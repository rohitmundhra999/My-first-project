/**
 * NLP Approvals - backend for the purchase approval app.
 *
 * Put this in its OWN Apps Script project (script.google.com > New project), not inside
 * the sheet's existing project, so its names can never clash with the report scripts.
 *
 * Flow
 *   1. HO in-charge picks an approver for new requisition lines  -> writes FMS column L (APPROVER)
 *      and sends that approver a push notification.
 *   2. The approver (and only that approver) chooses Approved / On Hold / Rejected / Withdrawn
 *      and the quantity -> writes K (APPROVAL), M (APPROVED BY), N (QTY) and J (ACTUAL time).
 *
 * Everyone signs in with Google. Every request carries a Google ID token, which is checked here
 * (right app, verified @summithotels.in email) before anything is read or written.
 *
 * Script properties (Project Settings > Script properties):
 *   GOOGLE_CLIENT_ID          OAuth client ID used by the app's "Sign in with Google" button
 *   APP_URL                   Web address of the app, e.g. https://<user>.github.io/My-first-project/approval-app/
 *   FIREBASE_SERVICE_ACCOUNT  The whole JSON key of the Firebase service account (for push notifications)
 */

// ===== TRIAL or LIVE: the ONLY line to change when going live (see GO-LIVE.md) =====
const MODE = 'TRIAL';   // 'TRIAL' = Copy of NONLOCAL PURCHASES,  'LIVE' = NONLOCAL PURCHASES

const SHEETS = {
  TRIAL: '1FYI-Mj44MXeu-YN4qiQMErPsm9jVE97vePxw3gu-QeY', // Copy of NONLOCAL PURCHASES (testing)
  LIVE:  '11B4bjVVFXyMXoTp8M22ROtMea55Hg0qRlAdzMVuIGJg', // NONLOCAL PURCHASES (real)
};

const CFG = {
  SHEET_ID: SHEETS[MODE],
  FMS: 'FMS',
  USERS: 'APP USERS',
  DEVICES: 'APP DEVICES',
  LOG: 'APP LOG',
  DOMAIN: 'summithotels.in',
  TZ: 'Asia/Kolkata',
  FIRST_ROW: 4,          // first data row in FMS
  START_YEAR: 2026,      // year of the first data row (timestamps have no year)
  LOOKBACK_DAYS: 120,    // only lines requested in the last N days are shown
  EMAIL_FALLBACK: true,  // email the approver if they have no device with notifications on
};

// FMS columns (1-based)
const COL = { ORDER: 1, TS: 2, UNIT: 3, CAT: 4, ITEM: 5, PIC: 6, QTY: 7, UOM: 8,
              ACTUAL: 10, APPROVAL: 11, APPROVER: 12, APPROVED_BY: 13, APPR_QTY: 14 };
const DECISIONS = ['Approved', 'On Hold', 'Rejected', 'Withdrawn'];

// ======================= web entry points =======================

function doGet() {
  return json_({ ok: true, app: 'NLP Approvals', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const user = auth_(req.idToken);
    const handlers = { me: me_, hoList: hoList_, assign: assign_, myList: myList_, decide: decide_, register: register_ };
    const fn = handlers[req.action];
    if (!fn) throw appError_('BAD_REQUEST', 'Unknown action.');
    return json_(Object.assign({ ok: true }, fn(user, req)));
  } catch (err) {
    const code = err && err.appCode ? err.appCode : 'SERVER';
    if (code === 'SERVER') console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: code, error: code === 'SERVER' ? 'Something went wrong: ' + (err && err.message) : err.message });
  }
}

// ======================= actions =======================

function me_(user) {
  return {
    user: { name: user.name, email: user.email, isHO: user.isHO, isApprover: user.isApprover },
    approvers: user.isHO ? activeUsers_().filter(u => u.isApprover).map(u => u.name) : [],
    decisions: DECISIONS,
    mode: MODE,
  };
}

/** HO: lines with no decision yet, split into "needs an approver" and "waiting for approver". */
function hoList_(user) {
  requireHO_(user);
  const lines = readLines_().filter(l => !l.approval);
  return {
    unassigned: lines.filter(l => !l.approver),
    waiting: lines.filter(l => l.approver),
  };
}

