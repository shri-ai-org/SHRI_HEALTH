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

/** False when the path belongs to a feature that is switched off. */
export function pathEnabled(path: string): boolean {
  return (Object.keys(FEATURE_PATHS) as PortalFeature[]).every(
    (f) => PORTAL_FEATURES[f] || !FEATURE_PATHS[f].some((p) => path === p || path.startsWith(`${p}/`)),
  )
}
