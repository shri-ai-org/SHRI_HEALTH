/**
 * The Dashboard's Today panel: the day as one row of bars across the hours,
 * its key, what comes next, and the free slots — a patient is booked only into
 * free time still to come, and only by tapping it. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, sentItems, toastSays }) => {
  const panel = `document.querySelector('[aria-labelledby="sh-today-title"]')`
  const panelText = () => page.evaluate(`${panel}?.textContent ?? ''`)
  const selectIn = (sel, value) =>
    page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)

  return [
    {
      name: 'Today: the day as one row, 7 AM to 7 PM — each activity a bar named with its time, free time and off hours drawn, Now labelled; what is on and next as cards; ‹ › move the calendar with it',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('[role="img"]')`, 3000, 'the Today panel')
        const t = await panelText()
        for (const w of ['Monday, 21 Sep 2026', 'Now · OPD', 'Now · 8:40 AM', '7:00', 'Upcoming', 'Next 5 events', 'Available slots', 'Off hours'])
          expect(t.includes(w), `the panel says “${w}”`)
        expect(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="OPD, 8:00 – 9:00 AM"]')`), 'the morning OPD is a bar named with its time, and opens its list')

        // Free time to come can be tapped to book; free time already gone cannot.
        const free = await page.evaluate(`[...${panel}.querySelectorAll('button[aria-label^="Free "]')].map((b) => b.getAttribute('aria-label'))`)
        expect(free.includes('Free 12:30 – 2:00 PM — book an appointment'), `free time to come is offered: ${free.join(' | ')}`)
        expect(free.every((f) => !/^Free (7|8):/.test(f)), `nothing before now is: ${free.join(' | ')}`)

        // Upcoming: what is on now, first, then what comes next.
        const cards = await page.evaluate(`[...document.querySelectorAll('ol[aria-label="Upcoming events"] > li')].map((li) => li.textContent)`)
        expect(cards.length === 5 && cards[0].includes('OPD') && cards[0].includes('NOW'), `five, the OPD on now first: ${cards.join(' | ')}`)
        await page.click('[aria-labelledby="sh-today-title"] button', 'View full day')
        await page.until(`document.querySelectorAll('ol[aria-label="Upcoming events"] > li').length > 5`, 3000, 'the whole day')

        // ‹ › move the day here and in the calendar; Today brings both back.
        await page.click('button[aria-label="Next day"]')
        await page.until(`${panel}.querySelector('h2').textContent === 'Tuesday' && document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-iso') === '2026-09-22'`, 3000, 'Tuesday, here and in the calendar')
        expect((await panelText()).includes('22 Sep 2026 · Coming up'), 'a day to come says so')
        await page.click(`[aria-labelledby="sh-today-title"] button`, 'Today')
        await page.until(`${panel}.querySelector('h2').textContent === 'Today' && document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-iso') === '2026-09-21'`, 3000, 'back to today, both')
      },
    },
    {
      name: 'Today: tapping a free slot books a patient into it — the time, the patient, the visit and why; at once on the timeline, the calendar and the slots; the patient and the front office told; audited',
      async run() {
        await page.open('/')
        await page.until(`!!document.querySelector('button[aria-label="Book 12:30 – 1:00 PM"]')`, 3000, 'the 12:30 slot')
        await page.click('button[aria-label="Book 12:30 – 1:00 PM"]')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Book an appointment')`, 3000, 'the booking dialog')
        expect(await page.evaluate(`document.querySelector('[role="dialog"] [role="radio"][aria-checked="true"]')?.textContent.includes('12:30 – 1:00 PM')`), 'the slot tapped is chosen')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Book appointment')).disabled`), 'nothing is booked without a patient and a reason')

        await selectIn('#bk-patient', 'SD-P-03')
        await page.type('#bk-purpose', 'Blood pressure review')
        await page.click('[role="dialog"] button', 'Book appointment')
        await toastSays('Appointment booked', 'R. Lakshmanan · Mon 21 Sep, 12:30 PM')

        await page.until(`!document.querySelector('button[aria-label="Book 12:30 – 1:00 PM"]')`, 3000, 'the slot is gone')
        expect(await page.evaluate(`!!${panel}.querySelector('[title="R. Lakshmanan · 12:30 – 1:00 PM"]')`), 'the timeline shows the booking')
        const booked = await page.evaluate(`document.querySelector('ul[aria-label^="Booked with you on Monday 21 September"]')?.textContent ?? ''`)
        expect(booked.includes('R. Lakshmanan') && booked.includes('12:30 PM'), `the calendar's day shows it: ${booked}`)

        const row = (await auditRows()).find((r) => r.event === 'APPOINTMENT.BOOKED')
        expect(row && row.subject === 'SD-P-03' && row.detail.includes('30 min') && row.detail.includes('R. Lakshmanan'), `audited: ${JSON.stringify(row)}`)
        const told = (await sentItems()).filter((n) => n.kind === 'appointment' && `${n.title} ${n.detail}`.includes('R. Lakshmanan')).map((n) => n.recipient)
        expect(told.includes('patient') && told.includes('front office'), `the patient and the front office are told: ${told}`)
      },
    },
    {
      name: 'Today: a day that has gone offers nothing to book; Find next available goes to the next day with free time',
      async run() {
        await page.open('/')
        await page.click('button[aria-label="Previous day"]')
        await page.until(`${panel}.querySelector('h2').textContent === 'Sunday'`, 3000, 'Sunday')
        const t = await panelText()
        expect(t.includes('Earlier') && t.includes('Nothing to book on a day that has gone.'), `a day gone says so: ${t.slice(0, 300)}`)
        expect(!(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="Free "], ul[aria-label="Available slots"]')`)), 'and offers nothing')
        await page.click(`[aria-labelledby="sh-today-title"] button`, 'Find next available')
        await page.until(`${panel}.querySelector('h2').textContent === 'Today'`, 3000, 'today has free time still to come')
      },
    },
  ]
}
