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

**Changing a shape:** a compatible change (a new optional field) keeps `schemaVersion`; anything else is a new major version, agreed with Thulasi first, because the simulated payer and the receiver change with it.
