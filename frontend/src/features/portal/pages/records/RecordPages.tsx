import { useState } from 'react'
import type { PortalAllergy, PortalProblem, PortalProblemClinicalStatus } from '../../../../api/generated/model'
import { Badge, formatPartialDate, formatPhone, type BadgeTone } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { ResultFlag } from '../../api/types'
import { useResource } from '../../api/useResource'
import { Link } from '../../router'
import { AsyncPanel, Card, DefinitionList, formatInstantShort, formatShortDate, HeldMarker, matches, PageHeader, Pager, SearchBox, Table, tableLink, usePaged } from '../../ui'

/*
 * The old Health Summary record screens: a searchable list, and a detail page per record. Detail
 * pages load by ID (the old portal passed the whole record as JSON in the URL, which broke on
 * refresh and put health data in the address bar).
 */

const TZ = 'America/Chicago'

/** "Recorded" instants have no facility; they show as the patient's own calendar date. */
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

function Footer({ topic }: { topic: string }) {
  return <p className="mt-5 text-sm text-ink-muted">If you have questions or concerns regarding {topic}, please contact your provider.</p>
}

/* ---------- Test Results ---------- */

export function TestResultsPage() {
  const api = usePortalApi()
  const results = useResource(() => api.listResults(), [])
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Test Results" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} label="Search test name" />} />
      <AsyncPanel resource={results} label="test results">
        {(list) => <TestResultTable list={list.filter((r) => matches(q, r.name))} />}
      </AsyncPanel>
    </>
  )
}

function TestResultTable({ list }: { list: Awaited<ReturnType<ReturnType<typeof usePortalApi>['listResults']>> }) {
  const paged = usePaged(list, 10)
  return (
    <>
      <Table
        caption="Test results"
        rows={paged.rows}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Date', cell: (r) => formatInstantShort(r.orderedAt, TZ) },
          { header: 'Test Name', rowHeader: true, cell: (r) => <Link to={`/test-results/${r.id}`} className={tableLink}>{r.name}</Link> },
          { header: 'Lab Name', cell: (r) => r.lab.name },
          { header: 'Order By', cell: (r) => r.orderedBy.displayName },
        ]}
      />
      <Pager {...paged} />
    </>
  )
}

const FLAG: Record<ResultFlag, { label: string; tone: BadgeTone }> = {
  normal: { label: 'No', tone: 'neutral' },
  high: { label: 'High', tone: 'warning' },
  low: { label: 'Low', tone: 'warning' },
  'critical-high': { label: 'Critical high', tone: 'critical' },
  'critical-low': { label: 'Critical low', tone: 'critical' },
  abnormal: { label: 'Yes', tone: 'warning' },
}

