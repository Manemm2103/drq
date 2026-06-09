const socket = io();
let currentUser = null;
let currentChatPartner = null;
let unreadCounts = {}; 

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const mainApp = document.getElementById('main-app');
const contactList = document.getElementById('contact-list');
const messagesDiv = document.getElementById('messages');
const chatTitle = document.getElementById('chat-title');
const messageInput = document.getElementById('message-input');
const codeInputBtn = document.getElementById('code-input-btn');
const codeModal = document.getElementById('code-modal');
const codeTextarea = document.getElementById('code-textarea');
const sendCodeBtn = document.getElementById('send-code-btn');
const closeCodeBtn = document.getElementById('close-code-btn');
const replyPreview = document.getElementById('reply-preview');
const replyContent = document.getElementById('reply-preview-content');

let currentReplyTo = null;
let soundEnabled = true;
let enterToSend = true;
let callDebugEnabled = false;
let runtimeVersionLabel = 'Version 2026-06-04.7';
let currentChatMessages = [];
let activeSearchTab = 'text';
let contactStateCache = {
    pendingIncoming: [],
    pendingOutgoing: [],
    rejected: []
};
let integrationTokensCache = [];

const soundUhOh = document.getElementById('sound-uhoh');
const soundRing = document.getElementById('sound-ring');
const soundMsg = document.getElementById('sound-msg');
const adminBtn = document.getElementById('admin-btn');
const adminModal = document.getElementById('admin-modal');
const profileModal = document.getElementById('profile-modal');
const chatSearchBtn = document.getElementById('chat-search-btn');
const chatSearchPanel = document.getElementById('chat-search-panel');
const chatSearchInput = document.getElementById('chat-search-input');
const chatSearchResults = document.getElementById('chat-search-results');

// --- Auth ---

window.onload = async () => {
    await loadRuntimeConfig();
    const savedUser = localStorage.getItem('icq_user');
    const savedSound = localStorage.getItem('icq_sound');
    const savedEnterSend = localStorage.getItem('icq_enter_send');
    const savedCallDebug = localStorage.getItem('icq_call_debug');
    soundEnabled = savedSound === null ? true : JSON.parse(savedSound);
    enterToSend = savedEnterSend === null ? true : JSON.parse(savedEnterSend);
    callDebugEnabled = savedCallDebug === null ? false : JSON.parse(savedCallDebug);
    
    // Set toggle switches (if elements exist)
    const toggle = document.getElementById('sound-toggle');
    if (toggle) toggle.checked = soundEnabled;
    const enterSendToggle = document.getElementById('enter-send-toggle');
    if (enterSendToggle) enterSendToggle.checked = enterToSend;
    const callDebugToggle = document.getElementById('call-debug-toggle');
    if (callDebugToggle) callDebugToggle.checked = callDebugEnabled;

    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            // Verify session with server via simple login (re-fetch latest data)
            // Ideally we'd have a 'verify token' endpoint, but re-login works for MVP
            restoreSession(currentUser);
            // Re-apply background
            applyChatBackground(currentUser.chat_bg);
        } catch (e) {
            localStorage.removeItem('icq_user');
        }
    }
    
    const savedUnread = localStorage.getItem('icq_unread');
    if (savedUnread) unreadCounts = JSON.parse(savedUnread);
    setChatComposerDisabled(true, 'Bitte zuerst einen Chat waehlen');
};

function toggleSound(enabled) {
    soundEnabled = enabled;
    localStorage.setItem('icq_sound', JSON.stringify(enabled));
}

function restoreSession(user) {
    currentUser = user;
    document.getElementById('my-username').textContent = currentUser.username;

    const pushButton = document.getElementById('enable-push-btn');
    if (typeof Notification !== 'undefined' && pushButton && Notification.permission === 'default') {
        pushButton.style.display = 'inline-block';
    }

    if ('serviceWorker' in navigator && 'PushManager' in window) {
        registerServiceWorkerAndPush();
    }

    // Set my avatar
    document.getElementById('my-avatar').style.backgroundImage = `url('/uploads/${user.avatar}')`;

    if (currentUser.role === 'admin') {
        adminBtn.style.display = 'block';
    } else {
        adminBtn.style.display = 'none';
    }

    loginScreen.classList.remove('active');
    loginScreen.style.display = 'none';
    mainApp.classList.add('active');
    
    applyChatBackground(user.chat_bg);
    loadContactState();
    socket.emit('join', currentUser.id);
}

// Re-add Code Modal Logic here because it was lost in replacement
codeInputBtn.onclick = () => {
    codeModal.style.display = 'block';
    codeTextarea.value = '';
    codeTextarea.focus();
};
closeCodeBtn.onclick = () => { codeModal.style.display = 'none'; };
sendCodeBtn.onclick = () => {
    const code = codeTextarea.value;
    if (!code.trim() || !currentChatPartner) return;
    socket.emit('send_message', {
        senderId: currentUser.id,
        receiverId: currentChatPartner.id,
        content: code,
        type: 'code'
    }); 
    clearTimeout(typingTimer);
    isTyping = false;
    socket.emit('stop_typing', { from: currentUser.id, to: currentChatPartner.id });
    codeModal.style.display = 'none';
};
codeTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) sendCodeBtn.click();
});

// Bind Enter Key for Chat Input
window.addEventListener('load', () => {
    if (messageInput) {
        messageInput.addEventListener('keydown', handleEnter);
        messageInput.addEventListener('input', function() {
            this.style.height = '40px'; // Reset to base to calculate scroll height properly
            this.style.height = Math.min(this.scrollHeight, 120) + 'px'; // Grow up to 120px
        });
    }
});

document.getElementById('password').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        login();
    }
});
document.getElementById('username').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        login();
    }
});

async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const loginError = document.getElementById('login-error');
    loginError.textContent = '';

    try {
        const res = await axios.post('/api/login', { username, password });
        if (res.data.success) {
            const user = res.data.user;
            localStorage.setItem('icq_user', JSON.stringify(user));
            restoreSession(user);
        }
    } catch (err) {
        console.error('Login client error', err);
        if (err.response && err.response.status === 401) {
            loginError.textContent = "Falscher Benutzername oder Passwort!";
        } else {
            loginError.textContent = "Login war erfolgreich, aber die App konnte danach nicht sauber starten.";
        }
    }
}

function logout() {
    localStorage.removeItem('icq_user');
    location.reload();
}

function formatSessionTime(isoString) {
    if (!isoString) return 'unbekannt';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return 'unbekannt';
    return date.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// --- Profile Management ---

function openProfile() {
    profileModal.style.display = 'block';
    document.getElementById('edit-uin').value = currentUser.uin || "---";
    document.getElementById('edit-username').value = currentUser.username;
    document.getElementById('edit-password').value = ""; // Don't show old pass
    document.getElementById('edit-status').value = currentUser.custom_status || ""; // Load Status
    
    // Render Background Options
    renderBackgroundOptions();
    loadContactState();
    loadIntegrationTokens();
}

function closeProfile() {
    profileModal.style.display = 'none';
}

function renderProfileEntityList(containerId, items, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!items || !items.length) {
        container.innerHTML = `<div class="profile-mini-empty">${options.emptyText || 'Keine Einträge'}</div>`;
        return;
    }

    container.innerHTML = items.map((item) => {
        const meta = options.meta ? options.meta(item) : '';
        const actions = options.actions ? options.actions(item) : '';
        return `
            <div class="profile-mini-item">
                <div class="profile-mini-copy">
                    <div class="profile-mini-title">${escapeHtml(item.username || item.integration_username || item.name || 'Eintrag')}</div>
                    ${meta ? `<div class="profile-mini-meta">${meta}</div>` : ''}
                </div>
                ${actions ? `<div class="profile-mini-actions">${actions}</div>` : ''}
            </div>
        `;
    }).join('');
}

async function loadContactState() {
    if (!currentUser) return;
    try {
        const res = await axios.get(`/api/profile/${currentUser.id}/contacts`, {
            params: { requesterId: currentUser.id }
        });
        const data = res.data || {};
        contactStateCache = {
            pendingIncoming: data.pendingIncoming || [],
            pendingOutgoing: data.pendingOutgoing || [],
            rejected: data.rejected || []
        };
        renderProfileEntityList('pending-contacts-list', data.pendingIncoming || [], {
            emptyText: 'Keine offenen Anfragen',
            meta: item => `DRQ#: ${item.uin}`,
            actions: item => `
                <button type="button" onclick="acceptContact(${item.id})">Annehmen</button>
                <button type="button" class="secondary-btn" onclick="rejectContact(${item.id})">Ablehnen</button>
            `
        });
        renderProfileEntityList('outgoing-contacts-list', data.pendingOutgoing || [], {
            emptyText: 'Keine gesendeten Anfragen',
            meta: item => `DRQ#: ${item.uin}`,
            actions: item => `
                <button type="button" class="secondary-btn" onclick="deleteContactRequest(${item.id})">Entfernen</button>
            `
        });
        renderProfileEntityList('accepted-contacts-list', data.accepted || [], {
            emptyText: 'Noch keine Kontakte',
            meta: item => `DRQ#: ${item.uin}`
        });
        renderUserList();
    } catch (err) {
        console.error('Failed to load contacts', err);
    }
}

async function sendContactRequest() {
    const input = document.getElementById('contact-search-input');
    const target = input.value.trim();
    if (!target) return;
    try {
        await axios.post(`/api/profile/${currentUser.id}/contacts/request`, {
            requesterId: currentUser.id,
            target
        });
        input.value = '';
        await loadContactState();
        showToast('Kontakt', 'Kontaktanfrage gesendet', currentUser);
    } catch (err) {
        alert(err.response?.data?.message || 'Kontaktanfrage fehlgeschlagen');
    }
}

async function acceptContact(contactId) {
    try {
        const activeEntry = (contactStateCache.pendingIncoming || []).find(item => item.id === contactId);
        await axios.post(`/api/profile/${currentUser.id}/contacts/${contactId}/accept`, {
            requesterId: currentUser.id
        });
        await loadContactState();
        if (activeEntry) {
            const acceptedUser = allUsersCache.find(user => user.id === activeEntry.user_id) || {
                id: activeEntry.user_id,
                uin: activeEntry.uin,
                username: activeEntry.username,
                avatar: activeEntry.avatar,
                status: activeEntry.online_status || 'offline',
                custom_status: activeEntry.custom_status || ''
            };
            openChat(acceptedUser);
        }
    } catch (err) {
        alert(err.response?.data?.message || 'Anfrage konnte nicht angenommen werden');
    }
}

async function rejectContact(contactId) {
    try {
        await axios.post(`/api/profile/${currentUser.id}/contacts/${contactId}/reject`, {
            requesterId: currentUser.id
        });
        await loadContactState();
        const rejectedEntry = (contactStateCache.rejected || []).find(item => item.id === contactId);
        if (rejectedEntry && currentChatPartner && currentChatPartner.id === contactId) {
            openChat({
                ...rejectedEntry,
                kind: 'contact_request_rejected',
                requestState: 'rejected',
                displayName: rejectedEntry.username
            });
        }
    } catch (err) {
        alert(err.response?.data?.message || 'Anfrage konnte nicht entfernt werden');
    }
}

async function deleteContactRequest(contactId) {
    try {
        await axios.delete(`/api/profile/${currentUser.id}/contacts/${contactId}`, {
            data: { requesterId: currentUser.id }
        });
        if (currentChatPartner && currentChatPartner.id === contactId && currentChatPartner.kind) {
            closeChat();
        }
        await loadContactState();
    } catch (err) {
        alert(err.response?.data?.message || 'Eintrag konnte nicht geloescht werden');
    }
}

