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
| D9 | **"MVP by late December"** is understood as the core clinic workflow working end to end on staging with synthetic data, with partners (lab, e-prescribing, clearinghouse) in test mode. Live partner certification, security sign-off and a real-patient pilot come after. *Awaiting management confirmation.* | Plan v1.1 dates |
| D10 | **Dates in all documents are provisional** and will be set separately. Do not plan around them. | All documents |
| D11 | Product name and use of "OpenEMR" are under legal review. Do not write "replaces OpenEMR" in any user-facing text. | — |
| D12 | **Stack:** FastAPI (Python 3.13), React + TypeScript + Vite, PostgreSQL 18 (FHIR R4 / US Core-shaped clinical tables; read-only FHIR API; ADR-0011), Keycloak, Nginx, SeaweedFS, OpenBao, vLLM, faster-whisper. No patient data outside production; synthetic data (Synthea) only. *Was: ~~HAPI FHIR R4 with US Core~~ (retired by ADR-0011).* | — |
| D20 | **Contract-first stays (ADR-0002).** Sam's generated admin endpoints are dropped; DB names map to contract camelCase in each module's repository. (ADR-0011 condition 1) **Accepted.** | Sam's proposal (PR #9) generated endpoints |
| D21 | **Thulasi's core is used** (`require()`, `tenant_db`, Problem Details, session cookie). `tenant_db` sets the database settings the schema's RLS policies read (`app.current_tenant_id`, `app.current_user_id`, `app.correlation_id`). The clinic comes from the server-side session, not token claims. (ADR-0011 condition 2) **Accepted.** | Sam's proposal's own login and token-claim reading |
| D22 | **The external `/fhir` API is read-only**, keeps OperationOutcome for its errors, offers `POST _search`, and query strings are stripped from logs (D13). Our screens never call `/fhir`. (ADR-0011 condition 3) **Accepted.** | — |
| D23 | **Three schemas in one database:** `clinical` (FHIR-shaped), `admin` (normalized), `audit` (append-only audit chain). One database role per service, each with the minimum grants: `shri_app` for the API (clinical and admin read/write, audit insert only); `shri_fhir_reader` for `/fhir` (clinical read only); `shri_integration` for the partner worker (integration tables plus result filing); `shri_reporting` (read-only, approved views only); `shri_migrator` (owns everything; migrations only). RLS stays forced on every clinic table. Anand implements this during schema adoption. (ADR-0011 condition 4) **Accepted.** | — |
| D24 | **Before the 30 October lock, only P0 tables are locked** (`P0_SCHEMA_SCOPE.md`). Owners Anand and Sam. Also decided for the lock: (1) the 0..1 simplifications are approved as listed in Sam's README; (2) **diagnosis removal:** removing a diagnosis before the note is signed sets the Condition's verification status to `entered-in-error` with a reason, and a `Provenance` record of who removed it and why. An entered-in-error diagnosis is excluded from the chart, the problem list, decision support, AI summaries, claims and patient-facing views; it is kept only for audit. The database refuses a charge or claim line that points at an entered-in-error diagnosis. There is no DELETE; (3) a load test of the visit, results and claims write paths; (4) **PostgreSQL 18, on the latest 18.x minor release** (migrations and tests re-verified on 18; UUID defaults `uuidv7()`). Move to PostgreSQL 19 only after it has had a couple of minor releases; (5) the eight "P0 items to confirm" are approved as P0. (ADR-0011 condition 5) **Accepted.** | Tech Arch ADR-03 "PostgreSQL 18" confirmed |
| D25 | **The outbox is for external partners only** (labs, e-prescribing, clearinghouse, fax, SMS). (ADR-0011 condition 6) **Accepted.** | — |
| D26 | **Before India:** designs for market code systems and DPDP erasure. Owner Anand. (ADR-0011 condition 7) **Accepted.** | — |
| D27 | **Full SSN is never stored.** Only a hash and the masked last four, as the schema already enforces (HIPAA minimum necessary). Decided 2026-10-23. | — |

## Who owns what

| Person | Owns |
|---|---|
| **Vimal** | OpenAPI contracts and mock server; patients and insurance, scheduling and check-in, eligibility, encounters and notes, patient history APIs; then AI (gateway, LLM serving, voice-to-text, AI-01 note drafting, AI-02 chart summary, scoring; P1: RAG, AI-03, AI-04, document extraction); AI screens |
| **Thulasi** | Middleware and security; integration engine and webhooks; medications and prescriptions APIs; orders and results APIs |
| **Anand** | The PostgreSQL schema (FHIR-shaped clinical tables and normalized admin tables), migrations and data-access helpers; the read-only FHIR API for outside systems; file system and file service; practice setup, billing and payments, documents and fax, C-CDA, inbox, exports and onboarding APIs; admin, billing and document screens |
| **Minalini** | Design system and all other screens (most already exist; wire them to the APIs); browser side of login; communications and operations dashboard APIs; design review of everyone's screens |

## Proposed (not yet agreed)

Proposed by Vimal on 2026-10-22 (Stage 1 review). They move up to **Decisions** only after everyone named in the last column agrees. Detail: `contracts/docs/README.md` (VD table).

