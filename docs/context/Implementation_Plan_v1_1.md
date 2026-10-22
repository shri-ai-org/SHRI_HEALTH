# Shri Health OpenEMR Edition — Detailed Implementation Plan v1.1

## Document control

| Document control | Value |
|---|---|
| **Version** | 1.1 (replaces the six-month schedule in v1.0) |
| **Date** | 21 October 2026 |
| **Status** | For management review |
| **Related documents** | MVP FRS v1.2; Technical Architecture v1.1; shri_health_db schema repository |
| **Change in v1.1** | P0 MVP now completes on 31 December 2026; the Orlando conference is on 2 April 2027; phases, gates, owners, risks and open questions re-dated to match |

### Key dates

| Milestone | Date |
|---|---|
| Phase 0 complete: architecture and schema locked | 30 October 2026 |
| G1: vertical slice running end to end | 20 November 2026 |
| Demo checkpoint and conference booth decision | 18 December 2026 |
| **P0 MVP complete** | **31 December 2026** |
| Pilot go-live target | 1 March 2027 |
| P1 feature freeze | 12 March 2027 |
| **Orlando conference** | **2 April 2027** |

## Purpose and sources

This plan completes the P0 MVP by 31 December 2026, readies a pilot for 1 March 2027, and shows P0 with the P1 AI features at the Orlando conference on 2 April 2027. It merges four inputs into one backlog, one schedule and one owner list, and replaces Mirth Connect with a Python integration service as instructed.

| Source | What this plan takes from it |
|---|---|
| MVP FRS v1.2 (21 Oct 2026, updated from v1.1 with this plan’s changes) | Functional baseline, P0/P1/P2 release model, acceptance criteria |
| Technical Architecture v1.1 (21 Oct 2026, updated from v1.0) | Stack, AI pipeline, ADR-01 to ADR-18, phase gates |
| Initial Implementation Specification v1.0 | FHIR client pattern, thin-route/service layering, starter acceptance tests. Mirth removed; HAPI FHIR as system of record reopened as ADR-19 |
| Kickoff meeting transcription (Oct 2026) | Priority changes and functions missing from the FRS |

Where sources conflict, the meeting wins over the FRS, and the FRS wins over the two architecture documents. Every conflict is listed in the next section, and FRS v1.2 and Technical Architecture v1.1 now carry the same changes, so the three documents agree.

The transcription is machine-generated. Names and vendor terms below are best readings and need confirming: Waystar (clearinghouse), Weno (e-prescribing used by OpenEMR), Quest and LabCorp (labs), Jitsi (video), C-CDA (record exchange).

Release tags used throughout:

- **P0**: required for the controlled pilot.
- **P0 stretch**: wanted for the pilot; ships in early P1 if it slips.
- **P1**: expansion; the meeting wants most of it for the Orlando conference launch.
- **P2**: scale.
- **Demo**: needed for the 18 December demo checkpoint.

## What the meeting changed

The meeting kept the U.S. ambulatory focus but moved four things: clinical decision support up, migration out, billing in as a must-have, and lab integration to near-real-time. The table lists every change and how the plan absorbs it.

| Topic | Baseline (FRS / Architecture) | Meeting direction | Change in this plan |
|---|---|---|---|
| Product naming | “Replace OpenEMR” | Avoid saying “replacing”; using the OpenEMR name carries trademark risk; “OpenEMR Pro” floated | IP counsel reviews name and marketing copy in Phase 0 (ADR-21); internal codename until cleared |
| AI dependency | Graceful AI failure | Core must work fully with AI down; AI is an augmentation layer | AI-off regression suite is release-blocking |
| Hosting | Cloud, AWS U.S. | Cloud only; no offline or hybrid mode for U.S. | Offline/hybrid deferred to the India edition |
| Walk-ins and queues | FR-SCH-02 includes walk-ins | U.S. clinics are appointment-only; token queues are India-only | Walk-in becomes a same-day add-on from the scheduling screen; no token queue |
| Priority order | Not stated | Doctor first, then front office | Vertical slice 1 is the clinician encounter |
| Clinical decision support | AI-03 in P1 | CDS is the differentiator that “carries weight”; build rule-based first, then add AI | Deterministic CDS in P0; AI-03 pulled into the conference build |
| Alert style | Not stated | Doctors may resent “have you considered” prompts | Severity tiers, override reasons and per-user suppression in P0 |
| OpenEMR migration | FR-MIG-01 in P0 | Don’t focus on migration; coexist with running OpenEMR later, as a separate project | Migration moves to its own track; P0 keeps a complete data mapping and C-CDA import |
| Pilot framing | Migrate an existing practice | “I opened a new clinic — what can I do?” | Pilot scenario is a greenfield clinic onboarding |
| Billing / RCM | Basic practice management | “Without RCM we cannot deploy”; automatic insurance validation is a must | Eligibility, claims and claim status in P0; ERA posting P0 stretch |
| Front office | Registration and insurance | Driver’s licence barcode scan; insurance auto-validation | Licence scan and real-time eligibility in P0; card OCR in P1 |
| Labs | Generic orders/results | Integrate Quest/LabCorp both ways; load compendium; track status; notify doctor within one minute; avoid per-second polling | Push-based result pipeline with a 60-second target (Integration plan) |
| E-prescribing | Surescripts-connected vendor | Integrate a vendor (OpenEMR uses Weno); patient picks pharmacy; no in-house pharmacy; vaccines not a focus | eRx vendor ADR-26; immunizations record-only in P1 |
| Patient portal, telehealth | P1 | Reuse ideas from the older portal; Jitsi video link | P1, React rebuild, self-hosted Jitsi |
| C-CDA | Not in FRS | Import/export of patient records is a must | C-CDA import and export in P0 |
| Templates | Clinical templates | Doctors keep their own favourite templates; visits run about 10 minutes | Template builder and per-provider favourites in P0 |
| Scope philosophy | Not stated | Build the common 70%; refine 30% with doctors; customise only for real customers | Change control rule (Workstreams section) |
| Delivery method | Phased by layer | Schema first; one vertical slice end to end, then replicate | Vertical-slice approach (Delivery approach section) |
| Middleware | Caddy or Nginx | Identify the middleware stack, e.g. Nginx | ADR-22 picks Nginx |
| Team | Not stated | Three more hires; senior U.S. architect reviews skeleton; clear deliverable per person | Workstream owners and hiring gaps listed |
| Conference | Not stated | Orlando launch with P0 and P1; booth costs $20,000–30,000; decide within about two months | Conference on 2 April 2027; booth decision at the 18 December demo; P0 complete 31 December |
| Vendor economics | Not stated | Some vendors pay for integrations, some charge | Partnerships track owned by the executive sponsor |

