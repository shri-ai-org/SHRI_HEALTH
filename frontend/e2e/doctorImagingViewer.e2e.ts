import { expect, request as apiRequest, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// Item 6 of the demo plan (#386): an imaging report with illustrative images has "View image" on
// the record's Imaging reports tab, which opens the study viewer with the image (read through the
// one-time download link to our own API, D105), labelled "Illustrative image" with its
// caption, the report beside it, and no marking tools or notice about them. The doctors' portal as the development
// physician (md), on the seeded history patients. Skips until some report has images (Anand's #387).

const DOCTORS = `http://localhost:${doctorsPort}`
const SEEDED = ['Linda Thompson', 'James Wilson', 'Patricia Davis', 'Maria Gonzalez', 'Robert Miller']

interface Report {
  id: string
  images?: { id: string; caption: string }[]
}

async function seeded(request: APIRequestContext, name: string): Promise<string | undefined> {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { query: name } } })
  if (res.status() !== 200) return undefined
  return ((await res.json()) as { items: { id: string }[] }).items[0]?.id
}

/** The first seeded patient's report that has images, read as the doctor. */
async function reportWithImages(request: APIRequestContext): Promise<{ patientId: string; report: Report } | undefined> {
  const doctor = await apiRequest.newContext({ baseURL: DOCTORS })
  try {
    for (const name of SEEDED) {
      const patientId = await seeded(request, name)
      if (!patientId) continue
      const res = await doctor.get(`/api/v1/patients/${patientId}/imaging-reports?limit=100`)
      if (res.status() !== 200) continue
      const report = ((await res.json()) as { items: Report[] }).items.find((r) => (r.images ?? []).length > 0)
      if (report) return { patientId, report }
    }
    return undefined
  } finally {
    await doctor.dispose()
  }
}

test('View image opens the illustrative image beside the report, read through the download route', async ({ page, request }) => {
  const found = await reportWithImages(request)
  test.skip(!found, "No imaging report has images in this database yet (Anand's seeded images, PR 387)")
  const { patientId, report } = found!

  await page.goto(`${DOCTORS}/patient/${patientId}/reports`)
  const row = page.getByRole('list', { name: 'Imaging reports' }).getByRole('listitem').filter({ has: page.getByRole('button', { name: 'View image' }) }).first()
  await row.getByRole('button', { name: 'View image' }).click()
  await expect(page).toHaveURL(new RegExp(`/radiology/study/${report.id}/view\\?patient=${patientId}$`))

  const img = page.getByRole('img', { name: `Illustrative image: ${report.images![0].caption}` })
  await expect(img).toBeVisible({ timeout: 30_000 })
  await expect(img).toHaveAttribute('src', /^\/api\/v1\/files\/[0-9a-f-]+\/content\?token=/)
  // The marking tools are hidden for the demo, with no notice about them (Vimal).
  await expect(page.getByText(/Markings/)).toHaveCount(0)
  await expect(page.getByRole('toolbar', { name: 'Reading tools' }).getByRole('button', { name: /Length|Arrow|Pen/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible()
})
