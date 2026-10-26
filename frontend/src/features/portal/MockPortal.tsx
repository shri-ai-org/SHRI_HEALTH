import { useState } from 'react'
import { createMockPortalApi } from './api/mockPortalApi'
import { PortalApp } from './PortalApp'

/**
 * The portal on the in-memory mock (synthetic data). Development builds only: main.tsx loads it
 * behind `import.meta.env.DEV`, so a production build has no portal and no fake sign-in until the
 * `/portal` contract (B8, D88) and its generated client exist.
 */
export default function MockPortal() {
  const [api] = useState(() => createMockPortalApi())
  return <PortalApp api={api} />
}
