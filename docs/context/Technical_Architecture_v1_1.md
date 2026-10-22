# Shri Health OpenEMR Edition — Technical Architecture v1.1

## Document control

| Document control | Value |
|---|---|
| **Version** | 1.1 (supersedes v1.0 of 15 October 2026) |
| **Date** | 21 October 2026 |
| **Status** | Proposed architecture baseline — product and engineering approval required |
| **Target** | U.S. ambulatory practices replacing or modernising OpenEMR (initial market); other markets through market profiles |
| **Design principle** | Modular monolith for core EMR; separate AI workers/services; standards-based integration; market-specific hosting, compliance, code sets and integrations kept as configuration and adapters <br> **[v1.1] **Application-owned PostgreSQL is the clinical system of record; a Python integration service replaces Mirth Connect. |
| **Related documents** | Shri Health OpenEMR Edition — MVP Functional Requirements Specification (FRS) **[v1.1] **v1.2; Detailed Implementation Plan v1.1; shri_health_db schema repository |
| **How to read changes** | Text marked **[v1.1]** is new or changed in this version. Everything else is carried over from v1.0 unchanged. |

### Changes in version 1.1

| Section | Change |
|---|---|
| §1 Executive decisions | Added system of record (ADR-19), integration service without Mirth (ADR-20), Nginx (ADR-22), jobs and real-time push (ADR-23, ADR-24), partner and drug-data decisions (ADR-25 to ADR-29) |
| §2 Architecture | Figure 1 redrawn; integration layer redefined; real-time push added |
| §3–4 Portals and modules | Front-desk, clinician and billing details from the meeting: licence scan, eligibility triggers, templates and favourites, inbox, eFax, C-CDA, no token queue |
| §5 AI | Decision-support layering; audio upload; evaluation gold set; AI-03 targeted for the conference |
| §6 Data | Reconciled with the shri_health_db schema (89 tables) and its confirmed gaps |
| §7 Integration | Integration service design; lab order-to-result path with a 60-second target; C-CDA, eFax, licence scanning |
| §8–9 Deployment and security | Integration service container; data handling outside production; sensitive records; open-source licence question |
| §10 Flows | Written flows replace the v1.0 images; lab and check-in flows added |
| §11 Sequence | Dated phases: P0 complete 31 Dec 2026, pilot target 1 Mar 2027, conference 2 Apr 2027 |
| §12–13 Traceability and ADRs | FRS v1.2 requirements traced; ADR-16 reopened; ADR-19 to ADR-29 added |
| Appendix A | Integration, validation and test-data tools added |

## 1. Executive decisions

**Version rule:** versions below are the proposed baseline available in the supplied architecture overview or selected for this proposal. Before implementation, engineering must verify official release status, licences, dependency compatibility and security advisories, then lock exact patch versions in a version-controlled bill of materials. Do not treat draft version numbers as production-verified.

| Decision area | MVP decision | Status / note |
|---|---|---|
| **Release scope** | P0 MVP, P1 expansion and P2 scale exactly as defined in FRS §2; P1 items are labelled (P1) throughout this document | Aligned with FRS **[v1.1] **v1.2 |
| **Market** | U.S. first; India and other markets added later as market profiles without changing core modules (Appendix C) | Aligned with FRS §1 |
| **Application shape** | Modular monolith for EMR; separate AI and integration services where isolation is needed | **Recommended** |
| **Frontend** | React + TypeScript + Vite | **Recommended** |
| **Backend API** | Python 3.13 + FastAPI + Pydantic 2 + SQLAlchemy 2 + Alembic | **Recommended**; pin compatible patch releases |
| **Primary database** | PostgreSQL 18; pgvector for embeddings; PostgreSQL full-text search for keyword retrieval | **Recommended**; **[v1.1] **schema verified on PostgreSQL 16 and uses nothing newer |
| **[v1.1] Clinical system of record** | Application-owned PostgreSQL schema (shri_health_db, 89 tables) with a FHIR R4 facade in FastAPI. No HAPI FHIR server in production; the HL7 FHIR Validator checks US Core conformance in CI | **Recommended** (ADR-19) |
| **[v1.1] Integration engine** | Python integration service in the same codebase, deployed as its own container. Mirth Connect is not used | **Recommended** (ADR-20) |
| **Identity** | Keycloak with OIDC/OAuth 2.0 and MFA | **Recommended**; configure role and organisation boundaries |
| **[v1.1] Edge proxy** | Nginx for TLS termination and routing | **Recommended** (ADR-22) |
| **[v1.1] Jobs and real-time push** | PostgreSQL-backed job queue; LISTEN/NOTIFY for events; Server-Sent Events to browsers. Add Redis only if load tests require it | **Recommended** (ADR-23, ADR-24) |
| **LLM serving** | vLLM OpenAI-compatible API; MedGemma 1.5 4B as primary benchmark candidate; Qwen3.5-4B as fallback | Model and GPU sizing must pass evaluation |
| **RAG** | Custom fixed pipeline; hybrid search in PostgreSQL; optional Qwen3-Reranker-0.6B only if evaluation improves results | No agent framework in MVP |
| **Speech** | faster-whisper + Silero VAD; benchmark on U.S. English clinical speech | Final model selected by benchmark; other languages per market profile |
| **Document ingestion** | Docling 2.138.0 + PaddleOCR-VL-1.6; CPU fallback for supported cases | Confirm package/model compatibility before pinning |
| **Object storage** | S3-compatible SeaweedFS for pilot; object versioning and encrypted backup | Pilot trial required; evaluate Ceph only at scale |
| **Secrets** | OpenBao | **Recommended** |
| **Backup** | pgBackRest for PostgreSQL; encrypted, separate-site object backups | Restore drills mandatory |
| **Deployment** | Docker + Docker Compose for MVP; GitHub Actions CI/CD; Terraform for reproducible cloud environments | Kubernetes deferred until scale requires it |
| **Hosting** | AWS U.S. region (us-east-1 proposed) under an AWS BAA, using HIPAA-eligible services; no identifiable patient data sent to external AI services during pilot <br> **[v1.1] **Cloud-only; no offline or on-premise hybrid mode for U.S. customers | Region, GPU quota and cost to be confirmed (ADR-08) |
| **Compliance** | HIPAA Privacy, Security and Breach Notification Rules; Business Associate Agreements with AWS and every vendor that handles PHI | Security risk analysis required before pilot |
| **Interoperability** | FHIR R4 API with US Core profiles and adapter layer; jurisdiction-specific profiles are separate configurations <br> **[v1.1] **C-CDA import and export for record exchange with other EHRs | ABDM deferred to the India market profile (Appendix C) |
| **[v1.1] Partners** | Clearinghouse: Waystar (candidate). E-prescribing: shortlist Weno, DrFirst, NewCrop. Labs: Quest and Labcorp, direct or through an aggregator. Drug knowledge base: licensed, or the e-prescribing vendor’s checks. Telehealth: self-hosted Jitsi Meet (P1) | Decisions ADR-25 to ADR-29 |

