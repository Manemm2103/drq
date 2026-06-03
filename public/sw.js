
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', e => {
    const data = e.data.json();
    console.log('Push Received...', data);
    
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: data.icon || '/drq-logo.svg',
        vibrate: [200, 100, 200, 100, 200, 100, 200],
        tag: data.tag,
        requireInteraction: !!data.requireInteraction,
        data: data.data || { url: '/' }
    });
});

self.addEventListener('notificationclick', e => {
    e.notification.close(); // Close the notification
    
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            const targetUrl = (e.notification.data && e.notification.data.url) ? e.notification.data.url : '/';
            // Check if app is already open and focus it
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes(targetUrl) && 'focus' in client) {
                    return client.focus();
                }
            }
            // If not open, open a new window
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
