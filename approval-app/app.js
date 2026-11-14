// Summit Procurement - front end. Talks to the Apps Script backend; all permission checks happen there.
const CFG = self.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'nlp.idToken';
const state = {
  idToken: null, me: null, tab: null, ho: null, mine: null, sel: new Set(), qty: {}, busy: false,
  viewAs: null, gen: 0,  // gen changes on every "view as" switch; replies for an older view are ignored
  pick: {},              // HO: approver chosen per line (key -> name), sent with the group's Send button          // admin preview: email of the person whose screens are shown (read-only)
  reports: null, repAt: 0,
  rep: { type: 'nr', view: 'list', cluster: '', unit: '', vendor: '', month: '', age: '', q: '', sort: 'old' },
  dec: null, decAt: 0, decShow: 200,
  df: { view: 'list', approver: '', status: '', cluster: '', unit: '', month: '', q: '' },
  // storekeeper
  goods: null, gf: { unit: '', vendor: '', st: '', q: '' }, hi: { unit: '', vendor: '', form: null }, hr: { unit: '', vendor: '', data: null, rq: {} }, rt: { data: null, q: '', cmp: null, busy: '' }, gsel: new Set(), gform: {}, gsf: { cluster: '', unit: '', vendor: '', st: '', q: '' },
  po: null, vendors: null, poSel: new Set(), poPrice: {}, poForm: { vendor: '', days: 25, terms: '', note: '', discountAmt: 0, billTo: '', shipTo: '', newVendor: null }, poUnit: '', poDone: null,
  store: { unit: '', view: 'raise', data: null, meta: {}, draft: null, rq: {}, inv: null, filter: 'pending', q: '', ven: '', show: 150, done: null, formUnit: '',
           byUnit: {}, raw: {}, base: null, prefetchedAt: 0, prefetching: false },
};
const STATUSES = ['Approved', 'Rejected', 'On Hold', 'Withdrawn'];
const stLabel = (x) => (x === 'Approved' ? 'Approved but PO not raised' : x);
const REMARK_MAX_WORDS = 10;
const WRITE_ACTIONS = ['assign', 'decide', 'register', 'storeRaise', 'storeReceive', 'storeInvoice', 'makePO', 'editItem', 'goodsSave'];
/** Preview that may not change anything (LIVE). In TRIAL the admin can act as the person ("actAs"). */
const readOnly = () => !!(state.me && state.me.preview && !state.me.actAs);

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
// Google Apps Script now and then drops a request without any answer. So every request has a time limit, and is
// tried once more if Google did not answer. Saves carry a requestId: the server remembers it, so a save that is
// tried twice is still saved only once.
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
async function api(action, data = {}) {
  const write = WRITE_ACTIONS.includes(action) && action !== 'register';
  const body = JSON.stringify({ action, idToken: state.idToken, ...(state.viewAs && action !== 'register' ? { viewAs: state.viewAs } : {}),
    ...(write ? { requestId: newId() } : {}), ...data });
  const limit = write || action === 'rateCompare' ? 120000 : 45000;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limit);
    let res, out;
    try {
      res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, signal: ctl.signal });   // "simple" request: no CORS preflight
      out = await res.json();
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? new ApiError('NETWORK', 'No reply from the server. Nothing may have been saved: please check and try again.')
        : res ? new ApiError('SERVER', 'Google did not answer properly (' + res.status + '). Please try again.')
        : new ApiError('NETWORK', 'No connection. Check your internet and try again.');
      continue;   // try once more (a save is never done twice: see requestId)
    } finally { clearTimeout(timer); }
    if (!out.ok) {
      if (out.code === 'BUSY' && attempt === 0) { lastErr = new ApiError(out.code, out.error); continue; }
      throw new ApiError(out.code, out.error || 'Something went wrong.');
    }
    return out;
  }
  throw lastErr;
}

// Saves in progress: while one is on its way, the background refresh waits so its lines do not flicker back.
// A save can never block refreshing for more than 2 minutes, even if Google never answers.
const pending = new Map();
const beginSave = () => { const id = newId(); pending.set(id, Date.now()); return id; };
const endSave = (id) => pending.delete(id);
const saving = () => { const now = Date.now(); for (const [id, t] of pending) if (now - t > 125000) pending.delete(id); return pending.size > 0; };

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
  clearLocal();
  store.del(TOKEN_KEY); state.idToken = null; state.me = null; state.viewAs = null; state.ho = state.mine = state.reports = null;
  $('viewAsBar').hidden = true; document.body.classList.remove('preview');
  try { google.accounts.id.disableAutoSelect(); } catch { /* not loaded */ }
  $('who').textContent = ''; $('btnSignOut').hidden = true; $('btnRefresh').hidden = true; banner('');
  startSignIn();
}

// ---------- local copy: the app opens instantly with what it showed last time, then updates quietly ----------
const LOCAL_KEY = 'nlp.cache.v1';
function localKey() { const p = jwtPayload(state.idToken || ''); return p && p.email ? LOCAL_KEY + '.' + String(p.email).toLowerCase() : null; }
function saveLocal() {
  if (state.viewAs || !state.me) return;   // never keep someone else's screens (admin preview)
  const k = localKey(); if (!k) return;
  const sv = state.store;
  const snap = { at: Date.now(), me: state.me, tab: state.tab, ho: state.ho, mine: state.mine, reports: state.reports, po: state.po, vendors: state.vendors,
    store: { unit: sv.unit, base: sv.base, meta: sv.meta[sv.unit] || null } };
  try { localStorage.setItem(k, JSON.stringify(snap)); } catch { /* no room: fine */ }
  // every unit's store lines, kept packed (as the server sent them) so they take little room
  try { localStorage.setItem(k + '.stores', JSON.stringify(sv.raw)); } catch { try { localStorage.removeItem(k + '.stores'); } catch { /* ignore */ } }
  try { if (state.dec) localStorage.setItem(k + '.dec', JSON.stringify(state.dec)); } catch { try { localStorage.removeItem(k + '.dec'); } catch { /* ignore */ } }
  try { localStorage.setItem(k + '.ho2', JSON.stringify({ goods: state.goods, hr: state.hr.data })); } catch { try { localStorage.removeItem(k + '.ho2'); } catch { /* ignore */ } }
  try { if (state.rt.data) localStorage.setItem(k + '.rates', JSON.stringify(state.rt.data)); } catch { try { localStorage.removeItem(k + '.rates'); } catch { /* ignore */ } }
}
function loadLocal() {
  const k = localKey(); if (!k) return null;
  try {
    const s = JSON.parse(localStorage.getItem(k) || 'null');
    if (!s || !s.me || Date.now() - s.at > 7 * 86400000) return null;
    try { s.dec = JSON.parse(localStorage.getItem(k + '.dec') || 'null'); } catch { s.dec = null; }
    try { s.stores = JSON.parse(localStorage.getItem(k + '.stores') || 'null'); } catch { s.stores = null; }
    try { s.ho2 = JSON.parse(localStorage.getItem(k + '.ho2') || 'null'); } catch { s.ho2 = null; }
    try { s.rates = JSON.parse(localStorage.getItem(k + '.rates') || 'null'); } catch { s.rates = null; }
    return s;
  } catch { return null; }
}
function clearLocal() { const k = localKey(); if (!k) return; try { ['', '.dec', '.stores', '.ho2', '.rates'].forEach((x) => localStorage.removeItem(k + x)); } catch { /* ignore */ } }
/** packed list from the server ({k:[names], r:[[values]]}) -> list of objects */
const unpack = (p) => (p && p.k ? p.r.map((row) => { const o = {}; p.k.forEach((k, i) => { if (row[i] !== null) o[k] = row[i]; }); return o; }) : (p || []));

// ---------- start ----------
async function boot(prefetched) {
  if (!configured()) { show('signin'); $('signinMsg').textContent = 'The app is not set up yet: fill in config.js (see SETUP.md).'; return; }
  const saved = state.idToken || store.get(TOKEN_KEY);
  if (!tokenValid(saved)) return startSignIn();
  state.idToken = saved;
  if (prefetched) { state.me = prefetched; return startApp(); }
  const local = loadLocal();
  if (local) {   // show the last screens at once; the first sync also re-checks who I am
    Object.assign(state, { me: local.me, ho: local.ho, mine: local.mine, reports: local.reports, dec: local.dec, po: local.po || null, vendors: local.vendors || null, tab: state.tab || local.tab });
    const st = state.store;
    if (local.store) { st.unit = local.store.unit || ''; st.base = local.store.base || null; if (local.store.meta) st.meta[local.store.unit] = local.store.meta; }
    if (local.stores) Object.entries(local.stores).forEach(([u, p]) => putStore(u, p));
    st.data = st.byUnit[st.unit] || null;
    if (local.ho2) { state.goods = local.ho2.goods || null; state.hr.data = local.ho2.hr || null; }
    if (local.rates) state.rt.data = local.rates;
    return startApp(true);
  }
  show('loading');
  try {
    const r = await api('sync', { want: { me: true, ho: true, mine: true } });
    if (!r.me || r.me.error) throw new ApiError(r.me?.code || 'SERVER', r.me?.error || 'Could not load.');
    state.me = r.me; applySync(r);
  } catch (e) { return handleError(e); }
  startApp();
}

const defaultTab = () => { const u = state.me.user; return u.isHO ? 'assign' : u.isApprover ? 'approve' : hasStore() ? 'store' : 'reports'; };
function setupChrome() {
  const u = state.me.user;
  $('who').textContent = `${u.name} · ${roleLabel(u)}`;
  $('modeTag').hidden = state.me.mode === 'LIVE';
  $('btnSignOut').hidden = false; $('btnRefresh').hidden = false;
  $('tabAssign').hidden = !u.isHO; $('tabApprove').hidden = !u.isApprover;
  $('tabPO').hidden = !u.isHO;
  $('tabGoods').hidden = !u.isHO;
  $('tabHoInv').hidden = !u.isHO;
  $('tabHoNr').hidden = !u.isHO;
  $('tabRates').hidden = !u.isHO;
  $('tabStore').hidden = !hasStore();
  setupStoreUnits();
  $('approverPick').innerHTML = '<option value="">Choose approver…</option>' + state.me.approvers.map((n) => `<option>${esc(n)}</option>`).join('');
  setupViewAs();
}
function startApp(withMe) {
  setupChrome();
  show('app');
  render();
  setTab(state.tab || defaultTab(), withMe);
  if (state.me.preview) banner(''); else setupNotifications();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('firebase-messaging-sw.js', { updateViaCache: 'none' }).catch(() => {});
  if (state.me.user.isHO) setTimeout(() => {   // HO tabs open instantly: their data is fetched quietly in the background
    if (state.tab !== 'honr') loadHoNr(false, true);
    if (state.tab !== 'rates') loadRates(true, true);
  }, 2500);
}

const roleLabel = (u) => {
  const base = u.isHO && u.isApprover ? 'HO in-charge & approver' : u.isHO ? 'HO in-charge' : u.isApprover ? 'Approver' : '';
  const sk = u.isStore ? 'Storekeeper · ' + (u.units || []).join(', ') : '';
  return [base, sk].filter(Boolean).join(' · ') || 'Reports only';
};
const hasStore = () => !!(state.me && state.me.storeUnits && state.me.storeUnits.length);

// ---------- admin preview ("view as") ----------
function setupViewAs() {
  const me = state.me;
  document.body.classList.toggle('preview', readOnly());
  document.body.classList.toggle('actas', !!me.actAs);
  $('previewNote').hidden = !me.preview;
  $('previewNote').textContent = me.actAs ? 'Acting as this person · trial' : 'Preview · read-only';
  $('previewNote').className = me.actAs ? 'actnote' : 'previewnote';
  if (!me.admin) { $('viewAsBar').hidden = true; return; }
  $('viewAsBar').hidden = false;
  const others = me.users.filter((x) => x.email !== me.admin.email);
  $('viewAsPick').innerHTML = `<option value="">Myself (${esc(me.admin.name)})</option>` +
    others.map((x) => `<option value="${esc(x.email)}">${esc(x.name)} · ${esc(roleLabel(x))} · ${esc(x.email)}</option>`).join('');
  $('viewAsPick').value = state.viewAs || '';
}
// Switching person: the screens of everyone already looked at are kept in memory, so switching back is instant;
// a new person needs ONE request (who + their lists together) instead of two.
const viewCache = {};
const VIEW_KEYS = ['me', 'tab', 'ho', 'mine', 'reports', 'dec', 'po', 'vendors'];
async function changeViewAs(email) {
  const gen = ++state.gen;
  const st = state.store;
  viewCache[state.viewAs || ''] = { ...Object.fromEntries(VIEW_KEYS.map((k) => [k, state[k]])), store: { unit: st.unit, byUnit: st.byUnit, raw: st.raw, base: st.base, meta: st.meta, prefetchedAt: st.prefetchedAt } };
  state.viewAs = email || null;
  state.poDone = null; state.poSel.clear(); state.poPrice = {}; state.sel.clear(); state.qty = {}; state.pick = {};
  Object.assign(st, { data: null, draft: null, rq: {}, inv: null, done: null, formUnit: '' });
  const c = viewCache[state.viewAs || ''];
  if (c && c.me) {   // seen before: show at once, then a quiet check
    VIEW_KEYS.forEach((k) => (state[k] = c[k]));
    Object.assign(st, c.store); st.data = st.byUnit[st.unit] || null;
    return startApp(true);
  }
  VIEW_KEYS.forEach((k) => (state[k] = null));
  Object.assign(st, { unit: '', byUnit: {}, raw: {}, prefetchedAt: 0 });
  show('loading');
  let r;
  try {
    r = await api('sync', { want: { me: true, ho: true, mine: true } });
    if (!r.me || r.me.error) throw new ApiError(r.me?.code || 'SERVER', r.me?.error || 'Could not switch.');
  } catch (e) { if (gen !== state.gen) return; state.viewAs = null; $('viewAsPick').value = ''; show('app'); return handleError(e); }
  if (gen !== state.gen) return;   // switched again while loading
  state.me = r.me; applySync(r);
  startApp();
}

function handleError(e) {
  if (e.code === 'AUTH') { store.del(TOKEN_KEY); state.idToken = null; return startSignIn(e.message); }
  if (e.code === 'PREVIEW') return toast(e.message, true);
  if (e.code === 'FORBIDDEN' && !state.me) { store.del(TOKEN_KEY); state.idToken = null; return startSignIn(e.message); }
  if (!state.me) { show('signin'); $('signinMsg').textContent = e.message; return; }
  toast(e.message, true);
}

// ---------- tabs & loading ----------
function setTab(tab, withMe) {
  const u = state.me.user;
  if (tab === 'assign' && !u.isHO) tab = u.isApprover ? 'approve' : 'reports';
  if (tab === 'approve' && !u.isApprover) tab = u.isHO ? 'assign' : 'reports';
  if (tab === 'store' && !hasStore()) tab = 'reports';
  if (tab === 'po' && !u.isHO) tab = 'reports';
  if ((tab === 'goods' || tab === 'hoinv' || tab === 'honr' || tab === 'rates') && !u.isHO) tab = 'reports';
  state.tab = tab; state.sel.clear();
  if (tab !== 'store' || state.store.view !== 'reports') unmountStoreReports();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('viewAssign').hidden = tab !== 'assign'; $('viewApprove').hidden = tab !== 'approve'; $('viewReports').hidden = tab !== 'reports';
  $('viewStore').hidden = tab !== 'store';
  $('viewPO').hidden = tab !== 'po';
  $('viewGoods').hidden = tab !== 'goods';
  $('viewHoInv').hidden = tab !== 'hoinv';
  $('viewHoNr').hidden = tab !== 'honr';
  $('viewRates').hidden = tab !== 'rates';
  if (tab === 'rates') loadRates(false);
  if (tab === 'honr') loadHoNr(false);
  if (tab === 'hoinv') renderHoInv(true);
  if (tab === 'goods') renderGoods();
  if (tab === 'po') renderPO(true);
  if (tab === 'reports') renderReports();
  if (tab === 'store') renderStore(true);
  refresh(false, withMe);
}

async function refresh(fresh, withMe) {
  fresh = fresh === true;   // only the ↻ button re-reads the sheet; otherwise the server's ready copy is used
  if (!state.me) return;
  if (saving() && !fresh && !withMe) return;   // a decision is on its way: don't bring its lines back yet
  const u = state.me.user, gen = state.gen, st = state.store;
  const wait = '<p class="empty">Loading… this can take a few seconds.</p>';
  if (u.isHO && !state.ho) $('listUnassigned').innerHTML = wait;
  if (u.isApprover && !state.mine) $('listPending').innerHTML = wait;
  // Everything in one request; v = the version already here, so unchanged reports are not sent again.
  const want = { ho: u.isHO, mine: u.isApprover };
  if (withMe) want.me = true;
  if (u.isHO && (state.tab === 'po' || state.po)) { want.po = { v: state.po?.v || '' }; if (!state.vendors) want.vendors = true; }
  const repOn = state.tab === 'reports' || state.tab === 'hoinv' || (state.tab === 'store' && st.view === 'reports');
  if (repOn || state.reports) want.reports = { v: state.reports?.v || '' };
  if ((repOn && state.rep.type === 'dec') || state.dec) want.dec = { v: state.dec?.v || '' };
  if (state.tab === 'goods' || (repOn && state.rep.type === 'gs') || state.goods) want.goods = { v: state.goods?.v || '' };
  if (hasStore() && st.unit && (state.tab === 'store' || st.data)) {
    want.store = { unit: st.unit, v: st.byUnit[st.unit] ? st.byUnit[st.unit].v : '' };
    if (!st.base) want.base = true;
    if (!st.meta[st.unit] && st.view === 'raise') want.meta = st.unit;
  }
  let r;
  try { r = await api('sync', { want, fresh }); } catch (e) { if (gen !== state.gen) return; return handleError(e); }
  if (gen !== state.gen) return;
  applySync(r, want.store && want.store.unit);
  // Drop selections for lines that are gone.
  const visible = new Set([...(state.ho ? [...state.ho.unassigned, ...state.ho.waiting] : []), ...(state.mine ? [...state.mine.pending, ...state.mine.onHold] : [])].map(key));
  [...state.sel].forEach((k) => { if (!visible.has(k)) state.sel.delete(k); });
  render();
  saveLocal();
  if (state.tab === 'store') prefetchStores();
}

