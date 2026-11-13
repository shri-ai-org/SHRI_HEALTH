/**
 * The portal and its staff side (the "Portal account" panel) together: development builds only,
 * until core serves the portal and staff portal-account routes and the patient realm exists
 * (D89, ADR-0013). Both halves turn on at once by changing this one line.
 */
export const PORTAL_ENABLED = import.meta.env.DEV

/**
 * P1 portal features that have no contract yet (MOCK_GUIDE §5d). Their screens stay in the code,
 * hidden from the menus, the home page and the router, until their batch lands; then the switch
 * turns on. Hide them, don't delete them.
 */
export const PORTAL_FEATURES = {
  /** Pay bills: payments and the patient ledger (P1, D58). */
  payBills: false,
  /** Video visits (telehealth). */
  video: false,
  /** Immunizations. */
  immunizations: false,
} as const

export type PortalFeature = keyof typeof PORTAL_FEATURES

/** The routes each feature owns, so the router and menus hide the same paths. */
export const FEATURE_PATHS: Record<PortalFeature, string[]> = {
  payBills: ['/billing'],
  video: ['/video-consult'],
  immunizations: ['/immunizations'],
}

/**
 * True in a build that talks to the real API (a production build unless `SHRI_API=mock`, or
 * `SHRI_API=real npm run dev`), as `__SHRI_REAL_API__` in the doctors' portal and the front office.
 */
export const REAL_API = typeof __SHRI_REAL_API__ !== 'undefined' && __SHRI_REAL_API__

/**
 * The screens whose data still comes from the in-memory sample (B8b and P1: test results,
 * messages, prescriptions, documents, reports, document templates and the e-signature). With the
 * real API they are hidden from the menus, the home page and the router, as the doctors' portal
 * hides screens without a backend, so a patient never sees sample records (M4). They return when
 * their contracts and services land; nothing is deleted.
 */
export const SAMPLE_ONLY_PATHS = [
  '/test-results',
  '/messages',
  '/prescriptions',
  '/patient-documents',
  '/reports',
  '/document-templates',
  '/e-signature',
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/** False when the path belongs to a feature that is switched off, or to a sample-only screen with the real API. */
export function pathEnabled(path: string, realApi: boolean = REAL_API): boolean {
  if (realApi && SAMPLE_ONLY_PATHS.some((p) => under(path, p))) return false
  return (Object.keys(FEATURE_PATHS) as PortalFeature[]).every((f) => PORTAL_FEATURES[f] || !FEATURE_PATHS[f].some((p) => under(path, p)))
}
