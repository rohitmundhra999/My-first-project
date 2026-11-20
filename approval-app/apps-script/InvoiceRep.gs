
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
  rows.reverse();   // latest upload first
  // the vendors' details (VENDORS + VENDOR EMAILS) for the vendors in this report
  const vd = {};
  vendorList_(user).list.forEach(v => { vd[v.name.toLowerCase()] = [v.address, v.phone, v.email]; });
  const vendors = {};
  rows.forEach(r => { const k = r.v.toLowerCase(); if (r.v && vd[k] && !vendors[r.v]) vendors[r.v] = vd[k]; });
  const pos = poAllBuild_(rows, po);
  pos.forEach(p => { const k = p.v.toLowerCase(); if (p.v && vd[k] && !vendors[p.v]) vendors[p.v] = vd[k]; });
  return { rows: rows, vendors: vendors, pos: pos };
}

/** PO report: every PO (FMS lines from REPORT_FROM, PO type) with its goods and invoice status, newest first. */
function poAllBuild_(invRows, poTab) {
  const snap = fmsSnap_(), fromKey = REPORT_FROM.y * 10000 + REPORT_FROM.m * 100 + REPORT_FROM.d;
  const pad = v => (v < 10 ? '0' : '') + v, norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const inv = {};
  invRows.forEach(r => { const k = String(r.po).toUpperCase(), x = inv[k] || (inv[k] = { n: 0, a: 0, no: [] }); x.n++; x.a += r.amt || 0; if (r.inv) x.no.push(r.inv); });
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
      g: p.nr === 0 ? 'all' : p.nr >= p.n ? 'none' : 'part',
      s: iv || p.ok ? 'Invoiced' : 'Invoice pending', ic: iv ? iv.n : 0, ia: iv ? iv.a : 0, ino: iv ? iv.no.slice(0, 3).join(', ') : '' };
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
