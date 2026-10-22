# Shri Health — Decisions Log (read this first)

This file records decisions made **after** FRS v1.2, Technical Architecture v1.1 and Implementation Plan v1.1 were written. Where those documents disagree with this file, **this file wins**.

## Which document wins

1. `DECISIONS.md` (this file)
2. The owner's implementation guide (`01_` to `04_`) and `00_Team_Workflow_and_Claude_Code_Setup.md`
3. `API_Catalogue.md`
4. `FRS_v1_2.md` (what the product must do)
5. `Technical_Architecture_v1_1.md` (how it is built), except where overridden below
6. `Implementation_Plan_v1_1.md` (background only: phases, gates, risks). Its workstream table and dates are out of date.

## Decisions

| # | Decision | Overrides |
|---|---|---|
| D1 | **Clinical data lives in HAPI FHIR** (JPA server with its own PostgreSQL). Administrative and operational data lives in our PostgreSQL. There are two databases. | Technical Architecture v1.1 ADR-19 and §1 ("application-owned PostgreSQL as clinical system of record; no HAPI in production") and the plan's matching recommendation |
| D2 | Our API reaches HAPI **only through its FHIR API**, via the client in `backend/app/fhir/`. Nobody reads or writes HAPI's internal tables from application code. | — |
| D3 | **Security lives in the middleware** (owner: Thulasi): login with reference tokens, permissions, row-level security, audit, encryption in transit and at rest, file-encryption keys, rate limits. Endpoints never handle tokens, passwords or encryption themselves; they use `require()` and `tenant_db`. | — |
| D4 | **Mirth Connect is not used.** A Python integration engine handles labs (HL7 v2 over MLLP), clearinghouse, e-prescribing, fax and SMS. | — |
| D5 | **Team ownership** is as in `00_Team_Workflow_and_Claude_Code_Setup.md` (CODEOWNERS). Summary below. | Plan v1.1 workstream table |
| D6 | **Build order:** API contracts first. Admin and front-desk APIs before clinical APIs. Vimal moves to AI after his APIs. | Plan v1.1 "doctor-first vertical slice" |
| D7 | **Patient registration** is stored in our database (source of truth for demographics and insurance) and mirrored to a FHIR `Patient` in HAPI on every change, through the integration engine so a HAPI outage never blocks the front desk. | — |
| D8 | **Notes and prescriptions:** drafts and versions in our database; on signing, written to HAPI (`DocumentReference` for notes, `MedicationRequest` for prescriptions) with a `Provenance` record. | Technical Architecture v1.1 storage notes for notes |
| D9 | **"MVP by late December"** is understood as the core clinic workflow working end to end on staging with synthetic data, with partners (lab, e-prescribing, clearinghouse) in test mode. Live partner certification, security sign-off and a real-patient pilot come after. *Awaiting management confirmation.* | Plan v1.1 dates |
| D10 | **Dates in all documents are provisional** and will be set separately. Do not plan around them. | All documents |
| D11 | Product name and use of "OpenEMR" are under legal review. Do not write "replaces OpenEMR" in any user-facing text. | — |
| D12 | **Stack:** FastAPI (Python 3.13), React + TypeScript + Vite, PostgreSQL, HAPI FHIR R4 with US Core, Keycloak, Nginx, SeaweedFS, OpenBao, vLLM, faster-whisper. No patient data outside production; synthetic data (Synthea) only. | — |

## Who owns what

| Person | Owns |
|---|---|
| **Vimal** | OpenAPI contracts and mock server; patients and insurance, scheduling and check-in, eligibility, encounters and notes, patient history APIs; then AI (gateway, LLM serving, voice-to-text, AI-01 note drafting, AI-02 chart summary, scoring; P1: RAG, AI-03, AI-04, document extraction); AI screens |
| **Thulasi** | Middleware and security; integration engine and webhooks; medications and prescriptions APIs; orders and results APIs |
| **Anand** | HAPI FHIR server, FHIR client and mappings; our database and migrations; file system and file service; practice setup, billing and payments, documents and fax, C-CDA, inbox, exports and onboarding APIs; admin, billing and document screens |
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

