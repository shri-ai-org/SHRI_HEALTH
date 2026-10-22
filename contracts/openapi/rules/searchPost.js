'use strict';
// shri-search-post: …/search is POST only, with limit and cursor in the body (API_STANDARDS §14, ADR-0005).
const { operations, isObject } = require('./_lib.js');
module.exports = (doc) => {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (!path.endsWith('/search') || !isObject(item)) continue;
    for (const m of ['get', 'put', 'patch', 'delete']) if (item[m]) out.push({ message: `${path} must be POST only.`, path: ['paths', path, m] });
    const op = item.post;
    if (!isObject(op)) { out.push({ message: `${path} must define POST.`, path: ['paths', path] }); continue; }
    const body = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
    const props = body && isObject(body.schema) && isObject(body.schema.properties) ? body.schema.properties : {};
    if (!props.limit || !props.cursor) out.push({ message: 'Search body must carry limit and cursor (SearchPaging).', path: ['paths', path, 'post', 'requestBody'] });
  }
  return out;
};
