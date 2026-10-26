# Note for Vimal — your decisions and actions from Stage 2

From: Claude Code · 2026-10-22

## 1. Corrected Claude Code deny list (VD-G10)

You said the deny list "in CLAUDE.local.md" is authoritative. `CLAUDE.local.md` itself has no deny list; the list is in your implementation guide §5 (loaded through `CLAUDE.local.md`). I used that list, then added the feature folders you named plus three paths from TW §7. I did not edit any settings file. **Status (2026-10-22): you will apply it to your own `.claude/settings.local.json`.**

Save as `.claude/settings.local.json` in the cloned repository (not committed):

```json
{
  "permissions": {
    "deny": [
      "Read(.env)", "Read(.env.*)", "Edit(.env)", "Edit(.env.*)",
      "Edit(.claude/settings.json)",
      "Edit(backend/app/core/**)", "Edit(backend/app/integration/**)",
      "Edit(backend/app/db/**)", "Edit(backend/app/fhir/**)",
      "Edit(backend/app/modules/medications/**)", "Edit(backend/app/modules/orders/**)",
      "Edit(backend/app/modules/practice_setup/**)", "Edit(backend/app/modules/billing/**)",
      "Edit(backend/app/modules/documents/**)", "Edit(backend/app/modules/files/**)",
      "Edit(backend/app/modules/ccda/**)", "Edit(backend/app/modules/inbox/**)",
      "Edit(backend/app/modules/exports/**)", "Edit(backend/app/modules/onboarding/**)",
      "Edit(backend/app/modules/communications/**)", "Edit(backend/app/modules/dashboards/**)",
      "Edit(frontend/src/design-system/**)", "Edit(frontend/src/app/**)",
      "Edit(frontend/src/api/generated/**)",
      "Edit(frontend/src/features/patients/**)", "Edit(frontend/src/features/scheduling/**)",
      "Edit(frontend/src/features/clinical/**)", "Edit(frontend/src/features/medications/**)",
      "Edit(frontend/src/features/orders/**)", "Edit(frontend/src/features/inbox/**)",
      "Edit(frontend/src/features/portal/**)", "Edit(frontend/src/features/admin-setup/**)",
      "Edit(frontend/src/features/billing/**)", "Edit(frontend/src/features/documents/**)",
      "Edit(infra/**)", "Edit(.github/**)"
    ]
  }
}
```

What changed against your guide §5:

| Added | Why |
|---|---|
| `Read`/`Edit` of `.env` files, `Edit(frontend/src/api/generated/**)` | In the shared `.claude/settings.json` (TW §7); repeated so they hold even before Thulasi commits the shared file |
| `Edit(.claude/settings.json)` | Thulasi owns it (TW §2) |
| The ten `frontend/src/features/*` folders | Your instruction (VD-G10) |

Reminder from TW §7: these rules stop Claude's file tools, not shell commands. CODEOWNERS and branch protection remain the real guard. After saving, run `/permissions` in an interactive `claude` terminal to confirm.

## 2. Proposed additions to DECISIONS.md

Your Stage 1 decisions are recorded in `contracts/docs/README.md` (VD table). **Status (2026-10-23):** D13–D19 are now **Decisions** in DECISIONS.md. They were applied in the Stage 2 documents that Thulasi and Minalini approved in PR #2. ~~Under "Proposed (not yet agreed)" until the team approves.~~

| # | Decision | Overrides |
|---|---|---|
| D13 | No PHI in URLs. Opaque UUIDs allowed; names, birth date, phone, MRN, license numbers, member IDs and SSN never. PHI searches use `POST …/search` (VD-G2) | CAT `GET /patients?search=` |
| D14 | No DELETE in the API. Unsigned encounter diagnoses are removed with `POST …/remove`; signed records only entered-in-error, one action per resource type with its own permission (VD-G1, VD-G6) | CAT `DELETE /encounters/{id}/diagnoses`, `/records/{type}/{rid}/entered-in-error` |
| D15 | Eligibility runs at booking, in a pre-visit batch and at check-in (VD-G3) | VG Steps 3–4 (incomplete) |
| D16 | Check-in creates the Encounter; `POST /encounters` only for unscheduled encounters; one encounter service (VD-G4) | — |
| D17 | Contract: one file per module plus shared components, bundled for tools; module owners approve their sections, Vimal approves standards (VD-G8, VD-SIGN) | VG Day 1 item 1 (single file) |
| D18 | U.S. spelling in all API identifiers and descriptions (VD-G9) | CAT `/me/favourites` |
| D19 | P1 endpoints and `/fhir` are out of the first contract pass (VD-SCOPE) | — |

## 3. Decisions waiting for you

