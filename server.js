const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const ogs = require('open-graph-scraper');
const appPackage = require('./package.json');

const webpush = require('web-push');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const dbPath = path.resolve(process.env.DB_PATH || path.join(dataDir, 'chat.db'));
const uploadDir = path.join(dataDir, 'uploads');
const backgroundsDir = path.join(dataDir, 'backgrounds');
const callDebugLogPath = path.join(dataDir, 'call-debug.log');
const legacyDbPath = path.join(__dirname, 'chat.db');
const legacyUploadsDir = path.join(__dirname, 'public/uploads');
const legacyBackgroundsDir = path.join(__dirname, 'public/backgrounds');
const iobrokerApiKey = String(process.env.IOBROKER_API_KEY || '').trim();
const iobrokerSenderUsername = String(process.env.IOBROKER_SENDER_USERNAME || 'ioBroker').trim() || 'ioBroker';
const smtpHost = String(process.env.SMTP_HOST || '').trim();
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || '').trim() === '1' || String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true';
const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPass = String(process.env.SMTP_PASS || '').trim();
const smtpFrom = String(process.env.SMTP_FROM || smtpUser || 'drq@localhost').trim();
const smtpRequireTls = String(process.env.SMTP_REQUIRE_TLS || '').trim() === '1' || String(process.env.SMTP_REQUIRE_TLS || '').trim().toLowerCase() === 'true';
const smtpRejectUnauthorized = !(String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '1').trim() === '0' || String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || '1').trim().toLowerCase() === 'false');
const maintenancePublicUrl = String(process.env.MAINTENANCE_PUBLIC_URL || '').trim();
const maintenanceMailEnabled = !(String(process.env.MAINTENANCE_MAIL_ENABLED || '1').trim() === '0' || String(process.env.MAINTENANCE_MAIL_ENABLED || '1').trim().toLowerCase() === 'false');
const maintenanceMailIntervalMinutes = Math.max(5, Number(process.env.MAINTENANCE_MAIL_INTERVAL_MINUTES || 30));
const maintenanceMailSchedule = String(process.env.MAINTENANCE_MAIL_SCHEDULE || 'nightly').trim().toLowerCase();
const maintenanceMailHour = Math.min(23, Math.max(0, Number(process.env.MAINTENANCE_MAIL_HOUR || 2)));
const maintenanceMailMinute = Math.min(59, Math.max(0, Number(process.env.MAINTENANCE_MAIL_MINUTE || 0)));
const DEFAULT_THEME_KEY = 'graphite';
const integrationPresenceTimers = new Map();
let maintenanceMailTimer = null;
let maintenanceMailLastRunDate = '';

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
webpush.setVapidDetails('mailto:hello@drq-app.com', vapidKeys.publicKey, vapidKeys.privateKey);

function buildRtcIceServers() {
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    const turnUrls = (process.env.TURN_URLS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

    if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
        iceServers.push({
            urls: turnUrls,
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL
        });
    }

    return iceServers;
}

function buildRtcConfig() {
    const iceServers = buildRtcIceServers();
    const iceTransportPolicy = process.env.RTC_ICE_TRANSPORT_POLICY || 'all';
    return {
        iceServers,
        iceTransportPolicy
    };
}

function parseIceCandidateDetails(candidateLike) {
    const raw = candidateLike?.candidate || '';
    const typeMatch = raw.match(/\btyp\s+([a-z]+)/i);
    const protocolMatch = raw.match(/\b(udp|tcp)\b/i);
    const addressMatch = raw.match(/candidate:\S+\s+\d+\s+\S+\s+\d+\s+([0-9a-fA-F\.:]+)\s+(\d+)/);
    return {
        type: candidateLike?.type || (typeMatch ? typeMatch[1] : null),
        protocol: protocolMatch ? protocolMatch[1].toLowerCase() : null,
        address: addressMatch ? addressMatch[1] : null,
        port: addressMatch ? Number(addressMatch[2]) : null,
        sdpMid: candidateLike?.sdpMid || null
    };
}

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
    console.log('CALL_DEBUG', line.trim());
}

function buildStoredFilename(targetDir, originalName) {
    const safeBaseName = path.basename(String(originalName || 'datei'))
        .replace(/[\/\\]/g, '_')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim() || 'datei';
    const ext = path.extname(safeBaseName);
    const stem = ext ? safeBaseName.slice(0, -ext.length) : safeBaseName;
    let candidate = safeBaseName;
    let counter = 1;

    while (fs.existsSync(path.join(targetDir, candidate))) {
        candidate = `${stem} (${counter})${ext}`;
        counter += 1;
    }

    return candidate;
}

function writeDataUrlImage(targetDir, preferredName, dataUrl) {
    const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1];
    const extMap = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/webp': '.webp'
    };
    const extension = extMap[mimeType] || '.png';
    const filename = buildStoredFilename(targetDir, `${preferredName || 'bild'}${extension}`);
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
    return {
        stored_name: filename,
        mime_type: mimeType,
        url: `/uploads/${filename}`
    };
}

function hashIntegrationToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateIntegrationSuffix() {
    return crypto.randomBytes(3).toString('hex').slice(0, 5);
}

function generateIntegrationTokenValue() {
    return crypto.randomBytes(24).toString('hex');
}

function getDisplayName(userLike) {
    const displayName = String(userLike?.display_name || '').trim();
    if (displayName) return displayName;
    const username = String(userLike?.username || '').trim();
    if (username) return username;
    return 'Unbekannt';
}

function detectMediaMessageType({ mimeType = '', originalName = '', requestedType = '' } = {}) {
    const normalizedRequested = String(requestedType || '').trim().toLowerCase();
    if (['image', 'video', 'audio', 'file'].includes(normalizedRequested)) {
        return normalizedRequested;
    }

    const normalizedMime = String(mimeType || '').trim().toLowerCase();
    if (normalizedMime.startsWith('image/')) return 'image';
    if (normalizedMime.startsWith('video/')) return 'video';
    if (normalizedMime.startsWith('audio/')) return 'audio';

    const ext = path.extname(String(originalName || '')).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
    if (['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.ogg', '.m4a', '.aac'].includes(ext)) return 'audio';
    return 'file';
}

function normalizeIntegrationUsernameInput(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const sanitized = raw
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!sanitized) return '';
    return sanitized.startsWith('iobroker_') ? sanitized : `iobroker_${sanitized}`;
}

function allocateIntegrationUsername(preferredName = '') {
    const normalizedPreferred = normalizeIntegrationUsernameInput(preferredName);
    for (let attempts = 0; attempts < 40; attempts += 1) {
        const candidate = attempts === 0 && normalizedPreferred
            ? normalizedPreferred
            : `iobroker_${generateIntegrationSuffix()}`;
        const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(candidate);
        if (!exists) return candidate;
    }
    throw new Error('Could not allocate integration username');
}

function sendPushToUser(userId, payload) {
    const subs = db.prepare('SELECT subscription FROM push_subscriptions WHERE user_id = ?').all(userId);
    for (const subRow of subs) {
        try {
            const sub = JSON.parse(subRow.subscription);
            webpush.sendNotification(sub, JSON.stringify(payload), {
                vapidDetails: {
                    subject: 'mailto:hello@drq-app.com',
                    publicKey: vapidKeys.publicKey,
                    privateKey: vapidKeys.privateKey
                }
            }).catch(err => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    db.prepare('DELETE FROM push_subscriptions WHERE subscription = ?').run(subRow.subscription);
                } else {
                    console.error('Push error:', err);
                }
            });
        } catch (e) {}
    }
}

function isUserOnline(userId) {
    return [...onlineUsers.values()].some((value) => Number(value) === Number(userId));
}

function emitMessageStatus(message) {
    const payload = {
        id: message.id,
        sender_id: Number(message.sender_id),
        receiver_id: Number(message.receiver_id),
        delivered_at: message.delivered_at || null,
        is_read: Number(message.is_read || 0)
    };
    io.to(`user_${message.sender_id}`).emit('message_status', payload);
    io.to(`user_${message.receiver_id}`).emit('message_status', payload);
}

function hasPersonalIntegrationLink(userId, integrationUserId) {
    return !!db.prepare(`
        SELECT 1
        FROM integration_tokens
        WHERE active = 1
          AND user_id = ?
          AND integration_user_id = ?
        LIMIT 1
    `).get(Number(userId), Number(integrationUserId));
}

function getActiveChatMute(userId, otherUserId) {
    const row = db.prepare(`
        SELECT id, user_id, muted_user_id, mute_until, is_forever
        FROM chat_mutes
        WHERE user_id = ?
          AND muted_user_id = ?
        LIMIT 1
    `).get(Number(userId), Number(otherUserId));

    if (!row) return null;
    if (Number(row.is_forever) === 1) return row;
    if (row.mute_until) {
        const untilTs = Date.parse(row.mute_until);
        if (!Number.isNaN(untilTs) && untilTs > Date.now()) {
            return row;
        }
    }

    db.prepare('DELETE FROM chat_mutes WHERE id = ?').run(row.id);
    return null;
}

function getChatMuteSettingsForUser(userId) {
    const nowIso = new Date().toISOString();
    db.prepare(`
        DELETE FROM chat_mutes
        WHERE user_id = ?
          AND is_forever = 0
          AND mute_until IS NOT NULL
          AND mute_until <= ?
    `).run(Number(userId), nowIso);

    return db.prepare(`
        SELECT muted_user_id, mute_until, is_forever
        FROM chat_mutes
        WHERE user_id = ?
        ORDER BY muted_user_id ASC
    `).all(Number(userId));
}

function getVisibleUsersForUser(userId) {
    const requester = db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(userId));
    if (!requester) return [];

    if (requester.role === 'admin') {
        return db.prepare(`
            SELECT id, uin, username, display_name, avatar, status, custom_status, can_chat, is_integration, owner_user_id
            FROM users
            WHERE can_chat = 1
            ORDER BY username COLLATE NOCASE ASC
        `).all();
    }

    return db.prepare(`
        SELECT DISTINCT u.id, u.uin, u.username, u.display_name, u.avatar, u.status, u.custom_status, u.can_chat, u.is_integration, u.owner_user_id
        FROM users u
        WHERE u.can_chat = 1
          AND u.id != ?
          AND (
                (u.is_integration = 1 AND u.owner_user_id = ?)
                OR EXISTS (
                    SELECT 1
                    FROM integration_tokens t
                    WHERE t.active = 1
                      AND t.user_id = ?
                      AND t.integration_user_id = u.id
                )
                OR EXISTS (
                    SELECT 1
                    FROM contacts c
                    WHERE c.status = 'accepted'
                      AND (
                            (c.requester_id = ? AND c.addressee_id = u.id)
                            OR (c.addressee_id = ? AND c.requester_id = u.id)
                          )
                )
              )
        ORDER BY u.is_integration DESC, u.username COLLATE NOCASE ASC
    `).all(Number(userId), Number(userId), Number(userId), Number(userId), Number(userId));
}

function broadcastVisibleUserList(userId = null) {
    if (userId != null) {
        io.to(`user_${Number(userId)}`).emit('user_list', getVisibleUsersForUser(Number(userId)));
        return;
    }

    const onlineUserIds = [...new Set([...onlineUsers.values()].map(Number).filter(Boolean))];
    onlineUserIds.forEach((onlineUserId) => {
        io.to(`user_${onlineUserId}`).emit('user_list', getVisibleUsersForUser(onlineUserId));
    });
}

function markIntegrationPresence(integrationUserId, ownerUserId = null) {
    const integrationId = Number(integrationUserId);
    if (!integrationId) return;

    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', integrationId);
    broadcastVisibleUserList();

    if (integrationPresenceTimers.has(integrationId)) {
        clearTimeout(integrationPresenceTimers.get(integrationId));
    }

    const timer = setTimeout(() => {
        integrationPresenceTimers.delete(integrationId);
        const user = db.prepare('SELECT id, is_integration, owner_user_id FROM users WHERE id = ?').get(integrationId);
        if (!user || Number(user.is_integration) !== 1) return;
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', integrationId);
        broadcastVisibleUserList();
    }, 90000);

    integrationPresenceTimers.set(integrationId, timer);
}

function canUsersChat(userId, otherUserId) {
    if (Number(userId) === Number(otherUserId)) return true;

    const pair = db.prepare(`
        SELECT
            a.id AS user_id,
            a.role AS user_role,
            b.id AS other_id,
            b.is_integration AS other_is_integration,
            b.owner_user_id AS other_owner_user_id,
            a.is_integration AS user_is_integration,
            a.owner_user_id AS user_owner_user_id
        FROM users a
        JOIN users b ON b.id = ?
        WHERE a.id = ?
    `).get(Number(userId), Number(otherUserId));

    if (!pair) return false;
    if (pair.user_role === 'admin') return true;
    if (pair.other_is_integration === 1 && Number(pair.other_owner_user_id) === Number(userId)) return true;
    if (pair.user_is_integration === 1 && Number(pair.user_owner_user_id) === Number(otherUserId)) return true;
    if (hasPersonalIntegrationLink(userId, otherUserId)) return true;
    if (hasPersonalIntegrationLink(otherUserId, userId)) return true;

    const accepted = db.prepare(`
        SELECT 1
        FROM contacts
        WHERE status = 'accepted'
          AND (
                (requester_id = ? AND addressee_id = ?)
                OR (requester_id = ? AND addressee_id = ?)
              )
    `).get(Number(userId), Number(otherUserId), Number(otherUserId), Number(userId));

    return !!accepted;
}

function hasContactRecordBetweenUsers(userId, otherUserId, statuses = []) {
    const params = [Number(userId), Number(otherUserId), Number(otherUserId), Number(userId)];
    let sql = `
        SELECT id, status, requester_id, addressee_id
        FROM contacts
        WHERE (
                (requester_id = ? AND addressee_id = ?)
                OR (requester_id = ? AND addressee_id = ?)
              )
    `;

    if (Array.isArray(statuses) && statuses.length) {
        sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
        params.push(...statuses.map((status) => String(status)));
    }

    sql += ' LIMIT 1';
    return db.prepare(sql).get(...params);
}

function canUsersAccessStoredChat(userId, otherUserId) {
    if (canUsersChat(userId, otherUserId)) return true;
    return !!hasContactRecordBetweenUsers(userId, otherUserId, ['pending', 'rejected', 'accepted']);
}

