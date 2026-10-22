'use strict';
// shri-description: every operation and every component schema has a description (CONTRACT_GOVERNANCE §5).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const { op, at } of operations(doc)) if (!op.description) out.push({ message: 'Operation needs a description.', path: at });
  const schemas = (doc.components && doc.components.schemas) || {};
  for (const [k, s] of Object.entries(schemas)) if (isObject(s) && !s.description) out.push({ message: `Schema ${k} needs a description.`, path: ['components', 'schemas', k] });
  return out;
};
