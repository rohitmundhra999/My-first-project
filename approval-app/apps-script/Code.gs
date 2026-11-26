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
const MODE = 'LIVE';   // 'TRIAL' = Copy of NONLOCAL PURCHASES,  'LIVE' = NONLOCAL PURCHASES

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
    const handlers = { me: me_, hoList: hoList_, assign: assign_, myList: myList_, decide: decide_, hoDecide: hoDecide_, register: register_,
      reports: (u, r) => scopeReports_(u, reports_(u, r)), decisions: (u, r) => scopeReports_(u, decisions_(u, r)), testPush: testPush_,
      storeMeta: storeMeta_, storeList: storeList_, storeRaise: storeRaise_, storeReceive: storeReceive_, storeInvoice: storeInvoice_,
      invoiceRead: invoiceRead_, sync: sync_, makePO: makePO_, editItem: editItem_, goodsList: goodsList_, goodsSave: goodsSave_, fileData: fileData_, poCancel: poCancel_, poUncancel: poUncancel_, readInvoice: readInvoice_, reqRead: reqRead_, hoReceiveList: hoReceiveList_, rateList: rateList_, rateCompare: rateCompare_, vendorList: vendorList_, vendorSave: vendorSave_, unitPhoneSave: unitPhoneSave_, invoiceReport: invoiceReport_, statementCheck: statementCheck_, fsToken: fsTokenAction_ };
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
      fsAfterWrite_(req.action);   // Firestore copy: the other phones see this save at once
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
    user: { name: user.name, email: user.email, isHO: user.isHO, isApprover: user.isApprover, isStore: user.isStore, isViewer: !!user.isViewer, units: user.units },
    storeUnits: storeUnits_(user),
    storeAll: !user.previewBy && isAdmin_(user),   // trial: the admin can work for every unit
    approvers: user.isHO ? activeUsers_().filter(u => u.isApprover).map(u => u.name) : [],
    decisions: DECISIONS,
    mode: MODE,
    // Admin only: everyone in APP USERS, so the admin can preview the app as them.
    admin: admin ? { name: realUser.name, email: realUser.email } : null,
    users: admin ? activeUsers_().map(u => ({ name: u.name, email: u.email, isHO: u.isHO, isApprover: u.isApprover, isStore: u.isStore, isViewer: !!u.isViewer, units: u.units })) : [],
    preview: user.previewBy ? true : false,
    actAs: user.previewBy ? true : false,   // admin (Rohit) can act as this person, in TRIAL and LIVE
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
  if (w.goods) part('goods', () => goodsList_(user, { fresh: fresh, v: w.goods.v }));
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

