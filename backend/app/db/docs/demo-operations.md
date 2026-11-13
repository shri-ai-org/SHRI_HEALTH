# Demo operations guide (the demo server's data)

For whoever runs a deploy, a reset or a rehearsal on the demo server. The server itself (host setup, settings, TLS, the health check, admin access) is Thulasi's deploy kit: [infra/deploy/README.md](../../../../infra/deploy/README.md). This guide covers the data: what each command does to it, when to run it, and how to check it is ready. Synthetic data only: every person here is fictional. No credentials, hostnames or secrets belong in this file.

## How a deploy works: `up` and `reset`

| | `deploy.sh up` | `deploy.sh reset` |
|---|---|---|
| **When** | A new commit is deployed | Before every rehearsal and before the demo, after the clinic's day has started (below) |
| **Schema** | Migrates to head (today `0022`) | Drops the application database, creates it empty and migrates to head |
| **Demo data** | `python -m app.db.seed demo`: **additive**. Adds what is missing and moves the demo providers' clinic-hours rules; never changes other existing rows | `python -m app.db.seed reset`: everything from empty, booked on the demo day, then the reset's own check (it fails loudly if anything below is missing) |
| **Codes** | Not loaded | Loads the pinned ICD-10-CM and RxNorm releases (`python -m app.db.terminology all`) |
| **Demo accounts** | Put back with their fixed IDs | Put back, enabled, with their authenticators |
| **Sessions** | Kept | Everyone is signed out (sessions live in the database) |

**What `up` doesn't update.** Rows from an earlier seed stay as they were: the clinic's time zone and address, today's visits, the history patients' charts. Over a database seeded before the San Jose move, `up` adds the new rows without error (the history and results seeds find past visits by their fixed booking IDs), but the clinic stays where it was. **Only a reset moves the demo to the current seed.** A migration such as `0022` needs no reset of its own; it arrives with `up`.

