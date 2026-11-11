import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { isFlowName, readFlow, withoutFlow } from './flowParams'
import type { FlowLocationState } from './flowParams'
import { FLOWS } from './registry'

/**
 * Renders whichever flow the URL names, over whatever page is showing.
 * Mounted once, in AppLayout.
 */
export function FlowHost() {
  const location = useLocation()
  const navigate = useNavigate()
  const active = readFlow(location.search)
  const Flow = active && isFlowName(active.name) ? FLOWS[active.name] : undefined

  // A flow's acknowledgement timer and the Escape key can both ask to close
  // in the same moment; only the first may step history back.
  const closingKey = useRef<string | null>(null)

  const close = useCallback(() => {
    if (!readFlow(location.search) || closingKey.current === location.key) return
    closingKey.current = location.key
    if ((location.state as FlowLocationState | null)?.flowPushed) {
      navigate(-1)
    } else {
      // Opened cold (a deep link or an old route's redirect): there is no
      // entry to step back to, so drop the flow from the address instead.
      navigate({ pathname: location.pathname, search: withoutFlow(location.search) }, { replace: true })
    }
  }, [location, navigate])

  const unknown = Boolean(active) && !Flow
  useEffect(() => {
    if (unknown) navigate({ pathname: location.pathname, search: withoutFlow(location.search) }, { replace: true })
  }, [unknown, location.pathname, location.search, navigate])

  if (!active || !Flow) return null
  return (
    <ErrorBoundary key={active.key} scope={`flow:${active.name}`} onDismiss={close} dismissLabel="Close" frame={flowErrorFrame}>
      <Flow params={active.params} onClose={close} />
    </ErrorBoundary>
  )
}

/** A failed flow still shows over the page, where the desk was looking. */
function flowErrorFrame(panel: ReactNode) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center sm:p-4">
      <div className="w-full max-w-md rounded-t-2xl border border-border-soft bg-surface-1 shadow-modal sm:rounded-xl">{panel}</div>
    </div>,
    document.body,
  )
}
