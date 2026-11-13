/**
 * Summit Procurement - backend for the purchase approval app.
 *
 * Put this in its OWN Apps Script project (script.google.com > New project), not inside
 * the sheet's existing project, so its names can never clash with the report scripts.
 *
 * Flow
 *   1. HO in-charge picks an approver for new requisition lines  -> writes FMS column L (APPROVER)
 *      and sends that approver a push notification.
 *   2. The approver (and only that approver) chooses Approved / On Hold / Rejected / Withdrawn
 *      and the quantity -> writes K (APPROVAL), M (APPROVED BY), N (QTY) and J (ACTUAL time).
 *   3. Storekeepers (role STOREKEEPER, unit(s) in APP USERS column E) work only on their own unit:
 *      raise a request (-> new FORMDATA row, which FMS picks up by itself), mark material received
 *      (-> FMS AB RECEIVED) and upload the vendor invoice (-> Drive file + INVOICES row).
 *      Every storekeeper action is checked here against the unit of the line, so nobody can change
 *      another unit's data. The admin can act for every unit (trial).
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
  REMARKS: 'REJECTION REMARKS',   // reason given by the approver for every rejected line (kept out of FMS)
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
const REMARK_MAX_WORDS = 10;
const REMARK_HEADER = ['Time', 'Order No', 'FMS Row', 'Unit', 'Item', 'Remark', 'Rejected By', 'Email'];

// ======================= web entry points =======================

function doGet() {
  return json_({ ok: true, app: 'Summit Procurement', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const realUser = auth_(req.idToken);
    const handlers = { me: me_, hoList: hoList_, assign: assign_, myList: myList_, decide: decide_, register: register_,
      reports: (u, r) => scopeReports_(u, reports_(u, r)), decisions: (u, r) => scopeReports_(u, decisions_(u, r)), testPush: testPush_,
      storeMeta: storeMeta_, storeList: storeList_, storeRaise: storeRaise_, storeReceive: storeReceive_, storeInvoice: storeInvoice_,
      sync: sync_, makePO: makePO_, readInvoice: readInvoice_, hoReceiveList: hoReceiveList_, rateList: rateList_, rateCompare: rateCompare_ };
    const fn = handlers[req.action];
    if (!fn) throw appError_('BAD_REQUEST', 'Unknown action.');
    const user = previewUser_(realUser, req);
    // A save sent twice (the app tries again when Google drops a request) is done only once: the answer is kept
    // under its requestId for 6 hours and simply given again.
    const rid = WRITE_ACTIONS.indexOf(req.action) !== -1 && /^[\w-]{8,64}$/.test(String(req.requestId || '')) ? 'rq_' + req.requestId : '';
    if (rid) {
      const c = CacheService.getScriptCache();
      for (let i = 0; i < 25; i++) {   // the first try may still be running: wait for its answer (max ~25 s)
        const prev = c.get(rid);
        if (!prev) break;
        if (prev !== 'running') return ContentService.createTextOutput(prev).setMimeType(ContentService.MimeType.JSON);
        if (i === 24) throw appError_('BUSY', 'Still saving your earlier tap. Please check in a minute before trying again.');
        Utilities.sleep(1000);
      }
      c.put(rid, 'running', 300);
      let text;
      try { text = JSON.stringify(Object.assign({ ok: true }, fn(user, req, realUser))); }
      catch (e) { c.remove(rid); throw e; }
      c.put(rid, text.length < 90000 ? text : JSON.stringify({ ok: true, again: true }), 21600);
      return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
    }
    return json_(Object.assign({ ok: true }, fn(user, req, realUser)));
  } catch (err) {
    const code = err && err.appCode ? err.appCode : 'SERVER';
    if (code === 'SERVER') console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: code, error: code === 'SERVER' ? 'Something went wrong: ' + (err && err.message) : err.message });
  }
}

// ======================= actions =======================

function me_(user, req, realUser) {
  const admin = isAdmin_(realUser);
  return {
    user: { name: user.name, email: user.email, isHO: user.isHO, isApprover: user.isApprover, isStore: user.isStore, units: user.units },
    storeUnits: storeUnits_(user),
    storeAll: !user.previewBy && isAdmin_(user),   // trial: the admin can work for every unit
    approvers: user.isHO ? activeUsers_().filter(u => u.isApprover).map(u => u.name) : [],
    decisions: DECISIONS,
    mode: MODE,
    // Admin only: everyone in APP USERS, so the admin can preview the app as them.
    admin: admin ? { name: realUser.name, email: realUser.email } : null,
    users: admin ? activeUsers_().map(u => ({ name: u.name, email: u.email, isHO: u.isHO, isApprover: u.isApprover, isStore: u.isStore, units: u.units })) : [],
    preview: user.previewBy ? true : false,
    actAs: user.previewBy && MODE === 'TRIAL' ? true : false,   // trial: the admin can act as this person
  };
}

// ======================= sync: everything a screen needs in ONE request =======================
// Every request to Apps Script costs ~1-2 seconds just to start, and only a limited number can run at the same
// time for everybody together. So the app asks for all it needs in one "sync" call, and gets back only what changed:
//   want.me      -> who am I (first open)
//   want.ho      -> HO lists           want.mine  -> approver lists
//   want.reports -> { v }  (v = version the app already has: "same" comes back when nothing changed)
//   want.dec     -> { v }  approval report
//   want.store   -> { unit, v }        want.meta -> unit (lists for the request form)
// Big lists are sent "packed" (field names once, then rows of values), which roughly halves the download.
// A part that fails comes back as { error } without spoiling the other parts.
function sync_(user, req, realUser) {
  const w = req.want || {}, fresh = !!req.fresh, out = {};
  const part = (k, fn) => {
    try { out[k] = fn(); } catch (e) {
      if (!e.appCode) console.error(e && e.stack ? e.stack : e);
      out[k] = { error: e.appCode ? e.message : 'Something went wrong: ' + (e && e.message), code: e.appCode || 'SERVER' };
    }
  };
  if (w.me) part('me', () => me_(user, req, realUser));
  if (w.ho && user.isHO) part('ho', () => hoList_(user, { fresh: fresh }));
  if (w.mine && user.isApprover) part('mine', () => myList_(user, { fresh: fresh }));
  if (w.reports) part('reports', () => scopeReports_(user, reports_(user, { fresh: fresh, v: w.reports.v })));
  if (w.dec) part('dec', () => {
    // after a fresh reports read in this same request the decisions are already rebuilt: just pick them up
    const r = scopeReports_(user, decisions_(user, { fresh: fresh && !w.reports, v: fresh ? '' : w.dec.v }));
    if (r.decisions) r.decisions = Object.assign({}, r.decisions, { lines: pack_(r.decisions.lines) });
    return r;
  });
  if (w.store && w.store.unit) part('store', () => {
    const r = storeList_(user, { unit: w.store.unit, fresh: fresh, v: fresh ? '' : w.store.v });
    if (r.lines) r.lines = pack_(r.lines);
    return r;
  });
  // several units at once (admin / storekeeper with more than one unit): the app keeps them all, so switching unit is instant
  if (Array.isArray(w.stores) && w.stores.length) part('stores', () => {
    const res = {};
    w.stores.slice(0, 60).forEach(x => {
      try {
        const r = storeList_(user, { unit: x.unit, fresh: fresh, v: fresh ? '' : x.v });
        if (r.lines) r.lines = pack_(r.lines);
        res[x.unit] = r;
      } catch (e) { res[x.unit] = { error: e.message, code: e.appCode || 'SERVER' }; }
    });
    return res;
  });
  if (w.po && user.isHO) part('po', () => poPending_(w.po.v));
  if (w.vendors && user.isHO) part('vendors', () => vendors_());
  if (w.base) part('base', () => { const m = storeMetaData_(); return { categories: m.categories, uoms: m.uoms }; });
  if (w.meta) part('meta', () => storeMeta_(user, { unit: w.meta }));
  return out;
}

/** Short fingerprint of the content: the same data always gives the same version, so the app downloads only real changes. */
function ver_(obj) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(obj))).slice(0, 16);
}

/** [{a:1,b:2},{a:3}] -> { k:['a','b'], r:[[1,2],[3,null]] } */
function pack_(list) {
  const keys = [], at = {};
  list.forEach(o => Object.keys(o).forEach(k => { if (!(k in at)) { at[k] = keys.length; keys.push(k); } }));
  return { k: keys, r: list.map(o => keys.map(k => (o[k] === undefined ? null : o[k]))) };
}

// ======================= admin preview ("view as") =======================
// The admin (the script owner, or anyone with ADMIN in their APP USERS role) can see the app exactly as
// another user sees it. Preview is READ-ONLY: nothing can be assigned, decided or registered while
// previewing, so the sheet and the APP LOG always show the real person who acted.

const WRITE_ACTIONS = ['assign', 'decide', 'register', 'storeRaise', 'storeReceive', 'storeInvoice', 'makePO'];

function isAdmin_(u) {
  if (u.isAdmin) return true;
  let owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  return !!owner && u.email === owner;
}

function previewUser_(realUser, req) {
  const email = String(req.viewAs || '').trim().toLowerCase();
  if (!email || email === realUser.email) return realUser;
  if (!isAdmin_(realUser)) throw appError_('FORBIDDEN', 'Only the admin can preview the app as someone else.');
  // TRIAL: the admin may also ACT as that person (assign, approve, raise, receive, make PO...) to test the whole flow.
  // Everything is written exactly as that person would write it; the APP LOG also records the admin who did it.
  // LIVE: view only. Registering a phone for notifications always stays with the real person.
  if (req.action === 'register' || (MODE !== 'TRIAL' && WRITE_ACTIONS.indexOf(req.action) !== -1)) {
    throw appError_('PREVIEW', 'This is a preview, so nothing can be changed. Switch back to yourself to make changes.');
  }
  const target = activeUsers_().find(u => u.email === email);
  if (!target) throw appError_('BAD_REQUEST', email + ' is not an active user in ' + CFG.USERS + '.');
  return Object.assign({}, target, { previewBy: realUser.email });
}

