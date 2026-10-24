// Shri Health design system, U.S. ambulatory edition. Import from here, not from inner files.
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/Button'
export { DataTable, type Column, type DataTableProps } from './components/DataTable'
export { Field, type FieldProps } from './components/Field'
export { Alert, Badge, EmptyState, ErrorState, Spinner, type AlertTone, type BadgeTone } from './components/feedback'
export {
  DateInput,
  isOverLimit,
  MoneyInput,
  PhoneInput,
  Select,
  StateSelect,
  Textarea,
  TextInput,
  type MoneyInputProps,
  type TextareaProps,
} from './components/inputs'
export { ConfirmDialog, Modal, type ModalProps } from './components/Modal'
export { Tabs, type TabItem } from './components/Tabs'
export { ToastProvider, useToast } from './components/Toast'

export { formatAddressLines, isValidState, isValidZip, normalizeZip, US_STATES, type Address } from './format/address'
export {
  ageInYears,
  formatDate,
  formatDateTime,
  formatTime,
  isValidTimeZone,
  minutesBetween,
  formatPartialDate,
  parsePartialDate,
  parseUsDate,
  TIME_ZONE_MISSING,
  todayIn,
} from './format/datetime'
export { formatMoney, parseMoneyInput, type Money } from './format/money'
export { formatNameFamilyFirst, formatNameGivenFirst, type HumanName } from './format/names'
export { formatPhone, formatPhoneLast4, parseUsPhone } from './format/phone'
export { fahrenheitToCelsius, formatHeightFeetInches, inchesToCentimeters, poundsToKilograms, toUsDisplay, type Quantity } from './format/units'

export {
  fieldErrorMessage,
  fieldKey,
  isKnownProblemCode,
  isProblem,
  PROBLEM_CODES,
  problemCopy,
  type FieldError,
  type Problem,
  type ProblemAction,
  type ProblemCode,
} from './problem/problem'

export { BreakGlassDialog, type BreakGlassReasonCode, type BreakGlassRequest } from './safety/BreakGlassDialog'
export { IdleTimeoutWarning } from './safety/IdleTimeoutWarning'
export { ProblemAlert } from './safety/ProblemAlert'
export { RecordChangedDialog, type FieldChange } from './safety/RecordChangedDialog'
export { safeInitials, SharedStatusBoard, statusLabel, type SharedBoardItem } from './safety/SharedStatusBoard'
