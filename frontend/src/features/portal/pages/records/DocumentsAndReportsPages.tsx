import { Download, Eye, FileArchive, FileText, Upload } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Alert, Button, formatPhone, Modal, problemCopy, Spinner, toUsDisplay, useToast } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { PortalDocument } from '../../api/types'
import { toProblem, useResource } from '../../api/useResource'
import { AsyncPanel, Card, formatInstantShort, formatShortDate, matches, PageHeader, saveBlob, SearchBox, Table } from '../../ui'

/* ---------- Patient Documents ---------- */

const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png'

export function PatientDocumentsPage() {
  const api = usePortalApi()
  const toast = useToast()
  const mine = useResource(() => api.listDocuments('patient'), [])
  const provider = useResource(() => api.listDocuments('provider'), [])
  const input = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ doc: PortalDocument; text: string } | null>(null)

  async function upload() {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) return setFailure('This file is over 10 MB. Choose a smaller one.')
    setUploading(true)
    setFailure(null)
    try {
      await api.uploadDocument(file)
      toast.show('Document uploaded')
      setFile(null)
      if (input.current) input.current.value = ''
      mine.reload()
    } catch (err) {
      setFailure(problemCopy(toProblem(err)).message)
    } finally {
      setUploading(false)
    }
  }

  async function view(doc: PortalDocument) {
    try {
      setViewing({ doc, text: await (await api.downloadDocument(doc.id)).text() })
    } catch (err) {
      toast.show(problemCopy(toProblem(err)).message, 'critical')
    }
  }

  async function download(doc: PortalDocument) {
    try {
      saveBlob(await api.downloadDocument(doc.id), doc.name)
    } catch (err) {
      toast.show(problemCopy(toProblem(err)).message, 'critical')
    }
  }

  return (
    <>
      <PageHeader title="Patient Documents" back={{ to: '/', label: 'Home' }} />
      <div className="space-y-6">
        <Card title="Patient Uploaded Documents">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-ink-muted">
                Upload a document <span className="font-normal text-ink-subtle">(PDF, JPG or PNG, up to 10 MB)</span>
              </label>
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-ink file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-border file:bg-surface-1 file:px-4 file:text-sm file:font-semibold file:text-ink hover:file:bg-surface-2"
              />
            </div>
            {file ? (
              <Button loading={uploading} icon={<Upload aria-hidden="true" size={16} />} onClick={upload}>
                Upload
              </Button>
            ) : null}
          </div>
          {failure ? <div className="mb-4"><Alert tone="critical" title="Upload failed">{failure}</Alert></div> : null}
          <AsyncPanel resource={mine} label="your documents">
            {(docs) => <DocumentTable docs={docs} empty="Documents not available" onView={view} onDownload={download} />}
          </AsyncPanel>
        </Card>
        <Card title="Provider Uploaded Documents">
          <AsyncPanel resource={provider} label="documents from your provider">
            {(docs) => <DocumentTable docs={docs} empty="Documents not available" onView={view} onDownload={download} />}
          </AsyncPanel>
        </Card>
      </div>
      <Modal open={viewing !== null} size="lg" title={viewing?.doc.name ?? ''} onClose={() => setViewing(null)}>
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-2 p-4 text-sm whitespace-pre-wrap text-ink">{viewing?.text}</pre>
      </Modal>
    </>
  )
}

function DocumentTable({ docs, empty, onView, onDownload }: { docs: PortalDocument[]; empty: string; onView: (d: PortalDocument) => void; onDownload: (d: PortalDocument) => void }) {
  const [q, setQ] = useState('')
  return (
    <>
      {docs.length ? (
        <div className="mb-3">
          <SearchBox value={q} onChange={setQ} label="Search documents" />
        </div>
      ) : null}
      <Table
        caption="Documents"
        empty={empty}
        rows={docs.filter((d) => matches(q, d.name, formatShortDate(d.date)))}
        rowKey={(d) => d.id}
        columns={[
          { header: 'Name', rowHeader: true, cell: (d) => d.name },
          { header: 'Date', cell: (d) => formatShortDate(d.date) },
          {
            header: 'Action',
            cell: (d) => (
              <span className="flex gap-1">
                <Button variant="ghost" size="sm" icon={<Eye aria-hidden="true" size={16} />} onClick={() => onView(d)} aria-label={`View ${d.name}`}>
                  View
                </Button>
                <Button variant="ghost" size="sm" icon={<Download aria-hidden="true" size={16} />} onClick={() => onDownload(d)} aria-label={`Download ${d.name}`}>
                  Download
                </Button>
              </span>
            ),
          },
        ]}
      />
    </>
  )
}