function createStoredMessage({ senderId, receiverId, content, type = 'text', filename = null, replyToId = null, isEncrypted = 0, severity = '' }) {
    const deliveredAt = isUserOnline(receiverId) ? new Date().toISOString() : null;
    const normalizedSeverity = typeof severity === 'string' ? severity.trim().toLowerCase() : '';
    const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, type, filename, reply_to_id, is_encrypted, delivered_at, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const info = stmt.run(senderId, receiverId, content, type, filename, replyToId, isEncrypted ? 1 : 0, deliveredAt, normalizedSeverity);

    let replyData = null;
    if (replyToId) {
        replyData = db.prepare('SELECT content, type, sender_id, is_encrypted FROM messages WHERE id = ?').get(replyToId);
    }

    const message = {
        id: info.lastInsertRowid,
        sender_id: Number(senderId),
        receiver_id: Number(receiverId),
        content,
        type,
        filename,
        severity: normalizedSeverity,
        delivered_at: deliveredAt,
        is_read: 0,
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

    const sender = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(senderId);
    const senderName = getDisplayName(sender);
    if (!getActiveChatMute(receiverId, senderId)) {
        sendPushToUser(receiverId, {
            title: `Neue Nachricht von ${senderName}`,
            body: type === 'text' ? content : 'Neue Mediendatei empfangen',
            icon: '/drq-logo.svg',
            tag: `message-${senderId}`,
            data: { type: 'message', senderId: Number(senderId) }
        });
    }

    return message;
}

function normalizeUsernameInput(value) {
    const normalized = typeof value === 'string'
        ? value.normalize('NFKC').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ').trim()
        : '';

    return /^\d+$/.test(normalized.replace(/\s+/g, '')) ? normalized.replace(/\s+/g, '') : normalized;
}

function getRequesterIdFromRequest(req) {
    const raw = req.body?.requesterId ?? req.query?.requesterId ?? req.params?.requesterId;
    const requesterId = Number(raw);
    return Number.isFinite(requesterId) && requesterId > 0 ? requesterId : 0;
}

function getRequesterUser(req) {
    const requesterId = getRequesterIdFromRequest(req);
    if (!requesterId) return null;
    return db.prepare(`
        SELECT id, uin, username, display_name, email, role, can_access_maintenance_board
        FROM users
        WHERE id = ?
    `).get(requesterId) || null;
}

function requireAdminUser(req, res) {
    const requester = getRequesterUser(req);
    if (!requester || requester.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Keine Berechtigung' });
        return null;
    }
    return requester;
}

function requireMaintenanceUser(req, res) {
    const requester = getRequesterUser(req);
    if (!requester) {
        res.status(401).json({ success: false, message: 'Bitte zuerst anmelden' });
        return null;
    }
    if (requester.role === 'admin' || Number(requester.can_access_maintenance_board) === 1) {
        return requester;
    }
    res.status(403).json({ success: false, message: 'Kein Zugriff auf das Wartungsboard' });
    return null;
}

function normalizeMaintenanceDate(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

function addDaysIso(baseDate, days) {
    const start = baseDate ? new Date(baseDate) : new Date();
    if (Number.isNaN(start.getTime())) return '';
    const next = new Date(start);
    next.setDate(next.getDate() + Number(days || 0));
    return next.toISOString().slice(0, 10);
}

function createMailTransporter() {
    if (!smtpHost || !smtpPort || !maintenanceMailEnabled) return null;
    const transportConfig = {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        requireTLS: smtpRequireTls,
        tls: {
            rejectUnauthorized: smtpRejectUnauthorized
        }
    };
    if (smtpUser || smtpPass) {
        transportConfig.auth = {
            user: smtpUser,
            pass: smtpPass
        };
    }
    return nodemailer.createTransport(transportConfig);
}

const mailTransporter = createMailTransporter();

function getLocalIsoDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getMaintenanceScheduleLabel() {
    if (maintenanceMailSchedule === 'interval') {
        return `alle ${maintenanceMailIntervalMinutes} Minuten`;
    }
    return `täglich um ${String(maintenanceMailHour).padStart(2, '0')}:${String(maintenanceMailMinute).padStart(2, '0')} Uhr`;
}

function logFailedLogin(req, rawUsername, normalizedUsername, password) {
    const debug = {
        event: 'login_failed',
        ip: req.ip,
        host: req.headers.host || null,
        userAgent: req.headers['user-agent'] || null,
        rawUsername,
        normalizedUsername,
        rawLength: rawUsername.length,
        normalizedLength: normalizedUsername.length,
        rawCodePoints: Array.from(rawUsername).map(ch => ch.codePointAt(0)),
        passwordLength: password.length
    };
    console.warn('LOGIN_DEBUG', JSON.stringify(debug));
}

function logLoginAttempt(req, rawUsername, normalizedUsername, password) {
    const debug = {
        event: 'login_attempt',
        ip: req.ip,
        host: req.headers.host || null,
        userAgent: req.headers['user-agent'] || null,
        rawUsername,
        normalizedUsername,
        rawLength: rawUsername.length,
        normalizedLength: normalizedUsername.length,
        passwordLength: password.length
    };
    console.log('LOGIN_DEBUG', JSON.stringify(debug));
}

function logSuccessfulLogin(req, user, normalizedUsername) {
    const debug = {
        event: 'login_success',
        ip: req.ip,
        host: req.headers.host || null,
        userAgent: req.headers['user-agent'] || null,
        normalizedUsername,
        userId: user.id,
        matchedUsername: user.username,
        matchedUin: user.uin
    };
    console.log('LOGIN_DEBUG', JSON.stringify(debug));
}

// Multer storage config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, buildStoredFilename(uploadDir, file.originalname));
    }
});
const upload = multer({ storage });
// Separate config for background uploads
const bgStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, backgroundsDir),
    filename: (req, file, cb) => {
        cb(null, buildStoredFilename(backgroundsDir, file.originalname));
    }
});
const bgUpload = multer({ storage: bgStorage });
const integrationMediaUpload = multer({ storage });

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
        display_name TEXT DEFAULT '',
        email TEXT DEFAULT '',
        password TEXT,
        role TEXT DEFAULT 'user', -- admin, user
        avatar TEXT DEFAULT 'default.png',
        chat_bg TEXT DEFAULT 'default', -- can be 'color:xxxx' or 'image:file'
        theme_key TEXT DEFAULT 'graphite',
        status TEXT DEFAULT 'offline',
        custom_status TEXT DEFAULT '', -- New: User defined status message
        public_key TEXT DEFAULT '', -- E2EE: Public Key (Base64)
        can_chat INTEGER DEFAULT 1, -- 1 = yes, 0 = no
        can_access_maintenance_board INTEGER DEFAULT 0,
        is_integration INTEGER DEFAULT 0,
        owner_user_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requester_id INTEGER NOT NULL,
        addressee_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(requester_id, addressee_id)
    );
    CREATE TABLE IF NOT EXISTS integration_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT DEFAULT '',
        token_hash TEXT UNIQUE NOT NULL,
        integration_user_id INTEGER,
        last_used_at DATETIME,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_mutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        muted_user_id INTEGER NOT NULL,
        mute_until DATETIME,
        is_forever INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, muted_user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        content TEXT,
        type TEXT DEFAULT 'text',
        severity TEXT DEFAULT '',
        delivered_at DATETIME,
        is_read INTEGER DEFAULT 0,
        is_encrypted INTEGER DEFAULT 0, -- New: Flag for E2EE
        filename TEXT,
        reply_to_id INTEGER, -- New: ID of message being replied to
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(receiver_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_buildings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT DEFAULT '',
        address TEXT DEFAULT '',
        city TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS maintenance_apartments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        building_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        floor TEXT DEFAULT '',
        unit_number TEXT DEFAULT '',
        tenant_name TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(building_id) REFERENCES maintenance_buildings(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_asset_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT DEFAULT '',
        description TEXT DEFAULT '',
        manufacturer TEXT DEFAULT '',
        default_interval_days INTEGER DEFAULT 180,
        checklist TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS maintenance_template_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(template_id) REFERENCES maintenance_asset_templates(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        building_id INTEGER NOT NULL,
        apartment_id INTEGER,
        name TEXT NOT NULL,
        location TEXT DEFAULT '',
        serial_number TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        installed_on TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(template_id) REFERENCES maintenance_asset_templates(id),
        FOREIGN KEY(building_id) REFERENCES maintenance_buildings(id),
        FOREIGN KEY(apartment_id) REFERENCES maintenance_apartments(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_staff (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS maintenance_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        interval_days INTEGER DEFAULT 180,
        next_due_date TEXT DEFAULT '',
        last_completed_at TEXT DEFAULT '',
        last_completion_note TEXT DEFAULT '',
        completion_checklist TEXT DEFAULT '',
        completion_requires_photo INTEGER DEFAULT 0,
        responsible_staff_id INTEGER,
        responsible TEXT DEFAULT '',
        priority TEXT DEFAULT 'normal',
        instructions TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(asset_id) REFERENCES maintenance_assets(id),
        FOREIGN KEY(responsible_staff_id) REFERENCES maintenance_staff(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_plan_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        completion_note TEXT DEFAULT '',
        checklist_state TEXT DEFAULT '',
        signature_stored_name TEXT DEFAULT '',
        signature_mime_type TEXT DEFAULT '',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(plan_id) REFERENCES maintenance_plans(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_plan_completion_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        completion_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(completion_id) REFERENCES maintenance_plan_completions(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_email_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        recipient_email TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plan_id, due_date, user_id)
    );
`);

// Migrations
try {
    const userCols = db.prepare("PRAGMA table_info(users)").all();
    if (!userCols.some(c => c.name === 'display_name')) {
        db.prepare("ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT ''").run();
        console.log("Migration: Added display_name to users");
    }
    if (!userCols.some(c => c.name === 'email')) {
        db.prepare("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''").run();
        console.log("Migration: Added email to users");
    }
    if (!userCols.some(c => c.name === 'custom_status')) {
        db.prepare("ALTER TABLE users ADD COLUMN custom_status TEXT DEFAULT ''").run();
        console.log("Migration: Added custom_status to users");
    }
    if (!userCols.some(c => c.name === 'theme_key')) {
        db.prepare(`ALTER TABLE users ADD COLUMN theme_key TEXT DEFAULT '${DEFAULT_THEME_KEY}'`).run();
        console.log("Migration: Added theme_key to users");
    }
    if (!userCols.some(c => c.name === 'public_key')) {
        db.prepare("ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT ''").run();
        console.log("Migration: Added public_key to users");
    }
    if (!userCols.some(c => c.name === 'is_integration')) {
        db.prepare("ALTER TABLE users ADD COLUMN is_integration INTEGER DEFAULT 0").run();
        console.log("Migration: Added is_integration to users");
    }
    if (!userCols.some(c => c.name === 'can_access_maintenance_board')) {
        db.prepare("ALTER TABLE users ADD COLUMN can_access_maintenance_board INTEGER DEFAULT 0").run();
        console.log("Migration: Added can_access_maintenance_board to users");
    }
    if (!userCols.some(c => c.name === 'owner_user_id')) {
        db.prepare("ALTER TABLE users ADD COLUMN owner_user_id INTEGER").run();
        console.log("Migration: Added owner_user_id to users");
    }
    const maintenancePlanCols = db.prepare("PRAGMA table_info(maintenance_plans)").all();
    if (maintenancePlanCols.length && !maintenancePlanCols.some(c => c.name === 'last_completion_note')) {
        db.prepare("ALTER TABLE maintenance_plans ADD COLUMN last_completion_note TEXT DEFAULT ''").run();
        console.log("Migration: Added last_completion_note to maintenance_plans");
    }
    if (maintenancePlanCols.length && !maintenancePlanCols.some(c => c.name === 'completion_checklist')) {
        db.prepare("ALTER TABLE maintenance_plans ADD COLUMN completion_checklist TEXT DEFAULT ''").run();
        console.log("Migration: Added completion_checklist to maintenance_plans");
    }
    if (maintenancePlanCols.length && !maintenancePlanCols.some(c => c.name === 'completion_requires_photo')) {
        db.prepare("ALTER TABLE maintenance_plans ADD COLUMN completion_requires_photo INTEGER DEFAULT 0").run();
        console.log("Migration: Added completion_requires_photo to maintenance_plans");
    }
    if (maintenancePlanCols.length && !maintenancePlanCols.some(c => c.name === 'responsible_staff_id')) {
        db.prepare("ALTER TABLE maintenance_plans ADD COLUMN responsible_staff_id INTEGER").run();
        console.log("Migration: Added responsible_staff_id to maintenance_plans");
    }
    
    const msgCols = db.prepare("PRAGMA table_info(messages)").all();
    if (!msgCols.some(c => c.name === 'delivered_at')) {
        db.prepare("ALTER TABLE messages ADD COLUMN delivered_at DATETIME").run();
        console.log("Migration: Added delivered_at to messages");
    }
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
    if (!msgCols.some(c => c.name === 'severity')) {
        db.prepare("ALTER TABLE messages ADD COLUMN severity TEXT DEFAULT ''").run();
        console.log("Migration: Added severity to messages");
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_id INTEGER NOT NULL,
            addressee_id INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(requester_id, addressee_id)
        );
        CREATE TABLE IF NOT EXISTS integration_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT DEFAULT '',
            token_hash TEXT UNIQUE NOT NULL,
            integration_user_id INTEGER,
            last_used_at DATETIME,
            active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS chat_mutes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            muted_user_id INTEGER NOT NULL,
            mute_until DATETIME,
            is_forever INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, muted_user_id)
        );
        CREATE TABLE IF NOT EXISTS maintenance_buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT DEFAULT '',
            address TEXT DEFAULT '',
            city TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_apartments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            building_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            floor TEXT DEFAULT '',
            unit_number TEXT DEFAULT '',
            tenant_name TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_asset_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT DEFAULT '',
            description TEXT DEFAULT '',
            manufacturer TEXT DEFAULT '',
            default_interval_days INTEGER DEFAULT 180,
            checklist TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_template_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            mime_type TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL,
            building_id INTEGER NOT NULL,
            apartment_id INTEGER,
            name TEXT NOT NULL,
            location TEXT DEFAULT '',
            serial_number TEXT DEFAULT '',
            status TEXT DEFAULT 'active',
            installed_on TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            role TEXT DEFAULT '',
            email TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            interval_days INTEGER DEFAULT 180,
            next_due_date TEXT DEFAULT '',
            last_completed_at TEXT DEFAULT '',
            last_completion_note TEXT DEFAULT '',
            completion_checklist TEXT DEFAULT '',
            completion_requires_photo INTEGER DEFAULT 0,
            responsible_staff_id INTEGER,
            responsible TEXT DEFAULT '',
            priority TEXT DEFAULT 'normal',
            instructions TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_plan_completions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            completed_at TEXT NOT NULL,
            completion_note TEXT DEFAULT '',
            checklist_state TEXT DEFAULT '',
            signature_stored_name TEXT DEFAULT '',
            signature_mime_type TEXT DEFAULT '',
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_plan_completion_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            completion_id INTEGER NOT NULL,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL,
            mime_type TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS maintenance_email_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL,
            due_date TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            recipient_email TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(plan_id, due_date, user_id)
        );
    `);
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

function ensureIntegrationUser(username) {
    const existing = db.prepare('SELECT id, uin, username, can_chat FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (existing) {
        if (existing.can_chat !== 1) {
            db.prepare('UPDATE users SET can_chat = 1 WHERE id = ?').run(existing.id);
            console.log(`Updated integration user ${existing.username}: Chat enabled`);
        }
        return db.prepare('SELECT id, uin, username, can_chat FROM users WHERE id = ?').get(existing.id);
    }

    const passwordHash = bcrypt.hashSync(uuidv4(), 10);
    const uin = generateUIN();
    const result = db.prepare('INSERT INTO users (uin, username, password, role, can_chat, custom_status) VALUES (?, ?, ?, ?, ?, ?)').run(
        uin,
        username,
        passwordHash,
        'user',
        1,
        'Systemintegration'
    );
    console.log(`Created integration user: ${username} (UIN: ${uin})`);
    return db.prepare('SELECT id, uin, username, can_chat FROM users WHERE id = ?').get(result.lastInsertRowid);
}

const iobrokerSenderUser = ensureIntegrationUser(iobrokerSenderUsername);

function ensurePersonalIntegrationUser(ownerUserId, preferredName = '') {
    const owner = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(ownerUserId));
    if (!owner) {
        throw new Error('Owner user not found');
    }

    const username = allocateIntegrationUsername(preferredName);

    const passwordHash = bcrypt.hashSync(uuidv4(), 10);
    const uin = generateUIN();
    const result = db.prepare(`
        INSERT INTO users (uin, username, password, role, can_chat, custom_status, is_integration, owner_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        uin,
        username,
        passwordHash,
        'user',
        1,
        'Persoenliche ioBroker-Integration',
        1,
        Number(ownerUserId)
    );

    return db.prepare(`
        SELECT id, uin, username, can_chat, is_integration, owner_user_id
        FROM users
        WHERE id = ?
    `).get(result.lastInsertRowid);
}

function createIntegrationTokenRecord(ownerUserId, name = '') {
    const plainToken = generateIntegrationTokenValue();
    const tokenHash = hashIntegrationToken(plainToken);
    const info = db.prepare(`
        INSERT INTO integration_tokens (user_id, name, token_hash, active)
        VALUES (?, ?, ?, 1)
    `).run(Number(ownerUserId), String(name || '').trim(), tokenHash);

    return {
        id: Number(info.lastInsertRowid),
        token: plainToken
    };
}

function getContactStateForUser(userId) {
    const accepted = db.prepare(`
        SELECT
            c.id,
            c.status,
            c.requester_id,
            c.addressee_id,
            u.id AS user_id,
            u.uin,
            u.username,
            u.display_name,
            u.avatar,
            u.status AS online_status,
            u.custom_status
        FROM contacts c
        JOIN users u ON u.id = CASE
            WHEN c.requester_id = ? THEN c.addressee_id
            ELSE c.requester_id
        END
        WHERE c.status = 'accepted'
          AND (c.requester_id = ? OR c.addressee_id = ?)
        ORDER BY u.username COLLATE NOCASE ASC
    `).all(Number(userId), Number(userId), Number(userId));

    const pendingIncoming = db.prepare(`
        SELECT
            c.id,
            c.status,
            c.requester_id,
            c.addressee_id,
            c.created_at,
            c.updated_at,
            u.id AS user_id,
            u.uin,
            u.username,
            u.display_name,
            u.avatar,
            u.status AS online_status,
            u.custom_status
        FROM contacts c
        JOIN users u ON u.id = c.requester_id
        WHERE c.status = 'pending'
          AND c.addressee_id = ?
        ORDER BY c.created_at DESC
    `).all(Number(userId));

    const pendingOutgoing = db.prepare(`
        SELECT
            c.id,
            c.status,
            c.requester_id,
            c.addressee_id,
            c.created_at,
            c.updated_at,
            u.id AS user_id,
            u.uin,
            u.username,
            u.display_name,
            u.avatar,
            u.status AS online_status,
            u.custom_status
        FROM contacts c
        JOIN users u ON u.id = c.addressee_id
        WHERE c.status = 'pending'
          AND c.requester_id = ?
        ORDER BY c.created_at DESC
    `).all(Number(userId));

    const rejected = db.prepare(`
        SELECT
            c.id,
            c.status,
            c.requester_id,
            c.addressee_id,
            c.created_at,
            c.updated_at,
            u.id AS user_id,
            u.uin,
            u.username,
            u.avatar,
            u.status AS online_status,
            u.custom_status
        FROM contacts c
        JOIN users u ON u.id = CASE
            WHEN c.requester_id = ? THEN c.addressee_id
            ELSE c.requester_id
        END
        WHERE c.status = 'rejected'
          AND (c.requester_id = ? OR c.addressee_id = ?)
        ORDER BY c.updated_at DESC, c.created_at DESC
    `).all(Number(userId), Number(userId), Number(userId));

    return { accepted, pendingIncoming, pendingOutgoing, rejected };
}

function getIntegrationTokensForUser(userId) {
    return db.prepare(`
        SELECT
            t.id,
            t.name,
            t.integration_user_id,
            t.last_used_at,
            t.active,
            t.created_at,
            u.username AS integration_username,
            u.uin AS integration_uin
        FROM integration_tokens t
        LEFT JOIN users u ON u.id = t.integration_user_id
        WHERE t.user_id = ?
        ORDER BY t.created_at DESC
    `).all(Number(userId));
}

function authenticateIoBrokerRequest(req, res) {
    const providedApiKey = String(req.headers['x-api-key'] || '').trim();
    if (!providedApiKey) {
        res.status(401).json({ success: false, message: 'Invalid API key' });
        return false;
    }

    if (iobrokerApiKey && providedApiKey === iobrokerApiKey) {
        markIntegrationPresence(iobrokerSenderUser.id, null);
        return {
            mode: 'legacy',
            ownerUser: null,
            integrationUser: iobrokerSenderUser,
            tokenRecord: null
        };
    }

    const tokenHash = hashIntegrationToken(providedApiKey);
    const tokenRecord = db.prepare(`
        SELECT id, user_id, name, integration_user_id, active
        FROM integration_tokens
        WHERE token_hash = ?
          AND active = 1
    `).get(tokenHash);

    if (!tokenRecord) {
        res.status(401).json({ success: false, message: 'Invalid API key' });
        return false;
    }

    const ownerUser = db.prepare('SELECT id, uin, username, role FROM users WHERE id = ?').get(tokenRecord.user_id);
    if (!ownerUser) {
        res.status(401).json({ success: false, message: 'Invalid token owner' });
        return false;
    }

    let integrationUser = null;
    if (tokenRecord.integration_user_id) {
        integrationUser = db.prepare(`
            SELECT id, uin, username, can_chat, is_integration, owner_user_id
            FROM users
            WHERE id = ?
        `).get(tokenRecord.integration_user_id);
    }

    if (!integrationUser) {
        integrationUser = ensurePersonalIntegrationUser(ownerUser.id, tokenRecord.name || '');
        db.prepare('UPDATE integration_tokens SET integration_user_id = ? WHERE id = ?').run(integrationUser.id, tokenRecord.id);
    }

    if (integrationUser.can_chat !== 1) {
        db.prepare('UPDATE users SET can_chat = 1 WHERE id = ?').run(integrationUser.id);
        integrationUser.can_chat = 1;
    }

    db.prepare('UPDATE integration_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(tokenRecord.id);
    markIntegrationPresence(integrationUser.id, ownerUser.id);

    return {
        mode: 'personal',
        ownerUser,
        integrationUser,
        tokenRecord
    };
}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));
app.use('/backgrounds', express.static(backgroundsDir));
app.use(express.static('public', {
    setHeaders: (res, filePath) => {
        const filename = path.basename(filePath).toLowerCase();
        if (filename === 'index.html') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return;
        }
        if (filename === 'sw.js') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return;
        }
        if (filename.endsWith('.js') || filename.endsWith('.css')) {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
    }
}));

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

app.get('/api/runtime-config', (req, res) => {
    res.json({
        version: `Version ${appPackage.version}`,
        rtcConfig: buildRtcConfig()
    });
});

app.post('/api/integrations/iobroker/messages', (req, res) => {
    const authContext = authenticateIoBrokerRequest(req, res);
    if (!authContext) {
        return;
    }

    const body = req.body || {};
    const messageText = typeof body.message === 'string' ? body.message.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const severity = typeof body.severity === 'string' ? body.severity.trim() : 'info';
    const source = typeof body.source === 'string' ? body.source.trim() : 'ioBroker';
    const recipients = Array.isArray(body.recipients)
        ? body.recipients.map(value => String(value).trim()).filter(Boolean)
        : [];

    if (!messageText) {
        return res.status(400).json({ success: false, message: 'Missing message' });
    }

    if (!recipients.length) {
        return res.status(400).json({ success: false, message: 'Missing recipients' });
    }

    const recipientUsers = [];
    const missingRecipients = [];
    const seenUserIds = new Set();

    for (const recipient of recipients) {
        const user = /^\d+$/.test(recipient)
            ? db.prepare('SELECT id, uin, username, can_chat FROM users WHERE uin = ?').get(Number(recipient))
            : db.prepare('SELECT id, uin, username, can_chat FROM users WHERE LOWER(username) = LOWER(?)').get(recipient);

        if (!user) {
            missingRecipients.push(recipient);
            continue;
        }

        if (!seenUserIds.has(user.id)) {
            if (authContext.ownerUser && !canUsersChat(authContext.ownerUser.id, user.id)) {
                missingRecipients.push(recipient);
                continue;
            }
            recipientUsers.push(user);
            seenUserIds.add(user.id);
        }
    }

    if (!recipientUsers.length) {
        return res.status(404).json({ success: false, message: 'No matching DRQ recipients found', missingRecipients });
    }

    const normalizedSeverity = severity.toLowerCase();
    const showSource = source && source.toLowerCase() !== 'iobroker';
    const formattedMessage = [
        title ? `[${title}]` : '',
        messageText,
        showSource ? `\nQuelle: ${source}` : ''
    ].join('').trim();

    try {
        const sent = recipientUsers.map((user) => {
            const storedMessage = createStoredMessage({
                senderId: authContext.integrationUser.id,
                receiverId: user.id,
                content: formattedMessage,
                type: 'text',
                severity: normalizedSeverity === 'info' ? '' : normalizedSeverity
            });
            return {
                userId: user.id,
                uin: user.uin,
                username: user.username,
                messageId: storedMessage.id
            };
        });

        if (authContext.integrationUser.can_chat !== 1) {
            db.prepare('UPDATE users SET can_chat = 1 WHERE id = ?').run(authContext.integrationUser.id);
        }
        if (authContext.ownerUser) {
            broadcastVisibleUserList(authContext.ownerUser.id);
        } else {
            broadcastVisibleUserList();
        }

        res.json({
            success: true,
            sender: {
                id: authContext.integrationUser.id,
                uin: authContext.integrationUser.uin,
                username: authContext.integrationUser.username
            },
            sent,
            missingRecipients
        });
    } catch (error) {
        console.error('ioBroker integration send failed:', error);
        res.status(500).json({ success: false, message: 'Failed to send DRQ message' });
    }
});

app.post('/api/integrations/iobroker/media', integrationMediaUpload.single('file'), (req, res) => {
    const authContext = authenticateIoBrokerRequest(req, res);
    if (!authContext) {
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try { fs.unlinkSync(req.file.path); } catch (error) {}
        }
        return;
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Missing file upload' });
    }

    const body = req.body || {};
    const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const severity = typeof body.severity === 'string' ? body.severity.trim() : 'info';
    const source = typeof body.source === 'string' ? body.source.trim() : 'ioBroker';
    const recipients = Array.isArray(body.recipients)
        ? body.recipients.map(value => String(value).trim()).filter(Boolean)
        : String(body.recipients || '')
            .split(/[,\n;]/)
            .map(value => value.trim())
            .filter(Boolean);

    if (!recipients.length) {
        try { fs.unlinkSync(req.file.path); } catch (error) {}
        return res.status(400).json({ success: false, message: 'Missing recipients' });
    }

    const recipientUsers = [];
    const missingRecipients = [];

    recipients.forEach((recipientValue) => {
        const user = /^\d+$/.test(recipientValue)
            ? db.prepare('SELECT id, uin, username, can_chat FROM users WHERE uin = ?').get(Number(recipientValue))
            : db.prepare('SELECT id, uin, username, can_chat FROM users WHERE LOWER(username) = LOWER(?)').get(recipientValue);

        if (!user) {
            missingRecipients.push(recipientValue);
            return;
        }

        if (authContext.ownerUser && !canUsersChat(authContext.ownerUser.id, user.id)) {
            missingRecipients.push(recipientValue);
            return;
        }

        recipientUsers.push(user);
    });

    if (!recipientUsers.length) {
        try { fs.unlinkSync(req.file.path); } catch (error) {}
        return res.status(400).json({ success: false, message: 'No valid recipients', missingRecipients });
    }

    const mediaType = detectMediaMessageType({
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
        requestedType: body.type
    });
    const messageContent = caption || title || req.file.originalname || mediaType;

    try {
        const sent = recipientUsers.map((user) => {
            const storedMessage = createStoredMessage({
                senderId: authContext.integrationUser.id,
                receiverId: user.id,
                content: messageContent,
                type: mediaType,
                filename: req.file.filename,
                severity
            });

            return {
                userId: user.id,
                uin: user.uin,
                username: user.username,
                messageId: storedMessage.id
            };
        });

        if (authContext.integrationUser.can_chat !== 1) {
            db.prepare('UPDATE users SET can_chat = 1 WHERE id = ?').run(authContext.integrationUser.id);
        }
        if (authContext.ownerUser) {
            broadcastVisibleUserList(authContext.ownerUser.id);
        } else {
            broadcastVisibleUserList();
        }

        res.json({
            success: true,
            sender: {
                id: authContext.integrationUser.id,
                uin: authContext.integrationUser.uin,
                username: authContext.integrationUser.username
            },
            file: {
                filename: req.file.filename,
                originalName: req.file.originalname,
                type: mediaType,
                mimetype: req.file.mimetype
            },
            sent,
            missingRecipients
        });
    } catch (error) {
        console.error('ioBroker integration media send failed:', error);
        res.status(500).json({ success: false, message: 'Failed to send DRQ media message' });
    }
});

app.get('/api/integrations/iobroker/inbox', (req, res) => {
    const authContext = authenticateIoBrokerRequest(req, res);
    if (!authContext) {
        return;
    }

    const afterId = Math.max(0, Number.parseInt(String(req.query.afterId || '0'), 10) || 0);
    const requestedLimit = Number.parseInt(String(req.query.limit || '20'), 10) || 20;
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

    try {
        const messages = db.prepare(`
            SELECT
                m.id,
                m.sender_id,
                m.receiver_id,
                m.content,
                m.type,
                m.severity,
                m.timestamp,
                m.delivered_at,
                m.is_read,
                u.uin AS sender_uin,
                u.username AS sender_username
            FROM messages m
            LEFT JOIN users u ON u.id = m.sender_id
            WHERE m.receiver_id = ?
              AND m.sender_id != ?
              AND m.id > ?
            ORDER BY m.id ASC
            LIMIT ?
        `).all(authContext.integrationUser.id, authContext.integrationUser.id, afterId, limit);

        if (messages.length) {
            const now = new Date().toISOString();
            const updateOne = db.prepare(`
                UPDATE messages
                SET is_read = 1,
                    delivered_at = COALESCE(delivered_at, ?)
                WHERE id = ?
            `);

            const transaction = db.transaction((rows) => {
                for (const row of rows) {
                    updateOne.run(now, row.id);
                }
            });
            transaction(messages);

            messages.forEach((message) => {
                emitMessageStatus({
                    ...message,
                    delivered_at: message.delivered_at || now,
                    is_read: 1
                });
            });
        }

        res.json({
            success: true,
            receiver: {
                id: authContext.integrationUser.id,
                uin: authContext.integrationUser.uin,
                username: authContext.integrationUser.username
            },
            messages: messages.map((message) => ({
                id: Number(message.id),
                senderId: Number(message.sender_id),
                senderUsername: message.sender_username || '',
                senderUin: message.sender_uin != null ? Number(message.sender_uin) : null,
                content: message.content || '',
                type: message.type || 'text',
                severity: message.severity || '',
                timestamp: message.timestamp || null,
                deliveredAt: message.delivered_at || null,
                isRead: 1
            }))
        });
    } catch (error) {
        console.error('ioBroker integration inbox fetch failed:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch DRQ inbox' });
    }
});

app.get('/api/integrations/iobroker/outbox-status', (req, res) => {
    const authContext = authenticateIoBrokerRequest(req, res);
    if (!authContext) {
        return;
    }

    const messageIds = String(req.query.messageIds || '')
        .split(/[,\s;]+/)
        .map(value => Number.parseInt(value, 10))
        .filter(value => Number.isInteger(value) && value > 0)
        .slice(0, 50);

    if (!messageIds.length) {
        return res.json({ success: true, messages: [] });
    }

    try {
        const placeholders = messageIds.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT
                m.id,
                m.sender_id,
                m.receiver_id,
                m.content,
                m.type,
                m.severity,
                m.timestamp,
                m.delivered_at,
                m.is_read,
                u.uin AS receiver_uin,
                u.username AS receiver_username
            FROM messages m
            LEFT JOIN users u ON u.id = m.receiver_id
            WHERE m.sender_id = ?
              AND m.id IN (${placeholders})
            ORDER BY m.id ASC
        `).all(authContext.integrationUser.id, ...messageIds);

        return res.json({
            success: true,
            sender: {
                id: authContext.integrationUser.id,
                uin: authContext.integrationUser.uin,
                username: authContext.integrationUser.username
            },
            messages: rows.map((message) => ({
                id: Number(message.id),
                senderId: Number(message.sender_id),
                receiverId: Number(message.receiver_id),
                receiverUsername: message.receiver_username || '',
                receiverUin: message.receiver_uin != null ? Number(message.receiver_uin) : null,
                content: message.content || '',
                type: message.type || 'text',
                severity: message.severity || '',
                timestamp: message.timestamp || null,
                deliveredAt: message.delivered_at || null,
                isRead: Number(message.is_read || 0) === 1
            }))
        });
    } catch (error) {
        console.error('ioBroker integration outbox status failed:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch DRQ outbox status' });
    }
});

// Login
app.post('/api/login', (req, res) => {
    const rawUsername = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const username = normalizeUsernameInput(rawUsername);
    logLoginAttempt(req, rawUsername, username, password);
    // Allow login by Username OR UIN
    let user;
    if (/^\d+$/.test(username)) { // If input is numeric, check UIN first
         user = db.prepare('SELECT * FROM users WHERE uin = ?').get(parseInt(username, 10));
    }
    if (!user) { // Otherwise username
         user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    }
    
    if (user && bcrypt.compareSync(password, user.password)) {
        logSuccessfulLogin(req, user, username);
        res.json({ 
            success: true, 
            user: { 
                id: user.id, 
                uin: user.uin,
                username: user.username,
                display_name: user.display_name || '',
                email: user.email || '',
                avatar: user.avatar,
                role: user.role,
                chat_bg: user.chat_bg,
                theme_key: user.theme_key || DEFAULT_THEME_KEY,
                custom_status: user.custom_status || '',
                can_access_maintenance_board: Number(user.can_access_maintenance_board || 0) === 1
            } 
        });
    } else {
        logFailedLogin(req, rawUsername, username, password);
        res.status(401).json({ success: false, message: 'Falsche Zugangsdaten!' });
    }
});

// Update Profile (Self)
app.put('/api/profile/:id', (req, res) => {
    const { id } = req.params;
    const { username, display_name, email, password, avatar, chat_bg, custom_status, public_key, theme_key } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ success: false, message: 'User nicht gefunden' });

    try {
        if (username && username !== user.username) {
            const exists = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
            if (exists) return res.status(400).json({ success: false, message: 'Username vergeben!' });
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
        }
        if (display_name !== undefined) {
            db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(display_name || '').trim(), id);
        }
        if (email !== undefined) {
            db.prepare('UPDATE users SET email = ? WHERE id = ?').run(String(email || '').trim(), id);
        }
        if (password) {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
        }
        if (avatar) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, id);
        if (chat_bg) db.prepare('UPDATE users SET chat_bg = ? WHERE id = ?').run(chat_bg, id);
        if (theme_key !== undefined) {
            db.prepare('UPDATE users SET theme_key = ? WHERE id = ?').run(String(theme_key || DEFAULT_THEME_KEY).trim() || DEFAULT_THEME_KEY, id);
        }
        
        // Custom Status Update
        if (custom_status !== undefined) {
            db.prepare('UPDATE users SET custom_status = ? WHERE id = ?').run(custom_status, id);
        }

        // E2EE Public Key Update (Only allow update if not set, or intentional reset)
        if (public_key) {
            db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(public_key, id);
        }
        
        const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        
        broadcastVisibleUserList();

        res.json({ success: true, user: { 
            id: updated.id, uin: updated.uin, username: updated.username,
            display_name: updated.display_name || '',
            email: updated.email || '',
            avatar: updated.avatar, role: updated.role, chat_bg: updated.chat_bg,
            theme_key: updated.theme_key || DEFAULT_THEME_KEY,
            custom_status: updated.custom_status || '',
            public_key: updated.public_key || '',
            can_access_maintenance_board: Number(updated.can_access_maintenance_board || 0) === 1
        }});
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Update failed' });
    }
});

