'use strict';
// shri-no-phi-in-query: no PHI-named query or path parameter (API_STANDARDS §14.3, ADR-0005).
const { operations, isObject, deref } = require('./_lib.js');
const EXACT = new Set(['name', 'given', 'family', 'firstname', 'lastname', 'birthdate', 'dob', 'phone', 'email', 'address',
  'postalcode', 'zip', 'mrn', 'ssn', 'ssnlast4', 'memberid', 'subscriberid', 'licensenumber', 'driverslicense', 'policynumber', 'search', 'q']);
const PARTS = ['phone', 'email', 'birth', 'ssn', 'mrn', 'address', 'license', 'licence', 'member', 'subscriber', 'postal', 'zip',
  'firstname', 'lastname', 'familyname', 'givenname', 'policy'];
// Catalog lookups (reference data, not patients): `q` is allowed; `/pharmacies` may also filter by the pharmacy's own ZIP code.
const Q_ALLOWED = ['/codes', '/pharmacies', '/lab-compendium'];
const CATALOG_EXTRA = { '/pharmacies': ['postalcode'] };
module.exports = (doc) => {
  const out = [];
  for (const { path, op, item, at } of operations(doc)) {
    [].concat(item.parameters || [], op.parameters || []).forEach((raw) => {
      const p = deref(doc, raw);
      if (!isObject(p) || (p.in !== 'query' && p.in !== 'path')) return;
      const n = String(p.name).toLowerCase();
      if (n === 'q' && Q_ALLOWED.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return;
      if ((CATALOG_EXTRA[path] || []).includes(n)) return;
      if (EXACT.has(n) || PARTS.some((x) => n.includes(x))) {
        out.push({ message: `Parameter "${p.name}" (${p.in}) looks like PHI. PHI never goes in a URL: use POST …/search with a body.`, path: at.concat('parameters') });
      }
    });
  }
  return out;
};
