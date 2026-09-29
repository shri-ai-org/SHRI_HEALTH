/**
 * The consultant's standing week — the session templates (S-05-04) and the
 * fixed theatre and on-call slots of the base week (S-05-05). The month
 * calendar on My Day lays these over every date they apply to; the templates
 * screen edits them. One source, so the two can never disagree.
 */

export interface Session {
  id: string
  day: string
  start: string
  end: string
  slotMin: number
  clinic: string
  capacity: number
  effectiveFrom: string
  /** AI-608's observation about this session. */
  observation?: string
  observationBand?: 'HIGH' | 'MED' | 'LOW'
  observationConfidence?: number
}

export const SESSIONS: Session[] = [
  {
    id: 'T-1',
    day: 'Monday',
    start: '08:00',
    end: '12:00',
    slotMin: 10,
    clinic: 'General medicine, new and follow-up',
    capacity: 24,
    effectiveFrom: '01-Apr-2026',
    observation:
      'This session has run over by a median of 34 minutes across the last 12 weeks. At 24 slots of 10 minutes against a mean consultation of 11, the template is 24 minutes short before anything goes wrong.',
    observationBand: 'HIGH',
    observationConfidence: 0.91,
  },
  { id: 'T-2', day: 'Tuesday', start: '14:00', end: '17:00', slotMin: 15, clinic: 'Thyroid and endocrine follow-up', capacity: 12, effectiveFrom: '01-Apr-2026' },
  { id: 'T-3', day: 'Thursday', start: '08:00', end: '11:00', slotMin: 10, clinic: 'General medicine, follow-up only', capacity: 18, effectiveFrom: '01-Apr-2026' },
  {
    id: 'T-4',
    day: 'Friday',
    start: '09:00',
    end: '12:00',
    slotMin: 20,
    clinic: 'Complex and multi-morbidity',
    capacity: 9,
    effectiveFrom: '01-Jul-2026',
    observation:
      'Consistently finishes 18 minutes early. Two more slots would fit without pushing the mean consultation down.',
    observationBand: 'MED',
    observationConfidence: 0.74,
  },
]

/** The base week's other fixed commitments, as S-05-05 draws them. */
export interface WeeklySlot {
  id: string
  day: string
  start: string
  end: string
  title: string
  icon: string
}

export const WEEKLY_SLOTS: WeeklySlot[] = [
  { id: 'W-theatre', day: 'Wednesday', start: '08:00', end: '11:00', title: 'Theatre list', icon: 'Syringe' },
  { id: 'W-oncall', day: 'Friday', start: '16:00', end: '17:00', title: 'On call', icon: 'Phone' },
]
