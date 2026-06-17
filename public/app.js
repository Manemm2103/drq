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
let runtimeVersionLabel = 'Version 1.3.1';
let currentChatMessages = [];
let activeSearchTab = 'text';
let contactStateCache = {
    accepted: [],
    pendingIncoming: [],
    pendingOutgoing: [],
    rejected: []
};
let integrationTokensCache = [];
let currentChatLoadSeq = 0;
let mutedChatsCache = {};

const soundUhOh = document.getElementById('sound-uhoh');
const soundRing = document.getElementById('sound-ring');
const soundMsg = document.getElementById('sound-msg');
const maintenanceBtn = document.getElementById('maintenance-btn');
const adminBtn = document.getElementById('admin-btn');
const adminModal = document.getElementById('admin-modal');
const profileModal = document.getElementById('profile-modal');
const chatSearchBtn = document.getElementById('chat-search-btn');
const chatSearchPanel = document.getElementById('chat-search-panel');
const chatSearchInput = document.getElementById('chat-search-input');
const chatSearchResults = document.getElementById('chat-search-results');

function getVisibleName(user) {
    if (!user) return 'Unbekannt';
    const displayName = String(user.display_name || user.displayName || '').trim();
    if (displayName) return displayName;
    return user.username || user.integration_username || user.name || 'Unbekannt';
}

function getSortName(user) {
    return getVisibleName(user).toLocaleLowerCase('de-DE');
}

function applyUiTheme(themeKey) {
    const nextTheme = String(themeKey || 'graphite').trim() || 'graphite';
    document.body.dataset.theme = nextTheme;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const computed = getComputedStyle(document.body);
    const shellColor = computed.getPropertyValue('--shell-bg').trim();
    if (themeMeta && shellColor) {
        themeMeta.setAttribute('content', shellColor);
    }
    if (currentUser) {
        applyChatBackground(currentUser.chat_bg);
    }
}

// --- Auth ---

window.onload = async () => {
    await loadRuntimeConfig();
    const savedUser = localStorage.getItem('icq_user');
    const savedSound = localStorage.getItem('icq_sound');
    const savedEnterSend = localStorage.getItem('icq_enter_send');
    soundEnabled = savedSound === null ? true : JSON.parse(savedSound);
    enterToSend = savedEnterSend === null ? true : JSON.parse(savedEnterSend);
    
    // Set toggle switches (if elements exist)
    const toggle = document.getElementById('sound-toggle');
    if (toggle) toggle.checked = soundEnabled;
    const enterSendToggle = document.getElementById('enter-send-toggle');
    if (enterSendToggle) enterSendToggle.checked = enterToSend;

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
    document.addEventListener('click', (event) => {
        const menu = document.getElementById('chat-actions-menu');
        const button = document.getElementById('chat-mute-btn');
        if (!menu || menu.style.display !== 'flex') return;
        if (menu.contains(event.target) || button?.contains(event.target)) return;
        closeChatActionsMenu();
    });
};

function toggleSound(enabled) {
    soundEnabled = enabled;
    localStorage.setItem('icq_sound', JSON.stringify(enabled));
}

function restoreSession(user) {
    currentUser = user;
    document.getElementById('my-username').textContent = getVisibleName(currentUser);
    document.getElementById('my-uin').textContent = `DRQ-Nummer: ${currentUser.uin || '-'}`;
    document.getElementById('my-status').textContent = currentUser.custom_status || '-';
    applyUiTheme(currentUser.theme_key);

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
    if (maintenanceBtn) {
        maintenanceBtn.style.display = (currentUser.role === 'admin' || currentUser.can_access_maintenance_board) ? 'inline-flex' : 'none';
    }

    loginScreen.classList.remove('active');
    loginScreen.style.display = 'none';
    mainApp.classList.add('active');
    
    applyChatBackground(user.chat_bg);
    loadContactState();
    loadChatSettings();
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
    document.getElementById('edit-display-name').value = currentUser.display_name || '';
    document.getElementById('edit-password').value = ""; // Don't show old pass
    document.getElementById('edit-status').value = currentUser.custom_status || ""; // Load Status
    document.getElementById('edit-theme').value = currentUser.theme_key || 'graphite';
    
    // Render Background Options
    renderBackgroundOptions();
    loadContactState();
    loadIntegrationTokens();
}

function closeProfile() {
    profileModal.style.display = 'none';
    if (currentUser) {
        applyUiTheme(currentUser.theme_key);
    }
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
                    <div class="profile-mini-title">${escapeHtml(getVisibleName(item))}</div>
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
            accepted: data.accepted || [],
            pendingIncoming: data.pendingIncoming || [],
            pendingOutgoing: data.pendingOutgoing || [],
            rejected: data.rejected || []
        };
        renderProfileEntityList('pending-contacts-list', data.pendingIncoming || [], {
            emptyText: 'Keine offenen Anfragen',
            meta: item => `DRQ-Nummer: ${item.uin}`,
            actions: item => `
                <button type="button" onclick="acceptContact(${item.id})">Annehmen</button>
                <button type="button" class="secondary-btn" onclick="rejectContact(${item.id})">Ablehnen</button>
            `
        });
        renderProfileEntityList('outgoing-contacts-list', data.pendingOutgoing || [], {
            emptyText: 'Keine gesendeten Anfragen',
            meta: item => `DRQ-Nummer: ${item.uin}`,
            actions: item => `
                <button type="button" class="secondary-btn" onclick="deleteContactRequest(${item.id})">Entfernen</button>
            `
        });
        renderProfileEntityList('accepted-contacts-list', data.accepted || [], {
            emptyText: 'Noch keine Kontakte',
            meta: item => `DRQ-Nummer: ${item.uin}`,
            actions: item => `
                <button type="button" class="secondary-btn" onclick="promptRemoveAcceptedContact(${item.user_id})">Entfernen</button>
            `
        });
        renderUserList();
    } catch (err) {
        console.error('Failed to load contacts', err);
    }
}

