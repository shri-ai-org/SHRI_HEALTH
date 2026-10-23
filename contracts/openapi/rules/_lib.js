'use strict';
// Shared helpers for the Shri Health Spectral rule functions (CONTRACT_GOVERNANCE §5).
// Every function receives the whole document (given: "$") and reports results with JSON paths.

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Yield every operation: { path, method, op, item, at } where `at` is the JSON path of the operation.
function* operations(doc) {
  const paths = isObject(doc && doc.paths) ? doc.paths : {};
  for (const [p, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const m of METHODS) {
      if (isObject(item[m])) yield { path: p, method: m, op: item[m], item, at: ['paths', p, m] };
    }
  }
}

// Resolve a local "#/..." reference one level at a time (used by rules that run on the unresolved document).
function deref(doc, node, seen = new Set()) {
  let cur = node;
  while (isObject(cur) && typeof cur.$ref === 'string' && cur.$ref.startsWith('#/') && !seen.has(cur.$ref)) {
    seen.add(cur.$ref);
    const parts = cur.$ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = doc;
    for (const part of parts) target = isObject(target) || Array.isArray(target) ? target[part] : undefined;
    if (target === undefined) return cur;
    // Keep sibling keywords (OpenAPI 3.1 allows them next to $ref in schemas).
    const { $ref, ...siblings } = cur;
    cur = Object.keys(siblings).length ? { ...target, ...siblings } : target;
  }
  return cur;
}

// Walk every schema in the document and call visit(schema, path).
// Starts at components and inside operations; skips examples, defaults and vendor extensions.
function walkSchemas(doc, visit) {
  const seen = new WeakSet();
  function schema(node, path) {
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    visit(node, path);
    if (isObject(node.properties)) {
      for (const [k, v] of Object.entries(node.properties)) schema(v, path.concat('properties', k));
    }
    if (isObject(node.items)) schema(node.items, path.concat('items'));
    if (Array.isArray(node.prefixItems)) node.prefixItems.forEach((s, i) => schema(s, path.concat('prefixItems', i)));
    if (isObject(node.additionalProperties)) schema(node.additionalProperties, path.concat('additionalProperties'));
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (Array.isArray(node[key])) node[key].forEach((s, i) => schema(s, path.concat(key, i)));
    }
    for (const key of ['not', 'if', 'then', 'else']) if (isObject(node[key])) schema(node[key], path.concat(key));
    if (isObject(node.$defs)) for (const [k, v] of Object.entries(node.$defs)) schema(v, path.concat('$defs', k));
  }
  function content(c, path) {
    if (!isObject(c)) return;
    for (const [mt, media] of Object.entries(c)) if (isObject(media)) schema(media.schema, path.concat(mt, 'schema'));
  }
  function parameter(p, path) {
    if (isObject(p)) {
      schema(p.schema, path.concat('schema'));
      content(p.content, path.concat('content'));
    }
  }
  function response(r, path) {
    if (!isObject(r)) return;
    content(r.content, path.concat('content'));
    if (isObject(r.headers)) for (const [h, hv] of Object.entries(r.headers)) parameter(hv, path.concat('headers', h));
  }
  const comps = isObject(doc.components) ? doc.components : {};
  for (const [k, v] of Object.entries(comps.schemas || {})) schema(v, ['components', 'schemas', k]);
  for (const [k, v] of Object.entries(comps.parameters || {})) parameter(v, ['components', 'parameters', k]);
  for (const [k, v] of Object.entries(comps.headers || {})) parameter(v, ['components', 'headers', k]);
  for (const [k, v] of Object.entries(comps.responses || {})) response(v, ['components', 'responses', k]);
  for (const [k, v] of Object.entries(comps.requestBodies || {})) if (isObject(v)) content(v.content, ['components', 'requestBodies', k, 'content']);
  for (const { item, op, at } of operations(doc)) {
    (item.parameters || []).forEach((p, i) => parameter(p, at.slice(0, 2).concat('parameters', i)));
    (op.parameters || []).forEach((p, i) => parameter(p, at.concat('parameters', i)));
    if (isObject(op.requestBody)) content(op.requestBody.content, at.concat('requestBody', 'content'));
    if (isObject(op.responses)) for (const [code, r] of Object.entries(op.responses)) response(r, at.concat('responses', code));
  }
}

// Walk every example value: schema `examples`/`example`, media/parameter `example`/`examples[*].value`,
// and components.examples[*].value. visit(value, key, path) is called for every nested value.
function walkExampleValues(doc, visit) {
  function values(v, key, path) {
    visit(v, key, path);
    if (Array.isArray(v)) v.forEach((x, i) => values(x, key, path.concat(i)));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) values(x, k, path.concat(k));
  }
  function scan(node, path, parentKey) {
    if (Array.isArray(node)) { node.forEach((x, i) => scan(x, path.concat(i), parentKey)); return; }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'example' || k === 'default') values(v, null, path.concat(k));
      else if (k === 'examples') {
        if (Array.isArray(v)) values(v, null, path.concat(k));
        else if (isObject(v)) for (const [n, ex] of Object.entries(v)) {
          if (isObject(ex) && 'value' in ex) values(ex.value, null, path.concat(k, n, 'value'));
          else if (parentKey === 'components') values(ex, null, path.concat(k, n));
        }
      } else scan(v, path.concat(k), k);
    }
  }
  scan(doc, [], null);
}

function hasParam(doc, op, item, name, where) {
  const all = [].concat(item.parameters || [], op.parameters || []).map((p) => deref(doc, p));
  return all.find((p) => isObject(p) && p.in === where && String(p.name).toLowerCase() === name.toLowerCase());
}

function responseCodes(op) {
  return isObject(op.responses) ? Object.keys(op.responses) : [];
}

module.exports = { METHODS, isObject, operations, deref, walkSchemas, walkExampleValues, hasParam, responseCodes };
