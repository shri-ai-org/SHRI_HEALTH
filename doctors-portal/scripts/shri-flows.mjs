/**
 * Flow checks for the Shri Health build — the behaviours the old build's
 * `acceptance.mjs` asserted, re-asserted against this build's DOM (which is
 * why that script cannot simply be pointed here: it looks for the old ids and
 * class names). Each flow drives the page the way a user would — clicks, keys,
 * reloads — and states what it expects in the old build's own copy.
 *
 * Runs against the DEV server (the `?e2e=1` / `window.__forceState` hooks are
 * DEV-only), at 1440×1000 unless a flow says otherwise.
 *
 * Usage:  npm run dev
 *         node scripts/shri-flows.mjs
 * Env:    BASE   http://localhost:5180
 *         ONLY   comma-separated substrings of flow names to run
 *         CDP_PORT  Chrome's debugging port (default 9399), so runs can go side by side
 *
 * Module flows live in scripts/shri-flows/<module>.mjs (see the loader below).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim().toLowerCase())
const PORT = Number(process.env.CDP_PORT ?? 9399)

const profile = mkdtempSync(join(tmpdir(), 'shri-flows-'))
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

/* The headless profile is this run's alone: it goes when the run does, however the run ends. */
process.on('exit', () => {
  try {
    chrome.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  // A dying Chrome writes into its profile for a moment after the kill, so the
  // profile is removed by a detached shell once Chrome is certainly gone.
  spawn('sh', ['-c', `sleep 3; rm -rf "${profile}"`], { detached: true, stdio: 'ignore' }).unref()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A DevTools connection: one socket, its own request ids, the events it hears. */
async function connect(url, onEvent) {
  const sock = new WebSocket(url)
  await new Promise((r) => sock.addEventListener('open', r))
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method) onEvent?.(m)
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 20_000)
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
      sock.send(JSON.stringify({ id, method, params }))
    })
  return { sock, call }
}

async function browserUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('no debugging target')
}

const browser = await connect(await browserUrl())
let consoleErrors = []
/** The current flow's page. */
let tab = null

/**
 * Every flow gets a browser context of its own — its own storage, cookies and
 * connection pool — so a page one flow leaves stuck (a hung request holding the
 * host's six sockets, say) cannot stall the flows after it.
 */
async function freshTab() {
  if (tab) {
    tab.sock.close()
    await browser.call('Target.disposeBrowserContext', { browserContextId: tab.context }).catch(() => {})
  }
  const { browserContextId } = await browser.call('Target.createBrowserContext', {})
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId, width: 1440, height: 1000 })
  const conn = await connect(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`, (m) => {
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })
  tab = { ...conn, context: browserContextId }
  await tab.call('Page.enable')
  await tab.call('Runtime.enable')
}

const send = (method, params = {}) => tab.call(method, params)

/* ------------------------------------------------------------ page helpers */

const page = {
  /**
   * Runs one of this file's own fixed expressions inside the headless test page
   * over the DevTools Protocol (`Runtime.evaluate`), as the other audit scripts
   * do. No outside input ever reaches it.
   */
  async evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  },
  /**
   * Loads a path with a clean slate: storage cleared, then the old build's
   * session written the way its harness writes it — signed in (unless
   * `signedIn: false`), optionally as another persona.
   */
  async open(path, { fresh = true, signedIn = true, persona } = {}) {
    if (fresh) {
      await send('Page.navigate', { url: `${BASE}/login` })
      await sleep(300)
      const session = { state: { signedIn, ...(persona ? { persona } : {}) }, version: 2 }
      await this.evaluate(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('indostates.session', ${JSON.stringify(JSON.stringify(session))}); true`).catch(() => {})
    }
    await send('Page.navigate', { url: `${BASE}${path}` })
    await this.until(`(document.querySelector('.shri-root')?.textContent ?? '').trim().length > 40`, 8000, `${path} rendered`)
    await sleep(300)
  },
  /** Focuses a field and types into it the way a keyboard would (React sees real input events). */
  async type(selector, text) {
    const ok = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true })()`)
    if (!ok) throw new Error(`nothing to type into: ${selector}`)
    await send('Input.insertText', { text })
    await sleep(80)
  },
  async reload() {
    await send('Page.reload')
    await sleep(400)
    await this.until(`(document.querySelector('.shri-root')?.textContent ?? '').trim().length > 40`, 8000, 'reloaded page rendered')
  },
  async until(expression, ms = 4000, what = expression) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await this.evaluate(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for: ${what}`)
  },
  /** Clicks the centre of the first element matching `selector` (optionally whose text includes `text`). */
  async click(selector, text) {
    const box = await this.evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      const el = ${text ? `els.find((e) => (e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)}))` : 'els[0]'}
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!box) throw new Error(`nothing to click: ${selector}${text ? ` "${text}"` : ''}`)
    await sleep(80)
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(250)
  },
  async key(key) {
    // Navigation keys need their virtual key code, or Chrome never delivers them to the page.
    const vk = { Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key]
    const extra = vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, ...extra })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, ...extra })
    await sleep(150)
  },
  text: () => page.evaluate(`document.querySelector('.shri-root')?.innerText ?? ''`),
  path: () => page.evaluate('location.pathname + location.search'),
}

function expect(ok, message) {
  if (!ok) throw new Error(message)
}

/* ------------------------------------------------------------------ flows */

/**
 * A stand-in for the browser's recogniser and microphone, installed before the
 * page's own scripts: `window.__say(text, confidence)` delivers one final
 * result the way Chrome does (the running list, the new one last), so a take
 * can be driven without a person speaking. `speech: false` removes the
 * recogniser instead, as Firefox has none.
 */
async function stubSpeech({ speech = true } = {}) {
  const source = speech
    ? `(() => {
        const results = []
        class FakeRecognition {
          constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this.onresult = null; this.onerror = null; this.onend = null; window.__sr = this }
          start() { window.__srStarts = (window.__srStarts || 0) + 1; window.__srLang = this.lang }
          stop() { this.onend && this.onend() }
          abort() {}
        }
        window.SpeechRecognition = FakeRecognition
        window.webkitSpeechRecognition = FakeRecognition
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
        window.__say = (text, confidence) => {
          const r = [{ transcript: text, confidence }]
          r.isFinal = true
          results.push(r)
          window.__sr.onresult({ resultIndex: results.length - 1, results })
        }
      })()`
    : `(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.webkitSpeechRecognition = undefined; window.SpeechRecognition = undefined })()`
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source })
  return () => send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
}

/** The old build's audit trail, as its store persists it. */
const auditRows = () => page.evaluate(`JSON.parse(localStorage.getItem('indostates.audit') ?? '{"state":{"rows":[]}}').state.rows`)
/** Text of the open Quick-Panel (textContent: section labels are uppercased by CSS, which innerText would report). */
const panelText = () => page.evaluate(`document.querySelector('aside[role="dialog"]')?.textContent ?? ''`)
const attentionNames = () => page.evaluate(`[...document.querySelectorAll('section[aria-label="Attention"] li > button:first-child')].map((b) => b.getAttribute('aria-label'))`)
const toastSays = (title, detail) =>
  page.until(
    `[...document.querySelectorAll('[role="status"]')].some((r) => r.textContent.includes(${JSON.stringify(title)})${detail ? ` && r.textContent.includes(${JSON.stringify(detail)})` : ''})`,
    3000,
    `the toast "${title}"${detail ? ` / "${detail}"` : ''}`,
  )

