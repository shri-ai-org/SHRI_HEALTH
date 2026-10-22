'use strict';
// shri-public-allowlist: x-permission "public" only on the allow-listed paths (SECURITY_MODEL §1).
const { operations } = require('./_lib.js');
const ALLOWED = new Set(['/auth/login', '/auth/callback', '/health']);
module.exports = (doc) => {
  const out = [];
  for (const { path, op, at } of operations(doc)) {
    if (op['x-permission'] === 'public' && !ALLOWED.has(path)) {
      out.push({ message: `"public" is only allowed on ${[...ALLOWED].join(', ')}; ${path} must require a session or a partner signature.`, path: at.concat('x-permission') });
    }
  }
  return out;
};
