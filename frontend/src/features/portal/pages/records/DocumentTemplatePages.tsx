import { PenLine, Printer, Save, Send, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Alert, Badge, Button, ConfirmDialog, DateInput, Field, formatDate, Modal, problemCopy, Select, TextInput, useToast, type BadgeTone } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { DocumentTemplate } from '../../api/types'
import { toProblem, useResource } from '../../api/useResource'
import { Link } from '../../router'
import { SignaturePad, type SignaturePadHandle } from '../../SignaturePad'
import { AsyncPanel, formatInstantShort, PageHeader, Table, tableLink } from '../../ui'

const TZ = 'America/Chicago'

const REVIEW: Record<DocumentTemplate['reviewStatus'], { label: string; tone: BadgeTone }> = {
  'not-sent': { label: 'Not sent', tone: 'neutral' },
  'waiting-review': { label: 'Waiting for review', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  denied: { label: 'Denied', tone: 'critical' },
}

export function DocumentTemplatesPage() {
  const api = usePortalApi()
  const list = useResource(() => api.listTemplates(), [])
  return (
    <>
      <PageHeader title="Document Template" description="Patient document templates from your clinic. Open one to fill it in, sign it and send it for review." back={{ to: '/', label: 'Home' }} />
      <AsyncPanel resource={list} label="document templates">
        {(items) => (
          <Table
            caption="Patient document templates"
            empty="No documents to fill in"
            rows={items}
            rowKey={(t) => t.id}
            columns={[
              { header: 'Document', rowHeader: true, cell: (t) => <Link to={`/document-templates/${t.id}`} className={tableLink}>{t.name}</Link> },
              { header: 'Create Date', cell: (t) => formatInstantShort(t.createdAt, TZ) },
              { header: 'Review Date', cell: (t) => (t.reviewedAt ? formatInstantShort(t.reviewedAt, TZ) : '—') },
              { header: 'Reviewed Status', cell: (t) => <Badge tone={REVIEW[t.reviewStatus].tone}>{REVIEW[t.reviewStatus].label}</Badge> },
              { header: 'Patient Signed Status', cell: (t) => <Badge tone={t.signed ? 'success' : 'warning'}>{t.signed ? 'Signed' : 'Not signed'}</Badge> },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  )
}

export function DocumentTemplatePage({ templateId }: { templateId: string }) {
  const api = usePortalApi()
  const template = useResource(() => api.getTemplate(templateId), [templateId])
  return (
    <>
      <PageHeader title={template.status === 'ready' ? template.data.name : 'Document'} back={{ to: '/document-templates', label: 'Document Template' }} />
      <AsyncPanel resource={template} label="this document">
        {(t) => <TemplateEditor t={t} onChange={(next) => template.status === 'ready' && template.setData(() => next)} />}
      </AsyncPanel>
    </>
  )
}

function TemplateEditor({ t, onChange }: { t: DocumentTemplate; onChange: (t: DocumentTemplate) => void }) {
  const api = usePortalApi()
  const toast = useToast()
  const [values, setValues] = useState<Record<string, string>>(t.values)
  const [busy, setBusy] = useState<'save' | 'review' | 'delete' | 'sign' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [signEmpty, setSignEmpty] = useState(true)
  const pad = useRef<SignaturePadHandle>(null)
  const locked = t.reviewStatus === 'waiting-review' || t.reviewStatus === 'accepted'

  async function run(kind: 'save' | 'review' | 'delete' | 'sign', fn: () => Promise<DocumentTemplate>, done: string) {
    setBusy(kind)
    setFailure(null)
    try {
      const next = await fn()
      onChange(next)
      setValues(next.values)
      toast.show(done)
      return true
    } catch (err) {
      const p = toProblem(err)
      setFailure(p.errors?.some((e) => e.pointer === '/signature') ? 'Sign the document before sending it for review.' : problemCopy(p).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  const input = (f: DocumentTemplate['fields'][number]) => {
    const v = values[f.id] ?? ''
    const set = (nv: string) => setValues((x) => ({ ...x, [f.id]: nv }))
    return (
      <Field key={f.id} id={`tf-${f.id}`} label={f.label} {...(f.kind === 'date' ? { hint: 'MM/DD/YYYY' } : {})}>
        {(p) =>
          locked ? (
            <p id={p.id} className="min-h-11 rounded-lg bg-surface-2 px-3.5 py-2.5 text-sm text-ink">
              {f.kind === 'date' && v ? formatDate(v) : v || '—'}
            </p>
          ) : f.kind === 'textarea' ? (
            <textarea {...p} rows={3} value={v} onChange={(e) => set(e.target.value)} className="w-full rounded-lg border border-border bg-surface-1 px-3.5 py-2.5 text-sm text-ink" />
          ) : f.kind === 'date' ? (
            <DateInput {...p} value={v} onValueChange={(d) => set(d ?? '')} />
          ) : f.kind === 'yes-no' ? (
            <Select {...p} value={v} onChange={(e) => set(e.target.value)}>
              <option value="">Select an option</option>
              <option>Yes</option>
              <option>No</option>
            </Select>
          ) : (
            <TextInput {...p} value={v} onChange={(e) => set(e.target.value)} />
          )
        }
      </Field>
    )
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_14rem]">
      <article className="space-y-5 rounded-2xl border border-(--accent-line) bg-surface-1 p-6 shadow-card print:border-0 print:shadow-none">
        {failure ? <Alert tone="critical" title="Couldn't do that">{failure}</Alert> : null}
        {locked ? <Alert tone="info" title={t.reviewStatus === 'accepted' ? 'Accepted by your clinic. This document can no longer be changed.' : 'Sent for review. You can change it again if the clinic sends it back.'} /> : null}
        <p className="text-sm leading-relaxed text-ink">{t.intro}</p>
        {t.fields.length ? <div className="grid gap-4 sm:grid-cols-2">{t.fields.map(input)}</div> : null}
        {t.closing ? <p className="text-sm text-ink-muted">{t.closing}</p> : null}
        <div>
          <p className="mb-1 text-sm font-medium text-ink-muted">Patient signature</p>
          {t.signature ? (
            <img src={t.signature} alt="Your signature on this document" className="h-24 rounded-lg border border-border-soft bg-white p-1" />
          ) : (
            <p className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-sm text-ink-subtle">Not signed yet</p>
          )}
        </div>
      </article>

      <aside aria-label="Document actions" className="flex flex-col gap-2 print:hidden">
        <Button variant="outline" icon={<Save aria-hidden="true" size={16} />} disabled={locked} loading={busy === 'save'} onClick={() => run('save', () => api.saveTemplate(t.id, { values }), 'Document saved')}>
          Save
        </Button>
        <Button variant="outline" icon={<PenLine aria-hidden="true" size={16} />} disabled={locked} onClick={() => setSigning(true)}>
          Signature
        </Button>
        <Button icon={<Send aria-hidden="true" size={16} />} disabled={locked} loading={busy === 'review'} onClick={() => run('review', async () => { await api.saveTemplate(t.id, { values }); return api.sendTemplateForReview(t.id) }, 'Sent to your clinic for review')}>
          Review
        </Button>
        <Button variant="outline" icon={<Printer aria-hidden="true" size={16} />} onClick={() => window.print()}>
          Print
        </Button>
        <Button variant="ghost" icon={<Trash2 aria-hidden="true" size={16} />} disabled={locked} onClick={() => setConfirmDelete(true)}>
          Delete Document
        </Button>
        <p className="mt-2 text-xs text-ink-subtle">Save keeps your answers. Review saves and sends the signed document to your clinic.</p>
      </aside>

      <Modal
        open={signing}
        size="lg"
        title="Sign this document"
        onClose={() => setSigning(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => pad.current?.clear()}>
              Clear
            </Button>
            <Button
              disabled={signEmpty}
              loading={busy === 'sign'}
              onClick={async () => {
                const image = pad.current?.toDataUrl() ?? ''
                if (await run('sign', () => api.saveTemplate(t.id, { values, signature: image }), 'Signature added')) setSigning(false)
              }}
            >
              Add signature
            </Button>
          </>
        }
      >
        <SignaturePad ref={pad} label="Signature box" onChange={setSignEmpty} />
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete your answers?"
        confirmLabel="Delete"
        confirmVariant="danger"
        busy={busy === 'delete'}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await run('delete', () => api.deleteTemplateDraft(t.id), 'Your answers and signature were removed')
          setConfirmDelete(false)
        }}
      >
        This clears your answers and signature on {t.name}. The blank document stays in your list.
      </ConfirmDialog>
    </div>
  )
}