const WRITE_ACTIONS = ['assign', 'decide', 'hoDecide', 'register', 'storeRaise', 'storeReceive', 'storeInvoice', 'makePO', 'unitPhoneSave', 'editItem', 'goodsSave', 'vendorSave', 'poCancel', 'poUncancel'];

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
  if (req.action === 'register' || false /* LIVE too: the admin keeps full rights to act as anyone */) {
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

/** HO (temporary): approve / hold / reject lines on behalf of an approver. Each line is first assigned to that
 * approver, then decided exactly as if the approver had done it; the log shows the HO user who did it. */
function hoDecide_(user, req) {
  requireHO_(user);
  const approver = activeUsers_().find(u => u.isApprover && same_(u.name, req.approver));
  if (!approver) throw appError_('BAD_REQUEST', 'Pick an approver from the list.');
  const items = cleanItems_(req.items);
  withLock_(() => {
    const sh = fms_();
    items.forEach(it => {
      const row = sh.getRange(it.row, 1, 1, COL.APPR_QTY).getValues()[0];
      const cur = String(row[COL.APPROVAL - 1]).trim();
      if (String(row[COL.ORDER - 1]).trim() !== it.orderNo || (cur && cur !== 'On Hold')) return;   // decide_ reports these as skipped
      if (!same_(row[COL.APPROVER - 1], approver.name)) sh.getRange(it.row, COL.APPROVER).setValue(approver.name);
    });
    SpreadsheetApp.flush();
  });
  const res = decide_(Object.assign({}, approver, { onBehalfBy: user.email }), req);
  // quick: On Hold lines now show this approver (decided lines already left the list); full re-read in the background
  // (was a full sheet re-read here, 10-20 s on every HO decision)
  const skip = {}; (res.skipped || []).forEach(s => (skip[s.orderNo] = true));
  try { patchOpenLines_(items.filter(it => !skip[it.orderNo]).map(it => it.row), l => { l.approver = approver.name; return l; }); } catch (e) { console.warn('Open list patch failed: ' + e); }
  scheduleRefresh_();
  return res;
}

/** HO: correct the item name of a line that is not decided yet.
 *  FMS B:H come from =QUERY(FORMDATA!A<start>:G) in FMS!B4, so the name is changed in FORMDATA (column D) on the
 *  matching row; FMS and its order no (column A formula) follow by themselves. Nothing in FMS is overwritten.
 *  Refused if: the line is decided, the rows do not match, the name was changed meanwhile, or the new order no
 *  would be the same as another line's (PO look-ups use the order no). */
function editItem_(user, req) {
  requireHO_(user);
  const it = cleanItems_([req])[0];
  const name = String(req.item || '').replace(/\s+/g, ' ').trim();
  const old = String(req.oldItem || '').trim();
  if (!name) throw appError_('BAD_REQUEST', 'Item name cannot be empty.');
  if (name.length > 200) throw appError_('BAD_REQUEST', 'Item name is too long (max 200 letters).');
  const out = withLock_(() => {
    const sh = fms_();
    const row = sh.getRange(it.row, 1, 1, COL.APPR_QTY).getValues()[0];
    if (String(row[COL.ORDER - 1]).trim() !== it.orderNo) throw appError_('CONFLICT', 'This line changed in the sheet. Refresh and try again.');
    if (String(row[COL.APPROVAL - 1]).trim()) throw appError_('CONFLICT', 'Already decided (' + row[COL.APPROVAL - 1] + '): the name can no longer be changed.');
    const cur = String(row[COL.ITEM - 1]).trim();
    if (old && cur !== old) throw appError_('CONFLICT', 'The name was changed in the sheet to "' + cur + '". Refresh and try again.');
    if (cur === name) return { row: it.row, orderNo: it.orderNo, item: name };

    // FMS!B4 = QUERY(FORMDATA!A<start>:G): FMS row r is FORMDATA row r - FIRST_ROW + start
    const m = String(sh.getRange(CFG.FIRST_ROW, COL.TS).getFormula()).match(/FORMDATA!\$?A\$?(\d+)/i);
    if (!m) throw appError_('SETUP', 'FMS!B' + CFG.FIRST_ROW + ' is not the FORMDATA query any more, so the name cannot be changed from the app.');
    const fd = book_().getSheetByName('FORMDATA');
    const fRow = it.row - CFG.FIRST_ROW + Number(m[1]);
    const src = fd.getRange(fRow, 1, 1, 4).getValues()[0];   // A time, B unit, C category, D item
    if (String(src[1]).trim() !== String(row[COL.UNIT - 1]).trim() || String(src[3]).trim() !== cur) {
      throw appError_('CONFLICT', 'Could not find this line in FORMDATA, so nothing was changed.');
    }
    fd.getRange(fRow, 4).setValue(name);
    SpreadsheetApp.flush();
    const orderNo = String(sh.getRange(it.row, COL.ORDER).getValue()).trim();
    const n = sh.getLastRow() - CFG.FIRST_ROW + 1;
    const dup = orderNo && orderNo !== it.orderNo && sh.getRange(CFG.FIRST_ROW, COL.ORDER, n, 1).getValues()
      .some((r, i) => CFG.FIRST_ROW + i !== it.row && String(r[0]).trim() === orderNo);
    if (!orderNo || dup) {
      fd.getRange(fRow, 4).setValue(src[3]);   // put the old name back
      SpreadsheetApp.flush();
      throw appError_('CONFLICT', 'With this name the order no would be ' + (orderNo || 'empty') + ', which another line already has. Use a slightly different name.');
    }
    log_(user, 'EDIT ITEM', it.orderNo + (orderNo !== it.orderNo ? ' -> ' + orderNo : ''), '"' + cur + '" -> "' + name + '" (FORMDATA row ' + fRow + ')');
    return { row: it.row, orderNo: orderNo, item: name };
  });
  patchOpenLines_([out.row], l => { l.item = out.item; l.orderNo = out.orderNo; return l; });
  scheduleRefresh_();   // reports and store lists pick up the new name in the background
  return out;
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
  (() => {   // no app-wide lock: each line has one approver, so approvers never write the same cells
    const sh = fms_();
    // Read every line in one go (much faster than one by one).
    const rws = items.map(it => it.row), lo = Math.min.apply(null, rws), hi = Math.max.apply(null, rws);
    const blk = hi - lo < 3000 ? { lo: lo, v: sh.getRange(lo, 1, hi - lo + 1, COL.APPR_QTY).getValues(),
      f: sh.getRange(lo, COL.ACTUAL, hi - lo + 1, COL.APPR_QTY - COL.ACTUAL + 1).getFormulas() } : null;
    const plan = [];
    items.forEach(it => {
      const row = blk ? blk.v[it.row - blk.lo] : sh.getRange(it.row, 1, 1, COL.APPR_QTY).getValues()[0];
      const current = String(row[COL.APPROVAL - 1]).trim();
      if (String(row[COL.ORDER - 1]).trim() !== it.orderNo) return skipped.push({ orderNo: it.orderNo, why: 'Line moved in the sheet. Refresh and try again.' });
      if (!same_(row[COL.APPROVER - 1], user.name)) return skipped.push({ orderNo: it.orderNo, why: 'This line is assigned to ' + (String(row[COL.APPROVER - 1]).trim() || 'nobody') + ', not you.' });
      if (current && current !== 'On Hold') return skipped.push({ orderNo: it.orderNo, why: 'Already ' + current + '.' });

      let qty = it.qty;
      if (qty === null) qty = Number(row[COL.QTY - 1]) || null;
      if (decision === 'Approved' && !(qty > 0)) return skipped.push({ orderNo: it.orderNo, why: 'Enter a quantity above 0.' });

      const rng = sh.getRange(it.row, COL.ACTUAL, 1, COL.APPR_QTY - COL.ACTUAL + 1);   // J..N
      const fm = blk ? blk.f[it.row - blk.lo] : rng.getFormulas()[0];
      const before = fm.map((f, c) => f || row[COL.ACTUAL - 1 + c]);
      const after = before.slice();
      after[0] = new Date(); after[COL.APPROVAL - COL.ACTUAL] = decision;
      after[COL.APPROVED_BY - COL.ACTUAL] = user.name; after[COL.APPR_QTY - COL.ACTUAL] = qty === null ? '' : qty;
      plan.push({ rng: rng, before: before, after: after, d: { row: it.row, orderNo: it.orderNo, qty: qty, r: row } });
    });
    // Write all lines together. If the sheet refuses any (e.g. a drop-down rule), put them all back exactly as they
    // were, then try line by line so only the refused ones are skipped: a line is never left half saved.
    try { plan.forEach(p => p.rng.setValues([p.after])); SpreadsheetApp.flush(); plan.forEach(p => done.push(p.d)); }
    catch (e) {
      plan.forEach(p => { try { p.rng.setValues([p.before]); } catch (e2) { /* restored below */ } });
      try { SpreadsheetApp.flush(); } catch (e3) { console.error('Restore failed: ' + e3); }
      plan.forEach(p => {
        try { p.rng.setValues([p.after]); SpreadsheetApp.flush(); done.push(p.d); }
        catch (e4) {
          try { p.rng.setValues([p.before]); SpreadsheetApp.flush(); } catch (e5) { console.error('Could not restore row ' + p.d.row + ': ' + e5); }
          skipped.push({ orderNo: p.d.orderNo, why: 'The sheet did not accept it (' + String(e4.message || e4).slice(0, 120) + ')' });
        }
      });
    }
    if (done.length) log_(user, decision.toUpperCase(), done.map(d => d.orderNo + (d.qty !== null ? ' x' + d.qty : '')).join(', '), remark);
    if (done.length && remark) {
      const now = new Date();
      const rs = tab_(CFG.REMARKS, REMARK_HEADER);
      const add = done.map(d => [now, d.orderNo, d.row, String(d.r[COL.UNIT - 1]).trim(), String(d.r[COL.ITEM - 1]).trim(), remark, user.name, user.email]);
      withLock_(() => { rs.getRange(rs.getLastRow() + 1, 1, add.length, REMARK_HEADER.length).setValues(add); SpreadsheetApp.flush(); });   // short lock: new rows only
    }
  })();
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
    .map(u => ({ name: u.name, email: u.email, isHO: /\bHO\b/.test(u.role), isApprover: /APPROVER/.test(u.role), isAdmin: /ADMIN/.test(u.role), isViewer: /VIEWER/.test(u.role),
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
  try { cachePutBig_(INVREP_CACHE, invoiceReportBuild_(), 21600); } catch (e) { console.error('Invoices report cache failed: ' + e); }
  fsTick();   // Firestore copy
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
// Log lines written while the lock is held are kept here and written just after it is released.
let LOG_Q_ = null;
function log_(user, action, lines, note) {
  if (LOG_Q_) { LOG_Q_.push([user, action, lines, note]); return; }
  logNow_(user, action, lines, note);
}
function logNow_(user, action, lines, note) {
  if (user.previewBy) note = (note ? note + ' | ' : '') + 'done by ' + user.previewBy + ' acting as this user (trial)';
  if (user.onBehalfBy) note = (note ? note + ' | ' : '') + 'done by HO ' + user.onBehalfBy + ' on behalf of this approver';
  tab_(CFG.LOG, ['Time', 'Email', 'Name', 'Action', 'Lines', 'Note']).appendRow([new Date(), user.email, user.name, action, lines, note]);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(28000)) throw appError_('BUSY', 'The sheet is busy. Please try again in a moment.');
  const outer = LOG_Q_ === null;
  if (outer) LOG_Q_ = [];
  try { return fn(); }
  finally {
    lock.releaseLock();   // others may go on now; the log is written after
    if (outer) {
      const q = LOG_Q_; LOG_Q_ = null;
      q.forEach(a => { try { logNow_(a[0], a[1], a[2], a[3]); } catch (e) { console.warn('Log failed: ' + e); } });
    }
  }
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
  const cxPO = poCancelIndex_();   // cancelled POs are left out of both reports
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
    if (cxPO[key]) return;                                                         // PO cancelled
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

  const links = poLinks_();   // PO number -> PO PDF link (P.Os tab), so the app can open/download the PO
  const list = t => t.order.filter(k => !t.excluded[k]).map(k => { const p = t.pos[k]; p.link = links[k] || ''; return p; });
  const out = {
    notReceived: list(nr),
    invoicePending: list(ip),
    unitMap: UNIT_MAP.map(x => [x[0], x[1]]),
    from: REPORT_FROM.y + '-' + pad(REPORT_FROM.m) + '-' + pad(REPORT_FROM.d),
    asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm'),
  };
  out.v = ver_([out.notReceived, out.invoicePending]);   // changes only when the report itself changes
  cachePutBig_('reports_' + MODE, out, REPORT_CACHE_SECONDS);
  try { invRepPosSync_(); } catch (e) { console.error('PO report sync failed: ' + e); }   // PO report follows the same read
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
  scheduleRefresh_(); // reports, PO lists and store lists follow any sheet edit within about a minute
  if (firstCol > COL.APPR_QTY) return; // the quick paths below are for columns A-N
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
  MAX_LINES: 100,                // lines in one request
  MAX_PHOTO: 3 * 1024 * 1024,    // bytes after decoding (the app shrinks photos to well under this)
  MAX_FILE: 8 * 1024 * 1024,     // invoice file
  CACHE: 'store_lines_' + MODE,
  META: 'store_meta_' + MODE,
};
const normU_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Units this person may work on. */
/** Every unit: units with requests in the sheet + every unit in the P.O tab's unit list (where GST and address are kept),
 * so a unit added there shows in the app at once. GOODS / ADVERTISEMENT are billing entries, not units. */
function allUnits_() {
  const seen = {}, out = [];
  const add = u => { u = String(u || '').trim(); const k = normU_(u); if (k && !seen[k]) { seen[k] = true; out.push(u); } };
  storeMetaData_().units.forEach(add);
  try { hotelList_().forEach(h => { if (!/^(goods|advertisement)$/.test(normU_(h[0]))) add(h[0]); }); } catch (e) { console.warn('Unit list from P.O tab: ' + e); }
  return out.sort();
}

function storeUnits_(user) {
  if (!user.previewBy && isAdmin_(user)) return allUnits_();
  if (user.isHO) return allUnits_();   // HO can raise a new request for any unit
  if (!user.isStore) return [];
  const known = allUnits_();
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
  const cxPO = poCancelIndex_();
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
    const po = String(r[SCOL.PO - 1]).trim();
    const status = po && cxPO[po.toUpperCase()] ? 'PO Cancelled' : String(r[COL.APPROVAL - 1]).trim();   // a cancelled PO leaves every to-do list
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
    const rate = Number(l.rate) > 0 && Number(l.rate) < 1e8 ? Math.round(Number(l.rate) * 100) / 100 : 0;   // HO: rate from an uploaded document
    return { item: item, cat: cat, uom: uom, qty: qty, stock: isFinite(Number(stock)) ? Number(stock) : stock, photo: l.photo || null, rate: rate };
  });
  if (req.doc) checkFile_(req.doc, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Document');

  // Photos first (slow), outside the lock.
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd-HHmmss');
  clean.forEach((l, i) => { l.pic = l.photo ? saveUpload_(l.photo, 'Item photos', unit + ' ' + stamp + ' ' + (i + 1) + ' ' + l.item) : ''; });

  const made = [];
  // Sent through the PURCHASE FORM itself, not written straight into FORMDATA: Google then keeps every request in time order
  // among the form's own entries. (Rows written straight into FORMDATA were pushed down by later form entries, which moved
  // FMS approvals onto other items.)
  const form = FormApp.openById(STORE_FORM.ID), qs = form.getItems(), fixes = [];
  const pick = (it, v) => {   // the form's own spelling of a list choice ("pcs" -> "Pcs"); null if the list does not have it
    const want = String(v).trim().toLowerCase(), c = it.asListItem().getChoices().map(x => x.getValue()).find(x => String(x).trim().toLowerCase() === want);
    return c === undefined ? null : c;
  };
  // sent 10 at a time, letting go of the lock in between, so a long request does not keep other saves waiting
  for (let b = 0; b < clean.length; b += 10) withLock_(() => {
    clean.slice(b, b + 10).forEach(l => {
      const uom = pick(qs[STORE_FORM.UOM], l.uom), suom = pick(qs[STORE_FORM.STOCK_UOM], l.uom);
      const r = form.createResponse();
      try {
        r.withItemResponse(qs[STORE_FORM.UNIT].asListItem().createResponse(pick(qs[STORE_FORM.UNIT], unit) || unit))
         .withItemResponse(qs[STORE_FORM.CAT].asMultipleChoiceItem().createResponse(l.cat))
         .withItemResponse(qs[STORE_FORM.ITEM].asTextItem().createResponse(l.item))
         .withItemResponse(qs[STORE_FORM.QTY].asTextItem().createResponse(String(l.qty)))
         .withItemResponse(qs[STORE_FORM.STOCK].asTextItem().createResponse(String(l.stock)));
        if (uom) r.withItemResponse(qs[STORE_FORM.UOM].asListItem().createResponse(uom));
        if (suom) r.withItemResponse(qs[STORE_FORM.STOCK_UOM].asListItem().createResponse(suom));
      } catch (e) { throw appError_('BAD_REQUEST', l.item + ': ' + e.message); }
      const t = r.submit().getTimestamp(), cs = Math.floor(t.getMilliseconds() / 10);
      made.push({ orderNo: orderNo_(unit, l.item, t, cs), item: l.item, qty: l.qty, uom: l.uom });
      // what the form cannot take is put into the form's own row afterwards (photo link; a unit missing from its lists)
      const put = {};
      if (l.pic) put[5] = l.pic;
      if (!uom) put[7] = l.uom;
      if (!suom) put[9] = l.uom;
      if (Object.keys(put).length) fixes.push({ ts: t.getTime(), item: l.item, put: put });
    });
  });
  if (fixes.length) { try { fixRaisedRows_(unit, fixes); } catch (e) { console.warn('Raised rows not completed: ' + e); } }
  // FMS picks the new FORMDATA rows up by itself: find them there to learn their FMS row and real order number (after the lock)
  try { patchAfterRaise_(unit, clean, made); } catch (e) { console.warn('Quick update failed: ' + e); }
  if (clean.some(l => l.rate > 0)) {   // rates from the uploaded document -> REQUEST RATES tab (Make PO fills the price from it)
    try { reqRateSave_(unit, clean, made, req.doc ? saveUpload_(req.doc, 'Request documents', unit + ' ' + stamp + ' list') : ''); } catch (e) { console.warn('Request rates not saved: ' + e); }
  }
  log_(user, 'REQUEST', made.map(m => m.orderNo).join(', '), unit + ': ' + made.map(m => m.item + ' x' + m.qty + ' ' + m.uom).join('; '));
  scheduleRefresh_();   // full re-read + "new requirement" alert to HO, in the background
  return { raised: made.length, unit: unit, lines: made };
}

// ----- Storekeeper requests go through the Google Form (PURCHASE FORM (ONLY NON-LOCAL)) -----
const STORE_FORM = { ID: '1s-tUWyDrG8VokWt_ywD2ZO2PAS6UhgwARE3QwuZi6To', UNIT: 0, CAT: 1, ITEM: 2, QTY: 4, UOM: 5, STOCK: 6, STOCK_UOM: 7 };
/** Finds the form's FORMDATA rows for just-sent app requests and fills the cells the form could not (only cells of those rows). */
function fixRaisedRows_(unit, fixes) {
  const sh = book_().getSheetByName(FORMDATA.TAB);
  for (let tries = 0; tries < 8 && fixes.some(f => !f.done); tries++) {
    if (tries) Utilities.sleep(1000);
    SpreadsheetApp.flush();
    const last = lastFilled_(sh, 1), from = Math.max(2, last - 80), rows = sh.getRange(from, 1, last - from + 1, 4).getValues();
    fixes.forEach(f => {
      if (f.done) return;
      for (let j = rows.length - 1; j >= 0; j--) {
        const r = rows[j], ts = r[0] instanceof Date ? r[0].getTime() : 0;
        if (Math.abs(ts - f.ts) > 2000 || normU_(r[1]) !== normU_(unit) || String(r[3]).replace(/\s+/g, ' ').trim() !== f.item) continue;
        Object.keys(f.put).forEach(c => sh.getRange(from + j, Number(c)).setValue(f.put[c]));
        f.done = true; break;
      }
    });
  }
}

/** Storekeeper: received quantity for approved lines that have a PO (FMS AB). */
function storeReceive_(user, req) {
  const items = cleanItems_(req.items);
  const done = [], skipped = [], got = [];
  (() => {   // no app-wide lock: only this line's "received" cell is written
    const sh = fms_();
    const rws = items.map(it => it.row), lo = Math.min.apply(null, rws), hi = Math.max.apply(null, rws);
    const blk = hi - lo < 3000 ? sh.getRange(lo, 1, hi - lo + 1, SCOL.LAST).getValues() : null;   // one read for all lines
    items.forEach(it => {
      const r = blk ? blk[it.row - lo] : sh.getRange(it.row, 1, 1, SCOL.LAST).getValues()[0];
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
  })();
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
  try { invoiceRepPatch_(po, link, amount, invNo, dm[0]); } catch (e) { console.warn('Invoices report patch: ' + e); }
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
  RECENT: 'po_recent_' + MODE,   // lines approved in the last 15 min, so Make PO never misses them while its copy is being rebuilt
  POS: 'P.Os', VENDORS: 'VENDORS', TEMPLATE: 'P.O',
  HOTELS: 'AH4:AL80',            // in the P.O tab: key, hotel name, address, phone, GST
  MAX_LINES: 100,                // the sheet's PO has room for 31 lines; the PDF adds rows for more
  TERMS: ['Advance (20%)', 'Advance (50%)', 'Advance (100%)', 'Normal Credit', 'Within 15 days'],
  COMPANY: 'SUMMIT HOTELS & RESORTS PVT. LTD.',
  COMPANY_ADDR: 'G0402, G Block, City Centre Office Block, Matigara, Siliguri - 734010',
};

/** Approved lines with no PO, grouped by nothing (the app groups by hotel). Kept in the cache; v = content version. */
function poPendingBuild_() {
  const from = Date.now();   // approvals after this moment may not be in this read (poPending_ adds them from RECENT)
  const snap = fmsSnap_();
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v;
  const lines = [];
  let rr = {};
  try { rr = reqRateIndex_(); } catch (e) { console.warn('Request rates not read: ' + e); }
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
      qr: rr[orderNo] || rr['#' + normU_(r[COL.UNIT - 1]) + '|' + rateKey_(r[COL.ITEM - 1])] || undefined,   // rate from the request document
    });
  });
  lines.reverse();   // newest first
  const out = { lines: lines, asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm'), terms: PO_CFG.TERMS, from: from };
  out.v = ver_(lines);
  cachePutBig_(PO_CFG.CACHE, out, OPEN_CACHE_SECONDS);
  return out;
}

function poPending_(v) {
  let data = cacheGetBig_(PO_CFG.CACHE);
  if (!data) data = poPendingBuild_();
  const rec = (cacheGetBig_(PO_CFG.RECENT) || []).filter(x => x.t >= (data.from || 0));
  if (rec.length) {   // approved while this copy was being read: add them
    const have = {}; data.lines.forEach(l => (have[l.row] = true));
    const add = rec.filter(x => !have[x.l.row]).map(x => x.l);
    if (add.length) { data = Object.assign({}, data, { lines: add.concat(data.lines) }); data.v = ver_(data.lines); }
  }
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
    const nk = s => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && ['m','s','ms','the','pvt','private','ltd','limited','llp','co','company','and','inc','corp','corporation'].indexOf(w) < 0).join('');
    const same = vs.find(v => nk(v[0]) === nk(name));
    if (same) throw appError_('BAD_REQUEST', 'This vendor already exists as "' + same[0] + '". Pick it from the list – do not create it again.');
    const nvEmail = String(nv.email || '').trim().toLowerCase();
    if (nvEmail && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(nvEmail)) throw appError_('BAD_REQUEST', 'Enter a valid vendor email.');
    vendor = [name, String(nv.address || '').trim().slice(0, 200), String(nv.phone || '').replace(/[^0-9+ ]/g, '').slice(0, 20), true, nvEmail];
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
    let hotel = hotelInfo_(req.shipTo || unit);
    if (req.shipPhone !== undefined && req.shipPhone !== null) {
      const ph = String(req.shipPhone).replace(/[^0-9+\-\/ ,]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (ph !== hotel.phone) { try { saveUnitPhone_(hotel.key, ph, user); } catch (e) { console.warn('Unit phone not saved: ' + e); } }
      hotel = Object.assign({}, hotel, { phone: ph });
    }
    const billToHotel = hotelInfo_(req.billTo || unit);
    const link = poPdf_({ poNo: poNo, date: now, unit: unit, hotel: hotel, billToHotel: billToHotel, vendor: vendor, vendorEmail: vendorEmailOf_(vendor[0]) || vendor[4] || '', days: days, lines: lines, subtotal: subtotal, discountAmt: discountAmt, total: grand, note: note, terms: terms, by: user.name });

    if (vendor[3] === true) {   // new vendor: add it to VENDORS like the vendor form does
      const vsh = book_().getSheetByName(PO_CFG.VENDORS);
      vsh.getRange(lastFilled_(vsh, 2) + 1, 1, 1, 4).setValues([[now, vendor[0], vendor[1], vendor[2]]]);
      if (vendor[4]) { const es = vendorEmailTab_(); es.getRange(es.getLastRow() + 1, 1, 1, 4).setValues([[vendor[0], vendor[4], now, user.name]]); }   // VENDOR EMAILS
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
    const rec = cacheGetBig_(PO_CFG.RECENT);
    if (rec && rec.some(x => set[x.l.row])) cachePutBig_(PO_CFG.RECENT, rec.filter(x => !set[x.l.row]), 900);   // PO made: not "recently approved" any more
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
    .map(r => { const k = String(r[0]).trim(); return [k, String(r[1]).trim(), String(r[4]).trim(), String(r[2]).trim(), unitPhoneOf_(k, String(r[3]).trim())]; });   // key, name, GST, address, phone
}

function hotelInfo_(unit) {
  const sh = book_().getSheetByName(PO_CFG.TEMPLATE);
  const rows = sh ? sh.getRange(PO_CFG.HOTELS).getValues() : [];
  const key = normU_(unit) === 'headoffice' ? 'goods' : normU_(unit);
  const r = rows.find(x => normU_(x[0]) === key) || rows.find(x => normU_(x[0]) && key.indexOf(normU_(x[0])) === 0);
  return r ? { key: String(r[0]).trim(), name: String(r[1]).trim(), address: String(r[2]).trim(), phone: unitPhoneOf_(String(r[0]).trim(), String(r[3]).trim()), gst: String(r[4]).trim() }
           : { key: unit, name: unit, address: '', phone: unitPhoneOf_(unit, ''), gst: '' };
}

// ----- Unit contact numbers for the PO (tab UNIT PHONES, locked: only the owner edits; the P.O tab is never changed) -----
const UNIT_PHONES = { TAB: 'UNIT PHONES', HEAD: ['Unit key', 'Contact number', 'Updated', 'Updated by'] };
function unitPhones_() {
  if (unitPhones_.memo) return unitPhones_.memo;
  const sh = book_().getSheetByName(UNIT_PHONES.TAB), out = {};
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { const k = normU_(r[0]); if (k) out[k] = String(r[1]).trim(); });
  return (unitPhones_.memo = out);
}
/** The saved number wins over the P.O tab's number (storekeepers change, so HO keeps it current while making a PO). */
/** HO (or admin): change a unit's contact number any time. */
function unitPhoneSave_(user, req) {
  requireHO_(user);
  const key = String(req.key || '').trim();
  if (!hotelList_().some(h => h[0] === key)) throw appError_('BAD_REQUEST', 'Pick a unit from the list.');
  saveUnitPhone_(key, req.phone, user);
  log_(user, 'UNIT PHONE', key, unitPhoneOf_(key, '') || '(cleared)');
  return { hotels: hotelList_() };
}
function unitPhoneOf_(key, fallback) { const v = unitPhones_()[normU_(key)]; return v !== undefined ? v : (fallback || ''); }
function saveUnitPhone_(key, phone, user) {
  key = String(key || '').trim(); phone = String(phone || '').replace(/[^0-9+\-\/ ,]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!key) return;
  const b = book_();
  let sh = b.getSheetByName(UNIT_PHONES.TAB);
  if (!sh) {
    sh = b.insertSheet(UNIT_PHONES.TAB);
    sh.getRange(1, 1, 1, UNIT_PHONES.HEAD.length).setValues([UNIT_PHONES.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  const n = sh.getLastRow() - 1, keys = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => normU_(r[0])) : [];
  const i = keys.indexOf(normU_(key)), row = [[key, "'" + phone, new Date(), user && user.name || '']];
  if (i === -1) sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues(row); else sh.getRange(i + 2, 1, 1, 4).setValues(row);
  unitPhones_.memo = null;
}

/** Makes the PO PDF from a copy of the sheet's P.O tab (same layout, logo and colours) and returns a Drive link. */
function poPdf_(p) {
  const ss = book_();
  const tpl = ss.getSheetByName(PO_CFG.TEMPLATE);
  let sh = null;
  try {
    sh = tpl.copyTo(ss).setName('PO_TMP_' + Date.now() + '_' + Math.floor(Math.random() * 1e4));
    const put = (a1, v) => sh.getRange(a1).setValue(v);
    const extra = Math.max(0, p.lines.length - 31);   // the template has 31 item rows; for more, rows are added in this temporary copy only
    if (extra) {
      sh.insertRowsAfter(53, extra);
      sh.getRange(53, 1, 1, sh.getMaxColumns()).copyTo(sh.getRange(54, 1, extra, sh.getMaxColumns()), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      sh.setRowHeights(54, extra, sh.getRowHeight(53));
    }
    const F = (c, r) => c + (r + extra);   // footer cells move down by the added rows
    sh.getRange('J24:T' + (54 + extra)).clearContent();
    put('J13', '');
    put('S8', "'" + Utilities.formatDate(p.date, CFG.TZ, 'dd-MMM-yy').toUpperCase());
    put('S9', p.poNo);
    put('J9', 'SUMMIT HOTELS AND RESORTS');
    put('J10', PO_CFG.COMPANY_ADDR);
    put('P12', p.hotel.name); put('P13', p.hotel.address);
    put('J15', p.vendor[0]); put('J16', String(p.vendor[1] || '').toUpperCase()); put('J17', p.vendor[2] ? '(M) ' + p.vendor[2] : ''); put('J18', p.vendorEmail ? 'Email: ' + p.vendorEmail : '');
    put('P16', p.billToHotel.name); put('P17', p.billToHotel.address);
    put('P21', p.billToHotel.gst ? 'GST - ' + p.billToHotel.gst : '');
    put('M19', p.days);
    // PHONE box: plain white with black text (the template's box is dark)
    sh.getRange('Q19:U19').setBackground('#ffffff').setFontColor('#000000');
    put('Q19', p.hotel.phone ? "'" + p.hotel.phone : '');
    const n = p.lines.length;
    const col = (c, f) => sh.getRange(c + '24:' + c + (23 + n)).setValues(p.lines.slice(0, n).map(l => [f(l)]));
    if (n) {
      col('J', l => l.orderNo); col('L', l => l.item); col('P', l => l.qty); col('Q', l => l.uom);
      col('R', l => l.price); col('S', l => l.tax); col('T', l => l.total);
    }
    const subtotal = p.subtotal != null ? p.subtotal : p.total;
    put(F('T', 55), subtotal);
    put(F('R', 57), 'DISCOUNT'); put(F('T', 57), p.discountAmt > 0 ? -p.discountAmt : '');
    put(F('T', 59), p.total);
    put(F('J', 56), p.note || '');   // exactly what HO wrote while making the PO (blank if nothing)
    put(F('J', 58), 'Delivery Period'); put(F('L', 58), p.days + (Number(p.days) === 1 ? ' day' : ' days'));
    if (p.terms) put(F('L', 59), p.terms);   // the box beside 'Payment with PO' (K59 is inside the label)
    SpreadsheetApp.flush();
    const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=pdf&gid=' + sh.getSheetId() +
      '&r1=4&c1=9&r2=' + (60 + extra) + '&c2=21&size=A4&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=false' +
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
    const now = Date.now(), byRow = {};
    add.forEach(l => (byRow[l.row] = true));
    const rec = (cacheGetBig_(PO_CFG.RECENT) || []).filter(x => x.t > now - 900000 && !byRow[x.l.row]).concat(add.map(l => ({ t: now, l: l })));
    cachePutBig_(PO_CFG.RECENT, rec, 900);
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


// ======================= Status of goods (HO) + file download/share =======================
// New sheet tab "GOODS STATUS" (made on first save); nothing in FMS or any existing tab is changed.
// One row per update; the latest row of a PO is its current status.

const GOODS_CFG = {
  TAB: 'GOODS STATUS',
  HEADER: ['Time', 'PO No', 'Unit', 'Vendor', 'Status', 'Remark', 'Document', 'Updated By', 'Email'],
  CACHE: 'goods_list3_' + MODE,
  SECONDS: 600,
  STATUSES: ['Order confirmed by vendor', 'Under preparation', 'Dispatched', 'In transit', 'Partially delivered',
    'Delivered to unit', 'Delayed', 'Cancelled', 'Other'],
};

/** PO number -> latest status row. */
function goodsIndex_() {
  const out = {};
  const sh = book_().getSheetByName(GOODS_CFG.TAB);
  if (!sh || sh.getLastRow() < 2) return out;
  const fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'dd MMM yyyy, HH:mm') : String(v || '').trim());
  sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(r => {
    const k = String(r[1]).trim().toUpperCase();
    if (k) out[k] = { st: String(r[4]).trim(), rm: String(r[5]).trim(), doc: String(r[6]).trim(), at: fd(r[0]), by: String(r[7]).trim() };
  });
  return out;
}

/** Every PO made since REPORT_FROM (from FMS column T), with its current goods status. */
function goodsBuild_() {
  const snap = fmsSnap_();
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v;
  const pos = {}, order = [];
  let year = CFG.START_YEAR, prevMonth = 1;
  snap.rows.forEach((r, i) => {
    const m = String(snap.stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;
    prevMonth = mon;
    if (year * 10000 + mon * 100 + day < fromKey) return;
    const key = String(r[19]).trim().toUpperCase();
    if (!key) return;
    let p = pos[key];
    if (!p) {
      const u = normU_(r[2]);
      const mapped = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1));
      p = pos[key] = { po: String(r[19]).trim(), unit: mapped ? mapped[1] : String(r[2]).trim(), cluster: mapped ? mapped[0] : 'Other',
        vendor: String(r[32]).trim(), amount: Number(String(r[20]).replace(/[^0-9.]/g, '')) || 0,
        date: year + '-' + pad(mon) + '-' + pad(day), items: 0, itemNames: [], rcv: 0, inv: 0 };
      order.push(key);
    }
    p.items++;
    if (String(r[27]).trim() !== '') p.rcv++;
    if (String(r[28]).trim().toUpperCase() === 'DONE' || String(r[29]).trim()) p.inv++;
    const item = String(r[COL.ITEM - 1]).trim();
    if (item && p.itemNames.length < 10) p.itemNames.push(item);
  });
  const links = poLinks_();
  // only POs whose material is not fully received; Central Store vendor left out
  // same POs as the Material not received report, and nothing received yet (Central Store already left out there)
  const nr = {};
  ((reports_({}, {}).reports || {}).notReceived || []).forEach(p => (nr[String(p.po).toUpperCase()] = true));
  const list = order.filter(k => nr[k] && String(pos[k].vendor).toLowerCase().replace(/[^a-z]/g, '').indexOf('centralstore') === -1)
    .map(k => Object.assign(pos[k], { link: links[k] || '' }));
  const data = { list: list, unitMap: UNIT_MAP.map(x => [x[0], x[1]]), statuses: GOODS_CFG.STATUSES,
    asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm') };
  cachePutBig_(GOODS_CFG.CACHE, data, GOODS_CFG.SECONDS);
  return data;
}

/** HO: every PO; others: only their own units (same rule as the other reports). */
function goodsList_(user, req) {
  let data = req && req.fresh ? null : cacheGetBig_(GOODS_CFG.CACHE);
  if (!data) data = goodsBuild_();
  const idx = goodsIndex_();
  let list = data.list.map(p => Object.assign({}, p, { g: idx[p.po.toUpperCase()] || null }));
  if (!user.isHO && !user.isApprover && !(!user.previewBy && isAdmin_(user))) {
    if (!user.isStore) list = [];
    else {
      const label = raw => { const u = normU_(raw); const m = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1)); return m ? m[1] : String(raw).trim(); };
      const mine = user.units.map(label);
      list = list.filter(p => mine.indexOf(p.unit) !== -1);
    }
  }
  const out = { list: list.reverse(), unitMap: data.unitMap, statuses: data.statuses, asOf: data.asOf };
  out.v = ver_(out.list);
  if (req && req.v && req.v === out.v) return { same: true, asOf: out.asOf };
  return out;
}

/** HO: save the status of goods of one or more POs, with an optional document. */
function goodsSave_(user, req) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO Purchase can update the status of goods.');
  const pos = (Array.isArray(req.pos) ? req.pos : [req.po]).map(x => String(x || '').trim()).filter(String);
  if (!pos.length) throw appError_('BAD_REQUEST', 'Choose a PO.');
  const st = String(req.status || '').trim();
  if (!st) throw appError_('BAD_REQUEST', 'Choose the status of the goods.');
  const rm = String(req.remark || '').trim().slice(0, 300);
  let doc = '';
  if (req.file) {
    checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'The document');
    doc = saveUpload_(req.file, 'Goods status', 'Goods status ' + pos[0].replace(/[\\/]/g, '-') + ' ' + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HHmm'));
  }
  const data = cacheGetBig_(GOODS_CFG.CACHE) || goodsBuild_();
  const prev = goodsIndex_();
  return withLock_(() => {
    const sh = tab_(GOODS_CFG.TAB, GOODS_CFG.HEADER);
    const now = new Date();
    const rows = pos.map(po => {
      const p = data.list.find(x => x.po.toUpperCase() === po.toUpperCase()) || { unit: '', vendor: '' };
      const keepDoc = doc || (prev[po.toUpperCase()] && prev[po.toUpperCase()].doc) || '';
      return [now, po, p.unit, p.vendor, st, rm, keepDoc, user.name, user.email];
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    log_(user, 'goodsStatus', pos.map(po => ({ orderNo: po })), st);
    return { saved: pos.length, doc: doc };
  });
}

/** A PO / invoice / goods document as base64, so the app can download or share the real file. */
function fileData_(user, req) {
  const m = String(req.url || '').match(/\/d\/([\w-]{20,})|[?&]id=([\w-]{20,})/);
  if (!m) throw appError_('BAD_REQUEST', 'File link not found.');
  const file = DriveApp.getFileById(m[1] || m[2]);
  if (file.getSize() > 15 * 1024 * 1024) throw appError_('BAD_REQUEST', 'The file is too big to share from the app.');
  const blob = file.getBlob();
  return { name: file.getName(), type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

// ======================= Invoice auto-read (Google Gemini, free tier) =======================
// The storekeeper picks the invoice photo/PDF; this reads invoice number, date and total so the form fills itself.
// The key is kept in Project Settings > Script properties as GEMINI_KEY (never in the code).

function invoiceRead_(user, req) {
  if (!storeUnits_(user).length) throw appError_('FORBIDDEN', 'You are not set up as a storekeeper.');
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw appError_('BAD_REQUEST', 'Invoice auto-read is not switched on yet.');
  const f = req.file || {};
  if (!/^(image\/|application\/pdf)/.test(String(f.type || '')) || !f.data) throw appError_('BAD_REQUEST', 'Choose a photo or PDF.');
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: f.type, data: f.data } },
      { text: 'This is an Indian GST purchase invoice. Read: invoiceNo (the invoice number as printed), ' +
              'date (invoice date as YYYY-MM-DD), amount (final grand total payable in rupees, a number, no commas), ' +
              'vendor (seller name). Use empty string / 0 for anything you cannot read.' },
    ] }],
    generationConfig: {
      temperature: 0, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: {
        invoiceNo: { type: 'STRING' }, date: { type: 'STRING' }, amount: { type: 'NUMBER' }, vendor: { type: 'STRING' } },
        required: ['invoiceNo', 'date', 'amount', 'vendor'] },
    },
  };
  const models = ['gemini-2.5-flash', 'gemini-flash-latest'];
  let last = '';
  for (let i = 0; i < models.length; i++) {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) {
      try {
        const txt = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
        const o = JSON.parse(txt);
        return {
          invoiceNo: String(o.invoiceNo || '').trim().slice(0, 40),
          date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : '',
          amount: Number(o.amount) > 0 ? Math.round(Number(o.amount) * 100) / 100 : 0,
          vendor: String(o.vendor || '').trim().slice(0, 80),
        };
      } catch (e) { last = 'could not read the reply'; continue; }
    }
    last = code === 429 ? 'free limit reached, try again in a minute' : 'error ' + code;
    if (code !== 404) break;
  }
  throw appError_('BAD_REQUEST', 'Auto-read failed (' + last + '). Please type the details.');
}

