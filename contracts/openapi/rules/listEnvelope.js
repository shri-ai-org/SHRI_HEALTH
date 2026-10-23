'use strict';
// shri-list-envelope: GET lists return { items, nextCursor } and accept limit and cursor (API_STANDARDS §8, ADR-0004).
const { operations, isObject, hasParam } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { method, op, item, at } of operations(doc)) {
    if (method !== 'get') continue;
    const ok = op.responses && op.responses['200'];
    const s = ok && ok.content && ok.content['application/json'] && ok.content['application/json'].schema;
    if (!isObject(s)) continue;
    const p = at.concat('responses', '200');
    if (s.type === 'array') { out.push({ message: 'A list must be the envelope { items, nextCursor }, never a bare array.', path: p }); continue; }
    const items = isObject(s.properties) && s.properties.items;
    if (isObject(items) && items.type === 'array') {
      if (!s.properties.nextCursor) out.push({ message: 'List envelope must include nextCursor.', path: p });
      if (!hasParam(doc, op, item, 'limit', 'query') || !hasParam(doc, op, item, 'cursor', 'query')) {
        out.push({ message: 'A GET list must accept the limit and cursor query parameters.', path: at.concat('parameters') });
      }
    }
  }
  return out;
};
