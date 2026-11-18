import { chromium, type FullConfig } from '@playwright/test'

// Each demo account signs in once through Keycloak; the audit's tests reuse its session cookies.
// The one-time code is skipped on the demo stack (SHRI_DEMO_SKIP_AUTH_CODE). Synthetic accounts only.
export const ACCOUNTS = {
  frontdesk: { start: '/', username: 'demo.frontdesk' },
  ma: { start: '/', username: 'demo.ma' },
  doctor: { start: '/clinician/', username: 'demo.doctor' },
  admin: { start: '/', username: 'demo.admin' },
  linda: { start: '/portal/', username: 'linda.thompson@example.com' },
} as const
export type Account = keyof typeof ACCOUNTS
export const stateFile = (who: Account) => `audit-results/.auth/${who}.json`

export default async function signIn(config: FullConfig): Promise<void> {
  const password = process.env.DEMO_PASSWORD
  if (!password) throw new Error("Set DEMO_PASSWORD (the run's own, from deploy.sh init-env)")
  const { baseURL, ignoreHTTPSErrors } = config.projects[0].use
  const browser = await chromium.launch()
  try {
    for (const [who, account] of Object.entries(ACCOUNTS) as [Account, (typeof ACCOUNTS)[Account]][]) {
      const context = await browser.newContext({ baseURL, ignoreHTTPSErrors })
      const page = await context.newPage()
      await page.goto(account.start)
      // With the demo sign-in on (D121, SHRI_DEMO_SIGN_IN), the portal stays on its own sign-in page
      // instead of leaving for Keycloak; its "Sign in" button (the existing-account path) leads there.
      const keycloak = page.locator('#username')
      const portalSignIn = page.getByRole('button', { name: 'Sign in', exact: true })
      await keycloak.or(portalSignIn).first().waitFor({ timeout: 30_000 })
      if (!(await keycloak.isVisible())) await portalSignIn.click()
      await keycloak.fill(account.username)
      await page.locator('#password').fill(password)
      await page.locator('#kc-login').click()
      await page.waitForURL((url) => !url.pathname.startsWith('/kc/'), { timeout: 30_000 })
      await context.storageState({ path: stateFile(who) })
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
