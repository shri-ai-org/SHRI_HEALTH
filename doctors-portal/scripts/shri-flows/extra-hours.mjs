/**
 * Off hours on the Today panel: opened as extra hours the front office may
 * book patients into — told, audited, offered when an appointment is moved,
 * closed again — or used for one appointment of the doctor's own, an
 * operation before the working day. Never time already gone. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, sentItems, toastSays, setInput }) => {
  const panel = `document.querySelector('[aria-labelledby="sh-today-title"]')`
  const dialogText = () => page.evaluate(`document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? ''`)
  const selectIn = (sel, value) =>
    page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)

  return [
    {
      name: 'Extra hours: off hours tapped this evening open as extra hours the front office may book — told, audited, on the timeline and offered when an appointment moves; closing them tells the front office again',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('button[aria-label="Off hours 5:00 – 7:00 PM — open extra hours or schedule here"]')`, 3000, 'the evening off hours')
        await page.click('button[aria-label="Off hours 5:00 – 7:00 PM — open extra hours or schedule here"]')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Outside your working hours')`, 3000, 'the off-hours choice')
        await page.click('[role="dialog"] button', 'Open extra hours')
        await page.until(`document.querySelector('#oh-when')?.textContent === 'Mon 21 Sep, 5:00 – 7:00 PM'`, 3000, 'the extra hours, from the off hours tapped')
        expect((await dialogText()).includes('Allow the front office to book patients into these hours'), 'for the front office, by default')
        await page.click('[role="dialog"] button', 'Open extra hours')
        await toastSays('Extra hours opened', 'Mon 21 Sep, 5:00 – 7:00 PM. The front office has been notified')

        await page.until(`!!${panel}.querySelector('button[aria-label="Extra hours 5:00 – 7:00 PM — schedule an appointment"]')`, 3000, 'extra hours on the timeline, to schedule into')
        expect((await page.evaluate(`document.body.textContent`)).includes('Extra hours · open for front office bookings'), 'the calendar’s day says so')
        const told = (await sentItems()).find((n) => n.recipient === 'front office' && n.title.includes('extra hours Mon 21 Sep, 5:00 – 7:00 PM'))
        expect(told, 'the front office is told it may book')
        const opened = (await auditRows()).find((r) => r.event === 'SCHEDULE.HOURS_OPENED')
        expect(opened && opened.detail.includes('the front office may book'), `audited: ${JSON.stringify(opened)}`)

        // Moving an appointment offers the extra hours first.
        await page.click(`button[aria-label="Move Kavya Reddy's appointment"]`)
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Move the appointment')`, 3000, 'the move dialog')
        const move = await dialogText()
        expect(move.includes('Mon 21 Sep, 17:00') && move.includes('Extra hours'), `the extra hours are offered: ${move.slice(0, 300)}`)
        await page.key('Escape')
        await page.until(`!document.querySelector('[role="dialog"]')`, 3000, 'the move dialog closed, nothing moved')

        await page.click('button[aria-label="Close extra hours Mon 21 Sep, 5:00 – 7:00 PM"]')
        await page.until(`(document.querySelector('[role="alertdialog"], [role="dialog"]')?.textContent ?? '').includes('Patients who are already booked will keep their appointments')`, 3000, 'the close confirmation')
        await page.click('[role="alertdialog"] button, [role="dialog"] button', 'Close extra hours')
        await toastSays('Extra hours closed')
        await page.until(`!!${panel}.querySelector('button[aria-label="Off hours 5:00 – 7:00 PM — open extra hours or schedule here"]')`, 3000, 'off hours again')
        expect((await auditRows()).some((r) => r.event === 'SCHEDULE.HOURS_CLOSED'), 'closing is audited')
        expect((await sentItems()).some((n) => n.recipient === 'front office' && n.title.includes('extra hours closed')), 'and the front office told')
      },
    },
    {
      name: 'Extra hours: an operation before the working day — off hours tapped, the start moved to 6:00 AM, a theatre and two hours; the day widens to show it; the front office told it is outside working hours',
      async run() {
        await page.open('/')
        await page.click('button[aria-label="Next day"]')
        await page.until(`${panel}.querySelector('h2').textContent === 'Tuesday'`, 3000, 'Tuesday')
        await page.click('button[aria-label="Off hours 7:00 – 8:00 AM — open extra hours or schedule here"]')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Outside your working hours')`, 3000, 'the off-hours choice')
        await page.click('[role="dialog"] button', 'Schedule a patient or procedure')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('This time is outside your working hours. Only this appointment will be added')`, 3000, 'scheduling outside working hours')

        await selectIn('#sch-kind', 'Procedure')
        await page.until(`!!document.querySelector('#sch-place')`, 2000, 'a place and a length')
        await selectIn('#sch-place', 'Main theatre OT-2')
        await selectIn('#sch-length', '120')
        await setInput('#sch-start', '06:00')
        await selectIn('#sch-patient', 'SD-P-03')
        await page.type('#sch-purpose', 'Laparoscopic cholecystectomy')
        await page.until(`document.querySelector('#sch-when')?.textContent === 'Tuesday 22 September · 6:00 – 8:00 AM'`, 2000, 'the start moved before the timeline’s 7 AM')
        await page.click('[role="dialog"] button', 'Schedule appointment')
        await toastSays('Appointment scheduled', 'R. Lakshmanan · Tue 22 Sep, 6:00 AM')

        await page.until(`!!${panel}.querySelector('[title="R. Lakshmanan · 6:00 – 8:00 AM"]')`, 3000, 'the operation on the timeline')
        const hours = await page.evaluate(`[...document.querySelectorAll('ul[aria-label="Hour by hour, Tuesday 22 September"] li')].map((li) => li.textContent)`)
        expect(hours[0]?.startsWith('6–7 AM · busy'), `the day widens to 6 AM: ${hours.slice(0, 3).join(' | ')}`)
        const row = (await auditRows()).find((r) => r.event === 'APPOINTMENT.SCHEDULED')
        expect(row && row.detail.includes('120 min') && row.detail.includes('Main theatre OT-2') && row.detail.includes('outside working hours'), `audited: ${JSON.stringify(row)}`)
        const told = (await sentItems()).find((n) => n.recipient === 'front office' && n.title.includes('R. Lakshmanan'))
        expect(told && told.detail.includes('outside working hours'), `the front office is told: ${JSON.stringify(told)}`)
      },
    },
    {
      name: 'Extra hours: off hours already gone are never offered — this morning before 7:30 is drawn, not tappable',
      async run() {
        await page.open('/')
        await page.until(`!!${panel}?.querySelector('button[aria-label^="Off hours 5:00"]')`, 3000, 'the evening off hours')
        expect(!(await page.evaluate(`!!${panel}.querySelector('button[aria-label^="Off hours 7:"]')`)), 'the morning’s off hours, gone, are not offered')
      },
    },
  ]
}