async function loadIntegrationTokens() {
    if (!currentUser) return;
    try {
        const res = await axios.get(`/api/profile/${currentUser.id}/integrations`, {
            params: { requesterId: currentUser.id }
        });
        integrationTokensCache = res.data?.tokens || [];
        renderProfileEntityList('integration-token-list', integrationTokensCache, {
            emptyText: 'Noch keine ioBroker Keys',
            meta: item => {
                const label = item.integration_username ? `${item.integration_username}${item.integration_uin ? ` (DRQ#: ${item.integration_uin})` : ''}` : 'Noch nicht verbunden';
                const state = item.active ? 'aktiv' : 'deaktiviert';
                return `${escapeHtml(item.name || 'Ohne Namen')} · ${escapeHtml(label)} · ${state}`;
            },
            actions: item => `
                <button type="button" class="secondary-btn" onclick="renameIntegrationToken(${item.id})">Name</button>
                <button type="button" onclick="rotateIntegrationToken(${item.id})">Neu</button>
                <button type="button" class="secondary-btn" onclick="toggleIntegrationToken(${item.id}, ${item.active ? 'false' : 'true'})">${item.active ? 'Aus' : 'An'}</button>
                <button type="button" class="secondary-btn" onclick="deleteIntegrationToken(${item.id})">Loeschen</button>
            `
        });
    } catch (err) {
        console.error('Failed to load integration tokens', err);
    }
}

async function createIntegrationToken() {
    const nameInput = document.getElementById('integration-name-input');
    const output = document.getElementById('integration-token-output');
    try {
        const res = await axios.post(`/api/profile/${currentUser.id}/integrations/tokens`, {
            requesterId: currentUser.id,
            name: nameInput.value.trim()
        });
        output.style.display = 'block';
        output.textContent = `Neuer API Key: ${res.data.token}`;
        nameInput.value = '';
        await loadIntegrationTokens();
    } catch (err) {
        alert(err.response?.data?.message || 'API Key konnte nicht erzeugt werden');
    }
}

async function rotateIntegrationToken(tokenId) {
    const output = document.getElementById('integration-token-output');
    try {
        const res = await axios.post(`/api/profile/${currentUser.id}/integrations/tokens/${tokenId}/rotate`, {
            requesterId: currentUser.id
        });
        output.style.display = 'block';
        output.textContent = `Neuer API Key: ${res.data.token}`;
        await loadIntegrationTokens();
    } catch (err) {
        alert(err.response?.data?.message || 'API Key konnte nicht erneuert werden');
    }
}

async function toggleIntegrationToken(tokenId, active) {
    try {
        await axios.post(`/api/profile/${currentUser.id}/integrations/tokens/${tokenId}/toggle`, {
            requesterId: currentUser.id,
            active
        });
        await loadIntegrationTokens();
    } catch (err) {
        alert(err.response?.data?.message || 'API Key konnte nicht umgeschaltet werden');
    }
}

async function renameIntegrationToken(tokenId) {
    const token = integrationTokensCache.find(item => Number(item.id) === Number(tokenId));
    const currentName = token?.integration_username || token?.name || 'iobroker_';
    const nextName = prompt('Neuer ioBroker-Chatname', currentName || 'iobroker_');
    if (nextName === null) return;
    try {
        await axios.put(`/api/profile/${currentUser.id}/integrations/tokens/${tokenId}`, {
            requesterId: currentUser.id,
            name: nextName
        });
        await loadIntegrationTokens();
        showToast('ioBroker', 'Chatname gespeichert', currentUser);
    } catch (err) {
        alert(err.response?.data?.message || 'Chatname konnte nicht gespeichert werden');
    }
}

async function deleteIntegrationToken(tokenId) {
    if (!confirm('API Key und zugehoerigen ioBroker-Chat wirklich entfernen?')) return;
    try {
        await axios.delete(`/api/profile/${currentUser.id}/integrations/tokens/${tokenId}`, {
            data: { requesterId: currentUser.id }
        });
        await loadIntegrationTokens();
        if (currentChatPartner && currentChatPartner.is_integration === 1 && Number(currentChatPartner.owner_user_id) === Number(currentUser.id)) {
            closeChat();
        }
    } catch (err) {
        alert(err.response?.data?.message || 'API Key konnte nicht geloescht werden');
    }
}

const bgPresets = [
    // --- Soft & Modern Colors ---
    '#e5ddd5', // WhatsApp Beige (Classic)
    '#f0f2f5', // Soft Light Grey
    '#1c1e21', // Dark Mode Grey
    '#202c33', // WhatsApp Dark Green
    '#dcf8c6', // Soft Light Green
    '#ffe4e1', // Misty Rose
    '#e0f7fa', // Cyan Mist
    '#f3e5f5', // Purple Mist
    '#fff3e0', // Orange Mist
    '#eceff1', // Blue Grey Mist

    // --- Elegant Gradients (Subtle) ---
    'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)', // Cloudy Sky
    'linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%)', // Baby Blue
    'linear-gradient(to top, #cfd9df 0%, #e2ebf0 100%)', // Silver
    'linear-gradient(to right, #4facfe 0%, #00f2fe 100%)', // Fresh Blue (etwas stärker)
    'linear-gradient(to top, #30cfd0 0%, #330867 100%)', // Deep Ocean (Dark)
    'linear-gradient(to right, #b8cbb8 0%, #b8cbb8 0%, #b465da 0%, #cf6cc9 33%, #ee609c 66%, #ee609c 100%)', // Sunset Pastel
    'linear-gradient(to top, #d299c2 0%, #fef9d7 100%)', // Soft Pink/Yellow
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', // Plum (Dark)
    'linear-gradient(to top, #09203f 0%, #537895 100%)', // Night Sky
    'linear-gradient(-20deg, #2b5876 0%, #4e4376 100%)', // Deep Purple
    'radial-gradient(circle at 10% 20%, rgb(0, 0, 0) 0%, rgb(64, 64, 64) 90.2%)', // Classic Dark
    'linear-gradient(to right, #243949 0%, #517fa4 100%)' // Slate Blue
];

function renderBackgroundOptions() {
    const container = document.getElementById('bg-options');
    container.innerHTML = '';
    
    bgPresets.forEach(bg => {
        const div = document.createElement('div');
        div.className = 'bg-option';
        if (bg === 'default') div.style.background = 'url("flower.png"), #e5ddd5'; // placeholder logic
        else div.style.background = bg;
        
        if (currentUser.chat_bg === bg) div.classList.add('selected');
        
        div.onclick = () => {
            selectBackground(bg);
            // update UI selection
            document.querySelectorAll('.bg-option').forEach(el => el.classList.remove('selected'));
            div.classList.add('selected');
        };
        container.appendChild(div);
    });
}

let selectedBgTemp = null;

function selectBackground(bg) {
    selectedBgTemp = bg;
}

async function saveProfile() {
    const newUsername = document.getElementById('edit-username').value;
    const newPassword = document.getElementById('edit-password').value;
    const newStatus = document.getElementById('edit-status').value;
    const avatarInput = document.getElementById('edit-avatar');
    
    let avatarFilename = currentUser.avatar;
    let bgValue = selectedBgTemp || currentUser.chat_bg;

    // Upload Avatar if selected
    if (avatarInput.files[0]) {
        const formData = new FormData();
        formData.append('file', avatarInput.files[0]);
        const res = await axios.post('/api/upload', formData);
        avatarFilename = res.data.filename;
    }
    
    // Upload Custom BG if selected
    const bgInput = document.getElementById('edit-bg-upload');
    if (bgInput.files[0]) {
        const formData = new FormData();
        formData.append('file', bgInput.files[0]);
        const res = await axios.post('/api/upload/background', formData);
        bgValue = `url('/backgrounds/${res.data.filename}')`;
    }

    try {
        const payload = {
            username: newUsername,
            avatar: avatarFilename,
            chat_bg: bgValue,
            custom_status: newStatus
        };
        if (newPassword) payload.password = newPassword;

        const res = await axios.put(`/api/profile/${currentUser.id}`, payload);
        
        if (res.data.success) {
            currentUser = res.data.user;
            localStorage.setItem('icq_user', JSON.stringify(currentUser));
            restoreSession(currentUser); // Refresh UI
            closeProfile();
            showToast("Erfolg", "Profil wurde gespeichert!", currentUser);
        }
    } catch (err) {
        showToast("Fehler", "Speichern fehlgeschlagen: " + (err.response?.data?.message || err.message), null);
    }
}

function applyChatBackground(bg) {
    const mainApp = document.getElementById('main-app');
    
    if (!bg || bg === 'default') {
        mainApp.style.backgroundImage = 'none';
        mainApp.style.backgroundColor = '#e5ddd5';
    } else {
        if (bg.includes('url') || bg.includes('gradient')) {
            mainApp.style.backgroundImage = bg;
            mainApp.style.backgroundSize = 'cover';
            mainApp.style.backgroundPosition = 'center';
        } else {
            mainApp.style.backgroundImage = 'none';
            mainApp.style.backgroundColor = bg;
        }
    }
}


// --- Admin ---

function openAdmin() {
    if (currentUser.role !== 'admin') {
        alert("Keine Berechtigung!");
        return;
    }
    adminModal.style.display = 'block';
    loadUsers();
}

function closeAdmin() {
    adminModal.style.display = 'none';
}

async function loadUsers() {
    try {
        const res = await axios.get('/api/admin/users');
        const list = document.getElementById('user-list');
        list.innerHTML = '';
        
        res.data.forEach(user => {
            const li = document.createElement('li');
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            li.style.alignItems = 'flex-start';
            li.style.padding = '8px 5px';
            li.style.borderBottom = '1px solid #eee';
            li.style.gap = '12px';

            const info = document.createElement('div');
            info.style.flex = '1';
            info.innerHTML = `<b>${user.username}</b> (UIN: ${user.uin})`;

            const meta = document.createElement('div');
            meta.style.fontSize = '0.85rem';
            meta.style.color = '#666';
            meta.style.marginTop = '4px';
            meta.textContent = `Rolle: ${user.role}`;
            info.appendChild(meta);

            const sessionMeta = document.createElement('div');
            sessionMeta.style.fontSize = '0.82rem';
            sessionMeta.style.color = '#666';
            sessionMeta.style.marginTop = '4px';
            sessionMeta.textContent = `Sitzungen: ${user.active_session_count || 0}`;
            info.appendChild(sessionMeta);
            
            const controls = document.createElement('div');
            controls.style.display = 'flex';
            controls.style.flexDirection = 'column';
            controls.style.alignItems = 'flex-end';
            controls.style.gap = '6px';

            const topRow = document.createElement('div');
            topRow.style.display = 'flex';
            topRow.style.alignItems = 'center';
            topRow.style.gap = '8px';
            
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = user.can_chat !== 0;
            checkbox.onchange = () => toggleChat(user.id, checkbox.checked);
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(' Chat'));
            topRow.appendChild(label);

            const roleSelect = document.createElement('select');
            roleSelect.innerHTML = '<option value="user">User</option><option value="admin">Admin</option>';
            roleSelect.value = user.role || 'user';
            roleSelect.onchange = () => updateUserRole(user.id, roleSelect.value);
            topRow.appendChild(roleSelect);

            controls.appendChild(topRow);

            const passwordRow = document.createElement('div');
            passwordRow.style.display = 'flex';
            passwordRow.style.alignItems = 'center';
            passwordRow.style.gap = '6px';

            const passwordInput = document.createElement('input');
            passwordInput.type = 'password';
            passwordInput.placeholder = 'Neues Passwort';
            passwordInput.style.width = '140px';
            passwordRow.appendChild(passwordInput);

            const savePasswordBtn = document.createElement('button');
            savePasswordBtn.innerText = 'Passwort';
            savePasswordBtn.onclick = () => updateUserPassword(user.id, passwordInput);
            passwordRow.appendChild(savePasswordBtn);

            controls.appendChild(passwordRow);

            if ((user.active_sessions || []).length) {
                const sessionList = document.createElement('div');
                sessionList.className = 'session-list';

                user.active_sessions.forEach((session) => {
                    const sessionRow = document.createElement('div');
                    sessionRow.className = 'session-row';

                    const sessionText = document.createElement('div');
                    sessionText.className = 'session-info';
                    const suffix = session.socketId ? session.socketId.slice(-6) : '------';
                    sessionText.textContent = `Online · ${formatSessionTime(session.joinedAt)} · ${suffix}`;
                    sessionRow.appendChild(sessionText);

                    const kickBtn = document.createElement('button');
                    kickBtn.innerText = 'Kill';
                    kickBtn.className = 'session-kill-btn';
                    kickBtn.onclick = () => disconnectUserSession(user.id, session.socketId);
                    sessionRow.appendChild(kickBtn);

                    sessionList.appendChild(sessionRow);
                });

                const killAllBtn = document.createElement('button');
                killAllBtn.innerText = 'Alle Sitzungen trennen';
                killAllBtn.className = 'session-kill-all-btn';
                killAllBtn.onclick = () => disconnectUserSession(user.id);
                sessionList.appendChild(killAllBtn);

                controls.appendChild(sessionList);
            }

            if (!(user.role === 'admin' && user.id === currentUser.id)) {
                const delBtn = document.createElement('button');
                delBtn.innerText = '🗑';
                delBtn.style.background = 'red';
                delBtn.style.color = 'white';
                delBtn.style.border = 'none';
                delBtn.style.padding = '5px 8px';
                delBtn.style.cursor = 'pointer';
                delBtn.onclick = () => deleteUser(user.id);
                controls.appendChild(delBtn);
            }
            
            li.appendChild(info);
            li.appendChild(controls);
            list.appendChild(li);
        });
    } catch (err) {
        console.error("Failed to load users", err);
    }
}

