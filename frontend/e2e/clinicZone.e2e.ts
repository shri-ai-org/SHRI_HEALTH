import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

import { doctorsPort, frontOfficePort } from '../playwright.config'

// The screens show the clinic's date and time (D40), not the browser's: the browser here runs in
// India, and the expected values are computed in the facility's own time zone, read from the API
// (GET /api/v1/booking/facilities), never from a constant. Run at any hour: when the clinic's day
// and India's differ (midnight to 13:30 IST, in San Jose's winter), the date shows it too.
// Synthetic data only.

test.use({ timezoneId: 'Asia/Kolkata' })

const DESK = `http://localhost:${frontOfficePort}`
const DOCTORS = `http://localhost:${doctorsPort}`

interface Facility {
  id: string
  timeZone: string
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as T
}

/** The signed-in user's facility, as the screens choose it: the first of theirs in the booking list. */
async function userFacility(api: APIRequestContext): Promise<Facility> {
  const me = await api.get('/api/v1/me')
  const mine = me.status() === 200 ? ((await me.json()) as { user: { facilityIds: string[] } }).user.facilityIds : []
  const facilities = (await ok<{ items: Facility[] }>(await api.get('/api/v1/booking/facilities'))).items
  const facility = facilities.find((f) => mine.includes(f.id)) ?? facilities[0]
  expect(facility, 'the user has a bookable facility').toBeTruthy()
  return facility!
}

/** What `fmt` gives for now and for a minute on, in the zone: a clock may turn the minute while checked. */
function nowAndNext(fmt: (at: Date) => string): string[] {
  const now = Date.now()
  return [...new Set([fmt(new Date(now)), fmt(new Date(now + 60_000))])]
}

test('the browser runs in India for these checks', async ({ page }) => {
  await page.goto(`${DESK}/`)
  // India: UTC+5:30 (Chrome names the zone Asia/Calcutta).
  expect(await page.evaluate(() => [Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset()])).toEqual([expect.stringMatching(/^Asia\/(Kolkata|Calcutta)$/), -330])
})

test("the front office's clock shows the clinic's time and day", async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: DESK })
  const { timeZone } = await userFacility(api)
  await api.dispose()
  await page.goto(`${DESK}/`)
  const clock = page.locator('header time').first()
  await expect(clock).toBeVisible({ timeout: 30_000 })
  // LiveClock: "9:05 AM, Fri 13 Nov" in the clinic's zone.
  const label = (at: Date) => {
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone, ...o }).format(at)
    const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at)
    return `${time}, ${part({ weekday: 'short' })} ${part({ day: 'numeric' })} ${part({ month: 'short' })}`
  }
  await expect.poll(async () => nowAndNext(label).includes((await clock.getAttribute('aria-label')) ?? ''), {
    message: `the clock reads ${timeZone}'s time`,
  }).toBe(true)
})

test("the doctors' portal greets by the clinic's hour and shows the clinic's date", async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: DOCTORS })
  const { timeZone } = await userFacility(api)
  await api.dispose()
  await page.goto(`${DOCTORS}/`)
  const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: /^Good (morning|afternoon|evening), / })
  await expect(heading).toBeVisible({ timeout: 30_000 })
  const greeting = (at: Date) => {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at))
    return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  }
  const shown = ((await heading.textContent()) ?? '').split(',')[0]
  expect(nowAndNext(greeting), `the greeting follows ${timeZone}'s hour`).toContain(shown)
  const day = (at: Date) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(at)
  const days = nowAndNext(day)
  await expect(page.getByText(new RegExp(days.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))).first()).toBeVisible()
})
