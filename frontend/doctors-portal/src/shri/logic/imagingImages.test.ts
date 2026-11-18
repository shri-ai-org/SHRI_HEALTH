import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDownloadUrl } from '../../../../src/api/generated/endpoints/files/files'
import type { ImagingReportImage } from '../../../../src/api/generated/model'
import { canView, ILLUSTRATIVE, illustrativeSeries, imageProblem, loadImages, viewerPath } from './imagingImages'

vi.mock('../../../../src/api/generated/endpoints/files/files', () => ({ createDownloadUrl: vi.fn() }))

// Synthetic file IDs and links only; no image file and never a medical image.
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
  it('shows each image from a fresh one-time link to our own API', async () => {
    vi.mocked(createDownloadUrl).mockImplementation((id) => Promise.resolve(link(id)) as never)
    const loaded = await loadImages([image(1), image(2)])
    expect(createDownloadUrl).toHaveBeenCalledTimes(2)
    expect(loaded).toEqual([
      { image: image(1), src: `/api/v1/files/${image(1).id}/content?token=${TOKEN}` },
      { image: image(2), src: `/api/v1/files/${image(2).id}/content?token=${TOKEN}` },
    ])
  })

  it("fails the set when a link can't be made, so the screen says so and asks again", async () => {
    vi.mocked(createDownloadUrl).mockImplementationOnce((id) => Promise.resolve(link(id)) as never).mockRejectedValueOnce(new Error('403'))
    await expect(loadImages([image(1), image(2)])).rejects.toThrow()
  })
})

describe('the viewer series', () => {
  it('is one frame per image, labelled illustrative, with each caption', () => {
    const s = illustrativeSeries('r1', 'MRI lumbar spine', [
      { image: image(1), src: '/link/1' },
      { image: image(2), src: '/link/2' },
    ])
    expect(s.frames).toBe(2)
    expect(s.path(2)).toBe('/link/2')
    expect(s.alt(1)).toBe(`${ILLUSTRATIVE}: Synthetic test image 1`)
    expect(s.topRight).toEqual([ILLUSTRATIVE])
    expect(s.frameNote?.(2)).toBe('Synthetic test image 2')
  })
})

describe("the viewer's messages (Anand's review of #417)", () => {
  it('says what went wrong in one plain line per refusal', () => {
    expect(imageProblem(403)).toBe("You don't have access to this report's images.")
    expect(imageProblem(404)).toBe("This image isn't available. Try again.")
    expect(imageProblem(409)).toBe('The image link expired. Try again.')
    expect(imageProblem(410)).toBe('The image link expired. Try again.')
    expect(imageProblem(undefined)).toBe("Couldn't load the image. The link may have expired.")
    expect(imageProblem(503)).toBe("Couldn't load the image. The link may have expired.")
  })
})
