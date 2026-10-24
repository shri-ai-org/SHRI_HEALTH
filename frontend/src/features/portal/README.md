# Patient portal (P1)

Owner: Minalini. Guide 04 Step 8, FRS 3.8. React rebuild of the earlier Shri patient portal (Angular 16), using the U.S. design system. **The screens and flows follow the old portal** (menus, pages, fields and steps); the look comes from the design system.

Run `npm run dev` in `frontend/` and open <http://localhost:5173/portal>. It runs on the mock API with synthetic data: any username and password sign in (`wrong-password` shows the failed sign-in). The mock lives in memory, so a full page reload signs you out.

## Colours

Each area has its own colour, as the old home cards did: green Test Results, plum Health Summary, amber Appointments, deep teal Messages, cyan Prescriptions, brown Billing, red Video Consult, olive Patient Education and indigo for your account pages. The colours live in `portal.css`, which maps each page to its area through `accent.ts`. They show on the gradient header, the page banner, the home cards, card headings and table headings. Every colour has at least 4.5:1 contrast with white text. The design system itself is unchanged.

## Old screens and where they are now

| Old portal | New path |
|---|---|
| Login, Forgot Username, Forgot Password, Registration (11 pages) | `/sign-in`, `/forgot-username`, `/forgot-password`, `/register` |
| Home: 8 cards + Alerts and Reminders | `/` |
| Test Results (list, detail) | `/test-results`, `/test-results/{id}` |
| Health Summary menu: Health Issues, Health Trends, Allergies, Immunization, Patient Documents, Reports, Document Template | `/health-issues`, `/health-trends`, `/allergies`, `/immunizations`, `/patient-documents`, `/reports`, `/document-templates` (each list has a detail page by ID) |
| My Appointments; Schedule; Upcoming Visit Details; Visit Summary | `/appointments`, `/appointments/schedule`, `/appointments/{id}` (+ `/reschedule`), `/visit-summaries/{id}` |
| Messages: Inbox, Sent, Trash, Compose | `/messages/inbox`, `/messages/sent`, `/messages/trash`, `/messages/compose` |
| Prescriptions; Prescription Refill Summary | `/prescriptions`, `/prescriptions/requests/{id}` |
| Pay Bills | `/billing` |
| Video Consult, Patient Education | `/video-consult`, `/patient-education` |
| Name menu: Demographics, E-Signature, Change Password, Log out | `/demographics`, `/e-signature`, `/change-password` |

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
  - Every password rule is shown to the user.
- **Not carried over:**
  - **SSN:** not collected (D43).
  - **Card number fields:** the card section is the processor's hosted form (Q17), so card numbers never touch our code.
  - **Rich-text message editor:** messages are plain text.
- **Video Consult:** lists real video visits with a Join button. The old page was an empty placeholder.

## Checks

- `portal.test.tsx` walks the main journeys (sign-in, menus, refill, schedule with the time picker, cancel, compose, trash and delete, payment, document template, the full 11-page registration) and runs axe (WCAG 2.1 A/AA) on every page.
- Checked by hand at 375px: no page scrolls sideways, and the phone menu is the old side panel.
- Still to do by hand: a screen-reader pass (VoiceOver, NVDA) and a session with a few real patients once there's a pilot practice (Q18).
