'use strict';
// shri-string-limits: every string schema has maxLength, enum, const, or format date / date-time / uuid / email (CONTRACT_GOVERNANCE §5).
const { walkSchemas } = require('./_lib.js');
const FORMATS = ['date', 'date-time', 'uuid', 'email'];
function isString(s) { return s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string')); }
module.exports = (doc) => {
  const out = [];
  walkSchemas(doc, (s, path) => {
    if (!isString(s)) return;
    if (s.maxLength !== undefined || Array.isArray(s.enum) || 'const' in s || FORMATS.includes(s.format)) return;
    out.push({ message: 'String without a limit: add maxLength, enum, const, or format date/date-time/uuid/email.', path });
  });
  return out;
};