## 2. End-to-end architecture

Figure 1 — Target architecture: portals, edge, FastAPI core, AI services, integration service, data stores and partners (redrawn in v1.1)

### 2.1 Layer responsibilities

| Layer | Responsibility | Technology / boundary |
|---|---|---|
| **Portals** | Role-specific user experience | React + TypeScript; no direct database or model access |
| **Edge and identity** | TLS, routing, login, MFA, token validation | **[v1.1] **Nginx; Keycloak OIDC/OAuth2 |
| **Application/API** | Business rules, validation, authorisation, audit, clinical transactions | FastAPI; Pydantic; SQLAlchemy; Alembic <br> **[v1.1] **FHIR R4 facade; Server-Sent Events for clinician alerts |
| **Clinical modules** | Patient, schedule, encounter, notes, vitals, diagnoses, medication and allergies, orders/results, billing basics, documents/referrals, notifications, administration and migration <br> **[v1.1] **Plus clinician inbox, templates and favourites, eFax and C-CDA | Python domain modules in one deployable backend |
| **Data** | Structured clinical data, vector index, documents and attachments | PostgreSQL 18 + pgvector; SeaweedFS S3 |
| **AI services** | Transcription, document extraction, retrieval, LLM generation, chart summarisation | Separate private services behind an AI gateway with kill switch; vLLM; faster-whisper; Docling/OCR |
| **Integration** | FHIR resources, external systems, retries and mapping | FHIR R4 adapter modules; lab, e-prescribing, clearinghouse and notification adapters; idempotency keys and retry policies <br> **[v1.1] **Python integration service (no Mirth): MLLP listener and HL7 v2 parsing for labs; e-prescribing and clearinghouse APIs; SMS, email and eFax adapters; message store, ACK, dead-letter and replay |
| **Operations/security** | Secrets, backups, monitoring, release controls | OpenBao; pgBackRest; GitHub Actions; OpenTelemetry |

## 3. Portal and module ownership

| Portal / workspace | Primary modules | Access boundary |
|---|---|---|
| **Clinician** | Patient chart; encounters; notes; diagnoses; medications; orders/results; AI note drafting; chart summary <br> **[v1.1] **Inbox; templates and favourites; rule-based safety alerts; co-signature | Assigned/authorised patient and encounter scope; clinician approval for clinical actions |
| **Front Desk / Practice Management** | Registration; patient search; appointments; check-in; provider schedules; reminders; basic billing/claims status <br> **[v1.1] **Licence scan; insurance capture; real-time eligibility; copay collection; visit status board; rooming; eFax indexing | Administrative data by role; no default access to detailed clinical notes |
| **Practice Administration** | Users/roles; facilities; providers; locations; appointment types; templates; audit review; AI feature toggles and kill switch; reporting and operational dashboards; permission-controlled exports <br> **[v1.1] **Practice onboarding wizard (providers, NPIs, fee schedules, payers, lab accounts) | Privileged, MFA-protected; administrative access does not automatically grant clinical record access |
| **Patient Portal (P1)** | Appointments; intake forms; approved results/records; secure messages; telehealth <br> **[v1.1] **Online check-in and payment; Jitsi video; designs reused from the earlier Shri portal | Patient identity, consent and explicit record-release controls |
| **Embedded AI workspace** | Transcript review; note draft; patient summary (P0); cited RAG answers, decision support, coding and order suggestions (P1) | Only via application API; patient context is permission-checked; no direct model-to-database access |

## 4. Core application modules

| Module | MVP responsibilities | Key dependency |
|---|---|---|
| **Patient identity** | Registration, search, identifiers, duplicate review, demographics, longitudinal chart timeline with source and status of each entry <br> **[v1.1] **Driver’s licence scan; restricted charts with break-the-glass; problem list and medical, surgical, family and social history | Database; identity and audit |
| **Scheduling** | Provider calendars, booking, rescheduling, cancellation, check-in and queue <br> **[v1.1] **Eligibility at booking, pre-visit batch and check-in; same-day add-ons instead of walk-in queues; rooming and visit status | Patient identity; notifications |
| **Encounter & notes** | Encounter lifecycle, structured/free-text notes, draft/sign/addendum, vitals and observations <br> **[v1.1] **Specialty templates, per-provider favourites, co-signature, after-visit summary | Patient identity; clinician role |
| **Diagnosis & coding** | Diagnosis list, encounter diagnosis, configured coding systems; AI coding suggestions with review (P1) | Encounter; terminology/coding configuration |
| **Medication** | Medication and allergy lists, reconciliation, prescription draft, deterministic safety checks (contraindications, interactions, dose limits), e-prescribing adapter if approved; AI medication assistance (P1) <br> **[v1.1] **New, cancel, change and renewal transactions; external medication history; alert tiers, override reasons and suppression; EPCS and PDMP in P1 | Allergies; encounter; external integration; **[v1.1] **drug knowledge base (ADR-25) |
| **Orders & results** | Lab/imaging orders, status, duplicate-order checks, results, abnormal and critical flags, acknowledgement, corrected-result versions <br> **[v1.1] **Compendium with AOE questions; medical necessity and ABN; requisitions and labels; status tracking; 60-second result notification; unmatched-result queue | Encounter; result integration |
| **Practice management** | Charge capture, service codes, superbill, insurance/payer details, eligibility where available, clearinghouse claim export/submission and status; advanced claims P1/P2 <br> **[v1.1] **837P, 999, 277CA, 276/277; ERA 835 posting as P0 stretch; patient payments through a processor; statements P1 | Encounter; clearinghouse integration |
| **Documents & referrals** | Secure file upload, source and encounter association; referral tracking (P1) <br> **[v1.1] **Inbound and outbound eFax with an indexing queue; C-CDA import and export | Object storage; malware scanning |
| **[v1.1] Inbox & tasks** | One queue for results, refill requests, messages, tasks, documents and unsigned notes, with assignment, due dates and escalation (built on work_queue_item) | All clinical modules; real-time push |
| **Notifications & communications** | Appointment reminders and patient notifications through approved channels, templates, communication consent, delivery status and history | Scheduling; notification adapter (ADR-15) |
| **Audit & administration** | RBAC, tenant/org isolation, audit events, configuration, AI feature settings and kill switch, operational dashboards, permission-controlled and de-identified cohort exports | All modules |
| **Migration** | Source extraction, mapping, validation, reconciliation and cutover <br> **[v1.1] **P0 is limited to the OpenEMR 8.x column-level mapping; extraction, import, reconciliation and coexistence move to a separate project (FRS v1.2 §5) | OpenEMR export/database access; test environment |

