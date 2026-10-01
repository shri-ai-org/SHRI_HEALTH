/**
 * Dictation through Shri Health's own speech service (backend/), driven against
 * its scripted stand-in (backend/tools/mock_service.py) so the flow needs no
 * model: the To-do mic streams the microphone, live words type into the box,
 * Stop shows "Processing…" until the final English lands, no AI label is shown,
 * the draft is kept on the device and saved as a to-do — and with the service
 * down, the browser's recogniser takes over and says so. Loaded by
 * scripts/shri-flows.mjs.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'backend')
const MOCK_PORT = 8799

export default ({ page, expect, sleep, stubSpeech, toastSays }) => {
  const box = () => page.evaluate(`document.querySelector('#dictation-draft')?.value ?? ''`)
  const dialog = () => page.evaluate(`document.querySelector('[role="dialog"]')?.textContent ?? ''`)

  async function withMock(fn) {
    const mock = spawn(join(BACKEND, '.venv', 'bin', 'python'), ['-m', 'tools.mock_service', '--port', String(MOCK_PORT)], { cwd: BACKEND, stdio: 'ignore' })
    await sleep(1500)
    try {
      await fn()
    } finally {
      mock.kill('SIGTERM')
    }
  }

  return [
    {
      name: 'Speech service (To-do): live English typed into the box, Processing… after Stop, the final lands, no AI labels; the draft is kept on the device and saved',
      async run() {
        await withMock(async () => {
          const unstub = await stubSpeech()
          try {
            await page.open('/')
            await page.evaluate(`localStorage.setItem('shri.asrUrl', 'ws://127.0.0.1:${MOCK_PORT}/ws/transcribe'); true`)
            await page.reload()
            await page.click('button[aria-label="Dictate a to-do note"]')
            await page.until(`(document.querySelector('#dictation-draft')?.value ?? '').includes('Blood pressure is slightly high')`, 8000, 'the live words in the box')
            let text = await dialog()
            expect(text.includes('Listening…'), `it says "Listening…": ${text.slice(0, 200)}`)
            expect(!/live recognition|◆|confidence|Why\?/i.test(text), `no AI labels while listening: ${text.slice(0, 300)}`)

            await page.click('[role="dialog"] button[aria-label="Stop recording"]')
            await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Processing…')`, 3000, '"Processing…" after Stop')
            await page.until(`document.querySelector('#dictation-draft')?.value === 'Blood pressure is slightly high, increase the dose.'`, 5000, 'the final English lands')
            text = await dialog()
            expect(!/Dictated · live|confidence|Why\?/i.test(text), `no AI labels after the take: ${text.slice(0, 300)}`)

            // Edited by hand, closed, the page reloaded: the draft is still there.
            await page.type('#dictation-draft', ' Review in a week.')
            await page.click('[role="dialog"] button[aria-label="Close — the draft is kept"]')
            await page.reload()
            await page.click('button[aria-label="Type a to-do note"]')
            await page.until(`(document.querySelector('#dictation-draft')?.value ?? '').endsWith('Review in a week.')`, 3000, 'the draft kept on the device')
            expect((await dialog()).includes('draft kept on this device'), 'and it says so')

            await page.click('[role="dialog"] button', 'Save')
            await toastSays('To-do note saved')
            expect((await page.text()).includes('Blood pressure is slightly high, increase the dose. Review in a week.'), 'the to-do is on My Day')
            expect(await page.evaluate(`!(JSON.parse(localStorage.getItem('shri.noteDrafts') ?? '{"state":{"drafts":{}}}').state.drafts.todo)`), 'and the draft is cleared once saved')
          } finally {
            await unstub()
          }
        })
      },
    },
    {
      name: 'Speech service down: the take carries on in the browser’s recogniser, and the box says so once',
      async run() {
        const unstub = await stubSpeech()
        try {
          await page.open('/')
          await page.evaluate(`localStorage.setItem('shri.asrUrl', 'ws://127.0.0.1:${MOCK_PORT + 1}/ws/transcribe'); true`)
          await page.reload()
          await page.click('button[aria-label="Dictate a to-do note"]')
          await page.until(`(window.__srStarts ?? 0) > 0`, 5000, 'the browser recogniser takes over')
          await page.evaluate(`window.__say('Call the lab about the culture', 0.9); true`)
          await page.click('[role="dialog"] button[aria-label="Stop recording"]')
          await page.until(`(document.querySelector('#dictation-draft')?.value ?? '').includes('Call the lab about the culture')`, 3000, 'the words land')
          expect((await dialog()).includes('isn’t reachable'), 'the fallback is said, once')
        } finally {
          await unstub()
          await page.evaluate(`localStorage.removeItem('shri.asrUrl'); true`)
        }
      },
    },
  ]
}
