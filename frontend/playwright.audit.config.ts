import { defineConfig } from '@playwright/test'

// The demo's final audit (.github/workflows/demo-audit.yml, #384): the screens as the demo server
// serves them (production builds behind the deploy kit's Nginx), signed in through Keycloak as the
// demo accounts, against the seeded demo data (Linda Thompson). Never the development sign-in,
// never sample data. SHRI_AUDIT_URL is the stack (https://shri.localhost:9443 in CI);
// DEMO_PASSWORD is that run's own, made by `deploy.sh init-env`. Synthetic data only.
// Run by hand:  SHRI_AUDIT_URL=https://shri.localhost:9443 DEMO_PASSWORD=… npm exec -- playwright test -c playwright.audit.config.ts
const baseURL = process.env.SHRI_AUDIT_URL ?? 'https://shri.localhost:9443'

export default defineConfig({
  testDir: 'e2e/audit',
  testMatch: '*.audit.ts',
  globalSetup: './e2e/audit/signIn.setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  outputDir: 'audit-results',
  reporter: [['list'], ['html', { outputFolder: 'audit-report', open: 'never' }]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true, // the stack's self-signed certificate only
    screenshot: 'on',
    trace: 'retain-on-failure',
    timezoneId: 'America/Los_Angeles', // the demo clinic is San Jose
    locale: 'en-US',
  },
})
