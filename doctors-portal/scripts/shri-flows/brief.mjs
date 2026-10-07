/**
 * The AI morning brief (S-06-18), opened from the Today panel, and the names
 * the sidebar and the pages share: Test results, Imaging reports. Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect }) => {
  const text = () => page.evaluate(`document.querySelector('.shri-root')?.textContent ?? ''`)

  return [
    {
      name: 'Brief (S-06-18): the morning brief opens from the Today panel — the night in one line, the critical result to acknowledge first, the results that changed by patient, the inpatients and the day',
      async run() {
        await page.open('/')
        await page.click('button[aria-label^="AI morning brief, 7:30"]')
        await page.until(`!!document.querySelector('[data-screen-id="S-06-18"]')`, 3000, 'the brief')
        const summary = await page.evaluate(`document.querySelector('#brief-summary')?.textContent ?? ''`)
        expect(summary.startsWith('1 critical result is waiting for you, starting with serum potassium of 6.8 mmol/L for Joseph Mathew.'), `the night in one line: ${summary}`)
        expect(summary.includes('24 results have changed across 10 patients') && summary.includes('Today you have '), `the results and the day: ${summary}`)
        const t = await text()
        for (const w of ['Act first', 'Results that changed', 'Your inpatients overnight', 'Left to finish', 'New deterioration'])
          expect(t.includes(w), `the brief has “${w}”`)
        // The same count as the Today panel's brief: one source.
        expect(await page.evaluate(`document.querySelectorAll('ul[aria-label="Critical results to acknowledge"] li').length === 1`), 'one critical result to act on')
        await page.click('ul[aria-label="Critical results to acknowledge"] button')
        await page.until(`location.pathname.startsWith('/results/')`, 3000, 'the result opens, to acknowledge')
      },
    },
    {
      name: 'Brief (S-06-18): with the AI off there is no summary and no ranking — the lists stay, each result with its range',
      async run() {
        await page.open('/brief?state=AI-OFF')
        await page.until(`!!document.querySelector('[data-screen-id="S-06-18"]')`, 3000, 'the brief')
        expect(!(await page.evaluate(`!!document.querySelector('#brief-summary')`)), 'no AI summary')
        const t = await text()
        expect(t.includes('AI assistance is off') && t.includes('Normal range '), `the plain lists, with ranges: ${t.slice(0, 200)}`)
      },
    },
    {
      name: 'Names: the sidebar, the pages and the record agree — Test results and Imaging reports',
      async run() {
        await page.open('/')
        const named = (sel) => `(() => { const a = document.querySelector('${sel}'); return ((a?.getAttribute('aria-label') ?? '') + ' ' + (a?.textContent ?? '')) })()`
        expect((await page.evaluate(named('nav[aria-label="Main"] a[href="/results/inbox"]'))).includes('Test results'), 'the sidebar says Test results')
        await page.open('/results/inbox', { fresh: false })
        expect(await page.evaluate(`document.querySelector('h1')?.textContent === 'Test results'`), 'the page says Test results')
        await page.open('/radiology/worklist', { persona: 'P-13' })
        expect(await page.evaluate(`document.querySelector('h1')?.textContent === 'Imaging reports'`), 'the imaging page says Imaging reports')
        // On a page under More, More stands open.
        await page.until(`${named('a[href="/radiology/worklist"]')}.includes('Imaging reports')`, 3000, 'the sidebar says Imaging reports')
      },
    },
    {
      name: 'Names: Coimbatore is ISH — the patient’s UHID reads ISH on the record, and a link saved with the old ICH code still opens the patient',
      async run() {
        await page.open('/patient/ISH-0044051')
        expect((await text()).includes('ISH-0044051') && !(await text()).includes('ICH-0044051'), 'the record shows ISH-0044051')
        await page.open('/patient/ICH-0044051', { fresh: false })
        await page.until(`(document.querySelector('.shri-root')?.textContent ?? '').includes('ISH-0044051')`, 3000, 'the old link opens R. Lakshmanan')
        expect((await text()).includes('R. Lakshmanan'), 'the same patient')
      },
    },
  ]
}
