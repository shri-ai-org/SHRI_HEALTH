# Note for Anand — API contract items needing your decision

From: Vimal (drafted with Claude Code) · 2026-10-22 · Becomes GitHub issues once the repository exists (VD-LOC).

Each item has a **PROPOSED** answer already written into the documents so work can continue. Please reply "agree", or give your answer. **A1 blocks Stage 4** (VD-G7). Items marked **blocks Stage 3** are needed for the shared contract components.

## Schema and HAPI placement

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A1 | Schema baseline (83 vs 89 tables) and the list of tables that move to HAPI (your Day 1 output). When can we load it? **Blocks Stage 4.** | — | DATA_OWNERSHIP (all "pending schema" markers) |
| A2 | Does our database keep an encounter row with the same UUID as the HAPI Encounter? Needed so check-in is not blocked by HAPI, and for the status board and billing | Yes | DATA_OWNERSHIP §1 (pattern B), ARCHITECTURE_CONTEXT §4.2 |
| A3 | Encounter diagnoses: Vimal chose option B (draft in ours until the encounter is signed, then written to HAPI as Conditions). Needs your draft table `encounter_diagnosis` | Please confirm the table | DATA_OWNERSHIP §2.5 |
| A4 | Legal record of a signed note. Vimal's proposal: the signed version in ours (immutable, hash-chained, audited) is the legal record; the HAPI DocumentReference carries the same content hash; reconciliation compares hashes. Also: where the hash goes in FHIR (R4 `Attachment.hash` is SHA-1) | Your sign-off, plus compliance confirmation (through Vimal) | DATA_OWNERSHIP §3.2 |
| A5 | Clinical writes (vitals, history) when HAPI is down: Vimal accepted for the MVP that they fail with `503 clinical-store-unavailable`; registration and check-in never block and queue through the outbox (D7). Rooming impact is an accepted risk | Please agree | DATA_OWNERSHIP §3.3, ARCHITECTURE_CONTEXT §8 |
| A6 | Tenant isolation inside HAPI (with Thulasi) | One HAPI partition per organization | DATA_OWNERSHIP §3.4 |
| A7 | US Core version to target (9.0.0 is current on hl7.org as of 2026-10-22; certification may need another) | Decide with TA ADR-16 | DATA_OWNERSHIP §2 |

## IDs, mirroring, consistency (blocks Stage 3)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A8 | HAPI client-assigned IDs equal to our UUIDs (`PUT <Type>/<uuid>`); FHIR client generates UUIDs for HAPI-only resources | Yes; HAPI configured to allow client-assigned IDs | ADR-0009, API_STANDARDS §5 |
| A9 | Our identifier on every HAPI resource, and its system URI | `https://fhir.<COMPANY_DOMAIN>/sid/<resource>-id` (domain is the open constant in API_STANDARDS §0) | DATA_OWNERSHIP §3.1 |
| A10 | Mirror Practitioner, PractitionerRole, Organization, Location from practice setup (VD-G5, pattern M) | Yes | DATA_OWNERSHIP §2.3 |
| A11 | Mirror Coverage (and payer Organization) to HAPI | Yes; US Core Coverage exists and C-CDA export needs insurance | DATA_OWNERSHIP §2.1 |
| A12 | Outbox jobs carry the ID only; worker loads the current row; FHIR transaction Bundles with conditional upserts of referenced mirrors; our version stored in `meta.tag` or an extension; nightly reconciliation | Yes | DATA_OWNERSHIP §3.1–3.2 |
| A13 | ETag translation to HAPI `meta.versionId`; version columns on every edited table | Yes | API_STANDARDS §11, ADR-0008 |
| A14 | HAPI paging wrapped in our opaque cursor | Yes | API_STANDARDS §8, ADR-0004 |
| A15 | UUIDv7 default for new IDs | Yes, when on PostgreSQL 18 | API_STANDARDS §5 |

