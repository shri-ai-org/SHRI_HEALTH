// SHRI_HEALTH: the clinic's AI switches (getAiSettings, replaceAiSettings; inventory #114-115;
// FRS §3.4 kill switch; D118), in the front office's user menu, where the administrator works
// (there is no admin app yet). Shown to whoever may read them (ADM; CO read-only); only ADM may
// change them (`ai-settings:update`). Turning a switch off stores a reason, as the API requires.
// On a demo server a feature never set counts as on (D118); this switch is the only way off.
import { useEffect, useState } from 'react'

import { ApiError } from '../../src/api/client'
import { getAiSettings, replaceAiSettings } from '../../src/api/generated/endpoints/ai/ai'
import type { AiSettings } from '../../src/api/generated/model'
import { useSession } from '../../src/api/session'

const FEATURE_LABEL: Record<string, string> = {
  'ambient-documentation': 'Draft notes with AI',
  'chart-summary': 'Chart summary, assistant, morning brief, differentials',
}
const OFF_REASON = 'Switched off in the AI settings by the administrator'

type Loaded = { settings: AiSettings; etag: string }

function Toggle({ label, on, disabled, onChange }: { label: string; on: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 px-3 text-sm text-ink">
      <span className="min-w-0">{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={on}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-9 shrink-0 cursor-pointer accent-primary-600 disabled:cursor-not-allowed"
      />
    </label>
  )
}

/** The clinic's AI switches, or nothing for a role that may not read them. */
export function AiSettingsSwitch() {
  const { state } = useSession()
  const mayChange = state.status === 'signed-in' && state.session.user.roles.includes('ADM')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    getAiSettings()
      .then((res) => {
        if (live && res.status === 200) setLoaded({ settings: res.data, etag: res.headers.get('ETag') ?? '' })
      })
      .catch(() => undefined) // 403: this role doesn't see the switches
    return () => {
      live = false
    }
  }, [])

  if (!loaded) return null

  async function save(update: { clinicEnabled?: boolean; feature?: string; enabled?: boolean }) {
    if (!loaded) return
    setBusy(true)
    setError(null)
    const clinicEnabled = update.clinicEnabled ?? loaded.settings.clinicEnabled
    const features = update.feature
      ? [{ feature: update.feature, enabled: Boolean(update.enabled), ...(update.enabled ? {} : { reason: OFF_REASON }) }]
      : []
    try {
      const res = await replaceAiSettings(
        { clinicEnabled, features } as Parameters<typeof replaceAiSettings>[0],
        { 'If-Match': loaded.etag },
      )
      if (res.status === 200) setLoaded({ settings: res.data, etag: res.headers.get('ETag') ?? loaded.etag })
    } catch (e: unknown) {
      // 412: changed elsewhere; read the current switches again.
      if (e instanceof ApiError && e.status === 412) {
        const again = await getAiSettings()
        if (again.status === 200) setLoaded({ settings: again.data, etag: again.headers.get('ETag') ?? '' })
        setError('The AI settings changed elsewhere; here they are now.')
      } else {
        setError('The AI settings were not saved. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const { settings } = loaded
  return (
    <section aria-label="AI for this clinic" className="py-1">
      <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">AI for this clinic</div>
      <Toggle label="AI on for the clinic" on={settings.clinicEnabled} disabled={!mayChange || busy} onChange={(on) => void save({ clinicEnabled: on })} />
      {settings.features.map((f) => (
        <Toggle
          key={f.feature}
          label={FEATURE_LABEL[f.feature] ?? f.feature}
          on={settings.clinicEnabled && f.enabled}
          disabled={!mayChange || busy || !settings.clinicEnabled}
          onChange={(on) => void save({ feature: f.feature, enabled: on })}
        />
      ))}
      {!mayChange ? <p className="px-3 pb-1 text-xs text-ink-subtle">Only an administrator can change these.</p> : null}
      {error ? (
        <p role="alert" className="px-3 pb-1 text-xs text-critical-fg">
          {error}
        </p>
      ) : null}
    </section>
  )
}
