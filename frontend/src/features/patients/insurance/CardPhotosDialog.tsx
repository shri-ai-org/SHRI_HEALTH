import { Upload } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, newIdempotencyKey } from '../../../api/client'
import { createDownloadUrl } from '../../../api/generated/endpoints/files/files'
import type { CardImageAttachSide, Coverage } from '../../../api/generated/model'
import { Alert, Button, formatDateTime, Modal, ProblemAlert, Spinner, type Problem } from '../../../design-system'
import { attachWhenClean, cardFileProblem, SCAN_WAITS_MS, uploadCardFile, UploadFailedError, type UploadStage } from './cardPhotos'

const SIDES: Array<{ side: CardImageAttachSide; label: string }> = [
  { side: 'front', label: 'Front' },
  { side: 'back', label: 'Back' },
]

const STAGE_TEXT: Record<UploadStage, string> = {
  preparing: 'Preparing the photo…',
  uploading: 'Uploading…',
  checking: 'Checking the file for viruses…',
  attaching: 'Saving to the insurance…',
}

/**
 * Photos of the insurance card, front and back (inventory #40; API_STANDARDS §15). Files go through
 * the file service: upload link, PUT, scan, then attach. Photos are viewed only through a
 * short-lived download link and never kept in the browser.
 */
export function CardPhotosDialog({
  patientId,
  coverage,
  onClose,
  onChanged,
  waits = SCAN_WAITS_MS,
}: {
  patientId: string
  coverage: Coverage
  onClose: () => void
  onChanged: () => void
  /** Waits between attach tries while the file is scanned; shorter in tests. */
  waits?: number[]
}) {
  const [current, setCurrent] = useState(coverage)
  return (
    <Modal
      open
      size="lg"
      title={`Insurance card: ${coverage.payerName ?? 'coverage'}`}
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <p className="mb-4 text-sm text-ink-muted">JPEG or PNG, up to 10 MB. A new photo replaces the one already saved for that side.</p>
      <div className="grid gap-6 md:grid-cols-2">
        {SIDES.map(({ side, label }) => (
          <CardSide
            key={side}
            patientId={patientId}
            coverage={current}
            side={side}
            label={label}
            waits={waits}
            onAttached={(updated) => {
              setCurrent(updated)
              onChanged()
            }}
          />
        ))}
      </div>
    </Modal>
  )
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; stage: UploadStage }
  | { kind: 'saved' }
  /** The scan didn't finish in time: the uploaded file is kept, so only the attach is tried again. */
  | { kind: 'still-checking'; fileId: string }
  | { kind: 'failed'; message: string }
  | { kind: 'problem'; problem: Problem }

