# Shri Health API — contract documents

Status: **PROPOSED** (Stage 2, 2026-10-22). Approved by Vimal as a proposal for team review; nothing here is agreed until each document's sign-off line is complete.
Owner of this folder: Vimal (`/contracts/` in CODEOWNERS, TW §3).

These documents set the rules for the API contract in `contracts/openapi/`. The contract itself is written in Stage 3 (shared parts) and Stage 4 (endpoints).

## Documents

| Document | What it answers | Needs sign-off from |
|---|---|---|
| [ARCHITECTURE_CONTEXT.md](ARCHITECTURE_CONTEXT.md) | How a request travels through middleware, modules, our one PostgreSQL database, the read-only `/fhir` API, the integration engine and the AI gateway | Vimal, Thulasi, Anand |
| [API_STANDARDS.md](API_STANDARDS.md) | The rulebook every endpoint follows: naming, IDs, dates, money, pagination, errors, idempotency, concurrency, async work, files, webhooks, PHI-safe search | Vimal (all), Thulasi (errors, headers, idempotency), Anand (IDs, money, files), Minalini (casing, pagination shape) |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | How the API relies on Thulasi's middleware: session, CSRF, permissions, roles, context, break-glass, audit, PHI classification, threats | Thulasi |
| [DATA_OWNERSHIP.md](DATA_OWNERSHIP.md) | For every resource: system of record, FHIR resource and US Core profile, consistency, concurrency, lifecycle state machines | Anand (Vimal for Vimal's modules, Thulasi for medications and orders) |
| [ENDPOINT_INVENTORY.md](ENDPOINT_INVENTORY.md) | Every MVP endpoint with owner, storage, permission, audit, idempotency, concurrency, async flag, FRS reference and Stage 4 batch | Each module owner for their rows |
| [EVENTS.md](EVENTS.md) | Domain event naming, envelope, Server-Sent Events framing, the initial event catalogue | Thulasi (publisher and stream), Anand and Minalini (consumers) |
| [TOOLCHAIN.md](TOOLCHAIN.md) | OpenAPI version, file layout, bundler, linter, mock server, breaking-change check, contract tests, client generator, with versions checked on 2026-10-22 | Vimal, Thulasi (CI), Minalini (client generator) |
| [CONTRACT_GOVERNANCE.md](CONTRACT_GOVERNANCE.md) | How anyone proposes a change, review rules, breaking changes, the lint ruleset, contract tests | Vimal, Thulasi |
| [EXTENSIONS.md](EXTENSIONS.md) | The `x-owner`, `x-permission`, `x-audit` and `x-phi` contract extensions: values, who reads them, lint rules | Vimal, Thulasi |
| [GLOSSARY.md](GLOSSARY.md) | Domain terms in plain English | Everyone (review only) |
| [notes/](notes/) | One note per person with every item that needs their answer, each with a PROPOSED answer | — |

Cross-team architecture decisions are recorded as ADRs in [`docs/adr/`](../../docs/adr/) (owner: everyone, TW §2).

## How to read the markers

| Marker | Meaning |
|---|---|
| **PROPOSED** | My recommendation, with a one-line reason. Not a fact and not approved. |
| **Pending &lt;name&gt;** | Needs that person's answer. A PROPOSED answer is written in place so work can continue; it is collected in `notes/NOTE_FOR_<NAME>.md`. |
| **Pending schema lock** | Depends on exact table and column names in the adopted schema (Sam's schema, ADR-0011), fixed at the 30 October lock for P0 tables (`docs/context/P0_SCHEMA_SCOPE.md`). Stage 4 does not start until then. |
| **Pending management** | Needs a decision outside the four of us; raised through Vimal. |

## Source abbreviations

| Short | Document |
|---|---|
| DEC | `docs/context/DECISIONS.md` (wins over everything else) |
| VG | `docs/context/01_Vimal_Implementation_Guide.md` |
| TW | `docs/context/00_Team_Workflow_and_Claude_Code_Setup.md` |
| CAT | `docs/context/API_Catalogue.md` |
| FRS | `docs/context/FRS_v1_2.md` |
| TA | `docs/context/Technical_Architecture_v1_1.md` (its ADR-19 agrees with DEC D1 since ADR-0011) |
| IP | `docs/context/Implementation_Plan_v1_1.md` (background only) |
| VD-xx | Vimal's decisions on the Stage 1 questions, 2026-10-22 (listed below) |

## Vimal's Stage 1 decisions (VD), 2026-10-22

These are Vimal's answers in the Stage 1 review. They are binding for the contract work. Proposed for adding to DECISIONS.md: see [notes/NOTE_FOR_VIMAL.md](notes/NOTE_FOR_VIMAL.md).

| ID | Decision |
|---|---|
| VD-G1 | No DELETE. While an encounter is unsigned, a diagnosis is removed with `POST /encounters/{id}/diagnoses/{did}/remove`. After signing, only entered-in-error. |
| VD-G2 | Opaque UUIDs are allowed in URLs. Names, date of birth, phone, MRN, driver's license numbers, member IDs and SSN never are. Any search on such fields uses `POST …/search` with a body. Patient search is `POST /patients/search`. |
| VD-G3 | Eligibility runs at booking, in a pre-visit batch and at check-in (FRS FR-RCM-01). |
| VD-G4 | Check-in creates the Encounter through the encounter service. `POST /encounters` is kept only for unscheduled encounters (telephone, documentation-only). Both paths use the same service. |
| VD-G5 | ~~PROPOSED, pending Anand: Practitioner, PractitionerRole, Organization and Location are mirrored into HAPI from practice setup, using the same pattern as Patient (D7).~~ **Resolved by ADR-0011:** they are FHIR-shaped tables in our database; nothing is mirrored. |
| VD-G6 | One entered-in-error action per resource type, each with its own `x-permission`, e.g. `POST /patients/{id}/problems/{pid}/entered-in-error`. |
| VD-G7 | DATA_OWNERSHIP is drafted with "pending schema" markers and finalized when the schema is loaded. Stage 4 does not start until then. |
| VD-G8 | One contract file per module plus shared components, bundled into one file for tools. |
| VD-G9 | U.S. spelling in every API identifier and description (favorites, license). |
| VD-G10 | Vimal's Claude Code deny list is authoritative, extended with Minalini's and Anand's feature folders (corrected list in NOTE_FOR_VIMAL). |
| VD-G11 | The notes contract is designed so AI drafts fit from the start; AI-01 is built after the Step 5 endpoints exist. |
| VD-SCOPE | P1 endpoints and `/fhir` are out of the first pass. |
| VD-LOC | API docs in `contracts/docs/`; cross-team ADRs in `docs/adr/`; notes for owners in `contracts/docs/notes/` (they become GitHub issues once the repo exists). |
| VD-SIGN | Module owners approve the contract sections they implement (`x-owner`); Vimal approves standards conformance for all. |
| VD-TITLE | The API title is "Shri Health API". |
| VD-SSN | PROPOSED, pending management: no full SSN in the MVP; at most an optional last 4 digits for patient matching. |
| VD-REPO | Work happens on `vimal/contracts-foundation`, branched from `main`. Never commit to `main`. |

### Stage 2 review answers, 2026-10-22

| ID | Decision |
|---|---|
| VD-DX | ~~Encounter diagnoses: option B. Drafted in our database until the encounter is signed; written to HAPI as Conditions on signing.~~ **Replaced by ADR-0011:** diagnoses are Condition rows in our database; removal before signing sets `entered-in-error` with the reason "removed before signing" (D24, DATA_OWNERSHIP §2.5). |
| VD-LEGAL | **Resolved by ADR-0011:** the signed note row in our database is the legal record. ~~The HAPI DocumentReference as a second copy with the same content hash, checked by reconciliation.~~ |
| VD-HAPIDOWN | ~~Accepted for the MVP: clinical writes that need HAPI return `clinical-store-unavailable`; rooming impact an accepted risk.~~ **Retired by ADR-0011:** no HAPI, so no such failure; partner outages are handled through the outbox (ARCHITECTURE_CONTEXT §8). |
| VD-DOMAIN | Still open: the company domain is the constant `COMPANY_DOMAIN` in API_STANDARDS §0. |
| VD-CLOSE | Still open: encounter-close rules (DATA_OWNERSHIP §5.2). |
| VD-TOOLS | Accepted: OpenAPI 3.1; adopt tool releases only once they are 7 days old (TOOLCHAIN). |
| VD-ADR | Stage 2 ADRs are numbered 0002–0010; ADR-0001 is Thulasi's repository ownership ADR (accepted). |