## 5. AI architecture: speech, LLM and RAG

**AI release scope:** P0 covers ambient documentation and dictation (AI-01) and patient chart summarisation (AI-02). Clinical decision support (AI-03), coding and order suggestions (AI-04) and AI medication assistance (FR-MED-02) are P1, as defined in FRS §2 and §3.4. **[v1.1] **AI-03 and AI-04 are targeted for the conference launch.

Figure 2 — AI speech → clinical note → RAG-grounded assistance (unchanged from v1.0; insert the original image)

### 5.1 AI service components

| Component | Proposed stack | Decision / function |
|---|---|---|
| **AI gateway / orchestration** | Python 3.13; FastAPI 0.143.0; Pydantic 2.14.1; OpenAI Python SDK 3.29.0 | Fixed, versioned pipelines; no agent framework for MVP; enforces model access, input restrictions, output validation, version logging, review requirements and organisation/feature-level shutdown |
| **LLM serving** | vLLM 0.31.0; OpenAI-compatible internal API | Private network; model swaps behind one interface |
| **Primary LLM candidate** | MedGemma 1.5 4B (instruction-tuned) | Candidate only; medical-tuned developer model under the Health AI Developer Foundations terms; benchmark clinical note quality on full-length visits, latency, licence and GPU fit before selection |
| **Fallback candidate** | Qwen3.5-4B | Apache 2.0; benchmark only; do not deploy as fallback until it passes the same tests and licence review |
| **Embedding model** | Qwen3-Embedding-0.6B, 1,024 dimensions | Embeddings for approved knowledge sources |
| **Reranker** | Qwen3-Reranker-0.6B | Optional; retain only if measured retrieval gains justify cost |
| **Speech-to-text** | faster-whisper 1.2.1 + CTranslate2 4.8.2 | Primary benchmark candidate for U.S. English clinical speech |
| **Voice activity detection** | Silero VAD 6.2.3 | Detect speech segments and reduce silence processing |
| **Document parsing/OCR** | Docling 2.138.0 + PaddleOCR-VL-1.6; RapidOCR CPU fallback | PDF/DOCX/scanned-document extraction <br> **[v1.1] **Also inbound faxes and insurance-card prefill (P1) |
| **Evaluation and prompt versioning** | MLflow 3.17.0; Presidio 2.2.364 for test-data masking | Version prompts, evaluation runs and safe test data |

### 5.2 RAG knowledge pipeline

- **Sources:** only approved clinical guidelines, organisational protocols, formulary/reference documents and authorised content.
- **Ingestion:** upload → malware scan → text/OCR extraction → metadata and version tagging → chunking → embeddings → PostgreSQL indexing.
- **Retrieval:** role/organisation filter → PostgreSQL full-text search + pgvector similarity → optional reranking → evidence bundle with source IDs.
- **Generation:** LLM receives only relevant permitted context; output includes source references and explicit insufficient-evidence handling.
- **Governance:** content owner, approval status, version, effective date and withdrawal status must be retained. Superseded content must leave active retrieval after re-indexing.
- Patient-specific context must be fetched through the application API after permission checks. Never query the patient database directly from the model.

Figure 3 — RAG knowledge pipeline: ingestion, retrieval and generation (unchanged from v1.0; insert the original image)

**Release:** the ingestion and retrieval foundation is built in Phase 3; guideline-based answers are released to users with clinical decision support (AI-03, P1) unless the product owner moves them into P0 (ADR-14). **[v1.1] **With the re-sequenced phases in §11, the foundation is built in the AI track and completed during Phase 4.

### 5.3 AI safety rules

- AI outputs are drafts or suggestions; a clinician or authorised user must approve before saving to the legal clinical record.
- No autonomous note signing, prescribing, irreversible orders or direct clinical database writes.
- Show supporting source links for RAG answers; do not invent citations. If evidence is inadequate, say so.
- Preserve original transcript and show edits/differences according to retention policy.
- Do not send identifiable patient data to external AI services during the pilot; model inference remains in the controlled environment.
- AI outage must not block patient registration, encounter documentation, saving or signing non-AI notes.
- Evaluate speech word/medical-term error rates, note factuality, omissions, hallucinations, citation correctness, retrieval relevance and permission-leak resistance before pilot.
- Label every AI output as AI-generated with a qualitative confidence band (High, Medium or Low), a rationale and links to supporting clinical information; unknown patient facts remain unknown.
- Keep deterministic clinical safety rules (for example allergy, interaction and dose-limit checks) in the application layer, not solely in an LLM prompt, and present them separately from probabilistic AI suggestions.
- Provide organisation-level and feature-level kill switches through the AI gateway; switching AI off must not disrupt normal clinical work.
- Record whether each AI suggestion was accepted, edited or rejected, with the reviewer and timestamp.
- **[v1.1] **Uploaded audio (recorded outside the application) follows the same consent check, retention and transcript-review path as in-app capture.

### [v1.1] 5.4 Clinical decision support layering

| Layer | Where it runs | Release | Stored as |
|---|---|---|---|
| 1. Safety rules: allergy, interaction, duplicate therapy, dose range | Application layer, licensed drug knowledge base | P0 | medication_safety_alert, rule_source = deterministic |
| 2. Care gaps and documentation checks | Application layer, rules configured with clinical advisors | P0 / P1 | work_queue_item or alert records |
| 3. AI suggestions (AI-03) with rationale, confidence and cited guideline | AI gateway + RAG | P1 | ai_suggestion; medication_safety_alert with rule_source = ai |

Alerts use severity tiers (info, warning, critical). Critical alerts require an override reason; low-value alerts can be suppressed per user; overrides are reported to clinical advisors. Alerts never block routine work.

### [v1.1] 5.5 Evaluation gold set

Clinician advisors script and record mock visits, each with a reference note; the clinical owner sets the size. Every model or prompt change reruns the set in MLflow and reports medical-term speech error, omissions, unsupported facts, citation correctness, clinician edit distance and latency. Development uses synthetic patients only.

## 6. Data architecture

