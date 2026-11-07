// Service worker: receives push notifications while the app is closed.
importScripts('config.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp(self.APP_CONFIG.FIREBASE);
// Messages sent by the backend carry a "notification" part, so Firebase shows them automatically
// and opens the app when tapped (webpush.fcm_options.link).
firebase.messaging();