| # | Proposed decision | Overrides | Must agree |
|---|---|---|---|
| D13 | No PHI in URLs. Opaque UUIDs are allowed; names, date of birth, phone, MRN, driver's license numbers, member IDs and SSN never are. PHI searches use `POST …/search` with a body (patient search is `POST /patients/search`). | `API_Catalogue.md` `GET /patients?search=` | Thulasi, Anand, Minalini |
| D14 | No DELETE in the API. An unsigned encounter diagnosis is removed with `POST /encounters/{id}/diagnoses/{did}/remove`; signed records only get entered-in-error, through one action per resource type with its own permission. | `API_Catalogue.md` `DELETE /encounters/{id}/diagnoses` and `/records/{type}/{rid}/entered-in-error` | Thulasi, Anand, Minalini |
| D15 | Eligibility runs at booking, in a pre-visit batch and at check-in (FRS FR-RCM-01). | `01_Vimal_Implementation_Guide.md` Steps 3–4 (check-in and batch only) | Thulasi, Anand |
| D16 | Check-in creates the Encounter through the encounter service; `POST /encounters` is only for unscheduled encounters (telephone, documentation-only). Both use the same service. | — | Anand, Minalini |
| D17 | The contract is one OpenAPI file per module plus shared components, bundled into one file for tools. Module owners approve the sections they implement (`x-owner`); Vimal approves standards conformance for all. | `01_Vimal_Implementation_Guide.md` Day 1 item 1 (single file) | Thulasi, Anand, Minalini |
| D18 | U.S. spelling in every API identifier and description (e.g. `favorites`, `license`). | `API_Catalogue.md` `/me/favourites` | Thulasi, Anand, Minalini |
| D19 | P1 endpoints and `/fhir` are out of the first contract pass. | — | Thulasi, Anand, Minalini |

## Still open

Every row has an owner and the milestone it blocks: **schema lock** (30 October), **pilot**, **conference**, **India**. Storage and schema questions were settled by ADR-0011 and are listed under "Resolved" below.

| Question | Owner | Blocks | Affects |
|---|---|---|---|
| US Core version to target; 9.0.0 is current on hl7.org (checked 2026-10-22). Tied to whether ONC certification is planned | Anand, with management (ONC) | **Needed before the 30 October schema lock** | Clinical table shapes, `/fhir`, FHIR Validator in CI |
| CPT license (AMA; Tech Arch ADR-18) | Management (raised by Vimal) | **Needed before the 30 October schema lock** | Code tables, code search, mock examples |
| ONC certification need | Management (product owner) | Schema lock (through the US Core version) | Customer targeting, US Core version |
| Clearinghouse (Waystar is the candidate), e-prescribing vendor, first lab | Management (raised by Vimal) | Pilot | Eligibility, claims, prescriptions, lab orders |
| Licensed drug database or the e-prescribing vendor's checks | Management and clinical advisors (raised by Thulasi) | Pilot | Medication safety checks |
| EPCS (controlled substances) on day one | Management and clinical advisors (raised by Thulasi) | Pilot | Prescriptions |
| Domain for error-type URIs and FHIR identifier systems (placeholder `company-domain.invalid`) | Management (raised by Vimal) | Pilot | Error format, FHIR identifiers |
| Session idle timeout on shared workstations: 15 minutes agreed by Thulasi (T9); 13-minute warning confirmed | Clinical advisors (raised by Thulasi) | Pilot | Security, clinician workflow |
| Clinical rows of the role-to-permission matrix, including the gap rows (SECURITY_MODEL §4.3, §4.4) | Clinical advisors (raised by Thulasi) | Pilot | `x-permission` on every endpoint |
| Encounter-close rules (DATA_OWNERSHIP §5.2) | Clinical advisors (raised by Vimal) | Pilot | Encounter close, billing |
| Care-team (relationship-based) access limits: MVP or P1 | Vimal, with clinical advisors | Pilot | Patient access checks |
| `enqueue()` signature change to `enqueue(db, partner, message_type, payload, idempotency_key, ordering_key=None)` (T29): a separate core PR, reviewed by all four | Thulasi | Pilot (first partner integration) | Partner calls (outbox for partners only, D25) |
| Repository license (the schema README says AGPL) | Management and counsel | Conference | Commercial release |
| Market code systems and DPDP erasure designs (D26) | Anand | India | India market profile |

### Work before the 30 October schema lock (decided; owners named)

| Work | Owner | Source |
|---|---|---|
| Tag all 218 tables P0, P0 stretch, P1 or P2 in the data dictionary | Anand, Sam | P0_SCHEMA_SCOPE.md |
| Add what is missing for the eight approved "P0 items to confirm" | Sam, Anand | P0_SCHEMA_SCOPE.md, D24 |
| Load-test the visit, results and claims write paths with the composite foreign keys in place | Anand, Sam | D24 |
| Re-verify migrations and tests on PostgreSQL 18; UUID defaults `uuidv7()` | Anand | D24 |
| Three schemas and five roles (D23) | Anand | D23 |
| Lock the P0 tables (afterwards they change only through new migrations) | Anand, Sam | D24 |

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