app.get('/api/profile/:id/contacts', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.query.requesterId || userId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    res.json({ success: true, ...getContactStateForUser(userId) });
});

app.get('/api/profile/:id/user-search', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.query.requesterId || userId);
    const q = String(req.query.q || '').trim();

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }
    if (!q || q.length < 2) {
        return res.json({ success: true, results: [] });
    }

    const results = db.prepare(`
        SELECT id, uin, username, display_name, avatar, status, custom_status
        FROM users
        WHERE can_chat = 1
          AND is_integration = 0
          AND id != ?
          AND (
                LOWER(username) LIKE LOWER(?)
                OR CAST(uin AS TEXT) LIKE ?
              )
        ORDER BY username COLLATE NOCASE ASC
        LIMIT 20
    `).all(userId, `%${q}%`, `%${q}%`);

    res.json({ success: true, results });
});

app.post('/api/profile/:id/contacts/request', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const targetInput = String(req.body?.target || '').trim();

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }
    if (!targetInput) {
        return res.status(400).json({ success: false, message: 'Kontakt fehlt' });
    }

    const targetUser = /^\d+$/.test(targetInput)
        ? db.prepare('SELECT id, uin, username, is_integration FROM users WHERE uin = ?').get(Number(targetInput))
        : db.prepare('SELECT id, uin, username, is_integration FROM users WHERE LOWER(username) = LOWER(?)').get(targetInput);

    if (!targetUser || targetUser.is_integration === 1 || Number(targetUser.id) === userId) {
        return res.status(404).json({ success: false, message: 'Kontakt nicht gefunden' });
    }

    const existingAccepted = canUsersChat(userId, targetUser.id);
    if (existingAccepted) {
        return res.status(400).json({ success: false, message: 'Kontakt bereits vorhanden' });
    }

    const reversePending = db.prepare(`
        SELECT id FROM contacts
        WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'
    `).get(targetUser.id, userId);

    if (reversePending) {
        db.prepare(`
            UPDATE contacts
            SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(reversePending.id);
    } else {
        db.prepare(`
            INSERT INTO contacts (requester_id, addressee_id, status)
            VALUES (?, ?, 'pending')
            ON CONFLICT(requester_id, addressee_id) DO UPDATE SET
                status = 'pending',
                updated_at = CURRENT_TIMESTAMP
        `).run(userId, targetUser.id);
    }

    broadcastVisibleUserList(userId);
    broadcastVisibleUserList(targetUser.id);
    io.to(`user_${targetUser.id}`).emit('contacts_updated');
    io.to(`user_${userId}`).emit('contacts_updated');

    res.json({ success: true, target: targetUser });
});

app.post('/api/profile/:id/contacts/:contactId/accept', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const contact = db.prepare(`
        SELECT * FROM contacts
        WHERE id = ? AND addressee_id = ? AND status = 'pending'
    `).get(contactId, userId);

    if (!contact) {
        return res.status(404).json({ success: false, message: 'Anfrage nicht gefunden' });
    }

    db.prepare(`
        UPDATE contacts
        SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(contactId);

    broadcastVisibleUserList(userId);
    broadcastVisibleUserList(contact.requester_id);
    io.to(`user_${contact.requester_id}`).emit('contacts_updated');
    io.to(`user_${userId}`).emit('contacts_updated');

    res.json({ success: true });
});