/** HO: lines with no decision yet, split into "needs an approver" and "waiting for approver". */
function hoList_(user, req) {
  requireHO_(user);
  const lines = openLines_(req && req.fresh).filter(l => !l.approval);
  return {
    unassigned: lines.filter(l => !l.approver),
    waiting: lines.filter(l => l.approver),
    cache: CACHE_INFO_,
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
  patchOpenLines_(done.map(d => d.row), l => { l.approver = approver.name; return l; });
  try { done.forEach(d => patchStore_(d.unit, ls => ls.forEach(l => { if (l.row === d.row) l.ap = approver.name; }))); } catch (e) { console.warn(e); }

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
function myList_(user, req) {
  requireApprover_(user);
  const mine = openLines_(req && req.fresh).filter(l => same_(l.approver, user.name));
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
  let remark = String(req.remark || '').replace(/\s+/g, ' ').trim();
  if (decision === 'Rejected') {
    if (!remark) throw appError_('BAD_REQUEST', 'Give the reason for rejection.');
    if (remark.split(' ').length > REMARK_MAX_WORDS) throw appError_('BAD_REQUEST', 'Keep the reason to ' + REMARK_MAX_WORDS + ' words or fewer.');
    if (remark.length > 150) throw appError_('BAD_REQUEST', 'The reason is too long.');
  } else remark = '';

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
      done.push({ row: it.row, orderNo: it.orderNo, qty: qty, r: row });
    });
    if (done.length) log_(user, decision.toUpperCase(), done.map(d => d.orderNo + (d.qty !== null ? ' x' + d.qty : '')).join(', '), remark);
    if (done.length && remark) {
      const now = new Date();
      const rs = tab_(CFG.REMARKS, REMARK_HEADER);
      rs.getRange(rs.getLastRow() + 1, 1, done.length, REMARK_HEADER.length).setValues(done.map(d =>
        [now, d.orderNo, d.row, String(d.r[COL.UNIT - 1]).trim(), String(d.r[COL.ITEM - 1]).trim(), remark, user.name, user.email]));
    }
  });
  try { patchDecisions_(done, decision, user, remark); } catch (e) { console.warn('Decision report patch failed: ' + e); }
  try { patchAfterDecide_(done, decision, user, remark); } catch (e) { console.warn('Quick update failed: ' + e); scheduleRefresh_(); }
  const qtyByRow = {};
  done.forEach(d => (qtyByRow[d.row] = d.qty));
  patchOpenLines_(done.map(d => d.row), l => {
    if (decision !== 'On Hold') return null;   // decided lines leave the open list
    l.approval = 'On Hold'; l.approvedQty = qtyByRow[l.row] === null ? '' : qtyByRow[l.row]; return l;
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


/** Sends a test notification to every device of the signed-in person (button in the app). */
function testPush_(user, req, realUser) {
  const u = realUser || user;
  const sh = book_().getSheetByName(CFG.DEVICES);
  const devices = sh ? sh.getDataRange().getValues().slice(1).filter(r => String(r[0]).toLowerCase() === u.email && r[1]).length : 0;
  const res = notify_(u.email, 'Test notification', 'Hi ' + u.name + ', notifications are working on this device.', true);
  return { devices: devices, notified: res };
}

/** Runs from warmCache (every 5 minutes): tells HO and the admin about requisition lines that arrived since the last check. */
function alertNewLines_(lines) {
  const props = PropertiesService.getScriptProperties();
  const KEY = 'NEW_LINES_SEEN_' + MODE;
  const open = (lines || []).filter(l => !l.approval && !l.approver);
  const maxTs = open.reduce((a, l) => Math.max(a, l.ts), 0);
  let seen = null;
  try { seen = JSON.parse(props.getProperty(KEY) || 'null'); } catch (e) { seen = null; }
  const atMax = open.filter(l => l.ts === maxTs).map(l => l.orderNo);
  if (!seen || !seen.ts) { props.setProperty(KEY, JSON.stringify({ ts: maxTs, ids: atMax })); return; } // first run: just remember
  const added = open.filter(l => l.ts > seen.ts || (l.ts === seen.ts && seen.ids.indexOf(l.orderNo) === -1));
  if (maxTs > seen.ts) props.setProperty(KEY, JSON.stringify({ ts: maxTs, ids: atMax }));
  else if (added.length) props.setProperty(KEY, JSON.stringify({ ts: seen.ts, ids: unique_(seen.ids.concat(added.map(l => l.orderNo))) }));
  if (!added.length) return;
  let owner = '';
  try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  const to = unique_(activeUsers_().filter(u => u.isHO || u.isAdmin || u.email === owner).map(u => u.email));
  const title = added.length === 1 ? 'New purchase requirement' : added.length + ' new purchase requirements';
  const body = unique_(added.map(l => l.unit)).join(', ') + ': ' + added.slice(0, 3).map(l => l.item).join(', ') +
    (added.length > 3 ? ' and ' + (added.length - 3) + ' more' : '') + '. Choose an approver.';
  const pushed = to.map(email => email + ' ' + notify_(email, title, body, true).push);
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']).appendRow([
    new Date(), '', '(server)', 'NEW LINES', added.map(l => l.orderNo).join(', '), 'push: ' + pushed.join(', ')]);
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
const USERS_KEY = 'app_users_' + MODE;
/** APP USERS, kept 5 minutes in the cache so a request does not have to open the spreadsheet just to check who you are.
 * warmCache re-reads it every 5 minutes, so a change in APP USERS shows within 5 minutes. */
function activeUsers_(fresh) {
  if (USERS_CACHE_ && !fresh) return USERS_CACHE_;
  if (!fresh) {
    const c = CacheService.getScriptCache().get(USERS_KEY);
    if (c) { try { USERS_CACHE_ = JSON.parse(c); return USERS_CACHE_; } catch (e) { /* re-read */ } }
  }
  const sh = book_().getSheetByName(CFG.USERS);
  if (!sh) throw appError_('SETUP', 'The "' + CFG.USERS + '" tab is missing. Run setup() once.');
  USERS_CACHE_ = sh.getDataRange().getValues().slice(1)
    .map(r => ({ name: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(), role: String(r[2]).toUpperCase(), active: String(r[3]).trim().toUpperCase(),
                 units: String(r[4] === undefined ? '' : r[4]).split(/[,;\n]/).map(x => x.trim()).filter(Boolean) }))
    .filter(u => u.name && u.email && u.active !== 'NO')
    .map(u => ({ name: u.name, email: u.email, isHO: /\bHO\b/.test(u.role), isApprover: /APPROVER/.test(u.role), isAdmin: /ADMIN/.test(u.role),
                 isStore: /STORE/.test(u.role) && u.units.length > 0, units: /STORE/.test(u.role) ? u.units : [] }));
  try { CacheService.getScriptCache().put(USERS_KEY, JSON.stringify(USERS_CACHE_), 600); } catch (e) { /* too big: read each time */ }
  return USERS_CACHE_;
}

/** The FMS tab read ONCE per run (A-AG values + the few display columns), shared by the open lines, the reports
 * and the store lines. Reading FMS is the slow part, so warmCache now reads it once instead of three times. */
let FMS_SNAP_ = null;
function fmsSnap_() {
  if (FMS_SNAP_) return FMS_SNAP_;
  const sh = fms_();
  const n = Math.max(0, sh.getLastRow() - CFG.FIRST_ROW + 1);
  FMS_SNAP_ = n ? {
    n: n,
    rows: sh.getRange(CFG.FIRST_ROW, 1, n, 33).getValues(),
    stamps: sh.getRange(CFG.FIRST_ROW, COL.TS, n, 1).getDisplayValues(),
    acted: sh.getRange(CFG.FIRST_ROW, COL.ACTUAL, n, 1).getDisplayValues(),
    inv: sh.getRange(CFG.FIRST_ROW, 29, n, 1).getDisplayValues(),
  } : { n: 0, rows: [], stamps: [], acted: [], inv: [] };
  return FMS_SNAP_;
}

function readLines_(keep) {
  // Only the recent end of FMS matters (LOOKBACK_DAYS): the last FMS_MAX_ROWS rows that have an order number.
  const snap = fmsSnap_();
  let lastData = snap.n;
  while (lastData > 0 && String(snap.rows[lastData - 1][COL.ORDER - 1]).trim() === '') lastData--;
  if (!lastData) return [];
  const startIdx = Math.max(0, lastData - FMS_MAX_ROWS);
  const values = snap.rows.slice(startIdx, lastData);
  const stamps = snap.stamps.slice(startIdx, lastData);
  const cutoff = Date.now() - CFG.LOOKBACK_DAYS * 86400000;
  const now = new Date(Date.now() + 330 * 60000), nowYear = now.getUTCFullYear(), nowMonth = now.getUTCMonth() + 1;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = v => (v < 10 ? '0' : '') + v;
  let stock = null;
  const out = [];
  values.forEach((r, j) => {
    const i = startIdx + j;
    const m = String(stamps[j][0]).match(/^(\d{1,2})-(\d{1,2})(?:\((\d{1,2}):(\d{2})\))?/);
    if (!m) return;
    const mon = +m[2];
    const year = mon > nowMonth ? nowYear - 1 : nowYear;   // timestamps have no year; anything "later" than now is last year
    const orderNo = String(r[COL.ORDER - 1]).trim();
    if (!orderNo) return;
    const day = +m[1], hh = +(m[3] || 0), mm = +(m[4] || 0);
    const date = new Date(Date.UTC(year, mon - 1, day, hh, mm) - 330 * 60000);
    if (date.getTime() < cutoff) return;
    if (keep && !keep(r)) return;
    if (!stock) stock = stockIndex_();
    out.push({
      row: CFG.FIRST_ROW + i, orderNo: orderNo, ts: date.getTime(),
      when: pad(day) + ' ' + MON[mon - 1] + ', ' + pad(hh) + ':' + pad(mm),
      unit: String(r[COL.UNIT - 1]).trim(), category: String(r[COL.CAT - 1]).trim(), item: String(r[COL.ITEM - 1]).trim(),
      pic: /^https?:\/\//.test(String(r[COL.PIC - 1])) ? String(r[COL.PIC - 1]).trim() : '',
      qty: r[COL.QTY - 1] === '' ? '' : Number(r[COL.QTY - 1]), uom: String(r[COL.UOM - 1]).trim(),
      approval: String(r[COL.APPROVAL - 1]).trim(), approver: String(r[COL.APPROVER - 1]).trim(),
      approvedQty: r[COL.APPR_QTY - 1] === '' ? '' : Number(r[COL.APPR_QTY - 1]),
      stock: findStock_(stock, r, orderNo, +m[1], mon, +(m[3] || 0), +(m[4] || 0)),
    });
  });
  return out.reverse(); // newest first
}

// ---- Stock in hand: the storekeeper enters it in the request form, which lands in FORMDATA.
// FORMDATA has no order number, so a line is matched on unit + item + quantity + date, picking the entry
// whose time is closest (within a few minutes) to the time in the order number (e.g. SAME-2310-1258-66).
const FORMDATA = { TAB: 'FORMDATA', TS: 1, UNIT: 2, ITEM: 4, QTY: 6, STOCK: 8, STOCK_UOM: 9, MAX_ROWS: 6000, MAX_MINUTES: 5 };
const FMS_MAX_ROWS = 4000;   // last N filled FMS rows are enough to cover LOOKBACK_DAYS
const stockKey_ = (unit, item, qty, day, mon) =>
  [String(unit).toLowerCase().replace(/[^a-z0-9]/g, ''), String(item).toLowerCase().replace(/[^a-z0-9]/g, ''), Number(qty) || 0, day + '-' + mon].join('|');

function stockIndex_() {
  const index = {};
  const sh = book_().getSheetByName(FORMDATA.TAB);
  if (!sh) return index;
  const last = sh.getLastRow();
  if (last < 2) return index;
  const first = Math.max(2, last - FORMDATA.MAX_ROWS + 1);
  const rows = sh.getRange(first, 1, last - first + 1, FORMDATA.STOCK_UOM).getValues();
  const cutoff = Date.now() - (CFG.LOOKBACK_DAYS + 10) * 86400000;
  const IST = 330 * 60000;   // India time, worked out by hand: Utilities.formatDate on every row is far too slow
  for (let i = rows.length - 1; i >= 0; i--) {   // newest first, stop at the first row older than the cutoff
    const r = rows[i];
    let p, t = r[FORMDATA.TS - 1];
    if (t instanceof Date) {
      if (t.getTime() < cutoff) break;
      const d = new Date(t.getTime() + IST);
      p = [d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCHours(), d.getUTCMinutes()];
    } else {
      const m = String(t).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
      if (!m) continue;
      if (Date.UTC(+m[3], +m[2] - 1, +m[1]) - IST < cutoff) break;
      p = [+m[1], +m[2], +m[4], +m[5]];
    }
    const key = stockKey_(r[FORMDATA.UNIT - 1], r[FORMDATA.ITEM - 1], r[FORMDATA.QTY - 1], p[0], p[1]);
    (index[key] = index[key] || []).push({
      minute: p[2] * 60 + p[3],
      stock: String(r[FORMDATA.STOCK - 1]).trim(),
      uom: String(r[FORMDATA.STOCK_UOM - 1]).trim(),
    });
  }
  return index;
}

function findStock_(index, r, orderNo, day, mon, hh, mm) {
  // Time from the order number (DDMM-HHMM) is the form's own time; fall back to the FMS timestamp.
  const o = String(orderNo).match(/-(\d{2})(\d{2})-(\d{2})(\d{2})-/);
  if (o) { day = +o[1]; mon = +o[2]; hh = +o[3]; mm = +o[4]; }
  const list = index[stockKey_(r[COL.UNIT - 1], r[COL.ITEM - 1], r[COL.QTY - 1], day, mon)];
  if (!list) return null;
  const want = hh * 60 + mm;
  let best = null;
  list.forEach(c => { const d = Math.abs(c.minute - want); if (d <= FORMDATA.MAX_MINUTES && (!best || d < best.d)) best = { d: d, c: c }; });
  return best ? { qty: best.c.stock, uom: best.c.uom } : null;
}

// ---- Open lines cache: reading FMS + FORMDATA takes ~10 seconds, so the open lines (no decision yet, or
// On Hold) are kept ready in the script cache. A timer rebuilds them every 5 minutes (installTriggers),
// and the app's own assign/decide actions update the copy straight away. The app's â» button forces a re-read.
const OPEN_CACHE = 'open_lines_' + MODE;
const OPEN_CACHE_SECONDS = 21600;   // 6 h: kept current by warmCache / bgRefresh, never rebuilt while someone waits

const CACHE_INFO_ = {};
function openLines_(fresh) {
  if (!fresh) { const hit = cacheGetBig_(OPEN_CACHE); CACHE_INFO_.hit = !!hit; if (hit) return hit; }
  const lines = readLines_(r => { const a = String(r[COL.APPROVAL - 1]).trim(); return a === '' || a === 'On Hold'; });
  cachePutBig_(OPEN_CACHE, lines, OPEN_CACHE_SECONDS);
  return lines;
}

/** fn(line) returns the changed line, or null to drop it. Only touches an existing cached copy. */
function patchOpenLines_(rows, fn) {
  if (!rows.length) return;
  const lines = cacheGetBig_(OPEN_CACHE);
  if (!lines) return;
  const want = {};
  rows.forEach(r => (want[r] = true));
  const out = [];
  lines.forEach(l => { if (!want[l.row]) return out.push(l); const v = fn(l); if (v) out.push(v); });
  cachePutBig_(OPEN_CACHE, out, OPEN_CACHE_SECONDS);
}

function cachePutBig_(key, obj, ttl) {
  const s = JSON.stringify(obj), size = 30000,   // â¤ 3 bytes per character keeps each piece under the 100 KB limit
    n = Math.max(1, Math.ceil(s.length / size));
  const map = {};
  for (let i = 0; i < n; i++) map[key + '_' + i] = s.substr(i * size, size);
  map[key] = String(n);
  try { CacheService.getScriptCache().putAll(map, ttl); CACHE_INFO_.put = 'ok ' + n + ' pieces'; }
  catch (e) { CACHE_INFO_.put = 'failed: ' + e.message; console.warn('Cache put failed: ' + e); }
}

function cacheGetBig_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = c.getAll(keys);
  let s = '';
  for (let i = 0; i < n; i++) { if (got[keys[i]] == null) return null; s += got[keys[i]]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** Runs every 5 minutes (see installTriggers) so the app always opens quickly. */
function warmCache() {
  activeUsers_(true);
  const lines = openLines_(true);
  try { alertNewLines_(lines); } catch (e) { console.error('New-line alert failed: ' + e); }
  reports_(null, { fresh: true });
  try { storeLines_(); } catch (e) { console.error('Store cache failed: ' + e); }
  try { poPendingBuild_(); } catch (e) { console.error('PO list failed: ' + e); }
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
  if (user.previewBy) note = (note ? note + ' | ' : '') + 'done by ' + user.previewBy + ' acting as this user (trial)';
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']).appendRow([new Date(), user.email, user.name, action, lines, note]);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('BUSY', 'The sheet is busy. Please try again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ======================= notifications =======================

/** Push to every device the person registered; email them if none worked. */
function notify_(email, title, body, noEmail) {
  if (MODE !== 'LIVE') title = '[TRIAL] ' + title;
  const appUrl = prop_('APP_URL', '');
  let push = 0;
  try { push = sendPush_(email, title, body, appUrl); } catch (e) { console.error('Push failed: ' + e); }
  let mailed = false;
  if (!push && CFG.EMAIL_FALLBACK && !noEmail) {
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
        headers: { Urgency: 'high', TTL: '86400' }, // deliver at once even when the phone is asleep
        notification: { icon: appUrl ? appUrl + 'icon-192.png' : undefined, tag: 'nlp-approval', renotify: true, requireInteraction: true, vibrate: [200, 100, 200] },
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

// ======================= live reports (Material Not Received / Invoice Pending) =======================
// Same rules as the daily emailed reports (sheet-scripts/material not recd.gs and invoice pending.gs):
//   - from 1 April 2026, APPROVAL = Approved, TYPE (col V) = PO
//   - same PO number counted once; a PO is left out if its vendor is Central Store
//   - Material not received: RECEIVED (AB) empty and AD empty
//   - Invoice pending:      RECEIVED (AB) filled and INVOICE (AC) = UPDATE
// Everyone in APP USERS can see the reports. Filters are applied in the app.

const REPORT_FROM = { y: 2026, m: 4, d: 1 };   // 1 April 2026
const REPORT_CACHE_SECONDS = 21600;            // kept ready by warmCache every 5 minutes; â» in the app re-reads

// Cluster, unit name shown in reports, and words used to recognise the unit in FMS (same as the emails)
const UNIT_MAP = [
  ['Arunachal Pradesh', 'DIRANG', ['dirang']],
  ['Assam', 'Green', ['green']],
  ['Darjeeling', 'Bougainvillea', ['bougainvillea']],
  ['Darjeeling', 'Enigma', ['enigma']],
  ['Darjeeling', 'Grace', ['grace']],
  ['Darjeeling', 'Hermon', ['hermon']],
  ['Darjeeling', 'Mall Stone', ['mallstone', 'mall']],
  ['Darjeeling', 'Montana', ['montana']],
  ['Darjeeling', 'Oakdene', ['oakden']],
  ['Darjeeling', 'POSHTEL', ['poshtel']],
  ['Darjeeling', 'Swiss', ['swiss']],
  ['Darjeeling', 'West Gate', ['westgate', 'west']],
  ['Gangtok', 'Grand', ['grand']],
  ['Gangtok', 'Namnang', ['namnang']],
  ['Gangtok', 'Norling', ['norling']],
  ['Gangtok', 'North Star', ['northstar']],
  ['Gangtok', 'Signature', ['signature']],
  ['Gangtok', 'Ttakshang', ['ttakshang']],
  ['Goa', 'Calangute', ['calangute']],
  ['HP', 'Le Royale', ['royale']],
  ['Kalimpong', 'Barsana', ['barsana']],
  ['Kalimpong', 'Samthar', ['samthar']],
  ['Kalimpong', 'Sherpa', ['sherpa']],
  ['North Sikkim', 'Gangchen', ['gangchen']],
  ['North Sikkim', 'Khangri', ['khangri']],
  ['North Sikkim', 'Panghen', ['panghen']],
  ['Pelling', 'Newa', ['newa']],
  ['Pelling', 'Tashi Ghang', ['tashi']],
  ['Siliguri', 'Head Office', ['headoffice', 'head']],
  ['Siliguri', 'Singalila', ['singalila']],
  ['UK', 'Ganges', ['ganges']],
  ['UK', 'Jungle', ['jungle']],
  ['Rajasthan', 'SALASAR', ['salasar']],
];

function reports_(user, req) {
  const cache = CacheService.getScriptCache();
  const hit = req && req.fresh ? null : cacheGetBig_('reports_' + MODE);
  if (hit) return hit.v && req && req.v === hit.v ? { same: true, asOf: hit.asOf } : { reports: hit };

  const snap = fmsSnap_();
  const n = snap.n, rows = snap.rows, stamps = snap.stamps;
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  const decided = [];
  const remarks = remarksIndex_();
  const acted = snap.acted;
  const nr = { pos: {}, order: [], excluded: {} };
  const ip = { pos: {}, order: [], excluded: {} };
  let year = CFG.START_YEAR, prevMonth = 1;

  rows.forEach((r, i) => {
    const m = String(stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;   // a new year started
    prevMonth = mon;
    if (year * 10000 + mon * 100 + day < fromKey) return;

    const status = DECISIONS.find(d => d.toLowerCase() === String(r[10]).trim().toLowerCase());
    if (status && !(status === 'Approved' && String(r[19]).trim())) {   // Approved lines only while their PO is not raised (T empty)
      const orderNo = String(r[COL.ORDER - 1]).trim();
      const u = norm(r[2]);
      const mapped = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1));
      decided.push({
        o: orderNo, d: year + '-' + pad(mon) + '-' + pad(day), at: String(acted[i][0]).trim(),
        u: mapped ? mapped[1] : String(r[2]).trim(), c: mapped ? mapped[0] : 'Other',
        it: String(r[COL.ITEM - 1]).trim(), q: r[COL.QTY - 1] === '' ? '' : r[COL.QTY - 1], uom: String(r[COL.UOM - 1]).trim(),
        aq: r[COL.APPR_QTY - 1] === '' ? '' : r[COL.APPR_QTY - 1], s: status,
        by: String(r[COL.APPROVED_BY - 1]).trim() || String(r[COL.APPROVER - 1]).trim(),
        rm: status === 'Rejected' ? (remarks[orderNo] || '') : '', row: CFG.FIRST_ROW + i,
      });
    }

    if (String(r[10]).trim().toLowerCase() !== 'approved') return;                 // K: APPROVAL
    if (String(r[21]).replace(/[\s.]/g, '').toUpperCase() !== 'PO') return;        // V: PO type
    const received = String(r[27]).trim() !== '';                                  // AB
    const isNR = !received && String(r[29]).trim() === '';                         // AD empty
    const isIP = received && String(r[28]).trim().toUpperCase() === 'UPDATE';      // AC = UPDATE
    if (!isNR && !isIP) return;

    const key = String(r[19]).trim().toUpperCase();                                // T: PO number
    if (!key) return;
    const target = isNR ? nr : ip;
    if (String(r[32]).toLowerCase().replace(/[^a-z]/g, '').indexOf('centralstore') !== -1) { target.excluded[key] = true; return; }

    let po = target.pos[key];
    if (!po) {
      const u = norm(r[2]);
      const mapped = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1));
      po = target.pos[key] = {
        po: String(r[19]).trim(),
        unitRaw: String(r[2]).trim(),
        unit: mapped ? mapped[1] : String(r[2]).trim(),
        cluster: mapped ? mapped[0] : 'Other',
        vendor: String(r[32]).trim(),
        amount: Number(String(r[20]).replace(/[^0-9.]/g, '')) || 0,
        date: year + '-' + pad(mon) + '-' + pad(day),
        items: 0,
        itemNames: [],
      };
      target.order.push(key);
    }
    po.items++;
    const item = String(r[COL.ITEM - 1]).trim();
    if (item && po.itemNames.length < 8) po.itemNames.push(item);
  });

  const list = t => t.order.filter(k => !t.excluded[k]).map(k => t.pos[k]);
  const out = {
    notReceived: list(nr),
    invoicePending: list(ip),
    unitMap: UNIT_MAP.map(x => [x[0], x[1]]),
    from: REPORT_FROM.y + '-' + pad(REPORT_FROM.m) + '-' + pad(REPORT_FROM.d),
    asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm'),
  };
  out.v = ver_([out.notReceived, out.invoicePending]);   // changes only when the report itself changes
  cachePutBig_('reports_' + MODE, out, REPORT_CACHE_SECONDS);
  const dec = { lines: decided.reverse(), from: out.from, asOf: out.asOf, unitMap: out.unitMap,
    approvers: activeUsers_().filter(u => u.isApprover).map(u => u.name) };   // everyone who can approve, for the filter
  dec.v = ver_([dec.lines, dec.approvers]);
  cachePutBig_(DEC_CACHE, dec, REPORT_CACHE_SECONDS);
  return { reports: out, decisionsData: dec };
}

// ======================= approval decisions report =======================
// Every line since REPORT_FROM that has a decision (Approved / On Hold / Rejected / Withdrawn), with the
// approver and, for rejections, the reason. Built in the same pass as the PO reports above.
const DEC_CACHE = 'decisions_' + MODE;

function decisions_(user, req) {
  const hit = req && req.fresh ? null : cacheGetBig_(DEC_CACHE);
  if (hit) return hit.v && req && req.v === hit.v ? { same: true, asOf: hit.asOf } : { decisions: hit };
  return { decisions: reports_(user, { fresh: true }).decisionsData };
}

/** Latest rejection reason per order number. */
function remarksIndex_() {
  const sh = book_().getSheetByName(CFG.REMARKS);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 2, sh.getLastRow() - 1, 5).getValues().forEach(r => { const o = String(r[0]).trim(); if (o) out[o] = String(r[4]).trim(); });
  return out;
}

/** Puts lines just decided in the app straight into the ready copy of the decisions report. */
function patchDecisions_(done, decision, user, remark) {
  if (!done.length) return;
  const dec = cacheGetBig_(DEC_CACHE);
  if (!dec) return;
  const rows = {};
  done.forEach(d => (rows[d.row] = true));
  const now = new Date(Date.now() + 330 * 60000), pad = v => (v < 10 ? '0' : '') + v;
  const at = pad(now.getUTCDate()) + '-' + pad(now.getUTCMonth() + 1) + '(' + pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ')';
  const old = {};
  dec.lines.forEach(l => { if (rows[l.row]) old[l.row] = l; });
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const fresh = done.map(d => {
    const r = d.r, u = norm(r[COL.UNIT - 1]);
    const mapped = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1));
    const prev = old[d.row];
    return {
      o: d.orderNo, d: prev ? prev.d : Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), at: at,
      u: mapped ? mapped[1] : String(r[COL.UNIT - 1]).trim(), c: mapped ? mapped[0] : 'Other',
      it: String(r[COL.ITEM - 1]).trim(), q: r[COL.QTY - 1] === '' ? '' : r[COL.QTY - 1], uom: String(r[COL.UOM - 1]).trim(),
      aq: d.qty === null ? '' : d.qty, s: decision, by: user.name, rm: remark, row: d.row,
    };
  });
  dec.lines = fresh.concat(dec.lines.filter(l => !rows[l.row]));
  dec.v = ver_([dec.lines, dec.approvers]);
  cachePutBig_(DEC_CACHE, dec, REPORT_CACHE_SECONDS);
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
    const sh = tab_(CFG.USERS, ['Name (exactly as in column L)', 'Email', 'Role (HO / APPROVER / HO+APPROVER / STOREKEEPER)', 'Active (YES / NO)', 'Unit(s) - storekeepers only']);
    // Start with the names already allowed in column L (APPROVER).
    const rule = fms_().getRange(CFG.FIRST_ROW, COL.APPROVER).getDataValidation();
    const names = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? rule.getCriteriaValues()[0] : [];
    if (names.length) sh.getRange(2, 1, names.length, 4).setValues(names.map(n => [n, '', 'APPROVER', 'YES']));
    sh.autoResizeColumns(1, 4);
  }
  tab_(CFG.DEVICES, ['Email', 'Token', 'Device', 'Updated']);
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']);
  tab_(CFG.REMARKS, REMARK_HEADER);
  setupStore();
  console.log('Done (' + MODE + ' sheet: ' + ss.getName() + '). Fill in the emails and roles in the "' + CFG.USERS + '" tab.');
}

