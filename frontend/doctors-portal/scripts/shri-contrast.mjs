/**
 * Text-contrast audit for the Shri Health build, in both themes.
 *
 * The method is `scripts/contrast.mjs`'s, carried over unchanged: MEASURED ON
 * RENDERED PIXELS. The page is screenshotted over the DevTools Protocol, the
 * PNG is drawn back into a canvas, and each text run's background is either
 * the nearest declared opaque fill or the modal pixel inside its box
 * (excluding pixels near the text colour, so a small solid control is not
 * mistaken for its own glyphs). AA: 4.5:1, or 3:1 for text ≥ 24px or ≥ 18.66px
 * bold. Text inside a disabled control is exempt (WCAG 1.4.3).
 *
 * What differs from the old script is only how the theme is chosen: this build
 * keeps it in `shri.ui` (light / dark), seeded before any app script runs, and
 * the session flag goes into `indostates.session` the same way the old
 * harness's `?e2e=1` does.
 *
 * Usage:  npm run dev                         (or a production preview)
 *         node scripts/shri-contrast.mjs
 * Env:    BASE    http://localhost:5180
 *         ROUTES  comma-separated paths (default: My Day and a record)
 *         THEMES  light,dark
 *         WIDTH   1440
 *         SEED    a JSON object of localStorage keys to values, written before
 *                 the page loads — to measure a state only a click reaches
 *                 (a drafted rewrite, a translation) without clicking
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const ROUTES = (process.env.ROUTES ?? '/,/patient/ISH-0044051').split(',').filter(Boolean)
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')
const WIDTH = Number(process.env.WIDTH ?? 1440)
const PORT = Number(process.env.CDP_PORT ?? 9388)

const profile = mkdtempSync(join(tmpdir(), 'shri-contrast-'))
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},1100`,
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
})
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

let seedScript = null
async function seed(theme) {
  if (seedScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScript })
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      if (!localStorage.getItem('shri.jitsiDomain')) localStorage.setItem('shri.jitsiDomain', 'meet.jit.si'); // tests stay off the real Jitsi
      const ui = JSON.parse(localStorage.getItem('shri.ui') || '{}');
      ui.state = { ...(ui.state || {}), theme: '${theme}' };
      localStorage.setItem('shri.ui', JSON.stringify({ ...ui, version: ui.version ?? 1 }));
      const s = JSON.parse(localStorage.getItem('indostates.session') || '{}');
      s.state = { ...(s.state || {}), signedIn: true };
      s.version = Math.max(s.version ?? 0, 2);
      localStorage.setItem('indostates.session', JSON.stringify(s));
      const extra = ${JSON.stringify(process.env.SEED ?? '{}')};
      for (const [k, v] of Object.entries(JSON.parse(extra))) localStorage.setItem(k, JSON.stringify(v));
    } catch {}`,
  })
  seedScript = identifier
}

const AUDIT = `
(async () => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const [r, g, b, a] = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

  const img = new Image();
  img.src = window.__shot;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const scale = img.naturalWidth / window.innerWidth;

  const sampledBg = (r, fg) => {
    const x0 = Math.max(0, Math.round(r.left * scale));
    const y0 = Math.max(0, Math.round(r.top * scale));
    const w = Math.min(cv.width - x0, Math.round(r.width * scale));
    const h = Math.min(cv.height - y0, Math.round(r.height * scale));
    if (w < 2 || h < 2) return null;
    const data = ctx.getImageData(x0, y0, w, h).data;
    const counts = new Map();
    const near = (i) => fg && Math.abs(data[i] - fg.r) < 40 && Math.abs(data[i + 1] - fg.g) < 40 && Math.abs(data[i + 2] - fg.b) < 40;
    for (let i = 0; i < data.length; i += 4) {
      if (near(i)) continue;
      const key = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    let best = null, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (near(i)) continue;
      const key = ((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2);
      if (key === best) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n += 1; }
    }
    return n === 0 ? null : { r: sr / n, g: sg / n, b: sb / n, a: 1 };
  };

  const out = [];
  // An address with \`open=\` measures only the top-most dialog, as the walk does: the scrim covers
  // everything under it by design, and text under a scrim is not text anyone is asked to read.
  const layers = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].filter((d) => d.getBoundingClientRect().width > 0);
  const scope = location.search.includes('open=') && layers.length ? layers[layers.length - 1] : document.querySelector('.shri-root');
  for (const el of scope ? scope.querySelectorAll('*') : []) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own.length < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.3) continue;
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.top < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) continue;
    // Text under something else — a sticky action bar it has scrolled beneath — is not text on show.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue;
    const fg = parse(s.color);
    if (!fg) continue;
    let bg = null;
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const ns = getComputedStyle(node);
      if (ns.backgroundImage && ns.backgroundImage !== 'none') break;
      const c = parse(ns.backgroundColor);
      if (c && c.a >= 0.99) { bg = c; break; }
      if (c && c.a > 0) break;
    }
    if (!bg) bg = sampledBg(r, fg);
    if (!bg) continue;
    const size = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, bg), bg);
    out.push({ text: own.slice(0, 44), size: Math.round(size * 10) / 10, weight, need, got: Math.round(got * 100) / 100, pass: got >= need - 0.005 });
  }
  out.sort((a, b) => a.got - b.got);
  return { total: out.length, worst: out[0], failures: out.filter((o) => !o.pass) };
})()
`

let bad = 0
for (const theme of THEMES) {
  await seed(theme)
  console.log(`\n=== ${theme} ===`)
  for (const route of ROUTES) {
    await send('Page.navigate', { url: `${BASE}${route}` })
    let ready = false
    for (let i = 0; i < 40 && !ready; i += 1) {
      await sleep(200)
      ready = await evaluate(`(() => { const r = document.querySelector('.shri-root'); return !!r && r.textContent.trim().length > 40 })()`).catch(() => false)
    }
    // Long enough for fonts, the theme and the entrance motion to settle.
    await sleep(1600)
    await evaluate('document.fonts.ready')
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await evaluate(`window.__shot = 'data:image/png;base64,${data}'`)
    const r = await evaluate(AUDIT)
    const fails = r.failures.filter((f) => f.got < f.need - 0.05)
    bad += fails.length + (ready ? 0 : 1)
    console.log(
      `${!ready ? 'FAIL' : fails.length === 0 ? 'PASS' : 'FAIL'}  ${route.padEnd(28)} ${String(r.total).padStart(3)} text runs · worst ${r.worst?.got}:1 (needs ${r.worst?.need}) "${r.worst?.text ?? ''}"${ready ? '' : ' · did not render'}`,
    )
    for (const f of fails.slice(0, 8)) console.log(`        ${f.got}:1 need ${f.need} · ${f.size}px/${f.weight} · "${f.text}"`)
  }
}

console.log(`\n---- ${bad} problem${bad === 1 ? '' : 's'} ----`)
ws.close()
chrome.kill()
process.exit(bad === 0 ? 0 : 1)
