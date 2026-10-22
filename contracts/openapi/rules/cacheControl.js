'use strict';
// shri-cache-control: success responses document Cache-Control: no-store (API_STANDARDS §7.2).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { op, at } of operations(doc)) {
    for (const [code, r] of Object.entries(op.responses || {})) {
      if (/^2\d\d$/.test(code) && code !== '204' && isObject(r) && !(isObject(r.headers) && r.headers['Cache-Control'])) {
        out.push({ message: `Response ${code} should document Cache-Control (components/headers/CacheControl).`, path: at.concat('responses', code) });
      }
    }
  }
  return out;
};