app.post('/api/profile/:id/contacts/:contactId/reject', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const contact = db.prepare(`
        SELECT * FROM contacts
        WHERE id = ?
          AND (
                requester_id = ?
                OR addressee_id = ?
              )
    `).get(contactId, userId, userId);

    if (!contact) {
        return res.status(404).json({ success: false, message: 'Anfrage nicht gefunden' });
    }

    db.prepare(`
        UPDATE contacts
        SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(contactId);

    const affectedUserIds = [...new Set([contact.requester_id, contact.addressee_id].map(Number).filter(Boolean))];
    affectedUserIds.forEach((affectedUserId) => {
        broadcastVisibleUserList(affectedUserId);
        io.to(`user_${affectedUserId}`).emit('contacts_updated');
    });
    res.json({ success: true });
});

app.delete('/api/profile/:id/contacts/:contactId', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);
    const clearHistory = req.body?.clearHistory === true;

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const contact = db.prepare(`
        SELECT * FROM contacts
        WHERE id = ?
          AND (
                requester_id = ?
                OR addressee_id = ?
              )
    `).get(contactId, userId, userId);

    if (!contact) {
        return res.status(404).json({ success: false, message: 'Eintrag nicht gefunden' });
    }

    const contactStatus = String(contact.status || '');
    const otherUserId = Number(contact.requester_id) === userId
        ? Number(contact.addressee_id)
        : Number(contact.requester_id);

    if (contactStatus === 'accepted') {
        if (clearHistory) {
            db.prepare(`
                DELETE FROM messages
                WHERE (sender_id = ? AND receiver_id = ?)
                   OR (sender_id = ? AND receiver_id = ?)
            `).run(userId, otherUserId, otherUserId, userId);

            db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
        } else {
            db.prepare(`
                UPDATE contacts
                SET status = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(contactId);
        }

        const affectedUserIds = [...new Set([contact.requester_id, contact.addressee_id].map(Number).filter(Boolean))];
        affectedUserIds.forEach((affectedUserId) => {
            io.to(`user_${affectedUserId}`).emit('contacts_updated');
            broadcastVisibleUserList(affectedUserId);
        });

        return res.json({
            success: true,
            removedFriend: true,
            clearedHistory: clearHistory,
            remainingEntry: clearHistory ? 'none' : 'rejected'
        });
    }

    if (!['rejected', 'pending'].includes(contactStatus)) {
        return res.status(400).json({ success: false, message: 'Dieser Kontakt kann gerade nicht entfernt werden' });
    }

    if (clearHistory) {
        db.prepare(`
            DELETE FROM messages
            WHERE (sender_id = ? AND receiver_id = ?)
               OR (sender_id = ? AND receiver_id = ?)
        `).run(userId, otherUserId, otherUserId, userId);
    }

    db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

    if (contact.requester_id) {
        io.to(`user_${contact.requester_id}`).emit('contacts_updated');
        broadcastVisibleUserList(contact.requester_id);
    }
    if (contact.addressee_id) {
        io.to(`user_${contact.addressee_id}`).emit('contacts_updated');
        broadcastVisibleUserList(contact.addressee_id);
    }

    res.json({ success: true });
});

app.get('/api/profile/:id/integrations', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.query.requesterId || userId);
    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    res.json({ success: true, tokens: getIntegrationTokensForUser(userId) });
});

app.get('/api/profile/:id/chat-settings', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.query.requesterId || userId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    res.json({ success: true, mutes: getChatMuteSettingsForUser(userId) });
});

