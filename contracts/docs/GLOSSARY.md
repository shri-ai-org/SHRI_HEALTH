# Glossary

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** everyone (review only). Clinical and billing definitions to be checked by the clinical advisors and the RCM analyst.

Plain-English meanings, so all four of us and every Claude session use the same words. U.S. spelling. Where a term is also an API name, the API spelling is shown in `code`.

## Clinical and front desk

| Term | Meaning |
|---|---|
| **Addendum** (`addenda`) | Text added to a note after it was signed. The signed note never changes; corrections and late information become addenda. |
| **Advanced practice provider (APP)** | Nurse practitioner (NP) or physician assistant (PA). Their notes may need a physician's co-signature, depending on state and clinic rules. |
| **After-visit summary** (`after-visit-summary`) | A patient-friendly handout made from the signed note: diagnoses, medications, orders, instructions and follow-up. |
| **Allergy / allergy intolerance** (`allergies`) | A recorded allergy or intolerance (to a drug, food, etc.), with reaction and severity. FHIR resource `AllergyIntolerance`. |
| **Appointment** | A booked time for a patient with a provider. It becomes a visit (encounter) when the patient checks in. |
| **Break-glass** (`break-glass`) | Opening a restricted chart by stating a reason. Always audited and reviewed afterwards. |
| **Chart** | Everything recorded about one patient. "Opening a chart" means viewing the patient's record. |
| **Check-in** (`check-in`) | Front desk confirms the patient is here, details are correct and insurance is checked. Creates the encounter. |
| **Chief complaint / reason for visit** | Why the patient came, in a few words ("headache for 3 days"). |
| **Clinical decision support (CDS)** | Alerts and reminders that help clinicians. Layer 1 is rule-based (allergy, interaction, dose); AI suggestions (AI-03) come later and are shown separately. |
| **Co-signature** (`cosign`) | A supervising physician's second signature on a note written by an NP or PA. |
| **Consent** | A recorded agreement by the patient, such as consent to treat, privacy-notice acknowledgement, or consent to record audio for AI notes. |
| **Duplicate / merge** | Two records for the same person. Merging combines them into one; "undo merge" reverses it. Both are audited. |
| **Emergency contact / related person** (`related-persons`) | Someone connected to the patient: emergency contact, guardian, caregiver. |
| **Encounter** | One interaction between patient and clinic: an office visit, a phone call, or documentation-only work. Holds the notes, vitals and diagnoses from that interaction. Also called a visit. |
| **Encounter diagnosis** (`diagnoses`) | A diagnosis made or addressed in one encounter, used for billing that visit. Different from the problem list. |
| **Entered-in-error** (`entered-in-error`) | Marks a record as wrong without deleting it. It disappears from normal views but stays for audit. Clinical records are never deleted. |
| **Family history** | Health conditions of the patient's relatives. FHIR resource `FamilyMemberHistory`. |
| **Favorites** (`favorites`) | A provider's saved templates, diagnoses, orders, prescriptions and phrases for quick reuse. |
| **History (patient history)** | Problem list, past medical, surgical, family and social history. |
| **HPI, ROS, exam, assessment and plan** | Standard note sections: history of present illness, review of systems, physical examination, the clinician's assessment, and the plan. |
| **Inbox** (`inbox`) | One work list per user: results to review, refill requests, messages, tasks, incoming documents, notes to sign or co-sign. |
| **Medical assistant (MA)** | Staff who room patients: record vitals, review medications and allergies. |
| **Medication reconciliation** | Comparing the patient's medication list with what they actually take, and correcting it. |
| **MRN (medical record number)** | The clinic's identifier for a patient. A HIPAA identifier, so never in URLs. |
| **No-show** (`noshow`) | The patient did not come to a booked appointment. FHIR's code is spelled `noshow`. |
| **Note** (`notes`) | The clinician's written record of an encounter, built from a template. Draft → signed → (addenda). |
| **Problem list** (`problems`) | The patient's ongoing health problems, kept across visits (e.g. "type 2 diabetes"). Different from encounter diagnoses. |
| **Provider** | A clinician who sees patients and bills for it (physician, NP, PA). Has an NPI. |
| **Restricted chart** | A chart marked sensitive (e.g. a staff member or VIP). Opening it needs break-glass. |
| **Result** | A lab or test outcome. Arrives from the lab or is entered in the office; the ordering clinician must acknowledge it. |
| **Rooming** | MA takes the patient to a room, records vitals, reviews medications and allergies, confirms the reason for visit. |
| **Same-day add-on** | U.S. term for fitting in a walk-in patient: booked as an appointment for today. There is no token queue in this edition. |
| **Social history** | Smoking, alcohol, occupation and similar facts. Stored as FHIR `Observation` with category social-history. |
| **Status board** (`status-board`) | Today's clinic flow: who has arrived, is checked in, roomed, with provider, checked out. |
| **Surgical history** | Past operations and procedures. FHIR resource `Procedure`. |
| **Template** (`note-templates`) | A note layout with sections (chief complaint, HPI, ROS, exam, assessment and plan) that a practice can copy and adapt. |
| **Timeline** | All of a patient's records in date order, each showing its source. |
| **Unscheduled encounter** | An encounter without an appointment: telephone, or documentation-only. Created with `POST /encounters`. |
| **Visit status** | Where the patient is in today's visit: arrived, checked in, roomed, with provider, checked out. |
| **Vitals** | Blood pressure, heart rate, temperature, breathing rate, oxygen level, height, weight, BMI. |

