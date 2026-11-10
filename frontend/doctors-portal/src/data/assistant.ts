/**
 * AI-911 · Contextual RAG help & documentation assistant — its content.
 *
 * §6.1 states the retrieval backend is hypothetical and later work (OQ-539,
 * OQ-540): "What this document specifies — and what the mockup must show — is
 * the AFFORDANCE and the SURFACE... Treat every example answer in M-28 as
 * illustrative copy for a mockup, not a committed capability."
 *
 * So the answers here are canned. What is NOT canned is the behaviour around
 * them, because that is the part the atlas actually specifies:
 *
 *   Guardrail 1  A clinical question is DECLINED AND ROUTED to the capability
 *                that owns it, under its own gate. Never answered here.
 *   Guardrail 2  Grounded or silent. An answer with no citations renders the
 *                AI-ABSTAIN frame instead of prose — "an uncited answer is not
 *                rendered at all."
 *   Guardrail 3  Retrieval is filtered to what the caller may already read.
 *   Guardrail 4  No PHI it did not already have — only the Z3 patient.
 *   Guardrail 5  Every answer is citable and reportable.
 *   Guardrail 6  It is never the only path.
 */

import type { ConfidenceBand } from '@/atlas/confidence'
import type { Gate } from '@/atlas/gates'

import { ATTENTION_PROMPT, DEFAULT_LIVE, admissionPrompt, patientPrompts, recordAnswer, recordIntent } from './assistant-record'
import type { LiveContext } from './assistant-record'

export interface Citation {
  n: number
  label: string
  /** Where it came from — a policy ID, an SOP, a screen spec, a record. */
  source: string
  /** The route that opens it, where the source is a record entry rather than a document. */
  to?: string
}

/**
 * The five terminal outcomes of W-28-1. Every one is reachable in the UI,
 * because a refusal taxonomy that only exists on paper is not a refusal
 * taxonomy.
 */
export type AnswerKind =
  /** O1 — a cited answer. */
  | 'cited'
  /** O2 — clinical, so routed to the capability that owns it under its own gate. */
  | 'routed'
  /** O3 — out of scope, declined NAMING what it does cover, with two examples. */
  | 'out-of-scope'
  /** O4 — nothing relevant retrieved. AI-ABSTAIN. */
  | 'no-evidence'
  /** O5 — would exceed the caller's access. Declines as though it does not exist. */
  | 'beyond-access'

export interface AssistantAnswer {
  kind: AnswerKind
  body: string
  /** Empty means the AI-ABSTAIN frame renders instead of the body. */
  citations: Citation[]
  band: ConfidenceBand
  /** Set on a routed answer: where the question actually belongs. */
  routedTo?: {
    capability: string
    name: string
    gate: Gate
    where: string
  }
  /** Set on an out-of-scope refusal: what it DOES cover. Two examples minimum. */
  covers?: { summary: string; examples: string[] }
  /** Set on no-evidence: the support route that remains. */
  supportRoute?: string
  /**
   * Set on a reading about ONE patient. It is only given where that patient is
   * the one in context — the potassium reading is Joseph Mathew's, and asked
   * from another patient's result it would be the wrong patient's answer.
   */
  about?: string
  /**
   * Set when the answer READS something clinical rather than describing how
   * the product works. The assistant is allowed to give a view — that is what
   * a clinician actually asks it — but the view is a claim under a gate, so it
   * ends in a signature rather than in a full stop. Rendered as an attest strip
   * writing the same disposition and audit event the owning screen writes.
   */
  attest?: {
    capabilityId: string
    gate: Gate
    touchpointId: string
    /** The one sentence being signed for. */
    claim: string
  }
}

interface Entry {
  /** Lowercase substrings that select this answer. */
  match: string[]
  answer: AssistantAnswer
}

// ───────────────────────────────────────────── Screen-specific suggestions

/**
 * §M-28's S-28-02 requires 3–4 screen-specific suggested prompts:
 * "A blank chat box on a clinical screen gets no use." The EMPTY state is
 * "never a blank box".
 */
export const SCREEN_PROMPTS: Record<string, string[]> = {
  'S-06-01': [
    'Who is deteriorating, and why?',
    'What does marking a patient seen change?',
    'What does the acuity sort actually rank on?',
  ],
  'S-06-03': [
    'How do I add an addendum to a signed note?',
    'Why is Sign still disabled?',
    'Which abbreviations are banned here?',
    'What gets published to ABDM when I sign?',
  ],
  'S-06-04': [
    'Is the raw transcript kept?',
    'What happens if the scribe service drops mid-consultation?',
    'Can I dictate in Hindi?',
  ],
  'S-06-05': [
    'Why can I not pick J18?',
    'What is a leaf code?',
    'How do I code an uncertain diagnosis?',
  ],
  'S-06-06': [
    'How far back does this timeline go?',
    'Can I filter to one episode?',
    'What does the AI badge on an event mean?',
  ],
  'S-06-07': [
    'What is the override process for a hard stop?',
    'Why was this drug blocked?',
    'How is the NLEM substitution prompt decided?',
    'Where does the prescription print from?',
  ],
  'S-06-08': [
    'Which languages can instructions print in?',
    'Does the patient get this on the app?',
    'Can I keep my own wording as well?',
  ],
  'S-06-09': [
    'What is the co-sign turnaround target?',
    'Can I reject an entry rather than co-sign it?',
    'What does an amendment look like to an auditor?',
  ],
  'S-06-10': [
    'How do I promote a personal order set to facility-wide?',
    'Who owns a facility-wide order set?',
    'What is a review date for?',
  ],
  'S-08-03': [
    'Who is deteriorating, and why?',
    'Why has the AI abstained on one patient?',
    'How do I hand over my list?',
  ],
  'S-08-04': [
    'How do I add an addendum to a signed note?',
    'What is the ward-round scribe drafting from?',
    'Why is Sign still disabled?',
  ],
  'S-08-07': [
    'When does the 24-hour assessment clock start?',
    'What counts as a completed initial assessment?',
    'What happens if the window closes before I finish?',
  ],
  'S-09-01': [
    'How do I apply an order set?',
    'Why is this test flagged as a duplicate?',
    'What happens to an order I place offline?',
  ],
  'S-09-02': [
    'Who governs facility-wide order sets?',
    'How often are pathways reviewed?',
    'Can I apply a set to a patient rather than an encounter?',
  ],
  'S-09-03': [
    'What does "overdue" mean for an order?',
    'Who chases an unresulted order?',
    'Who is notified when I void an order?',
  ],
  'S-09-04': [
    'What are your views on the critical potassium?',
    'What is the acknowledgement window for a critical result?',
    'How is this inbox ranked?',
  ],
  'S-09-05': [
    'What are your views on this result?',
    'What is a delta check?',
    'How far back does the trend go?',
    'Why is the interpretation a G3 touchpoint?',
  ],
  'S-09-08': [
    'What makes a test low-value?',
    'Can I disagree with a stewardship flag?',
    'Where do my rejections go?',
  ],
  'S-13-01': [
    'What are your views on today’s discharges?',
    'What does the discharge prediction use?',
    'Why is financial clearance blocking?',
    'How do I mark a patient as medically fit?',
  ],
  'S-13-02': [
    'What blocks a discharge summary from being signed?',
    'Is the summary bilingual?',
    'When does this publish to ABDM?',
  ],
  'S-13-03': [
    'What does reconciliation compare?',
    'How do I record a stopped medicine?',
    'What happens to a medicine I do not carry forward?',
  ],
  'S-13-06': [
    'What is the MCCD sequence?',
    'When is police intimation required?',
    'Who can certify a death here?',
  ],
  'S-05-03': [
    'How is the wait time predicted?',
    'What happens when I call the next token?',
    'Does the patient see the same wait I see?',
  ],
  'S-05-04': [
    'How do I change my clinic template?',
    'What does the capacity suggestion use?',
    'Does changing a template move existing appointments?',
  ],
  'S-05-05': [
    'How much notice does a leave block need?',
    'Who approves an override?',
    'What happens to patients already booked into a blocked session?',
  ],
  'S-05-06': [
    'How are referrals triaged?',
    'What is the urgent referral target?',
    'What goes back to the referring doctor?',
  ],
  'S-02-05': [
    'What is break-glass and when may I use it?',
    'Who reviews my break-glass access?',
    'What is recorded when I break the glass?',
  ],
  'S-15-01': [
    'How is this worklist ranked?',
    'What does the model detect and not detect?',
    'How do I escalate a critical finding?',
  ],
  'S-15-04': [
    'What does the overlay show?',
    'Can I turn the overlay off?',
    'How do I escalate a critical finding?',
  ],
  'S-15-06': [
    'Who must acknowledge a critical finding?',
    'What is the escalation ladder?',
    'What if I cannot reach the named clinician?',
  ],
  'S-27-02': [
    'How is the teleconsult queue ordered?',
    'What if the patient has no video?',
    'What can a teleconsult not do?',
  ],
  'S-27-03': [
    'Is the session recorded?',
    'What consent is needed for a teleconsult?',
    'What should the note say about what I could not examine?',
  ],
  'S-27-04': [
    'Which drug categories can I not tele-prescribe?',
    'What are categories O, A and B?',
    'Does a telephone teleconsult change what I can prescribe?',
  ],
  'S-16-08': [
    'What is PvPI and what must I report?',
    'How soon must an ADR be reported?',
    'Does reporting add the allergy to the patient record?',
  ],
  // ── Stroke
  'S-18-01': [
    'Which sites are active tonight?',
    'What does a dimmed wall mean?',
  ],
  'S-18-03': [
    'What makes a spoke "not ready"?',
    'Does a readiness flag stop an activation?',
    'Where does an ambulance go if the nearest site is not ready?',
  ],
  'S-18-04': [
    'What does activation trigger?',
    'Can I activate without a CT?',
    'How do I de-activate a mimic?',
  ],
  'S-18-05': [
    'Which six fields actually change the decision?',
    'What if the LKW is unknown?',
    'Does the intake block the clock?',
  ],
  'S-18-06': [
    'What are the DTN and DIDO targets?',
    'Why is the DIDO clock projected to breach?',
    'How do I stamp the needle?',
    'Which clock is authoritative if two disagree?',
  ],
  'S-18-07': [
    'Why can I not move this task to In progress?',
    'Who owns the next action?',
    'Why is loading the ambulance blocked before the needle?',
  ],
  'S-18-08': [
    'Which timestamp source wins?',
    'Can I correct a stamped event?',
    'What happens to the intervals when I amend a timestamp?',
  ],
  'S-18-09': [
    'What is the paging escalation ladder?',
    'What if nobody acknowledges?',
    'Does the escalation ladder run on its own?',
  ],
  'S-18-10': [
    'How is the telestroke queue ranked?',
    'What is the response target?',
    'What happens to a request outside the window?',
  ],
  'S-18-11': [
    'What does the session record?',
    'How do I share imaging in-session?',
    'What if the patient declines recording?',
  ],
  'S-18-12': [
    'Can NIHSS be scored over video?',
    'What if an item is not testable?',
    'Why is an untested item not scored zero?',
  ],
  'S-18-13': [
    'What do I do first if there is no neurologist here?',
    'How do I request the hub?',
    'What if the CT will not upload?',
    'Can I activate offline?',
  ],
  'S-18-14': [
    'What are your views on this scan?',
    'What does this model detect and not detect?',
    'What does G3 confirm required mean?',
    'Why is ICH shown as an explicit no?',
  ],
  'S-18-15': [
    'How is ASPECTS scored?',
    'Is my adjustment kept alongside the model score?',
    'What does a score below 6 mean for thrombectomy?',
  ],
  'S-18-16': [
    'What is a target mismatch profile?',
    'What are the core and penumbra thresholds?',
    'Why are core and penumbra on one axis?',
  ],
  'S-18-17': [
    'What is the protocol if BP is above 185/110?',
    'Can I proceed with an uncertain DOAC history?',
    'Does the cost block treatment?',
    'Who does the second dose check?',
  ],
  'S-18-18': [
    'What are the EVT selection criteria?',
    'How do I record a disagreement?',
    'Does recording a disagreement block the decision?',
  ],
  'S-18-19': [
    'What does single-act reservation hold?',
    'What happens if one resource becomes unavailable?',
    'What happens if one of the four resources is lost?',
  ],
  'S-18-21': [
    'What are your views on this scan?',
    'Why is this a P1?',
    'What would make thrombolysis unsafe here?',
    'What is the model and how sure is it?',
  ],
  'S-18-20': [
    'What is mRS and when is it collected?',
    'Which registry does this export to?',
    'What is exported to the registry, and is it audited?',
  ],

  // The two full-page assistants. Without their own lists they offered the
  // generic three, on the one screen whose entire job is the conversation.
  'S-28-02': [
    'What can you actually see about this patient?',
    'How do I add an addendum to a signed note?',
    'Why was this result ranked first?',
    'What will you refuse to answer?',
  ],
  'S-28-09': [
    'What are your views on this scan?',
    'What is the door-to-needle target here?',
    'Why was this case ranked above the other one?',
    'What blocks thrombolysis?',
  ],
}

/** A screen's own documentation prompts. The bubble composes these with the record's — see `suggestionsFor`. */
export function promptsFor(screenId: string): string[] {
  return SCREEN_PROMPTS[screenId] ?? []
}

// ─────────────────────────────────────────────────────── The answer corpus

/**
 * The canonical example from §6.1's own wireframe: "how do I add an addendum"
 * answered with two citations, one a compliance obligation and one a screen
 * specification.
 */
const ADDENDUM: AssistantAnswer = {
  kind: 'cited',
  body:
    'A signed clinical entry is never edited. To change or add to one, open it and use **Addendum** — the original and the addendum both remain visible and are separately attributed, each with its own author and timestamp.\n\nAdding an addendum needs the `amend` capability, which is granted separately from `write`. If the Addendum action is absent on a signed note, you hold `write` but not `amend`; your medical superintendent grants it.',
  citations: [
    { n: 1, label: 'A signed record is never edited — only amended', source: 'CMP-NABH-10' },
    { n: 2, label: 'Consultation note — LOCKED state and Addendum action', source: 'S-06-03 · M-06.10' },
    { n: 3, label: 'amend is a distinct capability from write', source: '§3.2 verb matrix' },
  ],
  band: 'HIGH',
}

const SIGN_DISABLED: AssistantAnswer = {
  kind: 'cited',
  body:
    'Sign stays disabled until three things are true:\n\n1. Every required field is valid.\n2. **Every AI-drafted block has a recorded disposition** — Accept, Accept with edits, or Reject. Only sections the scribe drafted count; what you dictated or typed yourself needs no decision. A drafted section left undecided keeps Sign disabled, and a LOW-confidence section cannot be accepted until you expand it.\n3. The banned-abbreviation check has cleared.\n\nThe screen tells you which of the three is outstanding. If the count says "3 items need attention", focus moves to the first one.',
  citations: [
    { n: 1, label: 'The page’s primary action stays disabled until every G2 item has a disposition', source: '§4.4 gate ladder · G2' },
    { n: 2, label: 'LOW is delivered collapsed; acceptance blocked until expanded', source: '§4.5 confidence bands' },
    { n: 3, label: 'Medication orders legible, complete, no banned abbreviations', source: 'CMP-NABH-05' },
  ],
  band: 'HIGH',
}

