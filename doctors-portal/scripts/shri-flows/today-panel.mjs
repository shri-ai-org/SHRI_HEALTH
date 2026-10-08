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
  /** Where a minute of the day sits on the row, on screen, by the row's own scale (`data-scale`) — the row scrolled into view. */
  const pointAt = (minute) =>
    page.evaluate(`(() => {
      const row = ${panel}.querySelector('[data-scale]')
      row.scrollIntoView({ block: 'center' })
      const pts = JSON.parse(row.dataset.scale)
      let i = 0
      while (i < pts.length - 2 && pts[i + 1][0] <= ${minute}) i += 1
      const [[m0, f0], [m1, f1]] = [pts[i], pts[i + 1]]
      const r = row.getBoundingClientRect()
      return { x: r.left + (f0 + ((${minute} - m0) / (m1 - m0)) * (f1 - f0)) * r.width, y: r.top + r.height / 2 }
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

        // Every bar does something, however short — a 15-minute gap, a 15-minute booking — but time gone.
        const inert = await page.evaluate(`[...${panel}.querySelector('[aria-label^="OPD, "]').parentElement.children].filter((c) => c.tagName === 'SPAN' && c.title).map((c) => c.title)`)
        expect(inert.length === 1 && inert[0] === 'Off hours · 7:00 – 7:30 AM', `only the off hours gone are inert: ${inert.join(' | ')}`)
        expect(await page.evaluate(`!!${panel}.querySelector('button[aria-label="Available 11:15 – 11:30 AM — schedule an appointment"]') && !!${panel}.querySelector('button[aria-label^="Kavya Reddy, 11:00 – 11:15 AM"]')`), 'the 15-minute gap and the 15-minute booking are buttons')

        // Short bars are one size, wider than their minutes alone would make them; the OPD's are longer.
        const widths = await page.evaluate(`Object.fromEntries(['Kavya Reddy, 11:00', 'Available 11:15', 'Arjun Nair, 11:30', 'Available 11:45', 'OPD, 8:00'].map((l) => [l, Math.round(${panel}.querySelector('[aria-label^="' + l + '"]').getBoundingClientRect().width)]))`)
        const short = ['Kavya Reddy, 11:00', 'Available 11:15', 'Arjun Nair, 11:30', 'Available 11:45'].map((l) => widths[l])
        expect(short.every((x) => x === short[0]) && short[0] >= 64 && widths['OPD, 8:00'] > short[0], `uniform short bars: ${JSON.stringify(widths)}`)

        // A booked patient is an OPD visit: the OPD's green, and the key names it once.
        const colour = (l) => `getComputedStyle(${panel}.querySelector('[aria-label^="${l}"]')).backgroundColor`
        expect(await page.evaluate(`${colour('Kavya Reddy, 11:00')} === ${colour('OPD, 8:00')}`), 'Kavya Reddy’s booking is OPD green')
        expect(!t.includes('Booked patient'), 'the key has no separate Booked patient')

        // Free time to come can be tapped, and is a picture, not words; free time already gone cannot.
        const free = await page.evaluate(`[...${panel}.querySelectorAll('button[aria-label^="Available "]')].map((b) => b.getAttribute('aria-label'))`)
        expect(free.includes('Available 9:20 – 10:05 AM — schedule an appointment'), `free time to come is offered: ${free.join(' | ')}`)
        expect(free.every((f) => !/^Available (7|8):/.test(f)), `nothing before now is: ${free.join(' | ')}`)
        expect(await page.evaluate(`[...${panel}.querySelectorAll('button[aria-label^="Available "]')].every((b) => b.textContent.trim() === '' && !!b.querySelector('svg'))`), 'no word on free time, a + instead')

        // Lunch, 12:30 to 2 PM, is off hours like any other: hatched, opened only by the doctor.
        expect(await page.evaluate(`!!${panel}.querySelector('button[aria-label="Off hours 12:30 – 2:00 PM — open extra hours or schedule here"]')`), 'lunch is off hours, offered to open')
        expect(!free.some((f) => /^Available (12:[3-5]|1:)/.test(f)) && !t.includes('Lunch'), `nothing at lunch is free, and nothing says lunch: ${free.join(' | ')}`)

        // The whole day by default, then only what is on and next.
        const cards = () => page.evaluate(`[...document.querySelectorAll('ol[aria-label="The day’s events"] > li, ol[aria-label="Upcoming events"] > li')].map((li) => li.textContent)`)
        const all = await cards()
        expect(all.length >= 7 && all[0].includes('AI morning brief'), `the whole day, from the morning brief: ${all.join(' | ')}`)
        await page.click('[aria-labelledby="sh-today-title"] button', 'Show upcoming only')
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
      name: 'Today: tapping free time at 9:40 AM schedules the patient at 9:40 AM, without asking for a time, the reason typed or dictated; on the timeline and the calendar at once; the patient and the front office told; audited',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('button[aria-label="Available 9:20 – 10:05 AM — schedule an appointment"]')`, 3000, 'the free morning')
        const at = await pointAt(9 * 60 + 40)
        await mouse('mouseMoved', at)
        await mouse('mousePressed', at)
        await mouse('mouseReleased', at)
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Schedule an appointment')`, 3000, 'the dialog')
        expect((await page.evaluate(`document.querySelector('#sch-when').textContent`)) === 'Monday 21 September · 9:40 – 10:05 AM', `the minute tapped, to where the free time ends: ${await page.evaluate(`document.querySelector('#sch-when').textContent`)}`)
        expect(!(await page.evaluate(`!!document.querySelector('[role="dialog"] [role="radio"]')`)), 'no time to choose again')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Schedule appointment')).disabled`), 'nothing is scheduled without a patient and a reason')
        expect(await page.evaluate(`!!document.querySelector('[role="dialog"] button[aria-label="Dictate into reason"]')`), 'the reason can be dictated')

        await selectIn('#sch-patient', 'SD-P-03')
        await page.type('#sch-purpose', 'Blood pressure review')
        await page.click('[role="dialog"] button', 'Schedule appointment')
        await toastSays('Appointment scheduled', 'R. Lakshmanan · Mon 21 Sep, 9:40 AM')
        await sleep(200)

        expect(await page.evaluate(`!!${panel}.querySelector('[title="R. Lakshmanan · 9:40 – 10:05 AM"]')`), 'the timeline shows it')
        const booked = await page.evaluate(`document.querySelector('ul[aria-label^="Booked with you on Monday 21 September"]')?.textContent ?? ''`)
        expect(booked.includes('R. Lakshmanan') && booked.includes('9:40 AM'), `the calendar's day shows it: ${booked}`)
        const row = (await auditRows()).find((r) => r.event === 'APPOINTMENT.SCHEDULED')
        expect(row && row.subject === 'SD-P-03' && row.detail.includes('25 min') && row.detail.includes('R. Lakshmanan'), `audited: ${JSON.stringify(row)}`)
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
        expect(!(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="Available "]')`)), 'and offers nothing to schedule')
      },
    },
  ]
}
