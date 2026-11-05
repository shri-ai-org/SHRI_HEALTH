// Doctor schedule config and its computed forms. The schedule stored on a
// Provider is CONFIG (working days + hours + slot length), never a
// pre-built list of slots — the actual per-date slot grid is always
// computed by domain/selectors.getDoctorSchedule/getSlotBoard.

export interface ScheduleBreak {
  start: string
  end: string
}

export interface ScheduleConfig {
  /** 0 (Sunday) .. 6 (Saturday), as returned by Date#getDay(). */
  workingDays: number[]
  /** "HH:MM" local time. */
  startTime: string
  endTime: string
  slotMinutes: number
  breaks: ScheduleBreak[]
}

/** actions.registerDoctor / updateDoctor's schedule input — same shape,
 *  before defaults are applied. */
export interface ScheduleConfigInput {
  workingDays?: number[]
  startTime?: string
  endTime?: string
  slotMinutes?: number | string
  breaks?: ScheduleBreak[]
}

export interface DoctorLeave {
  leaveId: string
  providerId: string
  date: string
  reason: string
}

/** domain/selectors.getDoctorSchedule's return shape — the schedule resolved
 *  for one specific date. */
export interface DoctorSchedule {
  providerId: string
  date: string
  slots: string[]
  breaks: ScheduleBreak[]
  onLeave: boolean
  leaveReason: string | null
  sessionStart: string
  sessionEnd: string
  slotMinutes: number
}
