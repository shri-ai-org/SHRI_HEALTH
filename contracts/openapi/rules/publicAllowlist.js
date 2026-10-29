'use strict';
// shri-public-allowlist: x-permission "public" only on the allow-listed paths (SECURITY_MODEL §1).
const { operations } = require('./_lib.js');
// The patient portal's sign-in, callback and enrolment come before any session exists (ADR-0013 §3, §5; D85; U.S. spelling, D18).
// Pre-registration is a public form with no account at all, under the practice's own link, and its bot-check
// challenge needs no session or practice code (D96).
const ALLOWED = new Set(['/auth/login', '/auth/callback', '/health', '/portal/auth/login', '/portal/auth/callback', '/portal/enrollments',
  '/portal/practices/{practiceLinkId}/pre-registrations', '/portal/bot-challenge']);
module.exports = (doc) => {
  const out = [];
  for (const { path, op, at } of operations(doc)) {
    if (op['x-permission'] === 'public' && !ALLOWED.has(path)) {
      out.push({ message: `"public" is only allowed on ${[...ALLOWED].join(', ')}; ${path} must require a session or a partner signature.`, path: at.concat('x-permission') });
    }
  }
  return out;
};
