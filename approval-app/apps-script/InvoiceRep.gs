
// ======================= HO: Invoices report (INVOICES tab + the PO each invoice is for) =======================
/** Every uploaded invoice (latest first) with its PO (P.Os tab) and the vendor's details. HO and admin only. */
function invoiceReport_(user) {
  canVendors_(user);
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
      if (!p.t) p.t = Number(String(r[6]).replace(/[^0-9.]/g, '')) || 0; if (!p.u) p.u = String(r[7]).trim();
    });
  }
  const rows = [], is = b.getSheetByName(STORE_CFG.INVOICES);
  if (is) {
    const last = lastFilled_(is, 1), first = Math.max(2, last - 4000 + 1);
    if (last >= 2) is.getRange(first, 1, last - first + 1, 6).getValues().forEach(r => {
      const k = String(r[0]).trim().toUpperCase();
      if (!k) return;
      const p = po[k] || {};
      rows.push({ po: String(r[0]).trim(), il: url(r[1]), up: fd(r[2]), amt: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0,
        inv: String(r[4]).trim(), idt: fd(r[5]), v: p.v || '', u: p.u || '', pd: p.d || '', pt: p.t || 0, pl: p.l || '', pn: p.n || 0 });
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