| Question | Affects |
|---|---|
| Baseline schema: 83-table version or the 89-table `shri_health_db` | Every API that stores data |
| Which tables move to HAPI (Anand's Day 1 output) | Encounter, history, medication and order APIs |
| Clearinghouse (Waystar is the candidate), e-prescribing vendor, first lab | Eligibility, claims, prescriptions, lab orders |
| Licensed drug database or the e-prescribing vendor's checks | Medication safety checks |
| EPCS (controlled substances) on day one | Prescriptions |
| Repository licence (the schema README says AGPL) | Commercial release |
| ONC certification need | Customer targeting |
| Tenant isolation inside HAPI. Agreed by Thulasi (issue #3, T30): one partition per clinic, tenant taken from the same request context as `tenant_db`, never from input. **Still open (Anand's design, blocks Stage 4):** where shared resources live (Practitioner, Organization, Location): default partition or a copy per clinic. See `contracts/docs/DATA_OWNERSHIP.md` §3.4 | Every API that reads or writes HAPI |
| HAPI resource IDs: client-assigned UUIDs equal to ours, plus our identifier system URI (Anand; ADR-0009) | Outbox retries, every clinical API |
| US Core version to target; 9.0.0 is current on hl7.org as of 2026-10-22 (Anand; depends on ONC need) | FHIR mappings, validator in CI |
| Mirror Practitioner, PractitionerRole, Organization, Location (proposed by Vimal) and Coverage into HAPI (Anand) | FHIR references, C-CDA export |
| Does our database keep an encounter row with the same UUID as the HAPI Encounter (Anand) | Check-in, status board, billing |
| Encounter diagnoses: drafted in ours until the encounter is signed, then written to HAPI as Conditions (Vimal accepted 2026-10-22; needs Anand for the draft table) | Encounter APIs, billing, AI-04 |
| Legal record of a signed note. Proposed by Vimal: the signed version in ours (immutable, hash-chained, audited) is the legal record; the HAPI DocumentReference is the clinical and interoperability copy carrying the same content hash (needs Anand and compliance confirmation) | Notes, release of information, audit |
| Clinical writes when HAPI is down. Vimal accepted for the MVP: they fail with `clinical-store-unavailable`; registration and check-in never block and queue through the outbox (D7); rooming impact is an accepted risk to revisit after the pilot (needs Anand, Thulasi) | Vitals, history, rooming |
| Full SSN collected? Proposed: no; optional last 4 for matching (management) | Registration, patient matching |
| Domain for error-type URIs and FHIR identifier systems (Vimal) | Error format, FHIR identifiers |
| Session idle timeout on shared workstations. Agreed by Thulasi (T9): 15 minutes idle, 12 hours absolute; only user-initiated requests reset the timer. Pending clinical advisors; the 13-minute warning (Vimal, M15) is pending Thulasi | Security, clinician workflow |
| ~~AI gateway access to patient data~~ **Agreed (Thulasi, T10):** per-task delegated token minted by the API, at most 5 minutes, read-only, audited as `ai` | AI-02, AI security |
| Role list and role-to-permission matrix. Agreed by Thulasi (T14), with multiple roles as a union; clinical rows pending clinical advisors | `x-permission` on every endpoint |
| Care-team (relationship-based) access limits: MVP or P1 (Vimal) | Patient access checks |
| ~~`/hooks/*`, `/health`, `/ready` outside `/api/v1`~~ **Agreed (Thulasi, T24):** `/health` and `/hooks/*` public through Nginx; `/ready` internal and not in the contract | Partner callback URLs, Nginx routing |
| ~~Idempotency-Key rule~~ **Agreed (Thulasi, T21):** we adopt the expired IETF draft's behavior as our own rule, in middleware; `5xx` and `429` not stored; Anand still to sign ADR-0007 | Partner-bound and payment POSTs |
| `enqueue()` signature change to `enqueue(db, partner, message_type, payload, idempotency_key, ordering_key=None)` (Thulasi, T29). **Core change: all four review Thulasi's PR before merge** | Outbox, registration, check-in, every partner call |