/** Sends a test notification to yourself (the person running this). */
function testNotification() {
  const me = Session.getActiveUser().getEmail().toLowerCase();
  console.log(JSON.stringify(notify_(me, 'Test from NLP Approvals', 'If you can read this on your phone, notifications work.')));
}

// ============ Notify as soon as a name is picked in FMS column L (in the sheet) ============

/** Run ONCE from the editor. Installs both triggers: the FMS edit watcher and the 5-minute cache refresh. */
function installTriggers() {
  installFmsTrigger();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'warmCache')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(5).create();
  warmCache();
  console.log('Cache refresh every 5 minutes is on.');
}

/** Run ONCE from the editor. Makes the server watch the FMS sheet for edits. */
function installFmsTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onFmsEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onFmsEdit').forSpreadsheet(CFG.SHEET_ID).onEdit().create();
  console.log('Now watching column L of: ' + book_().getName());
}

/** Re-reads the open lines after a change in the sheet, so the app shows it within seconds.
 * Edits that arrive while a re-read is running are picked up by that same run. */
function rebuildOpenLines_() {
  const c = CacheService.getScriptCache();
  c.put('open_dirty', String(Date.now()) + Math.random(), 600);
  if (c.get('open_rebuilding')) return;
  c.put('open_rebuilding', '1', 240);
  try {
    for (let i = 0; i < 3; i++) {
      const mark = c.get('open_dirty');
      FMS_SNAP_ = null;   // read the sheet as it is now
      openLines_(true);
      if (c.get('open_dirty') === mark) break;
    }
  } finally { c.remove('open_rebuilding'); }
}

