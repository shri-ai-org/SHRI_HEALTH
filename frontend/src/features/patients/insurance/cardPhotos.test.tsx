import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../../api/client'
import type { Coverage } from '../../../api/generated/model'
import { ToastProvider } from '../../../design-system'
import { axeViolations } from '../../../test/axe'
import { json, problem, serve } from '../../../test/fakeServer'
import { CardPhotosDialog } from './CardPhotosDialog'
import { cardFileProblem, sha256Hex } from './cardPhotos'
import { InsurancePanel } from './InsurancePanel'

// Synthetic data only.
const patientId = '00000000-0000-4000-8000-0000000000aa'
const fileId = '00000000-0000-4000-8000-0000000003c1'
const coverage: Coverage = {
  id: '00000000-0000-4000-8000-0000000001a1',
  patientId,
  order: 1,
  payerId: '00000000-0000-4000-8000-0000000002a1',
  payerName: 'Test Health Plan 1',
  memberId: 'TST10001',
  relationshipToSubscriber: 'self',
  status: 'active',
  createdAt: '2026-10-24T12:00:00Z',
  updatedAt: '2026-10-24T12:00:00Z',
}
const withFront: Coverage = { ...coverage, cardImages: [{ side: 'front', fileId, addedAt: '2026-10-26T15:00:00Z' }] }

const UPLOAD_URL = 'https://upload.test/quarantine/abc'
const ATTACH = `POST /api/v1/patients/${patientId}/coverages/${coverage.id}/card-images`
const UPLOAD_ROUTES = {
  'POST /api/v1/files/upload-url': [() => json(201, { fileId, uploadUrl: UPLOAD_URL, uploadHeaders: { 'Content-Type': 'image/png' }, expiresAt: '2026-10-26T15:10:00Z' })],
  [`PUT ${UPLOAD_URL}`]: [() => new Response(null, { status: 200 })],
  [`POST /api/v1/files/${fileId}/complete`]: [
    () => json(202, { id: '00000000-0000-4000-8000-0000000004c1', kind: 'file.scan', status: 'queued', createdAt: '2026-10-26T15:00:00Z', updatedAt: '2026-10-26T15:00:00Z' }),
  ],
}

// "abc" in a PNG wrapper is enough: the screen checks type and size, the server checks the bytes.
const png = () => new File(['abc'], 'card.png', { type: 'image/png' })

function renderDialog(c: Coverage = coverage) {
  const onChanged = vi.fn()
  render(
    <ToastProvider>
      <CardPhotosDialog patientId={patientId} coverage={c} onClose={() => {}} onChanged={onChanged} waits={[0, 0]} />
    </ToastProvider>,
  )
  return onChanged
}