/** Run once from the editor after saving GEMINI_KEY: checks the key works. */
function testInvoiceAI() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) return console.log('GEMINI_KEY is not set.');
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: [{ text: 'Reply OK' }] }] }) });
  console.log(r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
}

// ======================= AI: invoice auto-read (Google Gemini, free tier) =======================
// When a storekeeper picks the invoice photo/PDF, the app sends it here; Gemini reads the invoice
// number, date and grand total and the app fills the form. The storekeeper checks and then uploads.
// Nothing is written to the sheet here.
// Script properties: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default below).

const AI_CFG = { MODELS: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-flash-lite-latest'] };   // each model has its own free daily limit; next one is tried when one is busy/used up

function readInvoice_(user, req) {
  checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Invoice file');
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw appError_('SETUP', 'AI invoice reading is not set up yet. Please type the details.');
  const models = prop_('GEMINI_MODEL', '') ? [prop_('GEMINI_MODEL')] : AI_CFG.MODELS;
  const prompt = 'This is a purchase invoice / tax invoice / bill from an Indian vendor. Read it and return: ' +
    'invoiceNo = the invoice or bill number exactly as printed (not the PO, GSTIN, challan or order number); ' +
    'date = the invoice date as YYYY-MM-DD (Indian dates are day/month/year); ' +
    'amount = the final grand total payable in rupees including GST, as a plain number. ' +
    'Use an empty string or 0 for anything you cannot read clearly.';
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: req.file.type, data: req.file.data } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { invoiceNo: { type: 'STRING' }, date: { type: 'STRING' }, amount: { type: 'NUMBER' } },
        required: ['invoiceNo', 'date', 'amount'] }
    }
  };
  let res, code;
  for (let k = 0; k < models.length; k++) {
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[k]) + ':generateContent',
      { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
    code = res.getResponseCode();
    if (code !== 429 && code !== 503 && code !== 404) break;
  }
  if (code === 429) throw appError_('BUSY', 'AI is busy right now. Please type the details or try again in a minute.');
  if (code !== 200) { console.warn('Gemini ' + code + ': ' + res.getContentText().slice(0, 500)); throw appError_('AI', 'AI could not read this invoice. Please type the details.'); }
  let out = {};
  try {
    const j = JSON.parse(res.getContentText());
    out = JSON.parse(j.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || '').join(''));
  } catch (e) { throw appError_('AI', 'AI could not read this invoice. Please type the details.'); }

  const no = String(out.invoiceNo || '').trim().slice(0, 40);
  const dm = String(out.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let date = '';
  if (dm) {
    const d = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    if (d.getMonth() === +dm[2] - 1 && d.getTime() <= Date.now() + 86400000 && +dm[1] > 2000) date = dm[0];
  }
  const amount = Number(out.amount) > 0 && Number(out.amount) < 1e9 ? Math.round(Number(out.amount) * 100) / 100 : 0;
  return { invoiceNo: no, date: date, amount: amount };
}