async function toggleChat(id, enabled) {
    try {
        await axios.put(`/api/admin/users/${id}/toggle-chat`, { can_chat: enabled });
    } catch (err) {
        console.error(err);
        alert("Fehler beim Ändern des Chat-Status!");
        loadUsers(); // Revert UI on error
    }
}

async function createUser() {
    const username = document.getElementById('new-user').value;
    const password = document.getElementById('new-pass').value;
    const role = document.getElementById('new-role').value;
    
    if (!username || !password) return alert("Bitte alle Felder ausfüllen!");

    try {
        await axios.post('/api/admin/users', { 
            requesterId: currentUser.id, // Auth check
            username, password, role 
        });
        document.getElementById('new-user').value = '';
        document.getElementById('new-pass').value = '';
        loadUsers();
        alert("Benutzer angelegt!");
    } catch (err) {
        alert(err.response?.data?.message || "Fehler!");
    }
}

async function updateUserRole(id, role) {
    try {
        await axios.put(`/api/admin/users/${id}/role`, {
            requesterId: currentUser.id,
            role
        });
        loadUsers();
    } catch (err) {
        alert(err.response?.data?.message || "Fehler beim Ändern der Rolle!");
        loadUsers();
    }
}

async function updateUserPassword(id, passwordInput) {
    const password = passwordInput.value;
    if (!password) {
        alert("Bitte ein neues Passwort eingeben!");
        return;
    }

    try {
        await axios.put(`/api/admin/users/${id}/password`, {
            requesterId: currentUser.id,
            password
        });
        passwordInput.value = '';
        alert("Passwort geändert!");
    } catch (err) {
        alert(err.response?.data?.message || "Fehler beim Ändern des Passworts!");
    }
}

async function disconnectUserSession(id, socketId = null) {
    const confirmText = socketId ? 'Diese Sitzung wirklich trennen?' : 'Alle Sitzungen dieses Users wirklich trennen?';
    if (!confirm(confirmText)) return;
    try {
        await axios.post(`/api/admin/users/${id}/disconnect`, {
            requesterId: currentUser.id,
            socketId
        });
        loadUsers();
    } catch (err) {
        alert(err.response?.data?.message || 'Fehler beim Trennen der Sitzung!');
    }
}

async function deleteUser(id) {
    if (!confirm("Benutzer wirklich löschen?")) return;
    await axios.delete(`/api/admin/users/${id}`, { data: { requesterId: currentUser.id } });
    loadUsers();
}

// --- Socket Events ---

let allUsersCache = [];

socket.on('user_list', (users) => {
    allUsersCache = users;
    if (currentChatPartner && (!currentChatPartner.kind || currentChatPartner.kind === 'user')) {
        const refreshedPartner = allUsersCache.find(user => Number(user.id) === Number(currentChatPartner.id));
        if (refreshedPartner) {
            currentChatPartner = { ...currentChatPartner, ...refreshedPartner };
            chatTitle.textContent = `${currentChatPartner.displayName || currentChatPartner.username} (${currentChatPartner.uin})`;
            document.getElementById('chat-subtitle').textContent = getChatSubtitle(currentChatPartner);
            document.getElementById('chat-status').className = `status-dot ${getContactIndicatorClass(currentChatPartner)}`;
        }
    }
    renderUserList();
});

socket.on('contacts_updated', () => {
    loadContactState();
});



function updateGlobalUnreadBadge() {
    let totalUnread = 0;
    // Only count unread messages from users that are visible in the contact list
    for (const userId in unreadCounts) {
        if (allUsersCache.some(u => u.id == userId)) {
            totalUnread += Number(unreadCounts[userId]);
        }
    }
    
    const badge = document.getElementById('global-unread-badge');
    if (badge) {
        if (totalUnread > 0) {
            badge.textContent = totalUnread;
            badge.classList.add('active');
            badge.style.display = 'flex';
        } else {
            badge.classList.remove('active');
            badge.style.display = 'none';
        }
    }
}

function renderUserList() {
    contactList.innerHTML = '';
    
    // Sort: Online first, then A-Z
    allUsersCache.sort((a, b) => {
        if (a.status === 'online' && b.status !== 'online') return -1;
        if (a.status !== 'online' && b.status === 'online') return 1;
        return a.username.localeCompare(b.username);
    });

    const requestEntries = buildContactRequestEntries();
    const visibleUsers = allUsersCache.filter(user => user.id !== currentUser.id);
    const mergedEntries = [...requestEntries, ...visibleUsers];

    mergedEntries.forEach(user => {
        const div = document.createElement('div');
        const stateClass = user.requestState ? `request-${user.requestState}` : (user.status || 'offline');
        div.className = `contact-item ${stateClass}`;
        div.onclick = () => openChat(user);
        
        if (currentChatPartner && getChatEntryKey(currentChatPartner) === getChatEntryKey(user)) {
            div.classList.add('active');
        }

        const count = user.kind === 'user' || !user.kind ? (unreadCounts[user.id] || 0) : 0;
        const badgeHtml = count > 0 ? `<span class="unread-badge active">${count}</span>` : `<span class="unread-badge"></span>`;
        const avatarUrl = user.avatar ? `/uploads/${user.avatar}` : '';
        
        // Avatar Style for list
        const avatarDiv = `<div class="contact-avatar" style="${avatarUrl ? `background-image: url('${avatarUrl}')` : ''}"></div>`;
        const statusMsgText = getContactListSubtitle(user);
        const statusMsg = statusMsgText ? `<div class="contact-status-msg">${escapeHtml(statusMsgText)}</div>` : '';

        div.innerHTML = `
            ${avatarDiv}
            <div class="contact-status-mini ${getContactIndicatorClass(user)}"></div>
            <div class="contact-info">
                <div class="contact-name">${escapeHtml(user.displayName || user.username)}</div>
                <div class="contact-uin">${escapeHtml(getContactMetaLabel(user))} ${statusMsg}</div>
            </div>
            ${badgeHtml}
        `;
        contactList.appendChild(div);
    });
}

function buildContactRequestEntries() {
    const incoming = (contactStateCache.pendingIncoming || []).map(item => ({
        ...item,
        kind: 'contact_request_incoming',
        requestState: 'pending',
        displayName: item.username
    }));
    const outgoing = (contactStateCache.pendingOutgoing || []).map(item => ({
        ...item,
        kind: 'contact_request_outgoing',
        requestState: 'outgoing',
        displayName: item.username
    }));
    const rejected = (contactStateCache.rejected || []).map(item => ({
        ...item,
        kind: 'contact_request_rejected',
        requestState: 'rejected',
        displayName: item.username
    }));
    return [...incoming, ...outgoing, ...rejected];
}

function getChatEntryKey(entry) {
    if (!entry) return '';
    if (entry.contactId) return `contact:${entry.contactId}`;
    if (entry.id && entry.kind && entry.kind !== 'user') return `contact:${entry.id}`;
    return `user:${entry.id}`;
}

function getContactIndicatorClass(entry) {
    if (entry.requestState === 'pending') return 'pending';
    if (entry.requestState === 'outgoing') return 'outgoing';
    if (entry.requestState === 'rejected') return 'inactive';
    return entry.status || entry.online_status || 'offline';
}

function getContactMetaLabel(entry) {
    if (entry.requestState === 'pending') return `Anfrage · DRQ#: ${entry.uin}`;
    if (entry.requestState === 'outgoing') return `Ausstehend · DRQ#: ${entry.uin}`;
    if (entry.requestState === 'rejected') return `Inaktiv · DRQ#: ${entry.uin}`;
    return `DRQ#: ${entry.uin}`;
}

function getContactListSubtitle(entry) {
    if (entry.requestState === 'pending') return 'Kontaktanfrage wartet auf deine Entscheidung';
    if (entry.requestState === 'outgoing') return 'Anfrage gesendet';
    if (entry.requestState === 'rejected') return 'Anfrage abgelehnt';
    return entry.custom_status || '';
}

socket.on('receive_message', (msg) => {
    const sender = allUsersCache.find(u => u.id === msg.sender_id);
    const senderName = sender ? sender.username : "Unbekannt";

    if (msg.sender_id !== currentUser.id && soundEnabled) {
        const isCurrentChat = (currentChatPartner && msg.sender_id === currentChatPartner.id);
        const isInactive = (Date.now() - lastActivityTime) > 5 * 60 * 1000; // 5 minutes
        const isHidden = document.hidden;

        // Play sound if: we are not in this chat, OR we are inactive, OR window is hidden/unfocused
        if (!isCurrentChat || isInactive || isHidden) {
            soundMsg.play().catch(e => console.log("Audio play failed", e));
        }
    }

    if (currentChatPartner && 
        (msg.sender_id === currentChatPartner.id || msg.sender_id === currentUser.id)) {
        upsertCurrentChatMessage(msg);
        // Tell server it's read immediately
        if (msg.sender_id !== currentUser.id) {
            fetch('/api/history/' + currentUser.id + '/' + currentChatPartner.id);
        }
        appendMessage(msg);
        scrollToBottom();
    } else if (msg.sender_id !== currentUser.id) {
        if(soundEnabled) soundUhOh.play().catch(e => {}); 
        showToast(senderName, msg.content, sender);
        unreadCounts[msg.sender_id] = (unreadCounts[msg.sender_id] || 0) + 1;
        saveUnread();
        renderUserList();
        updateGlobalUnreadBadge();
    }
});