## Decisions to close in Weeks 1–2

The biggest open decision is who owns clinical data: this plan recommends an application-owned PostgreSQL schema with a FHIR R4 facade, not a HAPI FHIR server as the system of record. The two source architectures disagree here, and every later module depends on the answer.

**Why application-owned PostgreSQL (Architecture v1.0) over HAPI FHIR as authority (Initial Spec):**

- The shri_health_db repo already implements this: 89 tables with forced row-level security and provenance on every clinical row; the meeting asked for schema first.
- AI drafts, review decisions, billing, audit and clinical data must commit together. The Initial Spec itself warns that writes spanning HAPI and the application database cannot be atomic.
- Mapping to OpenEMR for later coexistence is relational-to-relational.
- One fewer JVM service to secure, back up and operate in a small team.
- Keep HAPI’s value without its runtime: run the HL7 FHIR Validator against US Core in CI. Revisit only if a partner needs FHIR search or subscriptions beyond what the facade offers.

| ID | Decision | Recommendation | Owner | Blocks |
|---|---|---|---|---|
| ADR-19 | Clinical system of record | App-owned PostgreSQL 18 + FHIR R4 facade in FastAPI | Tech lead + senior architect | Phase 1 |
| ADR-20 | Integration engine without Mirth | Python integration service: MLLP listener, HL7 v2 parsing (python-hl7 or hl7apy), partner APIs, message store, ACK, dead-letter, replay | Tech lead | Lab, eRx, billing builds |
| ADR-21 | Product name and trademark | IP counsel review of “OpenEMR Edition” / “OpenEMR Pro” and all “replacement” wording | Executive sponsor | Conference materials |
| ADR-22 | Edge proxy | Nginx (team familiarity) | DevOps | Phase 1 |
| ADR-23 | Async jobs and events | PostgreSQL-backed job queue + LISTEN/NOTIFY; add Redis only if load tests demand it | Tech lead | AI and integration workers |
| ADR-24 | Real-time push to clinicians | Server-Sent Events or WebSocket from FastAPI | Tech lead | Result alerts |
| ADR-25 | Drug knowledge base for CDS | Licensed database (First Databank, Medi-Span or Multum), or the eRx vendor’s bundled checks; NLM retired its free interaction API in early 2024 | Product + clinical advisor | Medication CDS |
| ADR-26 | E-prescribing vendor | Shortlist Weno, DrFirst, NewCrop; pick on API, EPCS path, price | Executive sponsor + tech lead | Medications slice |
| ADR-27 | Clearinghouse | Waystar (existing accounts; seminar next week) unless terms fail | Executive sponsor | Billing slice |
| ADR-28 | Lab connectivity | Direct HL7 v2 interface per lab vs a lab-network aggregator | Integration engineer | Orders slice |
| ADR-29 | Telehealth | Self-hosted Jitsi inside the AWS environment covered by the BAA | DevOps | Portal (P1) |
| ADR-16 | ONC certification | Reopen now: decide whether target customers need certified technology for CMS programs | Product owner | Customer targeting |

Existing ADR-02, 03, 08, 12, 13 and 18 from Architecture v1.0 also need sign-off before Phase 1 starts.

## Target architecture

The architecture follows Technical Architecture v1.0 with two changes: Mirth is replaced by an in-house Python integration service, and no HAPI FHIR server runs in production (ADR-19).

Figure 1 — One FastAPI core owns the record; AI and integrations sit behind it

Read it top down: every request passes Nginx and Keycloak into one FastAPI core, which alone writes clinical data; AI and partner traffic sit behind that core.

- Portals never touch the database or models; the AI services never query patient tables.
- The integration service is the only component that talks to outside partners.
- Rule-based clinical safety checks live in the core, not in an LLM prompt.

## Data model and schema plan

The schema already exists: the shri_health_db repo defines 89 tables in 12 domains, with 82 row-level-security policies, 518 foreign keys, 101 CHECK constraints and 290 indexes. Phase 0 therefore verifies and extends it rather than designing from scratch. The meeting quoted 83 tables; the repo’s README and ER diagram show 89, so this plan uses 89.

The model code (shri_health_db_schema.zip) has now been reviewed against this plan, and the gap table below reflects what the code actually contains. The migrations and live-database tests have not been run yet; that is step 1 below.

- Run the repo as its README describes: apply sql/00_extensions.sql, run alembic upgrade head, confirm alembic check reports no drift, and run the live-database tests.
- Stand up OpenEMR 8.x with demo data and script its data dictionary. The meeting counted roughly 352 OpenEMR tables and 4,000–5,000 data elements, many duplicated.
- Extend the README’s table-level OpenEMR map into a column-level matrix: OpenEMR column → Shri column → FHIR US Core element → release. The README itself says field-level mapping should follow the pilot customer’s exact OpenEMR version.
- Add the gap tables below as new Alembic revisions; regenerate RLS policies and ER docs; rerun alembic check.
- Confirm the README’s open assumptions: shared-table RLS, one superbill per encounter, compendium per lab and business unit with AOE answers as JSONB, appointment conflicts enforced in the application, and an unpartitioned audit table for the pilot.
- Plan the PostgreSQL 18 switch: the repo is verified on PostgreSQL 16, and the README suggests moving the UUID default to uuidv7() on 18.
- Seed reference data and load a Synthea synthetic patient set for dev and test.

**Conventions already in the schema:** UUID keys; shared tables with organization_id and forced row-level security, where the API role cannot bypass it and a session with no tenant set sees zero rows; VARCHAR enums with named CHECK constraints using FHIR codes; a provenance mixin on every clinical table (entry_source, source_system, source_record_id, author, verifier, ai_suggestion_id); insert-only versions for signed notes and prescriptions, with a trigger blocking signed → draft; an append-only audit_event with a per-tenant SHA-256 hash chain; DELETE revoked on clinical tables in favour of entered-in-error; files, audio and HL7/X12 payloads in SeaweedFS with only keys and hashes in PostgreSQL; secrets held as OpenBao references.

