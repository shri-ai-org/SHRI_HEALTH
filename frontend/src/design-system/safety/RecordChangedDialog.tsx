import { useRef } from 'react'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'

export interface FieldChange {
  label: string
  /** What this user typed and tried to save. */
  yours: string
  /** What is saved now, from the record re-read after the 412. */
  current: string
}

export interface RecordChangedDialogProps {
  open: boolean
  /** Fields where the user's edit and the saved record differ. Empty while the latest is loading. */
  changes: FieldChange[]
  loading?: boolean
  /** Throw away this user's edits and show the saved record. */
  onUseLatest: () => void
  /** Load the saved record and put this user's edits back on top, for them to review before saving. */
  onKeepMine: () => void
}

/**
 * Shown on `412 precondition-failed` (and `428`): someone else saved this record first (ADR-0008,
 * API_STANDARDS §11). Nothing is overwritten silently: the user sees both versions and chooses.
 * The next save sends the new ETag. There is no "save anyway": the API does not allow it.
 */
export function RecordChangedDialog({ open, changes, loading = false, onUseLatest, onKeepMine }: RecordChangedDialogProps) {
  const latestRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open={open}
      title="This record was changed"
      size="lg"
      initialFocus={latestRef}
      footer={
        <>
          <Button variant="outline" onClick={onKeepMine} disabled={loading}>
            Keep my changes and review
          </Button>
          <Button ref={latestRef} onClick={onUseLatest} disabled={loading}>
            Use the latest version
          </Button>
        </>
      }
    >
      <p>
        Someone else saved changes to this record while you were editing. Your changes have <strong className="text-ink">not</strong> been
        saved. Compare them with the latest version, then choose what to do.
      </p>
      {loading ? (
        <p role="status" className="mt-4">Loading the latest version…</p>
      ) : changes.length === 0 ? (
        <p className="mt-4">None of the fields you changed were edited by the other person.</p>
      ) : (
        <table className="mt-4 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Your changes compared with the latest saved version</caption>
          <thead>
            <tr className="border-b border-border-soft text-xs text-ink-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">Field</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Your change</th>
              <th scope="col" className="py-2 font-semibold">Latest saved</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.label} className="border-b border-border-soft align-top last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-ink">{c.label}</th>
                <td className="py-2 pr-3 text-ink">{c.yours || '(empty)'}</td>
                <td className="py-2 text-ink">{c.current || '(empty)'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
