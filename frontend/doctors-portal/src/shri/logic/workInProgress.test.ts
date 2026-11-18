import { describe, expect, it } from 'vitest'

import { WORK_IN_PROGRESS_ROUTES, workInProgressFeature } from './workInProgress'

// Orders and referrals come after the demo: their addresses open "Work in progress" (Vimal on #85).
describe('the addresses that open Work in progress', () => {
  it.each([
    ['/orders/sets', 'orders'],
    ['/orders/stewardship', 'orders'],
    ['/orders', 'orders'],
    ['/encounter/enc-1/orders', 'orders'],
    ['/encounter/enc-1/orders/new', 'orders'],
    ['/referrals', 'referrals'],
    ['/referrals/', 'referrals'],
  ])('%s is %s', (path, feature) => {
    expect(workInProgressFeature(path)).toBe(feature)
  })

  it.each(['/', '/patient/p-1', '/encounter/enc-1/rx', '/ordersets', '/results/inbox', '/referralsx'])('%s is not', (path) => {
    expect(workInProgressFeature(path)).toBeNull()
  })

  it('registers a route for each feature', () => {
    expect(new Set(WORK_IN_PROGRESS_ROUTES.map(([, f]) => f))).toEqual(new Set(['orders', 'referrals']))
  })
})
