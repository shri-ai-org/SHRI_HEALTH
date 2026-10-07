/**
 * The cursor, as every site shows it: a pointing hand over anything that does
 * something when clicked, a text cursor in a box you type into, and "not
 * allowed" over a control that is switched off. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect }) => [
  {
    name: 'Cursor: a pointing hand over buttons, links, tabs and timeline bars; a text cursor in text boxes; not-allowed on a disabled button',
    async run() {
      await page.open('/')
      const cursorOf = (sel) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).cursor : 'missing' })()`)
      for (const sel of ['nav[aria-label="Main"] a[href="/results/inbox"]', 'button[aria-label="Next day"]', '[role="tab"]', 'button[aria-label^="Free 12:30"]', '[role="gridcell"]'])
        expect((await cursorOf(sel)) === 'pointer', `${sel} shows a pointing hand: ${await cursorOf(sel)}`)

      await page.click('button[aria-label="Free 12:30 – 2:00 PM — schedule an appointment"]')
      await page.until(`!!document.querySelector('#sch-purpose')`, 3000, 'the schedule dialog')
      expect((await cursorOf('#sch-purpose')) === 'text', `the reason box shows a text cursor: ${await cursorOf('#sch-purpose')}`)
      expect((await cursorOf('#sch-patient')) === 'pointer', `the patient list shows a pointing hand: ${await cursorOf('#sch-patient')}`)
      const disabled = await page.evaluate(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent.includes('Schedule appointment')); return b.disabled ? getComputedStyle(b).cursor : 'enabled' })()`)
      expect(disabled === 'not-allowed', `a disabled button says so: ${disabled}`)
    },
  },
]
