/**
 * The calendar (My Day's week card, the month it expands to, Blocks and leave
 * S-05-05) and the appointment book it reads: blocking time, moving and
 * cancelling appointments, and who is told what. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, sentItems, toastSays }) => {
  const gridLabel = () => page.evaluate(`document.querySelector('[role="grid"]').getAttribute('aria-label')`)
  const cellLabel = (prefix) => page.evaluate(`document.querySelector('button[role="gridcell"][aria-label^="${prefix}"]')?.getAttribute('aria-label') ?? ''`)
  const dialogText = () => page.evaluate(`document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? ''`)
  const selectIn = (sel, value) =>
    page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)

  return [
    {
      name: 'Calendar: the week by default, weeks and months one arrow away, Today only once you have moved, the chosen day kept across week and month, and the keyboard inside one tab stop',
      async run() {
        await page.open('/')
        expect((await gridLabel()) === 'Week of 21 – 27 Sep 2026', `this week: ${await gridLabel()}`)
        expect(!(await page.evaluate(`!!document.querySelector('button[aria-label="Back to today"]')`)), 'no Today control while on this week')
        expect((await page.evaluate(`document.querySelector('[aria-current="date"]').getAttribute('data-iso')`)) === '2026-09-21', 'today is marked')
        await page.click('button[aria-label="Next week"]')
        await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'Week of 28 Sep – 4 Oct 2026'`, 3000, 'the next week')
        await page.click('button[aria-label="Back to today"]')
        await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'Week of 21 – 27 Sep 2026'`, 3000, 'Today brings the week back')

        // The keyboard: one tab stop, arrows move the day, ↓ crosses into next week.
        await page.until(`document.querySelectorAll('[role="grid"]').length === 1`, 3000, 'the slide has settled')
        expect((await page.evaluate(`[...document.querySelectorAll('[role="grid"] [role="gridcell"]')].filter((c) => c.tabIndex === 0).length`)) === 1, 'the grid is one tab stop')
        await page.evaluate(`document.querySelector('[role="grid"] [role="gridcell"][tabindex="0"]').focus()`)
        const focused = await page.evaluate(`document.activeElement?.getAttribute('data-iso') ?? document.activeElement?.tagName`)
        expect(focused === '2026-09-21', `the tab stop is today: ${focused}`)
        await page.key('ArrowRight')
        await page.until(`document.activeElement?.getAttribute('data-iso') === '2026-09-22' && document.activeElement.getAttribute('aria-selected') === 'true'`, 2000, '→ moves to Tuesday and selects it')
        await page.key('ArrowDown')
        await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'Week of 28 Sep – 4 Oct 2026' && document.activeElement?.getAttribute('data-iso') === '2026-09-29'`, 3000, '↓ moves a week, into the next one')

        // Week ↔ month is the same card; the chosen day survives the switch.
        await page.click('button', 'Month')
        await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'September 2026'`, 3000, 'the month in place')
        await page.click('button', 'Week')
        await page.until(`document.querySelector('[role="grid"]').getAttribute('aria-label') === 'Week of 28 Sep – 4 Oct 2026' && document.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-iso') === '2026-09-29'`, 3000, 'back to the week that holds the chosen day')
      },
    },
    {
      name: 'Calendar: blocking a day lists who is booked before anything is done; the booking moves to the first free slot of its clinic; the front office is told the reason, the patient only the new time; on record; unblocking tells the front office',
      async run() {
        await page.open('/')
        await page.click('button[role="gridcell"][aria-label^="Tuesday 22 September 2026"]')
        await page.click('button', 'Block time')
        await page.until(`!!document.querySelector('[role="dialog"]')?.textContent.includes('Block time')`, 3000, 'the block dialog')
        await selectIn('#blk-reason', 'Conference')
        await page.until(`document.querySelector('[role="dialog"]').textContent.includes('1 booked with you — nothing is done to them until you confirm')`, 3000, 'the booking is surfaced first')
        const text = await dialogText()
        expect(text.includes('Sunita Devi · Tue 22 Sep 2026, 14:30') && text.includes('Move to Tue 29 Sep, 14:00') && text.includes('Thyroid and endocrine follow-up — your first free slot'), `the first free slot of the same clinic: ${text.slice(0, 400)}`)
        await page.click('[role="dialog"] button', 'Block and notify')
        await toastSays('Time blocked', 'Tue 22 Sep, all day · Conference.')
        expect((await cellLabel('Tuesday 22 September 2026')).includes('blocked: Conference'), 'the day carries the block')
        const sent = await sentItems()
        const office = sent.find((n) => n.recipient === 'front office' && n.title.includes('blocked Tue 22 Sep, all day'))
        const patient = sent.find((n) => n.recipient === 'patient' && n.detail.startsWith('Sunita Devi'))
        expect(office && office.detail.includes('Conference') && office.detail.includes('moved to Tue 29 Sep 2026, 14:00'), `the front office has the reason and what happened: ${JSON.stringify(office)}`)
        expect(patient && patient.detail.includes('Tue 29 Sep 2026, 14:00') && !patient.detail.includes('Conference'), `the patient has the new time and not the reason: ${JSON.stringify(patient)}`)
        const rows = await auditRows()
        expect(rows.some((r) => r.event === 'SCHEDULE.BLOCKED' && r.detail.includes('Conference')) && rows.some((r) => r.event === 'APPOINTMENT.RESCHEDULED' && r.subject === 'SD-P-04'), 'the block and the move are on record')

        // Her record says the same: the move under Changed, and the new time as next.
        await page.open('/patient/ICH-0044208/appointments', { fresh: false })
        const record = await page.text()
        expect(record.includes('Moved by Dr. Rajsrinivas to Tue 29 Sep, 14:00') && record.includes('Changed'), 'the record keeps the move')
        expect(!(await page.evaluate(`document.querySelector('h1').parentElement.textContent`)).includes('22-Sep'), 'and nothing on the blocked day is next any more')

        // Unblocking is confirmed and tells the front office.
        await page.open('/schedule/blocks', { fresh: false })
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-05-05"]')`), 'S-05-05 is drawn')
        expect((await page.text()).includes('Tue 22 Sep, all day'), 'Blocks and leave lists the block')
        await page.click('button[aria-label^="Unblock Tue 22 Sep"]')
        await page.click('[role="alertdialog"] button', 'Unblock')
        await toastSays('Block removed')
        expect((await sentItems()).some((n) => n.recipient === 'front office' && n.title.includes('unblocked Tue 22 Sep')), 'the front office is told')
        expect((await auditRows()).some((r) => r.event === 'SCHEDULE.UNBLOCKED'), 'on record')
      },
    },
    {
      name: 'Appointments: a cancellation needs a reason and is kept with it; a move from the day offers the doctor’s free slots; each tells the patient and the front office',
      async run() {
        await page.open('/patient/ICH-0044262/appointments')
        await page.click('button[aria-label="Cancel: Sodium recheck result and anticoagulation plan"]')
        await page.until(`!!document.querySelector('[role="alertdialog"]')?.textContent.includes('Cancel the appointment?')`, 3000, 'the cancel dialog')
        expect(await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.includes('Cancel the appointment')).disabled`), 'a reason is required')
        await selectIn('#cx-reason', 'Patient asked to cancel')
        await page.click('[role="alertdialog"] button', 'Cancel the appointment')
        await toastSays('Appointment cancelled')
        expect((await page.text()).includes('Cancelled by Dr. Rajsrinivas · Patient asked to cancel'), 'kept with its reason')
        const office = (await sentItems()).find((n) => n.recipient === 'front office' && n.title === 'Appointment cancelled — Selvi Murugan')
        expect(office && office.detail.includes('Reason: Patient asked to cancel.'), `the front office has the reason: ${JSON.stringify(office)}`)
        expect((await auditRows()).some((r) => r.event === 'APPOINTMENT.CANCELLED' && r.subject === 'SD-P-11'), 'on record')

        // A move from My Day's day detail.
        await page.open('/', { fresh: false })
        await page.click('button[role="gridcell"][aria-label^="Tuesday 22 September 2026"]')
        await page.click(`button[aria-label="Move Sunita Devi's appointment"]`)
        await page.until(`!!document.querySelector('[role="dialog"]')?.textContent.includes('Move the appointment')`, 3000, 'the move dialog')
        expect((await dialogText()).includes('Tue 22 Sep, 14:00') && (await dialogText()).includes('Thyroid and endocrine follow-up — your first free slot'), `her own clinic’s next free slot first: ${(await dialogText()).slice(0, 300)}`)
        await page.click('[role="dialog"] button', 'Move and notify')
        await toastSays('Appointment moved', 'Sunita Devi')
        // The first free slot was earlier the same afternoon: the day now shows her at 14:00, not 14:30.
        const booked = await page.evaluate(`document.querySelector('ul[aria-label^="Booked with you on Tuesday 22 September"]')?.textContent ?? ''`)
        expect(booked.includes('14:00') && !booked.includes('14:30'), `the day shows the new time: ${booked}`)
      },
    },
  ]
}