beforeEach(() => setCsrfToken('tok'))
afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('cardPhotos helpers', () => {
  it('accepts JPEG and PNG up to 10 MB only (M13)', () => {
    expect(cardFileProblem(png())).toBeNull()
    expect(cardFileProblem(new File(['x'], 'card.gif', { type: 'image/gif' }))).toMatch(/JPEG or PNG/)
    expect(cardFileProblem(new File([], 'empty.png', { type: 'image/png' }))).toMatch(/empty/)
    const big = new File(['x'], 'big.jpg', { type: 'image/jpeg' })
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 })
    expect(cardFileProblem(big)).toMatch(/10 MB/)
  })

  it('hashes the bytes as lowercase hex SHA-256', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('CardPhotosDialog', () => {
  it('uploads through the file service and attaches once the scan is clean, under one key', async () => {
    const user = userEvent.setup()
    const server = serve({ ...UPLOAD_ROUTES, [ATTACH]: [() => problem(422, 'file-not-ready'), () => json(200, withFront)] })
    const onChanged = renderDialog()
    const front = screen.getByRole('region', { name: 'Front' })
    expect(await axeViolations()).toEqual([])

    await user.upload(within(front).getByLabelText('Add a photo of the front'), png())
    await user.click(within(front).getByRole('button', { name: 'Upload front' }))
    expect(await within(front).findByText('Front photo saved.')).toBeInTheDocument()
    expect(onChanged).toHaveBeenCalled()
    // Now saved, so the side offers View and Replace.
    expect(within(front).getByRole('button', { name: 'View front' })).toBeInTheDocument()

    expect(server.bodies('POST /api/v1/files/upload-url')[0]?.body).toEqual({
      purpose: 'insurance-card',
      contentType: 'image/png',
      sizeBytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
    expect(server.calls()).toContain(`PUT ${UPLOAD_URL}`)
    const attaches = server.bodies(ATTACH)
    expect(attaches.map((a) => a.body)).toEqual([{ fileId, side: 'front' }, { fileId, side: 'front' }])
    expect(attaches[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(attaches[1]?.headers.get('Idempotency-Key')).toBe(attaches[0]?.headers.get('Idempotency-Key'))
  })

  it('keeps the uploaded file when the scan takes longer, so Try again only attaches it', async () => {
    const user = userEvent.setup()
    const server = serve({
      ...UPLOAD_ROUTES,
      [ATTACH]: [() => problem(422, 'file-not-ready'), () => problem(422, 'file-not-ready'), () => problem(422, 'file-not-ready'), () => json(200, withFront)],
    })
    renderDialog()
    const front = screen.getByRole('region', { name: 'Front' })
    await user.upload(within(front).getByLabelText('Add a photo of the front'), png())
    await user.click(within(front).getByRole('button', { name: 'Upload front' }))
    expect(await within(front).findByText('Still checking the file')).toBeInTheDocument()

    await user.click(within(front).getByRole('button', { name: 'Try again' }))
    expect(await within(front).findByText('Front photo saved.')).toBeInTheDocument()
    expect(server.calls().filter((c) => c === 'POST /api/v1/files/upload-url')).toHaveLength(1)
  })

  it('says so when the upload itself fails', async () => {
    const user = userEvent.setup()
    serve({ ...UPLOAD_ROUTES, [`PUT ${UPLOAD_URL}`]: [() => new Response(null, { status: 403 })] })
    renderDialog()
    const back = screen.getByRole('region', { name: 'Back' })
    await user.upload(within(back).getByLabelText('Add a photo of the back'), png())
    await user.click(within(back).getByRole('button', { name: 'Upload back' }))
    expect(await within(back).findByText(/The upload didn't finish/)).toBeInTheDocument()
  })

  it('refuses other file types before uploading', async () => {
    const user = userEvent.setup({ applyAccept: false })
    serve({})
    renderDialog()
    const front = screen.getByRole('region', { name: 'Front' })
    const input = within(front).getByLabelText('Add a photo of the front')
    await user.upload(input, new File(['x'], 'card.gif', { type: 'image/gif' }))
    expect(input).toBeInvalid()
    expect(input).toHaveAccessibleDescription('Choose a JPEG or PNG photo.')
    expect(within(front).getByRole('button', { name: 'Upload front' })).toBeDisabled()
  })

  it('shows a saved photo only through a short-lived download link', async () => {
    const user = userEvent.setup()
    serve({
      [`GET /api/v1/files/${fileId}/download-url`]: [() => json(200, { url: 'https://download.test/clean/abc?sig=1', expiresAt: '2026-10-26T15:05:00Z', contentType: 'image/png' })],
    })
    renderDialog(withFront)
    const front = screen.getByRole('region', { name: 'Front' })
    expect(within(front).getByLabelText('Replace the front photo')).toBeInTheDocument()
    await user.click(within(front).getByRole('button', { name: 'View front' }))
    expect(await within(front).findByRole('img', { name: 'Front of the insurance card' })).toHaveAttribute('src', 'https://download.test/clean/abc?sig=1')
    await user.click(within(front).getByRole('button', { name: 'Hide' }))
    expect(within(front).queryByRole('img')).toBeNull()
  })
})

describe('InsurancePanel card photos', () => {
  it('shows which sides are on file and opens the photos from the row', async () => {
    const user = userEvent.setup()
    serve({ [`GET /api/v1/patients/${patientId}/coverages?limit=100`]: [() => json(200, { items: [withFront] })] })
    render(
      <ToastProvider>
        <InsurancePanel patientId={patientId} />
      </ToastProvider>,
    )
    const table = await screen.findByRole('table', { name: 'Insurance coverages' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Front')
    await user.click(within(table).getByRole('button', { name: 'Card photos for Test Health Plan 1' }))
    expect(screen.getByRole('dialog', { name: 'Insurance card: Test Health Plan 1' })).toBeInTheDocument()
  })
})
