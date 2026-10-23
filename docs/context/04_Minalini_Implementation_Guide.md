# Minalini — Implementation Guide

**Your role:** owner of the user interface and design system. You also own two light backend modules: communications and the operations dashboard API. Most screens already exist, so your main job is to bring them into one design system, connect them to the real APIs, and fill the gaps.
Read `00_Team_Workflow_and_Claude_Code_Setup.md` first.

## 1. What you own

| Area | Folders |
|---|---|
| Design system and app shell | `frontend/src/design-system/`, `frontend/src/app/` |
| Patient, scheduling, clinician workspace, medications, orders, inbox and portal screens | `frontend/src/features/patients/`, `scheduling/`, `clinical/`, `medications/`, `orders/`, `inbox/`, `portal/` |
| Communications APIs | `backend/app/modules/communications/` |
| Operations dashboard API | `backend/app/modules/dashboards/` |
| Design review of the AI screens (Vimal) and admin, billing and document screens (Anand) | Review only |

## 2. Day 1

1. **Inventory the existing screens** for each portal (clinician, front desk, admin, patient). For each screen, note:
   - whether it matches FRS v1.2;
   - fields that are missing;
   - which API endpoints it needs.

   Send gaps in endpoints to Vimal so they go into the contract.
2. **Set up the frontend** in the shared repository: React + TypeScript + Vite, with eslint, type checks and vitest running in CI.
3. **Generate the API client** from `contracts/openapi/shri-health.yaml`:
   - use orval with React Query hooks, or openapi-typescript with a small fetch wrapper;
   - point it at Vimal's mock server for now;
   - output goes to `frontend/src/api/generated/`, which nobody edits by hand.
4. **Build the login screen shell:** a "Sign in" button that sends the browser to `/auth/login`.

## 3. Build steps, in order

### Step 1 — Design system

Pull the styles of the existing screens into one shared set.

**Tokens:**
- colours;
- type sizes;
- spacing;
- corner radius.

**Components:**
- Button, Input, Select, Date picker;
- Table with paging, Modal, Toast, Tabs, Badge;
- Alert, with info, warning and critical levels, because the medication safety alerts need clear severity.

Accessibility from the start: full keyboard use, visible focus, readable contrast. Publish a short usage note so Vimal and Anand build their screens the same way.

**Done when:** the existing screens use the shared components, and the AI, admin, billing and document screens can be built from them.

### Step 2 — App shell and the browser side of login

- **Routing:** separate areas for clinician, front desk and admin (patient portal comes in P1).
- **Menus by role:** call `GET /me` after login and show only what the user's role allows. The server still checks every action; hiding a menu is only for clarity.
- **Session handling:**
  - a 401 response sends the user to sign in again;
  - an idle-timeout warning appears before automatic logout;
  - logout calls `/auth/logout`.
- **CSRF:** every request that changes data sends the custom header Thulasi defines.
- **No tokens in the browser:** never store tokens in localStorage or sessionStorage. The session is a secure cookie handled by the server.

### Step 3 — Connect screens to the real APIs

Switch each area from the mock to the real API as it becomes available, in this order:

1. **Patient search and registration,** including licence scanning:
   - read the PDF417 barcode on the back of a U.S. driver's licence with a camera library (for example ZXing), or a 2D scanner that types into a field;
   - parse it in the browser and fill the form;
   - card photos go through the file service.
2. **Scheduling, check-in and status board.** The status board listens for live updates (Step 4).
3. **Clinician workspace:** encounter, notes, templates, vitals, diagnoses.
   - Notes autosave and send the `If-Match` version. If the server replies "conflict", show the newer version instead of overwriting it.
   - Signed notes are read-only; changes go through "Add addendum".
4. **Medications and prescriptions:**
   - alerts appear by severity;
   - overriding a high-severity alert asks for a reason;
   - no alert blocks the doctor from continuing.
5. **Orders and results:**
   - order entry with the lab's extra questions;
   - the ABN prompt when needed;
   - results with abnormal and critical flags;
   - "Acknowledge";
   - an unmatched-results screen for staff.
6. **Inbox,** with live updates.

Every screen handles loading, empty and error states, and shows the error message from the server's standard error format.

### Step 4 — Live updates

