"""Value sets. FHIR enums use the exact FHIR R4 codes of their required binding; admin enums
use lower-kebab codes. Stored as VARCHAR + named CHECK (``base.enum_type``)."""
# The standard StrEnum: str(), format() and == give the value, as the hand-written
# `class StrEnum(str, Enum)` with `__str__ = value` did before.
from enum import StrEnum


# =========================================================================== provenance / meta
class EntrySource(StrEnum):
    CLINICIAN = "clinician"             # entered and verified in Shri Health
    IMPORTED = "imported"               # migration (OpenEMR) or C-CDA
    PATIENT_REPORTED = "patient-reported"
    AI_GENERATED = "ai-generated"       # accepted AI suggestion (ai_suggestion_id required)
    DEVICE = "device"
    INTERFACE = "interface"             # lab / eRx / clearinghouse feed


class SecurityLabel(StrEnum):           # v3 Confidentiality + ActCode sensitivity
    LOW = "L"
    MODERATE = "M"
    NORMAL = "N"
    RESTRICTED = "R"
    VERY_RESTRICTED = "V"
    PSYCHOTHERAPY = "PSY"
    SUBSTANCE_USE = "SUD"
    ETHANOL = "ETH"
    HIV = "HIV"
    SEXUAL_ABUSE = "SEX"
    SOCIAL_SERVICES = "SOC"
    CELEBRITY = "CEL"


class QuantityComparator(StrEnum):
    LT = "<"
    LE = "<="
    GE = ">="
    GT = ">"


