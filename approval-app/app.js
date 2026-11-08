// NLP Approvals - front end. Talks to the Apps Script backend; all permission checks happen there.
const CFG = self.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nlp.idToken';
const state = {
  idToken: null, me: null, tab: null, ho: null, mine: null, sel: new Set(), qty: {}, busy: false,
  viewAs: null,          // admin preview: email of the person whose screens are shown (read-only)
  reports: null, repAt: 0,
  rep: { type: 'nr', view: 'list', cluster: '', unit: '', month: '', age: '', q: '', sort: 'old' },
};
const WRITE_ACTIONS = ['assign', 'decide', 'register'];

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
function toast(msg, isErr) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3500);
}
function banner(html) { const b = $('banner'); b.innerHTML = html || ''; b.hidden = !html; }
function show(id) { ['signin', 'loading', 'app'].forEach((s) => ($(s).hidden = s !== id)); }
function jwtPayload(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}
const configured = () => CFG.API_URL && !/PASTE/.test(CFG.API_URL) && CFG.GOOGLE_CLIENT_ID && !/PASTE/.test(CFG.GOOGLE_CLIENT_ID);

// ---------- API ----------
class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function api(action, data = {}) {
  let res;
  try {
    res = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // "simple" request: no CORS preflight
      body: JSON.stringify({ action, idToken: state.idToken, ...(state.viewAs && !WRITE_ACTIONS.includes(action) ? { viewAs: state.viewAs } : {}), ...data }),
    });
  } catch { throw new ApiError('NETWORK', 'No connection. Check your internet and try again.'); }
  let out;
  try { out = await res.json(); } catch { throw new ApiError('SERVER', 'Unexpected reply from the server (' + res.status + ').'); }
  if (!out.ok) throw new ApiError(out.code, out.error || 'Something went wrong.');
  return out;
}

// ---------- sign-in (Google Identity Services) ----------
function waitForGsi() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (window.google?.accounts?.id) return resolve();
      if (Date.now() - t0 > 15000) return reject(new Error('Google sign-in did not load. Check your connection.'));
      setTimeout(poll, 100);
    })();
  });
}
function tokenValid(t) { const p = t && jwtPayload(t); return p && p.exp * 1000 > Date.now() + 120000; }

