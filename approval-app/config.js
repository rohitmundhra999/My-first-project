// Fill these in once (see SETUP.md). None of these values are secret: they only identify
// your Google sign-in client, your Firebase project and the Apps Script web app.
self.APP_CONFIG = {
  // Apps Script web app URL (Deploy > New deployment > Web app), ends with /exec
  API_URL: 'PASTE_APPS_SCRIPT_WEB_APP_URL',

  // Google Cloud > APIs & Services > Credentials > OAuth client ID (Web application)
  GOOGLE_CLIENT_ID: 'PASTE_CLIENT_ID.apps.googleusercontent.com',

  // Firebase console > Project settings > General > Your apps > Web app > SDK setup (Config)
  FIREBASE: {
    apiKey: 'PASTE',
    authDomain: 'PASTE.firebaseapp.com',
    projectId: 'PASTE',
    storageBucket: 'PASTE.appspot.com',
    messagingSenderId: 'PASTE',
    appId: 'PASTE',
  },

  // Firebase console > Project settings > Cloud Messaging > Web Push certificates > Key pair
  VAPID_KEY: 'PASTE',
};
