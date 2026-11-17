import { expect, test } from '@playwright/test'

// Item 8 of the demo plan: with the API there is no billing service yet, so the front office's
// Payments page shows the shared "Work in progress" screen (#85, 16 Nov): what billing will do, no
// figures, no actions, and no billing read. Check-out keeps its own copay (e2e/deskCopay*.e2e.ts).

const DESK_URL = 'http://localhost:5192'

test('Payments is in the menu and says billing is work in progress, reading nothing', async ({ page }) => {
  const reads: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/')) reads.push(new URL(req.url()).pathname)
  })

  await page.goto(`${DESK_URL}/`)
  await page.getByRole('link', { name: /Payments/ }).first().click()
  await expect(page).toHaveURL(/\/billing$/)

  const screen = page.getByRole('region', { name: 'Work in progress' })
  await expect(screen).toContainText('This feature is work in progress')
  await expect(screen).toContainText('Billing will show charges, payments and balances for each visit.')
  await expect(screen.getByRole('button')).toHaveCount(0)
  await expect(page.getByText('Payment pending')).toHaveCount(0)

  expect(reads.filter((path) => /payment|bill|charge|ledger|claim/i.test(path))).toEqual([])
})
