import { useState } from 'react'
import { createHttpPortalApi } from './api/httpPortalApi'
import { createMockPortalApi } from './api/mockPortalApi'
import { PortalApp } from './PortalApp'

/**
 * The portal in development builds: the B8a screens call the API through the generated client
 * (`npm run mock` in contracts/ answers them with sample data; MOCK_GUIDE §5d), and the later
 * screens (messages, results, prescriptions and the rest, B8b) use the in-memory mock. main.tsx
 * loads it behind `import.meta.env.DEV`, so a production build has no portal until B8b exists.
 */
export default function MockPortal() {
  const [api] = useState(() => createHttpPortalApi(createMockPortalApi()))
  return <PortalApp api={api} />
}