app.post('/api/profile/:id/chats/:contactId/mute', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);
    const durationHours = Number(req.body?.durationHours || 0);
    const forever = req.body?.forever === true;

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }
    if (!canUsersAccessStoredChat(userId, contactId)) {
        return res.status(403).json({ success: false, message: 'Chat nicht erlaubt' });
    }

    const muteUntil = forever || durationHours <= 0
        ? null
        : new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();

    db.prepare(`
        INSERT INTO chat_mutes (user_id, muted_user_id, mute_until, is_forever, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, muted_user_id) DO UPDATE SET
            mute_until = excluded.mute_until,
            is_forever = excluded.is_forever,
            updated_at = CURRENT_TIMESTAMP
    `).run(userId, contactId, muteUntil, forever ? 1 : 0);

    res.json({ success: true, muteUntil, isForever: forever });
});

app.delete('/api/profile/:id/chats/:contactId/mute', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    db.prepare(`
        DELETE FROM chat_mutes
        WHERE user_id = ?
          AND muted_user_id = ?
    `).run(userId, contactId);

    res.json({ success: true });
});

app.delete('/api/profile/:id/chats/:contactId/history', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const contactId = Number(req.params.contactId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }
    if (!canUsersAccessStoredChat(userId, contactId)) {
        return res.status(403).json({ success: false, message: 'Chat nicht erlaubt' });
    }

    db.prepare(`
        DELETE FROM messages
        WHERE (sender_id = ? AND receiver_id = ?)
           OR (sender_id = ? AND receiver_id = ?)
    `).run(userId, contactId, contactId, userId);

    res.json({ success: true });
});

app.post('/api/profile/:id/integrations/tokens', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const name = String(req.body?.name || '').trim();

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const tokenRecord = createIntegrationTokenRecord(userId, name);
    res.json({ success: true, token: tokenRecord.token, tokenId: tokenRecord.id });
});

app.post('/api/profile/:id/integrations/tokens/:tokenId/rotate', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const tokenId = Number(req.params.tokenId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const token = generateIntegrationTokenValue();
    db.prepare(`
        UPDATE integration_tokens
        SET token_hash = ?, last_used_at = NULL, active = 1
        WHERE id = ? AND user_id = ?
    `).run(hashIntegrationToken(token), tokenId, userId);

    res.json({ success: true, token });
});

app.put('/api/profile/:id/integrations/tokens/:tokenId', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const tokenId = Number(req.params.tokenId);
    const requestedName = String(req.body?.name || '').trim();

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const token = db.prepare(`
        SELECT id, name, integration_user_id
        FROM integration_tokens
        WHERE id = ? AND user_id = ?
    `).get(tokenId, userId);

    if (!token) {
        return res.status(404).json({ success: false, message: 'API Key nicht gefunden' });
    }

    const normalizedName = normalizeIntegrationUsernameInput(requestedName);
    if (!normalizedName) {
        return res.status(400).json({ success: false, message: 'Bitte einen gueltigen Chatnamen angeben' });
    }

    if (token.integration_user_id) {
        const exists = db.prepare(`
            SELECT id
            FROM users
            WHERE LOWER(username) = LOWER(?)
              AND id != ?
        `).get(normalizedName, token.integration_user_id);

        if (exists) {
            return res.status(400).json({ success: false, message: 'Chatname ist bereits vergeben' });
        }

        db.prepare(`
            UPDATE users
            SET username = ?
            WHERE id = ? AND owner_user_id = ?
        `).run(normalizedName, token.integration_user_id, userId);
    }

    db.prepare('UPDATE integration_tokens SET name = ? WHERE id = ? AND user_id = ?').run(normalizedName, tokenId, userId);
    broadcastVisibleUserList();
    res.json({ success: true, name: normalizedName });
});

app.post('/api/profile/:id/integrations/tokens/:tokenId/toggle', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const tokenId = Number(req.params.tokenId);
    const active = req.body?.active ? 1 : 0;

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const token = db.prepare(`
        SELECT integration_user_id
        FROM integration_tokens
        WHERE id = ? AND user_id = ?
    `).get(tokenId, userId);

    db.prepare(`
        UPDATE integration_tokens
        SET active = ?
        WHERE id = ? AND user_id = ?
    `).run(active, tokenId, userId);

    if (token?.integration_user_id && active !== 1) {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', token.integration_user_id);
        const timer = integrationPresenceTimers.get(Number(token.integration_user_id));
        if (timer) {
            clearTimeout(timer);
            integrationPresenceTimers.delete(Number(token.integration_user_id));
        }
    }

    broadcastVisibleUserList();

    res.json({ success: true });
});

app.delete('/api/profile/:id/integrations/tokens/:tokenId', (req, res) => {
    const userId = Number(req.params.id);
    const requesterId = Number(req.body?.requesterId || userId);
    const tokenId = Number(req.params.tokenId);

    if (userId !== requesterId) {
        return res.status(403).json({ success: false, message: 'Nicht erlaubt' });
    }

    const token = db.prepare(`
        SELECT id, integration_user_id
        FROM integration_tokens
        WHERE id = ? AND user_id = ?
    `).get(tokenId, userId);

    if (!token) {
        return res.status(404).json({ success: false, message: 'API Key nicht gefunden' });
    }

    db.prepare('DELETE FROM integration_tokens WHERE id = ? AND user_id = ?').run(tokenId, userId);

    if (token.integration_user_id) {
        db.prepare(`
            UPDATE users
            SET can_chat = 0,
                status = 'offline'
            WHERE id = ? AND owner_user_id = ?
        `).run(token.integration_user_id, userId);

        const timer = integrationPresenceTimers.get(Number(token.integration_user_id));
        if (timer) {
            clearTimeout(timer);
            integrationPresenceTimers.delete(Number(token.integration_user_id));
        }
    }

    broadcastVisibleUserList();
    res.json({ success: true });
});

// Get Public Key for a User
app.get('/api/keys/:userId', (req, res) => {
    const user = db.prepare('SELECT public_key FROM users WHERE id = ?').get(req.params.userId);
    if (!user) return res.status(404).json({ success: false });
    res.json({ publicKey: user.public_key });
});

function listMaintenanceBuildings() {
    return db.prepare(`
        SELECT
            b.*,
            COUNT(DISTINCT a.id) AS apartment_count,
            COUNT(DISTINCT ma.id) AS asset_count
        FROM maintenance_buildings b
        LEFT JOIN maintenance_apartments a ON a.building_id = b.id
        LEFT JOIN maintenance_assets ma ON ma.building_id = b.id
        GROUP BY b.id
        ORDER BY b.name COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        apartment_count: Number(row.apartment_count || 0),
        asset_count: Number(row.asset_count || 0)
    }));
}

function listMaintenanceApartments() {
    return db.prepare(`
        SELECT
            a.*,
            b.name AS building_name,
            COUNT(ma.id) AS asset_count
        FROM maintenance_apartments a
        JOIN maintenance_buildings b ON b.id = a.building_id
        LEFT JOIN maintenance_assets ma ON ma.apartment_id = a.id
        GROUP BY a.id
        ORDER BY b.name COLLATE NOCASE ASC, a.name COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        asset_count: Number(row.asset_count || 0)
    }));
}

function listMaintenanceTemplates() {
    const templates = db.prepare(`
        SELECT
            t.*,
            COUNT(ma.id) AS asset_count
        FROM maintenance_asset_templates t
        LEFT JOIN maintenance_assets ma ON ma.template_id = t.id
        GROUP BY t.id
        ORDER BY t.category COLLATE NOCASE ASC, t.name COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        active: Number(row.active || 0) === 1,
        default_interval_days: Number(row.default_interval_days || 0),
        asset_count: Number(row.asset_count || 0)
    }));
    const fileRows = db.prepare(`
        SELECT id, template_id, original_name, stored_name, mime_type
        FROM maintenance_template_files
        ORDER BY created_at DESC, id DESC
    `).all();
    const fileMap = new Map();
    fileRows.forEach((file) => {
        const key = Number(file.template_id);
        if (!fileMap.has(key)) fileMap.set(key, []);
        fileMap.get(key).push({
            id: file.id,
            original_name: file.original_name,
            stored_name: file.stored_name,
            mime_type: file.mime_type || '',
            url: `/uploads/${file.stored_name}`
        });
    });
    return templates.map((template) => ({
        ...template,
        files: fileMap.get(Number(template.id)) || []
    }));
}

function listMaintenanceAssets() {
    const assets = db.prepare(`
        SELECT
            ma.*,
            t.name AS template_name,
            t.category AS template_category,
            t.description AS template_description,
            t.checklist AS template_checklist,
            t.default_interval_days AS template_default_interval_days,
            b.name AS building_name,
            a.name AS apartment_name,
            COUNT(mp.id) AS plan_count
        FROM maintenance_assets ma
        JOIN maintenance_asset_templates t ON t.id = ma.template_id
        JOIN maintenance_buildings b ON b.id = ma.building_id
        LEFT JOIN maintenance_apartments a ON a.id = ma.apartment_id
        LEFT JOIN maintenance_plans mp ON mp.asset_id = ma.id
        GROUP BY ma.id
        ORDER BY b.name COLLATE NOCASE ASC, ma.name COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        plan_count: Number(row.plan_count || 0)
    }));
    const templateIds = [...new Set(assets.map((asset) => Number(asset.template_id)).filter(Boolean))];
    const fileMap = new Map();
    if (templateIds.length) {
        const placeholders = templateIds.map(() => '?').join(', ');
        const fileRows = db.prepare(`
            SELECT id, template_id, original_name, stored_name, mime_type
            FROM maintenance_template_files
            WHERE template_id IN (${placeholders})
            ORDER BY created_at DESC, id DESC
        `).all(...templateIds);
        fileRows.forEach((file) => {
            const key = Number(file.template_id);
            if (!fileMap.has(key)) fileMap.set(key, []);
            fileMap.get(key).push({
                id: file.id,
                original_name: file.original_name,
                stored_name: file.stored_name,
                mime_type: file.mime_type || '',
                url: `/uploads/${file.stored_name}`
            });
        });
    }
    return assets.map((asset) => ({
        ...asset,
        template_files: fileMap.get(Number(asset.template_id)) || [],
        template_default_interval_days: Number(asset.template_default_interval_days || 0)
    }));
}

