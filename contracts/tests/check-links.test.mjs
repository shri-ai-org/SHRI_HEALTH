// Tests for scripts/check-links.mjs: it reports broken links in our files, and never walks into node_modules
// or through a symbolic link (a worktree whose node_modules links to another checkout's).
//
//   node --test tests/check-links.test.mjs     (part of npm test)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-links.mjs');
const root = mkdtempSync(join(tmpdir(), 'check-links-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function check(folder) {
  const run = spawnSync(process.execPath, [SCRIPT, join(root, folder)], { encoding: 'utf8' });
  return { code: run.status, out: run.stdout + run.stderr };
}

// Outside every tree under test: a package README with a broken link, as in a real node_modules.
write('elsewhere/node_modules/pkg/README.md', '[docs](/docs/missing.md)\n');
write('elsewhere/other/README.md', '[gone](missing.md)\n');

test('a broken link in our own files is reported', () => {
  write('broken/GUIDE.md', '[ok](GUIDE.md) and [gone](NOWHERE.md)\n');
  const { code, out } = check('broken');
  assert.equal(code, 1);
  assert.match(out, /GUIDE\.md:1: NOWHERE\.md/);
  assert.match(out, /1 markdown file\(s\), 1 broken link\(s\)/);
});

test('a real node_modules folder is skipped', () => {
  write('real/GUIDE.md', '[self](GUIDE.md)\n');
  write('real/node_modules/pkg/README.md', '[docs](/docs/missing.md)\n');
  const { code, out } = check('real');
  assert.equal(code, 0, out);
  assert.match(out, /1 markdown file\(s\), 0 broken link\(s\)/);
});

test('a node_modules symlink is not followed', () => {
  write('linked/GUIDE.md', '[self](GUIDE.md)\n');
  symlinkSync(join(root, 'elsewhere/node_modules'), join(root, 'linked/node_modules'), 'dir');
  const { code, out } = check('linked');
  assert.equal(code, 0, out);
  assert.match(out, /1 markdown file\(s\), 0 broken link\(s\)/);
});

test('no other symlink is followed, to a folder or to a file', () => {
  write('other/GUIDE.md', '[self](GUIDE.md)\n');
  symlinkSync(join(root, 'elsewhere/other'), join(root, 'other/vendor'), 'dir');
  symlinkSync(join(root, 'elsewhere/other/README.md'), join(root, 'other/LINKED.md'), 'file');
  const { code, out } = check('other');
  assert.equal(code, 0, out);
  assert.match(out, /1 markdown file\(s\), 0 broken link\(s\)/);
});