socket.on('message_status', (message) => {
    const index = currentChatMessages.findIndex((item) => Number(item.id) === Number(message.id));
    if (index >= 0) {
        currentChatMessages[index] = { ...currentChatMessages[index], ...message };
    }
    updateMessageStatusUi(message);
    if (chatSearchPanel.style.display === 'flex') updateChatSearch();
});

socket.on('status_update', (data) => {
    const user = allUsersCache.find(u => u.id === data.userId);
    if (user) {
        user.status = data.status;
        if (data.custom_status !== undefined) {
            user.custom_status = data.custom_status;
            // Update active chat header if this user is open
            if (currentChatPartner && currentChatPartner.id === user.id) {
                document.getElementById('chat-subtitle').textContent = user.custom_status;
            }
        }
        
        renderUserList();
        if (data.status === 'online' && soundEnabled && (!currentUser || data.userId !== currentUser.id)) {
            soundUhOh.play().catch(e => {});
            showToast(user.username, "ist jetzt online!", user);
        }
    }
});

function saveUnread() {
    localStorage.setItem('icq_unread', JSON.stringify(unreadCounts));
}

function showToast(title, body, user) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <div class="toast-avatar" style="background-image: url('/uploads/${user.avatar || 'default.png'}')"></div>
        <div>
            <div style="font-weight:bold">${title}</div>
            <div style="font-size:0.8rem">${body.substring(0, 30)}${body.length > 30 ? '...' : ''}</div>
        </div>
    `;
    toast.onclick = () => { if (user) openChat(user); toast.remove(); };
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.add('hide'); setTimeout(() => toast.remove(), 300); }, 4000);
}

function toggleChatSearch() {
    if (!currentChatPartner) return;
    const shouldOpen = chatSearchPanel.style.display === 'none' || chatSearchPanel.style.display === '';
    chatSearchPanel.style.display = shouldOpen ? 'flex' : 'none';
    if (shouldOpen) {
        chatSearchInput.focus();
        updateChatSearch();
    }
}

function closeChatSearch() {
    chatSearchPanel.style.display = 'none';
}

function setChatSearchTab(tab) {
    activeSearchTab = tab;
    document.querySelectorAll('.search-tab').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === tab);
    });
    updateChatSearch();
}

function classifyMessageForSearch(msg) {
    const isLink = msg.type === 'text' && /https?:\/\/[^\s]+/i.test(msg.content || '');
    const isMedia = ['image', 'video', 'audio'].includes(msg.type);
    const isDoc = !['text', 'code', 'image', 'video', 'audio'].includes(msg.type);
    return { isLink, isMedia, isDoc };
}

function getSearchableText(msg) {
    if (msg.type === 'text' || msg.type === 'code') return msg.content || '';
    if (msg.filename) return msg.filename;
    return msg.content || '';
}

function formatSearchPreview(msg) {
    if (msg.type === 'image') return 'Bild';
    if (msg.type === 'video') return 'Video';
    if (msg.type === 'audio') return 'Audio';
    if (msg.type === 'code') return msg.content || 'Code';
    if (msg.filename) return msg.filename;
    return msg.content || '';
}

function updateChatSearch() {
    if (!chatSearchResults) return;
    if (!currentChatPartner) {
        chatSearchResults.innerHTML = '<div class="search-empty">Kein Chat geöffnet.</div>';
        return;
    }

    const term = (chatSearchInput.value || '').trim().toLowerCase();
    const results = currentChatMessages.filter((msg) => {
        const { isLink, isMedia, isDoc } = classifyMessageForSearch(msg);
        if (activeSearchTab === 'media' && !isMedia) return false;
        if (activeSearchTab === 'links' && !isLink) return false;
        if (activeSearchTab === 'docs' && !isDoc) return false;
        if (activeSearchTab === 'text' && msg.type !== 'text' && msg.type !== 'code') return false;
        if (!term) return true;
        return getSearchableText(msg).toLowerCase().includes(term);
    });

    if (!results.length) {
        chatSearchResults.innerHTML = '<div class="search-empty">Keine Treffer in diesem Bereich.</div>';
        return;
    }

    chatSearchResults.innerHTML = results.slice().reverse().map((msg) => {
        const title = new Date(msg.timestamp).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return `
            <button class="search-result-item" onclick="jumpToMessage(${msg.id})">
                <div class="search-result-title">${title}</div>
                <div class="search-result-snippet">${escapeHtml(formatSearchPreview(msg).substring(0, 140))}</div>
            </button>
        `;
    }).join('');
}

function jumpToMessage(messageId) {
    closeChatSearch();
    scrollToMessage(messageId);
}

function upsertCurrentChatMessage(msg) {
    const index = currentChatMessages.findIndex((item) => Number(item.id) === Number(msg.id));
    if (index >= 0) {
        currentChatMessages[index] = { ...currentChatMessages[index], ...msg };
    } else {
        currentChatMessages.push(msg);
        currentChatMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
    if (chatSearchPanel.style.display === 'flex') updateChatSearch();
}

function renderCurrentChatMessages() {
    messagesDiv.innerHTML = '';
    if (!currentChatMessages.length) {
        messagesDiv.innerHTML = '<div class="empty-state"><p>Keine Nachrichten hier... 🦗</p></div>';
        return;
    }
    currentChatMessages.forEach(appendMessage);
}

function getMessageStatusMarkup(msg) {
    if (msg.sender_id !== currentUser.id) return '';
    const isRead = Number(msg.is_read) === 1;
    const isDelivered = !!msg.delivered_at || isRead;
    const statusClass = isRead ? 'read' : (isDelivered ? 'delivered' : 'single');
    return `
        <span class="message-status ${statusClass}" data-message-status-id="${msg.id}" title="${isRead ? 'Gelesen' : (isDelivered ? 'Zugestellt' : 'Gesendet')}">
            <span class="tick">✓</span><span class="tick">✓</span>
        </span>
    `;
}

function updateMessageStatusUi(message) {
    const statusEl = document.querySelector(`[data-message-status-id="${message.id}"]`);
    if (!statusEl) return;
    const isRead = Number(message.is_read) === 1;
    const isDelivered = !!message.delivered_at || isRead;
    statusEl.className = `message-status ${isRead ? 'read' : (isDelivered ? 'delivered' : 'single')}`;
    statusEl.title = isRead ? 'Gelesen' : (isDelivered ? 'Zugestellt' : 'Gesendet');
}

// --- Chat Logic ---

async function openChat(user) {
    currentChatPartner = user;
    chatTitle.textContent = `${user.displayName || user.username} (${user.uin})`;
    document.getElementById('chat-subtitle').textContent = getChatSubtitle(user);
    
    // Set Header Avatar
    const avatarUrl = user.avatar ? `/uploads/${user.avatar}` : '';
    const avatarEl = document.getElementById('chat-avatar');
    if (avatarUrl) {
        avatarEl.style.backgroundImage = `url('${avatarUrl}')`;
    } else {
        avatarEl.style.backgroundImage = 'none';
        avatarEl.style.backgroundColor = '#ccc';
    }
    
    // Update Status Dot in Header
    const statusDot = document.getElementById('chat-status');
    statusDot.className = `status-dot ${getContactIndicatorClass(user)}`;
    
    if (user.kind === 'user' || !user.kind) {
        unreadCounts[user.id] = 0;
        saveUnread();
    }
    renderUserList();
    updateGlobalUnreadBadge();
    if (chatSearchBtn) chatSearchBtn.style.display = 'inline-block';
    closeChatSearch();
    chatSearchInput.value = '';
    activeSearchTab = 'text';
    document.querySelectorAll('.search-tab').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === 'text');
    });

    document.body.classList.add('chat-open');
    document.getElementById('sidebar').style.transform = "translateX(-100%)";
    document.getElementById('chat-area').style.transform = "translateX(0)";

    messagesDiv.innerHTML = '';
    if (user.kind && user.kind !== 'user') {
        renderContactRequestChat(user);
        return;
    }

    const res = await axios.get(`/api/history/${currentUser.id}/${user.id}`);
    currentChatMessages = res.data;
    renderCurrentChatMessages();
    setChatComposerDisabled(false);
    scrollToBottom();
}

function showContactList() {
    currentChatPartner = null;
    currentChatMessages = [];
    renderUserList();
    if (chatSearchBtn) chatSearchBtn.style.display = 'none';
    closeChatSearch();
    document.body.classList.remove('chat-open');
    document.getElementById('sidebar').style.transform = "translateX(0)";
    document.getElementById('chat-area').style.transform = "translateX(100%)";
}

function formatText(text) {
    if (!text) return '';
    
    // Links (simple regex)
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    
    // Markdown replacement
    let formatted = escapeHtml(text);
    
    // Bold *text*
    formatted = formatted.replace(/\*([^*]+)\*/g, '<span class="md-bold">$1</span>');
    // Italic _text_
    formatted = formatted.replace(/_([^_]+)_/g, '<span class="md-italic">$1</span>');
    // Inline Code `text`
    formatted = formatted.replace(/`([^`]+)`/g, '<span class="md-code">$1</span>');
    
    // Auto Linkify
    formatted = formatted.replace(urlRegex, function(url) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    return formatted;
}

function appendMessage(msg) {
    const existing = document.getElementById(`msg-${msg.id}`);
    if (existing) existing.remove();
    const div = document.createElement('div');
    const isMe = msg.sender_id === currentUser.id;
    const severityClass = msg.severity ? ` severity-${msg.severity}` : '';
    div.className = `message ${isMe ? 'sent' : 'received'}${severityClass}`;
    
    // Reply Context
    let replyHtml = '';
    if (msg.reply_to_id && msg.reply_content) {
        replyHtml = `
            <div class="quoted-message" onclick="scrollToMessage(${msg.reply_to_id})">
                <small>Antwort auf:</small><br>
                ${escapeHtml(msg.reply_content.substring(0, 50))}...
            </div>
        `;
    }

    let contentHtml = '';
    let copyText = '';
    let linkPreviewHtml = '';

    if (msg.type === 'text') {
        contentHtml = formatText(msg.content);
        copyText = msg.content;
        
        // Check for single link to fetch preview
        const urlMatch = msg.content.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
            fetchLinkPreview(urlMatch[0]).then(preview => {
                if (preview) {
                    const previewNode = document.createElement('a');
                    previewNode.href = urlMatch[0];
                    previewNode.target = "_blank";
                    previewNode.className = "link-preview";
                    previewNode.innerHTML = `
                        ${preview.image ? `<div class="lp-image" style="background-image:url('${preview.image}')"></div>` : ''}
                        <div class="lp-content">
                            <span class="lp-title">${escapeHtml(preview.title)}</span>
                            <span class="lp-desc">${escapeHtml(preview.description)}</span>
                            <div class="lp-site">${escapeHtml(preview.site)}</div>
                        </div>
                    `;
                    div.querySelector('.msg-content').appendChild(previewNode);
                }
            });
        }

    } else if (msg.type === 'code') {
        contentHtml = `<pre class="code-block"><code>${escapeHtml(msg.content)}</code></pre>`;
        copyText = msg.content;
    
    } else if (msg.type === 'video') {
        contentHtml = `<strong>📹 Videonachricht</strong><br><video src="/uploads/${msg.filename}" controls style="max-width: 100%; border-radius: 8px; margin-top: 5px;"></video>`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
    } else if (msg.type === 'audio') {
        contentHtml = `<strong>🎤 Sprachnachricht</strong><br><audio src="/uploads/${msg.filename}" controls style="width: 100%; margin-top: 5px;"></audio>`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
} else if (msg.type === 'image') {
        contentHtml = `<img src="/uploads/${msg.filename}" alt="Image" onclick="window.open(this.src)">`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
    } else {
        contentHtml = `<a href="/uploads/${msg.filename}" download="${msg.filename}">📎 ${msg.filename}</a>`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
    }

    const time = new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    const statusHtml = getMessageStatusMarkup(msg);
    
    div.id = `msg-${msg.id}`;
    div.innerHTML = `
        ${replyHtml}
        <div class="msg-content">${contentHtml}</div>
        <div class="msg-meta">
            <span class="timestamp">${time}</span>
            ${statusHtml}
            <span class="copy-icon" title="Kopieren">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </span>
        </div>
        <div class="msg-actions">
            <span class="msg-action-btn" onclick="startReply(${msg.id}, '${escapeHtml(msg.content.substring(0,30))}', '${msg.type}')" title="Antworten">↩️</span>
        </div>
    `;

    // Copy Logic
    const copyIcon = div.querySelector('.copy-icon');
    let textToCopy = msg.type === 'text' || msg.type === 'code' ? msg.content : (window.location.origin + '/uploads/' + msg.filename);
    copyIcon.onclick = () => {
        navigator.clipboard.writeText(textToCopy).then(() => {
            copyIcon.classList.add('copied');
            setTimeout(() => copyIcon.classList.remove('copied'), 1500);
        });
    };

    messagesDiv.appendChild(div);
}

