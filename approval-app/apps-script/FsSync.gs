
// ======================= Fast reading: a copy of the app's lists in Firebase Firestore =======================
// The Google Sheet stays the main record. After every save in the app, every minute (trigger) and after every
// warmCache, the same data the app gets from "sync" is written to Firestore, so phones read it in a fraction of a
// second. Only documents whose content changed are written. Who may read what is kept in acl/{email}
// (full = HO / approver / admin; units = a storekeeper's units). Nothing in the sheet is changed by this.
const FS_PROJECT = 'nlp-approvals';
const FS_BASE = 'https://firestore.googleapis.com/v1/projects/' + FS_PROJECT + '/databases/(default)/documents/';
const FS_CHUNK = 700000;   // characters per document (Firestore limit is 1 MB per document)
const FS_SYS = { name: 'SYSTEM', email: '', isHO: true, isApprover: true, isAdmin: true, isStore: false, units: [] };
const fsId_ = s => String(s).replace(/[^A-Za-z0-9]/g, '_').slice(0, 120);

function fsToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('fs_access');
  if (hit) return hit;
  const sa = JSON.parse(prop_('FIREBASE_SERVICE_ACCOUNT'));
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig } });
  if (res.getResponseCode() !== 200) throw new Error('Firestore access: ' + res.getContentText());
  const t = JSON.parse(res.getContentText()).access_token;
  cache.put('fs_access', t, 3000);
  return t;
}

/** Builds every published part (same shapes as the "sync" reply). */
function fsParts_(only) {
  const want = k => !only || only.indexOf(k) !== -1;
  const parts = {}, safe = (k, fn) => { try { parts[k] = fn(); } catch (e) { console.error('FS ' + k + ': ' + e); } };
  if (want('ho')) safe('ho', () => hoList_(FS_SYS, {}));
  if (want('reports')) safe('reports', () => reports_(FS_SYS, {}));
  if (want('dec')) safe('dec', () => { const r = decisions_(FS_SYS, {}); if (r.decisions) r.decisions = Object.assign({}, r.decisions, { lines: pack_(r.decisions.lines) }); return r; });
  if (want('po')) safe('po', () => poPending_(''));
  if (want('vendors')) safe('vendors', () => vendors_());
  if (want('irep')) safe('irep', () => invoiceReport_(FS_SYS, {}));
  if (want('vlist')) safe('vlist', () => vendorList_(FS_SYS));
  const users = activeUsers_();
  if (want('mine')) users.filter(u => u.isApprover).forEach(u => safe('mine_' + fsId_(u.email), () => Object.assign({ owner: u.email }, myList_(u, {}))));
  if (want('store')) {
    const units = {};
    users.forEach(u => u.units.forEach(x => (units[x] = true)));
    Object.keys(units).forEach(x => safe('store_' + fsId_(x), () => { const r = storeList_(FS_SYS, { unit: x }); if (r.lines) r.lines = pack_(r.lines); return r; }));
  }
  if (want('acl')) users.forEach(u => (parts['acl:' + u.email] = { full: !!(u.isHO || u.isApprover || u.isAdmin), ho: !!(u.isHO || u.isAdmin), units: u.units.map(fsId_) }));
  return parts;
}

