// ======================= HO: material not received (all units) =======================
// ho.purchase sees every unit's PO lines still to be received and can mark them received (same as the store).

function hoReceiveList_(user, req) {
  if (!user.isHO) throw appError_('FORBIDDEN', 'Only HO can see this.');
  const names = storeMetaData_().units;
  let byUnit = null;
  if (req && req.fresh) byUnit = storeLines_();
  const lines = [], pol = {};
  let asOf = '';
  unique_(names.map(normU_)).forEach(u => {
    let d;
    if (byUnit) d = cacheGetBig_(storeKey_(u));
    else { d = cacheGetBig_(storeKey_(u)); if (!d) { byUnit = storeLines_(); d = cacheGetBig_(storeKey_(u)); } }
    if (!d) return;
    asOf = asOf || d.asOf;
    const name = names.find(k => normU_(k) === u) || u;
    d.lines.forEach(l => { if (l.s === 'Approved' && l.po && l.rcv === '') lines.push(Object.assign({ u: name }, l)); });
    Object.assign(pol, d.pol || {});
  });
  return { lines: lines, pol: pol, asOf: asOf };
}
