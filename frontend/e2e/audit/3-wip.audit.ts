import { expect, test } from '@playwright/test'

import { as, screenOk } from './audit'

// Orders and referrals come after the demo (Thulasi; Vimal on #85, 18 Nov): in the doctors' portal
// their menu items and addresses must open the shared "Work in progress" screen, never an error,
// "No screen at this address" or a blank page. Synthetic data only.

for (const [name, path, heading] of [
  ['orders', '/clinician/orders/sets', 'Orders'],
  ['orders from a visit', '/clinician/encounter/00000000-0000-4000-8000-000000000000/orders/new', 'Orders'],
  ['referrals', '/clinician/referrals', 'Referrals'],
] as const) {
  test(`WIP: ${name} opens Work in progress`, async ({ page }) => {
    await as(page, 'doctor', path)
    await expect(page.getByRole('heading', { name: heading }).first(), `${name}: its heading`).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/This feature is work in progress/i), `${name}: Work in progress`).toBeVisible()
    await screenOk(page, `wip-${name.replace(/ /g, '-')}`)
  })
}

test('WIP: the doctor reaches Orders and Referrals from the menu', async ({ page }) => {
  await as(page, 'doctor', '/clinician/')
  // Both sit behind "More" on the rail (secondary items).
  const more = page.getByRole('button', { name: 'More' }).first()
  if (await more.isVisible()) await more.click()
  for (const label of ['Orders', 'Referrals']) {
    await expect(page.getByRole('link', { name: label }).first(), `${label} is on the menu`).toBeVisible({ timeout: 15_000 })
  }
  await page.getByRole('link', { name: 'Referrals' }).first().click()
  await expect(page.getByText(/This feature is work in progress/i)).toBeVisible({ timeout: 15_000 })
  await screenOk(page, 'wip-menu-referrals')
})