**What survives a reset:** Keycloak's own database and the demo accounts, OpenBao's keys, the service roles and their passwords, the stored files (earlier runs' files stay in the object store, unreferenced) and the downloaded code releases. Everything in the application database is rebuilt: patients, visits, notes, prescriptions and overrides, payments, holds, AI settings.

## The reset rule: after the clinic's day starts

The demo clinic is in San Jose (`America/Los_Angeles`). Its day starts at midnight there, which is 08:00 UTC, **13:30 IST, in winter** (Pacific Standard Time, November to March), and 07:00 UTC, **about 12:30 IST, in summer** (Pacific Daylight Time). A reset before that books "today" on the previous San Jose day. So the reset runs after 13:30 IST in November, including on the demo day.

## The demo day: `SHRI_DEMO_DAY`

- **Default (empty):** the demo patients are booked on the day the seed runs, in the clinic's time zone.
- **Set (`YYYY-MM-DD`):** booked on that day instead, to rehearse a particular day. Leave it empty afterwards. `deploy.sh` passes it to the seed only when set. Anything that isn't a date stops the seed with `SHRI_DEMO_DAY must be a date as YYYY-MM-DD (for example 2026-11-20), not '…'`.
- **What is booked on the demo day, all with demo.doctor:** Kaia401 Lindgren118 (the demo visit's new patient) at 09:00 and the six history patients at 09:40, 10:00, 10:20, 11:00, 11:20 and 11:40 San Jose time.
- **Clinic hours:** the demo providers have free times from 08:00 to 17:00 on all seven days, in each facility's time zone, so a rehearsal on any day can book today until 16:40.

## AI on the demo server (D118)

- **Every reset turns both AI features on** (`ambient-documentation`, `chart-summary`) for the demo clinic, through the seed.
- **A missing setting counts as on** on a demo server: the deploy kit gives the API `SHRI_AI_ON_BY_DEFAULT` from `SHRI_DEMO`, and the API ignores it in production.
- **A deliberate switch-off persists** (the AI settings screen, demo.admin) until it is switched back on or the next reset. `up` restores a missing setting as on and never touches an existing one.
- **Non-demo servers default off** until the ADR-08 decision. The Claude API takes fictional data only (D12).

## The readiness gate

Right after a reset, before any dry run or rehearsal (a dry run's new patient makes the patient-count line fail). On the server, as the master user, read-only, inside the API container. Follow the deploy kit for loading the settings file and exporting `SERVER_CHECK_DATABASE_URL`; the URL is never printed. Then:

```bash
python -m app.db.tools.server_check --patients 512 --demo
```

Expected: every line `PASS`, ending `21 of 21 passed`. A `FAIL` line ends with what to do. Who fixes it:

| Line | Expected | A FAIL means | Who |
|---|---|---|---|
| migrations at head | `0022` | The image isn't the merged main | Vimal (redeploy) |
| pgvector is RDS's (D31) | `0.8.2` | The database image changed | Thulasi |
| row security on and forced on every clinic table | `0` | A table without forced RLS | Anand |
| collation C.UTF-8 (D33) | `C.UTF-8` | The database was created wrongly | Thulasi (image), Anand |
| no service role bypasses row security | `0` | A role was altered | Thulasi |
| demo patients loaded | `512` | The seed didn't run, or a dry run added a patient | Reset |
| both AI features on in the demo clinic | `2` | Someone switched one off | Switch it on as demo.admin, or reset |
| the demo clinic's time zone | `America/Los_Angeles` | `up` ran without a reset | Reset |
| the demo clinic's main office's time zone | `America/Los_Angeles` | The same | Reset |
| no demo-clinic facility outside Pacific or Eastern time | `0` | The same | Reset |
| visits today with demo.doctor | at least `6` | Reset before the clinic's day started, or `up` only | Reset after 13:30 IST |
| the 11 shown patients | `11` | Seed data missing | Reset; if it stays, Anand |
| portal accounts active on their charts | `4` | The same | Reset; if it stays, Anand |
| David Nguyen's chart restricted | `True` | The same | Reset; if it stays, Anand |
| the MRN counter is ahead of every MRN | `True` | The counter is behind | Stop registering; Anand |
| ICD-10-CM codes loaded | at least `90000` | The code load didn't run | Reset loads them; if not, Anand |
| RxNorm codes loaded | at least `30000` | The same | The same |
| history patients short of their lab reports | `0` | Seed data missing | Reset; if it stays, Anand |
| history patients short of their imaging reports | `0` | The same | The same |
| history patients short of their vital signs | `0` | The same | The same |
| the alert scenarios (James aspirin; Robert amoxicillin and metformin) | `3` | The same | The same |

## The shown patients

| Patient | What's there |
|---|---|
| **Kaia401 Lindgren118** | The demo visit's new patient, booked at 09:00; demo.patient's portal account |
| **Robert Miller** | Diabetes, hypertension, high cholesterol; amoxicillin allergy; metformin, lisinopril, atorvastatin; 11 lab reports |
| **Linda Thompson** | Chronic low back pain; 5 lab reports, a lumbar spine MRI; a portal account |
| **James Wilson** | Asthma; aspirin allergy; 6 lab reports, a chest X-ray; a portal account |
| **Patricia Davis** | Breast cancer on anastrozole; 8 lab reports, a mammogram and a bone density scan |
| **David Nguyen** | Migraine; **restricted chart** (break-glass to open, D37); 3 lab reports, a brain MRI |
| **Maria Gonzalez** | COPD and knee osteoarthritis; 2 lab reports, a chest X-ray and knee X-rays; a portal account |
| Emily Carter, Daniel Brooks, Sofia Ramirez, Michael Chen, Aisha Johnson | Registration and insurance only, no clinical history, by design |

**Seeded results:** 42 studies for the six history patients, each ordered at a past visit and reported a few hours after collection. Lab results carry UCUM units, reference ranges and `H`/`L` flags. Imaging reports are text only: the impression plus the technique and findings, with no images. The screens show each code's short clinical name ("Lipid panel", "LDL cholesterol (calculated)"); the coding keeps the LOINC code and its long name.

## The three alert scenarios (prescribing, as demo.doctor)

The alerts are fixed rules matching an exact RxNorm ingredient (D99, never AI). A reset rebuilds everything, so every alert fires again.

| Patient | Type | Pick | Alert |
|---|---|---|---|
| James Wilson | `aspirin 81` | aspirin 81 MG Oral Tablet | Allergy, high: an override with a reason is needed to sign |
| Robert Miller | `amoxicillin 500 capsule` | amoxicillin 500 MG Oral Capsule | Allergy, high |
| Robert Miller | `metformin 1000 tablet` | metFORMIN HCl 1000 MG Oral Tablet | Duplicate medication, warning (metformin 500 is already on his list) |

Type the words exactly: `metformin 1000` alone lists a combination product first (a known ranking limit).

## Demo accounts (names only)

- **Staff:** demo.frontdesk, demo.ma, demo.doctor, demo.admin.
- **Patients:** demo.patient (Kaia401 Lindgren118), plus the portal accounts of Linda Thompson, James Wilson and Maria Gonzalez for self-booking.

Passwords and second factors are never written down here; the deploy kit's reset script puts the accounts back.

## Known limits

- **No drug-class matching:** penicillin V for Robert raises no alert, because the rules match ingredients, not classes (after the demo, with a drug-interaction source).
- **Drug search ranking:** a one-ingredient search can list a combination first; type the strength and form, as above.
- **Held portal items:** the portal shows held problems once Vimal's #349 uses `admin.portal_held_records()`. `admin.portal_held_items()` stays until then.
- **One copay per visit** is enforced by the billing service (a lock on the visit), not yet by a database constraint.
- **Results** are seeded, not from a lab: the lab interface waits on the vendor choice (Q14).
- **The other locations,** the New York office and the Denver clinic, keep their own time zones. Only the demo story's clinic is in San Jose.
