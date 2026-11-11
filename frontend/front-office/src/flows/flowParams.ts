// Flows live in the URL as `?flow=<name>` plus a fixed set of reserved keys
// that say where the flow starts (which patient, doctor, bill …). The page
// underneath keeps its own params; flows never write to the URL once open.

export const FLOW_NAMES = ['schedule', 'consult', 'reschedule', 'admit', 'discharge'] as const
export type FlowName = (typeof FLOW_NAMES)[number]

export const FLOW_PARAM_KEYS = ['uhid', 'dept', 'doctor', 'date', 'slot', 'ward', 'bed', 'admission', 'appointment'] as const
export type FlowParamKey = (typeof FLOW_PARAM_KEYS)[number]
export type FlowParams = Partial<Record<FlowParamKey, string>>

/** Router state a flow entry carries: whether opening it pushed a history
 *  entry (so closing can step back instead of adding another). */
export interface FlowLocationState {
  flowPushed?: boolean
}

export interface ActiveFlow {
  /** Raw name from the URL — may not be a known flow. */
  name: string
  params: FlowParams
  /** Identity of this opening; a flow is re-created when it changes. */
  key: string
}

export function isFlowName(name: string): name is FlowName {
  return (FLOW_NAMES as readonly string[]).includes(name)
}

export function readFlow(search: string): ActiveFlow | null {
  const query = new URLSearchParams(search)
  const name = query.get('flow')
  if (!name) return null
  const params: FlowParams = {}
  for (const key of FLOW_PARAM_KEYS) {
    const value = query.get(key)
    if (value) params[key] = value
  }
  const key = [name, ...FLOW_PARAM_KEYS.map((k) => params[k] ?? '')].join('|')
  return { name, params, key }
}

export function withoutFlow(search: string): string {
  const query = new URLSearchParams(search)
  query.delete('flow')
  for (const key of FLOW_PARAM_KEYS) query.delete(key)
  const rest = query.toString()
  return rest ? `?${rest}` : ''
}

export function withFlow(search: string, name: FlowName, params: FlowParams = {}): string {
  const query = new URLSearchParams(withoutFlow(search))
  query.set('flow', name)
  for (const key of FLOW_PARAM_KEYS) {
    const value = params[key]
    if (value) query.set(key, value)
  }
  return `?${query.toString()}`
}
