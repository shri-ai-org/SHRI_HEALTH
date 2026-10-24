import { CalendarPlus, CalendarX, MapPin, Video } from 'lucide-react'
import { useState } from 'react'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, formatAddressLines, formatPhone, formatTime, problemCopy, toUsDisplay, useToast } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { Appointment } from '../../api/types'
import { toProblem, useResource } from '../../api/useResource'
import { Link, useRouter } from '../../router'
import { AppointmentStatusBadge, AsyncPanel, Card, DefinitionList, formatLongDay, formatShortDate, matches, PageHeader, Pager, SearchBox, Table, usePaged } from '../../ui'

/* ---------- My Appointments ---------- */

export function AppointmentsPage() {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const list = useResource(() => api.listAppointments(), [])
  // When the page opened; splits upcoming from past without reading the clock during render.
  const [now] = useState(() => Date.now())
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
        {(all) => {
          const upcoming = all.filter((a) => a.status === 'booked' && Date.parse(a.endAt) >= now)
          const past = all.filter((a) => !upcoming.includes(a)).reverse()
          return (
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
                {past.length ? <PastTiles list={past} /> : <EmptyState title="No past appointments" />}
              </section>
            </div>
          )
        }}
      </AsyncPanel>
    </>
  )
}

function PastTiles({ list }: { list: Appointment[] }) {
  const paged = usePaged(list, 5)
  return (
    <>
      <Tiles list={paged.rows} />
      <Pager {...paged} />
    </>
  )
}