/** Puts the parts of a sync reply into the app. */
function applySync(r, unit) {
  const errs = [];
  const take = (k, fn) => { const p = r[k]; if (!p) return; if (p.error) return errs.push(p); fn(p); };
  take('me', (me) => {
    const changed = JSON.stringify(me) !== JSON.stringify(state.me);
    state.me = me;
    if (changed && !$('app').hidden) {   // roles or units changed since last time
      setupChrome();
      const t = state.tab;
      if ((t === 'assign' && !me.user.isHO) || ((t === 'po' || t === 'goods' || t === 'hoinv' || t === 'honr' || t === 'rates') && !me.user.isHO) || (t === 'approve' && !me.user.isApprover) || (t === 'store' && !hasStore())) state.tab = null;
    }
  });
  take('ho', (p) => (state.ho = p));
  take('mine', (p) => {   // lines whose decision is still being saved stay hidden, even if this copy was read before the save
    if (p && deciding.size) { p.pending = p.pending.filter((l) => !deciding.has(key(l))); p.onHold = p.onHold.filter((l) => !deciding.has(key(l))); }
    state.mine = p;
  });
  // "same" = nothing changed since the copy here: keep it, just update its "as of" time
  take('reports', (p) => { if (!p.same) state.reports = p.reports; else if (state.reports && p.asOf) state.reports.asOf = p.asOf; state.repAt = Date.now(); });
  take('dec', (p) => { if (!p.same) state.dec = Object.assign({}, p.decisions, { lines: unpack(p.decisions.lines) }); else if (state.dec && p.asOf) state.dec.asOf = p.asOf; state.decAt = Date.now(); });
  take('goods', (p) => { if (!p.same) state.goods = p; else if (state.goods && p.asOf) state.goods.asOf = p.asOf; });
  take('store', (p) => putStore(unit || p.unit, p));
  take('stores', (all) => Object.entries(all).forEach(([u, p]) => { if (!p.error) putStore(u, p); }));
  take('base', (p) => (state.store.base = p));
  take('po', (p) => { if (!p.same) state.po = Object.assign({}, p, { lines: unpack(p.lines) }); else if (state.po && p.asOf) state.po.asOf = p.asOf; });
  take('vendors', (p) => { state.vendors = p.list; if (p.hotels) state.hotels = p.hotels; });
  take('meta', (p) => {
    const st = state.store, u = unit || p.unit;
    st.meta[u] = p; st.base = { categories: p.categories, uoms: p.uoms };
    // the request form may already be open: only refresh its item suggestions, so nothing typed is lost
    if (u === st.unit && $('pastItems')) $('pastItems').innerHTML = p.items.map((x) => `<option value="${esc(x[0])}">`).join('');
  });
  if (state.me && !state.tab && !$('app').hidden) setTab(defaultTab());
  if (errs.length) {
    const e = errs[0];
    if (e.code === 'AUTH') return handleError(new ApiError('AUTH', e.error));
    toast(e.error, true);
  }
}

const key = (l) => l.row + '|' + l.orderNo;

// ---------- rendering ----------
function render() {
  if (state.ho) {
    $('tabAssign').querySelector('.count').textContent = state.ho.unassigned.length || '';
    const units = [...new Set([...state.ho.unassigned, ...state.ho.waiting].map((l) => l.unit))].sort((a, b) => a.localeCompare(b));
    state.aUnit = fillSelect('aUnit', 'All units', units.map((u) => [u, u]), state.aUnit || '');
    const inUnit = (l) => !state.aUnit || l.unit === state.aUnit;
    const un = state.ho.unassigned.filter(inUnit), wt = state.ho.waiting.filter(inUnit);
    $('listUnassigned').innerHTML = groupHtml(un, 'assign', state.aUnit ? 'Nothing waiting for an approver in this unit.' : 'Nothing waiting for an approver.');
    $('aAll').checked = un.length > 0 && un.every((l) => state.sel.has(key(l)));
    $('waitingCount').textContent = wt.length;
    $('listWaiting').innerHTML = groupHtml(wt, 'reassign', 'Nothing waiting.');
  }
  if (state.mine) {
    $('tabApprove').querySelector('.count').textContent = state.mine.pending.length || '';
    const pUnits = [...new Set([...state.mine.pending, ...state.mine.onHold].map((l) => l.unit))].sort((a, b) => a.localeCompare(b));
    state.pUnit = fillSelect('pUnit', 'All units', pUnits.map((u) => [u, u]), state.pUnit || '');
    const inP = (l) => !state.pUnit || l.unit === state.pUnit;
    const pend = state.mine.pending.filter(inP), hold = state.mine.onHold.filter(inP);
    $('pAllWrap').hidden = !pend.length && !hold.length;
    $('listPending').innerHTML = groupHtml(pend, 'approve', state.pUnit ? 'Nothing waiting for you in this unit.' : 'All done. Nothing waiting for you.');
    $('pAll').checked = pend.length > 0 && pend.every((l) => state.sel.has(key(l)));
    $('holdTitle').hidden = !hold.length;
    $('listHold').innerHTML = hold.length ? groupHtml(hold, 'approve', '') : '';
  }
  updateDocks();
  if (state.tab === 'reports') renderReports();
  if (state.tab === 'store') renderStore();
  if (state.po) $('tabPO').querySelector('.count').textContent = state.po.lines.length || '';
  if (state.tab === 'po') renderPO();
  if (state.tab === 'goods') renderGoods();
  if (state.tab === 'hoinv') renderHoInv();
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
  lockStoreUnit(state.rep);
  const R = state.reports, f = state.rep;
  document.querySelectorAll('[data-rtype]').forEach((b) => b.classList.toggle('on', b.dataset.rtype === f.type));
  $('poReport').hidden = f.type === 'dec' || f.type === 'gs'; $('viewDecisions').hidden = f.type !== 'dec'; $('viewGoodsRep').hidden = f.type !== 'gs';
  if (f.type === 'dec') return renderDecisions();
  if (f.type === 'gs') return renderGoodsRep();
  document.querySelectorAll('[data-rview]').forEach((b) => b.classList.toggle('on', b.dataset.rview === f.view));
  $('fSort').hidden = f.view !== 'list';
  if (!R) { $('repBody').innerHTML = '<p class="empty">Loading report…</p>'; return; }
  const all = f.type === 'nr' ? R.notReceived : R.invoicePending;

  // Filter choices come from the data, so only units/months that have POs are offered.
  const clusters = [...new Set(R.unitMap.map((x) => x[0]).concat(all.some((p) => p.cluster === 'Other') ? ['Other'] : []))];
  f.cluster = fillSelect('fCluster', 'All clusters', clusters.map((c) => [c, c]), f.cluster);
  const unitsInCluster = [...new Set(all.filter((p) => !f.cluster || p.cluster === f.cluster).map((p) => p.unit))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('fUnit', 'All units', unitsInCluster.map((u) => [u, u]), f.unit);
  if (inStoreReports()) f.unit = repUnitOf(state.store.unit);   // Store > Reports: always this unit, even with no POs
  // Only vendors that have POs in this report (and in the chosen cluster/unit)
  const vendors = [...new Set(all.filter((p) => (!f.cluster || p.cluster === f.cluster) && (!f.unit || p.unit === f.unit)).map((p) => p.vendor || 'No vendor'))].sort((a, b) => a.localeCompare(b));
  f.vendor = fillSelect('fVendor', 'All vendors', vendors.map((v) => [v, v]), f.vendor);
  const months = reportMonths(R.from);
  f.month = fillSelect('fMonth', 'All months', months.slice().reverse().map((m) => [m, monthLabel(m)]), f.month);
  $('fAge').value = f.age; $('fAge').classList.toggle('on-filter', !!f.age);
  $('fSort').value = f.sort;
  if ($('fSearch').value !== f.q) $('fSearch').value = f.q;

  const q = f.q.trim().toLowerCase();
  const rows = all.filter((p) =>
    (!f.cluster || p.cluster === f.cluster) && (!f.unit || p.unit === f.unit) && (!f.vendor || (p.vendor || 'No vendor') === f.vendor) &&
    (!f.month || p.date.slice(0, 7) === f.month) && (!f.age || daysSince(p.date) > +f.age) &&
    (!q || [p.po, p.vendor, p.unitRaw, ...p.itemNames].join(' ').toLowerCase().includes(q)));

  state.repRows = rows;
  $('tPos').textContent = rows.length;
  $('tAmt').textContent = inr(rows.reduce((a, p) => a + p.amount, 0));
  const oldest = rows.reduce((a, p) => Math.max(a, daysSince(p.date)), 0);
  $('tOld').textContent = rows.length ? `${oldest} days` : '–';
  $('btnClear').hidden = !(f.cluster || f.unit || f.vendor || f.month || f.age || f.q);
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
      <div class="po-foot">${p.itemNames.length ? `<div class="items">${esc(p.itemNames.join(', '))}${more}</div>` : '<div></div>'}${state.rep.type === 'nr' && p.link ? `<a class="btn sm po-dl" href="${esc(p.link)}" target="_blank" rel="noopener">Download PO (PDF)</a>` : ''}</div>
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
  lockStoreUnit(state.df);
  const D = state.dec, f = state.df;
  document.querySelectorAll('[data-dview]').forEach((b) => b.classList.toggle('on', b.dataset.dview === f.view));
  if (!D) { $('decBody').innerHTML = '<p class="empty">Loading report… this can take a few seconds.</p>'; $('dTiles').innerHTML = ''; return; }
  // Every approver set up in the app, plus any other name found in the sheet, with how many lines each decided.
  const perApprover = {};
  D.lines.forEach((l) => { if (l.by) perApprover[l.by] = (perApprover[l.by] || 0) + 1; });
  const approvers = [...new Set([...(D.approvers || []), ...Object.keys(perApprover)])].sort((a, b) => a.localeCompare(b));
  f.approver = fillSelect('dApprover', 'All approvers', approvers.map((a) => [a, `${a} (${perApprover[a] || 0})`]), f.approver);
  f.status = fillSelect('dStatus', 'All statuses', STATUSES.map((x) => [x, stLabel(x)]), f.status);
  const clusters = [...new Set(D.unitMap.map((x) => x[0]).concat(D.lines.some((l) => l.c === 'Other') ? ['Other'] : []))];
  f.cluster = fillSelect('dCluster', 'All clusters', clusters.map((c) => [c, c]), f.cluster);
  const units = [...new Set(D.lines.filter((l) => !f.cluster || l.c === f.cluster).map((l) => l.u))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('dUnit', 'All units', units.map((u) => [u, u]), f.unit);
  if (inStoreReports()) f.unit = repUnitOf(state.store.unit);   // Store > Reports: always this unit, even with no POs
  const months = reportMonths(D.from);
  f.month = fillSelect('dMonth', 'All months', months.slice().reverse().map((m) => [m, monthLabel(m)]), f.month);
  if ($('dSearch').value !== f.q) $('dSearch').value = f.q;

  const base = decFiltered(true);
  const counts = Object.fromEntries(STATUSES.map((x) => [x, 0]));
  base.forEach((l) => counts[l.s]++);
  $('dTiles').innerHTML = STATUSES.map((x) => `<button class="tile ${f.status === x ? 'on' : ''}" data-dstatus="${esc(x)}"><span class="sub">${esc(stLabel(x))}</span><b>${counts[x]}</b></button>`).join('');
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
    <thead><tr><th>Approver</th>${STATUSES.map((x) => `<th>${esc(stLabel(x))}</th>`).join('')}<th>Total</th></tr></thead>
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
      filters: filterText([['Approver', f.approver], ['Status', f.status && stLabel(f.status)], ['Cluster', f.cluster], ['Unit', f.unit], ['Month', f.month && monthLabel(f.month)], ['Search', f.q.trim()]]),
      head: ['#', 'Order No', 'Requested', 'Decided', 'Unit', 'Cluster', 'Item', 'Qty asked', 'Qty approved', 'UOM', 'Status', 'Approver', 'Reason for rejection'],
      body: rows.map((l, i) => [i + 1, l.o, fmtDate(l.d), decDate(l), l.u, l.c, l.it, l.q, l.aq, l.uom, l.s, l.by, l.rm]),
      pdfCols: [0, 1, 2, 3, 4, 6, 7, 8, 10, 11, 12],
    };
  }
  if (which === 'cr') {
    const C = state.rt.cmp || { rows: [] };
    return {
      title: 'Rate comparison', file: `Rate comparison ${C.vendor || ''} ${stamp}`.replace(/\s+/g, ' '), money: -1,
      filters: (C.vendor ? 'Vendor: ' + C.vendor + ' · ' : '') + (C.file || ''),
      head: ['#', 'Quoted item', 'Qty', 'UOM', 'Quoted rate', 'Quoted GST %', 'Matched past item', 'Last rate', 'Last GST %', 'Diff Rs', 'Diff %', 'Last vendor', 'Last date', 'Last unit'],
      body: C.rows.map((r, i) => { const d = rateDiff(r); return [i + 1, r.item, r.qty, r.uom, r.rate, r.gst, r.match || 'No past purchase', r.last ? r.last[6] : '', r.last ? r.last[7] : '',
        d ? d.amt : '', d ? d.pct + '%' : '', r.last ? r.last[3] : '', r.last ? fmtDate(r.last[0]) : '', r.last ? r.last[2] : '']; }),
      pdfCols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    };
  }
  if (which === 'gs' || which === 'gsel' || which === 'gone') {
    const rows = which === 'gs' ? (state.gsRows || []) : which === 'gone' ? (state.goods?.list || []).filter((p) => p.po === state.gOne) : goodsSelected();
    const f = state.gsf;
    return {
      title: 'Status of goods', file: which === 'gone' ? `Status of goods PO ${state.gOne}` : `Status of goods ${stamp}`, money: 6,
      filters: which === 'gs' ? filterText([['Cluster', f.cluster], ['Unit', f.unit], ['Vendor', f.vendor], ['Status', f.st], ['Search', f.q.trim()]]) : which === 'gone' ? 'PO ' + state.gOne : rows.length + ' selected PO' + (rows.length === 1 ? '' : 's'),
      head: ['#', 'PO No', 'PO date', 'Unit', 'Cluster', 'Vendor', 'Amount', 'Items', 'Status of goods', 'Remark', 'Updated', 'Updated by', 'Document'],
      body: rows.map((p, i) => [i + 1, p.po, fmtDate(p.date), p.unit, p.cluster, p.vendor, Math.round(p.amount), p.itemNames.join(', ') + (p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : ''),
        p.g ? p.g.st : 'Not updated', p.g ? p.g.rm : '', p.g ? p.g.at : '', p.g ? p.g.by : '', p.g && p.g.doc ? p.g.doc : '']),
      pdfCols: [0, 1, 2, 3, 5, 6, 7, 8, 9, 10],
    };
  }
  const f = state.rep, rows = (state.repRows || []).slice();
  const s = f.sort;
  rows.sort((a, b) => s === 'new' ? b.date.localeCompare(a.date) : s === 'amt' ? b.amount - a.amount :
    s === 'unit' ? (a.unit.localeCompare(b.unit) || a.date.localeCompare(b.date)) : a.date.localeCompare(b.date));
  const name = f.type === 'nr' ? 'Material not received' : 'Invoice pending';
  return {
    title: name, file: `${name} ${stamp}`, money: 6,
    filters: filterText([['Cluster', f.cluster], ['Unit', f.unit], ['Vendor', f.vendor], ['Month', f.month && monthLabel(f.month)], ['Pending for', f.age && `over ${f.age} days`], ['Search', f.q.trim()]]),
    head: ['#', 'PO No', 'PO date', 'Days', 'Unit', 'Cluster', 'Amount', 'Vendor', 'Items', 'Item names'],
    body: rows.map((p, i) => [i + 1, p.po, fmtDate(p.date), daysSince(p.date), p.unit, p.cluster, Math.round(p.amount), p.vendor, p.items,
      p.itemNames.join(', ') + (p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '')]),
    pdfCols: [0, 1, 2, 3, 4, 6, 7, 8, 9],
  };
}

async function download(which, fmt, share) {
  const d = exportData(which);
  if (!d.body.length) return toast('Nothing to ' + (share ? 'share' : 'download') + ': no lines match these filters.', true);
  toast(`Preparing ${fmt === 'xlsx' ? 'Excel' : fmt === 'png' ? 'snapshot' : 'PDF'}…`);
  if (fmt === 'png') return snapshotTable(d.title, d.filters + ' · ' + d.body.length + ' rows', d.pdfCols.map((i) => d.head[i]), d.body.map((r) => d.pdfCols.map((i) => (i === d.money ? inr(r[i]) : r[i]))), d.file + '.png');
  try { await loadLibs(fmt); } catch (e) { return toast(e.message, true); }
  if (fmt === 'xlsx') {
    const XLSX = window.XLSX;
    const aoa = [[d.title], [d.filters + ' · ' + d.body.length + ' rows'], [], d.head, ...d.body];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = d.head.map((h, i) => ({ wch: Math.min(48, Math.max(h.length + 2, ...d.body.slice(0, 300).map((r) => String(r[i] ?? '').length + 2))) }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + d.body.length, c: d.head.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, d.title.slice(0, 31));
    if (share) return shareFile(new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), d.file + '.xlsx');
    XLSX.writeFile(wb, d.file + '.xlsx');
  } else {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(14); doc.text('Summit Procurement - ' + d.title, 30, 32);
    doc.setFontSize(9); doc.setTextColor(90); doc.text(doc.splitTextToSize(d.filters + ' · ' + d.body.length + ' rows · ' + new Date().toLocaleString('en-IN'), 780), 30, 48);
    const pick = (r) => d.pdfCols.map((i) => (i === d.money ? 'Rs ' + Number(r[i]).toLocaleString('en-IN') : String(r[i] ?? '')));
    doc.autoTable({
      head: [pick(d.head).map((h, i) => (d.pdfCols[i] === d.money ? 'Amount' : h))], body: d.body.map(pick), startY: 62,
      styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' }, headStyles: { fillColor: [133, 22, 27] },
      margin: { left: 30, right: 30 },
      didDrawPage: () => { doc.setFontSize(8); doc.setTextColor(120); doc.text('Page ' + doc.internal.getNumberOfPages(), 780, 580); },
    });
    if (share) return shareFile(doc.output('blob'), d.file + '.pdf');
    doc.save(d.file + '.pdf');
  }
}

