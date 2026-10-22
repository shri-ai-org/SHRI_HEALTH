'use strict';
// shri-problem-responses: every 4xx/5xx response is application/problem+json with the shared Problem schema (API_STANDARDS §9).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { op, at } of operations(doc)) {
    for (const [code, r] of Object.entries(op.responses || {})) {
      if (!/^[45]\d\d$/.test(code) || !isObject(r)) continue;
      const p = at.concat('responses', code);
      const types = isObject(r.content) ? Object.keys(r.content) : [];
      if (types.length !== 1 || types[0] !== 'application/problem+json') {
        out.push({ message: `Response ${code} must have exactly one media type, application/problem+json.`, path: p });
        continue;
      }
      const s = r.content['application/problem+json'].schema;
      const req = isObject(s) && Array.isArray(s.required) ? s.required : [];
      if (!['type', 'title', 'status', 'code', 'requestId'].every((k) => req.includes(k))) {
        out.push({ message: `Response ${code} must use the shared Problem schema (#/components/schemas/Problem).`, path: p });
      }
    }
  }
  return out;
};