// ======================= HO: New request from a document (AI) =======================
// HO uploads a requirement list / vendor quotation (photo, PDF, or Excel sent as text; Hindi or English).
// AI lists the items with qty, unit and rate (blank when not written). HO checks and edits the list in the app,
// then it is sent as a normal New request (storeRaise). Nothing is written here.
function reqRead_(user, req) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO can do this.');
  const meta = storeMetaData_();
  const parts = [];
  if (req.text) parts.push({ text: 'Document (from an Excel file):\n' + String(req.text).slice(0, 60000) });
  else {
    checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Document');
    parts.push({ inline_data: { mime_type: req.file.type, data: req.file.data } });
  }
  parts.push({ text: 'This is a purchase requirement list or a vendor quotation for an Indian hotel (often vegetables, fruits, grocery). ' +
    'It may be handwritten, in Hindi, Hinglish or English. List every item line. ' +
    'item = the item name in clear professional English (translate Hindi, e.g. "आलू" -> "Potato", "धनिया पत्ता" -> "Coriander Leaves"; fix spelling; keep size, grade or brand words). ' +
    'qty = the quantity as a number (0 if not written). ' +
    'uom = the unit, taken from this list when it fits: ' + meta.uoms.join(', ') + ' (kilo/kg/केजी = KG, gram = GM, nag/pieces = PCS, litre = LTR, गड्डी = bunch); otherwise as written. ' +
    'rate = the rate per unit in rupees, as a plain number, ONLY if it is written in the document; otherwise 0. Never guess a rate. ' +
    'category = the best fitting one from this list: ' + meta.categories.join(', ') + '. ' +
    'Skip totals, headings, dates, names, signatures and GST lines.' });
  const out = geminiJson_(parts, { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT',
    properties: { item: { type: 'STRING' }, qty: { type: 'NUMBER' }, uom: { type: 'STRING' }, rate: { type: 'NUMBER' }, category: { type: 'STRING' } },
    required: ['item', 'qty', 'uom', 'rate', 'category'] } } }, required: ['items'] }, AI_CFG.MODELS);
  const fit = (v, list) => { const w = String(v || '').trim().toLowerCase(); return list.find(x => String(x).toLowerCase() === w) || ''; };
  const all = (out.items || []).map(x => ({
    item: String(x.item || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    qty: Number(x.qty) > 0 ? Math.round(Number(x.qty) * 1000) / 1000 : '',
    uom: fit(x.uom, meta.uoms) || String(x.uom || '').trim().slice(0, 15),
    rate: Number(x.rate) > 0 && Number(x.rate) < 1e8 ? Math.round(Number(x.rate) * 100) / 100 : '',
    cat: fit(x.category, meta.categories)
  })).filter(x => x.item);
  return { items: all.slice(0, STORE_CFG.MAX_LINES), total: all.length };
}

// REQUEST RATES tab (locked, only the owner edits): rates taken from a document uploaded with a New request.
//   A Date, B Order No, C Unit, D Item, E Qty, F UOM, G Rate, H Document. Make PO fills the price from here.
const REQRATE_CFG = { TAB: 'REQUEST RATES', HEAD: ['Date', 'Order No', 'Unit', 'Item', 'Qty', 'UOM', 'Rate', 'Document'], CACHE: 'reqrate_' + MODE };

function reqRateTab_() {
  const b = book_();
  let sh = b.getSheetByName(REQRATE_CFG.TAB);
  if (!sh) {
    sh = b.insertSheet(REQRATE_CFG.TAB);
    sh.getRange(1, 1, 1, REQRATE_CFG.HEAD.length).setValues([REQRATE_CFG.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return sh;
}

function reqRateSave_(unit, clean, made, docLink) {
  const now = new Date(), rows = [];
  clean.forEach((l, i) => { if (l.rate > 0 && made[i]) rows.push([now, made[i].orderNo, unit, l.item, l.qty, l.uom, l.rate, docLink || '']); });
  if (!rows.length) return;
  const sh = reqRateTab_();
  sh.getRange(lastFilled_(sh, 2) + 1, 1, rows.length, 8).setValues(rows);
  CacheService.getScriptCache().remove(REQRATE_CFG.CACHE);
}

/** order no -> rate, and '#unit|item' -> rate (in case HO later edits the item name, which changes the order no) */
function reqRateIndex_() {
  const hit = cacheGetBig_(REQRATE_CFG.CACHE);
  if (hit) return hit;
  const sh = book_().getSheetByName(REQRATE_CFG.TAB), idx = {};
  if (sh) {
    const last = lastFilled_(sh, 2);
    if (last >= 2) sh.getRange(2, 2, last - 1, 6).getValues().forEach(r => {
      const rate = Number(r[5]);
      if (!(rate > 0)) return;
      if (String(r[0]).trim()) idx[String(r[0]).trim()] = rate;
      idx['#' + normU_(r[1]) + '|' + rateKey_(r[2])] = rate;
    });
  }
  cachePutBig_(REQRATE_CFG.CACHE, idx, 21600);
  return idx;
}

// ======================= HO: material not received (all units) =======================
// ho.purchase sees every unit's PO lines still to be received and can mark them received (same as the store).

function hoReceiveList_(user, req) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO can see this.');
  const names = allUnits_();   // every unit (same list as the drop-downs), so this matches the Material not received report
  let byUnit = null;
  if (req && req.fresh) byUnit = storeLines_();
  const lines = [], pol = {};
  let asOf = '';
  unique_(names.map(normU_)).forEach(u => {
    let d;
    if (byUnit) d = cacheGetBig_(storeKey_(u));
    else { d = cacheGetBig_(storeKey_(u)); if (!d) { byUnit = storeLines_(); d = cacheGetBig_(storeKey_(u)); } }
    if (!d) return;
    asOf = asOf || d.asOf;
    const name = names.find(k => normU_(k) === u) || u;
    d.lines.forEach(l => { if (l.s === 'Approved' && l.po && l.rcv === '') lines.push(Object.assign({ u: name }, l)); });
    Object.assign(pol, d.pol || {});
  });
  return { lines: lines, pol: pol, asOf: asOf };
}

// ======================= HO: Check rates (last purchase rate + GST, AI quote comparison) =======================
// ITEM RATES tab (locked, only the owner edits): one row per PO line.
//   A Date, B PO No, C Unit, D Vendor, E Item, F Qty, G UOM, H Rate, I GST %, J Source (App / PDF)
// - every PO made in the app adds its lines (rateSavePO_, called from makePO_)
// - old PO PDFs are read once by AI in the background (rateBackfill, hourly trigger; switches itself off when done)

const RATE_CFG = { TAB: 'ITEM RATES', HEAD: ['Date', 'PO No', 'Unit', 'Vendor', 'Item', 'Qty', 'UOM', 'Rate', 'GST %', 'Source'],
  CACHE: 'rate_index_' + MODE, BF_MODELS: ['gemini-3.1-flash-lite', 'gemini-3.5-flash'], BF_PER_RUN: 150, BF_PARALLEL: 8 };

function rateTab_() {
  const b = book_();
  let sh = b.getSheetByName(RATE_CFG.TAB);
  if (!sh) {
    sh = b.insertSheet(RATE_CFG.TAB);
    sh.getRange(1, 1, 1, RATE_CFG.HEAD.length).setValues([RATE_CFG.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return sh;
}

/** Called from makePO_ after the PO is saved. lines: [{unit, item, qty, uom, price, tax}] */
function rateSavePO_(poNo, date, vendor, lines) {
  const sh = rateTab_();
  sh.getRange(lastFilled_(sh, 2) + 1, 1, lines.length, 10)
    .setValues(lines.map(l => [date, poNo, l.unit, vendor, l.item, l.qty, l.uom, l.price, l.tax, 'App']));
  CacheService.getScriptCache().remove(RATE_CFG.CACHE);
}

const rateKey_ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** item key -> last 5 purchases, newest first: [date, po, unit, vendor, qty, uom, rate, gst] ; names: display names */
function rateIndex_() {
  const hit = cacheGetBig_(RATE_CFG.CACHE);
  if (hit) return hit;
  const sh = rateTab_(), last = lastFilled_(sh, 2);
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 10).getValues() : [];
  rows.sort((a, b) => new Date(b[0]) - new Date(a[0]));
  const idx = {}, names = {};
  rows.forEach(r => {
    const k = rateKey_(r[4]);
    if (!k || !(Number(r[7]) > 0)) return;
    if (!idx[k]) { idx[k] = []; names[k] = String(r[4]).trim(); }
    if (idx[k].length < 5) idx[k].push([r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'yyyy-MM-dd') : String(r[0]).slice(0, 10),
      String(r[1]), String(r[2]), String(r[3]), Number(r[5]) || '', String(r[6]), Number(r[7]), r[8] === '' ? '' : Number(r[8])]);
  });
  const out = { idx: idx, names: names, asOf: Utilities.formatDate(new Date(), CFG.TZ, 'dd MMM yyyy, HH:mm'), count: rows.length };
  cachePutBig_(RATE_CFG.CACHE, out, 1800);
  return out;
}

function rateList_(user) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO can see this.');
  const d = rateIndex_(), st = rateBfStatus_();
  // PO number -> [PO file link, invoice link], for the POs shown in Check rates (View PO / View invoice)
  const pol = poLinks_(), ivx = invoiceIndex_(), lk = {};
  Object.keys(d.idx).forEach(k => d.idx[k].forEach(x => {
    const p = String(x[1]).trim().toUpperCase();
    if (!p || lk[p]) return;
    const a = pol[p] || '', b = (ivx[p] && ivx[p].l) || '';
    if (a || b) lk[p] = [a, b];
  }));
  return { idx: d.idx, names: d.names, asOf: d.asOf, count: d.count, backfill: st, lk: lk };
}

/** Gemini call with a JSON schema; tries the models in order when one is busy. */
function geminiJson_(parts, schema, models) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw appError_('SETUP', 'AI is not set up yet.');
  const body = { contents: [{ parts: parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } };
  let res, code;
  for (let k = 0; k < models.length; k++) {
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[k]) + ':generateContent',
      { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
    code = res.getResponseCode();
    if (code !== 429 && code !== 503 && code !== 404) break;
  }
  if (code === 429) throw appError_('BUSY', 'AI daily/minute limit reached. Please try again later.');
  if (code !== 200) { console.warn('Gemini ' + code + ': ' + res.getContentText().slice(0, 500)); throw appError_('AI', 'AI could not read this file.'); }
  try {
    const j = JSON.parse(res.getContentText());
    return JSON.parse(j.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text || '').join(''));
  } catch (e) { throw appError_('AI', 'AI could not read this file.'); }
}

/** HO uploads a vendor quotation (photo / PDF, or Excel sent as text); AI reads the items and matches them to past items. */
function rateCompare_(user, req) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO can do this.');
  const parts = [];
  if (req.text) parts.push({ text: 'Vendor quotation (from an Excel file):\n' + String(req.text).slice(0, 60000) });
  else {
    checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Quotation file');
    parts.push({ inline_data: { mime_type: req.file.type, data: req.file.data } });
  }
  const d = rateIndex_();
  const keys = Object.keys(d.names).slice(0, 4000);
  parts.push({ text: 'Read every item line of this vendor quotation / invoice / rate list. For each line give: item (name as written), qty (0 if none), ' +
    'uom, rate (price per unit in rupees BEFORE GST; 0 if not given), gst (GST % if given, else -1), and match = the item from the KNOWN ITEMS list below ' +
    'that is the same product (similar names, spelling, abbreviations, size written differently are fine; it must be the same product and size). ' +
    'Copy the match exactly from the list, or empty string if none is the same product. Skip totals, taxes, freight lines.\nKNOWN ITEMS:\n' +
    keys.map(k => d.names[k]).join('\n') });
  const out = geminiJson_(parts, { type: 'OBJECT', properties: { vendor: { type: 'STRING' }, items: { type: 'ARRAY', items: { type: 'OBJECT',
    properties: { item: { type: 'STRING' }, qty: { type: 'NUMBER' }, uom: { type: 'STRING' }, rate: { type: 'NUMBER' }, gst: { type: 'NUMBER' }, match: { type: 'STRING' } },
    required: ['item', 'rate', 'match'] } } }, required: ['items'] }, AI_CFG.MODELS);
  const rows = (out.items || []).slice(0, 200).map(it => {
    const k = rateKey_(it.match);
    const hist = k && d.idx[k] ? d.idx[k] : null;
    return { item: String(it.item || '').slice(0, 150), qty: Number(it.qty) || '', uom: String(it.uom || '').slice(0, 20), rate: Number(it.rate) || 0,
             gst: Number(it.gst) >= 0 ? Number(it.gst) : '', match: hist ? d.names[k] : '', last: hist ? hist[0] : null };
  });
  return { vendor: String(out.vendor || '').slice(0, 100), rows: rows };
}

