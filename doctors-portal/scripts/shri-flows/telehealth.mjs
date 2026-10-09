/**
 * Telehealth (M-27): Video visits (S-27-02), the video visit itself (S-27-03)
 * and the tele-prescription with its hard-coded category gate (S-27-04).
 * The call is a Jitsi room inside the visit page — here a stand-in for Jitsi's
 * IFrame API, so no network and no camera are needed. The recording and live
 * transcript run against the speech service's scripted stand-in
 * (backend/tools/mock_service.py) and a throwaway transcript store
 * (backend/telehealth), with a tone for the microphone and a canvas for the
 * shared tab. The video visits are the shared teleconsults — Fatima Bi and Arjun
 * Nair — and recording consent is the patient's, from the patient portal: Arjun
 * agreed, Fatima has not answered. The patient portal's stand-in (/demo/patient)
 * puts a patient in the visit's room to wait; another window of the browser is
 * played by writing the shared waiting list and telling this window, as the
 * browser does.
 * Loaded by scripts/shri-flows.mjs.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend')
const ASR_PORT = 8796
const STORE_PORT = 8795

/** A microphone that hums and a shared tab that is a ticking canvas with a hum of its own: real streams, so the recorder and the worklet have something to take. The share's options are kept, to check what was asked for. */
const MEDIA_STUB = `(() => {
  const tone = (hz) => { const ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = hz; const d = ctx.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream }
  navigator.mediaDevices.getUserMedia = async () => tone(220)
  navigator.mediaDevices.getDisplayMedia = async (opts) => {
    window.__shareOptions = opts
    const c = document.createElement('canvas'); c.width = 320; c.height = 180
    const g = c.getContext('2d'); let n = 0
    setInterval(() => { g.fillStyle = n++ % 2 ? '#dde' : '#edd'; g.fillRect(0, 0, 320, 180) }, 100)
    const s = c.captureStream(10)
    tone(330).getAudioTracks().forEach((t) => s.addTrack(t))
    return s
  }
  window.open = () => null
})()`

/** Jitsi's IFrame API, stood in: a box where the video would be, the patient joining a moment later, and the events the page listens for. */
const JITSI_STUB = `(() => {
  window.JitsiMeetExternalAPI = class {
    constructor(domain, o) {
      this.l = {}
      const d = document.createElement('div')
      d.setAttribute('data-jitsi-stub', o.roomName)
      d.style.cssText = 'width:100%;height:100%;background:#123'
      o.parentNode.appendChild(d)
      this.d = d
      window.__jitsi = this
      window.__jitsiDomain = domain
      window.__jitsiOptions = o
      window.__jitsiDisposed = false
      // Someone joins a moment later — unless this side is to wait alone.
      if (!window.__jitsiAlone) setTimeout(() => this.emit('participantJoined', { id: 'patient-1', displayName: 'Patient' }), 300)
    }
    addListener(e, f) { (this.l[e] = this.l[e] || []).push(f) }
    emit(e, x) { (this.l[e] || []).forEach((f) => f(x || {})) }
    executeCommand() {}
    getIFrame() { return this.d }
    dispose() { this.d.remove(); window.__jitsiDisposed = true }
  }
})()`

/** A camera: a painted canvas, so the doctor's own corner picture has a picture. */
const CAMERA_STUB = `(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 120
    const g = c.getContext('2d')
    setInterval(() => { g.fillStyle = '#468'; g.fillRect(0, 0, 160, 120) }, 100)
    return c.captureStream(10)
  }
})()`

/** The computer's notices, stood in: what would pop up is kept, permission starts unasked, and this window is behind others. */
const NOTICE_STUB = `(() => {
  window.__notices = []
  class FakeNotification {
    constructor(title, o) { this.title = title; this.body = o && o.body; this.tag = o && o.tag; this.onclick = null; window.__notices.push(this) }
    close() { this.closed = true }
    // The browser keeps the answer for the site, across pages.
    static requestPermission() { FakeNotification.permission = 'granted'; localStorage.setItem('__noticePermission', 'granted'); return Promise.resolve('granted') }
  }
  FakeNotification.permission = localStorage.getItem('__noticePermission') || 'default'
  window.Notification = FakeNotification
  document.hasFocus = () => false
})()`

/** The hospital's Jitsi answering "how many are in this room?" — set window.__roomSize[room] to a number; unset is no such room. */
const ROOM_SIZE_STUB = `(() => {
  window.__roomSize = {}
  window.__asked = []
  const real = window.fetch
  window.fetch = async (u, o) => {
    const url = String(u)
    if (!url.includes('/room-size')) return real(u, o)
    const room = new URL(url).searchParams.get('room')
    window.__asked.push(room)
    const n = window.__roomSize[room]
    return n === undefined ? new Response('', { status: 404 }) : new Response(JSON.stringify({ participants: n }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
})()`