## FHIR mappings

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A16 | Emergency contacts as `Patient.contact`; RelatedPerson only for legal representatives | Yes | DATA_OWNERSHIP §2.1 |
| A17 | Merge and undo merge in HAPI | `Patient.link` `replaced-by` / `replaces` | DATA_OWNERSHIP §2.1 |
| A18 | Addendum as DocumentReference with `relatesTo.code = appends`; co-signature as an extra Provenance agent; AI involvement in Provenance | Yes | DATA_OWNERSHIP §2.1 |
| A19 | Social history profiles beyond smoking status (Simple Observation, Occupation) | Your choice per US Core version | DATA_OWNERSHIP §2.1 |
| A20 | After-visit summary and clinical documents also as DocumentReference | Yes | DATA_OWNERSHIP §2.1, §2.3 |

## Data types and files (blocks Stage 3)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A21 | Money shape | `{ "value": "125.00", "currency": "USD" }` (decimal string) | API_STANDARDS §6.3 |
| A22 | Each facility stores an IANA time zone | Yes | API_STANDARDS §6.1 |
| A23 | HCPCS system URI in the terminology tables | Confirm | API_STANDARDS §6.4 |
| A24 | File service flow: upload URL → PUT → complete (async scan) → attach by `fileId`; purposes; allowed types and sizes per purpose; multipart for long audio; download links valid ≤ 5 minutes; client file names not stored | As written | API_STANDARDS §15 |
| A25 | Terminology: which code systems are loaded; CPT license status (affects code search and mock examples) | Examples show CPT codes without descriptions until licensed | API_STANDARDS §20 |

## Your endpoints and schema change requests

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A26 | Single GETs for practice setup resources and documents; `practice-setup:*` grouped permission | Add / yes | ENDPOINT_INVENTORY #151–186, #207 |
| A27 | C-CDA export: if slow, `POST /patients/{patientId}/ccda-exports` → 202 | Your call | #213 |
| A28 | `/cosign-rules` owned by Vimal (rules evaluated in notes), even though it is setup data | Yes | #87–89 |
| A29 | Claims state machine, close rule, co-signature hold, superbill handling when an encounter is entered-in-error (with the RCM analyst) | Please review | DATA_OWNERSHIP §5.7, §5.2 |
| A30 | Events billing, inbox and documents consume and publish | As listed | EVENTS §4 |
| A31 | Schema change requests: `user_clinical_preference` (favorites; P0 gap), co-signature rule configuration, draft `encounter_diagnosis` (if option B), encounter row (A2), version columns (A13), no full-SSN column (pending management, VD-SSN) | Please confirm | DATA_OWNERSHIP §2.1 |
| A32 | Sign off your rows (#148–219) | — | ENDPOINT_INVENTORY |

## Added after Thulasi's and Minalini's sign-offs (2026-10-22)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| A33 | **Where shared resources live in HAPI** (Practitioner, Organization, Location): the default partition shared by all clinics, or a copy per clinic. Raised by Thulasi (T30); your design decision; **blocks Stage 4**. Also: outside `/fhir` clients get their partition from machine-token claims | Your design | DATA_OWNERSHIP §3.4 |
| A34 | HEIC (iPhone photo format) for insurance-card images: accepted only if the file service converts it for display. P0 accepts JPEG and PNG (Minalini M13, Vimal) | Your call | API_STANDARDS §15 |
| A35 | Confirm the medication-list mapping: MedicationRequest with `intent` and `reported[x]` for patient-reported items (Thulasi T36) | Confirm | DATA_OWNERSHIP §2.2 |
| A36 | Break-glass notice to the privacy officer arrives as an **inbox item for CO**, from the `break-glass.granted` event, never as an email with PHI (Thulasi T16) | Add the inbox item type | EVENTS §4, SECURITY_MODEL §5.2 |
| A37 | Review Thulasi's PR changing `enqueue()`'s signature (T29): core change, all four of us review it | Review | DATA_OWNERSHIP §3.1 |

