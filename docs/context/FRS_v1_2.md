# Shri Health OpenEMR Edition — MVP Functional Requirements Specification (FRS) v1.2

## Document control

| Document control | Value |
|---|---|
| **Version** | 1.2 (supersedes v1.1 of 15 October 2026) |
| **Date** | 21 October 2026 |
| **Status** | Draft for product, clinical and engineering review |
| **Related documents** | Technical Architecture v1.1; Detailed Implementation Plan v1.1; shri_health_db schema repository (89 tables) |
| **How to read changes** | Text marked **[v1.2]** is new or changed in this version. Everything else is carried over from v1.1 unchanged. |

### Changes in version 1.2

Version 1.2 adds the decisions and requirements agreed in the October 2026 kickoff meeting, plus functions a U.S. ambulatory practice needs that v1.1 did not name. Names and vendor terms from the meeting come from a machine transcription and should be confirmed.

| Section | Change | Source |
|---|---|---|
| §1 Vision and principles | Positioning note on the OpenEMR name; doctor-first priority; cloud-only hosting; common-workflow-first scope rule; greenfield pilot | Meeting |
| §2 Scope | P0 adds real-time eligibility, rule-based CDS, lab and e-prescribing integration, eFax and C-CDA; full OpenEMR migration becomes a separate project; AI-03 targeted for the conference launch | Meeting |
| §3.1 Patient | Licence scan, insurance capture, pharmacy, consents, restricted charts; new FR-PAT-03 patient history | Meeting, gap analysis |
| §3.2 Scheduling | Walk-ins become same-day add-ons; eligibility at booking and check-in; rooming; visit status; copay collection | Meeting |
| §3.3 Encounter | Co-signature; new FR-ENC-04 templates and favourites, FR-ENC-05 clinician inbox, FR-ENC-06 after-visit summary | Meeting, gap analysis |
| §3.4 AI | Audio upload; decision-support layering (rules first, AI second); alert-fatigue controls | Meeting |
| §3.5 Medications | E-prescribing transactions, pharmacy choice, drug knowledge base, controlled substances, immunization scope | Meeting, gap analysis |
| §3.6 Orders | Lab compendium, electronic orders, ABN, status tracking, 60-second result notification, unmatched results | Meeting |
| §3.7 Revenue cycle | New FR-RCM-01 to 03: eligibility, claims and acknowledgements, payments and remittance | Meeting |
| §3.8 Portal | Reuse earlier portal designs; Jitsi telehealth; online check-in and payment | Meeting |
| §3.9 Documents | eFax; C-CDA import and export | Meeting, gap analysis |
| §3.10 Administration | Practice onboarding; quality measures in P2 | Gap analysis |
| §4 FHIR | C-CDA added; FHIR as a facade over the application database | Tech Arch v1.1 ADR-19 |
| §5 Migration | P0 limited to data mapping and C-CDA import; full migration and coexistence a separate project | Meeting |
| §6 Non-functional | Result-notification latency; hosting; sensitive records; data handling outside production | Meeting, gap analysis |
| §8–9 | Acceptance criteria and out-of-scope list extended | Meeting |
| §10 | New: open decisions that affect requirements | — |
| §2 Key dates | P0 complete 31 December 2026; conference 2 April 2027; pilot target 1 March 2027 | Management direction |

## 1. Product vision

Shri Health OpenEMR Edition is an AI-first ambulatory Electronic Medical Record (EMR) and practice-management platform designed to replace existing OpenEMR installations while preserving the essential workflows of an outpatient medical practice.

**Positioning: [v1.2] **External materials should not describe the product as “replacing” OpenEMR, and use of the OpenEMR name is under legal review (Technical Architecture ADR-21). Internal documents keep the current name until counsel advises.

Unlike the Shri Health edition designed for Indian hospitals, this edition focuses on ambulatory practices, clinics, physician groups and outpatient specialty practices, initially targeting organisations that currently use OpenEMR.

The initial target market is the United States. Support for India and other markets will be added later through market-specific configuration of the Shri Health platform, such as hosting region, regulatory compliance, coding systems, interoperability profiles and language support, without changing the core product.