export default ({ page, expect, toastSays, send, sleep, auditRows, stubSpeech }) => {
  const LIST = `ul[aria-label="Today\\'s video visits"] > li[data-status]`
  const cards = () => page.evaluate(`[...document.querySelectorAll('${LIST}')].map((li) => li.textContent)`)
  const statuses = () => page.evaluate(`[...document.querySelectorAll('${LIST}')].map((li) => li.dataset.status)`)
  const statusOfCard = (name) => page.evaluate(`[...document.querySelectorAll('${LIST}')].find((li) => li.textContent.includes(${JSON.stringify(name)}))?.dataset.status`)
  const countOf = (word) => page.evaluate(`document.querySelector('[data-count="${word}"] span').textContent`)
  const visitStatus = () => page.evaluate(`document.querySelector('[data-visit-status]')?.dataset.visitStatus`)
  const signDisabled = () => page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sign the tele-prescription')).disabled`)
  const btnDisabled = (label) => page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)})).disabled`)

  return [
    {
      name: 'Telehealth (S-27-02): Video visits are the shared teleconsults — the same two patients, times and reasons as the Dashboard and the OPD queue — with the counts that filter and each status with its button',
      async run() {
        await page.open('/tele/queue')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-27-02"]')`), 'S-27-02 is drawn')
        expect((await page.text()).includes('2 patients today'), 'two video visits')
        const rows = await cards()
        expect(rows.length === 2 && rows[0].startsWith('10:05') && rows[0].includes('Fatima Bi') && rows[1].startsWith('11:30') && rows[1].includes('Arjun Nair'), `Fatima at 10:05, Arjun at 11:30: ${rows}`)
        for (const clinic of ['Meera Krishnan', 'Selvi Murugan', 'Lakshmi Narayanan', 'Sunita Devi'])
          expect(!rows.some((r) => r.includes(clinic)), `${clinic} is a clinic patient today, not a video visit`)
        expect(JSON.stringify(await statuses()) === JSON.stringify(['waiting', 'waiting']), `both waiting: ${await statuses()}`)
        expect((await countOf('Waiting')) === '2' && (await countOf('In call')) === '0' && (await countOf('Call ended')) === '0' && (await countOf('Done')) === '0', 'the counts')
        expect(rows.every((r) => r.includes('Connect')), 'Connect for both')
        expect(rows[0].includes('Phone call only') && !rows[1].includes('Phone call only'), 'Fatima’s video did not work in her test')

        // The same two, as the Dashboard's Patients Today lists its teleconsults.
        await page.open('/', { fresh: false })
        const listed = await page.evaluate(`document.querySelector('[aria-label="Today\\'s OPD patients"]')?.textContent ?? ''`)
        const block = await page.evaluate(`document.querySelector('button[aria-label^="Teleconsult, "]')?.getAttribute('aria-label') ?? ''`)
        expect(listed.includes('Fatima Bi') && listed.includes('Arjun Nair') && block.includes('2 patients'), `the Dashboard agrees — Patients Today lists both, the Teleconsult block counts 2: ${block}`)

        await page.open('/tele/queue', { fresh: false })
        await page.click('[data-count="Waiting"]')
        expect((await cards()).length === 2, 'Waiting shows both')
        await page.click('button', 'All patients')
        await page.click('button[aria-label="Connect with Arjun Nair"]')
        await page.until(`/^\\/tele\\/session\\/[^/]+$/.test(location.pathname) && document.body.textContent.includes('Video visit with Arjun')`, 3000, 'Connect opens the visit')
      },
    },
    {
      name: 'Telehealth (S-27-03): the call opens inside the visit page, in its own private room — no link to make or paste; a visit moves Waiting → In call → Call ended → Done, and can be reopened; Video visits and My Day follow',
      async run() {
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        try {
          await page.open('/tele/session/ISH-0044240')
          let text = await page.text()
          expect(text.includes('Video visit with Arjun') && text.includes('The call opens here, inside Shri Health'), 'one card, one button')
          expect(text.includes('Arjun agreed to recording in the patient portal'), 'the consent is the patient portal’s')
          expect(!text.includes('Meeting link') && !text.includes('Permission to record') && !text.includes('Yes, agreed'), 'no link to paste, no consent to ask')
          expect(text.includes('About Arjun') && text.includes('Your notes'), 'the patient and the notes beside them')
          expect(!text.includes('Start consultation'), 'no Start consultation: the call is the consultation')
          expect((await visitStatus()) === 'waiting', 'Waiting')

          await page.click('button', 'Connect')
          await page.until(`document.body.textContent.includes('In call with Arjun') && !!document.querySelector('[data-video-room] [data-jitsi-stub]')`, 3000, 'the call opens in the page')
          const room = await page.evaluate(`document.querySelector('[data-video-room]').dataset.videoRoom`)
          expect(/^ShriHealth-[A-Za-z0-9]+-[A-Za-z0-9]{12}$/.test(room), `a private room no one can guess: ${room}`)
          await page.until(`!!document.querySelector('[data-joined]') && document.body.textContent.includes('Arjun is connected')`, 3000, 'it says when Arjun joins')
          expect((await visitStatus()) === 'incall', 'In call')
          expect(!(await btnDisabled('Start recording')), 'Start recording, one button')
          await page.until(`document.querySelector('[data-speech]')?.dataset.speech === 'browser'`, 3000, 'with no speech service, the browser listens')
          const listens = await page.evaluate(`document.querySelector('[data-speech]').textContent`)
          expect(listens.includes('The browser writes down your words, in English only') && !listens.includes('speech service'), `said plainly, with nothing to ask IT for: ${listens}`)

          const arjunOnMyDay = () => page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].find((li) => li.textContent.includes('Arjun Nair'))?.textContent ?? ''`)
          await page.open('/', { fresh: false })
          expect((await arjunOnMyDay()).includes('In room'), 'in call: In room on My Day')
          await page.open('/tele/queue', { fresh: false })
          expect((await countOf('In call')) === '1' && (await statusOfCard('Arjun')) === 'incall', 'and In call on Video visits')
          await page.click('button[aria-label="Back to call Arjun Nair"]')
          await page.until(`document.body.textContent.includes('In call with Arjun') && !!document.querySelector('[data-video-room="${room}"]')`, 3000, 'back in the same room')

          await page.click('button', 'End call')
          await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('You leave the video room')`, 3000, 'ending is confirmed')
          await page.click('[role="alertdialog"] button', 'End call')
          await toastSays('Call ended', 'Finish your notes, then mark the visit done.')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'the call ended')
          expect(await page.evaluate(`window.__jitsiDisposed === true`), 'the video room is left')
          expect((await visitStatus()) === 'ended' && !(await btnDisabled('Mark visit as done')), 'Call ended, waiting to be marked done')
          expect(await btnDisabled('Video recording'), 'nothing was recorded, so no video to download')

          await page.open('/tele/queue', { fresh: false })
          expect((await statusOfCard('Arjun')) === 'ended' && (await countOf('Call ended')) === '1', 'Call ended on Video visits')
          expect(await page.evaluate(`!!document.querySelector('button[aria-label="Finish visit Arjun Nair"]')`), 'with Finish visit')
          await page.open('/', { fresh: false })
          expect((await arjunOnMyDay()).includes('In room'), 'still In room on My Day until it is done')

          await page.open('/tele/session/ISH-0044240', { fresh: false })
          await page.click('button', 'Mark visit as done')
          await toastSays('Visit done', 'video visit is finished.')
          await page.until(`document.body.textContent.includes('Visit with Arjun done')`, 3000, 'done')
          expect((await visitStatus()) === 'done', 'Done')
          await page.open('/tele/queue', { fresh: false })
          expect((await statusOfCard('Arjun')) === 'done' && (await countOf('Done')) === '1', 'Done on Video visits')
          expect(await page.evaluate(`document.querySelector('ul[aria-label="Finished video visits"]')?.textContent.includes('Arjun Nair')`), 'and under Finished visits')
          await page.open('/', { fresh: false })
          expect((await arjunOnMyDay()).includes('Seen'), 'Seen on My Day')

          await page.open('/tele/session/ISH-0044240', { fresh: false })
          await page.click('button', 'Reopen')
          await page.until(`document.querySelector('[data-visit-status]').dataset.visitStatus === 'ended' && document.body.textContent.includes('Mark visit as done')`, 3000, 'reopened: Call ended again')

          await page.open('/tele/session/NOPE', { fresh: false })
          text = await page.text()
          expect(text.includes('There is no patient or teleconsult with the id “NOPE” here.'), 'an unknown id says so')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        }
      },
    },
    {
      name: 'Telehealth (S-27-03): the video is the patient, large, with the doctor small in a corner — Jitsi’s own tiles and self-view off — beside the patient’s record: history, test results, vitals, scans, trend and earlier notes',
      async run() {
        const jitsi = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        const camera = await send('Page.addScriptToEvaluateOnNewDocument', { source: CAMERA_STUB })
        try {
          await page.open('/tele/session/ISH-0044240')
          const rec = await page.evaluate(`document.querySelector('[data-visit-record]')?.textContent ?? ''`)
          for (const w of ['About Arjun', 'Patient report', 'Test results', 'Vitals', 'Report viewer', 'Trend', 'Consultation notes', 'Write prescription'])
            expect(rec.includes(w), `the record beside the visit has ${w}`)
          await page.click('button', 'Connect')
          await page.until(`!!document.querySelector('[data-visit-call] [data-video-room] [data-jitsi-stub]')`, 3000, 'the video, in the column beside the record')
          const o = await page.evaluate(`window.__jitsiOptions.configOverwrite`)
          expect(o.disableSelfView === true && o.filmstrip?.disabled === true && o.disableTileView === true && !o.toolbarButtons.includes('tileview'), `only the patient on Jitsi’s stage: ${JSON.stringify(o).slice(0, 240)}`)
          await page.until(`document.querySelector('[data-video-room] [data-self-view]')?.dataset.selfView === 'on'`, 3000, 'the doctor’s own picture, small in the corner of the video')
          await page.evaluate(`window.__jitsi.emit('videoMuteStatusChanged', { muted: true }); true`)
          await page.until(`document.querySelector('[data-self-view]').dataset.selfView === 'off'`, 2000, 'camera off in the call: the corner picture hides')
          await page.evaluate(`window.__jitsi.emit('videoMuteStatusChanged', { muted: false }); true`)
          await page.until(`document.querySelector('[data-self-view]').dataset.selfView === 'on'`, 2000, 'and comes back with the camera')
          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'ended')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: camera.identifier })
        }
      },
    },
    {
      name: 'Telehealth: a patient waiting in their video call — the patient portal’s stand-in puts them in the visit’s room; the doctor is told on every screen (the bar, the bell, the sidebar, Video visits); Connect opens the call in the same room, and the notice clears',
      async run() {
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        const waitingFor = `JSON.parse(localStorage.getItem('shri.waiting') ?? '{"state":{"waiting":{}}}').state.waiting`
        try {
          await page.open('/demo/patient')
          expect((await page.text()).includes('Who is connecting?'), 'the patient picks themselves')
          await page.evaluate(`window.__jitsiAlone = true; true`)
          await page.click('button[aria-label="I am Arjun Nair"]')
          await page.click('button', 'Connect')
          await page.until(`!!document.querySelector('[data-alone]')?.textContent.includes('Waiting for Dr. Rajsrinivas')`, 3000, 'the patient waits in the call')
          const room = await page.evaluate(`document.querySelector('[data-video-room]').dataset.videoRoom`)
          expect(/^ShriHealth-E118430-[A-Za-z0-9]{12}$/.test(room), `the visit’s own room: ${room}`)
          expect((await page.evaluate(waitingFor))['E-118430']?.patientId === 'SD-P-10', 'the doctor is told Arjun is waiting')
          await page.click('button', 'Leave the call')
          expect(Object.keys(await page.evaluate(waitingFor)).length === 0, 'leaving ends the wait')

          // The doctor's window, told by the browser that the patient's window wrote the waiting list.
          await page.open('/', { fresh: false })
          await page.evaluate(`localStorage.setItem('shri.waiting', JSON.stringify({ state: { waiting: { 'E-118430': { visitId: 'E-118430', patientId: 'SD-P-10', since: Date.now() } } }, version: 1 })); window.dispatchEvent(new StorageEvent('storage', { key: 'shri.waiting' })); true`)
          await page.until(`!!document.querySelector('[data-waiting="E-118430"]')`, 3000, 'the bar, on the Dashboard')
          const bar = await page.evaluate(`document.querySelector('[data-waiting="E-118430"]').textContent`)
          expect(bar.includes('Arjun Nair is waiting in the video call.') && bar.includes('Connect'), `said plainly, with Connect: ${bar}`)
          const bell = await page.evaluate(`document.querySelector('button[aria-label^="Notifications"]')?.getAttribute('aria-label') ?? ''`)
          expect(bell.includes('4 unread'), `the bell counts it: ${bell}`)
          expect(await page.evaluate(`!!document.querySelector('[data-lobby-dot]')`), 'a dot on Video visits in the sidebar')
          expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-waiting]').parentElement).position === 'fixed'`), 'a floating alert, over the page wherever it is scrolled')
          await page.click('[data-waiting="E-118430"] button[aria-label^="Later"]')
          await page.until(`!document.querySelector('[data-waiting]')`, 2000, 'Later puts the alert away')
          expect((await page.evaluate(`document.querySelector('button[aria-label^="Notifications"]').getAttribute('aria-label')`)).includes('4 unread') && (await page.evaluate(`!!document.querySelector('[data-lobby-dot]')`)), 'the bell and the dot still say so')

          await page.open('/tele/queue', { fresh: false })
          expect((await statusOfCard('Arjun')) === 'lobby' && (await countOf('Waiting')) === '2', 'In the waiting room on Video visits, still counted as waiting')
          expect(await page.evaluate(`!!document.querySelector('button[aria-label="Connect: Arjun Nair is waiting in the video call"]')`), 'with Connect')
          await page.click('[data-waiting="E-118430"] button', 'Connect')
          await page.until(`location.pathname === '/tele/session/E-118430' && document.body.textContent.includes('In call with Arjun')`, 3000, 'Connect: the call, already started')
          expect((await page.evaluate(`document.querySelector('[data-video-room]').dataset.videoRoom`)) === room, 'in the room the patient waits in')
          await page.until(`!document.querySelector('[data-waiting]')`, 2000, 'no longer waiting: the bar is gone')
          expect(Object.keys(await page.evaluate(waitingFor)).length === 0, 'and off the waiting list')
          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'ended')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        }
      },
    },
    {
      name: 'Telehealth: with Shri Health behind other windows, a patient arriving in their call is a notice on this computer — asked for once on Video visits — and clicking it joins the call',
      async run() {
        const notices = await send('Page.addScriptToEvaluateOnNewDocument', { source: NOTICE_STUB })
        const jitsi = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        try {
          await page.open('/tele/queue')
          await page.until(`!!document.querySelector('[data-alerts-prompt]')`, 3000, 'Video visits offers the alerts')
          await page.click('[data-alerts-prompt] button', 'Turn on alerts')
          await page.until(`!document.querySelector('[data-alerts-prompt]') && Notification.permission === 'granted'`, 2000, 'asked once, then gone')
          await page.open('/', { fresh: false })
          await page.evaluate(`localStorage.setItem('shri.waiting', JSON.stringify({ state: { waiting: { 'E-118430': { visitId: 'E-118430', patientId: 'SD-P-10', since: Date.now() } } }, version: 1 })); window.dispatchEvent(new StorageEvent('storage', { key: 'shri.waiting' })); true`)
          await page.until(`window.__notices.length === 1`, 3000, 'a notice on this computer')
          const n = await page.evaluate(`({ title: window.__notices[0].title, body: window.__notices[0].body, tag: window.__notices[0].tag })`)
          expect(n.title === 'Arjun Nair is waiting in the video call' && n.body.includes('Click to connect.') && n.tag === 'shri-waiting-E-118430', `said plainly: ${JSON.stringify(n)}`)
          await page.evaluate(`window.__notices[0].onclick(); true`)
          await page.until(`location.pathname === '/tele/session/E-118430' && document.body.textContent.includes('In call with Arjun')`, 3000, 'clicking it joins the call')
          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'ended')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: notices.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
        }
      },
    },
    {
      name: 'Telehealth: on the hospital’s own Jitsi, the server says who is in each visit’s room — a patient joining from any device is waiting, an empty room is not, and the doctor’s own open call is never a patient waiting',
      async run() {
        const sizes = await send('Page.addScriptToEvaluateOnNewDocument', { source: ROOM_SIZE_STUB })
        const jitsi = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        const arjun = 'shrihealth-e118430-q7kftz2lmw9x'
        try {
          await page.open('/')
          await page.evaluate(`localStorage.setItem('shri.jitsiDomain', 'meet.example.org'); true`)
          await page.open('/', { fresh: false })
          await page.until(`window.__asked.includes('${arjun}')`, 7000, 'the portal asks the Jitsi server about each visit’s room')
          expect(!(await page.evaluate(`!!document.querySelector('[data-waiting]')`)), 'nobody in the room, nobody waiting')
          await page.evaluate(`window.__roomSize['${arjun}'] = 1; true`)
          await page.until(`!!document.querySelector('[data-waiting="E-118430"]')`, 8000, 'someone in Arjun’s room: Arjun is waiting')
          await page.evaluate(`delete window.__roomSize['${arjun}']; true`)
          await page.until(`!document.querySelector('[data-waiting]')`, 8000, 'the room empties: no longer waiting')
          await page.evaluate(`window.__roomSize['${arjun}'] = 1; true`)
          await page.until(`!!document.querySelector('[data-waiting="E-118430"]')`, 8000, 'back in the room')
          await page.click('[data-waiting="E-118430"] button', 'Connect')
          await page.until(`document.body.textContent.includes('In call with Arjun')`, 3000, 'joined')
          await page.evaluate(`window.__roomSize['${arjun}'] = 2; true`)
          await sleep(6000)
          expect(!(await page.evaluate(`!!document.querySelector('[data-waiting]')`)), 'the doctor in the room is the call, not a patient waiting')
          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'ended')
        } finally {
          await page.evaluate(`localStorage.removeItem('shri.jitsiDomain'); true`)
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sizes.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
        }
      },
    },
    {
      name: 'Telehealth (S-27-03): the notes take typing while the mic listens and never write over it; they stay a draft until Save to record signs them into the record’s consultation notes, and the visit waits for them',
      async run() {
        const unstub = await stubSpeech()
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        const value = () => page.evaluate(`document.querySelector('#tele-note').value`)
        try {
          await page.open('/tele/session/ISH-0044240')
          await page.click('button', 'Connect')
          await page.until(`document.body.textContent.includes('In call with Arjun')`, 3000, 'in the call')
          expect(await btnDisabled('Save to record'), 'nothing to save yet')
          await page.evaluate(`document.querySelector('#tele-note').parentElement.querySelector('button[aria-label="Dictate"]').click(); true`)
          await page.until(`(window.__srStarts ?? 0) > 0`, 3000, 'the mic listens')
          expect(!(await page.evaluate(`document.querySelector('#tele-note').readOnly`)), 'the box takes typing while it listens')
          await page.type('#tele-note', 'Typed while listening.')
          await page.evaluate(`window.__say('Fewer new lesions this week', 0.9); true`)
          await page.until(`document.querySelector('#tele-note').value.includes('Fewer new lesions this week')`, 3000, 'the spoken words join')
          expect((await value()).startsWith('Typed while listening.'), `what was typed stays, the words after it: ${await value()}`)
          await page.evaluate(`document.querySelector('#tele-note').parentElement.querySelector('button[aria-label="Stop recording"]').click(); true`)
          await sleep(300)
          await page.type('#tele-note', ' Advised to continue.')
          const draft = await value()
          expect(draft.includes('Typed while listening.') && draft.includes('Fewer new lesions this week') && draft.includes('Advised to continue.'), `typed, spoken and typed again: ${draft}`)
          expect((await page.evaluate(`document.querySelector('[data-note-state]').dataset.noteState`)) === 'draft', 'a draft')

          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended')`, 3000, 'ended')
          expect((await btnDisabled('Mark visit as done')) && (await page.text()).includes('Your notes are still a draft. Save them to the record, then mark the visit done.'), 'the visit waits for the notes')

          await page.click('button', 'Save to record')
          await toastSays('Note saved to the record', 'Arjun Nair · signed, under Consultation notes')
          expect((await value()) === '' && (await page.evaluate(`document.querySelector('[data-note-state]').dataset.noteState`)) === 'saved', 'the box is clear, and says the note is saved')
          const notes = await page.evaluate(`document.querySelector('[aria-label="Consultation notes on Arjun Nair"]')?.textContent ?? ''`)
          expect(notes.includes('Fewer new lesions this week') && notes.includes('Advised to continue.'), `in the record’s consultation notes: ${notes.slice(0, 300)}`)
          const rows = await auditRows()
          expect(rows.some((r) => r.event === 'NOTE.DRAFT_SAVED' && r.subject === 'SD-P-10' && r.detail.includes('Video visit note saved, typed and dictated')), 'saved, on record')
          expect(rows.some((r) => r.event === 'NOTE.SIGNED' && r.subject === 'SD-P-10' && r.detail.includes('Video visit note signed')), 'signed, on record')
          expect(!(await btnDisabled('Mark visit as done')), 'and the visit can be marked done')
          await page.evaluate(`window.__saved = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__saved.push(b); return o.call(URL, b) }; true`)
          await page.click('button', 'Full visit record')
          const record = await page.evaluate(`window.__saved[0].text()`)
          expect(record.includes("DOCTOR'S NOTE") && record.includes('Fewer new lesions this week'), `the visit record carries the saved note: ${record.slice(0, 300)}`)
        } finally {
          await unstub()
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        }
      },
    },
    {
      name: 'Telehealth (S-27-03): recording is the patient’s to allow, in the patient portal — not yet answered, there is no Start recording and the page says why; leaving from inside the video ends the call',
      async run() {
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        try {
          await page.open('/tele/session/ISH-0042330')
          expect((await page.text()).includes('Fatima has not answered the recording question in the patient portal yet.'), 'Fatima has not answered, and the page says so')
          await page.click('button', 'Connect')
          await page.until(`document.body.textContent.includes('In call with Fatima')`, 3000, 'in the call')
          expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start recording'))`)), 'no Start recording until she agrees')
          expect(await page.evaluate(`document.querySelector('[data-consent]')?.dataset.consent === 'none'`), 'the reason, under the video')
          // Leaving from inside the video, with Jitsi's own button, ends the call here too.
          await page.evaluate(`window.__jitsi.emit('readyToClose'); true`)
          await toastSays('Call ended', 'You left the video.')
          await page.until(`document.body.textContent.includes('Call with Fatima ended') && document.body.textContent.includes('did not agree in the patient portal')`, 3000, 'ended, not recorded')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        }
      },
    },
    {
      name: 'Telehealth (S-27-04): the category gate — prohibited never, List A only on video; a blocked item stops the signature',
      async run() {
        await page.open('/tele/session/ISH-0044240/rx')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-27-04"]')`), 'S-27-04 is drawn')
        let text = await page.text()
        expect(text.includes('On the prohibited list. This cannot be prescribed by telemedicine under any circumstances.'), 'Tenecteplase is blocked on video too')
        expect(await signDisabled(), 'nothing to sign yet')
        await page.click('button[aria-label="Add Co-amoxiclav 1.2g IV"]')
        expect(!(await signDisabled()), 'List A signs on video')
        await page.click('[role="tab"]', 'Telephone')
        text = await page.text()
        expect(text.includes('telephone consultation · 1 blocked by the category gate') && text.includes('List A requires a video teleconsult.') && text.includes('Blocked — cannot be signed'), 'telephone blocks List A')
        expect(await signDisabled(), 'and the signature waits')
        await page.click('button[aria-label="Remove Co-amoxiclav 1.2g IV"]')
        await page.click('button[aria-label="Add Paracetamol 1g IV"]')
        await page.click('button', 'Sign the tele-prescription')
        await toastSays('Tele-prescription signed', 'Printed bilingually with your HPR number, and published to ABDM.')
        await page.until(`location.pathname === '/tele/queue'`, 3000, 'back to the queue')
      },
    },

    {
      name: 'Telehealth (S-27-03): Start recording shares this tab once — the video room and both voices are recorded and written down as a conversation, saved to the server, and downloadable as text and as the full visit record',
      async run() {
        const db = join(mkdtempSync(join(tmpdir(), 'tele-store-')), 'tele.sqlite3')
        const py = join(BACKEND, '.venv', 'bin', 'python')
        const asr = spawn(py, ['-m', 'tools.mock_service', '--port', String(ASR_PORT)], { cwd: BACKEND, stdio: 'ignore' })
        const store = spawn(py, ['-m', 'uvicorn', 'telehealth.api:tele', '--port', String(STORE_PORT)], { cwd: BACKEND, stdio: 'ignore', env: { ...process.env, TELE_DB: db, TELE_DEV: '1' } })
        const media = await send('Page.addScriptToEvaluateOnNewDocument', { source: MEDIA_STUB })
        const jitsi = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        await sleep(2000)
        try {
          await page.open('/tele/session/ISH-0044240')
          await page.evaluate(`localStorage.setItem('shri.asrUrl', 'ws://127.0.0.1:${ASR_PORT}/ws/transcribe'); localStorage.setItem('shri.teleApi', 'http://127.0.0.1:${STORE_PORT}'); true`)
          await page.open('/tele/session/ISH-0044240', { fresh: false })

          await page.click('button', 'Connect')
          await page.until(`document.body.textContent.includes('Chrome asks once to share this tab with its sound')`, 3000, 'one Allow, said plainly')
          await page.click('button', 'Start recording')
          const asked = await page.evaluate(`window.__shareOptions`)
          expect(asked && asked.preferCurrentTab === true && asked.selfBrowserSurface === 'include', `this tab, nothing to pick: ${JSON.stringify(asked)}`)
          await page.until(`!!document.querySelector('[data-channel="doctor"][data-state="live"]') && !!document.querySelector('[data-channel="patient"][data-state="live"]')`, 8000, 'both voices heard')
          await page.until(`!!document.querySelector('ol[aria-label="Live transcript"] li[data-faint]')`, 8000, 'words appear while they are spoken')
          await sleep(3500)
          await page.click('button', 'Stop recording')
          await page.until(`document.querySelectorAll('ol[aria-label="Live transcript"] li[data-speaker]:not([data-faint])').length === 2`, 10000, 'each voice’s words land')
          const sides = await page.evaluate(`[...document.querySelectorAll('ol[aria-label="Live transcript"] li[data-speaker]')].map((li) => li.dataset.speaker + ':' + li.textContent)`)
          expect(sides.some((l) => l.startsWith('doctor:You') && l.includes('increase the dose.')) && sides.some((l) => l.startsWith('patient:Arjun')), `you on the right, Arjun on the left: ${sides}`)

          // Download as text, mid-call: the file is the whole conversation, who said what.
          await page.evaluate(`window.__saved = []; const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__saved.push(b); return o.call(URL, b) }; true`)
          await page.click('button', 'Download as text')
          const file = await page.evaluate(`window.__saved[0].text()`)
          expect(file.includes('Teleconsult — Arjun Nair') && file.includes('Doctor: Blood pressure is slightly high, increase the dose.') && file.includes('Video room: https://'), `the text file: ${file}`)

          const stored = await page.evaluate(`new Promise((ok) => { const r = indexedDB.open('shri-tele'); r.onsuccess = () => { const q = r.result.transaction('chunks').objectStore('chunks').getAll(); q.onsuccess = () => ok({ n: q.result.length, bytes: q.result.reduce((a, c) => a + c.blob.size, 0), type: q.result[0]?.blob.type }) } })`)
          expect(stored.n > 0 && stored.bytes > 2000 && stored.type.startsWith('video/'), `the video is on the computer: ${JSON.stringify(stored)}`)
          await page.until(`document.querySelector('[data-saved="server"]')?.textContent.includes('Saved')`, 8000, 'the conversation reaches the server')
          const sid = await page.evaluate(`JSON.parse(localStorage.getItem('shri.tele')).state.latest['SD-P-10']`)
          const server = await (await fetch(`http://127.0.0.1:${STORE_PORT}/sessions/${sid}`)).json()
          expect(server.segments.length === 2 && /^ShriHealth-/.test(server.session.meetCode) && server.session.consent === 'given', `the server has it: ${JSON.stringify(server.session)}`)

          // Recording again in the same call is a second video, never written over the first.
          await page.click('button', 'Start recording')
          await page.until(`!!document.querySelector('[data-channel="doctor"][data-state="live"]')`, 8000, 'recording again')
          await sleep(3500)
          await page.click('button', 'Stop recording')
          await page.until(`document.querySelectorAll('ol[aria-label="Live transcript"] li[data-speaker]:not([data-faint])').length === 4`, 10000, 'the second take’s words land')

          await page.click('button', 'End call')
          await page.click('[role="alertdialog"] button', 'End call')
          await page.until(`document.body.textContent.includes('Call with Arjun ended') && document.body.textContent.includes('4 lines of conversation saved')`, 5000, 'the finished visit')
          expect(!(await btnDisabled('Video recording 1 of 2')) && !(await btnDisabled('Video recording 2 of 2')) && !(await btnDisabled('Full visit record')), 'two videos and the record download')
          const parts = await page.evaluate(`new Promise((ok) => { const r = indexedDB.open('shri-tele'); r.onsuccess = () => { const q = r.result.transaction('chunks').objectStore('chunks').getAll(); q.onsuccess = () => ok([...new Set(q.result.map((c) => c.sid))].length) } })`)
          expect(parts === 2, `both videos are kept: ${parts}`)
          expect(!(await page.text()).includes('Google Meet'), 'nothing about Google Meet')

          // A line written down wrong is corrected by typing; the words first heard stay with it.
          await page.click('button[aria-label^="Correct this line: Blood pressure is slightly high"]')
          await page.until(`!!document.querySelector('[data-editing] textarea')`, 2000, 'the line opens for correcting')
          await page.evaluate(`(() => { const t = document.querySelector('[data-editing] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Blood pressure is slightly high, increase the amlodipine dose.'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
          await page.click('[data-editing] button', 'Save correction')
          await page.until(`!!document.querySelector('ol[aria-label="Live transcript"] li[data-corrected]')`, 2000, 'corrected')
          const fixed = await page.evaluate(`document.querySelector('li[data-corrected]').textContent`)
          expect(fixed.includes('Corrected') && fixed.includes('increase the amlodipine dose.'), `the line says so: ${fixed}`)

          await page.evaluate(`window.__saved = []; true`)
          await page.click('button', 'Full visit record')
          const record = await page.evaluate(`window.__saved[0].text()`)
          expect(record.includes('Recording and transcript consent: given by the patient, in the patient portal') && record.includes('LIVE TRANSCRIPT') && !record.includes('Google Meet'), `the full record: ${record.slice(0, 400)}`)
          expect(record.includes('increase the amlodipine dose. (corrected by') && record.includes('first heard as “Blood pressure is slightly high, increase the dose.”'), `the record keeps the correction and what was heard: ${record.slice(0, 900)}`)

          // Once the visit is done, the lines are locked.
          await page.click('button', 'Mark visit as done')
          await page.until(`document.body.textContent.includes('Visit with Arjun done')`, 3000, 'done')
          expect(!(await page.evaluate(`!!document.querySelector('button[aria-label^="Correct this line"]')`)) && (await page.text()).includes('can no longer be corrected'), 'no more corrections')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: media.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
          asr.kill('SIGTERM')
          store.kill('SIGTERM')
        }
      },
    },
    {
      name: 'Telehealth (S-27-03): when nothing can turn speech into text, the page says so before the doctor starts — never a silent, empty transcript; the video can still be recorded',
      async run() {
        const NO_RECOGNISER = `(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined })()`
        const quiet = await send('Page.addScriptToEvaluateOnNewDocument', { source: NO_RECOGNISER })
        const jitsi = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        try {
          await page.open('/tele/session/ISH-0044240')
          // No speech service (as now), and a browser that cannot listen.
          await page.evaluate(`localStorage.setItem('shri.asrUrl', 'off'); localStorage.setItem('shri.teleApi', 'off'); true`)
          await page.open('/tele/session/ISH-0044240', { fresh: false })
          await page.click('button', 'Connect')
          await page.until(`document.querySelector('[data-speech]')?.dataset.speech === 'none'`, 8000, 'the check finds nothing that can listen')
          const said = await page.evaluate(`document.querySelector('[data-speech]').textContent`)
          expect(said.includes('This browser cannot turn speech into text, so nothing will be written down') && said.includes('Google Chrome'), `said plainly: ${said}`)
          expect(!(await btnDisabled('Start recording')), 'the video can still be recorded')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: quiet.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
        }
      },
    },
  ]
}
