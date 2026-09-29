/**
 * Scheduling and pharmacy (M-05, M-16): session templates (S-05-04),
 * referrals (S-05-06) and ADR reporting (S-16-08). Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, toastSays }) => {
  const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))`

  return [
    {
      name: 'Session templates (S-05-04): today first, the week one tap away; an edit is a new version, never retrospective; a new session is created from the date in the header',
      async run() {
        await page.open('/schedule/templates')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-05-04"]')`), 'S-05-04 is drawn')
        const text = await page.text()
        expect(text.includes('1 session today · 4 this week · 2 capacity suggestions'), 'the old counts')
        await page.click('[role="tab"]', 'This week')
        await page.until(`location.search === '?scope=week'`, 3000, 'the week, in the address')
        expect((await page.evaluate(`document.querySelectorAll('ul[aria-label^="Weekly session pattern"] > li').length`)) === 4, 'four sessions this week')
        await page.click('ul[aria-label^="Weekly session pattern"] > li button[aria-label^="Edit Monday"]')
        await page.until(`!!document.querySelector('[aria-label="Edit the Monday template"]')`, 3000, 'the editor')
        await page.click('button', 'Save a new version')
        await toastSays('Monday template updated', 'Effective from 01-Oct-2026. Existing bookings are untouched.')
        await page.click('button', 'New session')
        await page.until(`!!document.querySelector('[role="dialog"]')?.textContent.includes('New session template')`, 3000, 'the new-session dialog')
        expect(await page.evaluate(`${byText('[role="dialog"] button', 'Create session')}.disabled`), 'a clinic name is required')
        await page.type('#new-session-clinic', 'Thyroid clinic')
        await page.click('[role="dialog"] button', 'Create session')
        await toastSays('Session created', 'Monday 14:00–17:00 · 12 slots of 15 min · from 2026-09-21.')
      },
    },
    {
      name: 'Referrals (S-05-06): urgent first with the AI on, date received with it off; booking a slot replies to the referrer and moves the referral to triaged',
      async run() {
        await page.open('/referrals')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-05-06"]')`), 'S-05-06 is drawn')
        expect((await page.text()).includes('3 to triage · 1 urgent'), 'the counts')
        const first = () => page.evaluate(`document.querySelector('ul[aria-label="Inbound referrals"] > li h3').textContent`)
        expect((await first()).includes('Cardiology'), 'the urgent cardiology referral first')
        await page.open('/referrals?ai=off', { fresh: false })
        const off = await page.text()
        expect(!off.includes('Urgent · 48 hours'), 'no proposed urgency with the AI off')
        await page.open('/referrals', { fresh: false })
        await page.evaluate(`(() => { const s = document.querySelector('select[aria-label^="Slot for"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'Tue 22-Sep 09:20 · rapid access'); s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
        await page.click('button', 'Book and reply to the referrer')
        await toastSays('booked', 'Tue 22-Sep 09:20 · rapid access. A confirmation goes back to')
        expect((await page.text()).includes('2 to triage') && (await page.text()).includes('1 triaged'), 'it moves to triaged')
      },
    },
    {
      name: 'ADR reporting (S-16-08): the AI-815 signal is an offer; the report cannot be submitted without a narrative and the attestation',
      async run() {
        await page.open('/pharmacy/adr')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-16-08"]')`), 'S-16-08 is drawn')
        const text = await page.text()
        expect(text.includes('PvPI Form 1') && text.includes('1 signal detected') && text.includes('Co-amoxiclav 1.2g IV → Urticaria with facial swelling'), 'the signal')
        const submitOff = () => page.evaluate(`${byText('button', 'Submit the report')}.disabled`)
        expect(await submitOff(), 'nothing to submit yet')
        await page.type('textarea[id="adr-narrative"]', 'Urticarial rash over the trunk 90 minutes after the first dose; infusion stopped.')
        expect(await submitOff(), 'still needs the attestation')
        await page.click('[role="checkbox"]', 'The information above is accurate')
        expect(!(await submitOff()), 'ready')
        await page.click('button', 'Submit the report')
        await toastSays('ADR reported to PvPI', 'Co-amoxiclav 1.2g IV · Urticaria with facial swelling.')
        await page.open('/pharmacy/adr?ai=off', { fresh: false })
        expect(!(await page.text()).includes('A signal has been detected'), 'no signal with the AI off; the form stays')
      },
    },
  ]
}
