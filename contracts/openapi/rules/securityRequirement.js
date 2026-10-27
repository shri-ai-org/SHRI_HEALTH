'use strict';
// shri-security: non-public operations require the session cookie (the staff `sessionCookie` or the patient portal's
// `portalSessionCookie`, ADR-0013), or the AI delegated token; unsafe methods also require the CSRF header; public and
// partner-signed operations set security: [] (SECURITY_MODEL §1, §2.3).
const { operations, isObject } = require('./_lib.js');
const UNSAFE = ['post', 'put', 'patch', 'delete'];
module.exports = (doc) => {
  const out = [];
  for (const { path, method, op, at } of operations(doc)) {
    const perm = op['x-permission'];
    const sec = Array.isArray(op.security) ? op.security : doc.security;
    if (perm === 'public' || perm === 'partner-signed') {
      if (!Array.isArray(op.security) || op.security.length !== 0) out.push({ message: `"${perm}" operations must set security: [] explicitly.`, path: at });
      continue;
    }
    if (!Array.isArray(sec) || sec.length === 0) { out.push({ message: 'Operation has no security requirement.', path: at }); continue; }
    sec.forEach((req, i) => {
      if (!isObject(req)) return;
      const names = Object.keys(req);
      const cookie = names.includes('sessionCookie') ? 'sessionCookie' : names.includes('portalSessionCookie') ? 'portalSessionCookie' : null;
      if (!cookie && !names.includes('delegatedToken')) out.push({ message: 'Security must use sessionCookie or portalSessionCookie (or delegatedToken for the AI gateway).', path: at.concat('security') });
      if (cookie && names.includes('sessionCookie') && names.includes('portalSessionCookie')) out.push({ message: 'An operation is either staff (sessionCookie) or patient portal (portalSessionCookie), never both.', path: at.concat('security') });
      const portal = path.startsWith('/portal/');
      if (portal && names.includes('sessionCookie')) out.push({ message: 'Portal operations take portalSessionCookie, never the staff sessionCookie (ADR-0013 §5).', path: at.concat('security', i) });
      if (!portal && names.includes('portalSessionCookie')) out.push({ message: 'portalSessionCookie is for /portal/ operations only (ADR-0013 §5).', path: at.concat('security', i) });
      if (UNSAFE.includes(method) && cookie && !names.includes('csrfHeader')) {
        out.push({ message: `${method.toUpperCase()} with the session cookie must also require csrfHeader: [{ ${cookie}: [], csrfHeader: [] }].`, path: Array.isArray(op.security) ? at.concat('security', i) : at });
      }
    });
  }
  return out;
};
