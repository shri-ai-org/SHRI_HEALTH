/**
 * Where a procedure or an operation is done — the places a doctor can book
 * one into from the Today panel (`ScheduleDialogs` → Schedule an appointment).
 */

export const PROCEDURE_PLACES = ['Main theatre OT-1', 'Main theatre OT-2', 'Cath lab CATH-1', 'Procedure room'] as const
export type ProcedurePlace = (typeof PROCEDURE_PLACES)[number]
