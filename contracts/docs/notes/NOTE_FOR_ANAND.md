# Note for Anand — API contract items needing your decision

From: Vimal (drafted with Claude Code) · 2026-10-22 · Becomes GitHub issues once the repository exists (VD-LOC).

Each item has a **PROPOSED** answer already written into the documents so work can continue. Please reply "agree", or give your answer. **A1 blocks Stage 4** (VD-G7). Items marked **blocks Stage 3** are needed for the shared contract components.

## Status after ADR-0011 (2026-10-23)

HAPI is retired. Clinical data lives in FHIR-shaped tables in our one PostgreSQL 18 database (D1, ADR-0011), using Sam's schema. Your guide is now v2 (`docs/context/03_Anand_Implementation_Guide.md`).

- **Resolved by ADR-0011** (struck below): A1–A6, A8–A18 (A7 stays), A31, A33.
- **Still with you:**
  - A7 US Core version (needed before the 30 October lock);
  - A19–A30 (social history profiles, documents, money, time zones, HCPCS, files, terminology and CPT, setup endpoints, C-CDA export, co-sign rules owner, claims, events);
  - A32 (sign-off of your inventory rows), A34 (HEIC), A36 (break-glass inbox item), A37 (`enqueue()` core PR review).
- ~~NEEDS DECISION, with Thulasi: A35 (medication list in MedicationStatement per the P0 scope, or MedicationRequest per T36; DATA_OWNERSHIP §2.2).~~ **Decided (D28):** MedicationRequest.
- **New, from ADR-0011:**
  - the pre-lock work in DECISIONS.md: tag the 218 tables, add the eight approved P0 items, the load test, PostgreSQL 18 re-verify, three schemas and five roles;
  - schema adoption (guide v2, Steps 1–2);
  - the read-only `/fhir` API (Step 5).

## Status after your approval (2026-10-23)

You approved Sam's schema, PostgreSQL 18, D13–D19 and your Stage 2 items (DECISIONS.md D28). Your items below are marked agreed; A35 settles the medication list as MedicationRequest. Also decided that day (D29–D41, ADR-0009, ADR-0012): UUIDv4 IDs, Amazon RDS, the RDS pgvector version, built-in full-text search, C.UTF-8 collation, STORED computed columns, the load test and the re-checks after the split. Your next steps are in your guide and issue #13.

## Schema and placement (HAPI items resolved by ADR-0011)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A1 | ~~Schema baseline (83 vs 89 tables) and the list of tables that move to HAPI (your Day 1 output). When can we load it? **Blocks Stage 4.**~~ **Resolved by ADR-0011:** Sam's 218-table schema (PR #9) is the baseline; no tables move anywhere; P0 tables lock on 30 October (P0_SCHEMA_SCOPE.md). | — | DATA_OWNERSHIP (all "pending schema" markers) |
| A2 | ~~Does our database keep an encounter row with the same UUID as the HAPI Encounter? Needed so check-in is not blocked by HAPI, and for the status board and billing~~ **Resolved by ADR-0011:** the Encounter table is in our one database. | Yes | DATA_OWNERSHIP §1 (pattern B), ARCHITECTURE_CONTEXT §4.2 |
| A3 | ~~Encounter diagnoses: Vimal chose option B (draft in ours until the encounter is signed, then written to HAPI as Conditions). Needs your draft table `encounter_diagnosis`~~ **Resolved by ADR-0011:** diagnoses are Condition rows; removal before signing sets entered-in-error with the reason "removed before signing" (D24). | Please confirm the table | DATA_OWNERSHIP §2.5 |
| A4 | ~~Legal record of a signed note. Vimal's proposal: the signed version in ours (immutable, hash-chained, audited) is the legal record; the HAPI DocumentReference carries the same content hash; reconciliation compares hashes. Also: where the hash goes in FHIR (R4 `Attachment.hash` is SHA-1)~~ **Resolved by ADR-0011:** the signed note row is the legal record; no second copy, no hash. | Your sign-off, plus compliance confirmation (through Vimal) | DATA_OWNERSHIP §3.2 |
| A5 | ~~Clinical writes (vitals, history) when HAPI is down: Vimal accepted for the MVP that they fail with `503 clinical-store-unavailable`; registration and check-in never block and queue through the outbox (D7). Rooming impact is an accepted risk~~ **Resolved by ADR-0011:** no HAPI, so no such failure mode. | Please agree | DATA_OWNERSHIP §3.3, ARCHITECTURE_CONTEXT §8 |
| A6 | ~~Tenant isolation inside HAPI (with Thulasi)~~ **Resolved by ADR-0011:** no HAPI partitions; clinic isolation is forced RLS, clinic-carrying and same-patient links (SECURITY_MODEL §5.3). | One HAPI partition per organization | DATA_OWNERSHIP §3.4 |
| A7 | US Core version to target (9.0.0 is current on hl7.org as of 2026-10-22; certification may need another) | Decide with TA ADR-16 **Agreed (D28);** the version itself is Open Decisions Q6, needed before the lock. | DATA_OWNERSHIP §2 |

