'use strict';
// shri-async: x-async true → 202 with Location and the Operation schema; no 202 without x-async (API_STANDARDS §13).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { op, at } of operations(doc)) {
    const r = op.responses && op.responses['202'];
    if (op['x-async'] === true) {
      if (!isObject(r)) { out.push({ message: 'x-async operations must return 202 (components/responses/Accepted).', path: at.concat('responses') }); continue; }
      if (!isObject(r.headers) || !r.headers.Location) out.push({ message: '202 must carry a Location header pointing to the operation.', path: at.concat('responses', '202') });
      const s = r.content && r.content['application/json'] && r.content['application/json'].schema;
      const req = isObject(s) && Array.isArray(s.required) ? s.required : [];
      if (!['id', 'kind', 'status'].every((k) => req.includes(k))) out.push({ message: '202 body must be the shared Operation schema.', path: at.concat('responses', '202') });
    } else if (isObject(r)) out.push({ message: '202 is only for long-running work: set x-async: true.', path: at.concat('responses', '202') });
  }
  return out;
};
