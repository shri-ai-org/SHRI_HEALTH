import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, ConfirmDialog, formatDateTime, type AlertTone, type BadgeTone } from '../../../design-system'
import type { PortalMedication, PortalRefillRequest } from '../../../api/generated/model'
import { latestByPrescription, loadMyRefillRequests, NO_REFILL_TEXT, noRefillReason, requestRefill, type RequestOutcome } from '../refills'

/** The patient's refill requests for the page: read once, again after a change. */
export type RefillsState = { kind: 'loading' } | { kind: 'ok'; latest: Map<string, PortalRefillRequest> } | { kind: 'forbidden' } | { kind: 'error' }

export function useMyRefills(load: () => Promise<PortalRefillRequest[]> = loadMyRefillRequests) {
  const [state, setState] = useState<RefillsState>({ kind: 'loading' })
  const read = useCallback(
    () =>
      load().then(
        (items) => setState({ kind: 'ok', latest: latestByPrescription(items) }),
        (err: unknown) => setState({ kind: (err as { status?: number })?.status === 403 ? 'forbidden' : 'error' }),
      ),
    [load],
  )
  useEffect(() => {
    void read()
  }, [read])
  return { state, reload: read, retry: () => (setState({ kind: 'loading' }), void read()) }
}

const REQUEST_STATUS: Record<PortalRefillRequest['status'], { label: string; tone: BadgeTone }> = {
  requested: { label: 'Refill requested', tone: 'info' },
  approved: { label: 'Refill approved', tone: 'success' },
  declined: { label: 'Refill declined', tone: 'warning' },
}

/** What the patient reads about a medicine's latest request, in the clinic's time. */
export function requestStatusText(r: PortalRefillRequest, timeZone: string | null): string {
  if (r.status === 'requested') return `Requested ${formatDateTime(r.requestedAt, timeZone)}. Waiting for your clinic.`
  const at = r.respondedAt ? ` ${formatDateTime(r.respondedAt, timeZone)}` : ''
  // Approval makes a draft prescription; nothing reaches the pharmacy until the doctor signs it.
  if (r.status === 'approved')
    return `Approved by your clinic${r.respondedAt ? ` on ${formatDateTime(r.respondedAt, timeZone)}` : ''}. Your doctor still needs to sign the prescription before it goes to your pharmacy.`
  return `Declined${at}.${r.declineReason ? ` ${r.declineReason}` : ''}`
}

/** A refusal or failure, in plain words; `reload` when the page's requests should be read again. */
export function outcomeText(outcome: Exclude<RequestOutcome, { kind: 'done' }>): { tone: AlertTone; text: string; reload: boolean } {
  switch (outcome.kind) {
    case 'refused':
      if (outcome.reason === 'not-refillable') return { tone: 'warning', text: "This medicine can't be refilled online. Call your clinic.", reload: false }
      if (outcome.reason === 'not-active') return { tone: 'warning', text: "This medicine isn't current anymore, so it can't be refilled here.", reload: false }
      if (outcome.reason === 'refill-already-requested') return { tone: 'info', text: 'A refill is already requested for this medicine.', reload: true }
      return { tone: 'warning', text: "This refill couldn't be requested. Call your clinic.", reload: false }
    case 'forbidden':
      return { tone: 'warning', text: "Your account can't request refills. Call your clinic.", reload: false }
    case 'not-found':
      return { tone: 'warning', text: "That medicine isn't on your record anymore. Refresh the page to see your current list.", reload: false }
    case 'stale':
      return { tone: 'warning', text: 'Your medicines changed. The page has been updated; try again.', reload: true }
    case 'invalid':
      return { tone: 'warning', text: "That request couldn't be sent. Try again, or call your clinic.", reload: false }
    case 'rate-limited':
      return { tone: 'warning', text: 'Too many requests. Wait a few minutes, then try again.', reload: false }
    case 'error':
      return { tone: 'critical', text: "We couldn't send your request. Check your connection, then try again.", reload: false }
  }
}

/**
 * Under one medicine: its latest refill request's status, and "Request refill" (after a
 * confirmation) when the API's data allows one. Focus moves to the result.
 */
export function RefillControl({
  med,
  latest,
  timeZone,
  request = requestRefill,
  onChanged,
}: {
  med: PortalMedication
  latest: PortalRefillRequest | undefined
  timeZone: string | null
  request?: typeof requestRefill
  onChanged: () => void
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: AlertTone; text: string } | null>(null)
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  const [sent, setSent] = useState<PortalRefillRequest | null>(null)
  const key = useRef<string | null>(null)
  const result = useRef<HTMLDivElement>(null)
  const [moveFocus, setMoveFocus] = useState(0)

  // After an answer, focus moves to it once the dialog has closed (the dialog restores focus first).
  useEffect(() => {
    if (!moveFocus) return
    let frame = 0
    let tries = 0
    const go = () => {
      if (document.querySelector('[role="dialog"],[role="alertdialog"]') && tries++ < 60) {
        frame = requestAnimationFrame(go)
        return
      }
      result.current?.focus()
    }
    go()
    return () => cancelAnimationFrame(frame)
  }, [moveFocus])

  const shown = sent ?? latest
  const why = noRefillReason(med, shown, refused)

  async function send() {
    key.current ??= crypto.randomUUID()
    setBusy(true)
    const outcome = await request(med.id, key.current)
    setBusy(false)
    setAsking(false)
    if (outcome.kind === 'done') {
      key.current = null
      setSent(outcome.request)
      setMessage({ tone: 'success', text: 'Refill requested. Your clinic will review it, and you’ll see the answer here.' })
      onChanged()
    } else {
      const shownText = outcomeText(outcome)
      if (outcome.kind === 'refused') key.current = null
      if (outcome.kind === 'refused' && outcome.reason === 'not-refillable') setRefused(new Set([med.id]))
      setMessage({ tone: shownText.tone, text: shownText.text })
      if (shownText.reload) onChanged()
    }
    setMoveFocus((n) => n + 1)
  }

  return (
    <div className="mt-2 space-y-2">
      {shown ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <Badge tone={REQUEST_STATUS[shown.status].tone}>{REQUEST_STATUS[shown.status].label}</Badge>
          <span>{requestStatusText(shown, timeZone)}</span>
        </p>
      ) : null}
      <div ref={result} tabIndex={-1} className="outline-none">
        {message ? (
          <Alert tone={message.tone} title={message.text} />
        ) : null}
      </div>
      {why === null ? (
        <Button size="sm" variant="secondary" onClick={() => setAsking(true)} aria-label={`Request a refill of ${med.display}`}>
          Request refill
        </Button>
      ) : why !== 'open-request' ? (
        <p className="text-sm text-ink-muted">{NO_REFILL_TEXT[why]}</p>
      ) : null}
      <ConfirmDialog
        open={asking}
        title="Request a refill?"
        confirmLabel="Send request"
        busy={busy}
        onConfirm={() => void send()}
        onCancel={() => setAsking(false)}
      >
        <p className="text-sm text-ink">
          Ask your clinic to refill <strong>{med.display}</strong>. Your clinic reviews the request, and you’ll see the answer on this page.
        </p>
      </ConfirmDialog>
    </div>
  )
}
