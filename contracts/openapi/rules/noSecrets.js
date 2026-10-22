'use strict';
// shri-no-secrets: no examples or defaults that look like keys or tokens (CONTRACT_GOVERNANCE §5; gitleaks also runs in CI).
const { walkExampleValues } = require('./_lib.js');
const PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'API secret key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
module.exports = (doc) => {
  const out = [];
  walkExampleValues(doc, (v, key, path) => {
    if (typeof v !== 'string') return;
    for (const [re, what] of PATTERNS) if (re.test(v)) out.push({ message: `Example looks like a ${what}. Never put secrets in the contract.`, path });
    if (!v.includes('/') && /^[A-Za-z0-9+=_-]{32,}$/.test(v) && !UUID.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v)) {
      out.push({ message: 'Example looks like a random token or key (32+ random characters). Use a short placeholder.', path });
    }
  });
  return out;
};
