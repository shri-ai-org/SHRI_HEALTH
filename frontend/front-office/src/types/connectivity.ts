// Honest, simulated service status — this build has no backend, so `mode`
// is always 'development'. `network`/`abha` are modeled as real two-state
// values (not just the one the seed data happens to produce) because the
// UI branches on both — see components/frontoffice/ConnectivityStrip and
// ServiceStatusCard.
export type ConnectivityMode = 'development'
export type NetworkStatus = 'online' | 'offline'
export type AbhaStatus = 'available' | 'unavailable'

export interface Connectivity {
  mode: ConnectivityMode
  network: NetworkStatus
  abha: AbhaStatus
}
