'use strict';
// shri-standard-errors: every operation documents 401, 403, 429, 500; operations with a path ID document 404.
// "public" operations need no 401/403; "partner-signed" ones need no 403 (CONTRACT_GOVERNANCE §5).
// The Keycloak back-channel logout answers 400 for every failure, as OpenID Connect Back-Channel Logout 1.0
// §2.8 requires, so it documents no 401 (D94).
const { operations, responseCodes } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { path, op, at } of operations(doc)) {
    const have = new Set(responseCodes(op));
    const perm = op['x-permission'];
    const need = ['429', '500'];
    if (perm !== 'public' && path !== '/hooks/keycloak/backchannel-logout') need.push('401');
    if (perm !== 'public' && perm !== 'partner-signed') need.push('403');
    if (/\{[^}]+\}/.test(path)) need.push('404');
    const missing = need.filter((c) => !have.has(c));
    if (missing.length) out.push({ message: `Missing standard error responses: ${missing.join(', ')}.`, path: at.concat('responses') });
  }
  return out;
};
