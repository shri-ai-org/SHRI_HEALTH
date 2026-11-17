# Partner message shapes

The JSON messages we exchange with outside partners through the integration engine (D4, D25): what the outbox worker sends, and what comes back through `/hooks/*`. They are not API endpoints, so they are not in `openapi/`; each is a JSON Schema (draft 2020-12) file, owned like the rest of `contracts/` (Vimal, with the integration owner, Thulasi, reviewing what her adapters and receivers produce and read).

**Rules for every shape:**
- **Minimum necessary.** Only what the partner needs; never an SSN (D27, D43).
- **Money and dates are strings.** Money is a decimal string in USD with two fraction digits (D40); dates are `YYYY-MM-DD`; times are UTC with `Z`.
- **`x-phi` on every field,** with the values the API contract uses (`docs/EXTENSIONS.md`), so logs and reviews treat the fields the same way. Payloads are never logged.
- **Closed objects** (`additionalProperties: false`): an unknown field is an error, not a silent drop.
- **The outbox row holds IDs only.** `enqueue()` stores the IDs of the records; the adapter builds the full message at send time (`backend/app/integration/api.py`).
- **Examples are synthetic** (Synthea-style names, `TEST` member IDs) and are the recorded replies the backend tests file.

## Clearinghouse: eligibility (the 270 and 271)

| File | Message | Produced by | Consumed by |
|---|---|---|---|
| [clearinghouse/eligibility-request.schema.json](clearinghouse/eligibility-request.schema.json) | The eligibility request, our 270 | The clearinghouse adapter in the outbox worker (Thulasi), from `build_request()` in `backend/app/modules/eligibility/service.py` (Vimal), for the outbox message `clearinghouse` / `270` | The simulated payer for the demo (Thulasi); later the real clearinghouse |
| [clearinghouse/eligibility-response.schema.json](clearinghouse/eligibility-response.schema.json) | The payer's answer, our 271 | The simulated payer; later the real clearinghouse | The `/hooks/clearinghouse` receiver (Thulasi), which hands the body to `record_response()` in the eligibility service (Vimal) |
| [clearinghouse/examples/](clearinghouse/examples/) | A request for a subscriber and for a dependent; replies: active with copay and deductible, inactive, payer error, member not found | Recorded synthetic messages | `backend/app/modules/eligibility/tests/` |

