export type VisitStatus = 'Open' | 'Closed'

export interface Visit {
  visitId: string
  patientId: string
  appointmentId: string | null
  providerId: string
  status: VisitStatus
  arrivalTime: number
  checkInTime: number
  closedAt: number | null
}
