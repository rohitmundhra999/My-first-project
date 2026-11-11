// ======================= Status of goods (HO) + file download/share =======================
// A separate file so the main code stays as it is. New sheet tab "GOODS STATUS" (made on first save);
// nothing in FMS or any existing tab is changed. One row per update; the latest row of a PO is its current status.

const GOODS_CFG = {
  TAB: 'GOODS STATUS',
  HEADER: ['Time', 'PO No', 'Unit', 'Vendor', 'Status', 'Remark', 'Document', 'Updated By', 'Email'],
  CACHE: 'goods_list_' + MODE,
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
  const list = order.map(k => Object.assign(pos[k], { link: links[k] || '' }));
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
