import { AlertTriangle, BellRing, CalendarDays, CreditCard, FlaskConical, FolderHeart, GraduationCap, Mail, Pill, Video } from 'lucide-react'
import { useState } from 'react'
import { formatTime, Spinner, todayIn } from '../../../design-system'
import { usePortalApi } from '../api/portalApi'
import { useResource } from '../api/useResource'
import { pathEnabled } from '../features'
import { Link } from '../router'
import { useSession } from '../session'
import { formatLongDay, PageHeader } from '../ui'

/*
 * The old home page: eight cards in the old order and to the old destinations, and an "Alerts and
 * Reminders" panel. Each card has its area's colour, as the old cards did. The old cards hid their
 * description on the back face (flip on hover); here it is always visible, for touch and keyboard.
 */
const CARDS = [
  { to: '/test-results', icon: FlaskConical, title: 'Test Results', text: 'View your test results with the lab name and date.', accent: 'accent-results' },
  { to: '/allergies', icon: FolderHeart, title: 'Health Summary', text: 'Access your personal health information: vitals, issues, reports and documents.', accent: 'accent-health' },
  { to: '/appointments', icon: CalendarDays, title: 'Appointments', text: 'Schedule, view, reschedule and cancel appointments.', accent: 'accent-appointments' },
  { to: '/messages/inbox', icon: Mail, title: 'Messages', text: 'Send and receive messages securely with your provider.', accent: 'accent-messages' },
  { to: '/prescriptions', icon: Pill, title: 'Prescriptions', text: 'View prescriptions and request prescription refills.', accent: 'accent-prescriptions' },
  { to: '/billing', icon: CreditCard, title: 'Billing', text: 'Pay bills online securely.', accent: 'accent-billing' },
  { to: '/video-consult', icon: Video, title: 'Video Consult', text: 'Video consulting at your convenience.', accent: 'accent-video' },
  { to: '/patient-education', icon: GraduationCap, title: 'Patient Education', text: 'Search trusted patient education material.', accent: 'accent-education' },
]

/** Alerts and Reminders show the next three upcoming appointments (M20: from `?when=upcoming`). */
const ALERTS = 3

export function HomePage() {
  const api = usePortalApi()
  const { session } = useSession()
  const alerts = useResource(() => api.listAppointments('upcoming').then((list) => list.filter((a) => a.status === 'booked').slice(0, ALERTS)), [])
  // When the page opened, for "today" in each facility's zone.
  const [now] = useState(() => new Date())

  return (
    <>
      <PageHeader title={`Welcome, ${session.patient.displayName}`} description="Your health, appointments and messages in one place." />
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {CARDS.filter((c) => pathEnabled(c.to)).map(({ to, icon: Icon, title, text, accent }) => (
            <li key={title} className={accent}>
              <Link
                to={to}
                className="portal-lift relative flex h-full min-h-40 flex-col gap-3 overflow-hidden rounded-2xl bg-linear-to-br from-(--accent) to-(--accent-2) p-5 text-white shadow-card"
              >
                <span aria-hidden="true" className="pointer-events-none absolute -right-6 -bottom-6 size-24 rounded-full bg-white/10" />
                <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-2xl bg-white/20 ring-1 ring-white/30">
                  <Icon size={24} />
                </span>
                <span className="text-lg font-bold">{title}</span>
                <span className="text-sm text-white">{text}</span>
              </Link>
            </li>
          ))}
        </ul>

        <section aria-labelledby="alerts-heading" className="accent-appointments h-fit overflow-hidden rounded-2xl border border-(--accent-line) bg-surface-1 shadow-card">
          <h2 id="alerts-heading" className="flex items-center gap-2 bg-linear-to-r from-(--accent) to-(--accent-2) px-4 py-3 text-base font-bold text-white">
            <BellRing aria-hidden="true" size={18} /> Alerts and Reminders
          </h2>
          <div className="p-4">
            {alerts.status === 'loading' ? (
              <Spinner label="Loading alerts" />
            ) : alerts.status === 'error' ? (
              <p className="text-sm text-ink-muted">
                Couldn't load your alerts.{' '}
                <button type="button" className="font-semibold text-primary-700 underline" onClick={alerts.reload}>
                  Try again
                </button>
              </p>
            ) : alerts.data.length === 0 ? (
              <p className="text-sm text-ink-muted">No alerts and reminders found.</p>
            ) : (
              <ul className="space-y-2">
                {alerts.data.map((a) => {
                  const today = todayIn(a.timeZone, new Date(a.startAt)) === todayIn(a.timeZone, now)
                  return (
                    <li key={a.id}>
                      <Link
                        to={`/appointments/${a.id}`}
                        className={`portal-lift flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${today ? 'border-critical-fg/30 bg-critical-bg text-critical-fg' : 'border-warning-fg/30 bg-warning-bg text-warning-fg'}`}
                      >
                        <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
                        <span>
                          {today
                            ? `Today at ${formatTime(a.startAt, a.timeZone)} you have an appointment.`
                            : `You have an appointment on ${formatLongDay(a.startAt, a.timeZone)} at ${formatTime(a.startAt, a.timeZone)}.`}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
