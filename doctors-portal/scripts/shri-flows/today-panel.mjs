/**
 * The Dashboard's Today panel: the day as one row of bars across the hours,
 * its key and the day's events — the OPD as long as its queue runs, its next
 * patient the queue's own — and a patient scheduled only into free time still
 * to come, at the minute tapped. Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, send, sleep, auditRows, sentItems, toastSays }) => {
  const panel = `document.querySelector('[aria-labelledby="sh-today-title"]')`
  const panelText = () => page.evaluate(`${panel}?.textContent ?? ''`)
  const selectIn = (sel, value) =>
    page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  /** Where a minute of the day sits on the row, on screen — the row scrolled into view. */
  const pointAt = (minute) =>
    page.evaluate(`(() => {
      const row = ${panel}.querySelector('[aria-label^="OPD, "]').parentElement
      row.scrollIntoView({ block: 'center' })
      const r = row.getBoundingClientRect()
      return { x: r.left + ((${minute} - 420) / 720) * r.width, y: r.top + r.height / 2 }
    })()`)
  const mouse = async (type, { x, y }) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })

  return [
    {
      name: 'Today: the day as one row, 7 AM to 7 PM — each activity a bar named with its time, the OPD as long as its queue runs, free time and off hours drawn, Now labelled; the whole day as cards; ‹ › move the calendar with it',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('[role="img"]')`, 3000, 'the Today panel')
        const t = await panelText()
        for (const w of ['Monday, 21 Sep 2026', 'Now · OPD', 'Now · 8:40 AM', '7:00', 'Today’s schedule', 'Off hours'])
          expect(t.includes(w), `the panel says “${w}”`)
        expect(!t.includes('Available slots'), 'no separate slot list — free time is tapped on the timeline')
        // Meera Krishnan, booked into the clinic at 9:10 and still waiting, keeps the OPD running to 9:20 — she is the queue, not a bar of her own.
        expect(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="OPD, 8:00 – 9:20 AM"]')`), 'the morning OPD runs until its queue is seen')
        expect(!(await page.evaluate(`!!${panel}.querySelector('[title^="Meera Krishnan"]')`)), 'a clinic patient is not drawn twice')

        // Free time to come can be tapped; free time already gone cannot.
        const free = await page.evaluate(`[...${panel}.querySelectorAll('button[aria-label^="Free "]')].map((b) => b.getAttribute('aria-label'))`)
        expect(free.includes('Free 12:30 – 2:00 PM — schedule an appointment'), `free time to come is offered: ${free.join(' | ')}`)
        expect(free.every((f) => !/^Free (7|8):/.test(f)), `nothing before now is: ${free.join(' | ')}`)

        // The whole day by default, then only what is on and next.
        const cards = () => page.evaluate(`[...document.querySelectorAll('ol[aria-label="The day’s events"] > li, ol[aria-label="Upcoming events"] > li')].map((li) => li.textContent)`)
        const all = await cards()
        expect(all.length >= 7 && all[0].includes('AI morning brief'), `the whole day, from the morning brief: ${all.join(' | ')}`)
        await page.click('[aria-labelledby="sh-today-title"] button', 'Show what is next')
        await page.until(`document.querySelectorAll('ol[aria-label="Upcoming events"] > li').length === 5`, 3000, 'the next five')
        expect((await cards())[0].includes('OPD') && (await cards())[0].includes('NOW'), 'the OPD on now, first')

        // ‹ › move the day here and in the calendar; Today brings both back.
        await page.click('button[aria-label="Next day"]')
        await page.until(`${panel}.querySelector('h2').textContent === 'Tuesday' && document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-iso') === '2026-09-22'`, 3000, 'Tuesday, here and in the calendar')
        expect((await panelText()).includes('22 Sep 2026 · Coming up'), 'a day to come says so')
        await page.click(`[aria-labelledby="sh-today-title"] button`, 'Today')
        await page.until(`${panel}.querySelector('h2').textContent === 'Today' && document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-iso') === '2026-09-21'`, 3000, 'back to today, both')
      },
    },
    {
      name: 'Today: hovering the OPD on now names the patient the queue calls next — the same one as My patients → OPD',
      async run() {
        await page.open('/op-queue')
        await page.until(`[...document.querySelectorAll('button')].some((b) => /^Call MED-/.test(b.textContent.trim()))`, 3000, 'the queue’s Call button')
        const token = await page.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => /^Call MED-/.test(t)).replace('Call ', '')`)
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('[aria-label^="OPD, "]')`, 3000, 'the timeline')
        await mouse('mouseMoved', await pointAt(8 * 60 + 15))
        await page.until(`!!document.querySelector('.sh-frosted')?.textContent.includes('Next patient')`, 3000, 'the hover card')
        const card = await page.evaluate(`document.querySelector('.sh-frosted').textContent`)
        expect(card.includes('8:15 AM') && card.includes(token), `the queue’s next, ${token}: ${card}`)
      },
    },
    {
      name: 'Today: tapping free time at 1:40 PM schedules the patient at 1:40 PM, without asking for a time; on the timeline and the calendar at once; the patient and the front office told; audited',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('button[aria-label="Free 12:30 – 2:00 PM — schedule an appointment"]')`, 3000, 'the free afternoon')
        const at = await pointAt(13 * 60 + 40)
        await mouse('mouseMoved', at)
        await mouse('mousePressed', at)
        await mouse('mouseReleased', at)
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Schedule an appointment')`, 3000, 'the dialog')
        expect((await page.evaluate(`document.querySelector('#sch-when').textContent`)) === 'Monday 21 September · 1:40 – 2:00 PM', `the minute tapped, to where the free time ends: ${await page.evaluate(`document.querySelector('#sch-when').textContent`)}`)
        expect(!(await page.evaluate(`!!document.querySelector('[role="dialog"] [role="radio"]')`)), 'no time to choose again')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Schedule appointment')).disabled`), 'nothing is scheduled without a patient and a reason')

        await selectIn('#sch-patient', 'SD-P-03')
        await page.type('#sch-purpose', 'Blood pressure review')
        await page.click('[role="dialog"] button', 'Schedule appointment')
        await toastSays('Appointment scheduled', 'R. Lakshmanan · Mon 21 Sep, 1:40 PM')
        await sleep(200)

        expect(await page.evaluate(`!!${panel}.querySelector('[title="R. Lakshmanan · 1:40 – 2:00 PM"]')`), 'the timeline shows it')
        const booked = await page.evaluate(`document.querySelector('ul[aria-label^="Booked with you on Monday 21 September"]')?.textContent ?? ''`)
        expect(booked.includes('R. Lakshmanan') && booked.includes('1:40 PM'), `the calendar's day shows it: ${booked}`)
        const row = (await auditRows()).find((r) => r.event === 'APPOINTMENT.SCHEDULED')
        expect(row && row.subject === 'SD-P-03' && row.detail.includes('20 min') && row.detail.includes('R. Lakshmanan'), `audited: ${JSON.stringify(row)}`)
        const told = (await sentItems()).filter((n) => n.kind === 'appointment' && `${n.title} ${n.detail}`.includes('R. Lakshmanan')).map((n) => n.recipient)
        expect(told.includes('patient') && told.includes('front office'), `the patient and the front office are told: ${told}`)
      },
    },
    {
      name: 'Today: a day that has gone offers no free time to schedule',
      async run() {
        await page.open('/')
        await page.click('button[aria-label="Previous day"]')
        await page.until(`${panel}.querySelector('h2').textContent === 'Sunday'`, 3000, 'Sunday')
        const t = await panelText()
        expect(t.includes('Earlier') && t.includes('That day'), `a day gone says so: ${t.slice(0, 300)}`)
        expect(!(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="Free "]')`)), 'and offers nothing to schedule')
      },
    },
  ]
}
