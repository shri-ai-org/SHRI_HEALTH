import { pathEnabled, SAMPLE_ONLY_PATHS } from './features'

// M4: with the real API, the screens still on sample data are hidden; with the contract mock they
// stay. The P1 switches (billing, video, immunizations) are off either way.
describe('pathEnabled', () => {
  it('hides every sample-only screen and its sub-pages with the real API', () => {
    for (const p of SAMPLE_ONLY_PATHS) {
      expect(pathEnabled(p, true)).toBe(false)
      expect(pathEnabled(`${p}/abc`, true)).toBe(false)
      expect(pathEnabled(p, false)).toBe(true)
    }
    expect(pathEnabled('/messages/inbox', true)).toBe(false)
  })

  it('keeps the real-API screens and the education links', () => {
    for (const p of ['/', '/appointments', '/appointments/schedule', '/health-issues', '/health-trends', '/allergies', '/patient-education', '/visit-summaries/x']) {
      expect(pathEnabled(p, true)).toBe(true)
    }
  })

  it('keeps P1 features off whatever the API', () => {
    for (const p of ['/billing', '/video-consult', '/immunizations']) {
      expect(pathEnabled(p, true)).toBe(false)
      expect(pathEnabled(p, false)).toBe(false)
    }
  })

  it('does not hide a path that only starts with the same letters', () => {
    expect(pathEnabled('/reports-of-something', true)).toBe(true)
  })
})
