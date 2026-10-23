'use strict';
// shri-request-closed: request body object schemas set additionalProperties: false (API_STANDARDS §7.2).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { op, at } of operations(doc)) {
    const c = op.requestBody && op.requestBody.content;
    if (!isObject(c)) continue;
    for (const [mt, media] of Object.entries(c)) {
      const s = media && media.schema;
      if (isObject(s) && (s.type === 'object' || isObject(s.properties)) && s.additionalProperties !== false) {
        out.push({ message: 'Request body schemas must set additionalProperties: false.', path: at.concat('requestBody', 'content', mt, 'schema') });
      }
    }
  }
  return out;
};