The product combines a modern clinical user experience, standards-based interoperability and embedded AI assistance without making AI a prerequisite for routine clinical operations.

**[v1.2] **The first pilot is a U.S. ambulatory practice opening on Shri Health without an existing OpenEMR to migrate. A neurology practice was discussed; the pilot practice, state and specialty are to be confirmed (§10).

#### Product principles

- **AI-first, clinician-controlled:** AI assists with documentation, summarisation, search and clinical decision support. Clinicians remain responsible for decisions and signed records.
- **FHIR-first interoperability:** APIs use FHIR resources and standards-based integration wherever appropriate.
- **Practical OpenEMR replacement:** Deliver the core workflows needed to migrate and operate an existing practice, not merely an AI dashboard layered over an EMR.
- **Human approval:** AI-generated clinical content must be reviewed before entering the legal medical record.
- **Graceful AI failure:** All essential workflows must function when AI is unavailable or disabled.
- **Modular architecture:** Shared platform services can be reused with the broader Shri Health product family, while this edition maintains its own ambulatory scope.
- **[v1.2] Doctor first:** clinician workflows take priority, followed by front-office workflows.
- **[v1.2] Cloud-hosted:** U.S. deployments are cloud-only. There is no offline or on-premise hybrid mode.
- **[v1.2] Common workflow first:** build the workflows most practices share, refine the remainder with practising clinicians, and add customer-specific features only for a signed customer request.
- **[v1.2] Rules before AI:** deterministic safety checks ship first; AI suggestions build on them and are always shown separately.

This MVP is intended to establish a credible, usable replacement product — not to reproduce every OpenEMR feature in the first release.

## 2. MVP scope and priorities

The requirements are divided into three releases so the team can build a usable product incrementally.

| Release | Focus | Includes |
|---|---|---|
| **P0 — MVP** | Essential clinical operations + core AI | Patient registration, scheduling, encounters, notes, diagnoses, medications, orders, results, basic practice management, security, audit, FHIR APIs and AI-assisted documentation. <br> **[v1.2] **Adds: driver’s licence scan and real-time insurance eligibility; templates and favourites; clinician inbox; rule-based medication safety checks; e-prescribing and electronic lab interfaces; claims, acknowledgements and claim status; eFax; C-CDA import and export; OpenEMR data mapping (full migration moves to a separate project). |
| **P1 — Expansion** | Advanced AI + patient engagement | AI-assisted coding, clinical decision support, patient portal, telehealth, referrals, enhanced reporting and additional migration tooling. <br> **[v1.2] **Adds: EPCS with PDMP checks, formulary checks, immunization history, patient statements and ledger, C-CDA reconciliation, OpenEMR migration tooling. |
| **P2 — Scale** | Advanced intelligence + ecosystem | Longitudinal population health, advanced analytics, specialty-specific AI, additional integrations and more sophisticated practice automation. <br> **[v1.2] **Adds: quality measures (MIPS/eCQM), SMART on FHIR, denial management, prior authorisation, live coexistence with OpenEMR. |

**Key dates: [v1.2] **P0 is to be complete by 31 December 2026, with a demo checkpoint on 18 December that decides the conference booth. The business goal is to show P0 and the P1 AI features (AI-03, AI-04) at the U.S. conference in Orlando on 2 April 2027. P1 is not a condition for the pilot, whose go-live target is 1 March 2027.

## 3. Functional requirements

### 3.1 Patient management and identity

#### FR-PAT-01 — Patient registration

- Create, view and update patient demographics, contacts, identifiers, emergency contacts and preferred language.
- Assign a unique patient identifier within the organisation.
- Search patients by name, date of birth, identifier, telephone number and other configured identifiers.
- Detect possible duplicates and allow authorised staff to reconcile records with an audit trail.
- Preserve original identifiers and source-system references during migration.
- **[v1.2] **Prefill demographics by scanning the barcode on a U.S. driver’s licence or state ID (AAMVA PDF417) and store the licence number as an identifier.
- **[v1.2] **Capture primary and secondary insurance, subscriber details and both sides of the insurance card; validate coverage in real time (§3.7).
- **[v1.2] **Record the patient’s preferred pharmacy from a pharmacy directory.
- **[v1.2] **Record treatment consent, the privacy-notice acknowledgement and recording consent with an electronic signature.
- **[v1.2] **Mark a chart as restricted (sensitive or VIP). Opening it requires a stated reason and is audited (break-the-glass).

