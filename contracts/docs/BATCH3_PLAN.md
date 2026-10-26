# Contract batch 3: inbox, tasks and messages (Stage A plan)

**Status:** APPROVED (Vimal, 2026-10-26): Q1–Q13 decided as recommended, with four additions in §11 (DECISIONS D77–D81). Written in Stage B.
**Branch:** `vimal/contracts-batch3` (from `main` @ `52d4a6f`).

**Inventory name:** the inventory's B3 also holds scheduling, check-in, eligibility, payments, documents and fax, and communications. Most of those were written in batch 1. This batch is the **inbox part of B3**: rows #214–217 and the new rows below. The fax and document endpoints (#204–211) and message templates (#220–222, #248) stay with their own modules.

**Schema:** the locked schema (D72) as adopted in #45 (`anand/schema-adoption` @ `29cdbe7`, not on `main` yet): `admin.work_item` and `admin.work_item_event`.

**Sources:**
- ENDPOINT_INVENTORY #214–217 and "Later batches";
- SECURITY_MODEL §4.3 (`inbox:*`, `messages:create`), §5.1 (facility scope), §5.2 (restricted charts), §6 (audit);
- DATA_OWNERSHIP §2.3 (inbox row), §5.2–§5.4 (where items come from);
- EVENTS §4;
- FRS v1.2 FR-ENC-05 (and FR-ORD-02 for the 60-second result rule);
- DECISIONS D13, D14, D37, D38 (inbox message threads are an approved P0 item), D67, D71, D72, D73;
- NOTE_FOR_ANAND A36 (break-glass notice for CO);
- API_STANDARDS §6.5 (extensible enums), §11 (ETag), §12 (facility scope).

## 1. Module and owner

| Module file | Rows | x-owner | Folder that implements it |
|---|---|---|---|
| `inbox.yaml` | #214–217, plus new #252–255 | anand | `backend/app/modules/inbox/` |

- **On every operation:** `x-release: P0`; `x-storage: admin`; session cookie, with CSRF on writes; the standard error responses; no DELETE (D14); no PHI in URLs (D13; filters take opaque IDs only).
- **Approvals:** Anand approves the contract as x-owner; I approve standards conformance (D17).

## 2. Operations

Legend:
- **Audit** is `action/category`. `patient` is `result` for lists (the patient IDs returned are recorded), otherwise `body:/patientId` or the item's patient.
- **Idem:** `S` = `Idempotency-Key` supported. Nothing here reaches a partner.
- **IfM:** `req` = `If-Match` required (ADR-0008).

| # | Method and path | operationId | Permission | Audit | Idem | IfM | Events | FRS |
|---|---|---|---|---|---|---|---|---|
| 214 | `GET /inbox` | listInboxItems | `inbox:read` | R/phi-read, result | | | | FR-ENC-05 |
| **252** | `GET /inbox/{inboxItemId}` | getInboxItem | `inbox:read` | R/phi-read, the item's patient | | | | FR-ENC-05 |
| 215 | `PATCH /inbox/{inboxItemId}` | updateInboxItem | `inbox:update` | U/phi-write, the item's patient | | req | `inbox.item-assigned` (when the assignee changes) | FR-ENC-05 |
| 216 | `POST /inbox/{inboxItemId}/complete` | completeInboxItem | `inbox:complete` | E/phi-write, the item's patient | | opt | `inbox.item-completed` | FR-ENC-05 |
| **253** | `POST /inbox/{inboxItemId}/cancel` | cancelInboxItem | `inbox:update` | E/phi-write, the item's patient | | opt | `inbox.item-completed` (`status: cancelled`) | FR-ENC-05 |
| **254** | `POST /inbox/{inboxItemId}/replies` | replyToInboxItem | `messages:create` | C/phi-write, the item's patient | S | | `inbox.item-assigned` (back to the other party) | FR-ENC-05, D38 |
| 217 | `POST /messages` | createMessage | `messages:create` | C/phi-write, `body:/patientId` (optional) | S | | `inbox.item-assigned` | FR-ENC-05, D67 |
| **255** | `GET /inbox/summary` | getInboxSummary | `inbox:read` | R/none (counts only, no patient data) | | | | FR-ENC-05 |

**Why the new rows:**
- **#252:** `PATCH` needs an ETag, and list items carry none (API_STANDARDS §11; the same reason as #248). It also returns the item's thread.
- **#253:** a message or task sent by mistake is closed with a reason; nothing is deleted (D14).
- **#254:** replies make a thread (D38: "inbox holds message threads, not only tasks").
- **#255:** the badge counts, without loading the list.

