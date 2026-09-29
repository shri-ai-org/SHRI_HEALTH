/**
 * The record overview's fixed layout: every card on every record, in the same
 * place, whatever the patient has — so the page never reflows between
 * patients. Loaded by scripts/shri-flows.mjs.
 */

const UHIDS = [
  'ICH-0044120', 'ICH-0041882', 'ICH-0044051', 'ICH-0044208', 'IPL-0012774', 'ICH-0044191', 'ICH-0043910', 'ICH-0042330',
  'ICH-0044240', 'ICH-0044262', 'ICH-0044275', 'ICH-0044281', 'ITP-0021934', 'ICH-0044290', 'ICH-0044297',
]
const CARDS = 'Report viewer|Vitals|AI insights|Test results|Trend|Patient report'

export default ({ page, expect }) => {
  /** Each card's title and its column/row, read from the panel. */
  const layout = () =>
    page.evaluate(`(() => {
      const panel = document.querySelector('#record-panel')
      return [...panel.querySelectorAll('section.rounded-sh-card')].filter((c) => !c.parentElement.closest('section.rounded-sh-card')).map((c) => {
        const r = c.getBoundingClientRect()
        return { title: (c.querySelector('h2')?.textContent ?? '').replace(/\\s+/g, ' ').replace(/^[^A-Za-z]+/, '').trim(), x: Math.round(r.left), h: Math.round(r.height) }
      })
    })()`)
  const titles = (cards) => cards.map((c) => CARDS.split('|').find((t) => c.title.startsWith(t)) ?? c.title).join('|')

  return [
    {
      name: 'Record layout (S-06-11): the same six cards in the same places for all fifteen patients, and with the AI off — none collapsed',
      async run() {
        let reference
        let first = true
        // Every patient with the AI on; with it off, one of each shape (full, no imaging, no results trend, report only).
        for (const [ai, ids] of [['', UHIDS], ['?ai=off', ['ICH-0044051', 'ICH-0044240', 'ICH-0044290', 'ICH-0043910']]]) {
          for (const id of ids) {
            await page.open(`/patient/${id}${ai}`, { fresh: first })
            first = false
            await page.until(`document.querySelectorAll('#record-panel section.rounded-sh-card').length >= 6`, 4000, `${id}${ai}: the overview`)
            const cards = await layout()
            expect(titles(cards) === CARDS, `${id}${ai}: ${titles(cards)}`)
            const xs = cards.map((c) => c.x).join(',')
            reference ??= xs
            expect(xs === reference, `${id}${ai}: the cards sit where they do for everyone (${xs} vs ${reference})`)
            expect(cards.every((c) => c.h >= 140), `${id}${ai}: no card collapsed: ${cards.map((c) => c.h)}`)
          }
        }
      },
    },
  ]
}