async function loadChatSettings() {
    if (!currentUser) return;
    try {
        const res = await axios.get(`/api/profile/${currentUser.id}/chat-settings`, {
            params: { requesterId: currentUser.id }
        });
        mutedChatsCache = {};
        (res.data?.mutes || []).forEach((item) => {
            mutedChatsCache[String(item.muted_user_id)] = {
                muteUntil: item.mute_until || null,
                isForever: Number(item.is_forever) === 1
            };
        });
        updateChatMuteUi();
        renderUserList();
    } catch (err) {
        console.error('Failed to load chat settings', err);
    }
}

function isChatMuted(userId) {
    const entry = mutedChatsCache[String(userId)];
    if (!entry) return false;
    if (entry.isForever) return true;
    if (entry.muteUntil) {
        const untilTs = Date.parse(entry.muteUntil);
        if (!Number.isNaN(untilTs) && untilTs > Date.now()) {
            return true;
        }
    }
    delete mutedChatsCache[String(userId)];
    return false;
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
                display_name: activeEntry.display_name || '',
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
                displayName: getVisibleName(rejectedEntry)
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

function getAcceptedContactEntryByUserId(userId) {
    return (contactStateCache.accepted || []).find((item) => Number(item.user_id) === Number(userId)) || null;
}

function getChatTargetUserId(entry) {
    if (!entry) return 0;
    return Number(entry.user_id || entry.id || 0);
}

async function removeAcceptedContact(contactId, userId, options = {}) {
    const clearHistory = options.clearHistory === true;
    try {
        await axios.delete(`/api/profile/${currentUser.id}/contacts/${contactId}`, {
            data: {
                requesterId: currentUser.id,
                clearHistory
            }
        });

        if (clearHistory) {
            unreadCounts[String(userId)] = 0;
            saveUnread();
            updateGlobalUnreadBadge();
        }

        await loadContactState();

        if (currentChatPartner && Number(getChatTargetUserId(currentChatPartner)) === Number(userId)) {
            if (clearHistory) {
                closeChat();
            } else {
                const rejectedEntry = (contactStateCache.rejected || []).find((item) => Number(item.user_id) === Number(userId));
                if (rejectedEntry) {
                    openChat({
                        ...rejectedEntry,
                        kind: 'contact_request_rejected',
                        requestState: 'rejected',
                        displayName: getVisibleName(rejectedEntry)
                    });
                } else {
                    closeChat();
                }
            }
        }
    } catch (err) {
        alert(err.response?.data?.message || 'Freund konnte nicht entfernt werden');
    }
}

async function promptRemoveAcceptedContact(userId) {
    const acceptedEntry = getAcceptedContactEntryByUserId(userId);
    if (!acceptedEntry) {
        return alert('Freundschaftseintrag wurde nicht gefunden.');
    }

    if (!confirm(`Freund ${getVisibleName(acceptedEntry)} wirklich entfernen?`)) return;
    const clearHistory = confirm('Soll auch der bisherige Verlauf geloescht werden?\n\nOK = Verlauf loeschen\nAbbrechen = Verlauf behalten');
    await removeAcceptedContact(acceptedEntry.id, acceptedEntry.user_id, { clearHistory });
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
                const label = item.integration_username ? `${item.integration_username}${item.integration_uin ? ` (DRQ-Nummer: ${item.integration_uin})` : ''}` : 'Noch nicht verbunden';
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
    const newDisplayName = document.getElementById('edit-display-name').value;
    const newPassword = document.getElementById('edit-password').value;
    const newStatus = document.getElementById('edit-status').value;
    const newTheme = document.getElementById('edit-theme').value;
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
            display_name: newDisplayName,
            avatar: avatarFilename,
            chat_bg: bgValue,
            custom_status: newStatus,
            theme_key: newTheme
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
        mainApp.style.backgroundColor = getComputedStyle(document.body).getPropertyValue('--app-shell').trim() || '#e5ddd5';
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

function openMaintenanceBoard() {
    if (!currentUser || !(currentUser.role === 'admin' || currentUser.can_access_maintenance_board)) {
        return alert('Kein Zugriff auf das Wartungsboard.');
    }
    window.location.href = '/maintenance.html';
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
            info.innerHTML = `<b>${escapeHtml(getVisibleName(user))}</b> (UIN: ${user.uin})`;

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

            const maintenanceLabel = document.createElement('label');
            const maintenanceCheckbox = document.createElement('input');
            maintenanceCheckbox.type = 'checkbox';
            maintenanceCheckbox.checked = user.can_access_maintenance_board !== 0;
            maintenanceCheckbox.onchange = () => toggleMaintenanceBoardAccess(user.id, maintenanceCheckbox.checked);
            maintenanceLabel.appendChild(maintenanceCheckbox);
            maintenanceLabel.appendChild(document.createTextNode(' Maintenance'));
            topRow.appendChild(maintenanceLabel);

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

            const emailRow = document.createElement('div');
            emailRow.style.display = 'flex';
            emailRow.style.alignItems = 'center';
            emailRow.style.gap = '6px';
            emailRow.style.marginTop = '8px';
            emailRow.style.flexWrap = 'wrap';

            const emailInput = document.createElement('input');
            emailInput.type = 'email';
            emailInput.placeholder = 'E-Mail für Wartungen';
            emailInput.value = user.email || '';
            emailInput.style.width = '220px';
            emailRow.appendChild(emailInput);

            const saveEmailBtn = document.createElement('button');
            saveEmailBtn.innerText = 'E-Mail';
            saveEmailBtn.onclick = () => updateUserEmail(user.id, emailInput);
            emailRow.appendChild(saveEmailBtn);

            controls.appendChild(emailRow);

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

async function toggleMaintenanceBoardAccess(id, enabled) {
    try {
        await axios.put(`/api/admin/users/${id}/toggle-maintenance-board`, {
            requesterId: currentUser.id,
            can_access_maintenance_board: enabled
        });
        loadUsers();
    } catch (err) {
        console.error(err);
        alert("Fehler beim Ändern des Wartungsboard-Zugriffs!");
        loadUsers();
    }
}

async function createUser() {
    const username = document.getElementById('new-user').value;
    const password = document.getElementById('new-pass').value;
    const email = document.getElementById('new-email').value;
    const role = document.getElementById('new-role').value;
    
    if (!username || !password) return alert("Bitte alle Felder ausfüllen!");

    try {
        await axios.post('/api/admin/users', { 
            requesterId: currentUser.id, // Auth check
            username, password, role, email
        });
        document.getElementById('new-user').value = '';
        document.getElementById('new-pass').value = '';
        document.getElementById('new-email').value = '';
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

async function updateUserEmail(id, emailInput) {
    const email = String(emailInput.value || '').trim();

    try {
        await axios.put(`/api/admin/users/${id}/email`, {
            requesterId: currentUser.id,
            email
        });
        alert("E-Mail gespeichert!");
        loadUsers();
    } catch (err) {
        alert(err.response?.data?.message || "Fehler beim Speichern der E-Mail!");
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
            chatTitle.textContent = `${getVisibleName(currentChatPartner)} (${currentChatPartner.uin})`;
            document.getElementById('chat-subtitle').textContent = getChatSubtitle(currentChatPartner);
            document.getElementById('chat-status').className = `status-dot ${getContactIndicatorClass(currentChatPartner)}`;
        }
    }
    renderUserList();
    updateChatMuteUi();
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
        return getSortName(a).localeCompare(getSortName(b), 'de-DE');
    });

    const requestEntries = buildContactRequestEntries();
    const visibleUsers = allUsersCache.filter(user => user.id !== currentUser.id);
    const mergedEntries = [...requestEntries, ...visibleUsers];

    mergedEntries.forEach(user => {
        const div = document.createElement('div');
        const stateClass = user.requestState ? `request-${user.requestState}` : (user.status || 'offline');
        div.className = `contact-item ${stateClass}`;
        if (!user.kind && isChatMuted(user.id)) {
            div.classList.add('is-muted');
        }
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
        const visibleName = getVisibleName(user);
        const statusMsg = statusMsgText ? `<div class="contact-status-msg">${escapeHtml(statusMsgText)}</div>` : '';

        div.innerHTML = `
            ${avatarDiv}
            <div class="contact-status-mini ${getContactIndicatorClass(user)}"></div>
            <div class="contact-info">
                <div class="contact-name">${escapeHtml(visibleName)}</div>
                <div class="contact-uin">${escapeHtml(getContactMetaLabel(user))}</div>
                ${statusMsg}
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
        displayName: getVisibleName(item)
    }));
    const outgoing = (contactStateCache.pendingOutgoing || []).map(item => ({
        ...item,
        kind: 'contact_request_outgoing',
        requestState: 'outgoing',
        displayName: getVisibleName(item)
    }));
    const rejected = (contactStateCache.rejected || []).map(item => ({
        ...item,
        kind: 'contact_request_rejected',
        requestState: 'rejected',
        displayName: getVisibleName(item)
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
    if (entry.requestState === 'pending') return 'Kontaktanfrage';
    if (entry.requestState === 'outgoing') return 'Anfrage gesendet';
    if (entry.requestState === 'rejected') return 'Nicht mehr befreundet';
    if (entry.is_integration === 1) return 'Persoenliche ioBroker-Integration';
    return '';
}

function getContactListSubtitle(entry) {
    if (entry.requestState === 'pending') return 'Kontaktanfrage wartet auf deine Entscheidung';
    if (entry.requestState === 'outgoing') return 'Anfrage gesendet';
    if (entry.requestState === 'rejected') return 'Nicht mehr befreundet';
    return entry.custom_status || '';
}

socket.on('receive_message', (msg) => {
    const sender = allUsersCache.find(u => u.id === msg.sender_id);
    const senderName = getVisibleName(sender);
    const mutedForChat = msg.sender_id !== currentUser.id && isChatMuted(msg.sender_id);

    if (msg.sender_id !== currentUser.id && soundEnabled && !mutedForChat) {
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
        if(soundEnabled && !mutedForChat) soundUhOh.play().catch(e => {}); 
        if (!mutedForChat) showToast(senderName, msg.content, sender);
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
            showToast(getVisibleName(user), "ist jetzt online!", user);
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

function getUploadUrl(filename) {
    return `/uploads/${filename}`;
}

function getFirstUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s]+/i);
    return match ? match[0] : '';
}

function getDocExtension(filename) {
    const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/i);
    return match ? match[1] : '';
}

function getDocLabel(filename) {
    const ext = getDocExtension(filename);
    if (ext === 'pdf') return 'PDF';
    if (['doc', 'docx'].includes(ext)) return 'Word';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'Excel';
    if (['ppt', 'pptx'].includes(ext)) return 'PPT';
    if (['txt', 'log', 'json', 'xml', 'yaml', 'yml', 'md'].includes(ext)) return 'Text';
    if (['zip', 'rar', '7z'].includes(ext)) return 'Archiv';
    return ext ? ext.toUpperCase() : 'Datei';
}

function formatGalleryFilename(filename, fallback = '') {
    return escapeHtml(String(filename || fallback || '').trim() || 'Datei');
}

function formatSearchPreview(msg) {
    if (msg.type === 'image') return 'Bild';
    if (msg.type === 'video') return 'Video';
    if (msg.type === 'audio') return 'Audio';
    if (msg.type === 'code') return msg.content || 'Code';
    if (msg.filename) return msg.filename;
    return msg.content || '';
}

function renderSearchResultMarkup(msg) {
    const title = new Date(msg.timestamp).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const safeTitle = escapeHtml(title);

    if (activeSearchTab === 'media') {
        if (msg.type === 'image') {
            return `
                <button class="search-result-item gallery-card media-card" onclick="jumpToMessage(${msg.id})">
                    <div class="gallery-thumb-wrap">
                        <img class="gallery-thumb" src="${getUploadUrl(msg.filename)}" alt="${formatGalleryFilename(msg.filename, 'Bild')}">
                    </div>
                    <div class="gallery-meta">
                        <div class="gallery-name">${formatGalleryFilename(msg.filename, 'Bild')}</div>
                        <div class="gallery-time">${safeTitle}</div>
                    </div>
                </button>
            `;
        }
        if (msg.type === 'video') {
            return `
                <button class="search-result-item gallery-card media-card" onclick="jumpToMessage(${msg.id})">
                    <div class="gallery-thumb-wrap video-thumb-wrap">
                        <video class="gallery-thumb" src="${getUploadUrl(msg.filename)}" muted playsinline preload="metadata"></video>
                        <span class="gallery-badge">Video</span>
                    </div>
                    <div class="gallery-meta">
                        <div class="gallery-name">${formatGalleryFilename(msg.filename, 'Video')}</div>
                        <div class="gallery-time">${safeTitle}</div>
                    </div>
                </button>
            `;
        }
        return `
            <button class="search-result-item gallery-card media-card audio-card" onclick="jumpToMessage(${msg.id})">
                <div class="gallery-icon">🎧</div>
                <div class="gallery-meta">
                    <div class="gallery-name">${formatGalleryFilename(msg.filename, 'Audio')}</div>
                    <div class="gallery-time">${safeTitle}</div>
                </div>
            </button>
        `;
    }

    if (activeSearchTab === 'docs') {
        return `
            <button class="search-result-item gallery-card doc-card" onclick="jumpToMessage(${msg.id})">
                <div class="doc-thumb">
                    <span class="doc-thumb-label">${escapeHtml(getDocLabel(msg.filename))}</span>
                </div>
                <div class="gallery-meta">
                    <div class="gallery-name">${formatGalleryFilename(msg.filename, 'Dokument')}</div>
                    <div class="gallery-time">${safeTitle}</div>
                </div>
            </button>
        `;
    }

    if (activeSearchTab === 'links') {
        const url = getFirstUrl(msg.content);
        let hostname = '';
        let pathLabel = url;
        try {
            const parsed = new URL(url);
            hostname = parsed.hostname;
            pathLabel = `${parsed.pathname || '/'}${parsed.search || ''}` || '/';
        } catch (err) {}
        return `
            <button class="search-result-item link-card" onclick="jumpToMessage(${msg.id})">
                <div class="link-card-head">
                    <div class="link-site-badge">${escapeHtml((hostname || 'Link').slice(0, 1).toUpperCase())}</div>
                    <div class="link-card-copy">
                        <div class="link-card-site">${escapeHtml(hostname || 'Link')}</div>
                        <div class="link-card-path">${escapeHtml(pathLabel)}</div>
                    </div>
                </div>
                <div class="link-card-url">${escapeHtml(url)}</div>
                <div class="gallery-time">${safeTitle}</div>
            </button>
        `;
    }

    return `
        <button class="search-result-item" onclick="jumpToMessage(${msg.id})">
            <div class="search-result-title">${safeTitle}</div>
            <div class="search-result-snippet">${escapeHtml(formatSearchPreview(msg).substring(0, 140))}</div>
        </button>
    `;
}

function updateChatSearch() {
    if (!chatSearchResults) return;
    chatSearchResults.classList.toggle('is-gallery', activeSearchTab === 'media' || activeSearchTab === 'docs' || activeSearchTab === 'links');
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

    chatSearchResults.classList.toggle('is-gallery', activeSearchTab === 'media' || activeSearchTab === 'docs' || activeSearchTab === 'links');
    chatSearchResults.innerHTML = results.slice().reverse().map((msg) => renderSearchResultMarkup(msg)).join('');
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
    const chatLoadSeq = ++currentChatLoadSeq;
    currentChatPartner = user;
    chatTitle.textContent = `${getVisibleName(user)} (${user.uin})`;
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
    updateChatMuteUi();
    
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
    currentChatMessages = [];
    if (user.kind && user.kind !== 'user') {
        renderContactRequestChat(user);
        return;
    }

    setChatComposerDisabled(false);
    messagesDiv.innerHTML = '<div class="empty-state"><p>Chat wird geladen...</p></div>';

    try {
        const res = await axios.get(`/api/history/${currentUser.id}/${user.id}`);
        if (chatLoadSeq !== currentChatLoadSeq || !currentChatPartner || Number(currentChatPartner.id) !== Number(user.id)) {
            return;
        }

        const liveMessages = [...currentChatMessages];
        currentChatMessages = Array.isArray(res.data) ? res.data : [];
        liveMessages.forEach(upsertCurrentChatMessage);
        renderCurrentChatMessages();
        scrollToBottom();
    } catch (err) {
        if (chatLoadSeq !== currentChatLoadSeq || !currentChatPartner || Number(currentChatPartner.id) !== Number(user.id)) {
            return;
        }

        if (currentChatMessages.length) {
            renderCurrentChatMessages();
            scrollToBottom();
        } else {
            messagesDiv.innerHTML = '<div class="empty-state"><p>Verlauf konnte gerade nicht geladen werden.</p></div>';
        }
        console.error('Failed to load chat history', err);
    }
}

function toggleChatActionsMenu() {
    const menu = document.getElementById('chat-actions-menu');
    if (!currentChatPartner || currentChatPartner.kind) return;
    menu.style.display = (menu.style.display === 'flex') ? 'none' : 'flex';
}

function closeChatActionsMenu() {
    const menu = document.getElementById('chat-actions-menu');
    if (menu) menu.style.display = 'none';
}

function updateChatMuteUi() {
    const muteBtn = document.getElementById('chat-mute-btn');
    const clearBtn = document.getElementById('chat-clear-btn');
    const removeBtn = document.getElementById('chat-remove-btn');
    if (!muteBtn) return;
    if (clearBtn) clearBtn.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';

    if (!currentChatPartner) {
        muteBtn.style.display = 'none';
        closeChatActionsMenu();
        return;
    }

    const canMute = !currentChatPartner.kind;
    const canClear = !currentChatPartner.kind || currentChatPartner.requestState === 'rejected';
    const canRemove = !currentChatPartner.kind;

    muteBtn.style.display = canMute ? 'inline-flex' : 'none';
    if (canMute) {
        muteBtn.textContent = isChatMuted(currentChatPartner.id) ? '🔕' : '🔔';
        muteBtn.title = isChatMuted(currentChatPartner.id) ? 'Chat ist stumm' : 'Chat Optionen';
    } else {
        closeChatActionsMenu();
    }

    if (clearBtn && canClear) {
        clearBtn.style.display = 'inline-flex';
    }

    if (removeBtn && canRemove) {
        removeBtn.style.display = 'inline-flex';
    }
}

async function muteCurrentChat(mode) {
    if (!currentChatPartner || currentChatPartner.kind) return;
    try {
        await axios.post(`/api/profile/${currentUser.id}/chats/${currentChatPartner.id}/mute`, {
            requesterId: currentUser.id,
            durationHours: mode === 'forever' ? 0 : Number(mode),
            forever: mode === 'forever'
        });
        await loadChatSettings();
        closeChatActionsMenu();
    } catch (err) {
        alert(err.response?.data?.message || 'Chat konnte nicht stumm geschaltet werden');
    }
}

async function unmuteCurrentChat() {
    if (!currentChatPartner || currentChatPartner.kind) return;
    try {
        await axios.delete(`/api/profile/${currentUser.id}/chats/${currentChatPartner.id}/mute`, {
            data: { requesterId: currentUser.id }
        });
        await loadChatSettings();
        closeChatActionsMenu();
    } catch (err) {
        alert(err.response?.data?.message || 'Stumm konnte nicht aufgehoben werden');
    }
}

async function clearCurrentChatHistory() {
    if (!currentChatPartner) return;
    const targetUserId = getChatTargetUserId(currentChatPartner);
    if (!targetUserId) return;
    if (!confirm(`Chatverlauf mit ${currentChatPartner.username} wirklich leeren?`)) return;
    try {
        await axios.delete(`/api/profile/${currentUser.id}/chats/${targetUserId}/history`, {
            data: { requesterId: currentUser.id }
        });
        currentChatMessages = [];
        unreadCounts[String(targetUserId)] = 0;
        saveUnread();
        if (currentChatPartner.kind && currentChatPartner.requestState === 'rejected') {
            closeChat();
        } else {
            renderCurrentChatMessages();
        }
        renderUserList();
        updateGlobalUnreadBadge();
        closeChatActionsMenu();
    } catch (err) {
        alert(err.response?.data?.message || 'Chatverlauf konnte nicht geleert werden');
    }
}

async function removeCurrentFriend() {
    if (!currentChatPartner || currentChatPartner.kind) return;
    await promptRemoveAcceptedContact(currentChatPartner.id);
}

function showContactList() {
    currentChatLoadSeq += 1;
    currentChatPartner = null;
    currentChatMessages = [];
    updateChatMuteUi();
    closeChatActionsMenu();
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
        const captionHtml = msg.content ? `<div class="media-caption">${formatText(msg.content)}</div>` : '';
        contentHtml = `${captionHtml}<strong>📹 Videonachricht</strong><br><video src="/uploads/${msg.filename}" controls style="max-width: 100%; border-radius: 8px; margin-top: 5px;"></video>`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
    } else if (msg.type === 'audio') {
        const captionHtml = msg.content ? `<div class="media-caption">${formatText(msg.content)}</div>` : '';
        contentHtml = `${captionHtml}<strong>🎤 Sprachnachricht</strong><br><audio src="/uploads/${msg.filename}" controls style="width: 100%; margin-top: 5px;"></audio>`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
} else if (msg.type === 'image') {
        const captionHtml = msg.content ? `<div class="media-caption">${formatText(msg.content)}</div>` : '';
        contentHtml = `${captionHtml}<img src="/uploads/${msg.filename}" alt="Image" onclick="window.open(this.src)">`;
        copyText = window.location.origin + '/uploads/' + msg.filename;
    } else {
        const captionHtml = msg.content ? `<div class="media-caption">${formatText(msg.content)}</div>` : '';
        contentHtml = `${captionHtml}<a href="/uploads/${msg.filename}" download="${msg.filename}">📎 ${msg.filename}</a>`;
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
    const title = escapeHtml(getVisibleName(user));
    const requestText = user.requestState === 'pending'
        ? 'moechte dich als Kontakt hinzufuegen.'
        : user.requestState === 'outgoing'
            ? 'hat deine Anfrage noch nicht bestaetigt.'
            : 'ist nicht mehr mit dir befreundet.';

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
            <div class="request-chat-meta">DRQ-Nummer: ${escapeHtml(String(user.uin || ''))}</div>
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
    currentChatLoadSeq += 1;
    currentChatPartner = null;
    currentChatMessages = [];
    updateChatMuteUi();
    closeChatActionsMenu();
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

function handleEnter(e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
        const isMobile = window.innerWidth <= 768;
        if (!e.shiftKey && (enterToSend || isMobile)) {
            e.preventDefault();
            sendMessage();
        }
    }
}

function insertMarkdown(marker) {
    const start = messageInput.selectionStart;
    const end = messageInput.selectionEnd;
    const text = messageInput.value;
    const selected = text.substring(start, end);
    const newText = text.substring(0, start) + marker + selected + marker + text.substring(end);

    messageInput.value = newText;
    messageInput.focus();

    if (start === end) {
        messageInput.setSelectionRange(start + marker.length, start + marker.length);
    } else {
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
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');
        const isAudio = file.type.startsWith('audio/');
        const type = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'file';
        socket.emit('send_message', {
            senderId: currentUser.id,
            receiverId: currentChatPartner.id,
            content: '',
            type,
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
const audioCallPlaceholder = document.getElementById('audio-call-placeholder');
const muteBtn = document.getElementById('mute-btn');
const videoBtn = document.getElementById('video-btn');

let rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceTransportPolicy: 'all'
};

let localStream = null;
let remoteStream = null;
let peerConnection = null;
let incomingCallData = null;
let activeCallPartnerId = null;
let activeCallTargetSocketId = null;
let pendingIceCandidates = [];
let callWantsVideo = false;
let callFailureTimer = null;

function ensureCallVideoPlayback(videoEl, muted = false) {
    if (!videoEl) return;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.muted = muted;
    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
    }
}

function getCallConstraints(wantVideo) {
    return {
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: { ideal: 2 },
            sampleRate: { ideal: 48000 },
            sampleSize: { ideal: 16 }
        },
        video: wantVideo ? {
            facingMode: 'user',
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 360 },
            frameRate: { ideal: 30, min: 15 }
        } : false
    };
}

function updateCallOverlayMeta(name, statusText) {
    if (name !== undefined && name !== null) callPartnerNameEl.textContent = name;
    if (statusText !== undefined && statusText !== null) callPartnerStatusEl.textContent = statusText;
}

function updateCallControls() {
    const hasVideoTrack = !!(localStream && localStream.getVideoTracks().length);
    if (videoBtn) {
        videoBtn.style.display = callWantsVideo ? 'flex' : 'none';
        videoBtn.disabled = !hasVideoTrack;
        if (hasVideoTrack) {
            const enabled = localStream.getVideoTracks()[0].enabled;
            videoBtn.classList.toggle('active', !enabled);
            videoBtn.innerHTML = enabled ? '📷<span>Kamera</span>' : '🚫<span>Kamera aus</span>';
        }
    }
    if (muteBtn && localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            muteBtn.classList.toggle('active', !audioTrack.enabled);
            muteBtn.innerHTML = audioTrack.enabled ? '🎤<span>Mic</span>' : '🔇<span>Stumm</span>';
        }
    }
}

function updateCallVisualState() {
    const hasVideoTrack = !!(localStream && localStream.getVideoTracks().length);
    localVideo.style.display = hasVideoTrack ? 'block' : 'none';
    localVideo.style.visibility = 'visible';
    if (audioCallPlaceholder) audioCallPlaceholder.style.display = callWantsVideo ? 'none' : 'flex';
}

function resetCallUi() {
    updateCallOverlayMeta('Anruf', 'Verbindung wird aufgebaut...');
    if (audioCallPlaceholder) audioCallPlaceholder.style.display = 'none';
    if (localVideo) {
        localVideo.style.display = 'none';
        localVideo.style.visibility = 'visible';
        localVideo.srcObject = null;
    }
    if (remoteVideo) {
        remoteVideo.srcObject = null;
        remoteVideo.style.display = 'block';
    }
}

function clearCallFailureTimer() {
    if (callFailureTimer) {
        clearTimeout(callFailureTimer);
        callFailureTimer = null;
    }
}

async function applyPreferredSenderParameters() {
    if (!peerConnection || !peerConnection.getSenders) return;
    const senders = peerConnection.getSenders();

    for (const sender of senders) {
        if (!sender || !sender.track || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
            continue;
        }

        const params = sender.getParameters() || {};
        if (!params.encodings || !params.encodings.length) {
            params.encodings = [{}];
        }

        if (sender.track.kind === 'video') {
            params.encodings[0].maxBitrate = 2_500_000;
            params.encodings[0].maxFramerate = 30;
            params.degradationPreference = 'maintain-resolution';
        }

        if (sender.track.kind === 'audio') {
            params.encodings[0].maxBitrate = 128_000;
            params.degradationPreference = 'maintain-framerate';
        }

        try {
            await sender.setParameters(params);
        } catch (err) {
            console.warn('Could not apply sender parameters', err);
        }
    }
}

function canStartCallWithPartner() {
    if (!currentChatPartner) return false;
    if (currentChatPartner.kind && currentChatPartner.kind !== 'user') {
        alert('Anrufe sind aktuell nur mit normalen Kontakten möglich.');
        return false;
    }
    if (currentChatPartner.status !== 'online') {
        alert('Der Kontakt ist gerade nicht online.');
        return false;
    }
    return true;
}

function createPeerConnection(targetUserId, targetSocketId = null) {
    peerConnection = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;
    ensureCallVideoPlayback(remoteVideo, false);
    pendingIceCandidates = [];

    peerConnection.onicecandidate = (event) => {
        if (!event.candidate) return;
        socket.emit('ice_candidate', {
            to: targetUserId,
            toSocketId: targetSocketId || activeCallTargetSocketId || null,
            candidate: event.candidate
        });
    };

    peerConnection.ontrack = (event) => {
        const sourceStream = event.streams && event.streams[0] ? event.streams[0] : null;
        if (sourceStream) {
            sourceStream.getTracks().forEach((track) => {
                if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
                    remoteStream.addTrack(track);
                }
            });
        } else if (event.track && !remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
            remoteStream.addTrack(event.track);
        }
        remoteVideo.srcObject = remoteStream;
        ensureCallVideoPlayback(remoteVideo, false);
        updateCallOverlayMeta(null, callWantsVideo ? 'Verbunden' : 'Sprachanruf aktiv');
    };

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === 'new') updateCallOverlayMeta(null, 'Verbindung wird vorbereitet...');
        if (state === 'connecting') updateCallOverlayMeta(null, 'Verbindung wird aufgebaut...');
        if (state === 'connected') {
            clearCallFailureTimer();
            updateCallOverlayMeta(null, callWantsVideo ? 'Verbunden' : 'Sprachanruf aktiv');
        }
        if (state === 'disconnected') updateCallOverlayMeta(null, 'Verbindung unterbrochen');
        if (state === 'failed') {
            updateCallOverlayMeta(null, 'Verbindung fehlgeschlagen');
            clearCallFailureTimer();
            callFailureTimer = setTimeout(() => {
                if (peerConnection && peerConnection.connectionState === 'failed') {
                    endCall(true);
                }
            }, 4000);
        }
        if (state === 'closed') endCall(true);
    };

    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        if (state === 'checking') updateCallOverlayMeta(null, 'Netzwerk wird verbunden...');
        if (state === 'connected' || state === 'completed') {
            clearCallFailureTimer();
            updateCallOverlayMeta(null, callWantsVideo ? 'Verbunden' : 'Sprachanruf aktiv');
        }
        if (state === 'disconnected') updateCallOverlayMeta(null, 'Netzwerk kurz unterbrochen...');
        if (state === 'failed') {
            clearCallFailureTimer();
            callFailureTimer = setTimeout(() => {
                if (peerConnection && peerConnection.iceConnectionState === 'failed') {
                    updateCallOverlayMeta(null, 'Verbindung fehlgeschlagen');
                    endCall(true);
                }
            }, 4000);
        }
    };
}

async function flushPendingIceCandidates() {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    while (pendingIceCandidates.length) {
        const candidate = pendingIceCandidates.shift();
        if (!candidate) continue;
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn('ICE candidate ignored', err);
        }
    }
}

async function waitForIceGatheringComplete() {
    if (!peerConnection) return;
    if (peerConnection.iceGatheringState === 'complete') return;
    const timeoutMs = rtcConfig.iceTransportPolicy === 'relay' ? 5000 : 1800;
    await new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            peerConnection.removeEventListener('icegatheringstatechange', onStateChange);
            resolve();
        };
        const onStateChange = () => {
            if (peerConnection && peerConnection.iceGatheringState === 'complete') {
                finish();
            }
        };
        const timer = setTimeout(finish, timeoutMs);
        peerConnection.addEventListener('icegatheringstatechange', onStateChange);
    });
}

async function prepareLocalMedia(wantVideo) {
    localStream = await navigator.mediaDevices.getUserMedia(getCallConstraints(wantVideo));
    if (wantVideo) {
        localVideo.srcObject = localStream;
        ensureCallVideoPlayback(localVideo, true);
    }
    updateCallControls();
    updateCallVisualState();
}

const originalOpenChat = openChat;
openChat = async function(user) {
    await originalOpenChat(user);
    const canCall = !user.kind || user.kind === 'user';
    callAudioBtn.style.display = canCall ? 'block' : 'none';
    callVideoBtn.style.display = canCall ? 'block' : 'none';
};

async function startCall(video = true) {
    if (!canStartCallWithPartner()) return;

    try {
        callWantsVideo = video === true;
        activeCallPartnerId = currentChatPartner.id;
        activeCallTargetSocketId = null;
        resetCallUi();
        updateCallOverlayMeta(getVisibleName(currentChatPartner), callWantsVideo ? 'Videoanruf wird aufgebaut...' : 'Sprachanruf wird aufgebaut...');
        videoOverlay.style.display = 'flex';

        await prepareLocalMedia(callWantsVideo);
        createPeerConnection(currentChatPartner.id, null);
        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
        await applyPreferredSenderParameters();

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        await waitForIceGatheringComplete();

        socket.emit('call_user', {
            userToCall: currentChatPartner.id,
            signalData: peerConnection.localDescription,
            from: currentUser.id,
            video: callWantsVideo
        });
    } catch (err) {
        console.error('Error starting call:', err);
        alert('Konnte den Anruf nicht starten. Bitte Kamera/Mikrofon im Browser erlauben.');
        endCall(false);
    }
}

socket.on('call_user', (data) => {
    if (peerConnection || incomingCallData) return;
    incomingCallData = data;
    activeCallTargetSocketId = data.fromSocketId || null;
    const caller = allUsersCache.find((u) => u.id === data.from);
    callerNameSpan.textContent = `${getVisibleName(caller)}${data.video ? ' (Video)' : ' (Audio)'}`;
    incomingCallModal.style.display = 'block';
    if (soundEnabled && soundRing) {
        soundRing.currentTime = 0;
        soundRing.play().catch(() => {});
    }
});

async function acceptCall() {
    if (!incomingCallData) return;

    incomingCallModal.style.display = 'none';
    if (soundRing) {
        soundRing.pause();
        soundRing.currentTime = 0;
    }

    try {
        callWantsVideo = incomingCallData.video === true;
        activeCallPartnerId = incomingCallData.from;
        activeCallTargetSocketId = incomingCallData.fromSocketId || null;
        resetCallUi();
        const caller = allUsersCache.find((u) => u.id === incomingCallData.from);
        updateCallOverlayMeta(getVisibleName(caller), callWantsVideo ? 'Videoanruf wird verbunden...' : 'Sprachanruf wird verbunden...');
        videoOverlay.style.display = 'flex';

        await prepareLocalMedia(callWantsVideo);
        createPeerConnection(incomingCallData.from, incomingCallData.fromSocketId || null);
        localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
        await applyPreferredSenderParameters();

        await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingCallData.signal));
        await flushPendingIceCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await waitForIceGatheringComplete();

        socket.emit('answer_call', {
            signal: peerConnection.localDescription,
            to: incomingCallData.from,
            toSocketId: incomingCallData.fromSocketId || null
        });
    } catch (err) {
        console.error('Error accepting call:', err);
        alert('Konnte den Anruf nicht annehmen. Bitte Kamera/Mikrofon im Browser erlauben.');
        endCall(false);
    }
}

function rejectCall() {
    if (!incomingCallData) return;
    incomingCallModal.style.display = 'none';
    if (soundRing) {
        soundRing.pause();
        soundRing.currentTime = 0;
    }
    socket.emit('end_call', {
        to: incomingCallData.from,
        toSocketId: incomingCallData.fromSocketId || null
    });
    incomingCallData = null;
    activeCallPartnerId = null;
    activeCallTargetSocketId = null;
}

socket.on('call_accepted', async (payload) => {
    if (!peerConnection) return;
    const signal = payload && payload.signal ? payload.signal : payload;
    activeCallTargetSocketId = payload && payload.fromSocketId ? payload.fromSocketId : activeCallTargetSocketId;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
    await flushPendingIceCandidates();
    updateCallOverlayMeta(null, callWantsVideo ? 'Verbunden' : 'Sprachanruf aktiv');
});

socket.on('call_routed', (data) => {
    activeCallTargetSocketId = data && data.targetSocketId ? data.targetSocketId : null;
});

socket.on('ice_candidate', async (candidate) => {
    if (!candidate) return;
    if (!peerConnection || !peerConnection.remoteDescription) {
        pendingIceCandidates.push(candidate);
        return;
    }
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.warn('Error adding ICE candidate', err);
    }
});

socket.on('end_call', () => {
    endCall(true);
});

function endCall(isRemote = false) {
    if (!isRemote && (activeCallPartnerId || (incomingCallData && incomingCallData.from))) {
        socket.emit('end_call', {
            to: activeCallPartnerId || incomingCallData.from,
            toSocketId: activeCallTargetSocketId || (incomingCallData ? incomingCallData.fromSocketId : null) || null
        });
    }

    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    remoteStream = null;
    incomingCallData = null;
    activeCallPartnerId = null;
    activeCallTargetSocketId = null;
    pendingIceCandidates = [];
    callWantsVideo = false;
    clearCallFailureTimer();

    if (soundRing) {
        soundRing.pause();
        soundRing.currentTime = 0;
    }

    videoOverlay.style.display = 'none';
    incomingCallModal.style.display = 'none';
    resetCallUi();
}

function toggleMute() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    updateCallControls();
}

function toggleVideo() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.enabled = !videoTrack.enabled;
    localVideo.style.visibility = videoTrack.enabled ? 'visible' : 'hidden';
    updateCallControls();
}

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
            const register = await navigator.serviceWorker.register('/sw.js?v=3');
            
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
