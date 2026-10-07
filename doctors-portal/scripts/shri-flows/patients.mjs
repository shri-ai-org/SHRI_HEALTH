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
        expect(text.includes('My patients') && text.includes('7 booked · 2 seen · 3 waiting · running 6 min behind'), 'the heading and the live counts, with the recorded delay')
        expect(!text.includes('next in about') && !text.includes('to be called'), 'no AI-607 wait forecast anywhere')
        expect(await page.evaluate(`document.querySelector('nav[aria-label="Main"] a[aria-label="My patients"]')?.getAttribute('aria-current') === 'page'`), 'the rail marks My patients')
        const list = await rows()
        // Waiting first, in token order: the two head-CT follow-ups, then Meera.
        expect(
          list.length === 7 &&
            list[0].includes('MED-041') && list[0].includes('Selvi Murugan') && list[0].includes('Waiting 26m') &&
            list[1].includes('MED-042') && list[1].includes('Lakshmi Narayanan') && list[1].includes('Waiting 18m') &&
            list[2].includes('MED-045') && list[2].includes('Meera Krishnan') && list[2].includes('Waiting 14m'),
          `waiting first, in token order: ${list.slice(0, 3)}`,
        )
        expect(list.filter((r) => r.includes('Call')).length === 3, 'Call only on the patients who are waiting')
        // Still to come, by their time: Fatima's phone call at 10:05, Arjun's video at 11:30.
        expect(list[3].includes('Fatima Bi') && list[3].includes('Telephone') && list[4].includes('Arjun Nair') && list[4].includes('Video 11:30'), `then the rest of the session in time order: ${list.slice(3, 5)}`)
        // The same patients in the same order as My Day's Patients Today.
        await page.open('/', { fresh: false })
        const myDay = await page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].map((li) => li.textContent)`)
        const names = (xs) => xs.map((t) => ['Selvi Murugan', 'Lakshmi Narayanan', 'Meera Krishnan', 'Fatima Bi', 'Arjun Nair', 'Rahul Verma', 'Sunita Devi'].find((n) => t.includes(n))).join('|')
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
        expect(board.includes('longest 26m') && board.includes('Token order is the deterministic order.') && !board.includes('to be called'), 'the board, with its capacity signal and no forecast')
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
        await page.until(`location.pathname === '/patient/ISH-0044297'`, 3000, 'a row opens the record')
        await page.open('/op-queue', { fresh: false })
        await page.click('button', 'Call MED-041')
        await toastSays('Calling MED-041', 'Selvi Murugan · the note opens with the scribe ready.')
        await page.until(`/^\\/encounter\\/[^/]+\\/note$/.test(location.pathname)`, 3000, 'the consultation note opens')
        const kpi = (id) => page.evaluate(`document.querySelector('[data-kpi="${id}"]')?.textContent ?? ''`)
        await page.open('/', { fresh: false })
        expect((await kpi('inroom')).includes('1') && (await kpi('inroom')).includes('Murugan'), `In Room is 1, Selvi: ${await kpi('inroom')}`)
        expect((await kpi('waiting')).includes('2'), `two still waiting: ${await kpi('waiting')}`)
        await page.open('/op-queue', { fresh: false })
        expect((await rows()).find((r) => r.includes('Selvi Murugan')).includes('In room'), 'In room on the queue too')
        expect((await page.text()).includes('2 waiting'), 'and the count agrees')
      },
    },
  ]
}
