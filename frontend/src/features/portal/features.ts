/**
 * The portal and its staff side (the "Portal account" panel) together: development builds only,
 * until core serves the portal and staff portal-account routes and the patient realm exists
 * (D89, ADR-0013). Both halves turn on at once by changing this one line.
 */
export const PORTAL_ENABLED = import.meta.env.DEV

/**
 * The demo sign-in with a mobile number and date of birth (D121): demo servers only, in a build with
 * `VITE_FEATURE_DEMO_SIGN_IN=on` (deploy.sh sets it for `SHRI_DEMO_SIGN_IN=true`, which needs
 * `SHRI_DEMO=true`). Read when called, so a test can switch it. The server refuses it elsewhere too.
 */
export const demoSignInOn = (): boolean => import.meta.env.VITE_FEATURE_DEMO_SIGN_IN === 'on'

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
 * messages, prescriptions, documents, reports, document templates and the e-signature), and
 * Demographics, whose read isn't served yet. With the
 * real API they are hidden from the menus, the home page and the router, as the doctors' portal
 * hides screens without a backend, so a patient never sees sample records (M4). They return when
 * their contracts and services land; nothing is deleted.
 */
export const SAMPLE_ONLY_PATHS = [
  // The list reads the API (listPortalLabResults, #398); a single sample result's detail page has
  // no counterpart there, so only its route stays hidden.
  '/test-results/:resultId',
  '/messages',
  // The medication list reads the API (listPortalMedications, #389); refill requests have no
  // contract yet, so their confirmation page stays hidden.
  '/prescriptions/requests',
  '/patient-documents',
  '/reports',
  '/document-templates',
  '/e-signature',
  // Not sample data, but its read (getPortalProfile, GET /portal/me) isn't served yet: hidden until
  // it is, so the patient never meets "Couldn't load your profile" (final audit, 13 Nov).
  '/demographics',
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/** False when the path belongs to a feature that is switched off, or to a sample-only screen with the real API. */
export function pathEnabled(path: string, realApi: boolean = REAL_API): boolean {
  if (realApi && SAMPLE_ONLY_PATHS.some((p) => under(path, p))) return false
  return (Object.keys(FEATURE_PATHS) as PortalFeature[]).every((f) => PORTAL_FEATURES[f] || !FEATURE_PATHS[f].some((p) => under(path, p)))
}
