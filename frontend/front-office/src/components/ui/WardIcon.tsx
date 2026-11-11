import { BedDouble, BedSingle, HeartPulse, Siren } from 'lucide-react'

/** The one icon for each kind of ward: ICU a heartbeat, Emergency a siren,
 *  a private room a single bed, every other ward a double bed. */
export function WardIcon({ ward, className }: { ward: string | null; className?: string }) {
  if (ward === 'ICU') return <HeartPulse className={className} strokeWidth={1.75} aria-hidden="true" />
  if (ward === 'Emergency') return <Siren className={className} strokeWidth={1.75} aria-hidden="true" />
  if (ward === 'Private Ward') return <BedSingle className={className} strokeWidth={1.75} aria-hidden="true" />
  return <BedDouble className={className} strokeWidth={1.75} aria-hidden="true" />
}