#### FR-PAT-02 — Patient longitudinal record

- Display encounters, diagnoses, medications, allergies, observations, procedures, results, referrals and documents in a chronological timeline.
- Show the source, author, date and status of each entry.
- Distinguish verified information from imported, patient-reported and AI-generated content.
- Restrict access based on user permissions and patient relationships.

#### [v1.2] FR-PAT-03 — Patient history

- Maintain a standing problem list separate from encounter diagnoses.
- Record past medical, surgical, family and social history, including smoking status.
- Show history in the encounter workspace and the longitudinal record, with source and date.

**Acceptance criteria:** An authorised user can locate a patient, open the longitudinal record, identify the source of a clinical entry and access relevant history without creating duplicate records.

### 3.2 Scheduling and front-office operations

#### FR-SCH-01 — Appointment management

- Configure providers, locations, appointment types, durations, working hours and availability.
- Book, reschedule and cancel appointments.
- Prevent conflicting bookings according to configurable scheduling rules.
- Maintain appointment status, check-in status and cancellation reasons.
- Support reminders and appointment notifications through approved communication channels.
- **[v1.2] **Run an insurance eligibility check automatically at booking, in a pre-visit batch and at check-in (§3.7).
- **[v1.2] **Allow overbooking and double-booking only where the appointment type permits it.

#### FR-SCH-02 — Check-in, rooming and work queues

- Check in scheduled patients and register walk-ins.
- **[v1.2] **U.S. practices are appointment-based, so a walk-in is booked as a same-day add-on from the scheduling screen. No separate walk-in screen or token queue is required (token queues belong to the India hospital edition).
- Display waiting, in-progress, completed and cancelled appointments.
- **[v1.2] **Track visit status: arrived, checked in, roomed, with provider, checked out.
- **[v1.2] **Rooming: a medical assistant records vitals, reviews medications and allergies and confirms the reason for visit before the clinician enters.
- **[v1.2] **Collect and record copays at check-in.
- Present a role-specific task queue for front-office and clinical staff.
- Support configurable filters and clear status indicators.

**Acceptance criteria:** Front-desk staff can schedule a patient, check them in and make the patient available to the clinician without re-entering demographic information.

### 3.3 Clinical encounter and documentation

#### FR-ENC-01 — Encounter workspace

- Open an encounter associated with a patient and provider.
- Display relevant history, allergies, medications, vitals and prior results.
- Capture chief complaint, history of present illness, review of systems, examination, assessment and plan.
- Support structured fields and free-text documentation.
- Save drafts, resume interrupted work and sign completed notes.
- Preserve signed notes; corrections must be recorded as addenda or new versions.
- **[v1.2] **Support co-signature by a supervising physician where nurse practitioners or physician assistants require it, with rules configurable by state and provider.

#### FR-ENC-02 — Diagnoses and clinical coding

- Add, search and manage encounter diagnoses.
- Support applicable standard coding systems, including ICD-10-CM for the initial U.S. target market.
- Maintain the distinction between clinician-selected diagnoses and AI-suggested codes.
- Require clinician approval before AI-suggested codes are committed.

#### FR-ENC-03 — Vitals and observations

- Record and display vital signs and other configured observations.
- Display units, timestamps, reference ranges where applicable, and trends.
- Identify missing, out-of-range or potentially inconsistent values.
- Preserve provenance when observations are imported from another system.

#### [v1.2] FR-ENC-04 — Templates and favourites

- Provide specialty note templates (chief complaint, HPI, review of systems, examination, assessment and plan) that a practice can copy and adapt.
- Let each provider keep favourite templates, diagnoses, orders, prescriptions and reusable text phrases.
- Design goal: a routine follow-up visit can be documented within the visit time using templates, favourites and AI drafting. Clinician advisors set the measurable target.

#### [v1.2] FR-ENC-05 — Clinician inbox

