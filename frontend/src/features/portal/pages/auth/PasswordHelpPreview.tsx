// Development mock builds only (never with the real API): a small strip that picks what the next
// request and status check answer, so every state of the two pages can be seen before the contract
// exists. PasswordHelpRoute never renders it, nor uses these handlers, when REAL_API is on.
import { useState } from 'react'
import { Select } from '../../../../design-system'
import type { PasswordHelpHandlers, RequestOutcome, ResetStatus } from '../../passwordHelp'

type RequestChoice = RequestOutcome['kind']
type StatusChoice = ResetStatus | 'rate-limited' | 'error' | 'slow'

const choice: { request: RequestChoice; status: StatusChoice } = { request: 'accepted', status: 'waiting' }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function previewHandlers(): PasswordHelpHandlers {
  return {
    async requestReset() {
      await wait(500)
      return choice.request === 'accepted' ? { kind: 'accepted', statusToken: crypto.randomUUID().replace(/-/g, '') } : { kind: choice.request }
    },
    async readStatus() {
      if (choice.status === 'slow') {
        await wait(60_000)
        return { kind: 'error' }
      }
      await wait(400)
      if (choice.status === 'rate-limited' || choice.status === 'error') return { kind: choice.status }
      return choice.status === 'declined' ? { kind: 'ready', status: 'declined', note: 'Please call the front desk.' } : { kind: 'ready', status: choice.status }
    },
  }
}

export function PasswordHelpPreviewBar() {
  const [request, setRequest] = useState<RequestChoice>(choice.request)
  const [status, setStatus] = useState<StatusChoice>(choice.status)
  return (
    <aside aria-label="Preview (development only)" className="border-t border-border-soft bg-surface-1 px-4 py-3 text-xs">
      <div className="mx-auto flex max-w-md flex-wrap items-end gap-3">
        <span className="font-semibold text-ink-muted">Preview (development only)</span>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">Next request</span>
          <Select
            value={request}
            onChange={(e) => {
              choice.request = e.target.value as RequestChoice
              setRequest(choice.request)
            }}
          >
            {(['accepted', 'rate-limited', 'unavailable', 'error'] as const).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">Next status</span>
          <Select
            value={status}
            onChange={(e) => {
              choice.status = e.target.value as StatusChoice
              setStatus(choice.status)
            }}
          >
            {(['waiting', 'approved', 'declined', 'expired', 'unavailable', 'rate-limited', 'error', 'slow'] as const).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </aside>
  )
}
