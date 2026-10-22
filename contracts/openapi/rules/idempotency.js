'use strict';
// shri-idempotency: x-idempotency "required" → required Idempotency-Key header and 400, 409, 422 documented;
// "supported" → optional header present. Only on POST (API_STANDARDS §10, ADR-0007).
const { operations, hasParam, responseCodes } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { method, op, item, at } of operations(doc)) {
    const v = op['x-idempotency'];
    if (v === undefined) continue;
    const p = at.concat('x-idempotency');
    if (!['required', 'supported'].includes(v)) { out.push({ message: 'x-idempotency must be "required" or "supported".', path: p }); continue; }
    if (method !== 'post') out.push({ message: 'x-idempotency is only for POST.', path: p });
    const h = hasParam(doc, op, item, 'Idempotency-Key', 'header');
    if (!h) { out.push({ message: 'Declare the Idempotency-Key header parameter.', path: at.concat('parameters') }); continue; }
    if (v === 'required') {
      if (h.required !== true) out.push({ message: 'Idempotency-Key must be required: true.', path: at.concat('parameters') });
      const missing = ['400', '409', '422'].filter((c) => !responseCodes(op).includes(c));
      if (missing.length) out.push({ message: `Idempotent operations must document ${missing.join(', ')}.`, path: at.concat('responses') });
    } else if (h.required === true) out.push({ message: 'With x-idempotency "supported", Idempotency-Key must not be required.', path: at.concat('parameters') });
  }
  return out;
};