Status after your Stage 2 review (2026-10-22) is in the last column.

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| V1 | Domain for Problem `type` URIs and our FHIR identifier systems | `tag:company-domain.invalid,2026:problem/<code>`; `https://fhir.company-domain.invalid/sid/<resource>-id` (placeholder; Thulasi's code in PR #7 uses the same base) | API_STANDARDS §0, §9.1; DATA_OWNERSHIP §3.1. **Still open:** the company domain (management). Until then the placeholder `company-domain.invalid` is used everywhere; it is one constant in API_STANDARDS §0 |
| V2 | ~~Encounter diagnoses: option A or B (with Anand)~~ **Resolved by ADR-0011:** diagnoses are Condition rows; removal before signing sets entered-in-error with the reason "removed before signing" (D24). | B: draft in ours, HAPI on signing | DATA_OWNERSHIP §2.5. **Accepted (B).** New follow-ups for you: confirm "encounter signed" = its first note signed, and that diagnoses added after signing go straight to HAPI |
| V3 | ~~Legal record of a signed note (with Anand)~~ **Resolved by ADR-0011:** the signed note row is the legal record (ADR-0011). | Locked version in ours | DATA_OWNERSHIP §3.2. **Your proposal recorded:** signed version in ours (immutable, hash-chained, audited) is the legal record; HAPI copy carries the same content hash; reconciliation compares. Needs Anand and compliance |
| V4 | ~~Clinical writes when HAPI is down~~ **Resolved by ADR-0011:** no HAPI, so no such failure mode; partner outages go through the outbox (ARCHITECTURE_CONTEXT §8). | Fail with 503 | DATA_OWNERSHIP §3.3. **Accepted for the MVP**, with registration and check-in queuing; rooming impact recorded in ARCHITECTURE_CONTEXT §8 |
| V5 | Guards for closing an encounter (with clinical advisors) | At least one signed note; no open drafts; diagnosis required for billable types | DATA_OWNERSHIP §5.2. **Still open:** your answer kept the placeholder ("ACCEPTED as written / my change") |
| V6 | ~~Care-team (relationship-based) access limits are P1~~ **Decided (D37):** MVP access by role and facility; care-team members open restricted charts without break-glass; P1 practice setting limits all charts to the care team | Yes, P1; MVP uses clinic, facility and restricted charts | SECURITY_MODEL §5.1 |
| V7 | Patient search minimum criteria and 50-result cap | Yes | API_STANDARDS §14.2 |
| V8 | Your guide is incomplete on eligibility at booking (VD-G3). Update VG Step 3 / Step 4 text? | Yes, one line each | VG |
| V9 | Approve the Stage 4 batch order | B1 platform/setup → B2 patients → B3 front desk → B4 your clinical → B5 Thulasi's clinical → B6 back office → B7 AI | ENDPOINT_INVENTORY |
| V10 | Tooling | OpenAPI 3.1; adopt tool releases only once 7 days old | TOOLCHAIN. **Accepted** |

## 4. To raise with management

All of these are now in DECISIONS.md "Still open", numbered as in the Open Decisions document (Q1–Q30).

| Item | Affects | Source |
|---|---|---|
| ~~SSN: no full SSN in the MVP; optional last 4 for matching (VD-SSN, pending management)~~ **Decided:** D27 (Open Decisions Q10) | Registration, matching | VD-SSN |
| Meaning of "MVP by 31 December" (was D9) | Partner test vs live | DEC "Still open" Q1 |
| Clearinghouse, e-prescribing vendor, first lab | Eligibility, prescriptions, orders payloads | DEC "Still open" |
| Pilot state and specialty | Co-signature rules, EPCS timing | FRS §10 |
| CPT license (AMA) | Code search content, mock examples | TA ADR-18 |
| ONC certification need | US Core version, C-CDA scope | TA ADR-16 |

## 5. For the clinical advisors (through you)

Idle timeout on shared workstations (15 min proposed); clinical rows of the role matrix (who may draft prescriptions, answer refills, mark entered-in-error); required note sections before signing; whether a diagnosis is required to close an encounter.

## 6. Housekeeping

- The repository is cloned at `SHRI HEALTH/SHRI_HEALTH`, inside the old working folder. The working folder still holds the context pack (including duplicate copies of `00_` and `01_`); none of it is in the repository except through `docs/context/`, which already came from `main`. Copy `CLAUDE.local.md` into the clone if you want it loaded there (it is git-ignored).
- `CLAUDE.local.md` points to `backend/app/db/README.md`, which will only exist once Anand's schema is in the repository.
- Stage 2 files are on branch `vimal/contracts-foundation`: `contracts/docs/**`, `docs/adr/0002`–`0010` plus the ADR index, and `docs/context/DECISIONS.md` (new "Proposed (not yet agreed)" section and "Still open" rows only).

## 7. After the Stage 2 sign-offs (2026-10-22)

- Your answers to Minalini's M7 (phone is an identifier; exact full-number match only) and M15 (warning at 13 minutes, pending Thulasi), and on M11 and M13, are applied (API_STANDARDS §14.2, §15; SECURITY_MODEL §2.1, §8).
- ~~Thulasi's T30 point (where shared resources live in HAPI) is now Anand's item A33 and blocks Stage 4.~~ **Resolved by ADR-0011** (no HAPI). ~~Stage 4 now waits for the 30 October schema lock.~~ The schema is locked (D72, 2026-10-24); no stage waits for a date.
- **Reminder:** `enqueue()`'s signature change (T29) comes as a separate core PR from Thulasi (not in PR #7); all four of you review it.
- Still open from you: `COMPANY_DOMAIN` (API_STANDARDS §0) and the encounter-close rules (DATA_OWNERSHIP §5.2).

## 8. After ADR-0011 (2026-10-23)

- HAPI is retired. D1 is rewritten; ADR-0011 is accepted; the HAPI items V2–V4 are resolved.
- **Still open from you:** `COMPANY_DOMAIN`, raised with management; and the encounter-close rules, which go to the clinical advisors (DECISIONS.md "Still open").
- **Remove the architecture lines from your `CLAUDE.local.md`;** they live in DECISIONS.md and the root `CLAUDE.md`. Done locally on 2026-10-23.

## 9. Decisions of 2026-10-23 (D28–D42)

Anand approved the schema, PostgreSQL 18, D13–D19 and his items (D28). IDs are UUIDv4 (D29, ADR-0009 Accepted); hosting is Amazon RDS (D30, ADR-0012); care-team access is decided (D37, V6); Q24 and Q27–Q30 are decided (D30, D38–D41); the repository is the single source for plans and guides (D42). ADR-0004, ADR-0008, ADR-0009 and ADR-0010 are Accepted.