// --- Reply Logic ---
function startReply(msgId, contentSnippet, type) {
    currentReplyTo = msgId;
    replyPreview.style.display = 'block';
    
    let previewText = type === 'text' ? contentSnippet : `[${type.toUpperCase()}]`;
    replyContent.textContent = "Antwort auf: " + previewText;
    
    messageInput.focus();
}

function cancelReply() {
    currentReplyTo = null;
    replyPreview.style.display = 'none';
}

function scrollToMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (el) el.scrollIntoView({behavior: 'smooth', block: 'center'});
}

// --- Link Preview Fetcher ---
async function fetchLinkPreview(url) {
    try {
        const res = await axios.post('/api/preview', { url });
        if (res.data.error) return null;
        return res.data;
    } catch (e) { return null; }
}

function scrollToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentChatPartner) return;
    if (currentChatPartner.kind && currentChatPartner.kind !== 'user') return;

    socket.emit('send_message', {
        senderId: currentUser.id,
        receiverId: currentChatPartner.id,
        content: text,
        type: 'text',
        replyToId: currentReplyTo // Send reply ID
    });

    messageInput.value = '';
    messageInput.style.height = '40px'; // Reset height after send
    cancelReply(); // Clear reply state
}

function getChatSubtitle(user) {
    if (user.requestState === 'pending') return 'Neue Kontaktanfrage';
    if (user.requestState === 'outgoing') return 'Wartet auf Annahme';
    if (user.requestState === 'rejected') return 'Anfrage abgelehnt';
    return user.custom_status || '';
}

function renderContactRequestChat(user) {
    currentChatMessages = [];
    const title = escapeHtml(user.displayName || user.username);
    const requestText = user.requestState === 'pending'
        ? 'moechte dich als Kontakt hinzufuegen.'
        : user.requestState === 'outgoing'
            ? 'hat deine Anfrage noch nicht bestaetigt.'
            : 'ist als inaktiver Kontakt gespeichert.';

    const actions = [];
    if (user.requestState === 'pending') {
        actions.push(`<button type="button" class="request-action-btn" onclick="acceptContact(${user.id})">Annehmen</button>`);
        actions.push(`<button type="button" class="request-action-btn secondary" onclick="rejectContact(${user.id})">Ablehnen</button>`);
    } else if (user.requestState === 'outgoing') {
        actions.push(`<button type="button" class="request-action-btn secondary" onclick="deleteContactRequest(${user.id})">Anfrage entfernen</button>`);
    } else if (user.requestState === 'rejected') {
        actions.push(`<button type="button" class="request-action-btn secondary" onclick="deleteContactRequest(${user.id})">Eintrag loeschen</button>`);
    }

    messagesDiv.innerHTML = `
        <div class="request-chat-card ${user.requestState === 'rejected' ? 'inactive' : ''}">
            <div class="request-chat-kicker">${user.requestState === 'pending' ? 'Kontaktanfrage' : user.requestState === 'outgoing' ? 'Gesendete Anfrage' : 'Inaktiver Kontakt'}</div>
            <h4>${title}</h4>
            <p>${title} ${requestText}</p>
            <div class="request-chat-meta">DRQ#: ${escapeHtml(String(user.uin || ''))}</div>
            <div class="request-chat-actions">${actions.join('')}</div>
        </div>
    `;
    setChatComposerDisabled(true, user.requestState === 'pending'
        ? 'Bitte erst Anfrage annehmen oder ablehnen'
        : user.requestState === 'outgoing'
            ? 'Nachrichten sind erst nach Annahme moeglich'
            : 'Dieser Chat ist inaktiv');
}

function setChatComposerDisabled(disabled, placeholderText = 'Nachricht eingeben...') {
    messageInput.disabled = disabled;
    messageInput.placeholder = placeholderText;
    const actionSelectors = ['.send-btn', '.attach-btn', '.code-btn', '.md-btn'];
    actionSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((button) => {
            button.style.pointerEvents = disabled ? 'none' : '';
            button.style.opacity = disabled ? '0.45' : '';
        });
    });
}

function closeChat() {
    currentChatPartner = null;
    currentChatMessages = [];
    chatTitle.textContent = 'Wähle einen Kontakt';
    document.getElementById('chat-subtitle').textContent = '';
    document.getElementById('chat-avatar').style.backgroundImage = 'none';
    document.getElementById('chat-avatar').style.backgroundColor = '#ccc';
    document.getElementById('chat-status').className = 'status-dot offline';
    messagesDiv.innerHTML = '<div class="empty-state"><p>Waehle links einen Chat oder eine Anfrage.</p></div>';
    setChatComposerDisabled(true, 'Bitte zuerst einen Chat waehlen');
    renderUserList();
}

function toggleEnterSend(enabled) {
    enterToSend = enabled;
    localStorage.setItem('icq_enter_send', JSON.stringify(enabled));
}

function toggleCallDebug(enabled) {
    callDebugEnabled = enabled;
    localStorage.setItem('icq_call_debug', JSON.stringify(enabled));
    callDebugLog('debug_toggle', { enabled });
}

function summarizeTrack(track) {
    if (!track) return null;
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    return {
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState,
        settings
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
        sdpMid: candidateLike?.sdpMid || null,
        candidate: raw || null
    };
}

async function logSelectedCandidatePairStats(context = 'stats') {
    if (!peerConnection?.getStats) return;
    try {
        const stats = await peerConnection.getStats();
        let selectedPair = null;
        let localCandidate = null;
        let remoteCandidate = null;

        stats.forEach((report) => {
            if (!selectedPair && report.type === 'transport' && report.selectedCandidatePairId) {
                selectedPair = stats.get(report.selectedCandidatePairId) || null;
            }
        });

        if (!selectedPair) {
            stats.forEach((report) => {
                if (!selectedPair && report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
                    selectedPair = report;
                }
            });
        }

        if (selectedPair) {
            localCandidate = stats.get(selectedPair.localCandidateId) || null;
            remoteCandidate = stats.get(selectedPair.remoteCandidateId) || null;
        }

        await callDebugLog('selected_candidate_pair', {
            context,
            pair: selectedPair ? {
                state: selectedPair.state || null,
                nominated: selectedPair.nominated || false,
                writable: selectedPair.writable || false,
                bytesSent: selectedPair.bytesSent || 0,
                bytesReceived: selectedPair.bytesReceived || 0,
                currentRoundTripTime: selectedPair.currentRoundTripTime || null
            } : null,
            localCandidate: localCandidate ? {
                candidateType: localCandidate.candidateType || null,
                protocol: localCandidate.protocol || null,
                address: localCandidate.address || localCandidate.ip || null,
                port: localCandidate.port || null
            } : null,
            remoteCandidate: remoteCandidate ? {
                candidateType: remoteCandidate.candidateType || null,
                protocol: remoteCandidate.protocol || null,
                address: remoteCandidate.address || remoteCandidate.ip || null,
                port: remoteCandidate.port || null
            } : null
        });
    } catch (err) {
        await callDebugLog('selected_candidate_pair_error', {
            context,
            name: err.name || 'Error',
            message: err.message || String(err)
        });
    }
}

function summarizeVideoElement(videoEl) {
    if (!videoEl) return null;
    return {
        readyState: videoEl.readyState,
        paused: videoEl.paused,
        ended: videoEl.ended,
        currentTime: Number(videoEl.currentTime || 0),
        videoWidth: videoEl.videoWidth || 0,
        videoHeight: videoEl.videoHeight || 0
    };
}

function summarizeTransceivers() {
    if (!peerConnection?.getTransceivers) return [];
    return peerConnection.getTransceivers().map((transceiver, index) => ({
        index,
        mid: transceiver.mid || null,
        direction: transceiver.direction || null,
        currentDirection: transceiver.currentDirection || null,
        senderTrack: transceiver.sender?.track ? {
            kind: transceiver.sender.track.kind,
            readyState: transceiver.sender.track.readyState,
            enabled: transceiver.sender.track.enabled
        } : null,
        receiverTrack: transceiver.receiver?.track ? {
            kind: transceiver.receiver.track.kind,
            readyState: transceiver.receiver.track.readyState,
            enabled: transceiver.receiver.track.enabled,
            muted: transceiver.receiver.track.muted
        } : null
    }));
}

async function logCallDiagnostics(context = 'diag') {
    if (!peerConnection) return;
    let statsSummary = null;
    try {
        const stats = await peerConnection.getStats();
        const inbound = [];
        const outbound = [];
        stats.forEach((report) => {
            if (report.type === 'inbound-rtp') {
                inbound.push({
                    kind: report.kind || report.mediaType || null,
                    packetsReceived: report.packetsReceived || 0,
                    bytesReceived: report.bytesReceived || 0,
                    framesDecoded: report.framesDecoded || 0,
                    frameWidth: report.frameWidth || 0,
                    frameHeight: report.frameHeight || 0
                });
            }
            if (report.type === 'outbound-rtp') {
                outbound.push({
                    kind: report.kind || report.mediaType || null,
                    packetsSent: report.packetsSent || 0,
                    bytesSent: report.bytesSent || 0,
                    framesEncoded: report.framesEncoded || 0,
                    frameWidth: report.frameWidth || 0,
                    frameHeight: report.frameHeight || 0
                });
            }
        });
        statsSummary = { inbound, outbound };
    } catch (err) {
        statsSummary = { error: err.message || String(err) };
    }

    await callDebugLog('call_diagnostics', {
        context,
        signalingState: peerConnection.signalingState,
        iceConnectionState: peerConnection.iceConnectionState,
        connectionState: peerConnection.connectionState,
        iceGatheringState: peerConnection.iceGatheringState,
        localDescriptionType: peerConnection.localDescription?.type || null,
        remoteDescriptionType: peerConnection.remoteDescription?.type || null,
        localIceCandidateCount,
        remoteIceCandidateCount,
        localVideo: summarizeVideoElement(localVideo),
        remoteVideo: summarizeVideoElement(remoteVideo),
        transceivers: summarizeTransceivers(),
        stats: statsSummary
    });
}

function startCallDiagnosticsPolling() {
    stopCallDiagnosticsPolling();
    callDiagnosticsInterval = setInterval(() => {
        logCallDiagnostics('interval');
    }, 1500);
}

function stopCallDiagnosticsPolling() {
    if (callDiagnosticsInterval) {
        clearInterval(callDiagnosticsInterval);
        callDiagnosticsInterval = null;
    }
}