## 3. The inbox item

**Shape:**
- `id`, `itemType`, `status`;
- `priority` (`routine`, `urgent`, `asap`, `stat`);
- `title` (system titles name the kind of work, such as "Result to review", and never a patient; a sender's free-text title may contain anything, so it is `x-phi: clinical`);
- `body` (messages and tasks only; `x-phi: clinical`);
- `assignee` (`{ type: user | role, id, display }`);
- `facilityId`;
- `dueAt`;
- `escalationLevel` and `escalatedAt` (read-only);
- `patient`: a `PatientSummary`, absent when the user may not see it (§5);
- `subject`: the linked record (`{ type, id }`, at most one: result, note, document, prescription, order, appointment, unmatched result, claim or fax);
- `encounterId`;
- `createdBy`, `createdAt`, `updatedAt`, `completedAt`, `completedBy`;
- in the single GET only, `thread`: the item's events (`created`, `assigned`, `status-change`, `comment`, `escalated`) with who, when and the comment text.

**Item types** (an extensible enum, API_STANDARDS §6.5): the schema's values, plus three new ones (S2):

| `itemType` | Created by | Completed by | Default assignee | Batch of the source |
|---|---|---|---|---|
| `message` | `POST /messages` | `complete`, or `cancel` by the sender | the chosen user or role | B3 (this batch) |
| `task` | `POST /messages` (`kind: task`); D67 appointment-change requests | `complete`; `cancel` by the creator | the chosen user or role; for D67, the FD role at the appointment's facility | B3 |
| `cosign` | `note.signed` with `cosignStatus: pending` | `note.cosigned` (system) | the co-signer | B4 (written) |
| **`cosign-returned`** (new) | `note.cosign-returned` | the author's addendum (system), which creates a new `cosign` item | the note's author | B4 (written) |
| `unsigned-note` | appointment checked out while a draft note exists (Q8) | `note.signed` (system) | the note's author | B4 |
| `fax-indexing` | `fax.received` | `POST /fax-inbox/{faxId}/file` (#211, system) | the FD role at the receiving facility (never BIL, D71) | B3 documents |
| `document-review` | a filed clinical document routed to a clinician at filing (Q9) | `complete` | the chosen clinician | B3 documents |
| `result-review` | `result.received`, within 60 s (FR-ORD-02); a corrected result reopens it with `corrected: true` | `POST /results/{resultId}/acknowledge` (#144, system) | the ordering clinician | **B5** (Thulasi) |
| `refill-request` | `refill-request.received` | `POST /refill-requests/{id}/respond` (#129, system) | the prescriber | **B5** |
| **`prescription-failure`** (new) | `prescription.transmission-updated` with `rejected` or `error`, or a denied cancel | `complete`, once handled | the prescriber | **B5** |
| `unmatched-result` | `unmatched-result.received` | `POST /unmatched-results/{id}/match` or `/reject` (system) | the role that matches results | **B5** |
| **`break-glass-review`** (new, A36) | `break-glass.granted` | `complete` by CO | the CO role | platform (written) |
| `eligibility`, `claim-rejection`, `rooming` | (in the schema; their sources are B3 eligibility, B6 billing and scheduling) | `complete` | FD, BIL, MA roles | later |

**Batch 3 writes the item and every type.** Each source batch only publishes its event; the inbox service creates and completes the items. So B5 adds no inbox endpoints.

## 4. Lifecycle (DATA_OWNERSHIP §5.x, new)

The schema statuses are `open`, `in-progress`, `on-hold`, `completed` and `cancelled`. Assignment is a separate field, so "new", "assigned" and "reassigned" describe the assignee, not the status.

| Your word | How it is shown |
|---|---|
| **new** | `status: open`, assigned to a **role** (a shared queue), not yet taken |
| **assigned** | `status: open`, assigned to a **user** (taken from the queue, or sent to them) |
| **in progress** | `status: in-progress` |
| **reassigned** | not a state: an `assigned` event in the thread, plus `inbox.item-assigned` to the new assignee |
| **done** | `status: completed`, `completedAt`, `completedBy` |
| (on hold, cancelled) | `on-hold` (waiting on someone else); `cancelled` (a message or task closed with a reason) |

| Transition | Operation | Who | Rule |
|---|---|---|---|
| (none) → `open` | `POST /messages`, or the service on an event | sender, or system | One assignee: a user **or** a role (`ck_work_item_one_assignee`); a facility is required |
| take from a queue | `PATCH { assignee: me }` | a user holding the role, at the item's facility | `If-Match`; refused (`409`) if someone else took it first |
| reassign | `PATCH { assignee }` | the assignee; ADM for items at their facilities (Q5) | The new assignee must be able to see the item (§5); otherwise `422` |
| `open` ↔ `in-progress` ↔ `on-hold` | `PATCH { status }` | the assignee | Only these three statuses are allowed in PATCH |
| priority, due date | `PATCH { priority, dueAt }` | the assignee or the creator | `dueAt` is a time in UTC, shown in facility time (D40) |
| → `completed` | `POST …/complete { comment? }` | the assignee | For types that the system completes, `409 business-rule-violation`, code `completed-by-action`, naming the action (Q4) |
| → `cancelled` | `POST …/cancel { reason }` | the creator of a message or task | System items are never cancelled by users |
| escalation | none (system job) | system | Past `dueAt`, or past the co-sign rule's `cosignWithinDays`: `escalationLevel + 1`, priority raised one step, `inbox.item-assigned` to the assignee and, at level 2, to the facility's ADM role (Q6) |
| reply | `POST …/replies { text, assignBack? }` | anyone who can see the item | Adds a `comment` event. `assignBack` (default `true`) reassigns to the other party, so the thread moves between sender and recipient |

## 5. Who sees which items (D37, SECURITY_MODEL §5)

An item is visible to a user only when **all** of these hold:

1. **Clinic and facility:** the item's organization (RLS), and a facility the user is assigned to. A list without `facilityId` is still limited to the user's facilities (§5.1).
2. **Assignee or sender:** the item is assigned to the user, or to a role the user holds; or the user created it (the `sent` view, read-only apart from replies and cancel). ADM can also see items assigned to users at their facilities, to reassign them (Q5).
3. **Item type within the user's permissions.** The type's own read permission is required, so the inbox never shows more than the user's other screens:
   - `result-review` and `unmatched-result`: `results:read` / `unmatched-results:read`;
   - `refill-request` and `prescription-failure`: `refill-requests:read` / `prescriptions:read`;
   - `cosign`, `cosign-returned` and `unsigned-note`: `notes:read`;
   - `fax-indexing`: `fax-inbox:read` (so never BIL, D71);
   - `document-review`: `documents:read`;
   - `claim-rejection`: `claims:read`;
   - `eligibility`: `eligibility-checks:read`;
   - `break-glass-review`: `audit-events:read` (CO);
   - `message` and `task`: `inbox:read` only.
4. **Chart access, for items with a patient.** For a restricted patient, the item is listed without `patient` and with `restricted: true`, unless the user holds a current break-glass grant or is on the care team (§5.2, D37). Opening the linked record still needs the grant.

Also:
- `GET /inbox` is audited `phi-read` with the patient IDs it returns, and items about restricted patients without access record no patient.
- Sending: `POST /messages` with a `patientId` requires the sender to have chart access to that patient (`403 break-glass-required` otherwise). The recipient's view is still filtered by rule 4.

## 5a. Filters and order (`GET /inbox`)

**Query parameters** (no PHI; D13):
- `view` (`assigned` (default: mine and my roles), `mine`, `queue` (my roles only), `sent`, `facility` (ADM));
- `itemType` (repeatable), `status` (default `open,in-progress,on-hold`), `priority`;
- `patientId`, `facilityId`, `dueBefore`;
- `cursor`, `limit`.

**Order:** priority (`stat` first), then overdue, then `dueAt`, then `createdAt`.

## 6. What lands in the inbox, and from where

| Source | Inbox item | Status in this batch |
|---|---|---|
| New and corrected results | `result-review` for the ordering clinician within 60 s; a corrected result reopens the item, marked `corrected: true`; critical results escalate at once | Type and rules written now; the source is **B5** (Thulasi, #142–144) |
| Refill and change requests | `refill-request` for the prescriber | Type written now; the source is **B5** (#128–129) |
| Clinician tasks instead of editing appointments (D67) | `POST /messages { kind: task, subject: { type: appointment, id }, assignee: { type: role, id: FD } }`; the FD role at the appointment's facility gets it and completes it after rescheduling | **Written in this batch**; the example is in the mock flow |
| Co-sign requests and "return to author" | `cosign` for the co-signer (escalates after `cosignWithinDays`); `cosign-returned` for the author with the co-signer's comment; the author's addendum completes it and creates a new `cosign` | The events exist (batch 2); the item types are written now |
| Incoming faxes for filing (D71) | `fax-indexing` for the FD role at the receiving facility; filing completes it; filing a clinical document may route a `document-review` to a clinician (Q9) | Types written now; the fax endpoints are Anand's documents module |
| Staff messages | `message`, with replies as a thread (D38) | **Written in this batch** |
| Break-glass notice (A36, T16) | `break-glass-review` for CO, never an email with PHI | Type written now; the event exists |

## 7. Minalini's later-batch item (ENDPOINT_INVENTORY "Later batches")

"Inbox task creation (`POST /messages`, #217) with assignee, due date and link to a record; clinicians request appointment changes this way (D67)."

`POST /messages` takes:
- `kind` (`message` | `task`);
- `assignee` (user or role, required);
- `facilityId` (required; it must be one of the sender's facilities and, for a user, one of the recipient's);
- `title` (≤ 200), `body` (≤ 4,000);
- `priority` (default `routine`);
- `dueAt` (tasks only; optional);
- `patientId` (optional);
- `subject` (optional, `{ type, id }`, with at most one linked record; a linked record's patient must equal `patientId`).

It returns `201` with the item and its `ETag`.

## 8. Changes this plan needs outside `inbox.yaml`

| # | Change | Owner | Why |
|---|---|---|---|
| S1 | `version` column on `work_item` (as A41) | Anand (migration) | `PATCH` with `If-Match` |
| S2 | New `item_type` values: `cosign-returned`, `prescription-failure`, `break-glass-review` (A36 was agreed but is not in the schema's check list) | Anand (migration) | §3 |
| S3 | `work_item` reason for cancellation (or a `cancelled` event comment, which the schema already allows) | Anand: confirm using `work_item_event.comment` | `cancel` |
| S4 | A `corrected` flag (or a re-open event) for result items | Anand, with Thulasi (B5) | corrected results |
| P1 | CO gets `inbox:read`, `inbox:update` and `inbox:complete` (§4.3 has `–` for CO today, but A36 sends CO the break-glass notice) | Thulasi (core), Vimal (SECURITY_MODEL) | §3 |
| C1 | ENDPOINT_INVENTORY: new rows #252–255; #214–217 with their final shapes | Vimal | §2 |
| C2 | EVENTS §4: `inbox.item-completed` (new); `inbox.item-assigned` also covers role assignees (sent to the role's users at the facility) | Vimal; Thulasi agrees (stream filtering) | §2 |
| C3 | DATA_OWNERSHIP: the inbox row names `work_item`, `work_item_event`; new §5.x lifecycle | Vimal | §4 |
| C4 | D38 inbox threads: answered by replies on `work_item_event` (no new table) | Anand confirms | D38 |

## 9. Open questions, each with a recommended answer

| # | Question | Recommended answer | Who decides |
|---|---|---|---|
| Q1 | Messages and tasks: one endpoint or two? | One: `POST /messages` with `kind` (the inventory path stays). A task is a message with an optional due date, created through the same endpoint | You, Anand |
| Q2 | Several recipients | One assignee per item (the schema allows one). To reach several people, send to a role; to copy someone, send a second message | You, Anand |
| Q3 | Priority values | `routine`, `urgent`, `asap`, `stat` (FHIR request priority), stored as 4, 3, 2, 1 in `priority SMALLINT 1–5`. 5 is unused | You, Anand |
| Q4 | Can a user complete a system item by hand (for example a result to review)? | No: `409`, code `completed-by-action`, naming the action (acknowledge, sign, co-sign, file, respond). Only `message`, `task`, `document-review`, `prescription-failure` and the later types are completed by hand. This keeps "done" meaning the work was done | You, clinical advisors (‡) |
| Q5 | Covering for an absent colleague | ADM sees items assigned to users at their facilities (`view=facility`) and can reassign them. Items with patients still follow chart access (§5 rule 4). Team-lead views are P1 | You, Thulasi |
| Q6 | Escalation | A system job: when past `dueAt`, or past the co-sign rule's days, raise `escalationLevel` and priority one step, notify the assignee, and at level 2 the facility's ADM role. Critical results escalate at once (B5, FR-ORD-02). No manual "escalate" action; raising the priority by `PATCH` covers it | You, clinical advisors (‡) |
| Q7 | Restricted patients in the inbox | Items are listed without patient details and with `restricted: true` unless the user has a grant or is on the care team. The assignee of a result for a restricted patient is normally its ordering clinician, who is on the care team | You, Thulasi |
| Q8 | When does an "unsigned note" item appear? | When the appointment is checked out and a draft note by that author still exists. `note.signed` completes it | You, Minalini |
| Q9 | Incoming documents: does every filed fax go to a clinician? | No: filing (#211) takes an optional `routeTo` (a clinician), which creates a `document-review`. Unrouted documents are only filed. That field is Anand's #211 change, in the documents module | You, Anand |
| Q10 | Badge counts | `GET /inbox/summary`: counts by type and status for the user's `assigned` view, no patient data, audit `none` (added to SECURITY_MODEL §6) | You, Minalini |
| Q11 | Read / unread | Not in the MVP (the schema has no field, and FRS FR-ENC-05 does not ask for it); P1 | You, Minalini |
| Q12 | Message body PHI | `body`, replies **and the free-text title** are `x-phi: clinical` (addition 4); system titles never name a patient, and the screen shows the patient from `patient`. Replies are insert-only | You |
| Q13 | The locked schema is in #45, not on `main` | Write batch 3 against #45's head (29cdbe7), as batch 2 did; S1–S2 join Anand's migration follow-ups | Anand |

## 10. Stage B (after approval)

Same rules as before: shapes from this plan and the locked schema; synthetic examples only; full lint (`npm test`) after each step, no rule switched off; the mock flow at the end; CI green; the PR opens ready for review with all three.

1. `inbox.yaml`: the item, thread and summary schemas; #214, #252, #255. Lint.
2. `inbox.yaml`: #215, #216, #253, #254, #217. Lint.
3. Docs: C1–C4; SECURITY_MODEL (P1 row, Q10 audit `none`, §5 inbox rule); NOTE_FOR_ANAND (S1–S4); NOTE_FOR_THULASI (P1, C2); MOCK_GUIDE inbox flow.
4. Mock flow:
   - an MA sends a D67 task about an appointment to the FD role;
   - FD takes it, then completes it;
   - an MD sends a message about a patient to an RN, the RN replies, and the MD completes it;
   - a `cosign` item and its `complete` refused with `completed-by-action`;
   - the summary counts.

   Then the breaking check (additions only), gitleaks, and the PR.

## 10a. Tightened after the security review (2026-10-26, on PR #58)

- **Replies:** `assignBack` hands an item back only for messages and tasks, and only when the replier is the assignee (or holds its role) or the sender, checked inside the transaction. The new assignee must pass the same checks as for `PATCH`. A reply by anyone else never moves the item.
- **Restricted charts (D37):** an item the user may not open leaves out `patient`, `body`, `encounterId`, `corrected` and every reply's text. A message or task title becomes "Item about a restricted chart". `subject` stays, but opening it needs a grant (D80).
- **`patientId` filter:** for a restricted chart the user may not open, `GET /inbox?patientId=` returns `403 break-glass-required`, audited with the patient ID, so the filter cannot be used to probe charts.

## 11. Additions on approval (Vimal, 2026-10-26; DECISIONS D77–D81)

1. **Critical results have their own escalation path (D78).** If the ordering clinician does not acknowledge a critical result within a short per-practice time, the item escalates to the **covering clinician**, then to a **practice lead**. Every step is in the item's thread (`escalated` events) and in the audit trail. Q6's overdue job covers normal items only. The timings are per-practice settings; their values are confirmed later by the clinical advisors. The source (`result.received` with `critical: true`) is B5; the item fields (`escalationLevel`, `escalatedAt`, the thread) are written now. Anand's migration adds the settings, who covers whom, and the practice lead (A48).
2. **Clinicians away (D79).** The MVP has admin reassignment (Q5) plus overdue escalation (Q6). A self-service out-of-office forward is **P1**, recorded in ENDPOINT_INVENTORY "Later batches" so nobody assumes it exists.
3. **Linked records (D80).** The sender of a message or task must have access to the linked record (`subject`) and its patient, or the request is refused (`403`). A recipient without access sees the link (`subject` type and ID) but cannot open it: the linked record's own endpoint applies its own permission and the restricted-chart rules (D37), as for any read.
4. **Notifications outside the app (D81)** (email, SMS, push) never contain patient data, titles or bodies; only "You have a new item in Shri Health". Free-text `title` and `body` are `x-phi: clinical`.

