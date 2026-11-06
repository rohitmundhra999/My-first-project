/* Non-Local Purchase Dashboard
 * Reads the FMS tab of the NONLOCAL PURCHASES tracker (CSV / XLSX / Google Sheet)
 * and turns it into KPIs, charts and action lists. Runs entirely in the browser.
 */
(() => {
  'use strict';

  // ---------- FMS column layout (offsets from the "ORDER NO" column) ----------
  const C = {
    orderNo: 0, timestamp: 1, unit: 2, category: 3, item: 4, qty: 6, uom: 7,
    approval: 10, approvedBy: 11, approvedQty: 13, paymentTerms: 14,
    poDate: 16, poStatus: 17, deliveryDays: 18, poNo: 19, poAmount: 20,
    payMethod: 22, advancePct: 23, deliveryDue: 24, receivedDate: 25,
    deliveryStatus: 26, receivedQty: 27, invoiceNo: 29, invoiceDate: 30,
    invoiceAmount: 31, vendor: 32, paymentStatus: 35, paymentDate: 37, txn: 39,
  };

  const STAGES = ['Awaiting approval', 'On hold', 'Rejected / withdrawn', 'Awaiting PO', 'Awaiting delivery', 'Received', 'Paid'];
  const STAGE_COLOR = {
    'Awaiting approval': 'var(--muted)', 'On hold': 'var(--warning)', 'Rejected / withdrawn': 'var(--critical)',
    'Awaiting PO': 'var(--serious)', 'Awaiting delivery': 'var(--series)', 'Received': 'var(--good)', 'Paid': 'var(--good)',
  };
  const DAY = 86400000;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const LS_URL = 'nlp.sheetUrl', LS_DATA = 'nlp.cache';

  const $ = (id) => document.getElementById(id);
  const state = { lines: [], filtered: [], source: '', loadedAt: null, tab: 'overdue', sortKey: null, sortDir: -1, shown: 200, trend: 'count', unitMode: 'value' };
  const charts = {};

  // ---------- storage (best-effort) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota / private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- formatting ----------
  const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat('en-IN');
  function inrShort(v) {
    const a = Math.abs(v);
    if (a >= 1e7) return '₹' + (v / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
    if (a >= 1e5) return '₹' + (v / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
    if (a >= 1e3) return '₹' + (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return '₹' + Math.round(v);
  }
  const fmtDate = (d) => d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const pct = (a, b) => b ? Math.round((a / b) * 100) : null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const toNum = (s) => { const n = parseFloat(String(s ?? '').replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const clean = (s) => String(s ?? '').trim();
  const isPlaceholder = (s) => !s || /^(update|#ref!|#n\/a|#value!|-|0)$/i.test(s);

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  function toCSV(rows) {
    return rows.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  }

  // ---------- dates ----------
  // Returns {d, m, y?, h, mi} from the formats the tracker uses:
  // "22-06(16:33)", "21/11 13:17", "17/12/2023 20:03:12", "30-Jul", "2026-06-22".
  function parseParts(s) {
    s = clean(s); if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)))
      return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0) };
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T(]+(\d{1,2}):(\d{2}))?/))) {
      let y = +m[3]; if (y < 100) y += 2000;
      return { y, m: +m[2], d: +m[1], h: +(m[4] || 0), mi: +(m[5] || 0) };
    }
    if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})(?:\s*\(?\s*(\d{1,2}):(\d{2}))?/)))
      return { m: +m[2], d: +m[1], h: +(m[3] || 0), mi: +(m[4] || 0) };
    if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*(?:[-\s,]+(\d{2,4}))?/))) {
      const mo = MONTHS.indexOf(m[2].toLowerCase()); if (mo < 0) return null;
      let y = m[3] ? +m[3] : undefined; if (y && y < 100) y += 2000;
      return { y, m: mo + 1, d: +m[1], h: 0, mi: 0 };
    }
    return null;
  }
  const valid = (p) => p && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31;
  const mk = (p, y) => new Date(y, p.m - 1, p.d, p.h || 0, p.mi || 0);
  // A date without a year that belongs after `ref` (e.g. a PO raised after the requisition).
  function after(p, ref) {
    if (!valid(p)) return null;
    if (p.y) return mk(p, p.y);
    if (!ref) return mk(p, new Date().getFullYear());
    let d = mk(p, ref.getFullYear());
    if (d < ref - 45 * DAY) d = mk(p, ref.getFullYear() + 1);
    return d;
  }
  // Requisition timestamps have no year. Rows are appended in time order, so walk
  // backwards from the newest row (this year) and step back a year whenever the
  // month jumps forward by more than a couple of months (e.g. Jan -> previous Dec).
  function assignYears(parts) {
    const now = Date.now();
    let year = new Date().getFullYear(), prevM = null;
    const out = new Array(parts.length).fill(null);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; if (!valid(p)) continue;
      if (p.y) { out[i] = mk(p, p.y); year = p.y; prevM = p.m; continue; }
      if (prevM === null) { if (mk(p, year) - now > DAY) year--; }
      else if (p.m > prevM + 2) year--;
      prevM = p.m; out[i] = mk(p, year);
    }
    return out;
  }

  // ---------- parse FMS rows into purchase lines ----------
  function findHeader(rows) {
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const cells = rows[r].map((c) => clean(c).toUpperCase());
      const base = cells.indexOf('ORDER NO');
      if (base >= 0 && cells[base + 1] === 'TIMESTAMP') return { r, base };
    }
    return null;
  }

  function parseFMS(rows) {
    const h = findHeader(rows);
    if (!h) throw new Error('Could not find the FMS header row (expected "ORDER NO" followed by "TIMESTAMP"). Make sure you loaded the FMS tab.');
    const body = rows.slice(h.r + 1).filter((r) => clean(r[h.base]) || clean(r[h.base + C.item]));
    const g = (r, k) => clean(r[h.base + C[k]]);
    const reqDates = assignYears(body.map((r) => parseParts(g(r, 'timestamp'))));
    const today = startOfDay(new Date());

    return body.map((r, i) => {
      const reqDate = reqDates[i];
      const approvalRaw = g(r, 'approval');
      const approval = /approv/i.test(approvalRaw) ? 'Approved' : /hold/i.test(approvalRaw) ? 'On Hold'
        : /reject/i.test(approvalRaw) ? 'Rejected' : /withdr|cancel/i.test(approvalRaw) ? 'Withdrawn' : approvalRaw ? approvalRaw : 'Pending';
      const poNo = isPlaceholder(g(r, 'poNo')) ? '' : g(r, 'poNo');
      const poDate = poNo ? after(parseParts(g(r, 'poDate')), reqDate) : null;
      const deliveryDue = poNo ? after(parseParts(g(r, 'deliveryDue')), poDate || reqDate) : null;
      const receivedDate = after(parseParts(g(r, 'receivedDate')), poDate || reqDate);
      const receivedQty = toNum(g(r, 'receivedQty'));
      const invoiceNo = isPlaceholder(g(r, 'invoiceNo')) ? '' : g(r, 'invoiceNo');
      const received = !!poNo && (!!receivedDate || receivedQty > 0 || !!invoiceNo);
      const paymentDate = isPlaceholder(g(r, 'paymentDate')) ? '' : g(r, 'paymentDate');
      const txn = isPlaceholder(g(r, 'txn')) ? '' : g(r, 'txn');
      const paid = received && (!!paymentDate || !!txn);

      let stage;
      if (approval === 'Rejected' || approval === 'Withdrawn') stage = 'Rejected / withdrawn';
      else if (approval === 'On Hold') stage = 'On hold';
      else if (approval !== 'Approved' && !poNo) stage = 'Awaiting approval';
      else if (!poNo) stage = 'Awaiting PO';
      else if (!received) stage = 'Awaiting delivery';
      else if (!paid) stage = 'Received';
      else stage = 'Paid';

      const overdue = stage === 'Awaiting delivery' && deliveryDue && deliveryDue < today;
      const ageFrom = stage === 'Awaiting delivery' ? (overdue ? deliveryDue : poDate) : reqDate;
      return {
        orderNo: g(r, 'orderNo'), reqDate, unit: g(r, 'unit').toUpperCase() || '(blank)',
        category: g(r, 'category').toUpperCase() || '(blank)', item: g(r, 'item'),
        qty: toNum(g(r, 'qty')), uom: g(r, 'uom'), approval, approvedBy: g(r, 'approvedBy'),
        poNo, poDate, poStatus: g(r, 'poStatus').toUpperCase(), poAmount: toNum(g(r, 'poAmount')),
        payMethod: isPlaceholder(g(r, 'payMethod')) ? '' : g(r, 'payMethod'),
        deliveryDue, receivedDate, deliveryStatus: g(r, 'deliveryStatus').toUpperCase(), receivedQty,
        invoiceNo, vendor: poNo ? (g(r, 'vendor') || '(not recorded)') : '',
        paymentDate, txn, stage, overdue,
        age: ageFrom ? Math.max(0, Math.floor((today - startOfDay(ageFrom)) / DAY)) : null,
      };
    });
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  // ---------- loading ----------
  function msg(text, err) { const m = $('loadMsg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); }

  function ingest(rows, source, { cache = true } = {}) {
    const lines = parseFMS(rows);
    if (!lines.length) throw new Error('The FMS tab has a header but no purchase lines.');
    state.lines = lines; state.source = source; state.loadedAt = new Date();
    if (cache) store.set(LS_DATA, JSON.stringify({ source, rows: rows.slice(0, 20000) }));
    populateFilters(); applyFilters();
    $('empty').hidden = true; $('dash').hidden = false; $('dataPanel').hidden = true;
    msg('');
  }

  async function loadFile(file) {
    msg('Reading ' + file.name + '…');
    try {
      let rows;
      if (/\.csv$/i.test(file.name)) rows = parseCSV(await file.text());
      else {
        if (!window.XLSX) throw new Error('The spreadsheet reader did not load. Check your connection, or upload a CSV instead.');
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const name = wb.SheetNames.find((n) => n.trim().toUpperCase() === 'FMS')
          || wb.SheetNames.find((n) => findHeader(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }).slice(0, 30)))
          || wb.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
      }
      store.del(LS_URL); $('btnRefresh').hidden = true;
      ingest(rows, file.name);
    } catch (e) { msg(e.message, true); }
  }

  function toCsvUrl(url) {
    url = url.trim();
    if (/\/pub\?|output=csv|format=csv/.test(url)) return url;
    const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!id) return url;
    const gid = url.match(/[#&?]gid=(\d+)/);
    return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv${gid ? '&gid=' + gid[1] : ''}`;
  }

  async function loadUrl(url, quiet) {
    if (!url) return;
    if (!quiet) msg('Fetching sheet…');
    try {
      const res = await fetch(toCsvUrl(url), { cache: 'no-store' });
      if (!res.ok) throw new Error('Google returned ' + res.status + '. Is the sheet published or shared as "Anyone with the link"?');
      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Got a web page instead of CSV. Publish the FMS tab to the web as CSV, or share it as "Anyone with the link".');
      store.set(LS_URL, url); $('btnRefresh').hidden = false;
      ingest(parseCSV(text), 'Google Sheet', { cache: false });
    } catch (e) {
      const m = e instanceof TypeError ? 'Could not reach the sheet (network or sharing settings).' : e.message;
      if (quiet && state.lines.length) setSource(' · refresh failed: ' + m); else { $('dataPanel').hidden = false; msg(m, true); }
    }
  }

  // ---------- demo data (made-up, clearly labelled) ----------
  function demoRows() {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const units = ['PINECREST', 'RIVERSIDE', 'CLOUD NINE', 'TEA GARDEN', 'SNOWVIEW', 'MAPLE COURT', 'HILLTOP', 'LAKESHORE', 'ORCHID', 'SUMMIT HO'];
    const cats = { 'F&B': ['TEA CUPS', 'FULL PLATE', 'WHISKY GLASS', 'SOUP BOWL', 'BUFFET CHAFING DISH', 'JUICE GLASS'], 'HOUSE KEEPING': ['DOUBLE DUVET', 'BATH TOWEL', 'VACUUM CLEANER', 'DOOR KEY CARDS', 'LAUNDRY BAG', 'PILLOW COVER'], 'REPAIR-MAINTENANCE': ['LED BULB 9W', 'PVC PIPE', 'WATER HEATER', 'DOOR CLOSER', 'MCB 32A'], 'MAIN KITCHEN': ['CHOPPING BOARD', 'MIXER GRINDER', 'GN PAN', 'KNIFE SET'], 'UNIFORM': ['CHEF COAT', 'SWEAT SHIRT', 'BLAZER'], 'ACCOUNTS': ['BILL SCANNER', 'PRINTER TONER'], 'FRONT OFFICE': ['WELCOME CARDS', 'LUGGAGE TAG', 'KEY JACKET'] };
    const vendors = ['Alpha Hotel Supplies', 'Bright Linen Co', 'Crest Crockery House', 'Delta Electricals', 'Eastline Traders', 'Fineware Imports', 'Granite Hardware', 'Horizon Uniforms', 'Ivy Office Mart', 'Jade Kitchen Equip'];
    const header = new Array(41).fill('');
    ['ORDER NO', 'TIMESTAMP', 'UNIT', 'CATEGORY', 'ITEM'].forEach((v, i) => (header[i] = v));
    Object.assign(header, { 6: 'QTY', 7: 'UNIT', 10: 'APPROVAL', 11: 'APPROVED BY', 13: 'QTY', 16: 'ACTUAL', 17: '', 19: 'P.O NO.', 20: 'AMOUNT', 24: 'PLANNED', 25: 'ACTUAL', 27: 'RECEIVED', 29: 'INVOICE NUMBER', 32: 'VENDOR', 37: 'ACTUAL', 39: 'TRANSACTION DETAILS' });
    const rows = [['DEMO DATA'], [], header];
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}(${pad(d.getHours())}:${pad(d.getMinutes())})`;
    const now = Date.now(); const start = now - 300 * DAY;
    let t = start; const pos = [];
    while (t < now - DAY) {
      t += rnd() * 14 * 3600000 + 1800000;
      const unit = pick(units), cat = pick(Object.keys(cats)); const lines = 1 + Math.floor(rnd() * 4);
      const age = (now - t) / DAY; const r = rnd();
      const approval = r < 0.06 ? 'Rejected' : r < 0.10 ? 'Withdrawn' : r < (age < 10 ? 0.35 : 0.16) ? 'On Hold' : (age < 3 && r < 0.5) ? '' : 'Approved';
      const getsPO = approval === 'Approved' && (age > 6 || rnd() < 0.4) && rnd() < 0.93;
      const vendor = pick(vendors); const poAt = new Date(t + (0.5 + rnd() * rnd() * 7) * DAY);
      const poNo = getsPO ? `${unit.slice(0, 2)}${vendor.slice(0, 2).toUpperCase()}${pad(pos.length % 100)}${pad(poAt.getDate())}${pad(poAt.getMonth() + 1)}-${pad(poAt.getHours())}${pad(poAt.getMinutes())}` : '';
      const amount = Math.round((2000 + rnd() * rnd() * 180000) / 10) * 10;
      const days = [7, 10, 15, 25][Math.floor(rnd() * 4)];
      const due = new Date(+poAt + days * DAY);
      const lateBy = rnd() < 0.3 ? rnd() * 20 : -rnd() * 4;
      const recAt = new Date(+due + lateBy * DAY);
      const received = getsPO && recAt < now && ((now - recAt) / DAY > 40 || rnd() < 0.6);
      const paid = received && (now - recAt) / DAY > 12 && rnd() < 0.8;
      pos.push(poNo);
      for (let k = 0; k < lines; k++) {
        const at = new Date(t + k * 60000); const item = pick(cats[cat]); const qty = pick([1, 2, 4, 6, 12, 24, 36, 48]);
        const row = new Array(41).fill('');
        Object.assign(row, {
          0: `${unit.slice(0, 2)}${item.slice(0, 2)}-${pad(at.getDate())}${pad(at.getMonth() + 1)}-${pad(at.getHours())}${pad(at.getMinutes())}-${pad(Math.floor(rnd() * 100))}`,
          1: stamp(at), 2: unit, 3: cat, 4: item, 6: qty, 7: 'Pcs', 10: approval, 11: approval ? pick(['Purchase Head', 'Ops Manager']) : '', 13: qty,
        });
        if (getsPO) Object.assign(row, { 16: stamp(poAt), 17: (poAt - t) / DAY > 4 ? 'DELAYED' : 'ON TIME', 18: days, 19: poNo, 20: amount, 22: rnd() < 0.8 ? 'CREDIT' : 'ADVANCE', 24: stamp(due), 26: received ? (lateBy > 0 ? 'DELAYED' : 'ON TIME') : 'NOT RECEIVED', 32: vendor });
        if (received) Object.assign(row, { 25: stamp(recAt), 27: qty, 29: 'INV-' + Math.floor(rnd() * 9000 + 1000) });
        if (paid) Object.assign(row, { 37: stamp(new Date(+recAt + 10 * DAY)), 39: 'NEFT' });
        rows.push(row);
      }
    }
    return rows;
  }

  // ---------- filters ----------
  function fill(sel, values, label) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
    if (values.includes(cur)) sel.value = cur;
  }
  function populateFilters() {
    const uniq = (k) => [...new Set(state.lines.map((l) => l[k]).filter(Boolean))].sort();
    fill($('fUnit'), uniq('unit'), 'All units');
    fill($('fCategory'), uniq('category'), 'All categories');
    fill($('fVendor'), uniq('vendor'), 'All vendors');
  }
  function periodRange() {
    const p = $('fPeriod').value, now = new Date(), today = startOfDay(now);
    if (p === 'mtd') return [new Date(now.getFullYear(), now.getMonth(), 1), null];
    if (p === '30' || p === '90') return [new Date(+today - (+p - 1) * DAY), null];
    if (p === 'fy') { const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; return [new Date(y, 3, 1), null]; }
    if (p === 'custom') {
      const f = $('fFrom').value, t = $('fTo').value;
      return [f ? new Date(f + 'T00:00') : null, t ? new Date(+new Date(t + 'T00:00') + DAY) : null];
    }
    return [null, null];
  }
  function applyFilters() {
    const [from, to] = periodRange();
    const unit = $('fUnit').value, cat = $('fCategory').value, vendor = $('fVendor').value, stage = $('fStage').value;
    const q = $('fSearch').value.trim().toLowerCase();
    state.filtered = state.lines.filter((l) => {
      if (from && !(l.reqDate && l.reqDate >= from)) return false;
      if (to && !(l.reqDate && l.reqDate < to)) return false;
      if (unit && l.unit !== unit) return false;
      if (cat && l.category !== cat) return false;
      if (vendor && l.vendor !== vendor) return false;
      if (stage && l.stage !== stage) return false;
      if (q && !(`${l.item} ${l.orderNo} ${l.poNo} ${l.vendor} ${l.invoiceNo}`.toLowerCase().includes(q))) return false;
      return true;
    });
    state.shown = 200;
    render();
  }

  // ---------- aggregation ----------
  function purchaseOrders(lines) {
    const map = new Map();
    for (const l of lines) {
      if (!l.poNo) continue;
      let po = map.get(l.poNo);
      if (!po) {
        po = { poNo: l.poNo, amount: l.poAmount, unit: l.unit, vendor: l.vendor, date: l.poDate || l.reqDate, firstReq: l.reqDate, poStatus: l.poStatus, deliveryStatus: l.deliveryStatus, poDate: l.poDate, received: l.receivedDate, lines: 0 };
        map.set(l.poNo, po);
      }
      po.lines++;
      if (!po.amount && l.poAmount) po.amount = l.poAmount;
      if (l.reqDate && (!po.firstReq || l.reqDate < po.firstReq)) po.firstReq = l.reqDate;
      if (l.receivedDate && (!po.received || l.receivedDate > po.received)) po.received = l.receivedDate;
    }
    return [...map.values()];
  }
  function groupSum(items, key, val) {
    const m = new Map();
    for (const it of items) { const k = it[key] || '(blank)'; m.set(k, (m.get(k) || 0) + val(it)); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  // ---------- rendering ----------
  function setSource(extra = '') {
    const when = state.loadedAt ? state.loadedAt.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    $('sourceLine').textContent = `${state.source} · ${num.format(state.lines.length)} lines · loaded ${when}${extra}`;
  }

  function render() {
    setSource();
    const L = state.filtered, POs = purchaseOrders(L);
    renderKPIs(L, POs);
    renderCharts(L, POs);
    renderTurnaround(POs);
    renderTable();
  }

  function renderKPIs(L, POs) {
    const by = (s) => L.filter((l) => l.stage === s).length;
    const approved = L.filter((l) => l.approval === 'Approved').length;
    const decided = L.filter((l) => l.approval !== 'Pending').length;
    const value = POs.reduce((s, p) => s + p.amount, 0);
    const awaitingDel = by('Awaiting delivery'), overdue = L.filter((l) => l.overdue).length;
    const received = by('Received') + by('Paid');
    const units = new Set(L.map((l) => l.unit)).size;
    const tiles = [
      { label: 'Requisition lines', value: num.format(L.length), note: `${units} unit${units === 1 ? '' : 's'}` },
      { label: 'Approved', value: num.format(approved), note: decided ? `${pct(approved, decided)}% of decided` : '—' },
      { label: 'On hold / pending', value: num.format(by('On hold') + by('Awaiting approval')), note: `${num.format(by('On hold'))} on hold`, stage: 'On hold' },
      { label: 'Awaiting PO', value: num.format(by('Awaiting PO')), note: 'approved, no PO yet', stage: 'Awaiting PO' },
      { label: 'POs raised', value: num.format(POs.length), note: `${num.format(L.filter((l) => l.poNo).length)} lines` },
      { label: 'PO value', value: inrShort(value), note: inr.format(value) },
      { label: 'Overdue delivery', value: num.format(overdue), note: `of ${num.format(awaitingDel)} awaiting delivery`, flag: overdue ? 'critical' : 'good', tab: 'overdue' },
      { label: 'Received', value: num.format(received), note: `${num.format(by('Paid'))} paid`, stage: 'Received' },
    ];
    $('kpis').innerHTML = tiles.map((t, i) => `
      <div class="kpi${t.stage || t.tab ? ' clickable' : ''}" data-i="${i}" ${t.stage || t.tab ? 'role="button" tabindex="0"' : ''}>
        <div class="label">${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="note">${t.flag ? `<span class="flag"><i style="background:var(--${t.flag})"></i>${t.flag === 'critical' ? 'Needs follow-up' : 'All on track'}</span> · ` : ''}${t.note}</div>
      </div>`).join('');
    $('kpis').querySelectorAll('.kpi.clickable').forEach((el) => {
      const t = tiles[+el.dataset.i];
      const go = () => {
        if (t.tab) { setTab(t.tab); document.querySelector('.tablecard').scrollIntoView({ behavior: 'smooth' }); }
        else { $('fStage').value = $('fStage').value === t.stage ? '' : t.stage; applyFilters(); }
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function barChart(id, labels, data, { horizontal = true, money = false, onClick } = {}) {
    if (!window.Chart) return;
    const series = cssVar('--series'), ink2 = cssVar('--ink-2'), grid = cssVar('--grid'), axis = cssVar('--axis');
    const surface = cssVar('--surface'), ink = cssVar('--ink'), border = cssVar('--border');
    const fmt = (v) => money ? inrShort(v) : num.format(v);
    const valueAxis = { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: ink2, callback: (v) => fmt(v), maxTicksLimit: 6, padding: 6 }, beginAtZero: true };
    const catAxis = { grid: { display: false }, border: { color: axis }, ticks: { color: ink2, autoSkip: !horizontal, callback(v) { const s = this.getLabelForValue(v); return s.length > 22 ? s.slice(0, 21) + '…' : s; } } };
    const cfg = {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: series, hoverBackgroundColor: series, borderRadius: 4, borderSkipped: 'start', maxBarThickness: horizontal ? 18 : 28, categoryPercentage: 0.8, barPercentage: 0.9 }] },
      options: {
        indexAxis: horizontal ? 'y' : 'x', responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: surface, titleColor: ink, bodyColor: ink2, borderColor: border, borderWidth: 1, padding: 8, displayColors: false, callbacks: { label: (c) => money ? inr.format(c.raw) : num.format(c.raw) } },
        },
        onClick: onClick ? (e, els) => { if (els.length) onClick(labels[els[0].index]); } : undefined,
        onHover: onClick ? (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } : undefined,
      },
    };
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart($(id), cfg);
  }

  function setFilter(sel, v) { $(sel).value = $(sel).value === v ? '' : v; applyFilters(); }

  function renderCharts(L, POs) {
    // Pipeline: how many lines have reached each stage.
    const reached = (s) => L.filter((l) => STAGES.indexOf(l.stage) >= STAGES.indexOf(s) && !['On hold', 'Rejected / withdrawn'].includes(l.stage)).length;
    const pipe = [
      ['Requisitioned', L.length],
      ['Approved', L.filter((l) => l.approval === 'Approved' || l.poNo).length],
      ['PO raised', L.filter((l) => l.poNo).length],
      ['Received', reached('Received')],
      ['Paid', reached('Paid')],
    ];
    barChart('cPipeline', pipe.map((p) => p[0]), pipe.map((p) => p[1]));

    // Monthly trend (one measure at a time, never two axes).
    const months = new Map();
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (state.trend === 'count') L.forEach((l) => { if (l.reqDate) months.set(key(l.reqDate), (months.get(key(l.reqDate)) || 0) + 1); });
    else POs.forEach((p) => { if (p.date) months.set(key(p.date), (months.get(key(p.date)) || 0) + p.amount); });
    const mk = [...months.keys()].sort();
    const labels = mk.map((k) => { const [y, m] = k.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); });
    $('trendSub').textContent = state.trend === 'count' ? 'Requisition lines per month' : 'PO value per month (by PO date)';
    barChart('cTrend', labels, mk.map((k) => months.get(k)), { horizontal: false, money: state.trend === 'value' });

    // By unit
    const unitData = state.unitMode === 'value' ? groupSum(POs, 'unit', (p) => p.amount) : groupSum(L, 'unit', () => 1);
    $('unitSub').textContent = state.unitMode === 'value' ? 'PO value · click a bar to filter' : 'Requisition lines · click a bar to filter';
    barChart('cUnit', unitData.map((d) => d[0]), unitData.map((d) => d[1]), { money: state.unitMode === 'value', onClick: (v) => setFilter('fUnit', v) });

    const vend = groupSum(POs, 'vendor', (p) => p.amount).slice(0, 12);
    barChart('cVendor', vend.map((d) => d[0]), vend.map((d) => d[1]), { money: true, onClick: (v) => setFilter('fVendor', v) });

    const cats = groupSum(L, 'category', () => 1).slice(0, 15);
    barChart('cCategory', cats.map((d) => d[0]), cats.map((d) => d[1]), { onClick: (v) => setFilter('fCategory', v) });
  }

  function renderTurnaround(POs) {
    const onTime = (k) => { const on = POs.filter((p) => p[k] === 'ON TIME').length, late = POs.filter((p) => p[k] === 'DELAYED').length; return { on, late, p: pct(on, on + late) }; };
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const reqToPo = avg(POs.filter((p) => p.poDate && p.firstReq).map((p) => (p.poDate - p.firstReq) / DAY).filter((d) => d >= 0 && d < 365));
    const poToRec = avg(POs.filter((p) => p.poDate && p.received).map((p) => (p.received - p.poDate) / DAY).filter((d) => d >= 0 && d < 365));
    const po = onTime('poStatus'), del = onTime('deliveryStatus');
    const flag = (p) => p === null ? '' : p >= 90 ? ['good', 'On target'] : p >= 75 ? ['warning', 'Watch'] : ['critical', 'Below target'];
    const tile = (label, o) => {
      const f = flag(o.p);
      return `<div class="t"><div class="label">${label}</div><div class="value">${o.p === null ? '—' : o.p + '%'}</div>
        ${f ? `<span class="flag"><i style="background:var(--${f[0]})"></i>${f[1]}</span>` : ''}
        <div class="note muted" style="font-size:12px">${num.format(o.on)} on time · ${num.format(o.late)} delayed</div>
        <div class="meter"><i style="width:${o.p || 0}%"></i></div></div>`;
    };
    const days = (label, v) => `<div class="t"><div class="label">${label}</div><div class="value">${v === null ? '—' : v.toFixed(1)}</div><div class="note muted" style="font-size:12px">days on average</div></div>`;
    $('turnaround').innerHTML = tile('PO raised on time', po) + tile('Delivered on time', del) + days('Requisition → PO', reqToPo) + days('PO → material received', poToRec);
  }

  // ---------- table ----------
  const COLS = {
    unit: ['Unit', (l) => l.unit], category: ['Category', (l) => l.category], item: ['Item', (l) => l.item, 'wrap'],
    qty: ['Qty', (l) => l.qty, 'num', (l) => `${num.format(l.qty)} ${esc(l.uom)}`], vendor: ['Vendor', (l) => l.vendor],
    poNo: ['PO no.', (l) => l.poNo], orderNo: ['Order no.', (l) => l.orderNo],
    reqDate: ['Requested', (l) => l.reqDate, '', (l) => fmtDate(l.reqDate)], poDate: ['PO date', (l) => l.poDate, '', (l) => fmtDate(l.poDate)],
    due: ['Due', (l) => l.deliveryDue, '', (l) => fmtDate(l.deliveryDue)],
    age: ['Days', (l) => l.age ?? -1, 'num', (l) => l.age ?? ''],
    amount: ['PO value', (l) => l.poAmount, 'num', (l) => l.poAmount ? inr.format(l.poAmount) : ''],
    approvedBy: ['Approved by', (l) => l.approvedBy],
    stage: ['Stage', (l) => l.stage, '', (l) => `<span class="pill"><i style="background:${STAGE_COLOR[l.stage]}"></i>${esc(l.overdue ? 'Overdue delivery' : l.stage)}</span>`],
  };
  const TABS = {
    overdue: { rows: (L) => L.filter((l) => l.overdue), cols: ['unit', 'vendor', 'poNo', 'item', 'qty', 'poDate', 'due', 'age', 'amount'], sort: 'age', ageLabel: 'Days late' },
    nopo: { rows: (L) => L.filter((l) => l.stage === 'Awaiting PO'), cols: ['unit', 'category', 'item', 'qty', 'reqDate', 'approvedBy', 'age'], sort: 'age', ageLabel: 'Days waiting' },
    hold: { rows: (L) => L.filter((l) => l.stage === 'On hold' || l.stage === 'Awaiting approval'), cols: ['unit', 'category', 'item', 'qty', 'reqDate', 'stage', 'age'], sort: 'age', ageLabel: 'Days waiting' },
    all: { rows: (L) => L, cols: ['orderNo', 'reqDate', 'unit', 'category', 'item', 'qty', 'stage', 'vendor', 'poNo', 'amount'], sort: 'reqDate' },
  };
  function setTab(t) { state.tab = t; state.sortKey = null; state.shown = 200; renderTable(); }
  function currentRows() {
    const tab = TABS[state.tab]; const key = state.sortKey || tab.sort; const get = COLS[key][1];
    return tab.rows(state.filtered).slice().sort((a, b) => {
      const x = get(a), y = get(b);
      const cmp = (x instanceof Date || y instanceof Date) ? ((x ? +x : 0) - (y ? +y : 0)) : typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return cmp * state.sortDir;
    });
  }
  function renderTable() {
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
      b.querySelector('.count').textContent = num.format(TABS[b.dataset.tab].rows(state.filtered).length);
    });
    const tab = TABS[state.tab]; const rows = currentRows(); const key = state.sortKey || tab.sort;
    const head = tab.cols.map((c) => {
      const [label, , cls] = COLS[c]; const name = c === 'age' && tab.ageLabel ? tab.ageLabel : label;
      return `<th class="${cls === 'num' ? 'num' : ''}" data-col="${c}" aria-sort="${c === key ? (state.sortDir < 0 ? 'descending' : 'ascending') : 'none'}">${name}${c === key ? (state.sortDir < 0 ? ' ↓' : ' ↑') : ''}</th>`;
    }).join('');
    const body = rows.slice(0, state.shown).map((l) => '<tr>' + tab.cols.map((c) => {
      const [, get, cls, show] = COLS[c];
      return `<td class="${cls || ''}">${show ? show(l) : esc(get(l))}</td>`;
    }).join('') + '</tr>').join('');
    $('table').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${tab.cols.length}" class="muted">Nothing here for the current filters.</td></tr>`}</tbody>`;
    $('table').querySelectorAll('th').forEach((th) => th.addEventListener('click', () => {
      const c = th.dataset.col; if ((state.sortKey || tab.sort) === c) state.sortDir *= -1; else { state.sortKey = c; state.sortDir = -1; }
      renderTable();
    }));
    $('btnMore').hidden = rows.length <= state.shown;
    $('btnMore').textContent = `Show more (${num.format(rows.length - state.shown)} left)`;
  }

  function exportCSV() {
    if (!state.filtered.length) return;
    const head = ['Order no', 'Requested', 'Unit', 'Category', 'Item', 'Qty', 'UOM', 'Approval', 'Approved by', 'Stage', 'Overdue', 'PO no', 'PO date', 'PO amount (PO total)', 'Vendor', 'Delivery due', 'Received', 'Invoice no', 'Payment'];
    const d = (x) => x ? x.toISOString().slice(0, 10) : '';
    const rows = state.filtered.map((l) => [l.orderNo, d(l.reqDate), l.unit, l.category, l.item, l.qty, l.uom, l.approval, l.approvedBy, l.stage, l.overdue ? 'Yes' : '', l.poNo, d(l.poDate), l.poAmount || '', l.vendor, d(l.deliveryDue), d(l.receivedDate), l.invoiceNo, l.paymentDate || l.txn]);
    const blob = new Blob(['﻿' + toCSV([head, ...rows])], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `nonlocal-purchases-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- wiring ----------
  $('btnData').addEventListener('click', () => { $('dataPanel').hidden = !$('dataPanel').hidden; });
  $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  $('btnConnect').addEventListener('click', () => loadUrl($('sheetUrl').value));
  $('sheetUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl($('sheetUrl').value); });
  $('btnDemo').addEventListener('click', () => { store.del(LS_URL); $('btnRefresh').hidden = true; try { ingest(demoRows(), 'Demo data (made up)', { cache: false }); } catch (e) { msg(e.message, true); } });
  $('btnRefresh').addEventListener('click', () => loadUrl(store.get(LS_URL), true));
  $('btnExport').addEventListener('click', exportCSV);
  $('btnMore').addEventListener('click', () => { state.shown += 200; renderTable(); });
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  document.querySelectorAll('[data-trend]').forEach((b) => b.addEventListener('click', () => {
    state.trend = b.dataset.trend; document.querySelectorAll('[data-trend]').forEach((x) => x.classList.toggle('on', x === b)); if (state.lines.length) renderCharts(state.filtered, purchaseOrders(state.filtered));
  }));
  document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    state.unitMode = b.dataset.unit; document.querySelectorAll('[data-unit]').forEach((x) => x.classList.toggle('on', x === b)); if (state.lines.length) renderCharts(state.filtered, purchaseOrders(state.filtered));
  }));
  ['fUnit', 'fCategory', 'fVendor', 'fStage', 'fFrom', 'fTo'].forEach((id) => $(id).addEventListener('change', applyFilters));
  $('fPeriod').addEventListener('change', () => { $('customRange').hidden = $('fPeriod').value !== 'custom'; applyFilters(); });
  let t; $('fSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(applyFilters, 200); });
  $('btnReset').addEventListener('click', () => {
    ['fUnit', 'fCategory', 'fVendor', 'fStage', 'fSearch', 'fFrom', 'fTo'].forEach((id) => ($(id).value = ''));
    $('fPeriod').value = 'all'; $('customRange').hidden = true; applyFilters();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.lines.length) render(); });

  // ---------- start ----------
  const savedUrl = store.get(LS_URL);
  if (savedUrl) { $('sheetUrl').value = savedUrl; loadUrl(savedUrl, false); }
  else {
    const cached = store.get(LS_DATA);
    if (cached) { try { const c = JSON.parse(cached); ingest(c.rows, c.source + ' (saved copy)', { cache: false }); } catch { store.del(LS_DATA); } }
  }

  // Exposed for tests.
  window.NLP = { parseFMS, parseCSV, parseParts, assignYears, demoRows };
})();
