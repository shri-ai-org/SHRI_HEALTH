/**
 * S-18-03 · Site readiness — `/stroke/network/sites` (`src/screens/m18/
 * S1803.tsx`): "Whether each spoke can actually do its part tonight."
 *
 * The question this answers decides where an ambulance goes. The flagged
 * sites are the slice acted on tonight, so they open by default (`?scope=`);
 * the ready ones are one tap away. Each site is one card: one line of facts,
 * one line of flags. AI-816 notices training gaps at G1; the training matrix
 * and the maintenance schedule remain the authority.
 *
 * Removed, as a forecast (decision 8): AI-622's equipment-failure prediction
 * (IPL's "CT gantry service due in 11 days — AI-622 predicts failure risk
 * rising"). It is filtered in the view — the data keeps it — so IPL reads as
 * ready, the counts are counted without it, and the rail says one forecast
 * is not shown.
 */

import { Ban, Brain, Check, Scan, Sparkles, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { NETWORK_SITES, NETWORK_TODAY } from '@/data/stroke'

import { useMayOpenPath } from '../app/landing'
import { ScreenFrame } from '../app/ScreenFrame'
import { cn } from '../lib/cn'
import { useScope } from '../logic/scope'
import { readinessFlags } from '../logic/strokeCase'
import { useAiActive } from '../state/ai'
import { Why } from '../ui/Disclosure'
import { KeyValue } from '../ui/KeyValue'
import { Card, Icon, Pill, PillTag } from '../ui/primitives'
import { Segmented } from '../ui/Segmented'

type Scope = 'flagged' | 'ready'
const SCOPES: readonly Scope[] = ['flagged', 'ready']
type Site = (typeof NETWORK_SITES)[number]

const CT_TONE = { free: 'norm', 'in use': 'warn', none: 'neu' } as const
const ROLE_TONE = { hub: 'pend', spoke: 'warn', secondary: 'neu' } as const

const READY_MEANS = [
  'A working CT with a radiographer on shift',
  'A physician who has completed the stroke competency in the last 12 months',
  'A stroke bed, or a transfer agreement if there is not one',
  'Bandwidth sufficient for a video teleconsult',
]

export function SitesPage() {
  const navigate = useNavigate()
  const may = useMayOpenPath()
  const aiActive = useAiActive()
  const [scope, setScope] = useScope(SCOPES, 'flagged')

  const flagsOf = (s: Site) => readinessFlags(s.readiness)
  const flagged = NETWORK_SITES.filter((s) => flagsOf(s).length > 0)
  const ready = NETWORK_SITES.filter((s) => flagsOf(s).length === 0)
  const fullyReady = NETWORK_SITES.filter((s) => s.ctStatus !== 'none' && flagsOf(s).length === 0).length
  const transferOnly = NETWORK_SITES.filter((s) => s.ctStatus === 'none')
  const forecastsHidden = NETWORK_SITES.reduce((n, s) => n + s.readiness.length - flagsOf(s).length, 0)
  const shown = scope === 'flagged' ? flagged : ready

  return (
    <ScreenFrame
      screenId="S-18-03"
      heading="Site readiness"
      sub={`${NETWORK_SITES.length} sites · ${fullyReady} fully ready · ${flagged.length} flagged · ${transferOnly.length} transfer-only`}
      actions={
        may('/stroke/wall') && (
          <Pill variant="card" size="xl" icon={Brain} iconSize={17} onClick={() => navigate('/stroke/wall')}>
            Command wall
          </Pill>
        )
      }
      railTitle="Readiness"
      rail={
        <Card titleSize="sm" title="Tonight">
          <dl className="flex flex-col divide-y divide-(--line)">
            <KeyValue label="Fully ready">
              {fullyReady} of {NETWORK_SITES.length}
            </KeyValue>
            <KeyValue label="Transfer-only">
              {transferOnly.length} · {transferOnly.map((s) => s.code).join(', ')}, no CT
            </KeyValue>
            <KeyValue label="Activations today">{NETWORK_TODAY.activations}</KeyValue>
          </dl>
          {forecastsHidden > 0 && (
            <p className="mt-[8px] text-[12px]/[1.45] text-sh-text-3">
              {forecastsHidden === 1 ? '1 equipment-failure prediction (AI-622) is' : `${forecastsHidden} equipment-failure predictions (AI-622) are`} not shown or counted — a forecast, not a finding. The maintenance schedule is the authority.
            </p>
          )}
        </Card>
      }
    >
      <div className="flex flex-col gap-[20px]">
        <Segmented
          label="Which to show"
          value={scope}
          onChange={setScope}
          options={[
            { key: 'flagged', label: 'Flagged', icon: TriangleAlert, count: flagged.length },
            { key: 'ready', label: 'Ready', icon: Check, count: ready.length },
          ]}
        />

        {shown.length === 0 ? (
          <Card titleSize="sm" title={scope === 'flagged' ? 'Flagged' : 'Ready'}>
            <p className="text-[14px] text-sh-text-2">
              {scope === 'flagged' ? 'No site has a readiness flag tonight.' : 'No site is clear of flags tonight — each one has something that changes where the ambulance goes.'}
            </p>
          </Card>
        ) : (
          <div className="grid gap-[16px] lg:grid-cols-2">
            {shown.map((s) => (
              <SiteCard key={s.code} site={s} flags={flagsOf(s)} aiActive={aiActive} />
            ))}
          </div>
        )}

        <Why label="What ready means, and how the flags are found">
          <ul className="flex flex-col gap-[6px]">
            {READY_MEANS.map((t) => (
              <li key={t} className="flex gap-[8px]">
                <Icon icon={Check} size={13} className="mt-[4px] text-sh-norm-fg" />
                {t}
              </li>
            ))}
          </ul>
          <p>A site missing any of these is not unusable — it changes where the ambulance goes, which is why this screen exists rather than a single up-or-down status.</p>
          {/* The old line named AI-622's failure predictions too; the forecast is gone, and so is its half of the sentence. */}
          <p className="text-sh-text-3">The flags are AI-816 gap detections at G1 — they notice, and nobody is stopped from working. The training matrix and the maintenance schedule remain the authority.</p>
        </Why>
      </div>
    </ScreenFrame>
  )
}

/** One site: name · beds · CT chip, then the flags as one line. */
function SiteCard({ site: s, flags, aiActive }: { site: Site; flags: string[]; aiActive: boolean }) {
  const flagged = flags.length > 0
  return (
    <Card
      titleSize="sm"
      title={
        <>
          {s.code} <span className="font-normal text-sh-text-2">· {s.name}</span>
        </>
      }
      right={
        <>
          <PillTag tone={ROLE_TONE[s.role]} size="sm">
            {s.role}
          </PillTag>
          <PillTag tone={CT_TONE[s.ctStatus]} size="sm" icon={s.ctStatus === 'none' ? Ban : Scan}>
            CT {s.ctStatus}
          </PillTag>
        </>
      }
      headerClassName="flex-wrap"
      className={cn(flagged && 'shadow-[inset_4px_0_0_var(--warn)]')}
    >
      <p className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px] text-[14px] tabular-nums text-sh-text-2">
        <span>
          beds {s.strokeBeds.free}/{s.strokeBeds.total}
        </span>
        <span className="text-sh-text-3">·</span>
        <span>cath lab {s.cathLab}</span>
        <span className="text-sh-text-3">·</span>
        <span className="min-w-0">{s.neurologist}</span>
      </p>
      {flagged ? (
        <p className="mt-[10px] flex items-start gap-[8px] text-[14px] font-medium text-sh-warn-fg">
          <Icon icon={aiActive ? Sparkles : TriangleAlert} size={14} className="mt-[3px]" />
          <span>{flags.join(' · ')}</span>
        </p>
      ) : (
        <p className="mt-[10px] flex items-center gap-[8px] text-[14px] font-medium text-sh-norm-fg">
          <Icon icon={Check} size={14} />
          No readiness flags tonight
        </p>
      )}
    </Card>
  )
}