| Domain | Existing tables | Gaps confirmed in the code | Gap release |
|---|---|---|---|
| Organisation, facilities, users | organization, facility, location, app_user, role, permission, role_permission, user_role, practitioner, practitioner_role | Per-provider favourites and alert suppression: new user_clinical_preference table | P0 |
| Terminology | code_system, concept, local_code_list | Drug knowledge base content or vendor link (ADR-25); licensed CPT loaded per deployer (ADR-18) | P0 |
| Patient identity | patient, patient_identifier, related_person, care_team_member, duplicate_candidate, patient_merge | Family history: new family_member_history table. Social history is already an observation category and surgical history uses procedure | P0 |
| Scheduling and front office | appointment_type, note_template, provider_schedule, schedule_availability_rule, schedule_exception, appointment, work_queue_item | Recall lists (walk-in flag and waitlist status already exist) | P1 |
| Encounter and clinical record | encounter, clinical_note, clinical_note_version, note_addendum, condition, encounter_diagnosis, observation, procedure, allergy_intolerance | Immunizations | P1 |
| AI and knowledge | ai_feature_setting, prompt_template, ai_request, ai_suggestion, audio_recording, transcript, knowledge_source, knowledge_chunk | None found | None |
| Medications | medication_statement, medication_request, medication_request_version, medication_safety_alert, medication_dispense, pharmacy, patient_pharmacy | EPCS signing and PDMP records (controlled flag and DEA schedule already exist) | P1 |
| Orders and results | lab_provider, lab_account, compendium_test, compendium_aoe_question, service_request, service_request_item, service_request_diagnosis, specimen, diagnostic_report, result_acknowledgement, unmatched_result | Order status history: service_request keeps only the current status plus transmitted and acknowledged times; add service_request_status_event | P0 |
| Insurance and eligibility | payer, payer_enrollment, coverage, eligibility_check | None found | None |
| Charges, claims, payments | fee_schedule, fee_schedule_item, superbill, charge, claim, claim_line, claim_status_event, remittance, remittance_claim, remittance_adjustment, patient_payment | Patient ledger and statements (code marks the ledger as P1); prior authorisation | P1; prior auth P2 |
| Documents, consent, communications | document, consent, communication_preference, message_template, outbound_communication, referral | Outbound eFax: add fax to IntegrationKind and CommunicationChannel. Inbound faxes already land as documents; staff messages are covered by work_queue_item | P0 |
| Audit, integration, migration | audit_event, provenance_record, integration_endpoint, integration_message, migration_run, migration_issue, migration_record_map | Record-level sensitivity labels for 42 CFR Part 2 (chart-level restriction and break-the-glass already exist) | P1 |
| Patient portal and telehealth | None yet | Portal accounts and telehealth sessions | P1 |

Many items this plan first listed as gaps are already in the code: ABN and medical-necessity results on orders; supervising practitioner and co-signature; the unmatched-result queue; specimen barcodes; Quest/Labcorp compendium with AOE questions; aggregator as a lab connection type; eligibility triggers for booking, pre-visit batch and check-in; ERA remittance tables; patient payments with processor references; walk-in and waitlist flags; restricted charts with a break-the-glass audit action; a controlled-substance flag with DEA schedule. integration_message already provides the outbox/inbox, idempotency key, retries and dead-letter the Mirth-free integration service needs. Only four P0 gaps remain: favourites, family history, order status history and outbound fax.

Deliverables: the repo running with tests green, a column-level mapping matrix, gap migrations merged, regenerated ER docs and data dictionary. Owner: Sam; reviewer: senior architect.

## Functional scope by module

The backlog holds 81 capabilities: 58 in P0, 2 P0 stretch, 16 P1, 4 P2 and 1 out of scope; 21 are needed for the 18 December demo checkpoint, and all P0 items by 31 December. Source “Gap” marks functions neither the FRS nor the meeting named; the next section explains why each matters.

### Front office, scheduling, clinician, AI, medications

| Module | Capability | Release | Demo | Source |
|---|---|---|---|---|
| Patient | Registration: demographics, identifiers, contacts, preferred language, emergency contact | P0 | Yes | FRS |
| Patient | Search by name, date of birth, phone, MRN and configured identifiers | P0 | Yes | FRS |
| Patient | Duplicate detection, merge and unmerge with audit | P0 |  | FRS |
| Patient | Driver’s licence barcode scan (PDF417) prefills demographics | P0 |  | Meeting |
| Patient | Insurance capture: primary, secondary, subscriber, card images | P0 | Yes | FRS + Meeting |
| Patient | Insurance card OCR prefill | P1 |  | Meeting |
| Patient | Real-time eligibility (X12 270/271) at booking and check-in | P0 | Yes | Meeting |
| Patient | Copay estimate and collection at check-in | P0 |  | Gap |
| Patient | Consents and privacy-notice acknowledgement with e-signature | P0 |  | Gap |
| Patient | Preferred pharmacy from directory | P0 |  | Meeting |
| Patient | Longitudinal timeline with source and provenance labels | P0 | Yes | FRS |
| Scheduling | Provider calendars, locations, appointment types, availability templates | P0 | Yes | FRS |
| Scheduling | Book, reschedule, cancel with conflict rules and reasons | P0 | Yes | FRS |
| Scheduling | Same-day add-on from the scheduling screen (U.S. walk-in) | P0 |  | Meeting |
| Scheduling | Status board: arrived, roomed, with provider, checked out | P0 | Yes | FRS |
| Scheduling | Rooming: medical assistant records vitals, medication and allergy review | P0 |  | Gap |
| Scheduling | Reminders by SMS, email and voice with confirm/cancel replies | P0 |  | FRS |
| Scheduling | Waitlist and recall lists | P1 |  | Gap |
| Scheduling | Token queue management | Out of scope |  | Meeting (India edition) |
| Clinician | Encounter workspace with history, allergies, medications, vitals, results | P0 | Yes | FRS |
| Clinician | HPI, ROS, exam, assessment and plan; structured and free text | P0 | Yes | FRS |
| Clinician | Template builder, specialty templates, per-provider favourites, smart phrases | P0 | Yes | Meeting |
| Clinician | Draft, sign, addendum, versions; co-signature for supervised NPs and PAs | P0 | Yes | FRS + Gap |
| Clinician | Problem list kept separate from encounter diagnoses | P0 |  | Gap |
| Clinician | Medical, surgical, family and social history; smoking status | P0 |  | Gap |
| Clinician | ICD-10-CM search with favourites | P0 | Yes | FRS |
| Clinician | Vitals with trends, BMI, out-of-range flags | P0 |  | FRS |
| Clinician | Clinician inbox: results, refill requests, messages, tasks, documents to sign | P0 |  | Gap |
| Clinician | After-visit summary for the patient | P0 |  | Gap |
| Clinician | Immunization history (record only) | P1 |  | Meeting |
| AI | AI-01 dictation and ambient capture to structured note | P0 | Yes | FRS |
| AI | Upload of audio recorded outside the app | P0 |  | Meeting |
| AI | AI-02 patient chart summary with links to sources | P0 | Yes | FRS |
| AI | Kill switches, confidence bands, accept/edit/reject log | P0 | Yes | FRS |
| AI | AI-03 clinical decision support (probabilistic, cited) | P1 |  | FRS + Meeting |
| AI | AI-04 diagnosis, billing code and order suggestions | P1 |  | FRS |
| AI | Document extraction from faxes and outside records | P1 |  | Gap |
| AI | Guideline answers via RAG (ADR-14) | P1 |  | Architecture |
| Medications | Medication list, reconciliation, discontinue with reason | P0 |  | FRS |
| Medications | Prescription with sig builder and favourites | P0 | Yes | FRS |
| Medications | Rule-based checks: allergy, drug-drug, duplicate therapy, dose range | P0 | Yes | FRS + Meeting |
| Medications | Alert tiers, override reasons, per-user suppression | P0 |  | Meeting |
| Medications | eRx: new, cancel, change, renewal requests, medication history | P0 |  | Meeting |
| Medications | Formulary and real-time benefit check | P1 |  | Gap |
| Medications | Controlled-substance eRx (EPCS) with PDMP check | P1 |  | Gap (ADR-17) |