| Store | Contents | Rules |
|---|---|---|
| **PostgreSQL 18** | Patients, appointments, encounters, notes, vitals/observations, diagnoses, allergies, medication data, orders/results, referrals, billing/claims, communication history, users, consent, audit metadata, knowledge metadata and embeddings | Authoritative structured system of record; migrations versioned with Alembic |
| **pgvector** | Embeddings for approved knowledge chunks and permitted searchable content | Keep within PostgreSQL for MVP; apply tenant/source ACLs before retrieval |
| **PostgreSQL full-text search** | Keyword index for knowledge and metadata | Use alongside vector search; evaluate hybrid retrieval quality |
| **SeaweedFS (S3 API)** | Documents, uploaded reports, approved audio/transcript artefacts and attachments | Pilot trial required; private buckets, encryption, versioning and short-lived download links <br> **[v1.1] **Also raw HL7, X12 and fax payloads; only keys and SHA-256 hashes are kept in PostgreSQL |
| **OpenBao** | Secrets, credentials and key-management integration | No secrets in source control or plain environment files <br> **[v1.1] **TIN, DEA and partner credentials stored as OpenBao references (*_ref columns) |
| **pgBackRest** | PostgreSQL backups and point-in-time recovery | Encrypted backups; scheduled restore tests |
| **Audit events** | Actor, action, target, timestamp, outcome, source and correlation ID | Append-oriented/tamper-evident; do not log unnecessary clinical payloads <br> **[v1.1] **Implemented as an append-only table with a per-tenant SHA-256 hash chain |

**Tenant isolation:** enforce organisation/facility boundaries in the application and PostgreSQL row-level security where appropriate. Test cross-tenant access explicitly. SHRI platform administrators do not receive clinical-record access by default.

**Provenance:** every clinical entry stores its source, author, date and status so verified, imported, patient-reported and AI-generated content can be distinguished (FRS FR-PAT-02); migrated records keep their original identifiers and source references.

### [v1.1] 6.1 Schema baseline: shri_health_db

The data model is implemented in the shri_health_db repository: SQLAlchemy 2 models, Alembic revisions 0001 (baseline), 0002 (row-level security and integrity triggers) and 0003 (deferred AI provenance keys), and live-database tests for the safety rules.

| Measure | Value |
|---|---|
| Tables | 89 in 12 domains |
| Row-level-security policies | 82, forced; the API role cannot bypass them and a session with no tenant set sees zero rows |
| Foreign keys / CHECK constraints / indexes | 518 / 101 / 290 |
| Keys | UUID (uuid4 in Python); switch the default to uuidv7() on PostgreSQL 18 |
| Enumerations | VARCHAR with named CHECK constraints using FHIR codes |
| Provenance | Mixin on every clinical table: entry_source, source_system, source_record_id, author, verifier, ai_suggestion_id |
| Signed records | Insert-only note and prescription versions; trigger blocks signed → draft; DELETE revoked on clinical tables (entered-in-error instead) |

Already modelled, so no new work: ABN documents and medical-necessity results on orders; supervising practitioner and co-signature; unmatched-result queue; specimen barcodes; Quest/Labcorp compendium with AOE questions and business units; lab connection types including aggregator; eligibility triggers for booking, pre-visit batch and check-in; ERA remittance tables; patient payments with processor references; walk-in and waitlist appointment flags; restricted charts with break-the-glass audit; controlled-substance flag and DEA schedule; inbound faxes as documents.

### [v1.1] 6.2 Schema gaps to close

| Gap (confirmed in model code) | Proposed change | Release |
|---|---|---|
| Per-provider favourites and alert suppression | New user_clinical_preference table (favourite templates, diagnoses, orders, prescriptions, phrases; suppressed alert types) | P0 |
| Family history | New family_member_history table (FHIR FamilyMemberHistory). Social history is already an observation category; surgical history uses procedure | P0 |
| Order status history | New service_request_status_event table; service_request keeps only current status and a few timestamps | P0 |
| Outbound eFax | Add fax to IntegrationKind and CommunicationChannel; track sends in outbound_communication | P0 |
| Immunizations | New immunization table (FHIR Immunization), history only | P1 |
| Patient ledger and statements | Ledger and statement tables (code notes “full ledger is P1”) | P1 |
| Portal accounts and telehealth sessions | New tables when the portal is built | P1 |
| Record-level sensitivity labels | Labels beyond patient.is_restricted for 42 CFR Part 2 and psychotherapy notes | P1 |
| EPCS signing records | Two-factor signing evidence and PDMP check results for controlled prescriptions | P1 |
| Prior authorisation | New tables | P2 |

After each gap migration: regenerate RLS policies (python -m shri_health.db.rls), regenerate ER docs, and confirm alembic check reports no drift.

## 7. API and interoperability

| Area | Decision |
|---|---|
| **API framework** | FastAPI REST endpoints; OpenAPI contract generated and versioned |
| **Internal contracts** | Typed request/response models; Pydantic validation; idempotency for retryable writes |
| **FHIR** | FHIR R4 baseline with US Core profiles; map Patient, RelatedPerson, Practitioner, PractitionerRole, Appointment, Schedule, Slot, Encounter, Condition, AllergyIntolerance, Procedure, Observation, MedicationRequest, MedicationStatement, MedicationDispense, ServiceRequest, DiagnosticReport, DocumentReference, Composition, Consent, AuditEvent and Provenance as applicable (same resource set as FRS §4) <br> **[v1.1] **Plus FamilyMemberHistory. Served by a facade over PostgreSQL (ADR-19); validated with the HL7 FHIR Validator in CI |
| **Terminology** | ICD-10-CM diagnoses; CPT/HCPCS procedures and services; RxNorm medications; LOINC results; SNOMED CT problems where configured; licences confirmed under ADR-18 |
| **Integration adapter** | Separate connectors and mapping/validation layer; never embed partner-specific logic in portal components |
| **Lab integration** | HL7 v2 order and result interfaces or FHIR, depending on the lab partner <br> **[v1.1] **ORM/OML out and ORU in, over MLLP on VPN, HTTPS or SFTP; Quest and Labcorp first, direct or through an aggregator (ADR-28) |
| **E-prescribing** | Through a Surescripts-connected e-prescribing vendor; controlled-substance e-prescribing (EPCS) is a separate decision (ADR-17) <br> **[v1.1] **New, cancel, change and renewal transactions and medication history; shortlist in ADR-26 |
| **Billing and claims** | X12 837 claims and 270/271 eligibility through the selected clearinghouse where available; remittance and advanced claims workflows are P1/P2 <br> **[v1.1] **Also 999 and 277CA acknowledgements, 276/277 status, and 835 ERA posting as a P0 stretch; Waystar is the candidate (ADR-27) |
| **[v1.1] Clinical documents** | C-CDA (CCD) import and display; CCD export. Evaluate the open-source Microsoft FHIR-Converter for C-CDA to FHIR mapping |
| **[v1.1] eFax** | Vendor API with inbound webhook; inbound faxes become quarantined documents in an indexing queue |
| **[v1.1] Licence scanning** | AAMVA PDF417 barcode read by a 2D scanner or a browser camera library; parsed client-side, then sent to the API |
| **Notifications** | Notification adapter for appointment reminders and patient notifications through approved channels; delivery status recorded; provider selected under ADR-15 |
| **Telehealth (P1)** | Integration with the selected telehealth service, linked to patient, consent and encounter <br> **[v1.1] **Self-hosted Jitsi Meet (ADR-29) |
| **Reliability** | Timeouts, bounded retries, idempotency keys, correlation IDs, dead-letter/reconciliation workflow for asynchronous failures |
| **OpenEMR migration** | Use supported exports/database access; map and reconcile records in staging; retain source IDs; validate counts and samples before cutover <br> **[v1.1] **Separate project; P0 delivers the column-level mapping only |
| **Other markets** | ABDM (India) and other national profiles are added as separate configurations in a market profile (Appendix C); not part of the U.S. MVP |