async function startSignIn(message) {
  show('signin');
  $('signinMsg').textContent = message || '';
  try { await waitForGsi(); } catch (e) { $('signinMsg').textContent = e.message; return; }
  google.accounts.id.initialize({
    client_id: CFG.GOOGLE_CLIENT_ID,
    callback: (r) => onCredential(r.credential),
    auto_select: true,
    hd: 'summithotels.in',
    use_fedcm_for_prompt: true,
  });
  $('gsiButton').innerHTML = '';
  google.accounts.id.renderButton($('gsiButton'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with' });
  google.accounts.id.prompt();
}
function onCredential(token) {
  state.idToken = token; store.set(TOKEN_KEY, token);
  boot();
}
function signOut() {
  store.del(TOKEN_KEY); state.idToken = null; state.me = null; state.viewAs = null; state.ho = state.mine = state.reports = null;
  $('viewAsBar').hidden = true; document.body.classList.remove('preview');
  try { google.accounts.id.disableAutoSelect(); } catch { /* not loaded */ }
  $('who').textContent = ''; $('btnSignOut').hidden = true; $('btnRefresh').hidden = true; banner('');
  startSignIn();
}

// ---------- start ----------
async function boot() {
  if (!configured()) { show('signin'); $('signinMsg').textContent = 'The app is not set up yet: fill in config.js (see SETUP.md).'; return; }
  const saved = state.idToken || store.get(TOKEN_KEY);
  if (!tokenValid(saved)) return startSignIn();
  state.idToken = saved;
  show('loading');
  try {
    state.me = await api('me');
  } catch (e) { return handleError(e); }
  const u = state.me.user;
  $('who').textContent = `${u.name} · ${roleLabel(u)}`;
  $('modeTag').hidden = state.me.mode === 'LIVE';
  $('btnSignOut').hidden = false; $('btnRefresh').hidden = false;
  $('tabAssign').hidden = !u.isHO; $('tabApprove').hidden = !u.isApprover;
  $('approverPick').innerHTML = '<option value="">Choose approver…</option>' + state.me.approvers.map((n) => `<option>${esc(n)}</option>`).join('');
  setupViewAs();
  show('app');
  setTab(state.tab || (u.isHO ? 'assign' : u.isApprover ? 'approve' : 'reports'));
  if (state.me.preview) banner(''); else setupNotifications();
}

const roleLabel = (u) => (u.isHO && u.isApprover ? 'HO in-charge & approver' : u.isHO ? 'HO in-charge' : u.isApprover ? 'Approver' : 'Reports only');

// ---------- admin preview ("view as") ----------
function setupViewAs() {
  const me = state.me;
  document.body.classList.toggle('preview', !!me.preview);
  $('previewNote').hidden = !me.preview;
  if (!me.admin) { $('viewAsBar').hidden = true; return; }
  $('viewAsBar').hidden = false;
  const others = me.users.filter((x) => x.email !== me.admin.email);
  $('viewAsPick').innerHTML = `<option value="">Myself (${esc(me.admin.name)})</option>` +
    others.map((x) => `<option value="${esc(x.email)}">${esc(x.name)} · ${esc(roleLabel(x))} · ${esc(x.email)}</option>`).join('');
  $('viewAsPick').value = state.viewAs || '';
}
async function changeViewAs(email) {
  state.viewAs = email || null;
  state.ho = state.mine = null; state.sel.clear(); state.qty = {}; state.tab = null;
  show('loading');
  try { state.me = await api('me'); } catch (e) { state.viewAs = null; $('viewAsPick').value = ''; show('app'); return handleError(e); }
  boot();
}

function handleError(e) {
  if (e.code === 'AUTH') { store.del(TOKEN_KEY); state.idToken = null; return startSignIn(e.message); }
  if (e.code === 'PREVIEW') return toast(e.message, true);
  if (e.code === 'FORBIDDEN' && !state.me) { store.del(TOKEN_KEY); state.idToken = null; return startSignIn(e.message); }
  if (!state.me) { show('signin'); $('signinMsg').textContent = e.message; return; }
  toast(e.message, true);
}

// ---------- tabs & loading ----------
function setTab(tab) {
  const u = state.me.user;
  if (tab === 'assign' && !u.isHO) tab = u.isApprover ? 'approve' : 'reports';
  if (tab === 'approve' && !u.isApprover) tab = u.isHO ? 'assign' : 'reports';
  state.tab = tab; state.sel.clear();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('viewAssign').hidden = tab !== 'assign'; $('viewApprove').hidden = tab !== 'approve'; $('viewReports').hidden = tab !== 'reports';
  if (tab === 'reports') renderReports();
  refresh();
}

async function refresh() {
  if (!state.me) return;
  const u = state.me.user;
  try {
    const jobs = [];
    if (u.isHO) jobs.push(api('hoList').then((r) => (state.ho = r)));
    if (u.isApprover) jobs.push(api('myList').then((r) => (state.mine = r)));
    if (state.tab === 'reports' || state.reports) jobs.push(api('reports').then((r) => { state.reports = r.reports; state.repAt = Date.now(); }));
    await Promise.all(jobs);
  } catch (e) { return handleError(e); }
  // Drop selections for lines that are gone.
  const visible = new Set([...(state.ho ? [...state.ho.unassigned, ...state.ho.waiting] : []), ...(state.mine ? [...state.mine.pending, ...state.mine.onHold] : [])].map(key));
  [...state.sel].forEach((k) => { if (!visible.has(k)) state.sel.delete(k); });
  render();
}

const key = (l) => l.row + '|' + l.orderNo;

// ---------- rendering ----------
function render() {
  if (state.ho) {
    $('tabAssign').querySelector('.count').textContent = state.ho.unassigned.length || '';
    $('listUnassigned').innerHTML = groupHtml(state.ho.unassigned, 'assign', 'Nothing waiting for an approver.');
    $('waitingCount').textContent = state.ho.waiting.length;
    $('listWaiting').innerHTML = groupHtml(state.ho.waiting, 'reassign', 'Nothing waiting.');
  }
  if (state.mine) {
    $('tabApprove').querySelector('.count').textContent = state.mine.pending.length || '';
    $('listPending').innerHTML = groupHtml(state.mine.pending, 'approve', 'All done. Nothing waiting for you.');
    $('holdTitle').hidden = !state.mine.onHold.length;
    $('listHold').innerHTML = state.mine.onHold.length ? groupHtml(state.mine.onHold, 'approve', '') : '';
  }
  updateDocks();
  if (state.tab === 'reports') renderReports();
}

// ---------- reports ----------
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => MONTHS[+ym.slice(5, 7) - 1] + '-' + ym.slice(2, 4);
const daysSince = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.max(0, Math.floor((Date.now() - new Date(y, m - 1, d)) / 86400000)); };
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}-${MONTHS[+m - 1]}-${y.slice(2)}`; };

function reportMonths(from) {
  const out = []; const now = new Date();
  let y = +from.slice(0, 4), m = +from.slice(5, 7);
  while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function fillSelect(id, first, values, current) {
  const sel = $(id);
  sel.innerHTML = `<option value="">${esc(first)}</option>` + values.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  sel.value = values.some(([v]) => v === current) ? current : '';
  sel.classList.toggle('on-filter', !!sel.value);
  return sel.value;
}

function renderReports() {
  const R = state.reports, f = state.rep;
  document.querySelectorAll('[data-rtype]').forEach((b) => b.classList.toggle('on', b.dataset.rtype === f.type));
  document.querySelectorAll('[data-rview]').forEach((b) => b.classList.toggle('on', b.dataset.rview === f.view));
  $('fSort').hidden = f.view !== 'list';
  if (!R) { $('repBody').innerHTML = '<p class="empty">Loading report…</p>'; return; }
  const all = f.type === 'nr' ? R.notReceived : R.invoicePending;

  // Filter choices come from the data, so only units/months that have POs are offered.
  const clusters = [...new Set(R.unitMap.map((x) => x[0]).concat(all.some((p) => p.cluster === 'Other') ? ['Other'] : []))];
  f.cluster = fillSelect('fCluster', 'All clusters', clusters.map((c) => [c, c]), f.cluster);
  const unitsInCluster = [...new Set(all.filter((p) => !f.cluster || p.cluster === f.cluster).map((p) => p.unit))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('fUnit', 'All units', unitsInCluster.map((u) => [u, u]), f.unit);
  const months = reportMonths(R.from);
  f.month = fillSelect('fMonth', 'All months', months.slice().reverse().map((m) => [m, monthLabel(m)]), f.month);
  $('fAge').value = f.age; $('fAge').classList.toggle('on-filter', !!f.age);
  $('fSort').value = f.sort;
  if ($('fSearch').value !== f.q) $('fSearch').value = f.q;

  const q = f.q.trim().toLowerCase();
  const rows = all.filter((p) =>
    (!f.cluster || p.cluster === f.cluster) && (!f.unit || p.unit === f.unit) &&
    (!f.month || p.date.slice(0, 7) === f.month) && (!f.age || daysSince(p.date) > +f.age) &&
    (!q || [p.po, p.vendor, p.unitRaw, ...p.itemNames].join(' ').toLowerCase().includes(q)));

  $('tPos').textContent = rows.length;
  $('tAmt').textContent = inr(rows.reduce((a, p) => a + p.amount, 0));
  const oldest = rows.reduce((a, p) => Math.max(a, daysSince(p.date)), 0);
  $('tOld').textContent = rows.length ? `${oldest} days` : '–';
  $('btnClear').hidden = !(f.cluster || f.unit || f.month || f.age || f.q);
  $('repAsOf').textContent = `${f.type === 'nr' ? 'Material not received' : 'Invoice pending'} · approved POs from ${fmtDate(R.from)} · Central Store excluded · updated ${R.asOf}`;
  $('repBody').innerHTML = f.view === 'matrix' ? matrixHtml(rows, R, months) : listHtml(rows);
}

function listHtml(rows) {
  if (!rows.length) return '<p class="empty">No POs match these filters.</p>';
  const s = state.rep.sort;
  const sorted = rows.slice().sort((a, b) =>
    s === 'new' ? b.date.localeCompare(a.date) : s === 'amt' ? b.amount - a.amount :
    s === 'unit' ? (a.unit.localeCompare(b.unit) || a.date.localeCompare(b.date)) : a.date.localeCompare(b.date));
  return sorted.map((p) => {
    const d = daysSince(p.date);
    const more = p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '';
    return `<article class="po">
      <div class="top"><b>${esc(p.po)}</b><span class="amt">${inr(p.amount)}</span></div>
      <div class="sub">${esc(p.unit)} <span class="sub">(${esc(p.cluster)})</span> · ${esc(p.vendor || 'No vendor')}</div>
      <div class="sub">Ordered ${fmtDate(p.date)} · <span class="age ${d > 30 ? 'bad' : d > 15 ? 'warn' : ''}">${d} days</span> · ${p.items} item${p.items > 1 ? 's' : ''}</div>
      ${p.itemNames.length ? `<div class="items">${esc(p.itemNames.join(', '))}${more}</div>` : ''}
    </article>`;
  }).join('');
}

function matrixHtml(rows, R, allMonths) {
  if (!rows.length) return '<p class="empty">No POs match these filters.</p>';
  const months = state.rep.month ? [state.rep.month] : allMonths;
  const order = R.unitMap.map(([c, u]) => c + '|' + u);
  const grid = {};
  rows.forEach((p) => {
    const k = p.cluster + '|' + p.unit;
    (grid[k] = grid[k] || {})[p.date.slice(0, 7)] = (grid[k]?.[p.date.slice(0, 7)] || 0) + 1;
  });
  const keys = Object.keys(grid).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || a.localeCompare(b);
  });
  const cell = (v, unit, m) => (v ? `<button class="cell" data-cell-unit="${esc(unit)}" data-cell-month="${m}">${v}</button>` : '<span class="zero">–</span>');
  const body = keys.map((k) => {
    const [cluster, unit] = k.split('|');
    const counts = months.map((m) => grid[k][m] || 0);
    return `<tr><td>${esc(unit)}<br><span class="sub">${esc(cluster)}</span></td>${counts.map((v, i) => `<td>${cell(v, unit, months[i])}</td>`).join('')}<td><b>${counts.reduce((a, b) => a + b, 0)}</b></td></tr>`;
  }).join('');
  const totals = months.map((m) => keys.reduce((a, k) => a + (grid[k][m] || 0), 0));
  return `<div class="mwrap"><table class="matrix">
    <thead><tr><th>Unit</th>${months.map((m) => `<th>${monthLabel(m)}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${body}<tr class="total"><td>Grand total</td>${totals.map((v) => `<td>${v || '–'}</td>`).join('')}<td>${totals.reduce((a, b) => a + b, 0)}</td></tr></tbody>
  </table></div><p class="sub" style="margin-top:6px">Number of POs by order month. Tap a number to see those POs.</p>`;
}

// Lines of one requisition share the unit and the minute they were entered.
function groupHtml(lines, mode, emptyMsg) {
  if (!lines.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  const groups = [];
  lines.forEach((l) => {
    const g = groups[groups.length - 1];
    if (g && g.unit === l.unit && g.when === l.when) g.lines.push(l); else groups.push({ unit: l.unit, when: l.when, lines: [l] });
  });
  return groups.map((g) => {
    const allSel = g.lines.every((l) => state.sel.has(key(l)));
    return `<article class="group">
      <label class="ghead"><input type="checkbox" data-group="${esc(g.lines.map(key).join(','))}" ${allSel ? 'checked' : ''}>
        <span><b>${esc(g.unit)}</b> <span class="sub">${esc(g.when)} · ${g.lines.length} line${g.lines.length > 1 ? 's' : ''}</span></span></label>
      ${g.lines.map((l) => lineHtml(l, mode)).join('')}
    </article>`;
  }).join('');
}

function lineHtml(l, mode) {
  const k = key(l), checked = state.sel.has(k) ? 'checked' : '';
  const qty = `${esc(l.qty)} ${esc(l.uom)}`;
  const meta = [l.category, l.orderNo].filter(Boolean).map(esc).join(' · ');
  const pic = l.pic ? ` <a href="${esc(l.pic)}" target="_blank" rel="noopener">photo</a>` : '';
  if (mode === 'approve') {
    const hold = l.approval === 'On Hold' ? '<span class="tag hold">On hold</span> ' : '';
    return `<div class="line" data-key="${esc(k)}">
      <label class="lhead"><input type="checkbox" data-key="${esc(k)}" ${checked}>
        <span class="lmain"><span class="item">${hold}${esc(l.item)}</span><span class="sub">${meta}${pic}</span></span></label>
      <div class="lact">
        <label class="qty">Qty <input type="number" inputmode="decimal" min="0" step="any" value="${esc(k in state.qty ? state.qty[k] : (l.approvedQty !== '' && l.approvedQty != null ? l.approvedQty : l.qty))}" data-qty="${esc(k)}" aria-label="Quantity for ${esc(l.item)}"> <span class="sub">${esc(l.uom)} (asked ${esc(l.qty)})</span></label>
        <div class="btns">
          <button class="btn sm primary" data-one="Approved" data-key="${esc(k)}">Approve</button>
          ${l.approval === 'On Hold' ? '' : `<button class="btn sm" data-one="On Hold" data-key="${esc(k)}">Hold</button>`}
          <button class="btn sm danger" data-one="Rejected" data-key="${esc(k)}">Reject</button>
          <button class="btn sm ghost" data-one="Withdrawn" data-key="${esc(k)}">Withdraw</button>
        </div>
      </div>
    </div>`;
  }
  const who = mode === 'reassign' ? `<span class="tag">${esc(l.approver)}</span> ` : '';
  return `<label class="line lhead" data-key="${esc(k)}"><input type="checkbox" data-key="${esc(k)}" ${checked}>
    <span class="lmain"><span class="item">${who}${esc(l.item)}</span><span class="sub">${qty} · ${meta}${pic}</span></span></label>`;
}

function selectedLines() {
  const pool = state.tab === 'assign' ? [...(state.ho?.unassigned || []), ...(state.ho?.waiting || [])] : [...(state.mine?.pending || []), ...(state.mine?.onHold || [])];
  return pool.filter((l) => state.sel.has(key(l)));
}
function updateDocks() {
  const n = selectedLines().length;
  const label = `${n} selected`;
  $('assignDock').hidden = !(state.tab === 'assign' && n); $('assignCount').textContent = label;
  $('approveDock').hidden = !(state.tab === 'approve' && n); $('approveCount').textContent = label;
  document.body.classList.toggle('docked', !!n);
}

// ---------- actions ----------
async function run(label, fn) {
  if (state.busy) return;
  state.busy = true; document.body.classList.add('busy');
  try { await fn(); } catch (e) { handleError(e); } finally { state.busy = false; document.body.classList.remove('busy'); }
}

function assignSelected() {
  const approver = $('approverPick').value;
  const lines = selectedLines();
  if (!approver) return toast('Choose an approver first.', true);
  run('assign', async () => {
    const r = await api('assign', { approver, items: lines.map((l) => ({ row: l.row, orderNo: l.orderNo })) });
    state.sel.clear();
    const how = r.notified.push ? 'notified on their phone' : r.notified.email ? 'notified by email (no phone set up yet)' : 'not notified';
    toast(`${r.assigned} line${r.assigned === 1 ? '' : 's'} sent to ${r.approver}, ${how}.` + skippedText(r.skipped), r.skipped.length > 0);
    await refresh();
  });
}

function decide(decision, lines) {
  if (!lines.length) return;
  if ((decision === 'Rejected' || decision === 'Withdrawn') && !confirm(`${decision === 'Rejected' ? 'Reject' : 'Withdraw'} ${lines.length} line${lines.length > 1 ? 's' : ''}?`)) return;
  const items = lines.map((l) => {
    const input = document.querySelector(`[data-qty="${CSS.escape(key(l))}"]`);
    const v = input ? input.value.trim() : '';
    return { row: l.row, orderNo: l.orderNo, qty: v === '' ? null : Number(v) };
  });
  if (decision === 'Approved') {
    const bad = items.find((i) => !(i.qty > 0));
    if (bad) return toast(`Enter a quantity above 0 for ${bad.orderNo}.`, true);
  }
  run('decide', async () => {
    const r = await api('decide', { decision, items });
    lines.forEach((l) => { state.sel.delete(key(l)); delete state.qty[key(l)]; });
    toast(`${r.decided} line${r.decided === 1 ? '' : 's'} marked ${r.decision}.` + skippedText(r.skipped), r.skipped.length > 0);
    await refresh();
  });
}
const skippedText = (s) => (s && s.length ? ` ${s.length} skipped: ${s.map((x) => x.orderNo + ' (' + x.why + ')').join('; ')}` : '');

// ---------- notifications (Firebase Cloud Messaging) ----------
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const fbConfigured = () => CFG.FIREBASE && CFG.FIREBASE.projectId && !/PASTE/.test(CFG.FIREBASE.projectId) && CFG.VAPID_KEY && !/PASTE/.test(CFG.VAPID_KEY);

function setupNotifications() {
  if (!fbConfigured()) return banner('');
  if (isIOS() && !isStandalone()) {
    return banner('To get notifications on iPhone: tap <b>Share</b> <span aria-hidden="true">⎋</span> then <b>Add to Home Screen</b>, and open the app from there.');
  }
  if (!pushSupported()) return banner('This browser cannot show notifications. Use Chrome on Android, or Safari on iPhone (iOS 16.4 or newer) from the Home Screen.');
  if (Notification.permission === 'granted') { banner(''); return registerPush(false); }
  if (Notification.permission === 'denied') return banner('Notifications are blocked for this app. Turn them on in your phone settings to be told about new approvals.');
  banner('Get a notification on this phone when something needs you. <button id="btnNotify" class="btn sm primary">Turn on notifications</button>');
  $('btnNotify').onclick = () => registerPush(true);
}

async function registerPush(ask) {
  try {
    if (ask) {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return setupNotifications();
    }
    const [{ initializeApp }, { getMessaging, getToken, onMessage, isSupported }] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js'),
    ]);
    if (!(await isSupported())) return banner('This browser cannot receive notifications.');
    const app = initializeApp(CFG.FIREBASE);
    const messaging = getMessaging(app);
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    const token = await getToken(messaging, { vapidKey: CFG.VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw new Error('No notification token');
    if (store.get('nlp.pushToken') !== token || ask) {
      await api('register', { token, device: navigator.userAgent.slice(0, 120) });
      store.set('nlp.pushToken', token);
    }
    onMessage(messaging, (m) => { toast(m.notification?.title || 'New update'); refresh(); });
    banner('');
    if (ask) toast('Notifications are on for this phone.');
  } catch (e) {
    console.error(e);
    if (e instanceof ApiError) return handleError(e);
    banner('Could not turn on notifications on this device. <button id="btnNotify" class="btn sm">Try again</button>');
    $('btnNotify').onclick = () => registerPush(true);
  }
}

// ---------- wiring ----------
$('tabAssign').onclick = () => setTab('assign');
$('tabApprove').onclick = () => setTab('approve');
$('tabReports').onclick = () => setTab('reports');
$('viewAsPick').onchange = (e) => changeViewAs(e.target.value);
document.querySelectorAll('[data-rtype]').forEach((b) => (b.onclick = () => { state.rep.type = b.dataset.rtype; state.rep.unit = ''; renderReports(); }));
document.querySelectorAll('[data-rview]').forEach((b) => (b.onclick = () => { state.rep.view = b.dataset.rview; renderReports(); }));
[['fCluster', 'cluster'], ['fUnit', 'unit'], ['fMonth', 'month'], ['fAge', 'age'], ['fSort', 'sort']].forEach(([id, k]) =>
  ($(id).onchange = (e) => { state.rep[k] = e.target.value; if (k === 'cluster') state.rep.unit = ''; renderReports(); }));
$('fSearch').oninput = (e) => { state.rep.q = e.target.value; renderReports(); };
$('btnClear').onclick = () => { Object.assign(state.rep, { cluster: '', unit: '', month: '', age: '', q: '' }); renderReports(); };
$('btnRefresh').onclick = () => run('refresh', refresh);
$('btnSignOut').onclick = signOut;
$('btnAssign').onclick = assignSelected;
document.querySelectorAll('[data-bulk]').forEach((b) => (b.onclick = () => decide(b.dataset.bulk, selectedLines())));

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-key]')) { t.checked ? state.sel.add(t.dataset.key) : state.sel.delete(t.dataset.key); render(); }
  else if (t.matches('input[type=checkbox][data-group]')) { t.dataset.group.split(',').forEach((k) => (t.checked ? state.sel.add(k) : state.sel.delete(k))); render(); }
});
document.addEventListener('input', (e) => { if (e.target.matches('[data-qty]')) state.qty[e.target.dataset.qty] = e.target.value; });
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cell-unit]');
  if (c) { Object.assign(state.rep, { unit: c.dataset.cellUnit, month: c.dataset.cellMonth, view: 'list' }); renderReports(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-one]');
  if (!b) return;
  const all = [...(state.mine?.pending || []), ...(state.mine?.onHold || [])];
  const line = all.find((l) => key(l) === b.dataset.key);
  if (line) decide(b.dataset.one, [line]);
});
// Keep the list fresh while the app is open; reload when it comes back to the front.
setInterval(() => { if (document.visibilityState === 'visible' && state.me && !state.busy) refresh(); }, 120000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me && !state.busy) refresh(); });

boot();

// Exposed for tests.
window.__nlp = { state, api };
