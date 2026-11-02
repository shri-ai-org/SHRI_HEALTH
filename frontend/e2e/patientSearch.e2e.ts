import { randomInt, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

// Patient search against the real API (POST /patients/search, #78), as the development front-desk
// user. Synthetic patients only: each test registers its own, with a random surname and birth
// date, so no two runs, and no two tests, look like duplicates of each other.

/** Letters only, so the name passes the API's rules and reads like a surname. */
const surname = () =>
  `Testsearch${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
const birthDate = () => `19${randomInt(50, 99)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}`
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`

async function register(request: APIRequestContext, family: string, born: string): Promise<{ id: string; mrn: string }> {
  const res = await request.post('/api/v1/patients', {
    headers: { 'Idempotency-Key': randomUUID() },
    data: { name: { family, given: ['Ana'] }, birthDate: born },
  })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as { id: string; mrn: string }
}

test('finds a patient by last name and date of birth, with their MRN', async ({ page, request }) => {
  const family = surname()
  const born = birthDate()
  const patient = await register(request, family, born)

  await page.goto('/patients/search')
  await page.getByLabel('Last name').fill(family)
  await page.getByLabel('Date of birth').fill(usDate(born))
  await page.getByRole('button', { name: 'Search' }).click()

  const results = page.getByRole('table', { name: 'Search results: 1 patient' })
  await expect(results).toBeVisible()
  await expect(results.getByRole('row').filter({ hasText: family })).toContainText(patient.mrn)
})

test('finds a patient by MRN alone', async ({ page, request }) => {
  const family = surname()
  const patient = await register(request, family, birthDate())

  await page.goto('/patients/search')
  await page.getByLabel('MRN').fill(patient.mrn)
  await page.getByRole('button', { name: 'Search' }).click()

  await expect(page.getByRole('table', { name: 'Search results: 1 patient' }).getByRole('row').filter({ hasText: family })).toBeVisible()
})

test('says so when nobody matches', async ({ page }) => {
  await page.goto('/patients/search')
  await page.getByLabel('Last name').fill(surname())
  await page.getByLabel('Date of birth').fill(usDate(birthDate()))
  await page.getByRole('button', { name: 'Search' }).click()

  await expect(page.getByText('No patients found')).toBeVisible()
})

test('a name is a literal prefix: % and _ never list every patient (D65)', async ({ request }) => {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { family: '%%', given: '%' } } })
  expect(res.status()).toBe(200)
  expect(((await res.json()) as { items: unknown[] }).items).toEqual([])
})

test('the API refuses too few criteria with 422, as the screen checks first', async ({ page, request }) => {
  const res = await request.post('/api/v1/patients/search', { data: { criteria: { family: 'Te' } } })
  expect(res.status()).toBe(422)
  expect(((await res.json()) as { code: string }).code).toBe('business-rule-violation')

  await page.goto('/patients/search')
  await page.getByLabel('Last name').fill('Te')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByText('Check the search')).toBeVisible()
})