### Orders, billing, documents, portal, administration

| Module | Capability | Release | Demo | Source |
|---|---|---|---|---|
| Orders | Lab compendium load per lab: tests, panels, specimen rules, AOE questions | P0 |  | Meeting |
| Orders | Order entry from the encounter with order sets and favourites | P0 | Yes | FRS |
| Orders | Electronic order to lab (HL7 v2) with requisition and specimen labels | P0 |  | Meeting + Gap |
| Orders | ABN for Medicare and diagnosis linkage for medical necessity | P0 |  | Gap |
| Orders | Status tracking: sent, collected, in process, partial, final, corrected | P0 |  | Meeting |
| Orders | Result import, patient and order matching, unmatched-result queue | P0 |  | FRS |
| Orders | Abnormal and critical flags, acknowledgement, release to patient | P0 |  | FRS |
| Orders | Ordering clinician notified within 60 seconds of result receipt | P0 |  | Meeting |
| Orders | Imaging orders to outside centres; reports filed as documents | P0 |  | FRS |
| Orders | In-office and point-of-care test entry | P0 |  | Gap |
| Billing | Fee schedules, CPT/HCPCS, modifiers, place of service, diagnosis pointers | P0 |  | FRS |
| Billing | Charge capture from the signed encounter; superbill | P0 | Yes | FRS |
| Billing | Claim scrubbing (basic edits) and 837P submission | P0 |  | FRS |
| Billing | Acknowledgements (999, 277CA) and claim status (276/277) | P0 |  | Architecture |
| Billing | ERA (835) auto-posting, patient payments, statements | P0 stretch |  | Meeting |
| Billing | AR aging, charges and payments reports | P0 |  | FRS |
| Billing | Card payments through a processor, keeping card data off our servers | P1 |  | Gap |
| Billing | Denial work queues and prior authorisation | P2 |  | FRS |
| Documents | Upload, scan, categorise, link to patient and encounter | P0 |  | FRS |
| Documents | Inbound and outbound eFax with an indexing queue | P0 |  | Gap |
| Documents | C-CDA import (view) and export | P0 |  | Meeting |
| Documents | C-CDA reconciliation of medications, allergies, problems | P1 |  | Meeting |
| Documents | Referrals out and in with status tracking | P1 |  | FRS |
| Portal | Patient portal: appointments, intake forms, released results, messages | P1 |  | FRS |
| Portal | Telehealth video (Jitsi) linked to encounter and consent | P1 |  | Meeting |
| Portal | Online check-in and payments | P1 |  | Gap |
| Admin | Users, roles, facilities, providers, templates, AI toggles | P0 | Yes | FRS |
| Admin | Audit review and HIPAA access reports | P0 |  | FRS + Gap |
| Admin | Operational dashboards and permission-controlled exports | P0 |  | FRS |
| Admin | De-identified cohort exports | P0 stretch |  | FRS |
| Admin | Quality measures (MIPS / eCQM) | P2 |  | Gap |
| Interop | FHIR R4 US Core read and write for agreed resources | P0 |  | FRS |
| Interop | SMART on FHIR app launch and bulk export | P2 |  | Gap |
| Migration | OpenEMR mapping matrix (data model coverage) | P0 |  | Meeting |
| Migration | Migration tooling and reconciliation | P1 |  | FRS, moved by meeting |
| Migration | Coexistence sync with a live OpenEMR through its API | P2 |  | Meeting |

## Gaps nobody named yet

Five gaps could stop a U.S. practice from going live even if every FRS item ships: ONC certification status, a licensed drug database, eFax, a clinician inbox, and payer enrollment lead times. The rest make daily work tolerable.

