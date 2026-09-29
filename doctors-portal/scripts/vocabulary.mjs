/**
 * One word per thing, enforced.
 *
 * `VOCABULARY.md` fixes the clinical vocabulary this product speaks. The drift
 * it exists to stop was real and shipped: `Inpatients` in the nav, `My
 * inpatients` as the heading and `Ward` on the tile that opened it — three
 * names for one destination, which a reader noticed before any of us did.
 *
 * This checks only USER-FACING strings. Comments are stripped first, because a
 * comment explaining why a word was rejected must be allowed to contain it.
 *
 * Usage:  node scripts/vocabulary.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Each rule: the banned spelling, what to write instead, and why. */
const BANNED = [
  { find: /\bClinic & Queue\b/g, use: 'OPD', why: 'the nav said one thing and the screen said another' },
  { find: /\bStroke Centre\b/g, use: 'Stroke-AI Console', why: 'the console is the product; the centre is the building' },
  { find: /\bMy inpatients\b/gi, use: 'Inpatients', why: 'the module is Inpatients; possessives drift' },
  { find: /\bIP patients\b/gi, use: 'Inpatients', why: 'an abbreviation plus the word it abbreviates' },
  { find: /\badmitted patients\b/gi, use: 'Inpatients', why: 'Inpatients is the noun staff use' },
  { find: /'Everyone'/g, use: "'All'", why: 'the unfiltered slice of every list is All' },
  { find: />\s*Everyone\s*</g, use: 'All', why: 'the unfiltered slice of every list is All' },
  { find: /\bCasualty\b/g, use: 'ED', why: 'ED is what the beds and the signage say' },
  { find: /\bA&E\b/g, use: 'ED', why: 'ED is what the beds and the signage say' },
  { find: /\bCountersign/g, use: 'Co-sign', why: 'CMP-NABH-03 calls it co-signing' },
  {
    /* "Telemedicine Practice Guidelines 2020" is the statute's own name (MoHFW /
       NMC) and is a proper noun. Only the bare noun is banned. */
    find: /\bTelemedicine\b(?!\s+(Practice\s+)?Guidelines)/g,
    use: 'Telehealth',
    why: 'Telehealth is the module; teleconsult is the encounter',
  },
  { find: /\bUnreviewed\b/g, use: 'To review', why: 'the slice is named by the act, not by its absence' },
  { find: /\bunreviewed\b/g, use: 'to review', why: 'the slice is named by the act, not by its absence' },
  { find: /\bShow all\b/g, use: 'See all (a link) or All … (a filter)', why: 'one phrase for the full list, everywhere' },
  { find: /\bReview all\b/g, use: 'See all', why: 'one phrase for the full list, everywhere' },
  { find: /the whole clinic/g, use: 'all of OPD', why: 'OPD is the word; clinic drifts' },
  { find: /(['"`])Complete\1/g, use: 'Done', why: 'Done / Seen / Signed, per the verb of the screen — never Complete' },
  { find: /label: 'Clinic'/g, use: 'OPD', why: 'OPD is the department; clinic is not a label' },
  { find: /\b[Tt]eleconsultation/g, use: 'teleconsult', why: 'Teleconsult is the encounter; Telehealth is the module' },
  { find: /video appointment/g, use: 'teleconsult', why: 'one word for the encounter' },
  { find: /label="Site"/g, use: 'Facility', why: 'a field that names one of the four facilities says Facility; Site is the stroke network node' },
  { find: /Scan centre/g, use: 'Scanned at', why: 'centre drifts from facility' },
  { find: /Encounter \$\{/g, use: 'Visit record', why: 'Encounter is internal and rarely shown' },
  { find: /(Sign|Attest) & publish/g, use: 'and', why: 'user-facing labels say and, not &' },
  { find: /label: 'Week'/g, use: 'This week', why: 'the same filter reads the same on every screen' },
  { find: /\b(Sign|Attest) and publish\b/g, use: 'Sign / Attest and sign', why: 'doctors sign; publishing is a consequence the confirm dialog states' },
  { find: /Draft from the (visit|round|record)/g, use: 'Draft with AI', why: 'one label for the scribe, everywhere, and it names the AI' },
  { find: /\bRecord again\b/g, use: 'Dictate more / Dictate again', why: 'dictate is the ward word; record suggests a recording is kept' },
  { find: /\bVisit record\b/g, use: 'OP number / IP number', why: 'the number staff quote' },
  { find: /\bTo finish today\b/g, use: 'Tasks (in Needs Action)', why: 'one name for what is the doctor\'s to close' },
  { find: /\bComplete the assessment\b/g, use: 'Sign assessment', why: 'it is signed, and Complete is banned as a status' },
  { find: /\bNothing in the way\b/g, use: 'Cleared for discharge', why: 'what the board says' },
  { find: /\bDictate the [a-z ]+\b(?=<)/g, use: 'Dictate', why: 'the label above already names the section' },
]

/**
 * Every screen has ONE name, in sentence case, and the heading shows it. A
 * Title Case registry name beside a sentence-case heading is the drift the
 * vocabulary exists to stop.
 */
const NAME_ALLOW = new Set([
  'OPD', 'ICU', 'ED', 'AI', 'CT', 'MLC', 'ADR', 'NABH', 'ABDM', 'MCCD', 'CPOE', 'OT', 'NIHSS', 'ASPECTS', 'EVT', 'DIDO',
  'PvPI', 'mRS-90',
])
const NAME_EXCEPTIONS = new Set(['My Day', 'Stroke-AI Console'])
function sentenceCase(name) {
  if (NAME_EXCEPTIONS.has(name)) return true
  const words = name.split(' ')
  if (!/^[A-Z0-9]/.test(words[0])) return false
  return words.slice(1).every((w) => NAME_ALLOW.has(w) || w === w.toLowerCase())
}
const badNames = []
for (const m of readFileSync('src/atlas/registry.ts', 'utf8').matchAll(/^\s*name: '([^']+)',/gm)) {
  if (!sentenceCase(m[1])) badNames.push(m[1])
}

/** Strips comments and import lines so only rendered text is checked. */
function userFacing(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|import |export \* |export \{)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(path) && !path.endsWith('.generated.ts')) out.push(path)
  }
  return out
}

const hits = []
for (const file of walk('src')) {
  const text = userFacing(readFileSync(file, 'utf8'))
  const lines = text.split('\n')
  for (const rule of BANNED) {
    lines.forEach((line, i) => {
      rule.find.lastIndex = 0
      if (rule.find.test(line)) {
        hits.push({ file, line: i + 1, found: line.trim().slice(0, 90), use: rule.use, why: rule.why })
      }
    })
  }
}

console.log(`${BANNED.length} vocabulary rules checked across the source`)
if (badNames.length > 0) {
  console.log(`  registry screen names not in sentence case: ${badNames.map((n) => `"${n}"`).join(', ')}`)
  process.exit(1)
}
if (hits.length === 0) {
  console.log('OK: no banned term in a user-facing string')
  process.exit(0)
}
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}\n     write "${h.use}" — ${h.why}\n     ${h.found}`)
}
console.log(`\n---- ${hits.length} banned term${hits.length === 1 ? '' : 's'} ----`)
process.exit(1)
