import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, IdCard, Printer } from 'lucide-react'
import { Card, CardBody } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { useStoreValue } from '../hooks/useStore'
import { getGuestPasses } from '../domain/selectors'
import { formatClock } from '../utils/format'
import { formatDateKey } from '../utils/dates'
import { todayKey } from '../domain/time'
import type { GuestPass } from '../types/frontDesk'

function stamp(ts: number): string {
  return `${formatDateKey(todayKey(new Date(ts)))} · ${formatClock(ts)}`
}

function passById(passes: GuestPass[], passId: string): GuestPass | null {
  return passes.find((pass) => pass.passId === passId) ?? null
}

/** The printed pass the holder carries — who they are, the ID seen, where
 *  they may go, until when, and who confirmed the visit. */
export function GuestPassPrintPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const passId = new URLSearchParams(location.search).get('pass') ?? ''
  const pass = passById(useStoreValue(getGuestPasses), passId)
  const autoPrint = (location.state as { autoPrint?: boolean } | null)?.autoPrint

  useEffect(() => {
    if (autoPrint && pass) {
      const id = window.setTimeout(() => window.print(), 200)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [autoPrint, pass])

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full max-w-md items-center justify-between print:hidden">
        <Button size="sm" variant="ghost" onClick={() => navigate('/services/guest-pass')}>
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          Guest Pass
        </Button>
        {pass ? (
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} />
            Print pass
          </Button>
        ) : null}
      </div>

      <Card accentTone="brand" className="w-full max-w-md">
        {!pass ? (
          <CardBody>
            <EmptyState icon={IdCard} title="No such pass" />
          </CardBody>
        ) : (
          <CardBody className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle">SHRI Health · Guest Pass</p>
                <p className="mt-1 text-2xl font-bold tracking-wide tabular-nums text-primary-text">{pass.passId}</p>
                <p className="text-sm font-semibold text-ink">{pass.type}</p>
              </div>
              <IdCard className="h-10 w-10 shrink-0 text-primary-text" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <Fact label="Holder" value={pass.holderName} strong />
              <Fact label="Mobile" value={pass.holderMobile} />
              <Fact label="ID seen" value={pass.idProof} />
              {pass.patientName ? (
                <Fact label="Visiting" value={`${pass.patientName} (${pass.relationship})`} />
              ) : (
                <Fact label={pass.type === 'Visiting doctor' ? 'Host doctor' : 'Authorised by'} value={pass.hostName ?? '—'} />
              )}
              <Fact label="Allowed in" value={pass.ward} strong />
              {pass.purpose ? <Fact label="Purpose" value={pass.purpose} /> : null}
              <Fact label="Confirmed with" value={pass.verifiedWith} />
              <Fact label="Printed" value={`${stamp(pass.issuedAt)} · by ${pass.issuedBy}`} />
              <Fact label="Valid until" value={stamp(pass.validUntil)} strong />
            </dl>
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-muted">
              Wear this pass where it can be seen, and return it at the front desk when you leave.
              {pass.returned ? ' This pass has been returned.' : ''}
            </p>
          </CardBody>
        )}
      </Card>
    </div>
  )
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className={strong ? 'font-semibold text-ink' : 'text-ink'}>{value}</dd>
    </>
  )
}