| Gap | Why it matters | Recommendation |
|---|---|---|
| ONC Health IT certification | OpenEMR is a certified EHR; practices in Medicare incentive programs may need certified technology and will ask before switching | Decide target segment in Phase 0; design APIs, C-CDA and audit so certification stays reachable in P2 |
| Drug knowledge base | Rule-based CDS needs maintained interaction, allergy-class and dose data; no reliable free source remains | License one (ADR-25) or use the eRx vendor’s bundled checks |
| eFax | Referrals, outside records and prior authorisations still arrive by fax in most U.S. clinics | Fax vendor with a BAA; inbound faxes land in an indexing queue; AI extraction in P1 |
| Clinician inbox | Results, refill requests, phone messages and unsigned notes need one place, or items get lost | One task inbox with assignment, due dates and escalation |
| Payer enrollment | ERA and EFT enrollment through the clearinghouse can take weeks per payer | Start enrollment the day the pilot contract is signed |
| ABN and medical necessity | Medicare patients must sign an ABN before possibly non-covered tests, or the practice absorbs the cost | ABN prompt at order entry using diagnosis linkage |
| EPCS and PDMP | A neurology pilot will prescribe controlled substances; without EPCS doctors fall back to paper or a second system | Confirm pilot specialty; move ADR-17 earlier if needed |
| Problem list and histories | The FRS covers encounter diagnoses only; continuity of care needs a standing problem list and social, family and surgical history | Add to the clinical data model in P0 |
| Co-signature | NPs and PAs often need supervising physician sign-off, varying by state | Configurable co-sign rules per provider |
| After-visit summary | Patients expect a printed or portal summary at checkout | Template-driven summary from the signed note |
| Rooming workflow | Medical assistants capture vitals and reconcile meds before the doctor enters | Rooming screen feeding the encounter workspace |
| Sensitive records | Substance-use treatment records (42 CFR Part 2) and psychotherapy notes carry stricter rules | Sensitivity labels, restricted access and break-the-glass with audit |
| Terminology licences | CPT needs an AMA licence; SNOMED CT U.S. edition comes through the UMLS licence | Close ADR-18 in Phase 0 |
| Card payments | Collecting copays at check-in needs a processor | Hosted payment fields so card data never touches our servers |
| Practice onboarding | A new clinic needs providers, NPIs, fee schedules, payers and templates loaded before day one | Setup wizard and import templates |
| Support and training | A pilot practice needs a help channel, release notes and training material | Owned by the PM from Phase 3 |
| No PHI in chat tools | The team plans a WhatsApp status group | Rule: no patient data in WhatsApp, email or tickets; synthetic data only outside production |

These need a decision from a practising clinician, not the build team: specialty templates for the pilot, default alert severities, and which history fields are mandatory.

## Delivery approach: vertical slice first

The team builds one clinician workflow end to end before widening, as the meeting asked, so a design mistake is fixed in one slice rather than across every module. Each slice runs from table to screen and is reviewed before the pattern is copied. After slice 1, slices 2–5 run as parallel streams in Phase 2 so all of P0 lands by 31 December.

**Slice order:**

- Clinician encounter: patient (minimal) → appointment → check-in → encounter → templated note → ICD-10-CM diagnosis → sign and addendum → audit → FHIR read of Patient and Encounter.
- Front office: full registration, licence scan, insurance, eligibility, scheduling rules, reminders.
- Medications and rule-based CDS: med list, prescription, interaction checks, eRx sandbox.
- Orders and results: compendium, order, lab message round trip, result inbox, 60-second alert.
- Billing: charge capture, superbill, claim, claim status.

**Module layout** (adapted from the Initial Spec so route handlers stay thin):

app/

core/          config, db session, security, audit, tenancy, errors

modules/

<domain>/    api.py  schemas.py  service.py  repository.py  fhir_mapper.py  tests/

integration/   partners/<lab|erx|clearinghouse|fax|sms>/  hl7/  mllp_listener.py

ai/            gateway client, prompts, validators

workers/       job handlers

migrations/      Alembic

frontend/        React + TypeScript + Vite, shared design system

**Definition of done for every slice:**

- [ ] Alembic migration and seed data merged
- [ ] API with permission checks, audit events and a versioned OpenAPI contract
- [ ] FHIR mapping passes the FHIR Validator against US Core
- [ ] Screens built from the shared design system, keyboard and contrast checks passing
- [ ] Unit, integration and end-to-end tests green in CI, including the AI-off suite
- [ ] Running on staging with synthetic data and demoed at the weekly review
- [ ] Reviewed by the senior architect before the pattern is replicated

## Phase plan and timeline

P0, the MVP release, is complete on 31 December 2026, and the Orlando conference follows on 2 April 2027. That leaves about ten weeks for P0, so after a one-week Phase 0 and a three-week foundation, every P0 module is built in parallel streams. “Complete” on 31 December means every P0 capability works on staging against partner test environments; live partner certification and security sign-offs follow in Phase 3.

Figure 2 — P0 MVP complete by 31 December; P1 ready for the 2 April conference

The dashed line marks P0 complete. Phase 3 (pilot readiness) and Phase 4 (P1 conference features) then run side by side, with a feature freeze on 12 March before conference rehearsals.

**If P0 falls behind, these move to January first, in this order:** ERA auto-posting, outbound eFax, C-CDA export, copay card payments, co-signature rules. Nothing else moves without the executive sponsor’s approval.

| Phase | Key deliverables | Exit gate |
|---|---|---|
| Phase 0 · Architecture and schema lock | shri_health_db verified and P0 gap migrations merged; ADR-19 to ADR-24 signed; FRS v1.2 and Technical Architecture v1.1 approved; AWS BAA; vendor outreach; hires in seat | G0 |
| Phase 1 · Foundation and vertical slice | Keycloak, tenancy, audit, CI/CD, Terraform staging, backups; slice 1 clinician encounter end to end; GPU host; P0 use cases for every stream; OpenEMR column mapping | G1 |
| Phase 2 · P0 build | Six parallel streams covering all 58 P0 capabilities; AI-01 and AI-02; demo checkpoint and booth decision; integration test and bug fix in the final week | G2 demo, G3 P0 complete |
| Phase 3 · Hardening and pilot readiness | Live certification with the lab, eRx vendor and clearinghouse; pen test; HIPAA risk analysis; restore drill; load test; clinical validation; training; practice onboarding | G4 pilot ready |
| Phase 4 · P1 conference features | AI-03 and AI-04, patient portal, Jitsi telehealth, referrals, insurance card OCR, ERA posting if it slipped | Feature freeze |
| Phase 5 · Conference readiness | Demo environment with synthetic data, demo script, rehearsals, booth materials cleared by counsel | G5 conference ready |

### Next ten weeks to P0

**Week 1 (26–30 Oct) · Phase 0**

