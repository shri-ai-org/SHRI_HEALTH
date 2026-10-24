# Shri Health design system, U.S. ambulatory edition

Owner: Minalini. For everyone building screens (Vimal: AI screens; Anand: admin, billing and document
screens). Adapted from the Indian portals' design system: same calm palette, type scale and component
recipes, with U.S. formats, wording and the safety components the API contract needs.

Import from `src/design-system` only:

```ts
import { Button, Field, DateInput, formatMoney, ProblemAlert } from '../design-system'
```

Run the preview page with `npm run dev` in `frontend/` (Node 24; `nvm use`). It shows every
component with synthetic data, in light and dark mode.

## Rules

1. **Tokens only.** Colours come from `src/index.css` (`bg-surface-1`, `text-ink-muted`,
   `bg-critical-bg text-critical-fg`…). ESLint rejects raw hex in components. Dark mode and high
   contrast then work for free.
2. **Colour is never the only signal.** Alerts start with a word (Critical, Warning, Note); badges
   have text.
3. **44px targets.** Every button and input is at least 44px tall.
4. **One primary button per view.** Destructive actions use `ConfirmDialog`.
5. **Every state designed:** loading (`Spinner`), empty (`EmptyState`), error (`ErrorState` with the
   request reference), success (`useToast`).
6. **Errors by code, never by text.** Use `problemCopy(problem)` or `ProblemAlert`; never show
   `problem.detail` or `problem.title` to users.
7. **No patient data in URLs** (D13): routes carry the patient UUID only.

## U.S. formats

The API sends contract formats; screens show U.S. formats. Always convert with these helpers.

| Data | API (contract) | Screen | Helper |
|---|---|---|---|
| Calendar date (birth date) | `1984-07-19` | `07/19/1984` | `formatDate`, `parseUsDate`, `DateInput` |
| Instant (appointment time) | `2026-11-03T14:30:00Z` (UTC) | `8:30 AM CST`, in the **facility's** time zone from `timeZone` | `formatTime`, `formatDateTime`, `todayIn` |
| Age | never sent | derived on screen | `ageInYears` |
| Money | `{ value: "1234.50", currency: "USD" }` | `$1,234.50` (string maths, no floats) | `formatMoney`, `parseMoneyInput` |
| Phone | `+16175550123` (E.164) | `(617) 555-0123` | `formatPhone`, `parseUsPhone`, `PhoneInput` |
| State | `IL` (USPS) | `Illinois (IL)` in pickers | `US_STATES`, `StateSelect` |
| ZIP | `62701` or `62701-1234` | same | `isValidZip`, `normalizeZip` |
| Name | `{ given[], family, prefix, suffix }` | `Kuhlman, Ramona` in lists | `formatNameFamilyFirst`, `formatNameGivenFirst` |
| Weight, height, temperature | `Quantity` with UCUM unit (may be `kg`, `cm`, `Cel`) | **lb, in, °F** | `toUsDisplay`, `formatHeightFeetInches` |

## U.S. wording

| Use | Not (Indian edition) |
|---|---|
| Insurance, payer, member ID, copay, deductible | TPA, cashless, PM-JAY / ESI / CGHS |
| MRN | UHID |
| Driver's license, state ID | Aadhaar, ABHA |
| ZIP code, state | PIN code, district |
| Front desk, check-in, exam room, provider | OPD counter, token, ward, bed, consultant |
| Same-day add-on | Walk-in token |
| Canceled, No-show | Cancelled |
| $ (USD) | ₹, lakh, GST |
| Call 911 | Call 108 |

A test (`tokens.test.ts`) fails if Indian-edition terms appear in `src/`.

## Components

| Component | Use |
|---|---|
| `Button` | Variants primary, secondary, outline, ghost, danger; `loading` |
| `Field` + `TextInput`, `Select`, `DateInput`, `PhoneInput`, `StateSelect` | Labelled control with hint, error and "(required)" in words |
| `Alert` | info, warning, critical (+ success) banners. Medication safety alerts use these three levels; a critical alert never blocks the clinician by itself |
| `Badge` | Status chips |
| `Modal`, `ConfirmDialog` | Focus trapped, Esc closes, focus restored |
| `Tabs` | Arrow keys, Home, End |
| `DataTable` | Lists with **Load more** (cursor lists: no page numbers, no totals) |
| `Spinner`, `EmptyState`, `ErrorState` | Panel states |
| `ToastProvider` / `useToast` | Short confirmations only, never errors to act on |

## Safety components

| Component | When | Contract |
|---|---|---|
| `ProblemAlert` | Any API error not routed to a flow below; lists field errors and the reference | Problem Details, `code` (API_STANDARDS §9) |
| `BreakGlassDialog` | `403 break-glass-required` on a restricted chart. Reason required; note required for "Other". Then call `POST /patients/{patientId}/break-glass` | SECURITY_MODEL §5.2: `reasonCode` `emergency-care`, `continuity-of-care`, `patient-request`, `other`; 4-hour grant |
| `SharedStatusBoard` | Waiting-room or hallway display (`GET /status-board?view=shared`, `DSP` role). Initials, time and status only; anything that is not initials is hidden | SECURITY_MODEL §8 rule 11, D47 |
| `RecordChangedDialog` | `412 precondition-failed` (or `428`) on save: re-read the record, show the differences, let the user use the latest or reapply their edits. No "save anyway" | ADR-0008, API_STANDARDS §11 (M4) |
| `IdleTimeoutWarning` | Mounted once in the app shell. Warns 2 minutes before idle logout (at 13 of 15 minutes), timed from `idleExpiresAt`; "Stay signed in" calls `POST /auth/refresh`. Notice before the 12-hour `expiresAt`, which cannot be extended | SECURITY_MODEL §2.1 (M15) |

Route codes with `problemCopy(problem).action`: `break-glass` → `BreakGlassDialog`,
`record-changed` → `RecordChangedDialog`, `sign-in` → sign-in page, `review-duplicates` → duplicate
review, `fix-fields` → field errors on the form, everything else → `ProblemAlert`.

## Accessibility (WCAG 2.1 AA)

- `tokens.test.ts` checks every text colour pair at 4.5:1 and control borders and focus at 3:1, in
  light and dark mode.
- Component tests run axe (WCAG 2.0/2.1 A and AA rules) on each component.
- ESLint runs `jsx-a11y` in strict mode.
- Still check by hand on each new screen: keyboard walk-through, 200% zoom, large-text mode
  (`html[data-large-text='true']`), and a screen reader pass on the main flow.
