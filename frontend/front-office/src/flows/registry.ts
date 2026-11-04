import type { ComponentType } from 'react'
import type { FlowName, FlowParams } from './flowParams'
import { ScheduleFlow } from './schedule/ScheduleFlow'
import { AdmitFlow } from './admit/AdmitFlow'
import { DischargeFlow } from './discharge/DischargeFlow'
import { RescheduleFlow } from './reschedule/RescheduleFlow'
import { CheckOutFlow } from './checkout/CheckOutFlow'

export interface FlowProps {
  params: FlowParams
  /** Closes the flow and returns to the page underneath. Safe to call twice. */
  onClose: () => void
  /** Booked from check-out (the revisit): told the new booking instead of opening the patient's profile. */
  onBooked?: (appointmentId: string) => void
}

/** Every flow FlowHost can open. A name in the URL that isn't here is
 *  stripped from the address. */
export const FLOWS: Partial<Record<FlowName, ComponentType<FlowProps>>> = {
  schedule: ScheduleFlow,
  // The old Start Consultation: walk-ins are now part of Schedule.
  consult: ScheduleFlow,
  reschedule: RescheduleFlow,
  admit: AdmitFlow,
  discharge: DischargeFlow,
  // Check-out at the desk (D98): new, no source screen (Minalini's exception of 2026-11-04).
  checkout: CheckOutFlow,
}
