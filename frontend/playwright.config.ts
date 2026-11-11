import { defineConfig } from '@playwright/test'

// End-to-end tests: the screens against the real API (`npm run e2e`). The dev server runs in its
// real-API mode (dev/realApi.ts), so the backend's development sign-in and a synthetic session
// stand in for real login. Start the backend first: the local stack (infra/compose), or the API
// on 127.0.0.1:8000 as the frontend CI's e2e job does. Synthetic data only.
const port = 5190
/** The doctors' portal's dev server, signed in as the development physician. */
export const doctorsPort = 5191

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    // CI drives the runner's own Chrome, so no browser is downloaded. Locally, set
    // PLAYWRIGHT_CHANNEL=chrome to use an installed Chrome as well.
    ...(process.env.CI || process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' } : {}),
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `npm run dev -- --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      env: { SHRI_API: 'real', SHRI_API_URL: process.env.SHRI_API_URL ?? 'https://localhost:8443', SHRI_DEV_USER: 'fd' },
    },
    {
      // The doctors' portal as the development physician (md), for the doctor's screens
      // (e2e/doctor*.e2e.ts reach it at DOCTORS_URL).
      command: `npm run dev -w doctors-portal -- --port ${doctorsPort} --strictPort`,
      url: `http://localhost:${doctorsPort}`,
      reuseExistingServer: !process.env.CI,
      env: { SHRI_API: 'real', SHRI_API_URL: process.env.SHRI_API_URL ?? 'https://localhost:8443', SHRI_DEV_USER: 'md' },
    },
  ],
})