- [ ] Run shri_health_db end to end (migrations, alembic check, tests) and merge the four P0 gap migrations — Sam
- [ ] Review and approve FRS v1.2 and Technical Architecture v1.1 — Kalila, Sam and the senior architect
- [ ] Sign ADR-19 to ADR-24 — Tech lead
- [ ] Share the shri_health_db repo, older portal code and lab-module data sheet — Executive sponsor
- [ ] Open the AWS account under a BAA and request GPU quota — DevOps
- [ ] Request sandbox access from Waystar, the eRx shortlist and the first lab — Executive sponsor
- [ ] Confirm the three hires or contractors start by 2 November — Kalila

**Weeks 2–4 (2–20 Nov) · Phase 1**

- [ ] Repo skeleton, CI, Keycloak, tenancy and audit — Backend lead
- [ ] Slice 1 clinician encounter end to end on staging — Backend and frontend leads
- [ ] Use-case catalogue for every P0 stream, reviewed by a clinician — Kalila
- [ ] OpenEMR 8.x column mapping matrix — Sam
- [ ] GPU host running vLLM and faster-whisper; first speech benchmark — AI engineer
- [ ] Vendor ADR-25 to ADR-28 signed and sandboxes open — Executive sponsor and tech lead
- [ ] G1 review at the end of Week 4 — All

**Weeks 5–10 (23 Nov–31 Dec) · Phase 2, P0 build**

- [ ] Six parallel streams: front office and eligibility; clinical and templates; medications and CDS rules; orders and results; billing and claims; documents, eFax and C-CDA — Stream leads
- [ ] AI-01 and AI-02 scored on the gold set — AI engineer
- [ ] Demo checkpoint and booth decision on 18 December — Executive sponsor
- [ ] Integration test and bug fix, 24–31 December — QA lead
- [ ] G3 P0-complete review on 31 December — All

**After 31 December**

- [ ] Phase 3: live partner certification, pen test, HIPAA risk analysis, restore drill, load test, clinical validation and training; pilot go-live target 1 March — PM
- [ ] Phase 4: AI-03, AI-04, patient portal, Jitsi telehealth and referrals; feature freeze 12 March — Product and AI leads
- [ ] Phase 5: demo environment, script and rehearsals for the 2 April conference — Executive sponsor

## Integration plan

Vendor onboarding starts in Week 1 because partner sandboxes, contracts and certification take longer than the code. By 31 December every integration runs against the partner’s test environment, or against recorded messages where a sandbox is late; live certification happens in Phase 3. The integration service replaces Mirth and owns every partner connection; partner-specific logic never lives in core modules or screens.

| Integration | Standard and transport | Candidates (confirm) | Release | Lead-time risk |
|---|---|---|---|---|
| Lab orders and results | HL7 v2 ORM/OML out, ORU in; MLLP over VPN, HTTPS or SFTP per lab | Quest, LabCorp, or a lab-network aggregator (ADR-28) | P0 | High: per-lab interface build and validation |
| E-prescribing | Vendor API or embedded module; Surescripts network via vendor | Weno, DrFirst, NewCrop (ADR-26) | P0 | Medium: vendor certification of our integration |
| Eligibility, claims, status | X12 270/271, 837P, 999, 277CA, 276/277, 835 through clearinghouse API | Waystar (ADR-27) | P0 | Medium: payer enrollment for ERA/EFT |
| Reminders and notifications | SMS, email, voice through provider APIs with delivery receipts | Provider with a BAA (ADR-15) | P0 | Low |
| eFax | Vendor API, inbound webhook | Vendor with a BAA | P0 | Low |
| C-CDA | CCD import and export; evaluate Microsoft FHIR-Converter for C-CDA → FHIR | Build in-house | P0 | Low |
| Driver’s licence scan | AAMVA PDF417 barcode via 2D scanner or webcam library | Build in-house | P0 | Low |
| Telehealth | Jitsi Meet, self-hosted | Build in-house (ADR-29) | P1 | Low |
| FHIR API for partners | FHIR R4 + US Core facade | Build in-house | P0 | Low |

**Integration service design (no Mirth):**

- Separate container from the same codebase: inbound listeners (MLLP over TLS, HTTPS webhooks, SFTP pollers) and outbound senders.
- Every message is stored raw and encrypted before parsing, with partner, type, control ID, status, retry count and correlation ID.
- HL7 v2 parsing with python-hl7 (includes an asyncio MLLP server) or hl7apy for validation; X12 through the clearinghouse’s API where offered.
- Idempotency on message control ID; ACK or NACK on receipt; bounded retries; dead-letter queue with an operator screen to fix and replay.
- Per-interface dashboard and an alert when an interface goes silent during clinic hours.

**Lab result to clinician in 60 seconds:**

- Signed order → integration service builds the lab’s order message with AOE answers, ICD-10-CM codes and ABN status, and sends it on the lab’s transport.
- Lab acknowledgements and status messages (received, collected, in process) update the order where the lab sends them.
- Result message arrives → stored raw → parsed → matched on placer/filler order number and patient identifiers → unmatched results go to a review queue.
- The committed result fires a database notification; the ordering clinician’s inbox updates by Server-Sent Events, no page refresh.
- Critical results escalate (in-app, then SMS to the on-call provider per practice policy) until acknowledged.
- Corrected results version the earlier report and re-notify.

The 60-second target runs from message receipt, measured at the 95th percentile. A lab that only offers batch files is polled once a minute, never every second, and its target becomes 60 seconds from file availability. The earlier lab bidirectional module and its data sheet should be reviewed for reusable requirements before building.

## AI implementation plan

AI ships in three increments: a dictation-to-note and chart-summary prototype for the 18 December demo, AI-01 and AI-02 evaluated and complete with P0 on 31 December, and AI-03 and AI-04 for the 2 April conference. Every increment runs inside the private AWS environment and passes the AI-off suite.

**Infrastructure (Phase 1):** one GPU instance in the L40S class (AWS g6e family, subject to quota) running vLLM behind the AI gateway; speech and OCR workers on the same host until load tests say otherwise. Development uses synthetic patients and scripted mock visits only.

