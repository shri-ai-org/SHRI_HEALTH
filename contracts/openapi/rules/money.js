'use strict';
// shri-money: properties named *Amount, copay, deductible or balance use the shared Money schema (API_STANDARDS §6.3).
const { walkSchemas, isObject } = require('./_lib.js');
const NAME = /(Amount$|^amount$|^copay$|^deductible$|^balance$)/;
module.exports = (doc) => {
  const out = [];
  walkSchemas(doc, (s, path) => {
    if (!isObject(s.properties)) return;
    for (const [name, prop] of Object.entries(s.properties)) {
      if (NAME.test(name) && !(isObject(prop) && prop.$ref === '#/components/schemas/Money')) {
        out.push({ message: `"${name}" is money: use $ref: '#/components/schemas/Money'.`, path: path.concat('properties', name) });
      }
    }
  });
  return out;
};
