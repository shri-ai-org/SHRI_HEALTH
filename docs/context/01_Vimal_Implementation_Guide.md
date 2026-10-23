# Vimal Prasath — Implementation Guide

**Your role:** owner of the API contract, the front-desk and encounter APIs, and then the AI.
Read `00_Team_Workflow_and_Claude_Code_Setup.md` first for the repo layout, ownership and pull request rules.

## 1. What you own

| Area | Folders |
|---|---|
| OpenAPI contract for every endpoint (everyone's) and the mock server | `contracts/openapi/` |
| Patients and insurance, scheduling and check-in, eligibility | `backend/app/modules/patients/`, `scheduling/`, `eligibility/` |
| Encounters and notes, patient history | `backend/app/modules/encounters/`, `history/` |
| AI endpoints | `backend/app/modules/ai/` |
| AI gateway, model serving, speech, RAG, evaluation | `ai/` |
| AI review screens | `frontend/src/features/ai/` |

**Not yours:** login, tokens, encryption, audit (Thulasi), database tables, data-access helpers and the read-only `/fhir` API (Anand). You use what they provide.

**Since ADR-0011 (2026-10-23):** there is no HAPI. Clinical data lives in FHIR-shaped tables in our one PostgreSQL database; your modules write it in the same transaction as everything else, through your repositories and Anand's helpers in `backend/app/db/`.

## 2. Day 1

1. Create `contracts/openapi/shri-health.yaml` with the shared parts: `/api/v1` base path, cookie security scheme, the standard error object (Problem JSON), pagination, ID formats, and one tag per module.
2. Write the admin contracts first (patients, scheduling, practice setup) so Minalini can start wiring screens.
3. Add the permission each endpoint needs with an extension field, for example `x-permission: patients:write`. Thulasi builds permission checks from these.
4. Start the mock server for the UI:
   ```bash
   npx @stoplight/prism-cli mock contracts/openapi/shri-health.yaml
   ```
5. On your laptop, install faster-whisper and transcribe a sample recording (synthetic speech only, never real patients) to get familiar with the speech tooling.

## 3. Build steps, in order

### Step 1 — Contracts for every endpoint

Write all contracts before building, so the other three can work in parallel. Conventions:

- Plural nouns: `/patients`, `/appointments`. Actions as `POST /appointments/{id}/check-in`.
- Cursor pagination on every list (`?cursor=&limit=`).
- Errors always use the shared Problem JSON object.
- `Idempotency-Key` header on any POST that sends something to a partner (eligibility, claims, prescriptions, lab orders).
- `ETag` / `If-Match` on note and prescription updates, so two people can't silently overwrite each other.
- No DELETE on clinical data; use an `entered-in-error` action.
- IDs are UUIDv4 (D29, ADR-0009); times in UTC with the facility's time zone for display, money as exact decimal strings in USD (D40).

**Done when:** every endpoint from the API list has a contract with a permission name, the mock server runs, and Spectral lint passes.

### Step 2 — Patients and insurance APIs

Endpoints: search, register, view/edit, identifiers, coverages, card images, consents, preferred pharmacy, duplicates, merge, undo merge.

- Registration and insurance are written to the FHIR-shaped `Patient`, `RelatedPerson` and `Coverage` tables in our database, in one transaction, through your repository and Anand's helpers (`backend/app/db/`). Nothing is mirrored and nothing is queued (ADR-0011).
- Duplicate check on register: similar name + same date of birth or phone, using the schema's duplicate-candidate table (exact name at the schema lock).
- MRN: one counter per practice, never reused, practice prefix plus number (D41). The standard U.S. demographic fields are collected, all optional for the patient (D39).
- Chart access (D37, enforced by Thulasi's `require()`): by role and facility; restricted charts need break-glass, except for the patient's care-team members; every access is audited. A practice setting that limits all charts to the care team is P1.
- Card images go through Anand's file service; you only store the file ID.
- Licence scanning happens in the browser; the API just receives normal patient fields.

**Done when:** a patient can be searched, registered with insurance, edited and merged, with every change in one transaction and its version in `_history`.

### Step 3 — Scheduling and check-in APIs

Endpoints: free slots, book (including same-day add-on), list, reschedule, cancel, check in, visit status, status board.

- Free slots come from the availability rules minus exceptions minus booked appointments.
- Prevent double booking inside one database transaction (lock the provider's day while booking).
- Check-in does three things:
  - triggers an eligibility check;
  - creates the `Encounter` row in the same transaction;
  - calls `events.publish()` so the status board updates live.

**Done when:** booking conflicts are refused, check-in updates the status board within a second, and the Encounter row exists.

### Step 4 — Eligibility API

- `POST /eligibility-checks` saves a pending check and calls `integration.enqueue("clearinghouse", "270", ...)`.
- The clearinghouse reply arrives through Thulasi's webhook receiver; your handler updates the check with coverage status, copay and deductible.
- Also add a nightly batch for next-day appointments.

**Done when:** a check against the clearinghouse test system (or the recorded test replies) shows copay and deductible on screen.

### Step 5 — Encounter and notes APIs (build together with AI-01)

Endpoints: open visit, workspace data, vitals, diagnoses, code search, notes (draft, autosave, sign, addenda, co-sign, versions), favourites, after-visit summary, close visit.

| Data | Where it lives |
|---|---|
| Encounter, vitals (`Observation`), diagnoses (`Condition`) | FHIR-shaped tables in our database, written through Anand's helpers |
| Notes: drafts, versions and signed notes | FHIR-shaped `Composition` table in our database; every version kept in `_history` |
| Signed note | Signing locks the row and writes its `Provenance` in the same transaction. The signed note row is the legal record; changes become addenda |
| Diagnosis removed before signing | The `Condition` is set to entered-in-error with a reason and a Provenance record (who and why); excluded from the chart, problem list, decision support, AI summaries, claims and patient-facing views; never deleted (D24) |
| Favourites | Our database (admin tables) |
| Code search | Anand's terminology tables |

- Autosave uses `If-Match` so two tabs can't overwrite each other.
- After-visit summary: render a PDF from the signed note and store it through the file service.
- Closing the visit publishes an `encounter.closed` event; Anand's billing builds the superbill from it.

**Done when:** a clinician can open a visit, write and sign a note, add diagnoses and vitals, and the signed note and its Provenance are committed together.

### Step 6 — Patient history APIs

Problems (`Condition`, problem-list category), allergies (`AllergyIntolerance`), family history (`FamilyMemberHistory`), social history (`Observation`, social-history category), surgical history (`Procedure`), and entered-in-error as a status change, never a delete. All stored in FHIR-shaped tables in our database, through Anand's helpers.

### Step 7 — AI (after the APIs above)

| Order | Piece | What to build | Done when |
|---|---|---|---|
| 1 | LLM serving | vLLM with an OpenAI-compatible API on the GPU server Thulasi secures; load MedGemma 1.5 4B and Qwen3.5-4B; a benchmark script on full-length visit transcripts | Both models answer through one internal URL; latency and quality recorded |
| 2 | Voice-to-text | faster-whisper with Silero voice-activity detection; `POST /encounters/{id}/audio` (chunked upload via the file service); a background job that writes the transcript | A 15-minute recording becomes a transcript the clinician can review |
| 3 | AI gateway | One entry point for every AI call: on/off switch per clinic and per feature (`ai_feature_setting`), sends only the data the task needs, checks output against a JSON schema, logs request metadata (never patient text in logs), versions every prompt (`prompt_template`) | Switching AI off leaves every clinical screen working |
| 4 | AI-01 note draft | Transcript → the provider's template sections as JSON → validation (anything not in the transcript is dropped; unknown stays unknown) → saved as a draft through your notes API, marked AI-generated | Draft appears in the note editor; every accept, edit and reject is logged |
| 5 | AI-02 chart summary | Read permitted history through the clinical APIs (never the database directly); each statement carries a link to its source record; missing and conflicting items listed | Every statement in the summary links to a real record |
| 6 | AI screens | Transcript review, draft note with changes highlighted, summary panel, AI settings; built with Minalini's design system, reviewed by her | Screens pass her design review |
| 7 | Test set and scoring | Record mock patient visits with written reference notes (synthetic, scripted); score AI-01 and AI-02 in MLflow on medical-term errors, omissions, invented facts and clinician edits | Scores recorded for both models; the better model chosen |
| 8 | P1, for the conference | RAG: approved guideline documents → Docling extraction → chunks → pgvector (the RDS version, D31) + PostgreSQL's built-in full-text search (`tsvector` + GIN, D32) → answers with citations. Then AI-03 decision support (shown separately from rule-based alerts), AI-04 coding suggestions, fax and document extraction | Answers always cite sources or say evidence is insufficient |

Start with voice-to-text and note drafting, not RAG. RAG is only needed for P1.

## 4. Handoffs

| You need | From | For |
|---|---|---|
| `require()`, `tenant_db`, errors, `events.publish()`, `integration.enqueue()` | Thulasi | Every endpoint |
| GPU server secured; machine token for the AI gateway | Thulasi | AI step 1 onward |
| Admin tables, terminology tables, `user_clinical_preference` | Anand | Steps 2–5 |
| Data-access helpers (`backend/app/db/`) for Patient, Encounter, Observation, Condition, AllergyIntolerance, FamilyMemberHistory, Procedure, Composition, Provenance; locked P0 schema | Anand | Steps 2–6 |
| File service | Anand | Card images, audio, after-visit summary |

| You give | To | Why |
|---|---|---|
| Contracts and mock server | Everyone, Minalini first | Lets all screen and API work start in parallel |
| Permission names (`x-permission`) | Thulasi | Builds the permission checks |
| Schema change requests (as a pull request comment or issue) | Anand | He owns all tables |
| `encounter.closed` event | Anand | Superbill and billing |

## 5. Your Claude Code settings

Save as `.claude/settings.local.json` (not committed), then start `claude` from the repo root and run `/permissions` to check:

```json
{
  "permissions": {
    "deny": [
      "Edit(backend/app/core/**)", "Edit(backend/app/integration/**)",
      "Edit(backend/app/db/**)", "Edit(backend/app/fhir/**)",
      "Edit(backend/app/modules/medications/**)", "Edit(backend/app/modules/orders/**)",
      "Edit(backend/app/modules/practice_setup/**)", "Edit(backend/app/modules/billing/**)",
      "Edit(backend/app/modules/documents/**)", "Edit(backend/app/modules/files/**)",
      "Edit(backend/app/modules/ccda/**)", "Edit(backend/app/modules/inbox/**)",
      "Edit(backend/app/modules/exports/**)", "Edit(backend/app/modules/onboarding/**)",
      "Edit(backend/app/modules/communications/**)", "Edit(backend/app/modules/dashboards/**)",
      "Edit(frontend/src/design-system/**)", "Edit(frontend/src/app/**)",
      "Edit(infra/**)", "Edit(.github/**)"
    ]
  }
}
```

A good prompt pattern:

> Implement the endpoints tagged `scheduling` in contracts/openapi/shri-health.yaml inside backend/app/modules/scheduling, following the api/service/repository pattern in CLAUDE.md. Use require() and tenant_db. Write pytest tests for success, permission denied and validation errors, then run them. Do not edit files outside backend/app/modules/scheduling.