function listMaintenanceStaff() {
    return db.prepare(`
        SELECT
            ms.*,
            COUNT(mp.id) AS plan_count
        FROM maintenance_staff ms
        LEFT JOIN maintenance_plans mp ON mp.responsible_staff_id = ms.id
        GROUP BY ms.id
        ORDER BY ms.active DESC, ms.name COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        active: Number(row.active || 0) === 1,
        plan_count: Number(row.plan_count || 0)
    }));
}

function listMaintenancePlans() {
    const plans = db.prepare(`
        SELECT
            mp.*,
            ma.name AS asset_name,
            ma.template_id AS template_id,
            b.name AS building_name,
            a.name AS apartment_name,
            a.tenant_name AS tenant_name,
            t.name AS template_name,
            t.description AS template_description,
            t.checklist AS template_checklist,
            t.default_interval_days AS template_default_interval_days,
            ms.name AS staff_name
        FROM maintenance_plans mp
        JOIN maintenance_assets ma ON ma.id = mp.asset_id
        JOIN maintenance_buildings b ON b.id = ma.building_id
        LEFT JOIN maintenance_apartments a ON a.id = ma.apartment_id
        LEFT JOIN maintenance_asset_templates t ON t.id = ma.template_id
        LEFT JOIN maintenance_staff ms ON ms.id = mp.responsible_staff_id
        ORDER BY
            CASE WHEN COALESCE(mp.next_due_date, '') = '' THEN 1 ELSE 0 END ASC,
            mp.next_due_date ASC,
            mp.title COLLATE NOCASE ASC
    `).all().map((row) => ({
        ...row,
        active: Number(row.active || 0) === 1,
        interval_days: Number(row.interval_days || 0),
        completion_requires_photo: Number(row.completion_requires_photo || 0) === 1,
        responsible_staff_id: row.responsible_staff_id ? Number(row.responsible_staff_id) : null
    }));
    const templateIds = [...new Set(plans.map((plan) => Number(plan.template_id)).filter(Boolean))];
    const fileMap = new Map();
    if (templateIds.length) {
        const placeholders = templateIds.map(() => '?').join(', ');
        const fileRows = db.prepare(`
            SELECT id, template_id, original_name, stored_name, mime_type
            FROM maintenance_template_files
            WHERE template_id IN (${placeholders})
            ORDER BY created_at DESC, id DESC
        `).all(...templateIds);
        fileRows.forEach((file) => {
            const key = Number(file.template_id);
            if (!fileMap.has(key)) fileMap.set(key, []);
            fileMap.get(key).push({
                id: file.id,
                original_name: file.original_name,
                stored_name: file.stored_name,
                mime_type: file.mime_type || '',
                url: `/uploads/${file.stored_name}`
            });
        });
    }
    return plans.map((plan) => ({
        ...plan,
        template_files: fileMap.get(Number(plan.template_id)) || [],
        template_default_interval_days: Number(plan.template_default_interval_days || 0)
    }));
}

function listMaintenancePlanCompletions(planId) {
    const completions = db.prepare(`
        SELECT *
        FROM maintenance_plan_completions
        WHERE plan_id = ?
        ORDER BY completed_at DESC, id DESC
    `).all(Number(planId)).map((row) => ({
        ...row,
        signature_url: row.signature_stored_name ? `/uploads/${row.signature_stored_name}` : '',
        checklist_state: (() => {
            try {
                return row.checklist_state ? JSON.parse(row.checklist_state) : [];
            } catch (error) {
                return [];
            }
        })()
    }));
    const completionIds = completions.map((completion) => Number(completion.id)).filter(Boolean);
    const mediaMap = new Map();
    if (completionIds.length) {
        const placeholders = completionIds.map(() => '?').join(', ');
        const mediaRows = db.prepare(`
            SELECT id, completion_id, original_name, stored_name, mime_type
            FROM maintenance_plan_completion_media
            WHERE completion_id IN (${placeholders})
            ORDER BY id ASC
        `).all(...completionIds);
        mediaRows.forEach((media) => {
            const key = Number(media.completion_id);
            if (!mediaMap.has(key)) mediaMap.set(key, []);
            mediaMap.get(key).push({
                id: media.id,
                original_name: media.original_name,
                stored_name: media.stored_name,
                mime_type: media.mime_type || '',
                url: `/uploads/${media.stored_name}`
            });
        });
    }
    return completions.map((completion) => ({
        ...completion,
        photos: mediaMap.get(Number(completion.id)) || []
    }));
}

function getMaintenanceSummary() {
    const today = new Date().toISOString().slice(0, 10);
    const soon = addDaysIso(today, 30);
    return {
        buildings: Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_buildings').get() || {}).count || 0),
        apartments: Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_apartments').get() || {}).count || 0),
        templates: Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_asset_templates').get() || {}).count || 0),
        assets: Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_assets').get() || {}).count || 0),
        activePlans: Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_plans WHERE active = 1').get() || {}).count || 0),
        overduePlans: Number((db.prepare("SELECT COUNT(*) AS count FROM maintenance_plans WHERE active = 1 AND COALESCE(next_due_date, '') <> '' AND next_due_date < ?").get(today) || {}).count || 0),
        dueSoonPlans: Number((db.prepare("SELECT COUNT(*) AS count FROM maintenance_plans WHERE active = 1 AND COALESCE(next_due_date, '') <> '' AND next_due_date >= ? AND next_due_date <= ?").get(today, soon) || {}).count || 0)
    };
}

function escapeHtmlForMail(value) {
    return String(value || '').replace(/[&<>"']/g, (match) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[match]));
}

function buildMaintenancePlanLink(planId) {
    const baseUrl = maintenancePublicUrl || '';
    if (!baseUrl) return '';
    const hasQuery = baseUrl.includes('?');
    return `${baseUrl}${hasQuery ? '&' : '?'}plan=${encodeURIComponent(planId)}`;
}

function buildMaintenanceBoardLink() {
    return maintenancePublicUrl || '';
}

function loadDueMaintenancePlans(todayIso) {
    return db.prepare(`
        SELECT
            mp.id,
            mp.title,
            mp.interval_days,
            mp.next_due_date,
            mp.last_completed_at,
            mp.responsible,
            mp.priority,
            mp.instructions,
            ma.name AS asset_name,
            ma.location AS asset_location,
            ma.serial_number,
            b.name AS building_name,
            b.address AS building_address,
            b.city AS building_city,
            a.name AS apartment_name,
            t.name AS template_name
        FROM maintenance_plans mp
        JOIN maintenance_assets ma ON ma.id = mp.asset_id
        JOIN maintenance_buildings b ON b.id = ma.building_id
        LEFT JOIN maintenance_apartments a ON a.id = ma.apartment_id
        LEFT JOIN maintenance_asset_templates t ON t.id = ma.template_id
        WHERE mp.active = 1
          AND COALESCE(mp.next_due_date, '') <> ''
          AND mp.next_due_date <= ?
        ORDER BY mp.next_due_date ASC, mp.priority DESC, mp.title COLLATE NOCASE ASC
    `).all(todayIso);
}

function loadMaintenanceMailRecipients() {
    return db.prepare(`
        SELECT id, username, display_name, email, role
        FROM users
        WHERE COALESCE(email, '') <> ''
          AND (role = 'admin' OR can_access_maintenance_board = 1)
        ORDER BY username COLLATE NOCASE ASC
    `).all();
}

function loadNextMaintenancePlan() {
    return db.prepare(`
        SELECT mp.id, mp.title, mp.interval_days, mp.next_due_date, mp.last_completed_at, mp.responsible, mp.priority, mp.instructions, mp.active,
               ma.name AS asset_name, ma.location AS asset_location, ma.serial_number,
               mb.name AS building_name,
               ap.name AS apartment_name,
               mt.name AS template_name
        FROM maintenance_plans mp
        JOIN maintenance_assets ma ON ma.id = mp.asset_id
        LEFT JOIN maintenance_buildings mb ON mb.id = ma.building_id
        LEFT JOIN maintenance_apartments ap ON ap.id = ma.apartment_id
        LEFT JOIN maintenance_asset_templates mt ON mt.id = ma.template_id
        WHERE mp.active = 1
        ORDER BY mp.next_due_date ASC, mp.id ASC
        LIMIT 1
    `).get() || null;
}

function buildMaintenanceMail(plan, recipient) {
    const link = buildMaintenancePlanLink(plan.id);
    const subject = `DR-MAINTENANCE BOARD: Wartung fällig - ${plan.title}`;
    const lines = [
        `Hallo ${recipient.display_name || recipient.username},`,
        '',
        'eine Wartung ist fällig.',
        '',
        `Titel: ${plan.title}`,
        `Gebäude: ${plan.building_name || '-'}`,
        `Apartment: ${plan.apartment_name || '-'}`,
        `Wartungsobjekt: ${plan.asset_name || '-'}`,
        `Typ: ${plan.template_name || '-'}`,
        `Termin: ${plan.next_due_date || '-'}`,
        `Verantwortlich: ${plan.responsible || '-'}`,
        `Priorität: ${plan.priority || '-'}`,
        `Intervall: ${plan.interval_days || 0} Tage`,
        `Ort: ${plan.asset_location || '-'}`,
        `Seriennummer: ${plan.serial_number || '-'}`,
        `Zuletzt erledigt: ${plan.last_completed_at || '-'}`,
        `Anweisung: ${plan.instructions || '-'}`,
        ''
    ];
    if (link) {
        lines.push(`Direkt zur Wartung: ${link}`);
        lines.push('');
    }
    lines.push('Viele Grüße');
    lines.push('DR-MAINTENANCE BOARD');

    const html = `
        <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5">
            <h2 style="margin:0 0 14px">DR-MAINTENANCE BOARD</h2>
            <p>Hallo ${escapeHtmlForMail(recipient.display_name || recipient.username)},</p>
            <p>eine Wartung ist fällig.</p>
            <table style="border-collapse:collapse;width:100%;max-width:720px">
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Titel</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.title)}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Gebäude</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.building_name || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Apartment</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.apartment_name || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Wartungsobjekt</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.asset_name || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Typ</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.template_name || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Termin</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.next_due_date || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Verantwortlich</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.responsible || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Priorität</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.priority || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Intervall</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(`${plan.interval_days || 0} Tage`)}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Ort</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.asset_location || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Seriennummer</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.serial_number || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Zuletzt erledigt</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.last_completed_at || '-')}</td></tr>
                <tr><td style="padding:6px 10px;border:1px solid #ddd"><strong>Anweisung</strong></td><td style="padding:6px 10px;border:1px solid #ddd">${escapeHtmlForMail(plan.instructions || '-')}</td></tr>
            </table>
            ${link ? `<p style="margin-top:16px"><a href="${escapeHtmlForMail(link)}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px">Direkt zur Wartung</a></p>` : ''}
            <p>Viele Grüße<br>DR-MAINTENANCE BOARD</p>
        </div>
    `;
    return {
        subject,
        text: lines.join('\n'),
        html
    };
}

function buildMaintenanceTestMail(recipient) {
    const nextPlan = loadNextMaintenancePlan();
    if (nextPlan) {
        const message = buildMaintenanceMail(nextPlan, recipient);
        return {
            subject: `[TEST] ${message.subject}`,
            text: `Dies ist ein Test des DRQ-Mailversands.\nGeplanter Versandrhythmus: ${getMaintenanceScheduleLabel()}\n\n${message.text}`,
            html: `
                <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5">
                    <p><strong>Dies ist ein Test des DRQ-Mailversands.</strong></p>
                    <p>Geplanter Versandrhythmus: ${escapeHtmlForMail(getMaintenanceScheduleLabel())}</p>
                    <hr style="margin:18px 0;border:none;border-top:1px solid #ddd">
                    ${message.html}
                </div>
            `
        };
    }

    const boardLink = buildMaintenanceBoardLink();
    const textLines = [
        'Dies ist ein Test des DRQ-Mailversands.',
        `Geplanter Versandrhythmus: ${getMaintenanceScheduleLabel()}`,
        '',
        'Aktuell ist noch kein aktiver Wartungsplan vorhanden.'
    ];
    if (boardLink) {
        textLines.push(`Board öffnen: ${boardLink}`);
    }

    return {
        subject: '[TEST] DR-MAINTENANCE BOARD Mailversand',
        text: textLines.join('\n'),
        html: `
            <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5">
                <h2 style="margin:0 0 14px">DR-MAINTENANCE BOARD</h2>
                <p><strong>Dies ist ein Test des DRQ-Mailversands.</strong></p>
                <p>Geplanter Versandrhythmus: ${escapeHtmlForMail(getMaintenanceScheduleLabel())}</p>
                <p>Aktuell ist noch kein aktiver Wartungsplan vorhanden.</p>
                ${boardLink ? `<p><a href="${escapeHtmlForMail(boardLink)}" style="display:inline-block;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:8px">Board öffnen</a></p>` : ''}
            </div>
        `
    };
}

async function sendDueMaintenanceEmails() {
    if (!mailTransporter || !maintenanceMailEnabled) return;
    const todayIso = getLocalIsoDate();
    const plans = loadDueMaintenancePlans(todayIso);
    if (!plans.length) return;

    const recipients = loadMaintenanceMailRecipients();
    if (!recipients.length) return;

    for (const plan of plans) {
        for (const recipient of recipients) {
            const alreadySent = db.prepare(`
                SELECT id
                FROM maintenance_email_log
                WHERE plan_id = ? AND due_date = ? AND user_id = ?
            `).get(plan.id, plan.next_due_date, recipient.id);
            if (alreadySent) continue;

            const message = buildMaintenanceMail(plan, recipient);
            try {
                await mailTransporter.sendMail({
                    from: smtpFrom,
                    to: recipient.email,
                    subject: message.subject,
                    text: message.text,
                    html: message.html
                });
                db.prepare(`
                    INSERT INTO maintenance_email_log (plan_id, due_date, user_id, recipient_email)
                    VALUES (?, ?, ?, ?)
                `).run(plan.id, plan.next_due_date, recipient.id, recipient.email);
            } catch (error) {
                console.error('Maintenance mail send failed', {
                    planId: plan.id,
                    recipient: recipient.email,
                    message: error.message || String(error)
                });
            }
        }
    }
}

function startMaintenanceMailLoop() {
    if (!mailTransporter || !maintenanceMailEnabled || maintenanceMailTimer) return;
    if (maintenanceMailSchedule === 'interval') {
        sendDueMaintenanceEmails().catch((error) => {
            console.error('Initial maintenance mail run failed', error);
        });
        maintenanceMailTimer = setInterval(() => {
            sendDueMaintenanceEmails().catch((error) => {
                console.error('Scheduled maintenance mail run failed', error);
            });
        }, maintenanceMailIntervalMinutes * 60 * 1000);
        return;
    }

    const scheduleNextNightlyRun = () => {
        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setHours(maintenanceMailHour, maintenanceMailMinute, 0, 0);
        if (nextRun <= now) {
            nextRun.setDate(nextRun.getDate() + 1);
        }

        const delay = Math.max(60 * 1000, nextRun.getTime() - now.getTime());
        maintenanceMailTimer = setTimeout(async () => {
            try {
                const runDate = getLocalIsoDate();
                if (maintenanceMailLastRunDate !== runDate) {
                    await sendDueMaintenanceEmails();
                    maintenanceMailLastRunDate = runDate;
                }
            } catch (error) {
                console.error('Scheduled nightly maintenance mail run failed', error);
            } finally {
                maintenanceMailTimer = null;
                scheduleNextNightlyRun();
            }
        }, delay);
    };

    scheduleNextNightlyRun();
}

app.get('/api/maintenance/bootstrap', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    res.json({
        success: true,
        currentUser: {
            id: requester.id,
            username: requester.username,
            display_name: requester.display_name || '',
            role: requester.role
        },
        summary: getMaintenanceSummary(),
        buildings: listMaintenanceBuildings(),
        apartments: listMaintenanceApartments(),
        templates: listMaintenanceTemplates(),
        assets: listMaintenanceAssets(),
        staff: listMaintenanceStaff(),
        plans: listMaintenancePlans()
    });
});

app.post('/api/maintenance/test-mail', async (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    if (requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen Testmails senden.' });
    }
    if (!mailTransporter || !maintenanceMailEnabled) {
        return res.status(400).json({ success: false, message: 'Mailversand ist nicht aktiv konfiguriert.' });
    }

    const targetEmail = String(requester.email || '').trim();
    if (!targetEmail) {
        return res.status(400).json({ success: false, message: 'Bitte hinterlege zuerst eine E-Mail-Adresse bei deinem Admin-Benutzer.' });
    }

    try {
        const message = buildMaintenanceTestMail(requester);
        await mailTransporter.sendMail({
            from: smtpFrom,
            to: targetEmail,
            subject: message.subject,
            text: message.text,
            html: message.html
        });
        res.json({
            success: true,
            message: `Testmail an ${targetEmail} versendet.`,
            schedule: getMaintenanceScheduleLabel()
        });
    } catch (error) {
        console.error('Maintenance test mail failed', error);
        res.status(500).json({ success: false, message: error.message || 'Testmail konnte nicht versendet werden.' });
    }
});

app.post('/api/maintenance/buildings', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'Gebäudename fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_buildings (name, code, address, city, notes, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        name,
        String(req.body?.code || '').trim(),
        String(req.body?.address || '').trim(),
        String(req.body?.city || '').trim(),
        String(req.body?.notes || '').trim(),
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/buildings/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!db.prepare('SELECT id FROM maintenance_buildings WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Gebäude nicht gefunden' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Gebäudename fehlt' });

    db.prepare(`
        UPDATE maintenance_buildings
        SET name = ?, code = ?, address = ?, city = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name,
        String(req.body?.code || '').trim(),
        String(req.body?.address || '').trim(),
        String(req.body?.city || '').trim(),
        String(req.body?.notes || '').trim(),
        id
    );

    res.json({ success: true });
});

