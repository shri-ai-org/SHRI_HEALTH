import { expect, test } from '@playwright/test'

import { doctorsPort } from '../playwright.config'

// Refill requests in the doctors' portal (#415's API), as the development physician on the real
// API with VITE_FEATURE_REFILL_REQUESTS=on. Skips without the real API or without #415's
// listRefillRequests, and the decline step without an open request on an open chart. Declining
// changes data (the request is answered), so it runs only on a local or test stack. Synthetic
// patients only.

const DOCTORS = `http://localhost:${doctorsPort}`

test.beforeEach(async ({ request }) => {
  const probe = await request.get(`${DOCTORS}/api/v1/e2e-probe`).catch(() => null)
  test.skip(!probe || !(probe.headers()['content-type'] ?? '').includes('application/problem+json'), 'needs the real API')
  const list = await request.get(`${DOCTORS}/api/v1/refill-requests?status=requested&limit=1`)
  test.skip(list.status() !== 200, 'needs listRefillRequests (PR 415) on the API')
})

test('lists the open refill requests and declines one with a fixed reason', async ({ page, request }) => {
  const res = await request.get(`${DOCTORS}/api/v1/refill-requests?status=requested&limit=100`)
  const items = ((await res.json()) as { items: { id: string; restricted: boolean; display?: string }[] }).items
  await page.goto(`${DOCTORS}/refills`)
  await expect(page.getByRole('heading', { name: 'Refill requests' })).toBeVisible()
  const open = items.find((i) => !i.restricted && i.display)
  if (!open) {
    await expect(page.getByText(items.length === 0 ? 'No refill requests are waiting.' : 'Restricted chart').first()).toBeVisible()
    test.skip(true, 'no open request on an open chart to decline')
    return
  }
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  await page.getByRole('button', { name: `Decline the refill of ${open.display}`, exact: false }).first().click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Decline' }).click()
  await expect(dialog.getByText('Choose a reason.')).toBeVisible()
  await dialog.getByLabel(/Reason/).selectOption('contact-the-office')
  await dialog.getByRole('button', { name: 'Decline' }).click()
  await expect(page.getByText(/Declined\./)).toBeVisible()
  // Opaque IDs only in the addresses: no drug, name or reason in a URL.
  expect(urls.filter((u) => u.includes('contact-the-office') || (open.display && u.includes(encodeURIComponent(open.display))))).toEqual([])
  expect(page.url()).toBe(`${DOCTORS}/refills`)
})
