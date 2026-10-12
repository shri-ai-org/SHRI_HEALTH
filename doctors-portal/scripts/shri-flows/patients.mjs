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
        expect(text.includes('My patients') && text.includes('17 booked · 2 seen · 5 waiting · running 6 min behind'), 'the heading and the live counts, with the recorded delay')
        expect(!text.includes('next in about') && !text.includes('to be called'), 'no AI-607 wait forecast anywhere')
        expect(await page.evaluate(`document.querySelector('nav[aria-label="Main"] a[aria-label="My patients"]')?.getAttribute('aria-current') === 'page'`), 'the rail marks My patients')
        const list = await rows()
        // Waiting first, booked patients by their slot — the two head-CT follow-ups, then Meera — and the walk-ins after them, as they registered.
        expect(
          list.length === 17 &&
            list[0].includes('MED-041') && list[0].includes('Selvi Murugan') && list[0].includes('Waiting 26m') &&
            list[1].includes('MED-042') && list[1].includes('Lakshmi Narayanan') && list[1].includes('Waiting 18m') &&
            list[2].includes('MED-045') && list[2].includes('Meera Krishnan') && list[2].includes('Waiting 14m') &&
            list[3].includes('W-01') && list[3].includes('Thangavel Palanisamy') && list[3].includes('Waiting 22m') &&
            list[4].includes('W-02') && list[4].includes('Saraswathi Chinnasamy') && list[4].includes('Waiting 11m'),
          `waiting first, booked by slot, then walk-ins: ${list.slice(0, 5)}`,
        )
        expect(list[3].includes('walk-in') && list[4].includes('walk-in') && !list.slice(0, 3).concat(list.slice(5)).some((r) => r.includes('walk-in')), `the walk-ins say so, and only they: ${list.slice(0, 5)}`)
        expect(list.filter((r) => r.includes('Call')).length === 5, 'Call only on the patients who are waiting')
        // Still to come, by their time: the morning bookings and the five video visits, then the afternoon session.
        const later = [
          ['Nithya Sekar', 'Not arrived'],
          ['Arumugam Velusamy', 'Not arrived'],
          ['Fatima Bi', 'Video 10:05'],
          ['Kamala Devi', 'Video 10:15'],
          ['Vignesh Ramalingam', 'Video 10:25'],
          ['Ananya Iyer', 'Video 10:30'],
          ['Arjun Nair', 'Video 11:30'],
          ['Karthik Shanmugam', 'Not arrived'],
          ['Jayanthi Ravichandran', 'Not arrived'],
          ['Prabhu Natarajan', 'Not arrived'],
        ]
        expect(later.every(([n, t], i) => list[5 + i].includes(n) && list[5 + i].includes(t)) && !list.some((r) => r.includes('Telephone')), `then the rest of the session in time order: ${list.slice(5, 15)}`)
        expect(list[15].includes('Rahul Verma') && list[16].includes('Sunita Devi'), `and those already seen last: ${list.slice(15)}`)
        // The same patients in the same order as My Day's Patients Today.
        await page.open('/', { fresh: false })
        const myDay = await page.evaluate(`[...document.querySelectorAll('[aria-label="Today\\'s OPD patients"] li')].map((li) => li.textContent)`)
        const everyone = ['Selvi Murugan', 'Lakshmi Narayanan', 'Meera Krishnan', 'Thangavel Palanisamy', 'Saraswathi Chinnasamy', 'Nithya Sekar', 'Arumugam Velusamy', 'Fatima Bi', 'Kamala Devi', 'Vignesh Ramalingam', 'Ananya Iyer', 'Arjun Nair', 'Karthik Shanmugam', 'Jayanthi Ravichandran', 'Prabhu Natarajan', 'Rahul Verma', 'Sunita Devi']
        const names = (xs) => xs.map((t) => everyone.find((n) => t.includes(n))).join('|')
        expect(names(myDay) === names(list), `My Day and My patients agree: ${names(myDay)} vs ${names(list)}`)
        await page.open('/op-queue', { fresh: false })

        await page.click('[role="tab"]', 'Follow-ups')
        await page.until(`location.search === '?type=follow-up'`, 3000, 'the filter is in the address')
        const followUps = await rows()
        expect(!followUps.some((r) => r.includes('Sunita Devi') || r.includes('Thangavel Palanisamy') || r.includes('Karthik Shanmugam')), 'a new patient is not a follow-up, walk-in or booked')
        expect(followUps.some((r) => r.includes('Saraswathi Chinnasamy')) && followUps.some((r) => r.includes('Prabhu Natarajan')), 'a walk-in already under the clinic is one')
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
        // Selvi, first in the queue, called from her own row.
        await page.click('button[aria-label="Call MED-041, Selvi Murugan"]')
        await toastSays('Calling MED-041', 'Selvi Murugan · the note opens with the scribe ready.')
        await page.until(`/^\\/encounter\\/[^/]+\\/note$/.test(location.pathname)`, 3000, 'the consultation note opens')
        const kpi = (id) => page.evaluate(`document.querySelector('[data-kpi="${id}"]')?.textContent ?? ''`)
        await page.open('/', { fresh: false })
        expect((await kpi('inroom')).includes('1') && (await kpi('inroom')).includes('Murugan'), `In Room is 1, Selvi: ${await kpi('inroom')}`)
        expect((await kpi('waiting')).includes('4'), `four still waiting: ${await kpi('waiting')}`)
        await page.open('/op-queue', { fresh: false })
        expect((await rows()).find((r) => r.includes('Selvi Murugan')).includes('In room'), 'In room on the queue too')
        expect((await page.text()).includes('4 waiting'), 'and the count agrees')
      },
    },
  ]
}
