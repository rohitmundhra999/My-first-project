/**
 * Summit Purchase Reports and Approvals - backend for the purchase approval app.
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
  return json_({ ok: true, app: 'Summit Purchase Reports and Approvals', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const realUser = auth_(req.idToken);
    const handlers = { me: me_, hoList: hoList_, assign: assign_, myList: myList_, decide: decide_, register: register_, reports: reports_, decisions: decisions_, testPush: testPush_ };
    const fn = handlers[req.action];
    if (!fn) throw appError_('BAD_REQUEST', 'Unknown action.');
    const user = previewUser_(realUser, req);
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
    user: { name: user.name, email: user.email, isHO: user.isHO, isApprover: user.isApprover },
    approvers: user.isHO ? activeUsers_().filter(u => u.isApprover).map(u => u.name) : [],
    decisions: DECISIONS,
    mode: MODE,
    // Admin only: everyone in APP USERS, so the admin can preview the app as them.
    admin: admin ? { name: realUser.name, email: realUser.email } : null,
    users: admin ? activeUsers_().map(u => ({ name: u.name, email: u.email, isHO: u.isHO, isApprover: u.isApprover })) : [],
    preview: user.previewBy ? true : false,
  };
}

// ======================= admin preview ("view as") =======================
// The admin (the script owner, or anyone with ADMIN in their APP USERS role) can see the app exactly as
// another user sees it. Preview is READ-ONLY: nothing can be assigned, decided or registered while
// previewing, so the sheet and the APP LOG always show the real person who acted.

const WRITE_ACTIONS = ['assign', 'decide', 'register'];

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
  if (WRITE_ACTIONS.indexOf(req.action) !== -1) throw appError_('PREVIEW', 'This is a preview, so nothing can be changed. Switch back to yourself to make changes.');
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
function activeUsers_() {
  if (USERS_CACHE_) return USERS_CACHE_;
  const sh = book_().getSheetByName(CFG.USERS);
  if (!sh) throw appError_('SETUP', 'The "' + CFG.USERS + '" tab is missing. Run setup() once.');
  USERS_CACHE_ = sh.getDataRange().getValues().slice(1)
    .map(r => ({ name: String(r[0]).trim(), email: String(r[1]).trim().toLowerCase(), role: String(r[2]).toUpperCase(), active: String(r[3]).trim().toUpperCase() }))
    .filter(u => u.name && u.email && u.active !== 'NO')
    .map(u => ({ name: u.name, email: u.email, isHO: /\bHO\b/.test(u.role), isApprover: /APPROVER/.test(u.role), isAdmin: /ADMIN/.test(u.role) }));
  return USERS_CACHE_;
}

function readLines_(keep) {
  const sh = fms_();
  // Only the recent end of FMS matters (LOOKBACK_DAYS). Find the last row that has an order number, then read
  // the last FMS_MAX_ROWS rows above it, instead of every row since January.
  const lastSheetRow = sh.getLastRow();
  if (lastSheetRow < CFG.FIRST_ROW) return [];
  const orders = sh.getRange(CFG.FIRST_ROW, COL.ORDER, lastSheetRow - CFG.FIRST_ROW + 1, 1).getValues();
  let lastData = orders.length;
  while (lastData > 0 && String(orders[lastData - 1][0]).trim() === '') lastData--;
  if (!lastData) return [];
  const startIdx = Math.max(0, lastData - FMS_MAX_ROWS);
  const first = CFG.FIRST_ROW + startIdx, n = lastData - startIdx;
  const values = sh.getRange(first, 1, n, COL.APPR_QTY).getValues();
  const stamps = sh.getRange(first, COL.TS, n, 1).getDisplayValues();
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
// and the app's own assign/decide actions update the copy straight away. The app's ↻ button forces a re-read.
const OPEN_CACHE = 'open_lines_' + MODE;
const OPEN_CACHE_SECONDS = 900;

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
  const s = JSON.stringify(obj), size = 30000,   // ≤ 3 bytes per character keeps each piece under the 100 KB limit
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
  const lines = openLines_(true);
  try { alertNewLines_(lines); } catch (e) { console.error('New-line alert failed: ' + e); }
  reports_(null, { fresh: true });
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
const REPORT_CACHE_SECONDS = 900;              // kept ready by warmCache every 5 minutes; ↻ in the app re-reads

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
  if (hit) return { reports: hit };

  const sh = fms_();
  const n = sh.getLastRow() - CFG.FIRST_ROW + 1;
  const rows = n > 0 ? sh.getRange(CFG.FIRST_ROW, 1, n, 33).getValues() : [];
  const stamps = n > 0 ? sh.getRange(CFG.FIRST_ROW, COL.TS, n, 1).getDisplayValues() : [];
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

  const decided = [];
  const remarks = remarksIndex_();
  const acted = n > 0 ? sh.getRange(CFG.FIRST_ROW, COL.ACTUAL, n, 1).getDisplayValues() : [];
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
    if (status) {
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
  cachePutBig_('reports_' + MODE, out, REPORT_CACHE_SECONDS);
  const dec = { lines: decided.reverse(), from: out.from, asOf: out.asOf, unitMap: out.unitMap };
  cachePutBig_(DEC_CACHE, dec, REPORT_CACHE_SECONDS);
  return { reports: out, decisionsData: dec };
}

// ======================= approval decisions report =======================
// Every line since REPORT_FROM that has a decision (Approved / On Hold / Rejected / Withdrawn), with the
// approver and, for rejections, the reason. Built in the same pass as the PO reports above.
const DEC_CACHE = 'decisions_' + MODE;

function decisions_(user, req) {
  const hit = req && req.fresh ? null : cacheGetBig_(DEC_CACHE);
  if (hit) return { decisions: hit };
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
    const sh = tab_(CFG.USERS, ['Name (exactly as in column L)', 'Email', 'Role (HO / APPROVER / HO+APPROVER)', 'Active (YES / NO)']);
    // Start with the names already allowed in column L (APPROVER).
    const rule = fms_().getRange(CFG.FIRST_ROW, COL.APPROVER).getDataValidation();
    const names = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? rule.getCriteriaValues()[0] : [];
    if (names.length) sh.getRange(2, 1, names.length, 4).setValues(names.map(n => [n, '', 'APPROVER', 'YES']));
    sh.autoResizeColumns(1, 4);
  }
  tab_(CFG.DEVICES, ['Email', 'Token', 'Device', 'Updated']);
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']);
  tab_(CFG.REMARKS, REMARK_HEADER);
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
