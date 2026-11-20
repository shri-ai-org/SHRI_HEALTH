// Development mock builds only (never with the real API): a small bar that picks what the next
// request and status check answer, so every state of the two pages can be seen before the contract
// exists. PasswordHelpApp never renders it, nor uses these handlers, when REAL_API is on.
import { useState } from 'react'
import type { PasswordHelpHandlers, RequestOutcome, ResetStatus } from '../../../shri-health/passwordHelp'
import { inputClass, labelClass } from '../../utils/formClasses'

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
      return choice.status === 'declined'
        ? { kind: 'ready', status: 'declined', note: 'Please ask in person at the front desk.' }
        : { kind: 'ready', status: choice.status }
    },
  }
}

export function PreviewBar() {
  const [request, setRequest] = useState<RequestChoice>(choice.request)
  const [status, setStatus] = useState<StatusChoice>(choice.status)
  return (
    <aside aria-label="Preview (development only)" className="border-t border-border-soft bg-surface-1 px-4 py-3 text-xs">
      <div className="mx-auto flex max-w-md flex-wrap items-end gap-3">
        <span className="font-semibold text-ink-muted">Preview (development only)</span>
        <label className="flex flex-col">
          <span className={labelClass}>Next request</span>
          <select
            className={inputClass}
            value={request}
            onChange={(event) => {
              choice.request = event.target.value as RequestChoice
              setRequest(choice.request)
            }}
          >
            <option value="accepted">accepted</option>
            <option value="rate-limited">rate-limited</option>
            <option value="unavailable">unavailable</option>
            <option value="error">error</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className={labelClass}>Next status</span>
          <select
            className={inputClass}
            value={status}
            onChange={(event) => {
              choice.status = event.target.value as StatusChoice
              setStatus(choice.status)
            }}
          >
            {(['waiting', 'approved', 'declined', 'expired', 'unavailable', 'rate-limited', 'error', 'slow'] as const).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
    </aside>
  )
}
