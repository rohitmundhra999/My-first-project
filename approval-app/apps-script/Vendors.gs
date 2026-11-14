// ======================= HO: Vendors report (VENDORS tab + email in VENDOR EMAILS) =======================
// Name, address, phone, payment cycle and "deals with" come from the VENDORS tab. HO (or the admin) can edit the
// address, phone and email: address/phone are written on that vendor's VENDORS row(s); the email is kept in a new
// tab VENDOR EMAILS (locked, only the owner edits), so the VENDORS tab keeps its columns. New POs print all of it.
const VEND_CFG = { TAB: 'VENDOR EMAILS', HEAD: ['Vendor', 'Email', 'Updated', 'Updated by'] };

function canVendors_(u) { if (!u.isHO && !isAdmin_(u)) throw appError_('FORBIDDEN', 'Only HO can see vendors.'); }

function vendorEmailTab_() {
  const b = book_();
  let sh = b.getSheetByName(VEND_CFG.TAB);
  if (!sh) {
    sh = b.insertSheet(VEND_CFG.TAB);
    sh.getRange(1, 1, 1, VEND_CFG.HEAD.length).setValues([VEND_CFG.HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    const p = sh.protect().setDescription('Only the owner can edit (app writes here)');
    p.getEditors().forEach(e => { if (e.getEmail() !== Session.getEffectiveUser().getEmail()) p.removeEditor(e); });
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
  return sh;
}

/** vendor name (lower case) -> email */
function vendorEmails_() {
  const sh = book_().getSheetByName(VEND_CFG.TAB), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => {
    const k = String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase();
    if (k) out[k] = String(r[1]).trim();
  });
  return out;
}
function vendorEmailOf_(name) { return vendorEmails_()[String(name || '').replace(/\s+/g, ' ').trim().toLowerCase()] || ''; }

function vendorList_(user) {
  canVendors_(user);
  const sh = book_().getSheetByName(PO_CFG.VENDORS), em = vendorEmails_(), seen = {}, list = [];
  if (sh && sh.getLastRow() >= 2) sh.getRange(2, 2, sh.getLastRow() - 1, 5).getValues().forEach(r => {
    const name = String(r[0]).replace(/\s+/g, ' ').trim(), k = name.toLowerCase();
    if (!name) return;
    const v = { name: name, address: String(r[1]).trim(), phone: String(r[2]).trim(), cycle: String(r[3]).trim(), deals: String(r[4]).trim(), email: em[k] || '' };
    if (seen[k] !== undefined) { const o = list[seen[k]]; ['address', 'phone', 'cycle', 'deals'].forEach(f => { if (!o[f] && v[f]) o[f] = v[f]; }); return; }
    seen[k] = list.length; list.push(v);
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { list: list };
}

/** Edit a vendor's address, phone and email. */
function vendorSave_(user, req) {
  canVendors_(user);
  const name = String(req.vendor || '').replace(/\s+/g, ' ').trim(), k = name.toLowerCase();
  const address = String(req.address || '').replace(/\s+/g, ' ').trim();
  const phone = String(req.phone || '').replace(/[^0-9+ ,\/-]/g, '').trim();
  const email = String(req.email || '').trim().toLowerCase();
  if (!name) throw appError_('BAD_REQUEST', 'Choose the vendor.');
  if (address.length > 200) throw appError_('BAD_REQUEST', 'The address is too long (max 200 letters).');
  if (phone.length > 40) throw appError_('BAD_REQUEST', 'The phone number is too long.');
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i.test(email)) throw appError_('BAD_REQUEST', 'Enter a valid email address.');
  const vsh = book_().getSheetByName(PO_CFG.VENDORS);
  if (!vsh || vsh.getLastRow() < 2) throw appError_('SETUP', 'Tab VENDORS not found.');
  const es = vendorEmailTab_();
  withLock_(() => {
    const names = vsh.getRange(2, 2, vsh.getLastRow() - 1, 1).getValues();
    let hits = 0;
    names.forEach((r, i) => {
      if (String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase() !== k) return;
      vsh.getRange(i + 2, 3, 1, 2).setValues([[address, phone]]);   // VENDORS C address, D contact number
      hits++;
    });
    if (!hits) throw appError_('BAD_REQUEST', name + ' was not found in VENDORS.');
    const last = es.getLastRow();
    const en = last >= 2 ? es.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]).replace(/\s+/g, ' ').trim().toLowerCase()) : [];
    const at = en.indexOf(k);
    const row = [name, email, new Date(), user.name];
    if (at >= 0) es.getRange(at + 2, 1, 1, 4).setValues([row]); else es.getRange(last + 1, 1, 1, 4).setValues([row]);
    log_(user, 'VENDOR EDIT', name, 'Address: ' + address + ' | Phone: ' + phone + ' | Email: ' + (email || '-'));
  });
  return { vendor: { name: name, address: address, phone: phone, email: email } };
}