// ---------- snapshot (picture) of any table ----------
function snapshotTable(title, sub, head, body, name) {
  const MAXR = 150, rows = body.slice(0, MAXR).map((r) => r.map((c) => String(c ?? '')));
  if (body.length > MAXR) sub += ` · first ${MAXR} rows shown (use PDF/Excel for all)`;
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  g.font = '13px system-ui, sans-serif';
  const W = head.map((h, j) => Math.min(260, Math.max(36, g.measureText(h).width + 18, ...rows.map((r) => g.measureText(r[j]).width + 14))));
  const pad = 10, rowH = 30, top = 76, sc = 2;
  const width = Math.max(560, W.reduce((a, b) => a + b, 0) + pad * 2), height = top + rowH * (rows.length + 1) + pad * 2;
  cv.width = width * sc; cv.height = height * sc; g.scale(sc, sc);
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#111'; g.font = 'bold 18px system-ui, sans-serif'; g.fillText('Summit Procurement - ' + title, pad, 30);
  g.fillStyle = '#555'; g.font = '12px system-ui, sans-serif'; g.fillText(sub.length > 160 ? sub.slice(0, 157) + '…' : sub, pad, 52);
  const fit = (t, w) => { t = String(t); if (g.measureText(t).width <= w) return t; while (t && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
  [head, ...rows].forEach((r, i) => {
    const y = top + i * rowH;
    g.fillStyle = i === 0 ? '#85161b' : i % 2 ? '#fff' : '#f8f1f2'; g.fillRect(pad, y, width - pad * 2, rowH);
    g.fillStyle = i === 0 ? '#fff' : '#111'; g.font = (i === 0 ? 'bold ' : '') + '13px system-ui, sans-serif';
    let x = pad;
    r.forEach((c, j) => { g.fillText(fit(c, W[j] - 10), x + 5, y + 20); x += W[j]; });
  });
  g.strokeStyle = '#d0d6e0'; g.strokeRect(pad, top, width - pad * 2, rowH * (rows.length + 1));
  cv.toBlob((b) => (b ? shareFile(b, name) : toast('Could not make the snapshot.', true)), 'image/png');
}

// ---------- PO / invoice / document files: download or share the real file ----------
async function driveFile(url, name, share) {
  toast('Getting the file…');
  try {
    const r = await api('fileData', { url });
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const ext = (r.name.match(/\.\w{2,4}$/) || [''])[0] || (r.type === 'application/pdf' ? '.pdf' : r.type === 'image/png' ? '.png' : r.type === 'image/jpeg' ? '.jpg' : '');
    const blob = new Blob([bytes], { type: r.type || 'application/octet-stream' });
    const file = String(name || r.name).replace(/[\\/:*?"<>|]/g, '-') + (String(name || '').endsWith(ext) ? '' : ext);
    if (share) return shareFile(blob, file);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = file; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    // could not fetch the file through the app: fall back to the Drive link
    if (share && navigator.share) { try { await navigator.share({ title: name, text: name, url }); return; } catch (x) { if (x.name === 'AbortError') return; } }
    if (share) { window.open('https://wa.me/?text=' + encodeURIComponent(name + ': ' + url), '_blank', 'noopener'); return; }
    window.open(dlLink(url), '_blank', 'noopener');
  }
}

// ---------- HO: status of goods ----------
const NOT_UPDATED = 'Not updated';
const docBtns = (doc, po) => doc ? `<a class="btn sm" href="${esc(doc)}" target="_blank" rel="noopener">View document</a><button type="button" class="btn sm" data-fdl="${esc(doc)}" data-fname="Goods status ${esc(po)}">Download document</button><button type="button" class="btn sm" data-fshare="${esc(doc)}" data-fname="Goods status ${esc(po)}">Share document</button>` : '';
// every PO card: View PO + share/download this PO's status (+ document buttons when a document is uploaded)
const goodsBtns = (p) => `<div class="filelinks">${p.link ? `<a class="btn sm" href="${esc(p.link)}" target="_blank" rel="noopener">View PO</a>` : ''}<button type="button" class="btn sm" data-gone="${esc(p.po)}" data-gfmt="pdf" data-gsh="1">Share status</button><button type="button" class="btn sm" data-gone="${esc(p.po)}" data-gfmt="png" data-gsh="1">Share snapshot</button><button type="button" class="btn sm" data-gone="${esc(p.po)}" data-gfmt="pdf">Download status</button>${p.g && p.g.doc ? docBtns(p.g.doc, p.po) : ''}</div>`;
const vendorOf = (p) => p.vendor || 'Vendor not given';
function goodsFiltered() {
  const G = state.goods, f = state.gf, q = f.q.trim().toLowerCase();
  return (G?.list || []).filter((p) => (!f.unit || p.unit === f.unit) && (!f.vendor || vendorOf(p) === f.vendor) && (!f.st || (p.g ? p.g.st : NOT_UPDATED) === f.st) &&
    (!q || [p.po, p.vendor, p.unit, ...p.itemNames, p.g ? p.g.rm : ''].join(' ').toLowerCase().includes(q)));
}
function goodsSelected() { return (state.goods?.list || []).filter((p) => state.gsel.has(p.po)); }
function renderGoods(force) {
  const G = state.goods, f = state.gf, body = $('goodsBody');
  if (!G) { body.innerHTML = '<p class="empty">Loading… this can take a few seconds.</p>'; return; }
  if (!force && state.gform.po && body.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;   // keep what is being typed
  if (!force && state.gform.po && $('gFile') && $('gFile').files.length) return;
  const units = [...new Set(G.list.map((p) => p.unit))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('gUnit', 'All units', units.map((u) => [u, u]), f.unit);
  const vendors = [...new Set(G.list.filter((p) => !f.unit || p.unit === f.unit).map(vendorOf))].sort((a, b) => a.localeCompare(b));
  f.vendor = fillSelect('gVendor', 'All vendors', vendors.map((v) => [v, v]), f.vendor);
  f.st = fillSelect('gStatus', 'All statuses', [NOT_UPDATED, ...G.statuses].map((x) => [x, x]), f.st);
  if ($('gSearch').value !== f.q) $('gSearch').value = f.q;
  const rows = goodsFiltered();
  $('gAll').checked = rows.length > 0 && rows.every((p) => state.gsel.has(p.po));
  $('gCount').textContent = state.gsel.size ? state.gsel.size + ' selected' : '';
  $('goodsAsOf').textContent = `${rows.length} PO${rows.length === 1 ? '' : 's'} · POs made from ${fmtDate(REP_FROM_ISO)} · updated ${G.asOf}`;
  const ro = readOnly();
  body.innerHTML = rows.length ? rows.map((p) => {
    const open = state.gform.po === p.po, g = p.g, fm = state.gform;
    const more = p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '';
    return `<article class="card">
      <div class="top"><label class="selall"><input type="checkbox" data-gsel="${esc(p.po)}" ${state.gsel.has(p.po) ? 'checked' : ''}> <b>PO ${esc(p.po)}</b></label>${p.amount ? `<span class="amt">${inr(p.amount)}</span>` : ''}</div>
      <div class="sub">${esc(p.unit)} · <b>${esc(p.vendor || 'Vendor not given')}</b> · ${fmtDate(p.date)} · ${daysSince(p.date)} days</div>
      <div class="items">${esc(p.itemNames.join(', '))}${more}</div>
      <div class="sub">Received at unit: ${p.rcv}/${p.items} item${p.items > 1 ? 's' : ''}</div>
      <div class="sub" style="margin-top:4px">Status of goods: <span class="gst">${esc(g ? g.st : NOT_UPDATED)}</span>${g && g.rm ? ' · ' + esc(g.rm) : ''}${g ? ` <span class="sub">(${esc(g.at)}, ${esc(g.by)})</span>` : ''}</div>
      ${goodsBtns(p)}
      ${open ? `<form class="gform" id="gForm" data-po="${esc(p.po)}">
        <label class="field">Status<select name="st" required><option value="">Choose…</option>${G.statuses.map((x) => `<option ${x === (fm.st ?? g?.st) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label class="field">Document (photo or PDF)<input id="gFile" name="file" type="file" accept="image/*,application/pdf"></label>
        <label class="field full">Remark<input name="rm" maxlength="300" value="${esc(fm.rm ?? (g ? g.rm : ''))}" placeholder="e.g. Dispatched by transport, LR no. 1234"></label>
        <div class="formfoot full"><button type="button" class="btn ghost" data-gcancel>Cancel</button><button type="submit" class="btn primary">${g ? 'Update status' : 'Save status'}</button></div>
      </form>` : (ro ? '' : `<div class="formfoot" style="margin:8px 0 0"><span></span><button class="btn primary" data-gopen="${esc(p.po)}">${g ? 'Update status' : 'Enter status'}</button></div>`)}
    </article>`;
  }).join('') : '<p class="empty">No POs match these filters.</p>';
}
async function saveGoods(form) {
  if (!noPreview()) return;
  const po = form.dataset.po, st = form.st.value, rm = form.rm.value.trim(), f = form.file.files[0];
  if (!st) return toast('Choose the status of the goods.', true);
  let file = null;
  try { if (f) file = await fileForUpload(f); } catch (e) { return toast(e.message, true); }
  await run('Saving status…', async () => {
    const r = await api('goodsSave', { pos: [po], status: st, remark: rm, file });
    const p = (state.goods?.list || []).find((x) => x.po === po);
    if (p) p.g = { st, rm, doc: r.doc || (p.g && p.g.doc) || '', at: 'just now', by: state.me.user.name };
    state.gform = {}; state.goods.v = '';
    toast('Status of goods saved. You can update it any time.');
    renderGoods(true);
    refresh();
  });
}
function goodsClick(e) {
  const one = e.target.closest('[data-gone]');
  if (one) { state.gOne = one.dataset.gone; download('gone', one.dataset.gfmt, !!one.dataset.gsh); return true; }
  const o = e.target.closest('[data-gopen]');
  if (o) { state.gform = { po: o.dataset.gopen }; renderGoods(true); return true; }
  if (e.target.closest('[data-gcancel]')) { state.gform = {}; renderGoods(true); return true; }
  return false;
}
function setupGoodsEvents() {
  $('gUnit').onchange = (e) => { state.gf.unit = e.target.value; state.gf.vendor = ''; renderGoods(true); };
  $('gStatus').onchange = (e) => { state.gf.st = e.target.value; renderGoods(true); };
  $('gVendor').onchange = (e) => { state.gf.vendor = e.target.value; renderGoods(true); };
  $('gSearch').oninput = (e) => { state.gf.q = e.target.value; renderGoods(true); };
  $('gAll').onchange = (e) => { goodsFiltered().forEach((p) => (e.target.checked ? state.gsel.add(p.po) : state.gsel.delete(p.po))); renderGoods(true); };
  $('gPdf').onclick = () => (state.gsel.size ? download('gsel', 'pdf', true) : toast('Tick the POs first.', true));
  $('gSnap').onclick = () => (state.gsel.size ? download('gsel', 'png', true) : toast('Tick the POs first.', true));
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type=checkbox][data-gsel]')) { t.checked ? state.gsel.add(t.dataset.gsel) : state.gsel.delete(t.dataset.gsel); renderGoods(true); }
    else if (t.closest('#gForm') && t.name === 'st') state.gform.st = t.value;
  });
  document.addEventListener('input', (e) => { if (e.target.closest('#gForm') && e.target.name === 'rm') state.gform.rm = e.target.value; });
  document.addEventListener('submit', (e) => { if (e.target.id === 'gForm') { e.preventDefault(); saveGoods(e.target); } });
  [['gsCluster', 'cluster'], ['gsUnit', 'unit'], ['gsVendor', 'vendor'], ['gsStatus', 'st']].forEach(([id, k]) =>
    ($(id).onchange = (e) => { state.gsf[k] = e.target.value; if (k === 'cluster') state.gsf.unit = ''; if (k === 'cluster' || k === 'unit') state.gsf.vendor = ''; renderGoodsRep(); }));
  $('gsSearch').oninput = (e) => { state.gsf.q = e.target.value; renderGoodsRep(); };
  $('gsClear').onclick = () => { Object.assign(state.gsf, { cluster: '', unit: '', vendor: '', st: '', q: '' }); renderGoodsRep(); };
}
const REP_FROM_ISO = '2026-04-01';

// ---------- HO: upload invoice (any unit), with unit-wise and vendor-wise drop-downs ----------
function renderHoInv(force) {
  const H = state.hi, body = $('hiBody'), R = state.reports;
  if (!R) { body.innerHTML = '<p class="empty">Loading…</p>'; return; }
  if (!force && H.form && body.querySelector('#hoInvForm')) return;   // don't wipe what is being typed
  const all = R.invoicePending;
  H.unit = fillSelect('hiUnit', 'All units', [...new Set(all.map((p) => p.unit))].sort((a, b) => a.localeCompare(b)).map((u) => [u, u]), H.unit);
  const vend = [...new Set(all.filter((p) => !H.unit || p.unit === H.unit).map((p) => p.vendor || 'No vendor'))].sort((a, b) => a.localeCompare(b));
  H.vendor = fillSelect('hiVendor', 'All vendors', vend.map((v) => [v, v]), H.vendor);
  const rows = all.filter((p) => (!H.unit || p.unit === H.unit) && (!H.vendor || (p.vendor || 'No vendor') === H.vendor))
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  $('hiAsOf').textContent = `${rows.length} PO${rows.length === 1 ? '' : 's'} with invoice pending · updated ${R.asOf}`;
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  body.innerHTML = rows.length ? rows.map((p) => {
    const f = H.form && H.form.po === p.po ? H.form : null;
    const more = p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '';
    return `<article class="card">
      <div class="top"><h3>PO ${esc(p.po)}</h3><span class="amt">${inr(p.amount)}</span></div>
      <div class="sub">${esc(p.unit)} · ${esc(p.vendor || 'No vendor')} · ${fmtDate(p.date)} · ${p.items} item${p.items > 1 ? 's' : ''}</div>
      ${p.itemNames.length ? `<div class="items">${esc(p.itemNames.join(', '))}${more}</div>` : ''}
      ${f ? `<form class="grid2" id="hoInvForm" data-po="${esc(p.po)}">
        <label class="field full">Invoice photo or PDF<input name="file" type="file" accept="image/*,application/pdf" required></label>
        <p class="field full aihint">${f.ai ? esc(f.ai) : '✨ Choose the invoice first – AI will fill the number, date and total for you.'}</p>
        <label class="field">Invoice number<input name="no" maxlength="40" required value="${esc(f.no || '')}"></label>
        <label class="field">Invoice date<input name="date" type="date" max="${today}" required value="${esc(f.date || today)}"></label>
        <label class="field">Invoice total (₹)<input name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(f.amount ?? (p.amount || ''))}"></label>
        <div class="formfoot field full"><button type="button" class="btn ghost" data-hicancel>Cancel</button><button type="submit" class="btn primary">Upload invoice</button></div>
      </form>` : `<div class="formfoot" style="margin:8px 0 0"><span></span><button class="btn primary" data-hiopen="${esc(p.po)}">Upload invoice</button></div>`}
    </article>`;
  }).join('') : '<p class="empty">No invoice pending for these filters.</p>';
}
async function hoUploadInvoice(form) {
  if (!noPreview()) return;
  const po = form.dataset.po, no = form.no.value.trim(), date = form.date.value, amount = form.amount.value, file = form.file.files[0];
  if (!no) return toast('Enter the invoice number.', true);
  if (!date) return toast('Enter the invoice date.', true);
  if (!(Number(amount) > 0)) return toast('Enter the invoice total.', true);
  if (!file) return toast('Choose the invoice photo or PDF.', true);
  run('storeInvoice', async () => {
    let f;
    try { f = await fileForUpload(file); } catch (e) { return toast(e.message, true); }
    toast('Uploading invoice…');
    await api('storeInvoice', { po, invoiceNo: no, date, amount: Number(amount), file: { type: f.type, data: f.data } });
    state.hi.form = null;
    if (state.reports) state.reports.invoicePending = state.reports.invoicePending.filter((p) => p.po !== po);
    toast(`Invoice uploaded for PO ${po}.`);
    renderHoInv(true);
  });
}
function setupHoInvEvents() {
  $('hiUnit').onchange = (e) => { state.hi.unit = e.target.value; state.hi.vendor = ''; renderHoInv(true); };
  $('hiVendor').onchange = (e) => { state.hi.vendor = e.target.value; renderHoInv(true); };
  const body = $('hiBody');
  body.addEventListener('click', (e) => {
    const o = e.target.closest('[data-hiopen]');
    if (o) { state.hi.form = { po: o.dataset.hiopen }; renderHoInv(true); return; }
    if (e.target.closest('[data-hicancel]')) { state.hi.form = null; renderHoInv(true); }
  });
  body.addEventListener('input', (e) => { const t = e.target; if (t.form && t.form.id === 'hoInvForm' && state.hi.form && t.name !== 'file') state.hi.form[t.name] = t.value; });
  body.addEventListener('change', (e) => { const t = e.target; if (t.name === 'file' && t.form && t.form.id === 'hoInvForm' && t.files[0]) aiReadInvoice(t.form, t.files[0], () => state.hi.form); });
  body.addEventListener('submit', (e) => { if (e.target.id === 'hoInvForm') { e.preventDefault(); hoUploadInvoice(e.target); } });
}

// ---------- HO: material not received (any unit), receive like the store ----------
async function loadHoNr(fresh, quiet) {
  const H = state.hr;
  if (!quiet) { if (H.data) renderHoNr(); else $('hrBody').innerHTML = '<p class="empty">Loading… this can take a few seconds.</p>'; }
  try { H.data = await api('hoReceiveList', fresh ? { fresh: true } : {}); } catch (e) { return quiet ? null : handleError(e); }
  if (state.tab === 'honr' && !document.querySelector('#hrBody input:focus')) renderHoNr();
  saveLocal();
}
function hoNrGroups() {
  const H = state.hr, map = new Map();
  (H.data?.lines || []).filter((l) => (!H.unit || l.u === H.unit) && (!H.vendor || (l.ven || 'No vendor') === H.vendor)).forEach((l) => {
    const k = l.u + '|' + l.po.toUpperCase();
    if (!map.has(k)) map.set(k, { u: l.u, po: l.po, ven: l.ven, amt: l.amt, d: l.d, pol: H.data.pol[l.po], lines: [] });
    map.get(k).lines.push(l);
  });
  return [...map.values()].sort((a, b) => a.d.localeCompare(b.d));
}
function renderHoNr() {
  const H = state.hr, body = $('hrBody');
  if (!H.data) return;
  const all = H.data.lines;
  H.unit = fillSelect('hrUnit', 'All units', [...new Set(all.map((l) => l.u))].sort((a, b) => a.localeCompare(b)).map((u) => [u, u]), H.unit);
  const vend = [...new Set(all.filter((l) => !H.unit || l.u === H.unit).map((l) => l.ven || 'No vendor'))].sort((a, b) => a.localeCompare(b));
  H.vendor = fillSelect('hrVendor', 'All vendors', vend.map((v) => [v, v]), H.vendor);
  const groups = hoNrGroups();
  $('hrAsOf').textContent = `${groups.length} PO${groups.length === 1 ? '' : 's'} not received · updated ${H.data.asOf}`;
  body.innerHTML = groups.length ? `<p class="sub">Enter the quantity that actually arrived. Clear the box for items that have not come yet.</p>` + groups.map((g) => {
    const days = daysSince(g.d);
    return `<article class="card">
      <div class="top"><h3>PO ${esc(g.po)}</h3><span class="age ${days > 30 ? 'bad' : days > 15 ? 'warn' : ''}">${days} days</span></div>
      <div class="sub">${esc(g.u)} · ${esc(g.ven || 'Vendor not given')} · ${fmtDate(g.d)}${g.amt ? ' · ' + inr(g.amt) : ''}${g.pol ? ` · <a href="${esc(g.pol)}" target="_blank" rel="noopener">View PO</a>` : ''}</div>
      ${g.lines.map((l) => {
        const k = l.row + '|' + l.o, ordered = l.aq !== '' && l.aq != null ? l.aq : l.q;
        const v = k in H.rq ? H.rq[k] : ordered;
        return `<div class="rline">
          <div class="lmain"><span class="item">${esc(l.it)}</span><span class="sub">Ordered ${esc(ordered)} ${esc(l.uom)} · ${esc(l.o)}</span></div>
          <label class="qty">Recd <input type="number" inputmode="decimal" min="0" step="any" data-hrq="${esc(k)}" value="${esc(v)}" aria-label="Received quantity of ${esc(l.it)}"></label>
        </div>`;
      }).join('')}
      <div class="formfoot" style="margin:8px 0 0"><span></span><button class="btn primary" data-hrecv="${esc(g.u + '|' + g.po)}">Save received</button></div>
    </article>`;
  }).join('') : '<p class="empty">No material pending for these filters.</p>';
}
function hoSaveReceived(key) {
  if (!noPreview()) return;
  const H = state.hr, g = hoNrGroups().find((x) => x.u + '|' + x.po === key);
  if (!g) return;
  const items = [];
  for (const l of g.lines) {
    const k = l.row + '|' + l.o;
    const input = document.querySelector(`[data-hrq="${CSS.escape(k)}"]`);
    const v = input ? input.value.trim() : '';
    if (v === '') continue;
    const n = Number(v);
    if (!(n > 0)) return toast(`Enter a quantity above 0 for ${l.it}, or clear the box.`, true);
    items.push({ row: l.row, orderNo: l.o, qty: n, it: l.it, ordered: l.aq !== '' && l.aq != null ? Number(l.aq) : Number(l.q) });
  }
  if (!items.length) return toast('Enter the received quantity for at least one item.', true);
  const over = items.filter((i) => i.qty > i.ordered);
  if (over.length && !confirm(`More than ordered for: ${over.map((i) => i.it).join(', ')}. Save anyway?`)) return;
  run('storeReceive', async () => {
    const r = await api('storeReceive', { items: items.map(({ row, orderNo, qty }) => ({ row, orderNo, qty })) });
    const ok = new Set(items.map((i) => i.row));
    (r.skipped || []).forEach((s) => { const it = items.find((i) => i.orderNo === s.orderNo); if (it) ok.delete(it.row); });
    H.data.lines = H.data.lines.filter((l) => !ok.has(l.row));
    items.forEach((i) => delete H.rq[i.row + '|' + i.orderNo]);
    toast(`${r.received} item${r.received === 1 ? '' : 's'} marked received for PO ${g.po}.` + skippedText(r.skipped), r.skipped.length > 0);
    renderHoNr();
  });
}
function setupHoNrEvents() {
  $('hrUnit').onchange = (e) => { state.hr.unit = e.target.value; state.hr.vendor = ''; renderHoNr(); };
  $('hrVendor').onchange = (e) => { state.hr.vendor = e.target.value; renderHoNr(); };
  const body = $('hrBody');
  body.addEventListener('input', (e) => { const k = e.target.dataset.hrq; if (k) state.hr.rq[k] = e.target.value; });
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-hrecv]'); if (b) hoSaveReceived(b.dataset.hrecv); });
}

// ---------- HO: check rates (last purchase rate + GST; AI compares a vendor quotation) ----------
let ratesAt = 0;
async function loadRates(fresh, quiet) {
  const R = state.rt;
  const fill = () => { $('rtNames').innerHTML = Object.values(R.data.names).sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}">`).join(''); };
  if (R.data && !quiet) { if (!$('rtNames').options.length) fill(); renderRates(); }
  if (R.data && !fresh && Date.now() - ratesAt < 300000) return;   // fetched in the last 5 minutes
  if (!R.data && !quiet) $('rtList').innerHTML = '<p class="empty">Loading item rates…</p>';
  try { R.data = await api('rateList'); ratesAt = Date.now(); } catch (e) { return quiet ? null : handleError(e); }
  fill();
  if (state.tab === 'rates') renderRates();
  saveLocal();
}
const rateDiff = (r) => r.last && r.rate > 0 ? { amt: Math.round((r.rate - r.last[6]) * 100) / 100, pct: Math.round((r.rate - r.last[6]) / r.last[6] * 1000) / 10 } : null;
function histHtml(h) {
  return `<div class="sub">${fmtDate(h[0])} · ${esc(h[3] || 'Vendor not given')} · ${esc(h[2])} · PO ${esc(h[1])}${h[4] ? ' · ' + esc(h[4]) + ' ' + esc(h[5]) : ''}</div>`;
}
function renderRates() {
  const R = state.rt, D = R.data;
  if (!D) return;
  const bf = D.backfill;
  $('rtAsOf').textContent = `${D.count} past purchase lines · ${Object.keys(D.names).length} items · updated ${D.asOf}` + (bf && !bf.done ? ' · old PO PDFs are still being read in the background' : '');
  const q = R.q.trim().toLowerCase();
  if (!q) { $('rtList').innerHTML = '<p class="sub">Type an item name to see its last purchase rate and GST.</p>'; }
  else {
    const words = q.split(/\s+/);
    const hits = Object.keys(D.names).filter((k) => words.every((w) => D.names[k].toLowerCase().includes(w)))
      .sort((a, b) => (D.names[a].toLowerCase() === q ? -1 : 0) - (D.names[b].toLowerCase() === q ? -1 : 0) || D.idx[b][0][0].localeCompare(D.idx[a][0][0])).slice(0, 25);
    $('rtList').innerHTML = hits.length ? hits.map((k) => {
      const h = D.idx[k], l = h[0];
      return `<article class="card">
        <div class="top"><h3>${esc(D.names[k])}</h3><span class="amt">${inr(l[6])}${l[5] ? ' / ' + esc(l[5]) : ''}</span></div>
        <div class="sub"><b>GST ${l[7] === '' ? 'not known' : esc(l[7]) + '%'}</b> · last bought ${fmtDate(l[0])} from ${esc(l[3] || '-')} · ${esc(l[2])} · PO ${esc(l[1])}</div>
        <div class="filelinks">${(([po, inv]) => (po ? `<a class="btn sm" href="${esc(po)}" target="_blank" rel="noopener">View PO</a>` : '<span class="btn sm" aria-disabled="true" style="opacity:.45">No PO file</span>')
          + (inv ? `<a class="btn sm" href="${esc(inv)}" target="_blank" rel="noopener">View invoice</a>` : '<span class="btn sm" aria-disabled="true" style="opacity:.45">No invoice yet</span>'))((D.lk || {})[String(l[1]).trim().toUpperCase()] || [])}</div>
        ${h.length > 1 ? `<details><summary class="sub">Earlier rates (${h.length - 1})</summary>${h.slice(1).map((x) => `<div class="sub">${inr(x[6])} · GST ${x[7] === '' ? '-' : esc(x[7]) + '%'} · ${fmtDate(x[0])} · ${esc(x[3] || '-')} · ${esc(x[2])}</div>`).join('')}</details>` : ''}
      </article>`;
    }).join('') : '<p class="empty">No past purchase found for this item.</p>';
  }
  renderCompare();
}
function renderCompare() {
  const R = state.rt, C = R.cmp, box = $('rtCmp');
  $('rtDl').hidden = !(C && C.rows.length);
  if (R.busy) { box.innerHTML = `<p class="sub">✨ ${esc(R.busy)}</p>`; return; }
  if (!C) { box.innerHTML = ''; return; }
  if (!C.rows.length) { box.innerHTML = '<p class="empty">AI found no item lines in this file.</p>'; return; }
  const max = Math.max(...C.rows.map((r) => Math.max(r.rate || 0, r.last ? r.last[6] : 0)), 1);
  const up = C.rows.filter((r) => { const d = rateDiff(r); return d && d.amt > 0; }).length, down = C.rows.filter((r) => { const d = rateDiff(r); return d && d.amt < 0; }).length;
  box.innerHTML = `<p class="sub">${C.vendor ? '<b>' + esc(C.vendor) + '</b> · ' : ''}${C.rows.length} items · ${up} costlier · ${down} cheaper · ${C.rows.length - C.rows.filter((r) => r.last).length} with no past purchase</p>
    <div class="legend sub"><span class="cbar q"></span> Quoted rate <span class="cbar l"></span> Last purchase rate</div>` +
    C.rows.map((r) => {
      const d = rateDiff(r);
      return `<article class="card cmp">
        <div class="top"><h3>${esc(r.item)}</h3>${d ? `<span class="age ${d.amt > 0 ? 'bad' : d.amt < 0 ? 'good' : ''}">${d.amt > 0 ? '+' : ''}${d.pct}%</span>` : '<span class="age">New item</span>'}</div>
        <div class="sub">${r.match ? 'Matched to: <b>' + esc(r.match) + '</b>' : 'No past purchase of this item'}</div>
        <div class="bars"><div class="cbar q" style="width:${Math.max(2, r.rate / max * 55)}%"></div><span>${inr(r.rate)}${r.gst !== '' ? ' + ' + esc(r.gst) + '% GST' : ''} quoted</span></div>
        ${r.last ? `<div class="bars"><div class="cbar l" style="width:${Math.max(2, r.last[6] / max * 55)}%"></div><span>${inr(r.last[6])}${r.last[7] !== '' ? ' + ' + esc(r.last[7]) + '% GST' : ''} last paid</span></div>${histHtml(r.last)}` : ''}
        ${d ? `<div class="sub">Difference: <b>${d.amt > 0 ? '+' : ''}${inr(d.amt)}</b> per ${esc(r.uom || 'unit')}${r.qty ? ` · on qty ${esc(r.qty)}: ${d.amt > 0 ? '+' : ''}${inr(Math.round(d.amt * r.qty))}` : ''}</div>` : ''}
      </article>`;
    }).join('');
}
async function compareQuote(file) {
  const R = state.rt;
  R.cmp = null; R.busy = 'Reading the quotation with AI and matching items… this can take up to a minute.'; renderCompare();
  try {
    let payload;
    if (/\.(xlsx|xls|csv)$/i.test(file.name) || /sheet|excel|csv/.test(file.type)) {
      await loadLibs('xlsx');
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      payload = { text: wb.SheetNames.slice(0, 5).map((n) => window.XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })).join('\n\n').slice(0, 60000) };
    } else { const f = await fileForUpload(file); payload = { file: { type: f.type, data: f.data } }; }
    const r = await api('rateCompare', payload);
    R.cmp = { vendor: r.vendor, rows: r.rows, file: file.name };
  } catch (e) { R.busy = ''; renderCompare(); return handleError(e); }
  R.busy = ''; renderCompare();
}
function setupRatesEvents() {
  $('rtSearch').oninput = (e) => { state.rt.q = e.target.value; renderRates(); };
  $('rtFile').onchange = (e) => { const f = e.target.files[0]; if (f) compareQuote(f); e.target.value = ''; };
}

// ---------- Reports: status of goods ----------
function renderGoodsRep() {
  lockStoreUnit(state.gsf);
  const G = state.goods, f = state.gsf;
  if (!G) { $('gsBody').innerHTML = '<p class="empty">Loading report… this can take a few seconds.</p>'; return; }
  const clusters = [...new Set(G.list.map((p) => p.cluster))];
  f.cluster = fillSelect('gsCluster', 'All clusters', clusters.map((c) => [c, c]), f.cluster);
  const units = [...new Set(G.list.filter((p) => !f.cluster || p.cluster === f.cluster).map((p) => p.unit))].sort((a, b) => a.localeCompare(b));
  f.unit = fillSelect('gsUnit', 'All units', units.map((u) => [u, u]), f.unit);
  if (inStoreReports()) f.unit = repUnitOf(state.store.unit);   // Store > Reports: always this unit, even with no POs
  const vendors = [...new Set(G.list.filter((p) => (!f.cluster || p.cluster === f.cluster) && (!f.unit || p.unit === f.unit)).map(vendorOf))].sort((a, b) => a.localeCompare(b));
  f.vendor = fillSelect('gsVendor', 'All vendors', vendors.map((v) => [v, v]), f.vendor);
  f.st = fillSelect('gsStatus', 'All statuses', [NOT_UPDATED, ...G.statuses].map((x) => [x, x]), f.st);
  if ($('gsSearch').value !== f.q) $('gsSearch').value = f.q;
  const q = f.q.trim().toLowerCase();
  const rows = G.list.filter((p) => (!f.cluster || p.cluster === f.cluster) && (!f.unit || p.unit === f.unit) && (!f.vendor || vendorOf(p) === f.vendor) && (!f.st || (p.g ? p.g.st : NOT_UPDATED) === f.st) &&
    (!q || [p.po, p.vendor, p.unit, ...p.itemNames, p.g ? p.g.rm : ''].join(' ').toLowerCase().includes(q)));
  state.gsRows = rows;
  $('gsTotal').textContent = `${rows.length} PO${rows.length === 1 ? '' : 's'} · ${inr(rows.reduce((a, p) => a + p.amount, 0))}`;
  $('gsClear').hidden = !(f.cluster || f.unit || f.vendor || f.st || f.q);
  $('gsAsOf').textContent = `Status of goods · POs made from ${fmtDate(REP_FROM_ISO)} · updated ${G.asOf}`;
  $('gsBody').innerHTML = rows.length ? rows.slice(0, 300).map((p) => {
    const g = p.g, more = p.items > p.itemNames.length ? ` and ${p.items - p.itemNames.length} more` : '';
    return `<article class="po">
      <div class="top"><b>${esc(p.po)}</b><span class="amt">${inr(p.amount)}</span></div>
      <div class="sub">${esc(p.unit)} <span class="sub">(${esc(p.cluster)})</span> · ${esc(p.vendor || 'No vendor')} · ${fmtDate(p.date)}</div>
      <div class="items">${esc(p.itemNames.join(', '))}${more}</div>
      <div class="sub">Status of goods: <span class="gst">${esc(g ? g.st : NOT_UPDATED)}</span>${g && g.rm ? ' · ' + esc(g.rm) : ''}${g ? ` <span class="sub">(${esc(g.at)}, ${esc(g.by)})</span>` : ''}</div>
      ${goodsBtns(p)}
    </article>`;
  }).join('') + (rows.length > 300 ? '<p class="sub">First 300 shown. Use the filters, or download for all.</p>' : '') : '<p class="empty">No POs match these filters.</p>';
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
  if (mode === 'assign' || mode === 'reassign') {   // unit-wise: all requisitions of a unit together, under the unit name
    const order = [...new Set(lines.map((l) => l.unit))].sort((a, b) => a.localeCompare(b));
    return order.map((u) => assignGroupHtml({ unit: u, when: '', lines: lines.filter((l) => l.unit === u) }, mode)).join('');
  }
  if (mode === 'approve') {   // unit-wise: unit name once, then all its items
    const order = [...new Set(lines.map((l) => l.unit))].sort((a, b) => a.localeCompare(b));
    groups.length = 0;
    order.forEach((u) => groups.push({ unit: u, when: '', lines: lines.filter((l) => l.unit === u) }));
  }
  return groups.map((g) => {
    const allSel = g.lines.every((l) => state.sel.has(key(l)));
    return `<article class="group">
      <label class="ghead"><input type="checkbox" data-group="${esc(g.lines.map(key).join(','))}" ${allSel ? 'checked' : ''}>
        <span><b>${esc(g.unit)}</b> <span class="sub">${g.when ? esc(g.when) + ' · ' : ''}${g.lines.length} item${g.lines.length > 1 ? 's' : ''}</span></span></label>
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
  const dis = readOnly() ? 'disabled' : '';
  const ready = g.lines.filter((l) => state.pick[key(l)] && state.pick[key(l)] !== l.approver).length;
  return `<article class="group">
    <div class="ghead assignhead">
      ${dis ? '' : `<input type="checkbox" data-group="${esc(keys)}" ${g.lines.every((l) => state.sel.has(key(l))) ? 'checked' : ''} aria-label="Select all lines of this requisition">`}
      <span class="gtitle"><b>${esc(g.unit)}</b> <span class="sub">${g.when ? esc(g.when) + ' · ' : ''}${g.lines.length} line${g.lines.length > 1 ? 's' : ''}</span></span>
      ${g.lines.length > 1 ? `<select class="gpick" data-gpick="${esc(keys)}" ${dis} aria-label="Approver for all lines of ${esc(g.unit)}">${approverOptions('').replace('Choose approver…', 'Same approver for all…')}</select>` : ''}
    </div>
    ${g.lines.map((l) => {
      const k = key(l), meta = [l.when, l.category, l.orderNo].filter(Boolean).map(esc).join(' · ');
      const pic = l.pic ? ` <a href="${esc(l.pic)}" target="_blank" rel="noopener">photo</a>` : '';
      const chosen = state.pick[k] ?? l.approver ?? '';
      return `<div class="line">
        <div class="lrow">${dis ? '' : `<input type="checkbox" data-key="${esc(k)}" ${state.sel.has(k) ? 'checked' : ''} aria-label="Select ${esc(l.item)}">`}
          <div class="lmain"><span class="item">${esc(l.item)}</span><span class="sub">${meta}${pic}</span></div>
          ${dis || !EDIT_ITEM_ON ? '' : `<button class="btn sm ghost iedit" data-edit="${esc(k)}" title="Edit item name" aria-label="Edit item name">✎</button>`}</div>
        ${stockHtml(l)}
        <label class="pickrow"><span class="sub">Approver</span>
          <select data-pick="${esc(k)}" ${dis} aria-label="Approver for ${esc(l.item)}">${approverOptions(chosen)}</select></label>
      </div>`;
    }).join('')}
    ${readOnly() ? '' : `<div class="gfoot"><span class="sub">${ready ? ready + ' line' + (ready > 1 ? 's' : '') + ' ready' : mode === 'reassign' ? 'Change the approver to send again' : 'Choose an approver for each line'}</span>
      <button class="btn sm primary" data-gsend="${esc(keys)}" ${ready ? '' : 'disabled'}>Send${ready ? ' (' + ready + ')' : ''}</button></div>`}
  </article>`;
}

function sendGroup(keys) {
  const pool = [...(state.ho?.unassigned || []), ...(state.ho?.waiting || [])];
  const lines = pool.filter((l) => keys.includes(key(l)) && state.pick[key(l)] && state.pick[key(l)] !== l.approver);
  if (!lines.length) return toast('Choose an approver first.', true);
  const byApprover = {};
  lines.forEach((l) => (byApprover[state.pick[key(l)]] = byApprover[state.pick[key(l)]] || []).push(l));
  const picked = {};
  lines.forEach((l) => (picked[key(l)] = state.pick[key(l)]));
  optimistic(() => {   // move them to "waiting for approver" at once
    const ho = state.ho; if (!ho) return;
    const sent = new Set(lines.map(key));
    const moved = [...ho.unassigned, ...ho.waiting].filter((l) => sent.has(key(l))).map((l) => ({ ...l, approver: picked[key(l)] }));
    ho.unassigned = ho.unassigned.filter((l) => !sent.has(key(l)));
    ho.waiting = moved.concat(ho.waiting.filter((l) => !sent.has(key(l))));
    lines.forEach((l) => delete state.pick[key(l)]);
  }, async () => {
    const msgs = [], skipped = [];
    for (const [approver, ls] of Object.entries(byApprover)) {
      const r = await api('assign', { approver, items: ls.map((l) => ({ row: l.row, orderNo: l.orderNo })) });
      const how = r.notified.push ? 'notified on phone' : r.notified.email ? 'notified by email' : 'not notified';
      msgs.push(`${r.assigned} to ${r.approver} (${how})`);
      skipped.push(...r.skipped);
    }
    toast('Sent: ' + msgs.join('; ') + '.' + skippedText(skipped), skipped.length > 0);
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
        <span class="lmain"><span class="item">${hold}${esc(l.item)}</span><span class="sub">${l.when ? esc(l.when) + ' · ' : ''}${meta}${pic}</span></span></label>
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
  const assignOn = state.tab === 'assign' && !!n && !readOnly();
  $('assignDock').hidden = !assignOn; $('assignCount').textContent = label;
  $('approveDock').hidden = !(state.tab === 'approve' && n); $('approveCount').textContent = label;
  document.body.classList.toggle('docked', (!!n && state.tab === 'approve') || assignOn);
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
    refresh();
  });
}

const EDIT_ITEM_ON = true;   // the server writes the name to FORMDATA (FMS follows by its QUERY)
// ---------- HO: edit item name (writes FMS column E; refused if the sheet changed meanwhile) ----------
function editItem(k) {
  const ho = state.ho; if (!ho) return;
  const l = [...ho.unassigned, ...ho.waiting].find((x) => key(x) === k); if (!l) return;
  const typed = prompt('Correct the item name:', l.item);
  if (typed === null) return;
  const name = typed.replace(/\s+/g, ' ').trim();
  if (!name || name === l.item) return;
  run('editItem', async () => {
    const r = await api('editItem', { row: l.row, orderNo: l.orderNo, oldItem: l.item, item: name });
    const newK = r.row + '|' + r.orderNo;
    [ho.unassigned, ho.waiting, state.mine?.pending, state.mine?.onHold].forEach((list) => (list || []).forEach((x) => {
      if (x.row === l.row && x.orderNo === l.orderNo) { x.item = r.item; x.orderNo = r.orderNo; }
    }));
    if (newK !== k) {
      if (state.sel.has(k)) { state.sel.delete(k); state.sel.add(newK); }
      if (k in state.pick) { state.pick[newK] = state.pick[k]; delete state.pick[k]; }
    }
    render();
    toast('Item name updated in the sheet.');
  });
}

// ---------- HO: PDF / snapshot of the selected lines, ready to send to a vendor ----------
function selectedAssignLines() {
  return [...(state.ho?.unassigned || []), ...(state.ho?.waiting || [])].filter((l) => state.sel.has(key(l)))
    .sort((a, b) => a.unit.localeCompare(b.unit));
}
async function shareFile(blob, name) {
  const f = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function exportRequirement(kind) {
  const ls = selectedAssignLines();
  if (!ls.length) return toast('Select the items first.', true);
  const units = [...new Set(ls.map((l) => l.unit))];
  const when = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const sub = `${units.join(', ')} · ${ls.length} item${ls.length > 1 ? 's' : ''} · ${when}`;
  const stamp = new Date().toISOString().slice(0, 10);
  if (!(state.hotels && state.hotels.length && state.hotels[0].length > 3)) {   // billing details of each unit (from the P.O tab)
    try { const r = await api('sync', { want: { vendors: true } }); if (r.vendors && !r.vendors.error) { state.vendors = r.vendors.list; if (r.vendors.hotels) state.hotels = r.vendors.hotels; } } catch (e) { /* print without them */ }
  }
  const nz = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hl = state.hotels || [];
  const bill = units.map((u) => {
    const k = nz(u) === 'headoffice' ? 'goods' : nz(u);
    const h = hl.find((x) => nz(x[0]) === k || nz(x[1]) === k) || hl.find((x) => nz(x[0]) && k.indexOf(nz(x[0])) === 0);
    if (!h) return `Bill to (${u}): details not found`;
    return `Bill to (${u}): ${h[1]}${h[3] ? ', ' + h[3].replace(/\s*\n\s*/g, ', ') : ''}${h[4] ? ' · Ph ' + h[4] : ''}${h[2] ? ' · GSTIN ' + h[2] : ''}`;
  });
  const head = ['#', 'Unit', 'Item', 'Qty', 'UOM', 'Category'];
  const body = ls.map((l, i) => [i + 1, l.unit, l.item, l.qty === '' ? '' : String(l.qty), l.uom, l.category || '']);
  if (kind === 'pdf') {
    try { await loadLibs('pdf'); } catch (e) { return toast(e.message, true); }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    doc.setFontSize(15); doc.text('Summit Hotels and Resorts - Purchase requirement', 40, 42);
    doc.setFontSize(9); doc.setTextColor(90); doc.text(doc.splitTextToSize(sub, 515), 40, 58);
    doc.setFontSize(10); doc.setTextColor(20); let y = 76;
    bill.forEach((b) => { const t = doc.splitTextToSize(b, 515); doc.text(t, 40, y); y += t.length * 12 + 4; });
    doc.autoTable({ startY: y + 4, head: [head], body, styles: { fontSize: 9, cellPadding: 4 }, headStyles: { fillColor: [30, 64, 120] },
      columnStyles: { 0: { cellWidth: 24 }, 3: { halign: 'right' } }, margin: { left: 40, right: 40 } });
    return shareFile(doc.output('blob'), `Requirement ${stamp}.pdf`);
  }
  // Snapshot: the same table drawn as a picture (PNG)
  const W = [40, 190, 420, 80, 80, 170], pad = 10, rowH = 34, width = W.reduce((a, b) => a + b, 0) + pad * 2;
  const mc = document.createElement('canvas').getContext('2d'); mc.font = 'bold 15px system-ui, sans-serif';
  const wrap = (t, w) => { const out = []; let line = ''; String(t).split(' ').forEach((wd) => { const tr = line ? line + ' ' + wd : wd; if (mc.measureText(tr).width > w && line) { out.push(line); line = wd; } else line = tr; }); if (line) out.push(line); return out; };
  const billLines = bill.flatMap((b) => wrap(b, width - pad * 2));
  const top = 86 + billLines.length * 22 + (billLines.length ? 10 : 0);
  const height = top + rowH * (ls.length + 1) + pad * 2, sc = 2;
  const cv = document.createElement('canvas'); cv.width = width * sc; cv.height = height * sc;
  const g = cv.getContext('2d'); g.scale(sc, sc);
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  g.fillStyle = '#111'; g.font = 'bold 20px system-ui, sans-serif'; g.fillText('Summit Hotels and Resorts - Purchase requirement', pad, 34);
  g.fillStyle = '#555'; g.font = '14px system-ui, sans-serif'; g.fillText(sub.length > 130 ? sub.slice(0, 127) + '…' : sub, pad, 60);
  g.fillStyle = '#111'; g.font = 'bold 15px system-ui, sans-serif'; billLines.forEach((t, i) => g.fillText(t, pad, 88 + i * 22));
  const fit = (t, w) => { t = String(t); if (g.measureText(t).width <= w) return t; while (t && g.measureText(t + '…').width > w) t = t.slice(0, -1); return t + '…'; };
  [head, ...body].forEach((r, i) => {
    const y = top + i * rowH;
    g.fillStyle = i === 0 ? '#1e4078' : i % 2 ? '#fff' : '#f2f5fa'; g.fillRect(pad, y, width - pad * 2, rowH);
    g.fillStyle = i === 0 ? '#fff' : '#111'; g.font = (i === 0 ? 'bold ' : '') + '14px system-ui, sans-serif';
    let x = pad;
    r.forEach((c, j) => { const w = W[j]; g.textAlign = j === 3 ? 'right' : 'left'; g.fillText(fit(c, w - 12), j === 3 ? x + w - 6 : x + 6, y + 22); x += w; });
    g.textAlign = 'left';
  });
  g.strokeStyle = '#d0d6e0'; g.strokeRect(pad, top, width - pad * 2, rowH * (ls.length + 1));
  cv.toBlob((b) => (b ? shareFile(b, `Requirement ${stamp}.png`) : toast('Could not make the snapshot.', true)), 'image/png');
}

const deciding = new Set();   // keys of lines whose decision is on its way to the server
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
  const gone = new Set(lines.map(key));
  gone.forEach((k) => deciding.add(k));
  optimistic(() => {   // the lines leave the list at once; the server is told in the background
    lines.forEach((l) => { state.sel.delete(key(l)); delete state.qty[key(l)]; });
    const m = state.mine; if (!m) return;
    const moved = [...m.pending, ...m.onHold].filter((l) => gone.has(key(l)));
    m.pending = m.pending.filter((l) => !gone.has(key(l))); m.onHold = m.onHold.filter((l) => !gone.has(key(l)));
    if (decision === 'On Hold') m.onHold = moved.map((l) => ({ ...l, approval: 'On Hold' })).concat(m.onHold);
  }, async () => {
    const r = await api('decide', { decision, items, remark }).finally(() => gone.forEach((k) => deciding.delete(k)));
    toast(`${r.decided} line${r.decided === 1 ? '' : 's'} marked ${r.decision}.` + skippedText(r.skipped), r.skipped.length > 0);
  });
}

/** Shows the result of an action straight away, sends it to the server, and puts things back if it fails.
 * When the last action has gone through, one quiet sync brings the lists up to date. */
function optimistic(apply, call) {
  const before = { ho: state.ho && structuredClone(state.ho), mine: state.mine && structuredClone(state.mine) };
  apply(); render();
  const sid = beginSave();
  call().catch((e) => { state.ho = before.ho; state.mine = before.mine; render(); handleError(e); })
    .finally(() => { endSave(sid); if (!saving()) refresh(); });
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

let pushSentAt = 0, pushWatching = false;
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
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js', { updateViaCache: 'none' });
    reg.update().catch(() => {}); // always pick up the newest notification worker
    const sendToken = async () => {
      const token = await getToken(messaging, { vapidKey: CFG.VAPID_KEY, serviceWorkerRegistration: reg });
      if (!token) throw new Error('No notification token');
      await api('register', { token, device: navigator.userAgent.slice(0, 120) });
      store.set('nlp.pushToken', token);
      pushSentAt = Date.now();
    };
    await sendToken(); // register on every open, so the server always has this device's current token
    if (!pushWatching) { // also re-register whenever the app comes back to the screen (at most every 30 min)
      pushWatching = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Notification.permission === 'granted' && Date.now() - pushSentAt > 30 * 60 * 1000) {
          sendToken().catch((e) => console.error(e));
        }
      });
      navigator.serviceWorker.addEventListener('message', (ev) => { // push arrived while the app is open
        if (ev.data && ev.data.type === 'nlp-push') { toast(ev.data.title || 'New update'); refresh(); }
      });
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

// ---------- storekeeper ----------
// Everything here is for ONE unit at a time. The server checks the unit again on every read and write,
// so a storekeeper can never see or change another unit's lines, whatever this page sends.
const UNIT_KEY = 'nlp.storeUnit';
const blankLine = () => ({ cat: '', item: '', qty: '', uom: '', stock: '', photo: null });
const sv = state.store;

function setupStoreUnits() {
  const units = state.me.storeUnits || [];
  if (!units.length) return;
  const saved = store.get(UNIT_KEY);
  if (!units.includes(sv.unit)) sv.unit = units.includes(saved) ? saved : units[0];
  const one = units.length === 1;
  $('storeUnit').hidden = one; $('storeUnitOnly').hidden = !one;
  $('storeUnitOnly').textContent = units[0];
  $('storeUnit').innerHTML = units.map((u) => `<option>${esc(u)}</option>`).join('');
  $('storeUnit').value = sv.unit;
  const note = $('storeNote');
  if (state.me.storeAll) { note.hidden = false; note.textContent = 'Trial: as admin you can work for every unit. A storekeeper will only see the unit(s) set against their email in APP USERS.'; }
  else if (state.me.actAs) { note.hidden = false; note.textContent = 'Trial: you are acting as this storekeeper. What you submit is saved as them (the log also shows you).'; }
  else if (state.me.preview) { note.hidden = false; note.textContent = 'Preview of this storekeeper\'s screens. Nothing can be submitted while previewing.'; }
  else note.hidden = true;
}

/** Keeps one unit's store lines (packed as sent by the server) and makes them the current lines if it is the unit shown. */
function putStore(unit, p) {
  if (!unit || !p) return;
  if (p.same) {
    const d = sv.byUnit[unit]; if (d && p.asOf) { d.asOf = p.asOf; if (sv.raw[unit]) sv.raw[unit].asOf = p.asOf; }
  } else if (p.lines) {
    sv.raw[unit] = { lines: p.lines, pol: p.pol || {}, ivl: p.ivl || {}, asOf: p.asOf, v: p.v };
    const lines = unpack(p.lines), pol = p.pol || {}, ivl = p.ivl || {};
    lines.forEach((l) => { if (l.po) { l.pol = pol[l.po] || ''; if (ivl[l.po]) l.ivi = ivl[l.po]; } });
    sv.byUnit[unit] = { unit, lines, asOf: p.asOf, v: p.v };
  }
  if (unit === sv.unit) sv.data = sv.byUnit[unit] || null;
}

// Switching unit shows that unit AT ONCE from the copy kept here; a quiet check then brings it up to date.
function changeStoreUnit(u) {
  sv.unit = u; store.set(UNIT_KEY, u);
  Object.assign(sv, { data: sv.byUnit[u] || null, draft: null, rq: {}, inv: null, done: null, formUnit: '', show: 150 });
  renderStore(true);
  const gen = state.gen;
  loadStore(false, gen).then(() => { if (gen === state.gen && u === sv.unit) renderStore(); }).catch(handleError);
}

async function loadStore(fresh, gen) {
  const unit = sv.unit;
  const want = { store: { unit, v: !fresh && sv.byUnit[unit] ? sv.byUnit[unit].v : '' } };
  if (!sv.base) want.base = true;
  if (!sv.meta[unit] && sv.view === 'raise') want.meta = unit;
  const r = await api('sync', { want, fresh: !!fresh });
  if (gen !== state.gen) return;
  applySync(r, unit);
  saveLocal();
}

/** In the background, fetch every unit this person can work on (several per request, only those that changed),
 * so that switching unit never has to wait. Runs when the Store tab is used, at most every 5 minutes. */
async function prefetchStores() {
  const units = state.me?.storeUnits || [];
  if (units.length < 2 || sv.prefetching || Date.now() - sv.prefetchedAt < 300000) return;
  sv.prefetching = true;
  const gen = state.gen;
  try {
    const others = units.filter((u) => u !== sv.unit);
    for (let i = 0; i < others.length; i += 9) {
      const chunk = others.slice(i, i + 9);
      const r = await api('sync', { want: { stores: chunk.map((u) => ({ unit: u, v: sv.byUnit[u] ? sv.byUnit[u].v : '' })) } });
      if (gen !== state.gen) return;
      applySync(r);
    }
    sv.prefetchedAt = Date.now();
    saveLocal();
  } catch (e) { console.warn('Prefetch of units failed', e); }
  finally { sv.prefetching = false; }
}

// ---- what each screen shows ----
const isCentral = (v) => /central\s*store/i.test(v || '');
function poGroups(filter) {
  const map = new Map();
  (sv.data?.lines || []).filter(filter).forEach((l) => {
    const k = l.po.toUpperCase();
    if (!map.has(k)) map.set(k, { po: l.po, pol: l.pol, ivi: l.ivi, ven: l.ven, amt: l.amt, d: l.d, lines: [] });
    map.get(k).lines.push(l);
  });
  return [...map.values()].sort((a, b) => a.d.localeCompare(b.d));   // oldest first
}
const toReceive = () => poGroups((l) => l.s === 'Approved' && l.po && l.rcv === '');
const toInvoice = () => poGroups((l) => l.s === 'Approved' && l.po && l.rcv !== '' && l.inv === 'pending' && !isCentral(l.ven));

function lineStatus(l) {
  if (l.inv === 'done') return ['Invoice uploaded', 'done'];
  if (l.rcv !== '' && l.rcv != null) return [`Received ${l.rcv} ${l.uom}` + (l.inv === 'pending' ? ' · invoice pending' : ''), 'received'];
  if (l.s === 'Approved' && l.po) return ['PO raised · to receive', 'po'];
  if (l.s === 'Approved') return ['Approved · PO pending', 'approved'];
  if (l.s === 'Rejected') return ['Rejected', 'rejected'];
  if (l.s === 'On Hold') return ['On hold', 'onhold'];
  if (l.s === 'Withdrawn') return ['Withdrawn', 'waiting'];
  if (l.ap) return ['Waiting for ' + l.ap, 'waiting'];
  return ['With HO', 'waiting'];
}
const STATUS_FILTERS = [
  ['pending', 'Pending approval'], ['invoiced', 'Invoice uploaded'], ['rejected', 'Rejected / hold'],
];
function statusMatch(l, f) {
  const c = lineStatus(l)[1];
  if (f === 'pending') return c === 'waiting' && l.s !== 'Withdrawn';
  if (f === 'po') return c === 'po';
  if (f === 'received') return c === 'received';
  if (f === 'invoiced') return c === 'done';
  if (f === 'rejected') return c === 'rejected' || c === 'onhold' || l.s === 'Withdrawn';
  return true;
}

// ---- rendering ----
function renderStore(force) {
  if (!hasStore()) return;
  const busyForm = $('storeBody').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!force && sv.view !== 'raise' && (busyForm || (sv.view === 'invoice' && sv.inv))) return;   // background refresh: don't wipe what is being typed
  document.querySelectorAll('[data-stype]').forEach((b) => b.classList.toggle('on', b.dataset.stype === sv.view));
  const loaded = !!sv.data;
  $('cReceive').textContent = loaded ? toReceive().length || '' : '';
  $('cInvoice').textContent = loaded ? toInvoice().length || '' : '';
  $('tabStore').querySelector('.count').textContent = loaded ? (toReceive().length + toInvoice().length) || '' : '';
  $('storeAsOf').textContent = loaded && sv.view !== 'reports' ? `${sv.unit} · as of ${sv.data.asOf}` : '';
  const body = $('storeBody');
  body.hidden = sv.view === 'reports';
  if (sv.view === 'reports') { mountStoreReports(); renderReports(); return; }
  unmountStoreReports();
  if (sv.view === 'raise') {
    if (!sv.base) { body.innerHTML = '<p class="empty">Loading…</p>'; return; }
    if (sv.formUnit === sv.unit && body.querySelector('#raiseForm')) return;   // keep what is being typed
    if (!sv.meta[sv.unit]) loadMeta(sv.unit);   // past-item suggestions arrive a moment later
    body.innerHTML = raiseHtml(); sv.formUnit = sv.unit; return;
  }
  sv.formUnit = '';
  if (!loaded) { body.innerHTML = '<p class="empty">Loading… this can take a few seconds.</p>'; return; }
  if (sv.view === 'receive') body.innerHTML = receiveHtml();
  else if (sv.view === 'invoice') body.innerHTML = invoiceHtml();
  else body.innerHTML = statusHtml();
}

let metaLoading = '';
function loadMeta(unit) {
  if (metaLoading === unit) return;
  metaLoading = unit;
  api('sync', { want: { meta: unit } }).then((r) => applySync(r, unit)).catch(() => {}).finally(() => { if (metaLoading === unit) metaLoading = ''; });
}

function raiseHtml() {
  const meta = { categories: sv.base.categories, uoms: sv.base.uoms, items: sv.meta[sv.unit]?.items || [] };
  if (!sv.draft) sv.draft = [blankLine()];
  const done = sv.done ? `<div class="done-msg">${sv.done.sending ? 'Sending' : 'Request sent'}: ${sv.done.lines.length} item${sv.done.lines.length > 1 ? 's' : ''} for ${esc(sv.done.unit)}.
    HO will choose the approver.${sv.done.sending ? ' You can carry on.' : ` Order no: ${sv.done.lines.map((l) => `<code>${esc(l.orderNo)}</code>`).join(', ')}`}</div>` : '';
  const cats = (sel) => '<option value="">Choose…</option>' + meta.categories.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const uoms = (sel) => '<option value="">Unit…</option>' + meta.uoms.map((u) => `<option ${u === sel ? 'selected' : ''}>${esc(u)}</option>`).join('');
  return `${done}<form id="raiseForm" autocomplete="off">
    <datalist id="pastItems">${meta.items.map((x) => `<option value="${esc(x[0])}">`).join('')}</datalist>
    ${sv.draft.map((l, i) => `<div class="card">
      <div class="top"><h3>Item ${i + 1}</h3>${sv.draft.length > 1 ? `<button type="button" class="btn sm ghost storeact" data-rmline="${i}">Remove</button>` : ''}</div>
      <div class="grid2">
        <label class="field full">Item name<input data-f="item" data-i="${i}" list="pastItems" maxlength="100" required value="${esc(l.item)}" placeholder="Type or pick a past item"></label>
        <label class="field full">Category<select data-f="cat" data-i="${i}" required>${cats(l.cat)}</select></label>
        <label class="field">Quantity needed<input data-f="qty" data-i="${i}" type="number" inputmode="decimal" min="0" step="any" required value="${esc(l.qty)}"></label>
        <label class="field">Unit<select data-f="uom" data-i="${i}" required>${uoms(l.uom)}</select></label>
        <label class="field">Stock in hand<input data-f="stock" data-i="${i}" type="number" inputmode="decimal" min="0" step="any" required value="${esc(l.stock)}" placeholder="0 if none"></label>
        <div class="field">Photo (optional)<div class="photorow">
          ${l.photo ? `<img class="thumb" src="${l.photo.preview}" alt="Photo of item ${i + 1}"><button type="button" class="btn sm ghost" data-rmphoto="${i}">Remove</button>`
            : `<input type="file" accept="image/*" data-photo="${i}" aria-label="Photo of item ${i + 1}">`}
        </div></div>
      </div>
    </div>`).join('')}
    <div class="formfoot storeact">
      <button type="button" class="btn" id="addLine" ${sv.draft.length >= 30 ? 'disabled' : ''}>+ Add another item</button>
      <button type="submit" class="btn primary">Send request (${sv.draft.length} item${sv.draft.length > 1 ? 's' : ''})</button>
    </div>
  </form>`;
}

function receiveHtml() {
  const groups = toReceive();
  if (!groups.length) return '<p class="empty">Nothing to receive. Approved lines show here once their PO is made.</p>';
  return `<p class="sub">Enter the quantity that actually arrived. Clear the box for items that have not come yet.</p>` + groups.map((g) => {
    const days = daysSince(g.d);
    return `<article class="card">
      <div class="top"><h3>PO ${esc(g.po)}</h3><span class="age ${days > 30 ? 'bad' : days > 15 ? 'warn' : ''}">${days} days</span></div>
      <div class="sub">${esc(g.ven || 'Vendor not given')} · ${fmtDate(g.d)}${g.amt ? ' · ' + inr(g.amt) : ''}${g.pol ? ` · <a href="${esc(g.pol)}" target="_blank" rel="noopener">View PO</a>` : ''}</div>
      ${g.lines.map((l) => {
        const k = l.row + '|' + l.o, ordered = l.aq !== '' && l.aq != null ? l.aq : l.q;
        const v = k in sv.rq ? sv.rq[k] : ordered;
        return `<div class="rline">
          <div class="lmain"><span class="item">${esc(l.it)}</span><span class="sub">Ordered ${esc(ordered)} ${esc(l.uom)} · ${esc(l.o)}</span></div>
          <label class="qty">Recd <input type="number" inputmode="decimal" min="0" step="any" data-rq="${esc(k)}" value="${esc(v)}" aria-label="Received quantity of ${esc(l.it)}"></label>
        </div>`;
      }).join('')}
      <div class="formfoot storeact" style="margin:8px 0 0"><span></span><button class="btn primary" data-recv="${esc(g.po)}">Save received</button></div>
    </article>`;
  }).join('');
}

function invoiceHtml() {
  const groups = toInvoice();
  if (!groups.length) return '<p class="empty">No invoice pending. A PO shows here once its material is received.</p>';
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return groups.map((g) => {
    const open = sv.inv && sv.inv.po === g.po;
    const f = open ? sv.inv : null;
    return `<article class="card">
      <div class="top"><h3>PO ${esc(g.po)}</h3>${g.amt ? `<span class="amt">${inr(g.amt)}</span>` : ''}</div>
      <div class="sub">${esc(g.ven || 'Vendor not given')} · ${fmtDate(g.d)} · ${g.lines.length} line${g.lines.length > 1 ? 's' : ''} received${g.pol ? ` · <a href="${esc(g.pol)}" target="_blank" rel="noopener">View PO</a>` : ''}</div>
      <div class="items">${g.lines.map((l) => esc(l.it) + ' (' + esc(l.rcv) + ' ' + esc(l.uom) + ')').join(', ')}</div>
      ${open ? `<form class="grid2" id="invForm" data-po="${esc(g.po)}">
        <label class="field full">Invoice photo or PDF<input name="file" type="file" accept="image/*,application/pdf" required></label>
        <p class="field full aihint" id="invAi">${f.ai ? esc(f.ai) : '✨ Choose the invoice first – AI will fill the number, date and total for you.'}</p>
        <label class="field">Invoice number<input name="no" maxlength="40" required value="${esc(f.no || '')}"></label>
        <label class="field">Invoice date<input name="date" type="date" max="${today}" required value="${esc(f.date || today)}"></label>
        <label class="field">Invoice total (₹)<input name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${esc(f.amount ?? (g.amt || ''))}"></label>
        <div class="formfoot field full storeact"><button type="button" class="btn ghost" data-invcancel>Cancel</button><button type="submit" class="btn primary">Upload invoice</button></div>
      </form>` : `<div class="formfoot storeact" style="margin:8px 0 0"><span></span><button class="btn primary" data-invopen="${esc(g.po)}">Upload invoice</button></div>`}
    </article>`;
  }).join('');
}

function statusHtml() {
  const q = sv.q.trim().toLowerCase();
  const all = (sv.data?.lines || []);
  // Invoice uploaded: vendor drop-down with only the vendors in that list
  const invVens = sv.filter === 'invoiced' ? [...new Set(all.filter((l) => statusMatch(l, 'invoiced')).map((l) => l.ven || 'Vendor not given'))].sort((a, b) => a.localeCompare(b)) : [];
  if (!invVens.includes(sv.ven)) sv.ven = '';
  const rows = all.filter((l) => statusMatch(l, sv.filter) && (!sv.ven || (l.ven || 'Vendor not given') === sv.ven) && (!q || [l.it, l.o, l.po || '', l.cat, l.ven || ''].join(' ').toLowerCase().includes(q)));
  const chips = STATUS_FILTERS.map(([k, label]) => {
    const m = all.filter((l) => statusMatch(l, k));
    const n = k === 'invoiced' ? new Set(m.map((l) => l.po.toUpperCase())).size : m.length;
    return `<button class="chip ${sv.filter === k ? 'on' : ''}" data-sfilter="${k}">${label} ${n}</button>`;
  }).join('');
  const list = sv.filter === 'po' || sv.filter === 'invoiced' ? poListHtml(rows, sv.filter === 'invoiced') : rows.slice(0, sv.show).map((l) => {
    const [label, cls] = lineStatus(l);
    const qty = l.aq !== '' && l.aq != null && l.s === 'Approved' && Number(l.aq) !== Number(l.q) ? `${esc(l.q)} → ${esc(l.aq)}` : esc(l.q);
    return `<div class="po dec">
      <div class="top"><b>${esc(l.it)}</b><span class="st ${cls}">${esc(label)}</span></div>
      <div class="sub">${qty} ${esc(l.uom)} · ${esc(l.cat)} · ${esc(l.at)} · ${esc(l.o)}${l.po ? ' · PO ' + esc(l.po) : ''}${l.pic ? ` · <a href="${esc(l.pic)}" target="_blank" rel="noopener">photo</a>` : ''}</div>
      ${l.rm ? `<div class="remark">Reason: ${esc(l.rm)}${l.ap ? ' (' + esc(l.ap) + ')' : ''}</div>` : ''}
    </div>`;
  }).join('');
  return `<input id="sSearch" class="field" type="search" placeholder="Search item, order no or PO" value="${esc(sv.q)}" aria-label="Search" style="width:100%;margin:2px 0 8px;font:inherit;padding:8px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--ink)">
    <div class="chips">${chips}</div>
    ${sv.filter === 'invoiced' ? `<select id="sVen" aria-label="Vendor" style="width:100%;margin:0 0 8px">${['', ...invVens].map((v) => `<option value="${esc(v)}"${v === sv.ven ? ' selected' : ''}>${v ? esc(v) : 'All vendors'}</option>`).join('')}</select>` : ''}
    ${rows.length ? list : '<p class="empty">No lines.</p>'}
    ${rows.length > sv.show && sv.filter !== 'po' && sv.filter !== 'invoiced' ? `<button class="btn sm more" id="sMore">Show more (${rows.length - sv.show} left)</button>` : ''}`;
}

/** Drive "view" link -> direct download link (other links are returned as they are). */
function dlLink(u) {
  const m = String(u || '').match(/\/d\/([\w-]{20,})|[?&]id=([\w-]{20,})/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1] || m[2]}` : u;
}
const fileLinks = (u, what, name) => u ? `<button type="button" class="btn sm" data-fdl="${esc(u)}" data-fname="${esc(name || what)}">Download ${what}</button><button type="button" class="btn sm" data-fshare="${esc(u)}" data-fname="${esc(name || what)}">Share ${what}</button>` : `<span class="sub">${what} file not found</span>`;

/** My requests → PO raised / Invoice uploaded: one card per PO. */
function poListHtml(rows, invoiced) {
  const map = new Map();
  rows.forEach((l) => {
    const k = l.po.toUpperCase();
    if (!map.has(k)) map.set(k, { po: l.po, pol: l.pol, ivi: l.ivi, ven: l.ven, amt: l.amt, d: l.d, lines: [] });
    map.get(k).lines.push(l);
  });
  const groups = [...map.values()].sort((a, b) => b.d.localeCompare(a.d));   // newest first
  return groups.map((g) => {
    const iv = g.ivi;
    return `<article class="card">
      <div class="top"><h3>PO ${esc(g.po)}</h3>${g.amt ? `<span class="amt">${inr(g.amt)}</span>` : ''}</div>
      <div class="sub"><b>${esc(g.ven || 'Vendor not given')}</b> · ${fmtDate(g.d)} · ${g.lines.length} item${g.lines.length > 1 ? 's' : ''}</div>
      ${invoiced ? `<div class="sub">Invoice ${iv ? `<b>${esc(iv.n)}</b> · dated ${iv.d ? fmtDate(iv.d) : '-'} · ${iv.a ? inr(iv.a) : '-'}${iv.t ? ' · uploaded ' + fmtDate(iv.t) : ''}` : 'details not found'}</div>` : ''}
      <div class="items">${g.lines.map((l) => {
        const ord = l.aq !== '' && l.aq != null ? l.aq : l.q;
        return esc(l.it) + ' (' + (invoiced ? 'recd ' + esc(l.rcv) : esc(ord)) + ' ' + esc(l.uom) + ')';
      }).join(', ')}</div>
      <div class="filelinks">${fileLinks(g.pol, 'PO', 'PO ' + g.po)}${invoiced ? fileLinks(iv && iv.l, 'invoice', 'Invoice ' + g.po) : ''}</div>
    </article>`;
  }).join('');
}

// ---- files: photos are made smaller on the phone before upload ----
function readAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
}
async function shrinkImage(file, maxSide, quality) {
  const url = await readAsDataUrl(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That photo could not be opened. Try a JPG or PNG.')); i.src = url; });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const out = c.toDataURL('image/jpeg', quality);
  return { type: 'image/jpeg', data: out.split(',')[1], preview: out, name: file.name };
}
async function fileForUpload(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 8 * 1024 * 1024) throw new Error('The PDF is too big (max 8 MB).');
    const url = await readAsDataUrl(file);
    return { type: 'application/pdf', data: url.split(',')[1], name: file.name };
  }
  if (!/^image\//.test(file.type)) throw new Error('Choose a photo or a PDF.');
  return shrinkImage(file, 2000, 0.8);
}

// ---- actions ----
const noPreview = () => { if (readOnly()) { toast('This is a preview, so nothing can be submitted.', true); return false; } return true; };

function submitRequest() {
  if (!noPreview()) return;
  const meta = sv.base;
  for (const [i, l] of sv.draft.entries()) {
    const n = `Item ${i + 1}: `;
    if (!l.item.trim()) return toast(n + 'enter the item name.', true);
    if (!meta.categories.includes(l.cat)) return toast(n + 'choose the category.', true);
    if (!(Number(l.qty) > 0)) return toast(n + 'enter the quantity needed.', true);
    if (!l.uom) return toast(n + 'choose the unit (Pcs, Kg…).', true);
    if (l.stock === '' || Number(l.stock) < 0) return toast(n + 'enter the stock in hand (0 if none).', true);
  }
  const unit = sv.unit, draft = sv.draft;
  const lines = draft.map((l) => ({ item: l.item.trim(), category: l.cat, qty: Number(l.qty), uom: l.uom, stock: l.stock, photo: l.photo ? { type: l.photo.type, data: l.photo.data } : null }));
  // at once: clear the form and say it is on its way; the order numbers fill in when the server answers
  sv.done = { unit, lines: draft.map(() => ({ orderNo: '…' })), sending: true }; sv.draft = [blankLine()]; sv.formUnit = '';
  renderStore(true); window.scrollTo(0, 0);
  const sid = beginSave();
  api('storeRaise', { unit, lines })
    .then((r) => { sv.done = r; toast(`Request sent: ${r.raised} item${r.raised > 1 ? 's' : ''}.`); return loadStore(false, state.gen); })
    .catch((e) => { sv.done = null; sv.draft = draft; sv.formUnit = ''; handleError(e); })
    .finally(() => { endSave(sid); if (sv.view === 'raise' && sv.unit === unit) { sv.formUnit = ''; renderStore(true); } else renderStore(); });
}

function saveReceived(po) {
  if (!noPreview()) return;
  const g = toReceive().find((x) => x.po === po);
  if (!g) return;
  const items = [];
  for (const l of g.lines) {
    const k = l.row + '|' + l.o;
    const input = document.querySelector(`[data-rq="${CSS.escape(k)}"]`);
    const v = input ? input.value.trim() : '';
    if (v === '') continue;
    const n = Number(v);
    if (!(n > 0)) return toast(`Enter a quantity above 0 for ${l.it}, or clear the box.`, true);
    items.push({ row: l.row, orderNo: l.o, qty: n, it: l.it, ordered: l.aq !== '' && l.aq != null ? Number(l.aq) : Number(l.q) });
  }
  if (!items.length) return toast('Enter the received quantity for at least one item.', true);
  const over = items.filter((i) => i.qty > i.ordered);
  if (over.length && !confirm(`More than ordered for: ${over.map((i) => i.it).join(', ')}. Save anyway?`)) return;
  // at once: those lines move from "Receive" to "Invoice"; put back if the server says no
  const byRow = {}; items.forEach((i) => (byRow[i.row] = i.qty));
  const lines = (sv.data?.lines || []).filter((l) => l.row in byRow);
  lines.forEach((l) => { l.rcv = byRow[l.row]; if (l.inv === '') l.inv = 'pending'; delete sv.rq[l.row + '|' + l.o]; });
  renderStore(true);
  const sid = beginSave();
  api('storeReceive', { items: items.map(({ row, orderNo, qty }) => ({ row, orderNo, qty })) })
    .then((r) => { toast(`${r.received} item${r.received === 1 ? '' : 's'} marked received for PO ${po}.` + skippedText(r.skipped), r.skipped.length > 0); return loadStore(false, state.gen); })
    .catch((e) => { lines.forEach((l) => { l.rcv = ''; l.inv = ''; }); handleError(e); })
    .finally(() => { endSave(sid); renderStore(true); });
}

// AI: when the invoice is chosen, Gemini (on the server) reads the number, date and total and fills the form.
// The storekeeper checks the values and can change any of them before uploading.
async function aiReadInvoice(form, file, getSt = () => sv.inv) {
  const hint = form.querySelector('.aihint'), po = form.dataset.po;
  const cur = () => { const st = getSt(); return st && st.po === po ? st : null; };
  const say = (msg) => { if (hint) hint.textContent = msg; if (cur()) cur().ai = msg; };
  let f;
  try { f = await fileForUpload(file); } catch (e) { return say(e.message); }
  say('✨ Reading the invoice with AI…');
  form.classList.add('aibusy');
  try {
    const r = await api('readInvoice', { file: { type: f.type, data: f.data } });
    const st = cur();
    if (!form.isConnected || !st) return;
    const got = [];
    if (r.invoiceNo) { form.no.value = r.invoiceNo; st.no = r.invoiceNo; got.push('number'); }
    if (r.date) { form.date.value = r.date; st.date = r.date; got.push('date'); }
    if (r.amount > 0) { form.amount.value = r.amount; st.amount = r.amount; got.push('total'); }
    say(got.length ? `✨ AI filled the invoice ${got.join(', ')}. Please check before uploading.` : '✨ AI could not read the details. Please type them.');
  } catch (e) {
    say('✨ ' + ((e && e.message) || 'AI could not read this invoice.').replace(/^✨ /, ''));
  } finally { form.classList.remove('aibusy'); }
}

async function uploadInvoice(form) {
  if (!noPreview()) return;
  const po = form.dataset.po;
  const no = form.no.value.trim(), date = form.date.value, amount = form.amount.value, file = form.file.files[0];
  if (!no) return toast('Enter the invoice number.', true);
  if (!date) return toast('Enter the invoice date.', true);
  if (!(Number(amount) > 0)) return toast('Enter the invoice total.', true);
  if (!file) return toast('Choose the invoice photo or PDF.', true);
  run('storeInvoice', async () => {
    let f;
    try { f = await fileForUpload(file); } catch (e) { return toast(e.message, true); }
    toast('Uploading invoice…');
    await api('storeInvoice', { po, invoiceNo: no, date, amount: Number(amount), file: { type: f.type, data: f.data } });
    sv.inv = null;
    toast(`Invoice uploaded for PO ${po}.`);
    await loadStore(false, state.gen);
    renderStore(true);
  });
}

// ---- Reports inside the Store tab: the same reports, for the unit chosen at the top only ----
// Same unit words as UNIT_MAP in the server, so a store unit name finds its report unit name.
const REP_UNIT_WORDS = [['DIRANG', ['dirang']], ['Green', ['green']], ['Bougainvillea', ['bougainvillea']], ['Enigma', ['enigma']], ['Grace', ['grace']],
  ['Hermon', ['hermon']], ['Mall Stone', ['mallstone', 'mall']], ['Montana', ['montana']], ['Oakdene', ['oakden']], ['POSHTEL', ['poshtel']], ['Swiss', ['swiss']],
  ['West Gate', ['westgate', 'west']], ['Grand', ['grand']], ['Namnang', ['namnang']], ['Norling', ['norling']], ['North Star', ['northstar']],
  ['Signature', ['signature']], ['Ttakshang', ['ttakshang']], ['Calangute', ['calangute']], ['Le Royale', ['royale']], ['Barsana', ['barsana']],
  ['Samthar', ['samthar']], ['Sherpa', ['sherpa']], ['Gangchen', ['gangchen']], ['Khangri', ['khangri']], ['Panghen', ['panghen']], ['Newa', ['newa']],
  ['Tashi Ghang', ['tashi']], ['Head Office', ['headoffice', 'head']], ['Singalila', ['singalila']], ['Ganges', ['ganges']], ['Jungle', ['jungle']], ['SALASAR', ['salasar']]];
const repUnitOf = (raw) => { const n = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, ''); const m = REP_UNIT_WORDS.find(([, w]) => w.some((k) => n.includes(k))); return m ? m[0] : String(raw || '').trim(); };
const inStoreReports = () => $('viewReports').parentElement === $('storeRepSlot');
function lockStoreUnit(f) { if (inStoreReports()) { f.cluster = ''; f.unit = repUnitOf(state.store.unit); } }
function mountStoreReports() {
  const v = $('viewReports');
  if (!inStoreReports()) $('storeRepSlot').appendChild(v);
  v.classList.add('instore'); v.hidden = false;
}
function unmountStoreReports() {
  const v = $('viewReports');
  if (!inStoreReports()) return;
  $('viewStore').after(v);   // back to its own place
  v.classList.remove('instore'); v.hidden = state.tab !== 'reports';
  [state.rep, state.df, state.gsf].forEach((f) => { f.cluster = ''; f.unit = ''; });
}

// ---- wiring (store) ----
$('storeBody').addEventListener('change', (e) => { if (e.target.id === 'sVen') { sv.ven = e.target.value; renderStore(true); } });
$('storeUnit').onchange = (e) => changeStoreUnit(e.target.value);
document.querySelectorAll('[data-stype]').forEach((b) => (b.onclick = () => {
  sv.view = b.dataset.stype; if (sv.view !== 'raise') sv.done = null; renderStore(true);
  if (sv.view === 'reports') { if (!state.reports || (state.rep.type === 'dec' && !state.dec) || (state.rep.type === 'gs' && !state.goods)) refresh(); return; }
  if (!sv.data && sv.view !== 'raise') loadStore(false, state.gen).then(() => renderStore(true)).catch(handleError);
}));
$('storeBody').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.f) {
    const l = sv.draft[+t.dataset.i]; l[t.dataset.f] = t.value;
    if (t.dataset.f === 'item') {   // picked a past item: fill its category and unit
      const hit = (sv.meta[sv.unit]?.items || []).find((x) => x[0].toLowerCase() === t.value.trim().toLowerCase());
      if (hit) {
        const card = t.closest('.card');
        if (!l.cat && hit[1]) { l.cat = hit[1]; const s = card.querySelector('[data-f="cat"]'); if (s) s.value = hit[1]; }
        if (!l.uom && hit[2]) { l.uom = hit[2]; const s = card.querySelector('[data-f="uom"]'); if (s) s.value = hit[2]; }
      }
    }
  } else if (t.dataset.rq) sv.rq[t.dataset.rq] = t.value;
  else if (t.id === 'sSearch') { sv.q = t.value; sv.show = 150; const pos = t.selectionStart; renderStore(true); const n = $('sSearch'); n.focus(); n.setSelectionRange(pos, pos); }
  else if (t.form && t.form.id === 'invForm' && sv.inv && t.name !== 'file') sv.inv[t.name] = t.value;
});
$('storeBody').addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.f) sv.draft[+t.dataset.i][t.dataset.f] = t.value;
  if (t.name === 'file' && t.form && t.form.id === 'invForm' && t.files[0]) return aiReadInvoice(t.form, t.files[0]);
  if (t.dataset.photo !== undefined && t.files[0]) {
    try { sv.draft[+t.dataset.photo].photo = await shrinkImage(t.files[0], 1280, 0.75); } catch (err) { return toast(err.message, true); }
    sv.formUnit = ''; renderStore(true);
  }
});
$('storeBody').addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'raiseForm') submitRequest();
  else if (e.target.id === 'invForm') uploadInvoice(e.target);
});
$('storeBody').addEventListener('click', (e) => {
  const t = e.target;
  if (t.id === 'addLine') { sv.draft.push(blankLine()); sv.formUnit = ''; renderStore(true); return; }
  if (t.dataset.rmline !== undefined) { sv.draft.splice(+t.dataset.rmline, 1); sv.formUnit = ''; renderStore(true); return; }
  if (t.dataset.rmphoto !== undefined) { sv.draft[+t.dataset.rmphoto].photo = null; sv.formUnit = ''; renderStore(true); return; }
  if (t.dataset.recv) return saveReceived(t.dataset.recv);
  if (t.dataset.invopen) { sv.inv = { po: t.dataset.invopen }; renderStore(true); return; }
  if (t.dataset.invcancel !== undefined) { sv.inv = null; renderStore(true); return; }
  if (t.dataset.sfilter) { sv.filter = t.dataset.sfilter; sv.ven = ''; sv.show = 150; renderStore(true); return; }
  if (t.id === 'sMore') { sv.show += 300; renderStore(true); }
});