### [v1.1] 7.1 Integration service (replaces Mirth)

- Runs from the same codebase as its own container: inbound listeners (MLLP over TLS, HTTPS webhooks, SFTP pollers) and outbound senders.
- Every message is stored raw and encrypted before parsing, using integration_message: direction, partner, type, control ID, status, retries, idempotency key, correlation ID, dead-letter.
- HL7 v2 parsing with python-hl7 (includes an asyncio MLLP server) or hl7apy for validation; X12 through the clearinghouse’s API where offered.
- ACK or NACK on receipt; bounded retries; dead-letter queue with an operator screen to fix and replay.
- Partner-specific mapping is versioned per partner and never placed in core modules or portals.
- Per-interface dashboards; an alert fires when an interface is silent during clinic hours.

### [v1.1] 7.2 Lab result notification target

The 60-second target runs from receipt of the result message to the ordering clinician’s screen, measured at the 95th percentile. Labs that only offer batch files are polled at most once a minute and the target runs from file availability. Per-second polling is not used. The full path is in §10.4.

## 8. Deployment and operations

Figure 4 — Deployment, data and trust boundaries (unchanged from v1.0; insert the original image)

| Area | MVP selection | Implementation rule |
|---|---|---|
| **Containers** | Docker + Docker Compose | One reproducible deployment package for local/staging pilot <br> **[v1.1] **Containers: API, integration service, workers, AI gateway, vLLM, speech/OCR workers, Keycloak, Nginx |
| **CI/CD** | GitHub Actions | Tests, dependency/security scanning, image build, signed/tagged artefacts and manual production approval |
| **Infrastructure as code** | Terraform | Use for cloud networking, compute, storage and IAM; defer only for local prototype |
| **Cloud** | AWS U.S. region (us-east-1 proposed) | Sign the AWS BAA; use HIPAA-eligible services only; confirm GPU quota and availability; keep databases private |
| **GPU** | NVIDIA L40S-class 48 GB as sizing hypothesis | Load-test model, concurrency, speech and document workloads; do not finalise capacity from model size alone |
| **Observability** | OpenTelemetry; Prometheus/Grafana candidate | Metrics, traces, structured logs, alerts and health endpoints; final dashboard selection is an open decision |
| **Network** | Private subnets for DB, object storage and inference; outbound allowlist | No public database, object-store or model endpoints <br> **[v1.1] **Lab VPN or TLS endpoints terminate at the integration service only |
| **Environments** | Development, staging, production | Synthetic/de-identified data only in development; staging mirrors production controls <br> **[v1.1] **Synthea generates synthetic U.S. patients |
| **Scale path** | Modular monolith first; split services only for clear isolation/scaling needs | Kubernetes and dedicated vector DB deferred |

## 9. Security, privacy and recovery

- **Identity:** Keycloak OIDC/OAuth2; MFA for staff and administrators; short-lived tokens; least privilege.
- **Authorisation:** role-based access plus organisation, facility, patient and encounter context; enforce on every API request.
- **Encryption:** TLS in transit; encrypted database volumes, object storage and backups; sensitive fields receive additional protection where required.
- **File safety:** quarantine uploads, scan with ClamAV, validate type/size, then release to private object storage.
- **Secrets:** OpenBao; rotate credentials; separate production and non-production secrets.
- **Audit:** record record views, exports, changes, signatures, access denials, AI requests/reviews and administrative changes; minimise sensitive payload logging.
- **Backup:** pgBackRest plus encrypted, isolated off-site copy in a separate U.S. region; object storage backup/versioning; monthly restore drills at minimum.
- **Recovery targets:** use as provisional targets only; final RPO/RTO must be approved after pilot load and restore testing.
- **Compliance:** the U.S. deployment requires review against the HIPAA Privacy, Security and Breach Notification Rules, a documented security risk analysis, Business Associate Agreements with AWS and every vendor that handles PHI, and review of applicable state health-privacy laws. Other markets receive their own legal/security review (Appendix C). Do not claim compliance solely from this architecture.
- **[v1.1] Sensitive records:** restricted charts require a stated reason to open (break-the-glass) and are reviewed in an audit report; record-level labels for 42 CFR Part 2 and psychotherapy notes follow in P1.
- **[v1.1] Data outside production:** no patient data in development, test, chat (including the team WhatsApp group), email or tickets.
- **[v1.1] Session control:** automatic logoff after inactivity on shared clinic workstations.
- **[v1.1] Business Associate Agreements:** AWS, clearinghouse, e-prescribing vendor, SMS/email provider, eFax vendor and any support tool that may see PHI.
- **[v1.1] Open-source licence:** the schema README describes the repository as AGPL. AGPL obliges offering source to users who interact with the software over a network, so confirm the intended licence with counsel before commercial launch.

| Recovery scenario | Proposed pilot target (approval required) |
|---|---|
| **Database failure** | RPO ≤ 5 minutes; restore/service recovery ≤ 4 hours |
| **Accidental deletion** | Point-in-time recovery; restore within 4 hours |
| **Site loss/ransomware** | Database RPO ≤ 15 minutes; file RPO ≤ 24 hours; restore within 24–48 hours |

## 10. End-to-end functional flows

**[v1.1] **The v1.0 flow diagrams were not available in this revision; the flows are written out below and two flows are added.

### 10.1 Patient encounter

Every clinical write passes through the application API and audit controls.

- Front desk checks the patient in; eligibility is confirmed and the visit moves to roomed after vitals.
- Clinician opens the encounter workspace with history, allergies, medications, vitals and results.
- Clinician records or uploads audio; the AI gateway transcribes it and drafts the note into the provider’s template (AI-01), or the clinician writes the note directly.
- Clinician reviews the transcript and draft, edits, and accepts or rejects AI content; each decision is logged.
- Clinician adds diagnoses, prescriptions and orders; rule-based safety checks run before signing.
- Clinician signs; the note version becomes immutable, the superbill is drafted and the after-visit summary is generated.

