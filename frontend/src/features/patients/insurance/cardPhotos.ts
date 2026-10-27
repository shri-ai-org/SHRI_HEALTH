import { ApiError } from '../../../api/client'
import { completeUpload, createUploadUrl } from '../../../api/generated/endpoints/files/files'
import { attachCoverageCardImage } from '../../../api/generated/endpoints/patients/patients'
import type { CardImageAttachSide, Coverage } from '../../../api/generated/model'

/** M13: insurance cards are JPEG or PNG, at most 10 MB. */
export const CARD_TYPES = ['image/jpeg', 'image/png'] as const
export const CARD_MAX_BYTES = 10 * 1024 * 1024

/** What a chosen file is wrong with, in the words the screen shows; `null` when it can be uploaded. */
export function cardFileProblem(file: File): string | null {
  if (!(CARD_TYPES as readonly string[]).includes(file.type)) return 'Choose a JPEG or PNG photo.'
  if (file.size === 0) return 'That file is empty. Choose the photo again.'
  if (file.size > CARD_MAX_BYTES) return 'Choose a photo of 10 MB or less.'
  return null
}

/** Lowercase hex SHA-256 of the file, which the file service checks after upload. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export type UploadStage = 'preparing' | 'uploading' | 'checking' | 'attaching'

/** Waits between attach attempts while the file is scanned: about 30 seconds in all. */
export const SCAN_WAITS_MS = [1000, 2000, 3000, 5000, 8000, 10000]

const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** The upload link's PUT failed (network, or the link expired). */
export class UploadFailedError extends Error {
  constructor() {
    super('upload-failed')
    this.name = 'UploadFailedError'
  }
}

/**
 * Steps 1–3 of API_STANDARDS §15: ask for an upload link (purpose `insurance-card`), PUT the bytes
 * to it, and finish the upload, which starts the scan. Returns the file ID. The upload link is a
 * bearer secret, so it is used once here and never logged or kept.
 */
export async function uploadCardFile(file: File, onStage: (s: UploadStage) => void): Promise<string> {
  onStage('preparing')
  const sha256 = await sha256Hex(file)
  const ticket = await createUploadUrl({ purpose: 'insurance-card', contentType: file.type, sizeBytes: file.size, sha256 })
  if (ticket.status !== 201) throw new UploadFailedError()
  onStage('uploading')
  // Straight to the object store: no session cookie or CSRF token goes there.
  const put = await fetch(ticket.data.uploadUrl, {
    method: 'PUT',
    headers: ticket.data.uploadHeaders ?? { 'Content-Type': file.type },
    body: file,
    credentials: 'omit',
  }).catch(() => null)
  if (!put?.ok) throw new UploadFailedError()
  await completeUpload(ticket.data.fileId)
  return ticket.data.fileId
}

/**
 * Step 4: attach the file to the coverage. Until the scan ends the server answers
 * `422 file-not-ready`, so this tries again after each wait in `waits`. The contract has no
 * operation read yet (`GET /operations/{id}`, API_STANDARDS §13), and live updates come later.
 * The same Idempotency-Key is used for every try, since it is one user action.
 */
export async function attachWhenClean(
  patientId: string,
  coverageId: string,
  side: CardImageAttachSide,
  fileId: string,
  idempotencyKey: string,
  { waits = SCAN_WAITS_MS, onStage }: { waits?: number[]; onStage: (s: UploadStage) => void },
): Promise<Coverage> {
  onStage('checking')
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await attachCoverageCardImage(patientId, coverageId, { fileId, side }, { 'Idempotency-Key': idempotencyKey })
      if (res.status === 200) return res.data
      throw new UploadFailedError()
    } catch (error) {
      const wait = waits[attempt]
      if (error instanceof ApiError && error.code === 'file-not-ready' && wait !== undefined) {
        await pause(wait)
        continue
      }
      throw error
    }
  }
}
