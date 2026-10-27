'use strict';
// shri-properties-camel: property and query parameter names are camelCase (API_STANDARDS §3).
const { walkSchemas, operations, isObject, deref } = require('./_lib.js');
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
// Names fixed by an external standard, allowed only where that standard applies: the OpenID Connect
// Back-Channel Logout 1.0 form field, on /hooks/ operations only (D94).
const STANDARD_NAMES = new Set(['logout_token']);
const standardName = (name, path) => STANDARD_NAMES.has(name) && path[0] === 'paths' && String(path[1]).startsWith('/hooks/');
module.exports = (doc) => {
  const out = [];
  walkSchemas(doc, (s, path) => {
    if (!isObject(s.properties)) return;
    for (const name of Object.keys(s.properties)) {
      if (!CAMEL.test(name) && !standardName(name, path)) out.push({ message: `Property "${name}" must be camelCase.`, path: path.concat('properties', name) });
    }
  });
  for (const { op, item, at } of operations(doc)) {
    [].concat(item.parameters || [], op.parameters || []).forEach((raw, i) => {
      const p = deref(doc, raw);
      if (isObject(p) && p.in === 'query' && !CAMEL.test(p.name)) out.push({ message: `Query parameter "${p.name}" must be camelCase.`, path: at.concat('parameters') });
    });
  }
  return out;
};
