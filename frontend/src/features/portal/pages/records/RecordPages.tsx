import { useState } from 'react'
import { Badge, formatPhone, type BadgeTone } from '../../../../design-system'
import { usePortalApi } from '../../api/portalApi'
import type { ResultFlag } from '../../api/types'
import { useResource } from '../../api/useResource'
import { Link } from '../../router'
import { AsyncPanel, Card, DefinitionList, formatInstantShort, formatShortDate, matches, OCCURRENCE, PageHeader, Pager, SearchBox, Table, tableLink, usePaged } from '../../ui'

/*
 * The old Health Summary record screens: a searchable list, and a detail page per record. Detail
 * pages load by ID (the old portal passed the whole record as JSON in the URL, which broke on
 * refresh and put health data in the address bar).
 */

const TZ = 'America/Chicago'

function Footer({ topic }: { topic: string }) {
  return <p className="mt-5 text-sm text-ink-muted">If you have questions or concerns regarding {topic}, please contact your provider.</p>
}

function StatusBadge({ ended }: { ended: boolean }) {
  return <Badge tone={ended ? 'neutral' : 'success'}>{ended ? 'Inactive' : 'Active'}</Badge>
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

export function HealthIssuesPage() {
  const api = usePortalApi()
  const list = useResource(() => api.listHealthIssues(), [])
  const [q, setQ] = useState('')
  return (
    <>
      <PageHeader title="Medical Problems" back={{ to: '/', label: 'Home' }} actions={<SearchBox value={q} onChange={setQ} />} />
      <AsyncPanel resource={list} label="medical problems">
        {(items) => (
          <Table
            caption="Medical problems"
            empty="No details in this record"
            rows={items.filter((h) => matches(q, h.title, h.diagnosis, h.endDate ? 'inactive' : 'active'))}
            rowKey={(h) => h.id}
            columns={[
              { header: 'Title', rowHeader: true, cell: (h) => <Link to={`/health-issues/${h.id}`} className={tableLink}>{h.title}</Link> },
              { header: 'Diagnosis', cell: (h) => h.diagnosis },
              { header: 'Status', cell: (h) => <StatusBadge ended={Boolean(h.endDate)} /> },
            ]}
          />
        )}
      </AsyncPanel>
    </>
  )
}

export function HealthIssueDetailPage({ issueId }: { issueId: string }) {
  const api = usePortalApi()
  const issue = useResource(() => api.getHealthIssue(issueId), [issueId])
  return (
    <>
      <PageHeader title={issue.status === 'ready' ? `${issue.data.title} - Problem` : 'Problem'} back={{ to: '/health-issues', label: 'Medical Problems' }} />
      <AsyncPanel resource={issue} label="this problem">
        {(h) => (
          <div className="max-w-3xl">
            <Card title="Problem Details">
              <DefinitionList
                items={[
                  { term: 'Title', value: h.title },
                  { term: 'Problem Status', value: <StatusBadge ended={Boolean(h.endDate)} /> },
                  { term: 'Diagnosis Code', value: h.diagnosis },
                  { term: 'Begin Date', value: h.beginDate ? formatShortDate(h.beginDate) : '—' },
                  { term: 'End Date', value: h.endDate ? formatShortDate(h.endDate) : 'Problem is still active' },
                  { term: 'Occurrence', value: OCCURRENCE[h.occurrence] },
                  { term: 'Referred By', value: h.referredBy ?? '—' },
                  { term: 'Notes', value: h.notes ?? '—' },
                ]}
              />
            </Card>
            <Footer topic="your medical problems" />
          </div>
        )}
      </AsyncPanel>
    </>
  )
}

/* ---------- Allergies ---------- */

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
            rows={items.filter((a) => matches(q, a.title))}
            rowKey={(a) => a.id}
            columns={[
              { header: 'Title', rowHeader: true, cell: (a) => <Link to={`/allergies/${a.id}`} className={tableLink}>{a.title}</Link> },
              { header: 'Diagnosis', cell: (a) => a.diagnosis ?? '—' },
              { header: 'Status', cell: (a) => <StatusBadge ended={Boolean(a.endDate)} /> },
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
      <PageHeader title={allergy.status === 'ready' ? `Allergy - ${allergy.data.title}` : 'Allergy'} back={{ to: '/allergies', label: 'Allergies' }} />
      <AsyncPanel resource={allergy} label="this allergy">
        {(a) => (
          <div className="max-w-3xl">
            <Card title="Allergy Details">
              <DefinitionList
                items={[
                  { term: 'Problem Status', value: <StatusBadge ended={Boolean(a.endDate)} /> },
                  { term: 'Reaction', value: a.reaction },
                  { term: 'Begin Date', value: a.beginDate ? formatShortDate(a.beginDate) : '—' },
                  { term: 'End Date', value: a.endDate ? formatShortDate(a.endDate) : 'Allergy is still active' },
                  { term: 'Occurrence', value: OCCURRENCE[a.occurrence] },
                  { term: 'Referred By', value: a.referredBy ?? '—' },
                  { term: 'Notes', value: a.notes ?? '—' },
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