/** Runs by itself whenever someone picks or types a name in FMS column L. */
function onFmsEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== CFG.FMS) return;
  const firstCol = r.getColumn(), lastCol = firstCol + r.getNumColumns() - 1;
  if (firstCol > COL.APPR_QTY) return; // only columns A-N matter to the app
  if (COL.APPROVER < firstCol || COL.APPROVER > lastCol) return rebuildOpenLines_(); // e.g. approval cleared or a new line typed in
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

  const newApprover = {};
  rows.forEach((row, j) => (newApprover[top + j] = String(row[COL.APPROVER - 1]).trim()));
  patchOpenLines_(Object.keys(newApprover).map(Number), l => { l.approver = newApprover[l.row]; return l; });

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
  rebuildOpenLines_(); // pick up lines that were not in the app's ready copy (e.g. a decision cleared in the sheet)
}

// ======================= storekeeper =======================
// A storekeeper is a row in APP USERS with STOREKEEPER in the role and their unit(s) in column E
// (exactly as the unit is written in FORMDATA / FMS column C, e.g. SAMTHAR; several units separated by commas).
// Every storekeeper action checks the unit of the line on the server, so a storekeeper can never see or change
// another unit's lines. The admin (script owner, or ADMIN in the role) can work for every unit while on trial.
//
//   Raise request   -> new row in FORMDATA (A-I, same columns as the Google Form). FMS B:H is a QUERY on FORMDATA,
//                      and FMS A builds the order number, so the line appears in FMS and the app by itself.
//   Material recd   -> received quantity in FMS AB (RECEIVED), per line, only for approved lines with a PO.
//   Upload invoice  -> file saved in Drive + a row in INVOICES (A-F, same columns as the invoice Google Form),
//                      which FMS Z / AC-AF read by PO number.

const SCOL = { PO: 20, PO_AMT: 21, RECEIVED: 28, INVOICE: 29, INV_NO: 30, INV_DATE: 31, INV_AMT: 32, VENDOR: 33, LAST: 33 };
const STORE_CFG = {
  INVOICES: 'INVOICES',          // A P.O NUMBER, B UPLOAD INVOICE (link), C Timestamp, D AMOUNT, E INVOICE NUMBER, F INVOICE DATE
  POS: 'P.Os',                   // B PO NUMBER, C LINK
  FOLDER: 'Summit Purchase App uploads',
  MAX_LINES: 30,                 // lines in one request
  MAX_PHOTO: 3 * 1024 * 1024,    // bytes after decoding (the app shrinks photos to well under this)
  MAX_FILE: 8 * 1024 * 1024,     // invoice file
  CACHE: 'store_lines_' + MODE,
  META: 'store_meta_' + MODE,
};
const normU_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Units this person may work on. */
function storeUnits_(user) {
  if (!user.previewBy && isAdmin_(user)) return storeMetaData_().units;
  if (!user.isStore) return [];
  const known = storeMetaData_().units;
  return user.units.map(u => known.find(k => normU_(k) === normU_(u)) || u);
}

/** Returns the unit name if this person may work on it, otherwise stops with an error. */
function checkUnit_(user, unit) {
  const mine = storeUnits_(user);
  const hit = mine.find(u => normU_(u) === normU_(unit));
  if (!normU_(unit) || !hit) {
    throw appError_('FORBIDDEN', mine.length ? 'You can only work on ' + mine.join(', ') + '.' : 'You are not set up as a storekeeper.');
  }
  return hit;
}