- One inbox for results to review, refill requests, messages, tasks, incoming documents and unsigned notes.
- Items can be assigned, prioritised, given due dates and escalated.
- New results reach the ordering clinician’s inbox within 60 seconds of receipt (§3.6).

#### [v1.2] FR-ENC-06 — After-visit summary

- Generate a patient-facing visit summary from the signed note: diagnoses, medications, orders, instructions and follow-up.
- Print at checkout or release to the patient portal (P1).

### 3.4 AI-first clinical documentation

This is one of the principal differentiators of Shri Health OpenEMR Edition.

| ID | Capability | What it does |
|---|---|---|
| **AI-01** | Ambient documentation and dictation | Capture clinician-authorised audio, transcribe speech and prepare a structured clinical note. The clinician must be able to edit the draft, review the source transcript where available and accept or reject generated content. <br> **[v1.2] **Audio recorded outside the application may also be uploaded, under the same consent and retention rules. |
| **AI-02** | Patient chart summarisation | Summarise relevant prior encounters, diagnoses, medications, allergies, results and outstanding issues. Provide links to supporting records and clearly identify missing or conflicting information. |
| **AI-03** | Clinical decision support (P1) | Surface potential medication safety concerns, missing documentation, relevant historical findings and guideline-based suggestions. Distinguish deterministic safety rules from probabilistic AI recommendations. <br> **[v1.2] **Targeted for the conference launch; builds on the P0 rule layer below. |
| **AI-04** | Coding and order suggestions (P1) | Suggest diagnoses, billing codes and relevant orders based on the encounter. The clinician or authorised staff member must verify the suggestions before they are committed. |

#### [v1.2] Clinical decision support layering

The meeting identified decision support as the main clinical differentiator, to be built from rule-based features first and extended with AI.

| Layer | Release | Content |
|---|---|---|
| 1. Safety rules | P0 | Allergy, drug-drug interaction, duplicate therapy and dose-range checks from a licensed drug knowledge base, shown as rule-based alerts. |
| 2. Care gaps and documentation checks | P0 / P1 | Rule-based reminders for missing documentation and overdue follow-up, configured with clinical advisors. |
| 3. AI suggestions (AI-03) | P1 | Suggestions with rationale, confidence band and cited guideline, shown separately from rule-based alerts. |

- **[v1.2] **Alerts use severity tiers; high-severity alerts require an override reason; low-value alerts can be suppressed per user.
- **[v1.2] **Alerts and suggestions never block routine work, and override patterns are reviewed with clinical advisors to reduce alert fatigue.

#### Additional AI requirements

- AI outputs must be clearly labelled and carry a qualitative confidence band: High, Medium or Low.
- Each output must provide a rationale and links to supporting clinical information when applicable.
- AI must not invent missing patient facts; unknown information remains unknown.
- All accepted, edited or rejected suggestions must be traceable.
- Audio capture, transcription and retention must follow the configured consent and privacy policy.
- An organisation-level and feature-level kill switch must disable AI without disrupting normal clinical work.
- The platform must not autonomously sign notes, prescribe medications, place irreversible orders or alter verified clinical records.

**MVP AI acceptance criterion:** A clinician can conduct an encounter, generate a structured note draft, review and edit it, and sign the final note. The system retains the approved note and its author, timestamp and relevant AI provenance.

### 3.5 Medications and prescribing

#### FR-MED-01 — Medication management

- Maintain medication lists, including active and discontinued medications.
- Capture medication orders with drug, strength, dose, route, frequency, duration and applicable instructions.
- Display documented allergies and relevant medication history during prescribing.
- Check configured contraindications, interactions and dose limits.
- Route prescriptions to supported pharmacy or e-prescribing integrations where configured.
- Preserve signed prescription versions and record amendments.
- **[v1.2] **Prescribe electronically through a Surescripts-connected e-prescribing vendor: new prescriptions, cancellations, change requests and renewal (refill) requests, plus external medication history.
- **[v1.2] **Send prescriptions to the patient’s chosen retail or mail-order pharmacy. The product has no in-house pharmacy or dispensing.
- **[v1.2] **Source interaction, allergy-class and dose data from a licensed drug knowledge base or the e-prescribing vendor’s checks.
- **[v1.2] **Flag controlled substances. Electronic prescribing of controlled substances (EPCS) with prescription drug monitoring program (PDMP) checks is P1 (Technical Architecture ADR-17); move it earlier if the pilot specialty needs it.
- **[v1.2] **Formulary and real-time benefit checks are P1.

