// Loads and writes contract YAML without reformatting it, so a scripted edit shows only the lines it changed.
//
// The module files are written in one style: block style, keys in their original order, header comments kept,
// anchors (&id001) kept, plain or single-quoted scalars folded at a single space once the line passes column 120,
// and block sequences under an anchor not indented. `yaml` keeps comments, anchors and quoting through a
// Document, but folds and indents differently, so dump() puts both back.
//
// From a script in contracts/:
//   import { load, save } from './yaml-io.mjs';
//   const doc = load('openapi/modules/platform.yaml');
//   doc.setIn(['components', 'schemas', 'Session', 'description'], 'New text.');
//   save('openapi/modules/platform.yaml', doc);
//
// Round-trip check (npm run test:yaml): load and dump every module file; exit 1 unless each is byte-identical.
//   node scripts/yaml-io.mjs [file ...]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 120;
const cp = (s) => [...s].length; // columns in code points, as the files were written
const KEYED = /^( *)((?:- )*)((?:'(?:[^']|'')*'|[^'\s#][^:]*?)): (.+)$/;
const ITEM = /^( *)((?:- )+)(.+)$/;

// Fold one over-long `key: value` or `- value` line: break at a single space once the column is past WIDTH, with
// continuation lines indented two past the key (or level with the item). Anything else is left alone.
function refoldLine(line) {
  if (cp(line) <= WIDTH) return line;
  let m = KEYED.exec(line);
  let prefix, value, cont;
  if (m) {
    value = m[4];
    prefix = line.slice(0, line.length - value.length);
    cont = m[1].length + m[2].length + 2;
  } else if ((m = ITEM.exec(line))) {
    prefix = m[1] + m[2];
    value = m[3];
    cont = prefix.length;
  } else return line;
  if (/^[&*!|>{["]/.test(value)) return line;
  const quoted = value.startsWith("'");
  const chars = [...(quoted ? value.slice(1, -1) : value)];
  let out = prefix + (quoted ? "'" : '');
  let col = cp(out);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ') { out += chars[i]; col += 1; continue; }
    let j = i;
    while (j < chars.length && chars[j] === ' ') j++;
    // Only a single space between words can become a line break; a quoted value never breaks at its ends.
    const breakable = j === i + 1 && j < chars.length && (!quoted || i !== 0);
    if (breakable && col > WIDTH) {
      out += '\n' + ' '.repeat(cont);
      col = cont;
    } else {
      out += chars.slice(i, j).join('');
      col += j - i;
    }
    i = j - 1;
  }
  return out + (quoted ? "'" : '');
}

// `yaml` indents a block sequence under an anchored key (`key: &id005` then `- ...`) even with indentSeq: false;
// the files do not, so take those two spaces back out (nested ones too).
function unindentAnchoredSeqs(lines) {
  const indentOf = (l) => l.length - l.trimStart().length;
  const stack = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '') while (stack.length && indentOf(line) <= stack[stack.length - 1]) stack.pop();
    const cut = 2 * stack.length;
    out.push(cut && line.startsWith(' '.repeat(cut)) ? line.slice(cut) : line);
    const next = lines[i + 1] ?? '';
    if (/: &[\w-]+$/.test(line) && next.trimStart().startsWith('- ') && indentOf(next) === indentOf(line) + 2) {
      stack.push(indentOf(line));
    }
  }
  return out;
}

export function load(path) {
  return YAML.parseDocument(readFileSync(resolve(ROOT, path), 'utf8'));
}

export function dump(doc) {
  const raw = doc.toString({ lineWidth: 0, indentSeq: false });
  return unindentAnchoredSeqs(raw.split('\n')).map(refoldLine).join('\n');
}

export function save(path, doc) {
  writeFileSync(resolve(ROOT, path), dump(doc));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modules = join('openapi', 'modules');
  const files = process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(join(ROOT, modules)).filter((f) => f.endsWith('.yaml')).sort().map((f) => join(modules, f));
  const differ = files.filter((f) => dump(load(f)) !== readFileSync(resolve(ROOT, f), 'utf8'));
  for (const f of differ) console.error(`Round trip changes ${f}`);
  console.log(`YAML round trip: ${files.length - differ.length} of ${files.length} file(s) byte-identical.`);
  process.exit(differ.length ? 1 : 0);
}