/** Units, categories and units of measure used in FORMDATA, plus items the unit asked for before (for suggestions). */
function storeMetaData_(fresh) {
  if (!fresh) { const hit = cacheGetBig_(STORE_CFG.META); if (hit) return hit; }
  const sh = book_().getSheetByName(FORMDATA.TAB);
  const last = sh ? sh.getLastRow() : 0;
  const out = { units: [], categories: [], uoms: [], items: {} };
  if (last >= 2) {
    const first = Math.max(2, last - FORMDATA.MAX_ROWS + 1);
    const rows = sh.getRange(first, 1, last - first + 1, 7).getValues();
    const count = (map, v) => { v = String(v).trim().toUpperCase(); if (v) map[v] = (map[v] || 0) + 1; };
    const units = {}, cats = {}, uoms = {};
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const unit = String(r[1]).trim().toUpperCase(), item = String(r[3]).replace(/\s+/g, ' ').trim();
      if (!unit || !item) continue;
      count(units, unit); count(cats, r[2]);
      const uom = String(r[6]).trim(); if (uom) uoms[uom] = (uoms[uom] || 0) + 1;
      const list = out.items[unit] = out.items[unit] || [];
      if (list.length < 400 && !list.some(x => x[0].toLowerCase() === item.toLowerCase())) list.push([item, String(r[2]).trim().toUpperCase(), uom]);
    }
    const byCount = m => Object.keys(m).sort((a, b) => m[b] - m[a]);
    out.units = Object.keys(units).filter(u => units[u] >= 3).sort();
    out.categories = byCount(cats).filter(c => cats[c] >= 3);
    out.uoms = byCount(uoms).filter(u => uoms[u] >= 3).slice(0, 25);
  }
  Object.keys(out.items).forEach(u => cachePutBig_(STORE_CFG.META + '_items_' + normU_(u), out.items[u], 21600));
  const base = { units: out.units, categories: out.categories, uoms: out.uoms };
  cachePutBig_(STORE_CFG.META, base, 21600);
  return base;
}

function storeMeta_(user, req) {
  const unit = checkUnit_(user, req.unit);
  const m = storeMetaData_();
  let items = cacheGetBig_(STORE_CFG.META + '_items_' + normU_(unit));
  if (!items) { storeMetaData_(true); items = cacheGetBig_(STORE_CFG.META + '_items_' + normU_(unit)) || []; }
  return { unit: unit, categories: m.categories, uoms: m.uoms, items: items };
}

/** Lines the storekeeper screens need: requests of the last STORE_DAYS days, plus every line since REPORT_FROM
 * that still has to be received or invoiced. Kept ready in the cache PER UNIT (so a storekeeper only downloads and
 * the server only unpacks their own unit), rebuilt by warmCache every 5 minutes and after every store change. */
const STORE_DAYS = 60;
let STORE_BUILT_ = false;   // store lines already rebuilt in this run (a fresh read of many units rebuilds once)
const storeKey_ = unit => STORE_CFG.CACHE + '_' + normU_(unit);
function storeLines_() {
  const snap = fmsSnap_();
  const rows = snap.rows, disp = snap.stamps, invDisp = snap.inv;
  const remarks = remarksIndex_();
  const links = poLinks_();
  const invs = invoiceIndex_();
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const cutoff = Date.now() - STORE_DAYS * 86400000;
  const pad = v => (v < 10 ? '0' : '') + v;
  const num = v => (v === '' || v === null ? '' : (isFinite(Number(v)) ? Number(v) : String(v)));
  const byUnit = {}, polByUnit = {}, ivlByUnit = {};
  let year = CFG.START_YEAR, prevMonth = 1;
  rows.forEach((r, i) => {
    const m = String(disp[i][0]).match(/^(\d{1,2})-(\d{1,2})(?:\((\d{1,2}):(\d{2})\))?/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;
    prevMonth = mon;
    const orderNo = String(r[COL.ORDER - 1]).trim();
    if (!orderNo || year * 10000 + mon * 100 + day < fromKey) return;
    const ts = Date.UTC(year, mon - 1, day, +(m[3] || 0), +(m[4] || 0)) - 330 * 60000;
    const status = String(r[COL.APPROVAL - 1]).trim();
    const po = String(r[SCOL.PO - 1]).trim();
    const received = r[SCOL.RECEIVED - 1] !== '' && r[SCOL.RECEIVED - 1] !== null;
    const inv = String(invDisp[i][0]).trim().toUpperCase();
    const toReceive = status === 'Approved' && po && !received;
    const toInvoice = status === 'Approved' && po && received && inv === 'UPDATE';
    if (ts < cutoff && !toReceive && !toInvoice) return;
    const unit = normU_(r[COL.UNIT - 1]);
    if (!unit) return;
    const l = {
      row: CFG.FIRST_ROW + i, o: orderNo,
      d: year + '-' + pad(mon) + '-' + pad(day), at: pad(day) + '-' + pad(mon) + ' ' + pad(+(m[3] || 0)) + ':' + pad(+(m[4] || 0)),
      cat: String(r[COL.CAT - 1]).trim(), it: String(r[COL.ITEM - 1]).trim(),
      q: num(r[COL.QTY - 1]), uom: String(r[COL.UOM - 1]).trim(), s: status,
      ap: String(r[COL.APPROVED_BY - 1]).trim() || String(r[COL.APPROVER - 1]).trim(), aq: num(r[COL.APPR_QTY - 1]),
      rcv: received ? num(r[SCOL.RECEIVED - 1]) : '', inv: inv === 'UPDATE' ? 'pending' : (inv === 'INVOICE' ? 'done' : ''),
    };
    // only what the screens use: leave out empty fields
    if (/^https?:\/\//.test(String(r[COL.PIC - 1]))) l.pic = String(r[COL.PIC - 1]).trim();
    if (status === 'Rejected' && remarks[orderNo]) l.rm = remarks[orderNo];
    if (po) {
      l.po = po;   // the PO file link goes once per PO in "pol", not on every line
      if (links[po.toUpperCase()]) (polByUnit[unit] = polByUnit[unit] || {})[po] = links[po.toUpperCase()];
      if (inv === 'INVOICE' && invs[po.toUpperCase()]) (ivlByUnit[unit] = ivlByUnit[unit] || {})[po] = invs[po.toUpperCase()];
      l.amt = Number(String(r[SCOL.PO_AMT - 1]).replace(/[^0-9.]/g, '')) || 0; l.ven = String(r[SCOL.VENDOR - 1]).trim();
    }
    (byUnit[unit] = byUnit[unit] || []).push(l);
  });
  const asOf = Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm');
  const units = unique_(storeMetaData_().units.map(normU_).concat(Object.keys(byUnit)));
  units.forEach(u => {
    const lines = (byUnit[u] || []).reverse(), pol = polByUnit[u] || {}, ivl = ivlByUnit[u] || {};
    cachePutBig_(storeKey_(u), { lines: lines, pol: pol, ivl: ivl, asOf: asOf, v: ver_([lines, pol, ivl]) }, OPEN_CACHE_SECONDS);
  });
  STORE_BUILT_ = true;
  return byUnit;
}

/** PO number -> uploaded invoice {n: number, d: date, a: amount, l: link, t: uploaded on} from the INVOICES tab. */
function invoiceIndex_() {
  const out = {};
  const sh = book_().getSheetByName(STORE_CFG.INVOICES);
  if (!sh) return out;
  const last = lastFilled_(sh, 1);
  if (last < 2) return out;
  const first = Math.max(2, last - 4000 + 1);
  const fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  sh.getRange(first, 1, last - first + 1, 6).getValues().forEach(r => {
    const k = String(r[0]).trim().toUpperCase();
    if (!k) return;
    out[k] = { n: String(r[4]).trim(), d: fd(r[5]), a: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0, l: /^https?:\/\//.test(String(r[1])) ? String(r[1]).trim() : '', t: fd(r[2]) };
  });
  return out;
}

/** PO number -> link of the PO file (P.Os tab B:C), last few thousand POs. */
function poLinks_() {
  const out = {};
  const sh = book_().getSheetByName(STORE_CFG.POS);
  if (!sh) return out;
  const last = sh.getLastRow();
  if (last < 2) return out;
  const first = Math.max(2, last - 4000 + 1);
  sh.getRange(first, 2, last - first + 1, 2).getValues().forEach(r => {
    const k = String(r[0]).trim().toUpperCase();
    if (k && /^https?:\/\//.test(String(r[1]))) out[k] = String(r[1]).trim();
  });
  return out;
}

/** Storekeeper: every line of one unit (only units this person may work on). */
function storeList_(user, req) {
  const unit = checkUnit_(user, req.unit);
  const fresh = req && req.fresh && !STORE_BUILT_;
  let data = fresh ? null : cacheGetBig_(storeKey_(unit));
  if (!data) { storeLines_(); data = cacheGetBig_(storeKey_(unit)) || { lines: [], pol: {}, ivl: {}, asOf: '', v: '' }; }
  if (!(req && req.fresh) && req && req.v && req.v === data.v) return { same: true, unit: unit, asOf: data.asOf };
  return { unit: unit, lines: data.lines, pol: data.pol || {}, ivl: data.ivl || {}, asOf: data.asOf, v: data.v };
}

/** Storekeeper: raise a purchase request with one or more lines. */
function storeRaise_(user, req) {
  const unit = checkUnit_(user, req.unit);
  const meta = storeMetaData_();
  const lines = Array.isArray(req.lines) ? req.lines : [];
  if (!lines.length) throw appError_('BAD_REQUEST', 'Add at least one item.');
  if (lines.length > STORE_CFG.MAX_LINES) throw appError_('BAD_REQUEST', 'Too many items in one request (max ' + STORE_CFG.MAX_LINES + ').');
  const clean = lines.map((l, i) => {
    const n = 'Item ' + (i + 1) + ': ';
    const item = String(l.item || '').replace(/\s+/g, ' ').trim();
    const cat = String(l.category || '').trim().toUpperCase();
    const uom = String(l.uom || '').trim();
    const qty = Number(l.qty);
    if (!item || item.length > 100) throw appError_('BAD_REQUEST', n + 'enter the item name (up to 100 letters).');
    if (!meta.categories.some(c => c === cat)) throw appError_('BAD_REQUEST', n + 'choose a category from the list.');
    if (!(qty > 0) || qty > 1e6) throw appError_('BAD_REQUEST', n + 'enter a quantity above 0.');
    if (!uom || uom.length > 15) throw appError_('BAD_REQUEST', n + 'choose the unit (Pcs, Kgâ¦).');
    const stock = String(l.stock === undefined || l.stock === null ? '' : l.stock).trim();
    if (stock === '' || stock.length > 20) throw appError_('BAD_REQUEST', n + 'enter the stock in hand (0 if none).');
    if (l.photo) checkFile_(l.photo, ['image/jpeg', 'image/png', 'image/webp'], STORE_CFG.MAX_PHOTO, n + 'photo');
    return { item: item, cat: cat, uom: uom, qty: qty, stock: isFinite(Number(stock)) ? Number(stock) : stock, photo: l.photo || null };
  });

  // Photos first (slow), outside the lock.
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd-HHmmss');
  clean.forEach((l, i) => { l.pic = l.photo ? saveUpload_(l.photo, 'Item photos', unit + ' ' + stamp + ' ' + (i + 1) + ' ' + l.item) : ''; });

  const made = [];
  withLock_(() => {
    const sh = book_().getSheetByName(FORMDATA.TAB);
    if (!sh) throw appError_('SETUP', 'Tab ' + FORMDATA.TAB + ' not found.');
    const at = lastFilled_(sh, 1) + 1;
    // FMS A ends the order number with the hundredths of a second of the timestamp ("-00" in its TEXT format),
    // so each line gets its own second plus random hundredths, like Google Form timestamps.
    const base = Math.floor(Date.now() / 1000) * 1000;
    const values = clean.map((l, i) => {
      const cs = Math.floor(Math.random() * 100);
      const t = new Date(base + i * 1000 + cs * 10);
      made.push({ orderNo: orderNo_(unit, l.item, t, cs), item: l.item, qty: l.qty, uom: l.uom });
      return [t, unit, l.cat, l.item, l.pic, l.qty, l.uom, l.stock, l.uom];
    });
    sh.getRange(at, 1, values.length, values[0].length).setValues(values);
    SpreadsheetApp.flush();
    // FMS picks the new FORMDATA rows up by itself: find them there to learn their FMS row and real order number
    try { patchAfterRaise_(unit, clean, made); } catch (e) { console.warn('Quick update failed: ' + e); }
    log_(user, 'REQUEST', made.map(m => m.orderNo).join(', '), unit + ': ' + made.map(m => m.item + ' x' + m.qty + ' ' + m.uom).join('; '));
  });
  scheduleRefresh_();   // full re-read + "new requirement" alert to HO, in the background
  return { raised: made.length, unit: unit, lines: made };
}

/** Storekeeper: received quantity for approved lines that have a PO (FMS AB). */
function storeReceive_(user, req) {
  const items = cleanItems_(req.items);
  const done = [], skipped = [], got = [];
  withLock_(() => {
    const sh = fms_();
    items.forEach(it => {
      const r = sh.getRange(it.row, 1, 1, SCOL.LAST).getValues()[0];
      if (String(r[COL.ORDER - 1]).trim() !== it.orderNo) return skipped.push({ orderNo: it.orderNo, why: 'Line moved in the sheet. Refresh and try again.' });
      if (!user.isHO) checkUnit_(user, r[COL.UNIT - 1]);   // never another unit's line (HO may receive for any unit)
      if (String(r[COL.APPROVAL - 1]).trim() !== 'Approved') return skipped.push({ orderNo: it.orderNo, why: 'Not approved.' });
      if (!String(r[SCOL.PO - 1]).trim()) return skipped.push({ orderNo: it.orderNo, why: 'No PO yet.' });
      if (r[SCOL.RECEIVED - 1] !== '') return skipped.push({ orderNo: it.orderNo, why: 'Already received (' + r[SCOL.RECEIVED - 1] + ').' });
      if (!(it.qty > 0) || it.qty > 99999) return skipped.push({ orderNo: it.orderNo, why: 'Enter the quantity received (1 to 99999).' });
      sh.getRange(it.row, SCOL.RECEIVED).setValue(it.qty);
      done.push(it.orderNo + ' x' + it.qty);
      got.push({ row: it.row, qty: it.qty, unit: String(r[COL.UNIT - 1]).trim() });
    });
    if (done.length) log_(user, 'RECEIVED', done.join(', '), '');
  });
  if (got.length) {
    try { got.forEach(g => patchStore_(g.unit, ls => ls.forEach(l => { if (l.row === g.row) l.rcv = g.qty; }))); } catch (e) { console.warn(e); }
    scheduleRefresh_();
  }
  return { received: done.length, skipped: skipped };
}

/** Storekeeper: upload the vendor invoice for a PO whose material is received. */
function storeInvoice_(user, req) {
  const po = String(req.po || '').trim();
  const invNo = String(req.invoiceNo || '').trim();
  const amount = Number(String(req.amount || '').replace(/[^0-9.]/g, ''));
  const dm = String(req.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!po) throw appError_('BAD_REQUEST', 'Choose the PO.');
  if (!invNo || invNo.length > 40) throw appError_('BAD_REQUEST', 'Enter the invoice number.');
  if (!dm) throw appError_('BAD_REQUEST', 'Enter the invoice date.');
  if (!(amount > 0) || amount > 1e9) throw appError_('BAD_REQUEST', 'Enter the invoice total amount.');
  const invDate = new Date(+dm[1], +dm[2] - 1, +dm[3]);
  if (invDate.getTime() > Date.now() + 86400000) throw appError_('BAD_REQUEST', 'The invoice date is in the future.');
  checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Invoice file');

  // Check the PO against the sheet itself: every line of it must belong to a unit this person may work on.
  const sh = fms_();
  const n = sh.getLastRow() - CFG.FIRST_ROW + 1;
  const units = n > 0 ? sh.getRange(CFG.FIRST_ROW, COL.UNIT, n, 1).getValues() : [];
  const pos = n > 0 ? sh.getRange(CFG.FIRST_ROW, SCOL.PO, n, 1).getValues() : [];
  const rcv = n > 0 ? sh.getRange(CFG.FIRST_ROW, SCOL.RECEIVED, n, 1).getValues() : [];
  const key = po.toUpperCase();
  let lines = 0, received = 0, unit = '';
  pos.forEach((p, i) => {
    if (String(p[0]).trim().toUpperCase() !== key) return;
    unit = user.isHO ? (storeMetaData_().units.find(k => normU_(k) === normU_(units[i][0])) || String(units[i][0]).trim()) : checkUnit_(user, units[i][0]);   // HO may upload for any unit
    lines++;
    if (rcv[i][0] !== '') received++;
  });
  if (!lines) throw appError_('BAD_REQUEST', 'PO ' + po + ' was not found in FMS.');
  if (!received) throw appError_('BAD_REQUEST', 'Mark the material of PO ' + po + ' as received first.');
  const inv = book_().getSheetByName(STORE_CFG.INVOICES);
  if (!inv) throw appError_('SETUP', 'Tab ' + STORE_CFG.INVOICES + ' not found.');
  const invLast = lastFilled_(inv, 1);
  if (invLast >= 2 && inv.getRange(2, 1, invLast - 1, 1).getValues().some(r => String(r[0]).trim().toUpperCase() === key)) {
    throw appError_('BAD_REQUEST', 'An invoice for PO ' + po + ' is already uploaded.');
  }

  const link = saveUpload_(req.file, 'Invoices', po + ' ' + invNo);
  withLock_(() => {
    const at = lastFilled_(inv, 1) + 1;
    inv.getRange(at, 1, 1, 6).setValues([[po, link, new Date(), amount, invNo, invDate]]);
    log_(user, 'INVOICE', po, unit + ': invoice ' + invNo + ', â¹' + amount + ' (' + received + ' of ' + lines + ' lines received)');
  });
  const today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  try { patchStore_(unit, (ls, d) => { ls.forEach(l => { if (l.po && l.po.toUpperCase() === key && l.rcv !== '') l.inv = 'done'; }); (d.ivl = d.ivl || {})[po] = { n: invNo, d: dm[0], a: amount, l: link, t: today }; }); } catch (e) { console.warn(e); }
  scheduleRefresh_();
  return { uploaded: true, po: po, link: link };
}

// ---- storekeeper helpers ----

/** Order number as FMS column A makes it: first 2 letters of unit + item, then -DDMM-HHMM-<hundredths>. */
function orderNo_(unit, item, t, cs) {
  return (String(unit).slice(0, 2) + String(item).slice(0, 2)).toUpperCase() + Utilities.formatDate(t, CFG.TZ, '-ddMM-HHmm-') + (cs < 10 ? '0' : '') + cs;
}

/** Last row with something in the given column (ignores formulas/blank rows further down other columns). */
function lastFilled_(sh, col) {
  const last = sh.getLastRow();
  if (last < 1) return 0;
  const from = Math.max(1, last - 3000 + 1);
  const v = sh.getRange(from, col, last - from + 1, 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]).trim() !== '') return from + i;
  return from - 1;
}

function checkFile_(f, types, max, what) {
  if (!f || typeof f.data !== 'string' || !f.data) throw appError_('BAD_REQUEST', what + ' is missing.');
  if (types.indexOf(String(f.type)) === -1) throw appError_('BAD_REQUEST', what + ' must be a photo (JPG/PNG)' + (types.indexOf('application/pdf') !== -1 ? ' or a PDF.' : '.'));
  if (f.data.length * 3 / 4 > max) throw appError_('BAD_REQUEST', what + ' is too big (max ' + Math.round(max / 1048576) + ' MB).');
}

/** Saves a file in Drive: <My Drive>/Summit Purchase App uploads/<sub>/ and returns a link anyone at the company can open. */
function saveUpload_(f, sub, name) {
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[f.type] || '';
  const blob = Utilities.newBlob(Utilities.base64Decode(f.data), f.type, (String(name).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120)) + ext);
  const file = uploadFolder_(sub).createFile(blob);
  try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('Sharing not changed: ' + e); }
  return 'https://drive.google.com/open?id=' + file.getId();
}