The request carries the payer, the provider's NPI, the subscriber's member ID, name and date of birth (and the patient's, when the patient is a dependent), the service date, the service type codes and our check ID as `correlationId`. The reply echoes `correlationId` and says `active`, `inactive`, `member-not-found` or `error`, with the plan, the benefit lines (copay, deductible and what remains of it, coinsurance, out-of-pocket) and the payer's error codes. It is filed once: a second reply for the same `correlationId` changes nothing.

**X12 is the clearinghouse's job.** These shapes name the X12 segments they stand for, but mapping them to and from X12 005010X279A1 is done by the real clearinghouse's adapter once the vendor is chosen (Q11); until then the simulated payer speaks these JSON shapes directly.

## Pharmacy: e-prescribing (NewRx and its status)

| File | Message | Produced by | Consumed by |
|---|---|---|---|
| [pharmacy/new-rx.schema.json](pharmacy/new-rx.schema.json) | A signed prescription for the pharmacy, our NewRx | The e-prescribing adapter in the outbox worker (Thulasi), from `build_new_rx()` in `backend/app/modules/medications/service.py`, for the outbox message `erx` / `NewRx` that signing queues (D97, D99) | The simulated pharmacy for the demo (Thulasi); later the e-prescribing vendor (Q12) |
| [pharmacy/rx-status.schema.json](pharmacy/rx-status.schema.json) | The pharmacy's answer: `accepted`, or `rejected` with a reason | The simulated pharmacy; later the vendor | The `/hooks/erx` receiver (Thulasi), which hands the body to `record_status()` in the medications service |
| [pharmacy/examples/](pharmacy/examples/) | A NewRx for a coded drug and for a drug written as text; replies: accepted, rejected with a reason, rejected with only a code | Recorded synthetic messages | `backend/app/modules/medications/tests/` |

The NewRx carries our prescription ID as `correlationId`, when it was signed, the prescriber's NPI and name, the patient's legal name and date of birth, the pharmacy's NCPDP ID (and NPI when known), and the drug: its RxNorm code (when it has one) and name, the quantity and unit, days' supply, refills, whether generic substitution is allowed, the sig, the DEA schedule of a controlled substance and the note to the pharmacist. Nothing else about the patient: no address, phone, gender, insurance or diagnosis. The quantity is a decimal string, never a floating-point number.

**The transmission's way:** signing records it `queued` with the outbox message; the adapter records `sent` when the NewRx is delivered (`record_sent()`); the reply moves it to `accepted` or `rejected`; when the outbox gives up it is `error` (`record_failed()`), and an operator's replay queues it again. Each change publishes `prescription.transmission-updated`. A reply is filed once per `correlationId`: a second reply, or any reply after `accepted` or `rejected`, changes nothing. A rejection's `message` is shown to the prescriber as the transmission's message, so it is clinical data; without one, the prescriber sees a fixed message for the code.

**NCPDP SCRIPT is the vendor's job.** The shapes name the SCRIPT elements they stand for; mapping them to and from NCPDP SCRIPT 2017071 is done by the vendor's adapter once the vendor is chosen (Q12). Controlled substances need EPCS (Q19), which these shapes don't cover.

## Lab and imaging: orders, acknowledgements and results

| File | Message | Produced by | Consumed by |
|---|---|---|---|
| [lab/lab-order.schema.json](lab/lab-order.schema.json) | A signed lab or imaging order (`orderControl` `NW`), or its cancel (`CA`), our ORM^O01 | The lab adapter in the outbox worker (Thulasi), from `build_lab_order()` in the orders module, for the outbox message `lab` / `ORM^O01` that signing or cancelling queues (D25) | The simulated lab and imaging center for the demo (Thulasi); later the lab vendor (Q14) |
| [lab/lab-order-status.schema.json](lab/lab-order-status.schema.json) | The center's acknowledgement: `received` (with its filler order number), `rejected` with a reason, or `cancelled` | The simulated center; later the vendor | The `/hooks/lab` receiver (Thulasi), which files it against the order |
| [lab/lab-result.schema.json](lab/lab-result.schema.json) | The result for one order, our ORU^R01: a report with its results, each a UCUM quantity or a narrative | The simulated center; later the vendor | The `/hooks/lab` receiver, which files a `DiagnosticReport` and its `Observation`s against the order |
| [lab/examples/](lab/examples/) | Orders for an HbA1c and a chest X-ray, and a cancel; replies: received, rejected; results: the HbA1c (a value) and the chest X-ray (a narrative with a conclusion) | Recorded synthetic messages | The orders module's tests |

The order carries our order ID as `correlationId`, when it was signed, the ordering clinician's NPI and name, the patient's legal name, date of birth and administrative sex (for the reference ranges), the center, the test (LOINC, name and the center's own code), the priority, up to four of the visit's ICD-10-CM codes for medical necessity, and the note to the center. Nothing else about the patient: no address, phone, insurance or MRN. A cancel carries only the `correlationId`, the reason and, once the center has acknowledged the order, its filler order number. Values and reference ranges are decimal strings, never floating-point numbers.

**The order's way:** signing queues `ORM^O01` (tracking status `ordered`); the adapter records `sent`; the acknowledgement moves it to `received` (or `error` on `rejected`); the result files the report and moves it to `resulted`. A result for an unknown or cancelled order is refused (`409` to the hook) and filed nowhere. A reply is filed once per `responseId`; a `corrected` report amends the earlier one.

**HL7 v2 is the lab vendor's job.** The shapes name the HL7 v2 segments and fields they stand for (MSH, PID, ORC, OBR, OBX, MSA); mapping them to HL7 v2 over MLLP (D4) is done by the lab vendor's adapter once the lab is chosen (Q14). Until then the simulated center speaks these JSON shapes directly.

**Changing a shape:** a compatible change (a new optional field) keeps `schemaVersion`; anything else is a new major version, agreed with Thulasi first, because the simulated payer, pharmacy or lab and the receiver change with it.