/** The old date tiles: month and year, big day number, weekday and time, provider and location. */
function Tiles({ list }: { list: Appointment[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((a) => {
        const tz = a.facility.timeZone
        const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(a.startAt))
        const to = a.status === 'booked' ? `/appointments/${a.id}` : a.visitSummaryId ? `/visit-summaries/${a.visitSummaryId}` : `/appointments/${a.id}`
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
                  {a.mode === 'video' ? <Video aria-hidden="true" size={14} /> : <MapPin aria-hidden="true" size={14} />}
                  {a.mode === 'video' ? 'Video visit' : a.facility.displayName}
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

export function UpcomingAppointmentPage({ appointmentId }: { appointmentId: string }) {
  const api = usePortalApi()
  const { navigate } = useRouter()
  const toast = useToast()
  const appt = useResource(() => api.getAppointment(appointmentId), [appointmentId])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  async function cancel() {
    setBusy(true)
    setFailure(null)
    try {
      await api.cancelAppointment(appointmentId)
      toast.show('Your appointment is canceled')
      navigate('/appointments')
    } catch (err) {
      setConfirming(false)
      setFailure(problemCopy(toProblem(err)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Upcoming Visit Details" back={{ to: '/appointments', label: 'My Appointments' }} />
      <AsyncPanel resource={appt} label="this appointment">
        {(a) => {
          const tz = a.facility.timeZone
          const when = `${formatLongDay(a.startAt, tz)}, ${new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(new Date(a.startAt))}, ${formatTime(a.startAt, tz)}`
          return (
            <div className="max-w-3xl space-y-4">
              {failure ? <Alert tone="critical" title="Couldn't cancel">{failure}</Alert> : null}
              {a.status !== 'booked' ? <Alert tone="info" title="This appointment is no longer upcoming." /> : null}
              <Card>
                <DefinitionList
                  items={[
                    { term: 'Provider', value: a.provider.displayName },
                    { term: 'Appointment Date and Time', value: when },
                    { term: 'Appointment Type', value: a.category.displayName },
                    { term: 'Reason for Visit', value: a.reason },
                    {
                      term: 'Address',
                      value:
                        a.mode === 'video' ? (
                          'Video visit: join from the Video Consult page.'
                        ) : (
                          <>
                            <span className="block">{a.facility.displayName}</span>
                            {formatAddressLines(a.facility.address).map((l) => (
                              <span key={l} className="block">
                                {l}
                              </span>
                            ))}
                            <span className="block">{formatPhone(a.facility.phone)}</span>
                          </>
                        ),
                    },
                    { term: 'Status', value: <AppointmentStatusBadge status={a.status} /> },
                  ]}
                />
                {a.status === 'booked' ? (
                  <div className="mt-5 flex flex-wrap gap-2 border-t border-border-soft pt-4">
                    {a.canReschedule ? (
                      <Button variant="outline" icon={<CalendarPlus aria-hidden="true" size={16} />} onClick={() => navigate(`/appointments/${a.id}/reschedule`)}>
                        Reschedule Appointment
                      </Button>
                    ) : null}
                    {a.canCancel ? (
                      <Button variant="outline" icon={<CalendarX aria-hidden="true" size={16} />} onClick={() => setConfirming(true)}>
                        Cancel Appointment
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </Card>
              <p className="text-sm text-ink-muted">
                If you must cancel, please do so as far in advance as possible. This helps us offer the time to other patients who are waiting for an appointment.
              </p>
              <ConfirmDialog
                open={confirming}
                title="Cancel this appointment?"
                confirmLabel="Cancel appointment"
                cancelLabel="Keep appointment"
                confirmVariant="danger"
                busy={busy}
                onConfirm={cancel}
                onCancel={() => setConfirming(false)}
              >
                Your appointment on {when} with {a.provider.displayName} will be canceled.
              </ConfirmDialog>
            </div>
          )
        }}
      </AsyncPanel>
    </>
  )
}

/* ---------- Visit Summary ---------- */

export function VisitSummaryPage({ visitSummaryId }: { visitSummaryId: string }) {
  const api = usePortalApi()
  const summary = useResource(() => api.getVisitSummary(visitSummaryId), [visitSummaryId])
  return (
    <>
      <PageHeader title="Visit Summary" back={{ to: '/appointments', label: 'My Appointments' }} />
      <AsyncPanel resource={summary} label="the visit summary">
        {(s) => {
          const v = s.vitals
          const vitals: Array<[string, string | undefined]> = v
            ? [
                ['Blood Pressure', v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic} mmHg` : undefined],
                ['Pulse', v.pulse ? `${v.pulse} /min` : undefined],
                ['Weight', v.weight ? toUsDisplay(v.weight).text : undefined],
                ['Height', v.height ? toUsDisplay(v.height).text : undefined],
                ['Temperature', v.temperature ? toUsDisplay(v.temperature).text : undefined],
                ['Respiration', v.respiration ? `${v.respiration} /min` : undefined],
                ['BMI', v.bmi?.toFixed(1)],
                ['BMI Status', v.bmiStatus],
                ['Waist Circ', v.waistCircumference ? toUsDisplay(v.waistCircumference).text : undefined],
                ['Head Circ', v.headCircumference ? toUsDisplay(v.headCircumference).text : undefined],
                ['Oxygen Saturation', v.oxygenSaturation ? `${v.oxygenSaturation}%` : undefined],
              ]
            : []
          const shown = vitals.filter((x): x is [string, string] => Boolean(x[1]))
          return (
            <div className="max-w-3xl space-y-4">
              <p className="text-sm text-ink-muted">
                {formatShortDate(s.date)} with {s.provider.displayName}
              </p>
              <Card title="Reason For Visit">{s.reasons.length ? <ul className="list-disc pl-5 text-sm text-ink">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="text-sm text-ink-muted">No visit reasons</p>}</Card>
              <Card title="Vital Information">
                {shown.length ? <DefinitionList items={shown.map(([term, value]) => ({ term, value }))} /> : <p className="text-sm text-ink-muted">No vitals details</p>}
              </Card>
              <Card title="Medical Problem and Allergy Information">
                {s.problemsAndAllergies.length ? (
                  <ul className="list-disc pl-5 text-sm text-ink">
                    {s.problemsAndAllergies.map((m) => (
                      <li key={m.title}>
                        {m.title} - {m.diagnosis}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-muted">No medical problem and allergy details</p>
                )}
              </Card>
              <Card title="Prescriptions">
                {s.prescriptions.length ? <ul className="list-disc pl-5 text-sm text-ink">{s.prescriptions.map((p) => <li key={p}>{p}</li>)}</ul> : <p className="text-sm text-ink-muted">No prescriptions prescribed</p>}
              </Card>
            </div>
          )
        }}
      </AsyncPanel>
    </>
  )
}

/* ---------- Video Consult ---------- */

/** The old "Video Consulting" page, now listing the patient's video visits with a Join button. */
export function VideoConsultPage() {
  const api = usePortalApi()
  const toast = useToast()
  const list = useResource(() => api.listAppointments(), [])
  const [q, setQ] = useState('')
  const [joining, setJoining] = useState<string | null>(null)

  async function join(a: Appointment) {
    setJoining(a.id)
    try {
      const { joinUrl } = await api.joinVideoVisit(a.id)
      window.open(joinUrl, '_blank', 'noopener')
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
          const rows = all
            .filter((a) => a.mode === 'video' && a.status === 'booked' && Date.parse(a.endAt) >= Date.now())
            .filter((a) => matches(q, a.provider.displayName, a.reason, a.category.displayName))
          return (
            <Table
              caption="Upcoming video visits"
              empty="No video appointments in the list"
              rows={rows}
              rowKey={(a) => a.id}
              columns={[
                { header: 'Date & Time', rowHeader: true, cell: (a) => `${formatLongDay(a.startAt, a.facility.timeZone)}, ${formatTime(a.startAt, a.facility.timeZone)}` },
                { header: 'Description', cell: (a) => a.reason },
                { header: 'Appointment with', cell: (a) => a.provider.displayName },
                { header: 'Status', cell: (a) => (a.videoRoomOpen ? <Badge tone="success">Room open</Badge> : <Badge tone="primary">Scheduled</Badge>) },
                {
                  header: 'Instruction',
                  cell: (a) =>
                    a.videoRoomOpen ? (
                      <Button size="sm" loading={joining === a.id} icon={<Video aria-hidden="true" size={16} />} onClick={() => join(a)}>
                        Join
                      </Button>
                    ) : (
                      <span className="text-sm text-ink-muted">{a.instructions ?? 'The room opens 15 minutes before the start time.'} The Join button appears 15 minutes before the start.</span>
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
