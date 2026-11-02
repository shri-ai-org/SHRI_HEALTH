/**
 * The speech service end to end, with real speech and nothing stubbed: Chrome is
 * given a WAV as its microphone, the To-do mic streams it to the running service
 * (backend/app.py), and the English that lands in the box is printed with when it
 * arrived. For checking the model on real audio — not part of the flows, which use
 * the mock.
 *
 * Usage:
 *   BASE=http://localhost:5181 ASR=ws://127.0.0.1:8765/ws/transcribe WAV=clip.wav SECONDS=14 node scripts/asr-e2e.mjs
 *   (ASR=default uses the build's own address instead)
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:5181'
const ASR = process.env.ASR ?? 'ws://127.0.0.1:8765/ws/transcribe'
const WAV = process.env.WAV
const SECONDS = Number(process.env.SECONDS ?? 14)
const PORT = 9433
if (!WAV) throw new Error('WAV= a 16 kHz mono WAV to speak')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  ['--headless=new', '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'asr-e2e-'))}`, 'about:blank'],
  { stdio: 'ignore' },
)
process.on('exit', () => chrome.kill('SIGKILL'))

let target
for (let i = 0; i < 50 && !target; i += 1) {
  await sleep(200)
  target = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) pending.get(m.id)(m.result)
}
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value

await send('Page.navigate', { url: `${BASE}/` })
await sleep(2500)
// ASR=default leaves the address to the build (a dev server's own default), to check that path too.
if (ASR !== 'default') await evaluate(`localStorage.setItem('shri.asrUrl', ${JSON.stringify(ASR)}); true`)
await send('Page.reload')
// A deployed page can take longer than a dev server to load: wait for the mic, not a fixed time.
for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('button[aria-label="Dictate a to-do note"]')`)); i += 1) await sleep(200)
if (!(await evaluate(`!!document.querySelector('button[aria-label="Dictate a to-do note"]')`))) throw new Error(`no To-do mic on ${BASE}/`)
await evaluate(`document.querySelector('button[aria-label="Dictate a to-do note"]').click(); true`)
const t0 = Date.now()
let last = ''
while (Date.now() - t0 < SECONDS * 1000) {
  const v = await evaluate(`document.querySelector('#dictation-draft')?.value ?? ''`)
  const status = await evaluate(`[...document.querySelectorAll('[role="dialog"] *')].map((e) => e.childNodes.length === 1 && e.textContent).filter((t) => t === 'Listening…' || t === 'Processing…')[0] ?? ''`)
  if (v !== last) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  [${status}]  ${v}`)
    last = v
  }
  await sleep(250)
}
await evaluate(`document.querySelector('[role="dialog"] button[aria-label="Stop recording"]')?.click(); true`)
const stopAt = Date.now()
let steady = 0
for (let i = 0; i < 80; i += 1) {
  await sleep(250)
  const v = await evaluate(`document.querySelector('#dictation-draft')?.value ?? ''`)
  const processing = await evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('Processing…')`)
  if (v !== last) {
    console.log(`after Stop +${((Date.now() - stopAt) / 1000).toFixed(1)}s  ${v}`)
    last = v
    steady = 0
  } else steady += 1
  // Done once processing has ended and the typing has caught up (the text held for a second).
  if (!processing && steady >= 4) break
}
console.log(`\nFINAL: ${last}`)
process.exit(0)