export function TestResultDetailPage({ resultId }: { resultId: string }) {
  const api = usePortalApi()
  const result = useResource(() => api.getResult(resultId), [resultId])
  const title = result.status === 'ready' ? `${result.data.code} - ${result.data.name} - Details` : 'Test Details'
  return (
    <>
      <PageHeader title={title} back={{ to: '/test-results', label: 'Test Results' }} />
      <AsyncPanel resource={result} label="this result">
        {(r) => (
          <div className="max-w-4xl space-y-5">
            <Card title="Performed at">
              <DefinitionList
                items={[
                  { term: 'Lab', value: `${r.lab.name}, ${r.lab.address}` },
                  { term: 'Lab Director', value: r.lab.director },
                  { term: 'Phone', value: formatPhone(r.lab.phone) },
                ]}
              />
            </Card>
            <Card title="Component Result">
              <Table
                caption={`${r.name} components`}
                rows={r.components}
                rowKey={(c) => c.name}
                columns={[
                  { header: 'Name', rowHeader: true, cell: (c) => c.name },
                  { header: 'Abn', cell: (c) => <Badge tone={FLAG[c.flag].tone}>{FLAG[c.flag].label}</Badge> },
                  { header: 'Value', numeric: true, cell: (c) => <span className={c.flag === 'normal' ? 'text-success-fg' : 'font-semibold text-critical-fg'}>{c.value}</span> },
                  { header: 'Std Range', cell: (c) => [c.referenceRange, c.unit].filter(Boolean).join(' ') || '—' },
                ]}
              />
            </Card>
            <Card title="General Information">
              <DefinitionList
                items={[
                  { term: 'Collected', value: formatInstantShort(r.collectedAt, TZ) },
                  { term: 'Resulted', value: formatInstantShort(r.resultedAt, TZ) },
                  { term: 'Order By', value: r.orderedBy.displayName },
                  { term: 'Result Status', value: { final: 'Final', preliminary: 'Preliminary', corrected: 'Corrected' }[r.status] },
                ]}
              />
            </Card>
            <Footer topic="your test results" />
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Health Issues (Medical Problems) ---------- */

const PROBLEM_STATUS: Record<PortalProblemClinicalStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  recurrence: { label: 'Came back', tone: 'warning' },
  relapse: { label: 'Came back', tone: 'warning' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  remission: { label: 'In remission', tone: 'neutral' },
  resolved: { label: 'Resolved', tone: 'neutral' },
}

function ProblemStatus({ status }: { status?: PortalProblemClinicalStatus }) {
  if (!status) return <>—</>
  const s = PROBLEM_STATUS[status]
  return <Badge tone={s.tone}>{s.label}</Badge>
}

/** A held problem is listed without its content (D90), so the list never looks emptier than the chart. */
function problemTitle(p: PortalProblem): string {
  return p.releaseStatus === 'held' ? 'Held by your clinician' : (p.display ?? 'Problem')
}

export function HealthIssuesPage() {
  const api = usePortalApi()
  const list = useResource(() => api.listProblems(), [])
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Medical Problems" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} />} />
      <AsyncPanel resource={list} label="medical problems">
        {(items) => (
          <Table
            caption="Medical problems"
            empty="No details in this record"
            rows={items.filter((h) => matches(q, problemTitle(h), h.clinicalStatus))}
            rowKey={(h) => h.id}
            columns={[
              {
                header: 'Title',
                rowHeader: true,
                cell: (h) =>
                  h.releaseStatus === 'held' ? (
                    <HeldMarker what="problem" />
                  ) : (
                    <Link to={`/health-issues/${h.id}`} className={tableLink}>
                      {problemTitle(h)}
                    </Link>
                  ),
              },
              { header: 'Since', cell: (h) => (h.onsetDate ? formatPartialDate(h.onsetDate) : '—') },
              { header: 'Status', cell: (h) => <ProblemStatus {...(h.clinicalStatus ? { status: h.clinicalStatus } : {})} /> },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  )
}

export function HealthIssueDetailPage({ issueId }: { issueId: string }) {
  const api = usePortalApi()
  const issue = useResource(() => api.getProblem(issueId), [issueId])
  return (
    <>
      <PageHeader title={issue.status === 'ready' && issue.data.releaseStatus === 'available' ? `${problemTitle(issue.data)} - Problem` : 'Problem'} back={{ to: '/health-issues', label: 'Medical Problems' }} />
      <AsyncPanel resource={issue} label="this problem">
        {(h) => (
          <div className="max-w-3xl">
            <Card title="Problem Details">
              {h.releaseStatus === 'held' ? (
                <HeldMarker what="problem" />
              ) : (
                <DefinitionList
                  items={[
                    { term: 'Title', value: problemTitle(h) },
                    { term: 'Problem Status', value: <ProblemStatus {...(h.clinicalStatus ? { status: h.clinicalStatus } : {})} /> },
                    { term: 'Begin Date', value: h.onsetDate ? formatPartialDate(h.onsetDate) : '—' },
                    { term: 'End Date', value: h.abatementDate ? formatPartialDate(h.abatementDate) : 'Problem is still active' },
                    { term: 'Recorded', value: h.recordedAt ? formatInstantShort(h.recordedAt, BROWSER_TZ) : '—' },
                  ]}
                />
              )}
            </Card>
            <Footer topic="your medical problems" />
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Allergies ---------- */

const ALLERGY_STATUS: Record<PortalAllergy['clinicalStatus'], { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  resolved: { label: 'Resolved', tone: 'neutral' },
}

const CRITICALITY: Record<NonNullable<PortalAllergy['criticality']>, string> = {
  low: 'Low risk',
  high: 'High risk',
  'unable-to-assess': 'Risk not known',
}

function reactionsOf(a: PortalAllergy): string {
  return (a.reactions ?? []).flatMap((r) => r.manifestations).join(', ') || '—'
}

export function AllergiesPage() {
  const api = usePortalApi()
  const list = useResource(() => api.listAllergies(), [])
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Allergies" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} label="Search allergies" />} />
      <AsyncPanel resource={list} label="allergies">
        {(items) => (
          <Table
            caption="Allergies"
            empty="No allergies on file"
            rows={items.filter((a) => matches(q, a.display, reactionsOf(a)))}
            rowKey={(a) => a.id}
            columns={[
              { header: 'Title', rowHeader: true, cell: (a) => <Link to={`/allergies/${a.id}`} className={tableLink}>{a.display}</Link> },
              { header: 'Reaction', cell: (a) => reactionsOf(a) },
              { header: 'Status', cell: (a) => <Badge tone={ALLERGY_STATUS[a.clinicalStatus].tone}>{ALLERGY_STATUS[a.clinicalStatus].label}</Badge> },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  )
}

export function AllergyDetailPage({ allergyId }: { allergyId: string }) {
  const api = usePortalApi()
  const allergy = useResource(() => api.getAllergy(allergyId), [allergyId])
  return (
    <>
      <PageHeader title={allergy.status === 'ready' ? `Allergy - ${allergy.data.display}` : 'Allergy'} back={{ to: '/allergies', label: 'Allergies' }} />
      <AsyncPanel resource={allergy} label="this allergy">
        {(a) => (
          <div className="max-w-3xl">
            <Card title="Allergy Details">
              <DefinitionList
                items={[
                  { term: 'Allergy Status', value: <Badge tone={ALLERGY_STATUS[a.clinicalStatus].tone}>{ALLERGY_STATUS[a.clinicalStatus].label}</Badge> },
                  { term: 'Reaction', value: reactionsOf(a) },
                  { term: 'Risk', value: a.criticality ? CRITICALITY[a.criticality] : '—' },
                  { term: 'Recorded', value: a.recordedAt ? formatInstantShort(a.recordedAt, BROWSER_TZ) : '—' },
                ]}
              />
            </Card>
            <Footer topic="your allergies" />
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Immunization ---------- */

export function ImmunizationsPage() {
  const api = usePortalApi()
  const list = useResource(() => api.listImmunizations(), [])
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Immunization" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} />} />
      <AsyncPanel resource={list} label="immunizations">
        {(items) => (
          <Table
            caption="Immunizations"
            rows={items.filter((i) => matches(q, i.vaccine, i.administeredBy, formatShortDate(i.administeredDate)))}
            rowKey={(i) => i.id}
            columns={[
              { header: 'Date Administered', cell: (i) => formatShortDate(i.administeredDate) },
              { header: 'Vaccine', rowHeader: true, cell: (i) => <Link to={`/immunizations/${i.id}`} className={tableLink}>{i.vaccine}</Link> },
              { header: 'Administered By', cell: (i) => i.administeredBy },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  )
}

export function ImmunizationDetailPage({ immunizationId }: { immunizationId: string }) {
  const api = usePortalApi()
  const imm = useResource(() => api.getImmunization(immunizationId), [immunizationId])
  return (
    <>
      <PageHeader title={imm.status === 'ready' ? `Vaccine - ${imm.data.vaccine}` : 'Vaccine'} back={{ to: '/immunizations', label: 'Immunization' }} />
      <AsyncPanel resource={imm} label="this vaccine">
        {(i) => (
          <div className="max-w-3xl">
            <Card title="Vaccine Details">
              <DefinitionList
                items={[
                  { term: 'Date Administered', value: formatShortDate(i.administeredDate) },
                  { term: 'Amount Administered', value: i.amount ?? '—' },
                  { term: 'Route', value: i.route ?? '—' },
                  { term: 'Administered Site', value: i.site ?? '—' },
                  { term: 'Expiration', value: i.expirationDate ? formatShortDate(i.expirationDate) : '—' },
                  { term: 'Manufacturer', value: i.manufacturer ?? '—' },
                  { term: 'Physician', value: i.administeredBy },
                  { term: 'Completion Status', value: { completed: 'Completed', 'partially-administered': 'Partially administered', 'not-administered': 'Not administered' }[i.completionStatus] },
                  { term: 'Notes', value: i.notes ?? '—' },
                ]}
              />
            </Card>
            <Footer topic="immunizations" />
          </div>
        )}
      </AsyncPanel>
    </>
  )
}