/** Writes the parts that changed since the last time (version kept in the cache). */
function fsPublish_(only) {
  if (!prop_('FIREBASE_SERVICE_ACCOUNT')) return 0;
  const parts = fsParts_(only), cache = CacheService.getScriptCache(), token = fsToken_();
  const reqs = [], marks = {};
  const doc = (path, fields) => reqs.push({ url: FS_BASE + path, method: 'patch', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify({ fields: fields }) });
  Object.keys(parts).forEach(k => {
    if (k.indexOf('acl:') === 0) {
      const a = parts[k], v = ver_(a);
      if (cache.get('fsv_' + k) === v) return;
      marks['fsv_' + k] = v;
      doc('acl/' + encodeURIComponent(k.slice(4)), { full: { booleanValue: a.full }, ho: { booleanValue: a.ho }, units: { arrayValue: { values: a.units.map(x => ({ stringValue: x })) } } });
      return;
    }
    const text = JSON.stringify(parts[k]), v = ver_(text);
    if (cache.get('fsv_' + k) === v) return;
    marks['fsv_' + k] = v;
    const n = Math.max(1, Math.ceil(text.length / FS_CHUNK));
    for (let i = 0; i < n; i++) doc('pub/' + k + '/c/' + i, { j: { stringValue: text.slice(i * FS_CHUNK, (i + 1) * FS_CHUNK) }, v: { stringValue: v } });
    const unit = k.indexOf('store_') === 0 ? k.slice(6) : '', owner = k.indexOf('mine_') === 0 ? parts[k].owner : '';
    doc('pub/' + k, { v: { stringValue: v }, n: { integerValue: String(n) }, at: { timestampValue: new Date().toISOString() },
      unit: { stringValue: unit }, owner: { stringValue: owner } });   // the head is written last: readers fetch the chunks when v changes
  });
  if (!reqs.length) return 0;
  // chunks first, heads last (fetchAll runs in parallel, so two rounds)
  const heads = reqs.filter(r => !/\/c\/\d+$/.test(r.url)), chunks = reqs.filter(r => /\/c\/\d+$/.test(r.url));
  let bad = 0;
  [chunks, heads].forEach(list => { if (list.length) UrlFetchApp.fetchAll(list).forEach(r => { if (r.getResponseCode() !== 200) { bad++; console.error('FS write ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300)); } }); });
  if (!bad) cache.putAll(marks, 21600);
  return reqs.length - bad;
}

/** Trigger every minute (fsSetup makes it): publishes what changed. warmCache also calls it after reading the sheet. */
function fsTick() { try { fsPublish_(); } catch (e) { console.error('fsTick: ' + e); } }

/** After a save in the app: publish the lists that save can change. */
function fsAfterWrite_(action) {
  const map = { assign: ['ho', 'mine', 'reports', 'dec'], decide: ['ho', 'mine', 'reports', 'dec', 'po'], storeRaise: ['ho', 'store', 'reports'],
    storeReceive: ['store', 'reports', 'irep'], storeInvoice: ['store', 'reports', 'irep'], makePO: ['po', 'store', 'reports', 'irep', 'vendors', 'vlist'],
    vendorSave: ['vendors', 'vlist', 'irep'], editItem: ['ho', 'mine', 'po', 'store'], goodsSave: ['reports'] };
  if (!map[action]) return;
  try { fsPublish_(map[action]); } catch (e) { console.error('fsAfterWrite: ' + e); }
}

/** Sign-in for Firestore: a short-lived token for the signed-in user (uid = their email), made by the server. */
function fsCustomToken_(email) {
  const sa = JSON.parse(prop_('FIREBASE_SERVICE_ACCOUNT')), now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, sub: sa.client_email, uid: String(email).toLowerCase(),
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', iat: now, exp: now + 3600 });
  return input + '.' + Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
}
function fsTokenAction_(user, req, realUser) { return { token: fsCustomToken_(realUser.email) }; }

/** One-time: creates the Firestore database (if missing) and puts the security rules live. Returns what happened. */
function fsAdminSetup_() {
  const sa = JSON.parse(prop_('FIREBASE_SERVICE_ACCOUNT')), now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  const tok = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/token', { method: 'post', payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig } }).getContentText()).access_token;
  const call = (method, url, body) => { const r = UrlFetchApp.fetch(url, { method: method, contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tok }, payload: body ? JSON.stringify(body) : undefined }); return [r.getResponseCode(), r.getContentText()]; };
  const out = {};
  out.db = call('post', 'https://firestore.googleapis.com/v1/projects/' + FS_PROJECT + '/databases?databaseId=(default)', { locationId: 'asia-south1', type: 'FIRESTORE_NATIVE' });
  if (out.db[0] === 200) Utilities.sleep(20000);   // a new database takes a few seconds
  const rs = call('post', 'https://firebaserules.googleapis.com/v1/projects/' + FS_PROJECT + '/rulesets', { source: { files: [{ name: 'firestore.rules', content: FS_RULES }] } });
  out.rules = rs;
  if (rs[0] === 200) {
    const name = JSON.parse(rs[1]).name;
    const rel = 'projects/' + FS_PROJECT + '/releases/cloud.firestore';
    out.release = call('patch', 'https://firebaserules.googleapis.com/v1/' + rel, { release: { name: rel, rulesetName: name } });
    if (out.release[0] === 404) out.release = call('post', 'https://firebaserules.googleapis.com/v1/projects/' + FS_PROJECT + '/releases', { name: rel, rulesetName: name });
  }
  Object.keys(out).forEach(k => (out[k] = [out[k][0], String(out[k][1]).slice(0, 300)]));
  return out;
}

/** Run once from the editor: database + rules, the every-minute trigger, and a first full publish. */
function fsSetup() {
  console.log(JSON.stringify(fsAdminSetup_()));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'fsTick').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fsTick').timeBased().everyMinutes(1).create();
  CacheService.getScriptCache().removeAll(['fsv_reports']);
  const n = fsPublish_();
  console.log('Published ' + n + ' documents');
  return n;
}

const FS_RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    function signedIn() { return request.auth != null; }\n    function acl() { return get(/databases/$(db)/documents/acl/$(request.auth.uid)).data; }\n    function canRead(d) {\n      return signedIn() && exists(/databases/$(db)/documents/acl/$(request.auth.uid)) && (\n        d.owner != '' ? (d.owner == request.auth.uid || acl().ho == true)\n        : d.unit != '' ? (acl().full == true || d.unit in acl().units)\n        : acl().full == true);\n    }\n    match /pub/{k} { allow read: if canRead(resource.data); allow write: if false; }\n    match /pub/{k}/c/{i} { allow read: if canRead(get(/databases/$(db)/documents/pub/$(k)).data); allow write: if false; }\n    match /acl/{e} { allow read: if signedIn() && request.auth.uid == e; allow write: if false; }\n  }\n}\n";