const HARD_STOP_OVERRIDE: AssistantAnswer = {
  kind: 'cited',
  body:
    'A hard stop is a **deterministic rule**, not a model output — it fires identically when the AI is switched off, because the static interaction and allergy tables are never fully off.\n\nTo proceed past one you need all of:\n\n• a stated reason, from the fixed list or free text;\n• **a second consultant’s authentication** at the dialog — not yours again;\n• both identities are recorded against the prescription.\n\nThe override emits `AI.SAF.HARD_STOP_OVERRIDDEN` and is reviewed within 24 hours. Accepting one of the offered alternatives instead needs no override.',
  citations: [
    { n: 1, label: 'Override of a hard stop requires reason and a second qualified user', source: '§4.4 gate ladder · G4' },
    { n: 2, label: 'Hard stop is deterministic; static interaction tables never fully off', source: 'AI-205 · §4.2' },
    { n: 3, label: 'Prescription Writer — Override hard stop action', source: 'S-06-07 · M-06.10' },
  ],
  band: 'HIGH',
}

const CRITICAL_RESULT: AssistantAnswer = {
  kind: 'cited',
  body:
    'A critical value interrupts a **named** clinician — not a pool and not a ward. That clinician must acknowledge it, and if the acknowledgement does not arrive inside the window the alert escalates to the next person on the rota.\n\nAcknowledging is not the same as acting. You are expected to document what you did in an addendum or a new note; the acknowledgement records only that you saw it.',
  citations: [
    { n: 1, label: 'Critical-value detection & escalation — rule-based thresholds, never fully off', source: 'AI-213 · §4.2' },
    { n: 2, label: 'Critical result acknowledgement — interrupts a named clinician', source: 'S-09-06 · M-09.10' },
    { n: 3, label: 'Review a result and act', source: 'Workflow W-06-3' },
  ],
  band: 'HIGH',
}

const ACUITY_SORT: AssistantAnswer = {
  kind: 'cited',
  body:
    'The list is ranked by predicted clinical acuity, not by appointment time. Each row carries a one-line reason chip saying why it sits where it does — for example "NEWS2 7, rising 4h".\n\nThe header always names the sort in use, and **the deterministic chronological sort is one click away**. If the ranking model is unavailable the list reverts to chronological order without re-ordering under you mid-scan.',
  citations: [
    { n: 1, label: 'Ranked list — always reversible to a deterministic sort', source: 'AIP-07 · §4.3' },
    { n: 2, label: 'Clinician worklist prioritisation — fallback is chronological with manual pinning', source: 'AI-613 · §4.2' },
    { n: 3, label: 'Worklist archetype — the current sort is always named in the header', source: 'ARC-01 · §10.1' },
  ],
  band: 'HIGH',
}

const MARK_SEEN: AssistantAnswer = {
  kind: 'cited',
  body:
    'Marking a patient seen records the time YOU reviewed them, and that timestamp becomes the cut-off for "what changed since I last saw them". Everything already on the record falls behind it, so the change badges clear.\n\nIt is not an acknowledgement and it is not a note. A critical result still needs its own acknowledgement from a named clinician, and anything you decided still needs documenting.\n\nIf you are offline it is held locally with a visible count and syncs when the connection returns — nothing typed or tapped is lost.',
  citations: [
    { n: 1, label: 'Acknowledging is not the same as acting', source: 'S-09-06 · M-09.10' },
    { n: 2, label: 'OFFLINE — what works, what is queued, what is blocked; typed content never lost', source: 'C-37 · §1.5' },
    { n: 3, label: 'Unreliable connectivity is normal, not exceptional', source: '§2.1 A9' },
  ],
  band: 'HIGH',
}

const ATTENTION_LIST: AssistantAnswer = {
  kind: 'cited',
  body:
    'Four things put a patient on that list, and they are ranked in this order:\n\n• **Critical lab report identified** — a value past a rule-based threshold that no named clinician has acknowledged yet. This one escalates on a clock.\n• **New deterioration** — AI-201 scoring a rising risk from charted observations.\n• **Admission in progress** — a patient you admitted as Critical who is still waiting for a bed.\n• **Pending** — something waiting on you rather than on the patient: a note needing your signature, or a score the model could not produce.\n\nThe list is capped at five. Anything below the cut is on the Inpatients screen, one tap away in the nav.',
  citations: [
    { n: 1, label: 'Deterioration risk — abstains below the vitals-recency floor', source: 'AI-201 · §4.2' },
    { n: 2, label: 'Critical values interrupt a NAMED clinician, not a pool', source: 'AI-213 · §4.2' },
    { n: 3, label: 'Needs-attention pinned at the top with reason chips', source: 'S-06-01 · M-06.10' },
  ],
  band: 'HIGH',
}

const BREAK_GLASS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Break-glass is for when you hold the capability but have **no care relationship** with the patient — a remote on-call reading a chart at another site, for instance.\n\nYou are not refused. You state a reason, you proceed, and the access is logged and reviewed within 24 hours. The patient’s record shows an amber banner while you are in it.\n\nThe reason this exists rather than a refusal: an authorization model that can block resuscitation is the wrong model.',
  citations: [
    { n: 1, label: 'Break-glass proceeds rather than refusing; reason mandatory', source: 'GP-11 · §6' },
    { n: 2, label: 'Break-glass access request', source: 'S-02-05 · M-02.10' },
    { n: 3, label: 'An authorization model that can block resuscitation is the wrong model', source: 'DD-014 · §3.2' },
  ],
  band: 'HIGH',
}

const ABDM_PUBLISH: AssistantAnswer = {
  kind: 'cited',
  body:
    'Signing queues a FHIR R4 bundle to ABDM as the health information provider. Five record types publish: OPConsultation, DiagnosticReport, Prescription, DischargeSummary and ImmunizationRecord.\n\nTwo things worth knowing:\n\n• A publish failure **never** blocks or alters the clinical record. It lands in the publish-failure queue, visible and retryable.\n• Your HPR number goes on every published prescription.',
  citations: [
    { n: 1, label: 'HIP publish of 5 record types', source: 'CMP-ABDM-03' },
    { n: 2, label: 'Publish failures must be visible and retryable', source: 'CMP-ABDM-04' },
    { n: 3, label: 'HPR ID on every prescription', source: 'CMP-ABDM-07' },
  ],
  band: 'HIGH',
}

const LEAF_CODE: AssistantAnswer = {
  kind: 'cited',
  body:
    'A leaf code is the most specific code in its branch — one with no children. `J18.9` is a leaf; `J18` is the category above it.\n\nThe coding assistant proposes leaf codes and **blocks parent-only ones**, because a category code will not group for a claim and will not satisfy a coder audit. Manual search is always available if the suggestion is wrong.',
  citations: [
    { n: 1, label: 'Blocks parent-only codes; manual search always available', source: 'AI-501 · M-06.5' },
    { n: 2, label: 'Problem & code field — SNOMED plus ICD-10 leaf only', source: 'S-06-03 field 3' },
  ],
  band: 'HIGH',
}

const DTN_TARGETS: AssistantAnswer = {
  kind: 'cited',
  body:
    'The network runs to these targets:\n\n• **Door → CT start** 25 min\n• **CT → AI result** 5 min\n• **CT → read** 20 min\n• **Door → needle (DTN)** 60 min\n• **Door-in → door-out (DIDO)** 60 min at a spoke\n• **Groin puncture** 90 min\n\nEvery interval names who owns the next action. A projected breach is captured with a **structured reason at the moment of breach**, not reconstructed at audit — which is the whole point of the screen.',
  citations: [
    { n: 1, label: 'Live Case Clock — intervals, targets and owners', source: 'S-18-06 · M-18.10' },
    { n: 2, label: 'Capture breach reason at the moment of breach', source: 'S-18-06 actions' },
    { n: 3, label: 'Pathway & protocol adherence monitoring', source: 'AI-303 · §4.2' },
  ],
  band: 'HIGH',
}

const CLOCK_AUTHORITY: AssistantAnswer = {
  kind: 'cited',
  body:
    'The **server clock is authoritative**, and the event stream is append-only. Local device times are reconciled against the server, never trusted.\n\nWhere two sources disagree — a triage entry, an ambulance handover form, a DICOM header — the reconciliation screen shows all of them and which one won. Corrections are audited amendments, never overwrites.\n\nThis matters because a disputed door time is a disputed door-to-needle.',
  citations: [
    { n: 1, label: 'Local times reconciled against the server clock, never trusted', source: 'DD-012' },
    { n: 2, label: 'Event Stamping & Timestamp Reconciliation', source: 'S-18-08 · M-18.10' },
    { n: 3, label: 'A closed case is read-only; corrections are audited amendments', source: 'S-18-06 LOCKED state' },
  ],
  band: 'HIGH',
}

const BP_PROTOCOL: AssistantAnswer = {
  kind: 'cited',
  body:
    'Blood pressure above 185/110 blocks thrombolysis, and the item unblocks **only when a reading below threshold is documented** — not when someone asserts it has been treated.\n\nThe treat-to-target sub-flow on the screen carries the departmental protocol, and re-measurement is recorded against the case clock so the delay is visible.\n\nThis is a process answer. For the drug and dose, the screen’s own dosing panel owns that decision under its own check.',
  citations: [
    { n: 1, label: 'BP gate with its treat-to-target sub-flow', source: 'S-18-17 · M-18.10' },
    { n: 2, label: 'Thrombolysis eligibility criteria and consequences', source: 'S-18-17 Z5 items' },
  ],
  band: 'MED',
}

const COST_NEVER_BLOCKS: AssistantAnswer = {
  kind: 'cited',
  body:
    'No. The cost panel is **display only and does not block**. The primary action reads "Treat now, authorize in parallel", and taking it is audited.\n\nThe reasoning is stated as a design principle: in India, settling money is the commonest non-clinical cause of treatment delay, so pre-authorisation runs alongside the clinical pathway and never on its critical path.',
  citations: [
    { n: 1, label: 'Cost & coverage — display only, does not block', source: 'S-18-17 Z5' },
    { n: 2, label: 'Treat now, authorize in parallel', source: 'S-18-17 actions' },
    { n: 3, label: 'Tenecteplase ₹42,000 · PM-JAY package-inclusive', source: 'SD-M-07 · §8.4' },
  ],
  band: 'HIGH',
}

const SPOKE_FIRST_STEPS: AssistantAnswer = {
  kind: 'cited',
  body:
    'One action does both: **Activate & request hub**. It starts the case clock and raises the telestroke request together, and it is always enabled — it is never gated on the AI or on the network.\n\nThen answer the six questions. Not sixty; the hub collects the rest.\n\nIf the CT will not upload, it uploads progressively and the decision does not wait on full resolution. And the phone path is always there — calling the hub is a first-class route, never removed.',
  citations: [
    { n: 1, label: 'ACTIVATE & REQUEST HUB — largest target, always enabled', source: 'S-18-13 actions' },
    { n: 2, label: 'Six fields, not sixty', source: 'S-18-13 · M-18.10' },
    { n: 3, label: 'The phone is always a path — never remove it', source: 'S-18-13 Call hub' },
    { n: 4, label: 'Offline is the expected state at a spoke', source: 'S-18-13 OFFLINE state' },
  ],
  band: 'HIGH',
}

const IMAGING_MODEL_LIMITS: AssistantAnswer = {
  kind: 'cited',
  body:
    'The card names `lvo-det v4.2.1` and its gate is **G3 — confirm required**. It prioritises and notifies. **It never diagnoses.**\n\nWhat it reports: intracranial haemorrhage present or absent, large-vessel occlusion and its location, an ASPECTS estimate, and the hyperdense vessel sign.\n\nWhat it does not do reliably: posterior circulation occlusion, and it loses sensitivity with motion artefact or on scanners below 16 slices. The explainability drawer carries the validation population and the known failure modes.',
  citations: [
    { n: 1, label: 'Large-vessel-occlusion detection — G3, radiologist/neurologist read is the fallback', source: 'AI-404 · §4.2' },
    { n: 2, label: 'The card must name model@version', source: 'S-18-14 drawing notes' },
    { n: 3, label: 'Limits & provenance panel', source: 'C-42 panel 4 · §4.7' },
  ],
  band: 'HIGH',
}

const SINGLE_ACT_RESERVATION: AssistantAnswer = {
  kind: 'cited',
  body:
    'One action holds four resources **atomically**: the ambulance, the cath lab, the anaesthetist and the neuro-ICU bed. Either all four are held or none is — a transfer with three of the four is not a transfer.\n\nIf one becomes unavailable while you are deciding, the whole reservation is refused with the unavailable resource named, rather than partially committing you.',
  citations: [
    { n: 1, label: 'Single-act reservation must hold a bed, a cath lab and an ambulance atomically', source: 'DD-012' },
    { n: 2, label: 'Transfer, DIDO Clock & Single-Act Reservation', source: 'S-18-19 · M-18.10' },
  ],
  band: 'HIGH',
}

const ASSISTANT_SELF: AssistantAnswer = {
  kind: 'cited',
  body:
    'I answer questions about **process, policy and how this product works** — and only from documentation that exists, with the source cited. If nothing relevant is retrieved I say so rather than guessing.\n\nThree things I will not do:\n\n• Answer a clinical question. Those route to the capability that owns them, under its own human gate.\n• Show you a patient you have not opened.\n• Extrapolate a policy this hospital has not written.\n\nNo task in this product requires me to complete. The static help centre and a support contact are always available.',
  citations: [
    { n: 1, label: 'Six guardrails — never clinical, grounded or silent, capability-scoped', source: '§6.1' },
    { n: 2, label: 'No task anywhere in the product may require the assistant to complete', source: '§6.1 guardrail 6' },
  ],
  band: 'HIGH',
}

const CO_SIGN: AssistantAnswer = {
  kind: 'cited',
  body:
    'A resident holds `note.write` but not `note.sign` for the classes that require a consultant, so their entries are saved and land in your co-sign queue marked **Co-sign pending**. The queue runs to a 24-hour target.\n\nCountersigning a care plan is an accreditation requirement, not a courtesy. You can co-sign, or open the entry and add your own addendum where you disagree — the original stays visible and separately attributed either way.',
  citations: [
    { n: 1, label: 'Care plan documented and countersigned', source: 'CMP-NABH-03' },
    { n: 2, label: 'P-05 holds note.write but not note.sign', source: 'M-06.2' },
    { n: 3, label: 'Co-Sign & Amendment Queue', source: 'S-06-09 · M-06.10' },
  ],
  band: 'HIGH',
}

const BANNED_ABBREVIATIONS: AssistantAnswer = {
  kind: 'cited',
  body:
    'The check runs **on blur**, not on every keystroke, and banned abbreviations are rejected rather than warned about.\n\nThe common offenders: `OD` (write "once daily"), `U` or `IU` (write "units"), `cc` (write "mL"), a trailing zero after a decimal point, and `µg` (write "mcg"). Each rejection tells you what to write instead.',
  citations: [
    { n: 1, label: 'Medication orders legible, complete, no banned abbreviations', source: 'CMP-NABH-05' },
    { n: 2, label: 'Banned-abbreviation & documentation-quality check — checked on blur', source: 'AI-114 · M-06.5' },
  ],
  band: 'HIGH',
}

