import { expect, test } from '@playwright/test'

import { frontOfficePort } from '../playwright.config'

// Demo step 1 on the front office: every demo name is Synthea-style, with digits (D112), so the
// register form must take them. Nothing is submitted here. Fictional names only.

const DESK = `http://localhost:${frontOfficePort}`

test('the register form takes Synthea-style names with digits', async ({ page }) => {
  await page.goto(`${DESK}/register/new`)
  await page.locator('#reg-firstName').fill('Kaia401')
  await page.locator('#reg-middleName').fill('Rae12')
  await page.locator('#reg-lastName').fill('Lindgren118')
  await page.locator('#reg-lastName').blur()
  await expect(page.getByText(/Invalid (first|middle|last) name|Invalid Username/)).toHaveCount(0)
  // A name must still start with a letter.
  await page.locator('#reg-firstName').fill('401Kaia')
  await page.locator('#reg-firstName').blur()
  await expect(page.getByText('Invalid first name')).toBeVisible()
})
