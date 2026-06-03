const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ogs = require('open-graph-scraper');

const webpush = require('web-push');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dbPath = path.resolve(process.env.DB_PATH || path.join(dataDir, 'chat.db'));
const uploadDir = path.join(dataDir, 'uploads');
const backgroundsDir = path.join(dataDir, 'backgrounds');
const callDebugLogPath = path.join(dataDir, 'call-debug.log');
const legacyDbPath = path.join(__dirname, 'chat.db');
const legacyUploadsDir = path.join(__dirname, 'public/uploads');
const legacyBackgroundsDir = path.join(__dirname, 'public/backgrounds');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function copyIfMissing(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
    fs.copyFileSync(sourcePath, targetPath);
}

function copyDirIfMissing(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir) || fs.existsSync(targetDir)) return;
    fs.cpSync(sourceDir, targetDir, { recursive: true });
}

ensureDir(dataDir);
copyIfMissing(legacyDbPath, dbPath);
copyDirIfMissing(legacyUploadsDir, uploadDir);
copyDirIfMissing(legacyBackgroundsDir, backgroundsDir);
ensureDir(uploadDir);
ensureDir(backgroundsDir);

function loadVapidKeys() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return {
            publicKey: process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY
        };
    }

    const vapidFilePath = path.join(__dirname, 'vapidKeys.json');
    if (fs.existsSync(vapidFilePath)) {
        return JSON.parse(fs.readFileSync(vapidFilePath, 'utf8'));
    }

    throw new Error('Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY or provide vapidKeys.json');
}

const vapidKeys = loadVapidKeys();
webpush.setVapidDetails('mailto:hello@icq-modern.com', vapidKeys.publicKey, vapidKeys.privateKey);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database(dbPath);

function writeCallDebugLog(entry) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry
    }) + '\n';
    fs.appendFile(callDebugLogPath, line, (err) => {
        if (err) console.error('Call debug log write failed:', err);
    });
}

function normalizeUsernameInput(value) {
    const normalized = typeof value === 'string'
        ? value.normalize('NFKC').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ').trim()
        : '';

    return /^\d+$/.test(normalized.replace(/\s+/g, '')) ? normalized.replace(/\s+/g, '') : normalized;
}

function logFailedLogin(rawUsername, normalizedUsername, password) {
    const debug = {
        rawUsername,
        normalizedUsername,
        rawLength: rawUsername.length,
        normalizedLength: normalizedUsername.length,
        rawCodePoints: Array.from(rawUsername).map(ch => ch.codePointAt(0)),
        passwordLength: password.length
    };
    console.warn('Login failed debug:', JSON.stringify(debug));
}

// Multer storage config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });
// Separate config for background uploads
const bgStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, backgroundsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const bgUpload = multer({ storage: bgStorage });

// --- Database Schema ---
db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        subscription TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uin INTEGER UNIQUE,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user', -- admin, user
        avatar TEXT DEFAULT 'default.png',
        chat_bg TEXT DEFAULT 'default', -- can be 'color:xxxx' or 'image:file'
        status TEXT DEFAULT 'offline',
        custom_status TEXT DEFAULT '', -- New: User defined status message
        public_key TEXT DEFAULT '', -- E2EE: Public Key (Base64)
        can_chat INTEGER DEFAULT 1 -- 1 = yes, 0 = no
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        content TEXT,
        type TEXT DEFAULT 'text',
        is_read INTEGER DEFAULT 0,
        is_encrypted INTEGER DEFAULT 0, -- New: Flag for E2EE
        filename TEXT,
        reply_to_id INTEGER, -- New: ID of message being replied to
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(receiver_id) REFERENCES users(id)
    );
