/**
 * The record overview's Report viewer: a switcher across every report the
 * patient has, a study of several images that scrolls like a CT, a single
 * image that says so, and "Open in Imaging" landing on the same study and
 * image. Loaded by scripts/shri-flows.mjs.
 */

export default ({ page, expect }) => {
  const card = `[...document.querySelectorAll('#record-panel section.rounded-sh-card')].find((c) => c.querySelector('h2')?.textContent.trim() === 'Report viewer')`
  const pills = () => page.evaluate(`[...${card}.querySelectorAll('[role="tablist"][aria-label="Which report"] [role="tab"]')].map((t) => t.textContent.trim())`)
  const tile = () =>
    page.evaluate(`(() => {
      const c = ${card}
      const g = c.querySelector('[role="group"]')
      return { label: g?.getAttribute('aria-label') ?? '', img: c.querySelector('img')?.getAttribute('src') ?? '', text: c.textContent }
    })()`)
  const pick = (text) => page.evaluate(`[...${card}.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(text)}).click()`)

  return [
    {
      name: 'Report viewer (S-06-11): one switcher across the CT, the X-ray and the ECG; each opens in its own frame, and Open in Imaging lands on the chosen study',
      async run() {
        await page.open('/patient/ICH-0044051')
        await page.until(`!!${card}?.querySelector('[role="tablist"]')`, 4000, 'the switcher')
        const ps = await pills()
        expect(ps.join('|') === 'CT · 21-Sep|ECG · 21-Sep|X-ray · 19-Sep', `every report, newest first: ${ps}`)
        expect((await tile()).label.startsWith('Non-contrast CT head'), 'opens on the newest study with images, the CT')
        await pick('X-ray · 19-Sep')
        await page.until(`${card}.querySelector('img')?.getAttribute('src')?.includes('/imaging/xr-0301/')`, 3000, 'the X-ray on the tile')
        expect((await tile()).text.includes('1 image') && (await tile()).text.includes('right lower zone'), 'a single image says so, with its report')
        await pick('ECG · 21-Sep')
        expect((await tile()).text.includes('ECG — no images with this report'), 'a document keeps the frame and says what it is')
        await pick('X-ray · 19-Sep')
        await page.click('button', 'Open in Imaging')
        await page.until(`location.pathname === '/radiology/study/ST-4471/view'`, 3000, 'the X-ray opens in Imaging')
      },
    },
    {
      name: 'Report viewer (S-06-11): a study of two images scrolls like a stack — wheel, slider and ‹ › — and Imaging opens on the image that was showing',
      async run() {
        await page.open('/patient/ICH-0044208')
        await page.until(`!!${card}?.querySelector('[role="group"]')`, 4000, 'the viewer')
        let t = await tile()
        expect(t.label.includes('image 1 of 2') && t.label.includes('Sweep 1'), `the growth scan's first sweep: ${t.label}`)
        await page.evaluate(`${card}.querySelector('button[aria-label="Next image"]').click()`)
        await page.until(`${card}.querySelector('[role="group"]').getAttribute('aria-label').includes('image 2 of 2')`, 3000, 'the next image')
        t = await tile()
        expect(t.label.includes('Sweep 2 · HC 298.6 mm'), `each image named for what it is: ${t.label}`)
        await page.evaluate(`${card}.querySelector('[role="group"]').dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))`)
        await page.until(`${card}.querySelector('[role="group"]').getAttribute('aria-label').includes('image 1 of 2')`, 3000, 'the wheel steps back')
        await page.evaluate(`${card}.querySelector('button[aria-label="Next image"]').click()`)
        await page.click('button', 'Open in Imaging')
        await page.until(`location.pathname === '/radiology/study/ST-9790/view' && location.search === '?frame=2'`, 3000, 'Imaging opens at image 2')
        await page.until(`[...document.querySelectorAll('[role="group"]')].some((g) => (g.getAttribute('aria-label') ?? '').includes('image 2 of 2'))`, 3000, 'on image 2')
      },
    },
  ]
}