#### FR-MED-02 — AI medication assistance (P1)

- Identify potential medication discrepancies and missing prescription details.
- Present possible interactions or other safety concerns with supporting information.
- Require authorised clinician decisions for all prescribing actions.
- Never treat an AI-generated recommendation as a completed prescription.

**Immunizations: [v1.2] **In the U.S., most vaccines are given at retail pharmacies after insurer reminders. The MVP records immunization history only (P1) and does not manage vaccine inventory or administration.

### 3.6 Laboratory, imaging and other orders

#### FR-ORD-01 — Orders

- Create, review, cancel and track laboratory, imaging and other configured clinical orders.
- Maintain order priority, ordering clinician, status, timestamps and associated encounter.
- Prevent unintended duplicate orders and require reasons for cancellations where appropriate.
- Display pending orders and outstanding results in the clinical workspace.
- **[v1.2] **Load each lab’s compendium: tests, panels, specimen requirements, ask-at-order-entry (AOE) questions and medical-necessity rules.
- **[v1.2] **Let clinicians order from the encounter by searching the compendium or using order sets and favourites; the system creates the electronic order.
- **[v1.2] **Transmit lab orders electronically (HL7 v2 or the lab’s API) to Quest Diagnostics, Labcorp or other configured labs; print requisitions and specimen labels.
- **[v1.2] **Check medical necessity for Medicare patients and prompt for an Advance Beneficiary Notice (ABN) when a test may not be covered.
- **[v1.2] **Track order status: signed, transmitted, acknowledged, specimen collected, partial result, completed, cancelled.
- **[v1.2] **Send imaging orders to outside imaging centres; receive reports as documents or structured results.

#### FR-ORD-02 — Results

- Import or enter results, including values, units, reference ranges and interpretation where supplied.
- Link results to the correct patient and order.
- Support abnormal and critical-result flags and clinician acknowledgement.
- Preserve corrected results and report versions.
- **[v1.2] **Notify the ordering clinician within 60 seconds of the result message being received (95th percentile), without a page refresh. Critical results escalate until acknowledged.
- **[v1.2] **Labs that only supply batch files are polled at most once a minute; the 60-second target then runs from file availability. Per-second polling is not used.
- **[v1.2] **Place results that cannot be matched to a patient or order in a review queue; never file them automatically.
- **[v1.2] **Record in-office and point-of-care test results manually.

AI may summarise results or identify trends, but must not independently authorise or release a laboratory report.

### 3.7 Practice management and revenue-cycle integration

The MVP supports essential ambulatory practice-management functions without attempting to reproduce a complete hospital billing system.

- Provider schedules and encounter-linked billing data.
- Procedure and service codes (CPT/HCPCS for the U.S. market), charge capture and superbill generation.
- Insurance and payer information, eligibility integration where available, and claim export or submission through a selected clearinghouse.
- Encounter and claim status tracking, with appropriate error handling.
- Exportable operational and financial reports.

**Revenue cycle is a deployment prerequisite: [v1.2] **A U.S. practice cannot go live without eligibility checks, charge capture and claim submission, so these are pilot prerequisites rather than optional practice-management features.

#### [v1.2] FR-RCM-01 — Insurance and eligibility

- Maintain payers (commercial, Medicare, Medicare Advantage, Medicaid, TRICARE, workers’ compensation, self-pay) and each patient’s coverages in priority order.
- Run X12 270/271 eligibility checks through the clearinghouse at booking, in a pre-visit batch and at check-in; show coverage status, copay and deductible to the front desk.

#### [v1.2] FR-RCM-02 — Charges and claims

- Build the superbill from the signed encounter: CPT/HCPCS codes, modifiers, units, place of service and diagnosis pointers, priced from fee schedules.
- Scrub claims for basic errors, submit 837P professional claims through the clearinghouse, and track 999 and 277CA acknowledgements and 276/277 claim status.
- Support corrected and voided claims.

