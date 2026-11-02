import { randomInt } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

// Patient registration against the real API (POST /patients, #78), as the development front-desk
// user. Synthetic patients only, each with a random surname and birth date, so runs never collide.

const surname = () =>
  `Testreg${Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`
const usBirthDate = () => `0${randomInt(1, 9)}/1${randomInt(0, 9)}/19${randomInt(50, 99)}`

async function fillPatient(page: Page, family: string, born: string) {
  await page.goto('/patients/new')
  await page.getByLabel('First name').fill('Ana')
  await page.getByLabel('Last name').fill(family)
  await page.getByLabel('Date of birth').fill(born)
}

test('registers a patient, shows the new MRN and opens the chart', async ({ page }) => {
  const family = surname()
  await fillPatient(page, family, usBirthDate())
  await page.getByRole('button', { name: 'Register patient' }).click()

  await expect(page.getByText(/^Patient registered\. MRN \S+$/)).toBeVisible()
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: `Ana ${family}` })).toBeVisible()
})

test('warns about a possible duplicate (409), and registers anyway only with a reason', async ({ page }) => {
  const family = surname()
  const born = usBirthDate()
  await fillPatient(page, family, born)
  await page.getByRole('button', { name: 'Register patient' }).click()
  await expect(page.getByText(/^Patient registered\. MRN /)).toBeVisible()

  // The same person again: the API answers 409 possible-duplicate.
  await fillPatient(page, family, born)
  await page.getByRole('button', { name: 'Register patient' }).click()
  await expect(page.getByText('This patient may already be registered')).toBeVisible()

  await page.getByRole('button', { name: 'Register anyway' }).click()
  await expect(page.getByText('Explain why this is a different patient.')).toBeVisible()

  await page.getByLabel(/Reason to register anyway/).fill('Twins with the same name')
  await page.getByRole('button', { name: 'Register anyway' }).click()
  await expect(page.getByText(/^Patient registered\. MRN /)).toBeVisible()
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/)
})

test('shows the API’s 422 for a birth date in the future on its field', async ({ page }) => {
  await fillPatient(page, surname(), `01/01/${new Date().getFullYear() + 1}`)
  await page.getByRole('button', { name: 'Register patient' }).click()

  await expect(page.getByText('Check this field.')).toBeVisible()
  await expect(page).toHaveURL(/\/patients\/new$/)
})
