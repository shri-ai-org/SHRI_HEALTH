// Fails if a package in an npm lockfile has a licence D75 does not allow.
//
// No dependencies: Node's standard library only. Each package's licence comes from its entry in
// package-lock.json; when the lockfile has none, from the installed package.json, so run it after
// `npm ci`. allowed.json holds the D75 list, the fonts-and-data licences and the per-package
// entries; the same rules are in check_python.py (keep the two in step).
//
//   node ../.github/licences/check-npm.mjs            # in contracts/ or frontend/, after npm ci
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const policy = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'allowed.json'), 'utf8'));
const ALLOWED = new Set(policy.allowed);
const FONTS_AND_DATA = new Set(policy.fonts_and_data.licences);
const alias = (id) => policy.aliases[id] ?? id;

// Every package entry is a D75 font or data use, or a registered exception (Vimal, #60).
function policyProblems() {
  const problems = [];
  for (const [name, entry] of Object.entries(policy.packages)) {
    const { kind, licence, register = '' } = entry;
    if (kind === 'font' || kind === 'data') {
      if (!FONTS_AND_DATA.has(licence) || !register.includes('D75')) {
        problems.push(`${name}: a ${kind} entry needs a fonts-and-data licence and a D75 citation`);
      }
    } else if (kind === 'exception') {
      if (!licence || !register.includes('licence exceptions register')) {
        problems.push(`${name}: an exception must name its line in the licence exceptions register`);
      }
    } else {
      problems.push(`${name}: kind must be font, data or exception`);
    }
  }
  return problems;
}

// SPDX expression: OR needs one allowed side, AND needs both, `X WITH exception` needs X.
export function allowedExpression(expression, extra = new Set()) {
  const tokens = alias(expression.trim()).match(/\(|\)|[^\s()]+/g) ?? [];
  const accepted = (id) => ALLOWED.has(id) || extra.has(id);
  let i = 0;
  const term = () => {
    let value;
    if (tokens[i] === '(') {
      i += 1;
      value = either();
      if (tokens[i] !== ')') throw new Error('unbalanced');
      i += 1;
    } else {
      if (tokens[i] === undefined || tokens[i] === ')') throw new Error('missing licence');
      value = accepted(alias(tokens[i]));
      i += 1;
    }
    if (tokens[i]?.toUpperCase() === 'WITH') i += 2; // the exception only narrows the licence
    return value;
  };
  const both = () => {
    let value = term();
    while (tokens[i]?.toUpperCase() === 'AND') { i += 1; value = term() && value; }
    return value;
  };
  const either = () => {
    let value = both();
    while (tokens[i]?.toUpperCase() === 'OR') { i += 1; value = both() || value; }
    return value;
  };
  try {
    const value = either();
    return value && i === tokens.length;
  } catch {
    return false;
  }
}

function licenceOf(meta) {
  const field = meta.license ?? meta.licenses;
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) return field.map((l) => `(${l.type ?? l})`).join(' OR ');
  if (field && typeof field === 'object') return field.type;
  return undefined;
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const failures = policyProblems();
let checked = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (path === '' || entry.link) continue; // the project itself, and workspace links
  checked += 1;
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const listed = policy.packages[`npm:${name}`];
  const extra = new Set(listed?.licence ? [listed.licence] : []);
  let licence = licenceOf(entry);
  if (licence === undefined && existsSync(join(path, 'package.json'))) {
    licence = licenceOf(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')));
  }
  if (licence === undefined || !allowedExpression(licence, extra)) {
    failures.push(`${name}@${entry.version}: ${licence ?? 'no licence found'}`);
  }
}
for (const f of failures) console.log(`::error::Licence not allowed by D75: ${f}`);
console.log(`npm licence check: ${checked} package(s), ${failures.length} problem(s).`);
process.exit(failures.length ? 1 : 0);