function uploadFolder_(sub) {
  const props = PropertiesService.getScriptProperties();
  const key = 'FOLDER_' + MODE + '_' + sub.replace(/\W/g, '');
  const id = props.getProperty(key);
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make it again */ } }
  const rootName = STORE_CFG.FOLDER + (MODE === 'LIVE' ? '' : ' (TRIAL)');
  const it = DriveApp.getFoldersByName(rootName);
  const root = it.hasNext() ? it.next() : DriveApp.createFolder(rootName);
  const subs = root.getFoldersByName(sub);
  const folder = subs.hasNext() ? subs.next() : root.createFolder(sub);
  props.setProperty(key, folder.getId());
  return folder;
}

/** A storekeeper (who is not HO, approver or admin) sees the reports of their own unit(s) only. */
function scopeReports_(user, res) {
  if (res.same) return res;
  if (!user.isStore || user.isHO || user.isApprover || (!user.previewBy && isAdmin_(user))) return res;
  const label = raw => { const u = normU_(raw); const m = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1)); return m ? m[1] : String(raw).trim(); };
  const mine = user.units.map(label);
  const keep = u => mine.indexOf(u) !== -1;
  const out = Object.assign({}, res);
  if (res.reports) out.reports = Object.assign({}, res.reports, {
    notReceived: res.reports.notReceived.filter(p => keep(p.unit)),
    invoicePending: res.reports.invoicePending.filter(p => keep(p.unit)),
    unitMap: res.reports.unitMap.filter(x => keep(x[1])),
  });
  if (res.decisions) out.decisions = Object.assign({}, res.decisions, {
    lines: res.decisions.lines.filter(l => keep(l.u)),
    unitMap: res.decisions.unitMap.filter(x => keep(x[1])),
  });
  delete out.decisionsData;
  return out;
}

/** Run once from the editor (setup() also runs it): adds column E "Unit(s)" to APP USERS and asks for Drive access. */
function setupStore() {
  const sh = book_().getSheetByName(CFG.USERS);
  if (sh && !String(sh.getRange(1, 5).getValue()).trim()) {
    sh.getRange(1, 3).setValue('Role (HO / APPROVER / HO+APPROVER / STOREKEEPER)');
    sh.getRange(1, 5).setValue('Unit(s) - storekeepers only').setFontWeight('bold');
  }
  uploadFolder_('Item photos'); uploadFolder_('Invoices');
  storeMetaData_(true);
  storeLines_();
  console.log('Storekeeper setup done. Units found: ' + storeMetaData_().units.join(', '));
}


