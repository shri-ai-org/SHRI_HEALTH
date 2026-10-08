/**
 * Telehealth (M-27): Video visits (S-27-02), the video visit itself (S-27-03)
 * and the tele-prescription with its hard-coded category gate (S-27-04).
 * The call is a Jitsi room inside the visit page — here a stand-in for Jitsi's
 * IFrame API, so no network and no camera are needed. The recording and live
 * transcript run against the speech service's scripted stand-in
 * (backend/tools/mock_service.py) and a throwaway transcript store
 * (backend/telehealth), with a tone for the microphone and a canvas for the
 * shared tab. Recording consent is the patient's, from the patient portal:
 * Arjun agreed, Lakshmi declined, Sunita has not answered.
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
      window.__jitsiDisposed = false
      setTimeout(() => this.emit('participantJoined', { id: 'patient-1', displayName: 'Patient' }), 300)
    }
    addListener(e, f) { (this.l[e] = this.l[e] || []).push(f) }
    emit(e, x) { (this.l[e] || []).forEach((f) => f(x || {})) }
    executeCommand() {}
    getIFrame() { return this.d }
    dispose() { this.d.remove(); window.__jitsiDisposed = true }
  }
})()`

export default ({ page, expect, toastSays, send, sleep }) => {
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
      name: 'Telehealth (S-27-02): Video visits — six patients by time, the counts that filter, each status with its button, and the visit already done this morning',
      async run() {
        await page.open('/tele/queue')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-27-02"]')`), 'S-27-02 is drawn')
        expect((await page.text()).includes('6 patients today'), 'six video visits')
        const rows = await cards()
        expect(rows.length === 6, `six cards: ${rows.length}`)
        const times = rows.map((r) => r.slice(0, 5))
        expect(JSON.stringify(times) === JSON.stringify([...times].sort()) && rows[0].includes('Meera Krishnan'), `by time, Meera first: ${times}`)
        expect(JSON.stringify(await statuses()) === JSON.stringify(['done', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']), `Meera done, five waiting: ${await statuses()}`)
        expect((await countOf('Waiting')) === '5' && (await countOf('In call')) === '0' && (await countOf('Call ended')) === '0' && (await countOf('Done')) === '1', 'the counts')
        expect(rows[0].includes('Open') && rows.slice(1).every((r) => r.includes('Connect')), 'Open for the done visit, Connect for the rest')
        expect(rows.filter((r) => r.includes('Phone call only')).length === 2, 'two whose video did not work')

        await page.click('[data-count="Done"]')
        expect((await cards()).length === 1 && (await cards())[0].includes('Meera'), 'Done shows only Meera')
        await page.click('[data-count="Waiting"]')
        expect((await cards()).length === 5, 'Waiting shows five')
        await page.click('button', 'All patients')
        expect((await cards()).length === 6, 'and back to all')
        expect(await page.evaluate(`document.querySelector('ul[aria-label="Finished video visits"]')?.textContent.includes('Meera Krishnan')`), 'Meera under Finished visits')

        await page.click('button[aria-label="Open Meera Krishnan"]')
        await page.until(`document.body.textContent.includes('Visit with Meera done') && document.querySelectorAll('ol[aria-label="Live transcript"] li[data-speaker]').length === 8`, 3000, 'her finished visit, with its conversation')
        expect((await visitStatus()) === 'done', 'marked Done')

        await page.open('/tele/queue', { fresh: false })
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
          expect((await visitStatus()) === 'waiting', 'Waiting')

          await page.click('button', 'Start video call')
          await page.until(`document.body.textContent.includes('In call with Arjun') && !!document.querySelector('[data-video-room] [data-jitsi-stub]')`, 3000, 'the call opens in the page')
          const room = await page.evaluate(`document.querySelector('[data-video-room]').dataset.videoRoom`)
          expect(/^ShriHealth-[A-Za-z0-9]+-[A-Za-z0-9]{12}$/.test(room), `a private room no one can guess: ${room}`)
          await page.until(`!!document.querySelector('[data-joined]') && document.body.textContent.includes('Arjun has joined')`, 3000, 'it says when Arjun joins')
          expect((await visitStatus()) === 'incall', 'In call')
          expect(!(await btnDisabled('Start recording')), 'Start recording, one button')

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
          expect((await statusOfCard('Arjun')) === 'done' && (await countOf('Done')) === '2', 'Done on Video visits, two done')
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
      name: 'Telehealth (S-27-03): recording is the patient’s to allow, in the patient portal — declined or not yet answered, there is no Start recording and the page says why; leaving from inside the video ends the call',
      async run() {
        const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: JITSI_STUB })
        try {
          await page.open('/tele/session/ISH-0044290')
          expect((await page.text()).includes('Lakshmi declined recording in the patient portal, so this call cannot be recorded.'), 'Lakshmi declined, and the page says so')
          await page.click('button', 'Start video call')
          await page.until(`document.body.textContent.includes('In call with Lakshmi')`, 3000, 'in the call')
          expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start recording'))`)), 'no Start recording')
          expect(await page.evaluate(`document.querySelector('[data-consent]')?.dataset.consent === 'declined'`), 'the reason, under the video')
          // Leaving from inside the video, with Jitsi's own button, ends the call here too.
          await page.evaluate(`window.__jitsi.emit('readyToClose'); true`)
          await toastSays('Call ended', 'You left the video.')
          await page.until(`document.body.textContent.includes('Call with Lakshmi ended') && document.body.textContent.includes('did not agree in the patient portal')`, 3000, 'ended, not recorded')

          await page.open('/tele/session/ISH-0044208', { fresh: false })
          expect((await page.text()).includes('Sunita has not answered the recording question in the patient portal yet.'), 'Sunita has not answered')
          await page.click('button', 'Start video call')
          await page.until(`document.body.textContent.includes('In call with Sunita')`, 3000, 'in the call')
          expect(!(await page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start recording'))`)), 'no Start recording until she agrees')
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

          await page.click('button', 'Start video call')
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

          await page.evaluate(`window.__saved = []; true`)
          await page.click('button', 'Full visit record')
          const record = await page.evaluate(`window.__saved[0].text()`)
          expect(record.includes('Recording and transcript consent: given by the patient, in the patient portal') && record.includes('LIVE TRANSCRIPT') && !record.includes('Google Meet'), `the full record: ${record.slice(0, 400)}`)
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
          // A speech service that is not running.
          await page.evaluate(`localStorage.setItem('shri.asrUrl', 'ws://127.0.0.1:1/ws/transcribe'); localStorage.setItem('shri.teleApi', 'off'); true`)
          await page.open('/tele/session/ISH-0044240', { fresh: false })
          await page.click('button', 'Start video call')
          await page.until(`document.querySelector('[data-speech]')?.dataset.speech === 'none'`, 8000, 'the check finds nothing that can listen')
          const said = await page.evaluate(`document.querySelector('[data-speech]').textContent`)
          expect(said.includes('Nothing can be written down') && said.includes('Shri speech service is not running'), `said plainly: ${said}`)
          expect(!(await btnDisabled('Start recording')), 'the video can still be recorded')
        } finally {
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: quiet.identifier })
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: jitsi.identifier })
        }
      },
    },
  ]
}
