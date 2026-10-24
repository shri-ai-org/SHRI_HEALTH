import { useState, type ReactNode } from 'react'
import {
  Alert,
  Badge,
  BreakGlassDialog,
  Button,
  ConfirmDialog,
  DataTable,
  DateInput,
  ErrorState,
  Field,
  formatDate,
  formatMoney,
  formatPartialDate,
  formatPhone,
  formatTime,
  IdleTimeoutWarning,
  MoneyInput,
  parsePartialDate,
  PhoneInput,
  ProblemAlert,
  RecordChangedDialog,
  SharedStatusBoard,
  StateSelect,
  Tabs,
  Textarea,
  TextInput,
  toUsDisplay,
  useToast,
} from '../design-system'

// The contract's own example people (API_STANDARDS §20), so the preview matches the mock server.
const TZ = 'America/Chicago'
const APPOINTMENTS = [
  { id: 'a1', startAt: '2026-11-03T14:30:00Z', patient: 'Kuhlman72, Ramona980', provider: 'Dr. Gerard14 Lowe58', type: 'Follow-up visit', status: 'Checked in' },
  { id: 'a2', startAt: '2026-11-03T15:00:00Z', patient: 'Kuhlman72, Darius71', provider: 'Dr. Gerard14 Lowe58', type: 'New patient', status: 'Scheduled' },
]

