'use strict';
// shri-if-match: PATCH, PUT and x-concurrency "if-match-required" declare a required If-Match header and document 412 and 428
// (API_STANDARDS §11, ADR-0008).
const { operations, hasParam, responseCodes } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { method, op, item, at } of operations(doc)) {
    const required = method === 'patch' || method === 'put' || op['x-concurrency'] === 'if-match-required';
    if (!required) continue;
    const h = hasParam(doc, op, item, 'If-Match', 'header');
    if (!h || h.required !== true) out.push({ message: 'Declare If-Match as a required header parameter.', path: at.concat('parameters') });
    const missing = ['412', '428'].filter((c) => !responseCodes(op).includes(c));
    if (missing.length) out.push({ message: `Document ${missing.join(' and ')} for If-Match.`, path: at.concat('responses') });
  }
  return out;
};
