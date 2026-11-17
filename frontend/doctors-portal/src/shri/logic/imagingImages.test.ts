import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDownloadUrl, downloadFileContent } from '../../../../src/api/generated/endpoints/files/files'
import type { ImagingReportImage } from '../../../../src/api/generated/model'
import { canView, ILLUSTRATIVE, illustrativeSeries, loadImages, tokenOf, viewerPath } from './imagingImages'

vi.mock('../../../../src/api/generated/endpoints/files/files', () => ({ createDownloadUrl: vi.fn(), downloadFileContent: vi.fn() }))

// Tiny in-memory data only: a 1x1 pixel built here, never an image file and never a medical image.
const PIXEL = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
const TOKEN = 'a'.repeat(40)
const image = (n: number): ImagingReportImage => ({
  id: `f0000000-0000-4000-8000-00000000000${n}`,
  caption: `Synthetic test image ${n}`,
  label: 'Illustrative image',
  contentType: 'image/png',
  sizeBytes: 8,
})
const link = (fileId: string) => ({
  status: 200,
  data: { url: `/api/v1/files/${fileId}/content?token=${TOKEN}`, expiresAt: '2026-11-20T18:01:00Z', contentType: 'image/png' },
  headers: new Headers(),
})

beforeEach(() => {
  vi.mocked(createDownloadUrl).mockReset()
  vi.mocked(downloadFileContent).mockReset()
})

describe('the Imaging reports row', () => {
  it('offers View image when the report has images', () => {
    expect(canView({ images: [image(1)] })).toBe(true)
  })

  it('keeps a text-only report without a button', () => {
    expect(canView({ images: [] })).toBe(false)
  })

  it('opens the viewer at the report, with the patient as an opaque ID only (D13)', () => {
    expect(viewerPath('5eed0017-0000-4000-8000-000000000003', 'r0000000-0000-4000-8000-000000000001')).toBe(
      '/radiology/study/r0000000-0000-4000-8000-000000000001/view?patient=5eed0017-0000-4000-8000-000000000003',
    )
  })
})

describe('reading the images (D105)', () => {
  it('reads each image through a fresh link, its token, and shows it from a blob: URL', async () => {
    vi.mocked(createDownloadUrl).mockImplementation((id) => Promise.resolve(link(id)) as never)
    vi.mocked(downloadFileContent).mockResolvedValue({ status: 200, data: PIXEL, headers: new Headers() } as never)
    const toUrl = vi.fn(() => 'blob:test-1')
    const loaded = await loadImages([image(1)], toUrl)
    expect(downloadFileContent).toHaveBeenCalledWith(image(1).id, { token: TOKEN })
    expect(toUrl).toHaveBeenCalledWith(PIXEL)
    expect(loaded).toEqual([{ image: image(1), src: 'blob:test-1' }])
  })

  it("fails the set when an image can't be read, so the screen says so and asks again", async () => {
    vi.mocked(createDownloadUrl).mockImplementation((id) => Promise.resolve(link(id)) as never)
    vi.mocked(downloadFileContent).mockRejectedValueOnce(new Error('404: the link expired'))
    await expect(loadImages([image(1), image(2)], () => 'blob:x')).rejects.toThrow()
  })

  it('fails when the link has no token', () => {
    expect(() => tokenOf('/api/v1/files/f/content')).toThrow()
    expect(tokenOf(`/api/v1/files/f/content?token=${TOKEN}`)).toBe(TOKEN)
  })
})

describe('the viewer series', () => {
  it('is one frame per image, labelled illustrative, with each caption', () => {
    const s = illustrativeSeries('r1', 'MRI lumbar spine', [
      { image: image(1), src: 'blob:1' },
      { image: image(2), src: 'blob:2' },
    ])
    expect(s.frames).toBe(2)
    expect(s.path(2)).toBe('blob:2')
    expect(s.alt(1)).toBe(`${ILLUSTRATIVE}: Synthetic test image 1`)
    expect(s.topRight).toEqual([ILLUSTRATIVE])
    expect(s.frameNote?.(2)).toBe('Synthetic test image 2')
  })
})
