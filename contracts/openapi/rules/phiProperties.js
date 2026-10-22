'use strict';
// shri-x-phi: every schema property carries x-phi with an allowed value (SECURITY_MODEL §7).
const { walkSchemas, isObject } = require('./_lib.js');
const VALUES = ['identifier', 'clinical', 'financial', 'internal-id', 'none'];
module.exports = (doc) => {
  const out = [];
  walkSchemas(doc, (s, path) => {
    if (!isObject(s.properties)) return;
    for (const [name, prop] of Object.entries(s.properties)) {
      if (!isObject(prop)) continue;
      if (!VALUES.includes(prop['x-phi'])) {
        out.push({ message: `Property "${name}" needs x-phi: one of ${VALUES.join(', ')}.`, path: path.concat('properties', name) });
      }
    }
  });
  return out;
};