// ======================= HO: make PO =======================
// Same as the P.O tab of the sheet: approved lines (FMS K = Approved) that have no PO yet (FMS T empty) are picked per
// hotel, a vendor (VENDORS tab) and delivery days are chosen, a price and tax % are given per line, and the PO is made:
//   - PO number like the sheet's:  first 2 letters of hotel + first 2 of vendor + number of lines (2 digits) + ddMM-Hmm
//   - the PO is saved as a PDF in Drive (Summit Purchase App uploads/Purchase orders)
//   - one row per line in P.Os: A order no, B PO no, C PDF link, D time, E vendor, F delivery days, G PO total, H hotel
//     -> FMS fills T (PO no), U (amount), Q (PO time), S (delivery days), V (PO link) and AG (vendor) by itself
//   - optional: payment terms written in FMS O for those lines
const PO_CFG = {
  CACHE: 'po_pending_' + MODE,
  POS: 'P.Os', VENDORS: 'VENDORS', TEMPLATE: 'P.O',
  HOTELS: 'AH4:AL80',            // in the P.O tab: key, hotel name, address, phone, GST
  MAX_LINES: 31,                 // the sheet's PO has room for 31 lines
  TERMS: ['Advance (20%)', 'Advance (50%)', 'Advance (100%)', 'Normal Credit', 'Within 15 days'],
  COMPANY: 'SUMMIT HOTELS & RESORTS PVT. LTD.',
  COMPANY_ADDR: 'G0402, G Block, City Centre Office Block, Matigara, Siliguri - 734010',
};

/** Approved lines with no PO, grouped by nothing (the app groups by hotel). Kept in the cache; v = content version. */
function poPendingBuild_() {
  const snap = fmsSnap_();
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v;
  const lines = [];
  let year = CFG.START_YEAR, prevMonth = 1;
  snap.rows.forEach((r, i) => {
    const m = String(snap.stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})(?:\((\d{1,2}):(\d{2})\))?/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;
    prevMonth = mon;
    if (year * 10000 + mon * 100 + day < fromKey) return;
    const orderNo = String(r[COL.ORDER - 1]).trim();
    if (!orderNo || String(r[COL.APPROVAL - 1]).trim() !== 'Approved' || String(r[SCOL.PO - 1]).trim()) return;
    const aq = r[COL.APPR_QTY - 1];
    lines.push({
      row: CFG.FIRST_ROW + i, o: orderNo, d: year + '-' + pad(mon) + '-' + pad(day),
      at: pad(day) + '-' + pad(mon) + ' ' + pad(+(m[3] || 0)) + ':' + pad(+(m[4] || 0)),
      u: String(r[COL.UNIT - 1]).trim(), cat: String(r[COL.CAT - 1]).trim(), it: String(r[COL.ITEM - 1]).trim(),
      q: aq === '' || aq === null ? (Number(r[COL.QTY - 1]) || 0) : Number(aq), uom: String(r[COL.UOM - 1]).trim(),
      ap: String(r[COL.APPROVED_BY - 1]).trim() || String(r[COL.APPROVER - 1]).trim(),
      pt: String(r[14]).trim(),   // O: payment terms, if already chosen in the sheet
    });
  });
  lines.reverse();   // newest first
  const out = { lines: lines, asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm'), terms: PO_CFG.TERMS };
  out.v = ver_(lines);
  cachePutBig_(PO_CFG.CACHE, out, OPEN_CACHE_SECONDS);
  return out;
}

function poPending_(v) {
  let data = cacheGetBig_(PO_CFG.CACHE);
  if (!data) data = poPendingBuild_();
  if (v && v === data.v) return { same: true, asOf: data.asOf };
  return Object.assign({}, data, { lines: pack_(data.lines) });
}

function vendors_() {
  const sh = book_().getSheetByName(PO_CFG.VENDORS);
  if (!sh || sh.getLastRow() < 2) return { list: [] };
  const seen = {};
  const list = sh.getRange(2, 2, sh.getLastRow() - 1, 3).getValues()
    .map(r => [String(r[0]).trim(), String(r[1]).trim(), String(r[2]).trim()])
    .filter(r => r[0] && !seen[r[0].toLowerCase()] && (seen[r[0].toLowerCase()] = true));
  list.sort((a, b) => a[0].localeCompare(b[0]));
  return { list: list, hotels: hotelList_() };   // [name, address, phone]
}