const TELE_CATEGORIES: AssistantAnswer = {
  kind: 'cited',
  body:
    'The Telemedicine Practice Guidelines 2020 split prescribable drugs into three lists and one prohibition:\n\n• **List O** — over-the-counter and safe on any consultation mode.\n• **List A** — permitted on a first video teleconsult, or on a re-consult for the same condition.\n• **List B** — permitted only as an add-on to an existing prescription for the same condition.\n• **Prohibited list** — never by telemedicine, which includes Schedule X and narcotics.\n\nThe gate on the tele-prescription screen is **hard-coded and never AI-decided**, and it stays enforced when the model is off.',
  citations: [
    { n: 1, label: 'Teleconsult prescribing categories (O / A / B) and prohibited list', source: 'CMP-DRUG-06' },
    { n: 2, label: 'Tele-prescription category gate — hard-coded prohibited list, never off', source: 'AI-310 · §4.2' },
  ],
  band: 'HIGH',
}

const DISCHARGE_PREDICTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'The board is computed at 07:00 so the day can be planned rather than discovered at 16:00. It ranks likelihood of discharge today and names the blockers for each patient.\n\nSeparately, a financial-clearance readiness signal shows whether the money will be settled in time — a TPA approval still pending is the commonest reason a medically fit patient waits.\n\nIt is a prediction, at G1. Nothing discharges automatically; a clinician still marks the patient fit.',
  citations: [
    { n: 1, label: 'Discharge-today prediction — clinician-flagged discharges only is the fallback', source: 'AI-610 · §4.2' },
    { n: 2, label: 'Discharge financial clearance readiness', source: 'AI-514 · §4.2' },
    { n: 3, label: 'Discharge board', source: 'S-13-01 · M-13.10' },
  ],
  band: 'HIGH',
}

const MCCD: AssistantAnswer = {
  kind: 'cited',
  body:
    'The medical certificate of cause of death uses Form 4 for an institutional death and Form 4A otherwise, and the cause is recorded as a **sequence**, not a list:\n\n• **Part I(a)** the immediate cause, then (b) and (c) the antecedent causes leading to it, each one caused by the line below.\n• **Part II** other significant conditions contributing but not in the sequence.\n\nRegistration is with the civil registration system. If the death is medico-legal, police intimation and the MLC docket come first and the body is not released until that is acknowledged.',
  citations: [
    { n: 1, label: 'Birth & death registration (CRS), MCCD Form 4 / 4A', source: 'CMP-STAT-03' },
    { n: 2, label: 'MLC, police intimation with acknowledgement', source: 'CMP-STAT-01' },
    { n: 3, label: 'Death, MCCD & Body Handover', source: 'S-13-06 · M-13.10' },
  ],
  band: 'MED',
}

const SCRIBE_TRANSCRIPT: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes. The **raw transcript is retained verbatim**, and each drafted sentence links back to the transcript span behind it — that span is what the Why? drawer shows.\n\nIf the speech service drops mid-consultation, every AI affordance is hidden rather than greyed out, and the sections collapse to plain typing. Nothing you have already dictated is lost, and typing is always available anyway.',
  citations: [
    { n: 1, label: 'Ambient scribe — raw transcript retained verbatim; typing always available', source: 'AI-101 · M-06.5' },
    { n: 2, label: 'Explainability — the transcript span behind each sentence', source: 'S-06-03 AI touchpoints' },
    { n: 3, label: 'AI-OFF — every affordance hidden, not greyed', source: '§1.5' },
  ],
  band: 'HIGH',
}

const ORDER_SET_GOVERNANCE: AssistantAnswer = {
  kind: 'cited',
  body:
    'A personal order set is yours to draft and change freely. Promoting one to facility-wide is a **governance act**: it acquires a named owner and a review date, and it needs the facility administrator.\n\nThat asymmetry is deliberate. A personal set that is wrong affects your patients; a facility-wide set that is wrong affects everyone’s, and someone has to be accountable for it by name.',
  citations: [
    { n: 1, label: 'Facility-wide promotion is a governance act with a named owner and a review date', source: 'Workflow W-06-4 s3' },
    { n: 2, label: 'Template & Order-Set Manager', source: 'S-06-10 · M-06.10' },
  ],
  band: 'HIGH',
}

const DUPLICATE_TEST: AssistantAnswer = {
  kind: 'cited',
  body:
    'The flag means the same test was resulted recently enough that a repeat is unlikely to change management on the current trajectory. The row tells you the prior value, when it was resulted, and the basis of the flag.\n\nIt is a **G2 suggestion, not a block**. You can accept it, edit the order, or reject it — and rejecting requires a reason from the fixed list, which is how the stewardship team learns where the rule is wrong.',
  citations: [
    { n: 1, label: 'Duplicate & low-value test detection', source: 'AI-304 · §4.2' },
    { n: 2, label: 'Rejected requires a reason from the fixed five', source: '§4.6 dispositions' },
  ],
  band: 'HIGH',
}

const OFFLINE_BEHAVIOUR: AssistantAnswer = {
  kind: 'cited',
  body:
    'Unreliable connectivity is treated as normal, not exceptional. When the network drops, a strip tells you three things: what still works, what is queued, and what is blocked — plus a pending-sync count.\n\n**Typed content is never lost.** On an authoring screen the note queues locally and Sign is offered as "will sign when reconnected". At a spoke, offline is the expected state, so activation and the six fields capture locally and the phone path is offered prominently.',
  citations: [
    { n: 1, label: 'Offline strip — what works, what is queued, what is blocked', source: 'GP-12 · §6' },
    { n: 2, label: 'Unreliable power and connectivity is normal, not exceptional', source: '§2.1 A9 · DD-015' },
    { n: 3, label: 'OFFLINE is the expected state at a spoke', source: 'S-18-13' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-06 · the workspace

const LEAVE_COVER: AssistantAnswer = {
  kind: 'cited',
  body:
    'Nothing reassigns your list on its own. Leave and session blocks are recorded on **Leave, Block & Override**, and blocking a session does not cancel the patients booked into it — it surfaces them, before the block is made, and someone decides where each one goes.\n\nAI-623 finds coverage gaps in the roster at G2, so it proposes and you dispose; the manual roster stays the fallback. Cover for an inpatient list is handed over in a note, not by a setting.',
  citations: [
    { n: 1, label: 'Blocking a session surfaces the booked patients rather than cancelling them', source: 'S-05-05 · M-05.10' },
    { n: 2, label: 'Roster optimisation & coverage-gap detection — fallback is a manual roster', source: 'AI-623 · §4.2' },
    { n: 3, label: 'Ambient scribe — ward round, handover & intra-op', source: 'AI-102 · §4.2' },
  ],
  band: 'MED',
}

const UNCERTAIN_CODE: AssistantAnswer = {
  kind: 'cited',
  body:
    'There is no code for “uncertain”. Code what the record actually supports: AI-501 proposes leaf codes from what you documented and **blocks parent-only ones**, and manual search is always there when the suggestion is wrong.\n\nWhere the coded diagnosis is not carried by the evidence in the note, AI-204 flags the mismatch at G1 — it notices, you may ignore it, and coder review downstream remains the fallback. A working diagnosis belongs in the note in words; the code follows the documentation.',
  citations: [
    { n: 1, label: 'Blocks parent-only codes; manual search always available', source: 'AI-501 · M-06.5' },
    { n: 2, label: 'Diagnosis–evidence consistency check — fallback is coder review downstream', source: 'AI-204 · §4.2' },
    { n: 3, label: 'Problem List & Diagnosis Coding', source: 'S-06-05 · M-06.10' },
  ],
  band: 'MED',
}

const TIMELINE: AssistantAnswer = {
  kind: 'cited',
  body:
    'It carries the whole record held here for this patient, in time order and unsummarised. Today is open and every earlier day folds behind one line — nothing is truncated, it is folded.\n\nThe filters are by entry type: notes, results, medication, orders, imaging and observations. There is no per-episode filter; an episode is read from its own encounter. This is the screen the chart summary points at when it says the unsummarised record is one click away.',
  citations: [
    { n: 1, label: 'The whole record, in time order, unsummarised', source: 'S-06-06 · M-06.10' },
    { n: 2, label: 'Chart summarisation — fallback is the chronological record, unsummarised', source: 'AI-105 · §4.2' },
  ],
  band: 'HIGH',
}

const AI_BADGE: AssistantAnswer = {
  kind: 'cited',
  body:
    'It means the AI touched that entry and a human disposed of it. The words “AI-assisted” are **disclosure, not credit** — every entry carrying them has a recorded human disposition behind it, and the entry is attributed to the person who signed it.\n\nOpen the entry and the Why? drawer names the capability, the model and version, the confidence band and the evidence used. No G2-or-above output is persisted without a recorded disposition, so nothing here was written by a model alone.',
  citations: [
    { n: 1, label: 'Entries carry the word “AI-assisted”; every one has a recorded human disposition', source: 'S-06-06 · M-06.10' },
    { n: 2, label: 'No G2-or-above AI output is persisted without a recorded disposition', source: '§4.4 gate ladder' },
    { n: 3, label: 'Every AI-assisted entry carries the model and the gate it passed under', source: '§4.7 provenance' },
  ],
  band: 'HIGH',
}

const NLEM_SUBSTITUTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'It is a rule, not a model. Where the drug you picked has an NLEM-listed equivalent, CMP-DRUG-03 requires the substitution prompt, and the DPCO ceiling price is shown rather than a retail price.\n\nSubstitution is permitted by default and is yours to decline on the line — the prompt does not change the prescription by itself. The pricing is disclosure only; it never blocks a prescription.',
  citations: [
    { n: 1, label: 'DPCO ceiling and NLEM flags — a substitution prompt when an NLEM equivalent exists', source: 'CMP-DRUG-03' },
    { n: 2, label: 'NLEM status and DPCO ceiling shown on the prescription line', source: 'S-06-07 · M-06.10' },
  ],
  band: 'HIGH',
}

const PRESCRIPTION_PRINT: AssistantAnswer = {
  kind: 'cited',
  body:
    'Signing is what prints it. The prescription is committed with your name and HPR number, printed **bilingually on A5**, sent to the pharmacy dispensing queue, and queued to publish to ABDM as a Prescription record.\n\nSigning is irreversible — a signed prescription is amended, never edited. A failure to publish does not block or alter what was printed; it lands in the retryable publish-failure queue.',
  citations: [
    { n: 1, label: 'HPR ID on every clinician — printed on every prescription', source: 'CMP-ABDM-07' },
    { n: 2, label: 'Sign, print A5 bilingual, pharmacy dispensing queue', source: 'S-06-07 · M-06.10' },
    { n: 3, label: 'Publish failures must be visible and retryable', source: 'CMP-ABDM-04' },
  ],
  band: 'HIGH',
}

const PATIENT_INSTRUCTIONS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Three channels, chosen per encounter: a printed A5 in English and the patient’s language, the patient app in their language, and SMS. **The SMS carries a pointer only, never the content.**\n\nThe language is the patient’s, not yours — CMP-DPDP-02 requires patient-facing content in the language they read. AI-110 covers 22 languages with translation and name transliteration; English only, with the limitation stated, is the fallback.',
  citations: [
    { n: 1, label: 'Consent notice and patient-facing content in the patient’s language', source: 'CMP-DPDP-02' },
    { n: 2, label: 'Translation & name transliteration (22 languages)', source: 'AI-110 · §4.2' },
    { n: 3, label: 'Print, patient app and SMS channels', source: 'S-06-08 · M-06.10' },
  ],
  band: 'HIGH',
}

const OWN_WORDING: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes, and it is the design rather than a courtesy. AI-111 rewrites into plain language at G2 and **your wording is retained alongside** — two columns, what you wrote and what the patient reads, not a rewrite that overwrites you.\n\nYour text stays in the record either way. If the rewrite is unavailable the fallback is your own wording, printed as written.',
  citations: [
    { n: 1, label: 'Patient-friendly instruction rewrite — fallback is the clinician’s own wording', source: 'AI-111 · §4.2' },
    { n: 2, label: 'The rewrite does not replace what you wrote; your wording stays in the record', source: 'S-06-08 · M-06.10' },
  ],
  band: 'HIGH',
}

