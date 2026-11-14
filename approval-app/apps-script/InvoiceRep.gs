
// ======================= HO: Invoices report (INVOICES tab + the PO each invoice is for) =======================
/** Every uploaded invoice (latest first) with its PO (P.Os tab) and the vendor's details. HO and admin only. */
function invoiceReportBuild_() {
  const user = { isHO: true };   // internal: lets vendorList_ give the vendors' details
  const b = book_(), fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  const url = v => (/^https?:\/\//.test(String(v)) ? String(v).trim() : '');
  // PO number -> details (P.Os: A order no, B PO no, C link, D date, E vendor, F days, G total, H unit; one row per line)
  const po = {}, ps = b.getSheetByName(STORE_CFG.POS);
  if (ps && ps.getLastRow() >= 2) {
    const last = ps.getLastRow(), first = Math.max(2, last - 8000 + 1);
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
    const last = lastFilled_(is, 1), first = Math.max(2, last - 4000 + 1);
    if (last >= 2) is.getRange(first, 1, last - first + 1, 6).getValues().forEach(r => {
      const k = String(r[0]).trim().toUpperCase();
      if (!k) return;
      if (!pu[k]) return;   // same rule as Material not received / Invoice pending: PO of FMS lines from REPORT_FROM (1 April 2026)
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
  return { rows: rows, vendors: vendors };
}

// Ready copy of the Invoices report: rebuilt by warmCache every 5 minutes, new app uploads are added at once,
// and the app's Refresh button reads the sheet again (fresh).
const INVREP_CACHE = 'INVREP';
function invoiceReport_(user, req) {
  canVendors_(user);
  if (!(req && req.fresh)) { const c = cacheGetBig_(INVREP_CACHE); if (c) return c; }
  const out = invoiceReportBuild_();
  cachePutBig_(INVREP_CACHE, out, 21600);
  return out;
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
  if (!pu[k]) return;   // a PO from before REPORT_FROM: not in this report
  if (!f.u || /^#/.test(f.u)) f.u = pu[k];
  c.rows.unshift(Object.assign({ po: po, il: link, up: Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), amt: amount, inv: invNo, idt: invDate }, f));
  if (f.v && !(c.vendors || (c.vendors = {}))[f.v]) {
    const v = vendorList_({ isHO: true }).list.find(x => x.name.toLowerCase() === f.v.toLowerCase());
    if (v) c.vendors[f.v] = [v.address, v.phone, v.email];
  }
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