`);

// Migrations
try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'custom_status')) {
        db.prepare("ALTER TABLE users ADD COLUMN custom_status TEXT DEFAULT ''").run();
        console.log("Migration: Added custom_status to users");
    }
    if (!userCols.some(c => c.name === 'public_key')) {
        db.prepare("ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT ''").run();
        console.log("Migration: Added public_key to users");
    }
    
    const msgCols = db.prepare("PRAGMA table_info(messages)").all();
    if (!msgCols.some(c => c.name === 'is_read')) {
        db.prepare("ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0").run();
        console.log("Migration: Added is_read to messages");
    }
    if (!msgCols.some(c => c.name === 'reply_to_id')) {
        db.prepare("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER").run();
        console.log("Migration: Added reply_to_id to messages");
    }
    if (!msgCols.some(c => c.name === 'is_encrypted')) {
        db.prepare("ALTER TABLE messages ADD COLUMN is_encrypted INTEGER DEFAULT 0").run();
        console.log("Migration: Added is_encrypted to messages");
    }
} catch (e) { console.error("Migration error:", e); }

// Generate Random UIN (6-9 digits)
function generateUIN() {
    let uin;
    while (true) {
        uin = Math.floor(Math.random() * (999999999 - 100000 + 1)) + 100000;
        const exists = db.prepare('SELECT 1 FROM users WHERE uin = ?').get(uin);
        if (!exists) break;
    }
    return uin;
}

// Seed Admin User if not exists
const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
if (!adminUser) {
    const hash = bcrypt.hashSync('admin123', 10);
    const uin = generateUIN(); // Random UIN for admin too
    db.prepare('INSERT INTO users (uin, username, password, role, can_chat) VALUES (?, ?, ?, ?, 0)').run(uin, 'admin', hash, 'admin');
    console.log('Created user: admin / admin123 (UIN:', uin, ') - Chat disabled');
} else {
    // Ensure admin has chat disabled
    if (adminUser.can_chat !== 0) {
        db.prepare('UPDATE users SET can_chat = 0 WHERE id = ?').run(adminUser.id);
        console.log('Updated admin user: Chat disabled');
    }
}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));
app.use('/backgrounds', express.static(backgroundsDir));
app.use(express.static('public'));

// --- API Routes ---

app.post('/api/call-debug', (req, res) => {
    const { enabled, userId, username, event, details } = req.body || {};
    if (!enabled || !event) return res.json({ ok: true, skipped: true });

    writeCallDebugLog({
        type: 'client',
        userId: userId || null,
        username: username || null,
        event,
        details: details || null
    });
    res.json({ ok: true });
});

app.get('/api/call-debug', (req, res) => {
    if (!fs.existsSync(callDebugLogPath)) {
        return res.type('text/plain').send('');
    }
    res.type('text/plain').send(fs.readFileSync(callDebugLogPath, 'utf8'));
});

app.delete('/api/call-debug', (req, res) => {
    if (fs.existsSync(callDebugLogPath)) {
        fs.unlinkSync(callDebugLogPath);
    }
    res.json({ ok: true });
});

// Login
app.post('/api/login', (req, res) => {
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const username = normalizeUsernameInput(rawUsername);
    // Allow login by Username OR UIN
    let user;
    if (/^\d+$/.test(username)) { // If input is numeric, check UIN first
         user = db.prepare('SELECT * FROM users WHERE uin = ?').get(parseInt(username, 10));
    }
    if (!user) { // Otherwise username
         user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    }
    
    if (user && bcrypt.compareSync(password, user.password)) {
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                uin: user.uin,
                username: user.username, 
                avatar: user.avatar,
                role: user.role,
                chat_bg: user.chat_bg,
                custom_status: user.custom_status || ''
            } 
        });
    } else {
        logFailedLogin(rawUsername, username, password);
        res.status(401).json({ success: false, message: 'Falsche Zugangsdaten!' });
    }
});

// Update Profile (Self)
app.put('/api/profile/:id', (req, res) => {
    const { id } = req.params;
    const { username, password, avatar, chat_bg, custom_status, public_key } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, message: 'User nicht gefunden' });

    try {
        if (username && username !== user.username) {
            const exists = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
            if (exists) return res.status(400).json({ success: false, message: 'Username vergeben!' });
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
        }
        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
        }
        if (avatar) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, id);
        if (chat_bg) db.prepare('UPDATE users SET chat_bg = ? WHERE id = ?').run(chat_bg, id);
        
        // Custom Status Update
        if (custom_status !== undefined) {
            db.prepare('UPDATE users SET custom_status = ? WHERE id = ?').run(custom_status, id);
        }

        // E2EE Public Key Update (Only allow update if not set, or intentional reset)
        if (public_key) {
            db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(public_key, id);
        }
        
        const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        
        // Broadcast new status text to everyone
        io.emit('status_update', { 
            userId: updated.id, 
            status: updated.status, 
            custom_status: updated.custom_status,
            public_key: updated.public_key // Broadcast key too so clients can cache it
        });

        res.json({ success: true, user: { 
            id: updated.id, uin: updated.uin, username: updated.username, 
            avatar: updated.avatar, role: updated.role, chat_bg: updated.chat_bg, 
            custom_status: updated.custom_status || '',
            public_key: updated.public_key || ''
        }});
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

// Get Public Key for a User
app.get('/api/keys/:userId', (req, res) => {
    const user = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).json({ success: false });
    res.json({ publicKey: user.public_key });
});

// Admin: Get all users
app.get('/api/admin/users', (req, res) => {
    // Ideally verify requester via session/token. For now open internally.
    const users = db.prepare('SELECT id, uin, username, role, avatar, status, can_chat FROM users').all();
    res.json(users);
});

// Admin: Toggle Chat Permission
app.put('/api/admin/users/:id/toggle-chat', (req, res) => {
    const { id } = req.params;
    const { can_chat } = req.body;
    
    try {
        db.prepare('UPDATE users SET can_chat = ? WHERE id = ?').run(can_chat ? 1 : 0, id);
        
        // Notify all clients to update their user list (only show visible users)
        const publicUsers = db.prepare('SELECT id, uin, username, avatar, status FROM users WHERE can_chat = 1').all();
        io.emit('user_list', publicUsers);
        
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Admin: Create User (Strict Check)
app.post('/api/admin/users', (req, res) => {
    const { requesterId, username, password, role } = req.body;
    
    // Check if requester is admin
    const requester = db.prepare('SELECT role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    // Check if user exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ success: false, message: 'Benutzer existiert bereits!' });

    try {
        const hash = bcrypt.hashSync(password, 10);
        const uin = generateUIN();
        const result = db.prepare('INSERT INTO users (uin, username, password, role) VALUES (?, ?, ?, ?)').run(uin, username, hash, role || 'user');
        res.json({ success: true, id: result.lastInsertRowid, uin: uin });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Fehler beim Anlegen' });
    }
});

// Admin: Delete User
app.delete('/api/admin/users/:id', (req, res) => {
    // In real app verify requester is admin here too!
    const { id } = req.params;
    if (id == 1) return res.status(400).json({ success: false, message: "Admin kann nicht gelöscht werden!" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true });
});

// Chat History
app.get('/api/history/:userId/:contactId', (req, res) => {
    const { userId, contactId } = req.params;
    
    // Join with self to get reply content
    const messages = db.prepare(`
        SELECT m.*, 
               r.content as reply_content, 
               r.sender_id as reply_sender,
               r.type as reply_type,
               r.is_encrypted as reply_is_encrypted
        FROM messages m
        LEFT JOIN messages r ON m.reply_to_id = r.id
        WHERE (m.sender_id = ? AND m.receiver_id = ?) 
           OR (m.sender_id = ? AND m.receiver_id = ?)
        ORDER BY m.timestamp ASC
    `).all(userId, contactId, contactId, userId);
    
    
    // Mark as read when fetching history
    try {
        db.prepare('UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ?').run(userId, contactId);
    } catch(e) { console.error(e); }

    res.json(messages);
});

// Link Preview
app.post('/api/preview', async (req, res) => {
    const { url } = req.body;
    try {
        const data = await ogs({ url });
        if (data.error) throw new Error("OGS Error");
        res.json({
            title: data.result.ogTitle || data.result.twitterTitle || "",
            description: data.result.ogDescription || "",
            image: data.result.ogImage ? data.result.ogImage[0].url : null,
            site: data.result.ogSiteName || new URL(url).hostname
        });
    } catch (e) {
        res.json({ error: true });
    }
});

// File Upload (Chat)
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ filename: req.file.filename, originalName: req.file.originalname });
});

// File Upload (Background)
app.post('/api/upload/background', bgUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    res.json({ filename: req.file.filename });
});


// --- Web Push Routes ---
app.get('/api/vapidPublicKey', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
    const { userId, subscription } = req.body;
    if (!userId || !subscription) return res.status(400).send('Missing data');
    try {
        const stmt = db.prepare('INSERT OR IGNORE INTO push_subscriptions (user_id, subscription) VALUES (?, ?)');
        stmt.run(userId, JSON.stringify(subscription));
        res.status(201).json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- Socket.io Logic ---
const onlineUsers = new Map(); // socketId -> userId

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        onlineUsers.set(socket.id, userId);
        socket.join(`user_${userId}`);

        const user = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId);
        if (user && user.status !== 'online') {
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
            io.emit('status_update', { userId, status: 'online', custom_status: user.custom_status || '' });
        }
        
        // Send user list to connected client (only visible users)
        const users = db.prepare('SELECT id, uin, username, avatar, status, custom_status FROM users WHERE can_chat = 1').all();
        socket.emit('user_list', users);

        // Send unread counts
        const unreads = db.prepare('SELECT sender_id, count(*) as count FROM messages WHERE receiver_id = ? AND is_read = 0 GROUP BY sender_id').all(userId);
        const unreadMap = {};
        unreads.forEach(row => unreadMap[row.sender_id] = row.count);
        socket.emit('unread_sync', unreadMap);
        writeCallDebugLog({ type: 'server', event: 'join', details: { userId, socketId: socket.id } });

    });

    
    socket.on('typing', (data) => {
        io.to(`user_${data.to}`).emit('typing', { from: data.from });
    });
    
    socket.on('stop_typing', (data) => {
        io.to(`user_${data.to}`).emit('stop_typing', { from: data.from });
    });
    
    // Explicit activity ping to keep online status fresh without full join
    socket.on('im_active', (userId) => {
        const user = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId);
        if (!user || user.status === 'online') return;

        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
        io.emit('status_update', { userId, status: 'online', custom_status: user.custom_status || '' });
    });

    socket.on('send_message', (data) => {
        const { senderId, receiverId, content, type, filename, replyToId, isEncrypted } = data;
        
        const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, type, filename, reply_to_id, is_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const info = stmt.run(senderId, receiverId, content, type || 'text', filename || null, replyToId || null, isEncrypted ? 1 : 0);
        
        // Fetch reply details if needed
        let replyData = null;
        if (replyToId) {
            replyData = db.prepare('SELECT content, type, sender_id, is_encrypted FROM messages WHERE id = ?').get(replyToId);
        }

        const message = {
            id: info.lastInsertRowid,
            sender_id: senderId,
            receiver_id: receiverId,
            content,
            type: type || 'text',
            filename,
            is_encrypted: isEncrypted ? 1 : 0,
            reply_to_id: replyToId,
            reply_content: replyData?.content,
            reply_type: replyData?.type,
            reply_is_encrypted: replyData?.is_encrypted,
            timestamp: new Date().toISOString()
        };

        io.to(`user_${receiverId}`).emit('receive_message', message);
        io.to(`user_${senderId}`).emit('receive_message', message);
        io.to(`user_${receiverId}`).emit('notification', { type: 'message' });

        const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(senderId);
        const senderName = sender ? sender.username : 'Unbekannt';

        const payload = JSON.stringify({
            title: `Neue Nachricht von ${senderName}`,
            body: type === 'text' ? content : 'Neue Mediendatei empfangen',
            icon: '/icq-logo.png'
        });

        const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE user_id = ?').all(receiverId);
        for (let subRow of subs) {
            try {
                const sub = JSON.parse(subRow.subscription);
                webpush.sendNotification(sub, payload, {
                    vapidDetails: {
                        subject: 'mailto:hello@icq-modern.com',
                        publicKey: vapidKeys.publicKey,
                        privateKey: vapidKeys.privateKey
                    }
                }).catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Delete expired subscription
                        db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(subRow.subscription);
                    } else {
                        console.error('Push error:', err);
                    }
                });
            } catch(e) {}
        }
    
    });

    // --- WebRTC Signaling ---
    socket.on('call_user', (data) => {
        writeCallDebugLog({ type: 'server', event: 'call_user', details: { from: data.from, to: data.userToCall, video: data.video } });
        io.to(`user_${data.userToCall}`).emit('call_user', { 
            signal: data.signalData, 
            from: data.from,
            video: data.video 
        });
    });

    socket.on('answer_call', (data) => {
        writeCallDebugLog({ type: 'server', event: 'answer_call', details: { to: data.to } });
        io.to(`user_${data.to}`).emit('call_accepted', data.signal);
    });

    socket.on('ice_candidate', (data) => {
        writeCallDebugLog({
            type: 'server',
            event: 'ice_candidate',
            details: {
                to: data.to,
                candidateType: data.candidate?.type || null,
                sdpMid: data.candidate?.sdpMid || null
            }
        });
        io.to(`user_${data.to}`).emit('ice_candidate', data.candidate);
    });

    socket.on('end_call', (data) => {
        writeCallDebugLog({ type: 'server', event: 'end_call', details: { to: data.to } });
        io.to(`user_${data.to}`).emit('end_call');
    });

    socket.on('disconnect', () => {
        const userId = onlineUsers.get(socket.id);
        writeCallDebugLog({ type: 'server', event: 'disconnect', details: { userId: userId || null, socketId: socket.id } });
        if (userId) {
            onlineUsers.delete(socket.id);
            const isStillOnline = [...onlineUsers.values()].includes(userId);
            if (!isStillOnline) {
                db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
                io.emit('status_update', { userId, status: 'offline' });
            }
        }
    });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
