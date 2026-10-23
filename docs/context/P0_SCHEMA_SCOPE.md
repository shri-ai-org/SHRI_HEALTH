# P0 Schema Scope for the 30 October Lock

Oct 22, 2026 · Imported from the team's shared doc on 2026-10-23.

> **Status: Approved (2026-10-23).** ADR-0011 adopts Sam's schema (PR #9) in one PostgreSQL 18 database; D1 (HAPI) is retired. This scope is approved as written:
> - the release tags below are final for the 30 October lock;
> - every one of the eight "P0 items to confirm" is **approved as P0**: Sam and Anand add whatever is missing before the lock (D24);
> - the remaining "Next steps" are scheduled work with named owners (DECISIONS.md, "Work before the 30 October schema lock"), not open questions.

## What P0 means

P0 tables are the ones the controlled pilot needs to go live on 1 March 2027; only these must be reviewed and locked on 30 October 2026. The release labels come from MVP FRS v1.2 §2 and the backlog in the Detailed Implementation Plan v1.1.

Of the 28 FHIR resources in Sam's proposal, 27 are P0 and one (Immunization) is P1. Most admin table groups are P0; the exceptions are listed in the "Not P0" section.

**How to use this:** tag every one of the 218 tables in the data dictionary as P0, P0 stretch, P1 or P2 using the sections below. Lock the P0 tables. P1 and P2 tables can stay in the code, but they are not part of the lock and can still change.

This list works from the resource names and module groups in Sam's README. Exact table names come from the proposal's data dictionary, which has not been reviewed here.

## Clinical (FHIR) tables

Each resource below includes its child tables (names, identifiers, codings, components and similar) and the shared `fhir_resource_history` table, which is also P0.

| FHIR resource | Release | FRS requirement | What it holds |
| --- | --- | --- | --- |
| Patient | P0 | FR-PAT-01, FR-PAT-02 | Demographics, identifiers incl. driver's licence, restricted-chart flag |
| RelatedPerson | P0 | FR-PAT-01 | Emergency contacts, guarantors, insurance subscribers |
| Practitioner | P0 | §3.10 | Providers, NPI, credentials |
| PractitionerRole | P0 | §3.10, FR-ENC-01 | Provider at a facility; supervising physician for co-signature |
| Organization | P0 | §3.10 | Practice, payers, labs as organisations |
| Location | P0 | FR-SCH-01, FR-SCH-02 | Facilities and rooms used for scheduling and rooming |
| Schedule | P0 | FR-SCH-01 | Provider calendars |
| Appointment | P0 | FR-SCH-01, FR-SCH-02 | Bookings, cancellations, check-in, same-day add-ons |
| Encounter | P0 | FR-ENC-01 | The visit |
| Composition | P0 | FR-ENC-01, FR-ENC-06 | Clinical notes, signing, co-signature, addenda, after-visit summary |
| Condition | P0 | FR-ENC-02, FR-PAT-03 | Encounter diagnoses and the standing problem list |
| AllergyIntolerance | P0 | FR-ENC-01, FR-MED-01 | Allergies used by safety checks |
| Observation | P0 | FR-ENC-03, FR-ORD-02, FR-PAT-03 | Vitals, lab result values, smoking and social history |
| Procedure | P0 | FR-PAT-03 | Past surgical history and in-office procedures |
| FamilyMemberHistory | P0 | FR-PAT-03 | Family history |
| Medication | P0 | FR-MED-01 | Drug definitions (RxNorm) |
| MedicationRequest | P0 | FR-MED-01 | Prescriptions and e-prescribing |
| MedicationStatement | P0 | FR-MED-01 | Medication list and reconciliation |
| MedicationDispense | P0 | FR-MED-01 | External medication (fill) history |
| DetectedIssue | P0 | §3.4 rule layer, FR-MED-01 | Rule-based safety alerts and override reasons |
| ServiceRequest | P0 | FR-ORD-01 | Lab and imaging orders |
| Specimen | P0 | FR-ORD-01 | Specimens and labels |
| DiagnosticReport | P0 | FR-ORD-02 | Lab reports, corrected versions, acknowledgement |
| DocumentReference | P0 | §3.9 | Uploaded documents, eFax, C-CDA import and export |
| Consent | P0 | FR-PAT-01, AI-01 | Treatment, privacy-notice and recording consent |
| Coverage | P0 | FR-PAT-01, FR-RCM-01 | Primary and secondary insurance, card images |
| Provenance | P0 | FR-PAT-02, §3.4 | Source, author and AI-review trail for every entry |
| Immunization | **P1** | FRS §2 (P1: immunization history) | Keep the design, but leave it out of the lock |

## Admin (normalized) tables

All admin groups are P0 except RAG knowledge, migration runs and ERA posting. Groups follow the module files in Sam's `models/admin/`.

