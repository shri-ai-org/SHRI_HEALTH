# Contract batch 2: encounters, notes and patient history (Stage A plan)

**Status:** PROPOSED, waiting for Vimal's approval (2026-10-24). Nothing in `contracts/openapi/` changes until it is approved.
**Branch:** `vimal/contracts-batch2`. **Inventory name:** these rows are batch **B4** in ENDPOINT_INVENTORY (its B2 is patients and insurance); this plan calls the work "batch 2" as asked, and the contract keeps the inventory's B-codes.
**Schema:** the locked schema (D72, PR #32) as adopted on `anand/schema-adoption` @ `807144c`. That branch is not on `main` yet.
**Sources:** ENDPOINT_INVENTORY #46, #62–106; SECURITY_MODEL §4.3, §6; DATA_OWNERSHIP §2, §3.2, §5.2, §5.3; EVENTS §4; API_STANDARDS; FRS v1.2 §3.3, §3.4; DECISIONS D8, D14, D16, D24, D37, D55, D67–D70, D72; ADR-0007, ADR-0008. Every row below cites its inventory number.

## 1. Modules and owners

| Module file | Rows | x-owner | Folder that implements it |
|---|---|---|---|
| `encounters.yaml` | #62–89: encounters, vitals, diagnoses, code search, notes, favorites, after-visit summary, co-sign rules | vimal | `backend/app/modules/encounters/` |
| `history.yaml` | #90–106: problems, allergies, family, social and surgical history; plus #46 timeline (B4, listed under patients) | vimal | `backend/app/modules/history/` |

Every operation: `x-release: P0`, `x-storage: clinical` (code search, favorites and co-sign rules: `admin`), session cookie plus CSRF on writes, the standard error responses, no DELETE (D14), no PHI in URLs (D13).

## 2. Operations

Legend. **Audit** as `action/category`: `R/phi-read`, `C/phi-write`, `U/phi-write`, `E/phi-write`, `E/sign`, `E/export`, `C|U/admin`, `R/none`; `patient` is the path parameter when the path has `{patientId}`, otherwise `result` or `body:/patientId`. **Idem**: `S` = `Idempotency-Key` supported (ADR-0007; nothing in this batch reaches a partner). **IfM**: `req` = `If-Match` required (ADR-0008), `opt` = enforced if sent. **New** = a row this plan adds (section 6).

### 2.1 Encounters

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 62 | `POST /encounters` | createEncounter | `encounters:create` | C/phi-write, `body:/patientId` | S | | `encounter.opened` | FR-ENC-01 |
| 63 | `GET /encounters/{encounterId}` | getEncounter | `encounters:read` | R/phi-read, result | | | | FR-ENC-01 |
| 64 | `PATCH /encounters/{encounterId}` | updateEncounter | `encounters:update` | U/phi-write, result | | req | | FR-ENC-01 |
| 65 | `GET /patients/{patientId}/encounters` | listPatientEncounters | `encounters:read` | R/phi-read, patientId | | | | FR-PAT-02 |
| 66 | `POST /encounters/{encounterId}/close` | closeEncounter | `encounters:close` | E/phi-write, result | | opt | `encounter.closed`, `encounter.status-changed` | FR-ENC-01 |
| 67 | `POST /encounters/{encounterId}/entered-in-error` | markEncounterEnteredInError | `encounters:entered-in-error` | E/phi-write, result | | opt | `encounter.entered-in-error` | FR-ENC-01 |

### 2.2 Vitals

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 68 | `POST /encounters/{encounterId}/vitals` | recordVitals | `vitals:create` | C/phi-write, result | S | | | FR-ENC-03, FR-SCH-02 |
| 69 | `GET /patients/{patientId}/vitals` | listPatientVitals | `vitals:read` | R/phi-read, patientId | | | | FR-ENC-03 |
| 70 | `POST /patients/{patientId}/vitals/{vitalId}/entered-in-error` | markVitalEnteredInError | `vitals:entered-in-error` | E/phi-write, patientId | | opt | | FR-ENC-03 |

### 2.3 Diagnoses and code search

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 71 | `POST /encounters/{encounterId}/diagnoses` | addEncounterDiagnosis | `diagnoses:create` | C/phi-write, result | S | | | FR-ENC-02 |
| 72 | `POST /encounters/{encounterId}/diagnoses/{diagnosisId}/remove` | removeEncounterDiagnosis | `diagnoses:remove` | E/phi-write, result | | opt | | FR-ENC-02 |
| 73 | `POST /encounters/{encounterId}/diagnoses/{diagnosisId}/entered-in-error` | markDiagnosisEnteredInError | `diagnoses:entered-in-error` | E/phi-write, result | | opt | | FR-ENC-02 |
| 74 | `GET /codes/search?system=&q=` | searchCodes | `codes:read` | R/none | | | | FR-ENC-02 |

Diagnoses are read with the encounter (#63, ranked 1–12) and the problem list (#90); no `diagnoses:read` is added (Q8).

### 2.4 Notes

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 75 | `POST /encounters/{encounterId}/notes` | createNote | `notes:create` | C/phi-write, result | S | | `encounter.status-changed` (first note moves the encounter to `in-progress`) | FR-ENC-01, FR-ENC-04 |
| 76 | `GET /encounters/{encounterId}/notes` | listEncounterNotes | `notes:read` | R/phi-read, result | | | | FR-ENC-01 |
| 77 | `GET /notes/{noteId}` | getNote | `notes:read` | R/phi-read, result | | | | FR-ENC-01 |
| 78 | `PATCH /notes/{noteId}` | updateNoteDraft | `notes:update` | U/phi-write, result | | req | | FR-ENC-01 |
| 79 | `POST /notes/{noteId}/sign` | signNote | `notes:sign` | E/sign, result | | req | `note.signed` | FR-ENC-01, §3.4 |
| 80 | `POST /notes/{noteId}/addenda` | addNoteAddendum | `note-addenda:create` | C/sign, result | S | req | `note.amended` | FR-ENC-01 |
| 81 | `POST /notes/{noteId}/cosign` | cosignNote | `notes:cosign` | E/sign, result | | req | `note.cosigned` or **new** `note.cosign-returned` | FR-ENC-01 |
| 82 | `GET /notes/{noteId}/versions` | listNoteVersions | `notes:read` | R/phi-read, result | | | | FR-ENC-01 |
| 83 | `POST /notes/{noteId}/entered-in-error` | markNoteEnteredInError | `notes:entered-in-error` | E/phi-write, result | | opt | `note.entered-in-error` | FR-ENC-01 |

### 2.5 Favorites, after-visit summary, co-sign rules

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 84 | `GET /me/favorites` | getMyFavorites | `favorites:read` | R/none (Q9) | | | | FR-ENC-04 |
| 85 | `PUT /me/favorites` | replaceMyFavorites | `favorites:update` | U/admin (Q9) | | req | | FR-ENC-04 |
| 86 | `POST /encounters/{encounterId}/after-visit-summary` | createAfterVisitSummary | `after-visit-summaries:create` | E/export, result | S | | `operation.completed` (kind `encounter.after-visit-summary`) | FR-ENC-06 |
| 87 | `GET /cosign-rules` | listCosignRules | `cosign-rules:read` | R/admin | | | | FR-ENC-01 |
| **new** | `GET /cosign-rules/{cosignRuleId}` | getCosignRule | `cosign-rules:read` | R/admin | | | | FR-ENC-01 |
| 88 | `POST /cosign-rules` | createCosignRule | `cosign-rules:create` | C/admin | S | | | FR-ENC-01 |
| 89 | `PATCH /cosign-rules/{cosignRuleId}` | updateCosignRule | `cosign-rules:update` | U/admin | | req | | FR-ENC-01 |

### 2.6 Patient history and timeline (`history.yaml`)

| # | Method and path | operationId | Permission | Audit | Idem | IfM | FRS |
|---|---|---|---|---|---|---|---|
| 46 | `GET /patients/{patientId}/timeline` | getPatientTimeline | `timeline:read` | R/phi-read, patientId | | | FR-PAT-02 |
| 90 | `GET /patients/{patientId}/problems` | listProblems | `problems:read` | R/phi-read | | | FR-PAT-03 |
| **new** | `GET /patients/{patientId}/problems/{problemId}` | getProblem | `problems:read` | R/phi-read | | | FR-PAT-03 |
| 91 | `POST /patients/{patientId}/problems` | addProblem | `problems:create` | C/phi-write | S | | FR-PAT-03 |
| 92 | `PATCH /patients/{patientId}/problems/{problemId}` | updateProblem | `problems:update` | U/phi-write | | req | FR-PAT-03 |
| 93 | `POST …/problems/{problemId}/entered-in-error` | markProblemEnteredInError | `problems:entered-in-error` | E/phi-write | | opt | FR-PAT-03 |
| 94 | `GET /patients/{patientId}/allergies` | listAllergies | `allergies:read` | R/phi-read | | | FR-PAT-03, FR-MED-01 |
| **new** | `GET /patients/{patientId}/allergies/{allergyId}` | getAllergy | `allergies:read` | R/phi-read | | | FR-PAT-03 |
| 95 | `POST /patients/{patientId}/allergies` | addAllergy | `allergies:create` | C/phi-write | S | | FR-PAT-03 |
| 96 | `PATCH /patients/{patientId}/allergies/{allergyId}` | updateAllergy | `allergies:update` | U/phi-write | | req | FR-PAT-03 |
| 97 | `POST …/allergies/{allergyId}/entered-in-error` | markAllergyEnteredInError | `allergies:entered-in-error` | E/phi-write | | opt | FR-PAT-03 |
| 98–100 | `GET`, `POST /patients/{patientId}/family-history`; `POST …/{familyHistoryId}/entered-in-error` | listFamilyHistory, addFamilyHistory, markFamilyHistoryEnteredInError | `family-history:read`, `:create`, `:entered-in-error` | R / C / E, phi | – / S / – | – / – / opt | FR-PAT-03 |
| 101–103 | same for `/social-history` | listSocialHistory, addSocialHistory, markSocialHistoryEnteredInError | `social-history:*` | same | same | same | FR-PAT-03 (smoking status) |
| 104–106 | same for `/surgical-history` | listSurgicalHistory, addSurgicalHistory, markSurgicalHistoryEnteredInError | `surgical-history:*` | same | same | same | FR-PAT-03 |

All `history.yaml` paths carry `{patientId}`, so `patient: patientId`. History writes publish no events (no consumer exists; section 7).

**Count:** 46 inventory rows (#46, #62–89, #90–106) plus 3 new single GETs = **49 operations**; the contract goes from 101 to 150 operations.

## 3. Record lifecycles

Rules for every machine: a state changes only through an action endpoint, never PATCH (DATA_OWNERSHIP §5); a transition not listed returns `409 invalid-state-transition`; every action writes its Provenance in the same transaction (D8); nothing is deleted (D14); the reason for an entered-in-error or a removal is stored in Provenance `reason`, because no clinical table has a reason column.

### 3.1 Encounter (`clinical.encounter`, statuses as in the schema)

| From → to | How | Who | Guards |
|---|---|---|---|
| — → `arrived` | Check-in (batch 1, D16) | encounter service | appointment checked in |
| — → `in-progress` | `POST /encounters` (#62) | MD, APP | unscheduled only: type telephone or documentation-only (D16); `class` `AMB` or `VR` |
| `arrived` → `triaged` | visit step `roomed` (batch 1, #57) | MA, RN | room given |
| `arrived`/`triaged` → `in-progress` | visit step `with-provider`, or the first note (#75) | MD, APP, RN | — |
| `in-progress` → `finished` | `POST …/close` (#66) | MD, APP | Q1: at least one signed note, no open drafts, a diagnosis for billable types; co-sign pending does **not** block (A29) |
| `arrived`/`triaged` → `cancelled` | appointment cancel, left without being seen (batch 1) | FD, ADM | — |
| `arrived` → `entered-in-error` | undo check-in (batch 1, D55) | FD, ADM | no vitals, notes or diagnoses |
| any → `entered-in-error` | `POST …/entered-in-error` (#67) | MD, APP, ADM | every note entered-in-error first; superbill not billed; ADM only when no note was signed |

No reopening of a `finished` encounter; late information goes in addenda. `PATCH` (#64) edits only: type, reason codes, service location, participants (rendering, supervising), and only while not `finished` or `entered-in-error`.

### 3.2 Note (`clinical.composition`; `status` + `cosignStatus`)

`status`: `preliminary` (draft), `final` (signed), `amended` (signed, with addenda), `entered-in-error`. `cosignStatus`: `not-required`, `pending`, `returned`, `cosigned` (adds `returned`; needs schema item S2).

| From → to | How | Who | Guards and effects |
|---|---|---|---|
| — → `preliminary` | `POST /encounters/{encounterId}/notes` `{ templateId?, noteType }` (#75) | MD, APP, RN | encounter not `finished`/`entered-in-error`; sections copied from the template |
| `preliminary` → `preliminary` | `PATCH /notes/{noteId}` (#78), `If-Match` | author only | each committed autosave is a version in `_history` (the schema writes one per transaction); the screen autosaves at most every 30 seconds (Q11) |
| `preliminary` → `final` | `POST …/sign` (#79), `If-Match` | author with `notes:sign` | required template sections filled (Q1); **every AI section has an accept, edit or reject decision** (D70, FRS §3.4; the database also checks this); a `legal` attester and Provenance in the same transaction; `cosignStatus` = `pending` if a co-sign rule matches the author, else `not-required`; `note.signed` |
| `final`/`amended`, `cosignStatus pending` → `cosigned` | `POST …/cosign` `{ decision: "cosign" }` (#81), `If-Match` | supervising MD named by the rule, not the author | a second attester (`professional`) and Provenance; `note.cosigned` |
| `cosignStatus pending` → `returned` | `POST …/cosign` `{ decision: "return", comment }` (#81) | same | the note stays signed and frozen; the comment is stored (S2); `note.cosign-returned` → inbox task for the author |
| `returned` → `pending` | the author adds an addendum (#80) | author | the addendum answers the comment; the co-signer gets a new task |
| `final`/`amended` → `amended` | `POST …/addenda` `{ text }` (#80), `If-Match` on the original | MD, APP (RN: Q4) | a new Composition `relatesTo appends`, signed at once, with Provenance; `note.amended` |
| `preliminary` → `entered-in-error` | `POST …/entered-in-error` `{ reason }` (#83) | author | draft kept for audit, hidden from the chart |
| `final`/`amended` → `entered-in-error` | same | author, MD, APP | reason required; `note.entered-in-error`; billing notified if the encounter is closed |
| `final` → any edit | `PATCH` | — | always `409 record-locked` |

### 3.3 Diagnosis (`clinical.condition`, category `encounter-diagnosis`, linked by `encounter_diagnosis` with `rank` 1–12)

| Step | What happens |
|---|---|
| Add (#71) | a Condition plus its rank link, with Provenance, in one transaction; ICD-10-CM required (`system`, `code`), SNOMED optional |
| Remove before the encounter's first note is signed (#72) | `verificationStatus = entered-in-error`, `clinicalStatus` cleared (FHIR con-5), reason in Provenance (D24); the rank link is removed so the slot frees up (Q6); excluded from the chart, problem list, decision support, AI summaries, claims and patient views |
| After signing (#73) | only entered-in-error with a reason; the rank link stays, and the database refuses a charge pointing at it (D24; schema item S3) |

### 3.4 Vitals and history entries

| Record | Table | Edit model | Entered-in-error |
|---|---|---|---|
| Vitals (#68–70) | `observation`, category `vital-signs`; blood pressure as one observation with systolic and diastolic components | insert-only | `status = entered-in-error`, reason in Provenance; a correction is a new observation |
| Problem (#90–93) | `condition`, category `problem-list-item` | `PATCH` with `If-Match`: clinical status, onset, abatement, note | `verificationStatus = entered-in-error`, `clinicalStatus` cleared |
| Allergy (#94–97) | `allergy_intolerance` | same | same rule (FHIR ait-2) |
| Family history (#98–100) | `family_member_history` | insert-only | `status = entered-in-error` |
| Social history (#101–103) | `observation`, category `social-history`; smoking status as LOINC 72166-2 | insert-only | `status = entered-in-error` |
| Surgical history (#104–106) | `procedure`, category SNOMED 387713003 "Surgical procedure" (Q7) | insert-only | `status = entered-in-error` |

Every history entry carries its source (`entrySource`: `clinician`, `imported`, `patient-reported`, `ai-generated`, `device`, `interface`), author and date, as FRS FR-PAT-02 and FR-PAT-03 require. Partial dates use `PartialDate`.

## 4. How the decisions apply

| Decision | In this batch |
|---|---|
| **D69** vitals units as entered | `value` is `{ value (decimal string), unit, code }` with UCUM codes accepted as entered: `[lb_av]`, `[in_i]`, `[degF]` alongside `kg`, `cm`, `Cel`, `mm[Hg]`, `/min`, `%`. One allowed-units list per vital code; stored as entered (the schema's quantity `system` is not a foreign key); no conversion on save. Out-of-range values are flagged in the response (`interpretation`), never rejected (FR-ENC-03) |
| **D70** AI drafts, never auto-signed | The AI endpoints are batch 7. In this batch: note sections carry `entrySource` and `aiSuggestionId` (read-only), the note carries `aiAssisted`; sign returns `409 business-rule-violation` (code `ai-decision-missing` in `errors[]`) while any AI section is undecided; nothing in this batch creates a signed record from AI output. The section shape leaves room for D70's confidence band and source links |
| **D37** restricted charts | Every operation that returns or changes patient data goes through the chart-access check: `403 break-glass-required` unless the user has a grant or is on the care team; every access is audited. Lists that span patients (none in this batch) would leave restricted patients out |
| Signed records frozen (D8) | `409 record-locked` on any edit of a signed note; `If-Match` required on sign, co-sign and addenda; versions read through #82 (`_history`, read-only) |
| After-visit summary (FR-ENC-06) | `202` and an operation (kind `encounter.after-visit-summary`); built from the **signed** note version: diagnoses, medications (Thulasi's list), orders, patient instructions, follow-up; stored as a PDF through the file service and a DocumentReference (`ext_origin = generated`, linked to the Composition, A20); generating it again makes a new version. Portal release is P1 |
| Patient instructions (Minalini's item) | A note section with LOINC 69730-0 ("Instructions"), written and signed with the note; the after-visit summary prints it. No new column. The front desk's `appointment.patientInstruction` stays separate ("arrive 15 minutes early") |
| Favorites (FR-ENC-04) | `PUT /me/favorites` replaces the whole list with `If-Match`: kinds `note-template`, `diagnosis`, `order`, `order-set`, `prescription`, `phrase`, each with its target and order (`user_favorite`). Needs a version column (S1) |
| Templates (FR-ENC-04) | Note templates stay Anand's `/note-templates` (#183–186). Clinicians need to list them (Q2); personal templates use `note_template.owner_user_id` (Q3) |
| D14, D24 | No DELETE; removal and entered-in-error as in section 3 |
| D13 | Timeline and encounter lists filter by non-PHI parameters only (type, status, `dateFrom`, `dateTo`) |

## 5. Minalini's later-batch clinical items

| Item (ENDPOINT_INVENTORY "Later batches") | Becomes |
|---|---|
| Co-sign "return to author" with a comment | `decision: "return"` and `comment` on #81; `cosignStatus: returned`; new event `note.cosign-returned` (section 3.2; schema item S2) |
| Where patient instructions are stored | A note section (LOINC 69730-0), printed by the after-visit summary (section 4) |
| Timeline filters | `GET /patients/{patientId}/timeline?types=&dateFrom=&dateTo=&cursor=&limit=` (#46); `types` from: encounter, diagnosis, problem, allergy, vital, note, procedure, family-history, social-history, medication, result, document |
| Personal note templates | `note_template.owner_user_id` (already in the schema); the endpoint is Q3. The inventory row's `user_clinical_preference` is corrected (no such table) |
| Drug search confirmed as `GET /codes/search?system=rxnorm` | #74, `system` values `icd-10-cm`, `snomed-ct`, `loinc`, `rxnorm`, `cpt`, `hcpcs`, `cvx` (CPT placeholder codes until Q7) |
| Vitals in U.S. units (D69) | Section 4 |
| AI shapes (D70) | Batch 7; this batch only keeps the section markers |

## 6. Changes this plan needs outside the module files

| # | Change | Owner | Why |
|---|---|---|---|
| C1 | Inventory rows for the 3 single GETs (#249–251) and the counts; `user_clinical_preference` corrected | Vimal | `If-Match` needs an ETag, and list items carry none (API_STANDARDS §11) |
| C2 | EVENTS §4: `note.cosign-returned` (consumer: Anand's inbox) | Vimal; Anand agrees | return to author |
| C3 | DATA_OWNERSHIP §5.3: `cosignStatus` adds `returned`; the addendum form (a Composition `relatesTo appends`); autosave granularity settled; the "pending schema lock" markers in §2.1 for these rows | Vimal | locked schema |
| S1 | Version columns on `cosign_rule` and `user_favorite` (and `ai_feature_setting`, for batch 7), as A41 | Anand (migration) | `PATCH`/`PUT` with `If-Match` |
| S2 | Co-sign review storage: `cosign_status` on the note (or derived) plus an insert-only review row: decision, comment, reviewer, time | Anand (migration) | return to author |
| S3 | The D24 rule: the database refuses a charge or claim line pointing at an entered-in-error diagnosis (not found in the schema) | Anand (migration) | D24 |
| P1 | `note-templates:read` for MD, APP, RN, MA, ADM, CO on `GET /note-templates` and its single GET (Q2) | Thulasi (core), Anand (his rows) | clinicians must pick a template |
| P2 | RN `notes:sign` and `note-addenda:create` if Q4 says yes | Thulasi (core), Vimal (SECURITY_MODEL) | DATA_OWNERSHIP and core disagree |

S1–S3 go to Anand as one migration item (A46); P1–P2 go to Thulasi as T42.

## 7. Events

Already in EVENTS §4: `encounter.opened`, `encounter.status-changed`, `encounter.closed`, `encounter.entered-in-error`, `note.signed`, `note.cosigned`, `note.amended`, `note.entered-in-error`, `operation.completed`. New: `note.cosign-returned`. No events for vitals, diagnoses or history entries: nobody consumes them today, and the workspace re-reads after its own writes. They can be added later without a breaking change (CONTRACT_GOVERNANCE §4.1).

## 8. Open questions, each with a recommended answer

| # | Question | Recommended answer | Who decides |
|---|---|---|---|
| Q1 | Close and sign guards (DECISIONS Q22, still open with the clinical advisors) | Write the proposal into the contract as the default: close needs one signed note, no open drafts, and a diagnosis for billable types; sign needs the template's required sections. Each refusal has its own code in `errors[]`, so the rule can change without a contract change | You; the clinical advisors confirm later |
| Q2 | Clinicians cannot list note templates (`practice-setup:read` is ADM and CO only) | New permission `note-templates:read` (MD, APP, RN, MA, ADM, CO) on Anand's two template GETs, the D49 pattern; writes stay `practice-setup:*` | You, Anand, Thulasi |
| Q3 | Personal templates: how a clinician creates one | `POST /note-templates` with `personal: true` and a new permission `note-templates:create-personal` (MD, APP, RN); the server sets the owner; only the owner edits it (the contract already says so). Otherwise defer to P1 | You, Anand |
| Q4 | Do RNs sign nursing notes and write addenda? (DATA_OWNERSHIP says yes; SECURITY_MODEL and core say no) | Yes for nursing notes only: add `notes:sign` and `note-addenda:create` to RN, with the service limiting them to notes of type "nursing note" | You; clinical advisors (‡) |
| Q5 | Co-sign return: does the note stay signed? | Yes. A signed note is frozen; the author answers with an addendum, which sends it back to the co-signer. No unsigning | You |
| Q6 | Diagnosis removal before signing: keep or remove the rank link? | Remove the `encounter_diagnosis` link row (the API has no DELETE; the service removes a child row of an unsigned encounter) so ranks 1–12 stay contiguous; the Condition stays, entered-in-error, with Provenance | You, Anand |
| Q7 | How surgical history is told apart from in-office procedures | US Core Procedure `category` SNOMED 387713003 "Surgical procedure" on every surgical-history entry; in-office procedures (batch 5) use their own category | You |
| Q8 | `diagnoses:read` | Not needed: diagnoses come with the encounter (`encounters:read`) and the problem list (`problems:read`) | You |
| Q9 | Favorites audit: `–` in the inventory, but favorites are not on the `none` list | `GET` audited `none` (added to the SECURITY_MODEL §6 list: personal settings, no patient data); `PUT` audited `admin` | You, Thulasi |
| Q10 | Workspace `GET /encounters/{encounterId}`: what it returns | The encounter, its ranked diagnoses, its vitals and a summary of its notes (id, type, status, `cosignStatus`, author). History, medications and results come from their own endpoints, so each owner's data stays in one place | You, Minalini |
| Q11 | Autosave: every save is a version | Accept it (the schema writes one version per commit, and a legal trail is useful); the screen autosaves at most every 30 seconds and on leaving a field | You, Minalini |
| Q12 | BIL "signed notes only" (§4.3) | BIL's `notes:read` returns signed notes only (the service filters `preliminary`); written into SECURITY_MODEL §4.3 notes | You, Thulasi |
| Q13 | Vitals derived values (BMI) | The server does not compute BMI on save; the client may send it as its own observation; the screen may show a computed value | You, clinical advisors |
| Q14 | The locked schema is on `anand/schema-adoption`, not `main` | Write batch 2 against that branch (`807144c`); Anand opens the adoption PR before batch 2 merges | Anand |

## 9. Stage B (after approval)

Module by module, with the same rules as batch 1: shapes from this plan and the locked schema; synthetic (Synthea-style) examples only; full lint after each module (`npm test`), no rule switched off; the mock flow at the end; CI green; the PR opens as a draft.

1. `encounters.yaml`: encounters, vitals, diagnoses, code search. Lint.
2. `encounters.yaml`: notes, co-sign, addenda, versions, entered-in-error. Lint.
3. `encounters.yaml`: favorites, after-visit summary, co-sign rules. Lint.
4. `history.yaml`: timeline, problems, allergies, family, social and surgical history. Lint.
5. Docs: ENDPOINT_INVENTORY (C1), EVENTS (C2), DATA_OWNERSHIP (C3), SECURITY_MODEL (Q4, Q9, Q12 answers); notes A46 (Anand) and T42 (Thulasi); MOCK_GUIDE clinical flow.
6. Mock flow: open an unscheduled encounter → record vitals in lb/in/°F → add and remove a diagnosis → draft, autosave and sign a note → co-sign return → addendum → co-sign → after-visit summary → add an allergy and a problem → timeline. Then the breaking check (additions only), gitleaks, draft PR.
