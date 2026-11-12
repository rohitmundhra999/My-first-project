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
  return { idx: d.idx, names: d.names, asOf: d.asOf, count: d.count, backfill: st };
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