/** HO: set the approver (column L) for one or more lines and notify that approver. */
function assign_(user, req) {
  requireHO_(user);
  const approver = activeUsers_().find(u => u.isApprover && same_(u.name, req.approver));
  if (!approver) throw appError_('BAD_REQUEST', 'Pick an approver from the list.');
  const items = cleanItems_(req.items);

  const done = [], skipped = [];
  withLock_(() => {
    const sh = fms_();
    items.forEach(it => {
      const row = sh.getRange(it.row, 1, 1, COL.APPR_QTY).getValues()[0];
      if (String(row[COL.ORDER - 1]).trim() !== it.orderNo) return skipped.push({ orderNo: it.orderNo, why: 'Line moved in the sheet. Refresh and try again.' });
      if (String(row[COL.APPROVAL - 1]).trim()) return skipped.push({ orderNo: it.orderNo, why: 'Already decided (' + row[COL.APPROVAL - 1] + ').' });
      sh.getRange(it.row, COL.APPROVER).setValue(approver.name);
      done.push({ row: it.row, orderNo: it.orderNo, unit: String(row[COL.UNIT - 1]).trim(), item: String(row[COL.ITEM - 1]).trim() });
    });
    if (done.length) log_(user, 'ASSIGN', done.map(d => d.orderNo).join(', '), 'to ' + approver.name);
  });

  let notified = { push: 0, email: false };
  if (done.length) {
    const units = unique_(done.map(d => d.unit));
    const title = done.length === 1 ? 'New purchase line to approve' : done.length + ' purchase lines to approve';
    const body = units.join(', ') + ': ' + done.slice(0, 3).map(d => d.item).join(', ') + (done.length > 3 ? ' and ' + (done.length - 3) + ' more' : '') +
                 '. Assigned by ' + user.name + '.';
    notified = notify_(approver.email, title, body);
  }
  return { assigned: done.length, skipped: skipped, approver: approver.name, notified: notified };
}

/** Approver: lines assigned to me that are undecided or On Hold. */
function myList_(user) {
  requireApprover_(user);
  const mine = readLines_().filter(l => same_(l.approver, user.name));
  return {
    pending: mine.filter(l => !l.approval),
    onHold: mine.filter(l => l.approval === 'On Hold'),
  };
}

/** Approver: decide one or more lines. Only the approver named in column L may do this. */
function decide_(user, req) {
  requireApprover_(user);
  const decision = DECISIONS.find(d => d === req.decision);
  if (!decision) throw appError_('BAD_REQUEST', 'Choose Approved, On Hold, Rejected or Withdrawn.');
  const items = cleanItems_(req.items);

  const done = [], skipped = [];
  withLock_(() => {
    const sh = fms_();
    items.forEach(it => {
      const row = sh.getRange(it.row, 1, 1, COL.APPR_QTY).getValues()[0];
      const current = String(row[COL.APPROVAL - 1]).trim();
      if (String(row[COL.ORDER - 1]).trim() !== it.orderNo) return skipped.push({ orderNo: it.orderNo, why: 'Line moved in the sheet. Refresh and try again.' });
      if (!same_(row[COL.APPROVER - 1], user.name)) return skipped.push({ orderNo: it.orderNo, why: 'This line is assigned to ' + (String(row[COL.APPROVER - 1]).trim() || 'nobody') + ', not you.' });
      if (current && current !== 'On Hold') return skipped.push({ orderNo: it.orderNo, why: 'Already ' + current + '.' });

      let qty = it.qty;
      if (qty === null) qty = Number(row[COL.QTY - 1]) || null;
      if (decision === 'Approved' && !(qty > 0)) return skipped.push({ orderNo: it.orderNo, why: 'Enter a quantity above 0.' });

      sh.getRange(it.row, COL.ACTUAL, 1, 2).setValues([[new Date(), decision]]);             // J, K
      sh.getRange(it.row, COL.APPROVED_BY, 1, 2).setValues([[user.name, qty === null ? '' : qty]]); // M, N
      done.push({ orderNo: it.orderNo, qty: qty });
    });
    if (done.length) log_(user, decision.toUpperCase(), done.map(d => d.orderNo + (d.qty !== null ? ' x' + d.qty : '')).join(', '), '');
  });
  return { decided: done.length, decision: decision, skipped: skipped };
}

