/**
 * Every icon name used in the source must exist in the registry.
 *
 * `Icon` renders nothing for an unknown name rather than throwing, which is the
 * right runtime behaviour and the wrong build behaviour: the night-theme toggle
 * shipped as an invisible button because `Sun` was never registered. This turns
 * that silence into a failing check.
 *
 * Usage: node scripts/icon-audit.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const registry = readFileSync('src/components/icons.ts', 'utf8')
/** The ICONS map body — the names actually reachable by string lookup. */
const mapBody = registry.slice(registry.indexOf('ICONS'))
const registered = new Set([...mapBody.matchAll(/^\s{2}([A-Z][A-Za-z0-9]*),$/gm)].map((m) => m[1]))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

const used = new Map()
for (const file of walk('src')) {
  if (file.endsWith('icons.ts')) continue
  const src = readFileSync(file, 'utf8')
  /*
   * `icon="Name"`, `icon={'Name'}` and `icon: 'Name'`. Deliberately NOT `name:`
   * — gates, personas and capabilities all carry a human-readable `name`, and
   * matching it reported "Radiologist" as a missing icon.
   */
  for (const m of src.matchAll(/\bicon\s*[=:]\s*\{?\s*'([A-Z][A-Za-z0-9]*)'/g)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
  for (const m of src.matchAll(/\bicon="([A-Z][A-Za-z0-9]*)"/g)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
}

const missing = [...used].filter(([n]) => !registered.has(n))
console.log(`${registered.size} icons registered · ${used.size} referenced by name`)
if (missing.length === 0) {
  console.log('OK: every referenced icon exists in the registry')
  process.exit(0)
}
for (const [name, file] of missing) console.log(`MISSING  ${name.padEnd(20)} first used in ${file}`)
process.exit(1)