/** A page of every design-system component with synthetic data, for review and screenshots. */
export function DesignSystemPreview() {
  const toast = useToast()
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  const [tab, setTab] = useState('forms')
  const [birthDate, setBirthDate] = useState<string | null>('')
  const [phone, setPhone] = useState<string | null>('')
  const [copay, setCopay] = useState<string | null>('')
  const [surgery, setSurgery] = useState<string | null>('')
  const [note, setNote] = useState('')
  const [dialog, setDialog] = useState<'none' | 'confirm' | 'break-glass' | 'record-changed' | 'idle'>('none')
  // When the idle demo was opened; captured in the click handler, not during render.
  const [idleDemoStart, setIdleDemoStart] = useState(0)

  function toggleTheme() {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('shri-theme', next ? 'dark' : 'light')
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this page.
    }
    setDark(next)
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Shri Health design system</h1>
          <p className="mt-1 text-sm text-ink-muted">U.S. ambulatory edition · synthetic data only</p>
        </div>
        <Button variant="outline" onClick={toggleTheme} aria-pressed={dark}>
          Dark mode
        </Button>
      </header>

      <Tabs
        label="Design system sections"
        selectedId={tab}
        onSelect={setTab}
        items={[
          {
            id: 'forms',
            label: 'Forms and formats',
            panel: (
              <div className="grid gap-6 md:grid-cols-2">
                <Card title="Registration fields">
                  <div className="space-y-4">
                    <Field label="Last name" required>
                      {(p) => <TextInput {...p} autoComplete="family-name" />}
                    </Field>
                    <Field label="Date of birth" hint="MM/DD/YYYY" required error={birthDate === null ? 'Enter a real date as MM/DD/YYYY.' : undefined}>
                      {(p) => <DateInput {...p} value="" onValueChange={setBirthDate} />}
                    </Field>
                    <Field label="Mobile phone" error={phone === null ? 'Enter a 10-digit U.S. phone number.' : undefined}>
                      {(p) => <PhoneInput {...p} value="" onValueChange={setPhone} />}
                    </Field>
                    <Field label="State">{(p) => <StateSelect {...p} />}</Field>
                    <Field label="ZIP code" hint="12345 or 12345-6789">
                      {(p) => <TextInput {...p} inputMode="numeric" autoComplete="postal-code" />}
                    </Field>
                    <p className="text-xs text-ink-subtle">
                      Sent to the API as: birthDate <code>{birthDate || '—'}</code>, phone <code>{phone || '—'}</code>
                    </p>
                  </div>
                </Card>
                <Card title="Amounts, history dates and notes">
                  <div className="space-y-4">
                    <Field label="Copay amount (USD)" error={copay === null ? 'Enter an amount such as 25 or 25.00.' : undefined}>
                      {(p) => <MoneyInput {...p} value="" onValueChange={setCopay} />}
                    </Field>
                    <Field label="Year or date of surgery" hint="YYYY, MM/YYYY or MM/DD/YYYY" error={surgery === null ? 'Enter a year, a month and year, or a full date.' : undefined}>
                      {(p) => (
                        <TextInput
                          {...p}
                          inputMode="numeric"
                          onChange={(e) => setSurgery(e.target.value.trim() === '' ? '' : parsePartialDate(e.target.value))}
                        />
                      )}
                    </Field>
                    <Field label="Front-desk note" hint="Visible to staff only">
                      {(p) => <Textarea {...p} value={note} limit={500} onChange={(e) => setNote(e.target.value)} />}
                    </Field>
                    <p className="text-xs text-ink-subtle">
                      Sent as: amount <code>{copay || '—'}</code>, performedDate <code>{surgery || '—'}</code> (shown as{' '}
                      {surgery ? formatPartialDate(surgery) : '—'})
                    </p>
                  </div>
                </Card>
                <Card title="U.S. display formats">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <Row label="Date of birth">{formatDate('1984-07-19')}</Row>
                    <Row label="Appointment">{formatTime('2026-11-03T14:30:00Z', TZ)}</Row>
                    <Row label="Copay">{formatMoney({ value: '25.00', currency: 'USD' })}</Row>
                    <Row label="Balance">{formatMoney({ value: '1234.50', currency: 'USD' })}</Row>
                    <Row label="Phone">{formatPhone('+16175550123')}</Row>
                    <Row label="Weight">{toUsDisplay({ value: 70, unit: 'kg' }).text}</Row>
                    <Row label="Height">{toUsDisplay({ value: 177.8, unit: 'cm' }).text}</Row>
                    <Row label="Temperature">{toUsDisplay({ value: 37, unit: 'Cel' }).text}</Row>
                    <Row label="Blood pressure">{toUsDisplay({ value: 120, unit: 'mm[Hg]' }).text}</Row>
                  </dl>
                </Card>
              </div>
            ),
          },
          {
            id: 'feedback',
            label: 'Alerts and states',
            panel: (
              <div className="space-y-4">
                <Alert tone="critical" title="Allergy: penicillin (severe)" actions={<Button size="sm" variant="outline">Override with reason</Button>}>
                  Amoxicillin is a penicillin. The prescriber can continue after giving a reason.
                </Alert>
                <Alert tone="warning" title="Insurance not verified">Eligibility check is still pending.</Alert>
                <Alert tone="info" title="Same-day add-on">Booked outside the provider&apos;s template.</Alert>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="success">Active coverage</Badge>
                  <Badge tone="warning">Pending</Badge>
                  <Badge tone="critical">Restricted chart</Badge>
                  <Badge tone="primary">New patient</Badge>
                  <Badge>Self-pay</Badge>
                </div>
                <ProblemAlert
                  fieldLabels={{ '/birthDate': 'Date of birth', '/address/postalCode': 'ZIP code' }}
                  problem={{
                    type: 'tag:company-domain.invalid,2026:problem/validation-failed',
                    title: 'Request validation failed',
                    status: 422,
                    code: 'validation-failed',
                    requestId: '7f3c9a10-0000-4000-8000-000000000001',
                    errors: [
                      { in: 'body', pointer: '/birthDate', code: 'required' },
                      { in: 'body', pointer: '/address/postalCode', code: 'invalid-format' },
                    ],
                  }}
                />
                <Card title="Failed panel">
                  <ErrorState title="Couldn't load today's schedule" reference="7f3c9a10-0000-4000-8000-000000000002" onRetry={() => toast.show('Retrying…', 'info')} />
                </Card>
              </div>
            ),
          },
          {
            id: 'tables',
            label: 'Tables',
            panel: (
              <DataTable
                caption="Today's appointments"
                rows={APPOINTMENTS}
                rowKey={(r) => r.id}
                hasMore
                onLoadMore={() => toast.show('Loaded more appointments')}
                columns={[
                  { key: 'time', header: 'Time', render: (r) => formatTime(r.startAt, TZ, { withZone: false }) },
                  { key: 'patient', header: 'Patient', render: (r) => r.patient },
                  { key: 'provider', header: 'Provider', render: (r) => r.provider },
                  { key: 'type', header: 'Visit type', render: (r) => r.type },
                  { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'Checked in' ? 'success' : 'neutral'}>{r.status}</Badge> },
                ]}
              />
            ),
          },
          {
            id: 'safety',
            label: 'Safety dialogs',
            panel: (
              <div className="flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => setDialog('break-glass')}>Break-glass</Button>
                <Button variant="outline" onClick={() => setDialog('record-changed')}>Record changed (412)</Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setIdleDemoStart(Date.now())
                    setDialog('idle')
                  }}
                >
                  Idle warning
                </Button>
                <Button variant="danger" onClick={() => setDialog('confirm')}>Cancel appointment</Button>
              </div>
            ),
          },
          {
            id: 'board',
            label: 'Waiting-room display',
            panel: (
              <SharedStatusBoard
                timeZone={TZ}
                items={[
                  { appointmentId: 's1', initials: 'RK', startAt: '2026-11-03T14:30:00Z', status: 'checked-in', visitStatus: 'roomed' },
                  { appointmentId: 's2', initials: 'DK', startAt: '2026-11-03T15:00:00Z', status: 'arrived', visitStatus: 'arrived' },
                ]}
              />
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={dialog === 'confirm'}
        title="Cancel this appointment?"
        confirmLabel="Cancel appointment"
        cancelLabel="Keep it"
        confirmVariant="danger"
        onConfirm={() => {
          setDialog('none')
          toast.show('Appointment canceled')
        }}
        onCancel={() => setDialog('none')}
      >
        The time will be released for other patients.
      </ConfirmDialog>
      <BreakGlassDialog
        open={dialog === 'break-glass'}
        onSubmit={() => {
          setDialog('none')
          toast.show('Access granted for 4 hours')
        }}
        onCancel={() => setDialog('none')}
      />
      <RecordChangedDialog
        open={dialog === 'record-changed'}
        changes={[
          { label: 'Mobile phone', yours: '(617) 555-0123', current: '(617) 555-0199' },
          { label: 'ZIP code', yours: '62701', current: '62704' },
        ]}
        onUseLatest={() => setDialog('none')}
        onKeepMine={() => setDialog('none')}
      />
      {dialog === 'idle' ? (
        <IdleTimeoutWarning
          idleExpiresAt={new Date(idleDemoStart + 115_000).toISOString()}
          expiresAt={new Date(idleDemoStart + 8 * 3_600_000).toISOString()}
          onStaySignedIn={async () => setDialog('none')}
          onSignOut={() => setDialog('none')}
          onExpired={() => setDialog('none')}
        />
      ) : null}
    </main>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border-soft bg-surface-1 p-5 shadow-card">
      <h2 className="mb-4 text-sm font-semibold text-ink">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink tabular-nums">{children}</dd>
    </>
  )
}