### 10.2 RAG question

- User asks a question in the AI workspace; the API checks role, organisation and patient permissions.
- Patient context, if needed, is fetched through the application API, never by the model.
- Retrieval filters approved knowledge by organisation, runs full-text and vector search, optionally reranks, and builds an evidence bundle.
- The LLM answers only from the evidence bundle, with source references, or states that evidence is insufficient.
- The answer is labelled as AI-generated with a confidence band and logged with its sources.

### 10.3 OpenEMR migration

**[v1.1] **Separate project. Steps follow FRS FR-MIG-01: extract, profile, map, import to staging, reconcile counts and samples, customer acceptance, cutover with a rollback plan. Every imported row gets entry_source = imported, source_system = openemr, its source record ID and a migration_record_map row, which also makes re-runs idempotent.

### [v1.1] 10.4 Lab order to result

- Clinician orders from the compendium; AOE answers, ICD-10-CM codes and ABN status are captured; the order is signed.
- The integration service builds the lab’s order message and sends it on the lab’s transport; requisition and specimen labels print.
- Lab acknowledgements and status messages update the order and its status history.
- The result message is stored raw, parsed and matched on placer/filler order number and patient identifiers; unmatched results go to the review queue.
- The committed result fires a database notification; the ordering clinician’s inbox updates through Server-Sent Events.
- Critical results escalate (in-app, then SMS to the on-call provider per practice policy) until acknowledged; corrected results version the earlier report and re-notify.

### [v1.1] 10.5 Check-in with eligibility

- Booking triggers an eligibility request; a pre-visit batch re-checks the next day’s appointments.
- At arrival, front desk scans the driver’s licence and both sides of the insurance card if details changed.
- Check-in runs a real-time 270/271 check and shows coverage status, copay and deductible.
- Front desk collects the copay through the payment processor and marks the patient checked in; the visit appears on the clinician’s board.

## 11. MVP implementation sequence

**[v1.1] **Phases are dated and match the Detailed Implementation Plan v1.1. P0 is complete on 31 December 2026; a demo checkpoint on 18 December decides the conference booth; the pilot go-live target is 1 March 2027; the Orlando conference is on 2 April 2027. After P0, hardening and P1 conference features run side by side.

| Phase | Dates | Deliverables | Exit gate |
|---|---|---|---|
| **0. Architecture lock** | 26 – 30 Oct 2026 | Confirm roles, MVP modules, U.S. hosting region and AWS BAA, data model, version compatibility, terminology licences and HIPAA/legal requirements <br> **[v1.1] **shri_health_db verified and P0 gap migrations merged; ADR-19 to ADR-24 signed; vendor outreach; hires in seat | Architecture decisions signed; exact dependency lockfile approved |
| **1. Core foundation** | 2 – 20 Nov 2026 | CI/CD, identity, tenant isolation, PostgreSQL, audit, object storage, backup/restore <br> **[v1.1] **Vertical slice: one clinician encounter end to end; GPU host and first speech benchmark; use cases for every P0 stream | Security and recovery tests pass on synthetic data |
| **2. Clinical MVP** **[v1.1] (P0 build)** | 23 Nov – 31 Dec 2026 | Patient, scheduling, encounters, notes, diagnoses, medications, orders/results, basic practice management, documents, notifications, reporting and administration <br> **[v1.1] **Six parallel streams covering all P0 capabilities, including AI-01 and AI-02, eligibility, e-prescribing, lab interface, claims, eFax and C-CDA against partner test environments; demo checkpoint 18 Dec; integration test and bug fix 24–31 Dec | End-to-end clinician/front-desk scenarios pass; **[v1.1] **P0 complete |
| **[v1.1] 3. Hardening and pilot readiness** | 4 Jan – 26 Feb 2027 | Penetration test, HIPAA security risk analysis, restore drill, load test, clinical workflow validation, staff training and incident process (Phase 5 in v1.0); live certification with the lab, e-prescribing vendor and clearinghouse | No unresolved critical/high security issues; clinical owner approves AI workflow; FRS §8 MVP acceptance criteria demonstrated; pilot go-live target 1 Mar 2027 |
| **4. AI and P1 features** | 4 Jan – 12 Mar 2027 | **[v1.1] **AI-03 and AI-04; guideline answers through RAG; patient portal; Jitsi telehealth; referrals; insurance card OCR | Benchmark gates pass; no patient data leaves controlled environment; **[v1.1] **feature freeze 12 Mar |
| **[v1.1] 5. Conference readiness** | 15 Mar – 1 Apr 2027 | Demo environment with synthetic data, demo script, rehearsals, booth materials cleared by counsel | Conference on 2 Apr 2027 |

**[v1.1] **Parallel tracks: integrations (26 Oct 2026 – 26 Feb 2027; partner test environments by December, live certification January–February); AI services (2 Nov 2026 – 12 Mar 2027); billing and claims (23 Nov – 31 Dec 2026). FHIR conformance tests run in CI from Phase 1.

## 12. FRS traceability

Each requirement area in the MVP FRS **[v1.1] **v1.2 maps to the architecture components below. Release labels follow FRS §2.

### 12.1 Functional requirements

