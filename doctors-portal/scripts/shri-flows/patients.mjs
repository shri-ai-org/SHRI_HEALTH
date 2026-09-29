/**
 * My patients: the rail's one item for the doctor's own lists, the OPD queue
 * (S-05-03) and the inpatient list (S-08-03) as its tabs, each at its old
 * address. Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, toastSays }) => {
  const rows = () => page.evaluate(`[...document.querySelectorAll('ul[aria-label="Today\\'s outpatient session"] > li')].map((li) => li.textContent)`)

  return [
    {
      name: 'My patients (S-05-03): one rail item, OPD and Inpatients as tabs at their old addresses; the OPD queue in token order with the recorded delay and no wait forecast',
      async run() {
        await page.open('/op-queue')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-05-03"]')`), 'S-05-03 is drawn')
        const text = await page.text()
        expect(text.includes('My patients') && text.includes('6 booked · 2 seen · 1 waiting · running 6 min behind'), 'the heading and the live counts, with the recorded delay')
        expect(!text.includes('next in about') && !text.includes('to be called'), 'no AI-607 wait forecast anywhere')
        expect(await page.evaluate(`document.querySelector('nav[aria-label="Main"] a[aria-label="My patients"]')?.getAttribute('aria-current') === 'page'`), 'the rail marks My patients')
        const list = await rows()
        expect(list.length === 6 && list[0].includes('MED-045') && list[0].includes('Waiting 14m') && list[0].includes('Call'), `waiting first, then the teleconsults: ${list[0]}`)
        expect(list.filter((r) => r.includes('Call')).length === 1, 'Call only on the patient who is waiting')
        expect(list[1].includes('Arjun Nair') && list[1].includes('Connect') && list[2].includes('Meera Krishnan') && list[2].includes('Video 09:35'), 'a patient on the teleconsult queue appears once, as the teleconsult')
        // The same patients in the same order as My Day's Patients Today.
        await page.open('/', { fresh: false })
        const myDay = await page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].map((li) => li.textContent)`)
        const names = (xs) => xs.map((t) => ['Selvi Murugan', 'Arjun Nair', 'Meera Krishnan', 'Lakshmi Narayanan', 'Rahul Verma', 'Sunita Devi'].find((n) => t.includes(n))).join('|')
        expect(names(myDay) === names(list), `My Day and My patients agree: ${names(myDay)} vs ${names(list)}`)
        await page.open('/op-queue', { fresh: false })

        await page.click('[role="tab"]', 'Follow-ups')
        await page.until(`location.search === '?type=follow-up'`, 3000, 'the filter is in the address')
        expect(!(await rows()).some((r) => r.includes('Sunita Devi')), 'a new patient is not a follow-up')
        await page.click('[role="tab"]', 'All')
        await page.until(`location.search === ''`, 3000, 'and removable')

        await page.click('button', 'Session board')
        await page.until(`!!document.querySelector('section[aria-label="Waiting"]')`, 3000, 'the session board')
        const board = await page.text()
        expect(board.includes('longest 18m') && board.includes('Token order is the deterministic order.') && !board.includes('to be called'), 'the board, with its capacity signal and no forecast')
        await page.click('button', 'Back to the list')

        await page.click('[role="tablist"][aria-label="My patients"] [role="tab"]', 'Inpatients')
        await page.until(`location.pathname === '/ip/patients' && !!document.querySelector('[data-screen-id="S-08-03"]')`, 3000, 'the Inpatients tab is the inpatient list')
        expect(await page.evaluate(`document.querySelector('nav[aria-label="Main"] a[aria-label="My patients"]')?.getAttribute('aria-current') === 'true'`), 'still under My patients')
        await page.click('[role="tablist"][aria-label="My patients"] [role="tab"]', 'OPD')
        await page.until(`location.pathname === '/op-queue'`, 3000, 'and back')
      },
    },
    {
      name: 'My patients (S-05-03): Call opens the consultation and puts the patient In room on every card — My Day’s In Room count too — until the note is signed',
      async run() {
        await page.open('/op-queue')
        await page.click('ul[aria-label="Today\'s outpatient session"] > li > button', 'Rahul Verma')
        await page.until(`location.pathname === '/patient/ICH-0044297'`, 3000, 'a row opens the record')
        await page.open('/op-queue', { fresh: false })
        await page.click('button', 'Call MED-045')
        await toastSays('Calling MED-045', 'Selvi Murugan · the note opens with the scribe ready.')
        await page.until(`/^\\/encounter\\/[^/]+\\/note$/.test(location.pathname)`, 3000, 'the consultation note opens')
        const kpi = (id) => page.evaluate(`document.querySelector('[data-kpi="${id}"]')?.textContent ?? ''`)
        await page.open('/', { fresh: false })
        expect((await kpi('inroom')).includes('1') && (await kpi('inroom')).includes('Murugan'), `In Room is 1, Selvi: ${await kpi('inroom')}`)
        expect((await kpi('waiting')).includes('0'), `nobody waiting: ${await kpi('waiting')}`)
        await page.open('/op-queue', { fresh: false })
        expect((await rows()).find((r) => r.includes('Selvi Murugan')).includes('In room'), 'In room on the queue too')
        expect((await page.text()).includes('0 waiting'), 'and the count agrees')
      },
    },
  ]
}
