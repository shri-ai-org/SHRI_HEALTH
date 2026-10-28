import { CalendarPlus, CalendarX, ExternalLink, MapPin, Video } from 'lucide-react'
import { useRef, useState } from 'react'
import type { PortalAppointment } from '../../../../api/generated/model'
import { Alert, Badge, Button, EmptyState, Field, formatAddressLines, formatTime, isOverLimit, Modal, problemCopy, Textarea, useToast } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import { toProblem, useResource } from '../../api/useResource'
import { Link, useRouter } from '../../router'
import { AppointmentStatusBadge, AsyncPanel, Card, DefinitionList, formatLongDay, formatShortDate, HeldMarker, matches, PageHeader, Pager, SearchBox, Table, usePaged } from '../../ui'

/* ---------- My Appointments ---------- */

export function AppointmentsPage() {
  const api = usePortalApi()
  const { navigate } = useRouter()
  // The server splits upcoming from past (`when`), in each facility's time.
  const list = useResource(() => Promise.all([api.listAppointments('upcoming'), api.listAppointments('past')]), [])
  return (
    <>
      <PageHeader
        title="My Appointments"
        back={{ to: '/', label: 'Home' }}
        actions={
          <Button icon={<CalendarPlus aria-hidden="true" size={16} />} onClick={() => navigate('/appointments/schedule')}>
            Add appointment
          </Button>
        }
      />
      <AsyncPanel resource={list} label="your appointments">
        {([upcoming, past]) => (
          <div className="space-y-8">
            <section aria-labelledby="upcoming-heading">
              <h2 id="upcoming-heading" className="mb-3 text-lg font-semibold text-ink">
                Upcoming Appointments
              </h2>
              {upcoming.length ? <Tiles list={upcoming} /> : <EmptyState title="No upcoming appointments" />}
            </section>
            <section aria-labelledby="past-heading">
              <h2 id="past-heading" className="mb-3 text-lg font-semibold text-ink">
                Past Appointments
              </h2>
              {past.length ? <PastTiles list={[...past].sort((a, b) => b.startAt.localeCompare(a.startAt))} /> : <EmptyState title="No past appointments" />}
            </section>
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

function PastTiles({ list }: { list: PortalAppointment[] }) {
  const paged = usePaged(list, 5)
  return (
    <>
      <Tiles list={paged.rows} />
      <Pager {...paged} />
    </>
  )
}

/** The old date tiles: month and year, big day number, weekday and time, provider and location. */
function Tiles({ list }: { list: PortalAppointment[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((a) => {
        const tz = a.timeZone
        const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(a.startAt))
        // A past visit opens its summary once there is one (available or held, D86).
        const to = a.status !== 'booked' && a.visitSummaryId ? `/visit-summaries/${a.visitSummaryId}` : `/appointments/${a.id}`
        return (
          <li key={a.id}>
            <Link to={to} className="flex h-full items-center gap-4 rounded-2xl border border-(--accent-line) bg-surface-1 p-3 shadow-card hover:border-primary-200 hover:shadow-card-lg">
              <span aria-hidden="true" className="flex w-20 shrink-0 flex-col items-center rounded-lg bg-primary-50 py-2 text-primary-700">
                <span className="text-xs font-semibold">{part({ month: 'short', year: 'numeric' })}</span>
                <span className="text-3xl leading-none font-bold">{part({ day: '2-digit' })}</span>
                <span className="text-xs">
                  {part({ weekday: 'short' })} {formatTime(a.startAt, tz, { withZone: false })}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="sr-only">{`${part({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at ${formatTime(a.startAt, tz)}. `}</span>
                <span className="block text-sm font-semibold text-ink">{a.provider.displayName}</span>
                <span className="mt-0.5 flex items-center gap-1 text-sm text-ink-muted">
                  {a.telehealth ? <Video aria-hidden="true" size={14} /> : <MapPin aria-hidden="true" size={14} />}
                  {a.telehealth ? 'Video visit' : a.facility.name}
                </span>
                <span className="mt-1 block">
                  <AppointmentStatusBadge status={a.status} />
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- Upcoming Visit Details ---------- */

const CANCEL_REASON_LIMIT = 500

export function UpcomingAppointmentPage({ appointmentId }: { appointmentId: string }) {
  const api = usePortalApi()
  const appt = useResource(() => api.getAppointment(appointmentId), [appointmentId])
  const { navigate } = useRouter()
  const [cancelling, setCancelling] = useState(false)

  return (
    <>
      <PageHeader title="Upcoming Visit Details" back={{ to: '/appointments', label: 'My Appointments' }} />
      <AsyncPanel resource={appt} label="this appointment">
        {(a) => {
          const tz = a.timeZone
          const when = `${formatLongDay(a.startAt, tz)}, ${new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date(a.startAt))}, ${formatTime(a.startAt, tz)}`
          return (
            <div className="max-w-3xl space-y-4">
              {a.status !== 'booked' ? <Alert tone="info" title="This appointment is no longer upcoming." /> : null}
              <Card>
                <DefinitionList
                  items={[
                    { term: 'Provider', value: a.provider.displayName },
                    { term: 'Appointment Date and Time', value: when },
                    { term: 'Appointment Type', value: a.appointmentType.name },
                    { term: 'Reason for Visit', value: a.reasonForVisit ?? '—' },
                    {
                      term: 'Address',
                      value: a.telehealth ? (
                        'Video visit'
                      ) : (
                        <>
                          <span className="block">{a.facility.name}</span>
                          {(a.facility.address ? formatAddressLines(a.facility.address) : []).map((l) => (
                            <span key={l} className="block">
                              {l}
                            </span>
                          ))}
                        </>
                      ),
                    },
                    ...(a.patientInstruction ? [{ term: 'Instructions', value: a.patientInstruction }] : []),
                    { term: 'Status', value: <AppointmentStatusBadge status={a.status} /> },
                  ]}
                />
                {a.status === 'booked' && (a.canReschedule || a.canCancel) ? (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-border-soft pt-4">
                    {a.canReschedule ? (
                      <Button variant="outline" icon={<CalendarPlus aria-hidden="true" size={16} />} onClick={() => navigate(`/appointments/${a.id}/reschedule`)}>
                        Reschedule Appointment
                      </Button>
                    ) : null}
                    {a.canCancel ? (
                      <Button variant="outline" icon={<CalendarX aria-hidden="true" size={16} />} onClick={() => setCancelling(true)}>
                        Cancel Appointment
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {a.status === 'booked' && !a.canCancel && !a.canReschedule ? (
                  <p className="mt-4 text-sm text-ink-muted">To change this appointment, please call the clinic.</p>
                ) : null}
              </Card>
              <p className="text-sm text-ink-muted">
                If you must cancel, please do so as far in advance as possible. This helps us offer the time to other patients who are waiting for an appointment.
              </p>
              {cancelling ? <CancelDialog appointment={a} when={when} onClose={() => setCancelling(false)} /> : null}
            </div>
          )
        }}
      </AsyncPanel>
    </>
  )
}

/** Cancelling needs a reason (M20); the practice sees it, and it may be too late to cancel online. */
function CancelDialog({ appointment, when, onClose }: { appointment: PortalAppointment; when: string; onClose: () => void }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  async function cancel() {
    const text = reason.trim()
    if (!text) return setError('Tell us why you are canceling.')
    if (isOverLimit(text, CANCEL_REASON_LIMIT)) return setError(`Shorten the reason to ${CANCEL_REASON_LIMIT} characters or fewer.`)
    setError(null)
    setFailure(null)
    setBusy(true)
    try {
      await api.cancelAppointment(appointment.id, text)
      toast.show('Your appointment is canceled')
      navigate('/appointments')
    } catch (err) {
      const p = toProblem(err)
      setFailure(p.status === 422 || p.status === 409 ? 'This appointment can no longer be canceled online. Please call the clinic.' : problemCopy(p).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title="Cancel this appointment?"
      onClose={onClose}
      initialFocus={reasonRef}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep appointment
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void cancel()}>
            Cancel appointment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {failure ? <Alert tone="critical" title="Couldn't cancel">{failure}</Alert> : null}
        <p>
          Your appointment on {when} with {appointment.provider.displayName} will be canceled.
        </p>
        <Field label="Reason for canceling" required error={error ?? undefined}>
          {(p) => <Textarea {...p} ref={reasonRef} value={reason} limit={CANCEL_REASON_LIMIT} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  )
}

/* ---------- Visit Summary ---------- */

export function VisitSummaryPage({ visitSummaryId }: { visitSummaryId: string }) {
  const api = usePortalApi()
  const summary = useResource(() => api.getVisitSummary(visitSummaryId), [visitSummaryId])
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function open() {
    setOpening(true)
    setFailure(null)
    try {
      // A short-lived link, opened at once and never kept (D86).
      const { url } = await api.getVisitSummaryDownloadUrl(visitSummaryId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setFailure(problemCopy(toProblem(err)).message)
    } finally {
      setOpening(false)
    }
  }

  return (
    <>
      <PageHeader title="Visit Summary" back={{ to: '/appointments', label: 'My Appointments' }} />
      <AsyncPanel resource={summary} label="the visit summary">
        {(s) => (
          <div className="max-w-3xl space-y-4">
            {failure ? <Alert tone="critical" title="Couldn't open the visit summary">{failure}</Alert> : null}
            <Card>
              <DefinitionList
                items={[
                  { term: 'Visit Date', value: formatShortDate(s.visitDate) },
                  ...(s.providerDisplayName ? [{ term: 'Provider', value: s.providerDisplayName }] : []),
                  ...(s.facilityName ? [{ term: 'Location', value: s.facilityName }] : []),
                  { term: 'Summary', value: s.releaseStatus === 'held' ? <HeldMarker what="visit summary" /> : <Badge tone="success">Available</Badge> },
                ]}
              />
              {s.releaseStatus === 'available' ? (
                <div className="mt-5 border-t border-border-soft pt-4">
                  <Button loading={opening} icon={<ExternalLink aria-hidden="true" size={16} />} onClick={() => void open()}>
                    Open visit summary
                  </Button>
                </div>
              ) : null}
            </Card>
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Video Consult (P1, hidden: PORTAL_FEATURES.video) ---------- */

/** The room opens 15 minutes before the start, until the visit ends. */
const ROOM_OPENS_MS = 15 * 60_000

/** The old "Video Consulting" page, listing the patient's video visits with a Join button. */
export function VideoConsultPage() {
  const api = usePortalApi()
  const toast = useToast()
  const list = useResource(() => api.listAppointments('upcoming'), [])
  const [q, setQ] = useState('')
  const [joining, setJoining] = useState<string | null>(null)
  // When the page opened; the Join button appears for rooms already open then.
  const [now] = useState(() => Date.now())
  const roomOpen = (a: PortalAppointment) => Date.parse(a.startAt) - ROOM_OPENS_MS <= now && now < Date.parse(a.endAt)

  async function join(a: PortalAppointment) {
    setJoining(a.id)
    try {
      const { joinUrl } = await api.joinVideoVisit(a.id)
      window.open(joinUrl, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toast.show(problemCopy(toProblem(err)).message, 'critical')
    } finally {
      setJoining(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Video Consulting"
        description="HIPAA-compliant video consulting at your convenience. For a medical emergency, call 911."
        back={{ to: '/', label: 'Home' }}
        actions={
          <Link to="/appointments/schedule" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 text-sm font-semibold text-ink hover:bg-surface-2">
            <CalendarPlus aria-hidden="true" size={16} /> Schedule a video visit
          </Link>
        }
      />
      <h2 className="mb-3 text-lg font-semibold text-ink">Upcoming Video Visits</h2>
      <div className="mb-3">
        <SearchBox value={q} onChange={setQ} />
      </div>
      <AsyncPanel resource={list} label="video visits">
        {(all) => {
          const rows = all.filter((a) => a.telehealth && a.status === 'booked').filter((a) => matches(q, a.provider.displayName, a.reasonForVisit, a.appointmentType.name))
          return (
            <Table
              caption="Upcoming video visits"
              empty="No video appointments in the list"
              rows={rows}
              rowKey={(a) => a.id}
              columns={[
                { header: 'Date & Time', rowHeader: true, cell: (a) => `${formatLongDay(a.startAt, a.timeZone)}, ${formatTime(a.startAt, a.timeZone)}` },
                { header: 'Description', cell: (a) => a.reasonForVisit ?? a.appointmentType.name },
                { header: 'Appointment with', cell: (a) => a.provider.displayName },
                { header: 'Status', cell: (a) => (roomOpen(a) ? <Badge tone="success">Room open</Badge> : <Badge tone="primary">Scheduled</Badge>) },
                {
                  header: 'Instruction',
                  cell: (a) =>
                    roomOpen(a) ? (
                      <Button size="sm" loading={joining === a.id} icon={<Video aria-hidden="true" size={16} />} onClick={() => join(a)}>
                        Join
                      </Button>
                    ) : (
                      <span className="text-sm text-ink-muted">{a.patientInstruction ?? 'The room opens 15 minutes before the start time.'} The Join button appears 15 minutes before the start.</span>
                    ),
                },
              ]}
            />
          )
        }}
      </AsyncPanel>
      <p className="mt-4 text-sm text-ink-muted">Video visits need a phone, tablet or computer with a camera, microphone and a good internet connection.</p>
    </>
  )
}