## Medications and orders

| Term | Meaning |
|---|---|
| **ABN (Advance Beneficiary Notice)** | A Medicare form the patient signs before a test that Medicare might not pay for; otherwise the practice cannot bill the patient. |
| **AOE (ask-at-order-entry) questions** | Questions a lab requires when a test is ordered (e.g. "fasting?"). |
| **Compendium** (`lab-compendium`) | A lab's catalog of tests, panels, specimen rules and AOE questions. |
| **Drug knowledge base** | Licensed drug data used for interaction, allergy and dose checks. |
| **EPCS** | Electronic prescribing of controlled substances; needs extra identity proofing and two-factor signing. P1. |
| **E-prescribing (eRx)** | Sending prescriptions electronically to pharmacies through a vendor connected to the Surescripts network. |
| **In-office result** | A test done in the clinic (e.g. rapid strep) and entered by staff. |
| **Medical necessity check** | Checks whether a test is likely to be covered for the patient's diagnoses; may require an ABN. |
| **Order** (`orders`) | A request for a lab test, imaging or other service. FHIR `ServiceRequest`. |
| **PDMP** | Prescription drug monitoring program: state database checked before prescribing controlled substances. P1. |
| **Placer / filler order number** | The order number given by us (placer) and by the lab (filler); used to match results to orders. |
| **Prescription** (`prescriptions`) | An order for a medication, signed by a prescriber and sent to a pharmacy. FHIR `MedicationRequest`. |
| **Refill request** | A pharmacy asking the prescriber to renew a prescription. |
| **Requisition and labels** | Printed paperwork and specimen labels sent with a lab sample. |
| **Safety check / alert / override** | Rule-based check before prescribing; alerts have severity; a high-severity alert needs an override reason. |
| **Unmatched result** | A result the system could not match to a patient or order; goes to a review queue, never filed automatically. |

## Insurance and billing (revenue cycle)

| Term | Meaning |
|---|---|
| **270 / 271** | X12 eligibility request and response: "is this patient covered, what is the copay and deductible?" |
| **276 / 277** | X12 claim status request and response. |
| **277CA** | Claim acknowledgement from the clearinghouse or payer: accepted for processing or rejected. |
| **835 (ERA)** | Electronic remittance advice: the payer's explanation of what was paid, adjusted or denied. |
| **837P** | X12 professional claim: the electronic bill for an outpatient visit. |
| **999** | X12 acknowledgement that a file was received and is well-formed. |
| **Charge capture** | Recording billable services from the signed encounter. |
| **Claim** (`claims`) | The bill sent to the payer for a visit. Can be corrected (replacement) or voided. |
| **Claim scrubbing** (`scrub`) | Automatic checks for errors before a claim is sent. |
| **Clearinghouse** | A company that passes claims and eligibility checks between practices and payers (Waystar is the candidate). |
| **Copay** | Fixed amount the patient pays at the visit. |
| **Coverage** (`coverages`) | A patient's insurance policy: payer, plan, member ID, subscriber, priority (primary, secondary). |
| **CPT / HCPCS** | Codes for procedures and services used in billing. CPT is owned and licensed by the AMA. |
| **Deductible** | Amount the patient pays each year before insurance pays. |
| **Eligibility check** (`eligibility-checks`) | Asking the payer whether coverage is active, and what copay and deductible apply. Runs at booking, the day before, and at check-in. |
| **Fee schedule** | The practice's price list per service code. |
| **Member ID / subscriber ID** | The insurance card identifier. A HIPAA identifier, never in URLs. |
| **Payer** | The insurance company or program (commercial, Medicare, Medicaid, etc.). |
| **Remittance / posting** | Recording what the payer paid against each claim. |
| **Revenue cycle (RCM)** | Everything from eligibility to payment: charges, claims, remittances, patient payments. |
| **Superbill** | The list of billable services and diagnoses for one encounter, built when the encounter closes; the basis for the claim. |

## Standards and codes