const REVIEW_DATE: AssistantAnswer = {
  kind: 'cited',
  body:
    'A review date is what makes a shared set somebody’s responsibility. Every facility-wide order set and pathway carries a named owner and a date by which it must be looked at again; a personal set carries neither.\n\nThe catalogue opens on what is due — the soonest date, plus anything falling inside 90 days. A set past its date is listed as due rather than withdrawn: removing a pathway silently is worse than running a stale one.',
  citations: [
    { n: 1, label: 'Facility-wide promotion is a governance act with a named owner and a review date', source: 'Workflow W-06-4 s3' },
    { n: 2, label: 'The catalogue opens on the sets due for review', source: 'S-09-02 · M-09.10' },
    { n: 3, label: 'Template & Order-Set Manager', source: 'S-06-10 · M-06.10' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-08 · inpatient

const AI_ABSTAIN: AssistantAnswer = {
  kind: 'cited',
  body:
    'Because it could not produce a calibrated score for that patient, and a capability that cannot **shows AI-ABSTAIN rather than LOW**. AI-201 abstains below its vitals-recency floor — stale observations produce no score at all instead of a reassuring one.\n\nThe row still appears; it carries no risk figure and says why. Manual NEWS2 from the charted vitals is the fallback. It is the same rule the assistant follows: grounded or silent.',
  citations: [
    { n: 1, label: 'A capability that cannot produce a calibrated score shows AI-ABSTAIN, not LOW', source: '§4.5 confidence bands' },
    { n: 2, label: 'Deterioration risk (NEWS2+) — fallback is manual NEWS2 from charted vitals', source: 'AI-201 · §4.2' },
    { n: 3, label: 'Grounded or silent — an uncited answer is not rendered at all', source: '§6.1 guardrail 2' },
  ],
  band: 'HIGH',
}

const HANDOVER: AssistantAnswer = {
  kind: 'cited',
  body:
    'Handover is a note, not a button. AI-102 drafts from ward-round or handover dictation at G2 — you accept, edit or reject each block, and it is signed like any other entry, with your identity and registration number stamped on it rather than typed.\n\nMarking a patient seen is not a handover: it records when you last looked. A critical result still needs its own acknowledgement from a named clinician, whoever is holding the list.',
  citations: [
    { n: 1, label: 'Ambient scribe — ward round, handover & intra-op; fallback is typing manually', source: 'AI-102 · §4.2' },
    { n: 2, label: 'Every clinical entry carries author identity, registration number, date and time', source: 'CMP-NABH-11' },
    { n: 3, label: 'Critical values interrupt a NAMED clinician, not a pool', source: 'AI-213 · §4.2' },
  ],
  band: 'HIGH',
}

const ADMISSION_ASSESSMENT: AssistantAnswer = {
  kind: 'cited',
  body:
    'It starts at the admission timestamp and runs 24 hours — CMP-NABH-01. The screen carries the countdown and the worklist carries an overdue flag once it passes.\n\nComplete means the assessment itself, a disposition on **every** risk scale AI-211 scored — fall, pressure ulcer and VTE — and your attestation. The action stays disabled until all three are done.\n\nIf the window closes first, nothing is blocked: you still complete it, and the delay is recorded against the assessment rather than quietly absorbed.',
  citations: [
    { n: 1, label: 'Initial assessment within 24h of admission — a countdown, and an overdue flag', source: 'CMP-NABH-01' },
    { n: 2, label: 'Fall, pressure-ulcer & VTE risk — fallback is manual assessment scales', source: 'AI-211 · §4.2' },
    { n: 3, label: 'Completion is stamped; the delay is recorded', source: 'S-08-07 · M-08.10' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-09 · orders & results

const ORDER_SET_SCOPE: AssistantAnswer = {
  kind: 'cited',
  body:
    'To an encounter. A set is applied into the order basket, and the basket belongs to the encounter you have open — orders are placed against an encounter, never against a patient in general.\n\nA set’s scope is a different thing: **personal** or **facility-wide** says who may use it and who owns it, not which patient it applies to. AI-302 recommends at G2, so every line still arrives with Accept, Edit or Reject before it is committed.',
  citations: [
    { n: 1, label: 'One basket for everything a clinician can order, per encounter', source: 'S-09-01 · M-09.10' },
    { n: 2, label: 'Order-set & pathway recommendation — fallback is browsing the library', source: 'AI-302 · §4.2' },
    { n: 3, label: 'Order sets carry a scope, an owner and a review date', source: 'S-09-02 · M-09.10' },
  ],
  band: 'MED',
}

const ORDER_STATUS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Overdue means the order has not moved inside its expected window — 25 minutes since a phlebotomy order against a 30-minute target, for instance. The row names the blocking step, so “chasing · porter not yet assigned” tells you what is actually stuck.\n\nAI-308 does the chasing at G1 and the manual order status list is the fallback — this screen is that list underneath. Nothing closes an order on your behalf; the chase tells you where it is, it does not resolve it.',
  citations: [
    { n: 1, label: 'Order status & closed-loop chasing — fallback is a manual order status list', source: 'AI-308 · §4.2' },
    { n: 2, label: 'An order that has not moved inside its window is chased, with the blocking step named', source: 'S-09-03 · M-09.10' },
  ],
  band: 'HIGH',
}

const VOID_ORDER: AssistantAnswer = {
  kind: 'cited',
  body:
    '**The performing department.** Voiding is not deleting: the order stays visible on the encounter with your reason recorded against it, and the department that would have performed it is told.\n\nA reason is mandatory on cancel and the record keeps both the order and the void. It is the same rule as everywhere else here — a clinical entry is amended or annotated, never erased.',
  citations: [
    { n: 1, label: 'The order is voided, not deleted; the performing department is notified', source: 'S-09-03 · M-09.10' },
    { n: 2, label: 'A signed record is never edited — only amended', source: 'CMP-NABH-10' },
  ],
  band: 'HIGH',
}

const DELTA_CHECK: AssistantAnswer = {
  kind: 'cited',
  body:
    'A delta check compares this result with the same patient’s previous one and reports the **change**, not just the value — potassium 6.8 means one thing flat and another after a rise of 1.4 in nine hours.\n\nIt is AI-212 at G1, so it sits beside the numbers rather than in front of them, and the fallback is what the screen already shows: the reference range and the prior value. The narrative above it is AI-109 at G3 and enters the record only over a signature.',
  citations: [
    { n: 1, label: 'Result interpretation & delta check — fallback is reference ranges and prior value shown', source: 'AI-212 · §4.2' },
    { n: 2, label: 'Lab report narrative & interpretation draft — G3', source: 'AI-109 · §4.2' },
    { n: 3, label: 'Potassium 6.8 mmol/L, risen 1.4 in nine hours', source: 'Result R-88410' },
  ],
  band: 'HIGH',
}

const TREND_RANGE: AssistantAnswer = {
  kind: 'cited',
  body:
    'As far back as this record holds results for the same test on this patient. The chart plots the stored series and the values table restates it point for point — for the potassium here, five results across 19 to 21 September.\n\nWhere there is no prior value the chart says so rather than drawing a single point, and the delta check has nothing to compare against.',
  citations: [
    { n: 1, label: 'The series behind the chart, restated point for point', source: 'S-09-05 · M-09.10' },
    { n: 2, label: 'Potassium series, 19–21 Sep, five values', source: 'Result R-88410' },
    { n: 3, label: 'Result interpretation & delta check — fallback is reference ranges and prior value shown', source: 'AI-212 · §4.2' },
  ],
  band: 'HIGH',
}

const STEWARDSHIP_REJECTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'To the stewardship team, as a signal. Rejecting a flag needs a reason from the fixed five, and those reasons are the only evidence that tells stewardship the **rule** is wrong rather than the clinician. An accept teaches nothing.\n\nThe disposition is recorded against you and the order either way, and the retrospective stewardship round remains the fallback. AI-304 is G2 throughout: it flags, it never cancels an order.',
  citations: [
    { n: 1, label: 'Rejecting a flag requires a reason from the fixed five', source: 'S-09-08 · M-09.10' },
    { n: 2, label: 'Duplicate & low-value test detection — fallback is retrospective stewardship review', source: 'AI-304 · §4.2' },
    { n: 3, label: 'Rejected requires a reason from the fixed five', source: '§4.6 dispositions' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-13 · discharge & death

const DISCHARGE_SUMMARY_SIGN: AssistantAnswer = {
  kind: 'cited',
  body:
    'Three things. Every one of the six sections must be present and substantive — reason for admission, course in hospital, discharge diagnosis, discharge medication, follow-up, and when to come back. Every AI-106 draft must carry a disposition. And the attestation must be signed rather than clicked.\n\nAI-106 is G3 precisely because the summary enters the legal record and publishes to ABDM, so the primary action carries a signature block and fixed attestation wording.',
  citations: [
    { n: 1, label: 'Discharge summary draft — G3; fallback is a structured template, manually completed', source: 'AI-106 · §4.2' },
    { n: 2, label: 'Six required sections, blocked until complete', source: 'S-13-02 · M-13.10' },
    { n: 3, label: 'HIP publish of 5 record types, including DischargeSummary', source: 'CMP-ABDM-03' },
  ],
  band: 'HIGH',
}

const BILINGUAL: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes. It prints in English and in the patient’s own language, chosen on the screen — CMP-DPDP-02 requires patient-facing content in the language the patient reads, not the one you work in.\n\nAI-110 does the translation and name transliteration across 22 languages at G2; English only, with the limitation stated on the document, is the fallback. The same rule covers prescriptions, instructions and consent.',
  citations: [
    { n: 1, label: 'Consent notice and patient-facing content in the patient’s language', source: 'CMP-DPDP-02' },
    { n: 2, label: 'Translation & name transliteration (22 languages)', source: 'AI-110 · §4.2' },
    { n: 3, label: 'Prints in English and the patient’s language', source: 'S-13-02 · M-13.10' },
  ],
  band: 'HIGH',
}

const MED_REC: AssistantAnswer = {
  kind: 'cited',
  body:
    'The medicines the patient was on at admission against the medicines they will leave on, line by line. AI-306 proposes a match per row at G2, and AI-205 runs over the resulting list — a reconciliation that introduces an interaction is worse than none.\n\nEvery admission medicine must be accounted for. **Not carried forward is a decision, not an omission**: marking a line stopped needs a reason, and the screen will not complete while a stopped line has none.',
  citations: [
    { n: 1, label: 'Medication reconciliation matching — fallback is manual side-by-side comparison', source: 'AI-306 · §4.2' },
    { n: 2, label: 'Every admission medicine must be accounted for; a stopped line needs a reason', source: 'S-13-03 · M-13.10' },
    { n: 3, label: 'Drug interaction, allergy & contraindication check', source: 'AI-205 · §4.2' },
  ],
  band: 'HIGH',
}

const MLC_POLICE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Whenever the death is a medico-legal case. CMP-STAT-01 requires intimation **and an acknowledgement** — the police station, the docket and who acknowledged it are recorded, and the body is not released until that is on the record.\n\nIntimation alone is not enough: it leaves the release unlawful and the record unable to show who was told. Marking a death medico-legal is reversible before certification and not after, so mark it if in doubt.',
  citations: [
    { n: 1, label: 'MLC, police intimation with acknowledgement, wound certificate', source: 'CMP-STAT-01' },
    { n: 2, label: 'The acknowledgement unblocks the handover step', source: 'S-13-06 · M-13.10' },
    { n: 3, label: 'Medico-legal documentation completeness', source: 'AI-810 · §4.2' },
  ],
  band: 'HIGH',
}

const DEATH_CERTIFIER: AssistantAnswer = {
  kind: 'cited',
  body:
    'The clinician who verified the death signs it, and the certificate carries their name and registration number — stamped from the session, never typed. Verification, the time of death and who informed the family are recorded first, before the cause.\n\nThe cause goes on MCCD Form 4 for an institutional death, as a causal sequence. AI-810 checks the sequence reads as a chain and that the medico-legal steps are present; **it never fills the cause of death in for you**.',
  citations: [
    { n: 1, label: 'Every clinical entry carries author identity, registration number, date and time', source: 'CMP-NABH-11' },
    { n: 2, label: 'Birth & death registration (CRS), MCCD Form 4 / 4A', source: 'CMP-STAT-03' },
    { n: 3, label: 'AI-810 flags; it never fills the cause of death in', source: 'S-13-06 · M-13.10' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-05 · scheduling

const WAIT_PREDICTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'AI-607 predicts from the session rather than the patient: your position in the token queue and the mean consultation length for this clinician, against how far behind the session is already running.\n\nIt is **G0 — disclosure only**, never a dialog, because a predicted wait is not something you accept or reject. The fallback is position in the queue only: you still know you are fifth, you just stop knowing when.\n\nThe board view is what the waiting area and the front office read, so the patient sees the same figure you do.',
  citations: [
    { n: 1, label: 'OP queue wait-time prediction — G0; fallback is position in queue only', source: 'AI-607 · §4.2' },
    { n: 2, label: 'Predicts from the session, not from the individual patient’s complexity', source: 'S-05-03 · M-05.10' },
    { n: 3, label: 'Front-office queue & load forecast', source: 'AI-601 · §4.2' },
  ],
  band: 'HIGH',
}

const TOKEN_CALL: AssistantAnswer = {
  kind: 'cited',
  body:
    'Calling a token moves that patient to **In room** and records the time; the next token is the screen’s primary action, so the common case is one tap.\n\nToken order is the deterministic order for the queue, and the list is in time order by default. Nothing here reorders a patient without a reason printed on the row — the prediction changes the estimated wait, never the position.',
  citations: [
    { n: 1, label: 'Token order is the deterministic order; nothing reorders a patient without a reason', source: 'S-05-03 · M-05.10' },
    { n: 2, label: 'OP queue wait-time prediction — G0, disclosure only', source: 'AI-607 · §4.2' },
  ],
  band: 'HIGH',
}

const CLINIC_TEMPLATE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Edit the session — its start and finish, its slot length and its case mix — and give the change an effective date. **It does not move what is already booked.**\n\nA template is effective-dated master data: appointments made against the old pattern stay exactly where they are, and the new pattern applies from its date forward. That is why the confirmation reads “effective from 01-Oct-2026, existing bookings are untouched”. Moving a booked patient is a separate, deliberate act.',
  citations: [
    { n: 1, label: 'Effective-dated master data — changing a template does not rewrite booked appointments', source: 'S-05-04 · ARC-18' },
    { n: 2, label: 'Clinician capacity & template optimisation — fallback is manual template editing', source: 'AI-608 · §4.2' },
  ],
  band: 'HIGH',
}

const CAPACITY_SUGGESTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'Twelve weeks of actual session start and finish times, plus the did-not-attend rate for that session. From those AI-608 proposes a capacity change at G1 — that a clinic consistently finishing eighteen minutes early would take two more slots, for instance.\n\nIt observes the past, so a change in case mix makes it wrong until it has re-learned, and it does not know which overruns were worth having. Manual template editing is the fallback and nothing is applied without you.',
  citations: [
    { n: 1, label: 'Clinician capacity & template optimisation — fallback is manual template editing', source: 'AI-608 · §4.2' },
    { n: 2, label: 'Inputs: session start and finish times over 12 weeks, and the did-not-attend rate', source: 'S-05-04 · M-05.10' },
  ],
  band: 'MED',
}

const LEAVE_BLOCK: AssistantAnswer = {
  kind: 'cited',
  body:
    '**Fourteen days.** A block placed inside 14 days needs an administrator’s override, because patients are already booked into it; beyond that you place it yourself.\n\nBlocking never cancels anybody. The patients already booked into the session are listed inside the confirmation, before the block is made, and each one has to be moved or rebooked deliberately. A session nobody is booked into says so, and blocking it has no downstream effect.',
  citations: [
    { n: 1, label: 'A block inside 14 days needs an administrator’s override', source: 'S-05-05 · M-05.10' },
    { n: 2, label: 'Blocking surfaces the booked patients rather than cancelling them', source: 'S-05-05 · Leave, Block & Override' },
    { n: 3, label: 'Roster optimisation & coverage-gap detection', source: 'AI-623 · §4.2' },
  ],
  band: 'HIGH',
}

const REFERRAL_TRIAGE: AssistantAnswer = {
  kind: 'cited',
  body:
    'AI-609 reads the referral letter and proposes an urgency at G2 — **Urgent** within 48 hours, **Soon** within 2 weeks, **Routine** within 6 weeks. You accept, edit or reject it, and rejecting takes a reason.\n\nIt reads the letter only and has no access to the record at the referring practice, so a vaguely written referral triages low — a property of the letter rather than the patient. Manual triage stays on every row.\n\nThe referring doctor does not log in here; the decision and the booked slot are recorded on the referral.',
  citations: [
    { n: 1, label: 'Referral triage & routing — fallback is manual triage', source: 'AI-609 · §4.2' },
    { n: 2, label: 'Urgent 48 hours · Soon 2 weeks · Routine 6 weeks', source: 'S-05-06 · M-05.10' },
    { n: 3, label: 'P-44, the referring doctor — an inbound data source, not a portal user', source: 'S-05-06 personas' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-02 · access

const BREAK_GLASS_RECORD: AssistantAnswer = {
  kind: 'cited',
  body:
    'Your name, the reason you typed before the record rendered, the patient and the time — written synchronously as `ACCESS.BREAK_GLASS`. **If it cannot be written, the absence is itself an alert**; a break-glass that is not logged has not happened.\n\nWhile you are in the record an amber banner states that the access is logged and reviewed within 24 hours. AI-908 assists that review at G1 by finding the patterns worth looking at; manual log review is the fallback.',
  citations: [
    { n: 1, label: 'An access decision is written synchronously; the absence is itself an alert', source: 'DD-014 · §3.2' },
    { n: 2, label: 'Reason before render — logged and reviewed within 24 hours', source: 'S-02-05 · GP-10 / C-48' },
    { n: 3, label: 'Access-pattern anomaly & break-glass review assist — fallback is manual log review', source: 'AI-908 · §4.2' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-15 · imaging

const AI_OVERLAY: AssistantAnswer = {
  kind: 'cited',
  body:
    'The overlay draws where the model found something and names it — on a chest study, AI-402’s triage finding and what AI-408 says has changed since the prior film.\n\nYes, you can turn it off, and the control is deliberately prominent: **an overlay a reader cannot remove is a finding they cannot disagree with**, so the unmarked image is always one control away. The findings sit beside the image rather than on top of it, and at G3 nothing enters the report until a radiologist attests to it.',
  citations: [
    { n: 1, label: 'Chest X-ray triage — G3; fallback is the standard reporting queue', source: 'AI-402 · §4.2' },
    { n: 2, label: 'The unmarked image is always one control away', source: 'AIP-04 · S-15-04' },
    { n: 3, label: 'Prior-study comparison & change detection', source: 'AI-408 · §4.2' },
  ],
  band: 'HIGH',
}

const CRITICAL_FINDING_ESCALATION: AssistantAnswer = {
  kind: 'cited',
  body:
    'A critical imaging finding is escalated to a **named** clinician, never to a queue — a finding left in a report queue has not been communicated.\n\nYou record who you told, how, and what you said, and it is filed against the study and the patient record. If you cannot reach them, that is one of the channels: record it as unable to reach, and it escalates to the on-call.\n\nAI-407 detects the finding; the radiologist-initiated escalation call remains the fallback.',
  citations: [
    { n: 1, label: 'Critical-finding detection & escalation — fallback is a radiologist-initiated call', source: 'AI-407 · §4.2' },
    { n: 2, label: 'Who you told, how, and what you said — recorded against the study', source: 'S-15-06 · M-15.10' },
    { n: 3, label: 'Critical values interrupt a NAMED clinician, not a pool', source: 'AI-213 · §4.2' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-27 · telehealth

const TELE_QUEUE: AssistantAnswer = {
  kind: 'cited',
  body:
    'AI-613 ranks it at G0 — video-ready first, then scheduled time — and each row carries the reason it sits where it does. The deterministic sort, arrival time, is one click away and is what you get if the ranking is unavailable.\n\nA patient with no working video is not a failure: the consultation happens by telephone. The prescribing category gate then tightens, and the prescription screen enforces that rather than trusting anyone to remember it.',
  citations: [
    { n: 1, label: 'Clinician worklist prioritisation — G0; fallback is chronological with manual pinning', source: 'AI-613 · §4.2' },
    { n: 2, label: 'A telephone fallback is not a failure; the category gate is stricter for it', source: 'S-27-02 · M-27.10' },
    { n: 3, label: 'Tele-prescription category gate — hard-coded, never off', source: 'AI-310 · §4.2' },
  ],
  band: 'HIGH',
}

const TELE_LIMITS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Four things. It cannot palpate, percuss or auscultate; it cannot take a blood pressure or a temperature you can trust; it can assess a rash for appearance but not texture; and it cannot prescribe from the prohibited category list.\n\nOnly the last is enforced by the software. The first three are yours to remember, which is why **the note should say what you could not assess** as plainly as what you could.',
  citations: [
    { n: 1, label: 'What a teleconsult cannot do — the first three are yours to remember', source: 'S-27-03 · M-27.10' },
    { n: 2, label: 'Teleconsult prescribing categories (O / A / B) and prohibited list', source: 'CMP-DRUG-06' },
    { n: 3, label: 'Ambient scribe — consultation & teleconsult', source: 'AI-101 · §4.2' },
  ],
  band: 'HIGH',
}

const SESSION_RECORDING: AssistantAnswer = {
  kind: 'cited',
  body:
    'Only with consent, and the indicator is visible to everyone on the call for as long as it runs. Consent to the teleconsult and consent to recording are recorded separately, alongside the patient’s language.\n\nWhere recording is consented the **raw transcript is retained verbatim** and the session note is drafted from it. Where the patient declines, the transcript is not retained after the session — the note is, and the scribe simply does not run. Typing is always available.',
  citations: [
    { n: 1, label: 'Consent to the session and consent to recording are recorded separately', source: 'S-27-03 · M-27.10' },
    { n: 2, label: 'The recording indicator is visible to everyone on the call', source: 'S-18-11 · M-18.10' },
    { n: 3, label: 'Ambient scribe — raw transcript retained verbatim', source: 'AI-101 · M-06.5' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-16 · pharmacovigilance

const PVPI: AssistantAnswer = {
  kind: 'cited',
  body:
    'PvPI is the national pharmacovigilance programme, and CMP-DRUG-04 puts a reporting form on the prescription and the chart. **Suspected is enough** — you are not certifying causation, and a serious reaction is escalated to the monitoring centre within 15 days.\n\nAI-815 detects a signal at G1 — three urticarial reactions after a first co-amoxiclav dose in 90 days, for instance — but it only sees what was charted, and clinician-initiated reporting remains the main route.',
  citations: [
    { n: 1, label: 'ADR reporting — a PvPI form reachable from the prescription and the chart', source: 'CMP-DRUG-04' },
    { n: 2, label: 'ADR signal detection (PvPI) — fallback is clinician-initiated reporting', source: 'AI-815 · §4.2' },
    { n: 3, label: 'A serious reaction is escalated within 15 days', source: 'S-16-08 · M-16.10' },
  ],
  band: 'HIGH',
}

const ADR_CONSEQUENCE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes, immediately — and that is the part worth knowing before you submit. The allergy is added to the patient record, and prescribing that drug for them becomes a **hard stop** from then on, overridable only with a reason and a second consultant’s authentication.\n\nThe report itself goes to the ADR monitoring centre, with your narrative and attestation. A serious reaction is escalated within 15 days.',
  citations: [
    { n: 1, label: 'Submitting adds the allergy and makes future prescribing a hard stop', source: 'S-16-08 · M-16.10' },
    { n: 2, label: 'Override of a hard stop requires reason and a second qualified user', source: '§4.4 gate ladder · G4' },
    { n: 3, label: 'ADR reporting', source: 'CMP-DRUG-04' },
  ],
  band: 'HIGH',
}

// ───────────────────────────────── M-18 · stroke

const COMMAND_WALL: AssistantAnswer = {
  kind: 'cited',
  body:
    'The wall carries every active case in the network with its clock ring, each site and its resource state, and the inbound ambulances — three activations tonight, one transfer and one mimic.\n\nWhen it goes **stale** it dims and states its last-good time in large type: a wall showing confidently wrong data is worse than one showing none. With the AI off the clocks, targets and resource state are unaffected, because none of them is AI-derived.',
  citations: [
    { n: 1, label: 'Stroke network wall — cases, sites and inbound ambulances', source: 'S-18-01 · M-18.10' },
    { n: 2, label: 'STALE — past 2× the 5s refresh the wall dims and states its last-good time', source: 'S-18-01 · ARC-12' },
    { n: 3, label: 'Time-critical pathway detection — manual activation always present', source: 'AI-209 · §4.2' },
  ],
  band: 'HIGH',
}

const WALL_NO_BUBBLE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Because ARC-12 strips the shell: **Z5 only** — no facility switcher, no nav rail, no input affordances and no Z7b assistant bubble. The wall is read at three to four metres and runs unattended for a shift; there is nobody standing at it to type a question.\n\nOn a phone the same screen becomes the case rail with a large clock ring. The assistant is reached from the screens that own the work, which is where a question about a case is answerable anyway.',
  citations: [
    { n: 1, label: 'ARC-12 — Z5 only; no Z1, no Z2, no input affordances, no Z7b bubble', source: 'S-18-01 · §10.1' },
    { n: 2, label: 'Read at 3–4 metres, runs unattended for a shift', source: 'S-18-01 · M-18.10' },
    { n: 3, label: 'The assistant is never the only path', source: '§6.1 guardrail 6' },
  ],
  band: 'HIGH',
}

const SITE_READINESS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Ready means four things at once: a working CT with a radiographer on shift, a physician whose stroke competency is current within 12 months, a stroke bed or a transfer agreement, and bandwidth for a video teleconsult.\n\nA flag stops nobody working — **it changes where the ambulance goes**. Udumalpet has no CT at all, so every activation there routes out. The flags are AI-816 and AI-622 at G1; the training matrix and the maintenance schedule remain the authority.',
  citations: [
    { n: 1, label: 'What ready means, and how the flags are found', source: 'S-18-03 · M-18.10' },
    { n: 2, label: 'Training & competency gap detection', source: 'AI-816 · §4.2' },
    { n: 3, label: 'Equipment failure prediction — fallback is scheduled preventive maintenance', source: 'AI-622 · §4.2' },
  ],
  band: 'HIGH',
}

const ACTIVATION: AssistantAnswer = {
  kind: 'cited',
  body:
    'One tap starts six things: the case clock, with door time stamped from the server rather than a device; the team paged in parallel; the CT queue reordered; the case on the network wall; the activation order set offered; and pre-authorisation started off the critical path.\n\nNo CT is required — the button is never gated on the model, the network or a half-filled form. De-activating a mimic is normal, roughly one activation in three at a spoke, and it keeps the record and the reason.',
  citations: [
    { n: 1, label: 'Code Stroke Activation — what one tap triggers', source: 'S-18-04 · M-18.10' },
    { n: 2, label: 'The one-tap manual activation button is always present and never gated on the model', source: 'AI-209 · §4.2' },
    { n: 3, label: 'De-activation keeps the record and its reason', source: 'S-18-04 · Why panel' },
  ],
  band: 'HIGH',
}

const LKW_UNKNOWN: AssistantAnswer = {
  kind: 'cited',
  body:
    'Answer it UNKNOWN. Every item on the intake and the eligibility checklist can be answered UNKNOWN, and each one **shows its consequence** rather than refusing to continue — that is what makes the screen usable by a general physician at 02:00.\n\nLast known well drives the 4.5-hour window, so an unknown one is the difference between a straightforward decision and an imaging-selected one; extended-window selection may still apply. The case clock is unaffected — it runs from activation regardless.',
  citations: [
    { n: 1, label: 'Every item answerable UNKNOWN, each unknown showing its consequence', source: 'S-18-17 · M-18.10' },
    { n: 2, label: 'Time from LKW < 4.5h — the thrombolysis window', source: 'S-18-17 · Z5 criteria' },
    { n: 3, label: 'Windows are computed from last-known-well against a 4.5-hour window', source: 'S-18-10 · M-18.10' },
  ],
  band: 'HIGH',
}

const INTAKE_CLOCK: AssistantAnswer = {
  kind: 'cited',
  body:
    'No. The clock starts at activation, stamped from the server, and the intake happens alongside it — nothing on the form gates the pathway, the paging or the CT.\n\nThat is why it asks six questions rather than sixty: the six that actually change the decision. The hub collects the rest afterwards, and AI-112 lifts what it can from the triage text already written, so the same fact is not typed twice.',
  citations: [
    { n: 1, label: 'Activation Intake — the six things that actually change the decision', source: 'S-18-05 · M-18.10' },
    { n: 2, label: 'The case clock starts at activation; door time is stamped from the server', source: 'S-18-04 · M-18.10' },
    { n: 3, label: 'Structured extraction from free text — fallback is manual structured entry', source: 'AI-112 · §4.2' },
  ],
  band: 'HIGH',
}

const STAMPING: AssistantAnswer = {
  kind: 'cited',
  body:
    'Focus the event and press `e`, or tap it — stamping is one keystroke by design, because it happens while your hands are busy. The needle is one of four stampable events, with CT done, door-out and groin puncture.\n\nThe stream is **append-only: a stamped event cannot be re-stamped.** Offline, the stamp queues locally and shows as pending until it reaches the server, where its time is reconciled against the server clock. A correction afterwards is an audited amendment, not an overwrite.',
  citations: [
    { n: 1, label: 'Stamping is one keystroke; the stream is append-only', source: 'S-18-06 · M-18.10' },
    { n: 2, label: 'Local times are reconciled against the server clock, never trusted', source: 'DD-012' },
    { n: 3, label: 'Corrections are audited amendments, never overwrites', source: 'S-18-08 · M-18.10' },
  ],
  band: 'HIGH',
}

const TASK_BOARD: AssistantAnswer = {
  kind: 'cited',
  body:
    'Because something it depends on has not happened, and the card names it. Loading the ambulance is blocked until the needle is stamped — drip-and-ship means the bolus goes in before the patient is loaded, so that task unblocks itself once thrombolysis is given.\n\nThe second dose check cannot be dragged to done at all: record who performed it on the thrombolysis screen and it moves itself.\n\nEvery task carries a named owner and a timer, and every interval on the clock names who owns the next action.',
  citations: [
    { n: 1, label: 'Parallel Task Board — eight things at once, each with an owner and a timer', source: 'S-18-07 · M-18.10' },
    { n: 2, label: 'Drip-and-ship requires the bolus before the patient is loaded', source: 'S-18-07 · blocked task' },
    { n: 3, label: 'Task prioritisation & workload balancing — fallback is due-time order', source: 'AI-619 · §4.2' },
  ],
  band: 'HIGH',
}

const STAMP_CORRECTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes, but not by overwriting it. The stream is append-only, so a correction is an **audited amendment**: the original stays visible beside the resolved value, with who changed it and why.\n\nWhere sources disagree — a triage entry, an ambulance handover form, a DICOM header — the screen shows all of them and which one won, and the server clock is authoritative. It matters because the intervals recompute: five minutes on the door time moved door-to-needle from 41 to 46.',
  citations: [
    { n: 1, label: 'Corrections are audited amendments, never overwrites', source: 'S-18-08 · M-18.10' },
    { n: 2, label: 'Local times are reconciled against the server clock, never trusted', source: 'DD-012' },
    { n: 3, label: 'The 5-minute spread changes DTN from 41 to 46', source: 'S-18-08 · door time conflict' },
  ],
  band: 'HIGH',
}

const PAGING_LADDER: AssistantAnswer = {
  kind: 'cited',
  body:
    'Five steps, each with its own wait: a push notification at once, an automated call to the registered mobile at 2 minutes, the second contact on the rota at 4, the switchboard paging the next person in the speciality at 6, and the on-call consultant for the division at 10.\n\nIt runs on its own — nobody has to remember to escalate. The ladder advances until somebody acknowledges, and the log records who was paged, on what channel, and who actually answered.',
  citations: [
    { n: 1, label: 'Team Paging & Acknowledgement — the escalation ladder and its waits', source: 'S-18-09 · M-18.10' },
    { n: 2, label: 'Who was paged, and who actually answered', source: 'S-18-09 · paging log' },
    { n: 3, label: 'Roster optimisation & coverage-gap detection', source: 'AI-623 · §4.2' },
  ],
  band: 'HIGH',
}

const TELESTROKE_QUEUE_ANSWER: AssistantAnswer = {
  kind: 'cited',
  body:
    'Ranked by window remaining, then severity — a patient whose window closes in 90 minutes outranks one who arrived first. Arrival time is the deterministic sort and is one click away.\n\nThe response targets are 5 minutes to answer a request, 15 to complete the NIHSS and 20 for the decision back to the spoke.\n\nA request outside the window stays in the queue and still needs answering: **outside the window is a different decision, not no decision.** Extended-window imaging selection may still apply.',
  citations: [
    { n: 1, label: 'Telestroke Request Queue — window remaining first, then severity', source: 'S-18-10 · M-18.10' },
    { n: 2, label: 'Answer within 5 min · NIHSS within 15 · decision to the spoke within 20', source: 'S-18-10 · response targets' },
    { n: 3, label: 'Ranked list — always reversible to a deterministic sort', source: 'AIP-07 · §4.3' },
  ],
  band: 'HIGH',
}

const SHARE_IMAGING: AssistantAnswer = {
  kind: 'cited',
  body:
    '**Share the CT** puts the study on the session surface beside the video, with the triage findings as one line each. It is a reminder of the read, not the read.\n\nThe read itself stays on the imaging screen under its own G3 gate — a finding does not enter the record because it was shown on a call. If the study is still arriving it uploads progressively, and the decision does not wait on full resolution.',
  citations: [
    { n: 1, label: 'Share the CT; the read lives on the imaging screen under its own G3 gate', source: 'S-18-11 · M-18.10' },
    { n: 2, label: 'Large-vessel-occlusion detection — G3, radiologist / neurologist read', source: 'AI-404 · §4.2' },
    { n: 3, label: 'The CT uploads progressively; the decision does not wait on full resolution', source: 'S-18-13' },
  ],
  band: 'HIGH',
}

const NIHSS_OVER_VIDEO: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes — it is a 15-item scale scored over video, with the examining clinician recorded against it. Manual scoring is both the fallback and the authority.\n\nAI-112 extracts at G2 only the items you scored **aloud** during the examination; an item examined silently is not captured, and each extracted item still needs Accept, Edit or Reject before it counts. On this case nine of the fifteen were extracted and six were not tested.',
  citations: [
    { n: 1, label: 'A 15-item NIHSS scored over video, with the examiner recorded', source: 'S-18-12 · M-18.10' },
    { n: 2, label: 'Structured extraction from free text — fallback is manual structured entry', source: 'AI-112 · §4.2' },
    { n: 3, label: 'Extracts only items scored aloud; manual scoring is the fallback and the authority', source: 'S-18-11 · M-18.10' },
  ],
  band: 'HIGH',
}

const NIHSS_UNTESTED: AssistantAnswer = {
  kind: 'cited',
  body:
    'Leave it blank and mark it not tested. **An untested item stays blank rather than defaulting to zero, because zero means normal** — scoring an untestable limb as 0 records an examination nobody performed, and the total then understates the deficit.\n\nThe extraction never fills in an item that was not tested either. Limb ataxia in a dense hemiparesis is the ordinary case of this, and it is recorded as not testable rather than as 0.',
  citations: [
    { n: 1, label: 'An untested item stays blank rather than defaulting to zero', source: 'S-18-12 · M-18.10' },
    { n: 2, label: 'It never fills in an item that was not tested', source: 'AI-112 · S-18-12' },
    { n: 3, label: 'Limb ataxia — not testable, hemiparesis', source: 'NIHSS item 7 · case 0141' },
  ],
  band: 'HIGH',
}

const ASPECTS_THRESHOLD: AssistantAnswer = {
  kind: 'cited',
  body:
    'Six is the selection threshold. At 6 or above thrombectomy remains on the table; **below 6, reperfusion is less likely to help**, because too much of the territory is already infarcted to gain from opening the vessel.\n\nIt is a criterion on the EVT checklist, not a bar the model applies: the model scores, you adjust, and the selection is made on the EVT screen under its own gate. This case scores 8, human-adjusted to 7.',
  citations: [
    { n: 1, label: 'ASPECTS ≥ 6 — EVT selection criterion', source: 'S-18-18 · EVT criteria' },
    { n: 2, label: 'Below 6 — reperfusion is less likely to help', source: 'S-18-15 · M-18.10' },
    { n: 3, label: 'ASPECTS 8, human-adjusted 7', source: 'Case STROKE/26-27/0141' },
  ],
  band: 'HIGH',
}

const ASPECTS_SCORING: AssistantAnswer = {
  kind: 'cited',
  body:
    'Ten regions of the middle cerebral artery territory — caudate, lentiform, insula, internal capsule and M1 to M6 — starting at 10, with one point lost for each region showing early ischaemic change.\n\nAI-405 scores it at G2 and you adjust it region by region. **Both scores are kept.** The model’s and yours sit side by side in the record, because overwriting the model score would erase the disagreement, and the disagreement is the most useful thing here for whoever audits the model later.',
  citations: [
    { n: 1, label: 'ASPECTS auto-scoring — fallback is manual region-by-region scoring', source: 'AI-405 · §4.2' },
    { n: 2, label: 'Scored by the model and adjusted by the human, both kept', source: 'S-18-15 · M-18.10' },
    { n: 3, label: '10 regions, 1 point lost per affected region', source: 'S-18-15 · region map' },
  ],
  band: 'HIGH',
}

const ONE_AXIS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Because they are two quantities of the same kind — millilitres of brain — and the number that decides anything is the ratio between them. On separate scales the bar would still look convincing while the mismatch it implied became meaningless.\n\nSo: one axis, one split bar, both segments directly labelled with their volume and their threshold. 18 mL against 96 mL reads as a ratio of 5.3 at a glance, and that ratio is the decision.',
  citations: [
    { n: 1, label: 'Two quantities of the same kind, so one chart with one axis', source: 'S-18-16 · M-18.10' },
    { n: 2, label: 'Core 18 mL, penumbra 96 mL, mismatch ratio 5.3', source: 'AI-406 · perf-quant v2.8.0' },
  ],
  band: 'HIGH',
}

const PERFUSION_THRESHOLDS: AssistantAnswer = {
  kind: 'cited',
  body:
    'Core is tissue with relative cerebral blood flow below 30% of the other side. Penumbra is tissue with Tmax above 6 seconds. A **target mismatch profile** is a core under 70 mL with a mismatch ratio above 1.8.\n\nThis case is 18 mL against 96 mL — a ratio of 5.3, well clear of it. The thresholds are vendor defaults and a convention rather than a physical boundary; motion inflates the core, and the vendor maps remain readable manually if AI-406 is unavailable.',
  citations: [
    { n: 1, label: 'Perfusion core & penumbra quantification — fallback is vendor maps, read manually', source: 'AI-406 · §4.2' },
    { n: 2, label: 'Core rCBF < 30%, penumbra Tmax > 6 s; target mismatch is core < 70 mL and ratio > 1.8', source: 'S-18-16 · M-18.10' },
    { n: 3, label: 'Core 18 mL, penumbra 96 mL, ratio 5.3', source: 'perf-quant v2.8.0' },
  ],
  band: 'HIGH',
}

const DOAC_UNCERTAIN: AssistantAnswer = {
  kind: 'cited',
  body:
    'Only with an override and a reason. An uncertain DOAC history is recorded as **contraindicated unless the last dose was more than 48 hours ago** — uncertainty here is not treated as absence.\n\nThe screen offers two routes rather than a dead end: a family call to establish the last dose, or override with a reason, which is recorded against the case under your name. Other unknown items show their own consequence the same way, so you can see what each one costs before deciding.',
  citations: [
    { n: 1, label: 'DOAC last dose UNCERTAIN — contraindicated unless more than 48 hours ago', source: 'S-18-17 · Z5 criteria' },
    { n: 2, label: 'Every item answerable UNKNOWN, each unknown showing its consequence', source: 'S-18-17 · M-18.10' },
    { n: 3, label: 'Differential diagnosis suggestion — suggests and never concludes', source: 'AI-203 · §4.2' },
  ],
  band: 'HIGH',
}

const SECOND_CHECK: AssistantAnswer = {
  kind: 'cited',
  body:
    'A second qualified person, not you again. They recompute the dose from the recorded weight independently, and **both identities are recorded against the case**.\n\nIt is mandatory, and it is a rule rather than a model output, so it stays in force with the AI switched off. Thrombolysis cannot be given while the check is outstanding, and the action says so rather than failing quietly. The weight it is computed from is on the screen with its source, because an estimated weight is the commonest error here.',
  citations: [
    { n: 1, label: 'High-risk medication double-check — a second-person check before the drug is committed', source: 'CMP-NABH-06' },
    { n: 2, label: 'The independent second dose check is mandatory even when the AI is off', source: 'S-18-17 · M-18.10' },
    { n: 3, label: 'Weight estimated by the treating clinician — no bed scale at IPL', source: 'S-18-17 dosing panel' },
  ],
  band: 'HIGH',
}

const EVT_SELECTION: AssistantAnswer = {
  kind: 'cited',
  body:
    'Six items, each carrying its consequence on the row: a confirmed large-vessel occlusion, ASPECTS ≥ 6, a target mismatch, a pre-stroke mRS ≤ 2, presentation within 6 hours — or 6 to 24 with imaging selection — and feasible vascular access.\n\nAn UNKNOWN does not block; it states what it would change. Access is assessed on the table, and a tortuous arch would change the approach rather than the decision. The selection itself is made on the screen, under its own gate.',
  citations: [
    { n: 1, label: 'EVT Selection & Cath Lab Decision — criteria and their consequences', source: 'S-18-18 · M-18.10' },
    { n: 2, label: 'Perfusion core & penumbra quantification', source: 'AI-406 · §4.2' },
    { n: 3, label: 'Functional-outcome prediction (mRS, Barthel) — observed scale only is the fallback', source: 'AI-221 · §4.2' },
  ],
  band: 'HIGH',
}

const EVT_DISAGREEMENT: AssistantAnswer = {
  kind: 'cited',
  body:
    'Use **Record a disagreement**: name who disagrees and give a reason of at least ten characters. It is recorded against the case and travels with the registry export.\n\nIt blocks nothing. The decision proceeds and the disagreement sits beside it, because a decision that looks unanimous in the record when it was not is the version nobody can learn from. Recording it is how the registry eventually finds out which reading was right.',
  citations: [
    { n: 1, label: 'Selecting for thrombectomy, and recording the disagreement', source: 'S-18-18 · M-18.10' },
    { n: 2, label: 'Recording the disagreement is how the registry learns which reading was right', source: 'S-18-18 · Why panel' },
    { n: 3, label: 'Functional-outcome prediction, shown with its limits', source: 'AI-221 · §4.2' },
  ],
  band: 'HIGH',
}

const TRIAGE_PRIORITY: AssistantAnswer = {
  kind: 'cited',
  body:
    'P1 means immediate. On this study the verdict is an ischaemic stroke with a left M1 occlusion — no haemorrhage, ASPECTS 8, mismatch 5.3 — a candidate for both thrombolysis and thrombectomy, and every one of those is time-dependent.\n\nA haemorrhage would also be P1, for the opposite reason; a stood-down mimic is P3. The priority is what the model uses to **prioritise and notify**. It is not a diagnosis, and the reading enters the record only over a clinician’s signature at G3.',
  citations: [
    { n: 1, label: 'Triage verdict — ischaemic stroke, large vessel occlusion, P1 IMMEDIATE', source: 'S-18-21 · Stroke-AI console' },
    { n: 2, label: 'It prioritises and notifies; it never diagnoses', source: 'AI-404 · G3' },
    { n: 3, label: 'ICH negative 0.97, LVO left M1 0.94, ASPECTS 8', source: 'lvo-det v4.2.1' },
  ],
  band: 'HIGH',
}

const THROMBOLYSIS_BLOCKERS: AssistantAnswer = {
  kind: 'cited',
  body:
    'The checklist names what blocks and what would unblock it. **Blood pressure above 185/110 blocks**, and it clears only when a reading below threshold is documented. An uncertain DOAC last dose is contraindicated unless that dose was more than 48 hours ago. Haemorrhage on the scan is an absolute no.\n\nAn item answered UNKNOWN — platelets still pending, say — does not block; it shows its consequence so you can decide. Cost never blocks. The eligibility decision is made on that screen, under its own gate.',
  citations: [
    { n: 1, label: 'Thrombolysis eligibility criteria and their consequences', source: 'S-18-17 · Z5 items' },
    { n: 2, label: 'Intracranial haemorrhage detection — the negative is what unlocks thrombolysis', source: 'AI-403 · §4.2' },
    { n: 3, label: 'Cost & coverage — display only, does not block', source: 'S-18-17 Z5' },
  ],
  band: 'HIGH',
}

const MRS_OUTCOME: AssistantAnswer = {
  kind: 'cited',
  body:
    'The modified Rankin Scale — function after a stroke from 0 to 6: 0 no symptoms, 2 slight disability but independent, 5 bedridden, 6 died. The registry indicator is the proportion reaching **mRS 0–2 at 90 days**, currently 54% against a 50% target.\n\nIt is collected by a telephone call inside the 90-day window. Once that window closes the outcome cannot be recorded at all and the case counts against completeness for good, which is why the call list is the surface of the screen.',
  citations: [
    { n: 1, label: 'Stroke Outcomes, mRS-90 & Registry — mRS 0–6 at 90 days', source: 'S-18-20 · M-18.10' },
    { n: 2, label: 'mRS 0–2 at 90 days — 54% against a ≥ 50% target', source: 'Registry indicators' },
    { n: 3, label: 'Functional-outcome prediction (mRS, Barthel)', source: 'AI-221 · §4.2' },
  ],
  band: 'HIGH',
}

const REGISTRY_EXPORT: AssistantAnswer = {
  kind: 'cited',
  body:
    'The cases for the period with their clocks and outcomes: door-to-needle and door-to-groin, thrombolysis rate, DIDO at the spokes, mRS at 90 days and follow-up completeness, each against its target. A recorded EVT disagreement travels with it.\n\nIt is audited on those indicators, and completeness is the one that bites — 78% here against a 90% target. Incomplete follow-up is the commonest reason a stroke centre loses its accreditation, and it has nothing to do with the quality of the care.',
  citations: [
    { n: 1, label: 'Registry indicators — DTN, door-to-groin, DIDO, thrombolysis rate, mRS, completeness', source: 'S-18-20 · M-18.10' },
    { n: 2, label: 'Indicator computation & trend alerting — fallback is manual monthly computation', source: 'AI-802 · §4.2' },
    { n: 3, label: 'A recorded disagreement travels with the registry export', source: 'S-18-18 · M-18.10' },
  ],
  band: 'HIGH',
}

const TELE_MODE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Yes. The consultation mode is part of the gate rather than a preference: **List A requires a video teleconsult**, so on a telephone teleconsult only List O and List B add-ons are permitted.\n\nSwitching between video and telephone on the prescription screen re-evaluates every line, and a blocked line has to be removed before you can sign. The gate is hard-coded from the Telemedicine Practice Guidelines 2020 — never AI-decided, and still enforced with the model off.',
  citations: [
    { n: 1, label: 'Teleconsult prescribing categories (O / A / B) and prohibited list', source: 'CMP-DRUG-06' },
    { n: 2, label: 'List A requires video; telephone permits List O and List B add-ons only', source: 'S-27-04 · M-27.10' },
    { n: 3, label: 'Tele-prescription category gate — hard-coded prohibited list, never off', source: 'AI-310 · §4.2' },
  ],
  band: 'HIGH',
}

const ENTRIES: Entry[] = [
  // ── Specific first. A broad token above any of these would shadow it.
  { match: ['amend a timestamp', 'correct a stamped', 'stamped event'], answer: STAMP_CORRECTION },
  {
    match: ['escalation ladder', 'reach the named clinician', 'escalate a critical finding', 'acknowledge a critical finding'],
    answer: CRITICAL_FINDING_ESCALATION,
  },
  { match: ['score below 6', 'below 6 mean'], answer: ASPECTS_THRESHOLD },
  { match: ['one axis'], answer: ONE_AXIS },
  { match: ['apply a set', 'apply an order set', 'rather than an encounter'], answer: ORDER_SET_SCOPE },
  { match: ['review date', 'pathways reviewed', 'due for review'], answer: REVIEW_DATE },
  { match: ['recorded when i break', 'break the glass'], answer: BREAK_GLASS_RECORD },

  // ── M-06 · the workspace
  { match: ['covers my list', 'when i am on leave', 'who covers'], answer: LEAVE_COVER },
  { match: ['timeline go', 'this timeline', 'one episode', 'filter to one'], answer: TIMELINE },
  { match: ['ai badge', 'badge on an event', 'ai-assisted'], answer: AI_BADGE },
  { match: ['nlem', 'substitution'], answer: NLEM_SUBSTITUTION },
  { match: ['prescription print', 'the prescription print', 'print from'], answer: PRESCRIPTION_PRINT },
  { match: ['on the app', 'patient app', 'which languages', 'instructions print'], answer: PATIENT_INSTRUCTIONS },
  { match: ['own wording', 'my wording', 'keep my own'], answer: OWN_WORDING },

  // ── M-08 · inpatient
  { match: ['abstain'], answer: AI_ABSTAIN },
  { match: ['hand over my list', 'handover', 'hand over'], answer: HANDOVER },
  {
    match: ['24-hour assessment', '24 hour assessment', 'assessment clock', 'initial assessment', 'window closes'],
    answer: ADMISSION_ASSESSMENT,
  },

  // ── M-09 · orders & results
  { match: ['overdue', 'unresulted', 'chases an'], answer: ORDER_STATUS },
  { match: ['void'], answer: VOID_ORDER },
  { match: ['delta check', 'delta'], answer: DELTA_CHECK },
  { match: ['trend go', 'far back does the trend'], answer: TREND_RANGE },
  { match: ['rejections go', 'my rejections', 'reject a flag'], answer: STEWARDSHIP_REJECTION },

  // ── M-13 · discharge & death
  { match: ['discharge summary'], answer: DISCHARGE_SUMMARY_SIGN },
  { match: ['bilingual'], answer: BILINGUAL },
  {
    match: ['reconciliation compare', 'does reconciliation', 'stopped medicine', 'carry forward', 'carried forward'],
    answer: MED_REC,
  },
  { match: ['police', 'medico-legal', 'mlc'], answer: MLC_POLICE },
  { match: ['certify a death', 'can certify'], answer: DEATH_CERTIFIER },

  // ── M-05 · scheduling
  { match: ['wait time', 'wait is predicted', 'same wait', 'predicted wait'], answer: WAIT_PREDICTION },
  { match: ['next token', 'token order', 'call a token'], answer: TOKEN_CALL },
  { match: ['clinic template', 'change my template', 'changing a template', 'template move'], answer: CLINIC_TEMPLATE },
  { match: ['capacity suggestion', 'capacity'], answer: CAPACITY_SUGGESTION },
  { match: ['leave block', 'blocked session', 'already booked', 'notice does a leave'], answer: LEAVE_BLOCK },
  { match: ['referral', 'referring doctor'], answer: REFERRAL_TRIAGE },

  // ── M-15 · imaging
  { match: ['overlay'], answer: AI_OVERLAY },

  // ── M-27 · telehealth
  { match: ['teleconsult queue', 'no video', 'telephone fallback'], answer: TELE_QUEUE },
  { match: ['teleconsult not do', 'could not examine', 'cannot examine', 'not examine'], answer: TELE_LIMITS },
  {
    match: ['session record', 'declines recording', 'declined recording', 'consent is needed for a teleconsult'],
    answer: SESSION_RECORDING,
  },

  // ── M-16 · pharmacovigilance
  { match: ['add the allergy', 'allergy to the patient record'], answer: ADR_CONSEQUENCE },
  { match: ['pvpi', 'an adr', 'adr report', 'adverse drug'], answer: PVPI },

  // ── M-18 · stroke
  { match: ['dimmed wall', 'wall dim', 'sites are active', 'command wall'], answer: COMMAND_WALL },
  { match: ['assistant bubble', 'no bubble'], answer: WALL_NO_BUBBLE },
  { match: ['readiness', 'not ready', 'ambulance go', 'spoke'], answer: SITE_READINESS },
  {
    match: ['activation trigger', 'does activation', 'activate without', 'de-activate', 'deactivate', 'mimic'],
    answer: ACTIVATION,
  },
  { match: ['lkw', 'last known well'], answer: LKW_UNKNOWN },
  { match: ['intake block', 'does the intake'], answer: INTAKE_CLOCK },
  { match: ['stamp the needle', 'stamp an event', 'do i stamp'], answer: STAMPING },
  {
    match: ['in progress', 'move this task', 'owns the next action', 'loading the ambulance', 'before the needle'],
    answer: TASK_BOARD,
  },
  { match: ['paging', 'nobody acknowledges', 'ladder run'], answer: PAGING_LADDER },
  { match: ['outside the window', 'telestroke queue', 'response target'], answer: TELESTROKE_QUEUE_ANSWER },
  { match: ['share imaging', 'share the ct', 'imaging in-session'], answer: SHARE_IMAGING },
  { match: ['nihss'], answer: NIHSS_OVER_VIDEO },
  { match: ['not testable', 'untested item', 'not scored zero'], answer: NIHSS_UNTESTED },
  { match: ['aspects', 'adjustment kept', 'model score'], answer: ASPECTS_SCORING },
  { match: ['core and penumbra', 'penumbra', 'target mismatch'], answer: PERFUSION_THRESHOLDS },
  { match: ['doac'], answer: DOAC_UNCERTAIN },
  { match: ['second dose check', 'second check'], answer: SECOND_CHECK },
  { match: ['evt selection', 'evt criteria', 'selection criteria'], answer: EVT_SELECTION },
  { match: ['disagreement'], answer: EVT_DISAGREEMENT },
  { match: ['a p1', 'p1?'], answer: TRIAGE_PRIORITY },
  { match: ['blocks thrombolysis', 'thrombolysis unsafe'], answer: THROMBOLYSIS_BLOCKERS },
  { match: ['mrs'], answer: MRS_OUTCOME },
  { match: ['registry'], answer: REGISTRY_EXPORT },

  // ── The original corpus.
  { match: ['addendum', 'amend', 'edit a signed', 'change a signed', 'signed note'], answer: ADDENDUM },
  { match: ['sign still disabled', 'why is sign', 'cannot sign', "can't sign", 'sign disabled', 'enable sign'], answer: SIGN_DISABLED },
  { match: ['override', 'hard stop', 'blocked drug', 'why was this drug'], answer: HARD_STOP_OVERRIDE },
  { match: ['critical result', 'acknowledge', 'acknowledgement window', 'unacknowledged', 'escalate'], answer: CRITICAL_RESULT },
  { match: ['acuity', 'ranked', 'ranking', 'how is this list ordered', 'how is this inbox ranked', 'sort', 'chronolog'], answer: ACUITY_SORT },
  { match: ['marking a patient seen', 'mark seen', 'marking seen', 'marked seen', 'seen change'], answer: MARK_SEEN },
  { match: ['needs-my-attention', 'needs my attention', 'attention list', 'puts a patient on', 'why is this patient on'], answer: ATTENTION_LIST },
  { match: ['break-glass', 'break glass', 'no care relationship'], answer: BREAK_GLASS },
  { match: ['abdm', 'publish', 'fhir', 'health information provider'], answer: ABDM_PUBLISH },
  { match: ['leaf code', 'j18', 'parent-only', 'parent code', 'code assist'], answer: LEAF_CODE },
  { match: ['dtn', 'dido', 'door to needle', 'door-to-needle', 'breach'], answer: DTN_TARGETS },
  { match: ['which clock', 'authoritative', 'timestamp', 'clocks disagree', 'door time'], answer: CLOCK_AUTHORITY },
  { match: ['185', 'blood pressure', 'bp is above', 'treat to target', 'labetalol'], answer: BP_PROTOCOL },
  { match: ['cost', 'money', 'does the cost block', 'authorise in parallel', 'authorize in parallel', 'pm-jay pending'], answer: COST_NEVER_BLOCKS },
  { match: ['no neurologist', 'what do i do first', 'request the hub', 'activate offline', 'ct will not upload', 'six fields'], answer: SPOKE_FIRST_STEPS },
  { match: ['model detect', 'g3', 'confirm required', 'explicit no', 'lvo model', 'model version', 'what is the model', 'how sure'], answer: IMAGING_MODEL_LIMITS },
  { match: ['single-act', 'single act', 'reservation', 'holds what', 'atomic', 'one resource', 'one of the four', 'becomes unavailable', 'resources is lost'], answer: SINGLE_ACT_RESERVATION },
  { match: ['what can you', 'what can i ask', 'who are you', 'what do you do', 'help with', 'refuse to answer'], answer: ASSISTANT_SELF },
  { match: ['co-sign', 'cosign', 'countersign', 'resident', 'turnaround'], answer: CO_SIGN },
  { match: ['banned abbreviation', 'abbreviation', 'which abbreviations'], answer: BANNED_ABBREVIATIONS },
  { match: ['telephone teleconsult', 'telephone consultation', 'telephone change'], answer: TELE_MODE },
  { match: ['tele-prescri', 'tele prescri', 'category o', 'categories o', 'list a', 'list b', 'cannot tele', 'drug categories'], answer: TELE_CATEGORIES },
  { match: ['discharge prediction', 'discharge today', 'financial clearance', 'medically fit'], answer: DISCHARGE_PREDICTION },
  { match: ['mccd', 'cause of death', 'death certificat', 'form 4'], answer: MCCD },
  { match: ['transcript', 'the scribe', 'scribe service', 'ambient scribe', 'round scribe', 'dictat'], answer: SCRIBE_TRANSCRIPT },
  { match: ['order set', 'promote', 'facility-wide', 'governance'], answer: ORDER_SET_GOVERNANCE },
  { match: ['duplicate', 'low-value', 'low value', 'unnecessary test', 'stewardship'], answer: DUPLICATE_TEST },
  { match: ['offline', 'no network', 'connectivity', 'queued'], answer: OFFLINE_BEHAVIOUR },
]

// ────────────────────────────────────────────── The four refusal outcomes

/**
 * O2 — a clinical question. Guardrail 1: "A clinical question — 'is this dose
 * safe', 'what does this result mean', 'should I thrombolyse' — is DECLINED AND
 * ROUTED to the capability that owns it under its own gate. The assistant never
 * answers it directly, at any confidence."
 */
const CLINICAL_ROUTES: { match: string[]; routedTo: NonNullable<AssistantAnswer['routedTo']> }[] = [
  {
    match: ['dose safe', 'is this dose', 'safe to give', 'interaction', 'allergic', 'allergy safe', 'contraindicat'],
    routedTo: {
      capability: 'AI-205',
      name: 'Drug interaction, allergy & contraindication check',
      gate: 'G2',
      where: 'the Prescription Writer, where it runs before the prescription is committed',
    },
  },
  {
    match: ['what does this result mean', 'interpret', 'is this result', 'significan'],
    routedTo: {
      capability: 'AI-212',
      name: 'Result interpretation & delta check',
      gate: 'G1',
      where: 'the result detail screen, alongside the reference range and the prior value',
    },
  },
  {
    match: ['should i thrombolyse', 'should i treat', 'should we thrombolyse', 'give tenecteplase', 'thrombolyse this'],
    routedTo: {
      capability: 'AI-203',
      name: 'Differential diagnosis suggestion',
      gate: 'G1',
      where: 'the thrombolysis eligibility checklist, which suggests and never concludes',
    },
  },
  {
    match: ['what is wrong with', 'diagnos', 'differential', 'what could this be'],
    routedTo: {
      capability: 'AI-203',
      name: 'Differential diagnosis suggestion',
      gate: 'G1',
      where: 'the consultation note, as a suggestion card that suggests and never concludes',
    },
  },
  {
    match: ['how much', 'what dose', 'dosage', 'mg/kg', 'adjust the dose'],
    routedTo: {
      capability: 'AI-206',
      name: 'Renal & hepatic dose adjustment',
      gate: 'G2',
      where: 'the prescription line itself, with the printed reference as the fallback',
    },
  },
]

function clinicalRefusal(routedTo: NonNullable<AssistantAnswer['routedTo']>): AssistantAnswer {
  return {
    kind: 'routed',
    body:
      'That is a clinical question, and I do not answer those — at any confidence.\n\nIt belongs to a capability with its own human gate, so that the answer arrives where you can accept, edit or reject it and the decision is recorded against your name.',
    citations: [
      { n: 1, label: 'It is not a clinical adviser — declined and routed', source: '§6.1 guardrail 1' },
      { n: 2, label: `${routedTo.capability} ${routedTo.name}`, source: `§4.2 · gate ${routedTo.gate}` },
    ],
    band: 'HIGH',
    routedTo,
  }
}

/**
 * O3 — out of scope. "declined NAMING WHAT IT DOES COVER, with two examples.
 * Not a generic 'I don't understand'."
 */
const OUT_OF_SCOPE: AssistantAnswer = {
  kind: 'out-of-scope',
  body: 'That is outside what I cover.',
  citations: [{ n: 1, label: 'Out-of-scope requests are declined explicitly', source: '§6.1 · GP-13' }],
  band: 'HIGH',
  covers: {
    summary:
      'I cover how this product works and the process and policy behind it — documentation, accreditation obligations, capability and access rules, and the clinical pathways as written.',
    examples: ['How do I add an addendum to a signed note?', 'What is the acknowledgement window for a critical result?'],
  },
}

/** O4 — nothing relevant retrieved. AI-ABSTAIN, never an extrapolated policy. */
const NO_EVIDENCE: AssistantAnswer = {
  kind: 'no-evidence',
  body: "I don't have documentation for that.",
  /** Empty by design — an uncited answer is not rendered at all. */
  citations: [],
  band: 'LOW',
  supportRoute: 'Static help centre, or the service desk on extension 4400.',
}

/**
 * O5 — would exceed the caller's access. "declines AS THOUGH THE CONTENT DOES
 * NOT EXIST — the refusal is uniform and does not confirm that the record
 * exists." Same rule as the DENIED state.
 */
const BEYOND_ACCESS: AssistantAnswer = {
  kind: 'beyond-access',
  body: "I don't have documentation for that.",
  citations: [],
  band: 'LOW',
  supportRoute: 'Static help centre, or the service desk on extension 4400.',
}

/** Questions that reach for a patient the caller has not opened. */
const CROSS_PATIENT_PATTERNS = [
  'another patient',
  'other patients',
  'any patient with',
  'list patients',
  'all patients in',
  'who else has',
  'show me a patient',
  'bed 3',
  'ward 3c',
]

/** Questions that are simply not about this product. */
const OFF_TOPIC_PATTERNS = [
  'weather',
  'cricket',
  'canteen',
  'parking',
  'salary',
  'holiday',
  'joke',
  'recipe',
  'flight',
  'stock price',
  'who won',
]

export interface AskContext {
  screenId: string
  /** The Z3 patient, if the calling screen had one. */
  patientId?: string
  /** Whether the assistant is scoped to a patient at all. */
  patientScoped: boolean
  /** The doctor's session — what the record answers read. Absent means the defaults. */
  live?: LiveContext
}


// ───────────────────────────── Readings — the assistant giving a clinical view

/**
 * The phrasings a clinician actually uses when they want an opinion rather
 * than a fact. Shared, because the question is the same on every screen that
 * owns an interpretation; only the answer differs.
 */
const VIEW_MATCH = [
  'your view',
  'views on',
  'your opinion',
  'what do you think',
  'how worried',
  'should i be worried',
  'interpret',
  'what does this mean',
  'make of this',
]

/**
 * A reading, not a diagnosis. The shape is fixed and is the safety argument:
 *   1. the number, cited;
 *   2. what it means in THIS patient, cited to why;
 *   3. what would change the reading — the line that keeps it honest;
 *   4. the gate, and a signature.
 */
const VIEW_RESULT_K: AssistantAnswer = {
  kind: 'cited',
  body:
    'Potassium 6.8 mmol/L is a critical value, and it has risen 1.4 in nine hours. [1]\n\nIn this patient that is the dangerous combination rather than the number alone: he is ventilated with stage 2 AKI by creatinine criteria, so the kidney is not going to correct it and the rise is likely to continue. [2] At 6.8 with a rising trend the immediate risk is a cardiac arrhythmia, which is treatable and time-critical — an ECG looking for peaked T waves and loss of P waves is the next five minutes. [3]\n\n**What would change this reading:** a haemolysed sample, which raises potassium spuriously and is common on a difficult draw. The laboratory has not flagged haemolysis on this specimen, but if the draw was traumatic, repeat it while you treat rather than instead of treating. [1]\n\nTwo active prescriptions are affected and are listed on the chart. [4]',
  citations: [
    { n: 1, label: 'Serum potassium 6.8 mmol/L, reported 08:28, no haemolysis flag', source: 'Result R-88410' },
    { n: 2, label: 'Creatinine 212 µmol/L, +64 in 24 h — AKI stage 2', source: 'Result R-88405' },
    { n: 3, label: 'Critical potassium escalates to the on-call consultant at 15 minutes', source: 'AI-213 · escalation rule' },
    { n: 4, label: 'Two active prescriptions affected by renal function', source: 'Prescription record · ICU-1' },
  ],
  band: 'HIGH',
  attest: {
    capabilityId: 'AI-212',
    gate: 'G3',
    touchpointId: 'assistant:R-88410:view',
    claim: 'Critical hyperkalaemia on a rising trend in a ventilated patient with AKI stage 2.',
  },
  about: 'SD-P-07',
}

const VIEW_NCCT: AssistantAnswer = {
  kind: 'cited',
  body:
    'The scan is negative for haemorrhage, and that is the finding that matters first — it is what opens the thrombolysis pathway rather than closing it. All five subtype classifiers are below threshold and the reporting radiologist agreed. [1]\n\nASPECTS is 8 of 10, with early change in the insula and M2. Eight is comfortably above the six that thrombectomy selection asks for, so the territory is still largely salvageable. [2] The hyperdense left MCA on the source images, with the M1 cut-off on the angiogram, is a consistent picture rather than two separate findings. [3]\n\n**What would change this reading:** ASPECTS is the softest number here at 0.89 and it falls as time passes — it is a snapshot, not a constant. If the transfer runs long, it is worth re-scoring rather than carrying this figure forward. Motion artefact would also degrade it, and this study is clean. [2]',
  citations: [
    { n: 1, label: 'Haemorrhage classifier negative at 0.97 across ICH, IPH, IVH, SDH, EDH and SAH', source: 'AI-403 · NCCT triage' },
    { n: 2, label: 'ASPECTS 8/10 at 0.89 — insula and M2', source: 'AI-405 · ASPECTS' },
    { n: 3, label: 'Left M1 occlusion at 0.94, clot length 11.4 mm', source: 'AI-404 · CT angiogram' },
  ],
  band: 'HIGH',
  attest: {
    capabilityId: 'AI-404',
    gate: 'G3',
    touchpointId: 'assistant:strokeai:view',
    claim: 'Ischaemic stroke with a left M1 occlusion, no haemorrhage, ASPECTS 8.',
  },
  about: 'SD-P-05',
}

const VIEW_DETERIORATION: AssistantAnswer = {
  kind: 'cited',
  body:
    'Two of your inpatients are flagged, and they are flagged for different reasons.\n\nR. Lakshmanan is the one I would see first. NEWS2 is 7 and has been rising over four hours — respiratory rate 26, oxygen saturation 92% on 4 litres, temperature 38.4 °C. [1] His CRP has nearly doubled at 72 hours of antibiotics, which is the pattern of treatment failure rather than slow response. [2]\n\nJoseph Mathew is flagged on a single critical result rather than a trend — potassium 6.8, unacknowledged twelve minutes. [3] That is more urgent per minute but narrower: it is one problem with one action.\n\n**What would change this reading:** NEWS2 weights oxygen saturation heavily, so a patient on long-term oxygen scores high without deteriorating. Lakshmanan has no such history recorded, which is why the score is being taken at face value here. [1]',
  citations: [
    { n: 1, label: 'NEWS2 7, rising over 4 h — RR 26, SpO₂ 92% on 4 L, temp 38.4 °C', source: 'AI-201 · 4B-12' },
    { n: 2, label: 'CRP 184 mg/L, +88 in 48 h at 72 h of antibiotics', source: 'Result R-88402' },
    { n: 3, label: 'Potassium 6.8 mmol/L, unacknowledged 12 min', source: 'Result R-88410 · ICU-1' },
  ],
  band: 'HIGH',
  attest: {
    capabilityId: 'AI-201',
    gate: 'G3',
    touchpointId: 'assistant:deterioration:view',
    claim: 'Two inpatients deteriorating — one on a rising trend, one on a single critical value.',
  },
}

const VIEW_DISCHARGE: AssistantAnswer = {
  kind: 'cited',
  body:
    'Two are likely to go home today, and neither is clinically blocked — both are held up by paperwork and logistics. [1]\n\nKavya Reddy has been afebrile eighteen hours with oral intake established and no active orders; the only thing outstanding is an unsigned discharge summary. [2] Fatima Bi is a routine chronic admission whose dialysis finishes at 16:00, and transport has not been arranged. [3]\n\nThat matters more than it sounds: a discharge discovered at 16:00 frees a bed the following morning, while the same discharge known at 07:00 frees it the same afternoon. Both of today\u2019s blockers are solvable before noon.\n\n**What would change this reading:** the prediction is computed at 07:00 and does not know about anything that has happened on the round since. A patient who has deteriorated this morning will still appear here until the next run. [1]',
  citations: [
    { n: 1, label: 'Discharge likelihood computed 07:00', source: 'AI-610 · G1' },
    { n: 2, label: 'Afebrile 18 h, oral intake established, no active orders; summary unsigned', source: 'Discharge board · 4B-19' },
    { n: 3, label: 'Dialysis session at 14:00; transport not arranged', source: 'Discharge board · 4B-06' },
  ],
  band: 'MED',
  attest: {
    capabilityId: 'AI-610',
    gate: 'G3',
    touchpointId: 'assistant:discharge:view',
    claim: 'Two discharges are achievable today; both blockers are administrative.',
  },
}


/**
 * Sits ahead of the screen's reading, because `VIEW_MATCH` contains
 * `'interpret'` and would otherwise answer "why is this a G3 touchpoint?"
 * with the potassium reading — cited, and the wrong question.
 */
const G3_WHY: AssistantAnswer = {
  kind: 'cited',
  body:
    'Because a drafted interpretation is a claim about the patient, not a ranking of the worklist.\n\nG1 and G2 cover things you may ignore or dispose of — a sort order, a suggested order, a flag. G3 is the gate for anything that enters the record as your clinical opinion, and it asks for a signature rather than a click. [1]\n\nThe practical difference: an unattested G3 draft never reaches the note, and the attestation stamps your name and registration number against the wording at the moment you signed it. [2] Acknowledging the result is a separate act from documenting what you did about it. [3]',
  citations: [
    { n: 1, label: 'G3 — attest: the clinician signs for the claim, not merely accepts it', source: 'Gate G3' },
    { n: 2, label: 'Drafted interpretation, attested before it enters the report', source: 'AI-109 · S-09-05' },
    { n: 3, label: 'Acknowledgement records that you saw it; action is documented separately', source: 'AI-213 · S-09-06' },
  ],
  band: 'HIGH',
}

/**
 * Answers a screen owns.
 *
 * "What are your views on this result?" is the question clinicians actually
 * ask, and routing it to a capability id is a non-answer. So a screen that
 * OWNS an interpretation answers for it: the reading is cited to the record,
 * it names what would change it, and it ends under a gate with a signature.
 *
 * Consulted BEFORE `CLINICAL_ROUTES`, and only for the screen it is keyed to —
 * so the same question asked from a screen that does not own the result still
 * routes, which is the behaviour §6.1 wants everywhere else.
 */
const SCREEN_ANSWERS: Record<string, Entry[]> = {
  'S-09-05': [
    { match: ['g3', 'why is the interpretation', 'attest'], answer: G3_WHY },
    { match: VIEW_MATCH, answer: VIEW_RESULT_K },
  ],
  'S-09-04': [{ match: VIEW_MATCH, answer: VIEW_RESULT_K }],
  'S-18-21': [{ match: [...VIEW_MATCH, 'read the scan', 'what does the scan show'], answer: VIEW_NCCT }],
  'S-18-14': [{ match: [...VIEW_MATCH, 'read the scan', 'what does the scan show'], answer: VIEW_NCCT }],
  'S-28-09': [{ match: [...VIEW_MATCH, 'read the scan', 'what does the scan show'], answer: VIEW_NCCT }],
  'S-08-03': [{ match: [...VIEW_MATCH, 'deteriorat'], answer: VIEW_DETERIORATION }],
  'S-06-01': [{ match: [...VIEW_MATCH, 'deteriorat'], answer: VIEW_DETERIORATION }],
  'S-13-01': [{ match: VIEW_MATCH, answer: VIEW_DISCHARGE }],

  /**
   * The other reason a screen owns an answer: the corpus alone would get it
   * wrong. "How do I code an uncertain diagnosis?" carries a clinical token and
   * would route; "how much notice" would route to dose adjustment; and an
   * escalation ladder means one thing in radiology and another on a page.
   */
  'S-06-05': [{ match: ['uncertain diagnosis', 'code an uncertain'], answer: UNCERTAIN_CODE }],
  'S-05-05': [{ match: ['how much notice', 'notice does a leave', 'approves an override'], answer: LEAVE_BLOCK }],
  'S-18-09': [{ match: ['escalation ladder', 'nobody acknowledges', 'ladder run'], answer: PAGING_LADDER }],
}

/**
 * Resolve a question to one of the five outcomes. The order matters: clinical
 * routing is checked BEFORE the general corpus, because a clinical question
 * that happens to contain a documentation keyword must still be declined.
 * The exception is a screen that owns the interpretation being asked about.
 */
export function resolveAnswer(question: string, context: AskContext): AssistantAnswer {
  const q = question.toLowerCase().trim()

  if (!q) return NO_EVIDENCE

  // O5 first — a privilege-escalation attempt must not be answered by accident.
  if (CROSS_PATIENT_PATTERNS.some((p) => q.includes(p))) return BEYOND_ACCESS

  // O1, screen-owned — a reading, under a gate, on the screen that owns it,
  // and only about the patient that reading is about.
  for (const entry of SCREEN_ANSWERS[context.screenId] ?? []) {
    const other = entry.answer.about && context.patientId && entry.answer.about !== context.patientId
    if (!other && entry.match.some((m) => q.includes(m))) return entry.answer
  }

  // O1, read from the record — what changed, the latest reports, what needs me.
  const intent = recordIntent(q)
  if (intent) {
    const read = recordAnswer(intent, context.patientId, context.live ?? DEFAULT_LIVE)
    if (read) return read
  }

  // O2 — clinical questions never reach the corpus.
  for (const route of CLINICAL_ROUTES) {
    if (route.match.some((m) => q.includes(m))) return clinicalRefusal(route.routedTo)
  }

  // O1 — the cited corpus.
  for (const entry of ENTRIES) {
    if (entry.match.some((m) => q.includes(m))) return entry.answer
  }

  // O3 — recognisably off-topic.
  if (OFF_TOPIC_PATTERNS.some((p) => q.includes(p))) return OUT_OF_SCOPE

  // O4 — in scope, but nothing retrieved.
  return NO_EVIDENCE
}

// ──────────────────────────────────────────────── The bubble's suggestions

/** "3–4 suggested prompts" — more is a menu, not a suggestion. */
export const MAX_SUGGESTIONS = 4

/** Where the doctor's day is the subject, so what needs them leads. */
const ACTIVITY_SCREENS = new Set(['S-06-01', 'S-08-03', 'S-05-03', 'S-09-04'])

/** The question a doctor has next, after each thing they may just have done. */
const AFTER_ACTION: Record<string, string> = {
  'NOTE.SIGNED': 'What gets published to ABDM when I sign?',
  'NOTE.COSIGN_QUEUED': 'What is the co-sign turnaround target?',
  'ACCESS.BREAK_GLASS': 'Who reviews my break-glass access?',
  'AI.SAF.HARD_STOP_OVERRIDDEN': 'What happens after a hard-stop override?',
}

function afterAction(context: AskContext, live: LiveContext): string | undefined {
  const recent = live.recent
  if (!recent) return undefined
  // About another patient than the one open: not this conversation's question.
  if (recent.subject && context.patientId && recent.subject !== context.patientId) return undefined
  if (recent.event === 'ADMISSION.REQUESTED') return admissionPrompt(recent.subject, live)
  return AFTER_ACTION[recent.event]
}

/**
 * The bubble's suggested questions, personalised and capped at four:
 *   1. what the doctor just did, if it raises a question;
 *   2. with a patient open — what changed, the latest reports, the screen's
 *      own question, how they are doing, what they take;
 *   3. without one — what needs the doctor today (first on the screens that
 *      are about their day, last elsewhere) around the screen's own questions.
 *
 * Every candidate is resolved before it is offered: one that would not come
 * back cited, or would repeat an answer already on the list, is dropped.
 */
export function suggestionsFor(context: AskContext): string[] {
  const live = context.live ?? DEFAULT_LIVE
  const own = SCREEN_PROMPTS[context.screenId] ?? []
  const candidates: string[] = []

  const after = afterAction(context, live)
  if (after) candidates.push(after)

  const record = context.patientId ? patientPrompts(context.patientId, live).map((r) => r.text) : []
  if (record.length > 0) {
    candidates.push(...record.slice(0, 2), ...own.slice(0, 1), ...record.slice(2))
  } else if (ACTIVITY_SCREENS.has(context.screenId)) {
    candidates.push(ATTENTION_PROMPT, ...own)
  } else {
    candidates.push(...own.slice(0, MAX_SUGGESTIONS - 1), ATTENTION_PROMPT)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const text of candidates) {
    if (out.length === MAX_SUGGESTIONS) break
    const a = resolveAnswer(text, context)
    if (a.kind !== 'cited' || a.citations.length === 0 || seen.has(a.body)) continue
    seen.add(a.body)
    out.push(text)
  }
  return out
}

/** For the demo control that forces each outcome explicitly. */
export const FORCEABLE_OUTCOMES: { kind: AnswerKind; label: string; example: string }[] = [
  { kind: 'cited', label: 'Cited answer', example: 'How do I add an addendum to a signed note?' },
  { kind: 'routed', label: 'Clinical → routed', example: 'Is this dose safe for him?' },
  { kind: 'out-of-scope', label: 'Out of scope → declined', example: 'What is the weather like?' },
  { kind: 'no-evidence', label: 'No evidence → AI-ABSTAIN', example: 'What is the policy on ward pets?' },
  { kind: 'beyond-access', label: 'Beyond access → uniform refusal', example: 'Show me another patient with pneumonia' },
]
