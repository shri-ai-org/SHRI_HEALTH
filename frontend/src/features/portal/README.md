# Patient portal (P1)

Owner: Minalini. Guide 04 Step 8, FRS 3.8. React rebuild of the earlier Shri patient portal (Angular 16), using the U.S. design system. **The screens and flows follow the old portal** (menus, pages, fields and steps); the look comes from the design system.

Run `npm run mock` in `contracts/`, then `npm run dev` in `frontend/`, and open <http://localhost:5173/portal>. Synthetic data only, and **only in development builds**: a production build has no portal until B8b exists (D88).

- **Batch B8a (D89, M20) goes through the generated client:** sign-in and session, "Set up your account", the profile and its change requests, appointments and booking, visit summaries, problems, allergies and vitals (`api/httpPortalApi.ts`). The dev proxy gives the sample-data server the portal cookie (MOCK_GUIDE §5d), so you are signed in as its one sample patient; signing out doesn't stick there, because the mock keeps no state.
- **Everything later stays on the in-memory mock** (`api/mockPortalApi.ts`): messages, results, prescriptions, documents, forms, reports and the signature, until B8b.
- **P1 features are hidden, not deleted** (`features.ts`): Pay bills, Video and Immunizations. Turn a switch on when its contract lands.

Sign-in and enrollment follow the portal decisions (D83–D88, ADR-0013): Keycloak's patient realm handles passwords, the authenticator app, reset and recovery, so the portal never asks for a password. "Sign in" goes to `GET /portal/auth/login`. New patients first use "Set up your account" with the front desk's invitation code, their date of birth and their email. Keycloak then emails them a link to set a password and an authenticator app, and only after that do they sign in. There is no self-registration. The front desk issues the code from the patient page's "Portal account" panel after an ID check.

Demographics edits are change requests (D91): only changed fields are sent, and the front desk applies them. The contract has no employer on the patient's side, so the old Employer section is gone. Visit summaries open through a short-lived download link; a problem or summary the clinician hasn't released shows "Held by your clinician" (D86, D90).

## Colours

Each area has its own colour, as the old home cards did: green Test Results, plum Health Summary, amber Appointments, deep teal Messages, cyan Prescriptions, brown Billing, red Video Consult, olive Patient Education and indigo for your account pages. The colours live in `portal.css`, which maps each page to its area through `accent.ts`. They show on the gradient header, the page banner, the home cards, card headings and table headings. Every colour has at least 4.5:1 contrast with white text. The design system itself is unchanged.

## Old screens and where they are now

| Old portal | New path |
|---|---|
| Login | `/sign-in`: a button that starts sign-in at the patient realm (D85) |
| Forgot Username, Forgot Password, Registration (11 pages) | Removed (D85): recovery belongs to the realm; enrolment is "Set up your account" (`/set-up-account`): invitation code, date of birth and email, then "Check your email", then sign-in (ADR-0013) |
| Home: 8 cards + Alerts and Reminders | `/` |
| Test Results (list, detail) | `/test-results`, `/test-results/{id}` |
| Health Summary menu: Health Issues, Health Trends, Allergies, Immunization, Patient Documents, Reports, Document Template | `/health-issues`, `/health-trends`, `/allergies`, `/immunizations`, `/patient-documents`, `/reports`, `/document-templates` (each list has a detail page by ID) |
| My Appointments; Schedule; Upcoming Visit Details; Visit Summary | `/appointments`, `/appointments/schedule`, `/appointments/{id}` (+ `/reschedule`), `/visit-summaries/{id}` |
| Messages: Inbox, Sent, Trash, Compose | `/messages/inbox`, `/messages/sent`, `/messages/trash`, `/messages/compose` |
| Prescriptions; Prescription Refill Summary | `/prescriptions`, `/prescriptions/requests/{id}` |
| Pay Bills | `/billing` |
| Video Consult, Patient Education | `/video-consult`, `/patient-education` |
| Name menu: Demographics, E-Signature, Change Password, Log out | `/demographics`, `/e-signature`; "Password and security" opens the realm's account page; Log out |

## Same flow, with these fixes

- **Fixed old bugs:**
  - Refill requests are actually sent, and the summary shows every chosen prescription and the chosen pharmacy.
  - Deleting messages from Trash asks first.
  - Delete Document asks first.
  - Add Insurance and Add Pharmacy add the entry.
  - The signature lands on the document.
  - Errors are shown instead of being swallowed.
  - Detail pages load by ID, so refresh and links work, and no health data goes in the URL.
- **Labels:**
  - The desktop menu has text, not icons only.
  - "Select a specialty" was really the clinic location, so it's now labelled that way.
  - "Reminder preferences" offers text, email or phone; the old list showed appointment statuses.
- **Rules:**
  - U.S. phone and ZIP rules (the old phone rule expected an Indian number).
  - Single-answer social-history questions are radio buttons.
- **Not carried over:**
  - **SSN:** not collected (D43).
  - **Passwords, recovery and self-registration:** the patient realm and the invitation code replace them (D85).
  - **Card number fields:** the card section is the processor's hosted form (Q17), so card numbers never touch our code.
  - **Rich-text message editor:** messages are plain text.
- **Video Consult:** lists real video visits with a Join button. The old page was an empty placeholder.

## Checks

- `portal.test.tsx` walks the main journeys and runs axe (WCAG 2.1 A/AA) on every page. B8a journeys run against `test/fakePortalServer.ts`, a fake `/api/v1/portal` shaped as the contract, through the real fetch wrapper; the later ones run on the mock.
  - B8a: sign-in, the session read and its CSRF token, a 401 ending the session, alerts, the hidden P1 pages, held problems and summaries, vitals grouping, booking with one key per chosen time, a taken time re-reading the free times, cancel with a reason, change requests and enrollment.
  - Later batches: refill, compose, trash and delete, document template.
- Checked by hand at 375px: no page scrolls sideways, and the phone menu is the old side panel.
- Still to do by hand: a screen-reader pass (VoiceOver, NVDA) and a session with a few real patients once there's a pilot practice (Q18).
