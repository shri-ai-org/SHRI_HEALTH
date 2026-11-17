/**
 * SHRI_HEALTH: proves a real-API build carries none of the sample screens' imported scans (D12:
 * synthetic data only; D75: licences): no CQ500 case and none of the open datasets' source links.
 * vite.config.ts resolves src/data/imaging.generated.ts and ncct.generated.ts to empty stand-ins
 * for the real API; this reads what a build wrote and fails if anything slipped through.
 *
 * Usage:  node scripts/check-bundle.mjs [dir]     (default: dist; `npm run build` runs it)
 * Exit 0 when clean, 1 with each file and term when not. A sample-mode build (SHRI_API=mock) still
 * carries the sample screens' data and their credits by design, so it is not checked.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.SHRI_API === 'mock') {
  console.log('Sample-mode build (SHRI_API=mock): not checked; it carries the sample screens by design.')
  process.exit(0)
}

const FORBIDDEN = ['CQ500', 'cancerimagingarchive.net', 'qure.ai', 'commons.wikimedia.org', 'zenodo.org', 'data.mendeley.com']
const TEXT = /\.(js|mjs|css|html|json|txt|map|svg)$/

const root = process.argv[2] ?? 'dist'
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? files(path) : [path]
})

const found = []
for (const file of files(root)) {
  if (!TEXT.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const term of FORBIDDEN) if (text.includes(term)) found.push(`${file}: ${term}`)
}

if (found.length > 0) {
  console.error(`The build in ${root} carries the sample screens' imported scans (D12, D75):\n${found.join('\n')}`)
  process.exit(1)
}
console.log(`${root}: no CQ500 case and no open-dataset source link`)