// ---------- HO: make PO ----------
// Same steps as the sheet's P.O tab: choose the hotel, tick approved lines that have no PO yet, give price and tax %,
// choose the vendor, delivery days and payment terms, and make the PO. The server writes P.Os and saves the PDF.
const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const poKey = (l) => l.row + '|' + l.o;
const lineTotal = (l, pr) => Math.round((Number(l.q) || 0) * (Number(pr?.price) || 0) * (1 + (Number(pr?.tax) || 0) / 100) * 10) / 10;

function poUnits() {
  const c = {};
  (state.po?.lines || []).forEach((l) => (c[l.u] = (c[l.u] || 0) + 1));
  return Object.keys(c).sort().map((u) => [u, c[u]]);
}

function renderPO(force) {
  if (!state.me?.user.isHO) return;
  const body = $('poBody');
  if (!force && body.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;   // typing
  if (!state.po) { body.innerHTML = '<p class="empty">Loading… this can take a few seconds.</p>'; return; }
  const units = poUnits();
  if (!units.some(([u]) => u === state.poUnit)) state.poUnit = units[0]?.[0] || '';
  $('poUnit').innerHTML = units.map(([u, n]) => `<option value="${esc(u)}">${esc(u)} (${n})</option>`).join('') || '<option value="">No hotel waiting</option>';
  $('poUnit').value = state.poUnit;
  $('poAsOf').textContent = 'as of ' + state.po.asOf;
  const done = state.poDone?.making ? `<div class="done-msg">Making PO for ${esc(state.poDone.unit)} · ${esc(state.poDone.vendor)} · ${state.poDone.lines} line${state.poDone.lines > 1 ? 's' : ''} · ${money(state.poDone.total)}… You can start the next PO.</div>`
    : state.poDone ? `<div class="done-msg">PO <b>${esc(state.poDone.poNo)}</b> made for ${esc(state.poDone.unit)} · ${esc(state.poDone.vendor)} ·
    ${state.poDone.lines} line${state.poDone.lines > 1 ? 's' : ''} · ${money(state.poDone.total)}.
    <a href="${esc(state.poDone.link)}" target="_blank" rel="noopener">Open the PO (PDF)</a>. It is in FMS (PO no, amount, vendor) and in the hotel's “Receive” list.
    ${state.poDone.link ? `<div class="filelinks" style="margin-top:8px"><button type="button" class="btn sm primary" data-fshare="${esc(state.poDone.link)}" data-fname="PO ${esc(state.poDone.poNo)}">Share PO (WhatsApp, email…)</button><button type="button" class="btn sm" data-fdl="${esc(state.poDone.link)}" data-fname="PO ${esc(state.poDone.poNo)}">Download PO</button></div>` : ''}</div>` : '';
  const lines = (state.po.lines || []).filter((l) => l.u === state.poUnit);
  if (!lines.length) { body.innerHTML = done + '<p class="empty">No approved lines waiting for a PO.</p>'; return; }
  [...state.poSel].forEach((k) => { if (!lines.some((l) => poKey(l) === k)) state.poSel.delete(k); });
  const sel = lines.filter((l) => state.poSel.has(poKey(l)));
  const total = sel.reduce((a, l) => a + lineTotal(l, state.poPrice[poKey(l)]), 0);
  const f = state.poForm, ro = readOnly();
  const vendorOpts = (state.vendors || []).map((v) => `<option value="${esc(v[0])}">`).join('');
  const hl = (state.hotels && state.hotels.length) ? state.hotels : poUnits().map(([u]) => [u, u, '']);
  const nz = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const defH = hl.find((h) => nz(h[0]) === nz(state.poUnit) || nz(h[1]) === nz(state.poUnit)) || hl.find((h) => nz(h[0]) && nz(state.poUnit).indexOf(nz(h[0])) === 0);
  const defKey = defH ? defH[0] : state.poUnit;
  if (!f.shipTo) f.shipTo = defKey;
  if (!f.billTo) f.billTo = defKey;
  const hOpts = (cur) => hl.map((h) => `<option value="${esc(h[0])}"${cur === h[0] ? ' selected' : ''}>${esc(h[1])}${h[2] ? ' (GST ' + esc(h[2]) + ')' : ''}</option>`).join('') + (hl.some((h) => h[0] === cur) ? '' : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
  const shipToOpts = hOpts(f.shipTo), billToOpts = hOpts(f.billTo);
  const terms = (state.po.terms || []).map((t) => `<option ${t === f.terms ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const priceRow = (l) => {
    const k = poKey(l), pr = state.poPrice[k] || {};
    return `<div class="poline">
      <button type="button" class="linkbtn" data-pounsel="${esc(k)}" title="Take out of this PO" aria-label="Take ${esc(l.it)} out of this PO">✕</button>
      <div class="lmain"><input class="item" data-pn="${esc(k)}" value="${esc(pr.name ?? l.it)}" maxlength="200" aria-label="Item name" title="Item name on the PO - you can change it" style="width:100%;font-weight:600;border:1px solid #ccc;border-radius:6px;padding:4px 6px"><span class="sub">${esc(l.q)} ${esc(l.uom)} · ${esc(l.o)}</span></div>
      <div class="price"><label>Price ₹ <input type="number" inputmode="decimal" min="0" step="any" data-pp="${esc(k)}" value="${esc(pr.price ?? '')}" aria-label="Price of ${esc(l.it)}"></label>
        <label>Tax % <input class="tax" type="number" inputmode="decimal" min="0" max="100" step="any" data-pt="${esc(k)}" value="${esc(pr.tax ?? '')}" aria-label="Tax % of ${esc(l.it)}"></label>
        <span>Total <b data-ptot="${esc(k)}">${money(lineTotal(l, pr))}</b></span></div>
    </div>`;
  };
  // The PO being made comes FIRST (prices, vendor, Make PO); the hotel's other waiting lines are below to tick.
  const details = sel.length ? `<article class="card">
      <h3>New PO · ${esc(state.poUnit)}</h3>
      ${sel.map(priceRow).join('')}
      <div class="grid2">
        ${f.newVendor ? `<label class="field full">New vendor name<input data-pf="nvName" maxlength="80" value="${esc(f.newVendor.name || '')}"></label>
          <label class="field full">Vendor address<input data-pf="nvAddress" maxlength="200" value="${esc(f.newVendor.address || '')}"></label>
          <label class="field">Vendor phone<input data-pf="nvPhone" inputmode="tel" maxlength="20" value="${esc(f.newVendor.phone || '')}"></label>
          <div class="field"><span>&nbsp;</span><button type="button" class="linkbtn" id="poPickVendor">Pick an existing vendor instead</button></div>`
        : `<label class="field full">Vendor<input data-pf="vendor" list="poVendors" value="${esc(f.vendor)}" placeholder="Type to search ${(state.vendors || []).length} vendors"><datalist id="poVendors">${vendorOpts}</datalist></label>
          <div class="field full"><button type="button" class="linkbtn" id="poNewVendor">+ Vendor not in the list? Add a new vendor</button></div>`}
        <label class="field full">Ship To (delivery unit)<select data-pf="shipTo">${shipToOpts}</select></label>
        <label class="field full">Bill To (invoice in this unit's name &amp; GST)<select data-pf="billTo">${billToOpts}</select></label>
        <label class="field">Delivery days<input data-pf="days" type="number" inputmode="numeric" min="0" max="365" value="${esc(f.days)}"></label>
        <label class="field">Payment terms<select data-pf="terms"><option value="">Not now</option>${terms}</select></label>
        <label class="field full">Comments on the PO (optional)<input data-pf="note" maxlength="300" value="${esc(f.note)}"></label>
      </div>
      <label class="field full">Discount (Rs.)<input type="number" inputmode="decimal" min="0" step="0.01" data-pf="discountAmt" value="${f.discountAmt || ''}" placeholder="0"></label>
      <div class="pototal"><span>${sel.length} line${sel.length > 1 ? 's' : ''} · Sub total</span><b id="poSub">${money(total)}</b></div>
      <div class="pototal"><span>Less: Discount</span><b id="poDisc">${money(Number(f.discountAmt) || 0)}</b></div>
      <div class="pototal"><span>Grand total</span><b id="poTotal">${money(Math.round((total - (Number(f.discountAmt) || 0)) * 100) / 100)}</b></div>
      ${ro ? '' : `<button class="btn primary" id="poMake" style="width:100%">Make PO</button>`}
    </article>` : '';
  body.innerHTML = done + details + `<p class="sub">${sel.length ? 'Tick more lines of this hotel to add them to the PO.' : 'Tick the approved lines to put in one PO. Price, vendor and the Make PO button then show here at the top.'}</p>
    <article class="card">
      <label class="ghead" style="margin:-12px -12px 0;border-radius:12px 12px 0 0"><input type="checkbox" id="poAll" ${sel.length === lines.length ? 'checked' : ''}>
        <span><b>${esc(state.poUnit)}</b> <span class="sub">${lines.length} approved line${lines.length > 1 ? 's' : ''} without PO${sel.length ? ' · ' + sel.length + ' ticked' : ''}</span></span></label>
      ${lines.map((l) => {
        const k = poKey(l), on = state.poSel.has(k);
        return `<label class="poline" style="cursor:pointer">
          <input type="checkbox" data-pok="${esc(k)}" ${on ? 'checked' : ''}>
          <span class="lmain"><span class="item">${esc(l.it)}</span>
            <span class="sub">${esc(l.q)} ${esc(l.uom)} · ${esc(l.cat)} · approved by ${esc(l.ap)} · ${esc(l.at)} · ${esc(l.o)}${l.pt ? ' · ' + esc(l.pt) : ''}</span></span>
        </label>`;
      }).join('')}
    </article>`;
}

function updatePOTotals() {
  const lines = (state.po?.lines || []).filter((l) => l.u === state.poUnit && state.poSel.has(poKey(l)));
  let total = 0;
  lines.forEach((l) => { const t = lineTotal(l, state.poPrice[poKey(l)]); total += t; const el = document.querySelector(`[data-ptot="${CSS.escape(poKey(l))}"]`); if (el) el.textContent = money(t); });
  const disc = Number(state.poForm.discountAmt) || 0;
  if ($('poSub')) $('poSub').textContent = money(total);
  if ($('poDisc')) $('poDisc').textContent = money(disc);
  if ($('poTotal')) $('poTotal').textContent = money(Math.round((total - disc) * 100) / 100);
}

function makePO() {
  if (!noPreview()) return;
  const lines = (state.po?.lines || []).filter((l) => l.u === state.poUnit && state.poSel.has(poKey(l)));
  const f = state.poForm;
  if (!lines.length) return toast('Tick at least one line.', true);
  for (const l of lines) {
    const pr = state.poPrice[poKey(l)] || {};
    if (pr.price === undefined || pr.price === '' || !(Number(pr.price) >= 0)) return toast(`Enter the price for ${l.it}.`, true);
    if (pr.tax !== undefined && pr.tax !== '' && !(Number(pr.tax) >= 0 && Number(pr.tax) <= 100)) return toast(`Tax % for ${l.it} must be 0 to 100.`, true);
  }
  let vendor = '', newVendor = null;
  if (f.newVendor) {
    if (!String(f.newVendor.name || '').trim()) return toast('Enter the new vendor name.', true);
    newVendor = f.newVendor;
  } else {
    vendor = String(f.vendor || '').trim();
    if (!(state.vendors || []).some((v) => v[0] === vendor)) return toast('Choose the vendor from the list (or add a new vendor).', true);
  }
  if (!(Number(f.days) >= 0)) return toast('Enter the delivery days.', true);
  const total = lines.reduce((a, l) => a + lineTotal(l, state.poPrice[poKey(l)]), 0);
  if (!confirm(`Make PO for ${state.poUnit}: ${lines.length} line${lines.length > 1 ? 's' : ''}, ${vendor || newVendor.name}, total ${money(total)}?`)) return;
  const payload = {
    items: lines.map((l) => ({ row: l.row, orderNo: l.o, name: ((state.poPrice[poKey(l)] || {}).name || '').trim() || l.it, price: Number(state.poPrice[poKey(l)].price), tax: state.poPrice[poKey(l)].tax === '' || state.poPrice[poKey(l)].tax == null ? 0 : Number(state.poPrice[poKey(l)].tax) })),
    vendor, newVendor, days: Number(f.days), terms: f.terms, note: f.note, discountAmt: Number(f.discountAmt) || 0, billTo: f.billTo || state.poUnit, shipTo: f.shipTo || state.poUnit,
  };
  // at once: the lines leave the list and the form clears, so the next PO can be started; the PO number and
  // PDF link show when the server has made it (a few seconds). Everything is put back if it fails.
  const keep = { prices: { ...state.poPrice }, form: { ...f }, sel: new Set(state.poSel) };
  const unit = state.poUnit;
  state.poDone = { poNo: '…', unit, vendor: vendor || newVendor.name, lines: lines.length, total, making: true };
  lines.forEach((l) => { state.poSel.delete(poKey(l)); delete state.poPrice[poKey(l)]; });
  state.po.lines = state.po.lines.filter((l) => !lines.includes(l));
  state.poForm = { vendor: '', days: 25, terms: '', note: '', discountAmt: 0, billTo: '', shipTo: '', newVendor: null };
  renderPO(true); window.scrollTo(0, 0);
  const sid = beginSave();
  api('makePO', payload)
    .then((r) => { state.poDone = r; if (newVendor) state.vendors = null; toast(`PO ${r.poNo} made.`); })
    .catch((e) => {
      state.po.lines = lines.concat(state.po.lines); state.poPrice = keep.prices; state.poForm = keep.form; state.poSel = keep.sel; state.poDone = null; state.poUnit = unit;
      handleError(e);
    })
    .finally(() => { endSave(sid); renderPO(true); if (!saving()) refresh(); });
}

$('poUnit').onchange = (e) => { state.poUnit = e.target.value; state.poDone = null; state.poForm.shipTo = ''; state.poForm.billTo = ''; renderPO(true); };
$('poBody').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'poAll') {
    (state.po?.lines || []).filter((l) => l.u === state.poUnit).forEach((l) => (t.checked ? state.poSel.add(poKey(l)) : state.poSel.delete(poKey(l))));
    return renderPO(true);
  }
  if (t.dataset.pok) { t.checked ? state.poSel.add(t.dataset.pok) : state.poSel.delete(t.dataset.pok); return renderPO(true); }
  if (t.dataset.pf === 'terms' || t.dataset.pf === 'billTo' || t.dataset.pf === 'shipTo') state.poForm[t.dataset.pf] = t.value;
});
$('poBody').addEventListener('input', (e) => {
  const t = e.target, f = state.poForm;
  if (t.dataset.pn) { (state.poPrice[t.dataset.pn] = state.poPrice[t.dataset.pn] || {}).name = t.value; return; }
  if (t.dataset.pp) { (state.poPrice[t.dataset.pp] = state.poPrice[t.dataset.pp] || {}).price = t.value; return updatePOTotals(); }
  if (t.dataset.pt) { (state.poPrice[t.dataset.pt] = state.poPrice[t.dataset.pt] || {}).tax = t.value; return updatePOTotals(); }
  const k = t.dataset.pf;
  if (k === 'vendor' || k === 'days' || k === 'note' || k === 'discountAmt' || k === 'billTo' || k === 'shipTo') { f[k] = t.value; if (k === 'discountAmt') updatePOTotals(); }
  else if (k === 'nvName') f.newVendor.name = t.value;
  else if (k === 'nvAddress') f.newVendor.address = t.value;
  else if (k === 'nvPhone') f.newVendor.phone = t.value;
});
$('poBody').addEventListener('click', (e) => {
  const t = e.target;
  if (t.id === 'poMake') return makePO();
  if (t.id === 'poNewVendor') { state.poForm.newVendor = { name: state.poForm.vendor || '', address: '', phone: '' }; return renderPO(true); }
  if (t.id === 'poPickVendor') { state.poForm.newVendor = null; return renderPO(true); }
  if (t.dataset.pounsel) { state.poSel.delete(t.dataset.pounsel); return renderPO(true); }
});

// ---------- wiring ----------
$('tabAssign').onclick = () => setTab('assign');
$('tabApprove').onclick = () => setTab('approve');
$('tabReports').onclick = () => setTab('reports');
$('tabStore').onclick = () => setTab('store');
$('tabPO').onclick = () => setTab('po');
$('tabGoods').onclick = () => setTab('goods');
$('tabHoInv').onclick = () => setTab('hoinv');
$('tabHoNr').onclick = () => setTab('honr');
$('tabRates').onclick = () => setTab('rates');
setupGoodsEvents();
setupHoInvEvents();
setupHoNrEvents();
setupRatesEvents();
[['dApprover', 'approver'], ['dStatus', 'status'], ['dCluster', 'cluster'], ['dUnit', 'unit'], ['dMonth', 'month']].forEach(([id, k]) =>
  ($(id).onchange = (e) => { state.df[k] = e.target.value; if (k === 'cluster') state.df.unit = ''; state.decShow = 200; renderDecisions(); }));
$('dSearch').oninput = (e) => { state.df.q = e.target.value; state.decShow = 200; renderDecisions(); };
$('dClear').onclick = () => { Object.assign(state.df, { approver: '', status: '', cluster: '', unit: '', month: '', q: '' }); state.decShow = 200; renderDecisions(); };
document.querySelectorAll('[data-dview]').forEach((b) => (b.onclick = () => { state.df.view = b.dataset.dview; renderDecisions(); }));
$('viewAsPick').onchange = (e) => changeViewAs(e.target.value);
document.querySelectorAll('[data-rtype]').forEach((b) => (b.onclick = () => {
  state.rep.type = b.dataset.rtype; state.rep.unit = ''; renderReports();
  if ((b.dataset.rtype === 'dec' && !state.dec) || (b.dataset.rtype === 'gs' && !state.goods)) refresh();
}));
document.querySelectorAll('[data-rview]').forEach((b) => (b.onclick = () => { state.rep.view = b.dataset.rview; renderReports(); }));
[['fCluster', 'cluster'], ['fUnit', 'unit'], ['fVendor', 'vendor'], ['fMonth', 'month'], ['fAge', 'age'], ['fSort', 'sort']].forEach(([id, k]) =>
  ($(id).onchange = (e) => { state.rep[k] = e.target.value; if (k === 'cluster') state.rep.unit = ''; renderReports(); }));
$('fSearch').oninput = (e) => { state.rep.q = e.target.value; renderReports(); };
$('btnClear').onclick = () => { Object.assign(state.rep, { cluster: '', unit: '', vendor: '', month: '', age: '', q: '' }); renderReports(); };
$('btnRefresh').onclick = () => { toast('Reading the latest from the sheet…'); run('refresh', () => refresh(true)); if (state.tab === 'honr') loadHoNr(true); };
$('btnSignOut').onclick = signOut;
$('btnAssign').onclick = assignSelected;
$('aUnit').onchange = (e) => { state.aUnit = e.target.value; render(); };
$('aAll').onchange = (e) => {   // select / unselect every line shown under "Needs an approver"
  (state.ho?.unassigned || []).filter((l) => !state.aUnit || l.unit === state.aUnit).forEach((l) => (e.target.checked ? state.sel.add(key(l)) : state.sel.delete(key(l))));
  render();
};
$('aPdf').onclick = () => exportRequirement('pdf');
$('aSnap').onclick = () => exportRequirement('png');
$('pUnit').onchange = (e) => {   // a new unit: lines of other units are unticked, so Approve/Reject never touches hidden lines
  state.pUnit = e.target.value;
  if (state.pUnit) [...(state.mine?.pending || []), ...(state.mine?.onHold || [])].forEach((l) => { if (l.unit !== state.pUnit) state.sel.delete(key(l)); });
  render();
};
$('pAll').onchange = (e) => { (state.mine?.pending || []).filter((l) => !state.pUnit || l.unit === state.pUnit).forEach((l) => (e.target.checked ? state.sel.add(key(l)) : state.sel.delete(key(l)))); render(); };
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
  const sh = e.target.closest('[data-share]');
  if (sh) return download(sh.dataset.share, sh.dataset.fmt, true);
  const fd = e.target.closest('[data-fdl]');
  if (fd) return driveFile(fd.dataset.fdl, fd.dataset.fname, false);
  const fs = e.target.closest('[data-fshare]');
  if (fs) return driveFile(fs.dataset.fshare, fs.dataset.fname, true);
  if (goodsClick(e)) return;
  const ds = e.target.closest('[data-dstatus]');
  if (ds) { state.df.status = state.df.status === ds.dataset.dstatus ? '' : ds.dataset.dstatus; state.decShow = 200; return renderDecisions(); }
  const dc = e.target.closest('[data-dcell-by]');
  if (dc) { Object.assign(state.df, { approver: dc.dataset.dcellBy === '(none)' ? '' : dc.dataset.dcellBy, status: dc.dataset.dcellSt, view: 'list' }); state.decShow = 200; renderDecisions(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#decMore')) { state.decShow += 300; return renderDecisions(); }
  const gs = e.target.closest('[data-gsend]');
  if (gs) return sendGroup(gs.dataset.gsend.split(','));
  const ed = e.target.closest('[data-edit]');
  if (ed) return editItem(ed.dataset.edit);
  const c = e.target.closest('[data-cell-unit]');
  if (c) { Object.assign(state.rep, { unit: c.dataset.cellUnit, month: c.dataset.cellMonth, view: 'list' }); renderReports(); window.scrollTo(0, 0); return; }
  const b = e.target.closest('[data-one]');
  if (!b) return;
  const all = [...(state.mine?.pending || []), ...(state.mine?.onHold || [])];
  const line = all.find((l) => key(l) === b.dataset.key);
  if (line) decide(b.dataset.one, [line]);
});
// Auto-update: when a new version is published, reload (unless a PO is being made).
const APP_V = (((document.querySelector('script[src*="app.js"]') || {}).src || '').split('v=')[1] || '');
function checkUpdate() {
  fetch('index.html', { cache: 'no-store' }).then((r) => r.text()).then((h) => {
    const m = h.match(/app\.js\?v=([\w.-]+)/);
    if (m && APP_V && m[1] !== APP_V && !(state.poSel && state.poSel.size)) location.reload();
  }).catch(() => {});
}
setInterval(checkUpdate, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
// Keep the list fresh while the app is open; reload when it comes back to the front.
setInterval(() => { if (document.visibilityState === 'visible' && state.me && !state.busy) refresh(); }, 20000);   // every 20 s while the app is on screen (the server answers "no change" quickly)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.me && !state.busy) refresh(); });

boot();

// Exposed for tests.
window.__nlp = { state, api };

// Locked top: keep the sticky offsets right as the header / tabs change height.
(function lockTop() {
  const root = document.documentElement.style;
  const h = (el) => (el && el.offsetParent !== null ? el.getBoundingClientRect().height : 0);
  const set = () => {
    const bar = h(document.querySelector('.bar'));
    root.setProperty('--barH', bar + 'px');
    root.setProperty('--top', (bar + h(document.getElementById('viewAsBar'))) + 'px');   // header + "View app as"
    root.setProperty('--tabsH', h(document.querySelector('.tabs')) + 'px');
    root.setProperty('--segH', (h(document.querySelector('#viewStore > .seg')) + 6) + 'px');
    root.setProperty('--pbarH', h(document.getElementById('pAllWrap')) + 'px');
    root.setProperty('--segRH', (h(document.querySelector('#app > #viewReports > .seg')) + 6) + 'px');
  };
  const ro = new ResizeObserver(set);
  ['.bar', '#viewAsBar', '.tabs', '#viewStore > .seg', '#viewReports > .seg', '#pAllWrap'].forEach((s) => { const el = document.querySelector(s); if (el) ro.observe(el); });
  window.addEventListener('resize', set); set();
})();