#### [v1.2] FR-RCM-03 — Payments and remittance

- Record copays and patient payments. Card payments go through a payment processor so card numbers never reach Shri Health.
- Post ERA (835) remittances automatically: P0 stretch, P1 if it slips.
- Patient statements and a full patient ledger are P1; denial work queues and prior authorisation are P2.
- Billing reports: charges, payments and accounts-receivable ageing.

**Scope boundary:** Advanced claims management, complex denial workflows and payer-specific automation can be phased into P1/P2. They should not delay the initial clinical MVP unless required by the first deployment customer.

### 3.8 Patient portal and telehealth (P1)

- Secure patient access to appointments, approved clinical information and released results.
- Patient intake forms, questionnaires and medication or allergy updates subject to review.
- Appointment requests and secure communication.
- Telehealth integration, patient consent and encounter linkage.
- AI-generated patient-facing content only after appropriate review and approval.
- **[v1.2] **Reuse proven designs from the earlier Shri patient portal, rebuilt as React components.
- **[v1.2] **Telehealth video through a self-hosted open-source service (Jitsi Meet), launched from the appointment.
- **[v1.2] **Online check-in, intake and card payment before the visit.

### 3.9 Documents, referrals and communications

- Upload and manage clinical documents and external reports.
- Associate documents with the correct patient and encounter.
- Maintain referral requests, destination, status and returned information (P1).
- Support configurable appointment reminders and patient notifications.
- Record message delivery status and communication history.
- Use approved templates and communication consent settings.
- **[v1.2] **Send and receive faxes through an eFax service covered by a Business Associate Agreement. Incoming faxes go to an indexing queue for patient matching and filing.
- **[v1.2] **Import C-CDA documents from other EHRs and display them; export a patient’s C-CDA on request. Reconciling imported medications, allergies and problems into the chart is P1.

### 3.10 Reporting and administration

- Manage users, roles, permissions, providers, locations, appointment types and clinical templates.
- Configure AI features and their availability by organisation.
- Provide operational dashboards for appointments, encounter completion, outstanding results and documentation status.
- Produce auditable, permission-controlled exports.
- Support de-identified cohort exports for authorised research and analytics use.
- Maintain audit records for access, changes, exports, signatures and AI-assisted actions.
- **[v1.2] **Onboard a new practice through a setup wizard or import templates: providers and NPIs, fee schedules, payers, lab accounts, templates and users.
- **[v1.2] **Quality-measure reporting (MIPS/eCQM) is P2.

## 4. FHIR API and interoperability requirements

Shri Health OpenEMR Edition uses FHIR as its principal interoperability contract, consistent with the earlier architecture decision.

| Capability | FHIR resource candidates |
|---|---|
| **Patient identity** | Patient, RelatedPerson |
| **Providers** | Practitioner, PractitionerRole |
| **Scheduling** | Appointment, Schedule, Slot |
| **Encounters** | Encounter |
| **Vitals and results** | Observation, DiagnosticReport |
| **Diagnoses** | Condition |
| **Allergies** | AllergyIntolerance |
| **Procedures** | Procedure |
| **Medication orders** | MedicationRequest |
| **Medication history / dispensing** | MedicationStatement, MedicationDispense where applicable |
| **Laboratory and imaging orders** | ServiceRequest |
| **Documents** | DocumentReference, Composition |
| **Consent** | Consent |
| **Audit events** | AuditEvent, Provenance |
| **[v1.2] Family history** | FamilyMemberHistory |
| **[v1.2] Clinical document exchange** | C-CDA (Continuity of Care Document) import and export, linked through DocumentReference |

The MVP exposes versioned APIs, validates inputs, enforces authorisation, records provenance and supports reliable integration retries. FHIR resource mappings and profiles must be agreed before implementation, using US Core profiles for the U.S. market; FHIR support alone does not guarantee interoperability with every EHR or payer.

**[v1.2] **FHIR APIs are a facade over the application’s PostgreSQL database. No separate FHIR server is the system of record (Technical Architecture ADR-19); output is validated against US Core in automated tests.

