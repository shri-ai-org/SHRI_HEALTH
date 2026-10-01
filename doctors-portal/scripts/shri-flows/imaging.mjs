/**
 * Imaging flows: the NCCT viewer wherever it is drawn — the record's Report
 * viewer (S-06-11), the imaging study (S-15-04), the worklist (S-15-01), the
 * escalation (S-15-06) and the Stroke-AI Console (S-18-21). Loaded by
 * scripts/shri-flows.mjs.
 */

export default ({ page, expect, auditRows, sentItems, toastSays, pick }) => {
  /** The viewer's state, read from its own controls and marks. */
  const viewer = (root = 'main') =>
    page.evaluate(`(() => {
      const r = document.querySelector(${JSON.stringify(root)})
      const frame = r.querySelector('[role="group"][aria-label^="Non-contrast CT head"]')
      const img = frame?.querySelector('img')
      const ellipse = frame?.querySelector('svg[data-ncct-overlay] ellipse')
      return {
        label: frame?.getAttribute('aria-label') ?? '',
        src: img?.getAttribute('src') ?? '',
        marks: frame ? frame.querySelectorAll('[data-ncct-overlay]').length : 0,
        ellipse: ellipse ? ellipse.getBoundingClientRect().toJSON() : null,
        frame: frame ? frame.getBoundingClientRect().toJSON() : null,
        text: r.textContent,
      }
    })()`)

  return [
    {
      name: 'Record CT (S-06-11): the Report viewer scrolls every slice, the AI marks sit on their slices and zoom with the image, the switch lifts them off, and AI insights says what the scan shows',
      async run() {
        await page.open('/patient/ITP-0021934')
        let v = await viewer()
        expect(v.label === 'Non-contrast CT head, slice 7 of 28' && v.src.endsWith('/ncct/0142/slice-07.png'), `opens on the middle of the first finding: ${v.label} ${v.src}`)
        expect(v.marks === 2 && v.text.includes('RIGHT BASAL GANGLIA HAEMORRHAGE'), 'the AI mark and its label are drawn on the slice')
        expect(v.text.includes('HAEMORRHAGIC STROKE') && v.text.includes('Scan') && v.text.includes('NCCT head 21-Sep-2026 —'), 'the verdict under the image, and the Scan row on AI insights')

        // Every slice is reachable — the buttons stop at the ends.
        for (let n = 0; n < 30; n++) await page.click('button[aria-label="Previous slice"]').catch(() => {})
        v = await viewer()
        expect(v.label.includes('slice 1 of 28') && (await page.evaluate(`document.querySelector('button[aria-label="Previous slice"]').disabled`)), `slice 1, and Previous stops there: ${v.label}`)
        // The wheel steps the stack, not the page.
        const before = await page.evaluate('scrollY')
        await page.evaluate(`(() => { const f = document.querySelector('[role="group"][aria-label^="Non-contrast CT head"]'); for (let i = 0; i < 27; i++) f.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })); return true })()`)
        v = await viewer()
        expect(v.label.includes('slice 28 of 28') && (await page.evaluate('scrollY')) === before, `the wheel reaches slice 28 and the page stays put: ${v.label}`)
        expect(v.marks === 0, 'no mark on a slice the finding is not on')
        // Arrow keys while the frame has focus.
        await page.evaluate(`document.querySelector('[role="group"][aria-label^="Non-contrast CT head"]').focus()`)
        for (let n = 0; n < 17; n++) await page.key('ArrowDown')
        v = await viewer()
        // One <svg> for the ellipses plus one label per finding: both findings reach slice 11.
        expect(v.label.includes('slice 11 of 28') && v.marks === 3, `arrow keys step back to slice 11, where both findings are marked: ${v.label}, ${v.marks}`)

        // The mark zooms with the image: its centre stays at the same fraction of the frame.
        const centre = (x) => ({ x: (x.ellipse.x + x.ellipse.width / 2 - x.frame.x) / x.frame.width, y: (x.ellipse.y + x.ellipse.height / 2 - x.frame.y) / x.frame.height })
        const at1 = centre(v)
        await page.click('button[aria-label="Zoom"]')
        await page.until(`document.querySelector('button[aria-label="Zoom 150%"]')`, 2000, 'zoomed to 150%')
        await new Promise((r) => setTimeout(r, 250))
        const z = await viewer()
        const at15 = centre(z)
        expect(z.ellipse.width > v.ellipse.width * 1.4, `the mark grows with the image: ${v.ellipse.width} → ${z.ellipse.width}`)
        expect(Math.abs(at15.x - (0.5 + (at1.x - 0.5) * 1.5)) < 0.02 && Math.abs(at15.y - (0.5 + (at1.y - 0.5) * 1.5)) < 0.02, `and stays on what it marks: ${JSON.stringify(at1)} → ${JSON.stringify(at15)}`)

        await page.click('button[aria-pressed]', 'AI overlay on')
        expect((await viewer()).marks === 0 && (await page.text()).includes('Show the overlay'), 'the switch lifts the marks off the image')

        await page.open('/patient/ITP-0021934?ai=off', { fresh: false })
        v = await viewer()
        expect(v.marks === 0 && !(await page.evaluate(`!!document.querySelector('button[aria-pressed]')`)), 'AI off: no marks and no switch — the image, unmarked')
      },
    },
    {
      name: 'Record CT (S-06-11): a negative scan is scrollable with nothing marked; a patient with no CT keeps the document report',
      async run() {
        await page.open('/patient/ICH-0044051')
        const v = await viewer()
        expect(v.label === 'Non-contrast CT head, slice 14 of 28' && v.marks === 0 && v.text.includes('NO ACUTE STROKE ON THIS SCAN'), `R. Lakshmanan's negative CT, unmarked: ${v.label}`)
        await page.click('button[aria-label="Next slice"]')
        expect((await viewer()).label.includes('slice 15 of 28'), 'and scrollable')
      },
    },
    {
      name: 'Imaging worklist (S-15-01): every study, AI-flagged first with newest-first a choice away; the filter in the address; a row opens its study; AI off, no flags',
      async run() {
        await page.open('/radiology/worklist')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-15-01"]')`), 'S-15-01 is drawn')
        const text = await page.text()
        expect(/\d+ studies · \d+ flagged by AI · \d+ awaiting a report/.test(text), `the counts: ${text.slice(0, 300)}`)
        const first = await page.evaluate(`document.querySelector('ul[aria-label="Imaging studies on the record"] li button').getAttribute('aria-label')`)
        expect(first.startsWith('Santhosh Babu') || first.includes('ST-9921') || first.includes('ST-9640') || first.includes('ST-9871'), `a flagged bleed leads: ${first}`)
        await page.click('[role="tab"]', 'Awaiting report')
        await page.until(`location.search === '?scope=awaiting'`, 2000, 'the filter is in the address')
        await page.click('ul[aria-label="Imaging studies on the record"] li button', 'ST-9921')
        await page.until(`location.pathname === '/radiology/study/ST-9921/view'`, 3000, 'the row opens its study')
        await page.open('/radiology/worklist?ai=off', { fresh: false })
        const off = await page.text()
        expect(!off.includes('flagged by AI') && !off.includes('AI-flagged') && off.includes('AI ranking is off'), 'AI off: no flags, newest first, said')
      },
    },
    {
      name: 'Imaging study (S-15-04): the critical finding asks for a named clinician and the escalation is on record and sent; the G3 read is attested only when accepted; the reading note is saved; questions come back with citations',
      async run() {
        await page.open('/radiology/study/ST-9921/view')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-15-04"]')`), 'S-15-04 is drawn')
        let text = await page.text()
        for (const t of ['ST-9921 · NCCT head · 28 of 272 slices', 'brain window W 80 / L 40', 'Intracranial haemorrhage — POSITIVE', 'HAEMORRHAGIC STROKE', 'Clinical report'])
          expect(text.includes(t), `the study says "${t}"`)
        expect((await viewer()).marks > 0, 'the AI marks are on the scan')

        // Original beside overlay: one slice for both panes.
        await page.click('button', 'Original beside overlay')
        await page.evaluate(`document.querySelectorAll('button[aria-label="Next slice"]')[0].click()`)
        await new Promise((r) => setTimeout(r, 150))
        const labels = await page.evaluate(`[...document.querySelectorAll('[role="group"][aria-label^="Non-contrast CT head"]')].map((f) => f.getAttribute('aria-label'))`)
        expect(labels.length === 2 && labels[0] === labels[1] && labels[0].includes('slice 8 of 28'), `the two panes move together: ${labels}`)
        const marks = await page.evaluate(`[...document.querySelectorAll('[role="group"][aria-label^="Non-contrast CT head"]')].map((f) => f.querySelectorAll('[data-ncct-overlay]').length)`)
        expect(marks[0] === 0 && marks[1] > 0, `the original is unmarked, the other marked: ${marks}`)

        await page.click('button', 'Escalate')
        await page.until(`document.querySelector('[role="alertdialog"]')?.textContent.includes('Escalate a critical finding')`, 3000, 'the escalation')
        await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === 'Record the escalation').click()`)
        expect((await page.evaluate(`document.querySelector('[role="alertdialog"]').textContent`)).includes('Say what you told them'), 'what was said is required')
        await pick('#esc-recipient', 'Dr. Rajsrinivas')
        await page.type('[id="escalation-detail-ST-9921"]', 'Right basal ganglia bleed with IVH, INR 3.8 — reversal and BP control now.')
        await page.click('[role="alertdialog"] [role="checkbox"]', 'I have communicated this finding')
        await page.evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === 'Record the escalation').click()`)
        await toastSays('Escalated to Dr. Rajsrinivas', 'Recorded against study ST-9921 and the patient record.')
        const esc = (await auditRows()).find((r) => r.event === 'IMAGING.CRITICAL_ESCALATED')
        expect(esc && esc.subject === 'SD-P-14' && esc.detail.includes('told Dr. Rajsrinivas'), `on record: ${JSON.stringify(esc)}`)
        expect((await sentItems()).some((n) => n.recipient === 'colleague' && n.title === 'Critical finding — Santhosh Babu'), 'sent to the clinician told')

        // G3: Accept waits for the fixed checkbox; attested only once accepted.
        expect(await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Accept').disabled`), 'Accept waits for "I have reviewed this content"')
        await page.click('[role="checkbox"]', 'I have reviewed this content')
        await page.click('[role="group"][aria-label^="Disposition"] button', 'Accept')
        text = await page.text()
        expect(text.includes('Attested') && text.includes('It is now part of the report.'), 'attested once accepted')
        expect(!text.includes('Intracranial haemorrhage — POSITIVE\nFlagged'), 'the alert goes once the read is decided')

        await page.type('[id="imaging-note-ST-9921"]', 'Agree with the AI read. Bleed extends into the ventricles.')
        await page.click('button', 'Save note')
        await toastSays('Reading note saved', 'Santhosh Babu · ST-9921')
        expect((await auditRows()).some((r) => r.event === 'IMAGING.NOTE_SAVED' && r.subject === 'SD-P-14'), 'the note is on record')

        const prompt = await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.closest('ul') && b.textContent.trim().endsWith('?'))?.textContent.trim() ?? ''`)
        if (prompt) {
          await page.click('button', prompt)
          await page.until(`document.querySelector('ol[aria-label="Answers"]')`, 3000, 'an answer')
          expect((await page.evaluate(`document.querySelector('ol[aria-label="Answers"]').textContent`)).includes('[1]'), 'the answer carries its citations')
        }
      },
    },
    {
      name: 'Imaging study (S-15-04): a rejected read is never shown as attested; an unknown study says so; a report-only study shows its report',
      async run() {
        await page.open('/radiology/study/ST-9921/view')
        await page.click('[role="group"][aria-label^="Disposition"] button', 'Reject')
        await page.until(`document.querySelector('[role="dialog"]')?.textContent.includes('Reject this suggestion')`, 3000, 'reject asks for a reason')
        await page.click('[role="dialog"] button', 'Record rejection')
        await toastSays('Rejection recorded')
        await page.until(`document.body.textContent.includes('AI read rejected') && document.body.textContent.includes('The read does not enter the report.')`, 3000, 'a rejection says so')
        expect(!(await page.text()).includes('Attested'), 'and is never "Attested"')
        await page.open('/radiology/study/ST-0000/view', { fresh: false })
        expect((await page.text()).includes('No study at this address.'), 'an unknown study says so, and opens nobody’s scan')
        await page.open('/radiology/study/ST-9905/view', { fresh: false })
        const t = await page.text()
        expect(t.includes('report only') && t.includes('Images for this study are not in this demo'), 'a report-only study shows its report')
        // An open-dataset image: the frame loads, its source is credited under it, and no model reads it.
        await page.open('/radiology/study/ST-4471/view', { fresh: false })
        await page.until(`[...document.querySelectorAll('img')].some((i) => i.src.includes('/imaging/xr-0301/frame-01.png') && i.naturalWidth > 0)`, 5000, 'the X-ray frame loads')
        const x = await page.text()
        expect(x.includes('Image: TCIA COVID-19-AR') && x.includes('CC BY 4.0'), 'the image is credited')
        expect(x.includes('No model reads X-rays here'), 'and no AI read is claimed')
      },
    },
    {
      name: 'Stroke-AI Console (S-18-21): a named case opens from the address; its scan opens on its own finding when the case changes; the read is G3; AI off says what stands in',
      async run() {
        await page.open('/stroke/ai-console?case=0142')
        expect(await page.evaluate(`!!document.querySelector('[data-screen-id="S-18-21"]')`), 'S-18-21 is drawn')
        let text = await page.text()
        expect(text.includes('5 imaged cases · 2 active') && text.includes('HAEMORRHAGIC STROKE') && text.includes('P1 · IMMEDIATE') && text.includes('radiologist agrees'), 'the case, its verdict and findings')
        let v = await viewer()
        expect(v.label.includes('slice 7 of 28') && v.marks > 0, `0142 opens on its finding: ${v.label}`)
        for (let n = 0; n < 5; n++) await page.click('button[aria-label="Next slice"]')
        await page.click('ul[aria-label="Imaged stroke cases"] button', 'Kumar Subramanian')
        await page.until(`location.search === '?case=0137'`, 2000, 'the case is in the address')
        v = await viewer()
        expect(v.label.includes('slice 13 of 28') && v.marks > 0, `a new case opens on its own finding, not the last slice: ${v.label}`)
        await page.click('button', 'Patient record')
        await page.until(`location.pathname === '/patient/ICH-0044275'`, 3000, 'the patient record')
        await page.open('/stroke/ai-console?case=0141&ai=off', { fresh: false })
        text = await page.text()
        expect(text.includes('Automated reading is off.') && (await viewer()).marks === 0, 'AI off: the scan unmarked, the worklist route said')
      },
    },
  ]
}