## IDs and consistency (mirroring resolved by ADR-0011)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A8 | ~~HAPI client-assigned IDs equal to our UUIDs (`PUT <Type>/<uuid>`); FHIR client generates UUIDs for HAPI-only resources~~ **Resolved by ADR-0011:** one database, one ID per record. | Yes; HAPI configured to allow client-assigned IDs | ADR-0009, API_STANDARDS §5 |
| A9 | ~~Our identifier on every HAPI resource, and its system URI~~ **Resolved by ADR-0011:** no HAPI resources; identifiers for `/fhir` are part of your facade design (placeholder domain still open, DECISIONS "Still open"). | `https://fhir.company-domain.invalid/sid/<resource>-id` (domain is the open constant in API_STANDARDS §0) | DATA_OWNERSHIP §3.1 |
| A10 | ~~Mirror Practitioner, PractitionerRole, Organization, Location from practice setup (VD-G5, pattern M)~~ **Resolved by ADR-0011:** they are FHIR-shaped tables in our database; nothing is mirrored. | Yes | DATA_OWNERSHIP §2.3 |
| A11 | ~~Mirror Coverage (and payer Organization) to HAPI~~ **Resolved by ADR-0011:** Coverage is a FHIR-shaped table in our database; nothing is mirrored. | Yes; US Core Coverage exists and C-CDA export needs insurance | DATA_OWNERSHIP §2.1 |
| A12 | ~~Outbox jobs carry the ID only; worker loads the current row; FHIR transaction Bundles with conditional upserts of referenced mirrors; our version stored in `meta.tag` or an extension; nightly reconciliation~~ **Resolved by ADR-0011:** no mirroring; the outbox is for partners only (D25). | Yes | DATA_OWNERSHIP §3.1–3.2 |
| A13 | ~~ETag translation to HAPI `meta.versionId`; version columns on every edited table~~ **Resolved by ADR-0011:** no ETag translation; ETags come from the row version (your helpers' `if_version`). | Yes | API_STANDARDS §11, ADR-0008 |
| A14 | ~~HAPI paging wrapped in our opaque cursor~~ **Resolved by ADR-0011:** no HAPI paging; keyset pagination over our tables. | Yes | API_STANDARDS §8, ADR-0004 |
| A15 | ~~UUIDv7 default for new IDs~~ **Decided (D29, ADR-0009):** IDs stay UUIDv4; ~~UUID defaults `uuidv7()`~~ is not adopted. PostgreSQL 18 stays (D24). | Yes, when on PostgreSQL 18 | API_STANDARDS §5 |

## FHIR mappings

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A16 | ~~Emergency contacts as `Patient.contact`; RelatedPerson only for legal representatives~~ **Resolved by ADR-0011:** RelatedPerson, per the approved P0 scope. | Yes | DATA_OWNERSHIP §2.1 |
| A17 | ~~Merge and undo merge in HAPI~~ **Resolved by ADR-0011:** Patient.link in our database. | `Patient.link` `replaced-by` / `replaces` | DATA_OWNERSHIP §2.1 |
| A18 | ~~Addendum as DocumentReference with `relatesTo.code = appends`; co-signature as an extra Provenance agent; AI involvement in Provenance~~ **Resolved by ADR-0011:** notes are Composition rows (P0 scope); addenda and co-signature with Provenance in the same transaction; `/fhir` presentation is your facade design. | Yes | DATA_OWNERSHIP §2.1 |
| A19 | Social history profiles beyond smoking status (Simple Observation, Occupation) | Your choice per US Core version **Agreed (D28).** | DATA_OWNERSHIP §2.1 |
| A20 | After-visit summary and clinical documents also as DocumentReference | Yes **Agreed (D28).** | DATA_OWNERSHIP §2.1, §2.3 |

## Data types and files (blocks Stage 3)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A21 | Money shape | `{ "value": "125.00", "currency": "USD" }` (decimal string) **Agreed (D28).** | API_STANDARDS §6.3 |
| A22 | Each facility stores an IANA time zone | Yes **Agreed (D28).** | API_STANDARDS §6.1 |
| A23 | HCPCS system URI in the terminology tables | Confirm **Agreed (D28).** | API_STANDARDS §6.4 |
| A24 | File service flow: upload URL → PUT → complete (async scan) → attach by `fileId`; purposes; allowed types and sizes per purpose; multipart for long audio; download links valid ≤ 5 minutes; client file names not stored | As written **Agreed (D28).** | API_STANDARDS §15 |
| A25 | Terminology: which code systems are loaded; CPT license status (affects code search and mock examples) | Examples show CPT codes without descriptions until licensed **Agreed (D28);** the CPT licence is Open Decisions Q7 (before the pilot). | API_STANDARDS §20 |

## Your endpoints and schema change requests

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A26 | Single GETs for practice setup resources and documents; `practice-setup:*` grouped permission | Add / yes **Agreed (D28).** | ENDPOINT_INVENTORY #151–186, #207 |
| A27 | C-CDA export: if slow, `POST /patients/{patientId}/ccda-exports` → 202 | Your call **Agreed (D28):** your call when you build it. | #213 |
| A28 | `/cosign-rules` owned by Vimal (rules evaluated in notes), even though it is setup data | Yes **Agreed (D28).** | #87–89 |
| A29 | Claims state machine, close rule, co-signature hold, superbill handling when an encounter is entered-in-error (with the RCM analyst) | Please review **Agreed (D28).** | DATA_OWNERSHIP §5.7, §5.2 |
| A30 | Events billing, inbox and documents consume and publish | As listed **Agreed (D28).** | EVENTS §4 |
| A31 | ~~Schema change requests: `user_clinical_preference` (favorites; P0 gap), co-signature rule configuration, draft `encounter_diagnosis` (if option B), encounter row (A2), version columns (A13), no full-SSN column (pending management, VD-SSN)~~ **Resolved by ADR-0011:** the adopted schema replaces these change requests; anything missing goes through your P0 review before the lock. | Please confirm | DATA_OWNERSHIP §2.1 |
| A32 | Sign off your rows (#148–219) | — **Agreed (D28).** | ENDPOINT_INVENTORY |

## Added after Thulasi's and Minalini's sign-offs (2026-10-22)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A33 | ~~**Where shared resources live in HAPI** (Practitioner, Organization, Location): the default partition shared by all clinics, or a copy per clinic. Raised by Thulasi (T30); your design decision; **blocks Stage 4**. Also: outside `/fhir` clients get their partition from machine-token claims~~ **Resolved by ADR-0011:** no HAPI partitions; shared resources are ordinary rows under RLS. | Your design | DATA_OWNERSHIP §3.4 |
| A34 | HEIC (iPhone photo format) for insurance-card images: accepted only if the file service converts it for display. P0 accepts JPEG and PNG (Minalini M13, Vimal) | Your call **Agreed (D28):** P0 accepts JPEG and PNG; HEIC only if you add conversion. | API_STANDARDS §15 |
| A35 | Confirm the medication-list mapping: MedicationRequest with `intent` and `reported[x]` for patient-reported items (Thulasi T36) | Confirm **Decided (D28):** MedicationRequest is confirmed (US Core represents the medication list this way), with Thulasi's T36. During your tagging, MedicationStatement is tagged P1: the table is kept, not locked. | DATA_OWNERSHIP §2.2 |
| A36 | Break-glass notice to the privacy officer arrives as an **inbox item for CO**, from the `break-glass.granted` event, never as an email with PHI (Thulasi T16) | Add the inbox item type **Agreed (D28).** | EVENTS §4, SECURITY_MODEL §5.2 |
| A37 | Review Thulasi's separate core PR changing `enqueue()`'s signature (T29), when it opens: core change, all four of us review it | Review **Agreed (D28).** | DATA_OWNERSHIP §3.1 |