## 5. OpenEMR migration requirements

Migration is essential to a replacement product. The MVP must include a controlled process for moving data from existing OpenEMR installations.

**Change in v1.2: [v1.2] **The kickoff meeting moved full migration out of the MVP. Practices are not expected to switch off a working OpenEMR on day one, so the first pilot is a new practice, and migration plus coexistence with a live OpenEMR become a separate project. The P0 work below keeps that project estimable.

#### [v1.2] FR-MIG-00 — Migration readiness (P0)

- Map every OpenEMR 8.x data element to the Shri Health data model as keep, merge or drop, at column level, so later migration can be estimated.
- Keep source identifiers and provenance fields in the data model for every clinical table (already present in the schema).
- Import individual patient records from other systems using C-CDA (§3.9).

#### FR-MIG-01 — Migration workflow ([v1.2] separate project, P1)

- Extract data from an authorised OpenEMR installation or supported export.
- Profile and validate the source data.
- Map patients, providers, encounters, diagnoses, medications, allergies, orders, results and documents to the Shri Health data model.
- Preserve original identifiers, dates, authorship and source references wherever available.
- Identify duplicates, unmapped fields and inconsistent records for review.
- Import into a test environment and reconcile record counts and sample records.
- Obtain customer acceptance before production cutover.
- Retain migration logs and an agreed rollback or recovery plan.

#### [v1.2] FR-MIG-02 — Coexistence with a live OpenEMR (P2)

- Let a practice use Shri Health screens while its OpenEMR keeps running, synchronising data through OpenEMR’s APIs so either system shows the same record.
- Design starts only for a signed customer who needs a gradual switch.

The initial release supports a defined set of source versions and data types, rather than claiming universal, one-click migration.

## 6. Non-functional requirements

| Requirement | MVP target |
|---|---|
| **Security** | Encryption in transit and at rest, least privilege, MFA for privileged and clinical roles as configured |
| **Audit** | Traceable reads, changes, exports, signatures and AI review decisions |
| **Availability** | Proposed 99.9% monthly target, subject to hosting and operational design; the high-availability design is an open architecture decision (Technical Architecture ADR-13) |
| **Performance** | Proposed 95% of common record reads within 500 ms under agreed test loads |
| **[v1.2] Result notification** | New results reach the ordering clinician within 60 seconds of message receipt (95th percentile) |
| **Data recovery** | Defined backup, restore and recovery-point objectives tested before production |
| **AI resilience** | Core workflows remain usable with AI disabled or unavailable |
| **Accessibility** | Keyboard navigation, clear focus, accessible contrast and assistive-technology support |
| **Privacy** | Configurable consent, retention, access and data-processing policies |
| **[v1.2] Sensitive records** | Restricted charts, break-the-glass access with a stated reason, and audit review; finer-grained labels for substance-use treatment records (42 CFR Part 2) in P1 |
| **[v1.2] Data outside production** | Synthetic or de-identified data only in development and test; no patient data in chat, email or ticketing tools |
| **[v1.2] Hosting** | Cloud-only in an AWS U.S. region; no offline or on-premise mode |
| **Compliance** | HIPAA Privacy, Security and Breach Notification Rules for the U.S. market; Business Associate Agreements with vendors that handle PHI; ONC Health IT certification is not part of the MVP (Technical Architecture ADR-16) <br> **[v1.2] **ADR-16 is reopened: confirm whether target practices need certified software for Medicare programs. |
| **Testing** | Automated unit, integration, security, migration and end-to-end workflow tests |

These are proposed MVP targets to validate during implementation, not verified performance guarantees.

## 7. Implementation architecture

A modular monolith initially, with independently deployable AI and integration services where necessary.

The AI gateway enforces model access, input restrictions, output validation, version logging, review requirements and feature-level shutdown. Clinical safety rules remain in the application layer, not solely in an LLM prompt.

**[v1.2] **Mirth Connect is not used. A Python integration service handles HL7 v2 lab messages, clearinghouse and e-prescribing APIs, notifications and eFax (Technical Architecture ADR-20). The system layers are shown in Technical Architecture v1.1, Figure 1.