/** Chooses an option in a <select> the way a person would, so React sees the change. */
const pick = (selector, value) =>
  page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('no select: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)

/** Signs in as another persona without clearing the session's records — the same browser, handed to a colleague. */
const becomePersona = (persona) =>
  page.evaluate(`(() => { const s = JSON.parse(localStorage.getItem('indostates.session')); s.state.persona = ${JSON.stringify(persona)}; localStorage.setItem('indostates.session', JSON.stringify(s)); return true })()`)

/** A registrar writes a note on an encounter and saves it for co-sign (S-06-03). */
async function saveForCoSign(encounterId, code) {
  const texts = { subjective: 'Breathless overnight, now settled.', objective: 'Pulse 96 regular, saturation 95% on air.', assessment: 'Improving on the current plan today.', plan: 'Continue treatment and review in the morning.' }
  for (const [key, words] of Object.entries(texts)) await page.type(`[id="${encounterId}:${key}"]`, words)
  await page.click('button', code)
  await page.click('button', 'Save for co-sign')
  await page.click('[role="alertdialog"] button', 'Save for co-sign')
  await toastSays('Saved for co-sign')
}

/** Sets an <input>'s value the way typing would end, so React sees the change (a date field, say). */
const setInput = (selector, value) =>
  page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('no input: ' + ${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)

/** The prescription's primary action, wherever the bar puts it. */
const SIGN_RX = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign prescription')`

const railLabels = () => page.evaluate(`[...document.querySelectorAll('nav[aria-label="Main"] a, nav[aria-label="Main"] button')].map((e) => e.getAttribute('aria-label')).filter(Boolean)`)

const FLOWS = [
  {
    name: 'My Day: the old greeting on the old clock, and counts from the old data — no forecast',
    async run() {
      await page.open('/')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-01"]')`), 'S-06-01 is drawn')
      const text = await page.text()
      for (const t of ['Good morning, Dr. Iyer', 'Mon 21-Sep-2026 · General Medicine · Indostates Health Hospital, Coimbatore'])
        expect(text.includes(t), `greeting line "${t}"`)
      const critical = await page.evaluate(`document.querySelector('[data-kpi="critical"]').textContent`)
      expect(critical.includes('Serum potassium 6.8 mmol/L · Mathew'), `the critical KPI names the unacknowledged result: ${critical}`)
      expect(!/predicted|projected/i.test(text), 'no forecast anywhere on My Day')
      const names = await attentionNames()
      expect(names[0] === 'critical: Critical lab report identified, Joseph Mathew', `AI-613 ranks the critical first: ${names}`)
    },
  },
  {
    name: 'My Day: Attention opens the Quick-Panel on what changed; Mark seen clears it and is audited',
    async run() {
      await page.open('/')
      await page.click('section[aria-label="Attention"] li > button')
      await page.until(`document.querySelector('aside[role="dialog"][aria-label="Joseph Mathew"]')`, 3000, 'the Quick-Panel on Joseph Mathew')
      const text = await panelText()
      for (const t of ['71/M · ICU-1 · ICH-0043910', 'You last saw Mathew at 07:30', 'Changed since then', 'Serum potassium 6.8 mmol/L', 'Audit — 0 events', 'AI-212'])
        expect(text.includes(t), `the panel says "${t}"`)
      await page.click('aside[role="dialog"] button', 'Mark seen')
      await toastSays('Marked seen', 'Joseph Mathew · changes cleared')
      expect(await page.evaluate(`[...document.querySelectorAll('aside[role="dialog"] button')].some((b) => b.textContent.trim() === 'Seen' && b.disabled)`), 'Seen, and not again')
      const row = (await auditRows()).find((r) => r.event === 'PATIENT.MARKED_SEEN')
      expect(row && row.subject === 'SD-P-07' && row.actor === 'Dr. Ananya Iyer' && /changes cleared/.test(row.detail), `the audit row: ${JSON.stringify(row)}`)
      await page.click('aside[role="dialog"] button', 'Audit — 1 event')
      expect((await panelText()).includes('Marked seen · Dr. Ananya Iyer'), 'the trail is readable in the panel')
      await page.key('Escape')
      await page.until(`!document.querySelector('aside[role="dialog"]')`, 3000, 'Esc closed the panel')
      expect(!(await attentionNames()).some((n) => n.includes('Joseph Mathew')), 'a patient marked seen drops off Attention')
      await page.reload()
      expect(!(await attentionNames()).some((n) => n.includes('Joseph Mathew')), 'and stays off after a reload')
    },
  },
  {
    name: 'My Day: offline, Mark seen queues and says so; back online the queue syncs with a toast',
    async run() {
      await page.open('/?state=OFFLINE')
      expect((await page.text()).includes('0 changes waiting to sync'), 'the offline strip counts the real queue')
      await page.click('section[aria-label="Attention"] li > button')
      await page.click('aside[role="dialog"] button', 'Mark seen')
      await toastSays('Queued — you are offline', 'Joseph Mathew will sync when the connection returns. Nothing is lost.')
      expect((await panelText()).includes('1 mark-seen queued for sync'), 'the panel shows the queued mark')
      expect((await page.text()).includes('1 changes waiting to sync'), 'the strip counts it')
      expect((await auditRows()).some((r) => r.event === 'PATIENT.MARKED_SEEN' && r.queued && r.detail === 'Queued — device offline'), 'audited as queued')
      await page.evaluate(`window.__forceState(null)`)
      await toastSays('1 queued update synced', 'Nothing was lost while you were offline.')
      expect(!(await panelText()).includes('queued for sync'), 'the queue is empty once synced')
    },
  },
  {
    name: 'My Day: the Critical KPI counts unacknowledged results — marking the patient seen does not acknowledge one',
    async run() {
      await page.open('/')
      await page.click('[data-kpi="critical"]')
      await page.until(`document.querySelector('aside[role="dialog"][aria-label="Joseph Mathew"]')`, 3000, 'the Quick-Panel on the critical patient')
      expect((await panelText()).includes('Critical lab report identified'), 'with the attention reason')
      await page.click('aside[role="dialog"] button', 'Mark seen')
      await page.key('Escape')
      const kpi = await page.evaluate(`document.querySelector('[data-kpi="critical"]').textContent`)
      expect(kpi.startsWith('1') && kpi.includes('Serum potassium 6.8 mmol/L · Mathew'), `still one critical, still named: ${kpi}`)
      expect(await page.evaluate(`!!document.querySelector('nav[aria-label="Main"] a[aria-label="Results, critical results waiting"]')`), 'and the rail still says so')
      await page.click('[data-kpi="critical"]')
      await page.until(`document.querySelector('aside[role="dialog"][aria-label="Joseph Mathew"]')`, 3000, 'the KPI still opens it')
    },
  },
  {
    name: "My Day: Why? opens the old four panels over the Quick-Panel; Esc closes only the drawer",
    async run() {
      await page.open('/')
      await page.click('section[aria-label="Attention"] li > button')
      await page.click('aside[role="dialog"] button', 'Why?')
      await page.until(`document.querySelector('[role="dialog"][aria-label="Why this was suggested"]')`, 3000, 'the explain drawer')
      const text = await page.evaluate(`document.querySelector('[role="dialog"][aria-label="Why this was suggested"]').textContent`)
      for (const t of ['What this is', 'What it used', 'Why', 'Limits & provenance', 'AI-212', 'This is decision support. It is not a diagnosis.'])
        expect(text.includes(t), `the drawer says "${t}"`)
      await page.key('Escape')
      await page.until(`!document.querySelector('[role="dialog"][aria-label="Why this was suggested"]')`, 3000, 'Esc closed the drawer')
      expect(await page.evaluate(`!!document.querySelector('aside[role="dialog"][aria-label="Joseph Mathew"]')`), 'the Quick-Panel under it stayed open')
      await page.key('Escape')
      await page.until(`!document.querySelector('aside[role="dialog"]')`, 3000, 'a second Esc closed the Quick-Panel')
    },
  },
  {
    name: 'My Day: to-do notes — type one, tick it, delete it, in the old words, audited',
    async run() {
      await page.open('/')
      expect((await page.text()).includes('Nothing noted for today yet. Dictate one with the microphone, or type one with +.'), 'the empty copy')
      await page.click('button[aria-label="Type a to-do note"]')
      await page.until(`document.querySelector('[role="dialog"][aria-label="To-do note"]')`, 3000, 'the to-do note dialog')
      await page.type('[role="dialog"] textarea[aria-label="Your note"]', 'Call the lab about the repeat potassium')
      await page.click('[role="dialog"] button', 'Save')
      await toastSays('To-do note saved', 'On My Day, under To-do notes')
      const saved = (await auditRows()).find((r) => r.event === 'NOTE.DRAFT_SAVED')
      expect(saved && saved.gate === 'G2' && saved.model === 'Typed — no speech recognition' && saved.detail === 'Typed note saved · 7 words', `NOTE.DRAFT_SAVED: ${JSON.stringify(saved)}`)
      expect(!(await auditRows()).some((r) => r.event === 'AI.SCRIBE.TRANSCRIPT_CREATED'), 'typed, so no transcript row')
      await page.click('[role="checkbox"][aria-label^="Mark as done: Call the lab"]')
      await page.until(`document.querySelector('[role="checkbox"][aria-label^="Mark as not done: Call the lab"]')?.getAttribute('aria-checked') === 'true'`, 3000, 'ticked')
      expect((await page.text()).includes('All done'), 'the header says all done')
      await page.click('button[aria-label="Delete this to-do note"]')
      await toastSays('To-do note deleted', '“Call the lab about the repeat potassium”')
    },
  },
  {
    name: "My Day: a typed note on a patient saves as that patient's unsigned draft and becomes the last note",
    async run() {
      await page.open('/?open=note:SD-P-07')
      await page.until(`document.querySelector('[role="dialog"][aria-label="Add note · Joseph Mathew"]')`, 3000, 'the note dialog, named for the patient')
      expect(await page.evaluate(`document.querySelector('[role="dialog"] button[title="Dictate or type the note first"]')?.disabled === true`), 'Save waits for words')
      await page.type('[role="dialog"] textarea[aria-label="Your note"]', 'Repeat potassium after insulin-dextrose')
      await page.click('[role="dialog"] button', 'Save')
      await toastSays('Note saved as a draft', 'Joseph Mathew · not signed')
      const saved = (await auditRows()).find((r) => r.event === 'NOTE.DRAFT_SAVED')
      expect(saved && saved.subject === 'SD-P-07', `audited against the patient: ${JSON.stringify(saved)}`)
      await page.click('section[aria-label="Attention"] li > button')
      const text = await panelText()
      expect(text.includes('Dictated note · draft') && text.includes('Repeat potassium after insulin-dextrose') && text.includes('1 dictated'), `the last note is the draft: ${text.slice(0, 400)}`)
    },
  },
  {
    name: 'Dictation: a take is written into the box as spoken, audited once, and saved with its engine and band',
    async run() {
      const unstub = await stubSpeech()
      try {
        await page.open('/')
        await page.click('button[aria-label="Add note about Joseph Mathew"]')
        await page.until(`window.__srStarts === 1`, 3000, 'the attention mic opens the note already listening')
        expect((await page.evaluate('window.__srLang')) === 'en-IN', 'the recogniser listens in the session language')
        expect(await page.evaluate(`document.querySelector('#dictation-draft').readOnly`), 'the box is read-only while it listens')
        await page.evaluate(`window.__say('repeat potassium at noon', 0.93)`)
        await page.until(`document.querySelector('#dictation-draft').value === 'repeat potassium at noon'`, 3000, 'the words land in the box as spoken')
        await page.click('[role="dialog"] button[aria-label="Stop recording"]')
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes('Dictated · live · Web Speech API · Chrome · en-IN')`, 3000, 'the provenance line names the engine')
        const scribe = (await auditRows()).filter((r) => r.event === 'AI.SCRIBE.TRANSCRIPT_CREATED')
        expect(scribe.length === 1 && scribe[0].detail === '4 words · live recognition · HIGH' && scribe[0].gate === 'G2' && scribe[0].subject === 'SD-P-07', `one transcript row: ${JSON.stringify(scribe)}`)
        await page.type('#dictation-draft', ' today')
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes('edited by you')`, 3000, 'an edit after the take is said')
        await page.click('[role="dialog"] button', 'Save')
        await toastSays('Note saved as a draft', 'Joseph Mathew · not signed')
        const saved = (await auditRows()).find((r) => r.event === 'NOTE.DRAFT_SAVED')
        expect(
          saved && saved.model === 'Web Speech API · Chrome · en-IN' && saved.detail === 'Dictated note saved after manual edit · 5 words',
          `NOTE.DRAFT_SAVED: ${JSON.stringify(saved)}`,
        )
        const notes = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.clinical')).state.voiceNotes['SD-P-07']`)
        expect(notes.length === 1 && notes[0].band === 'HIGH' && notes[0].status === 'draft' && notes[0].body === 'repeat potassium at noon today', `the draft: ${JSON.stringify(notes)}`)
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Dictation: where the browser cannot listen, the note says why, has no mic, and still types',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/')
        await page.click('button[aria-label="Dictate a to-do note"]')
        await page.until(`document.querySelector('[role="dialog"][aria-label="To-do note"]')`, 3000, 'the to-do dialog')
        const text = await page.evaluate(`document.querySelector('[role="dialog"]').textContent`)
        expect(text.includes('This browser can’t turn speech into text. Use Chrome, Edge or Safari — or type instead.'), `the old notice: ${text.slice(0, 300)}`)
        expect(await page.evaluate(`![...document.querySelectorAll('[role="dialog"] button')].some((b) => /^Dictate/.test(b.textContent.trim()))`), 'no microphone to press — absent, not greyed')
        expect((await page.evaluate(`document.querySelector('#dictation-draft').placeholder`)) === 'Type the note…', 'the typing placeholder')
        await page.type('#dictation-draft', 'Chase the echo report')
        await page.click('[role="dialog"] button', 'Save')
        await toastSays('To-do note saved', 'On My Day, under To-do notes')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'VoiceField: the admit note takes a new sentence per take, is read before signing, offers no tidy-up, and hides its mic with AI off',
    async run() {
      const unstub = await stubSpeech()
      const note = `document.querySelector('#admit-note-SD-P-01').value`
      try {
        await page.open('/patient/ICH-0044120?open=admit:SD-P-01')
        await page.until(`document.querySelector('#admit-note-SD-P-01')`, 3000, 'the admit note field')
        await page.type('#admit-note-SD-P-01', 'start amlodipine 5 mg OD')
        expect(!(await page.text()).includes('Tidy up with AI'), 'the admit note offers no tidy-up (the old tidy={false})')
        await page.click('button[aria-label="Dictate into note (optional)"]')
        await page.until(`window.__srStarts === 1`, 3000, 'the field listens')
        await page.evaluate(`window.__say('observe on the ward', 0)`)
        await page.until(`${note} === 'start amlodipine 5 mg OD. observe on the ward'`, 3000, 'a take joins the text as a new sentence')
        await page.click('button[aria-label="Stop recording"]')
        await page.until(`document.body.textContent.includes('Dictated · live')`, 3000, 'the provenance line')
        await page.click('[role="dialog"] button', 'Why?')
        await page.until(`document.querySelector('[role="dialog"][aria-label="Why this was suggested"]')?.textContent.includes('read it before signing')`, 3000, "a form's Why says it is read before signing")
      } finally {
        await unstub()
      }
      await page.open('/patient/ICH-0044120?open=admit:SD-P-01&ai=off')
      expect(await page.evaluate(`!document.querySelector('button[aria-label="Dictate into note (optional)"]') && !!document.querySelector('#admit-note-SD-P-01')`), 'AI off: the mic is absent, the box stays')
    },
  },
  {
    name: "Record: the overview on the old data — GP-05's banner, the parts with their counts, the cards; an unknown id says so",
    async run() {
      await page.open('/patient/ICH-0044051')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-11"]')`), 'S-06-11 is drawn')
      const banner = await page.evaluate(`document.querySelector('[aria-label="Patient"]').textContent.replace(/\\u00a0/g, ' ')`)
      for (const t of ['R. Lakshmanan', '62/M', 'ICH-0044051 · 4B-12 · LOS 4d · Dr. Ananya Iyer', 'Allergy: Penicillin', 'Payer: PM-JAY', 'ABHA Linked'])
        expect(banner.includes(t), `the banner says "${t}": ${banner}`)
      const tabs = await page.evaluate(`[...document.querySelectorAll('[role="tab"][id^="record-tab-"]')].map((t) => t.textContent)`)
      expect(tabs.join('|') === 'Overview|Condition2|Results8|Reports3|Notes2|Medicines3|Appointments3', `the seven parts with their counts: ${tabs}`)
      expect(await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').textContent === 'Overview'`), 'Overview is the selected part')
      const text = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      for (const t of ['Report viewer', 'NO ACUTE STROKE ON THIS SCAN', 'Vitals', 'AI insights', 'Test results', 'Trend', 'Patient report', 'Community-acquired pneumonia'])
        expect(text.includes(t), `the overview shows "${t}"`)
      // Flags, not narrative: the AI card's old lead sentence is gone, and so are its suggested orders.
      expect(!text.includes('A treatment-failure pattern') && !text.includes('suggested —'), 'no AI narrative summary and no suggested orders on the overview')
      expect(await page.evaluate(`![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Admit')`), 'no Admit for a patient already in a bed')
      await page.open('/patient/NOPE-1')
      const none = await page.text()
      expect(none.includes('No patient at this address.') && none.includes('There is no patient with the id “NOPE-1” in this sample record.'), 'an unknown id says so')
    },
  },
  {
    name: "Record: a tab goes to its part's own address; AI off keeps the insights card in its place, saying so; an insight's Why opens the four panels",
    async run() {
      await page.open('/patient/ICH-0044051')
      await page.click('[role="tab"]', 'Results')
      await page.until(`location.pathname === '/patient/ICH-0044051/results'`, 3000, "the Results part's own address")
      await page.open('/patient/ICH-0044051?ai=off')
      const off = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      expect(off.includes('AI insights are off') && !off.includes('Why?'), 'AI off: the card stands, with no readings in it')
      await page.open('/patient/ICH-0044051')
      await page.click('button[aria-label^="Why? Risk"]')
      await page.until(`document.querySelector('[role="dialog"][aria-label="Why this was suggested"]')?.textContent.includes('AI-201')`, 3000, "the risk reading's Why")
    },
  },
  {
    name: 'Admit: priority required, one admission per patient; the banner, My Day and the audit follow it; the front office completes it',
    async run() {
      await page.open('/patient/ICH-0044120')
      await page.click('button', 'Admit')
      await page.until(`document.querySelector('[role="dialog"][aria-labelledby="admit-title"]')?.textContent.includes('Admit Meera Krishnan')`, 3000, 'the Admit modal, named for the patient')
      const confirm = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Confirm')`
      expect(await page.evaluate(`${confirm}.disabled`), 'Confirm waits for a priority — none is chosen for the doctor')
      await page.click('[role="dialog"] [role="radio"]', 'Urgent')
      expect(!(await page.evaluate(`${confirm}.disabled`)), 'a priority enables Confirm')
      await page.click('[role="dialog"] button', 'Confirm')
      await toastSays('Admission in progress — Meera Krishnan', 'Ward · Urgent')
      await page.until(`document.querySelector('[aria-label="Patient"]').textContent.includes('Admission in progress · waiting for bed')`, 3000, 'the banner chip')
      expect(await page.evaluate(`![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Admit')`), 'Admit is gone once an admission exists')
      const rows = (await auditRows()).filter((r) => r.event === 'ADMISSION.REQUESTED')
      expect(rows.length === 1 && rows[0].subject === 'SD-P-01' && rows[0].detail === 'Ward · Urgent', `one ADMISSION.REQUESTED row: ${JSON.stringify(rows)}`)
      // A second confirm (the modal opened again from a link) makes no second admission and no second row.
      await page.open('/patient/ICH-0044120?open=admit:SD-P-01', { fresh: false })
      await page.click('[role="dialog"] [role="radio"]', 'Critical')
      await page.click('[role="dialog"] button', 'Confirm')
      await sleep(400)
      expect((await auditRows()).filter((r) => r.event === 'ADMISSION.REQUESTED').length === 1, 'idempotent per patient')
      const adm = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.admissions')).state.admissions['SD-P-01']`)
      expect(adm.priority === 'urgent', `the first admission stands: ${JSON.stringify(adm)}`)
      // My Day counts it while it is on its way.
      await page.open('/', { fresh: false })
      const kpi = await page.evaluate(`document.querySelector('[data-kpi="admissions"]').textContent`)
      expect(kpi.startsWith('1') && kpi.includes('1 in progress'), `the Admissions KPI: ${kpi}`)
      expect(
        await page.evaluate(`[...document.querySelectorAll('a[href="/patient/ICH-0044120"]')].some((a) => a.textContent.includes('Admission in progress'))`),
        "Meera's OPD row says her admission is in progress",
      )
      // The front office works on the wall clock: 20 s to a bed, 45 s to admitted. Pretend a minute has passed, and reload.
      await page.evaluate(`(() => { const k = 'indostates.admissions'; const v = JSON.parse(localStorage.getItem(k)); v.state.admissions['SD-P-01'].requestedAt -= 60000; localStorage.setItem(k, JSON.stringify(v)); return true })()`)
      await page.open('/', { fresh: false })
      await toastSays('Meera Krishnan admitted')
      expect((await page.text()).includes('Now on your Inpatients list.'), 'the old toast detail')
      await page.click('[role="tab"]', 'Inpatients')
      await page.until(`[...document.querySelectorAll('a[href="/patient/ICH-0044120"]')].length > 0`, 3000, 'Meera is on the inpatient list now')
      await page.open('/patient/ICH-0044120', { fresh: false })
      await page.until(`/Admitted · /.test(document.querySelector('[aria-label="Patient"]').textContent)`, 3000, 'the banner says admitted, with the bed')
    },
  },
  {
    name: 'Record · Reports (S-06-12): filtered by kind, the body one tap away, the viewer only where real pixels are',
    async run() {
      await page.open('/patient/ICH-0044051/reports')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-12"]')`), 'S-06-12 is drawn')
      expect(await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"][id="record-tab-reports"]') !== null`), 'the Reports part is selected')
      const titles = () => page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] li .font-semibold')].map((e) => e.textContent)`)
      expect((await titles()).join('|') === 'NCCT head|12-lead ECG|Chest X-ray AP', `every report, newest first: ${await titles()}`)
      await page.click('[role="tablist"][aria-label="Which reports"] [role="tab"]', 'Documents')
      expect((await titles()).join('|') === '12-lead ECG', `documents only: ${await titles()}`)
      await page.click('[role="tablist"][aria-label="Which reports"] [role="tab"]', 'All')
      await page.click('[role="tabpanel"] button', 'Full report')
      expect(await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] button')].some((b) => b.textContent.trim() === 'Less' && b.getAttribute('aria-expanded') === 'true')`), 'the body opens')
      // Both of this patient's studies carry images — the head CT and the chest X-ray.
      expect(!(await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] button')].some((b) => b.textContent.trim() === 'Report only')`)), 'no study here is report-only')
      await page.click('[role="tabpanel"] button', 'Open images')
      await page.until(`location.pathname.startsWith('/radiology/study/')`, 3000, 'real pixels open the viewer')
      // Priya Raman's day-2 MRI has no open image that fits — it says so.
      await page.open('/patient/ICH-0044281/reports', { fresh: false })
      expect(await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] button')].some((b) => b.textContent.trim() === 'Report only')`), 'a study without images says so')
    },
  },
  {
    name: 'Record · Results (S-06-13): the three counts, grouped by test, filtered, each row to its full result; cultures with their sensitivities and the allergy beside its drug',
    async run() {
      await page.open('/patient/ICH-0044051/results')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-13"]')`), 'S-06-13 is drawn')
      const tiles = await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] > div:first-child > div')].map((t) => t.textContent)`)
      expect(tiles[0].includes('Results on file8') && tiles[1].includes('Outside range7') && tiles[2].includes('To review6'), `the three counts: ${tiles}`)
      const rows = () => page.evaluate(`document.querySelectorAll('ul[aria-label="Test results"] > li').length`)
      await page.click('[role="tablist"][aria-label="Which results"] [role="tab"]', 'To review')
      expect((await rows()) === 6, 'six to review')
      // The sputum: microscopy and culture with no pathogen, and GeneXpert — no organism yet, as the record says.
      const micro = await page.evaluate(`[...document.querySelectorAll('ul[aria-label="Microbiology"] > li')].map((l) => l.textContent)`)
      expect(micro.length === 2 && micro.some((t) => t.includes('no pathogen isolated')) && micro.some((t) => t.includes('MTB not detected')), `the sputum results: ${micro}`)
      await page.click('[role="tablist"][aria-label="Which results"] [role="tab"]', 'All')
      await page.click('ul[aria-label="Test results"] > li button', 'CRP')
      await page.until(`location.pathname.startsWith('/results/')`, 3000, 'a row opens its full result')
      // Cultures carry their sensitivities; an allergy on the record sits beside its drug, never read as a choice.
      await page.open('/patient/ICH-0043910/results', { fresh: false })
      const cultures = await page.evaluate(`[...document.querySelectorAll('ul[aria-label="Microbiology"] > li')].map((l) => l.getAttribute('aria-label'))`)
      expect(cultures.length === 3 && cultures.every((c) => c.endsWith('final')), `three final cultures: ${cultures}`)
      const cotrim = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Sensitivities — Urine culture"] > li')].find((l) => l.textContent.startsWith('Co-trimoxazole'))?.textContent ?? ''`)
      expect(cotrim.includes('Sulfa allergy on record') && cotrim.includes('Resistant'), `co-trimoxazole: ${cotrim}`)
      const mero = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Sensitivities — Urine culture"] > li')].find((l) => l.textContent.startsWith('Meropenem'))?.textContent ?? ''`)
      expect(mero.includes('Sensitive') && !mero.includes('allergy'), `meropenem: ${mero}`)
    },
  },
  {
    name: 'Record · Notes (S-06-14): a draft is signed or discarded, both on record; an earlier note opens to its four sections',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/patient/ICH-0044051/notes')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-14"]')`), 'S-06-14 is drawn')
        for (const words of ['Plan to switch to meropenem', 'Discuss with the family']) {
          await page.click('button', 'Add note')
          await page.until(`document.querySelector('#dictation-draft')`, 3000, 'the note dialog')
          await page.type('#dictation-draft', words)
          await page.click('[role="dialog"] button', 'Save')
          await page.until(`!document.querySelector('#dictation-draft')`, 3000, 'saved and closed')
        }
        await page.until(`document.querySelector('[role="tabpanel"]').textContent.includes('Plan to switch to meropenem')`, 3000, 'the drafts are listed')
        const signBtn = `[...document.querySelectorAll('[role="tabpanel"] li')].find((li) => li.textContent.includes('Plan to switch')).querySelector('button')`
        await page.evaluate(`${signBtn}.click()`)
        await toastSays('Note signed', 'R. Lakshmanan · now part of the record')
        const signed = (await auditRows()).find((r) => r.event === 'NOTE.SIGNED')
        expect(signed && signed.subject === 'SD-P-03' && signed.detail === 'Dictated note signed · 5 words', `NOTE.SIGNED: ${JSON.stringify(signed)}`)
        await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"] li')].find((li) => li.textContent.includes('Discuss with the family')).querySelector('button[aria-label="Discard this draft"]').click()`)
        await toastSays('Draft discarded', 'R. Lakshmanan')
        expect((await auditRows()).some((r) => r.event === 'NOTE.DRAFT_DISCARDED' && r.subject === 'SD-P-03'), 'the discard is on record too')
        expect(!(await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)).includes('Discuss with the family'), 'the discarded draft is gone')
        await page.click('[role="tabpanel"] button[aria-expanded="false"]')
        const open = await page.evaluate(`document.querySelector('[role="tabpanel"] button[aria-expanded="true"]').parentElement.textContent`)
        expect(['Subjective', 'Objective', 'Assessment', 'Plan'].every((t) => open.includes(t)), 'an earlier note opens to SOAP')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: "Record · Condition (S-06-15): the status first, what to watch, the problems; the AI's read and risk only while AI is on",
    async run() {
      await page.open('/patient/ICH-0044051/condition')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-15"]')`), 'S-06-15 is drawn')
      const text = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      for (const t of ['How they are now', 'Deteriorating', 'What to watch', 'Problem list', 'ICD-10', 'AI read of the record', 'Deterioration risk', 'Latest observations'])
        expect(text.includes(t), `the condition shows "${t}"`)
      await page.click('[role="tabpanel"] button', 'Why?')
      await page.until(`document.querySelector('[role="dialog"][aria-label="Why this was suggested"]')?.textContent.includes('AI-105')`, 3000, "the AI read's Why")
      await page.open('/patient/ICH-0044051/condition?ai=off')
      const off = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      expect(!off.includes('AI read of the record') && !off.includes('Deterioration risk') && off.includes('How they are now'), 'AI off: the AI cards are absent, the record is not')
    },
  },
  {
    name: 'Record · Medicines (S-06-16): taking now across every prescription, the history as written; Write prescription only for who may',
    async run() {
      await page.open('/patient/ICH-0044051/prescriptions')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-16"]')`), 'S-06-16 is drawn')
      const text = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      expect(text.includes('Taking now') && text.includes('Prescription history') && text.includes('Piperacillin-tazobactam'), 'both lists, on the old data')
      expect(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Write prescription')`), 'the consultant may write one')
      await page.click('button', 'Write prescription')
      await page.until(`/^\\/encounter\\/[^/]+\\/rx$/.test(location.pathname)`, 3000, "the encounter's prescription")
      await page.open('/patient/ICH-0044051/prescriptions', { persona: 'P-05' })
      expect(await page.evaluate(`![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Write prescription')`), 'absent for a resident, who has no rx.write')
    },
  },
  {
    name: 'Record · Appointments (S-06-17): the next one fills the top with what to bring; the rest is a quiet list',
    async run() {
      await page.open('/patient/ICH-0044051/appointments')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-17"]')`), 'S-06-17 is drawn')
      const text = await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)
      for (const t of ['Next appointment', 'Repeat chest X-ray', 'Earlier visits'])
        expect(text.includes(t), `the appointments show "${t}"`)
      const tab = await page.evaluate(`document.querySelector('#record-tab-appointments').textContent`)
      const rows = await page.evaluate(`document.querySelectorAll('[role="tabpanel"] li').length`)
      expect(tab === 'Appointments3', `the tab counts three: ${tab}`)
      expect(rows >= 2, `rows listed: ${rows}`)
    },
  },
  {
    name: 'Consultation (S-06-03): Sign waits for every section, a leaf code and clean abbreviations; signing locks it, an addendum is on record',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118402/note')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-03"]')`), 'S-06-03 is drawn')
        const sign = `[...document.querySelectorAll('button')].find((b) => /^(Sign|Save for co-sign)$/.test(b.textContent.trim()))`
        expect(await page.evaluate(`${sign}.getAttribute('aria-disabled') === 'true'`), 'Sign is disabled on an empty note')
        expect((await page.text()).includes('0 of 4 sections written'), 'and says why')
        expect(!(await page.text()).includes('J18.9 Pneumonia'), "no pneumonia code offered on a hypothyroid patient's note")
        const texts = { subjective: 'Tired for two weeks, no weight change.', objective: 'Pulse 80 regular, thyroid not enlarged.', assessment: 'Hypothyroidism well controlled on dose.', plan: 'Continue levothyroxine 75 mcg OD.' }
        // Opening the consultation started it: Meera is In room on My Day while the note is written.
        await page.open('/', { fresh: false })
        expect((await page.evaluate(`document.querySelector('[data-kpi="inroom"]').textContent`)).includes('Krishnan'), 'in the room while the note is open')
        await page.open('/encounter/E-118402/note', { fresh: false })
        for (const [key, words] of Object.entries(texts)) await page.type(`[id="E-118402:${key}"]`, words)
        await page.click('[aria-label="Search ICD-10"]')
        // Pressed while its gate is shut, Sign names every problem.
        await page.click('button', 'Sign')
        await page.until(`document.querySelector('[role="alert"]')?.textContent.includes('is not accepted — write "once daily"')`, 3000, 'the banned OD is named with what to write')
        expect((await page.evaluate(`document.querySelector('[role="alert"]').textContent`)).includes('a leaf ICD-10 code is required'), 'and the missing code')
        await page.evaluate(`(() => { const el = document.getElementById('E-118402:plan'); el.focus(); el.select(); return true })()`)
        await page.type('[id="E-118402:plan"]', 'Continue levothyroxine 75 mcg once daily.')
        await page.click('button', 'Hypothyroidism · E03.9')
        await page.click('[aria-label="Search ICD-10"]')
        await page.until(`${sign}.getAttribute('aria-disabled') !== 'true'`, 3000, 'Sign enables once every rule clears')
        await page.click('button', 'Sign')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Sign this note?')`, 3000, 'the irreversible step asks first')
        await page.click('[role="alertdialog"] button', 'Sign')
        await toastSays('Note signed', 'Queued to publish to ABDM.')
        const signed = (await auditRows()).find((r) => r.event === 'NOTE.SIGNED')
        expect(signed && signed.subject === 'SD-P-01' && signed.detail.includes('ICD-10 E03.9'), `NOTE.SIGNED: ${JSON.stringify(signed)}`)
        // The consultation is over once its note is signed: Seen on My Day, and out of the room.
        await page.open('/', { fresh: false })
        const meera = await page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].find((li) => li.textContent.includes('Meera Krishnan'))?.textContent ?? ''`)
        expect(meera.includes('Seen') && (await page.evaluate(`document.querySelector('[data-kpi="inroom"]').textContent`)).includes('Room free'), `signed: Seen, and the room is free: ${meera}`)
        await page.open('/encounter/E-118402/note', { fresh: false })
        expect((await page.text()).includes('Read-only') && (await page.text()).includes('A signed record is never edited'), 'signed: locked, with the reason')
        await page.click('button', 'Addendum')
        await page.type('[id="E-118402:addendum"]', 'Ferritin result reviewed with the patient.')
        await page.click('[role="alertdialog"] button', 'Append addendum')
        await toastSays('Addendum appended', 'Both entries remain visible and attributed.')
        expect((await auditRows()).some((r) => r.event === 'NOTE.ADDENDUM_APPENDED' && r.subject === 'SD-P-01'), 'the addendum is on record')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Consultation (S-06-03): a resident writes but cannot sign — Save for co-sign, on record',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118402/note', { persona: 'P-05' })
        expect((await page.text()).includes('You may write this note but not sign it'), 'the resident is told before writing')
        const texts = { subjective: 'Tired for two weeks, no weight change.', objective: 'Pulse 80 regular, thyroid not enlarged.', assessment: 'Hypothyroidism well controlled on dose.', plan: 'Continue levothyroxine 75 mcg once daily.' }
        for (const [key, words] of Object.entries(texts)) await page.type(`[id="E-118402:${key}"]`, words)
        await page.click('button', 'Hypothyroidism · E03.9')
        await page.click('button', 'Save for co-sign')
        await page.click('[role="alertdialog"] button', 'Save for co-sign')
        await toastSays('Saved for co-sign', "It is now in the consultant's queue.")
        expect((await auditRows()).some((r) => r.event === 'NOTE.COSIGN_QUEUED' && r.subject === 'SD-P-01'), 'NOTE.COSIGN_QUEUED is on record')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Consultation (S-06-03): the scribe drafts what it heard as ghost text; each draft needs a decision before Sign',
    async run() {
      const unstub = await stubSpeech()
      try {
        await page.open('/encounter/E-118402/note')
        await page.click('button', 'Draft with AI')
        await page.until(`window.__srStarts === 1`, 3000, 'the scribe listens as it opens')
        await page.evaluate(`window.__say('patient complains of tiredness for two weeks', 0.93)`)
        await page.evaluate(`window.__say('on examination pulse is 80 and regular', 0.93)`)
        await page.evaluate(`window.__say('impression is hypothyroidism well controlled', 0.93)`)
        await page.evaluate(`window.__say('plan to continue levothyroxine and review in six months', 0.93)`)
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('4 of 4 sections drafted')`, 3000, 'four sections drafted from what was said')
        await page.click('[role="dialog"] button', 'Use this draft')
        await toastSays('Four sections drafted', 'Each one needs Accept, Edit or Reject before Sign will enable.')
        expect((await page.evaluate(`document.querySelectorAll('[role="region"][aria-label*="AI draft"]').length`)) === 4, 'four ghost drafts in the note, not in a side card')
        await page.click('button', 'Hypothyroidism · E03.9')
        expect((await page.text()).includes('4 AI drafts need a decision'), 'Sign waits for the decisions')
        for (let i = 0; i < 3; i++) await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
        await page.click('[role="group"][aria-label^="Disposition"] button', 'Reject')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Reject this suggestion')`, 3000, 'reject asks for a reason')
        await page.click('[role="dialog"] button', 'Record rejection')
        await toastSays('Rejection recorded', 'Clinically incorrect · fed back to model governance')
        const plan = await page.evaluate(`document.getElementById('E-118402:plan')?.value ?? ''`)
        expect(plan === '', `a rejected draft leaves the section empty for the doctor: "${plan}"`)
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Problems (S-06-05): AI-204 flags, never blocks; a problem added is added everywhere and on record; the list confirms only when every code is',
    async run() {
      await page.open('/encounter/E-118201/problems')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-05"]')`), 'S-06-05 is drawn')
      const text = await page.text()
      expect(text.includes('1 coded problem needs evidence') && text.includes('the flag is a prompt, not a block'), 'AI-204 flags, in the old words')
      const confirmList = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Confirm the problem list'))`
      expect(await page.evaluate(`${confirmList}.disabled`), 'the list waits for every code')
      await page.type('#dx-search', 'hypo')
      await page.click('button', 'Hypothyroidism')
      await toastSays('Hypothyroidism added', 'Coded E03.9')
      expect((await auditRows()).some((r) => r.event === 'PROBLEM.ADDED' && r.subject === 'SD-P-07' && r.detail.includes('E03.9')), 'PROBLEM.ADDED is on record')
      await page.type('#dx-search', 'hypo')
      await page.click('button', 'Hypothyroidism')
      await toastSays('Hypothyroidism is already on the list')
      // Confirm each code, row by row (a confirmed row reads "Confirmed").
      while (await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Confirm')`)) {
        await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Confirm').click()`)
        await sleep(120)
      }
      await page.until(`!${confirmList}.disabled`, 3000, 'every code confirmed enables the list')
      await page.click('button', 'Confirm the problem list')
      await toastSays('Problem list confirmed')
      expect((await auditRows()).some((r) => r.event === 'PROBLEM_LIST.CONFIRMED' && r.detail.includes('E03.9')), 'PROBLEM_LIST.CONFIRMED is on record, with the codes')
      await page.open('/patient/ICH-0043910/condition', { fresh: false })
      expect((await page.evaluate(`document.querySelector('[role="tabpanel"]').textContent`)).includes('Hypothyroidism'), "the added problem is on the patient's Condition tab too")
    },
  },
  {
    name: "Timeline (S-06-06): unsummarised by day, the type kept in the address; the summary only on the record it describes; an unknown id says so",
    async run() {
      await page.open('/patient/ICH-0044051/timeline')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-06"]')`), 'S-06-06 is drawn')
      expect((await page.text()).includes('unsummarised'), 'the sub-line says what it is')
      await page.click('[role="tablist"][aria-label="Entry type"] [role="tab"]', 'Results')
      await page.until(`location.search === '?kind=result'`, 3000, 'the type is kept in the address')
      await page.open('/patient/ICH-0044051/timeline?kind=imaging', { fresh: false })
      expect(await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').textContent.startsWith('Imaging')`), 'a link opens it narrowed')
      await page.click('button[aria-label="Show Timeline"], aside button', 'Timeline')
      await page.click('button', 'Summarise this timeline')
      await page.until(`document.body.textContent.includes('The turning point is overnight on 20/21-Sep')`, 3000, "R. Lakshmanan's summary, on his timeline")
      await page.open('/patient/ICH-0044120/timeline')
      expect(!(await page.text()).includes('Summarise this timeline'), "no one else's summary on another patient's timeline")
      await page.open('/patient/NOPE-2/timeline')
      expect((await page.text()).includes('No patient at this address.'), 'an unknown id says so, never another patient')
    },
  },
  {
    name: 'Prescription (S-06-07): the hard stop is a rule — it fires with the AI off, the gate cannot be dismissed, an alternative lifts it and is on record',
    async run() {
      await page.open('/encounter/E-118366/rx?ai=off')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-07"]')`), 'S-06-07 is drawn')
      const text = await page.text()
      expect(text.includes('Co-amoxiclav 1.2g IV is blocked for this patient') && text.includes('the AI is currently off and it fired anyway'), 'the block fires with the AI off, and says so')
      expect(text.includes('Resolve the hard stop first'), 'the bar names what holds Sign')
      expect(await page.evaluate(`${SIGN_RX}.getAttribute('aria-disabled') === 'true'`), 'Sign is held')
      await page.click('button', 'Resolve')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Prescription blocked')`, 3000, 'the gate opens')
      const gate = await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)
      expect(gate.includes('The AI is currently off.') && gate.includes('This block still fired'), 'the gate says the rule fired with the AI off')
      expect(gate.includes('Allergy documented 11-Aug-2021 by Dr. Ananya Iyer.'), 'who documented the allergy, and when')
      expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"] button[aria-label="Close"]')`)), 'no ✕ on the gate')
      await page.key('Escape')
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 8, y: 8, button: 'left', clickCount: 1 })
      await sleep(300)
      expect(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`), 'neither Esc nor the scrim dismisses it')
      await page.click('[role="alertdialog"] button[aria-label="Use Levofloxacin"]')
      await toastSays('Levofloxacin substituted', 'No beta-lactam cross-reactivity. No override was needed.')
      const row = (await auditRows()).find((r) => r.event === 'RX.HARD_STOP_RESOLVED')
      expect(row && row.subject === 'SD-P-03' && row.detail.includes('replaced by Levofloxacin'), `the disposition is on record: ${JSON.stringify(row)}`)
      const after = await page.text()
      expect(after.includes('Levofloxacin 750 mg IV') && !after.includes('is blocked for this patient') && !after.includes('Hard stop outstanding'), 'the line is the alternative and the block is gone')
    },
  },
  {
    name: 'Prescription (S-06-07): an override needs a reason, a second consultant, their PIN and the attestation; it clears only its own line, on record',
    async run() {
      await page.open('/encounter/E-118366/rx')
      await page.click('button', 'Resolve')
      await page.click('[role="alertdialog"] button', 'Override — needs a second consultant')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Dual signature required')`, 3000, 'the G4 dialog')
      const proceed = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Override and proceed'))`
      expect(await page.evaluate(`${proceed}.disabled`), 'nothing filled: it cannot proceed')
      const options = await page.evaluate(`[...document.querySelector('select[id$="-cosigner"]').options].map((o) => o.textContent)`)
      expect(!options.some((o) => o.includes('Dr. Ananya Iyer')) && options.some((o) => o.includes('Dr. Rohit Desai')), `the prescriber is not offered as the second consultant: ${options}`)
      await page.type('[role="alertdialog"] textarea', 'Too short')
      await page.click('[role="alertdialog"] button', 'Cancel')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Prescription blocked')`, 3000, 'Cancel goes back to the gate, not past it')
      await page.click('[role="alertdialog"] button', 'Override — needs a second consultant')
      await page.until(`document.querySelector('[role="alertdialog"] textarea')?.value === ''`, 3000, 'the dialog opens empty again')
      await page.type('[role="alertdialog"] textarea', 'Too short')
      await pick('select[id$="-cosigner"]', 'Dr. Rohit Desai')
      await page.type('input[id$="-pin"]', '12')
      await page.click('[role="alertdialog"] [role="checkbox"]')
      expect(await page.evaluate(`${proceed}.disabled`), 'a nine-character reason and a two-digit PIN are not enough')
      await page.type('[role="alertdialog"] textarea', ': the reaction on record was a childhood rash, reviewed with allergy.')
      await page.type('input[id$="-pin"]', '34')
      await page.until(`!${proceed}.disabled`, 3000, 'reason, second consultant, PIN and attestation: it may proceed')
      await page.click('[role="alertdialog"] button', 'Override and proceed')
      await toastSays('Hard stop overridden', 'AI.SAF.HARD_STOP_OVERRIDDEN emitted. Both identities recorded.')
      const row = (await auditRows()).find((r) => r.event === 'AI.SAF.HARD_STOP_OVERRIDDEN')
      expect(row && row.gate === 'G4' && row.actor === 'Dr. Ananya Iyer' && row.detail.includes('second consultant Dr. Rohit Desai'), `both identities on record: ${JSON.stringify(row)}`)
      const text = await page.text()
      expect(text.includes('Hard stop overridden with a dual signature') && text.includes('Second consultant: Dr. Rohit Desai'), 'the override is stated on the page')
      // The override was signed for co-amoxiclav. Another beta-lactam raises its own.
      await page.type('[aria-label="Search the formulary"]', 'pipera')
      await page.key('Enter')
      await page.until(
        `document.querySelector('[role="alertdialog"]')?.textContent.includes('Piperacillin-tazobactam 4.5g IV cannot be signed for this patient.')`,
        3000,
        'a second beta-lactam is blocked afresh',
      )
      await page.click('[role="alertdialog"] button', 'Remove Piperacillin-tazobactam 4.5g IV')
      await toastSays('Piperacillin-tazobactam 4.5g IV removed from the prescription')
      expect((await auditRows()).some((r) => r.event === 'RX.HARD_STOP_RESOLVED' && r.detail.includes('Piperacillin-tazobactam 4.5g IV removed')), 'removing it is on record')
    },
  },
  {
    name: 'Prescription (S-06-07): Sign waits for the dose decision and every line complete; signing is irreversible, on record, locked and printable',
    async run() {
      await page.open('/encounter/E-118366/rx')
      await page.click('button', 'Resolve')
      await page.click('[role="alertdialog"] button[aria-label="Use Levofloxacin"]')
      await toastSays('Levofloxacin substituted')
      expect((await page.text()).includes('1 dose adjustment needs a decision'), 'the renal suggestion holds Sign')
      await page.click('button', 'Sign prescription')
      await page.until(`[...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes('need attention'))`, 3000, 'pressed while held, Sign says why')
      const why = await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].find((a) => a.textContent.includes('need attention')).textContent`)
      expect(why.includes('1 dose adjustment needs a decision') && why.includes('No maximum daily dose stated. Add a 24-hour ceiling (CMP-NABH-05).'), `every reason: ${why}`)
      await page.click('[aria-label="Accept 20 mg once daily"]')
      expect((await page.evaluate(`document.getElementById('E-118366:RX-L-02:dose').value`)) === '20 mg once daily', 'accepting the suggestion writes the dose')
      await page.type('[id="E-118366:RX-L-03:ceiling"]', '4 g')
      await page.until(`${SIGN_RX}.getAttribute('aria-disabled') !== 'true'`, 3000, 'Sign enables once every rule clears')
      await page.click('button', 'Sign prescription')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Sign this prescription?')`, 3000, 'the irreversible step asks first')
      await page.click('[role="alertdialog"] button', 'Sign prescription')
      await toastSays('Prescription signed', 'Now in the pharmacy queue.')
      const row = (await auditRows()).find((r) => r.event === 'RX.SIGNED')
      expect(row && row.subject === 'SD-P-03' && row.detail.startsWith('3 items'), `RX.SIGNED: ${JSON.stringify(row)}`)
      await page.reload()
      const text = await page.text()
      expect(text.includes('Read-only') && text.includes('Signed by Dr. Ananya Iyer'), 'signed: locked, naming who')
      expect((await page.evaluate(`document.getElementById('E-118366:RX-L-02:dose').value`)) === '20 mg once daily', 'what was signed is what is shown after a reload')
      await page.click('button', 'Print A5, bilingual')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Print preview · A5')`, 3000, 'the A5 preview')
      const paper = await page.evaluate(`document.querySelector('[role="dialog"] article').textContent`)
      expect(paper.includes('1. Levofloxacin 750 mg IV') && paper.includes('at most 4 g in 24 hours') && paper.includes('Printed in English only.'), `the paper: ${paper.slice(0, 300)}`)
      await page.key('Escape')
      await page.open('/patient/ICH-0044051/prescriptions', { fresh: false })
      expect((await page.text()).includes('Today’s prescription was signed'), 'the record says it was signed')
    },
  },
  {
    name: "Prescription (S-06-07): a drug added from the formulary states its dose, frequency and duration before Sign; Remove works; nobody is given another patient's basket",
    async run() {
      await page.open('/encounter/E-118402/rx')
      expect(await page.evaluate(`${SIGN_RX}.getAttribute('aria-disabled') !== 'true'`), "Meera Krishnan's levothyroxine is complete: Sign is open")
      await page.key('/')
      expect(await page.evaluate(`document.activeElement?.getAttribute('aria-label') === 'Search the formulary'`), '/ focuses the formulary search, as the screen says')
      await page.type('[aria-label="Search the formulary"]', 'metf')
      await page.key('Enter')
      await toastSays('Metformin 500mg is on the NLEM', 'DPCO ceiling ₹18. Substitution is permitted by default.')
      expect((await page.text()).includes('Dose, frequency and duration are not stated yet.'), 'a new line states nothing yet')
      expect(await page.evaluate(`${SIGN_RX}.getAttribute('aria-disabled') === 'true'`), 'and holds Sign')
      await page.evaluate(`(() => { const el = document.getElementById('E-118402:RX-NEW-1:dose'); el.focus(); el.select(); return true })()`)
      await page.type('[id="E-118402:RX-NEW-1:dose"]', '500 mg')
      expect((await page.text()).includes('Frequency and duration are not stated yet.'), 'the gap names what is left')
      await pick('[id="E-118402:RX-NEW-1:route"]', 'Oral · once daily')
      await pick('[id="E-118402:RX-NEW-1:duration"]', '14')
      await page.until(`${SIGN_RX}.getAttribute('aria-disabled') !== 'true'`, 3000, 'a complete line opens Sign')
      await page.click('button[aria-label="Remove Metformin 500mg"]')
      await toastSays('Metformin 500mg removed from the prescription')
      await page.reload()
      expect(await page.evaluate(`!document.getElementById('E-118402:RX-NEW-1') && !!document.getElementById('E-118402:RX-L-11')`), 'the removal is kept with the prescription')
      await page.open('/encounter/E-118201/rx')
      const other = await page.text()
      expect(other.includes('Nothing prescribed yet.') && !other.includes('Levothyroxine 75 mcg'), "Joseph Mathew's prescription starts empty, not with Meera Krishnan's")
      await page.open('/encounter/NOPE-1/rx')
      expect((await page.text()).includes('No encounter at this address.'), 'an unknown encounter says so')
    },
  },
  {
    name: 'Prescription (S-06-07): a role without rx.override can resolve a hard stop but not override it',
    async run() {
      await page.open('/encounter/E-118366/rx', { persona: 'P-06' })
      await page.click('button', 'Resolve')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Prescription blocked')`, 3000, 'the gate opens')
      const override = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Override — needs a second consultant'))`
      expect(await page.evaluate(`${override}.disabled`), 'the override is shut to this role')
      expect((await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).includes('needs the rx.override capability'), 'and says which capability it needs')
      await page.click('[role="alertdialog"] button[aria-label="Use Clarithromycin"]')
      await toastSays('Clarithromycin substituted')
    },
  },
  {
    name: 'Instructions (S-06-08): your wording stays; the rewrite comes only on request, needs a decision, and prints bilingually beside exactly what it translates',
    async run() {
      await page.open('/encounter/E-118402/instructions')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-08"]')`), 'S-06-08 is drawn')
      const draftBtn = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Draft with AI')`
      expect(await page.evaluate(`${draftBtn}.disabled`), 'nothing to rewrite until you have written something')
      expect((await page.text()).includes('Dictate or type your instructions first'), 'the bar says what comes first')
      await page.click('button', 'Issue to the patient')
      await page.until(`[...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes('Dictate or type your instructions first'))`, 3000, 'pressed while held, Issue says why')
      await page.type('#clinician-text', 'Continue levothyroxine 75 mcg OD. TFT in 6/12.')
      await page.click('button', 'Draft with AI')
      await page.until(`document.body.textContent.includes('Keep taking your thyroid tablet')`, 3000, "the rewrite, in the patient's words")
      expect((await page.text()).includes('1 AI draft needs a decision'), 'the rewrite holds Issue until it is decided')
      expect(await page.evaluate(`document.querySelector('[lang="kn"]')?.textContent.includes('ಲೆವೊಥೈರಾಕ್ಸಿನ್')`), 'the Kannada beside the rewrite it translates')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
      await page.click('button', 'Issue to the patient')
      await toastSays('Instructions issued', 'Printed bilingually and pushed to the patient app.')
      const row = (await auditRows()).find((r) => r.event === 'INSTRUCTIONS.ISSUED')
      expect(row && row.subject === 'SD-P-01' && row.gate === 'G2' && row.model === 'plain-lang v2.2.0' && row.detail.includes('A5 print, patient app · English and ಕನ್ನಡ'), `on record: ${JSON.stringify(row)}`)
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent && sent.recipient === 'patient' && sent.title === 'Instructions sent to Meera Krishnan' && sent.detail.includes('Patient app'), `kept as sent: ${JSON.stringify(sent)}`)
      await page.click('button', 'Issue again')
      await page.until(`[...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes('Already issued, and nothing has changed since'))`, 3000, 'no second send of the same thing')
      await page.click('button', 'Preview the A5 print')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Print preview · A5')`, 3000, 'the A5 preview')
      const paper = await page.evaluate(`document.querySelector('[role="dialog"] article').textContent`)
      expect(paper.includes('Your instructions') && paper.includes('ಕನ್ನಡ') && paper.includes('English and ಕನ್ನಡ'), `the paper: ${paper.slice(0, 240)}`)
    },
  },
  {
    name: 'Instructions (S-06-08): an edited rewrite or another language prints in English only, the limitation stated; a rejected rewrite leaves nothing to issue',
    async run() {
      await page.open('/encounter/E-118402/instructions')
      await page.type('#clinician-text', 'Continue levothyroxine 75 mcg OD.')
      await page.click('button', 'Draft with AI')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Edit')
      await page.until(`document.getElementById('plain-text')?.value.startsWith('Keep taking your thyroid tablet')`, 3000, 'Edit opens the rewrite for editing')
      await page.evaluate(`(() => { const el = document.getElementById('plain-text'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); return true })()`)
      await page.type('#plain-text', ' Bring your tablets to the next visit.')
      expect((await page.text()).includes('No translation into ಕನ್ನಡ is available for this text'), 'an edited rewrite has no translation beside it')
      await page.click('button', 'Undo')
      await page.until(`document.body.textContent.includes('AI-111 rewrite') && !!document.querySelector('[lang="kn"]')`, 3000, 'Undo returns the rewrite as drafted, and its translation')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Reject')
      await page.click('[role="dialog"] button', 'Record rejection')
      await toastSays('Rejection recorded')
      const text = await page.text()
      expect(text.includes('Rewrite rejected — write the patient version yourself') && text.includes('Draft again with AI'), 'rejected: yours to write, or ask again')
      expect(text.includes('Draft the patient version to issue'), 'and nothing left to issue')
      await page.click('button', 'Draft again with AI')
      await page.until(`document.body.textContent.includes('AI-111 rewrite')`, 3000, 'drafted again')
      await page.click('aside button', 'Delivery')
      await pick('select[aria-label="Patient\'s preferred language"]', 'HI')
      expect((await page.text()).includes('No translation into हिन्दी is available for this text'), 'another language: English only, said')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
      await page.click('button', 'Issue to the patient')
      await toastSays('Instructions issued', 'Printed in English only and pushed to the patient app.')
      await page.reload()
      expect(await page.evaluate(`[...document.querySelectorAll('[data-screen-id="S-06-08"] span')].some((c) => c.textContent.trim() === 'हिन्दी')`), 'the language stays with the patient')
    },
  },
  {
    name: 'Instructions (S-06-08): with the AI off the patient version is yours to write; no rewrite for a patient it was not written for; the SMS carries no PHI',
    async run() {
      await page.open('/encounter/E-118402/instructions?ai=off')
      expect(!(await page.text()).includes('Draft with AI'), 'no rewrite offered with the AI off')
      await page.type('#clinician-text', 'Continue levothyroxine 75 mcg once daily.')
      await page.type('#plain-text', 'Take your thyroid tablet every morning before breakfast.')
      await page.click('aside button', 'Delivery')
      await page.click('[role="checkbox"]', 'SMS notification')
      expect((await page.text()).includes('The SMS carries no PHI'), 'the SMS rule, in the old words')
      await page.click('button', 'Issue to the patient')
      await toastSays('Instructions issued', 'Printed in English only and pushed to the patient app. The SMS carries a pointer only, never the content.')
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent.detail.includes('SMS pointer, no content'), `the SMS went as a pointer: ${sent.detail}`)
      await page.open('/encounter/E-118366/instructions')
      const other = await page.text()
      expect(!other.includes('Draft with AI') && !other.includes('Keep taking your thyroid tablet'), "no one else's rewrite for R. Lakshmanan")
      expect(await page.evaluate(`!!document.getElementById('plain-text')`), 'the patient version is written by hand')
      await page.open('/encounter/NOPE-2/instructions')
      expect((await page.text()).includes('No encounter at this address.'), 'an unknown encounter says so')
    },
  },
  {
    name: "Co-sign (S-06-09): a registrar's note joins the queue under its own patient; co-signing signs it with both names, on record",
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118201/note', { persona: 'P-05' })
        await saveForCoSign('E-118201', 'Septic shock · R65.21')
        await becomePersona('P-04')
        await page.open('/clinician/cosign', { fresh: false })
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-09"]')`), 'S-06-09 is drawn')
        const row = await page.evaluate(`[...document.querySelectorAll('button[data-row]')].map((b) => b.textContent).find((t) => t.includes('Joseph Mathew')) ?? ''`)
        expect(row.includes('Inpatient progress note'), `the note is filed under its own patient: "${row}"`)
        await page.click('button[aria-label="Co-sign — Inpatient progress note for Joseph Mathew by Dr. Ananya Iyer"]')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Co-sign this entry?')`, 3000, 'the stamp asks first')
        await page.click('[role="alertdialog"] button', 'Co-sign')
        await toastSays('Co-signed', 'Stamped Dr. Ananya Iyer · IN-HPR-2291840')
        const audit = (await auditRows()).find((r) => r.event === 'NOTE.COSIGNED')
        expect(audit && audit.subject === 'SD-P-07' && audit.detail.includes('IP number'), `NOTE.COSIGNED: ${JSON.stringify(audit)}`)
        expect((await page.text()).includes('Actioned this session') && (await page.text()).includes('Joseph Mathew · Inpatient progress note'), 'actioned, by patient and document')
        await page.open('/encounter/E-118201/note', { fresh: false })
        const note = await page.text()
        expect(note.includes('Read-only') && note.includes('co-signed by Dr. Ananya Iyer'), 'the note is signed, with both names')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: "Co-sign (S-06-09): Return needs what must change; the note goes back to the author's drafts with it, the author is told, and a new save comes back",
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118402/note', { persona: 'P-05' })
        await saveForCoSign('E-118402', 'Hypothyroidism · E03.9')
        await becomePersona('P-04')
        await page.open('/clinician/cosign', { fresh: false })
        await page.click('button[aria-label="Return — Consultation note for Meera Krishnan by Dr. Ananya Iyer"]')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Return this entry to the author?')`, 3000, 'the return asks first')
        const confirm = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Return with a comment'))`
        expect(await page.evaluate(`${confirm}.disabled`), 'no return without what needs changing')
        await page.type('[id="return-note"]', 'State the TSH result in the assessment.')
        await page.click('[role="alertdialog"] button', 'Return with a comment')
        await toastSays('Returned to the author', 'The author has been notified. The entry remains in their drafts.')
        const audit = (await auditRows()).find((r) => r.event === 'NOTE.RETURNED')
        expect(audit && audit.subject === 'SD-P-01' && audit.detail.includes('State the TSH result'), `NOTE.RETURNED with the comment: ${JSON.stringify(audit)}`)
        const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
        expect(sent && sent.recipient === 'author' && sent.detail.includes('State the TSH result'), `the author is told: ${JSON.stringify(sent)}`)
        await becomePersona('P-05')
        await page.open('/encounter/E-118402/note', { fresh: false })
        const note = await page.text()
        expect(note.includes('Returned by Dr. Ananya Iyer') && note.includes('State the TSH result in the assessment.'), 'the author sees what needs changing on the note')
        await page.click('button', 'Save for co-sign')
        await page.click('[role="alertdialog"] button', 'Save for co-sign')
        await toastSays('Saved for co-sign')
        await becomePersona('P-04')
        await page.open('/clinician/cosign', { fresh: false })
        expect(await page.evaluate(`[...document.querySelectorAll('button[data-row]')].some((b) => b.textContent.includes('Meera Krishnan'))`), 'saved again, it is back in the queue')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Co-sign (S-06-09): the order the header names is the order of the rows; with the AI off it is oldest first, and says so; arrow keys move between rows',
    async run() {
      await page.open('/clinician/cosign')
      const names = () => page.evaluate(`[...document.querySelectorAll('button[data-row]')].map((b) => b.querySelector('span span').textContent)`)
      expect((await page.text()).includes('Sorted by quality flags first'), 'the AI order, named')
      expect((await names())[0] === 'Abdul Rahman Sheikh', `flagged first: ${await names()}`)
      await page.click('button[aria-haspopup="menu"]', 'Sorted by')
      await page.click('[role="menu"] button, [role="menuitem"]', 'Oldest first')
      expect((await names())[0] === 'Fatima Bi', `oldest first: ${await names()}`)
      await page.open('/clinician/cosign?ai=off')
      expect((await page.text()).includes('Sorted by oldest first · AI ranking is off'), 'AI off: the deterministic order, said')
      expect((await names())[0] === 'Fatima Bi', 'and the rows are in it')
      await page.evaluate(`document.querySelector('button[data-row]').focus()`)
      await page.key('ArrowDown')
      expect(await page.evaluate(`document.activeElement === document.querySelectorAll('button[data-row]')[1]`), 'ArrowDown moves to the next entry')
      await page.open('/clinician/cosign?state=EMPTY')
      expect((await page.text()).includes('or an addendum to a signed record, would appear here'), 'EMPTY, in the old words')
      await page.open('/clinician/cosign?state=STALE')
      expect((await page.text()).includes('Data as of 08:06'), 'STALE, as the old frame drew it on every screen')
    },
  },
  {
    name: "Templates (S-06-10): due for review first; a set made here is kept, is its maker's, and can itself be promoted — a dated governance act with an owner and a review date after today",
    async run() {
      await page.open('/clinician/templates')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-06-10"]')`), 'S-06-10 is drawn')
      const due = await page.text()
      expect(due.includes('Sepsis bundle — first hour') && due.includes('review due 30-Sep-2026') && !due.includes('Community-acquired pneumonia — adult'), 'the default slice is what is due for review')
      await page.click('[role="tab"]', 'All')
      await page.click('button', 'New set')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('New order set')`, 3000, 'the new-set dialog')
      const create = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Create set'))`
      expect(await page.evaluate(`${create}.disabled`), 'nothing to create yet')
      await page.type('[role="dialog"] input', 'Acute asthma — adult')
      await page.type('[role="dialog"] textarea', 'Peak flow\nSpO2')
      await page.click('[role="dialog"] button', 'Create set')
      await toastSays('Order set created', 'Acute asthma — adult · 2 items · personal scope.')
      expect((await auditRows()).some((r) => r.event === 'ORDERSET.CREATED' && r.detail.includes('Acute asthma — adult')), 'ORDERSET.CREATED is on record')
      await page.reload()
      await page.click('[role="tab"]', 'All')
      const row = await page.evaluate(`[...document.querySelectorAll('li')].map((l) => l.textContent).find((t) => t.includes('Acute asthma — adult')) ?? ''`)
      expect(row.includes('2 items · Personal · Dr. Ananya Iyer'), `kept, and its maker's: "${row}"`)
      await page.click('button[aria-label="Promote Acute asthma — adult"]')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('"Acute asthma — adult" would become available')`, 3000, 'the dialog names the set made here')
      await setInput('[role="alertdialog"] input[type="date"]', '2026-01-01')
      const promote = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Promote with an owner'))`
      expect(await page.evaluate(`${promote}.disabled`) && (await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).includes('A review date after today'), 'a review date already past is refused')
      await setInput('[role="alertdialog"] input[type="date"]', '2027-06-30')
      await page.click('[role="alertdialog"] button', 'Promote with an owner')
      await toastSays('Promoted to facility-wide', 'Owner Dr. Vivek Sharma · review due 30-Jun-2027. Recorded as a governance act.')
      const audit = (await auditRows()).find((r) => r.event === 'ORDERSET.PROMOTED')
      expect(audit && audit.detail.includes('owner Dr. Vivek Sharma') && audit.detail.includes('30-Jun-2027'), `the governance act is on record: ${JSON.stringify(audit)}`)
      const after = await page.evaluate(`[...document.querySelectorAll('li')].map((l) => l.textContent).find((t) => t.includes('Acute asthma — adult')) ?? ''`)
      expect(after.includes('Facility-wide · Dr. Vivek Sharma') && !after.includes('Promote'), `promoted: "${after}"`)
      await setInput('input[aria-label="Effective on"]', '2026-09-20')
      const then = await page.text()
      expect(then.includes('The library as it stood on 20-Sep-2026') && !then.includes('Acute asthma — adult'), 'the day before, the set did not exist yet')
      expect(await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New set').getAttribute('aria-disabled') === 'true'`), 'a past library is read, never changed')
    },
  },
  {
    name: "Templates (S-06-10): a set's items open with it; search says when nothing matches; AI-302 suggests only while the AI is on",
    async run() {
      await page.open('/clinician/templates?scope=all')
      await page.click('button[aria-expanded]', 'Community-acquired pneumonia — adult')
      await page.until(`[...document.querySelectorAll('button[aria-expanded="true"]')].some((b) => b.textContent.includes('Community-acquired pneumonia'))`, 3000, 'the row opens')
      expect((await page.text()).includes('Sputum culture'), 'its items, once opened')
      await page.type('[aria-label="Search order sets and templates"]', 'zzz')
      expect((await page.text()).includes('No set matches “zzz”.'), 'nothing matched, said')
      await page.click('aside button', 'Governance')
      expect((await page.text()).includes('Add a sputum culture to your CAP set'), 'AI-302 in the rail')
      await page.open('/clinician/templates?ai=off')
      await page.click('aside button', 'Governance').catch(() => {})
      expect(!(await page.text()).includes('Add a sputum culture to your CAP set'), 'no AI-302 with the AI off')
    },
  },
  {
    name: 'Results (S-09-04 · S-09-06): the critical one comes first and interrupts; its acknowledgement cannot be dismissed, and is a named act on record',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/results/inbox')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-04"]')`), 'S-09-04 is drawn')
        expect((await page.text()).includes('Serum potassium 6.8 mmol/L — critical, unacknowledged 12 minutes'), 'the critical banner, in the old words')
        const first = await page.evaluate(`document.querySelector('ul[aria-label^="Results released"] li button').textContent`)
        expect(first.includes('Joseph Mathew') && first.includes('Serum potassium'), `critical first: ${first}`)
        await page.click('button', 'Acknowledge now')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Addressed to you by name')`, 3000, 'S-09-06 opens')
        expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"] button[aria-label="Close"]')`)), 'no ✕')
        await page.key('Escape')
        await sleep(200)
        expect(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`), 'Esc does not dismiss it')
        const only = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Acknowledge only'))`
        expect(await page.evaluate(`${only}.disabled`), 'nothing acknowledged before the fixed attestation')
        await page.click('[role="alertdialog"] [role="checkbox"]')
        await page.type('[id="critical-action-R-88410"]', 'Calcium gluconate given, ECG requested.')
        await page.click('[role="alertdialog"] button', 'Acknowledge only')
        await toastSays('Acknowledged', 'Escalation stopped. Acting on it is still to be documented.')
        const row = (await auditRows()).find((r) => r.event === 'RESULT.ACKNOWLEDGED')
        expect(row && row.subject === 'SD-P-07' && row.detail.includes('Calcium gluconate given'), `a named act on record: ${JSON.stringify(row)}`)
        expect(!(await page.text()).includes('critical, unacknowledged 12 minutes'), 'the banner goes with the acknowledgement')
        await page.open('/', { fresh: false })
        expect((await page.text()).includes('None unacknowledged'), "My Day's Critical count follows it")
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Results (S-09-06): Not me — reassign is a disposition — it names who, is on record, and leaves the result unacknowledged',
    async run() {
      await page.open('/results/inbox')
      await page.click('button[aria-label^="Acknowledge Serum potassium 6.8"]')
      await page.click('[role="alertdialog"] button', 'Not me — reassign')
      const reassign = `[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === 'Reassign')`
      expect(await page.evaluate(`${reassign}.disabled`), 'not until someone is named')
      await pick('[role="alertdialog"] select', 'Dr. Rohit Desai')
      await page.click('[role="alertdialog"] button', 'Reassign')
      await toastSays('Reassigned to Dr. Rohit Desai', 'It is still unacknowledged, and the escalation clock keeps running.')
      expect((await auditRows()).some((r) => r.event === 'RESULT.REASSIGNED' && r.detail.includes('to Dr. Rohit Desai')), 'RESULT.REASSIGNED is on record')
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent && sent.recipient === 'colleague' && sent.severity === 'critical', `sent to the colleague: ${JSON.stringify(sent)}`)
      const text = await page.text()
      expect(text.includes('Reassigned to Dr. Rohit Desai — still unacknowledged.') && text.includes('reassigned to Dr. Rohit Desai'), 'still owed, and to whom it went')
      await page.click('button[aria-label^="Acknowledge Serum potassium 6.8"]')
      await page.until(`!!document.querySelector('[role="alertdialog"] [role="checkbox"]')`, 3000, 'it opens afresh, at the attestation')
    },
  },
  {
    name: 'Results (S-09-04): filtered by review state and patient, read as a list or by patient; with the AI off in time order, said, and no abstain card',
    async run() {
      await page.open('/results/inbox')
      await page.click('[role="tab"]', 'Reviewed')
      expect(await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Results released"] li')].every((l) => l.textContent.includes('acknowledged'))`), 'reviewed: every row acknowledged')
      await page.click('[role="tab"]', 'All')
      expect((await page.text()).includes('One result cannot be ranked'), 'AI-212 abstains on the incomplete culture, said')
      await page.click('section[aria-label="Results summary"] button', 'Meera Krishnan')
      expect(await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Results released"] li')].every((l) => l.textContent.includes('Meera Krishnan'))`), 'one patient, filtered')
      await page.click('[role="tab"]', 'By patient')
      await page.click('button', 'All of Meera’s results')
      await page.until(`location.pathname === '/patient/ICH-0044120/results'`, 3000, "to the patient's own results")
      await page.open('/results/inbox?ai=off')
      const off = await page.text()
      expect(off.includes('Sorted by most recent first · AI ranking is off') && !off.includes('One result cannot be ranked'), 'AI off: time order, said; no AI claim')
      expect(off.includes('critical, unacknowledged 12 minutes'), 'the escalation is rule-based and stays with the AI off')
    },
  },
  {
    name: "Result (S-09-05): the numbers first; an unacknowledged critical value is acknowledged from here; AI-109's reading is attested — the fixed checkbox, then the signature, on record",
    async run() {
      await page.open('/results/R-88410')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-05"]')`), 'S-09-05 is drawn')
      expect((await page.text()).includes('6.8 mmol/L · reference 3.5 – 5.1'), 'the value and its reference, first')
      await page.click('button', 'Acknowledge')
      await page.click('[role="alertdialog"] [role="checkbox"]')
      await page.click('[role="alertdialog"] button', 'Acknowledge only')
      await toastSays('Acknowledged')
      const text = await page.text()
      expect(text.includes('Acknowledged') && !text.includes('This critical value has not been acknowledged'), 'acknowledged from the result itself')
      const accept = `[...document.querySelectorAll('[role="group"][aria-label^="Disposition"] button')].find((b) => b.textContent.includes('Accept'))`
      expect(await page.evaluate(`${accept}.disabled`), 'G3: nothing is accepted before "I have reviewed this content"')
      await page.click('[role="checkbox"]', 'I have reviewed this content')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
      await page.until(`document.body.textContent.includes('Attested · HPR IN-HPR-2291840')`, 3000, 'the signature block: who, the number, when')
      const row = (await auditRows()).find((r) => r.event === 'AI.ATTESTED')
      expect(row && row.gate === 'G3' && row.subject === 'SD-P-07' && row.model === 'lab-narrative v2.3.1', `attested on record: ${JSON.stringify(row)}`)
      await page.open('/results/R-88410?ai=off', { fresh: false })
      await page.click('aside button', 'Result')
      const off = await page.text()
      expect(!off.includes('Drafted interpretation') && !off.includes('Why this result was ranked') && off.includes('These are the fallback and the authority'), 'AI off: the numbers stay, the model goes')
      await page.open('/results/R-NOPE')
      expect((await page.text()).includes('No result at this address.'), 'an unknown result says so')
    },
  },
  {
    name: 'New orders (S-09-01): AI-304 flags a repeat on its line; Place waits for Remove it or Order anyway, which takes one of the fixed reasons; orders go with their priority, on record',
    async run() {
      await page.open('/encounter/E-118366/orders/new')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-01"]')`), 'S-09-01 is drawn')
      await page.type('[aria-label="Search tests, imaging and procedures"]', 'crp')
      await page.key('Enter')
      const text = await page.text()
      expect(text.includes('AI-304 · possible duplicate') && text.includes('CRP was resulted 2 hours ago at 184 mg/L'), 'the flag, on the line, in the rule\'s words')
      const place = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Place'))`
      expect(await page.evaluate(`${place}.getAttribute('aria-disabled') === 'true'`) && text.includes('1 duplicate flag needs a decision'), 'Place waits for the decision')
      await page.click('button', 'Order anyway')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Reject this suggestion')`, 3000, 'ordering anyway asks for a reason')
      await page.click('[role="dialog"] button', 'Record rejection')
      await toastSays('Rejection recorded', 'fed back to model governance')
      expect((await page.text()).includes('Ordered anyway · Clinically incorrect · AI-304'), 'the decision stays on the line')
      await page.type('[aria-label="Search tests, imaging and procedures"]', 'serum creat')
      await page.key('Enter')
      await pick('select[aria-label="Priority for Serum creatinine"]', 'Urgent')
      await page.click('button', 'Place 2 orders')
      await toastSays('2 orders placed', 'They appear on the active orders screen')
      const row = (await auditRows()).find((r) => r.event === 'ORDER.PLACED')
      expect(row && row.subject === 'SD-P-03' && row.detail.includes('Serum creatinine (Urgent)'), `ORDER.PLACED with the priority: ${JSON.stringify(row)}`)
      const placed = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.clinical')).state.placedOrders`)
      expect(placed.length === 2 && placed.every((o) => o.id.startsWith('O-E-118366-B-') && o.encounterId === 'E-118366') && placed[1].priority === 'Urgent', `each under its own id: ${JSON.stringify(placed)}`)
      await page.until(`location.pathname === '/encounter/E-118366/orders'`, 3000, 'on to the active orders')
    },
  },
  {
    name: 'New orders (S-09-01): the basket is kept on leaving; suggestions only on the record they came from; a set adds what is not there yet, and one chosen elsewhere arrives applied',
    async run() {
      await page.open('/encounter/E-118366/orders/new')
      await page.click('aside button', 'Suggestions')
      await page.click('[role="region"][aria-label^="AI-301"] [role="group"] button', 'Accept')
      await page.open('/', { fresh: false })
      await page.open('/encounter/E-118366/orders/new', { fresh: false })
      expect(await page.evaluate(`[...document.querySelectorAll('li p')].some((p) => p.textContent === 'Chest X-ray PA')`), 'the basket is kept with the encounter')
      await page.click('button', 'Community-acquired pneumonia — adult')
      await toastSays('Community-acquired pneumonia — adult applied', '5 orders added to the basket.')
      await page.open('/encounter/E-118402/orders/new')
      const meera = await page.text()
      expect(!meera.includes('suggestions') && meera.includes('The basket is empty. Search on the left, or apply an order set.'), "no one else's suggestions for Meera Krishnan")
      await page.open('/encounter/E-118402/orders/new?set=OS.AIYER-THYROID', { fresh: false })
      await toastSays('Thyroid follow-up — Dr. Iyer applied', '3 orders added to the basket.')
      await page.until(`location.search === ''`, 3000, 'the address forgets the set, so a reload does not apply it twice')
      await page.open('/encounter/NOPE-3/orders/new')
      expect((await page.text()).includes('No encounter at this address.'), 'an unknown encounter says so')
    },
  },
  {
    name: 'Orders (S-09-03): open first, chasing named; a void keeps the reason and what was added, is sent to the performing department, and stays visible, folded',
    async run() {
      await page.open('/encounter/E-118366/orders')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-03"]')`), 'S-09-03 is drawn')
      expect((await page.text()).includes('3 open · 2 being chased · 2 resulted'), 'the counts, in the old words')
      const first = await page.evaluate(`document.querySelector('ul[aria-label^="Orders on"] li').textContent`)
      expect(first.includes('Chest X-ray PA') && first.includes('chasing'), `chasing first: ${first}`)
      await page.click('button[aria-label="Cancel CRP"]')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Cancel CRP?')`, 3000, 'the void asks first')
      expect(await page.evaluate(`document.querySelector('[role="alertdialog"] select').value === 'No longer clinically indicated'`), 'the reason starts as a cancellation reason')
      await pick('[role="alertdialog"] select', 'Duplicate of another order')
      await page.type('[id="cancel-order-note"]', 'see O-5504')
      await page.click('[role="alertdialog"] button', 'Void this order')
      await toastSays('CRP voided', 'Reason recorded: Duplicate of another order — see O-5504')
      expect((await auditRows()).some((r) => r.event === 'ORDER.CANCELLED' && r.detail.includes('Duplicate of another order — see O-5504')), 'ORDER.CANCELLED, with both')
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent && sent.recipient === 'department' && sent.title === 'CRP voided', `the department is told: ${JSON.stringify(sent)}`)
      await page.click('button', 'Show voided')
      expect(await page.evaluate(`document.querySelector('ul[aria-label="Voided orders on this encounter"]').textContent.includes('Duplicate of another order — see O-5504')`), 'voided, visible, with its reason')
      await page.click('[role="tab"]', 'Resulted')
      await page.click('button[aria-label="Result — CRP"]')
      await page.until(`location.pathname.startsWith('/results/R-')`, 3000, 'a resulted order opens its own result')
    },
  },
  {
    name: 'Orders (S-09-03): orders placed in the basket join with their priority; with the AI off the chasing goes and the order is the newest first, said',
    async run() {
      await page.open('/encounter/E-118366/orders/new')
      await page.type('[aria-label="Search tests, imaging and procedures"]', 'serum creat')
      await page.key('Enter')
      await pick('select[aria-label="Priority for Serum creatinine"]', 'Stat')
      await page.click('button', 'Place 1 order')
      await page.until(`location.pathname === '/encounter/E-118366/orders'`, 3000, 'placed, and on the list')
      const row = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Orders on"] li')].map((l) => l.textContent).find((t) => t.includes('Serum creatinine')) ?? ''`)
      expect(row.includes('Stat') && row.includes('Ordered'), `with its priority: ${row}`)
      await page.open('/encounter/E-118366/orders?ai=off', { fresh: false })
      const off = await page.text()
      expect(off.includes('Sorted by most recent first · AI ranking is off') && !off.includes('chasing') && off.includes('4 open') && !off.includes('being chased'), 'AI off: the status list, said, no chasing')
    },
  },
  {
    name: "Order sets (S-09-02): due for review first; Apply asks which encounter and the set arrives applied in that basket; AI-303's adherence only with the AI on",
    async run() {
      await page.open('/orders/sets')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-02"]')`), 'S-09-02 is drawn')
      const due = await page.text()
      expect(due.includes('1 due for review · 4 sets · used 283 times this month') && due.includes('review due 30-Sep-2026'), 'the due slice, in the old words')
      await page.click('[role="tab"]', 'All')
      await page.click('button[aria-label="Apply Community-acquired pneumonia — adult to an encounter"]')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('A set is applied to an encounter, not to a patient.')`, 3000, 'Apply asks which encounter')
      await page.click('[role="dialog"] button', 'R. Lakshmanan')
      await page.until(`location.pathname === '/encounter/E-118366/orders/new'`, 3000, "into that encounter's basket")
      await toastSays('Community-acquired pneumonia — adult applied', '6 orders added to the basket.')
      await page.open('/orders/sets', { fresh: false })
      await page.click('button', 'Show pathway adherence')
      expect((await page.text()).includes('87% overall') && (await page.text()).includes('Most often omitted when the patient cannot expectorate'), 'AI-303, in its own words')
      await page.open('/orders/sets?ai=off', { fresh: false })
      expect(!(await page.text()).includes('pathway adherence'), 'no AI-303 with the AI off')
    },
  },
  {
    name: 'Stewardship (S-09-08): a deferral stays awaiting; accepting records the decision, voiding is its own act, and the cost counts as avoided only then; AI off says what stands in',
    async run() {
      await page.open('/orders/stewardship')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-09-08"]')`), 'S-09-08 is drawn')
      expect((await page.text()).includes('1 awaiting your decision · 1 flagged in the last 7 days'), 'the queue, in the old words')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Defer')
      expect(await page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').textContent.includes('1')`), 'a deferral stays awaiting')
      await page.click('button', 'Undo')
      await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
      expect((await page.text()).includes('Every flagged test has a decision recorded against it.'), 'accepted: reviewed')
      await page.click('[role="tab"]', 'Reviewed')
      await page.click('aside button', 'Stewardship')
      const before = await page.text()
      expect(before.includes('The order is still open. Accepting the flag does not stop it.') && before.includes('₹0'), 'agreeing is not voiding, and nothing is avoided yet')
      await page.click('button', 'Void this order')
      await page.click('[role="alertdialog"] button', 'Void this order')
      await toastSays('CRP voided', 'AI-304 flag accepted')
      expect((await auditRows()).some((r) => r.event === 'ORDER.CANCELLED' && r.detail.includes('O-5503') && r.detail.includes('AI-304 flag accepted')), 'the void is on record')
      const after = await page.text()
      expect(after.includes('Voided · Duplicate of another order — AI-304 flag accepted, prior order O-5504') && after.includes('₹480'), 'voided, and only now avoided')
      await page.open('/encounter/E-118366/orders', { fresh: false })
      await page.click('button', 'Show voided')
      expect(await page.evaluate(`document.querySelector('ul[aria-label="Voided orders on this encounter"]').textContent.includes('CRP')`), 'the same void on the orders screen')
      await page.open('/orders/stewardship?ai=off', { fresh: false })
      expect((await page.text()).includes('AI-304 is off, so no test is flagged. The retrospective stewardship round remains the fallback.'), 'AI off: what stands in, said')
    },
  },
  {
    name: 'Inpatients (S-08-03): those needing attention first; a location from My Day narrows the list visibly and removably; with the AI off, time order and no risk, the facts kept',
    async run() {
      await page.open('/ip/patients')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-08-03"]')`), 'S-08-03 is drawn')
      // textContent: the group's label is upper-cased by CSS, which innerText would report.
      const all = await page.evaluate(`document.querySelector('[data-screen-id="S-08-03"]').textContent`)
      expect(all.includes('6 under you · 3 high risk · 6 round notes outstanding') && all.includes('Needs attention'), `the counts and the pinned group, in the old words: ${all.slice(0, 300)}`)
      await page.open('/ip/patients?location=icu', { fresh: false })
      const icu = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Inpatients"] li button')].map((b) => b.textContent)`)
      expect(icu.length === 1 && icu[0].includes('Joseph Mathew'), `the ICU only: ${icu}`)
      await page.click('[role="tab"]', 'All')
      await page.until(`location.search === ''`, 3000, 'the narrowing is removable')
      await page.open('/ip/patients?location=ed', { fresh: false })
      expect((await page.text()).includes('No inpatients of yours are in the ED right now.'), 'an empty location says so')
      await page.click('button', 'All locations')
      await page.until(`location.search === ''`, 3000, 'and offers the way back')
      await page.open('/ip/patients?ai=off', { fresh: false })
      const off = await page.text()
      expect(off.includes('Sorted by chronological · AI ranking is off') && !off.includes('High risk') && off.includes('NEWS2 7, rising 4h'), 'AI off: time order, no risk, the facts kept')
      await page.click('ul[aria-label^="Inpatients"] li button', 'R. Lakshmanan')
      await page.until(`location.pathname === '/patient/ICH-0044051'`, 3000, 'a row opens the record')
    },
  },
  {
    name: 'Progress note (S-08-04): the ward-round note on the shared surface; an order the plan implies is placed once, under its own id, on record; AI-201 only with the AI on',
    async run() {
      await page.open('/ip/encounter/E-118366/note')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-08-04"]')`), 'S-08-04 is drawn')
      await page.click('aside button', 'Suggestions')
      expect((await page.text()).includes('Deterioration risk HIGH') && (await page.text()).includes('Orders this plan implies'), "why you are at the bed, and the plan's orders")
      await page.click('[role="region"][aria-label^="AI-301"] [role="group"] button', 'Accept')
      await toastSays('Chest X-ray PA placed')
      expect((await auditRows()).some((r) => r.event === 'ORDER.PLACED' && r.detail.includes('from the round plan')), 'placed, on record')
      await page.click('[role="region"][aria-label^="AI-301"] button', 'Undo')
      await page.click('[role="region"][aria-label^="AI-301"] [role="group"] button', 'Accept')
      const placed = await page.evaluate(`JSON.parse(localStorage.getItem('indostates.clinical')).state.placedOrders.filter((o) => o.id === 'O-E-118366-R-0')`)
      expect(placed.length === 1, `placed once, under its own id: ${JSON.stringify(placed)}`)
      await page.open('/ip/encounter/E-118366/note?ai=off', { fresh: false })
      await page.click('aside button', 'Suggestions')
      const off = await page.text()
      expect(!off.includes('Deterioration risk') && !off.includes('Orders this plan implies') && off.includes('Latest observations'), 'AI off: the observations stay, the model goes')
    },
  },
  {
    name: 'Assessment (S-08-07): the NABH clock leads; the screens open unanswered; history, both screens, the three scales and the declaration before Sign; the delay recorded, on record',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/ip/encounter/E-118366/assessment')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-08-07"]')`), 'S-08-07 is drawn')
        const text = await page.text()
        expect(text.includes('overdue') && text.includes('This assessment is past its 24-hour window'), 'the clock, and the miss said plainly')
        expect(await page.evaluate(`document.getElementById('ass-nutrition').value === '' && document.getElementById('ass-function').value === ''`), 'the screens open unanswered')
        await page.click('button', 'Sign assessment')
        const why = await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ')`)
        expect(why.includes('Nutrition risk') && why.includes('Functional status') && why.includes('0 of 3 confirmed') && why.includes('Declaration'), `every reason: ${why}`)
        await page.click('button', 'Carry forward from the admission note')
        expect((await page.text()).includes('carried forward'), 'carried forward, and marked')
        await pick('#ass-nutrition', 'At risk')
        await pick('#ass-function', 'Needs assistance')
        for (let n = 0; n < 3; n++) await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
        await page.click('[role="checkbox"]', 'I have completed the initial assessment')
        await page.click('button', 'Sign assessment')
        await toastSays('Admission assessment signed', 'with the delay recorded')
        const row = (await auditRows()).find((r) => r.event === 'NOTE.SIGNED' && r.detail.startsWith('Admission assessment'))
        expect(row && row.subject === 'SD-P-03' && row.detail.includes('late'), `signed, the delay on record: ${JSON.stringify(row)}`)
        expect((await page.text()).includes('Read-only'), 'signed: locked')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: "Assessment (S-08-07): without pre-scores the manual scales stand, and nothing is carried forward that is not the patient's; a registrar's assessment joins the co-sign queue as what it is",
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/ip/encounter/E-118201/assessment', { persona: 'P-05' })
        const text = await page.text()
        expect(!text.includes('Carry forward from the admission note') && text.includes('Score it on the manual scale.') && !text.includes('Acute infection'), "no one else's scores or note")
        await page.type('#ass-history', 'Septic shock on vasopressors, admitted from ED overnight.')
        await pick('#ass-nutrition', 'High risk — dietitian referral')
        await pick('#ass-function', 'Fully dependent')
        for (let n = 0; n < 3; n++) {
          await page.evaluate(`[...document.querySelectorAll('[role="checkbox"]')].find((c) => c.textContent.includes('Scored manually') && c.getAttribute('aria-checked') === 'false').click()`)
          await sleep(80)
        }
        await page.click('[role="checkbox"]', 'I have completed the initial assessment')
        await page.click('button', 'Save for co-sign')
        await toastSays('Saved for co-sign')
        expect((await auditRows()).some((r) => r.event === 'NOTE.COSIGN_QUEUED' && r.detail.startsWith('Admission assessment')), 'queued, on record')
        await becomePersona('P-04')
        await page.open('/clinician/cosign', { fresh: false })
        const queued = await page.evaluate(`[...document.querySelectorAll('button[data-row]')].map((b) => b.textContent).find((t) => t.includes('Joseph Mathew')) ?? ''`)
        expect(queued.includes('Admission assessment'), `in the queue as what it is: "${queued}"`)
        await page.click('button[aria-label="Co-sign — Admission assessment for Joseph Mathew by Dr. Ananya Iyer"]')
        await page.click('[role="alertdialog"] button', 'Co-sign')
        await toastSays('Co-signed')
        await page.open('/ip/encounter/E-118201/assessment', { fresh: false })
        expect((await page.text()).includes('co-signed by Dr. Ananya Iyer'), 'the assessment is signed with both names')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Discharge board (S-13-01): grouped by what is recorded, no forecast; a gate refuses in the old words; a discharge is confirmed, stored once, on record, sent to the front office, and leaves the inpatient list',
    async run() {
      await page.open('/discharge/board')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-13-01"]')`), 'S-13-01 is drawn')
      const text = await page.text()
      expect(text.includes('1 cleared for discharge · 2 waiting on a gate · 0 discharged'), `the counts, by recorded readiness: ${text.slice(0, 300)}`)
      expect(!/predicted|forecast|likelihood|tomorrow|07:00/i.test(text), 'no forecast anywhere on the board')
      await page.click('[role="tab"]', 'Waiting on')
      await page.until(`location.search === '?scope=waiting'`, 3000, 'the scope is in the address')
      const waiting = await page.text()
      for (const t of [
        'R. Lakshmanan is deteriorating. A patient on a rising deterioration score cannot be marked discharged.',
        'Financial clearance is outstanding: estimate unsigned. The bed cannot be released until it clears.',
        'Financial clearance is outstanding: TPA approval pending. The bed cannot be released until it clears.',
      ])
        expect(waiting.includes(t), `the gate in the old words: "${t}"`)
      expect(await page.evaluate(`document.querySelector('button[aria-label="Discharge R. Lakshmanan"]').getAttribute('aria-disabled') === 'true'`), 'a gated Discharge is aria-disabled')
      await page.click('button[aria-label="Discharge R. Lakshmanan"]')
      await page.until(`document.querySelector('[role="alert"]')?.textContent.includes('R. Lakshmanan is deteriorating.')`, 3000, 'pressing it says why, and nothing opens')
      expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'no confirmation for a refused discharge')

      await page.open('/ip/patients', { fresh: false })
      const before = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Inpatients"] li button')].map((b) => b.textContent).join('|')`)
      expect(before.includes('Kavya Reddy'), `Kavya Reddy is an inpatient before: ${before}`)

      await page.open('/discharge/board', { fresh: false })
      await page.click('button', 'Board view')
      await page.until(`document.querySelectorAll('section[aria-label]').length >= 3`, 3000, 'the three columns')
      // The drag itself: a cleared card dropped on Discharged asks first; Cancel leaves her where she was.
      const drag = (name) =>
        page.evaluate(`(() => {
          const card = document.querySelector('article[aria-label="' + ${JSON.stringify(name)} + '"]')
          const target = document.querySelector('section[aria-label="Discharged"]')
          const data = new DataTransfer()
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
          return true
        })()`)
      await drag('Kavya Reddy')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Discharge Kavya Reddy?')`, 3000, 'a drop asks before it discharges')
      await page.click('[role="alertdialog"] button', 'Cancel')
      await page.until(`!document.querySelector('[role="alertdialog"]')`, 3000, 'Cancel closes it')
      expect(await page.evaluate(`!!document.querySelector('section[aria-label="Cleared for discharge"] article[aria-label="Kavya Reddy"]')`), 'cancelled, she stays cleared')
      await page.click('button', 'List view')
      await page.click('button[aria-label="Discharge Kavya Reddy"]')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Discharge Kavya Reddy?')`, 3000, 'the confirmation')
      expect(
        (await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).includes('The summary is unsigned: it goes to the sign queue, and the discharge stands.'),
        'the confirmation says the summary goes to the sign queue',
      )
      await page.click('[role="alertdialog"] button', 'Discharge')
      await toastSays('Kavya Reddy discharged', 'Bed released to the bed board. The summary is unsigned — it goes to the sign queue.')
      expect((await page.text()).includes('0 cleared for discharge · 2 waiting on a gate · 1 discharged'), 'the counts move')
      const row = (await auditRows()).find((r) => r.event === 'PATIENT.DISCHARGED')
      expect(row && row.subject === 'SD-P-06' && row.actor === 'Dr. Ananya Iyer' && /bed 4B-19 released · summary unsigned, to the sign queue/.test(row.detail), `the audit row: ${JSON.stringify(row)}`)
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent && sent.recipient === 'front office' && sent.title === 'Bed 4B-19 released' && sent.detail === 'Kavya Reddy discharged home · summary to follow', `sent to the front office: ${JSON.stringify(sent)}`)

      await page.click('[role="tab"]', 'Discharged')
      const gone = await page.text()
      expect(gone.includes('Kavya Reddy') && gone.includes('discharged 08:40 by Dr. Ananya Iyer') && gone.includes('Summary unsigned — it is in the sign queue'), 'Discharged shows her, when, by whom, and the summary owed')
      expect(!(await page.evaluate(`!!document.querySelector('button[aria-label="Discharge Kavya Reddy"]')`)), 'no second Discharge is offered')

      await page.reload()
      expect((await page.text()).includes('1 discharged'), 'the discharge is kept after a reload')
      await page.open('/ip/patients', { fresh: false })
      const after = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Inpatients"] li button')].map((b) => b.textContent).join('|')`)
      expect(!after.includes('Kavya Reddy'), `a discharged patient leaves the inpatient list: ${after}`)

      await page.open('/discharge/board', { fresh: false })
      await page.click('button', 'Board view')
      await page.until(`document.querySelectorAll('section[aria-label]').length >= 3`, 3000, 'the three columns')
      expect(
        await page.evaluate(`[...document.querySelectorAll('section[aria-label="Discharged"] article')].map((a) => a.getAttribute('aria-label')).join() === 'Kavya Reddy'`),
        'she is on the Discharged column',
      )
      await page.click('button[aria-label="Discharge Abdul Rahman Sheikh"]')
      await page.until(
        `document.querySelector('section[aria-label="Discharged"] [role="alert"]')?.textContent.includes('Financial clearance is outstanding: TPA approval pending.')`,
        3000,
        'on the board the refusal is named on the target column',
      )
      await drag('R. Lakshmanan')
      await page.until(`document.querySelector('section[aria-label="Discharged"] [role="alert"]')?.textContent.includes('R. Lakshmanan is deteriorating.')`, 3000, 'a gated drop is refused on the target, in the old words')
      expect(await page.evaluate(`!!document.querySelector('section[aria-label="Waiting on"] article[aria-label="R. Lakshmanan"]')`), 'and the card has not moved')
      expect((await auditRows()).filter((r) => r.event === 'PATIENT.DISCHARGED').length === 1, 'one discharge, one audit row')
    },
  },
  {
    name: 'Discharge board (S-13-01): without discharge.write the board and its gates are read, with no Discharge and nothing to drag; without ip.encounter.read it is refused',
    async run() {
      await page.open('/discharge/board', { persona: 'P-06' })
      const text = await page.text()
      expect(text.includes('1 cleared for discharge') && text.includes('Kavya Reddy'), 'P-06 reads the board')
      expect(!(await page.evaluate(`!!document.querySelector('button[aria-label^="Discharge "]')`)), 'no Discharge without discharge.write')
      await page.click('button', 'Board view')
      expect(await page.evaluate(`[...document.querySelectorAll('section[aria-label] article')].every((a) => a.getAttribute('draggable') !== 'true')`), 'no card can be dragged')
      await page.open('/discharge/board', { persona: 'P-13' })
      const refused = await page.text()
      expect(refused.includes('Request access') && !refused.includes('Kavya Reddy'), 'P-13 is refused, and sees nobody')
    },
  },
  {
    name: 'Discharge summary (S-13-02): six empty sections; AI-106 drafts them for its own patient, each decided, then one fixed-wording attestation — asked again after a change — and a signature; published, on record, sent',
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118366/discharge-summary')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-13-02"]')`), 'S-13-02 is drawn')
        expect((await page.text()).includes('0 of 6 sections written · prints in English only — no ಕನ್ನಡ translation'), 'the count, and the print language said plainly')
        await page.click('button', 'Attest and sign')
        const why = await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ')`)
        expect(why.includes('Reason for admission') && why.includes('When to come back') && why.includes('Attestation'), `every reason: ${why}`)
        expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'no confirmation while incomplete')

        await page.click('button', 'Draft with AI')
        await toastSays('6 of 6 sections drafted from the record', 'AI-106 read signed entries only.')
        expect((await page.text()).includes('6 drafted sections need a decision'), 'each draft needs a decision')
        expect((await page.evaluate(`document.querySelectorAll('[role="checkbox"]').length`)) === 1, 'one attestation for the document, not one per section')
        for (let n = 0; n < 6; n++) await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
        expect((await page.text()).includes('6 of 6 sections written'), 'accepted drafts are the text')

        await page.click('[role="checkbox"]', 'I have reviewed this content and it is accurate.')
        await page.type('[id="E-118366:disch:followup"]', ' Oxygen saturation check at the review.')
        await page.until(`document.body.textContent.includes('The summary changed after you ticked this.')`, 3000, 'a change after the tick asks for it again')
        await page.click('button', 'Attest and sign')
        expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'the stale attestation does not sign')
        await page.click('[role="checkbox"]', 'I have reviewed this content and it is accurate.')
        await page.click('button', 'Attest and sign')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Attest and sign this discharge summary?')`, 3000, 'the confirmation')
        expect((await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).includes('printed in English only, published to ABDM'), 'the confirmation says what signing does, truthfully')
        await page.click('[role="alertdialog"] button', 'Attest and sign')
        await toastSays('Discharge summary published', 'ABDM publish queued; discharging from the board releases the bed.')

        const rows = await auditRows()
        expect(rows.some((r) => r.event === 'NOTE.SIGNED' && r.subject === 'SD-P-03' && r.detail.startsWith('Discharge summary signed')), 'signed, on record')
        const att = rows.find((r) => r.event === 'AI.ATTESTED' && r.subject === 'SD-P-03')
        expect(att && att.gate === 'G3' && att.detail.includes('6 drafted sections'), `the attestation, on record once for the document: ${JSON.stringify(att)}`)
        const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent`)
        expect(sent.some((n) => n.recipient === 'patient' && n.detail.includes('no ಕನ್ನಡ translation')) && sent.some((n) => n.recipient === 'colleague' && n.detail.includes('referring doctor')), `sent to the patient and the referring doctor: ${JSON.stringify(sent)}`)

        const locked = await page.text()
        expect(locked.includes('Read-only') && locked.includes('Signed · prints in English only'), 'signed: locked')
        await page.click('button', 'Print A4')
        expect((await page.evaluate(`document.querySelector('[role="dialog"]').textContent`)).includes('Printed in English only. A translation of this summary is not available'), 'the print says it is English only')
        await page.key('Escape')
        await page.click('button', 'Back to the board')
        await page.until(`location.pathname === '/discharge/board'`, 3000, 'back to the board')
        await page.click('[role="tab"]', 'Waiting on')
        expect(!(await page.evaluate(`document.querySelector('[data-screen-id="S-13-01"]').textContent`)).includes('Discharge summary unsigned · Antibiotics'), 'the board reads the signed summary')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: "Discharge summary (S-13-02): no one else's draft; AI off, no Draft with AI; a registrar saves for co-sign, the consultant co-signs, and it goes out; a discharged patient's summary is what is owed",
    async run() {
      const unstub = await stubSpeech({ speech: false })
      try {
        await page.open('/encounter/E-118201/discharge-summary', { persona: 'P-05' })
        const text = await page.text()
        expect(!text.includes('Draft with AI') && !text.includes('piperacillin'), "no one else's draft")
        expect(text.includes('You may write this summary but not sign it'), 'a registrar is told who signs')
        const words = {
          reason: 'Admitted overnight from ED with septic shock needing vasopressors.',
          course: 'Resuscitated, cultures taken, broad-spectrum antibiotics; weaned off vasopressors.',
          diagnosis: 'Septic shock, source under investigation; hyperkalaemia treated.',
          meds: 'Continue the current antibiotic course as charted on the medicines record.',
          followup: 'Review in the medical clinic in two weeks with repeat electrolytes.',
          redflags: 'Return at once with fever, fainting, confusion or reduced urine output.',
        }
        for (const [key, t] of Object.entries(words)) await page.type(`[id="E-118201:disch:${key}"]`, t)
        await page.click('[role="checkbox"]', 'I have reviewed this content and it is accurate.')
        await page.click('button', 'Save for co-sign')
        await page.click('[role="alertdialog"] button', 'Save for co-sign')
        await toastSays('Saved for co-sign', 'discharge.write but not discharge.sign')
        expect((await auditRows()).some((r) => r.event === 'NOTE.COSIGN_QUEUED' && r.detail.startsWith('Discharge summary')), 'queued, on record')

        await becomePersona('P-04')
        await page.open('/clinician/cosign', { fresh: false })
        const queued = await page.evaluate(`[...document.querySelectorAll('button[data-row]')].map((b) => b.textContent).find((t) => t.includes('Joseph Mathew')) ?? ''`)
        expect(queued.includes('Discharge summary'), `in the queue as what it is: "${queued}"`)
        await page.click('button[aria-label="Co-sign — Discharge summary for Joseph Mathew by Dr. Ananya Iyer"]')
        await page.click('[role="alertdialog"] button', 'Co-sign')
        await toastSays('Co-signed')
        const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent`)
        expect(sent.some((n) => n.recipient === 'patient' && n.detail.startsWith('Joseph Mathew')), `a co-signed summary goes out too: ${JSON.stringify(sent)}`)
        await page.open('/encounter/E-118201/discharge-summary', { fresh: false })
        expect((await page.text()).includes('co-signed by Dr. Ananya Iyer'), 'signed with both names')

        // Discharge now, sign later: a patient already discharged, the summary still to write.
        await page.evaluate(`(() => { const c = JSON.parse(localStorage.getItem('indostates.clinical')); c.state.discharges['SD-P-03'] = { patientId: 'SD-P-03', encounterId: 'E-118366', at: '2026-09-21T03:10:00.000Z', by: 'Dr. Ananya Iyer', kind: 'discharge', bed: '4B-12', summarySigned: false }; localStorage.setItem('indostates.clinical', JSON.stringify(c)); return true })()`)
        await page.open('/encounter/E-118366/discharge-summary?ai=off', { fresh: false })
        const owed = await page.text()
        expect(owed.includes('R. Lakshmanan was discharged at 08:40 by Dr. Ananya Iyer') && owed.includes('The discharge stands.'), 'the discharge stands, the summary is owed')
        expect(!owed.includes('Draft with AI'), 'AI off: no Draft with AI')
      } finally {
        await unstub()
      }
    },
  },
  {
    name: 'Medication reconciliation (S-13-03): every line needs a decision and a stopped one a reason; AI-306 proposes at G2; decisions are kept; confirming fixes the list, on record; the board reads it',
    async run() {
      await page.open('/encounter/E-118366/med-rec')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-13-03"]')`), 'S-13-03 is drawn')
      const text = await page.text()
      expect(text.includes('0 of 5 reconciled · 1 interaction to note') && text.includes('Interacts with clarithromycin.'), 'the count, and the interaction on its line')
      await page.click('button', 'Confirm the discharge list')
      const why = await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ')`)
      expect((why.match(/unaccounted for/g) ?? []).length === 5, `every line unaccounted for is named: ${why}`)
      expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'nothing to confirm yet')

      await page.click('button[aria-label="Accept Continued"]')
      expect(await page.evaluate(`document.querySelector('select[aria-label="Decision for Metformin 500mg"]').value === 'continue'`), "AI-306's proposal, accepted, is the decision")
      await pick('select[aria-label="Decision for Atorvastatin 40mg"]', 'continue')
      await pick('select[aria-label="Decision for Piperacillin-tazobactam 4.5g IV"]', 'changed')
      await pick('select[aria-label="Decision for Enoxaparin 40mg SC"]', 'stopped')
      await pick('select[aria-label="Decision for Paracetamol 1g IV"]', 'new')
      await sleep(150)
      expect((await page.text()).includes('1 stopped medicine needs a reason'), 'a stopped line needs a reason')
      await page.click('button', 'Confirm the discharge list')
      expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'not without the reason')

      await page.reload()
      expect(await page.evaluate(`document.querySelector('select[aria-label="Decision for Enoxaparin 40mg SC"]').value === 'stopped'`), 'the decisions are kept with the encounter')
      await page.open('/discharge/board?scope=waiting', { fresh: false })
      expect((await page.text()).includes('Medication reconciliation open'), 'the board says the reconciliation is open')

      await page.open('/encounter/E-118366/med-rec', { fresh: false })
      await page.type('input[aria-label="Why Enoxaparin 40mg SC is not carried forward"]', 'Inpatient thromboprophylaxis only; mobile.')
      await page.click('button', 'Confirm the discharge list')
      await page.click('[role="alertdialog"] button', 'Confirm the discharge list')
      await toastSays('Medication reconciled', 'The discharge list is fixed and on the record.')
      await page.until(`location.pathname === '/encounter/E-118366/discharge-summary'`, 3000, 'on to the summary')
      const row = (await auditRows()).find((r) => r.event === 'MEDREC.CONFIRMED')
      expect(row && row.subject === 'SD-P-03' && row.detail.includes('5 medicines: 2 continued, 1 changed, 1 stopped, 1 new'), `on record: ${JSON.stringify(row)}`)

      await page.open('/encounter/E-118366/med-rec', { fresh: false })
      expect((await page.text()).includes('Confirmed by Dr. Ananya Iyer'), 'who confirmed it')
      expect(await page.evaluate(`[...document.querySelectorAll('select[aria-label^="Decision for"]')].every((s) => s.disabled)`), 'the list is fixed')
      await page.open('/discharge/board?scope=waiting', { fresh: false })
      expect(!(await page.text()).includes('Medication reconciliation open'), 'and the board reads it')
    },
  },
  {
    name: "Medication reconciliation (S-13-03): no one else's medicines; AI off, no proposals, the decisions still the doctor's; without rx.write it is refused",
    async run() {
      await page.open('/encounter/E-118201/med-rec')
      const other = await page.text()
      expect(other.includes('No medicine list to reconcile') && !other.includes('Metformin') && !other.includes('Confirm the discharge list'), "no one else's list, and nothing to confirm")
      await page.open('/encounter/E-118366/med-rec?ai=off', { fresh: false })
      expect(!(await page.evaluate(`!!document.querySelector('[role="region"][aria-label^="AI-306"]')`)), 'AI off: no proposals')
      await pick('select[aria-label="Decision for Metformin 500mg"]', 'continue')
      expect((await page.text()).includes('1 of 5 reconciled'), 'the decisions are still the doctor’s')
      await page.open('/encounter/E-118366/med-rec', { persona: 'P-05' })
      expect((await page.text()).includes('Request access'), 'a registrar without rx.write is refused')
    },
  },
  {
    name: 'Death (S-13-06): four steps in statutory order; no time of death after now; Part I a chain with (a) and (b), AI-810 only when it repeats; a medico-legal case waits for the docket and the acknowledgement; certified once, on record, the admission closed',
    async run() {
      await page.open('/encounter/E-118201/death')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-13-06"]')`), 'S-13-06 is drawn')
      expect((await page.text()).includes('MCCD Form 4 · Verification'), 'the first step')
      const cont = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continue')`
      expect(await page.evaluate(`${cont}.getAttribute('aria-disabled') === 'true'`), 'Continue waits for the step')
      await page.click('button', 'Continue')
      expect((await page.text()).includes('Time of death'), 'pressing it says what is missing')
      await setInput('#dod-time', '2026-09-21T09:30')
      await page.click('button', 'Continue')
      expect((await page.text()).includes('cannot be later than now'), 'a death after the present is refused')
      await setInput('#dod-time', '2026-09-21T07:55')
      await pick('#dod-family', 'By telephone')
      await page.click('button', 'Continue')
      await page.until(`document.body.textContent.includes('MCCD Form 4 · Cause of death')`, 3000, 'on to the cause of death')

      await page.type('#cod-a', 'Septic shock')
      await page.click('button', 'Continue')
      expect((await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ')`)).includes('(b) Due to, or as a consequence of'), '(b) is required')
      await page.type('#cod-b', 'septic shock')
      await page.until(`document.body.textContent.includes('The sequence repeats itself')`, 3000, 'AI-810 speaks when the chain repeats')
      await setInput('#cod-b', 'Community-acquired pneumonia')
      await page.until(`!document.body.textContent.includes('The sequence repeats itself')`, 3000, 'and is silent when it reads as a chain')
      await page.click('button', 'Continue')

      await page.until(`document.body.textContent.includes('MCCD Form 4 · Medico-legal')`, 3000, 'on to medico-legal')
      await page.click('[role="checkbox"]', 'This is a medico-legal case')
      await page.click('button', 'Continue')
      const mlc = await page.evaluate(`[...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ')`)
      expect(mlc.includes('Police station and docket') && mlc.includes('Acknowledgement'), `the docket and the acknowledgement both hold it: ${mlc}`)
      await page.type('#mlc-station', 'Peelamedu PS · 114/2026')
      await page.click('[role="checkbox"]', 'Acknowledgement received and filed')
      await page.click('button', 'Continue')

      await page.until(`document.body.textContent.includes('MCCD Form 4 · Handover')`, 3000, 'on to handover')
      await page.click('button', 'Certify and release')
      expect(!(await page.evaluate(`!!document.querySelector('[role="alertdialog"]')`)), 'not without a receiver')
      await page.type('#handover-to', 'Mary Mathew, wife')
      await pick('#handover-id', 'Passport')
      await page.type('#handover-belongings', 'Wristwatch, wallet, spectacles')
      await page.click('button', 'Certify and release')
      await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Certify the cause of death and release the body?')`, 3000, 'the confirmation')
      await page.click('[role="alertdialog"] button', 'Certify and release')
      await toastSays('MCCD issued', 'Registration queued; handover recorded.')
      await page.until(`location.pathname === '/ip/patients'`, 3000, 'back to the inpatient list')
      const list = await page.evaluate(`[...document.querySelectorAll('ul[aria-label^="Inpatients"] li button')].map((b) => b.textContent).join('|')`)
      expect(!list.includes('Joseph Mathew'), `the admission is closed: ${list}`)

      const row = (await auditRows()).find((r) => r.event === 'DEATH.CERTIFIED')
      expect(
        row && row.subject === 'SD-P-07' && row.detail.includes('(a) Septic shock due to (b) Community-acquired pneumonia') && row.detail.includes('police acknowledgement filed (Peelamedu PS · 114/2026)') && row.detail.includes('released to Mary Mathew, wife'),
        `on record: ${JSON.stringify(row)}`,
      )
      const sent = await page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications')).state.sent[0]`)
      expect(sent && sent.recipient === 'front office' && sent.title === 'Bed ICU-1 released', `the front office is told: ${JSON.stringify(sent)}`)

      await page.open('/encounter/E-118201/death', { fresh: false })
      await page.reload()
      const cert = await page.text()
      for (const t of ['MCCD Form 4 · Certified', 'By telephone', 'Passport', 'Wristwatch, wallet, spectacles', 'Peelamedu PS · 114/2026']) expect(cert.includes(t), `the certificate keeps "${t}"`)
      expect(!(await page.evaluate(`!!document.querySelector('#cod-a')`)), 'nothing on it is editable')
    },
  },
  {
    name: 'Death (S-13-06): a medico-legal patient arrives marked so; AI off, AI-810 is silent; without discharge.sign it is refused; an unknown encounter says so',
    async run() {
      await page.open('/encounter/E-118398/death')
      expect((await page.evaluate(`document.querySelector('[data-screen-id="S-13-06"]').textContent.match(/MLC/g) ?? []`)).length === 1, 'MLC said once, on the banner')
      await setInput('#dod-time', '2026-09-21T07:10')
      await page.click('button', 'Continue')
      await page.type('#cod-a', 'Head injury')
      await page.type('#cod-b', 'head injury')
      await page.click('button', 'Continue')
      expect(await page.evaluate(`document.querySelector('[role="checkbox"]').getAttribute('aria-checked') === 'true'`), 'medico-legal already marked')
      await page.open('/encounter/E-118201/death?ai=off', { fresh: false })
      await setInput('#dod-time', '2026-09-21T07:10')
      await page.click('button', 'Continue')
      await page.type('#cod-a', 'Septic shock')
      await page.type('#cod-b', 'Septic shock')
      await sleep(200)
      expect(!(await page.text()).includes('The sequence repeats itself'), 'AI off: AI-810 is silent')
      await page.open('/encounter/E-118201/death', { persona: 'P-05' })
      expect((await page.text()).includes('Request access'), 'without discharge.sign the certificate is refused')
      await page.open('/encounter/E-000000/death')
      expect((await page.text()).includes('No encounter at this address.'), 'an unknown encounter says so, and certifies nobody')
    },
  },
  {
    name: 'Search: the old kit, by name or UHID; Enter opens the record; nothing matched says why',
    async run() {
      await page.open('/')
      await page.key('/')
      await page.until(`document.querySelector('[role="dialog"][aria-label="Patient search"]')`, 3000, '/ opens the search')
      expect((await page.evaluate(`document.querySelectorAll('[role="dialog"] [role="option"]').length`)) === 6, 'the first six before typing')
      await page.type('[role="dialog"] input[aria-label="Patient search"]', 'laksh')
      await page.until(`document.querySelector('[role="dialog"] [role="option"]')?.textContent.includes('R. Lakshmanan')`, 3000, 'a match by name')
      await page.key('Enter')
      await page.until(`location.pathname === '/patient/ICH-0044051'`, 3000, 'Enter opens the record')
      await page.until(`!document.querySelector('[role="dialog"][aria-label="Patient search"]')`, 3000, 'the palette has closed')
      await page.key('/')
      await page.until(`document.querySelector('[role="dialog"] input[aria-label="Patient search"]')`, 3000, '/ opens it again from the record')
      await page.type('[role="dialog"] input[aria-label="Patient search"]', 'zzz')
      await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Nothing matched. Only the')`, 3000, 'the old no-match line')
    },
  },
  {
    name: 'My Day: AI off sorts by time and hides the finding; AI-LOW arrives collapsed',
    async run() {
      await page.open('/?ai=off')
      expect((await page.text()).includes('Sorted by time · AI ranking is off'), 'the deterministic order, said')
      await page.click('section[aria-label="Attention"] li > button')
      expect(!(await panelText()).includes('AI-212'), 'no AI finding in the panel with AI off')
      await page.open('/?state=AI-LOW')
      const text = await page.text()
      expect(text.includes('Low confidence in this ranking') && text.includes('in time order until you review the ranking'), 'the LOW collapse, in the old words')
      await page.click('button', 'Show the ranking')
      await page.until(`document.body.innerText.includes('Sorted by AI acuity')`, 3000, 'the ranking, once reviewed')
    },
  },
  {
    name: 'My Day: EMPTY, STALE and DENIED in the old words; DENIED shows no patient data',
    async run() {
      await page.open('/?state=EMPTY')
      const empty = await page.text()
      expect(empty.includes('Nothing is waiting on you.') && empty.includes('No session is open, you have no inpatients assigned'), 'the EMPTY copy')
      await page.open('/?state=STALE')
      expect((await page.text()).includes('Data as of 08:06'), 'stale: the old frame dates it 34 minutes back')
      await page.open('/?state=DENIED')
      const denied = await page.text()
      expect(denied.includes('This is not available to you'), 'the refusal')
      expect(!denied.includes('Joseph Mathew') && !denied.includes('Selvi Murugan'), 'and no patient anywhere on screen')
    },
  },
  {
    name: "My Day: the calendar opens on this week; a day's detail shows under it; the month expands in place and a day there peeks — no AI brief",
    async run() {
      await page.open('/')
      expect((await page.evaluate(`document.querySelector('[role="grid"]').getAttribute('aria-label')`)) === 'Week of 21 – 27 Sep 2026', 'this week, Monday first')
      await page.click('button[role="gridcell"][aria-label^="Tuesday 22 September 2026"]')
      const card = `document.querySelector('[role="grid"]').closest('section')`
      await page.until(`${card}.textContent.includes('Coming up') && ${card}.textContent.includes('Booked with you')`, 3000, "the day's detail, under the week")
      expect(!(await page.text()).includes('AI brief'), 'the calendar shows what is booked, not an AI summary of it')
      await page.click('button', 'Month')
      await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'September 2026'`, 3000, 'the month, in place')
      await page.click('button[role="gridcell"][aria-label^="Monday 28 September 2026"]')
      await page.until(`[...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes('Coming up'))`, 3000, 'a day in the month pins its peek')
    },
  },
  {
    name: 'Shell: the rail is the persona\'s — absent modules, More only when needed',
    async run() {
      await page.open('/')
      const p04 = await railLabels()
      for (const l of ['My Day', 'Patient search', 'My patients', 'Results', 'Discharge', 'Stroke-AI Console', 'Telehealth', 'Assistant', 'More'])
        expect(p04.includes(l), `P-04 rail has ${l}: ${p04}`)
      await page.open('/', { persona: 'P-05' })
      const p05 = await railLabels()
      expect(!p05.includes('Stroke-AI Console') && !p05.includes('Telehealth'), `P-05 has no stroke or telehealth: ${p05}`)
      await page.open('/radiology/worklist', { persona: 'P-13' })
      const p13 = await railLabels()
      expect(!p13.includes('My Day') && p13.includes('More'), `P-13: no My Day, Imaging under More: ${p13}`)
      // P-13 may open OPD but not Inpatients: My patients is there, with the one list and no tab to the other.
      await page.open('/op-queue', { persona: 'P-13', fresh: false })
      expect(!(await page.evaluate(`!!document.querySelector('[role="tablist"][aria-label="My patients"]')`)), 'P-13: no Inpatients tab')
    },
  },
  {
    name: 'Shell: the assistant item opens the persona\'s own assistant',
    async run() {
      await page.open('/')
      expect(await page.evaluate(`!!document.querySelector('nav[aria-label="Main"] a[href="/assistant/clinician"]')`), 'P-04 → the clinician assistant')
      await page.open('/stroke/wall', { persona: 'P-35' })
      await page.open('/stroke/ai-console', { fresh: false })
      expect(await page.evaluate(`!!document.querySelector('nav[aria-label="Main"] a[href="/assistant/stroke"]')`), 'P-35 → the stroke assistant')
    },
  },
  {
    name: 'Shell: facility switch — the four facilities, the old caution toast',
    async run() {
      await page.open('/')
      await page.click('button[title^="Facility"]')
      const rows = await page.evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((r) => r.textContent)`)
      expect(rows.length === 4 && ['ICH', 'ITP', 'IPL', 'IUD'].every((c) => rows.some((r) => r.startsWith(c))), `four facilities: ${rows}`)
      await page.click('[role="menu"] [role="menuitem"]', 'Pollachi')
      await page.until(`document.body.innerText.includes('Scope changed to IPL')`, 3000, 'the caution toast')
      expect((await page.text()).includes('What you may read and write has changed with it.'), 'its detail, word for word')
      expect(await page.evaluate(`document.querySelector('button[title^="Facility"]').textContent.includes('IPL')`), 'the pill shows the new scope')
    },
  },
  {
    name: 'Shell: persona switch lands where the atlas says and says so',
    async run() {
      await page.open('/')
      await page.click('button[aria-label$="user menu"]')
      await page.click('[role="menu"] [role="menuitem"]', 'Radiologist')
      await page.until(`location.pathname === '/radiology/worklist'`, 3000, 'the radiologist landing')
      await page.until(`document.body.innerText.includes('Signed in as Radiologist')`, 3000, 'the toast names the persona')
    },
  },
  {
    name: 'Shell: the bell — the old three, grouped; each opens its source; absent where the persona cannot go',
    async run() {
      await page.open('/')
      expect(await page.evaluate(`!!document.querySelector('button[aria-label="Notifications, 3 unread"]')`), 'three unread for P-04')
      await page.click('button[aria-label^="Notifications"]')
      const text = await page.evaluate(`document.querySelector('[role="menu"]').textContent`)
      for (const t of ['Critical — interrupts and escalates', 'Critical potassium 6.8 mmol/L', 'Code stroke active at Pollachi', 'Co-signatures pending'])
        expect(text.includes(t), `bell shows "${t}"`)
      expect(!text.includes('projected'), 'no forecast in the stroke item')
      await page.click('[role="menu"] [role="menuitem"]', 'Critical potassium')
      await page.until(`location.pathname === '/results/inbox'`, 3000, 'opens the results inbox')
      await page.open('/', { persona: 'P-05' })
      // A resident holds neither note.cosign nor stroke.case.read, so only the critical result is theirs.
      expect(await page.evaluate(`!!document.querySelector('button[aria-label="Notifications, 1 unread"]')`), 'a resident sees only what they may open')
    },
  },
  {
    name: 'Shell: Back names where it goes when opened cold; ⓘ shows the atlas trace',
    async run() {
      await page.open('/patient/ICH-0044120')
      expect(await page.evaluate(`!!document.querySelector('button[aria-label="Back to My Day"]')`), 'cold: Back to My Day')
      await page.click('button[aria-label="About this screen"]')
      await page.until(`document.querySelector('[role="dialog"][aria-label^="About"]')?.innerText.includes('S-06-11 · M-06')`, 3000, 'the screen id and module')
      await page.click('button[aria-label="Back to My Day"]')
      await page.until(`location.pathname === '/'`, 3000, 'back on My Day')
    },
  },
  {
    name: 'No sign-in: the portal opens on My Day; an old /login link lands on My Day, or on the address in its ?next=',
    async run() {
      await page.open('/', { signedIn: false })
      await page.until(`location.pathname === '/' && !!document.querySelector('[data-screen-id="S-06-01"]')`, 4000, 'My Day, with no session at all')
      await page.open('/login', { fresh: false })
      await page.until(`location.pathname === '/'`, 3000, 'an old sign-in link lands on My Day')
      await page.open('/login?next=%2Fop-queue%3Ftype%3Dfollow-up', { fresh: false })
      await page.until(`location.pathname === '/op-queue'`, 3000, 'and one with ?next= on where it was going')
      expect((await page.path()) === '/op-queue?type=follow-up', `the query comes too: ${await page.path()}`)
      await page.click('button[aria-label^="Dr. Ananya Iyer"], button[aria-haspopup="menu"]', 'Dr. Ananya Iyer')
      expect(!(await page.text()).includes('Sign out'), 'nothing to sign out of')
    },
  },
  {
    name: 'A screen the persona cannot use shows the refusal, and Go back goes somewhere',
    async run() {
      await page.open('/stroke/activate')
      const text = await page.text()
      expect(text.includes('This is not available to you') && text.includes('stroke.activate'), 'the uniform refusal naming the capability')
      await page.click('button', 'Request access')
      await page.until(`document.body.innerText.includes('Access request sent')`, 3000, 'the request toast')
      await page.click('button', 'Go back')
      await page.until(`location.pathname === '/'`, 3000, 'opened cold, Go back lands on the persona landing')
    },
  },
  {
    name: 'Personas land where the atlas says; one without My Day skips it',
    async run() {
      await page.open('/', { persona: 'P-13' })
      await page.until(`location.pathname === '/radiology/worklist'`, 3000, 'P-13 lands on the imaging worklist')
      await page.open('/', { persona: 'P-06' })
      expect((await page.path()) === '/', 'P-06 (whose /ed/board does not exist) stays on My Day')
    },
  },
  {
    name: 'Old deep links land in the new build, one hop, query kept',
    async run() {
      await page.open('/clinician?open=search')
      expect((await page.path()) === '/?open=search', `landed on ${await page.path()}`)
      await page.open('/patient/ICH-0044120/record')
      expect((await page.path()) === '/patient/ICH-0044120', `landed on ${await page.path()}`)
      // The last screens to move (stroke) are drawn now: no address shows the "being moved" frame any more.
      await page.open('/stroke/case/STR-0141/clock')
      expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-18-06"]')`) && !(await page.text()).includes('being moved'), 'the case clock itself, not the frame')
      expect((await page.text()).includes('STR-0141'), 'an id with no case behind it is named, not swapped for another case')
    },
  },
  {
    name: 'Toasts stack on the shared store, dismissable, announced not focused',
    async run() {
      await page.open('/')
      await page.click('button[title^="Facility"]')
      await page.click('[role="menu"] button, [role="menu"] [role="menuitem"]')
      await page.until(`document.querySelector('[role="status"] button[aria-label="Dismiss"]')`, 3000, 'a toast with Dismiss')
      const inStatus = await page.evaluate(`[...document.querySelectorAll('[role="status"]')].some((r) => r.textContent.includes('Scope changed'))`)
      expect(inStatus, 'the toast text is inside role="status"')
      const focused = await page.evaluate(`!!document.activeElement?.closest('[role="status"]')`)
      expect(!focused, 'a new toast must not take focus')
      await page.click('[role="status"] button[aria-label="Dismiss"]')
      await page.until(`!document.querySelector('[role="status"] button[aria-label="Dismiss"]')`, 3000, 'toast dismissed')
    },
  },
  {
    name: 'AI fabric switch: old copy, hides the bubble, per session',
    async run() {
      await page.open('/')
      expect(await page.evaluate(`!!document.querySelector('button[aria-label="Assistant"]')`), 'bubble present with AI on')
      await page.click('button[aria-label$="user menu"]')
      await page.click('[role="switch"][aria-label="AI fabric enabled"]')
      await page.until(`document.body.innerText.includes('AI fabric off — AI-OFF state')`, 3000, 'the old off toast')
      expect(await page.evaluate(`!document.querySelector('button[aria-label="Assistant"]')`), 'bubble gone with AI off')
      await page.reload()
      expect(await page.evaluate(`!!document.querySelector('button[aria-label="Assistant"]')`), 'the switch is per session: back on after a reload')
    },
  },
  {
    name: 'A forced state from the URL clears when the screen changes',
    async run() {
      await page.open('/?state=OFFLINE')
      expect((await page.text()).includes('changes waiting to sync'), 'offline strip shown')
      await page.click('a[href^="/patient/"]')
      await page.until(`location.pathname.startsWith('/patient/')`, 3000, 'record opened')
      await page.click('button[aria-label^="Back"]')
      await page.until(`location.pathname === '/'`, 3000, 'back on My Day')
      expect(!(await page.text()).includes('changes waiting to sync'), 'the forced state went with the screen')
    },
  },
  {
    name: "The old harness's window.__forceState drives this build",
    async run() {
      await page.open('/')
      await page.until('typeof window.__forceState === "function"', 3000, 'the DEV hook')
      await page.evaluate(`window.__forceState('STALE')`)
      await page.until(`document.body.innerText.includes('Data as of')`, 3000, 'stale chip')
      await page.click('button', 'Refresh')
      await page.until(`!document.body.innerText.includes('Data as of')`, 3000, 'stale chip cleared by Refresh')
    },
  },
]