/** Save this device's push token for the signed-in user. */
function register_(user, req) {
  const token = String(req.token || '').trim();
  if (!token || token.length > 4096) throw appError_('BAD_REQUEST', 'Missing notification token.');
  withLock_(() => {
    const sh = tab_(CFG.DEVICES, ['Email', 'Token', 'Device', 'Updated']);
    const values = sh.getDataRange().getValues();
    const now = new Date(), device = String(req.device || '').slice(0, 120);
    for (let i = 1; i < values.length; i++) {
      if (values[i][1] === token) { sh.getRange(i + 1, 1, 1, 4).setValues([[user.email, token, device, now]]); return; }
    }
    sh.appendRow([user.email, token, device, now]);
  });
  return { registered: true };
}

// ======================= sign-in check =======================

function auth_(idToken) {
  if (!idToken) throw appError_('AUTH', 'Please sign in.');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw appError_('AUTH', 'Your sign-in has expired. Please sign in again.');
    const t = JSON.parse(res.getContentText());
    if (t.aud !== prop_('GOOGLE_CLIENT_ID')) throw appError_('AUTH', 'Sign-in was not for this app.');
    if (String(t.email_verified) !== 'true') throw appError_('AUTH', 'Your Google email is not verified.');
    email = String(t.email || '').toLowerCase();
    if (t.hd !== CFG.DOMAIN || !email.endsWith('@' + CFG.DOMAIN)) throw appError_('FORBIDDEN', 'Please sign in with your @' + CFG.DOMAIN + ' account.');
    const ttl = Math.floor(Number(t.exp) - Date.now() / 1000 - 60);
    if (ttl > 30) cache.put(key, email, Math.min(ttl, 3000));
  }
  const user = activeUsers_().find(u => u.email === email);
  if (!user) throw appError_('FORBIDDEN', email + ' is not set up in the app yet. Ask HO to add you to the "' + CFG.USERS + '" tab.');
  return user;
}

function requireHO_(u) { if (!u.isHO) throw appError_('FORBIDDEN', 'Only HO in-charge can assign approvers.'); }
function requireApprover_(u) { if (!u.isApprover) throw appError_('FORBIDDEN', 'You are not set up as an approver.'); }

// ======================= sheet helpers =======================

let USERS_CACHE_ = null;
function activeUsers_() {
  if (USERS_CACHE_) return USERS_CACHE_;
  const sh = book_().getSheetByName(CFG.USERS);
  if (!sh) throw appError_('SETUP', 'The "' + CFG.USERS + '" tab is missing. Run setup() once.');
  USERS_CACHE_ = sh.getDataRange().getValues().slice(1)
    .map(r => ({ name: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(), role: String(r[2]).toUpperCase(), active: String(r[3]).trim().toUpperCase() }))
    .filter(u => u.name && u.email && u.active !== 'NO')
    .map(u => ({ name: u.name, email: u.email, isHO: /\bHO\b/.test(u.role), isApprover: /APPROVER/.test(u.role) }));
  return USERS_CACHE_;
}

function readLines_() {
  const sh = fms_();
  const last = sh.getLastRow();
  if (last < CFG.FIRST_ROW) return [];
  const n = last - CFG.FIRST_ROW + 1;
  const values = sh.getRange(CFG.FIRST_ROW, 1, n, COL.APPR_QTY).getValues();
  const stamps = sh.getRange(CFG.FIRST_ROW, COL.TS, n, 1).getDisplayValues();
  const cutoff = Date.now() - CFG.LOOKBACK_DAYS * 86400000;
  const out = [];
  let year = CFG.START_YEAR, prevMonth = 1;
  values.forEach((r, i) => {
    const m = String(stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})(?:\((\d{1,2}):(\d{2})\))?/);
    if (!m) return;
    const mon = +m[2];
    if (prevMonth - mon >= 6) year++;          // a new year started
    prevMonth = mon;
    const orderNo = String(r[COL.ORDER - 1]).trim();
    if (!orderNo) return;
    const date = new Date(year, mon - 1, +m[1], +(m[3] || 0), +(m[4] || 0));
    if (date.getTime() < cutoff) return;
    out.push({
      row: CFG.FIRST_ROW + i, orderNo: orderNo, ts: date.getTime(),
      when: Utilities.formatDate(date, CFG.TZ, 'dd MMM, HH:mm'),
      unit: String(r[COL.UNIT - 1]).trim(), category: String(r[COL.CAT - 1]).trim(), item: String(r[COL.ITEM - 1]).trim(),
      pic: /^https?:\/\//.test(String(r[COL.PIC - 1])) ? String(r[COL.PIC - 1]).trim() : '',
      qty: r[COL.QTY - 1] === '' ? '' : Number(r[COL.QTY - 1]), uom: String(r[COL.UOM - 1]).trim(),
      approval: String(r[COL.APPROVAL - 1]).trim(), approver: String(r[COL.APPROVER - 1]).trim(),
      approvedQty: r[COL.APPR_QTY - 1] === '' ? '' : Number(r[COL.APPR_QTY - 1]),
    });
  });
  return out.reverse(); // newest first
}

