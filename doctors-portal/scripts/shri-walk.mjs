/**
 * Layout and target audit for the Shri Health screens, in both themes, at
 * every width from a 320px phone to a 2560px ultrawide.
 *
 * For each route × theme × width it asserts:
 *   · the page rendered, with no console error or uncaught exception
 *   · nothing scrolls sideways — `scrollWidth ≤ innerWidth`
 *   · every visible, enabled control is a 44 × 44 target — MEASURED BY
 *     HIT-TESTING, not by box size: nine points across the 44px square centred
 *     on the control must all land on the control. That credits a ::before hit
 *     area, and fails one that is clipped by an overflow or covered by a
 *     neighbour's. A point covered by an unrelated fixed or sticky layer (the
 *     tab bar, the rail) is the layer's, not the control's, and is skipped.
 *     A control inside a scroller that fails where it rests is judged again
 *     scrolled to the centre of its scroller, where the reader can put it.
 *     A bar on the Today panel's timeline (`data-timeline-bar`) is as wide as
 *     the time it stands for — a 15-minute gap is narrow by design — so it is
 *     named but not held to 44px; each activity is also a full-size card.
 *   · every control has an accessible name
 *   · every `role=tab` sits in a `role=tablist` and carries `aria-selected`
 *   · a main-nav link to the current page carries `aria-current="page"`, and
 *     no link to another page does
 *   · no control runs past the viewport's edge (overflow-x: clip and fixed
 *     layers hide that from scrollWidth); with INSETS (an emulated notched
 *     phone) none sits under a side notch, none sits under the status bar at
 *     the top of the page, and no fixed control (tab bar, bubble, sheets) sits
 *     under the home indicator
 *
 * A URL with `open=` (the DEV overlay hook) audits only the top-most dialog or
 * menu — the scrim covers everything under it by design.
 *
 * Usage:  npm run dev  (or a production preview on the same port)
 *         node scripts/shri-walk.mjs
 * Env:    BASE    http://localhost:5180
 *         ROUTES  comma-separated paths (default: My Day, a record, and a screen still being moved)
 *         WIDTHS  comma-separated px     (default: 320 … 2560)
 *         THEMES  light,dark
 *         SHOTS   a directory to write one screenshot per combination into
 *         INSETS  top,right,bottom,left safe-area insets to emulate, e.g. 47,0,34,0
 *         SEED    a JSON object of localStorage keys to values, written before
 *                 the app runs — a record already drafted, say (as shri-contrast)
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const ROUTES = (process.env.ROUTES ?? '/,/patient/ISH-0044051,/op-queue').split(',').filter(Boolean)
const WIDTHS = (process.env.WIDTHS ?? '320,360,375,390,414,768,1023,1024,1279,1280,1440,1920,2560').split(',').map(Number)
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')
const SHOTS = process.env.SHOTS
const INSETS = process.env.INSETS ? process.env.INSETS.split(',').map(Number) : null
const PORT = Number(process.env.CDP_PORT ?? 9366)

if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'shri-walk-'))
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

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((p) => p.type === 'page')
      if (pages[0]) return pages[0].webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('no debugging target')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const pending = new Map()
let errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    return
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    return
  }
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
})
/* A reload in the middle of a call (the dev server's hot reload) can drop its
   reply, so no call waits more than 20s — it fails and the run carries on. */
const send = (method, params = {}) =>
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
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

await send('Page.enable')
await send('Runtime.enable')

/* The theme is seeded into the persisted store before any app script runs, so
   the same audit works against the dev server and a production build. So is a
   signed-in session (the same flag the old harness's `?e2e=1` writes), or
   every route would audit the sign-in redirect. */