function summarizeStream(stream) {
    if (!stream) return null;
    return {
        id: stream.id,
        active: stream.active,
        audioTracks: stream.getAudioTracks().map(summarizeTrack),
        videoTracks: stream.getVideoTracks().map(summarizeTrack)
    };
}

async function callDebugLog(event, details = {}) {
    const alwaysLoggedEvents = new Set([
        'start_call_requested',
        'local_stream_ready',
        'incoming_call',
        'accept_call_requested',
        'accept_call_local_stream_ready',
        'call_accepted',
        'remote_description_set',
        'peer_connection_created',
        'ice_connection_state',
        'connection_state',
        'signaling_state',
        'ice_gathering_state',
        'remote_track',
        'remote_track_muted',
        'remote_track_unmuted',
        'remote_track_ended',
        'remote_video_loadedmetadata',
        'start_call_error',
        'accept_call_error',
        'ice_candidate_add_error',
        'camera_switch_error',
        'selected_candidate_pair',
        'selected_candidate_pair_error',
        'call_routed',
        'outgoing_ice_ready',
        'ice_candidate_local',
        'ice_candidate_received',
        'call_diagnostics',
        'ice_candidate_local_complete'
    ]);
    if (!callDebugEnabled && !alwaysLoggedEvents.has(event)) return;
    console.log('[call-debug]', event, details);

    try {
        await fetch('/api/call-debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                userId: currentUser ? currentUser.id : null,
                username: currentUser ? currentUser.username : null,
                event,
                details
            })
        });
    } catch (err) {
        console.warn('Call debug log upload failed', err);
    }
}

function handleEnter(e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
        const isMobile = window.innerWidth <= 768;
        if (!e.shiftKey && (enterToSend || isMobile)) {
            e.preventDefault();
            sendMessage();
        }
    }
}

// Markdown Insert Helper
function insertMarkdown(marker) {
    const start = messageInput.selectionStart;
    const end = messageInput.selectionEnd;
    const text = messageInput.value;
    const selected = text.substring(start, end);
    
    // Insert marker around selection or at cursor
    const newText = text.substring(0, start) + marker + selected + marker + text.substring(end);
    
    messageInput.value = newText;
    messageInput.focus();
    
    // Move cursor inside marker if no selection
    if (start === end) {
        messageInput.setSelectionRange(start + marker.length, start + marker.length);
    } else {
        // Keep selection if text was selected
        messageInput.setSelectionRange(start, end + (marker.length * 2));
    }
}

async function handleFileUpload(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    await uploadAndSend(file);
    input.value = ''; 
}

document.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            await uploadAndSend(file);
        }
    }
});

async function uploadAndSend(file) {
    if (!currentChatPartner) return alert("Bitte erst einen Chat öffnen!");
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await axios.post('/api/upload', formData, {
            headers: { 'Content-Type': 'multipart/form-data' }
        });
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        socket.emit('send_message', {
            senderId: currentUser.id,
            receiverId: currentChatPartner.id,
            content: '',
            type: type,
            filename: res.data.filename
        });
    } catch (err) {
        console.error("Upload failed", err);
        alert("Upload fehlgeschlagen!");
    }
}

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

async function loadRuntimeConfig() {
    try {
        const response = await fetch('/api/runtime-config');
        if (!response.ok) return;
        const config = await response.json();
        if (config && config.rtcConfig && Array.isArray(config.rtcConfig.iceServers)) {
            rtcConfig = config.rtcConfig;
        }
        if (config && config.version) {
            runtimeVersionLabel = config.version;
            const versionEl = document.getElementById('build-version-sidebar');
            if (versionEl) versionEl.textContent = runtimeVersionLabel;
        }
    } catch (err) {
        console.warn('Runtime config load failed', err);
    }
}


// --- Inactivity Tracking ---
let lastActivityTime = Date.now();
const resetActivityTimer = () => { lastActivityTime = Date.now(); };
window.addEventListener('mousemove', resetActivityTimer);
window.addEventListener('keydown', resetActivityTimer);
window.addEventListener('click', resetActivityTimer);
window.addEventListener('touchstart', resetActivityTimer);
// ---------------------------

// --- WebRTC Video Call Logic ---

const videoOverlay = document.getElementById('video-call-overlay');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const incomingCallModal = document.getElementById('incoming-call-modal');
const callerNameSpan = document.getElementById('caller-name');
const callVideoBtn = document.getElementById('call-video-btn');
const callAudioBtn = document.getElementById('call-audio-btn');
const callPartnerNameEl = document.getElementById('call-partner-name');
const callPartnerStatusEl = document.getElementById('call-partner-status');
const switchCameraBtn = document.getElementById('switch-camera-btn');

let localStream = null;
let peerConnection = null;
let incomingCallData = null;
let activeCallPartnerId = null;
let activeCallTargetSocketId = null;
let remoteStream = null;
let pendingIceCandidates = [];
let currentFacingMode = 'user';
let activeCallHasVideo = false;
let isSwitchingCamera = false;
let callDiagnosticsInterval = null;
let localIceCandidateCount = 0;
let remoteIceCandidateCount = 0;

function getCallConstraints(wantVideo) {
    return {
        audio: true,
        video: wantVideo ? {
            facingMode: { ideal: currentFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
        } : false
    };
}

function updateCallOverlayMeta(name, statusText) {
    if (callPartnerNameEl && name !== undefined && name !== null) callPartnerNameEl.textContent = name;
    if (callPartnerStatusEl && statusText !== undefined && statusText !== null) callPartnerStatusEl.textContent = statusText;
}

function resetFloatingPreviewPosition() {
    if (!localVideo) return;
    localVideo.style.left = '';
    localVideo.style.top = '';
    localVideo.style.right = '';
    localVideo.style.bottom = '';
}

function updateCallControls() {
    if (!switchCameraBtn) return;
    switchCameraBtn.style.display = activeCallHasVideo ? 'flex' : 'none';
    switchCameraBtn.disabled = isSwitchingCamera;
    switchCameraBtn.style.opacity = isSwitchingCamera ? '0.6' : '1';
}

// STUN servers (Google's public ones are reliable enough for testing)
let rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceTransportPolicy: 'all'
};

async function waitForOutgoingIceReadiness(context = 'offer') {
    if (!peerConnection) return;
    const needsRelay = rtcConfig.iceTransportPolicy === 'relay';
    const startedAt = Date.now();
    const timeoutMs = needsRelay ? 6500 : 2000;

    while (Date.now() - startedAt < timeoutMs) {
        if (peerConnection.iceGatheringState === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 80));
    }

    await callDebugLog('outgoing_ice_ready', {
        context,
        waitedMs: Date.now() - startedAt,
        iceGatheringState: peerConnection.iceGatheringState,
        hasRelayCandidate: !!peerConnection.__hasRelayCandidate,
        iceTransportPolicy: rtcConfig.iceTransportPolicy || 'all',
        waitMode: needsRelay ? 'complete-or-timeout' : 'short-complete-or-timeout'
    });
}

async function getCurrentLocalDescriptionForSignal(context = 'offer') {
    const localDescription = peerConnection ? peerConnection.localDescription : null;
    const sdp = localDescription && typeof localDescription.sdp === 'string' ? localDescription.sdp : '';
    await callDebugLog('local_description_ready', {
        context,
        type: localDescription ? localDescription.type : null,
        hasCandidateLines: sdp.includes('\na=candidate:') || sdp.startsWith('a=candidate:'),
        hasEndOfCandidates: sdp.includes('a=end-of-candidates'),
        sdpLength: sdp.length
    });
    return localDescription;
}

// Hook into openChat to show/hide call button
const originalOpenChat = openChat;
openChat = async function(user) {
    await originalOpenChat(user);
    // Show call button only if user is online (optional, but good UX)
    callVideoBtn.style.display = 'block'; callAudioBtn.style.display = 'block';
};

// Start a call (Initiator)
async function startCall(video = true) {
    if (!currentChatPartner) return;
    
    
    if (currentChatPartner.status !== 'online') {
        showOfflinePrompt(video);
        return;
    }
    try {
        activeCallHasVideo = !!video;
        currentFacingMode = 'user';
        activeCallTargetSocketId = null;
        localIceCandidateCount = 0;
        remoteIceCandidateCount = 0;
        resetFloatingPreviewPosition();
        updateCallOverlayMeta(currentChatPartner.username, video ? 'Videoanruf wird aufgebaut...' : 'Sprachanruf wird aufgebaut...');
        updateCallControls();
        console.log(`Requesting media access (video=${video})...`);
        await callDebugLog('start_call_requested', {
            wantVideo: video,
            partnerId: currentChatPartner.id,
            userAgent: navigator.userAgent
        });
        localStream = await navigator.mediaDevices.getUserMedia(getCallConstraints(video));
        console.log("Media access granted.");
        await callDebugLog('local_stream_ready', summarizeStream(localStream));
        
        // Show video element only if video is enabled
        if (video) {
            localVideo.srcObject = localStream;
            localVideo.style.display = 'block';
            ensureCallVideoPlayback(localVideo, true);
        } else {
            localVideo.style.display = 'none'; // Hide own preview for audio calls
        }
        
        videoOverlay.style.display = 'flex';
        ensureCallVideoPlayback(remoteVideo, false);
        activeCallPartnerId = currentChatPartner ? currentChatPartner.id : null;
        
        createPeerConnection();
        
        // Add local tracks to peer connection
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        if (typeof window.bgMode !== 'undefined' && window.bgMode !== 'none' && typeof startSegmentation === 'function') { startSegmentation(); }

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        await waitForOutgoingIceReadiness('offer');

        const signalData = await getCurrentLocalDescriptionForSignal('offer');

        socket.emit('call_user', {
            userToCall: currentChatPartner.id,
            signalData,
            from: currentUser.id,
            video: video
        });
        
    } catch (err) {
        console.error("Error starting call:", err);
        let msg = "Unbekannter Fehler.";
        if (err.name === 'NotAllowedError') msg = "Zugriff auf Kamera/Mikrofon verweigert! Bitte im Browser erlauben.";
        if (err.name === 'NotFoundError') msg = "Keine Kamera/Mikrofon gefunden.";
        if (err.name === 'NotReadableError') msg = "Hardware-Fehler: Kamera/Mikrofon wird bereits verwendet.";
        await callDebugLog('start_call_error', { name: err.name, message: err.message });
        alert("Konnte Anruf nicht starten:\n" + msg + "\n(" + err.name + ")");
        endCall();
    }
}

// Incoming Call Handler
socket.on('call_user', (data) => {
    // data: { signal, from, video }
    incomingCallData = data;
    activeCallTargetSocketId = data.fromSocketId || null;
    callDebugLog('incoming_call', { from: data.from, video: data.video });
    const caller = allUsersCache.find(u => u.id === data.from);
    callerNameSpan.textContent = (caller ? caller.username : "Unbekannt") + (data.video ? " (Video)" : " (Audio)");
    incomingCallModal.style.display = 'block';
    
    // Play ringtone if you have one
    if (soundEnabled && soundRing) {
        soundRing.currentTime = 0;
        soundRing.play().catch(e=>{});
    } else if (soundEnabled && soundUhOh) {
        soundUhOh.play().catch(e=>{});
    } 
});