# =========================================================================== datatypes
class AdministrativeGender(StrEnum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"
    UNKNOWN = "unknown"


class BirthSex(StrEnum):                # US Core birthsex extension
    FEMALE = "F"
    MALE = "M"
    UNKNOWN = "UNK"


class IdentifierUse(StrEnum):
    USUAL = "usual"
    OFFICIAL = "official"
    TEMP = "temp"
    SECONDARY = "secondary"
    OLD = "old"


class NameUse(StrEnum):
    USUAL = "usual"
    OFFICIAL = "official"
    TEMP = "temp"
    NICKNAME = "nickname"
    ANONYMOUS = "anonymous"
    OLD = "old"
    MAIDEN = "maiden"


class ContactPointSystem(StrEnum):
    PHONE = "phone"
    FAX = "fax"
    EMAIL = "email"
    PAGER = "pager"
    URL = "url"
    SMS = "sms"
    OTHER = "other"


class ContactPointUse(StrEnum):
    HOME = "home"
    WORK = "work"
    TEMP = "temp"
    OLD = "old"
    MOBILE = "mobile"


class AddressUse(StrEnum):
    HOME = "home"
    WORK = "work"
    TEMP = "temp"
    OLD = "old"
    BILLING = "billing"


class AddressType(StrEnum):
    POSTAL = "postal"
    PHYSICAL = "physical"
    BOTH = "both"


class RaceEthnicityKind(StrEnum):       # US Core race / ethnicity extensions
    RACE = "race"
    ETHNICITY = "ethnicity"


class RaceEthnicityLevel(StrEnum):
    OMB = "ombCategory"
    DETAILED = "detailed"


# =========================================================================== patient / directory
class LinkType(StrEnum):
    REPLACED_BY = "replaced-by"
    REPLACES = "replaces"
    REFER = "refer"
    SEEALSO = "seealso"


class LocationStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    INACTIVE = "inactive"


class LocationMode(StrEnum):
    INSTANCE = "instance"
    KIND = "kind"


class BedStatus(StrEnum):               # v2-0116 Location.operationalStatus
    CLOSED = "C"
    HOUSEKEEPING = "H"
    ISOLATED = "I"
    CONTAMINATED = "K"
    OCCUPIED = "O"
    UNOCCUPIED = "U"


class DaysOfWeek(StrEnum):
    MON = "mon"
    TUE = "tue"
    WED = "wed"
    THU = "thu"
    FRI = "fri"
    SAT = "sat"
    SUN = "sun"


# =========================================================================== scheduling
class AppointmentStatus(StrEnum):
    PROPOSED = "proposed"
    PENDING = "pending"
    BOOKED = "booked"
    ARRIVED = "arrived"
    FULFILLED = "fulfilled"
    CANCELLED = "cancelled"
    NOSHOW = "noshow"
    ENTERED_IN_ERROR = "entered-in-error"
    CHECKED_IN = "checked-in"
    WAITLIST = "waitlist"


class ParticipantRequired(StrEnum):
    REQUIRED = "required"
    OPTIONAL = "optional"
    INFORMATION_ONLY = "information-only"


class ParticipationStatus(StrEnum):
    ACCEPTED = "accepted"
    DECLINED = "declined"
    TENTATIVE = "tentative"
    NEEDS_ACTION = "needs-action"


class VisitFlowStep(StrEnum):           # FR-SCH-02 visit status board
    ARRIVED = "arrived"
    CHECKED_IN = "checked-in"
    ROOMED = "roomed"
    WITH_PROVIDER = "with-provider"
    CHECKED_OUT = "checked-out"


# =========================================================================== encounter
class EncounterStatus(StrEnum):
    PLANNED = "planned"
    ARRIVED = "arrived"
    TRIAGED = "triaged"
    IN_PROGRESS = "in-progress"
    ONLEAVE = "onleave"
    FINISHED = "finished"
    CANCELLED = "cancelled"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


class EncounterClass(StrEnum):          # v3 ActCode
    AMBULATORY = "AMB"
    VIRTUAL = "VR"
    HOME_HEALTH = "HH"
    EMERGENCY = "EMER"
    INPATIENT = "IMP"                   # India hospital edition only


class EncounterLocationStatus(StrEnum):
    PLANNED = "planned"
    ACTIVE = "active"
    RESERVED = "reserved"
    COMPLETED = "completed"


# =========================================================================== clinical
class ConditionClinicalStatus(StrEnum):
    ACTIVE = "active"
    RECURRENCE = "recurrence"
    RELAPSE = "relapse"
    INACTIVE = "inactive"
    REMISSION = "remission"
    RESOLVED = "resolved"


class ConditionVerificationStatus(StrEnum):
    UNCONFIRMED = "unconfirmed"
    PROVISIONAL = "provisional"
    DIFFERENTIAL = "differential"
    CONFIRMED = "confirmed"
    REFUTED = "refuted"
    ENTERED_IN_ERROR = "entered-in-error"


class AllergyClinicalStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    RESOLVED = "resolved"


class AllergyVerificationStatus(StrEnum):
    UNCONFIRMED = "unconfirmed"
    CONFIRMED = "confirmed"
    REFUTED = "refuted"
    ENTERED_IN_ERROR = "entered-in-error"


class AllergyType(StrEnum):
    ALLERGY = "allergy"
    INTOLERANCE = "intolerance"


class AllergyCategory(StrEnum):
    FOOD = "food"
    MEDICATION = "medication"
    ENVIRONMENT = "environment"
    BIOLOGIC = "biologic"


class AllergyCriticality(StrEnum):
    LOW = "low"
    HIGH = "high"
    UNABLE_TO_ASSESS = "unable-to-assess"


class ReactionSeverity(StrEnum):
    MILD = "mild"
    MODERATE = "moderate"
    SEVERE = "severe"


class ObservationStatus(StrEnum):
    REGISTERED = "registered"
    PRELIMINARY = "preliminary"
    FINAL = "final"
    AMENDED = "amended"
    CORRECTED = "corrected"
    CANCELLED = "cancelled"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


class EventStatus(StrEnum):             # Procedure.status
    PREPARATION = "preparation"
    IN_PROGRESS = "in-progress"
    NOT_DONE = "not-done"
    ON_HOLD = "on-hold"
    STOPPED = "stopped"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


class FamilyHistoryStatus(StrEnum):
    PARTIAL = "partial"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    HEALTH_UNKNOWN = "health-unknown"


class ImmunizationStatus(StrEnum):
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    NOT_DONE = "not-done"


# =========================================================================== medications
class MedicationStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    ENTERED_IN_ERROR = "entered-in-error"


class MedicationRequestStatus(StrEnum):
    ACTIVE = "active"
    ON_HOLD = "on-hold"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    STOPPED = "stopped"
    DRAFT = "draft"
    UNKNOWN = "unknown"


class MedicationRequestIntent(StrEnum):
    PROPOSAL = "proposal"
    PLAN = "plan"
    ORDER = "order"
    ORIGINAL_ORDER = "original-order"
    REFLEX_ORDER = "reflex-order"
    FILLER_ORDER = "filler-order"
    INSTANCE_ORDER = "instance-order"
    OPTION = "option"


class MedicationRequestCategory(StrEnum):
    INPATIENT = "inpatient"
    OUTPATIENT = "outpatient"
    COMMUNITY = "community"
    DISCHARGE = "discharge"


class MedicationStatementStatus(StrEnum):
    ACTIVE = "active"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    INTENDED = "intended"
    STOPPED = "stopped"
    ON_HOLD = "on-hold"
    UNKNOWN = "unknown"
    NOT_TAKEN = "not-taken"


class MedicationDispenseStatus(StrEnum):
    PREPARATION = "preparation"
    IN_PROGRESS = "in-progress"
    CANCELLED = "cancelled"
    ON_HOLD = "on-hold"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    STOPPED = "stopped"
    DECLINED = "declined"
    UNKNOWN = "unknown"


class RequestPriority(StrEnum):
    ROUTINE = "routine"
    URGENT = "urgent"
    ASAP = "asap"
    STAT = "stat"


class DeaSchedule(StrEnum):
    CII = "CII"
    CIII = "CIII"
    CIV = "CIV"
    CV = "CV"


class UnitsOfTime(StrEnum):
    S = "s"
    MIN = "min"
    H = "h"
    D = "d"
    WK = "wk"
    MO = "mo"
    A = "a"


class DetectedIssueStatus(StrEnum):
    REGISTERED = "registered"
    PRELIMINARY = "preliminary"
    FINAL = "final"
    AMENDED = "amended"
    CORRECTED = "corrected"
    CANCELLED = "cancelled"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


class DetectedIssueSeverity(StrEnum):
    HIGH = "high"
    MODERATE = "moderate"
    LOW = "low"


class RuleSource(StrEnum):              # §3.4 layering: rules shown separately from AI
    DETERMINISTIC = "deterministic"
    AI = "ai"


# =========================================================================== orders / results
class RequestStatus(StrEnum):           # ServiceRequest.status
    DRAFT = "draft"
    ACTIVE = "active"
    ON_HOLD = "on-hold"
    REVOKED = "revoked"
    COMPLETED = "completed"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


class RequestIntent(StrEnum):
    PROPOSAL = "proposal"
    PLAN = "plan"
    DIRECTIVE = "directive"
    ORDER = "order"
    ORIGINAL_ORDER = "original-order"
    REFLEX_ORDER = "reflex-order"
    FILLER_ORDER = "filler-order"
    INSTANCE_ORDER = "instance-order"
    OPTION = "option"


class OrderFulfillmentStatus(StrEnum):  # FR-ORD-01 lab workflow (extension on ServiceRequest)
    NOT_SENT = "not-sent"
    TRANSMITTED = "transmitted"
    ACKNOWLEDGED = "acknowledged"
    SPECIMEN_COLLECTED = "specimen-collected"
    IN_PROCESS = "in-process"
    PARTIAL_RESULT = "partial-result"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


class SpecimenStatus(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    UNSATISFACTORY = "unsatisfactory"
    ENTERED_IN_ERROR = "entered-in-error"


class DiagnosticReportStatus(StrEnum):
    REGISTERED = "registered"
    PARTIAL = "partial"
    PRELIMINARY = "preliminary"
    FINAL = "final"
    AMENDED = "amended"
    CORRECTED = "corrected"
    APPENDED = "appended"
    CANCELLED = "cancelled"
    ENTERED_IN_ERROR = "entered-in-error"
    UNKNOWN = "unknown"


# =========================================================================== documents / consent
class DocumentReferenceStatus(StrEnum):
    CURRENT = "current"
    SUPERSEDED = "superseded"
    ENTERED_IN_ERROR = "entered-in-error"


class CompositionStatus(StrEnum):       # also DocumentReference.docStatus
    PRELIMINARY = "preliminary"
    FINAL = "final"
    AMENDED = "amended"
    ENTERED_IN_ERROR = "entered-in-error"


class DocumentRelationshipType(StrEnum):
    REPLACES = "replaces"
    TRANSFORMS = "transforms"
    SIGNS = "signs"
    APPENDS = "appends"


class CompositionAttestationMode(StrEnum):
    PERSONAL = "personal"
    PROFESSIONAL = "professional"
    LEGAL = "legal"
    OFFICIAL = "official"


class DocumentOrigin(StrEnum):          # extension: how a document arrived
    UPLOAD = "upload"
    SCAN = "scan"
    FAX = "fax"
    LAB = "lab"
    CCDA = "ccda"
    MIGRATION = "migration"
    GENERATED = "generated"
    PORTAL = "portal"


class IndexingStatus(StrEnum):          # eFax / unfiled document queue
    NOT_REQUIRED = "not-required"
    PENDING = "pending"
    INDEXED = "indexed"
    REJECTED = "rejected"


class ConsentState(StrEnum):
    DRAFT = "draft"
    PROPOSED = "proposed"
    ACTIVE = "active"
    REJECTED = "rejected"
    INACTIVE = "inactive"
    ENTERED_IN_ERROR = "entered-in-error"


class ConsentProvisionType(StrEnum):
    DENY = "deny"
    PERMIT = "permit"


class ConsentKind(StrEnum):             # Shri consent categories (local CodeSystem)
    TREATMENT = "treatment"
    PRIVACY_NOTICE = "privacy-notice"
    AMBIENT_RECORDING = "ambient-recording"
    TELEHEALTH = "telehealth"
    RESEARCH = "research"
    INFORMATION_SHARING = "information-sharing"
    FINANCIAL = "financial"


class SignatureMethod(StrEnum):
    VERBAL = "verbal"
    WRITTEN = "written"
    ELECTRONIC = "electronic"


class FinancialResourceStatus(StrEnum):  # Coverage.status
    ACTIVE = "active"
    CANCELLED = "cancelled"
    DRAFT = "draft"
    ENTERED_IN_ERROR = "entered-in-error"


class SubscriberRelationship(StrEnum):
    CHILD = "child"
    PARENT = "parent"
    SPOUSE = "spouse"
    COMMON = "common"
    OTHER = "other"
    SELF = "self"
    INJURED = "injured"


class CoverageClassType(StrEnum):
    GROUP = "group"
    SUBGROUP = "subgroup"
    PLAN = "plan"
    SUBPLAN = "subplan"
    CLS = "class"
    RXBIN = "rxbin"
    RXPCN = "rxpcn"
    RXID = "rxid"
    RXGROUP = "rxgroup"


class ProvenanceEntityRole(StrEnum):
    DERIVATION = "derivation"
    REVISION = "revision"
    QUOTATION = "quotation"
    SOURCE = "source"
    REMOVAL = "removal"


# =========================================================================== admin: practice
class FacilityRole(StrEnum):
    CLINIC = "clinic"
    LAB = "lab"
    IMAGING = "imaging"
    BILLING = "billing"


class SettingValueType(StrEnum):
    STRING = "string"
    INTEGER = "integer"
    BOOLEAN = "boolean"
    DECIMAL = "decimal"
    JSON = "json"


class FavoriteKind(StrEnum):
    NOTE_TEMPLATE = "note-template"
    DIAGNOSIS = "diagnosis"
    ORDER = "order"
    ORDER_SET = "order-set"
    PRESCRIPTION = "prescription"
    PHRASE = "phrase"


class WorkItemStatus(StrEnum):
    OPEN = "open"
    IN_PROGRESS = "in-progress"
    ON_HOLD = "on-hold"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class WorkItemType(StrEnum):            # FR-ENC-05 clinician inbox + front-office queues
    RESULT_REVIEW = "result-review"
    REFILL_REQUEST = "refill-request"
    MESSAGE = "message"
    TASK = "task"
    DOCUMENT_REVIEW = "document-review"
    UNSIGNED_NOTE = "unsigned-note"
    COSIGN = "cosign"
    FAX_INDEXING = "fax-indexing"
    UNMATCHED_RESULT = "unmatched-result"
    ELIGIBILITY = "eligibility"
    CLAIM_REJECTION = "claim-rejection"
    ROOMING = "rooming"


# =========================================================================== admin: orders
class LabConnectionType(StrEnum):
    DIRECT_HL7 = "direct-hl7"
    AGGREGATOR = "aggregator"
    FHIR = "fhir"
    MANUAL = "manual"


class BillTo(StrEnum):
    INSURANCE = "insurance"
    PATIENT = "patient"
    CLIENT = "client"


class CollectionMode(StrEnum):
    IN_OFFICE = "in-office"
    PATIENT_SERVICE_CENTER = "psc"
    HOME = "home"


class AnswerType(StrEnum):
    STRING = "string"
    DECIMAL = "decimal"
    INTEGER = "integer"
    DATE = "date"
    BOOLEAN = "boolean"
    CHOICE = "choice"


class AbnOption(StrEnum):               # CMS-R-131 options
    OPTION_1 = "option-1"
    OPTION_2 = "option-2"
    OPTION_3 = "option-3"


class MedicalNecessityOutcome(StrEnum):
    COVERED = "covered"
    NOT_COVERED = "not-covered"
    FREQUENCY_LIMITED = "frequency-limited"
    UNKNOWN = "unknown"


class ResultAckAction(StrEnum):
    REVIEWED = "reviewed"
    PATIENT_NOTIFIED = "patient-notified"
    FOLLOW_UP_ORDERED = "follow-up-ordered"
    FORWARDED = "forwarded"


class UnmatchedReason(StrEnum):
    NO_PATIENT = "no-patient"
    NO_ORDER = "no-order"
    MULTIPLE_PATIENTS = "multiple-patients"
    DEMOGRAPHIC_MISMATCH = "demographic-mismatch"


class UnmatchedResultStatus(StrEnum):
    OPEN = "open"
    MATCHED = "matched"
    REJECTED = "rejected"


# =========================================================================== admin: medication
class ErxMessageType(StrEnum):          # NCPDP SCRIPT transactions via the eRx vendor
    NEW_RX = "NewRx"
    CANCEL_RX = "CancelRx"
    CANCEL_RX_RESPONSE = "CancelRxResponse"
    RX_CHANGE_REQUEST = "RxChangeRequest"
    RX_CHANGE_RESPONSE = "RxChangeResponse"
    RX_RENEWAL_REQUEST = "RxRenewalRequest"
    RX_RENEWAL_RESPONSE = "RxRenewalResponse"
    RX_FILL = "RxFill"
    MEDICATION_HISTORY = "RxHistory"
    STATUS = "Status"
    ERROR = "Error"


class ErxTransactionStatus(StrEnum):
    QUEUED = "queued"
    SENT = "sent"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    ERROR = "error"
    RECEIVED = "received"
    RESPONDED = "responded"


# =========================================================================== admin: RCM
class PayerType(StrEnum):
    COMMERCIAL = "commercial"
    MEDICARE = "medicare"
    MEDICARE_ADVANTAGE = "medicare-advantage"
    MEDICAID = "medicaid"
    TRICARE = "tricare"
    WORKERS_COMP = "workers-comp"
    AUTO = "auto"
    SELF_PAY = "self-pay"
    OTHER = "other"


class EnrollmentTransaction(StrEnum):
    CLAIMS_837P = "837P"
    ERA_835 = "835"
    ELIGIBILITY_270 = "270"
    STATUS_276 = "276"
    EFT = "EFT"


class EnrollmentStatus(StrEnum):
    NOT_REQUIRED = "not-required"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class EligibilityTrigger(StrEnum):
    BOOKING = "booking"
    PRE_VISIT_BATCH = "pre-visit-batch"
    CHECK_IN = "check-in"
    MANUAL = "manual"


class EligibilityStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    INACTIVE = "inactive"
    NOT_FOUND = "not-found"
    ERROR = "error"
    TIMEOUT = "timeout"


class BenefitType(StrEnum):             # X12 271 EB01 (subset)
    ACTIVE_COVERAGE = "active-coverage"
    COPAY = "copay"
    COINSURANCE = "coinsurance"
    DEDUCTIBLE = "deductible"
    OUT_OF_POCKET = "out-of-pocket"
    LIMITATION = "limitation"
    NON_COVERED = "non-covered"


class CoverageLevel(StrEnum):
    INDIVIDUAL = "individual"
    FAMILY = "family"


class NetworkIndicator(StrEnum):
    IN_NETWORK = "in"
    OUT_OF_NETWORK = "out"
    NOT_APPLICABLE = "na"


class BenefitTimePeriod(StrEnum):
    CALENDAR_YEAR = "calendar-year"
    PLAN_YEAR = "plan-year"
    VISIT = "visit"
    REMAINING = "remaining"
    LIFETIME = "lifetime"


class SuperbillStatus(StrEnum):
    DRAFT = "draft"
    READY_FOR_REVIEW = "ready-for-review"
    APPROVED = "approved"
    BILLED = "billed"
    VOID = "void"


class ClaimStatus(StrEnum):
    DRAFT = "draft"
    READY = "ready"
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    PENDED = "pended"
    PAID = "paid"
    PARTIALLY_PAID = "partially-paid"
    DENIED = "denied"
    VOID = "void"


class ClaimFrequency(StrEnum):          # CLM05-3
    ORIGINAL = "1"
    REPLACEMENT = "7"
    VOID = "8"


class PayerSequence(StrEnum):
    PRIMARY = "P"
    SECONDARY = "S"
    TERTIARY = "T"


class ClaimEventSource(StrEnum):
    ACK_999 = "999"
    ACK_277CA = "277CA"
    STATUS_277 = "277"
    ERA_835 = "835"
    MANUAL = "manual"
    SCRUBBER = "scrubber"


class RemittancePaymentMethod(StrEnum):  # BPR04
    ACH = "ACH"
    CHECK = "CHK"
    NON_PAYMENT = "NON"
    FEDWIRE = "FWT"
    BOP = "BOP"


class PostingStatus(StrEnum):
    UNPOSTED = "unposted"
    PARTIAL = "partial"
    POSTED = "posted"
    EXCEPTION = "exception"


class AdjustmentGroup(StrEnum):         # CAS01
    CONTRACTUAL = "CO"
    PATIENT_RESPONSIBILITY = "PR"
    OTHER = "OA"
    PAYER_INITIATED = "PI"
    CORRECTION = "CR"


class PaymentMethod(StrEnum):
    CASH = "cash"
    CARD = "card"
    CHECK = "check"
    ACH = "ach"
    OTHER = "other"


# =========================================================================== admin: comms, files
class CommunicationChannel(StrEnum):
    SMS = "sms"
    EMAIL = "email"
    VOICE = "voice"
    PORTAL = "portal"
    LETTER = "letter"
    FAX = "fax"


class DeliveryStatus(StrEnum):
    QUEUED = "queued"
    SENT = "sent"
    DELIVERED = "delivered"
    FAILED = "failed"
    BOUNCED = "bounced"
    SUPPRESSED = "suppressed"


class CommunicationPurpose(StrEnum):
    REMINDER = "reminder"
    RESULTS = "results"
    BILLING = "billing"
    MARKETING = "marketing"
    CARE = "care"
    REFERRAL = "referral"


class FaxDirection(StrEnum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class FaxStatus(StrEnum):
    QUEUED = "queued"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    RECEIVED = "received"


class ScanStatus(StrEnum):
    PENDING = "pending"
    CLEAN = "clean"
    INFECTED = "infected"
    ERROR = "error"


# =========================================================================== admin: AI
class AIFeature(StrEnum):
    AMBIENT_DOCUMENTATION = "ambient-documentation"   # AI-01 (P0)
    CHART_SUMMARY = "chart-summary"                   # AI-02 (P0)
    DECISION_SUPPORT = "decision-support"             # AI-03 (P1)
    CODING_SUGGESTION = "coding-suggestion"           # AI-04 (P1)
    ORDER_SUGGESTION = "order-suggestion"             # AI-04 (P1)
    MEDICATION_ASSISTANCE = "medication-assistance"   # FR-MED-02 (P1)
    DOCUMENT_EXTRACTION = "document-extraction"
    INSURANCE_CARD_OCR = "insurance-card-ocr"


class AIRequestStatus(StrEnum):
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"
    DISABLED = "disabled"
    TIMEOUT = "timeout"


class AIConfidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class AIDecision(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    EDITED = "edited"
    REJECTED = "rejected"
    EXPIRED = "expired"


class AudioMode(StrEnum):
    AMBIENT = "ambient"
    DICTATION = "dictation"
    UPLOAD = "upload"


class AudioStatus(StrEnum):
    UPLOADED = "uploaded"
    TRANSCRIBING = "transcribing"
    TRANSCRIBED = "transcribed"
    FAILED = "failed"
    PURGED = "purged"


class KnowledgeApprovalStatus(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"
    WITHDRAWN = "withdrawn"
    SUPERSEDED = "superseded"


# =========================================================================== admin: audit etc.
class AuditAction(StrEnum):
    READ = "read"
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    SIGN = "sign"
    EXPORT = "export"
    PRINT = "print"
    LOGIN = "login"
    LOGOUT = "logout"
    ACCESS_DENIED = "access-denied"
    AI_REQUEST = "ai-request"
    AI_REVIEW = "ai-review"
    MERGE = "merge"
    BREAK_GLASS = "break-glass"
    CONFIG_CHANGE = "config-change"


class AuditOutcome(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"


class ActorType(StrEnum):
    USER = "user"
    SYSTEM = "system"
    AI = "ai"
    INTEGRATION = "integration"
    PATIENT = "patient"
    PARTNER = "partner"                 # a partner callback (/hooks/*), audited as phi-write (T37)
    ANONYMOUS = "anonymous"             # the public pre-registration form: nobody signed in (D96)


class IntegrationKind(StrEnum):
    LAB = "lab"
    CLEARINGHOUSE = "clearinghouse"
    ERX = "erx"
    NOTIFICATION = "notification"
    FAX = "fax"
    FHIR_PARTNER = "fhir-partner"
    TELEHEALTH = "telehealth"
    IMAGING = "imaging"
    PAYMENT = "payment"


class EndpointEnvironment(StrEnum):
    TEST = "test"
    PRODUCTION = "production"


class MessageDirection(StrEnum):
    OUTBOUND = "outbound"
    INBOUND = "inbound"


class IntegrationMessageStatus(StrEnum):
    QUEUED = "queued"
    SENDING = "sending"
    SENT = "sent"
    ACKNOWLEDGED = "acknowledged"
    RECEIVED = "received"
    PROCESSED = "processed"
    FAILED = "failed"
    DEAD_LETTER = "dead-letter"


class MigrationRunStatus(StrEnum):
    PLANNED = "planned"
    EXTRACTING = "extracting"
    PROFILING = "profiling"
    MAPPING = "mapping"
    IMPORTING = "importing"
    RECONCILING = "reconciling"
    AWAITING_ACCEPTANCE = "awaiting-acceptance"
    ACCEPTED = "accepted"
    FAILED = "failed"
    ROLLED_BACK = "rolled-back"


class MigrationRecordStatus(StrEnum):
    IMPORTED = "imported"
    SKIPPED = "skipped"
    FAILED = "failed"
    NEEDS_REVIEW = "needs-review"


class IssueSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    BLOCKER = "blocker"


# =========================================================================== core runtime
class AuditCategory(StrEnum):           # SECURITY_MODEL §6, the x-audit category of each operation
    PHI_READ = "phi-read"
    PHI_WRITE = "phi-write"
    SIGN = "sign"
    EXPORT = "export"
    SECURITY = "security"
    AI = "ai"
    ADMIN = "admin"


class BreakGlassReason(StrEnum):        # D53: reasonCode; reasonText is required only for OTHER
    EMERGENCY_CARE = "emergency-care"
    CONTINUITY_OF_CARE = "continuity-of-care"
    PATIENT_REQUEST = "patient-request"
    OTHER = "other"


class IdempotencyState(StrEnum):        # T21, ADR-0007
    IN_PROGRESS = "in-progress"
    DONE = "done"


class OperationStatus(StrEnum):         # contract OperationStatus; the last three are final
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PreRegistrationStatus(StrEnum):   # D96: the front desk's queue
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class PreRegistrationRejectReason(StrEnum):
    DUPLICATE = "duplicate"
    INCOMPLETE = "incomplete"
    NOT_OUR_PRACTICE = "not-our-practice"
    SPAM = "spam"
    OTHER = "other"                     # needs a reason text


class IdDocumentType(StrEnum):          # D96: the kind of ID checked at accept
    DRIVERS_LICENSE = "drivers-license"
    STATE_ID = "state-id"
    PASSPORT = "passport"
    MILITARY_ID = "military-id"
    OTHER = "other"
