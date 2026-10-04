/**
 * The record overview's fixed layout: every card on every record, in the same
 * place, whatever the patient has — so the page never reflows between
 * patients. Loaded by scripts/shri-flows.mjs.
 */

const UHIDS = [
  'ICH-0044120', 'ICH-0041882', 'ICH-0044051', 'ICH-0044208', 'IPL-0012774', 'ICH-0044191', 'ICH-0043910', 'ICH-0042330',
  'ICH-0044240', 'ICH-0044262', 'ICH-0044275', 'ICH-0044281', 'ITP-0021934', 'ICH-0044290', 'ICH-0044297',
]
const CARDS = 'Report viewer|Vitals|AI insights|Test results|Notes|Trend|Patient report'

export default ({ page, expect, toastSays, auditRows }) => {
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
      name: 'Record layout (S-06-11): the same seven cards in the same places for all fifteen patients, and with the AI off — none collapsed',
      async run() {
        let reference
        let first = true
        // Every patient with the AI on; with it off, one of each shape (full, no imaging, no results trend, report only).
        for (const [ai, ids] of [['', UHIDS], ['?ai=off', ['ICH-0044051', 'ICH-0044240', 'ICH-0044290', 'ICH-0043910']]]) {
          for (const id of ids) {
            await page.open(`/patient/${id}${ai}`, { fresh: first })
            first = false
            await page.until(`document.querySelectorAll('#record-panel section.rounded-sh-card').length >= 7`, 4000, `${id}${ai}: the overview`)
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
    {
      name: 'Record overview: a note typed on the Notes card is a draft — edited before signing (audited), then signed, after which it cannot be edited',
      async run() {
        const card = `document.querySelector('section[aria-label="Notes on Lakshmi Narayanan"]')`
        await page.open('/patient/ICH-0044290')
        await page.until(`!!${card}`, 4000, 'the Notes card')
        expect((await page.evaluate(`${card}.textContent`)).includes('No notes yet'), 'no notes yet, said so')
        await page.click('button[aria-label="Type a note on Lakshmi Narayanan"]')
        await page.until(`document.querySelector('#dictation-draft')`, 3000, 'the note box')
        await page.type('#dictation-draft', 'Headache diary reviewed: two attacks this month')
        await page.click('[role="dialog"] button', 'Save')
        await toastSays('Note saved as a draft', 'Lakshmi Narayanan · not signed')
        await page.until(`${card}.textContent.includes('Headache diary reviewed: two attacks this month') && ${card}.textContent.includes('Draft · not signed')`, 3000, 'the draft on the card')

        await page.click('section[aria-label="Notes on Lakshmi Narayanan"] button[aria-label="Edit this draft"]')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Edit note') && document.querySelector('#dictation-draft')?.value === 'Headache diary reviewed: two attacks this month'`, 3000, 'the draft reopens with its words')
        await page.evaluate(`(() => { const el = document.querySelector('#dictation-draft'); el.focus(); el.setSelectionRange(el.value.length, el.value.length) })()`)
        await page.type('#dictation-draft', '; continue propranolol 40 mg')
        await page.click('[role="dialog"] button', 'Save')
        await toastSays('Draft updated', 'Lakshmi Narayanan · not signed')
        await page.until(`${card}.textContent.includes('two attacks this month; continue propranolol 40 mg') && ${card}.textContent.includes('edited')`, 3000, 'the edit is on the card, marked')
        expect((await page.evaluate(`${card}.querySelectorAll('li').length`)) === 1, 'edited in place, not a second note')
        expect((await auditRows()).some((r) => r.event === 'NOTE.DRAFT_EDITED' && r.subject === 'SD-P-15'), 'the edit is on the audit trail')

        await page.click('section[aria-label="Notes on Lakshmi Narayanan"] button', 'Sign')
        await toastSays('Note signed', 'Lakshmi Narayanan · now part of the record')
        await page.until(`!${card}.querySelector('button[aria-label="Edit this draft"]') && ${card}.textContent.includes('Signed')`, 3000, 'signed: no edit any more')
      },
    },
  ]
}