// ---------- one-time background read of old PO PDFs ----------

function rateBfStatus_() {
  const p = PropertiesService.getScriptProperties();
  return { next: Number(p.getProperty('RATE_BF_NEXT_' + MODE) || 0), done: p.getProperty('RATE_BF_DONE_' + MODE) === '1' };
}

/** Run once by hand: creates ITEM RATES and starts the hourly background reading of old PO PDFs. */
function startRateBackfill() {
  rateTab_();
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('RATE_BF_NEXT_' + MODE)) {
    const pos = book_().getSheetByName(PO_CFG.POS);
    p.setProperty('RATE_BF_NEXT_' + MODE, String(lastFilled_(pos, 2)));   // start from the newest PO and go back
  }
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'rateBackfill').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('rateBackfill').timeBased().everyMinutes(15).create();
  rateBackfill();
}

function rateBackfill() {
  // Stopped for good (14 Nov 2026, owner's request): no more AI reading of old POs into ITEM RATES.
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'rateBackfill').forEach(t => ScriptApp.deleteTrigger(t));
  return;
  const c = CacheService.getScriptCache();
  if (c.get('rate_bf_running')) return;   // (no script lock: the app's saves must never wait for this)
  c.put('rate_bf_running', '1', 330);
  try {
    const p = PropertiesService.getScriptProperties(), K = 'RATE_BF_NEXT_' + MODE;
    let row = Number(p.getProperty(K) || 0);
    const t0 = Date.now(), pos = book_().getSheetByName(PO_CFG.POS), sh = rateTab_();
    const fl = fms_().getLastRow(), unitOf = {};
    fms_().getRange(1, 1, fl, 3).getValues().forEach(r => { if (r[0]) unitOf[String(r[0]).trim()] = String(r[2]).trim(); });
    const have = {}, rl = lastFilled_(sh, 2);
    if (rl >= 2) sh.getRange(2, 2, rl - 1, 1).getValues().forEach(r => (have[String(r[0]).trim().toUpperCase()] = true));
    const key = prop_('GEMINI_API_KEY');
    const prompt = 'This is a purchase order. List every item line: item name, qty, uom, rate (unit price before GST, rupees), gst (tax %, -1 if not shown). Skip freight, transport, packing, loading and other charges.';
    const schema = { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { item: { type: 'STRING' }, qty: { type: 'NUMBER' },
      uom: { type: 'STRING' }, rate: { type: 'NUMBER' }, gst: { type: 'NUMBER' } }, required: ['item', 'rate'] } } }, required: ['items'] };
    const req = (model, b64) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: b64 } }, { text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }) });
    let total = 0, limited = false;
    while (row >= 2 && !limited && total < RATE_CFG.BF_PER_RUN && Date.now() - t0 < 180000) {
      // next batch: up to BF_PARALLEL unread POs, read by AI at the same time
      const batch = [];
      while (row >= 2 && batch.length < RATE_CFG.BF_PARALLEL) {
        const r = pos.getRange(row, 1, 1, 8).getValues()[0], po = String(r[1]).trim(), id = (String(r[2]).match(/[-\w]{25,}/) || [])[0];
        const at = row; row--;
        if (!po || !id || have[po.toUpperCase()]) continue;
        have[po.toUpperCase()] = true;
        let blob;
        try { blob = DriveApp.getFileById(id).getBlob(); } catch (e) { continue; }
        if (blob.getContentType() !== 'application/pdf' || blob.getBytes().length > 8 * 1024 * 1024) continue;
        batch.push({ r: r, po: po, at: at, b64: Utilities.base64Encode(blob.getBytes()) });
      }
      if (!batch.length) break;
      let res = UrlFetchApp.fetchAll(batch.map(b => req(RATE_CFG.BF_MODELS[0], b.b64)));
      const busy = res.map((x, i) => [429, 503].indexOf(x.getResponseCode()) !== -1 ? i : -1).filter(i => i >= 0);
      if (busy.length) {   // the 1st model is at its limit: try the 2nd for those
        const res2 = UrlFetchApp.fetchAll(busy.map(i => req(RATE_CFG.BF_MODELS[1], batch[i].b64)));
        busy.forEach((i, k) => (res[i] = res2[k]));
      }
      const out = [];
      batch.forEach((b, i) => {
        const code = res[i].getResponseCode();
        if (code === 429 || code === 503) { limited = true; delete have[b.po.toUpperCase()]; row = Math.max(row, b.at); return; }   // free limit: this PO again next run
        if (code !== 200) return;
        let items = [];
        try { const j = JSON.parse(res[i].getContentText()); items = JSON.parse(j.candidates[0].content.parts.filter(x => !x.thought).map(x => x.text || '').join('')).items || []; } catch (e) { return; }
        const date = b.r[3] instanceof Date ? b.r[3] : new Date(b.r[3]);
        const unit = String(b.r[7]).trim() || unitOf[String(b.r[0]).trim()] || '';
        items.filter(x => x.item && Number(x.rate) > 0).forEach(x => out.push([isNaN(date) ? '' : date, b.po, unit, String(b.r[4]).trim(), String(x.item).trim(),
          Number(x.qty) || '', String(x.uom || ''), Number(x.rate), Number(x.gst) >= 0 ? Number(x.gst) : '', 'PDF']));
        total++;
      });
      if (out.length) sh.getRange(lastFilled_(sh, 2) + 1, 1, out.length, 10).setValues(out);
      p.setProperty(K, String(row));
    }
    if (row < 2) {
      p.setProperty('RATE_BF_DONE_' + MODE, '1');
      ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'rateBackfill').forEach(t => ScriptApp.deleteTrigger(t));
    }
    if (total) CacheService.getScriptCache().remove(RATE_CFG.CACHE);
  } finally { c.remove('rate_bf_running'); }
}


// ======================= HO: Vendors report (VENDORS tab + email in VENDOR EMAILS) =======================
// Name, address, phone, payment cycle and "deals with" come from the VENDORS tab. HO (or the admin) can edit the
// address, phone and email: address/phone are written on that vendor's VENDORS row(s); the email is kept in a new
// tab VENDOR EMAILS (locked, only the owner edits), so the VENDORS tab keeps its columns. New POs print all of it.
const VEND_CFG = { TAB: 'VENDOR EMAILS', HEAD: ['Vendor', 'Email', 'Updated', 'Updated by'] };

// Every user can see the Vendors tab; only HO and the admin can edit vendor details (every user can run the statement check).
function canVendors_(u) { if (!u) throw appError_('FORBIDDEN', 'Please sign in.'); }
function canEditVendors_(u) { if (!u.isHO && !isAdmin_(u)) throw appError_('FORBIDDEN', 'Only HO can change vendor details.'); }
// A storekeeper (not HO / approver / admin) sees invoices and POs of their own unit(s) only.
function vendorUnitsOnly_(u) { return (u.isHO || u.isApprover || u.isViewer || isAdmin_(u)) ? null : (u.units || []).map(x => String(x).trim().toLowerCase()); }