| Term | Meaning |
|---|---|
| **C-CDA / CCD** | Standard clinical document format for exchanging a patient's summary record with other EHRs. |
| **FHIR (R4)** | HL7's standard for exchanging health data as "resources" (Patient, Encounter, Observation…). We use release 4. |
| **HL7 v2** | Older pipe-delimited message standard still used by labs (orders out, results in). |
| **ICD-10-CM** | U.S. diagnosis codes. |
| **LOINC** | Codes for lab tests and clinical observations. |
| **MLLP** | The simple network framing used to send HL7 v2 messages. |
| **NPI** | National Provider Identifier: a provider's U.S. ID number (not PHI). |
| **RxNorm** | Codes for medications. |
| **SNOMED CT** | Clinical terminology for problems and findings. |
| **UCUM** | Standard codes for units of measure (e.g. `mm[Hg]`). |
| **US Core** | U.S. rules ("profiles") for how FHIR resources must be filled in. |
| **USCDI** | U.S. Core Data for Interoperability: the national list of data elements EHRs must be able to exchange. |
| **X12** | The standard format for U.S. insurance transactions (eligibility, claims, remittances). |

## Privacy and security

| Term | Meaning |
|---|---|
| **Audit event** | A record of who did what to which record and when. Append-only. |
| **BAA (Business Associate Agreement)** | A HIPAA contract required with any vendor that handles PHI for us. |
| **CSRF** | Cross-site request forgery: another website tricking a logged-in browser into sending a request. Blocked by the CSRF header. |
| **HIPAA** | U.S. law protecting health information. |
| **Minimum necessary** | HIPAA principle: use and show only the PHI needed for the task. |
| **PHI (protected health information)** | Health information linked to a person, including identifiers such as name, birth date, phone, MRN and member ID. |
| **Reference token** | A random value in the session cookie that points to the session stored on our server; meaningless on its own. |
| **Row-level security (RLS)** | PostgreSQL feature that hides other clinics' rows from every query. |
| **Synthetic data** | Invented patient data (e.g. from Synthea). The only data allowed outside production. |
| **Tenant / organization** | One clinic or practice using the system. Its data is isolated from every other tenant. |

## Architecture and API terms

| Term | Meaning |
|---|---|
| **Contract** | The OpenAPI files in `contracts/openapi/` that define every endpoint. Written before the code. |
| **Cursor** | An opaque marker meaning "continue the list from here". |
| **Dead-letter** | Where a message goes after all retries failed, so an operator can fix and replay it. |
| **ETag / If-Match** | A version stamp on a record; sending it back proves you edit the version you saw. |
| **Event** | A short notice that something happened (`note.signed`), carrying IDs only. |
| **HAPI FHIR** | The open-source FHIR server that stores our clinical data. |
| **Idempotency key** | A unique value sent with a request so that retrying it never does the work twice. |
| **Integration engine** | Our Python service that talks to labs, clearinghouse, e-prescribing, fax and SMS, and queues writes to HAPI. |
| **Mirror** | A copy of our record kept in HAPI (e.g. Patient), updated after every change. |
| **Mock server** | A fake API (Prism) that answers from the contract's examples so screens can be built before the backend. |
| **Operation** (`operations`) | A record that tracks slow background work (e.g. an AI draft) and points to the result when done. |
| **Outbox** | A table where a change and "send this to HAPI or a partner" are saved together, so neither is lost. |
| **Problem Details** | The standard JSON shape for every error (RFC 9457). |
| **Provenance** | A record of who created or changed a clinical record, when, and with what help (including AI). |
| **Server-Sent Events (SSE)** | A one-way live connection from server to browser used for status board and inbox updates. |
| **Source of truth / system of record** | The one place whose copy wins when copies disagree. |
| **x-owner, x-permission, x-audit, x-phi** | Our extra fields in the contract: who implements, which permission, what to audit, how sensitive each field is. |

## AI

| Term | Meaning |
|---|---|
| **AI-01** | Ambient documentation and dictation: audio → transcript → draft note for the clinician to edit and sign. |
| **AI-02** | Chart summary with a link to the source record for every statement. |
| **AI-03 / AI-04** | P1: AI decision support; coding and order suggestions. |
| **AI gateway** | The single entry point for every AI call: on/off switches, minimum data, output checks, prompt versions, metadata-only logs. |
| **AI suggestion / decision** | A piece of AI output the clinician accepts, edits or rejects; every decision is recorded. |
| **Confidence band** | High, Medium or Low label on AI output. |
| **Kill switch** | Turning AI off for a clinic or a feature; every non-AI workflow keeps working. |
| **RAG** | Retrieval-augmented generation: AI answers from approved documents and cites them. P1. |
| **Transcript** | The text produced from audio by speech-to-text. |