| Module | Table group | Release | FRS requirement |
| --- | --- | --- | --- |
| core | Tenant, settings, facilities, users, roles and permissions | P0 | §3.10, §6 security |
| core | Care team (who may open which chart) | P0 | FR-PAT-02 |
| core | Co-signature rules by state and provider | P0 | FR-ENC-01 |
| core | Terminology and picklists | P0 | FR-ENC-02 |
| practice | Appointment types and availability | P0 | FR-SCH-01 |
| practice | Visit flow (arrived to checked out) | P0 | FR-SCH-02 |
| practice | Templates and favourites | P0 | FR-ENC-04 |
| practice | Rule-based decision-support rules | P0 | §3.4 rule layer |
| practice | Clinician inbox | P0 | FR-ENC-05 |
| orders | Labs, compendium, AOE questions | P0 | FR-ORD-01 |
| orders | Requisitions, ABN, medical necessity, status history | P0 | FR-ORD-01 |
| orders | Unmatched results | P0 | FR-ORD-02 |
| medication | Pharmacy directory, preferred pharmacy | P0 | FR-PAT-01, FR-MED-01 |
| medication | E-prescribing transactions (new, cancel, change, renewal) | P0 | FR-MED-01 |
| rcm | Payers, provider enrolment, eligibility checks | P0 | FR-RCM-01 |
| rcm | Fee schedules, superbill, charges | P0 | FR-RCM-02 |
| rcm | Claims, 999 / 277CA acknowledgements, 276/277 status | P0 | FR-RCM-02 |
| rcm | Copays and patient payments | P0 | FR-SCH-02, FR-RCM-03 |
| rcm | ERA (835) remittance posting | P0 stretch | FR-RCM-03 |
| comms | Object storage records | P0 | §3.9 |
| comms | Communication preferences, templates, outbound messages | P0 | FR-SCH-01, §3.9 |
| comms | eFax | P0 | §3.9 |
| ai | AI settings and kill switch, prompts, requests | P0 | AI-01, AI-02, §3.4 |
| ai | Suggestions and evidence, audio, transcripts | P0 | AI-01, AI-02 |
| ai | RAG knowledge sources and chunks | P1 | AI-03 (Tech Arch ADR-14) |
| platform | Audit chain, break-the-glass | P0 | FR-PAT-01, §6 audit |
| platform | Duplicates and merge | P0 | FR-PAT-01 |
| platform | Integration messages (outbox, retries, dead-letter) | P0 | §3.6, §3.7 |
| platform | Migration runs, record maps, issues | P1 | FRS §5: P0 is mapping only |

## Not P0

None of these tables is needed for the pilot, so none should hold up the 30 October lock.

| Feature or table | Release | Source |
| --- | --- | --- |
| Immunization history | P1 | FRS §2 |
| Patient portal accounts, intake questionnaires (QuestionnaireResponse) | P1 | FRS §3.8 |
| Telehealth sessions (Jitsi) | P1 | FRS §3.8 |
| Referrals | P1 | FRS §3.9 |
| Patient ledger and statements | P1 | FR-RCM-03 |
| Card-payment processor integration | P1 | Implementation Plan backlog |
| EPCS, PDMP checks, formulary checks | P1 | FRS §2, ADR-17 |
| Insurance card OCR | P1 | Implementation Plan Phase 4 |
| C-CDA reconciliation into the chart | P1 | FRS §2 |
| Substance-use record labels (42 CFR Part 2) | P1 | FRS §6 |
| RAG knowledge, AI-03 and AI-04 suggestions | P1 | FRS §3.4 |
| OpenEMR migration tooling and runs | P1 (separate project) | FRS §5 |
| Denial work queues, prior authorisation | P2 | FR-RCM-03 |
| Quality measures (MIPS / eCQM), SMART on FHIR | P2 | FRS §2 |
| Live coexistence with OpenEMR | P2 | FR-MIG-02 |
| Inpatient, beds, in-house pharmacy, vaccine inventory, walk-in tokens | Out of scope | FRS §9 |

AI-03 and AI-04 reuse the P0 suggestion tables, so they add no new tables beyond RAG.

## P0 items to confirm in Sam's schema

A comparison against OpenEMR's current schema found these P0 needs; Sam's README does not mention them, so each needs a yes or no before the lock.

| Item | Why it is P0 | What to check |
| --- | --- | --- |
| Claim details: accident indicators, onset dates, prior-auth number, resubmission code, original claim reference | FR-RCM-02 corrected and voided claims; 837P needs them | Fields on superbill or claim (OpenEMR keeps them in `form_misc_billing_options`) |
| Employer of patient and subscriber | Workers' compensation is a P0 payer type (FR-RCM-01) | An employer table or fields on Patient and Coverage |
| MRN generation per practice | FR-PAT-01: unique patient identifier | A per-tenant counter with format rules; never reused |
| HIPAA amendment requests | §6 HIPAA Privacy Rule; patients may ask to correct records | A request table with status and decision |
| Accounting of disclosures | §6 HIPAA; Implementation Plan: HIPAA access reports P0 | Releases outside the practice, separate from the access audit |
| Visit status history | FR-SCH-02: arrived, checked in, roomed, with provider, checked out | Visit flow keeps each change with a timestamp, not only the latest |
| Staff messages in the inbox | FR-ENC-05: messages, refill requests | Inbox holds message threads, not only tasks |
| Occupation, industry, tribal affiliation | USCDI data in Patient | Columns present; low cost to add now |

## Next steps before 30 October

The storage decision comes first: this list assumes clinical data stays in our PostgreSQL (ADR-19), not HAPI FHIR (D1).

- [x] Sena and the four owners: confirm ADR-19 replaces D1. **Done: ADR-0011 (2026-10-23).**
- [ ] Anand and Sam: tag all 218 tables P0, P0 stretch, P1 or P2 in the data dictionary.
- [ ] Sam: answer each item in "P0 items to confirm" and add what is missing.
- [ ] Anand: load-test the visit, results and claims write paths with the composite foreign keys in place.
- [ ] Team: review and lock the P0 tables only.

After the lock, P0 tables change only through new migrations; P1 tables can still be reshaped until their own review.