let seedScript = null
async function seedTheme(theme) {
  if (seedScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScript })
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      const k = 'shri.ui';
      const cur = JSON.parse(localStorage.getItem(k) || '{}');
      cur.state = Object.assign({}, cur.state, { theme: ${JSON.stringify(theme)} });
      if (cur.version === undefined) cur.version = 2;
      localStorage.setItem(k, JSON.stringify(cur));
      const sk = 'indostates.session';
      const ses = JSON.parse(localStorage.getItem(sk) || '{}');
      ses.state = Object.assign({}, ses.state, { signedIn: true });
      ses.version = Math.max(ses.version || 0, 2);
      localStorage.setItem(sk, JSON.stringify(ses));
      const extra = ${JSON.stringify(process.env.SEED ?? '{}')};
      for (const [key, value] of Object.entries(JSON.parse(extra))) localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}`,
  })
  seedScript = identifier
}

const AUDIT = (overlay, insets) => `
(() => {
  const SEL = 'button, a[href], [role=button], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=radio], [role=option], input:not([type=hidden]), select, textarea';
  const out = { vw: innerWidth, sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), rendered: false, small: [], unnamed: [], tabs: [], nav: [], insets: [] };
  const root = document.querySelector('.shri-root');
  if (!root) return out;
  out.rendered = root.querySelector('main, [role=dialog], [role=alertdialog]') !== null && root.textContent.trim().length > 40;

  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) === 0) return false;
    }
    return true;
  };
  const describe = (el) => {
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 42);
    const role = el.getAttribute('role');
    return el.tagName.toLowerCase() + (role ? '[' + role + ']' : '') + ' "' + name + '"';
  };
  const layer = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return n;
    }
    return null;
  };
  /** The nearest ancestor that scrolls — not merely one that clips. */
  const scroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (/(auto|scroll)/.test(c.overflowX + c.overflowY) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return n;
    }
    return null;
  };
  const clipped = (el, r) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(c.overflowX + c.overflowY)) {
        const b = n.getBoundingClientRect();
        if (r.top < b.top || r.bottom > b.bottom || r.left < b.left || r.right > b.right) return true;
      }
    }
    return false;
  };

  let scope = root;
  if (${overlay}) {
    const layers = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [role=menu]')].filter(shown);
    if (layers.length) scope = layers[layers.length - 1];
  }

  const controls = [...scope.querySelectorAll(SEL)].filter(
    (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[aria-hidden="true"]') && shown(el),
  );

  // Edges. overflow-x: clip and fixed layers both hide an overflow from
  // scrollWidth, so every control is also checked against the viewport's own
  // edges — and, when INSETS emulates a notched phone, against the insets.
  {
    const inset = ${JSON.stringify(insets)};
    const [t, rt, b, l] = inset ?? [0, 0, 0, 0];
    window.scrollTo(0, 0);
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      if (clipped(el, r)) continue; // scrolled out of its box: not on screen, so under nothing
      const fixed = layer(el) && getComputedStyle(layer(el)).position === 'fixed';
      const where = [];
      if (r.left < l - 0.5 || r.right > innerWidth - rt + 0.5) where.push(inset && (l || rt) ? 'under a side notch' : 'past the viewport edge');
      if (inset && t && r.bottom > 0 && r.top < innerHeight && r.top < t - 0.5) where.push('under the status bar');
      if (fixed && r.bottom > innerHeight - b + 0.5) where.push(inset && b ? 'under the home indicator' : 'below the viewport');
      if (where.length) out.insets.push(describe(el) + ' ' + where.join(' + '));
    }
  }
  for (const el of controls) {
    const named =
      el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') ||
      el.textContent.trim() || (el.labels && el.labels.length) || el.getAttribute('placeholder');
    if (!named) out.unnamed.push(describe(el));
    if (el.hasAttribute('data-timeline-bar')) continue;

    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth || clipped(el, r)) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      r = el.getBoundingClientRect();
    }
    const probe = (box) => {
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      let miss = null;
      for (const dx of [-21, 0, 21]) {
        for (const dy of [-21, 0, 21]) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit === el || el.contains(hit)) continue;
          const cover = layer(hit);
          if (cover && !cover.contains(el)) continue;
          miss = describe(hit.closest(SEL) || hit);
        }
      }
      return miss;
    };
    let bad = probe(r);
    // Inside a scroller, a control resting against its edge has part of its hit area scrolled out of
    // view — the reader scrolls it clear. Judge it where it can be: centred in its scroller.
    if (bad && scroller(el)) {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      r = el.getBoundingClientRect();
      bad = probe(r);
    }
    if (bad) out.small.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height), hit: bad });
  }

  for (const t of scope.querySelectorAll('[role=tab]')) {
    if (!t.closest('[role=tablist]') || !t.hasAttribute('aria-selected')) out.tabs.push(describe(t));
  }
  // Every visible main-nav link to this page says so; no link to another page does.
  for (const nav of [...document.querySelectorAll('nav[aria-label="Main"]')].filter(shown)) {
    for (const a of nav.querySelectorAll('a[href]')) {
      const here = new URL(a.href).pathname === location.pathname;
      const marked = a.getAttribute('aria-current') === 'page';
      if (here && !marked) out.nav.push('not marked current: ' + describe(a));
      if (!here && marked) out.nav.push('marked current but elsewhere: ' + describe(a));
    }
  }
  window.scrollTo(0, 0);
  return out;
})()`

async function waitForApp() {
  for (let i = 0; i < 40; i += 1) {
    const ok = await evaluate(`(() => { const r = document.querySelector('.shri-root'); return !!r && r.textContent.trim().length > 40 })()`).catch(() => false)
    if (ok) break
    await sleep(150)
  }
  await evaluate('document.fonts.ready.then(() => true)').catch(() => {})
  await sleep(650) // overlay and card entrances run 220ms; month slide and toast less
}

const results = []
for (const theme of THEMES) {
  await seedTheme(theme)
  for (const width of WIDTHS) {
    const height = width < 768 ? 800 : 1000
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 })
    if (INSETS) {
      const [top, right, bottom, left] = INSETS
      await send('Emulation.setSafeAreaInsetsOverride', { insets: { top, right, bottom, left, topMax: top, rightMax: right, bottomMax: bottom, leftMax: left } })
    }
    for (const route of ROUTES) {
      errors = []
      await send('Page.navigate', { url: `${BASE}${route}` })
      await waitForApp()
      const overlay = route.includes('open=')
      if (SHOTS) {
        const { data } = await send('Page.captureScreenshot', { format: 'png' })
        const name = `${theme}-${width}-${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}.png`
        writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'))
      }
      const a = await evaluate(AUDIT(overlay, INSETS)).catch((e) => ({
        vw: width, sw: width, rendered: false, small: [], unnamed: [], tabs: [], nav: [], insets: [], failure: String(e),
      }))
      results.push({ theme, width, route, errors: [...errors, ...(a.failure ? [a.failure] : [])], ...a })
    }
  }
}

/* ------------------------------------------------------------- report */
let failed = 0
const detail = new Map()
const note = (key, width) => {
  if (!detail.has(key)) detail.set(key, [])
  detail.get(key).push(width)
}
for (const r of results) {
  const problems = []
  if (!r.rendered) problems.push('did not render')
  if (r.errors.length) problems.push(`${r.errors.length} console error(s)`)
  if (r.sw > r.vw) problems.push(`scrolls sideways ${r.sw}>${r.vw}`)
  if (r.small.length) problems.push(`${r.small.length} target(s) < 44`)
  if (r.unnamed.length) problems.push(`${r.unnamed.length} unnamed`)
  if (r.tabs.length) problems.push(`${r.tabs.length} tab role issue(s)`)
  if (r.nav.length) problems.push(`${r.nav.length} nav aria-current issue(s)`)
  if (r.insets.length) problems.push(`${r.insets.length} past an edge or inset`)
  const ok = problems.length === 0
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.theme.padEnd(5)} ${String(r.width).padStart(4)}  ${r.route}${ok ? '' : '  — ' + problems.join(' · ')}`)
  for (const e of r.errors) note(`${r.route} · ${r.theme} · console: ${e.slice(0, 160)}`, r.width)
  for (const s of r.small) note(`${r.route} · target ${s.el} ${s.w}×${s.h} → hits ${s.hit}`, `${r.theme[0]}${r.width}`)
  for (const u of r.unnamed) note(`${r.route} · unnamed ${u}`, `${r.theme[0]}${r.width}`)
  for (const t of r.tabs) note(`${r.route} · tab role ${t}`, `${r.theme[0]}${r.width}`)
  for (const n of r.nav) note(`${r.route} · nav ${n}`, `${r.theme[0]}${r.width}`)
  for (const i of r.insets) note(`${r.route} · ${i}`, `${r.theme[0]}${r.width}`)
}
if (detail.size) {
  console.log('\nDetails (where → at which theme/width):')
  for (const [k, ws_] of detail) console.log(`  · ${k}\n      ${[...new Set(ws_)].join(' ')}`)
}
console.log(`\n${results.length - failed}/${results.length} combinations pass`)

ws.close()
chrome.kill()
process.exit(failed ? 1 : 0)