function CardSide({
  patientId,
  coverage,
  side,
  label,
  waits,
  onAttached,
}: {
  patientId: string
  coverage: Coverage
  side: CardImageAttachSide
  label: string
  waits: number[]
  onAttached: (c: Coverage) => void
}) {
  const inputId = useId()
  const saved = coverage.cardImages?.find((i) => i.side === side)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [view, setView] = useState<{ url: string } | { problem: Problem } | 'loading' | null>(null)
  // One key per upload: kept for the attach tries of that upload, replaced by a new file.
  const idempotencyKey = useRef<string | null>(null)
  const previewUrl = useRef<string | null>(null)

  // A local preview of the chosen file, released when it changes or the dialog closes.
  function showPreview(next: File | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = next && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(next) : null
    setPreview(previewUrl.current)
  }
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    },
    [],
  )

  function choose(next: File | null) {
    setStatus({ kind: 'idle' })
    idempotencyKey.current = null
    const problem = next ? cardFileProblem(next) : null
    setFileError(problem)
    setFile(problem ? null : next)
    showPreview(problem ? null : next)
  }

  async function attach(fileId: string) {
    idempotencyKey.current ??= newIdempotencyKey()
    const updated = await attachWhenClean(patientId, coverage.id, side, fileId, idempotencyKey.current, {
      waits,
      onStage: (stage) => setStatus({ kind: 'working', stage }),
    })
    setStatus({ kind: 'saved' })
    setFile(null)
    showPreview(null)
    setView(null)
    onAttached(updated)
  }

  async function run(action: () => Promise<void>, fileId?: string) {
    try {
      await action()
    } catch (error) {
      if (error instanceof UploadFailedError) {
        setStatus({ kind: 'failed', message: "The upload didn't finish. Check the connection and try again." })
      } else if (error instanceof ApiError && error.code === 'file-not-ready' && fileId) {
        setStatus({ kind: 'still-checking', fileId })
      } else if (error instanceof ApiError) {
        setStatus({ kind: 'problem', problem: error.problem })
      } else {
        throw error
      }
    }
  }

  function upload() {
    if (!file) return setFileError('Choose a photo first.')
    let fileId: string | undefined
    void run(async () => {
      fileId = await uploadCardFile(file, (stage) => setStatus({ kind: 'working', stage }))
      try {
        await attach(fileId)
      } catch (error) {
        // Not ready in time: keep the uploaded file, so "Try again" only attaches it.
        if (error instanceof ApiError && error.code === 'file-not-ready') return setStatus({ kind: 'still-checking', fileId })
        throw error
      }
    }, fileId)
  }

  async function showSaved() {
    if (!saved) return
    setView('loading')
    try {
      const res = await createDownloadUrl(saved.fileId)
      if (res.status === 200) setView({ url: res.data.url })
    } catch (error) {
      if (error instanceof ApiError) setView({ problem: error.problem })
      else throw error
    }
  }

  const busy = status.kind === 'working'

  return (
    <section aria-labelledby={`${inputId}-title`} className="space-y-3 rounded-lg border border-border p-4">
      <h3 id={`${inputId}-title`} className="font-semibold text-ink">
        {label}
      </h3>

      {saved ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-muted">Saved {formatDateTime(saved.addedAt, null)}</p>
          {view === null ? (
            <Button size="sm" variant="outline" onClick={() => void showSaved()}>
              View {label.toLowerCase()}
            </Button>
          ) : view === 'loading' ? (
            <Spinner label="Opening the photo" />
          ) : 'url' in view ? (
            <div className="space-y-2">
              {/* The link is short-lived and audited; it is never stored. */}
              <img src={view.url} alt={`${label} of the insurance card`} className="max-h-56 rounded border border-border object-contain" />
              <Button size="sm" variant="ghost" onClick={() => setView(null)}>
                Hide
              </Button>
            </div>
          ) : (
            <ProblemAlert problem={view.problem} />
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">No photo yet.</p>
      )}

      <div className="space-y-2">
        <label htmlFor={inputId} className="block text-sm font-medium text-ink">
          {saved ? `Replace the ${label.toLowerCase()} photo` : `Add a photo of the ${label.toLowerCase()}`}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png"
          disabled={busy}
          aria-describedby={fileError ? `${inputId}-error` : undefined}
          aria-invalid={fileError ? true : undefined}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5"
        />
        {fileError ? (
          <p id={`${inputId}-error`} className="text-sm text-critical-fg">
            {fileError}
          </p>
        ) : null}
        {preview ? <img src={preview} alt={`${label} of the card, chosen for upload`} className="max-h-40 rounded border border-border object-contain" /> : null}
        <Button size="sm" loading={busy} disabled={!file} icon={<Upload aria-hidden="true" size={14} />} onClick={upload}>
          Upload {label.toLowerCase()}
        </Button>
      </div>

      <div role="status" className="text-sm">
        {status.kind === 'working' ? STAGE_TEXT[status.stage] : null}
        {status.kind === 'saved' ? <span className="text-success-fg">{label} photo saved.</span> : null}
      </div>
      {status.kind === 'still-checking' ? (
        <Alert tone="warning" title="Still checking the file">
          <p>The upload worked, but the virus check isn't finished yet.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void run(() => attach(status.fileId), status.fileId)}>
            Try again
          </Button>
        </Alert>
      ) : null}
      {status.kind === 'failed' ? <Alert tone="critical" title="Upload failed">{status.message}</Alert> : null}
      {status.kind === 'problem' ? <ProblemAlert problem={status.problem} /> : null}
    </section>
  )
}
