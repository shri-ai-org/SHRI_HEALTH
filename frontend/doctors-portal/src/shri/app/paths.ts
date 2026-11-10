/**
 * Root paths. `BrowserRouter` carries the deploy base (`PORTAL_BASE`), so none
 * of these include it. Module destinations are the Indostates build's own
 * routes (`src/atlas/nav.ts`, `src/atlas/registry.ts`), so a deep link from
 * the old build opens the same screen here.
 */
export const P = {
  myDay: '/',
  /** The record overview; `id` is the UHID (or the kit id — both resolve). */
  record: (id: string) => `/patient/${id}`,
}

/** Where each module lives — the routes the old rail and registry use. */
export const MODULE = {
  opd: '/op-queue',
  inpatients: '/ip/patients',
  results: '/results/inbox',
  orders: '/orders/sets',
  discharge: '/discharge/board',
  imaging: '/radiology/worklist',
  strokeAi: '/stroke/ai-console',
  telestroke: '/stroke/telestroke/queue',
  sites: '/stroke/network/sites',
  registry: '/stroke/registry',
  telehealth: '/tele/queue',
  cosign: '/clinician/cosign',
  referrals: '/referrals',
} as const

export type ModuleKey = keyof typeof MODULE

/**
 * The two addresses that moved when this build took the root: My Day from
 * `/clinician` to `/`, and the record overview from `/patient/:id/record` to
 * `/patient/:id`. Links read from the old build's data go through this, so
 * navigating inside the app never costs a redirect.
 */
export function canonical(to: string): string {
  const cut = to.search(/[?#]/)
  const path = cut === -1 ? to : to.slice(0, cut)
  const rest = cut === -1 ? '' : to.slice(cut)
  if (path === '/clinician' || path === '/clinician/') return `/${rest}`
  const record = /^\/patient\/([^/]+)\/record\/?$/.exec(path)
  if (record) return `/patient/${record[1]}${rest}`
  return to
}
