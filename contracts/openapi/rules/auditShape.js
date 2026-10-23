'use strict';
// shri-x-audit: every operation declares x-audit { action, category, patient?, actor? } (SECURITY_MODEL §6).
const { operations, isObject } = require('./_lib.js');
const ACTIONS = ['C', 'R', 'U', 'E'];
const CATEGORIES = ['phi-read', 'phi-write', 'sign', 'export', 'security', 'ai', 'admin', 'none'];
const ACTORS = ['user', 'partner'];
module.exports = (doc) => {
  const out = [];
  for (const { path, op, at } of operations(doc)) {
    const a = op['x-audit'];
    const p = at.concat('x-audit');
    if (!isObject(a)) { out.push({ message: 'x-audit is required: { action, category, patient?, actor? }.', path: at }); continue; }
    if (!ACTIONS.includes(a.action)) out.push({ message: `x-audit.action must be one of ${ACTIONS.join(', ')}.`, path: p });
    if (!CATEGORIES.includes(a.category)) out.push({ message: `x-audit.category must be one of ${CATEGORIES.join(', ')}.`, path: p });
    if (a.actor !== undefined && !ACTORS.includes(a.actor)) out.push({ message: `x-audit.actor must be one of ${ACTORS.join(', ')}.`, path: p });
    if (a.patient !== undefined && typeof a.patient !== 'string') out.push({ message: 'x-audit.patient must be a string: a path parameter name, "body:/pointer" or "result".', path: p });
    for (const k of Object.keys(a)) if (!['action', 'category', 'patient', 'actor'].includes(k)) out.push({ message: `Unknown x-audit member "${k}".`, path: p });
    if (path.includes('{patientId}') && !a.patient) out.push({ message: 'Patient-scoped path: x-audit.patient must name where the patient ID comes from (e.g. "patientId").', path: p });
  }
  return out;
};