| FRS requirement area | Architecture components | Release |
|---|---|---|
| **3.1 Patient management and identity (FR-PAT-01, FR-PAT-02, {v}FR-PAT-03)** | Patient identity module; PostgreSQL with provenance status; FHIR Patient, RelatedPerson; **[v1.1] **licence scan; FamilyMemberHistory | **P0** |
| **3.2 Scheduling and front office (FR-SCH-01, FR-SCH-02)** | Scheduling module; Notifications & communications; Front Desk portal; FHIR Appointment, Schedule, Slot; **[v1.1] **eligibility triggers | **P0** |
| **3.3 Encounter and documentation (FR-ENC-01 to {v}06)** | Encounter & notes; Diagnosis & coding; **[v1.1] **Inbox & tasks; templates and favourites; FHIR Encounter, Condition, Observation, Procedure | **P0; AI-suggested codes P1** |
| **3.4 AI clinical documentation (AI-01 to AI-04)** | AI gateway; speech pipeline; private LLM; validation and evidence checks; clinician review (Figure 2); **[v1.1] **CDS layering (§5.4) | **AI-01, AI-02 P0; AI-03, AI-04 P1** |
| **3.5 Medications and prescribing (FR-MED-01, FR-MED-02)** | Medication module with deterministic safety checks; Surescripts-connected e-prescribing adapter; FHIR MedicationRequest, MedicationStatement, MedicationDispense, AllergyIntolerance; **[v1.1] **drug knowledge base | **FR-MED-01 P0; FR-MED-02 P1; {v}EPCS P1** |
| **3.6 Orders and results (FR-ORD-01, FR-ORD-02)** | Orders & results module; lab adapter; FHIR ServiceRequest, DiagnosticReport, Observation; **[v1.1] **integration service (§7.1); real-time push | **P0** |
| **3.7 Practice management** **[v1.1] (FR-RCM-01 to 03)** | Practice management module; clearinghouse adapter (X12 837, 270/271); CPT/HCPCS service codes; **[v1.1] **999, 277CA, 276/277, 835 | **P0 basic; {v}ERA P0 stretch; advanced P1/P2** |
| **3.8 Patient portal and telehealth** | Patient Portal; telehealth integration; **[v1.1] **Jitsi Meet | **P1** |
| **3.9 Documents, referrals and communications** | Documents & referrals; Notifications & communications; SeaweedFS with ClamAV scanning; FHIR DocumentReference, Composition; **[v1.1] **eFax adapter; C-CDA | **P0; referrals P1** |
| **3.10 Reporting and administration** | Audit & administration module; Practice Administration portal; audit events; **[v1.1] **onboarding wizard | **P0; {v}quality measures P2** |
| **4 FHIR API and interoperability** | FHIR R4 adapter layer with US Core profiles (Section 7); **[v1.1] **facade over PostgreSQL (ADR-19) | **P0** |
| **5 OpenEMR migration (FR-MIG-01)** | Migration module; migration flow (Section 10.3) | **{v}FR-MIG-00 P0; FR-MIG-01 P1; FR-MIG-02 P2** |
| **8 MVP acceptance criteria** | Phase 5 exit gate (Section 11) | **P0** |
| **9 Out of scope** | Not designed in this architecture | **—** |

### 12.2 Non-functional requirements

| FRS requirement | FRS MVP target | Architecture approach |
|---|---|---|
| **Security** | Encryption in transit and at rest, least privilege, MFA for privileged and clinical roles as configured | TLS; encrypted volumes, object storage and backups; Keycloak OIDC/OAuth2 with MFA; role and context checks on every API request (Section 9) |
| **Audit** | Traceable reads, changes, exports, signatures and AI review decisions | Append-oriented audit events including AI requests and review outcomes (Sections 6 and 9) |
| **Availability** | Proposed 99.9% monthly, subject to hosting and operational design | Health endpoints and OpenTelemetry/Prometheus monitoring; a single-host Docker Compose pilot needs a PostgreSQL standby and redundant application instances to meet the target (ADR-13) |
| **Performance** | 95% of common record reads within 500 ms under agreed test loads | PgBouncer connection pooling; latency measured with OpenTelemetry traces; verified in the Phase 5 load test |
| **[v1.1] Result notification** | 60 seconds from receipt, 95th percentile | Push from the integration service through LISTEN/NOTIFY and Server-Sent Events; measured per interface (§7.2) |
| **Data recovery** | Backup, restore and recovery-point objectives tested before production | pgBackRest point-in-time recovery; encrypted off-site copies; restore drills; provisional RPO/RTO (Section 9) |
| **AI resilience** | Core workflows usable with AI disabled or unavailable | AI in separate private services behind the AI gateway; organisation and feature kill switches (Section 5.3) |
| **Accessibility** | Keyboard navigation, clear focus, accessible contrast and assistive-technology support | Built into the shared design-system components; accessibility checks in CI and Phase 2 workflow tests |
| **Privacy** | Configurable consent, retention, access and data-processing policies | Consent records in PostgreSQL; retention policy for audio and transcripts; tenant isolation; no identifiable data to external AI during pilot |
| **[v1.1] Sensitive records** | Restricted charts and break-the-glass | patient.is_restricted; break-glass audit action; audit report (Section 9) |
| **Compliance** | HIPAA for the U.S. market; BAAs with vendors that handle PHI; ONC certification not in MVP | AWS BAA and HIPAA-eligible services; BAAs with clearinghouse, e-prescribing, notification and telehealth vendors; security risk analysis in Phase 5; certification decision ADR-16 |
| **Testing** | Automated unit, integration, security, migration and end-to-end workflow tests | GitHub Actions pipeline with unit, integration, security scanning, migration reconciliation and end-to-end tests; **[v1.1] **AI-off suite; recorded HL7/X12 replay tests |

## 13. Architecture decisions requiring approval

