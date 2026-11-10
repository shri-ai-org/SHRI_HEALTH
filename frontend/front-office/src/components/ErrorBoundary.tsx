import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Where the failure happened, for the log line. */
  scope?: string
  /** Optional extra action beside Retry (e.g. "Close" for a flow). */
  onDismiss?: () => void
  dismissLabel?: string
  /** Wraps the error panel — e.g. in an overlay, for a flow that has no
   *  place in the page to show it. */
  frame?: (panel: ReactNode) => ReactNode
}

interface State {
  error: Error | null
  reference: string
}

function newReference(): string {
  return `ERR-${Date.now().toString(36).toUpperCase()}`
}

/**
 * One failed render never blanks the app (DESIGN_SYSTEM §1 "every state
 * designed", §10.10 error state): the shell, navigation and every other
 * place keep working, and this panel offers Retry plus a reference id the
 * desk can quote to support.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reference: '' }

  static getDerivedStateFromError(error: Error): State {
    return { error, reference: newReference() }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.scope ?? 'app'}] ${this.state.reference || 'render error'}`, error, info.componentStack)
  }

  private retry = () => this.setState({ error: null, reference: '' })

  render() {
    if (!this.state.error) return this.props.children
    const panel = (
      <div role="alert" className="flex flex-col items-center justify-center px-6 py-14 text-center">
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-critical-bg">
          <AlertTriangle size={22} className="text-critical-fg" aria-hidden="true" />
        </span>
        <h2 className="text-base font-semibold text-ink">Something went wrong here</h2>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted">
          This part of the screen could not be shown. Nothing you entered elsewhere is lost — try again, or use the menu to go to another place.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.retry}
            className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2"
          >
            <RotateCw size={15} aria-hidden="true" />
            Retry
          </button>
          {this.props.onDismiss ? (
            <button
              type="button"
              onClick={this.props.onDismiss}
              className="focus-ring inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {this.props.dismissLabel ?? 'Close'}
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-ink-subtle">Reference {this.state.reference}</p>
      </div>
    )
    return this.props.frame ? this.props.frame(panel) : panel
  }
}