Open one `EventSource` to `/events/stream` after login. When an event arrives (for example `result.received` or `appointment.status_changed`), refresh the affected data through the generated client. Events carry IDs only, so the screen fetches details through the normal API.

### Step 5 — Communications APIs (backend)

Endpoints:
- reminder message templates (create, list, edit);
- patient communication preferences and opt-outs;
- communication history with delivery status.

Build them in `backend/app/modules/communications/` with the same pattern as everyone else (see `CLAUDE.md`):
- `api.py` for routes;
- `service.py` for rules;
- `repository.py` for database access;
- `schemas.py` for the request and response models.

Use Thulasi's `require()` and `tenant_db`, and Anand's existing tables (`message_template`, `communication_preference`, `outbound_communication`). The actual sending of SMS and email is done by Thulasi's integration engine; your API only manages templates, preferences and history.

**Done when:** endpoints match the contract, and tests cover success, permission denied and validation errors.

### Step 6 — Operations dashboard API (backend)

`GET /dashboards/operations` returns counts only:
- today's appointments by status;
- unsigned notes;
- pending results;
- open inbox items.

These are plain read-only queries over our one PostgreSQL database (clinical and admin tables alike; ADR-0011), run through your module's repository, scoped by `tenant_db` like every other query. No HAPI helper is needed. Connect it to the dashboard screen.

### Step 7 — Design reviews

Review Vimal's AI screens and Anand's admin, billing and document screens before they merge. Check that they use the shared components, keyboard access and consistent wording. CODEOWNERS adds you as a reviewer on those folders automatically.

### Step 8 — P1, for the conference: patient portal

- Appointments.
- Intake forms.
- Released results.
- Secure messages.
- Online check-in and payment.
- Joining a telehealth video call.

## 4. Handoffs

| You need | From | For |
|---|---|---|
| Contracts and mock server | Vimal | All screens, from Day 1 |
| Login endpoints, CSRF header name, `/events/stream` | Thulasi | Steps 2 and 4 |
| File service | Anand | Card photos, documents |
| `require()`, `tenant_db` | Thulasi | Your two backend modules |
| Communications tables; table names for the dashboard counts (after the schema lock) | Anand | Steps 5 and 6 |

| You give | To |
|---|---|
| Design system and usage note | Vimal, Anand |
| Screen inventory and missing endpoints | Vimal |
| Design reviews | Vimal, Anand |

## 5. Your Claude Code settings

Save as `.claude/settings.local.json`, start `claude` from the repo root, run `/permissions` to check:

```json
{
  "permissions": {
    "deny": [
      "Edit(contracts/**)",
      "Edit(backend/app/core/**)", "Edit(backend/app/integration/**)",
      "Edit(backend/app/db/**)", "Edit(backend/app/fhir/**)",
      "Edit(backend/app/modules/patients/**)", "Edit(backend/app/modules/scheduling/**)",
      "Edit(backend/app/modules/eligibility/**)", "Edit(backend/app/modules/encounters/**)",
      "Edit(backend/app/modules/history/**)", "Edit(backend/app/modules/ai/**)",
      "Edit(backend/app/modules/medications/**)", "Edit(backend/app/modules/orders/**)",
      "Edit(backend/app/modules/practice_setup/**)", "Edit(backend/app/modules/billing/**)",
      "Edit(backend/app/modules/documents/**)", "Edit(backend/app/modules/files/**)",
      "Edit(backend/app/modules/ccda/**)", "Edit(backend/app/modules/inbox/**)",
      "Edit(backend/app/modules/exports/**)", "Edit(backend/app/modules/onboarding/**)",
      "Edit(ai/**)", "Edit(infra/**)", "Edit(.github/**)",
      "Edit(frontend/src/features/ai/**)",
      "Edit(frontend/src/features/admin-setup/**)",
      "Edit(frontend/src/features/billing/**)",
      "Edit(frontend/src/features/documents/**)"
    ]
  }
}
```

The last four lines stop your Claude from editing Vimal's and Anand's screens; you review those through pull requests instead.

A good prompt pattern:

> Connect the patient registration screen in frontend/src/features/patients to the generated client in frontend/src/api/generated, replacing the hard-coded data. Use the design-system components, handle loading, empty and error states, and add vitest tests. Do not edit files outside frontend/src/features/patients.