async function acceptCall() {
    incomingCallModal.style.display = 'none';
    if (soundRing) { soundRing.pause(); soundRing.currentTime = 0; }
    videoOverlay.style.display = 'flex';
    activeCallPartnerId = incomingCallData ? incomingCallData.from : null;
    activeCallTargetSocketId = incomingCallData ? (incomingCallData.fromSocketId || null) : null;
    localIceCandidateCount = 0;
    remoteIceCandidateCount = 0;
    
    // Check if incoming call has video to decide on our constraints (try to match)
    // For simplicity, we match: if they call audio-only, we answer audio-only.
    // If they call video, we try video too.
    const wantVideo = incomingCallData.video !== false; 
    activeCallHasVideo = wantVideo;
    currentFacingMode = 'user';
    resetFloatingPreviewPosition();
    const caller = allUsersCache.find(u => u.id === incomingCallData.from);
    updateCallOverlayMeta(caller ? caller.username : 'Unbekannt', wantVideo ? 'Videoanruf wird verbunden...' : 'Sprachanruf wird verbunden...');
    updateCallControls();

    try {
        console.log(`Accepting call, requesting media (video=${wantVideo})...`);
        await callDebugLog('accept_call_requested', { wantVideo, from: incomingCallData ? incomingCallData.from : null });
        localStream = await navigator.mediaDevices.getUserMedia(getCallConstraints(wantVideo));
        await callDebugLog('accept_call_local_stream_ready', summarizeStream(localStream));
        
        if (wantVideo) {
            localVideo.srcObject = localStream;
            localVideo.style.display = 'block';
            ensureCallVideoPlayback(localVideo, true);
        } else {
            localVideo.style.display = 'none';
        }

        ensureCallVideoPlayback(remoteVideo, false);
        createPeerConnection();
        
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        if (typeof window.bgMode !== 'undefined' && window.bgMode !== 'none' && typeof startSegmentation === 'function') { startSegmentation(); }

        await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallData.signal));
        await callDebugLog('remote_description_set', { side: 'callee', type: incomingCallData.signal ? incomingCallData.signal.type : null });
        await flushPendingIceCandidates();
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        await waitForOutgoingIceReadiness('answer');

        const signal = await getCurrentLocalDescriptionForSignal('answer');

        socket.emit('answer_call', {
            signal,
            to: incomingCallData.from,
            toSocketId: incomingCallData.fromSocketId || null
        });

    } catch (err) {
        console.error("Error accepting call:", err);
        let msg = "Unbekannter Fehler.";
        if (err.name === 'NotAllowedError') msg = "Zugriff verweigert! Bitte erlauben.";
        if (err.name === 'NotFoundError') msg = "Keine Kamera/Mikrofon gefunden.";
        await callDebugLog('accept_call_error', { name: err.name, message: err.message });
        alert("Fehler beim Annehmen:\n" + msg);
        endCall();
    }
}

function rejectCall() {
    callDebugLog('reject_call', { from: incomingCallData ? incomingCallData.from : null });
    incomingCallModal.style.display = 'none';
    if (soundRing) { soundRing.pause(); soundRing.currentTime = 0; }
    socket.emit('end_call', { to: incomingCallData.from, toSocketId: incomingCallData.fromSocketId || null });
    incomingCallData = null;
    activeCallPartnerId = null;
    activeCallTargetSocketId = null;
}

async function flushPendingIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;

    await callDebugLog('flush_pending_ice_candidates_start', {
        count: pendingIceCandidates.length
    });

    while (pendingIceCandidates.length) {
        const candidate = pendingIceCandidates.shift();
        try {
            if (!candidate) {
                await peerConnection.addIceCandidate(null);
            } else {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch (e) {
            console.error("Error adding queued ICE candidate", e);
        }
    }

    await callDebugLog('flush_pending_ice_candidates_done', {
        remaining: pendingIceCandidates.length
    });
}

// Call Accepted (Initiator receives answer)
socket.on('call_accepted', async (payload) => {
    const signal = payload && payload.signal ? payload.signal : payload;
    activeCallTargetSocketId = payload && payload.fromSocketId ? payload.fromSocketId : activeCallTargetSocketId;
    await callDebugLog('call_accepted', { type: signal ? signal.type : null, fromSocketId: activeCallTargetSocketId });
    if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        updateCallOverlayMeta(currentChatPartner ? currentChatPartner.username : 'Anruf', activeCallHasVideo ? 'Verbunden' : 'Sprachverbindung aktiv');
        await callDebugLog('remote_description_set', { side: 'caller', type: signal ? signal.type : null });
        await flushPendingIceCandidates();
    }
});

socket.on('call_routed', async (data) => {
    activeCallTargetSocketId = data && data.targetSocketId ? data.targetSocketId : null;
    await callDebugLog('call_routed', data || {});
});

// ICE Candidates
socket.on('ice_candidate', async (candidate) => {
    remoteIceCandidateCount += 1;
    await callDebugLog('ice_candidate_received', candidate ? parseIceCandidateDetails(candidate) : { endOfCandidates: true });
    if (!peerConnection) {
        pendingIceCandidates.push(candidate);
        return;
    }

    if (!peerConnection.remoteDescription) {
        pendingIceCandidates.push(candidate);
        return;
    }

    try {
        if (!candidate) {
            await peerConnection.addIceCandidate(null);
        } else {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (e) {
        await callDebugLog('ice_candidate_add_error', { name: e.name, message: e.message });
        console.error("Error adding ICE candidate", e);
    }
});

// End Call (Remote hung up)
socket.on('end_call', () => {
    endCall(true); // true = remote ended
});

function ensureCallVideoPlayback(videoEl, muted = false) {
    if (!videoEl) return;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = muted;
    videoEl.setAttribute('autoplay', 'autoplay');
    videoEl.setAttribute('playsinline', 'playsinline');
    videoEl.setAttribute('webkit-playsinline', 'true');

    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => console.log('Video autoplay blocked', err));
    }
}

function endCall(isRemote = false) {
    callDebugLog('end_call', { isRemote });
    if (typeof stopSegmentation === 'function') { stopSegmentation(); }
    stopCallDiagnosticsPolling();
    pendingIceCandidates = [];
    activeCallHasVideo = false;
    isSwitchingCamera = false;
    updateCallOverlayMeta('Anruf', isRemote ? 'Anruf beendet' : 'Verbindung getrennt');
    updateCallControls();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    videoOverlay.style.display = 'none';
    incomingCallModal.style.display = 'none';
    if (soundRing) { soundRing.pause(); soundRing.currentTime = 0; }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    remoteStream = null;
    resetFloatingPreviewPosition();

    if (!isRemote) {
        // Notify other side if *I* hung up
        if (activeCallPartnerId || currentChatPartner) {
            socket.emit('end_call', {
                to: activeCallPartnerId || currentChatPartner.id,
                toSocketId: activeCallTargetSocketId || incomingCallData?.fromSocketId || null
            });
        }
    }
    
    incomingCallData = null;
    activeCallPartnerId = null;
    activeCallTargetSocketId = null;
    localIceCandidateCount = 0;
    remoteIceCandidateCount = 0;
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnection.__hasRelayCandidate = false;
    localIceCandidateCount = 0;
    remoteIceCandidateCount = 0;
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    ensureCallVideoPlayback(remoteVideo, false);
    callDebugLog('peer_connection_created', {
        pendingIceCandidates: pendingIceCandidates.length,
        iceServers: rtcConfig.iceServers.map(server => server.urls),
        iceTransportPolicy: rtcConfig.iceTransportPolicy || 'all'
    });
    startCallDiagnosticsPolling();

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            const candidateDetails = parseIceCandidateDetails(event.candidate);
            if (candidateDetails.type === 'relay') {
                peerConnection.__hasRelayCandidate = true;
            }
            localIceCandidateCount += 1;
            const targetId = currentChatPartner ? currentChatPartner.id : incomingCallData?.from;
            callDebugLog('ice_candidate_local', {
                to: targetId,
                toSocketId: activeCallTargetSocketId || incomingCallData?.fromSocketId || null,
                ...candidateDetails
            });
            socket.emit('ice_candidate', {
                to: targetId,
                toSocketId: activeCallTargetSocketId || incomingCallData?.fromSocketId || null,
                candidate: event.candidate
            });
        } else {
            callDebugLog('ice_candidate_local_complete');
            const targetId = currentChatPartner ? currentChatPartner.id : incomingCallData?.from;
            socket.emit('ice_candidate', {
                to: targetId,
                toSocketId: activeCallTargetSocketId || incomingCallData?.fromSocketId || null,
                candidate: null
            });
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        callDebugLog('ice_connection_state', { state: peerConnection.iceConnectionState });
        const state = peerConnection.iceConnectionState;
        if (state === 'checking') updateCallOverlayMeta(null, 'Netzwerk wird verbunden...');
        if (state === 'connected' || state === 'completed') updateCallOverlayMeta(null, activeCallHasVideo ? 'Verbunden' : 'Sprachverbindung aktiv');
        if (state === 'failed') updateCallOverlayMeta(null, 'Verbindung fehlgeschlagen');
        if (state === 'disconnected') updateCallOverlayMeta(null, 'Verbindung unterbrochen');
        if (state === 'checking' || state === 'connected' || state === 'completed' || state === 'failed') {
            setTimeout(() => { logSelectedCandidatePairStats(`ice-${state}-t1`); }, 1000);
            setTimeout(() => { logSelectedCandidatePairStats(`ice-${state}-t4`); }, 4000);
            setTimeout(() => { logCallDiagnostics(`ice-${state}-t1`); }, 1000);
        }
    };
    peerConnection.onconnectionstatechange = () => {
        callDebugLog('connection_state', { state: peerConnection.connectionState });
    };
    peerConnection.onsignalingstatechange = () => {
        callDebugLog('signaling_state', { state: peerConnection.signalingState });
    };
    peerConnection.onicegatheringstatechange = () => {
        callDebugLog('ice_gathering_state', { state: peerConnection.iceGatheringState });
    };

    peerConnection.ontrack = (event) => {
        callDebugLog('remote_track', {
            track: summarizeTrack(event.track),
            streams: event.streams.map(summarizeStream)
        });
        if (!remoteStream) {
            remoteStream = new MediaStream();
        }

        const hasTrackAlready = remoteStream.getTracks().some((track) => track.id === event.track.id);
        if (!hasTrackAlready) {
            remoteStream.addTrack(event.track);
        }

        event.track.onmute = () => callDebugLog('remote_track_muted', { trackId: event.track.id, kind: event.track.kind });
        event.track.onunmute = () => callDebugLog('remote_track_unmuted', { trackId: event.track.id, kind: event.track.kind });
        event.track.onended = () => callDebugLog('remote_track_ended', { trackId: event.track.id, kind: event.track.kind });

        remoteVideo.srcObject = remoteStream;
        remoteVideo.onloadedmetadata = () => {
            callDebugLog('remote_video_loadedmetadata', {
                readyState: remoteVideo.readyState,
                videoWidth: remoteVideo.videoWidth,
                videoHeight: remoteVideo.videoHeight
            });
            logSelectedCandidatePairStats('remote-video-loadedmetadata');
            logCallDiagnostics('remote-video-loadedmetadata');
            updateCallOverlayMeta(null, activeCallHasVideo ? 'Gegenuebervideo aktiv' : 'Sprachverbindung aktiv');
            ensureCallVideoPlayback(remoteVideo, false);
        };
        ensureCallVideoPlayback(remoteVideo, false);
    };
}

// Controls
function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            document.getElementById('mute-btn').classList.toggle('active', !audioTrack.enabled);
            document.getElementById('mute-btn').innerHTML = audioTrack.enabled ? '🎤<span>Mic</span>' : '🔇<span>Stumm</span>';
        }
    }
}

function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            document.getElementById('video-btn').classList.toggle('active', !videoTrack.enabled);
            document.getElementById('video-btn').innerHTML = videoTrack.enabled ? '📷<span>Kamera</span>' : '🚫<span>Kamera aus</span>';
        }
    }
}

