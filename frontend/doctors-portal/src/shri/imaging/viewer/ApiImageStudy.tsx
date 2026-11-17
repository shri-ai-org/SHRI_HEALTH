/**
 * SHRI_HEALTH: S-15-04 with the API (item 6 of the demo plan, #386): an imaging report's
 * illustrative images in the existing reading Workstation, with the report's text beside it, as
 * the sample screen lays out an image study. Opened from the record's Imaging reports tab
 * ("View image") at /radiology/study/<report>/view?patient=<patient>, both opaque IDs (D13).
 *
 * Each image is read through a fresh one-time link (logic/imagingImages.ts, D105) and shown from a
 * blob: URL, labelled "Illustrative image" with its caption: never diagnostic. The display tools
 * only (pan, window/level, zoom, fit and reset, rotate, flip, invert): no marks, because marks are
 * kept in this browser. If an image can't be read, the screen says so and reads again; it never
 * shows another picture. Every time is the clinic's (D40).
 */

import { FileText, ImageOff, RotateCcw, ScanLine } from 'lucide-react'
import { useEffect, useState } from 'react'

import { formatClinicDateTime } from '../../../../shri-health/format'
import { patient } from '../../../../shri-health/kit'
import { usePatientImagingReports, type ImagingReportRow } from '../../../../shri-health/results'
import { ScreenFrame } from '../../app/ScreenFrame'
import { ILLUSTRATIVE, illustrativeSeries, loadImages, type LoadedImage } from '../../logic/imagingImages'
import { EmptyState } from '../../ui/EmptyState'
import { Card, Pill, PillTag } from '../../ui/primitives'

import { Workstation } from './Workstation'

const when = (at?: string) => (at ? formatClinicDateTime(at) : 'date not recorded')

export function ApiImageStudy({ patientId, reportId }: { patientId: string; reportId: string }) {
  const p = patient(patientId)
  const reports = usePatientImagingReports(patientId)
  const report = reports.items.find((r) => r.id === reportId)
  if (reports.denied || !report || report.images.length === 0) {
    return (
      <ScreenFrame screenId="S-15-04" patient={p} sub="No image at this address.">
        <Card className="max-w-[640px]">
          <EmptyState icon={ScanLine} why={reports.denied ? "Your role can't read imaging reports." : 'This report has no image to view. Its text is on the Imaging reports tab.'} />
        </Card>
      </ScreenFrame>
    )
  }
  return <ReportImages key={report.id} patient={p} report={report} />
}

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; loaded: LoadedImage[] }

function ReportImages({ patient: p, report: r }: { patient: ReturnType<typeof patient>; report: ImagingReportRow }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [slice, setSlice] = useState(1)

  useEffect(() => {
    let live = true
    let made: LoadedImage[] = []
    setLoad({ state: 'loading' })
    loadImages(r.images).then(
      (loaded) => {
        made = loaded
        if (live) setLoad({ state: 'ready', loaded })
        else loaded.forEach((l) => URL.revokeObjectURL(l.src))
      },
      () => live && setLoad({ state: 'error' }),
    )
    return () => {
      live = false
      made.forEach((l) => URL.revokeObjectURL(l.src))
    }
  }, [r.images, attempt])

  return (
    <ScreenFrame
      screenId="S-15-04"
      patient={p}
      sub={`${r.name} · studied ${when(r.studiedAt)}`}
      chips={
        <PillTag tone="neu" size="sm" icon={ScanLine}>
          {ILLUSTRATIVE}
        </PillTag>
      }
    >
      <div className="grid grid-cols-1 gap-[20px] xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:items-start">
        <div className="min-w-0">
          {load.state === 'ready' ? (
            <>
              <Workstation series={illustrativeSeries(r.id, r.name, load.loaded)} studyId={`illustrative:${r.id}`} slice={slice} onSlice={setSlice} marks={false} />
              <p className="mt-[10px] text-[13px] text-sh-text-2">
                <span className="font-semibold text-sh-text">{ILLUSTRATIVE}</span> · {load.loaded[slice - 1]?.image.caption}
              </p>
              <p className="mt-[4px] text-[12px] text-sh-text-3">Markings are not saved in this demo.</p>
            </>
          ) : load.state === 'error' ? (
            <Card>
              <EmptyState icon={ImageOff} why="Couldn't load the image. The link may have expired." />
              <div className="mt-[12px] flex justify-center">
                <Pill variant="primary" size="md" icon={RotateCcw} onClick={() => setAttempt((a) => a + 1)}>
                  Try again
                </Pill>
              </div>
            </Card>
          ) : (
            <div role="status" aria-label="Loading the image" className="mx-auto aspect-square w-full max-w-[min(100%,74vh)] animate-pulse rounded-[16px] bg-sh-inner" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-[16px]">
          <Card titleSize="sm" title="Report" right={<span className="text-[12px] text-sh-text-2">{r.status}</span>}>
            {r.impression && (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Impression</p>
                <p className="mt-[4px] text-[17px]/[1.5] text-sh-text">{r.impression}</p>
              </>
            )}
            {r.text && (
              <>
                <p className="mt-[12px] text-[11px] font-semibold uppercase tracking-[0.08em] text-sh-text-2">Full report</p>
                <p className="mt-[4px] whitespace-pre-line text-[14px]/[1.55] text-sh-text-2">{r.text}</p>
              </>
            )}
            <p className="mt-[12px] flex items-center gap-[6px] text-[12px] tabular-nums text-sh-text-3">
              <FileText size={13} aria-hidden="true" />
              Studied {when(r.studiedAt)}
              {r.performer && ` · ${r.performer}`}
              {r.issuedAt && ` · reported ${when(r.issuedAt)}`}
            </p>
          </Card>
          <Card titleSize="sm" title={r.images.length === 1 ? 'Image' : 'Images'}>
            <ul className="flex flex-col gap-[6px] text-[13px]" aria-label="Images on this report">
              {r.images.map((img, i) => (
                <li key={img.id}>
                  <button
                    type="button"
                    disabled={load.state !== 'ready'}
                    onClick={() => setSlice(i + 1)}
                    aria-current={slice === i + 1 ? 'true' : undefined}
                    className="w-full rounded-[12px] bg-sh-inner px-[12px] py-[8px] text-left text-sh-text hover:bg-sh-control disabled:opacity-60 aria-[current=true]:ring-2 aria-[current=true]:ring-sh-primary"
                  >
                    <span className="font-semibold">{img.label}</span> · {img.caption}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-[10px] text-[12px] text-sh-text-3">Illustrative, not diagnostic.</p>
          </Card>
        </div>
      </div>
    </ScreenFrame>
  )
}