/** HO: make one PO for some approved lines of one hotel. */
function makePO_(user, req) {
  requireHO_(user);
  const items = cleanItems_(req.items).map((it, i) => {
    const src = req.items[i] || {};
    const price = Number(src.price), tax = src.tax === '' || src.tax == null ? 0 : Number(src.tax);
    if (!(price >= 0) || price > 1e8) throw appError_('BAD_REQUEST', 'Enter the price for ' + it.orderNo + '.');
    if (!(tax >= 0) || tax > 100) throw appError_('BAD_REQUEST', 'Tax % for ' + it.orderNo + ' must be 0 to 100.');
    return Object.assign(it, { price: price, tax: tax, name: String(src.name || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  });
  if (items.length > PO_CFG.MAX_LINES) throw appError_('BAD_REQUEST', 'A PO can have at most ' + PO_CFG.MAX_LINES + ' lines.');
  if (!items.some(it => it.price > 0)) throw appError_('BAD_REQUEST', 'Enter the prices.');
  const days = Math.floor(Number(req.days));
  if (!(days >= 0) || days > 365) throw appError_('BAD_REQUEST', 'Enter the delivery days (0 to 365).');
  const terms = String(req.terms || '').trim();
  if (terms && PO_CFG.TERMS.indexOf(terms) === -1) throw appError_('BAD_REQUEST', 'Choose payment terms from the list.');
  const note = String(req.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);

  // vendor: from VENDORS, or a new one added now
  let vendor = null;
  const vs = vendors_().list;
  if (req.newVendor) {
    const nv = req.newVendor, name = String(nv.name || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80) throw appError_('BAD_REQUEST', 'Enter the new vendor name.');
    vendor = vs.find(v => v[0].toLowerCase() === name.toLowerCase()) ||
      [name, String(nv.address || '').trim().slice(0, 200), String(nv.phone || '').replace(/[^0-9+ ]/g, '').slice(0, 20), true];
  } else {
    vendor = vs.find(v => v[0] === String(req.vendor || '').trim());
    if (!vendor) throw appError_('BAD_REQUEST', 'Choose the vendor.');
  }

  let result, rows = [];
  withLock_(() => {
    const sh = fms_();
    const lines = items.map(it => {
      const r = sh.getRange(it.row, 1, 1, SCOL.LAST).getValues()[0];
      if (String(r[COL.ORDER - 1]).trim() !== it.orderNo) throw appError_('BAD_REQUEST', it.orderNo + ' moved in the sheet. Refresh and try again.');
      if (String(r[COL.APPROVAL - 1]).trim() !== 'Approved') throw appError_('BAD_REQUEST', it.orderNo + ' is not approved.');
      if (String(r[SCOL.PO - 1]).trim()) throw appError_('BAD_REQUEST', it.orderNo + ' already has PO ' + r[SCOL.PO - 1] + '.');
      const aq = r[COL.APPR_QTY - 1];
      const qty = aq === '' || aq === null ? Number(r[COL.QTY - 1]) || 0 : Number(aq);
      const total = Math.round(qty * it.price * (1 + it.tax / 100) * 10) / 10;   // as the sheet: ROUND(qty*price*(1+tax%),1)
      return { row: it.row, orderNo: it.orderNo, unit: String(r[COL.UNIT - 1]).trim(), cat: String(r[COL.CAT - 1]).trim(),
               item: it.name || String(r[COL.ITEM - 1]).trim(), qty: qty, uom: String(r[COL.UOM - 1]).trim(), price: it.price, tax: it.tax, total: total };
    });
    const unit = lines[0].unit;
    if (lines.some(l => normU_(l.unit) !== normU_(unit))) throw appError_('BAD_REQUEST', 'All lines of a PO must be for the same hotel.');
    const pos = book_().getSheetByName(PO_CFG.POS);
    const posLast = lastFilled_(pos, 1);
    const already = {};
    if (posLast >= 2) pos.getRange(Math.max(2, posLast - 3000), 1, posLast - Math.max(2, posLast - 3000) + 1, 1).getValues().forEach(x => (already[String(x[0]).trim()] = true));
    const dup = lines.find(l => already[l.orderNo]);
    if (dup) throw appError_('BAD_REQUEST', dup.orderNo + ' is already in a PO.');

    const now = new Date();
    const poNo = (unit.slice(0, 2) + vendor[0].slice(0, 2)) + (lines.length < 10 ? '0' : '') + lines.length +
                 Utilities.formatDate(now, CFG.TZ, 'ddMM-H') + Utilities.formatDate(now, CFG.TZ, 'mm');
    const subtotal = Math.round(lines.reduce((a, l) => a + l.total, 0) * 100) / 100;
      const dRaw = Number(req.discountAmt != null ? req.discountAmt : req.discount) || 0;
  const discountAmt = dRaw > 0 ? Math.min(Math.round(dRaw * 100) / 100, subtotal) : 0;
      const grand = Math.round((subtotal - discountAmt) * 100) / 100;
    const hotel = hotelInfo_(req.shipTo || unit);
    const billToHotel = hotelInfo_(req.billTo || unit);
    const link = poPdf_({ poNo: poNo, date: now, unit: unit, hotel: hotel, billToHotel: billToHotel, vendor: vendor, days: days, lines: lines, subtotal: subtotal, discountAmt: discountAmt, total: grand, note: note, terms: terms, by: user.name });

    if (vendor[3] === true) {   // new vendor: add it to VENDORS like the vendor form does
      const vsh = book_().getSheetByName(PO_CFG.VENDORS);
      vsh.getRange(lastFilled_(vsh, 2) + 1, 1, 1, 4).setValues([[now, vendor[0], vendor[1], vendor[2]]]);
    }
    const at = posLast + 1;
    pos.getRange(at, 1, lines.length, 8).setValues(lines.map(l => [l.orderNo, poNo, link, now, vendor[0], days, grand, unit]));
    try { rateSavePO_(poNo, now, vendor[0], lines); } catch (e) { console.warn('ITEM RATES: ' + e); }   // Check rates history
    if (terms) lines.forEach(l => sh.getRange(l.row, 15).setValue(terms));   // FMS O: payment terms
    SpreadsheetApp.flush();
    log_(user, 'PO', lines.map(l => l.orderNo).join(', '), poNo + ' | ' + vendor[0] + ' | â¹' + grand + ' | ' + link);
    result = { poNo: poNo, link: link, total: grand, unit: unit, vendor: vendor[0], lines: lines.length };
    rows = lines.map(l => l.row);
  });
  // quick: take the lines out of "Make PO" and show the PO on the hotel's store lines; full re-read in the background
  try {
    const set = {}; rows.forEach(r => (set[r] = true));
    patchCache_(PO_CFG.CACHE, d => { d.lines = d.lines.filter(l => !set[l.row]); d.v = ver_(d.lines); return d; });
    patchCache_(DEC_CACHE, d => { d.lines = d.lines.filter(l => !set[l.row]); d.v = ver_([d.lines, d.approvers]); return d; });
    patchStore_(result.unit, (ls, d) => { ls.forEach(l => { if (set[l.row]) { l.po = result.poNo; l.amt = result.total; l.ven = result.vendor; } }); (d.pol = d.pol || {})[result.poNo] = result.link; });
  } catch (e) { console.warn('Quick update failed: ' + e); }
  scheduleRefresh_();
  return result;
}

/** Hotel name, address, phone, GST from the P.O tab's hotel table (Head Office -> company "GOODS" row). */
/** Summit logo from the P.O tab (cell J6), as a data URI for the PDF; cached 6 h. */
function poLogo_() {
  const c = CacheService.getScriptCache();
  const hit = c.get('poLogo');
  if (hit) return hit === '-' ? '' : hit;
  let d = '';
  try {
    const v = book_().getSheetByName(PO_CFG.TEMPLATE).getRange('J6').getValue();
    let url = v && v.getContentUrl ? v.getContentUrl() : '';
    if (url) {
      url = url.replace(/=s\d+/, '=s240');
      const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (r.getResponseCode() === 200) d = 'data:' + (r.getHeaders()['Content-Type'] || 'image/png').split(';')[0] + ';base64,' + Utilities.base64Encode(r.getContent());
    }
  } catch (err) { console.warn('Logo not loaded: ' + err); }
  try { c.put('poLogo', d && d.length < 95000 ? d : (d ? '' : '-'), 21600); } catch (err) {}
  return d;
}

/** Units for Ship To / Bill To: [key, hotel name] from the P.O tab. */
function hotelList_() {
  const sh = book_().getSheetByName(PO_CFG.TEMPLATE);
  if (!sh) return [];
  return sh.getRange(PO_CFG.HOTELS).getValues().filter(r => String(r[0]).trim() && String(r[1]).trim())
    .map(r => [String(r[0]).trim(), String(r[1]).trim(), String(r[4]).trim(), String(r[2]).trim(), String(r[3]).trim()]);   // key, name, GST, address, phone
}

function hotelInfo_(unit) {
  const sh = book_().getSheetByName(PO_CFG.TEMPLATE);
  const rows = sh ? sh.getRange(PO_CFG.HOTELS).getValues() : [];
  const key = normU_(unit) === 'headoffice' ? 'goods' : normU_(unit);
  const r = rows.find(x => normU_(x[0]) === key) || rows.find(x => normU_(x[0]) && key.indexOf(normU_(x[0])) === 0);
  return r ? { name: String(r[1]).trim(), address: String(r[2]).trim(), phone: String(r[3]).trim(), gst: String(r[4]).trim() }
           : { name: unit, address: '', phone: '', gst: '' };
}

/** Makes the PO PDF from a copy of the sheet's P.O tab (same layout, logo and colours) and returns a Drive link. */
function poPdf_(p) {
  const ss = book_();
  const tpl = ss.getSheetByName(PO_CFG.TEMPLATE);
  let sh = null;
  try {
    sh = tpl.copyTo(ss).setName('PO_TMP_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const put = (a1, v) => sh.getRange(a1).setValue(v);
    sh.getRange('J24:T54').clearContent();
    put('J13', '');
    put('S8', "'" + Utilities.formatDate(p.date, CFG.TZ, 'dd-MMM-yy').toUpperCase());
    put('S9', p.poNo);
    put('J9', 'SUMMIT HOTELS AND RESORTS');
    put('J10', PO_CFG.COMPANY_ADDR);
    put('P12', p.hotel.name); put('P13', p.hotel.address);
    put('J15', p.vendor[0]); put('J16', String(p.vendor[1] || '').toUpperCase()); put('J17', p.vendor[2] ? '(M) ' + p.vendor[2] : '');
    put('P16', p.billToHotel.name); put('P17', p.billToHotel.address);
    put('P21', p.billToHotel.gst ? 'GST - ' + p.billToHotel.gst : '');
    put('M19', p.days);
    const n = Math.min(p.lines.length, 31);
    const col = (c, f) => sh.getRange(c + '24:' + c + (23 + n)).setValues(p.lines.slice(0, n).map(l => [f(l)]));
    if (n) {
      col('J', l => l.orderNo); col('L', l => l.item); col('P', l => l.qty); col('Q', l => l.uom);
      col('R', l => l.price); col('S', l => l.tax); col('T', l => l.total);
    }
    const subtotal = p.subtotal != null ? p.subtotal : p.total;
    put('T55', subtotal);
    put('R57', 'DISCOUNT'); put('T57', p.discountAmt > 0 ? -p.discountAmt : '');
    put('T59', p.total);
    put('J56', 'FRIGHT INCLUDING' + (p.note ? ' - ' + p.note : ''));
    if (p.terms) put('K59', p.terms);
    SpreadsheetApp.flush();
    const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=pdf&gid=' + sh.getSheetId() +
      '&r1=4&c1=9&r2=60&c2=21&size=A4&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=false' +
      '&pagenum=UNDEFINED&fzr=false&horizontal_alignment=CENTER&top_margin=0.4&bottom_margin=0.4&left_margin=0.3&right_margin=0.3';
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('PDF export failed (' + res.getResponseCode() + ')');
    const blob = res.getBlob().setName(p.poNo + '.pdf');
    const file = uploadFolder_('Purchase orders').createFile(blob);
    try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { console.warn('Sharing not changed: ' + err); }
    return 'https://drive.google.com/file/d/' + file.getId() + '/view?usp=drivesdk';
  } finally {
    if (sh) try { ss.deleteSheet(sh); } catch (err) { console.warn('Temp PO sheet not deleted: ' + err); }
  }
}


// ======================= quick updates + background refresh =======================
// Re-reading the whole FMS sheet takes 10-30 seconds, so nobody should wait for it. A save now changes only its own
// lines in the ready copies (so every screen shows the change at once) and asks for ONE full re-read a few seconds
// later in the background (bgRefresh), which also sends the "new requirement" alerts to HO.

function patchCache_(key, fn) {
  const o = cacheGetBig_(key);
  if (!o) return false;   // no ready copy: the background refresh builds it
  const n = fn(o);
  cachePutBig_(key, n || o, OPEN_CACHE_SECONDS);
  return true;
}

/** fn(lines, data) changes one unit's store lines in place; the version is recomputed so phones pick it up. */
function patchStore_(unit, fn) {
  return patchCache_(storeKey_(unit), d => { fn(d.lines, d); d.v = ver_([d.lines, d.pol || {}, d.ivl || {}]); return d; });
}

function scheduleRefresh_() {
  const c = CacheService.getScriptCache();
  if (c.get('bg_refresh_' + MODE)) return;   // one is already on its way
  c.put('bg_refresh_' + MODE, '1', 180);
  try { ScriptApp.newTrigger('bgRefresh').timeBased().after(5 * 1000).create(); }
  catch (e) { console.warn('Could not schedule the background refresh: ' + e); c.remove('bg_refresh_' + MODE); }
}

/** Runs a few seconds after a save (see scheduleRefresh_): re-reads everything once, then removes its own trigger. */
function bgRefresh() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'bgRefresh').forEach(t => { try { ScriptApp.deleteTrigger(t); } catch (e) { /* gone */ } });
  CacheService.getScriptCache().remove('bg_refresh_' + MODE);   // a save during this run schedules the next one
  warmCache();
  try { storeMetaData_(true); } catch (e) { console.warn('Meta re-read failed: ' + e); }
}

/** New request: put its lines into HO's "Assign approver" list and the unit's store lines straight away. */
function patchAfterRaise_(unit, clean, made) {
  const sh = fms_();
  // FMS has formulas far below the data, so look for the last row that really has an item (one column: quick)
  const col = sh.getRange(CFG.FIRST_ROW, COL.ITEM, Math.max(1, sh.getLastRow() - CFG.FIRST_ROW + 1), 1).getValues();
  let last = col.length;
  while (last > 0 && String(col[last - 1][0]).trim() === '') last--;
  last = CFG.FIRST_ROW + last - 1;
  if (last < CFG.FIRST_ROW) return;
  const from = Math.max(CFG.FIRST_ROW, last - clean.length - 40);
  const rows = sh.getRange(from, 1, last - from + 1, COL.UOM).getValues();
  const used = {};
  const pad = v => (v < 10 ? '0' : '') + v;
  const now = new Date(), IST = Utilities.formatDate(now, CFG.TZ, 'yyyy-MM-dd|dd-MM HH:mm|dd MMM, HH:mm').split('|');
  const open = [], store = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i];
    let j = rows.length - 1;
    for (; j >= 0; j--) {
      const r = rows[j];
      if (used[j] || normU_(r[COL.UNIT - 1]) !== normU_(unit) || String(r[COL.ITEM - 1]).replace(/\s+/g, ' ').trim() !== l.item || Number(r[COL.QTY - 1]) !== l.qty) continue;
      break;
    }
    if (j < 0) continue;   // not visible in FMS yet: the background refresh will add it
    used[j] = true;
    const r = rows[j], row = from + j, orderNo = String(r[COL.ORDER - 1]).trim() || made[i].orderNo;
    made[i].orderNo = orderNo;
    open.unshift({ row: row, orderNo: orderNo, ts: now.getTime(), when: IST[2], unit: unit, category: l.cat, item: l.item, pic: l.pic || '',
                   qty: l.qty, uom: l.uom, approval: '', approver: '', approvedQty: '', stock: { qty: String(l.stock), uom: l.uom } });
    const sl = { row: row, o: orderNo, d: IST[0], at: IST[1], cat: l.cat, it: l.item, q: l.qty, uom: l.uom, s: '', ap: '', aq: '', rcv: '', inv: '' };
    if (l.pic) sl.pic = l.pic;
    store.unshift(sl);
  }
  if (open.length) patchCache_(OPEN_CACHE, lines => open.concat(lines));
  if (store.length) patchStore_(unit, (ls, d) => { d.lines = store.concat(ls); });
  patchCache_(STORE_CFG.META + '_items_' + normU_(unit), items => {
    clean.forEach(l => { if (!items.some(x => x[0].toLowerCase() === l.item.toLowerCase())) items.unshift([l.item, l.cat, l.uom]); });
    return items;
  });
}

/** Decision: approved lines appear in "Make PO" at once; the unit's store lines show the new status. */
function patchAfterDecide_(done, decision, user, remark) {
  if (!done.length) return;
  if (decision === 'Approved') {
    const add = done.map(d => {
      const r = d.r, ts = r[COL.TS - 1] instanceof Date ? r[COL.TS - 1] : new Date();
      const p = Utilities.formatDate(ts, CFG.TZ, 'yyyy-MM-dd|dd-MM HH:mm').split('|');
      return { row: d.row, o: d.orderNo, d: p[0], at: p[1], u: String(r[COL.UNIT - 1]).trim(), cat: String(r[COL.CAT - 1]).trim(),
               it: String(r[COL.ITEM - 1]).trim(), q: d.qty === null ? Number(r[COL.QTY - 1]) || 0 : d.qty, uom: String(r[COL.UOM - 1]).trim(), ap: user.name, pt: '' };
    });
    patchCache_(PO_CFG.CACHE, data => {
      const have = {}; data.lines.forEach(l => (have[l.row] = true));
      data.lines = add.filter(l => !have[l.row]).concat(data.lines);
      data.v = ver_(data.lines);
      return data;
    });
  }
  done.forEach(d => patchStore_(String(d.r[COL.UNIT - 1]).trim(), ls => ls.forEach(l => {
    if (l.row !== d.row) return;
    l.s = decision; l.ap = user.name; l.aq = d.qty === null ? '' : d.qty;
    if (decision === 'Rejected' && remark) l.rm = remark;
  })));
}
