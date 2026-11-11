import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { readFlow, withFlow } from './flowParams'
import type { FlowLocationState, FlowName, FlowParams } from './flowParams'

/**
 * Opens a flow over the current page. The flow is a history entry of its
 * own, so the browser's Back closes it and the page underneath is untouched.
 * Opening a second flow while one is open replaces it rather than stacking.
 */
export function useFlow() {
  const location = useLocation()
  const navigate = useNavigate()

  const openFlow = useCallback(
    (name: FlowName, params: FlowParams = {}) => {
      const alreadyOpen = readFlow(location.search) !== null
      const pushed = alreadyOpen ? Boolean((location.state as FlowLocationState | null)?.flowPushed) : true
      navigate(
        { pathname: location.pathname, search: withFlow(location.search, name, params) },
        { replace: alreadyOpen, state: { flowPushed: pushed } satisfies FlowLocationState },
      )
    },
    [location, navigate],
  )

  return { openFlow }
}
