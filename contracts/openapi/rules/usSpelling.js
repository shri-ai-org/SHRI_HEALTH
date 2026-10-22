'use strict';
// shri-us-spelling: U.S. spelling in every identifier and description (VD-G9, D18).
const { isObject } = require('./_lib.js');
const BRITISH = /\b(favourit\w*|licence[sd]?|colour\w*|organis\w*|authoris\w*|behaviour\w*|centre[sd]?|catalogue[sd]?|analys(e|ed|ing)|normalis\w*|optimis\w*|prioritis\w*|recognis\w*|minimis\w*|summaris\w*|utilis\w*|defence|offence|programme[sd]?|judgement)\b/i;
module.exports = (doc) => {
  const out = [];
  function walk(v, path) {
    if (typeof v === 'string') {
      const m = v.match(BRITISH);
      if (m) out.push({ message: `British spelling "${m[0]}": use U.S. spelling.`, path });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path.concat(i)));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) {
      const m = k.match(BRITISH);
      if (m) out.push({ message: `British spelling "${m[0]}" in a name: use U.S. spelling.`, path: path.concat(k) });
      walk(x, path.concat(k));
    }
  }
  walk(doc, []);
  return out;
};