async function switchCamera() {
    if (!activeCallHasVideo || !localStream || isSwitchingCamera) return;

    const currentVideoTrack = localStream.getVideoTracks()[0];
    if (!currentVideoTrack) return;

    isSwitchingCamera = true;
    updateCallControls();
    const previousFacingMode = currentFacingMode;
    const nextFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    updateCallOverlayMeta(null, nextFacingMode === 'environment' ? 'Rueckkamera wird aktiviert...' : 'Frontkamera wird aktiviert...');

    try {
        const switchedStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: { exact: nextFacingMode },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        }).catch(async () => navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: { ideal: nextFacingMode },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        }));

        const newVideoTrack = switchedStream.getVideoTracks()[0];
        if (!newVideoTrack) throw new Error('Kein neuer Videotrack verfuegbar');

        const sender = peerConnection
            ? peerConnection.getSenders().find((item) => item.track && item.track.kind === 'video')
            : null;

        if (sender) {
            await sender.replaceTrack(newVideoTrack);
        }

        const previousEnabledState = currentVideoTrack.enabled;
        localStream.removeTrack(currentVideoTrack);
        currentVideoTrack.stop();
        newVideoTrack.enabled = previousEnabledState;
        localStream.addTrack(newVideoTrack);
        localVideo.srcObject = localStream;
        ensureCallVideoPlayback(localVideo, true);

        currentFacingMode = nextFacingMode;
        if (typeof window.bgMode !== 'undefined' && window.bgMode !== 'none' && typeof startSegmentation === 'function') {
            if (typeof stopSegmentation === 'function') stopSegmentation();
            startSegmentation();
        }

        await callDebugLog('camera_switched', { facingMode: currentFacingMode });
        updateCallOverlayMeta(null, currentFacingMode === 'environment' ? 'Rueckkamera aktiv' : 'Frontkamera aktiv');
    } catch (err) {
        currentFacingMode = previousFacingMode;
        await callDebugLog('camera_switch_error', { name: err.name || 'Error', message: err.message || String(err) });
        updateCallOverlayMeta(null, 'Kamerwechsel fehlgeschlagen');
        console.error('Camera switch failed', err);
    } finally {
        isSwitchingCamera = false;
        updateCallControls();
    }
}

// Draggable Local Video
let isDragging = false;
let dragStartX, dragStartY;

if (localVideo) {
    localVideo.addEventListener('mousedown', (e) => {
        isDragging = true;
        dragStartX = e.clientX - localVideo.offsetLeft;
        dragStartY = e.clientY - localVideo.offsetTop;
        localVideo.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            e.preventDefault();
            localVideo.style.left = (e.clientX - dragStartX) + 'px';
            localVideo.style.top = (e.clientY - dragStartY) + 'px';
            localVideo.style.bottom = 'auto'; // Disable bottom once moved
            localVideo.style.right = 'auto';  // Disable right once moved
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        if (localVideo) localVideo.style.cursor = 'grab';
    });

    // Touch support for dragging (Mobile)
    localVideo.addEventListener('touchstart', (e) => {
        isDragging = true;
        const touch = e.touches[0];
        dragStartX = touch.clientX - localVideo.offsetLeft;
        dragStartY = touch.clientY - localVideo.offsetTop;
    });

    document.addEventListener('touchmove', (e) => {
        if (isDragging) {
            e.preventDefault(); // Prevent scrolling
            const touch = e.touches[0];
            localVideo.style.left = (touch.clientX - dragStartX) + 'px';
            localVideo.style.top = (touch.clientY - dragStartY) + 'px';
            localVideo.style.bottom = 'auto';
            localVideo.style.right = 'auto';
        }
    }, { passive: false });

    document.addEventListener('touchend', () => { isDragging = false; });
}


// --- Offline Recording Logic ---
let offlineMediaRecorder;
let offlineAudioChunks = [];
let offlineStream;
let isVideoRecording = false;
let recordTimerInterval;
let recordSeconds = 0;

function showOfflinePrompt(video) {
    isVideoRecording = video;
    document.getElementById('offline-msg-type').textContent = video ? 'Videonachricht' : 'Sprachnachricht';
    document.getElementById('offline-message-modal').style.display = 'block';
    document.getElementById('start-offline-record-btn').onclick = () => startOfflineRecording(video);
}

async function startOfflineRecording(video) {
    document.getElementById('offline-message-modal').style.display = 'none';
    try {
        offlineStream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
        const videoPreview = document.getElementById('offline-video-preview');
        
        if (video) {
            videoPreview.srcObject = offlineStream;
            videoPreview.style.display = 'block';
        } else {
            videoPreview.style.display = 'none';
        }
        
        document.getElementById('recording-modal').style.display = 'block';
        
        offlineAudioChunks = [];
        // Use webm format
        const options = { mimeType: video ? 'video/webm' : 'audio/webm' };
        
        // Fallbacks for Safari etc.
        let finalMime = options.mimeType;
        if (!MediaRecorder.isTypeSupported(finalMime)) {
            finalMime = video ? 'video/mp4' : 'audio/mp4';
        }
        
        offlineMediaRecorder = new MediaRecorder(offlineStream, { mimeType: MediaRecorder.isTypeSupported(finalMime) ? finalMime : '' });
        
        offlineMediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) offlineAudioChunks.push(e.data);
        };
        
        offlineMediaRecorder.onstop = async () => {
            clearInterval(recordTimerInterval);
            const blob = new Blob(offlineAudioChunks, { type: offlineMediaRecorder.mimeType || finalMime });
            await sendOfflineMessage(blob, video);
            closeOfflineModal();
        };
        
        offlineMediaRecorder.start();
        
        recordSeconds = 0;
        document.getElementById('recording-time').textContent = '0:00';
        recordTimerInterval = setInterval(() => {
            recordSeconds++;
            const m = Math.floor(recordSeconds / 60);
            const s = recordSeconds % 60;
            document.getElementById('recording-time').textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
        }, 1000);
        
        document.getElementById('stop-offline-record-btn').onclick = () => offlineMediaRecorder.stop();
        
    } catch (err) {
        console.error("Error starting offline record:", err);
        alert("Fehler beim Zugriff auf Kamera/Mikrofon.");
        closeOfflineModal();
    }
}

function cancelOfflineRecording() {
    if (offlineMediaRecorder && offlineMediaRecorder.state !== 'inactive') {
        offlineMediaRecorder.onstop = null; // Prevent sending
        offlineMediaRecorder.stop();
    }
    closeOfflineModal();
}

function closeOfflineModal() {
    document.getElementById('offline-message-modal').style.display = 'none';
    document.getElementById('recording-modal').style.display = 'none';
    clearInterval(recordTimerInterval);
    if (offlineStream) {
        offlineStream.getTracks().forEach(t => t.stop());
        offlineStream = null;
    }
    document.getElementById('offline-video-preview').srcObject = null;
}

async function sendOfflineMessage(blob, isVideo) {
    const ext = isVideo ? 'webm' : 'webm'; // Most browsers use webm. Safari might use mp4.
    const filename = `${isVideo ? 'Video' : 'Audio'}_${Date.now()}.${ext}`;
    const file = new File([blob], filename, { type: blob.type });
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Upload failed');
        const data = await res.json();
        const fileUrl = "/uploads/" + data.filename;
        
        // Send as chat message
        const messageData = {
            senderId: currentUser.id,
            receiverId: currentChatPartner.id,
            type: isVideo ? 'video' : 'audio',
            filename: data.filename,
            content: isVideo ? 'Videonachricht' : 'Sprachnachricht',
            timestamp: new Date().toISOString()
        };
        
        socket.emit('send_message', messageData);
        
    } catch (err) {
        console.error('Upload Error:', err);
        alert('Fehler beim Senden der Datei.');
    }
}
// --- End Offline Recording Logic ---



// --- Web Push & Service Worker ---
const publicVapidKey = async () => {
    const res = await fetch('/api/vapidPublicKey');
    const data = await res.json();
    return data.publicKey;
};

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}


async function registerServiceWorkerAndPush() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            const register = await navigator.serviceWorker.register('/sw.js?v=2');
            
            // Check if already subscribed
            const sub = await register.pushManager.getSubscription();
            
            if (sub) {
                // Already subscribed, just send to server to make sure it's saved
                await fetch('/api/subscribe', {
                    method: 'POST',
                    body: JSON.stringify({ userId: currentUser.id, subscription: sub }),
                    headers: { 'Content-Type': 'application/json' }
                });
                document.getElementById('enable-push-btn').style.display = 'none';
            } else {
                // Not subscribed. Show button so user can click to subscribe (iOS requires user gesture)
                document.getElementById('enable-push-btn').style.display = 'inline-block';
            }
        } catch (err) {
            console.error('Service Worker Error', err);
        }
    }
}

async function requestPushPermission() {
    try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            alert('Push-Rechte verweigert. Bitte in den iOS-Einstellungen erlauben.');
            return;
        }
        
        const register = await navigator.serviceWorker.ready;
        const pubKey = await publicVapidKey();
        
        // Subscribe (Must be called from this click handler for iOS)
        const newSub = await register.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(pubKey)
        });

        const res = await fetch('/api/subscribe', {
            method: 'POST',
            body: JSON.stringify({ userId: currentUser.id, subscription: newSub }),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (res.ok) {
            document.getElementById('enable-push-btn').style.display = 'none';
            alert("Push erfolgreich aktiviert! Du bist startklar.");
        } else {
            alert("Fehler beim Speichern auf dem Server: " + res.status);
        }
    } catch(e) {
        alert("Push-Fehler: " + e.message + "\nTipp: Auf iOS muss die Seite oft zum Home-Bildschirm hinzugefügt sein.");
    }
}
// ----------------------------------


socket.on('unread_sync', (map) => {
    unreadCounts = map;
    saveUnread();
    renderUserList();
    updateGlobalUnreadBadge();
});



// Handle automatic reconnect
socket.on('connect', () => {
    if (currentUser) {
        socket.emit('join', currentUser.id);
    }
});

socket.on('admin_force_logout', (payload) => {
    alert(payload?.reason || 'Diese Sitzung wurde vom Admin beendet.');
    logout();
});

// Ping activity to server on touch or focus
const pingActivity = () => {
    if (currentUser && socket.connected) {
        socket.emit('im_active', currentUser.id);
    }
};
window.addEventListener('focus', pingActivity);
window.addEventListener('touchstart', pingActivity, { passive: true });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pingActivity();
});



let typingTimer;
let isTyping = false;

function emitTyping() {
    if (!currentChatPartner) return;
    if (!isTyping) {
        isTyping = true;
        socket.emit('typing', { from: currentUser.id, to: currentChatPartner.id });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        isTyping = false;
        socket.emit('stop_typing', { from: currentUser.id, to: currentChatPartner.id });
    }, 2000);
}

// Add event listener for typing
if (messageInput) {
    messageInput.addEventListener('input', () => {
        emitTyping();
        pingActivity();
    });
}

socket.on('typing', (data) => {
    if (currentChatPartner && data.from === currentChatPartner.id) {
        showTypingIndicator();
    }
});

socket.on('stop_typing', (data) => {
    if (currentChatPartner && data.from === currentChatPartner.id) {
        hideTypingIndicator();
    }
});

function showTypingIndicator() {
    let indicator = document.getElementById('typing-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'typing-indicator';
        indicator.className = 'typing-indicator';
        indicator.innerHTML = '<span></span><span></span><span></span>';
    }
    // Always append it again so it moves to the very bottom
    document.getElementById('messages').appendChild(indicator);
    indicator.style.display = 'flex';
    scrollToBottom();
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.style.display = 'none';
    }
}
