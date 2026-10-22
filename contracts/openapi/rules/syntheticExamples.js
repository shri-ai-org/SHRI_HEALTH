'use strict';
// shri-examples-synthetic: examples are synthetic (API_STANDARDS §20): 555-01xx phones, example.com/.org/.net email,
// no SSN-shaped strings, TEST-prefixed identifiers, Synthea-style names (ending in digits).
const { walkExampleValues } = require('./_lib.js');
const PHONE_KEY = /(phone|fax|mobile|telephone)/i;
const NAME_KEYS = new Set(['given', 'family', 'firstName', 'lastName', 'middleName', 'preferredName']);
const ID_KEYS = new Set(['mrn', 'memberId', 'subscriberId', 'licenseNumber', 'driversLicenseNumber', 'policyNumber', 'groupNumber']);
const FORMATTED_PHONE = /(\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{10,15}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
function fictionalPhone(s) {
  const d = s.replace(/\D/g, '');
  return d.length >= 7 && d.slice(-7, -2) === '55501';
}
module.exports = (doc) => {
  const out = [];
  walkExampleValues(doc, (v, key, path) => {
    if (typeof v !== 'string') return;
    if (SSN.test(v)) out.push({ message: 'SSN-shaped value in an example: never put SSNs in examples.', path });
    if (key && /ssn/i.test(key)) out.push({ message: 'No SSN values in examples (VD-SSN).', path });
    const phones = (key && PHONE_KEY.test(key)) ? [v] : (v.match(FORMATTED_PHONE) || []);
    for (const p of phones) if (/\d{7}/.test(p.replace(/\D/g, '')) && !fictionalPhone(p)) out.push({ message: `Phone "${p}" is not in the fictional 555-0100 to 555-0199 range.`, path });
    for (const m of v.matchAll(EMAIL)) if (!/^example\.(com|org|net)$/i.test(m[1])) out.push({ message: `Email domain "${m[1]}" is not example.com, example.org or example.net.`, path });
    if (key && NAME_KEYS.has(key) && !/^\S*\d$/.test(v.split(/\s+/).pop())) out.push({ message: `Name "${v}" is not Synthea-style (a name ending in digits, e.g. Kuhlman72).`, path });
    if (key && ID_KEYS.has(key) && !v.startsWith('TEST')) out.push({ message: `Identifier example "${key}" must start with TEST.`, path });
  });
  return out;
};
