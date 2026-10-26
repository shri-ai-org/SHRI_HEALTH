// Checks that every relative link in the markdown files points at a file or folder that exists.
// Web links (http, https, mailto) and same-page anchors are skipped; a link's own #anchor is not checked.
//
//   node scripts/check-links.mjs            # every .md file under contracts/ (npm run links; part of npm test)
//   node scripts/check-links.mjs .. docs    # the whole repository, or any folders and files given
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'dist', '.venv']);
const LINK = /\]\(([^)\s]+)\)/g;
const EXTERNAL = /^(https?:|mailto:|#)/;

function markdownFiles(path) {
  if (!statSync(path).isDirectory()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
    .flatMap((e) => markdownFiles(join(path, e.name)));
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : [ROOT];
const files = targets.flatMap(markdownFiles).sort();
const broken = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, n) => {
    for (const [, target] of line.matchAll(LINK)) {
      if (EXTERNAL.test(target)) continue;
      if (!existsSync(resolve(dirname(file), decodeURI(target.split('#')[0])))) {
        broken.push(`${relative(process.cwd(), file)}:${n + 1}: ${target}`);
      }
    }
  });
}
for (const b of broken) console.error(`Broken link ${b}`);
console.log(`Link check: ${files.length} markdown file(s), ${broken.length} broken link(s).`);
process.exit(broken.length ? 1 : 0);