/* ---------- Reports ---------- */

const REPORTS = [
  { kind: 'ccr' as const, icon: FileArchive, title: 'Continuity of Care Record (CCR)', text: 'A summary of your health information in the standard CCR format, to share with another provider.', button: 'Generate CCR', file: 'patientreportccr.zip' },
  { kind: 'ccd' as const, icon: FileArchive, title: 'Continuity of Care Document (CCD)', text: 'Your health summary in the standard CCD format used by most health record systems.', button: 'Generate CCD', file: 'patientreportccd.zip' },
  { kind: 'pdf' as const, icon: FileText, title: 'Patient Care Report', text: 'A printable report of your problems, allergies, medicines and vaccines.', button: 'Download as PDF', file: 'PatientReport.pdf' },
]

export function ReportsPage() {
  const api = usePortalApi()
  const toast = useToast()
  const report = useResource(() => api.getPatientReport(), [])
  const [busy, setBusy] = useState<string | null>(null)

  async function download(kind: 'ccr' | 'ccd' | 'pdf', file: string) {
    setBusy(kind)
    try {
      // Mock files are text; the real API returns the zip and PDF.
      saveBlob(await api.downloadReport(kind), file.replace(/\.(zip|pdf)$/, '.txt'))
      toast.show('Report downloaded')
    } catch (err) {
      toast.show(problemCopy(toProblem(err)).message, 'critical')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader title="Patient Health Report" back={{ to: '/', label: 'Home' }} />
      <ul className="grid gap-3 md:grid-cols-3">
        {REPORTS.map(({ kind, icon: Icon, title, text, button, file }) => (
          <li key={kind} className="flex flex-col rounded-2xl border border-(--accent-line) bg-surface-1 p-4 shadow-card">
            <span aria-hidden="true" className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
              <Icon size={20} />
            </span>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="mt-1 flex-1 text-sm text-ink-muted">{text}</p>
            <Button className="mt-4" variant="outline" loading={busy === kind} icon={<Download aria-hidden="true" size={16} />} onClick={() => download(kind, file)}>
              {button}
            </Button>
          </li>
        ))}
      </ul>

      <section aria-labelledby="report-heading" className="mt-6 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
        <h2 id="report-heading" className="mb-4 text-lg font-semibold text-ink">
          Patient Report
        </h2>
        {report.status === 'loading' ? (
          <Spinner label="Loading your report" />
        ) : (
          <AsyncPanel resource={report} label="your report">
            {(r) => (
              <div className="space-y-5 text-sm text-ink">
                <p className="text-ink-muted">
                  {r.patient.name} · Born {formatShortDate(r.patient.birthDate)} · {r.patient.sex} · {r.patient.address} · {formatPhone(r.patient.phone)}
                  <br />
                  Generated {formatInstantShort(r.generatedAt, 'America/Chicago')}
                </p>
                <ReportList title="Medical Problems" items={r.issues.map((h) => `${h.title} (${h.diagnosis})${h.endDate ? ', resolved' : ''}`)} />
                <ReportList title="Allergies" items={r.allergies.map((a) => `${a.title}: ${a.reaction}`)} />
                <ReportList title="Medications" items={r.prescriptions.map((p) => `${p.drug}${p.note ? `: ${p.note}` : ''}`)} />
                <ReportList title="Immunizations" items={r.immunizations.map((i) => `${i.vaccine}, ${formatShortDate(i.administeredDate)}`)} />
                {r.vitals ? (
                  <ReportList
                    title="Latest Vitals"
                    items={[
                      r.vitals.systolic && r.vitals.diastolic ? `Blood pressure ${r.vitals.systolic}/${r.vitals.diastolic} mmHg` : '',
                      r.vitals.pulse ? `Pulse ${r.vitals.pulse} /min` : '',
                      r.vitals.weight ? `Weight ${toUsDisplay(r.vitals.weight).text}` : '',
                      r.vitals.bmi ? `BMI ${r.vitals.bmi.toFixed(1)}` : '',
                    ].filter(Boolean)}
                  />
                ) : null}
              </div>
            )}
          </AsyncPanel>
        )}
      </section>
    </>
  )
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-1 font-semibold">{title}</h3>
      {items.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted">None recorded.</p>
      )}
    </div>
  )
}
