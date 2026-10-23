# Shri Health — Decisions Log (read this first)

This file records decisions made **after** FRS v1.2, Technical Architecture v1.1 and Implementation Plan v1.1 were written. Where those documents disagree with this file, **this file wins**.

## Which document wins

1. `DECISIONS.md` (this file)
2. The owner's implementation guide (`01_` to `04_`) and `00_Team_Workflow_and_Claude_Code_Setup.md`
3. `API_Catalogue.md`
4. `FRS_v1_2.md` (what the product must do)
5. `Technical_Architecture_v1_1.md` (how it is built), except where overridden below. Its ADR-19 (application-owned PostgreSQL as the clinical system of record, no HAPI) agrees with D1 since ADR-0011 (2026-10-23)
6. `Implementation_Plan_v1_1.md` (background only: phases, gates, risks). Its workstream table and dates are out of date.

## Decisions

| # | Decision | Overrides |
|---|---|---|
| D1 | **One PostgreSQL database holds all our data (ADR-0011, 2026-10-23).** Clinical data lives in FHIR-shaped tables (FHIR R4 / US Core structure; Sam's schema, PR #9); administrative data is normalized in the same database. PostgreSQL 18 (latest 18.x minor release), three schemas (`clinical`, `admin`, `audit`), one role per service, forced row-level security on every clinic table. Writes that belong together commit in one transaction. Outside systems read the read-only `/fhir` API; our screens use `/api/v1` only. There is no HAPI server. *Was (retired by ADR-0011): ~~Clinical data lives in HAPI FHIR (JPA server with its own PostgreSQL); administrative data in our PostgreSQL; two databases.~~* | Nothing: Technical Architecture v1.1 ADR-19 agrees. (The retired D1 overrode ADR-19.) |
| D2 | ~~Our API reaches HAPI **only through its FHIR API**, via the client in `backend/app/fhir/`. Nobody reads or writes HAPI's internal tables from application code.~~ **Superseded by ADR-0011:** there is no HAPI. Modules reach the database only through their own repositories, using Anand's helpers in `backend/app/db/`; `backend/app/fhir/` is now the read-only FHIR API for outside systems. | — |
| D3 | **Security lives in the middleware** (owner: Thulasi): login with reference tokens, permissions, row-level security, audit, encryption in transit and at rest, file-encryption keys, rate limits. Endpoints never handle tokens, passwords or encryption themselves; they use `require()` and `tenant_db`. | — |
| D4 | **Mirth Connect is not used.** A Python integration engine handles labs (HL7 v2 over MLLP), clearinghouse, e-prescribing, fax and SMS. | — |
| D5 | **Team ownership** is as in `00_Team_Workflow_and_Claude_Code_Setup.md` (CODEOWNERS). Summary below. | Plan v1.1 workstream table |
| D6 | **Build order:** API contracts first. Admin and front-desk APIs before clinical APIs. Vimal moves to AI after his APIs. | Plan v1.1 "doctor-first vertical slice" |
| D7 | **Patient registration** is stored in our database (source of truth for demographics and insurance)~~ and mirrored to a FHIR `Patient` in HAPI on every change, through the integration engine so a HAPI outage never blocks the front desk~~. **HAPI mirroring superseded by ADR-0011:** the FHIR-shaped `Patient` table *is* the record; nothing is mirrored. | — |
| D8 | **Notes and prescriptions:** drafts and versions in our database~~; on signing, written to HAPI (`DocumentReference` for notes, `MedicationRequest` for prescriptions) with a `Provenance` record~~. **HAPI writes superseded by ADR-0011:** signing locks the row in the same database (Composition for notes, MedicationRequest for prescriptions), writes its `Provenance` in the same transaction, and keeps every version in `_history`. The signed note row is the legal record. | Technical Architecture v1.1 storage notes for notes |
| D10 | **Dates in all documents are provisional** and will be set separately. Do not plan around them. | All documents |
| D11 | Product name and use of "OpenEMR" are under legal review. Do not write "replaces OpenEMR" in any user-facing text. | — |
| D12 | **Stack:** FastAPI (Python 3.13), React + TypeScript + Vite, PostgreSQL 18 (FHIR R4 / US Core-shaped clinical tables; read-only FHIR API; ADR-0011), Keycloak, Nginx, SeaweedFS, OpenBao, vLLM, faster-whisper. No patient data outside production; synthetic data (Synthea) only. *Was: ~~HAPI FHIR R4 with US Core~~ (retired by ADR-0011).* | — |
| D13 | No PHI in URLs. Opaque UUIDs are allowed; names, date of birth, phone, MRN, driver's license numbers, member IDs and SSN never are. PHI searches use `POST …/search` with a body (patient search is `POST /patients/search`). **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G2; API_STANDARDS, SECURITY_MODEL, ENDPOINT_INVENTORY, ADR-0005). | `API_Catalogue.md` `GET /patients?search=` |
| D14 | No DELETE in the API. An unsigned encounter diagnosis is removed with `POST /encounters/{id}/diagnoses/{did}/remove` (which sets entered-in-error, D24); signed records only get entered-in-error, through one action per resource type with its own permission. **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G1, VD-G6; ENDPOINT_INVENTORY, DATA_OWNERSHIP; lint rule `shri-no-delete`). | `API_Catalogue.md` `DELETE /encounters/{id}/diagnoses` and `/records/{type}/{rid}/entered-in-error` |
| D15 | Eligibility runs at booking, in a pre-visit batch and at check-in (FRS FR-RCM-01). **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G3; ARCHITECTURE_CONTEXT §4.2, DATA_OWNERSHIP eligibility states). | `01_Vimal_Implementation_Guide.md` Steps 3–4 (check-in and batch only) |
| D16 | Check-in creates the Encounter through the encounter service; `POST /encounters` is only for unscheduled encounters (telephone, documentation-only). Both use the same service. **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G4; ARCHITECTURE_CONTEXT §4.2, DATA_OWNERSHIP encounter states). | — |
| D17 | The contract is one OpenAPI file per module plus shared components, bundled into one file for tools. Module owners approve the sections they implement (`x-owner`); Vimal approves standards conformance for all. **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G8, VD-SIGN; CONTRACT_GOVERNANCE, TOOLCHAIN; Thulasi's CODEOWNERS PR #8 (T2)). | `01_Vimal_Implementation_Guide.md` Day 1 item 1 (single file) |
| D18 | U.S. spelling in every API identifier and description (e.g. `favorites`, `license`). **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-G9; API_STANDARDS, ENDPOINT_INVENTORY; lint rule `shri-us-spelling`). | `API_Catalogue.md` `/me/favourites` |
| D19 | P1 endpoints and `/fhir` are out of the first contract pass. (`/fhir` is now Anand's read-only FHIR API, D22; it is not part of the OpenAPI contract.) **Agreed** (2026-10-22): applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2 (VD-SCOPE; ENDPOINT_INVENTORY, SECURITY_MODEL, ARCHITECTURE_CONTEXT §6). | — |
| D20 | **Contract-first stays (ADR-0002).** Sam's generated admin endpoints are dropped; DB names map to contract camelCase in each module's repository. (ADR-0011 condition 1) **Accepted.** | Sam's proposal (PR #9) generated endpoints |
| D21 | **Thulasi's core is used** (`require()`, `tenant_db`, Problem Details, session cookie). `tenant_db` sets the database settings the schema's RLS policies read (`app.current_tenant_id`, `app.current_user_id`, `app.correlation_id`). The clinic comes from the server-side session, not token claims. (ADR-0011 condition 2) **Accepted.** | Sam's proposal's own login and token-claim reading |
| D22 | **The external `/fhir` API is read-only**, keeps OperationOutcome for its errors, offers `POST _search`, and query strings are stripped from logs (D13). Our screens never call `/fhir`. (ADR-0011 condition 3) **Accepted.** | — |
| D23 | **Three schemas in one database:** `clinical` (FHIR-shaped), `admin` (normalized), `audit` (append-only audit chain). One database role per service, each with the minimum grants: `shri_app` for the API (clinical and admin read/write, audit insert only); `shri_fhir_reader` for `/fhir` (clinical read only); `shri_integration` for the partner worker (integration tables plus result filing); `shri_reporting` (read-only, approved views only); `shri_migrator` (owns everything; migrations only). RLS stays forced on every clinic table. Anand implements this during schema adoption. (ADR-0011 condition 4) **Accepted.** | — |
| D24 | **Before the 30 October lock, only P0 tables are locked** (`P0_SCHEMA_SCOPE.md`). Owners Anand and Sam. Also decided for the lock: (1) the 0..1 simplifications are approved as listed in Sam's README; (2) **diagnosis removal:** removing a diagnosis before the note is signed sets the Condition's verification status to `entered-in-error` with a reason, and a `Provenance` record of who removed it and why. An entered-in-error diagnosis is excluded from the chart, the problem list, decision support, AI summaries, claims and patient-facing views; it is kept only for audit. The database refuses a charge or claim line that points at an entered-in-error diagnosis. There is no DELETE; (3) a load test of the visit, results and claims write paths; (4) **PostgreSQL 18, on the latest 18.x minor release** (migrations and tests re-verified on 18; UUID defaults `uuidv7()`). Move to PostgreSQL 19 only after it has had a couple of minor releases; (5) the eight "P0 items to confirm" are approved as P0. (ADR-0011 condition 5) **Accepted.** | Tech Arch ADR-03 "PostgreSQL 18" confirmed |
| D25 | **The outbox is for external partners only** (labs, e-prescribing, clearinghouse, fax, SMS). (ADR-0011 condition 6) **Accepted.** | — |
| D26 | **Before India:** designs for market code systems and DPDP erasure. Owner Anand. (ADR-0011 condition 7) **Accepted.** | — |
| D27 | **Full SSN is never stored.** Only a hash and the masked last four, as the schema already enforces (HIPAA minimum necessary). Decided 2026-10-23 (Open Decisions Q10). | — |

D9 (what "MVP by late December" means) was removed on 2026-10-23: it is question Q1 in "Still open". D13–D19 moved here from "Proposed (not yet agreed)" on 2026-10-23.

## Who owns what

| Person | Owns |
|---|---|
| **Vimal** | OpenAPI contracts and mock server; patients and insurance, scheduling and check-in, eligibility, encounters and notes, patient history APIs; then AI (gateway, LLM serving, voice-to-text, AI-01 note drafting, AI-02 chart summary, scoring; P1: RAG, AI-03, AI-04, document extraction); AI screens |
| **Thulasi** | Middleware and security; integration engine and webhooks; medications and prescriptions APIs; orders and results APIs |
| **Anand** | The PostgreSQL schema (FHIR-shaped clinical tables and normalized admin tables), migrations and data-access helpers; the read-only FHIR API for outside systems; file system and file service; practice setup, billing and payments, documents and fax, C-CDA, inbox, exports and onboarding APIs; admin, billing and document screens |
| **Minalini** | Design system and all other screens (most already exist; wire them to the APIs); browser side of login; communications and operations dashboard APIs; design review of everyone's screens |

## Still open

These are the 30 questions of **Open Decisions for the MVP, v1.0** (23 October 2026; `Shri_Health_Open_Decisions_v1_0.docx`, shared by Vimal, not in the repo), numbered as there. Where a question has a recommended answer, it becomes the decision unless the owner changes it; *Needs input* has no default. Owners answer in that document; Vimal records the answers here through one reviewed pull request.

**Q10 is decided** (never store a full SSN; hash and masked last four only) and is recorded as D27, not here.

| # | Question | Owner | Recommended answer | Needed before | Notes |
|---|---|---|---|---|---|
| Q1 | What does "MVP complete by 31 December" mean? | Sena | Every P0 feature works on staging, with partners in test mode. A real-patient pilot follows on 1 March | **Now** | Was D9 (removed 2026-10-23) |
| Q2 | Product name: can it include "OpenEMR"? | Sena | No. Keep "OpenEMR" out of the product name and all marketing. *Needs input:* the final name | Before the pilot | D11 meanwhile: never write "replaces OpenEMR" |
| Q3 | Company domain, used in error links and identifiers | Sena | *Needs input* | Before the first staging release | Placeholder `company-domain.invalid` (API_STANDARDS §0) |
| Q4 | Licence for our code | Sena | Proprietary, all rights reserved. Remove the AGPL mention and confirm no OpenEMR code was copied in (OpenEMR is GPL) | **Now** | The schema README says AGPL |
| Q5 | Will we seek ONC certification? | Sena | Yes, in P2. Design for it now: audit trail, FHIR API, US Core, required data fields | **Schema lock** | Decides Q6 |
| Q6 | Which US Core version? | Sena | The version the ONC certification program requires, checked against the current ONC rule and recorded before the schema lock | **Schema lock** | 9.0.0 current on hl7.org (checked 2026-10-22); Anand records it (A7) |
| Q7 | Buy the AMA CPT licence? | Sena | Yes, before the pilot; real billing needs CPT codes. Placeholder codes until then | Before the pilot. The code-table design is part of the schema lock regardless | Tech Arch ADR-18; Anand A25 |
| Q8 | Register for the free UMLS licence (for SNOMED CT)? | Sena | Yes | Before loading terminology |  |
| Q9 | Upgrade GitHub to the Team plan? | Sena | Yes: enforced reviews and a record of who approved each change | **Now** | Approvals are kept by agreement until then (ADR-0001) |
| Q11 | Clearinghouse | Sena, with Thulasi | Waystar, using the existing accounts | Before the eligibility and claims build |  |
| Q12 | E-prescribing vendor | Sena, with Thulasi | One whose contract covers the Surescripts network, controlled-substance prescribing (EPCS), and drug-interaction and allergy checks. *Needs input:* Weno, DrFirst, NewCrop or another | Before the e-prescribing build |  |
| Q13 | Drug interaction database | Sena, with Thulasi | Use the e-prescribing vendor's built-in checks if included. Otherwise license First Databank or Medi-Span | Before the medication safety checks build |  |
| Q14 | First lab | Sena, with Thulasi | The lab the pilot practice already uses, over a direct connection. *Needs input:* Quest, Labcorp or another | Before the lab interface build |  |
| Q15 | SMS and email provider | Sena, with Thulasi | One that signs a Business Associate Agreement (BAA). *Needs input:* which | Before the reminders build |  |
| Q16 | eFax vendor | Sena, with Thulasi | One that signs a BAA. *Needs input:* which | Before the fax build |  |
| Q17 | Card payment processor | Sena, with Thulasi | One with hosted payment fields, so card numbers never touch our servers. *Needs input:* which | Before the payments build |  |
| Q18 | Pilot practice, state and specialty | Clinical advisors | *Needs input.* It decides co-signature rules, state privacy law and EPCS timing | Before clinical templates and co-signature rules |  |
| Q19 | EPCS on day one? | Clinical advisors | Yes, if the pilot specialty prescribes controlled substances (neurology usually does) | Before the e-prescribing build |  |
| Q20 | Session timeout | Clinical advisors | Logout after 15 minutes idle, warning at 13 minutes, 12-hour maximum session | Before the real login build | Thulasi agreed (T9) |
| Q21 | Clinical rows of the role permissions matrix (marked ‡ in SECURITY_MODEL §4) | Clinical advisors | Approved as drafted | Before clinical validation | Includes the gap rows (SECURITY_MODEL §4.4) |
| Q22 | Rules for closing an encounter (proposal in `contracts/docs/notes/`) | Clinical advisors | *Needs input:* approve as written, or give changes | Before the encounter APIs | DATA_OWNERSHIP §5.2 |
| Q23 | Who are the clinical advisors, and how many hours a week? | Clinical advisors | *Needs input* | **Now** |  |
| Q24 | Run PostgreSQL ourselves or use AWS's managed service? | Thulasi, with Anand | Amazon RDS for PostgreSQL, Multi-AZ: managed backups, encryption and automatic failover, with less work for a small team. Use it if it supports PostgreSQL 18 and our extensions (Anand checks). Otherwise self-managed on EC2 with pgBackRest | **Schema lock** |  |
| Q25 | Availability and recovery targets | Thulasi, with Anand | 99.9% monthly uptime; at most 5 minutes of data lost; back online within 4 hours; backup copy in a second U.S. region | Before production setup |  |
| Q26 | How long to keep records | Thulasi, with Anand | Clinical records at least 10 years after the last visit, longer for minors where the pilot state requires it; audit logs and HIPAA documents 6 years | Before the pilot |  |
| Q27 | The eight "P0 items to confirm" | Sam and Anand | Add all eight | **Schema lock** | Approved as P0 (D24); the work is listed below |
| Q28 | Standard U.S. demographic fields (race, ethnicity, sex, gender identity, sexual orientation, preferred language, occupation, industry, tribal affiliation) | Sam and Anand | Collect them all, optional for the patient. Certification requires them | **Schema lock** |  |
| Q29 | Times and money | Sam and Anand | Store times in UTC; each facility has its own time zone, and appointments display in facility time. Money as exact decimals in USD, never floating point | **Schema lock** | API_STANDARDS §6.1, §6.3 (A21, A22) |
| Q30 | Medical record numbers | Sam and Anand | One counter per practice, never reused, format practice prefix plus number | **Schema lock** |  |

### Not yet in the Open Decisions document

| Question | Owner | Needed before | Notes |
|---|---|---|---|
| Care-team (relationship-based) access limits: MVP or P1 | Vimal, with clinical advisors | Before the encounter APIs | SECURITY_MODEL §5; to be added to the Open Decisions document |

### Scheduled work (decided; owners named)

All rows are needed before the 30 October schema lock unless the row says otherwise.

| Work | Owner | Source |
|---|---|---|
| Tag all 218 tables P0, P0 stretch, P1 or P2 in the data dictionary | Anand, Sam | P0_SCHEMA_SCOPE.md |
| Add what is missing for the eight approved "P0 items to confirm" | Sam, Anand | P0_SCHEMA_SCOPE.md, D24 |
| Load-test the visit, results and claims write paths with the composite foreign keys in place | Anand, Sam | D24 |
| Re-verify migrations and tests on PostgreSQL 18; UUID defaults `uuidv7()` | Anand | D24 |
| Three schemas and five roles (D23) | Anand | D23 |
| Lock the P0 tables (afterwards they change only through new migrations) | Anand, Sam | D24 |
| `enqueue()` signature change to `enqueue(db, partner, message_type, payload, idempotency_key, ordering_key=None)` (T29): a separate core PR, reviewed by all four. Not a schema-lock item; needed before the first partner integration | Thulasi | D25 |
| Market code systems and DPDP erasure designs. Not a schema-lock item; needed before India | Anand | D26 |

### Resolved (kept for history)

| Item | Resolution |
|---|---|
| ~~Baseline schema: 83-table version or the 89-table `shri_health_db`~~ | ADR-0011: Sam's 218-table schema (PR #9), P0 tables locked on 30 October |
| ~~Which tables move to HAPI (Anand's Day 1 output)~~ | ADR-0011: none; there is no HAPI |
| ~~Tenant isolation inside HAPI (T30): one partition per clinic; where shared resources live (A33)~~ | ADR-0011: no HAPI partitions. Clinic isolation is forced RLS, clinic-carrying links and same-patient links |
| ~~HAPI resource IDs: client-assigned UUIDs equal to ours, plus our identifier system URI (ADR-0009)~~ | ADR-0011: one database, one ID per record |
| ~~Mirror Practitioner, PractitionerRole, Organization, Location and Coverage into HAPI~~ | ADR-0011: they are FHIR-shaped tables in our database; nothing is mirrored |
| ~~Does our database keep an encounter row with the same UUID as the HAPI Encounter~~ | ADR-0011: the Encounter table is in our database |
| ~~Encounter diagnoses: drafted in ours until signing, then written to HAPI as Conditions~~ | ADR-0011 / D24: Conditions in our database; removal before signing sets `entered-in-error` with the reason "removed before signing" |
| ~~Legal record of a signed note: the signed version in ours, with the same content hash in the HAPI DocumentReference~~ | ADR-0011: the signed note row is the legal record; no second copy, no hash check |
| ~~Clinical writes when HAPI is down fail with `clinical-store-unavailable`; rooming impact accepted as a risk~~ | ADR-0011: no HAPI, so no such failure mode; the error code is removed from the contract |
| ~~Full SSN collected?~~ | D27: never stored; hash and masked last four only |
| ~~AI gateway access to patient data~~ | Agreed (Thulasi, T10): per-task delegated token minted by the API, at most 5 minutes, read-only, audited as `ai` |
| ~~`/hooks/*`, `/health`, `/ready` outside `/api/v1`~~ | Agreed (Thulasi, T24): `/health` and `/hooks/*` public through Nginx; `/ready` internal and not in the contract |
| ~~Idempotency-Key rule~~ | Agreed (Thulasi, T21): the expired IETF draft's behavior as our own rule, in middleware; `5xx` and `429` not stored |
