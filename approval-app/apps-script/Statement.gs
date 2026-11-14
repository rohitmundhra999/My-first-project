
// ======================= HO: check a vendor statement against our invoices (AI reads the statement) =======================
// Lines are matched by invoice number (written a little differently is fine) and amount. A bill on the statement that
// we do not have is also looked up among this vendor's POs without an invoice (same amount): "PO raised, invoice not uploaded".
function statementCheck_(user, req) {
  canVendors_(user);
  const vendor = String(req.vendor || '').replace(/\s+/g, ' ').trim();
  if (!vendor) throw appError_('BAD_REQUEST', 'Pick the vendor first.');
  const parts = [];
  if (req.text) parts.push({ text: 'Vendor statement (from an Excel file):\n' + String(req.text).slice(0, 60000) });
  else {
    checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Statement file');
    parts.push({ inline_data: { mime_type: req.file.type, data: req.file.data } });
  }
  parts.push({ text: 'This is a vendor account statement / ledger sent to us (the buyer) by the vendor "' + vendor + '". Read EVERY line. For each give: ' +
    'date (yyyy-mm-dd), ref (invoice / bill / voucher number exactly as written, "" if none), kind ("invoice" for a bill/sale/debit to us, ' +
    '"payment" for money received from us, "credit" for credit note / return / discount, "opening" for opening balance, "other"), ' +
    'amount (positive rupees). Also give from and to (the statement period, yyyy-mm-dd, "" if not shown) and closing (closing balance, 0 if not shown). ' +
    'Do not invent lines; skip page totals.' });
  const out = geminiJson_(parts, { type: 'OBJECT', properties: { from: { type: 'STRING' }, to: { type: 'STRING' }, closing: { type: 'NUMBER' },
    lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: { date: { type: 'STRING' }, ref: { type: 'STRING' }, kind: { type: 'STRING' }, amount: { type: 'NUMBER' } },
    required: ['ref', 'kind', 'amount'] } } }, required: ['lines'] }, AI_CFG.MODELS);
  const sl = (out.lines || []).slice(0, 600).map(l => ({ date: String(l.date || '').slice(0, 10), ref: String(l.ref || '').slice(0, 60),
    kind: String(l.kind || 'other').toLowerCase(), amt: Math.round((Number(l.amount) || 0) * 100) / 100 }));

  // our side: this vendor's POs (P.Os) and the invoices uploaded against them (INVOICES)
  const b = book_(), vk = vendor.toLowerCase();
  const fd = v => (v instanceof Date ? Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd') : String(v || '').trim());
  const pos = {}, ps = b.getSheetByName(STORE_CFG.POS);
  if (ps && ps.getLastRow() >= 2) ps.getRange(2, 1, ps.getLastRow() - 1, 7).getValues().forEach(r => {
    if (String(r[4]).replace(/\s+/g, ' ').trim().toLowerCase() !== vk) return;
    const k = String(r[1]).trim().toUpperCase();
    if (!k) return;
    const p = pos[k] || (pos[k] = { po: String(r[1]).trim(), d: fd(r[3]), t: 0, l: /^https?:\/\//.test(String(r[2])) ? String(r[2]).trim() : '' });
    if (!p.t) p.t = Number(String(r[6]).replace(/[^0-9.]/g, '')) || 0;
  });
  const ours = [], hasInv = {}, is = b.getSheetByName(STORE_CFG.INVOICES);
  if (is && is.getLastRow() >= 2) is.getRange(2, 1, lastFilled_(is, 1) - 1, 6).getValues().forEach(r => {
    const k = String(r[0]).trim().toUpperCase();
    if (!pos[k]) return;
    hasInv[k] = true;
    ours.push({ po: pos[k].po, inv: String(r[4]).trim(), d: fd(r[5]) || fd(r[2]), amt: Number(String(r[3]).replace(/[^0-9.]/g, '')) || 0,
      il: /^https?:\/\//.test(String(r[1])) ? String(r[1]).trim() : '', pl: pos[k].l });
  });

  const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tail = s => { const m = String(s || '').match(/(\d+)\D*$/); return m ? String(+m[1]) : ''; };
  const same = (a, b) => { const ka = key(a), kb = key(b); if (!ka || !kb) return false;
    if (ka === kb || (ka.length >= 4 && kb.endsWith(ka)) || (kb.length >= 4 && ka.endsWith(kb))) return true;
    return false; };
  const used = {}, matched = [], diff = [], missing = [], money = [];
  sl.forEach(s => {
    if (s.kind !== 'invoice') { if (s.kind !== 'opening' || s.amt) money.push(s); return; }
    let i = ours.findIndex((o, j) => !used[j] && same(o.inv, s.ref));
    if (i < 0) i = ours.findIndex((o, j) => !used[j] && tail(o.inv) && tail(o.inv) === tail(s.ref) && tail(s.ref).length >= 2 && Math.abs(o.amt - s.amt) <= 1);
    if (i >= 0) {
      used[i] = 1; const o = ours[i];
      (Math.abs(o.amt - s.amt) <= 1 ? matched : diff).push({ s: s, o: o, d: Math.round((s.amt - o.amt) * 100) / 100 });
      return;
    }
    // not uploaded with us: is there a PO for this vendor, without an invoice, for (about) the same amount?
    const open = Object.keys(pos).filter(k => !hasInv[k]).map(k => pos[k]);
    const exact = open.filter(p => Math.abs(p.t - s.amt) <= 1);
    const close = exact.length ? [] : open.filter(p => p.t && Math.abs(p.t - s.amt) <= Math.max(1, s.amt * 0.02));
    missing.push({ s: s, po: exact.concat(close).slice(0, 3).map(p => ({ po: p.po, d: p.d, t: p.t, l: p.l, exact: Math.abs(p.t - s.amt) <= 1 })) });
  });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(out.from || '') ? out.from : (sl.map(x => x.date).filter(Boolean).sort()[0] || '');
  const to = /^\d{4}-\d{2}-\d{2}$/.test(out.to || '') ? out.to : (sl.map(x => x.date).filter(Boolean).sort().pop() || '');
  const notInStmt = ours.filter((o, j) => !used[j] && (!from || !o.d || o.d >= from) && (!to || !o.d || o.d <= to));
  const sum = a => Math.round(a.reduce((t, x) => t + x, 0) * 100) / 100;
  return {
    vendor: vendor, from: from, to: to, closing: Number(out.closing) || 0,
    matched: matched, diff: diff, missing: missing, notInStmt: notInStmt, money: money,
    totals: { stmtBills: sum(sl.filter(s => s.kind === 'invoice').map(s => s.amt)), ourBills: sum(ours.filter((o, j) => used[j]).map(o => o.amt).concat(notInStmt.map(o => o.amt))),
      payments: sum(money.filter(m => m.kind === 'payment').map(m => m.amt)), credits: sum(money.filter(m => m.kind === 'credit').map(m => m.amt)) },
  };
}
