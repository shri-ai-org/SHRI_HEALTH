/**
 * The print preview — one modal for every "Print" (`src/components/print.tsx`).
 * There is no print server in this build, so the preview is the deliverable:
 * what the ward printer would put on paper, the patient line on top and each
 * section under its heading. "Print" hands it to the browser's own print
 * dialog, which is real, and says which printer the ward would normally use.
 * The paper is paper-white with dark ink in both themes (`--paper-*`).
 */

import { Printer, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { HUB, type Patient } from '@/data/kit'
import { useUI } from '@/store/ui'

import { Dialog } from './Dialog'
import { Pill } from './primitives'

export interface PrintSection {
  heading: string
  body: string
  /** Rendered with the raised line height Indic scripts need. */
  lang?: string
}

export function PrintPreview({
  open,
  onClose,
  title,
  patient,
  meta,
  sections,
  paper = 'A4',
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  patient?: Patient
  /** One line under the title — encounter number, who signed, when. */
  meta?: string
  sections: PrintSection[]
  paper?: 'A4' | 'A5'
  footer?: ReactNode
}) {
  const toast = useUI((s) => s.toast)
  const printer = patient?.bed ? `${patient.bed.split('-')[0]} ward printer` : 'OPD front-desk printer'

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={760}
      icon={Printer}
      title={`Print preview · ${paper}`}
      subtitle={`${HUB.name} · ${printer}`}
      footer={
        <>
          {footer}
          <Pill variant="control" size="lg" icon={X} onClick={onClose}>
            Close
          </Pill>
          <Pill
            variant="primary"
            size="lg"
            icon={Printer}
            onClick={() => {
              toast({ tone: 'success', title: 'Sent to print', detail: `${title} · ${paper} · ${printer}.` })
              onClose()
              try {
                window.print()
              } catch {
                /* a browser without a print dialog — the toast has already said what happened */
              }
            }}
          >
            Print
          </Pill>
        </>
      }
    >
      <article
        className="mx-auto max-h-[60dvh] overflow-y-auto rounded-[12px] px-[32px] py-[28px] shadow-sh-pop"
        style={{ maxWidth: paper === 'A5' ? '30rem' : '40rem', background: 'var(--paper)', color: 'var(--paper-ink)' }}
      >
        <header className="pb-[12px]" style={{ borderBottom: '1px solid var(--paper-line)' }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--paper-muted)' }}>
            {HUB.name}
          </p>
          <h1 className="mt-[4px] text-[20px] font-bold">{title}</h1>
          {patient && (
            <p className="mt-[4px] text-[14px]">
              <span className="font-semibold">{patient.name}</span>
              {patient.nameNative && <span className="ml-[6px]">{patient.nameNative}</span>} · {patient.age}/{patient.sex} ·{' '}
              <span className="tabular-nums">{patient.uhid}</span>
              {patient.bed && ` · ${patient.bed}`}
            </p>
          )}
          {meta && (
            <p className="mt-[4px] text-[13px] tabular-nums" style={{ color: 'var(--paper-muted)' }}>
              {meta}
            </p>
          )}
        </header>
        <div className="mt-[16px] flex flex-col gap-[16px]">
          {sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-[11px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--paper-heading)' }}>
                {s.heading}
              </h2>
              {s.body.trim() === '' ? (
                <p className="mt-[4px] text-[14px] italic" style={{ color: 'var(--paper-faint)' }}>
                  Not recorded.
                </p>
              ) : (
                <div className={s.lang ? 'mt-[4px] flex flex-col gap-[8px] leading-loose' : 'mt-[4px] flex flex-col gap-[8px] leading-relaxed'} lang={s.lang}>
                  {s.body.split(/\n{2,}/).map((para, i) => (
                    <p key={i} className="text-[14px]">
                      {para}
                    </p>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </article>
    </Dialog>
  )
}
