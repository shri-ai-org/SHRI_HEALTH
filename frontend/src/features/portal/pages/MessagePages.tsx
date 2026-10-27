import { PenLine, Trash2 } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { Alert, Button, ConfirmDialog, Field, Modal, problemCopy, Select, TextInput, useToast } from '../../../design-system'
import { cn } from '../../../design-system/lib/cn'
import { usePortalApi } from '../api/portalApi'
import { MESSAGE_SUBJECTS, type Message, type MessageSubject } from '../api/types'
import { toProblem, useResource } from '../api/useResource'
import { Link, useRouter } from '../router'
import { useSession } from '../session'
import { AsyncPanel, ErrorSummary, matches, PageHeader, Pager, SearchBox, usePaged } from '../ui'

type Folder = 'inbox' | 'sent' | 'trash'
const TITLES: Record<Folder, string> = { inbox: 'Inbox', sent: 'Sent', trash: 'Trash' }
const TZ = 'America/Chicago'

function when(instant: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
}

/** Folder list with counts, as in the old portal's left column. */
function Folders({ current }: { current: Folder }) {
  const api = usePortalApi()
  const counts = useResource(() => Promise.all((['inbox', 'sent', 'trash'] as const).map((f) => api.listMessages(f))), [current])
  return (
    <nav aria-label="Message folders" className="rounded-2xl border border-(--accent-line) bg-surface-1 p-2 shadow-card">
      <p className="px-3 pt-1 pb-2 text-sm font-semibold text-ink">Messages</p>
      <ul className="flex gap-1 lg:flex-col">
        {(['inbox', 'sent', 'trash'] as const).map((f, i) => {
          const n = counts.status === 'ready' ? (counts.data[i]?.items.length ?? 0) : null
          return (
            <li key={f} className="flex-1">
              <Link
                to={`/messages/${f}`}
                {...(f === current ? { 'aria-current': 'page' as const } : {})}
                className={cn('flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-sm', f === current ? 'bg-primary-50 font-semibold text-primary-700' : 'text-ink hover:bg-surface-2')}
              >
                {TITLES[f]}
                {n !== null ? <span className="text-xs text-ink-subtle tabular-nums">{n}</span> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export function MessagesPage({ folder }: { folder: Folder }) {
  const api = usePortalApi()
  const list = useResource(() => api.listMessages(folder), [folder])
  return (
    <>
      <PageHeader title={`${TITLES[folder]} Messages`} back={{ to: '/', label: 'Home' }} />
      <div className="grid gap-5 lg:grid-cols-[13rem_1fr]">
        <Folders current={folder} />
        <AsyncPanel resource={list} label="messages">
          {(page) => <MessageTable key={folder} folder={folder} items={page.items} onChanged={list.reload} onRead={(id) => list.status === 'ready' && list.setData((p) => ({ ...p, items: p.items.map((m) => (m.id === id ? { ...m, read: true } : m)) }))} />}
        </AsyncPanel>
      </div>
    </>
  )
}

function MessageTable({ folder, items, onChanged, onRead }: { folder: Folder; items: Message[]; onChanged: () => void; onRead: (id: string) => void }) {
  const api = usePortalApi()
  const toast = useToast()
  const { navigate } = useRouter()
  const filterId = useId()
  const [subject, setSubject] = useState<'All' | MessageSubject>('All')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<Message | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const subjects = Array.from(new Set(items.map((m) => m.subject)))
  const who = (m: Message) => (folder === 'sent' ? m.to.displayName : m.from.displayName)
  const shown = items.filter((m) => (subject === 'All' || m.subject === subject) && matches(q, who(m), m.subject, m.body, when(m.sentAt)))
  const paged = usePaged(shown, 10)
  const allOnPage = paged.rows.length > 0 && paged.rows.every((m) => selected.includes(m.id))

  async function act(kind: 'trash' | 'delete') {
    setBusy(true)
    try {
      if (kind === 'trash') await api.moveMessagesToTrash(selected)
      else await api.deleteMessagesFromTrash(selected)
      toast.show(kind === 'trash' ? 'Message moved to trash successfully' : 'Message deleted successfully')
      setSelected([])
      setConfirmDelete(false)
      onChanged()
    } catch (err) {
      toast.show(problemCopy(toProblem(err)).message, 'critical')
    } finally {
      setBusy(false)
    }
  }

  function read(m: Message) {
    setOpen(m)
    if (!m.read) {
      onRead(m.id)
      void api.markMessageRead(m.id).catch(() => undefined)
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="outline"
          icon={<Trash2 aria-hidden="true" size={16} />}
          disabled={!selected.length}
          loading={busy && !confirmDelete}
          onClick={() => (folder === 'trash' ? setConfirmDelete(true) : act('trash'))}
        >
          {folder === 'trash' ? 'Delete' : 'Move to trash'}
          {selected.length ? ` (${selected.length})` : ''}
        </Button>
        <Button icon={<PenLine aria-hidden="true" size={16} />} onClick={() => navigate('/messages/compose')}>
          Compose
        </Button>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={filterId} className="mb-1 block text-xs font-medium text-ink-muted">
              Filter by subject
            </label>
            <Select id={filterId} value={subject} onChange={(e) => setSubject(e.target.value as typeof subject)}>
              <option>All</option>
              {subjects.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </div>
          <SearchBox value={q} onChange={setQ} label="Search messages" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <caption className="sr-only">{TITLES[folder]} messages</caption>
          <thead className="bg-(--accent-soft) text-xs font-bold tracking-wide text-(--accent-text) uppercase">
            <tr>
              <th scope="col" className="w-12 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="size-5 accent-primary-600"
                  aria-label="Select all messages on this page"
                  checked={allOnPage}
                  onChange={(e) => setSelected((s) => (e.target.checked ? Array.from(new Set([...s, ...paged.rows.map((m) => m.id)])) : s.filter((id) => !paged.rows.some((m) => m.id === id))))}
                />
              </th>
              <th scope="col" className="px-3 py-2.5 font-semibold">{folder === 'sent' ? 'To' : 'From'}</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Date</th>
              <th scope="col" className="px-3 py-2.5 font-semibold">Subject</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.length ? (
              paged.rows.map((m) => {
                const unread = folder === 'inbox' && !m.read
                return (
                  <tr key={m.id} className={cn('border-t border-border-soft hover:bg-surface-2', unread && 'bg-primary-50/50')}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-5 accent-primary-600"
                        aria-label={`Select message: ${m.subject}, ${who(m)}`}
                        checked={selected.includes(m.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? [...s, m.id] : s.filter((x) => x !== m.id)))}
                      />
                    </td>
                    <td className={cn('px-3 py-2', unread ? 'font-semibold text-ink' : 'text-ink')}>
                      {unread ? <span className="sr-only">Unread. </span> : null}
                      {who(m)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-ink-muted">{when(m.sentAt)}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => read(m)} className={cn('min-h-11 text-left text-primary-700 underline-offset-2 hover:underline', unread && 'font-semibold')}>
                        {m.subject}
                      </button>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-ink-muted">
                  No data to display
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager {...paged} noun="messages" />

      <Modal open={open !== null} title={TITLES[folder]} onClose={() => setOpen(null)} footer={<Button variant="outline" onClick={() => setOpen(null)}>Discard</Button>}>
        {open ? (
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[6rem_1fr]">
            <dt className="font-medium text-ink-subtle">From</dt>
            <dd className="text-ink">{open.from.displayName}</dd>
            <dt className="font-medium text-ink-subtle">To</dt>
            <dd className="text-ink">{open.to.displayName}</dd>
            <dt className="font-medium text-ink-subtle">Date</dt>
            <dd className="text-ink">{when(open.sentAt)}</dd>
            <dt className="font-medium text-ink-subtle">Subject</dt>
            <dd className="text-ink">{open.subject}</dd>
            <dt className="font-medium text-ink-subtle">Message</dt>
            <dd className="leading-relaxed whitespace-pre-line text-ink">{open.body}</dd>
          </dl>
        ) : null}
      </Modal>

      <ConfirmDialog open={confirmDelete} title="Delete these messages?" confirmLabel="Delete" confirmVariant="danger" busy={busy} onConfirm={() => act('delete')} onCancel={() => setConfirmDelete(false)}>
        {selected.length === 1 ? 'This message' : `These ${selected.length} messages`} will be removed from your trash. This can't be undone.
      </ConfirmDialog>
    </div>
  )
}

/** The old "Compose Messages": From (you), To, Subject from the old list, Message, Send and Cancel. */
export function ComposePage() {
  const api = usePortalApi()
  const { session } = useSession()
  const { navigate } = useRouter()
  const recipients = useResource(() => api.listRecipients(), [])
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState<MessageSubject | ''>('')
  const [body, setBody] = useState('')
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message

  async function send(e: FormEvent) {
    e.preventDefault()
    const found: typeof errors = []
    if (!to) found.push({ fieldId: 'cm-to', message: 'Choose who the message is for' })
    if (!subject) found.push({ fieldId: 'cm-subject', message: 'Select a subject' })
    if (!body.trim()) found.push({ fieldId: 'cm-body', message: 'Write your message' })
    setErrors(found)
    setSent(false)
    if (found.length || !subject) return
    setBusy(true)
    setFailure(null)
    try {
      await api.sendMessage({ recipientId: to, subject, body: body.trim() })
      setSent(true)
      setTo('')
      setSubject('')
      setBody('')
    } catch (error) {
      setFailure(problemCopy(toProblem(error)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Compose Messages" back={{ to: '/messages/inbox', label: 'Inbox' }} />
      <div className="max-w-2xl space-y-4">
        {sent ? <Alert tone="success" title="Message sent successfully.">You'll find it in your Sent folder.</Alert> : null}
        <Alert tone="warning" title="Not for emergencies">For a medical emergency, call 911. For urgent symptoms, call the clinic.</Alert>
        <AsyncPanel resource={recipients} label="your providers">
          {(list) => (
            <form noValidate onSubmit={send} className="space-y-4 rounded-2xl border border-(--accent-line) bg-surface-1 p-5 shadow-card">
              <ErrorSummary errors={errors} />
              {failure ? <Alert tone="critical" title="Message not sent">{failure} Your message is still here.</Alert> : null}
              <Field id="cm-from" label="From">
                {(p) => <TextInput {...p} readOnly value={session.patient.displayName} className="bg-surface-2" />}
              </Field>
              <Field id="cm-to" label="To" required error={err('cm-to')}>
                {(p) => (
                  <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Select a provider</option>
                    {list.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="cm-subject" label="Subject" required error={err('cm-subject')}>
                {(p) => (
                  <Select {...p} value={subject} onChange={(e) => setSubject(e.target.value as MessageSubject)}>
                    <option value="">Select subject</option>
                    {MESSAGE_SUBJECTS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field id="cm-body" label="Message" hint={`${body.length} of 2000 characters`} required error={err('cm-body')}>
                {(p) => (
                  <textarea
                    {...p}
                    rows={8}
                    maxLength={2000}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-1 px-3.5 py-2.5 text-sm text-ink aria-invalid:border-critical-fg"
                  />
                )}
              </Field>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => navigate('/messages/inbox')}>
                  Cancel
                </Button>
                <Button type="submit" size="lg" loading={busy}>
                  Send
                </Button>
              </div>
            </form>
          )}
        </AsyncPanel>
      </div>
    </>
  )
}
