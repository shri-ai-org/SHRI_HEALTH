/**
 * Every patient on today's lists — the six in OPD and the seven inpatients —
 * has a record with nothing empty and nothing thin: vitals with their history,
 * a trend, an image or a document on the report viewer, results, and enough
 * notes, appointments and timeline to read as a course of care. Loaded by
 * scripts/shri-flows.mjs.
 */

const TODAY = {
  'ISH-0044120': 'Meera Krishnan',
  'ISH-0044208': 'Sunita Devi',
  'ISH-0044240': 'Arjun Nair',
  'ISH-0044262': 'Selvi Murugan',
  'ISH-0044290': 'Lakshmi Narayanan',
  'ISH-0044297': 'Rahul Verma',
  'ISH-0041882': 'Abdul Rahman Sheikh',
  'ISH-0044051': 'R. Lakshmanan',
  'ISH-0044191': 'Kavya Reddy',
  'ISH-0043910': 'Joseph Mathew',
  'ISH-0042330': 'Fatima Bi',
  'ISH-0044275': 'Kumar Subramanian',
  'ISH-0044281': 'Priya Raman',
}

/** The least each part of the record carries for a patient on today's lists. */
const AT_LEAST = { 'Test results': 3, 'Imaging reports': 1, 'Consultation notes': 2, Prescriptions: 1, Appointments: 3, Condition: 1 }
/**
 * Rahul Verma recovered and was discharged from follow-up this morning — his
 * note says so — so he takes no medicine now and has no visit booked. The
 * record says that rather than being padded.
 */
const EXCEPT = { 'ISH-0044297': { Prescriptions: 0, Appointments: 2 } }

// One flow per patient, each on a fresh page, so thirteen records never share one long-lived tab.
export default ({ page, expect }) =>
  Object.entries(TODAY).map(([uhid, name]) => ({
    name: `Today's patients are filled — ${name}: vitals with history, a trend, an image or document, results, notes, appointments and a timeline`,
    async run() {
      {
        await page.open(`/patient/${uhid}`)
        await page.until(`document.querySelectorAll('#record-panel section.rounded-sh-card').length >= 6`, 4000, `${name}: the overview`)
        const card = (title) => `[...document.querySelectorAll('#record-panel section.rounded-sh-card')].find((c) => (c.querySelector('h2')?.textContent ?? '').trim().startsWith('${title}'))`
        const got = await page.evaluate(`(() => {
          const vitals = ${card('Vitals')}
          const trend = ${card('Trend')}
          const viewer = ${card('Report viewer')}
          const results = ${card('Test results')}
          return {
            vitals: vitals?.querySelectorAll('dl > div').length ?? 0,
            sparklines: vitals?.querySelectorAll('dl svg[role="img"]').length ?? 0,
            trend: !!trend?.querySelector('svg') && !trend.textContent.includes('No result has two or more values yet'),
            viewer: !!viewer && !viewer.textContent.includes('No imaging on file') && (!!viewer.querySelector('img') || viewer.textContent.includes('no images with this report')),
            results: !!results && !results.textContent.includes('No results yet'),
            tabs: [...document.querySelectorAll('[role="tab"][id^="record-tab-"]')].map((t) => t.textContent.trim()),
          }
        })()`)
        expect(got.vitals >= 5, `${name}: ${got.vitals} vitals`)
        expect(got.sparklines >= 2, `${name}: vitals with a history (${got.sparklines} lines)`)
        expect(got.trend, `${name}: the Trend card charts something`)
        expect(got.viewer, `${name}: the report viewer shows an image or a document`)
        expect(got.results, `${name}: test results on file`)
        for (const [part, fallback] of Object.entries(AT_LEAST)) {
          const least = EXCEPT[uhid]?.[part] ?? fallback
          const tab = got.tabs.find((t) => t.startsWith(part))
          const n = Number((tab ?? '').slice(part.length)) || 0
          expect(n >= least, `${name}: ${part} ${n} (at least ${least}) — ${got.tabs.join(',')}`)
        }
        await page.open(`/patient/${uhid}/timeline`, { fresh: false })
        await page.until(`!!document.querySelector('[data-screen-id="S-06-06"]')`, 4000, `${name}: the timeline`)
        const events = Number(/(\d+) in the record/.exec(await page.text())?.[1] ?? 0)
        expect(events >= 6, `${name}: ${events} timeline entries`)
      }
    },
  }))
