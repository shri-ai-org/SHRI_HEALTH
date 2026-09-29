/**
 * Every suggested prompt must actually resolve to an answer.
 *
 * The assistant offers 3–4 screen-specific questions because "a blank chat box
 * on a clinical screen gets no use". But matching is substring-based, so a
 * prompt whose wording drifts from its entry's `match` list silently starts
 * returning "I have nothing on that" — the product then ships a suggestion
 * that answers nothing, which is worse than offering none. Nothing else in the
 * build catches it.
 *
 * The resolver is a module, not an endpoint, so this runs it inside the page
 * through the DEV-only `window.__rag` hook in `src/e2e.ts`.
 *
 * Usage:  npm run dev    # in another terminal
 *         node scripts/rag-audit.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const PORT = 9377
const profile = mkdtempSync(join(tmpdir(), 'rag-'))
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((p) => p.type === 'page')
      if (pages[0]) return pages[0].webSocketDebuggerUrl
    } catch {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error('no debugging target')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `${BASE}/clinician?e2e=1` })
await sleep(2200)

const ready = await evaluate('Boolean(window.__rag)')
if (!ready) {
  console.error('FAIL: window.__rag is absent — is the dev server running on ' + BASE + '?')
  ws.close()
  chrome.kill()
  process.exit(2)
}

/**
 * Resolve every prompt under its own screen's context. A prompt is allowed to
 * land on a non-cited outcome only if it is deliberately demonstrating one —
 * those live in the dev rail, not in the suggestion list.
 */
const report = await evaluate(`
  (() => {
    const { resolveAnswer, screenPrompts } = window.__rag
    const rows = []
    for (const [screenId, prompts] of Object.entries(screenPrompts)) {
      for (const text of prompts) {
        const a = resolveAnswer(text, { screenId, patientScoped: false })
        rows.push({
          screenId,
          text,
          kind: a.kind,
          citations: a.citations.length,
          attest: Boolean(a.attest),
        })
      }
    }
    return rows
  })()
`)

const bad = report.filter((r) => r.kind !== 'cited' || r.citations === 0)
const screens = new Set(report.map((r) => r.screenId))
const attesting = report.filter((r) => r.attest)

console.log(`${report.length} suggested prompts across ${screens.size} screens`)
console.log(`${attesting.length} resolve to a reading that needs a signature`)

for (const r of bad) {
  console.log(`  MISS  ${r.screenId}  "${r.text}"  → ${r.kind}${r.citations === 0 ? ' · no citations' : ''}`)
}

console.log(
  bad.length === 0
    ? '\nOK: every suggested prompt resolves to a cited answer on its own screen'
    : `\n---- ${bad.length} suggested prompt${bad.length === 1 ? '' : 's'} answer nothing ----`,
)

/**
 * The bubble's own list, which is composed rather than static: per screen, per
 * patient in context, per session. Walk every bubble screen with every patient
 * it could name (and with none, for a route that names nobody), under a plain
 * session, a stroke persona's, and sessions that have just signed a note and
 * just requested an admission. Each list must hold 1 to the cap, repeat no
 * answer, and resolve every entry to a cited answer in the same context.
 */
const composed = await evaluate(`
  (() => {
    const { resolveAnswer, suggestionsFor, maxSuggestions, bubbleScreens, patientIds } = window.__rag
    const base = { persona: 'P-04', acknowledgements: {}, seenAt: {}, admissions: {}, breakGlass: {} }
    const admission = {
      id: 'ADM-audit', patientId: 'SD-P-01', type: 'ward', priority: 'urgent',
      requestedBy: 'Dr. Ananya Iyer', requestedById: 'audit', requestedAt: Date.now(),
    }
    const sessions = {
      plain: base,
      stroke: { ...base, persona: 'P-35' },
      signed: { ...base, recent: { event: 'NOTE.SIGNED', subject: 'SD-P-03' } },
      admitted: { ...base, admissions: { 'SD-P-01': admission }, recent: { event: 'ADMISSION.REQUESTED', subject: 'SD-P-01' } },
    }
    const rows = []
    for (const s of bubbleScreens) {
      const patients = s.patientScoped ? [undefined, ...patientIds] : [undefined]
      for (const patientId of patients) {
        for (const [session, live] of Object.entries(sessions)) {
          const ctx = { screenId: s.id, patientId, patientScoped: Boolean(patientId), live }
          const list = suggestionsFor(ctx)
          const answers = list.map((text) => resolveAnswer(text, ctx))
          const problems = []
          if (list.length === 0) problems.push('no suggestions')
          if (list.length > maxSuggestions) problems.push(list.length + ' suggestions')
          if (new Set(answers.map((a) => a.body)).size !== answers.length) problems.push('repeats an answer')
          answers.forEach((a, i) => {
            if (a.kind !== 'cited' || a.citations.length === 0) problems.push('"' + list[i] + '" → ' + a.kind)
            if (a.about && patientId && a.about !== patientId) problems.push('"' + list[i] + '" is about ' + a.about)
          })
          rows.push({ screenId: s.id, patientId: patientId ?? '—', session, list, problems })
        }
      }
    }
    return rows
  })()
`)

const failing = composed.filter((r) => r.problems.length > 0)
const fixed = new Set(report.map((r) => r.text))
const personalised = composed.filter((r) => r.patientId !== '—' && r.list.some((t) => !fixed.has(t)))
console.log(`\n${composed.length} composed suggestion lists (screen × patient × session)`)
console.log(`${personalised.length} of them carry a question read from the patient's record`)
for (const r of failing.slice(0, 40)) {
  console.log(`  FAIL  ${r.screenId}  ${r.patientId}  ${r.session}  ${r.problems.join(' · ')}`)
}
if (failing.length > 40) console.log(`  …and ${failing.length - 40} more`)
console.log(
  failing.length === 0
    ? 'OK: every composed list is 1–4 cited, distinct answers'
    : `---- ${failing.length} composed list${failing.length === 1 ? '' : 's'} fail ----`,
)

ws.close()
chrome.kill()
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
} catch {
  /* Chrome is still flushing; the OS will reap /tmp. */
}
process.exit(bad.length === 0 && failing.length === 0 ? 0 : 1)
