'use strict';
// shri-x-audit: every operation declares x-audit { action, category, patient?, actor? } (SECURITY_MODEL §6).
// Portal operations (/portal/...) are the patient's own: actor `patient`, the patient from the session, never a
// `{patientId}` in the path (D84, ADR-0013 §5, §6). `patient` and `session` are for portal operations only.
const { operations, isObject } = require('./_lib.js');
const ACTIONS = ['C', 'R', 'U', 'E'];
const CATEGORIES = ['phi-read', 'phi-write', 'sign', 'export', 'security', 'ai', 'admin', 'none'];
const ACTORS = ['user', 'partner', 'patient'];
// The only portal operations a patient session may call without an audit record: practice data and the session read
// (SECURITY_MODEL §6). Every other portal-session operation is audited with the patient from the session.
const PORTAL_UNAUDITED = ['/portal/auth/session', '/portal/booking/facilities', '/portal/booking/appointment-types',
  '/portal/booking/providers', '/portal/me/slots'];
module.exports = (doc) => {
  const out = [];
  for (const { path, op, at } of operations(doc)) {
    const a = op['x-audit'];
    const p = at.concat('x-audit');
    if (!isObject(a)) { out.push({ message: 'x-audit is required: { action, category, patient?, actor? }.', path: at }); continue; }
    if (!ACTIONS.includes(a.action)) out.push({ message: `x-audit.action must be one of ${ACTIONS.join(', ')}.`, path: p });
    if (!CATEGORIES.includes(a.category)) out.push({ message: `x-audit.category must be one of ${CATEGORIES.join(', ')}.`, path: p });
    if (a.actor !== undefined && !ACTORS.includes(a.actor)) out.push({ message: `x-audit.actor must be one of ${ACTORS.join(', ')}.`, path: p });
    if (a.patient !== undefined && typeof a.patient !== 'string') out.push({ message: 'x-audit.patient must be a string: a path parameter name, "body:/pointer", "result" or "session".', path: p });
    for (const k of Object.keys(a)) if (!['action', 'category', 'patient', 'actor'].includes(k)) out.push({ message: `Unknown x-audit member "${k}".`, path: p });
    if (path.includes('{patientId}') && !a.patient) out.push({ message: 'Patient-scoped path: x-audit.patient must name where the patient ID comes from (e.g. "patientId").', path: p });
    const portal = path.startsWith('/portal/');
    const sec = Array.isArray(op.security) ? op.security : doc.security;
    const patientSession = Array.isArray(sec) && sec.some((s) => isObject(s) && 'portalSessionCookie' in s);
    if (portal) {
      if (path.includes('{patientId}')) out.push({ message: 'Portal path: the patient comes from the session, never the path (D84).', path: at });
      if (a.actor !== 'patient') out.push({ message: 'Portal operation: x-audit.actor must be "patient" (ADR-0013 §6).', path: p });
      if (patientSession && a.category === 'none' && !PORTAL_UNAUDITED.includes(path)) out.push({ message: `Portal operation: category "none" is allowed only on ${PORTAL_UNAUDITED.join(', ')} (SECURITY_MODEL §6).`, path: p });
      else if (patientSession && a.category !== 'none' && a.patient !== 'session') out.push({ message: 'Portal operation with a patient session: x-audit.patient must be "session" (D84).', path: p });
    } else {
      if (a.actor === 'patient') out.push({ message: 'x-audit.actor "patient" is for portal operations only.', path: p });
      if (a.patient === 'session') out.push({ message: 'x-audit.patient "session" is for portal operations only.', path: p });
    }
  }
  return out;
};
