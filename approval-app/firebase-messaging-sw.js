// Service worker: receives push notifications while the app is closed.
// It shows every notification itself (no Firebase library here), so a push is never dropped silently.

self.addEventListener('install', () => self.skipWaiting());              // a new version takes over at once
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Speed: app files are kept on the phone. Versioned files (?v=...) and libraries open straight from the phone;
// the page itself is checked online first (max 1.5 s) so a new version shows at once, else the kept copy opens.
const SHELL = 'summit-shell-v1';
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const same = u.origin === self.location.origin, lib = u.hostname === 'cdnjs.cloudflare.com' || u.hostname === 'www.gstatic.com';
  if ((!same && !lib) || u.pathname.endsWith('firebase-messaging-sw.js')) return;
  const keep = (res) => { if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())); return res; };
  if (req.mode === 'navigate') {
    event.respondWith(new Promise((resolve) => {
      let done = false;
      const fallback = () => caches.match(req).then((hit) => { if (!done && hit) { done = true; resolve(hit); } });
      const t = setTimeout(fallback, 1500);
      fetch(req).then((res) => { clearTimeout(t); keep(res.clone()); if (!done) { done = true; resolve(res); } })
        .catch(() => caches.match(req).then((hit) => { if (!done) { done = true; resolve(hit || Response.error()); } }));
    }));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(keep)));
});

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { notification: { body: event.data ? event.data.text() : '' } }; }
  const n = p.notification || {};
  const d = p.data || {};
  const title = n.title || d.title || 'Summit Procurement';
  const link = (p.fcmOptions && p.fcmOptions.link) || (p.fcm_options && p.fcm_options.link) || n.click_action || d.link || self.registration.scope;
  // tell an open app window, so it refreshes its lists at once
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => list.forEach((c) => c.postMessage({ type: 'nlp-push', title: title })));
  event.waitUntil(self.registration.showNotification(title, {
    body: n.body || d.body || '',
    icon: n.icon || 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'nlp-' + (p.fcmMessageId || p.fcm_message_id || Date.now()), // each one stays; none replaces another
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { link: link },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || self.registration.scope;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return self.clients.openWindow(link);
  }));
});