/* ------------------------------------------------------- module flow files */

/**
 * Each module's flows live in `scripts/shri-flows/<module>.mjs`, so screens
 * moved in parallel never edit this file. A module file default-exports
 * `(helpers) => flows[]`, with the same helpers the flows above use.
 */
const sentItems = () => page.evaluate(`JSON.parse(localStorage.getItem('shri.notifications') ?? '{"state":{"sent":[]}}').state.sent`)
const helpers = { page, expect, sleep, send, auditRows, sentItems, panelText, attentionNames, toastSays, pick, becomePersona, saveForCoSign, setInput, stubSpeech, railLabels, SIGN_RX }
const MODULES = fileURLToPath(new URL('./shri-flows/', import.meta.url))
if (existsSync(MODULES)) {
  for (const file of readdirSync(MODULES).filter((f) => f.endsWith('.mjs')).sort()) {
    FLOWS.push(...(await import(pathToFileURL(join(MODULES, file)).href)).default(helpers))
  }
}

/* ------------------------------------------------------------------ run */

let failed = 0
for (const flow of FLOWS.filter((f) => !ONLY || ONLY.some((o) => f.name.toLowerCase().includes(o)))) {
  consoleErrors = []
  try {
    await freshTab()
    await flow.run()
    if (consoleErrors.length) throw new Error(`console errors: ${consoleErrors.join(' || ').slice(0, 400)}`)
    console.log(`PASS  ${flow.name}`)
  } catch (e) {
    failed += 1
    console.log(`FAIL  ${flow.name}\n      ${e.message}`)
  }
}
console.log(`\n${failed === 0 ? 'All flows pass' : `${failed} flow${failed === 1 ? '' : 's'} failed`}`)
tab?.sock.close()
browser.sock.close()
chrome.kill()
process.exit(failed === 0 ? 0 : 1)