The detailed technology stack, layers, deployment design, AI pipeline and FHIR mappings are specified in the Shri Health OpenEMR Edition Technical Architecture **[v1.2] **v1.1, which follows the release scope defined in Section 2 and traces each requirement in this document to its architecture components.

## 8. MVP acceptance criteria

The MVP is ready for a controlled pilot when all of the following are demonstrated:

- A practice can register patients, schedule appointments and complete clinical encounters.
- Clinicians can document, diagnose, prescribe and manage orders and results.
- AI can generate reviewable clinical note drafts and patient summaries with traceability.
- No AI-generated clinical content enters a signed record without the required human approval.
- Core workflows continue when AI services are unavailable.
- Users can be restricted by role, organisation and patient access scope.
- **[v1.2] **Every OpenEMR 8.x data element is mapped to the Shri Health data model. (Migrating a full OpenEMR dataset is tested in the separate migration project.)
- FHIR APIs can exchange the agreed MVP resources with a test integration partner.
- Audit, backup, recovery and security tests pass the agreed release criteria.
- **[v1.2] **Front desk can scan a licence, capture insurance and receive an eligibility response at check-in.
- **[v1.2] **A lab order round-trips with a lab test environment, and the result reaches the clinician within 60 seconds of receipt.
- **[v1.2] **A prescription that triggers an interaction alert is sent through the e-prescribing vendor’s test environment.
- **[v1.2] **A claim built from a signed encounter is accepted by the clearinghouse test environment.
- **[v1.2] **A C-CDA from another EHR imports and displays correctly.

## 9. Out of scope for this edition

To keep the product distinct from the Indian hospital edition, the initial OpenEMR replacement excludes:

- Inpatient admission and bed management.
- Ward nursing, ICU and operating theatre workflows.
- Hospital pharmacy inventory and procurement.
- Hospital laboratory operations as a full laboratory information system.
- Stroke command centre and acute stroke transfer coordination.
- Hospital-wide revenue cycle and supply-chain management.
- **[v1.2] **Offline or on-premise hybrid deployment.
- **[v1.2] **Walk-in token queues (India hospital edition).
- **[v1.2] **In-house pharmacy, dispensing and vaccine inventory.
- **[v1.2] **Full OpenEMR migration and live coexistence (separate project, §5).

These functions may be supported through integrations or separate Shri Health products rather than built into the ambulatory MVP.

**Recommendation:** Make AI-assisted clinical documentation, longitudinal patient summarisation, FHIR interoperability and reliable OpenEMR migration the four defining MVP capabilities. The rest of the release should deliver a complete, dependable ambulatory workflow so a practice can operate on Shri Health rather than maintaining OpenEMR alongside it.

**[v1.2] Updated recommendation:** Add rule-based clinical decision support and dependable lab, e-prescribing and clearinghouse integration to the defining capabilities. The meeting identified decision support as the main differentiator and revenue cycle as a deployment prerequisite, and moved full migration to a separate project.

## [v1.2] 10. Open decisions affecting requirements

| Decision | Affects | Owner |
|---|---|---|
| Conference booth deadline and demo format (conference is 2 April 2027) | Whether P1 is shown live or as a demo (§2) | Executive sponsor |
| Meaning of “P0 complete by 31 December” | Whether partner connections must be live or may run in test mode at that date (§8) | Executive sponsor |
| Pilot practice, state and specialty | Templates, co-signature rules, EPCS timing, state privacy rules (§3.3, §3.5) | Executive sponsor |
| ONC certification need | Target customers and compliance scope (§6) | Product owner |
| EPCS on day one | FR-MED-01 release | Product + clinical owner |
| Licensed drug knowledge base or vendor checks | CDS layer 1 (§3.4) | Product + clinical owner |
| Product name and positioning | All external materials (§1) | Executive sponsor + counsel |
| Clearinghouse, e-prescribing vendor and first lab | FR-RCM, FR-MED-01, FR-ORD-01 | Executive sponsor + tech lead |
| Open-source licence of the codebase (README states AGPL) | Commercial distribution and SaaS obligations | Executive sponsor + counsel |