| ID | Decision | Proposed default | Owner / gate |
|---|---|---|---|
| **ADR-01** | React SPA vs existing frontend | React + TypeScript + Vite | Engineering review |
| **ADR-02** | Backend pattern | FastAPI modular monolith | Engineering review |
| **ADR-03** | Primary database | PostgreSQL 18 + pgvector | DB/engineering review |
| **ADR-04** | LLM model | Benchmark MedGemma 1.5 4B (primary) and Qwen3.5-4B (fallback) against approved alternatives | AI evaluation + licence review |
| **ADR-05** | Speech models/languages | faster-whisper baseline for U.S. English; other languages added per market profile after benchmark | Speech benchmark |
| **ADR-06** | GPU and concurrency | 48 GB L40S-class starting hypothesis; the 4B candidates may allow a smaller GPU after load tests | Load test and budget approval |
| **ADR-07** | Object store | SeaweedFS pilot after two-week trial | Operations/security review |
| **ADR-08** | Hosting and residency | AWS U.S. region (us-east-1 proposed) under an AWS BAA; patient data stays in the U.S.; no identifiable data to external AI in pilot | Security/legal approval |
| **ADR-09** | Patient portal | P1 unless pilot requires it | Product owner |
| **ADR-10** | FHIR profile scope | FHIR R4 + US Core foundation; ABDM and other national profiles with later market profiles | Product/interoperability owner |
| **ADR-11** | Monitoring UI | OpenTelemetry + Prometheus/Grafana candidate | Operations owner |
| **ADR-12** | RPO/RTO and retention | Provisional values; approve after testing/legal review | Security/clinical/legal |
| **ADR-13** | Availability design | 99.9% monthly target (FRS §6) needs a PostgreSQL standby with tested failover and redundant application instances; otherwise approve a lower pilot target | Product/operations owner |
| **ADR-14** | Knowledge RAG release | Ingestion and retrieval foundation in Phase 3; guideline answers released with AI-03 decision support (P1) <br> **[v1.1] **Foundation now completes during Phase 4 (§11) | Product + clinical owner |
| **ADR-15** | Notification channels | Notification adapter; U.S. channels and provider chosen for the pilot, with a BAA where PHI is sent | Product/operations owner |
| **ADR-16** | ONC Health IT certification | Not in MVP; decide target criteria and timeline before onboarding practices that need certified EHR technology for CMS programs <br> **[v1.1] **Reopened: decide the target segment in Phase 0, since OpenEMR users may rely on certified software | Product owner + regulatory |
| **ADR-17** | Controlled-substance e-prescribing (EPCS) | Not in MVP; requires DEA-compliant identity proofing and two-factor signing through the e-prescribing vendor <br> **[v1.1] **Move earlier if the pilot specialty prescribes controlled substances | Product + clinical owner |
| **ADR-18** | Terminology licensing | ICD-10-CM, CPT/HCPCS, RxNorm, LOINC, SNOMED CT; CPT requires an AMA licence; confirm all licence terms | Product/legal |
| **[v1.1] ADR-19** | Clinical system of record | Application-owned PostgreSQL (shri_health_db) with FHIR R4 facade; no HAPI FHIR server in production; FHIR Validator in CI | Tech lead + senior architect |
| **[v1.1] ADR-20** | Integration engine | Python integration service; Mirth Connect not used | Tech lead |
| **[v1.1] ADR-21** | Product name and positioning | Counsel reviews use of “OpenEMR” and any “replacement” wording before external materials | Executive sponsor + counsel |
| **[v1.1] ADR-22** | Edge proxy | Nginx | DevOps |
| **[v1.1] ADR-23** | Async jobs and events | PostgreSQL-backed queue + LISTEN/NOTIFY; Redis only if load tests demand | Tech lead |
| **[v1.1] ADR-24** | Real-time push to clinicians | Server-Sent Events from FastAPI | Tech lead |
| **[v1.1] ADR-25** | Drug knowledge base | Licensed database (First Databank, Medi-Span or Multum) or the e-prescribing vendor’s checks | Product + clinical owner |
| **[v1.1] ADR-26** | E-prescribing vendor | Shortlist Weno, DrFirst, NewCrop; choose on API, EPCS path and cost | Executive sponsor + tech lead |
| **[v1.1] ADR-27** | Clearinghouse | Waystar, using existing accounts, unless terms fail | Executive sponsor |
| **[v1.1] ADR-28** | Lab connectivity | Direct HL7 v2 interface per lab vs a lab-network aggregator | Integration engineer |
| **[v1.1] ADR-29** | Telehealth | Self-hosted Jitsi Meet inside the BAA-covered AWS environment (P1) | DevOps |

## Appendix A — Proposed version baseline

These are proposed pins for planning, not a claim that every version is the latest or mutually compatible. Confirm official release status, model card terms, GPU/CUDA compatibility and dependency conflicts before lock-in.

| Technology | Proposed version / baseline |
|---|---|
| **Python** | 3.13 |
| **FastAPI** | 0.143.0 |
| **Pydantic** | 2.14.1 |
| **OpenAI Python SDK** | 3.29.0 |
| **PostgreSQL** | 18 (**[v1.1] **schema verified on 16) |
| **pgvector** | 0.8.7 |
| **pg_textsearch** | 1.5.0 |
| **vLLM** | 0.31.0; CUDA 13 build |
| **Primary LLM** | MedGemma 1.5 4B (google/medgemma-1.5-4b-it) candidate; confirm Health AI Developer Foundations terms |
| **Fallback LLM** | Qwen3.5-4B candidate; Apache 2.0; verify exact model ID |
| **Qwen embedding** | Qwen3-Embedding-0.6B, 1,024 dimensions |
| **Qwen reranker** | Qwen3-Reranker-0.6B, optional |
| **faster-whisper** | 1.2.1 |
| **CTranslate2** | 4.8.2 |
| **Silero VAD** | 6.2.3 |
| **Docling** | 2.138.0 |
| **PaddleOCR-VL** | 1.6 |
| **MLflow** | 3.17.0 |
| **Presidio** | 2.2.364 |
| **OpenEMR migration** | Source version(s) to be confirmed against first pilot customer |
| **[v1.1] HL7 v2 libraries** | python-hl7 and/or hl7apy; pin after evaluation |
| **[v1.1] FHIR validation** | HL7 FHIR Validator (CLI) with US Core package, in CI |
| **[v1.1] C-CDA conversion** | Microsoft FHIR-Converter (open source); evaluate before adopting |
| **[v1.1] Synthetic data** | Synthea |
| **[v1.1] Telehealth** | Jitsi Meet, self-hosted (P1) |
| **React / TypeScript / Vite** | Select compatible stable versions and pin via lockfile at project kickoff |
| **Keycloak / SeaweedFS / OpenBao / Docker** **[v1.1] / Nginx** | Pin maintained stable versions after deployment compatibility/security review |

## Appendix B — Definition of done for version lock

- Official release source and release date recorded for every pinned dependency.
- Licence and model terms reviewed, including commercial deployment and healthcare use.
- Python, CUDA, driver, vLLM and model compatibility tested together on target GPU.
- Container images pinned by immutable digest where practical; dependency lockfiles committed.
- Known vulnerabilities and upgrade policy documented.
- Model quality and resource consumption benchmarked with representative, approved test data.

## Appendix C — Market profiles: India

The United States is the initial market. A market profile changes hosting, compliance, code sets, FHIR profiles, language models and integration adapters only; core modules, the AI pipeline and the data model stay the same. The items below come from the earlier India-oriented proposal and are the starting point for an India market profile. Other markets follow the same pattern.

| Area | India market profile | Rule |
|---|---|---|
| **Hosting** | AWS Mumbai (ap-south-1) | Region, quotas and cost to be confirmed; no identifiable patient data sent to external AI services during pilot |
| **Compliance** | Legal/security review for applicable DPDP, CERT-In, medical-record retention and contractual requirements | Do not claim compliance solely from this architecture |
| **Interoperability** | ABDM | Not assumed for MVP; add only after explicit scope, sandbox and compliance approval |
| **Indian-language speech** | AI4Bharat IndicConformer | Benchmark for target languages; do not claim support until tested |
| **Translation (optional)** | IndicTrans2 | Only for explicitly approved translation workflows; translation must not silently alter source clinical meaning |
| **Backups** | Separate India region/site | Encrypted, isolated off-site copy with restore drills |
| **Coding and payers** | National code sets and insurer workflows in place of ICD-10-CM, CPT/HCPCS and X12 clearinghouse transactions | Confirm with the first India customer |
| **[v1.1] Front office** | Walk-in registration and token queue management; hybrid on-premise deployment for hospitals | Excluded from the U.S. edition by the October 2026 meeting; belongs to this profile or the India hospital edition |
