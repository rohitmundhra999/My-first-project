// Summit Purchase Reports and Approvals - front end. Talks to the Apps Script backend; all permission checks happen there.
const CFG = self.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nlp.idToken';
const state = {
  idToken: null, me: null, tab: null, ho: null, mine: null, sel: new Set(), qty: {}, busy: false,
  viewAs: null, gen: 0,  // gen changes on every "view as" switch; replies for an older view are ignored
  pick: {},              // HO: approver chosen per line (key -> name), sent with the group's Send button          // admin preview: email of the person whose screens are shown (read-only)
  reports: null, repAt: 0,
  rep: { type: 'nr', view: 'list', cluster: '', unit: '', month: '', age: '', q: '', sort: 'old' },
  dec: null, decAt: 0, decShow: 200,
  df: { view: 'list', approver: '', status: '', cluster: '', unit: '', month: '', q: '' },
};
const STATUSES = ['Approved', 'Rejected', 'On Hold', 'Withdrawn'];
const REMARK_MAX_WORDS = 10;
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
async function boot(prefetched) {
  if (!configured()) { show('signin'); $('signinMsg').textContent = 'The app is not set up yet: fill in config.js (see SETUP.md).'; return; }
  const saved = state.idToken || store.get(TOKEN_KEY);
  if (!tokenValid(saved)) return startSignIn();
  state.idToken = saved;
  show('loading');
  if (prefetched) state.me = prefetched;
  else {
    try { state.me = await api('me'); } catch (e) { return handleError(e); }
  }
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
  const gen = ++state.gen;
  state.viewAs = email || null;
  state.ho = state.mine = null; state.sel.clear(); state.qty = {}; state.pick = {}; state.tab = null;
  show('loading');
  let me;
  try { me = await api('me'); } catch (e) { if (gen !== state.gen) return; state.viewAs = null; $('viewAsPick').value = ''; show('app'); return handleError(e); }
  if (gen !== state.gen) return;   // switched again while loading
  boot(me);
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

async function refresh(fresh) {
  fresh = fresh === true;   // only the ↻ button re-reads the sheet; otherwise the server's ready copy is used
  if (!state.me) return;
  const u = state.me.user, gen = state.gen;
  const wait = '<p class="empty">Loading… this can take a few seconds.</p>';
  if (u.isHO && !state.ho) $('listUnassigned').innerHTML = wait;
  if (u.isApprover && !state.mine) $('listPending').innerHTML = wait;
  try {
    const jobs = [];
    if (u.isHO) jobs.push(api('hoList', { fresh }).then((r) => { if (gen === state.gen) state.ho = r; }));
    if (u.isApprover) jobs.push(api('myList', { fresh }).then((r) => { if (gen === state.gen) state.mine = r; }));
    let repJob = null;
    const wantDec = (state.tab === 'reports' && state.rep.type === 'dec') || state.dec;
    if (state.tab === 'reports' || state.reports) jobs.push(repJob = api('reports', { fresh }).then((r) => { state.reports = r.reports; state.repAt = Date.now(); }));
    // Both reports come from one read of the sheet: on ↻ the decisions are fetched after the reports re-read.
    if (wantDec) jobs.push((fresh && repJob ? repJob : Promise.resolve())
      .then(() => api('decisions', { fresh: fresh && !repJob })).then((r) => { state.dec = r.decisions; state.decAt = Date.now(); }));
    await Promise.all(jobs);
  } catch (e) { if (gen !== state.gen) return; return handleError(e); }
  if (gen !== state.gen) return;
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
  $('poReport').hidden = f.type === 'dec'; $('viewDecisions').hidden = f.type !== 'dec';
  if (f.type === 'dec') return renderDecisions();
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

  state.repRows = rows;
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

// ---------- approval report (decisions) ----------
const stClass = (s) => s.toLowerCase().replace(/\s+/g, '');
const decDate = (l) => (l.at ? l.at.replace(/\(/, ' ').replace(/\)/, '') : '');

function decFiltered(ignoreStatus) {
  const D = state.dec, f = state.df;
  const q = f.q.trim().toLowerCase();
  return D.lines.filter((l) =>
    (!f.approver || l.by === f.approver) && (ignoreStatus || !f.status || l.s === f.status) &&
    (!f.cluster || l.c === f.cluster) && (!f.unit || l.u === f.unit) && (!f.month || l.d.slice(0, 7) === f.month) &&
    (!q || [l.o, l.it, l.u, l.rm, l.by].join(' ').toLowerCase().includes(q)));
}

function renderDecisions() {
  const D = state.dec, f = state.df;
  document.querySelectorAll('[data-dview]').forEach((b) => b.classList.toggle('on', b.dataset.dview === f.view));
  if (!D) { $('decBody').innerHTML = '<p class="empty">Loading report… this can take a few seconds.</p>'; $('dTiles').innerHTML = ''; return; }
  // Every approver set up in the app, plus any other name found in the sheet, with how many lines each decided.
  const perApprover = {};
  D.lines.forEach((l) => { if (l.by) perApprover[l.by] = (perApprover[l.by] || 0) + 1; });
  const approvers = [...new Set([...(D.approvers || []), ...Object.keys(perApprover)])].sort((a, b) => a.localeCompare(b));
  f.approver = fillSelect('dApprover', 'All approvers', approvers.map((a) => [a, `${a} (${perApprover[a] || 0})`]), f.approver);
  f.status = fillSelect('dStatus', 'All statuses', STATUSES.map((x) => [x, x]), f.status);
  const clusters = [...new Set(D.unitMap.map((x) => x[0]).concat(D.lines.some((l) => l.c === 'Other') ? ['Other'] : []))];
  f.cluster = fillSelect('dCluster', 'All clusters', clusters.map((c) => [c, c]), f.cluster);
  const units = [...new Set(D.lines.filter((l) => !f.cluster || l.c === f.cluster).map((l) => l.u))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('dUnit', 'All units', units.map((u) => [u, u]), f.unit);
  const months = reportMonths(D.from);
  f.month = fillSelect('dMonth', 'All months', months.slice().reverse().map((m) => [m, monthLabel(m)]), f.month);
  if ($('dSearch').value !== f.q) $('dSearch').value = f.q;

  const base = decFiltered(true);
  const counts = Object.fromEntries(STATUSES.map((x) => [x, 0]));
  base.forEach((l) => counts[l.s]++);
  $('dTiles').innerHTML = STATUSES.map((x) => `<button class="tile ${f.status === x ? 'on' : ''}" data-dstatus="${esc(x)}"><span class="sub">${esc(x)}</span><b>${counts[x]}</b></button>`).join('');
  const rows = f.status ? base.filter((l) => l.s === f.status) : base;
  state.decRows = rows;
  $('dClear').hidden = !(f.approver || f.status || f.cluster || f.unit || f.month || f.q);
  $('decAsOf').textContent = `Approval report · requests from ${fmtDate(D.from)} · ${rows.length} line${rows.length === 1 ? '' : 's'} · updated ${D.asOf}`;
  $('decBody').innerHTML = f.view === 'summary' ? decSummaryHtml(rows) : decListHtml(rows);
}

function decListHtml(rows) {
  if (!rows.length) return '<p class="empty">No lines match these filters.</p>';
  const shown = rows.slice(0, state.decShow);
  return shown.map((l) => {
    const qty = l.s === 'Approved' && l.aq !== '' && String(l.aq) !== String(l.q) ? `${esc(l.aq)} of ${esc(l.q)} ${esc(l.uom)}` : `${esc(l.q)} ${esc(l.uom)}`;
    return `<article class="po dec">
      <div class="top"><b>${esc(l.it)}</b><span class="st ${stClass(l.s)}">${esc(l.s)}</span></div>
      <div class="sub">${esc(l.u)} <span class="sub">(${esc(l.c)})</span> · ${qty}</div>
      <div class="sub">${esc(l.o)} · requested ${fmtDate(l.d)}${l.at ? ' · decided ' + esc(decDate(l)) : ''}</div>
      <div class="sub">Approver: <b>${esc(l.by || '–')}</b></div>
      ${l.rm ? `<div class="remark"><b>Reason:</b> ${esc(l.rm)}</div>` : ''}
    </article>`;
  }).join('') + (rows.length > shown.length ? `<button class="btn sm more" id="decMore">Show more (${rows.length - shown.length} left)</button>` : '');
}

function decSummaryHtml(rows) {
  if (!rows.length) return '<p class="empty">No lines match these filters.</p>';
  const by = {};
  rows.forEach((l) => { const k = l.by || '(none)'; (by[k] = by[k] || Object.fromEntries(STATUSES.map((x) => [x, 0])))[l.s]++; });
  const names = Object.keys(by).sort((a, b) => a.localeCompare(b));
  const tot = STATUSES.map((x) => names.reduce((a, n) => a + by[n][x], 0));
  return `<div class="mwrap"><table class="matrix">
    <thead><tr><th>Approver</th>${STATUSES.map((x) => `<th>${esc(x)}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>${names.map((n) => `<tr><td>${esc(n)}</td>${STATUSES.map((x) => `<td>${by[n][x] ? `<button class="cell" data-dcell-by="${esc(n)}" data-dcell-st="${esc(x)}">${by[n][x]}</button>` : '<span class="zero">–</span>'}</td>`).join('')}<td><b>${STATUSES.reduce((a, x) => a + by[n][x], 0)}</b></td></tr>`).join('')}
    <tr class="total"><td>Total</td>${tot.map((v) => `<td>${v || '–'}</td>`).join('')}<td>${tot.reduce((a, b) => a + b, 0)}</td></tr></tbody>
  </table></div><p class="sub" style="margin-top:6px">Number of lines by approver and status. Tap a number to see those lines.</p>`;
}

// ---------- downloads (Excel and PDF) ----------
const LIBS = {
  xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'],
  pdf: ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'],
};
const loaded = {};
function loadScript(src) {
  return (loaded[src] = loaded[src] || new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.onload = resolve;
    s.onerror = () => { delete loaded[src]; reject(new Error('Could not load the download tool. Check your internet.')); };
    document.head.appendChild(s);
  }));
}
async function loadLibs(fmt) { for (const src of LIBS[fmt]) await loadScript(src); }

function filterText(pairs) { return pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'No filters'; }

function exportData(which) {
  const today = new Date();
  const stamp = `${String(today.getDate()).padStart(2, '0')}-${MONTHS[today.getMonth()]}-${today.getFullYear()}`;
  if (which === 'dec') {
    const f = state.df, rows = state.decRows || [];
    return {
      title: 'Approval report', file: `Approval report ${stamp}`,
      filters: filterText([['Approver', f.approver], ['Status', f.status], ['Cluster', f.cluster], ['Unit', f.unit], ['Month', f.month && monthLabel(f.month)], ['Search', f.q.trim()]]),
      head: ['#', 'Order No', 'Requested', 'Decided', 'Unit', 'Cluster', 'Item', 'Qty asked', 'Qty approved', 'UOM', 'Status', 'Approver', 'Reason for rejection'],
      body: rows.map((l, i) => [i + 1, l.o, fmtDate(l.d), decDate(l), l.u, l.c, l.it, l.q, l.aq, l.uom, l.s, l.by, l.rm]),
      pdfCols: [0, 1, 2, 3, 4, 6, 7, 8, 10, 11, 12],
    };
  }
  const f = state.rep, rows = (state.repRows || []).slice();
  const s = f.sort;
  rows.sort((a, b) => s === 'new' ? b.date.localeCompare(a.date) : s === 'amt' ? b.amount - a.amount :
    s === 'unit' ? (a.unit.localeCompare(b.unit) || a.date.localeCompare(b.date)) : a.date.localeCompare(b.date));
  const name = f.type === 'nr' ? 'Material not received' : 'Invoice pending';
  return {
    title: name, file: `${name} ${stamp}`, money: 6,
    filters: filterText([['Cluster', f.cluster], ['Unit', f.unit], ['Month', f.month && monthLabel(f.month)], ['Pending for', f.age && `over ${f.age} days`], ['Search', f.q.trim()]]),
    head: ['#', 'PO No', 'PO date', 'Days', 'Unit', 'Cluster', 'Amount', 'Vendor', 'Items', 'Item names'],
    body: rows.map((p, i) => [i + 1, p.po, fmtDate(p.date), daysSince(p.date), p.unit, p.cluster, Math.round(p.amount), p.vendor, p.items,
      p.itemNames.join(', ') + (p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '')]),
    pdfCols: [0, 1, 2, 3, 4, 6, 7, 8, 9],
  };
}

async function download(which, fmt) {
  const d = exportData(which);
  if (!d.body.length) return toast('Nothing to download: no lines match these filters.', true);
  toast(`Preparing ${fmt === 'xlsx' ? 'Excel' : 'PDF'}…`);
  try { await loadLibs(fmt); } catch (e) { return toast(e.message, true); }
  if (fmt === 'xlsx') {
    const XLSX = window.XLSX;
    const aoa = [[d.title], [d.filters + ' · ' + d.body.length + ' rows'], [], d.head, ...d.body];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = d.head.map((h, i) => ({ wch: Math.min(48, Math.max(h.length + 2, ...d.body.slice(0, 300).map((r) => String(r[i] ?? '').length + 2))) }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + d.body.length, c: d.head.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, d.title.slice(0, 31));
    XLSX.writeFile(wb, d.file + '.xlsx');
  } else {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(14); doc.text('Summit Purchase Reports and Approvals - ' + d.title, 30, 32);
    doc.setFontSize(9); doc.setTextColor(90); doc.text(doc.splitTextToSize(d.filters + ' · ' + d.body.length + ' rows · ' + new Date().toLocaleString('en-IN'), 780), 30, 48);
    const pick = (r) => d.pdfCols.map((i) => (i === d.money ? 'Rs ' + Number(r[i]).toLocaleString('en-IN') : String(r[i] ?? '')));
    doc.autoTable({
      head: [pick(d.head).map((h, i) => (d.pdfCols[i] === d.money ? 'Amount' : h))], body: d.body.map(pick), startY: 62,
      styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' }, headStyles: { fillColor: [27, 94, 32] },
      margin: { left: 30, right: 30 },
      didDrawPage: () => { doc.setFontSize(8); doc.setTextColor(120); doc.text('Page ' + doc.internal.getNumberOfPages(), 780, 580); },
    });
    doc.save(d.file + '.pdf');
  }
}

// ---------- reason for rejection (max 10 words) ----------
const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
function askRemark(lines) {
  return new Promise((resolve) => {
    const box = $('remarkBox'), txt = $('remarkText');
    $('remarkWhat').textContent = lines.length === 1 ? `${lines[0].item} · ${lines[0].unit}` : `${lines.length} lines will be rejected with this reason.`;
    $('remarkOk').textContent = lines.length === 1 ? 'Reject' : `Reject ${lines.length}`;
    txt.value = ''; box.hidden = false; update(); setTimeout(() => txt.focus(), 50);
    function update() {
      const n = wordCount(txt.value);
      $('remarkCount').textContent = n > REMARK_MAX_WORDS ? `${n} words - too long, keep it to ${REMARK_MAX_WORDS} words` : `${n} / ${REMARK_MAX_WORDS} words`;
      $('remarkCount').classList.toggle('over', n > REMARK_MAX_WORDS);
      $('remarkOk').disabled = n === 0 || n > REMARK_MAX_WORDS;
    }
    function close(v) { box.hidden = true; txt.oninput = null; $('remarkForm').onsubmit = null; $('remarkCancel').onclick = null; box.onclick = null; resolve(v); }
    txt.oninput = update;
    $('remarkForm').onsubmit = (e) => { e.preventDefault(); const n = wordCount(txt.value); if (n && n <= REMARK_MAX_WORDS) close(txt.value.trim().replace(/\s+/g, ' ')); };
    $('remarkCancel').onclick = () => close(null);
    box.onclick = (e) => { if (e.target === box) close(null); };
  });
}

// Lines of one requisition share the unit and the minute they were entered.
function groupHtml(lines, mode, emptyMsg) {
  if (!lines.length) return `<p class="empty">${esc(emptyMsg)}</p>`;
  const groups = [];
  lines.forEach((l) => {
    const g = groups[groups.length - 1];
    if (g && g.unit === l.unit && g.when === l.when) g.lines.push(l); else groups.push({ unit: l.unit, when: l.when, lines: [l] });
  });
  if (mode === 'assign' || mode === 'reassign') return groups.map((g) => assignGroupHtml(g, mode)).join('');
  return groups.map((g) => {
    const allSel = g.lines.every((l) => state.sel.has(key(l)));
    return `<article class="group">
      <label class="ghead"><input type="checkbox" data-group="${esc(g.lines.map(key).join(','))}" ${allSel ? 'checked' : ''}>
        <span><b>${esc(g.unit)}</b> <span class="sub">${esc(g.when)} · ${g.lines.length} line${g.lines.length > 1 ? 's' : ''}</span></span></label>
      ${g.lines.map((l) => lineHtml(l, mode)).join('')}
    </article>`;
  }).join('');
}

// ---------- HO: pick an approver on each line ----------
const approverOptions = (current) => '<option value="">Choose approver…</option>' +
  (state.me?.approvers || []).map((n) => `<option ${n === current ? 'selected' : ''}>${esc(n)}</option>`).join('');
const stockHtml = (l) => {
  const req = `<span class="need">Required <b>${esc(l.qty)} ${esc(l.uom)}</b></span>`;
  const st = l.stock && l.stock.qty !== '' ? `<span class="stock">Stock in hand <b>${esc(l.stock.qty)} ${esc(l.stock.uom || '')}</b></span>`
    : '<span class="stock none">Stock in hand: not given</span>';
  return `<div class="reqstock">${req}${st}</div>`;
};

function assignGroupHtml(g, mode) {
  const keys = g.lines.map(key).join(',');
  const dis = state.me.preview ? 'disabled' : '';
  const ready = g.lines.filter((l) => state.pick[key(l)] && state.pick[key(l)] !== l.approver).length;
  return `<article class="group">
    <div class="ghead assignhead">
      <span><b>${esc(g.unit)}</b> <span class="sub">${esc(g.when)} · ${g.lines.length} line${g.lines.length > 1 ? 's' : ''}</span></span>
      ${g.lines.length > 1 ? `<select class="gpick" data-gpick="${esc(keys)}" ${dis} aria-label="Approver for all lines of ${esc(g.unit)}">${approverOptions('').replace('Choose approver…', 'Same approver for all…')}</select>` : ''}
    </div>
    ${g.lines.map((l) => {
      const k = key(l), meta = [l.category, l.orderNo].filter(Boolean).map(esc).join(' · ');
      const pic = l.pic ? ` <a href="${esc(l.pic)}" target="_blank" rel="noopener">photo</a>` : '';
      const chosen = state.pick[k] ?? l.approver ?? '';
      return `<div class="line">
        <div class="lmain"><span class="item">${esc(l.item)}</span><span class="sub">${meta}${pic}</span></div>
        ${stockHtml(l)}
        <label class="pickrow"><span class="sub">Approver</span>
          <select data-pick="${esc(k)}" ${dis} aria-label="Approver for ${esc(l.item)}">${approverOptions(chosen)}</select></label>
      </div>`;
    }).join('')}
    ${state.me.preview ? '' : `<div class="gfoot"><span class="sub">${ready ? ready + ' line' + (ready > 1 ? 's' : '') + ' ready' : mode === 'reassign' ? 'Change the approver to send again' : 'Choose an approver for each line'}</span>
      <button class="btn sm primary" data-gsend="${esc(keys)}" ${ready ? '' : 'disabled'}>Send${ready ? ' (' + ready + ')' : ''}</button></div>`}
  </article>`;
}

function sendGroup(keys) {
  const pool = [...(state.ho?.unassigned || []), ...(state.ho?.waiting || [])];
  const lines = pool.filter((l) => keys.includes(key(l)) && state.pick[key(l)] && state.pick[key(l)] !== l.approver);
  if (!lines.length) return toast('Choose an approver first.', true);
  const byApprover = {};
  lines.forEach((l) => (byApprover[state.pick[key(l)]] = byApprover[state.pick[key(l)]] || []).push(l));
  run('assign', async () => {
    const msgs = [], skipped = [];
    for (const [approver, ls] of Object.entries(byApprover)) {
      const r = await api('assign', { approver, items: ls.map((l) => ({ row: l.row, orderNo: l.orderNo })) });
      ls.forEach((l) => delete state.pick[key(l)]);
      const how = r.notified.push ? 'notified on phone' : r.notified.email ? 'notified by email' : 'not notified';
      msgs.push(`${r.assigned} to ${r.approver} (${how})`);
      skipped.push(...r.skipped);
    }
    toast('Sent: ' + msgs.join('; ') + '.' + skippedText(skipped), skipped.length > 0);
    await refresh();
  });
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
      <div class="indent">${stockHtml(l)}</div>
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
  $('assignDock').hidden = true;
  $('approveDock').hidden = !(state.tab === 'approve' && n); $('approveCount').textContent = label;
  document.body.classList.toggle('docked', !!n && state.tab === 'approve');
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

async function decide(decision, lines) {
  if (!lines.length || state.busy) return;
  let remark = '';
  if (decision === 'Rejected') { remark = await askRemark(lines); if (!remark) return; }
  if (decision === 'Withdrawn' && !confirm(`Withdraw ${lines.length} line${lines.length > 1 ? 's' : ''}?`)) return;
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
    const r = await api('decide', { decision, items, remark });
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
    { // register on every open, so the server always has this device's current token
      await api('register', { token, device: navigator.userAgent.slice(0, 120) });
      store.set('nlp.pushToken', token);
    }
    onMessage(messaging, (m) => { // app is open: show it in the app AND as a phone notification
    const title = m.notification?.title || 'New update';
    toast(title);
    try { reg.showNotification(title, { body: m.notification?.body || '', icon: 'icon-192.png', tag: 'nlp-approval', renotify: true, vibrate: [200, 100, 200] }); } catch { /* ignore */ }
    refresh();
  });
  addTestButton();
    banner('');
    if (ask) toast('Notifications are on for this phone.');
  } catch (e) {
    console.error(e);
    if (e instanceof ApiError) return handleError(e);
    banner('Could not turn on notifications on this device. <button id="btnNotify" class="btn sm">Try again</button>');
    $('btnNotify').onclick = () => registerPush(true);
  }
}

// Bell button in the header: sends a test notification to all of my devices.
function addTestButton() {
  if ($('btnTestPush')) return;
  const b = document.createElement('button');
  b.id = 'btnTestPush'; b.className = 'btn ghost'; b.textContent = '🔔';
  b.title = 'Send a test notification to my devices'; b.setAttribute('aria-label', b.title);
  b.onclick = () => run('testPush', async () => {
    const r = await api('testPush');
    const n = r.notified.push;
    toast(n ? `Test notification sent to ${n} device${n > 1 ? 's' : ''}.` : 'No device has notifications turned on yet.', !n);
  });
  document.querySelector('.bar-actions').prepend(b);
}

// ---------- wiring ----------
$('tabAssign').onclick = () => setTab('assign');
$('tabApprove').onclick = () => setTab('approve');
$('tabReports').onclick = () => setTab('reports');
[['dApprover', 'approver'], ['dStatus', 'status'], ['dCluster', 'cluster'], ['dUnit', 'unit'], ['dMonth', 'month']].forEach(([id, k]) =>
  ($(id).onchange = (e) => { state.df[k] = e.target.value; if (k === 'cluster') state.df.unit = ''; state.decShow = 200; renderDecisions(); }));
$('dSearch').oninput = (e) => { state.df.q = e.target.value; state.decShow = 200; renderDecisions(); };
$('dClear').onclick = () => { Object.assign(state.df, { approver: '', status: '', cluster: '', unit: '', month: '', q: '' }); state.decShow = 200; renderDecisions(); };
document.querySelectorAll('[data-dview]').forEach((b) => (b.onclick = () => { state.df.view = b.dataset.dview; renderDecisions(); }));
$('viewAsPick').onchange = (e) => changeViewAs(e.target.value);
document.querySelectorAll('[data-rtype]').forEach((b) => (b.onclick = () => {
  state.rep.type = b.dataset.rtype; state.rep.unit = ''; renderReports();
  if (b.dataset.rtype === 'dec' && !state.dec) refresh();
}));
document.querySelectorAll('[data-rview]').forEach((b) => (b.onclick = () => { state.rep.view = b.dataset.rview; renderReports(); }));
[['fCluster', 'cluster'], ['fUnit', 'unit'], ['fMonth', 'month'], ['fAge', 'age'], ['fSort', 'sort']].forEach(([id, k]) =>
  ($(id).onchange = (e) => { state.rep[k] = e.target.value; if (k === 'cluster') state.rep.unit = ''; renderReports(); }));
$('fSearch').oninput = (e) => { state.rep.q = e.target.value; renderReports(); };
$('btnClear').onclick = () => { Object.assign(state.rep, { cluster: '', unit: '', month: '', age: '', q: '' }); renderReports(); };
$('btnRefresh').onclick = () => { toast('Reading the latest from the sheet…'); run('refresh', () => refresh(true)); };
$('btnSignOut').onclick = signOut;
$('btnAssign').onclick = assignSelected;
document.querySelectorAll('[data-bulk]').forEach((b) => (b.onclick = () => decide(b.dataset.bulk, selectedLines())));

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('input[type=checkbox][data-key]')) { t.checked ? state.sel.add(t.dataset.key) : state.sel.delete(t.dataset.key); render(); }
  else if (t.matches('input[type=checkbox][data-group]')) { t.dataset.group.split(',').forEach((k) => (t.checked ? state.sel.add(k) : state.sel.delete(k))); render(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('select[data-pick]')) { state.pick[t.dataset.pick] = t.value; render(); }
  else if (t.matches('select[data-gpick]')) { if (t.value) t.dataset.gpick.split(',').forEach((k) => (state.pick[k] = t.value)); render(); }
});
document.addEventListener('input', (e) => { if (e.target.matches('[data-qty]')) state.qty[e.target.dataset.qty] = e.target.value; });
document.addEventListener('click', (e) => {
  const dl = e.target.closest('[data-dl]');
  if (dl) return download(dl.dataset.dl, dl.dataset.fmt);
  const ds = e.target.closest('[data-dstatus]');
  if (ds) { state.df.status = state.df.status === ds.dataset.dstatus ? '' : ds.dataset.dstatus; state.decShow = 200; return renderDecisions(); }
  const dc = e.target.closest('[data-dcell-by]');
  if (dc) { Object.assign(state.df, { approver: dc.dataset.dcellBy === '(none)' ? '' : dc.dataset.dcellBy, status: dc.dataset.dcellSt, view: 'list' }); state.decShow = 200; renderDecisions(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#decMore')) { state.decShow += 300; return renderDecisions(); }
  const gs = e.target.closest('[data-gsend]');
  if (gs) return sendGroup(gs.dataset.gsend.split(','));
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