function vendorEmailTab_() {
  const b = book_();
  let sh = b.getSheetByName(VEND_CFG.TAB);
  if (!sh) {
    sh = b.insertSheet(VEND_CFG.TAB);
    sh.getRange(1, 1, 1, VEND_CFG.HEAD.length).setValues([VEND_CFG.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return sh;
}

/** vendor name (lower case) -> email */
function vendorEmails_() {
  const sh = book_().getSheetByName(VEND_CFG.TAB), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => {
    const k = String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase();
    if (k) out[k] = String(r[1]).trim();
  });
  return out;
}
function vendorEmailOf_(name) { return vendorEmails_()[String(name || '').replace(/\s+/g, ' ').trim().toLowerCase()] || ''; }

function vendorList_(user) {
  canVendors_(user);
  const sh = book_().getSheetByName(PO_CFG.VENDORS), em = vendorEmails_(), seen = {}, list = [];
  if (sh && sh.getLastRow() >= 2) sh.getRange(2, 2, sh.getLastRow() - 1, 5).getValues().forEach(r => {
    const name = String(r[0]).replace(/\s+/g, ' ').trim(), k = name.toLowerCase();
    if (!name) return;
    const v = { name: name, address: String(r[1]).trim(), phone: String(r[2]).trim(), cycle: String(r[3]).trim(), deals: String(r[4]).trim(), email: em[k] || '' };
    if (seen[k] !== undefined) { const o = list[seen[k]]; ['address', 'phone', 'cycle', 'deals'].forEach(f => { if (!o[f] && v[f]) o[f] = v[f]; }); return; }
    seen[k] = list.length; list.push(v);
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { list: list };
}

/** Edit a vendor's address, phone and email. */
function vendorSave_(user, req) {
  canEditVendors_(user);
  const name = String(req.vendor || '').replace(/\s+/g, ' ').trim(), k = name.toLowerCase();
  const address = String(req.address || '').replace(/\s+/g, ' ').trim();
  const phone = String(req.phone || '').replace(/[^0-9+ ,\/-]/g, '').trim();
  const email = String(req.email || '').trim().toLowerCase();
  if (!name) throw appError_('BAD_REQUEST', 'Choose the vendor.');
  if (address.length > 200) throw appError_('BAD_REQUEST', 'The address is too long (max 200 letters).');
  if (phone.length > 40) throw appError_('BAD_REQUEST', 'The phone number is too long.');
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(email)) throw appError_('BAD_REQUEST', 'Enter a valid email address.');
  const vsh = book_().getSheetByName(PO_CFG.VENDORS);
  if (!vsh || vsh.getLastRow() < 2) throw appError_('SETUP', 'Tab VENDORS not found.');
  const es = vendorEmailTab_();
  withLock_(() => {
    const names = vsh.getRange(2, 2, vsh.getLastRow() - 1, 1).getValues();
    let hits = 0;
    names.forEach((r, i) => {
      if (String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase() !== k) return;
      vsh.getRange(i + 2, 3, 1, 2).setValues([[address, phone]]);   // VENDORS C address, D contact number
      hits++;
    });
    if (!hits) throw appError_('BAD_REQUEST', name + ' was not found in VENDORS.');
    const last = es.getLastRow();
    const en = last >= 2 ? es.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase()) : [];
    const at = en.indexOf(k);
    const row = [name, email, new Date(), user.name];
    if (at >= 0) es.getRange(at + 2, 1, 1, 4).setValues([row]); else es.getRange(last + 1, 1, 1, 4).setValues([row]);
    log_(user, 'VENDOR EDIT', name, 'Address: ' + address + ' | Phone: ' + phone + ' | Email: ' + (email || '-'));
  });
  return { vendor: { name: name, address: address, phone: phone, email: email } };
}

// ======================= HO: Invoices report (INVOICES tab + the PO each invoice is for) =======================
/** Every uploaded invoice since the sheet started (latest first) with its PO (P.Os tab) and the vendor's details. HO and admin only. */
function invoiceReportBuild_() {
  const user = { isHO: true };   // internal: lets vendorList_ give the vendors' details
  const b = book_(), fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  const url = v => (/^https?:\/\//.test(String(v)) ? String(v).trim() : '');
  // PO number -> details (P.Os: A order no, B PO no, C link, D date, E vendor, F days, G total, H unit; one row per line)
  const po = {}, ps = b.getSheetByName(STORE_CFG.POS);
  if (ps && ps.getLastRow() >= 2) {
    const last = ps.getLastRow(), first = 2;   // whole P.Os tab (Invoices report shows every invoice)
    ps.getRange(first, 1, last - first + 1, 8).getValues().forEach(r => {
      const k = String(r[1]).trim().toUpperCase();
      if (!k) return;
      const p = po[k] || (po[k] = { no: String(r[1]).trim(), l: '', d: '', v: '', t: 0, u: '', n: 0 });
      p.n++; if (!p.l) p.l = url(r[2]); if (!p.d) p.d = fd(r[3]); if (!p.v) p.v = String(r[4]).trim();
      if (!p.t) p.t = Number(String(r[6]).replace(/[^0-9.]/g, '')) || 0; if (!p.u && !/^#/.test(String(r[7]))) p.u = String(r[7]).trim();
    });
  }
  const pu = poUnits_();   // PO -> unit, only POs of FMS lines dated from REPORT_FROM
  const now = new Date(), fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
  const when = v => { if (v instanceof Date) return v; const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
  const rows = [], is = b.getSheetByName(STORE_CFG.INVOICES);
  if (is) {
    const last = lastFilled_(is, 1), first = 2;   // whole INVOICES tab, from the day the sheet started
    if (last >= 2) is.getRange(first, 1, last - first + 1, 6).getValues().forEach(r => {
      const k = String(r[0]).trim().toUpperCase();
      if (!k) return;
      // no date rule here: the Invoices report lists every invoice ever uploaded (other reports keep the 1 April 2026 rule)
      const p = po[k] || {};
      rows.push({ po: String(r[0]).trim(), il: url(r[1]), up: fd(r[2]), amt: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0,
        inv: String(r[4]).trim(), idt: fd(r[5]), v: p.v || '', u: pu[k] || p.u || '', pd: p.d || '', pt: p.t || 0, pl: p.l || '', pn: p.n || 0 });
    });
  }
  const liveRows = rows.slice();   // PO report counts only this sheet's invoices (unchanged)
  const seen = {};
  rows.forEach(r => { seen[String(r.po).toUpperCase() + '|' + r.il] = 1; });
  rows.unshift.apply(rows, oldInvoiceRows_(seen));   // last year's invoices go below this sheet's (latest first)
  const ua = poUnitsAll_();   // unit of every PO ever made (this FMS + old sheets' FMS), for invoices of older POs
  rows.forEach(r => { if (!r.u || /^#/.test(r.u)) r.u = ua[String(r.po).trim().toUpperCase()] || ''; });
  rows.reverse();   // latest upload first
  // the vendors' details (VENDORS + VENDOR EMAILS) for the vendors in this report
  const vd = {};
  vendorList_(user).list.forEach(v => { vd[v.name.toLowerCase()] = [v.address, v.phone, v.email]; });
  const vendors = {};
  rows.forEach(r => { const k = r.v.toLowerCase(); if (r.v && vd[k] && !vendors[r.v]) vendors[r.v] = vd[k]; });
  const pos = poAllBuild_(liveRows, po);
  pos.forEach(p => { const k = p.v.toLowerCase(); if (p.v && vd[k] && !vendors[p.v]) vendors[p.v] = vd[k]; });
  return { rows: rows, vendors: vendors, pos: pos };
}

/** PO report: every PO (FMS lines from REPORT_FROM, PO type) with its goods and invoice status, newest first. */
function poAllBuild_(invRows, poTab) {
  const snap = fmsSnap_(), fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v, norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const inv = {};
  invRows.forEach(r => { const k = String(r.po).toUpperCase(), x = inv[k] || (inv[k] = { n: 0, a: 0, no: [] }); x.n++; x.a += r.amt || 0; if (r.inv) x.no.push(r.inv); });
  const cxPO = poCancelIndex_();
  const out = {}, order = [];
  let year = CFG.START_YEAR, prevMonth = 1;
  snap.rows.forEach((r, i) => {
    const m = String(snap.stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;
    prevMonth = mon;
    if (year * 10000 + mon * 100 + day < fromKey) return;
    if (String(r[10]).trim().toLowerCase() !== 'approved') return;            // K: same rule as Material not received (rejected lines left out)
    if (String(r[21]).replace(/[\s.]/g, '').toUpperCase() !== 'PO') return;   // V: PO type
    const key = String(r[19]).trim().toUpperCase();                           // T: PO number
    if (!key) return;
    let p = out[key];
    if (!p) {
      const u = norm(r[2]), mapped = UNIT_MAP.find(x => x[2].some(k => u.indexOf(k) !== -1)), t = poTab[key] || {};
      p = out[key] = { po: String(r[19]).trim(), d: t.d || (year + '-' + pad(mon) + '-' + pad(day)), u: mapped ? mapped[1] : String(r[2]).trim(),
        v: String(r[32]).trim() || t.v || '', t: Number(String(r[20]).replace(/[^0-9.]/g, '')) || t.t || 0, l: t.l || '',
        n: 0, nr: 0, ok: false };
      order.push(key);
    }
    p.n++;
    if (String(r[27]).trim() === '' && String(r[29]).trim() === '') p.nr++;   // same as Material not received: AB received and AD invoice no. both empty
    const ac = String(r[28]).trim().toUpperCase();                            // AC: UPDATE = invoice pending
    if ((ac && ac !== 'UPDATE') || String(r[29]).trim()) p.ok = true;
  });
  return order.map(k => {
    const p = out[k], iv = inv[k];
    // g: goods (all / part / none received); s: invoice status
    return { po: p.po, d: p.d, u: p.u, v: p.v, t: p.t, l: p.l, n: p.n,
      g: cxPO[k] ? 'cx' : p.nr === 0 ? 'all' : p.nr >= p.n ? 'none' : 'part',
      s: cxPO[k] ? 'Cancelled' : iv || p.ok ? 'Invoiced' : 'Invoice pending', cx: cxPO[k] ? { d: cxPO[k].d, r: cxPO[k].r, by: cxPO[k].by, l: cxPO[k].l } : undefined, ic: iv ? iv.n : 0, ia: iv ? iv.a : 0, ino: iv ? iv.no.slice(0, 3).join(', ') : '' };
  }).sort((a, b) => String(b.d).localeCompare(String(a.d)));
}

// Ready copy of the Invoices report: rebuilt by warmCache every 5 minutes, new app uploads are added at once,
// and the app's Refresh button reads the sheet again (fresh).
const INVREP_CACHE = 'INVREP';
function invoiceReport_(user, req) {
  canVendors_(user);
  let out = (!(req && req.fresh)) ? cacheGetBig_(INVREP_CACHE) : null;
  if (!out) { out = invoiceReportBuild_(); cachePutBig_(INVREP_CACHE, out, 21600); }
  const only = vendorUnitsOnly_(user);
  if (!only) return out;
  const mine = x => only.indexOf(String(x.u || '').trim().toLowerCase()) !== -1;
  return { rows: (out.rows || []).filter(mine), vendors: out.vendors, pos: out.pos ? out.pos.filter(mine) : out.pos };
}
/** Keeps the PO report's goods status and PO list in step with Material not received: called every time that
 *  report is rebuilt, from the same FMS read, so both always count the same POs (no waiting for the 5-minute copy). */
function invRepPosSync_() {
  const c = cacheGetBig_(INVREP_CACHE);
  if (!c || !c.pos) return;
  const t = {};
  c.pos.forEach(p => { t[String(p.po).toUpperCase()] = { d: p.d, v: p.v, t: p.t, l: p.l }; });
  c.pos = poAllBuild_(c.rows || [], t);
  cachePutBig_(INVREP_CACHE, c, 21600);
}
/** An invoice just uploaded in the app: put it on top of the ready copy (with its PO details). */
function invoiceRepPatch_(po, link, amount, invNo, invDate) {
  const c = cacheGetBig_(INVREP_CACHE);
  if (!c) return;
  const k = po.toUpperCase(), had = c.rows.find(r => String(r.po).toUpperCase() === k);
  let f = had ? { v: had.v, u: had.u, pd: had.pd, pt: had.pt, pl: had.pl, pn: had.pn } : null;
  if (!f) {
    f = { v: '', u: '', pd: '', pt: 0, pl: '', pn: 0 };
    const ps = book_().getSheetByName(STORE_CFG.POS);
    const hits = ps ? ps.getRange(2, 2, Math.max(1, ps.getLastRow() - 1), 1).createTextFinder(po).matchEntireCell(true).findAll() : [];
    if (hits.length) {
      const x = ps.getRange(hits[0].getRow(), 1, 1, 8).getValues()[0];
      f = { v: String(x[4]).trim(), u: String(x[7]).trim(), pd: x[3] instanceof Date ? Utilities.formatDate(x[3], CFG.TZ, 'yyyy-MM-dd') : String(x[3] || '').trim(),
        pt: Number(String(x[6]).replace(/[^0-9.]/g, '')) || 0, pl: /^https?:\/\//.test(String(x[2])) ? String(x[2]).trim() : '', pn: hits.length };
    }
  }
  const pu = poUnits_();
  if ((!f.u || /^#/.test(f.u)) && pu[k]) f.u = pu[k];   // every invoice is listed (no date rule)
  c.rows.unshift(Object.assign({ po: po, il: link, up: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), amt: amount, inv: invNo, idt: invDate }, f));
  if (f.v && !(c.vendors || (c.vendors = {}))[f.v]) {
    const v = vendorList_({ isHO: true }).list.find(x => x.name.toLowerCase() === f.v.toLowerCase());
    if (v) c.vendors[f.v] = [v.address, v.phone, v.email];
  }
  const pp = (c.pos || []).find(x => String(x.po).toUpperCase() === k);
  if (pp) { pp.s = 'Invoiced'; pp.ic = (pp.ic || 0) + 1; pp.ia = (pp.ia || 0) + (amount || 0); pp.ino = [invNo, pp.ino].filter(Boolean).join(', '); }
  cachePutBig_(INVREP_CACHE, c, 21600);
}

/** PO number -> unit, from FMS (unit column and PO column). */
function poUnits_() {
  const sh = fms_(), n = sh.getLastRow() - CFG.FIRST_ROW + 1, out = {};
  if (n < 1) return out;
  const u = sh.getRange(CFG.FIRST_ROW, COL.UNIT, n, 1).getValues(), p = sh.getRange(CFG.FIRST_ROW, SCOL.PO, n, 1).getValues();
  const st = sh.getRange(CFG.FIRST_ROW, COL.TS, n, 1).getDisplayValues();   // dd-mm(hh:mm), as the other reports read it
  const fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  let year = CFG.START_YEAR, prevMonth = 1;
  p.forEach((x, i) => {
    const m = String(st[i][0]).match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;   // a new year started (same as reports_)
    prevMonth = mon;
    if (year * 10000 + mon * 100 + day < fromKey) return;
    const k = String(x[0]).trim().toUpperCase();
    if (k && !out[k]) out[k] = String(u[i][0]).trim();
  });
  return out;
}

// ======================= HO: check a vendor statement against our invoices (AI reads the statement) =======================
// Lines are matched by invoice number (written a little differently is fine) and amount. A bill on the statement that
// we do not have is also looked up among this vendor's POs without an invoice (same amount): "PO raised, invoice not uploaded".
function statementCheck_(user, req) {
  canVendors_(user);
  const vendor = String(req.vendor || '').replace(/\s+/g, ' ').trim();
  if (!vendor) throw appError_('BAD_REQUEST', 'Pick the vendor first.');
  const onlyUnit = String(req.unit || '').trim();   // a unit picked in the report: check and show only that unit
  const b = book_(), vk = vendor.toLowerCase();
  const fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  const round = x => Math.round(x * 100) / 100;

  // our side: this vendor's POs (P.Os: B PO no, C link, D date, E vendor, G total, H unit) and the invoices uploaded against them
  // unit of a PO: from FMS (same as the other reports); else P.Os column H if it is a real name; else the PO number's first two letters (MO = MONTANA) when they always mean one unit
  const pu = poUnits_(), pre = {}, unitSet = {}, ok = u => !!u && !/^#/.test(u);
  Object.keys(pu).forEach(k => { const u = String(pu[k] || '').trim(); if (!ok(u)) return; unitSet[u] = 1; const p = k.slice(0, 2); (pre[p] = pre[p] || {})[u] = (pre[p][u] || 0) + 1; });
  const preUnit = {};
  Object.keys(pre).forEach(p => { const c = pre[p], tot = Object.keys(c).reduce((t, u) => t + c[u], 0), top = Object.keys(c).sort((a, z) => c[z] - c[a])[0]; if (c[top] / tot >= 0.9) preUnit[p] = top; });
  const unitOfPo = (k, h) => { const x = String(pu[k] || '').trim(), y = String(h || '').trim(); return ok(x) ? x : ok(y) ? y : (preUnit[k.slice(0, 2)] || ''); };
  const pos = {}, ps = b.getSheetByName(STORE_CFG.POS);
  if (ps && ps.getLastRow() >= 2) ps.getRange(2, 1, ps.getLastRow() - 1, 8).getValues().forEach(r => {
    if (ok(String(r[7] || '').trim())) unitSet[String(r[7]).trim()] = 1;
    if (String(r[4]).replace(/\s+/g, ' ').trim().toLowerCase() !== vk) return;
    const k = String(r[1]).trim().toUpperCase();
    if (!k) return;
    const u = unitOfPo(k, r[7]);
    const p = pos[k] || (pos[k] = { po: String(r[1]).trim(), d: fd(r[3]), t: 0, u: u, l: /^https?:\/\//.test(String(r[2])) ? String(r[2]).trim() : '' });
    if (!p.t) p.t = Number(String(r[6]).replace(/[^0-9.]/g, '')) || 0;
    if (!p.u) p.u = u;
  });
  const ours = [], hasInv = {}, is = b.getSheetByName(STORE_CFG.INVOICES);
  if (is && is.getLastRow() >= 2) is.getRange(2, 1, lastFilled_(is, 1) - 1, 6).getValues().forEach(r => {
    const k = String(r[0]).trim().toUpperCase();
    if (!pos[k]) return;
    hasInv[k] = true;
    ours.push({ po: pos[k].po, u: pos[k].u, inv: String(r[4]).trim(), d: fd(r[5]) || fd(r[2]), amt: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0,
      il: /^https?:\/\//.test(String(r[1])) ? String(r[1]).trim() : '', pl: pos[k].l });
  });
  const unitNames = Object.keys(unitSet).sort();
  // unit name written on the statement -> our unit name
  const STOP = ['summit', 'hotel', 'hotels', 'resort', 'resorts', 'and', 'spa', 'the', 'private', 'limited', 'ltd', 'pvt', 'boutique', 'retreat'];
  const unitIn = text => { const x = String(text || '').toLowerCase(); if (!x) return '';
    return unitNames.find(u => u.toLowerCase() === x.trim()) || unitNames.find(u => u.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && STOP.indexOf(w) < 0).some(w => x.indexOf(w) >= 0)) || ''; };

  // AI reads every file (one statement, many files, or files from a zip)
  const docs = Array.isArray(req.files) && req.files.length ? req.files.slice(0, 40) : [req];
  const prompt = 'This is a vendor account statement / ledger sent to us (the buyer) by the vendor "' + vendor + '". Our units (hotels) are: ' + unitNames.join('; ') + '. ' +
    'unit: which ONE of our units this statement is for (buyer / billed-to / party / ledger name on it), written exactly as in that list, "" if not clear. ' +
    'Read EVERY line. For each give: date (yyyy-mm-dd), ref (invoice / bill / voucher number exactly as written, "" if none), po (our purchase order / PO number if written on that line, "" if none), ' +
    'unit (only if that line itself names one of our units, exactly as in the list, else ""), ' +
    'kind ("invoice" for a bill/sale/debit to us, "payment" for money received from us, "credit" for credit note / return / discount, "opening" for opening balance, "other"), ' +
    'amount (positive rupees). Also give from and to (the statement period, yyyy-mm-dd, "" if not shown) and closing (closing balance, 0 if not shown). Do not invent lines; skip page totals.';
  const schema = { type: 'OBJECT', properties: { unit: { type: 'STRING' }, from: { type: 'STRING' }, to: { type: 'STRING' }, closing: { type: 'NUMBER' },
    lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { date: { type: 'STRING' }, ref: { type: 'STRING' }, po: { type: 'STRING' }, unit: { type: 'STRING' }, kind: { type: 'STRING' }, amount: { type: 'NUMBER' } },
    required: ['ref', 'kind', 'amount'] } } }, required: ['lines'] };
  const partsList = docs.map(d => {
    const p = [];
    if (d.text) p.push({ text: 'Vendor statement (from an Excel file' + (d.name ? ' named ' + d.name : '') + '):\n' + String(d.text).slice(0, 60000) });
    else {
      checkFile_(d.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Statement file' + (d.name ? ' ' + d.name : ''));
      p.push({ inline_data: { mime_type: d.file.type, data: d.file.data } });
    }
    p.push({ text: prompt });
    return p;
  });
  const outs = docs.length === 1 ? [geminiJson_(partsList[0], schema, AI_CFG.MODELS)] : geminiJsonMany_(partsList, schema, AI_CFG.MODELS);
  const failed = [], sl = [], fileUnit = {}, closingOf = {};
  outs.forEach((o, n) => {
    const name = String(docs[n].name || '').slice(0, 80);
    if (!o || o instanceof Error) { failed.push(name || 'file ' + (n + 1)); return; }
    let fu = unitIn(o.unit) || unitIn(name);
    if (onlyUnit && !fu) fu = onlyUnit;
    const pf = /^\d{4}-\d{2}-\d{2}$/.test(o.from || '') ? o.from : '', pt = /^\d{4}-\d{2}-\d{2}$/.test(o.to || '') ? o.to : '';
    closingOf[fu] = (closingOf[fu] || 0) + (Number(o.closing) || 0);
    (fileUnit[fu] = fileUnit[fu] || []).push(name);
    (o.lines || []).slice(0, 1500).forEach(l => {
      let u = unitIn(l.unit) || fu;
      if (onlyUnit && !u) u = onlyUnit;
      sl.push({ date: String(l.date || '').slice(0, 10), ref: String(l.ref || '').slice(0, 60), po: String(l.po || '').slice(0, 40), f: name, u: u, pf: pf, pt: pt,
        kind: String(l.kind || 'other').toLowerCase(), amt: round(Number(l.amount) || 0) });
    });
  });
  if (failed.length === docs.length) throw appError_('BUSY', 'AI could not read the statement' + (docs.length > 1 ? 's' : '') + ' (daily/minute limit may be reached). Please try again later.');

  // unit-wise: each unit's statement lines are matched only with that unit's invoices and POs
  const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tail = s => { const m = String(s || '').match(/(\d+)\D*$/); return m ? String(+m[1]) : ''; };
  const same = (a, b) => { const ka = key(a), kb = key(b); if (!ka || !kb) return false;
    return ka === kb || (ka.length >= 4 && kb.endsWith(ka)) || (kb.length >= 4 && ka.endsWith(kb)); };
  const lines = onlyUnit ? sl.filter(s => s.u === onlyUnit) : sl;
  const gNames = [...new Set(lines.map(s => s.u))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));   // named units first, "unit not found" last
  if (onlyUnit && !gNames.length) gNames.push(onlyUnit);
  const groups = gNames.map(u => {
    const scope = u || onlyUnit;
    const mine = ours.filter(o => !scope || o.u === scope || !o.u);   // a PO whose unit is not known can match any unit
    const open = Object.keys(pos).filter(k => !hasInv[k] && (!scope || pos[k].u === scope || !pos[k].u)).map(k => pos[k]);
    const matched = [], diff = [], missing = [], money = [], gl = lines.filter(s => s.u === u);
    const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5), rest = [];
    gl.forEach(s => {   // pass 1: by invoice number
      if (s.kind !== 'invoice') { if (s.kind !== 'opening' || s.amt) money.push(s); return; }
      let o = mine.find(o => !o._used && same(o.inv, s.ref));
      if (!o) o = mine.find(o => !o._used && tail(o.inv) && tail(o.inv) === tail(s.ref) && tail(s.ref).length >= 2 && Math.abs(o.amt - s.amt) <= 1);
      if (o) { o._used = 1; (Math.abs(o.amt - s.amt) <= 1 ? matched : diff).push({ s: s, o: o, d: round(s.amt - o.amt) }); return; }
      rest.push(s);
    });
    rest.forEach(s => {   // pass 2: our invoice no. is missing / typed differently (e.g. PO no. entered): same amount within 45 days
      const o2 = mine.find(o => !o._used && Math.abs(o.amt - s.amt) <= 1 && (!s.date || !o.d || days(s.date, o.d) <= 45));
      if (o2) { o2._used = 1; matched.push({ s: s, o: o2, d: round(s.amt - o2.amt), how: 'amount' }); return; }
      // not uploaded with us: a PO of this unit without an invoice for (about) the same amount, else one whose PO number is on the statement line
      const exact = open.filter(p => Math.abs(p.t - s.amt) <= 1);
      const close = exact.length ? [] : open.filter(p => p.t && Math.abs(p.t - s.amt) <= Math.max(1, s.amt * 0.02));
      let found = exact.concat(close).slice(0, 3).map(p => ({ po: p.po, d: p.d, t: p.t, l: p.l, exact: Math.abs(p.t - s.amt) <= 1 }));
      if (!found.length && s.po) found = open.filter(p => same(p.po, s.po) || (tail(s.po).length >= 3 && tail(p.po) === tail(s.po))).slice(0, 3)
        .map(p => ({ po: p.po, d: p.d, t: p.t, l: p.l, exact: false, byNo: true, diff: round(s.amt - p.t) }));
      missing.push({ s: s, po: found });
    });
    const dates = gl.map(x => x.date).filter(Boolean).sort();
    return { unit: scope || '', label: u || 'Unit not found on statement', vendor: vendor, mine: mine, named: !!scope,
      from: gl.map(x => x.pf).filter(Boolean).sort()[0] || dates[0] || '', to: gl.map(x => x.pt).filter(Boolean).sort().pop() || dates.pop() || '',
      closing: round(closingOf[u] || 0), file: (fileUnit[u] || []).filter(Boolean).join(', '), matched: matched, diff: diff, missing: missing, money: money };
  });
  // a bill on one unit's statement that we booked under another unit (vendor billed the wrong unit, or we entered it in another unit)
  const dd = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);
  groups.forEach(g => {
    g.cross = [];
    if (!g.unit) return;
    g.missing = g.missing.filter(x => {
      const s = x.s, other = o => !o._used && o.u && o.u !== g.unit;
      let how = 'number', o = ours.find(o => other(o) && same(o.inv, s.ref));
      if (!o) { how = 'amount'; o = ours.find(o => other(o) && Math.abs(o.amt - s.amt) <= 1 && (!s.date || !o.d || dd(s.date, o.d) <= 45)); }
      if (!o) return true;
      o._used = 1;
      const df = round(s.amt - o.amt);
      g.cross.push({ s: s, o: o, vu: g.label, ou: o.u, how: how, d: df,
        note: 'Vendor statement shows this bill under ' + g.label + '; we entered it under ' + o.u + ' (PO ' + o.po + ', our invoice no. ' + (o.inv || '-') + ')' +
          (how === 'amount' ? '; found by same amount and date' : '') + (Math.abs(df) > 1 ? '; amount also differs by Rs ' + df : '') });
      return false;
    });
  });
  // where invoice no. or amount does not agree, AI reads our uploaded invoice file to see if it was a data-entry mistake on our side
  const recheck = [];
  groups.forEach(g => { g.matched.forEach(x => { if (x.how === 'amount') recheck.push(x); }); g.diff.forEach(x => recheck.push(x)); });
  invoiceRecheck_(recheck.slice(0, 40), same);
  const sum = a => round(a.reduce((t, x) => t + x, 0));
  groups.forEach(g => {   // after all matching: our invoices of this unit (in the statement period) that the vendor has not shown
    g.notInStmt = g.named || groups.length === 1 ? g.mine.filter(o => !o._used && (!g.unit || o.u === g.unit) && (!g.from || !o.d || o.d >= g.from) && (!g.to || !o.d || o.d <= g.to)) : [];
    g.totals = { stmtBills: sum(g.matched.concat(g.diff).map(x => x.s.amt).concat(g.missing.map(x => x.s.amt))),
      ourBills: sum(g.matched.concat(g.diff).map(x => x.o.amt).concat(g.notInStmt.map(o => o.amt))),
      payments: sum(g.money.filter(m => m.kind === 'payment').map(m => m.amt)), credits: sum(g.money.filter(m => m.kind === 'credit').map(m => m.amt)) };
    delete g.mine;
  });
  const all = k => [].concat.apply([], groups.map(g => g[k]));
  return {
    vendor: vendor, unit: onlyUnit, files: docs.map(d => String(d.name || '')), failed: failed, units: groups,
    from: groups.map(g => g.from).filter(Boolean).sort()[0] || '', to: groups.map(g => g.to).filter(Boolean).sort().pop() || '', closing: sum(groups.map(g => g.closing)),
    matched: all('matched'), diff: all('diff'), cross: all('cross'), missing: all('missing'), notInStmt: all('notInStmt'), money: all('money'),
    totals: { stmtBills: sum(groups.map(g => g.totals.stmtBills)), ourBills: sum(groups.map(g => g.totals.ourBills)),
      payments: sum(groups.map(g => g.totals.payments)), credits: sum(groups.map(g => g.totals.credits)) },
  };
}


/** Same as geminiJson_ for many files at once (in parallel). Returns one result per file, or an Error for a file that could not be read. */
function geminiJsonMany_(partsList, schema, models) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw appError_('SETUP', 'AI is not set up yet.');
  const res = partsList.map(() => null);
  let todo = partsList.map((_, i) => i);
  for (let k = 0; k < models.length && todo.length; k++) {
    for (let a = 0; a < todo.length; a += 6) {
      const grp = todo.slice(a, a + 6);
      const rs = UrlFetchApp.fetchAll(grp.map(i => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[k]) + ':generateContent',
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ parts: partsList[i] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }) })));
      rs.forEach((r, n) => {
        const i = grp[n], c = r.getResponseCode();
        if (c === 429 || c === 503 || c === 404) return;   // busy / used up: next model tries it
        if (c !== 200) { console.warn('Gemini ' + c + ': ' + r.getContentText().slice(0, 300)); res[i] = new Error('AI could not read this file.'); return; }
        try { const j = JSON.parse(r.getContentText()); res[i] = JSON.parse(j.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text || '').join('')); }
        catch (e) { res[i] = new Error('AI could not read this file.'); }
      });
    }
    todo = todo.filter(i => res[i] === null);
  }
  todo.forEach(i => { res[i] = new Error('AI limit reached.'); });
  return res;
}

/** Statement check helper: AI reads our uploaded invoice files (in parallel) and explains each number / amount mismatch in x.note. */
function invoiceRecheck_(list, same) {
  if (!list.length) return;
  const rs = v => 'Rs ' + Number(v || 0).toLocaleString('en-IN');
  const parts = [], todo = [];
  list.forEach(x => {
    const id = (String(x.o.il || '').match(/[-\w]{25,}/) || [])[0];
    if (!id) { x.note = 'Invoice file not found in our system - please check manually'; return; }
    try {
      const blob = DriveApp.getFileById(id).getBlob(), mt = blob.getContentType(), bytes = blob.getBytes();
      if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(mt) || bytes.length > 15e6) throw new Error('type');
      parts.push([{ inline_data: { mime_type: mt, data: Utilities.base64Encode(bytes) } },
        { text: 'This is a vendor tax invoice / bill. Give invoice_no (the invoice / bill number exactly as printed) and total (the grand total payable in rupees).' }]);
      todo.push(x);
    } catch (e) { x.note = 'Could not open our uploaded invoice file - please check manually'; }
  });
  if (!parts.length) return;
  const res = geminiJsonMany_(parts, { type: 'OBJECT', properties: { invoice_no: { type: 'STRING' }, total: { type: 'NUMBER' } }, required: ['invoice_no', 'total'] }, AI_CFG.MODELS);
  todo.forEach((x, n) => {
    const a = res[n];
    if (!a || a instanceof Error) { x.note = 'AI could not read our uploaded invoice (limit reached) - please check manually'; return; }
    const no = String(a.invoice_no || '').trim(), tot = Math.round((Number(a.total) || 0) * 100) / 100;
    x.chk = { inv: no, amt: tot };
    if (x.how === 'amount') {   // amount agrees, invoice no. does not
      x.note = no && same(no, x.s.ref)
        ? 'Data entry error on our side: invoice no. entered as "' + x.o.inv + '", uploaded invoice shows ' + no + ' (same as statement)'
        : 'Invoice no. differs: statement ' + x.s.ref + ', our entry "' + x.o.inv + '", uploaded invoice shows "' + (no || 'not readable') + '" - please check';
    } else {   // invoice no. agrees, amount does not
      x.note = tot && Math.abs(tot - x.s.amt) <= 1
        ? 'Data entry error on our side: amount entered ' + rs(x.o.amt) + ', uploaded invoice shows ' + rs(tot) + ' (same as statement)'
        : tot && Math.abs(tot - x.o.amt) <= 1
          ? 'Uploaded invoice also shows ' + rs(tot) + ' - real difference with vendor statement (' + rs(x.s.amt) + ')'
          : 'Uploaded invoice shows ' + (tot ? rs(tot) : 'amount not readable') + ' - differs from both our entry and the statement, please check';
    }
  });
}


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
  if (want('acl')) users.forEach(u => (parts['acl:' + u.email] = { full: !!(u.isHO || u.isApprover || u.isAdmin || u.isViewer), ho: !!(u.isHO || u.isAdmin), units: u.units.map(fsId_) }));
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
  const map = { assign: ['ho', 'mine', 'reports', 'dec'], decide: ['ho', 'mine', 'reports', 'dec', 'po'], hoDecide: ['ho', 'mine', 'reports', 'dec', 'po'], storeRaise: ['ho', 'store', 'reports'],
    storeReceive: ['store', 'reports', 'irep'], storeInvoice: ['store', 'reports', 'irep'], makePO: ['po', 'store', 'reports', 'irep', 'vendors', 'vlist'],
    vendorSave: ['vendors', 'vlist', 'irep'], unitPhoneSave: ['vendors'], poCancel: ['ho', 'store', 'reports', 'irep'], poUncancel: ['ho', 'store', 'reports', 'irep'], editItem: ['ho', 'mine', 'po', 'store'], goodsSave: ['reports'] };
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




// ---------- Old sheets (read only): their invoices are listed in the Invoices report, nothing else ----------
// The old sheets hardly change, so they are read once and kept for 6 hours (the 5-minute refresh stays fast).
const OLD_INV_SHEETS = ['16TCz5HIEGFH1UFDNx4mn63faobrGmUj9lbxkNRTexAg'];   // NONLOCAL PURCHASES Jan-Dec 2025
const OLDINV_CACHE = 'OLDINV';
function oldSheetsData_() {
  const c = cacheGetBig_(OLDINV_CACHE);
  if (c && c.rows) return c;
  const d = { rows: [], units: {} };
  const url = v => (/^https?:\/\//.test(String(v)) ? String(v).trim() : '');
  const iso = v => {
    if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
    const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : String(v || '').trim();
  };
  OLD_INV_SHEETS.forEach(id => {
    try {
      const b = SpreadsheetApp.openById(id);
      // PO number -> details from P.Os (B PO no, C link, D date, E vendor, G total)
      const po = {}, ps = b.getSheetByName(STORE_CFG.POS);
      if (ps && ps.getLastRow() >= 2) ps.getRange(2, 1, ps.getLastRow() - 1, 7).getValues().forEach(r => {
        const k = String(r[1]).trim().toUpperCase();
        if (!k) return;
        const p = po[k] || (po[k] = { l: '', d: '', v: '', t: 0, n: 0 });
        p.n++; if (!p.l) p.l = url(r[2]); if (!p.d) p.d = iso(r[3]); if (!p.v) p.v = String(r[4]).trim();
        if (!p.t) p.t = Number(String(r[6]).replace(/[^0-9.]/g, '')) || 0;
      });
      // PO number -> unit from this old sheet's FMS (C unit, S PO number)
      const fs = b.getSheetByName('FMS'), fn = fs ? fs.getLastRow() - 1 : 0;
      if (fn > 0) {
        const u = fs.getRange(2, 3, fn, 1).getValues(), pn = fs.getRange(2, 19, fn, 1).getValues();
        pn.forEach((x, i) => { const k = String(x[0]).trim().toUpperCase(), un = String(u[i][0]).trim(); if (k && un && !d.units[k]) d.units[k] = un; });
      }
      const is = b.getSheetByName(STORE_CFG.INVOICES);
      const last = is ? lastFilled_(is, 1) : 0;
      if (last >= 2) is.getRange(2, 1, last - 1, 6).getValues().forEach(r => {
        const k = String(r[0]).trim().toUpperCase();
        if (!k) return;
        const p = po[k] || {};
        d.rows.push({ po: String(r[0]).trim(), il: url(r[1]), up: iso(r[2]), amt: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0,
          inv: String(r[4]).trim(), idt: iso(r[5]), v: p.v || '', u: d.units[k] || '', pd: p.d || '', pt: p.t || 0, pl: p.l || '', pn: p.n || 0 });
      });
    } catch (e) { console.error('Old invoices (' + id + '): ' + e); }
  });
  cachePutBig_(OLDINV_CACHE, d, 21600);
  return d;
}
/** The old sheets' invoices that are not already listed from this year's sheet. */
function oldInvoiceRows_(seen) {
  return oldSheetsData_().rows.filter(r => {
    const k = String(r.po).toUpperCase() + '|' + r.il;
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
}

/** PO -> unit for every PO in this sheet's FMS (C unit, T PO) and the old sheets' FMS, no date rule. */
function poUnitsAll_() {
  const out = {}, sh = fms_(), n = sh.getLastRow() - 1;
  if (n > 0) {
    const u = sh.getRange(2, COL.UNIT, n, 1).getValues(), p = sh.getRange(2, SCOL.PO, n, 1).getValues();
    p.forEach((x, i) => { const k = String(x[0]).trim().toUpperCase(), un = String(u[i][0]).trim(); if (k && un && !out[k]) out[k] = un; });
  }
  const old = oldSheetsData_().units;
  Object.keys(old).forEach(k => { if (!out[k]) out[k] = old[k]; });
  return out;
}

// ======================= PO cancellation =======================
// HO (or the admin) can cancel a whole PO after it was made (wrong PO, vendor cannot supply...). Nothing in FMS changes:
// the cancellation is kept in its own locked tab "PO CANCELLATIONS", and every list and report leaves the PO out
// (the PO report still shows it, marked Cancelled). A copy of the PO PDF is stamped CANCELLED (two light diagonal lines
// with the word between them) so it can be shared with the vendor. The admin can undo a cancellation.
// A PO can be cancelled only while nothing of it is received and no invoice is uploaded.
const CX_CFG = { TAB: 'PO CANCELLATIONS', CACHE: 'poCancel_' + MODE, REASON_MAX_WORDS: 10,
  HEADER: ['Time', 'PO No', 'Unit', 'Vendor', 'Amount', 'Reason', 'Cancelled By', 'Email', 'Cancelled PO', 'Status', 'Original PO'] };

function cxTab_() {
  const ss = book_();
  let sh = ss.getSheetByName(CX_CFG.TAB);
  if (sh) return sh;
  sh = ss.insertSheet(CX_CFG.TAB, ss.getSheets().length);
  sh.getRange(1, 1, 1, CX_CFG.HEADER.length).setValues([CX_CFG.HEADER]).setFontWeight('bold');
  sh.setFrozenRows(1);
  try {   // locked: only the owner can edit (the app writes here), same as the other app tabs
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  } catch (e) { console.warn('PO CANCELLATIONS not locked: ' + e); }
  return sh;
}

/** PO number (upper case) -> { d: date, r: reason, by: name, l: cancelled PDF link, row } for every PO that is cancelled now. */
function poCancelIndex_(fresh) {
  const c = CacheService.getScriptCache();
  if (!fresh) { const hit = c.get(CX_CFG.CACHE); if (hit) try { return JSON.parse(hit); } catch (e) {} }
  const out = {};
  const sh = book_().getSheetByName(CX_CFG.TAB);
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, CX_CFG.HEADER.length).getValues().forEach((r, i) => {
      const k = String(r[1]).trim().toUpperCase();
      if (!k) return;
      if (String(r[9]).trim().toLowerCase() === 'undone') { delete out[k]; return; }
      out[k] = { d: r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'yyyy-MM-dd') : String(r[0]).slice(0, 10),
        r: String(r[5]).trim(), by: String(r[6]).trim(), l: /^https?:\/\//.test(String(r[8])) ? String(r[8]).trim() : '', row: i + 2 };
    });
  }
  try { c.put(CX_CFG.CACHE, JSON.stringify(out), 600); } catch (e) {}
  return out;
}

function canCancelPO_(u) { if (!u.isHO && !isAdmin_(u)) throw appError_('FORBIDDEN', 'Only HO can cancel a PO.'); }

/** HO / admin: cancel a whole PO. req: { po, reason } */
function poCancel_(user, req) {
  canCancelPO_(user);
  const po = String(req.po || '').trim(), key = po.toUpperCase();
  if (!po) throw appError_('BAD_REQUEST', 'Choose the PO.');
  const reason = String(req.reason || '').replace(/\s+/g, ' ').trim();
  if (!reason) throw appError_('BAD_REQUEST', 'Write the reason for cancelling.');
  if (reason.split(' ').length > CX_CFG.REASON_MAX_WORDS) throw appError_('BAD_REQUEST', 'Keep the reason to ' + CX_CFG.REASON_MAX_WORDS + ' words.');
  let result;
  withLock_(() => {
    if (poCancelIndex_(true)[key]) throw appError_('BAD_REQUEST', 'PO ' + po + ' is already cancelled.');
    const sh = fms_();
    const n = Math.max(0, sh.getLastRow() - CFG.FIRST_ROW + 1);
    const rows = n ? sh.getRange(CFG.FIRST_ROW, 1, n, 33).getValues() : [];
    const mine = rows.filter(r => String(r[19]).trim().toUpperCase() === key);   // T: PO number
    if (!mine.length) throw appError_('BAD_REQUEST', 'PO ' + po + ' was not found in the sheet.');
    if (mine.some(r => String(r[27]).trim() !== '')) throw appError_('BAD_REQUEST', 'Material of PO ' + po + ' is already received, so it cannot be cancelled.');   // AB
    if (mine.some(r => String(r[29]).trim() !== '') || invoiceIndex_()[key]) throw appError_('BAD_REQUEST', 'An invoice is already uploaded for PO ' + po + ', so it cannot be cancelled.');   // AD / INVOICES
    const r0 = mine[0];
    const orig = poLinks_()[key] || '';
    const amount = Number(String(r0[20]).replace(/[^0-9.]/g, '')) || 0;
    const now = new Date();
    const cx = cxTab_();
    cx.getRange(cx.getLastRow() + 1, 1, 1, CX_CFG.HEADER.length).setValues([[now, po, String(r0[2]).trim(), String(r0[32]).trim(), amount,
      reason, user.name, user.email, '', 'Cancelled', orig]]);
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(CX_CFG.CACHE);
    log_(user, 'PO cancelled', po, reason + (orig ? ' | ' + orig : ''));
    result = { po: po, row: cx.getLastRow(), orig: orig, reason: reason, date: now };
  });
  // the CANCELLED copy of the PO for the vendor (made now; if it fails, a background run tries again)
  const link = '';
  if (result.orig) cxScheduleStamp_();   // the stamp needs an async run, so a background run makes it a few seconds later
  cxRebuild_();
  return { po: result.po, link: link, preparing: !link && !!result.orig };
}

/** Admin only: undo a cancellation (the row stays, marked Undone, for the record). */
function poUncancel_(user, req) {
  if (!isAdmin_(user)) throw appError_('FORBIDDEN', 'Only the admin can undo a PO cancellation.');
  const key = String(req.po || '').trim().toUpperCase();
  withLock_(() => {
    const x = poCancelIndex_(true)[key];
    if (!x) throw appError_('BAD_REQUEST', 'This PO is not cancelled.');
    cxTab_().getRange(x.row, 10).setValue('Undone');
    SpreadsheetApp.flush();
    CacheService.getScriptCache().remove(CX_CFG.CACHE);
    log_(user, 'PO cancel undone', String(req.po || '').trim(), '');
  });
  cxRebuild_();
  return { po: String(req.po || '').trim() };
}

/** Every list and report reads FMS again, so the PO leaves (or comes back to) all of them at once. */
function cxRebuild_() {
  FMS_SNAP_ = null;
  try { reports_(null, { fresh: true }); } catch (e) { console.error('Reports rebuild: ' + e); }
  try { storeLines_(); } catch (e) { console.error('Store rebuild: ' + e); }
  try { goodsBuild_(); } catch (e) { console.error('Goods rebuild: ' + e); }
  try { cachePutBig_(INVREP_CACHE, invoiceReportBuild_(), 21600); } catch (e) { console.error('Invoices report rebuild: ' + e); }
}

// ---- the CANCELLED stamp on the PO PDF (pdf-lib, kept in Drive after the first download) ----
function pdfLib_() {
  if (globalThis.PDFLib) return globalThis.PDFLib;
  const props = PropertiesService.getScriptProperties();
  let code = '';
  const id = props.getProperty('PDFLIB_FILE');
  if (id) try { code = DriveApp.getFileById(id).getBlob().getDataAsString(); } catch (e) { code = ''; }
  if (!code) {
    const r = UrlFetchApp.fetch('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('PDF tool could not be loaded (' + r.getResponseCode() + ')');
    code = r.getContentText();
    try { props.setProperty('PDFLIB_FILE', uploadFolder_('App files').createFile('pdf-lib.min.js', code, 'text/plain').getId()); } catch (e) { console.warn('pdf-lib not kept: ' + e); }
  }
  if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = (f) => { f(); return 0; };
  (0, eval)(code);   // defines PDFLib
  return globalThis.PDFLib;
}

async function cxStampBytes_(bytes, note) {
  const L = pdfLib_();
  const doc = await L.PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const bold = await doc.embedFont(L.StandardFonts.HelveticaBold), reg = await doc.embedFont(L.StandardFonts.Helvetica);
  const red = L.rgb(0.86, 0.15, 0.15);
  doc.getPages().forEach(pg => {
    const w = pg.getWidth(), h = pg.getHeight(), a = Math.atan2(h, w), cs = Math.cos(a), sn = Math.sin(a);
    const size = Math.min(w, h) / 6.5, tw = bold.widthOfTextAtSize('CANCELLED', size), th = size * 0.72;
    const g = th * 0.9 + 10;                              // half the gap between the two lines
    const nx = -sn * g, ny = cs * g;                      // shift across the diagonal
    [1, -1].forEach(s => pg.drawLine({ start: { x: s * nx, y: s * ny }, end: { x: w + s * nx, y: h + s * ny }, thickness: 3, color: red, opacity: 0.35 }));
    pg.drawText('CANCELLED', { x: w / 2 - cs * tw / 2 + sn * th / 2, y: h / 2 - sn * tw / 2 - cs * th / 2, size: size, font: bold,
      color: red, opacity: 0.3, rotate: L.degrees(a * 180 / Math.PI) });
    if (note) pg.drawText(note, { x: 24, y: 14, size: 9, font: reg, color: red, opacity: 0.85, maxWidth: w - 48 });
  });
  const out = await doc.save();
  return Array.from(out, b => (b > 127 ? b - 256 : b));
}

/** Makes the CANCELLED copy for one row of PO CANCELLATIONS and writes its link there. */
async function cxStampOneA_(row) {
  const sh = cxTab_();
  const r = sh.getRange(row, 1, 1, CX_CFG.HEADER.length).getValues()[0];
  if (String(r[8]).trim() || String(r[9]).trim().toLowerCase() === 'undone') return String(r[8]).trim();
  const m = String(r[10]).match(/[-\w]{25,}/);
  if (!m) return '';   // no PO file to stamp
  const f = DriveApp.getFileById(m[0]);
  const src = f.getMimeType() === 'application/pdf' ? f.getBlob() : f.getAs('application/pdf');
  const when = r[0] instanceof Date ? Utilities.formatDate(r[0], CFG.TZ, 'dd-MMM-yyyy') : '';
  const note = 'PO ' + r[1] + ' CANCELLED on ' + when + (r[5] ? ' · Reason: ' + r[5] : '');
  const bytes = await cxStampBytes_(src.getBytes(), note);
  const file = uploadFolder_('Purchase orders').createFile(Utilities.newBlob(bytes, 'application/pdf', r[1] + ' CANCELLED.pdf'));
  try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('Sharing not changed: ' + e); }
  const link = 'https://drive.google.com/file/d/' + file.getId() + '/view?usp=drivesdk';
  sh.getRange(row, 9).setValue(link);
  CacheService.getScriptCache().remove(CX_CFG.CACHE);
  return link;
}

function cxScheduleStamp_() { try { ScriptApp.newTrigger('cxStampRun').timeBased().after(1000).create(); } catch (e) { console.warn(e); } }

/** Background: makes any CANCELLED copies still missing (runs once, removes its own trigger). */
async function cxStampRun() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cxStampRun').forEach(t => { try { ScriptApp.deleteTrigger(t); } catch (e) {} });
  const sh = book_().getSheetByName(CX_CFG.TAB);
  if (!sh || sh.getLastRow() < 2) return;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, CX_CFG.HEADER.length).getValues();
  const made = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[8]).trim() && String(r[9]).trim().toLowerCase() !== 'undone' && String(r[10]).trim())
      try { const l = await cxStampOneA_(i + 2); if (l) made[String(r[1]).trim().toUpperCase()] = l; } catch (e) { console.error('Stamp ' + r[1] + ': ' + e); }
  }
  // fast: put the new links straight into the ready PO report copy (warmCache still rebuilds it every 5 minutes)
  try {
    const rep = cacheGetBig_(INVREP_CACHE);
    if (rep && rep.pos) { rep.pos.forEach(p => { const l = made[String(p.po).trim().toUpperCase()]; if (l && p.cx) p.cx.l = l; }); cachePutBig_(INVREP_CACHE, rep, 21600); }
    else cachePutBig_(INVREP_CACHE, invoiceReportBuild_(), 21600);
    fsPublish_(['irep']);
  } catch (e) { console.error('Report update: ' + e); }
}

/** Editor test: stamps a copy of one PO PDF (no cancellation is recorded) and logs the link of the test copy. */
async function testCancelStamp() {
  const links = poLinks_(), k = Object.keys(links).pop();
  const f = DriveApp.getFileById(links[k].match(/[-\w]{25,}/)[0]);
  const bytes = await cxStampBytes_(f.getBlob().getBytes(), 'TEST ONLY · PO ' + k);
  const t = DriveApp.createFile(Utilities.newBlob(bytes, 'application/pdf', 'TEST stamp ' + k + '.pdf'));
  console.log('Test copy (delete after checking): ' + t.getUrl());
}