app.delete('/api/maintenance/buildings/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const apartmentCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_apartments WHERE building_id = ?').get(id) || {}).count || 0);
    const assetCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_assets WHERE building_id = ?').get(id) || {}).count || 0);
    if (apartmentCount || assetCount) {
        return res.status(400).json({ success: false, message: 'Gebäude enthält noch Apartments oder Wartungsobjekte' });
    }
    db.prepare('DELETE FROM maintenance_buildings WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/maintenance/apartments', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const buildingId = Number(req.body?.building_id);
    const name = String(req.body?.name || '').trim();
    if (!buildingId || !db.prepare('SELECT id FROM maintenance_buildings WHERE id = ?').get(buildingId)) {
        return res.status(400).json({ success: false, message: 'Gebäude fehlt' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Apartmentname fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_apartments (building_id, name, floor, unit_number, tenant_name, notes, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        buildingId,
        name,
        String(req.body?.floor || '').trim(),
        String(req.body?.unit_number || '').trim(),
        String(req.body?.tenant_name || '').trim(),
        String(req.body?.notes || '').trim(),
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/apartments/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const buildingId = Number(req.body?.building_id);
    const name = String(req.body?.name || '').trim();
    if (!db.prepare('SELECT id FROM maintenance_apartments WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Apartment nicht gefunden' });
    }
    if (!buildingId || !db.prepare('SELECT id FROM maintenance_buildings WHERE id = ?').get(buildingId)) {
        return res.status(400).json({ success: false, message: 'Gebäude fehlt' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Apartmentname fehlt' });

    db.prepare(`
        UPDATE maintenance_apartments
        SET building_id = ?, name = ?, floor = ?, unit_number = ?, tenant_name = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        buildingId,
        name,
        String(req.body?.floor || '').trim(),
        String(req.body?.unit_number || '').trim(),
        String(req.body?.tenant_name || '').trim(),
        String(req.body?.notes || '').trim(),
        id
    );

    res.json({ success: true });
});

app.delete('/api/maintenance/apartments/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const assetCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_assets WHERE apartment_id = ?').get(id) || {}).count || 0);
    if (assetCount) {
        return res.status(400).json({ success: false, message: 'Apartment enthält noch Wartungsobjekte' });
    }
    db.prepare('DELETE FROM maintenance_apartments WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/maintenance/templates', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'Stammdatename fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_asset_templates (name, category, description, manufacturer, default_interval_days, checklist, active, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        name,
        String(req.body?.category || '').trim(),
        String(req.body?.description || '').trim(),
        String(req.body?.manufacturer || '').trim(),
        Math.max(1, Number(req.body?.default_interval_days || 180)),
        String(req.body?.checklist || '').trim(),
        req.body?.active === false ? 0 : 1,
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/templates/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!db.prepare('SELECT id FROM maintenance_asset_templates WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Stammdatensatz nicht gefunden' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Stammdatename fehlt' });

    db.prepare(`
        UPDATE maintenance_asset_templates
        SET name = ?, category = ?, description = ?, manufacturer = ?, default_interval_days = ?, checklist = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name,
        String(req.body?.category || '').trim(),
        String(req.body?.description || '').trim(),
        String(req.body?.manufacturer || '').trim(),
        Math.max(1, Number(req.body?.default_interval_days || 180)),
        String(req.body?.checklist || '').trim(),
        req.body?.active === false ? 0 : 1,
        id
    );

    res.json({ success: true });
});

app.post('/api/maintenance/templates/:id/files', upload.single('file'), (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;
    const templateId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM maintenance_asset_templates WHERE id = ?').get(templateId)) {
        return res.status(404).json({ success: false, message: 'Stammdatensatz nicht gefunden' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Keine Datei hochgeladen' });
    }
    const result = db.prepare(`
        INSERT INTO maintenance_template_files (template_id, original_name, stored_name, mime_type)
        VALUES (?, ?, ?, ?)
    `).run(
        templateId,
        req.file.originalname,
        req.file.filename,
        req.file.mimetype || ''
    );
    res.json({
        success: true,
        file: {
            id: result.lastInsertRowid,
            original_name: req.file.originalname,
            stored_name: req.file.filename,
            mime_type: req.file.mimetype || '',
            url: `/uploads/${req.file.filename}`
        }
    });
});

app.delete('/api/maintenance/templates/:templateId/files/:fileId', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;
    const templateId = Number(req.params.templateId);
    const fileId = Number(req.params.fileId);
    const file = db.prepare('SELECT id, stored_name FROM maintenance_template_files WHERE id = ? AND template_id = ?').get(fileId, templateId);
    if (!file) {
        return res.status(404).json({ success: false, message: 'Datei nicht gefunden' });
    }
    db.prepare('DELETE FROM maintenance_template_files WHERE id = ?').run(fileId);
    res.json({ success: true });
});

app.delete('/api/maintenance/templates/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const assetCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_assets WHERE template_id = ?').get(id) || {}).count || 0);
    if (assetCount) {
        return res.status(400).json({ success: false, message: 'Stammdatensatz wird noch von Wartungsobjekten genutzt' });
    }
    db.prepare('DELETE FROM maintenance_asset_templates WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/maintenance/assets', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const templateId = Number(req.body?.template_id);
    const buildingId = Number(req.body?.building_id);
    const apartmentId = req.body?.apartment_id ? Number(req.body.apartment_id) : null;
    const name = String(req.body?.name || '').trim();
    if (!templateId || !db.prepare('SELECT id FROM maintenance_asset_templates WHERE id = ?').get(templateId)) {
        return res.status(400).json({ success: false, message: 'Stammdatensatz fehlt' });
    }
    if (!buildingId || !db.prepare('SELECT id FROM maintenance_buildings WHERE id = ?').get(buildingId)) {
        return res.status(400).json({ success: false, message: 'Gebäude fehlt' });
    }
    if (apartmentId && !db.prepare('SELECT id FROM maintenance_apartments WHERE id = ? AND building_id = ?').get(apartmentId, buildingId)) {
        return res.status(400).json({ success: false, message: 'Apartment passt nicht zum Gebäude' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Name des Wartungsobjekts fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_assets (template_id, building_id, apartment_id, name, location, serial_number, status, installed_on, notes, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        templateId,
        buildingId,
        apartmentId,
        name,
        String(req.body?.location || '').trim(),
        String(req.body?.serial_number || '').trim(),
        String(req.body?.status || 'active').trim() || 'active',
        normalizeMaintenanceDate(req.body?.installed_on),
        String(req.body?.notes || '').trim(),
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/assets/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const templateId = Number(req.body?.template_id);
    const buildingId = Number(req.body?.building_id);
    const apartmentId = req.body?.apartment_id ? Number(req.body.apartment_id) : null;
    const name = String(req.body?.name || '').trim();
    if (!db.prepare('SELECT id FROM maintenance_assets WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Wartungsobjekt nicht gefunden' });
    }
    if (!templateId || !db.prepare('SELECT id FROM maintenance_asset_templates WHERE id = ?').get(templateId)) {
        return res.status(400).json({ success: false, message: 'Stammdatensatz fehlt' });
    }
    if (!buildingId || !db.prepare('SELECT id FROM maintenance_buildings WHERE id = ?').get(buildingId)) {
        return res.status(400).json({ success: false, message: 'Gebäude fehlt' });
    }
    if (apartmentId && !db.prepare('SELECT id FROM maintenance_apartments WHERE id = ? AND building_id = ?').get(apartmentId, buildingId)) {
        return res.status(400).json({ success: false, message: 'Apartment passt nicht zum Gebäude' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Name des Wartungsobjekts fehlt' });

    db.prepare(`
        UPDATE maintenance_assets
        SET template_id = ?, building_id = ?, apartment_id = ?, name = ?, location = ?, serial_number = ?, status = ?, installed_on = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        templateId,
        buildingId,
        apartmentId,
        name,
        String(req.body?.location || '').trim(),
        String(req.body?.serial_number || '').trim(),
        String(req.body?.status || 'active').trim() || 'active',
        normalizeMaintenanceDate(req.body?.installed_on),
        String(req.body?.notes || '').trim(),
        id
    );

    res.json({ success: true });
});

app.delete('/api/maintenance/assets/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const planCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_plans WHERE asset_id = ?').get(id) || {}).count || 0);
    if (planCount) {
        return res.status(400).json({ success: false, message: 'Wartungsobjekt hat noch Wartungspläne' });
    }
    db.prepare('DELETE FROM maintenance_assets WHERE id = ?').run(id);
    res.json({ success: true });
});

app.post('/api/maintenance/staff', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: 'Name fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_staff (name, role, email, phone, notes, active, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        name,
        String(req.body?.role || '').trim(),
        String(req.body?.email || '').trim(),
        String(req.body?.phone || '').trim(),
        String(req.body?.notes || '').trim(),
        req.body?.active === false ? 0 : 1,
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/staff/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!db.prepare('SELECT id FROM maintenance_staff WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Mitarbeiter nicht gefunden' });
    }
    if (!name) return res.status(400).json({ success: false, message: 'Name fehlt' });

    db.prepare(`
        UPDATE maintenance_staff
        SET name = ?, role = ?, email = ?, phone = ?, notes = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        name,
        String(req.body?.role || '').trim(),
        String(req.body?.email || '').trim(),
        String(req.body?.phone || '').trim(),
        String(req.body?.notes || '').trim(),
        req.body?.active === false ? 0 : 1,
        id
    );

    res.json({ success: true });
});

app.delete('/api/maintenance/staff/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const planCount = Number((db.prepare('SELECT COUNT(*) AS count FROM maintenance_plans WHERE responsible_staff_id = ?').get(id) || {}).count || 0);
    if (planCount) {
        return res.status(400).json({ success: false, message: 'Mitarbeiter ist noch Wartungsplänen zugewiesen' });
    }
    db.prepare('DELETE FROM maintenance_staff WHERE id = ?').run(id);
    res.json({ success: true });
});

app.get('/api/maintenance/plans/:id/completions', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    if (!db.prepare('SELECT id FROM maintenance_plans WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Wartungsplan nicht gefunden' });
    }
    res.json({ success: true, completions: listMaintenancePlanCompletions(id) });
});

app.post('/api/maintenance/plans', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const assetId = Number(req.body?.asset_id);
    const responsibleStaffId = Number(req.body?.responsible_staff_id || 0);
    const title = String(req.body?.title || '').trim();
    const intervalDays = Math.max(1, Number(req.body?.interval_days || 180));
    const nextDueDate = normalizeMaintenanceDate(req.body?.next_due_date) || addDaysIso(new Date().toISOString().slice(0, 10), intervalDays);
    if (!assetId || !db.prepare('SELECT id FROM maintenance_assets WHERE id = ?').get(assetId)) {
        return res.status(400).json({ success: false, message: 'Wartungsobjekt fehlt' });
    }
    if (responsibleStaffId && !db.prepare('SELECT id FROM maintenance_staff WHERE id = ?').get(responsibleStaffId)) {
        return res.status(400).json({ success: false, message: 'Mitarbeiter nicht gefunden' });
    }
    if (!title) return res.status(400).json({ success: false, message: 'Titel fehlt' });

    const result = db.prepare(`
        INSERT INTO maintenance_plans (asset_id, title, interval_days, next_due_date, last_completed_at, last_completion_note, completion_checklist, completion_requires_photo, responsible_staff_id, responsible, priority, instructions, active, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        assetId,
        title,
        intervalDays,
        nextDueDate,
        normalizeMaintenanceDate(req.body?.last_completed_at),
        String(req.body?.last_completion_note || '').trim(),
        String(req.body?.completion_checklist || '').trim(),
        req.body?.completion_requires_photo ? 1 : 0,
        responsibleStaffId || null,
        String(req.body?.responsible || '').trim(),
        String(req.body?.priority || 'normal').trim() || 'normal',
        String(req.body?.instructions || '').trim(),
        req.body?.active === false ? 0 : 1,
        requester.id
    );

    res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/maintenance/plans/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const assetId = Number(req.body?.asset_id);
    const responsibleStaffId = Number(req.body?.responsible_staff_id || 0);
    const title = String(req.body?.title || '').trim();
    const intervalDays = Math.max(1, Number(req.body?.interval_days || 180));
    if (!db.prepare('SELECT id FROM maintenance_plans WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, message: 'Wartungsplan nicht gefunden' });
    }
    if (!assetId || !db.prepare('SELECT id FROM maintenance_assets WHERE id = ?').get(assetId)) {
        return res.status(400).json({ success: false, message: 'Wartungsobjekt fehlt' });
    }
    if (responsibleStaffId && !db.prepare('SELECT id FROM maintenance_staff WHERE id = ?').get(responsibleStaffId)) {
        return res.status(400).json({ success: false, message: 'Mitarbeiter nicht gefunden' });
    }
    if (!title) return res.status(400).json({ success: false, message: 'Titel fehlt' });

    db.prepare(`
        UPDATE maintenance_plans
        SET asset_id = ?, title = ?, interval_days = ?, next_due_date = ?, last_completed_at = ?, last_completion_note = ?, completion_checklist = ?, completion_requires_photo = ?, responsible_staff_id = ?, responsible = ?, priority = ?, instructions = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        assetId,
        title,
        intervalDays,
        normalizeMaintenanceDate(req.body?.next_due_date),
        normalizeMaintenanceDate(req.body?.last_completed_at),
        String(req.body?.last_completion_note || '').trim(),
        String(req.body?.completion_checklist || '').trim(),
        req.body?.completion_requires_photo ? 1 : 0,
        responsibleStaffId || null,
        String(req.body?.responsible || '').trim(),
        String(req.body?.priority || 'normal').trim() || 'normal',
        String(req.body?.instructions || '').trim(),
        req.body?.active === false ? 0 : 1,
        id
    );

    res.json({ success: true });
});

app.post('/api/maintenance/plans/:id/complete', upload.array('photos', 12), (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    const id = Number(req.params.id);
    const plan = db.prepare('SELECT id, interval_days, completion_checklist, completion_requires_photo FROM maintenance_plans WHERE id = ?').get(id);
    if (!plan) return res.status(404).json({ success: false, message: 'Wartungsplan nicht gefunden' });

    const completedAt = normalizeMaintenanceDate(req.body?.completed_at) || new Date().toISOString().slice(0, 10);
    const nextDueDate = addDaysIso(completedAt, Number(plan.interval_days || 0));
    const completionNote = String(req.body?.completion_note || '').trim();
    const checklistStateRaw = String(req.body?.checklist_state || '[]').trim() || '[]';
    let checklistState = [];
    try {
        checklistState = JSON.parse(checklistStateRaw);
    } catch (error) {
        checklistState = [];
    }
    const requiredChecklistItems = String(plan.completion_checklist || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (requiredChecklistItems.length) {
        const incompleteItem = requiredChecklistItems.find((item) => {
            const match = checklistState.find((entry) => String(entry?.label || '').trim() === item);
            return !match || !match.checked;
        });
        if (incompleteItem) {
            return res.status(400).json({ success: false, message: `Checkliste noch offen: ${incompleteItem}` });
        }
    }
    const signatureDataUrl = String(req.body?.signature_data_url || '').trim();
    const signatureFile = writeDataUrlImage(uploadDir, `wartung-signatur-${id}`, signatureDataUrl);
    if (!signatureFile) {
        return res.status(400).json({ success: false, message: 'Bitte unterschreiben, bevor du die Wartung abschließt.' });
    }
    const uploadedPhotos = Array.isArray(req.files) ? req.files : [];
    if (Number(plan.completion_requires_photo || 0) === 1 && !uploadedPhotos.length) {
        return res.status(400).json({ success: false, message: 'Für diese Wartung ist mindestens ein Foto Pflicht.' });
    }
    const completionResult = db.prepare(`
        INSERT INTO maintenance_plan_completions (plan_id, completed_at, completion_note, checklist_state, signature_stored_name, signature_mime_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        completedAt,
        completionNote,
        JSON.stringify(checklistState),
        signatureFile.stored_name,
        signatureFile.mime_type,
        requester.id
    );
    const completionId = Number(completionResult.lastInsertRowid);
    for (const file of uploadedPhotos) {
        db.prepare(`
            INSERT INTO maintenance_plan_completion_media (completion_id, original_name, stored_name, mime_type)
            VALUES (?, ?, ?, ?)
        `).run(
            completionId,
            file.originalname,
            file.filename,
            file.mimetype || ''
        );
    }
    db.prepare(`
        UPDATE maintenance_plans
        SET last_completed_at = ?, last_completion_note = ?, next_due_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(completedAt, completionNote, nextDueDate, id);

    res.json({ success: true, completed_at: completedAt, next_due_date: nextDueDate, completion_id: completionId });
});

app.delete('/api/maintenance/plans/:id', (req, res) => {
    const requester = requireMaintenanceUser(req, res);
    if (!requester) return;

    db.prepare('DELETE FROM maintenance_plans WHERE id = ?').run(Number(req.params.id));
    res.json({ success: true });
});

function getActiveSessionsForUser(userId) {
    const socketIds = [...(userSockets.get(Number(userId)) || [])];
    return socketIds.map((socketId) => {
        const socket = io.sockets.sockets.get(socketId);
        return {
            socketId,
            connected: !!socket?.connected,
            joinedAt: socket?.data?.joinedAt || null,
            userAgent: socket?.handshake?.headers?.['user-agent'] || ''
        };
    });
}

// Admin: Get all users
app.get('/api/admin/users', (req, res) => {
    // Ideally verify requester via session/token. For now open internally.
    const users = db.prepare('SELECT id, uin, username, display_name, email, role, avatar, status, can_chat, can_access_maintenance_board FROM users').all()
        .map((user) => {
            const activeSessions = getActiveSessionsForUser(user.id);
            return {
                ...user,
                active_sessions: activeSessions,
                active_session_count: activeSessions.length
            };
        });
    res.json(users);
});

// Admin: Disconnect active sessions
app.post('/api/admin/users/:id/disconnect', (req, res) => {
    const { id } = req.params;
    const { requesterId, socketId } = req.body || {};

    const requester = db.prepare('SELECT id, role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'User nicht gefunden!' });
    }

    const targetSocketIds = socketId
        ? [socketId]
        : [...(userSockets.get(Number(id)) || [])];

    targetSocketIds.forEach((targetSocketId) => {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('admin_force_logout', { reason: 'Diese Sitzung wurde vom Admin beendet.' });
            targetSocket.disconnect(true);
        }
    });

    res.json({ success: true, disconnected: targetSocketIds.length });
});

// Admin: Toggle Chat Permission
app.put('/api/admin/users/:id/toggle-chat', (req, res) => {
    const { id } = req.params;
    const { can_chat } = req.body;
    
    try {
        db.prepare('UPDATE users SET can_chat = ? WHERE id = ?').run(can_chat ? 1 : 0, id);
        
        // Notify all clients to update their user list (only show visible users)
        broadcastVisibleUserList();
        
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/users/:id/toggle-maintenance-board', (req, res) => {
    const { id } = req.params;
    const { can_access_maintenance_board, requesterId } = req.body;

    const requester = db.prepare('SELECT role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Keine Berechtigung' });
    }

    try {
        db.prepare('UPDATE users SET can_access_maintenance_board = ? WHERE id = ?').run(can_access_maintenance_board ? 1 : 0, id);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Toggle failed' });
    }
});

// Admin: Create User (Strict Check)
app.post('/api/admin/users', (req, res) => {
    const { requesterId, username, password, role, email } = req.body;
    
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
        const result = db.prepare('INSERT INTO users (uin, username, password, role, email) VALUES (?, ?, ?, ?, ?)').run(uin, username, hash, role || 'user', String(email || '').trim());
        res.json({ success: true, id: result.lastInsertRowid, uin: uin });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Fehler beim Anlegen' });
    }
});

app.put('/api/admin/users/:id/email', (req, res) => {
    const { id } = req.params;
    const { requesterId, email } = req.body;

    const requester = db.prepare('SELECT role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(String(email || '').trim(), id);
    res.json({ success: true });
});

// Admin: Update User Role
app.put('/api/admin/users/:id/role', (req, res) => {
    const { id } = req.params;
    const { requesterId, role } = req.body;

    if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Ungültige Rolle!' });
    }

    const requester = db.prepare('SELECT id, role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!target) {
        return res.status(404).json({ success: false, message: 'Benutzer nicht gefunden!' });
    }

    if (Number(target.id) === Number(requester.id) && role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Du kannst dir die Admin-Rechte nicht selbst entziehen!' });
    }

    if (target.role === 'admin' && role !== 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
        if (adminCount && adminCount.count <= 1) {
            return res.status(400).json({ success: false, message: 'Es muss mindestens einen Admin geben!' });
        }
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    res.json({ success: true });
});

// Admin: Update User Password
app.put('/api/admin/users/:id/password', (req, res) => {
    const { id } = req.params;
    const { requesterId, password } = req.body;

    const requester = db.prepare('SELECT role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    if (!password || password.length < 1) {
        return res.status(400).json({ success: false, message: 'Bitte ein Passwort angeben!' });
    }

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!target) {
        return res.status(404).json({ success: false, message: 'Benutzer nicht gefunden!' });
    }

    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    res.json({ success: true });
});

// Admin: Delete User
app.delete('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    const { requesterId } = req.body || {};

    const requester = db.prepare('SELECT id, role FROM users WHERE id = ?').get(requesterId);
    if (!requester || requester.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Nur Admins dürfen das!' });
    }

    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
    if (!target) {
        return res.status(404).json({ success: false, message: 'Benutzer nicht gefunden!' });
    }

    if (Number(target.id) === Number(requester.id)) {
        return res.status(400).json({ success: false, message: 'Du kannst dich nicht selbst löschen!' });
    }

    if (target.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get();
        if (adminCount && adminCount.count <= 1) {
            return res.status(400).json({ success: false, message: 'Der letzte Admin kann nicht gelöscht werden!' });
        }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ success: true });
});

// Chat History
app.get('/api/history/:userId/:contactId', (req, res) => {
    const userId = Number(req.params.userId);
    const contactId = Number(req.params.contactId);
    const now = new Date().toISOString();

    if (!canUsersChat(userId, contactId)) {
        return res.status(403).json({ success: false, message: 'Chat nicht erlaubt' });
    }

    try {
        const pendingStatuses = db.prepare(`
            SELECT id, sender_id, receiver_id, delivered_at, is_read
            FROM messages
            WHERE receiver_id = ? AND sender_id = ? AND (is_read = 0 OR delivered_at IS NULL)
        `).all(userId, contactId);

        if (pendingStatuses.length) {
            db.prepare(`
                UPDATE messages
                SET is_read = 1,
                    delivered_at = COALESCE(delivered_at, ?)
                WHERE receiver_id = ? AND sender_id = ? AND (is_read = 0 OR delivered_at IS NULL)
            `).run(now, userId, contactId);

            pendingStatuses.forEach((message) => {
                emitMessageStatus({
                    ...message,
                    delivered_at: message.delivered_at || now,
                    is_read: 1
                });
            });
        }
    } catch (e) {
        console.error(e);
    }

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
const userSockets = new Map(); // userId -> Set(socketId)

function addUserSocket(userId, socketId) {
    const sockets = userSockets.get(userId) || new Set();
    sockets.add(socketId);
    userSockets.set(userId, sockets);
}

function removeUserSocket(userId, socketId) {
    const sockets = userSockets.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (!sockets.size) userSockets.delete(userId);
}

function getPreferredSocketId(userId, excludeSocketId = null) {
    const sockets = userSockets.get(userId);
    if (!sockets || !sockets.size) return null;
    const candidates = [...sockets].filter(id => id !== excludeSocketId);
    return candidates.length ? candidates[candidates.length - 1] : null;
}

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        onlineUsers.set(socket.id, userId);
        addUserSocket(userId, socket.id);
        socket.data.joinedAt = new Date().toISOString();
        socket.join(`user_${userId}`);

        const user = db.prepare('SELECT status, custom_status, role FROM users WHERE id = ?').get(userId);
        if (user && user.status !== 'online') {
            db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
            broadcastVisibleUserList();
        }
        
        // Send user list to connected client (only visible users)
        socket.emit('user_list', getVisibleUsersForUser(Number(userId)));

        // Send unread counts
        const unreads = db.prepare('SELECT sender_id, count(*) as count FROM messages WHERE receiver_id = ? AND is_read = 0 GROUP BY sender_id').all(userId);
        const unreadMap = {};
        unreads.forEach(row => unreadMap[row.sender_id] = row.count);
        socket.emit('unread_sync', unreadMap);
        writeCallDebugLog({ type: 'server', event: 'join', details: { userId, socketId: socket.id } });

        const now = new Date().toISOString();
        const pendingDelivered = db.prepare(`
            SELECT id, sender_id, receiver_id, delivered_at, is_read
            FROM messages
            WHERE receiver_id = ? AND delivered_at IS NULL
        `).all(Number(userId));
        if (pendingDelivered.length) {
            db.prepare('UPDATE messages SET delivered_at = ? WHERE receiver_id = ? AND delivered_at IS NULL').run(now, Number(userId));
            pendingDelivered.forEach((message) => {
                emitMessageStatus({
                    ...message,
                    delivered_at: now,
                    is_read: message.is_read
                });
            });
        }

    });

    
    socket.on('typing', (data) => {
        if (!canUsersChat(data.from, data.to)) return;
        io.to(`user_${data.to}`).emit('typing', { from: data.from });
    });
    
    socket.on('stop_typing', (data) => {
        if (!canUsersChat(data.from, data.to)) return;
        io.to(`user_${data.to}`).emit('stop_typing', { from: data.from });
    });
    
    // Explicit activity ping to keep online status fresh without full join
    socket.on('im_active', (userId) => {
        const user = db.prepare('SELECT status, custom_status FROM users WHERE id = ?').get(userId);
        if (!user || user.status === 'online') return;

        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
        broadcastVisibleUserList();
    });

    socket.on('send_message', (data) => {
        const { senderId, receiverId, content, type, filename, replyToId, isEncrypted, severity } = data;
        if (!canUsersChat(senderId, receiverId)) {
            return;
        }
        createStoredMessage({
            senderId,
            receiverId,
            content,
            type: type || 'text',
            filename: filename || null,
            replyToId: replyToId || null,
            isEncrypted: isEncrypted ? 1 : 0,
            severity: severity || ''
        });
    });

    // --- WebRTC Signaling ---
    socket.on('call_user', (data) => {
        if (!canUsersChat(data.from, data.userToCall)) return;
        const targetSocketId = getPreferredSocketId(data.userToCall, socket.id);
        writeCallDebugLog({
            type: 'server',
            event: 'call_user',
            details: { from: data.from, to: data.userToCall, video: data.video, targetSocketId }
        });
        if (targetSocketId) {
            io.to(targetSocketId).emit('call_user', {
                signal: data.signalData,
                from: data.from,
                video: data.video,
                fromSocketId: socket.id
            });
            io.to(socket.id).emit('call_routed', {
                userToCall: data.userToCall,
                targetSocketId
            });
        } else {
            io.to(`user_${data.userToCall}`).emit('call_user', {
                signal: data.signalData,
                from: data.from,
                video: data.video,
                fromSocketId: socket.id
            });
        }

        const caller = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(data.from);
        const callerName = getDisplayName(caller);
        sendPushToUser(data.userToCall, {
            title: data.video ? `Eingehender Videoanruf von ${callerName}` : `Eingehender Sprachanruf von ${callerName}`,
            body: 'Tippe, um DRQ zu oeffnen.',
            icon: '/drq-logo.svg',
            tag: `incoming-call-${data.from}`,
            requireInteraction: true,
            data: {
                type: 'incoming_call',
                from: data.from,
                video: data.video === true,
                url: '/'
            }
        });
    });

    socket.on('answer_call', (data) => {
        if (!canUsersChat(data.to, onlineUsers.get(socket.id))) return;
        const targetSocketId = data.toSocketId || getPreferredSocketId(data.to, socket.id);
        writeCallDebugLog({ type: 'server', event: 'answer_call', details: { to: data.to, targetSocketId } });
        if (targetSocketId) {
            io.to(targetSocketId).emit('call_accepted', {
                signal: data.signal,
                fromSocketId: socket.id
            });
            return;
        }
        io.to(`user_${data.to}`).emit('call_accepted', {
            signal: data.signal,
            fromSocketId: socket.id
        });
    });

    socket.on('ice_candidate', (data) => {
        if (!canUsersChat(data.to, onlineUsers.get(socket.id))) return;
        const targetSocketId = data.toSocketId || getPreferredSocketId(data.to, socket.id);
        writeCallDebugLog({
            type: 'server',
            event: 'ice_candidate',
            details: data.candidate ? {
                to: data.to,
                targetSocketId,
                ...parseIceCandidateDetails(data.candidate)
            } : {
                to: data.to,
                targetSocketId,
                endOfCandidates: true
            }
        });
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice_candidate', data.candidate);
            return;
        }
        io.to(`user_${data.to}`).emit('ice_candidate', data.candidate);
    });

    socket.on('end_call', (data) => {
        if (!canUsersChat(data.to, onlineUsers.get(socket.id))) return;
        const targetSocketId = data.toSocketId || getPreferredSocketId(data.to, socket.id);
        writeCallDebugLog({ type: 'server', event: 'end_call', details: { to: data.to, targetSocketId } });
        if (targetSocketId) {
            io.to(targetSocketId).emit('end_call');
            return;
        }
        io.to(`user_${data.to}`).emit('end_call');
    });

    socket.on('disconnect', () => {
        const userId = onlineUsers.get(socket.id);
        if (userId) removeUserSocket(userId, socket.id);
        writeCallDebugLog({ type: 'server', event: 'disconnect', details: { userId: userId || null, socketId: socket.id } });
        if (userId) {
            onlineUsers.delete(socket.id);
            const isStillOnline = [...onlineUsers.values()].includes(userId);
            if (!isStillOnline) {
                db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
                broadcastVisibleUserList();
            }
        }
    });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, '0.0.0.0', () => {
    startMaintenanceMailLoop();
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
