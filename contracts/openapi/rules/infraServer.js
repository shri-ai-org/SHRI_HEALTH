'use strict';
// shri-infra-server: /health and /hooks/* override servers with the "/" entry; every other path uses /api/v1 (API_STANDARDS §2).
const { isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (!isObject(item)) continue;
    const infra = path === '/health' || path.startsWith('/hooks/');
    const urls = Array.isArray(item.servers) ? item.servers.map((s) => s && s.url) : null;
    if (infra && !(urls && urls.length === 1 && urls[0] === '/')) out.push({ message: `${path} is outside /api/v1: set servers: [{ url: / }] on the path item.`, path: ['paths', path] });
    if (!infra && urls) out.push({ message: `${path} must not override servers; only /health and /hooks/* do.`, path: ['paths', path, 'servers'] });
    if (path === '/ready') out.push({ message: '/ready is internal and not part of the contract (Thulasi, T24).', path: ['paths', path] });
  }
  return out;
};
