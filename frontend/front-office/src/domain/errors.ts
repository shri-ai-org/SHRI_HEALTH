// Domain-level errors thrown by src/domain/actions.ts. A real backend would
// return these as rejected requests (4xx + a code); until one exists, the
// in-memory store enforces the same invariants synchronously so the UI can
// exercise real optimistic-update/rollback behavior against them.
export type DomainErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'SLOT_ALREADY_BOOKED'
  | 'PATIENT_OVERLAP'
  | 'HAS_OPEN_APPOINTMENTS'
  | 'DUPLICATE'
  | 'PASS_LIMIT'
  | 'BED_UNAVAILABLE'
  | 'ALREADY_ADMITTED'
  | 'BALANCE_DUE'

export class DomainError extends Error {
  code: DomainErrorCode

  constructor(code: DomainErrorCode, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}
