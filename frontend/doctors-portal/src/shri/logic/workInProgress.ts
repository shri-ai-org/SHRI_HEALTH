// SHRI_HEALTH: the addresses that open the doctors' portal's "Work in progress" screen with the API
// (orders and referrals come after the demo: Thulasi; Vimal on #85, 18 Nov), so their menu items
// and old addresses never show Not found, an error or sample data.

export type WorkInProgressFeature = 'orders' | 'referrals'

/** React Router paths, in the order ShriApp registers them. */
export const WORK_IN_PROGRESS_ROUTES: ReadonlyArray<readonly [string, WorkInProgressFeature]> = [
  ['/orders/*', 'orders'],
  ['/encounter/:id/orders/*', 'orders'],
  ['/referrals/*', 'referrals'],
]

/** The feature a path belongs to, or null: `/orders`, `/orders/…`, `/encounter/<id>/orders…`, `/referrals…`. */
export function workInProgressFeature(pathname: string): WorkInProgressFeature | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/orders' || path.startsWith('/orders/')) return 'orders'
  if (/^\/encounter\/[^/]+\/orders(\/|$)/.test(path)) return 'orders'
  if (path === '/referrals' || path.startsWith('/referrals/')) return 'referrals'
  return null
}