function cleanItems_(items) {
  if (!Array.isArray(items) || !items.length) throw appError_('BAD_REQUEST', 'Select at least one line.');
  if (items.length > 200) throw appError_('BAD_REQUEST', 'Too many lines at once (max 200).');
  return items.map(it => {
    const row = Math.floor(Number(it && it.row));
    const orderNo = String(it && it.orderNo || '').trim();
    if (!(row >= CFG.FIRST_ROW) || !orderNo) throw appError_('BAD_REQUEST', 'Bad line reference.');
    let qty = null;
    if (it.qty !== undefined && it.qty !== null && it.qty !== '') {
      qty = Number(it.qty);
      if (!isFinite(qty) || qty < 0 || qty > 1e7) throw appError_('BAD_REQUEST', 'Quantity for ' + orderNo + ' is not a valid number.');
    }
    return { row: row, orderNo: orderNo, qty: qty };
  });
}

function book_() { return SpreadsheetApp.openById(CFG.SHEET_ID); }
function fms_() {
  const sh = book_().getSheetByName(CFG.FMS);
  if (!sh) throw appError_('SETUP', 'Tab FMS not found.');
  return sh;
}
function tab_(name, header) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); sh.getRange(1, 1, 1, header.length).setFontWeight('bold'); }
  return sh;
}
function log_(user, action, lines, note) {
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']).appendRow([new Date(), user.email, user.name, action, lines, note]);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('BUSY', 'The sheet is busy. Please try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ======================= notifications =======================

/** Push to every device the person registered; email them if none worked. */
function notify_(email, title, body) {
  if (MODE !== 'LIVE') title = '[TRIAL] ' + title;
  const appUrl = prop_('APP_URL', '');
  let push = 0;
  try { push = sendPush_(email, title, body, appUrl); } catch (e) { console.error('Push failed: ' + e); }
  let mailed = false;
  if (!push && CFG.EMAIL_FALLBACK) {
    MailApp.sendEmail({ to: email, subject: title, body: body + (appUrl ? '\n\nOpen the app: ' + appUrl : '') });
    mailed = true;
  }
  return { push: push, email: mailed };
}

function sendPush_(email, title, body, appUrl) {
  const raw = prop_('FIREBASE_SERVICE_ACCOUNT', '');
  if (!raw) return 0;
  const sa = JSON.parse(raw);
  const sh = book_().getSheetByName(CFG.DEVICES);
  if (!sh) return 0;
  const rows = sh.getDataRange().getValues();
  const targets = [];
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]).toLowerCase() === email && rows[i][1]) targets.push({ row: i + 1, token: rows[i][1] });
  if (!targets.length) return 0;

  const access = fcmAccessToken_(sa);
  const url = 'https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send';
  const requests = targets.map(t => ({
    url: url, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + access },
    payload: JSON.stringify({ message: {
      token: t.token,
      notification: { title: title, body: body },
      webpush: {
        notification: { icon: appUrl ? appUrl + 'icon-192.png' : undefined, tag: 'nlp-approval', renotify: true },
        fcm_options: appUrl ? { link: appUrl } : undefined,
      },
    } }),
  }));
  const responses = UrlFetchApp.fetchAll(requests);
  let sent = 0;
  const dead = [];
  responses.forEach((res, i) => {
    const code = res.getResponseCode();
    if (code === 200) sent++;
    else if (code === 404 || /UNREGISTERED|registration-token-not-registered/i.test(res.getContentText())) dead.push(targets[i].row);
    else console.error('FCM ' + code + ': ' + res.getContentText());
  });
  dead.sort((a, b) => b - a).forEach(r => sh.deleteRow(r)); // phone uninstalled the app or turned notifications off
  return sent;
}

function fcmAccessToken_(sa) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('fcm_access');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(input, sa.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig },
  });
  if (res.getResponseCode() !== 200) throw new Error('Could not get Firebase access: ' + res.getContentText());
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('fcm_access', token, 3000);
  return token;
}