| Capability | Release | Build steps | Gate before release |
|---|---|---|---|
| AI-01 dictation and ambient note | P0 (prototype in demo) | Browser capture with consent prompt, or audio upload → Silero VAD → faster-whisper → transcript review → LLM fills the provider’s template sections as validated JSON → clinician edits → sign | Medical-term error rate, omissions and invented facts scored on a clinician-reviewed gold set; clinician sign-off |
| AI-02 chart summary | P0 (prototype in demo) | Fetch permitted chart data through the core API → summary with a link per statement → missing and conflicting items listed | Every statement traceable to a record; zero unsupported facts on the gold set |
| Rule-based CDS | P0 (demo) | Allergy, drug-drug, duplicate therapy and dose rules from the licensed database, in the application layer | Rule test cases from the clinical advisor all pass |
| AI-03 decision support | P1 (conference) | Care gaps and documentation checks as rules; probabilistic suggestions with rationale, confidence band and cited guideline via RAG; shown apart from rule alerts | Clinician panel rates usefulness; alert acceptance tracked |
| AI-04 code and order suggestions | P1 (conference) | ICD-10-CM and CPT suggestions from the signed note; order suggestions from plan text | Coder review against gold set; never auto-committed |
| Document extraction | P1 | Docling + OCR on faxes and outside records → suggested patient match, type and key fields → staff confirm | Field accuracy on sample faxes |

**Evaluation harness (Phase 1, owned by the AI engineer):** MLflow tracks prompts, model versions and runs. The gold set is mock visits scripted and recorded with clinician advisors, each with a reference note; size to be agreed with the clinical owner. Metrics: speech error on medical terms, omissions, invented facts, citation correctness, clinician edit distance, latency.

**Model choice:** benchmark MedGemma 1.5 4B and Qwen3.5-4B on full-length visits (ADR-04). If neither meets the gate, try a larger open model on the same GPU before changing hosting. No identifiable data goes to external AI services.

**Doctor-facing rules carried from the meeting:** suggestions must be easy to dismiss, never block a workflow, and learn from overrides; anything a doctor rejects twice in a pattern is reviewed for suppression.

## Security, compliance and operations

No real patient data enters any environment until the AWS BAA is signed, a HIPAA security risk analysis is done, and a restore drill has passed. Until then, everything runs on synthetic data.

**Built in Phase 1, before any clinical module:**

- Keycloak OIDC with MFA for all staff; short-lived tokens; automatic logoff after inactivity.
- Role plus context checks on every API call: organisation, facility, patient and encounter; PostgreSQL row-level security as a second wall; cross-tenant tests in CI.
- TLS everywhere; encrypted volumes, object storage and backups; secrets in OpenBao only.
- Append-only audit events for views, changes, signatures, exports, access denials, AI requests and AI review decisions.
- Upload quarantine with ClamAV before files reach object storage.
- Break-the-glass access with a reason and an after-the-fact review report.

**Compliance work, owned by the executive sponsor with counsel:**

- [ ] AWS BAA signed and HIPAA-eligible services list confirmed
- [ ] BAAs with clearinghouse, eRx vendor, SMS/email, eFax and any support tools that may see PHI
- [ ] HIPAA security risk analysis (Phase 3), policies for access, retention and incident response
- [ ] State health-privacy and medical-record retention rules for the pilot state
- [ ] Terminology licences (ADR-18), trademark review (ADR-21), ONC certification decision (ADR-16)
- [ ] Penetration test by an outside firm before pilot

**Operations:**

| Area | MVP choice |
|---|---|
| Environments | Dev (synthetic), staging (production controls, synthetic), production |
| Delivery | GitHub Actions: tests, dependency and container scanning, signed images, manual production approval |
| Infrastructure | Terraform for VPC, private subnets, compute, GPU, storage, IAM in us-east-1 |
| Runtime | Docker Compose for pilot; PostgreSQL standby and two app instances if the 99.9% target stands (ADR-13) |
| Observability | OpenTelemetry traces, Prometheus metrics, Grafana dashboards, alerts to on-call |
| Backup | pgBackRest with point-in-time recovery; encrypted copy in a second U.S. region; monthly restore drill |
| Incidents | On-call rota, runbooks and breach-notification procedure before pilot |

## Workstreams, owners and first deliverables

Eleven workstreams each get one named owner and one first deliverable with a date, compressed to hold P0 on 31 December. Names come from the transcription and need confirming; roles in brackets are proposals.

| Workstream | Owner | First deliverable | Due |
|---|---|---|---|
| Product and clinical requirements | Kalila (PM) with clinician advisors | Use-case catalogue for every P0 stream: user stories, acceptance criteria, screen list | 13 Nov 2026 |
| Data model | Sam (database architect) | shri_health_db running with tests green and P0 gap migrations merged; column mapping by 20 Nov | 30 Oct 2026 |
| Architecture review | Senior U.S. architect (advisor) | Written review of repo skeleton and ADR set | 6 Nov 2026 |
| Backend platform | Backend lead | Repo skeleton with auth, tenancy, audit and one module | 6 Nov 2026 |
| Frontend and design system | Frontend lead | Clickable clinician workspace prototype for doctor feedback | 6 Nov 2026 |
| AI | AI engineer | GPU environment, speech pipeline running on mock-visit audio | 20 Nov 2026 |
| Integrations | Integration engineer (new hire) | Sandbox access for clearinghouse, eRx vendor and one lab | 6 Nov 2026 |
| Billing / RCM | RCM analyst (new hire) | Billing workflow spec: superbill, claim data set, eligibility flow | 13 Nov 2026 |
| DevOps and security | DevOps engineer | AWS account under BAA, Terraform baseline, CI pipeline | 6 Nov 2026 |
| Quality | QA lead | Test strategy, Synthea data set, AI-off suite skeleton | 13 Nov 2026 |
| Partnerships and go-to-market | Executive sponsor | Vendor terms (Waystar, eRx, lab) and naming review; booth decision at the 18 Dec demo | 6 Nov 2026 |

**The three new hires, in priority order; all must be in seat by 2 November to hold 31 December:**

- U.S. healthcare integration engineer: HL7 v2, X12, FHIR, lab and clearinghouse onboarding. This is the longest-lead skill and the one the team lacks most.
- U.S. RCM and billing analyst: payer rules, clearinghouse workflows, claim edits. The meeting called RCM a deployment blocker.
- QA automation engineer with healthcare workflow experience; swap for an AI/ML engineer if no one in-house has speech and LLM evaluation experience.

