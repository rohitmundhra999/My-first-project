// Fill these in once (see SETUP.md). None of these values are secret: they only identify
// your Google sign-in client, your Firebase project and the Apps Script web app.
self.APP_CONFIG = {
  // Apps Script web app URL (Deploy > New deployment > Web app), ends with /exec
  API_URL: 'https://script.google.com/macros/s/AKfycbwCJKnxhnFNs0I5WehaQcxLn2zZehPtC7WKD368lhAmGTgmQS7FhmZNY2UF3R-m02c/exec',

  // Google Cloud > APIs & Services > Credentials > OAuth client ID (Web application)
  GOOGLE_CLIENT_ID: '374454702532-p82hju1ee801n15j5pmk5r4lat1pd0tp.apps.googleusercontent.com',

  // Firebase console > Project settings > General > Your apps > Web app > SDK setup (Config)
  FIREBASE: {
    apiKey: 'AIzaSyCIR3l3N4kf_UuFafv8d8vDGLyXeEr0ty0',
    authDomain: 'nlp-approvals.firebaseapp.com',
    projectId: 'nlp-approvals',
    storageBucket: 'nlp-approvals.firebasestorage.app',
    messagingSenderId: '374454702532',
    appId: '1:374454702532:web:a01db7bee0ec70f2e1d491',
  },

  // Firebase console > Project settings > Cloud Messaging > Web Push certificates > Key pair
  VAPID_KEY: 'BCnzcgIzTTPap3zJpOx_Bs9VGDHS4clGsYey-W3jonR6bn_vLnzaGPypN9UYKAbUl9k73XHyqI4r1aDwTCgpfIc',
};
