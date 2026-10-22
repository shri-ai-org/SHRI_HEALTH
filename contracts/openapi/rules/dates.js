'use strict';
// shri-dates: *At properties are date-time; *Date properties are date or PartialDate (API_STANDARDS §3, §6.1).
const { walkSchemas, isObject, deref } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  walkSchemas(doc, (s, path) => {
    if (!isObject(s.properties)) return;
    for (const [name, raw] of Object.entries(s.properties)) {
      if (!isObject(raw)) continue;
      const prop = deref(doc, raw);
      if (/[a-z0-9]At$/.test(name) && prop.format !== 'date-time') {
        out.push({ message: `"${name}" ends in At: it must be a date-time (Timestamp).`, path: path.concat('properties', name) });
      }
      const partial = raw.$ref === '#/components/schemas/PartialDate';
      if ((/[a-z0-9]Date$/.test(name) || name === 'date') && prop.format !== 'date' && !partial) {
        out.push({ message: `"${name}" ends in Date: it must be a date (Date) or a PartialDate.`, path: path.concat('properties', name) });
      }
    }
  });
  return out;
};