Also needed, part-time: two or three practising U.S. clinicians on a paid advisory basis, at least one from the pilot specialty. The meeting was explicit that the team are not medical experts. A business head for market research follows later, as discussed.

**Governance:**

- Weekly follow-up meeting with the full team; Sam visits the office weekly.
- Friday demo of whatever is on staging; nothing counts as done until demoed.
- Daily status in the WhatsApp group, with no patient data ever.
- ADR log in the repo; a decision is closed when its owner signs it.
- Change control: features beyond this backlog are added only for a signed customer request, per the meeting’s 70/30 rule.

## Testing and milestone gates

Six gates control the plan; the team does not start the next phase until the current gate’s criteria are demonstrated on staging.

| Gate | When | Pass criteria |
|---|---|---|
| G0 Architecture lock | End of Phase 0 | ADR-19 to ADR-24 signed; schema verified and P0 gap migrations merged; FRS v1.2 and Technical Architecture v1.1 approved; dependency lockfile approved |
| G1 Vertical slice | End of Phase 1 | Slice 1 meets the definition of done; cross-tenant and permission tests pass; backup restored once; every stream has its use cases |
| G2 Demo checkpoint | Mid Phase 2 | Book → check in → dictate → AI note → edit → sign → chart summary → prescription with interaction alert → eligibility check → superbill, on synthetic data; booth decision made |
| G3 P0 complete | End of Phase 2 | All 58 P0 capabilities working on staging against partner test environments or recorded messages; AI-01 and AI-02 pass the gold set; AI-off suite green; no open critical defects |
| G4 Pilot ready | End of Phase 3 | Live partner certification; pen test with no open critical or high issues; risk analysis done; restore drill within target; clinical owner signs the AI workflow; FRS §8 criteria shown |
| G5 Conference ready | End of Phase 5 | P1 features frozen and demoable; demo environment isolated with synthetic data; script rehearsed; booth materials cleared by counsel |

**Test layers:**

- Unit and integration tests on every module, run on every pull request.
- Contract tests on the OpenAPI spec and the FHIR facade (FHIR Validator against US Core).
- Partner message tests: recorded HL7 and X12 samples replayed, including malformed and duplicate messages.
- End-to-end browser tests for each slice’s main path, plus the AI-off suite that reruns them with AI disabled.
- Security: dependency and container scans in CI, permission and tenant-leak tests, an external pen test before pilot.
- Performance: load test against the FRS target of 95% of common reads within 500 ms.
- AI evaluation on the gold set at every model or prompt change.
- Clinical validation: advisors run scripted visits and sign off each workflow before pilot.

## Risks and mitigations

The biggest risk is the ten weeks to P0: the date holds only with six parallel streams staffed from 2 November and partners working in test mode until January.

| Risk | Effect if it happens | Mitigation | Owner |
|---|---|---|---|
| Ten weeks is too short for all 58 P0 capabilities | P0 misses 31 December or ships with defects | Parallel streams from 23 November; scope-protection list moves named items to January first; weekly burn-down against the backlog | PM |
| Hires or contractors not in seat by 2 November | Streams cannot run in parallel | Confirm offers in Week 1; use short-term contractors for integration and QA | Executive sponsor |
| Lab, eRx or clearinghouse onboarding runs long | Live connections slip past the pilot date | Build against sandboxes and recorded messages; live certification in Phase 3; manual fallback (print requisition, fax) | Executive sponsor |
| Holiday week (24–31 December) cuts U.S. advisor and vendor availability | Late clinical sign-off or sandbox issues unresolved | Book clinical reviews before 18 December; reserve the last week for internal test and bug fix | PM |
| Trademark challenge over “OpenEMR” | Rebrand after conference spend | Counsel review before any booth material (ADR-21) | Executive sponsor |
| Target customers need ONC-certified software | Practices cannot switch | Decide segment in Phase 0; keep certification reachable (ADR-16) | Product owner |
| 4B models produce weak notes on long visits | AI-01 fails its gate | Benchmark in Phase 1; test a larger open model on the same GPU | AI engineer |
| GPU quota or cost in us-east-1 | AI environment delayed or over budget | Request quota in Week 1; size from load tests (ADR-06) | DevOps |
| Alert fatigue | Doctors ignore or reject CDS | Tiered severity, override reasons, suppression, advisor review of defaults | Clinical advisor |
| No in-house U.S. domain expertise | Wrong workflows built | Paid clinician and billing advisors; integration and RCM hires first | Executive sponsor |
| Real patient data leaks into dev or chat tools | HIPAA breach | Synthetic data only outside production; no PHI in WhatsApp, email or tickets | DevOps + PM |
| Schema churn after streams start | Rework across streams | Vertical slice first; schema review at G1 before parallel streams begin | Sam |

## Open questions for next week

Fourteen answers are needed at next week’s follow-up to close Phase 0 on time.

- [ ] The conference is on 2 April 2027 in Orlando: confirm its name, the booth booking deadline, and whether P1 is shown live or as a demo.
- [ ] Who is the pilot practice, in which state, and which specialty (neurology was mentioned)?
- [ ] Does the pilot practice need ONC-certified software for Medicare programs?
- [ ] Is Waystar confirmed as clearinghouse, and are the existing accounts usable for a new product?
- [ ] Which eRx vendor, and is EPCS required on day one?
- [ ] Which lab first: Quest, LabCorp or a regional lab used by the pilot practice?
- [ ] Product name: does counsel clear “OpenEMR Edition” or “OpenEMR Pro”?
- [ ] Does the team accept ADR-19 (application-owned schema, no HAPI server)?
- [ ] Can the shri_health_db repo and the older portal and lab-module code be shared with Sam and the senior architect this week?
- [ ] Does “MVP complete by 31 December” mean P0 working on staging with partners in test mode, as this plan assumes, or live with a practice?
- [ ] The shri_health_db README describes the repo as AGPL. Is that intended for the commercial product? AGPL obliges offering source to users who interact with it over a network, so confirm with counsel.
- [ ] Is a licensed drug database in budget, or do we rely on the eRx vendor’s checks?
- [ ] Which three roles are being hired, and when do they start?
- [ ] Who are the clinician advisors, and how many hours a week can they give?