// ======================= small helpers =======================

function prop_(name, fallback) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw appError_('SETUP', 'Script property ' + name + ' is not set.');
}
function same_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== ''; }
function unique_(arr) { return arr.filter((v, i) => v && arr.indexOf(v) === i); }
function appError_(code, message) { const e = new Error(message); e.appCode = code; return e; }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ======================= run these yourself from the editor =======================

/** Run once. Creates the APP USERS / APP DEVICES / APP LOG tabs in the copy sheet. */
function setup() {
  const ss = book_();
  if (!ss.getSheetByName(CFG.USERS)) {
    const sh = tab_(CFG.USERS, ['Name (exactly as in column L)', 'Email', 'Role (HO / APPROVER / HO+APPROVER)', 'Active (YES / NO)']);
    // Start with the names already allowed in column L (APPROVER).
    const rule = fms_().getRange(CFG.FIRST_ROW, COL.APPROVER).getDataValidation();
    const names = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? rule.getCriteriaValues()[0] : [];
    if (names.length) sh.getRange(2, 1, names.length, 4).setValues(names.map(n => [n, '', 'APPROVER', 'YES']));
    sh.autoResizeColumns(1, 4);
  }
  tab_(CFG.DEVICES, ['Email', 'Token', 'Device', 'Updated']);
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']);
  console.log('Done (' + MODE + ' sheet: ' + ss.getName() + '). Fill in the emails and roles in the "' + CFG.USERS + '" tab.');
}

/** Sends a test notification to yourself (the person running this). */
function testNotification() {
  const me = Session.getActiveUser().getEmail().toLowerCase();
  console.log(JSON.stringify(notify_(me, 'Test from NLP Approvals', 'If you can read this on your phone, notifications work.')));
}

// ============ Notify as soon as a name is picked in FMS column L (in the sheet) ============

/** Run ONCE from the editor. Makes the server watch the FMS sheet for edits. */
function installFmsTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onFmsEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFmsEdit').forSpreadsheet(CFG.SHEET_ID).onEdit().create();
  console.log('Now watching column L of: ' + book_().getName());
}

/** Runs by itself whenever someone picks or types a name in FMS column L. */
function onFmsEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== CFG.FMS) return;
  const firstCol = r.getColumn(), lastCol = firstCol + r.getNumColumns() - 1;
  if (COL.APPROVER < firstCol || COL.APPROVER > lastCol) return;
  const top = Math.max(r.getRow(), CFG.FIRST_ROW);
  const bottom = r.getRow() + r.getNumRows() - 1;
  if (bottom < top) return;

  const rows = r.getSheet().getRange(top, 1, bottom - top + 1, COL.APPR_QTY).getValues();
  const byApprover = {};
  rows.forEach(row => {
    const name = String(row[COL.APPROVER - 1]).trim();
    if (!name || String(row[COL.APPROVAL - 1]).trim()) return; // cleared, or already decided
    (byApprover[name] = byApprover[name] || []).push({
      orderNo: String(row[COL.ORDER - 1]).trim(),
      unit: String(row[COL.UNIT - 1]).trim(),
      item: String(row[COL.ITEM - 1]).trim(),
    });
  });

  let editor = '';
  try { editor = String(e.user && e.user.getEmail ? e.user.getEmail() : '').toLowerCase(); } catch (err) {}
  const users = activeUsers_();
  Object.keys(byApprover).forEach(name => {
    const approver = users.find(u => u.isApprover && same_(u.name, name));
    const lines = byApprover[name];
    if (!approver) { console.warn('No active approver named "' + name + '" in APP USERS'); return; }
    const title = lines.length === 1 ? 'New purchase line to approve' : lines.length + ' purchase lines to approve';
    const body = unique_(lines.map(l => l.unit)).join(', ') + ': ' +
      lines.slice(0, 3).map(l => l.item).join(', ') +
      (lines.length > 3 ? ' and ' + (lines.length - 3) + ' more' : '') + '. Assigned in the sheet.';
    const sent = notify_(approver.email, title, body);
    tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']).appendRow([
      new Date(), editor, '(sheet)', 'ASSIGN', lines.map(l => l.orderNo).join(', '),
      'to ' + approver.name + ' | push ' + sent.push + (sent.email ? ' | emailed' : '')]);
  });
}
