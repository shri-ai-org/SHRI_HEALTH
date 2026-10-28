import { CalendarDays, CreditCard, HeartPulse, Mail, Pill, Video } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { SourceCodeLink } from '../../sourceCode'
import { PORTAL_NAME } from '../../ui'

const FEATURES = [
  { icon: HeartPulse, text: 'My health records and test results', accent: 'accent-results' },
  { icon: CalendarDays, text: 'Schedule, reschedule and cancel appointments', accent: 'accent-appointments' },
  { icon: Mail, text: 'Message your provider securely', accent: 'accent-messages' },
  { icon: Pill, text: 'Request prescription refills', accent: 'accent-prescriptions' },
  { icon: CreditCard, text: 'Pay bills online', accent: 'accent-billing' },
  { icon: Video, text: 'Video consultations', accent: 'accent-video' },
]

/** Signed-out pages: the form on the left, what the portal does on the right (kept from the old portal). */
export function AuthLayout({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    document.title = `${title} · ${PORTAL_NAME}`
    heading.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <div className="portal-header flex min-h-dvh flex-col">
      <div className="mx-auto grid w-full max-w-5xl flex-1 items-start gap-8 px-4 py-8 sm:py-14 lg:grid-cols-[1fr_22rem] lg:items-center">
        <main className="portal accent-brand rounded-3xl bg-surface-1 p-6 shadow-modal sm:p-8">
          <div className="mb-6 flex items-center gap-2">
            <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl bg-linear-to-br from-(--accent) to-(--accent-2) font-extrabold text-white">
              SH
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-bold text-ink">Shri Health</span>
              <span className="text-xs text-ink-subtle">Patient portal</span>
            </span>
          </div>
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold text-ink outline-none sm:text-3xl">
            {title}
          </h1>
          {intro ? <div className="mt-1.5 text-sm text-ink-muted">{intro}</div> : null}
          <div className="mt-6">{children}</div>
        </main>
        <aside aria-label="What you can do in the portal" className="hidden text-white lg:block">
          <p className="mb-5 text-2xl leading-snug font-bold">Your health, in one place.</p>
          <ul className="space-y-4">
            {FEATURES.map(({ icon: Icon, text, accent }) => (
              <li key={text} className={`flex items-center gap-3 text-sm font-medium ${accent}`}>
                <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-linear-to-br from-(--accent) to-(--accent-2) text-white shadow-card ring-2 ring-white/40">
                  <Icon size={20} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <footer className="px-4 pb-6 text-center text-xs text-white">
        <strong>For a medical emergency, call 911.</strong> Need help signing in? Call your clinic.{' '}
        <SourceCodeLink className="text-white underline" />
      </footer>
    </div>
  )
}
