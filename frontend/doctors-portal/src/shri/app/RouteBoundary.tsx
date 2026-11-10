import { ChevronLeft, RotateCcw } from 'lucide-react'
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { Card, Icon } from '../ui/primitives'

import { P } from './paths'
import { SealedBody } from '../overlays/QuickPanel'
import { breakGlassOnServer, breakGlassPatientOf } from '../../../shri-health/breakglass'

interface Props {
  children: ReactNode
  /** A new value (the pathname) clears the error, so moving on always works. */
  resetKey: string
}

interface State {
  error: Error | null
  /** The `resetKey` the error belongs to. */
  key: string
}

/**
 * A screen that throws while drawing — an unknown patient or encounter id in
 * the address is the usual cause — shows this card instead of taking the whole
 * app down. The old build had no boundary and went blank.
 */
export class RouteBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen failed to draw:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    // SHRI_HEALTH: screens whose data comes from the API wait here while it loads (shri-health/resource.ts).
    if (!error) {
      const loading = (
        <p role="status" className="py-[24px] text-[13px] text-sh-text-3">
          Loading…
        </p>
      )
      return <Suspense fallback={loading}>{this.props.children}</Suspense>
    }
    // SHRI_HEALTH: a restricted chart (403 break-glass-required, D37) opens through the portal's own
    // sealed card; "Record and open" records the break-glass on the server, then reads again.
    const sealedPatient = breakGlassPatientOf(error, this.props.resetKey)
    if (sealedPatient) {
      return (
        <div className="mx-auto w-full max-w-[640px] py-[40px]">
          <Card title="Restricted record" className="flex flex-col">
            <SealedBody
              onConfirm={(reason) =>
                void breakGlassOnServer(sealedPatient, reason)
                  .then(() => this.setState({ error: null }))
                  .catch((e: unknown) => this.setState({ error: e instanceof Error ? e : new Error(String(e)) }))
              }
            />
          </Card>
        </div>
      )
    }
    return (
      <div className="mx-auto w-full max-w-[640px] py-[40px]">
        <Card title="This screen could not open">
          <p className="text-[14px]/[1.5] text-sh-text-2">
            Something it needed was not there — often an address with an id that is not on this system.
          </p>
          <p className="mt-[10px] break-words rounded-sh-inner bg-sh-inner px-[12px] py-[8px] text-[13px] text-sh-text">{error.message}</p>
          <div className="mt-[18px] flex flex-wrap gap-[12px]">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="inline-flex h-[44px] items-center gap-[6px] rounded-full bg-sh-control pl-[14px] pr-[18px] text-[13px] font-medium text-sh-text hover:bg-sh-hover"
            >
              <Icon icon={RotateCcw} size={16} />
              Try again
            </button>
            <Link
              to={P.myDay}
              className="inline-flex h-[44px] items-center gap-[6px] rounded-full bg-sh-primary pl-[14px] pr-[18px] text-[13px] font-medium text-sh-on-primary hover:bg-sh-primary-hover"
            >
              <Icon icon={ChevronLeft} size={16} />
              Dashboard
            </Link>
          </div>
        </Card>
      </div>
    )
  }
}
