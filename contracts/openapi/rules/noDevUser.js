'use strict';
// shri-no-dev-user: the X-Dev-User header picks a stand-in test user in Thulasi's development and test login
// (PR #7). It must never appear in the contract: not as a parameter, header, security scheme or in any text,
// so it never reaches the generated client or staging and production.
const { isObject } = require('./_lib.js');
const DEV_USER = /x-dev-user/i;
module.exports = (doc) => {
  const out = [];
  function walk(v, path) {
    if (typeof v === 'string') {
      if (DEV_USER.test(v)) out.push({ message: 'X-Dev-User is a development and test login header; it must never appear in the contract.', path });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path.concat(i)));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) {
      if (DEV_USER.test(k)) out.push({ message: 'X-Dev-User is a development and test login header; it must never appear in the contract.', path: path.concat(k) });
      walk(x, path.concat(k));
    }
  }
  walk(doc, []);
  return out;
};
