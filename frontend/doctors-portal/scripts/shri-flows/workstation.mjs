/**
 * The imaging workstation (S-15-04): the reading tools draw real marks in the
 * frame's own pixels, calibrated where the series is; undo and redo; a key
 * image; the marks survive a reload and are audited; a report is drafted and
 * signed by a named reader, appended — an addendum on a reported study.
 * Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect, send, sleep, auditRows, toastSays }) => {
  /** A real mouse stroke across the viewport, from and to fractions of its box. */
  async function stroke(from, to) {
    const box = await page.evaluate(`(() => { const g = document.querySelector('[role="toolbar"] ~ [role="group"], [role="group"][aria-describedby$="-ws-help"]'); g.scrollIntoView({ block: 'center' }); const r = g.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
    const at = ([fx, fy]) => ({ x: box.x + fx * box.w, y: box.y + fy * box.h })
    const a = at(from)
    const b = at(to)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    await sleep(200)
  }
  const tool = (name) => page.click('[role="toolbar"][aria-label="Reading tools"] button', name)
  const marks = () => page.evaluate(`[...document.querySelectorAll('ul[aria-label="Marks on this study"] > li')].map((l) => l.textContent)`)

  return [
    {
      name: 'Imaging workstation (S-15-04): a calibrated length in mm, a text label, an ellipse ROI, undo and redo, a key image — kept after a reload, and audited',
      async run() {
        await page.open('/radiology/study/ST-4471/view')
        await page.until(`!!document.querySelector('[role="toolbar"][aria-label="Reading tools"]')`, 4000, 'the reading tools')
        expect((await page.text()).includes('0.706 mm/px'), 'the calibration is on the frame')

        await tool('Length')
        await stroke([0.3, 0.5], [0.7, 0.5])
        let m = await marks()
        expect(m.length === 1 && /Length · \d+\.\d mm/.test(m[0]), `a length in mm: ${m}`)

        await tool('Text label')
        await stroke([0.4, 0.6], [0.4, 0.6])
        await page.until(`!!document.querySelector('input[id$="-ws-text"]')`, 2000, 'the label field')
        await page.type('input[id$="-ws-text"]', 'RLZ shadowing')
        await page.click('form button[type="submit"]', 'Place')
        m = await marks()
        expect(m.length === 2 && m.some((t) => t.includes('“RLZ shadowing”')), `a text label: ${m}`)

        await page.click('[role="toolbar"] button', 'Undo')
        expect((await marks()).length === 1, 'undo takes the label back off')
        await page.click('[role="toolbar"] button', 'Redo')
        expect((await marks()).length === 2, 'redo puts it back')

        await tool('Ellipse ROI')
        await stroke([0.35, 0.4], [0.45, 0.48])
        m = await marks()
        expect(m.some((t) => /Ellipse ROI · \d+ mm² · mean \d+ \(display\)/.test(t)), `an ellipse with its area and mean: ${m}`)

        await page.click('[role="toolbar"] button', 'Mark as key image')
        expect((await page.text()).includes('★ key image'), 'the frame says it is a key image')

        const rows = await auditRows()
        expect(rows.filter((r) => r.event === 'IMAGING.ANNOTATION_ADDED' && r.subject === 'ST-4471').length === 3, `every mark drawn is on record — redo restores, it does not add: ${rows.filter((r) => r.event.startsWith('IMAGING.')).map((r) => r.event)}`)
        expect(rows.some((r) => r.event === 'IMAGING.KEY_IMAGE' && r.detail.includes('marked as a key image')), 'the key image is on record')

        await page.reload()
        await page.until(`document.querySelectorAll('ul[aria-label="Marks on this study"] > li').length === 3`, 4000, 'the marks after a reload')
        await page.click('[role="toolbar"] button', 'Eraser')
        await page.click('ul[aria-label="Marks on this study"] button[aria-label^="Delete the length"]')
        expect((await marks()).length === 2, 'a mark is deleted from the list')
        expect((await auditRows()).some((r) => r.event === 'IMAGING.ANNOTATION_DELETED'), 'and the delete is on record')
      },
    },
    {
      name: 'Imaging workstation (S-15-04): an addendum on a reported study and a report on an unreported one — signed by name, appended, audited; the head CT keeps its AI read',
      async run() {
        await page.open('/radiology/study/ST-4471/view')
        await page.click('[role="tablist"][aria-label="Study panel"] [role="tab"], [aria-label="Study panel"] button', 'Report')
        expect((await page.text()).includes('Add an addendum'), 'a reported study takes an addendum, not a new report')
        await page.type('textarea[id$="-impression"]', 'Compared with the admission film: no new consolidation.')
        await page.click('button', 'Sign addendum')
        await toastSays('Addendum signed', 'ST-4471')
        expect(/addendum · signed/i.test(await page.text()) && (await page.text()).includes('no new consolidation'), 'the addendum shows, signed')
        expect((await auditRows()).some((r) => r.event === 'IMAGING.ADDENDUM_SIGNED' && r.subject === 'ST-4471'), 'on record')

        await page.open('/radiology/study/ST-9921/view', { fresh: false })
        const t = await page.text()
        expect(t.includes('Intracranial haemorrhage — POSITIVE') && t.includes('Study panel'), 'the head CT keeps its AI read beside the new panel')
        await page.click('[aria-label="Study panel"] button', 'Report')
        expect((await page.text()).includes('Write the report'), 'an unreported study takes a report')
        await page.type('textarea[id$="-findings"]', 'Right basal ganglia haematoma with intraventricular extension.')
        await page.type('textarea[id$="-impression"]', 'Acute right basal ganglia haemorrhage with IVH.')
        await page.click('button', 'Save draft')
        await toastSays('Draft saved')
        await page.click('button', 'Sign report')
        await toastSays('Report signed', 'ST-9921')
        expect((await auditRows()).some((r) => r.event === 'IMAGING.REPORT_SIGNED' && r.subject === 'ST-9921'), 'the report is on record')
      },
    },
  ]
}
