# API standards

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Vimal (whole document); Thulasi (§9 errors, §10 idempotency, §12 404 vs 403, §16 webhooks, §17 rate limits, §18 headers); Anand (§5 IDs, §6.3 money, §15 files); Minalini (§3 casing, §8 pagination shape). **Thulasi signed off her sections on issue #3 and Minalini hers on issue #5 (2026-10-22), with the additions applied below.**

Every endpoint in `contracts/openapi/` follows these rules. Where a rule comes from a source document it is cited. Everything else is **PROPOSED** with a one-line reason. There is one way to do each thing; exceptions need an ADR.

Related: [SECURITY_MODEL.md](SECURITY_MODEL.md), [DATA_OWNERSHIP.md](DATA_OWNERSHIP.md), [EVENTS.md](EVENTS.md), ADRs in `docs/adr/`.

---

## 0. Constants

Values used in more than one rule are defined once here.

| Constant | Value | Status |
|---|---|---|
| `COMPANY_DOMAIN` | `company-domain.invalid` (placeholder) | **Open, pending management through Vimal:** a domain the organization owns. The placeholder uses the reserved `.invalid` name (RFC 2606) so it is a valid URI part and can never resolve. When the domain is confirmed, it is replaced in the contract (`Problem.type` pattern and examples), in this table, and in `core/errors.py` settings (Thulasi, PR #7) together |
| Problem type base | `tag:company-domain.invalid,2026:problem/` | Exactly this string, everywhere: docs, `components/schemas/Problem.yaml` (enforced by its `pattern`), examples, lint fixtures and Thulasi's `core/errors.py` default (PR #7). Derived from `COMPANY_DOMAIN` (§9.1) |
| FHIR identifier system base | `https://fhir.company-domain.invalid/sid/` | Derived from `COMPANY_DOMAIN` (DATA_OWNERSHIP §3.1) |

## 1. Principles

1. **Contract first.** The OpenAPI document is written before the code and is the source of truth (TW §1, §5; ADR-0002).
2. **Minimum necessary.** A response carries only what the screen or caller needs (HIPAA minimum-necessary standard; your rule 3). See SECURITY_MODEL §8.
3. **No PHI in URLs** (VD-G2, ADR-0005).
4. **Predictable over clever.** The same thing looks the same in every module.
5. **The contract hides storage.** Clients never see database table or column names: each module's repository maps them to contract camelCase (D20). FHIR shapes are not exposed through `/api/v1`; outside FHIR clients use Anand's read-only `/fhir` API (D22, VD-SCOPE).

## 2. Base URL, versioning and deprecation

| Rule | Detail | Source |
|---|---|---|
| Base path | `/api/v1` | CAT conventions |
| Infrastructure paths outside the version | `/health` and `/hooks/{partner}`, both public through Nginx and documented in the contract under a separate server entry. `/ready` is **internal only** (load balancer and Compose) and **not in the contract** | Partner callback URLs and health checks must not change when the API version changes. **Agreed (Thulasi, T24)** |
| Version in the path only | Major version only (`v1`, `v2`). No version headers, no media-type versioning. | **PROPOSED**: simplest for the generated client and Nginx routing (ADR-0010) |
| Non-breaking changes | Added endpoints, added optional request fields, added response fields: allowed within `v1` | ADR-0010; definition of "breaking" in CONTRACT_GOVERNANCE §4 |
| Breaking changes | Avoided. If unavoidable: add a new endpoint or field alongside the old, deprecate the old. A new major version only for system-wide redesign. | ADR-0010 |
| Deprecation signal | `deprecated: true` in the contract, plus response headers `Deprecation` (RFC 9745, e.g. `Deprecation: @1798761600`) and `Sunset` (RFC 8594, HTTP date). `Link: <…>; rel="deprecation"` points to the change note. | RFC 9745 (published March 2025, Standards Track; checked 2026-10-22) |
| Deprecation period | At least 30 days, or two releases, whichever is longer, between `Deprecation` and `Sunset` | **PROPOSED**: only our own SPA consumes `/api/v1` today; extend when outside clients exist |
| After sunset | `410 Gone` with Problem code `gone` | **PROPOSED** |

## 3. Naming

| Item | Rule | Example |
|---|---|---|
| Language | U.S. English in every identifier and description | `favorites`, `license` (VD-G9) |
| Paths | Lowercase kebab-case, plural nouns, at most two levels of nesting below a top-level resource | `/patients/{patientId}/coverages/{coverageId}` (VG Step 1) |
| Actions | `POST /<collection>/{id}/<verb>` in kebab-case | `POST /appointments/{appointmentId}/check-in` (VG Step 1) |
| Search with PHI | `POST /<collection>/search` | `POST /patients/search` (VD-G2) |
| Path parameters | camelCase, named after the resource: `{patientId}`, never bare `{id}` in the contract | **PROPOSED**: avoids ambiguity in nested paths and generated code |
| JSON properties and query parameters | camelCase | `birthDate`, `nextCursor`. **Agreed (Minalini, M1)**: matches TypeScript and FHIR JSON; Pydantic aliases it on the Python side |
| Timestamps | End in `At` | `createdAt`, `signedAt` |
| Dates | End in `Date` | `birthDate`, `serviceDate` |
| References | `<thing>Id` for an ID; `<thing>` for an embedded summary object | `providerId`, `provider: { id, displayName }` |
| Booleans | Adjective or participle, no `is`/`has` prefix | `restricted`, `active`, `aiGenerated` (matches FHIR style) |
| Arrays | Plural | `identifiers`, `codings` |
| Enum values | FHIR codes where FHIR defines the concept (exact spelling, e.g. `checked-in`, `noshow`, `entered-in-error`); otherwise lowercase kebab-case | §6.5 |
| operationId | camelCase verb + noun, unique: `searchPatients`, `checkInAppointment`, `signNote` | **PROPOSED**: becomes the function name in the generated client |
| Tags | One per module, matching the folder name: `patients`, `scheduling`, `eligibility`, `encounters`, `history`, `ai`, … | VG Day 1 item 1 |
| Schema names | PascalCase singular. Variants by suffix: `Patient`, `PatientSummary`, `PatientCreate`, `PatientPatch`, `PatientList` | **PROPOSED**: separate request and response schemas instead of `readOnly` flags; clearer generated types |
| Abbreviations | Treated as words in camelCase: `npi`, `mrn`, `aiSuggestionId`, `ccdaDocumentId` | **PROPOSED** |

## 4. Methods and status codes

| Method | Use | Success | Notes |
|---|---|---|---|
| GET | Read one resource or a list | 200 | Never changes state. Never carries PHI in the query string. |
| POST (collection) | Create | 201 + `Location` + body | |
| POST (`…/search`) | Search involving PHI | 200 | Not a create; never cached |
| POST (`…/{id}/<action>`) | Run an action | 200 + the updated resource, or 202 + operation (§13) | |
| PATCH | Partial update, JSON Merge Patch | 200 + updated resource | §7.3; `If-Match` required (§11) |
| PUT | Replace a singleton sub-resource | 200 | Only where the catalogue says so: `/patients/{patientId}/preferred-pharmacy`, `/me/favorites`, `/admin/ai-settings`, `/users/{userId}/roles` |
| DELETE | **Not used** in the MVP contract | — | Clinical: no DELETE (CAT, TW §7, VD-G1). Non-clinical: none needed in the catalogue; any future DELETE needs an ADR |

Allowed error statuses are listed in §9.3. `204 No Content` is used only for `POST /auth/logout` (**PROPOSED**: nothing to return).

## 5. Resource IDs

| Rule | Detail | Source |
|---|---|---|
| Format | UUID (RFC 9562), lowercase, canonical 36-character form; OpenAPI `type: string, format: uuid` | TA §6.1 (UUID keys); ADR-0009 |
| Generation | Server-generated. Clients never choose IDs. | **PROPOSED**: one generator, no collisions across tenants |
| Version | UUIDv4: Python-side `uuid4` for primary keys, `gen_random_uuid()` for the audit `event_uuid`, as Sam's schema does | D29, ADR-0009 (a time-ordered ID would expose each record's creation time) |
| Opaque | Clients must not parse IDs or infer order or time from them | ADR-0009 |
| Clinical records | FHIR-shaped clinical rows use the same UUID format; the `/fhir` API serves them under the same ID. Each record has exactly one ID in one database (ADR-0011) | ADR-0009, ADR-0011 |
| Business identifiers | MRN, NPI, claim numbers, member IDs and driver's license numbers are properties, never IDs, and (except NPI) never appear in URLs | VD-G2 |
| Unknown ID | `404 not-found` (also for IDs belonging to another clinic, §12) | |

## 6. Data types

### 6.1 Dates and times

| Kind | Format | Example | Source |
|---|---|---|---|
| Instant (when something happened) | RFC 3339 `date-time`, always UTC with `Z` in responses, at most millisecond precision. Requests may send any offset; the server normalizes to UTC. Local times without an offset are rejected. | `"2026-11-03T14:30:00Z"` | Your Stage 2 brief (ISO 8601, UTC) |
| Calendar date (no time zone) | `date`, `YYYY-MM-DD` | `"birthDate": "1984-07-19"` | Your Stage 2 brief |
| Partial date (history, onset) | `PartialDate`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD` | `"performedDate": "2011-05"` | **PROPOSED**: patients often remember only a year for surgery or onset; FHIR allows partial dates |
| Appointment day queries | `date` interpreted in the facility's time zone | `GET /appointments?date=2026-11-03&facilityId=…` | **Agreed** (Anand A22, D28; D40): each facility stores an IANA time zone (e.g. `America/New_York`) |
| Facility time zone | Returned as `timeZone` on facility and on day-view responses so screens can display local time | `"timeZone": "America/Chicago"` | **PROPOSED** |
| Durations | Integer with the unit in the name | `durationMinutes: 20` | **PROPOSED**: avoids ISO 8601 duration parsing in clients |
| Age | Never stored or sent; derived from `birthDate` on screen | — | **PROPOSED**: avoids stale data |

### 6.2 Strings, contact data and names

| Item | Rule |
|---|---|
| Every string | Has `maxLength`. Enumerated values use `enum`, or `x-extensible-enum` for a response enum that may grow (§6.5). Free text is normalized to Unicode NFC and trimmed. |
| Phone | E.164: `"+16175550123"`. Optional `extension`. |
| Email | `format: email`, max 254. |
| Address | `{ lines: [string] (max 3), city, state (USPS 2-letter), postalCode (ZIP `12345` or ZIP+4 `12345-6789`), country: "US" }` |
| Person name | `{ given: [string], family, prefix?, suffix? }` (mirrors FHIR HumanName) |
| Display name | `displayName` is a server-formatted string for lists; never parsed by clients |

### 6.3 Money

**Agreed** (Anand A21, D28; exact decimals in USD, D40): `Money = { "value": "125.00", "currency": "USD" }`.

- `value` is a decimal **string** with exactly two fraction digits (`^-?\d{1,9}\.\d{2}$`), so JavaScript never rounds it as a float.
- `currency` is ISO 4217; only `USD` in the MVP.
- Field names follow FHIR `Money` (`value`, `currency`). Negative values only where documented (adjustments, refunds).

### 6.4 Clinical quantities and codes

| Type | Shape | Notes |
|---|---|---|
| `Quantity` | `{ "value": 98.6, "unit": "[degF]" }` | `unit` is a UCUM code (system `http://unitsofmeasure.org`). Numbers are JSON numbers. |
| `Coding` | `{ "system": "<URI>", "code": "<code>", "display": "<text>" }` | `display` is optional and never relied on for logic |
| `CodeableConcept` | `{ "codings": [Coding], "text": "<free text>" }` | Used where FHIR uses CodeableConcept |

Code system URIs (FHIR canonical):

| System | URI |
|---|---|
| ICD-10-CM | `http://hl7.org/fhir/sid/icd-10-cm` |
| CPT | `http://www.ama-assn.org/go/cpt` |
| HCPCS Level II | `urn:oid:2.16.840.1.113883.6.285` — confirmed by Anand (A23, D28) |
| LOINC | `http://loinc.org` |
| RxNorm | `http://www.nlm.nih.gov/research/umls/rxnorm` |
| SNOMED CT | `http://snomed.info/sct` |
| NPI | `http://hl7.org/fhir/sid/us-npi` |
| UCUM | `http://unitsofmeasure.org` |

### 6.5 Enumerations

- Use the FHIR value set's codes where FHIR defines the concept (appointment status, encounter status, condition clinical status, allergy criticality, gender, …), with FHIR's exact spelling.
- Our own enums use lowercase kebab-case (`with-provider`, `ai-generated`).
- Enums are strings, never integers.
- **Strict by default.** Every enum is a strict `enum` unless it is a response enum that is expected to grow.
- **Extensible response enums.** A response enum that may grow (for example `OperationKind`, which gains a kind with new batches) lists its values under `x-extensible-enum` instead of `enum`, with `type: string` and a `maxLength`. Clients must render an unknown value safely: show the raw value or a generic label, never fail or hide the record. Adding a value is then a governed change, not a breaking one; removing a value is breaking (CONTRACT_GOVERNANCE §4.1).
- `x-extensible-enum` is never used for a value the client sends: request enums stay strict, so the server rejects a value it does not know.
- Adding a value to a strict response enum is a breaking change (CONTRACT_GOVERNANCE §4).

## 7. Request and response bodies

### 7.1 Media types

| Use | Media type |
|---|---|
| Normal requests and responses | `application/json; charset=utf-8` |
| PATCH | `application/merge-patch+json` (RFC 7396) |
| Errors | `application/problem+json` (RFC 9457) |
| Event stream | `text/event-stream` |
| File content | Never through `/api/v1`; through the file service (§15) |

### 7.2 Shape rules

| Rule | Detail |
|---|---|
| Request schemas | `additionalProperties: false`. Unknown fields → `422 validation-failed` with field code `unknown-field`. **PROPOSED**: catches client typos and stops mass-assignment |
| Response schemas | Clients must ignore unknown fields, so adding response fields is non-breaking |
| Absent vs null | Responses omit fields with no value. `null` appears only in PATCH requests, meaning "clear this field". **PROPOSED**: one meaning for null |
| "Unknown" in clinical data | Never a sentinel (`"N/A"`, `0`, `1900-01-01`). Missing stays missing; where "explicitly unknown" matters clinically, a FHIR `data-absent-reason`-style code is used (FRS §3.4: unknown stays unknown) |
| Create | `201`, `Location: /api/v1/<collection>/<id>`, body = the created resource |
| Single resource | The resource object at the top level (no `data` wrapper) |
| List | Envelope `{ "items": [...], "nextCursor": "…" }` (§8) |
| Caching | Every `/api/v1` response sends `Cache-Control: no-store`. **PROPOSED**: PHI must not sit in browser or proxy caches |
| Summary vs detail | Lists return `<Resource>Summary`; the full `<Resource>` comes from `GET /<collection>/{id}` (SECURITY_MODEL §8) |

### 7.3 PATCH

- JSON Merge Patch (RFC 7396). Fields absent from the patch are unchanged; `null` clears; arrays are replaced whole.
- Only fields listed in `<Resource>Patch` may be sent.
- Status fields are **never** patched. State changes go through action endpoints, so every transition is checked against the state machine in DATA_OWNERSHIP §5.
- `If-Match` is required (§11).

## 8. Pagination, filtering and sorting

### 8.1 Cursor pagination (VG Step 1; ADR-0004; shape agreed by Minalini, M2)

| Rule | Detail |
|---|---|
| Parameters | `limit` (default 25, max 100) and `cursor` (opaque). For `POST …/search`, both go in the body. |
| Response | `{ "items": [...], "nextCursor": "…" }`. No `nextCursor` = last page. |
| Total counts | Not returned by default: counting is expensive on large tables. Screens use "load more". Dashboard and status-board counts come from the dashboard API, not from list totals (M2). Where a screen needs a count, the endpoint documents a `count` field explicitly. |
| Cursor content | Opaque, URL-safe, at most 512 characters. **Must never contain readable PHI** (for example a family name used as a sort key). **Agreed (Thulasi, T22):** the middleware encrypts cursors with AES-GCM, using a key from OpenBao with a key ID for rotation; tenant, user and endpoint are the associated data, and the expiry is inside the encrypted payload. |
| Cursor lifetime | 24 hours. An expired or tampered cursor → `400 invalid-cursor`. |
| Consistency | Keyset pagination for every list (stable under inserts). |

### 8.2 Filtering

- Each list endpoint declares named filter parameters. There is no generic query language.
- Allowed in query strings: UUIDs, enum values, non-PHI dates (for example an appointment day), booleans.
- Not allowed: anything in the PHI denylist (§14.3). Such filters go in `POST …/search`.
- Multiple values repeat the parameter: `?status=booked&status=checked-in`.
- Ranges: `<field>From` (inclusive) and `<field>To`. Inclusive for dates, exclusive for instants. Example: `serviceDateFrom=2026-11-01&serviceDateTo=2026-11-30`.

### 8.3 Sorting

- `sort` is a comma-separated list; a `-` prefix means descending: `sort=-createdAt,id`.
- Each endpoint lists the fields it allows; anything else → `422 validation-failed` with a field error `{ "in": "query", "name": "sort", "code": "not-allowed-value" }` (§9.3).
- Each endpoint documents its default sort, which always ends with `id` so the order is total.
- Sorting by a PHI field is only offered in `POST …/search`.

## 9. Errors: Problem Details (RFC 9457) (ADR-0003)

### 9.1 Shape

```json
{
  "type": "tag:company-domain.invalid,2026:problem/validation-failed",
  "title": "Request validation failed",
  "status": 422,
  "detail": "2 fields are invalid.",
  "instance": "/api/v1/patients",
  "code": "validation-failed",
  "requestId": "0b7e4b0c-3f4e-4d3a-9d0e-0c1b5e2f9a11",
  "errors": [
    { "in": "body", "pointer": "/birthDate", "code": "invalid-format" },
    { "in": "body", "pointer": "/name/family", "code": "required" }
  ]
}
```

| Member | Rule |
|---|---|
| `type` | Absolute URI unique to the problem. **PROPOSED:** an RFC 4151 tag URI: the Problem type base in §0 followed by the code, `tag:company-domain.invalid,2026:problem/<code>`, which needs no hosted page. **Open:** the value of `COMPANY_DOMAIN` (§0). |
| `title` | Fixed English text per `code` |
| `status` | Same as the HTTP status |
| `detail` | Human-readable, **never contains PHI or request values** (for example never "Patient John Smith not found") |
| `instance` | The request **path only**, never the query string |
| `code` | Stable machine key from the catalogue (§9.3). Clients switch on `code`, never on `title` or `detail`. |
| `requestId` | Same as the `X-Request-ID` response header |
| `errors` | Present for `validation-failed` and `business-rule-violation`. Each item has `in` (`body`, `query`, `path`, `header`), `pointer` (RFC 6901, for body) or `name` (for others), and a field `code` (§9.2). Never echoes the submitted value. |
| Extensions | Only those listed per code in §9.3 (for example `mergedIntoId`, `candidateIds`, `currentEtag`) |

`core/errors.py` (Thulasi) produces this shape, including replacing FastAPI's default 422 body (**agreed, T19**). Until `COMPANY_DOMAIN` (§0) is decided, `type` uses a placeholder value from settings.

### 9.2 Field error codes

`required`, `unknown-field`, `invalid-format`, `invalid-type`, `too-short`, `too-long`, `out-of-range`, `not-allowed-value`, `invalid-reference` (an ID that does not exist in this clinic), `conflicting-fields`, `not-editable`.

**400 vs 422** (agreed with Thulasi on PR #7, 2026-10-22): an invalid or unparseable **parameter** (path, query or header: a bad UUID, a number out of range, a malformed `If-Match` or `Idempotency-Key` value) returns `422 validation-failed`, with a field error naming the parameter (`in` + `name`). `400 malformed-request` is **only** for a request **body** that is not parseable JSON. Two specific 400 codes remain in the catalogue for their own cases: `invalid-cursor` and `idempotency-key-missing` (the latter from the IETF draft); **pending Thulasi** to confirm they stay 400.

### 9.3 Error-code catalogue (v1)

Codes are permanent once released; new codes may be added; meanings never change.

| HTTP | `code` | When | Extensions |
|---|---|---|---|
| 400 | `malformed-request` | The request **body** is not parseable JSON. Only this; invalid or unparseable parameters are `422 validation-failed` | — |
| 400 | `invalid-cursor` | Cursor expired, tampered with, or from another endpoint | — |
| 400 | `idempotency-key-missing` | Required `Idempotency-Key` header missing (Idempotency-Key draft-07 §2.7) | — |
| 401 | `unauthenticated` | No valid session | — |
| 401 | `session-expired` | Session ended by idle timeout or logout | — |
| 403 | `permission-denied` | Role lacks the endpoint's `x-permission`. Checked before the record is read, so it reveals nothing about the record | — |
| 403 | `csrf-check-failed` | Missing or wrong CSRF header on an unsafe method | — |
| 403 | `break-glass-required` | Restricted chart; the user may open it with a stated reason (SECURITY_MODEL §5) | `patientId` |
| 404 | `not-found` | Does not exist, **or** belongs to another clinic (§12) | — |
| 405 | `method-not-allowed` | | — |
| 406 | `not-acceptable` | | — |
| 409 | `invalid-state-transition` | Action not allowed in the current state (DATA_OWNERSHIP §5) | `currentState` |
| 409 | `record-locked` | Edit attempted on a signed note or prescription; use an addendum or a new version | — |
| 409 | `booking-conflict` | Slot taken or overlaps another appointment | — |
| 409 | `possible-duplicate` | Registration matches existing patients; resend with `"duplicateCheck": "override"` and a reason to proceed | `candidateIds` (IDs only) |
| 409 | `patient-merged` | The patient was merged into another record | `mergedIntoId` |
| 409 | `idempotency-request-in-progress` | Same key is still being processed (draft-07 §2.7) | — |
| 409 | `feature-disabled` | AI feature switched off for this clinic or user | `feature` |
| 409 | `consent-required` | A required consent (for example recording consent for AI audio) is missing | `consentType` |
| 410 | `gone` | Endpoint past its sunset date | — |
| 412 | `precondition-failed` | `If-Match` does not match the current version | — |
| 413 | `payload-too-large` | | `maxBytes` |
| 415 | `unsupported-media-type` | | — |
| 422 | `validation-failed` | Field-level validation failed, in the body **or in a path, query or header parameter** (including values that cannot be parsed, such as a bad UUID). Each field error names the field: `in` + `pointer` for the body, `in` + `name` for parameters | `errors` |
| 422 | `business-rule-violation` | Valid shape, but a rule rejects it (for example a date of birth in the future) | `errors` |
| 422 | `idempotency-key-reused` | Same key sent with a different body (draft-07 §2.7) | — |
| 422 | `file-not-ready` | Referenced file not scanned clean, wrong purpose, or from another clinic | `fileId` |
| 428 | `precondition-required` | `If-Match` missing where required | — |
| 429 | `rate-limited` | Rate limit hit; `Retry-After` set | — |
| 500 | `internal-error` | Unexpected error; details only in server logs, without PHI | — |
| 502 | `upstream-error` | A partner returned an unusable response to a synchronous call | — |
| 503 | `service-unavailable` | Maintenance or overload; `Retry-After` set | — |
| 504 | `upstream-timeout` | A partner did not answer a synchronous call in time | — |

Operation failures (§13) reuse the same Problem object inside the operation, with these extra codes: `ai-unavailable`, `ai-output-rejected` (output failed schema or grounding validation), `partner-rejected`, `partner-timeout`.

## 10. Idempotency (ADR-0007)

| Rule | Detail | Source |
|---|---|---|
| Header | `Idempotency-Key` | VG Step 1, CAT conventions |
| Standard | Follows IETF draft-ietf-httpapi-idempotency-key-header-07 (latest revision 2025-10-15). **The draft has expired and is not an RFC** (checked 2026-10-22); we adopt its behavior as our own rule. | datatracker.ietf.org |
| Required on | Every POST that reaches a partner or charges money. Marked `x-idempotency: required`. Examples: `POST /eligibility-checks`, `/claims/{claimId}/submit`, `/prescriptions/{prescriptionId}/sign-and-send`, `/orders/{orderId}/sign-and-send`, `/faxes`, `/patients/{patientId}/payments`, `/payments/card-session`. Full list in ENDPOINT_INVENTORY. | Your Stage 2 brief |
| Accepted on | Every other creating POST (`x-idempotency: supported`) so screens can retry safely after a network error. **PROPOSED** | |
| Value | A UUID generated by the client per logical attempt. Servers accept it bare or quoted (the draft's Structured Field form). Other formats → `422 validation-failed` naming the header (`{ "in": "header", "name": "Idempotency-Key", "code": "invalid-format" }`, §9.3). | draft-07 §2.2 recommends UUIDs |
| Scope | Tenant + user + method + path (with IDs) + key | **PROPOSED** |
| Fingerprint | SHA-256 of the canonical request body | **PROPOSED** |
| Retention | 24 hours, then purged | **PROPOSED**: covers client retries; partner-level retries are handled by the integration engine's own message IDs |
| Same key, same body | Return the stored status and body; add header `Idempotent-Replayed: true` | Agreed (T21) |
| Not stored | `5xx` and `429` responses are **not** stored, so a retry runs the request again | Agreed (Thulasi, T21) |
| Same key, different body | `422 idempotency-key-reused` | draft-07 §2.7 |
| Same key, still running | `409 idempotency-request-in-progress` | draft-07 §2.7 |
| Missing when required | `400 idempotency-key-missing` | draft-07 §2.7 |
| Storage | Implemented once in middleware. Stored responses can contain PHI: kept in our PostgreSQL under row-level security, bodies encrypted with `encrypt_field`, purged at expiry | Agreed (Thulasi, T21) |
| Not a replacement | Partner messages also carry the integration engine's own idempotency keys (`integration_message`); the two layers are independent | TA §7.1 |

## 11. Optimistic concurrency (ADR-0008)

| Rule | Detail | Source |
|---|---|---|
| ETag | Every single-resource response (GET, create, PATCH, action) carries a **strong** `ETag` header. The value is opaque. | VG Step 1 |
| Where `If-Match` is required | Every PATCH and PUT; plus the actions `sign`, `cosign` and `addenda` on notes, and `sign-and-send`, `change` on prescriptions | VG Step 1 (notes, prescriptions); **PROPOSED** extension to every PATCH/PUT so there is one rule |
| Other actions | `If-Match` optional; if sent, it is enforced | **PROPOSED** |
| Missing | `428 precondition-required` | RFC 6585 |
| Mismatch | `412 precondition-failed`; the response carries the current `ETag` header so the client can re-read | RFC 9110 §13.1.1 |
| Our database | ETag derived from a row version counter | **Pending schema** |
| Clinical records | The ETag comes from the row version of the FHIR-shaped record (its `meta.versionId`); the helpers' version check (`if_version`) rejects a stale write (ADR-0011) | Anand's guide v2, Step 3 |
| Lists | List items do not carry ETags; clients GET the single resource before editing | **PROPOSED** |
| Autosave | Each successful PATCH returns the new ETag; two tabs editing one draft → the second gets `412` (VG Step 5) |
| Screen | On `412`, the screen shows a "record changed" view so the user can reload and see the difference. Designed by Minalini (M4, issue #5) | |

## 12. 404 vs 403: no discovery across clinics

The order of checks is fixed (**agreed by Thulasi, T11**: 401 → CSRF → 403 permission → 404 → 403 break-glass; the CSRF step is in SECURITY_MODEL §3):

1. **Not logged in** → `401`.
2. **Role lacks the endpoint's `x-permission`** → `403 permission-denied`. This is checked **before** any lookup, so it is the same whether or not the record exists.
3. **Record in another clinic (tenant)** → `404 not-found`, exactly as for a record that does not exist. Row-level security returns zero rows, so the endpoint cannot tell the difference (TA §6.1).
4. **Record in this clinic but outside the user's facility scope** → `404 not-found`, same reasoning as clinics (agreed, T15). Lists called without `facilityId` are filtered to the user's facilities (SECURITY_MODEL §5.1).
5. **Restricted chart without a break-glass grant** → `403 break-glass-required`. The user's own clinic already knows the patient exists (they appear on schedules), and the user needs to be told how to proceed (FRS FR-PAT-01).
6. **Allowed** → normal response.

Additional rules:

- Search results omit records the user cannot see. Restricted patients appear in patient search with summary fields only and `restricted: true`, so staff can request break-glass (agreed, T16).
- Error timing must not reveal existence: the 404 path does the same work as a real lookup (Thulasi; tested in CI).
- Business identifiers are never "probed" through errors: a `possible-duplicate` returns IDs only, and only to users with `patients:create`.

## 13. Long-running work: 202 + operation (PROPOSED; your Stage 2 brief)

| Rule | Detail |
|---|---|
| When | The client needs an outcome that is produced asynchronously: AI transcription, AI note draft, AI chart summary, eligibility check, after-visit summary PDF, exports, C-CDA import and export, onboarding import, outside medication history fetch, medical-necessity check (if partner-backed) |
| Not when | The action completes now and only a later delivery is pending, for example signing a prescription that is then transmitted. Respond `200` with the resource; delivery progress is part of its state machine (DATA_OWNERSHIP §5) and announced by events |
| Response | `202 Accepted`, `Location: /api/v1/operations/{operationId}`, body = `Operation` |
| Operation | `{ id, kind, status, createdAt, updatedAt, completedAt?, result?: { type, id }, error?: Problem }` |
| `status` | `queued` → `running` → `succeeded` \| `failed` \| `cancelled` |
| `kind` | `ai.transcription`, `ai.note-draft`, `ai.chart-summary`, `eligibility.check`, `encounter.after-visit-summary`, `export`, `ccda.import`, `ccda.export`, `onboarding.import`, `medication-history.fetch`, `file.scan`. The list grows with each batch; clients treat an unknown kind as generic long-running work (§6.5) |
| Result | A reference only; the client GETs the result resource with its normal permission |
| Polling | `GET /operations/{operationId}` with `Retry-After` while unfinished |
| Push | Event `operation.completed` to the requesting user over Server-Sent Events (EVENTS.md) |
| Cancel | `POST /operations/{operationId}/cancel` where the kind supports it (AI kinds) |
| Visibility | **Only the user who created the operation**, in the MVP. Other users reach the result through the resource itself (agreed, Thulasi T26). Polling `/operations` does not reset the idle timer (SECURITY_MODEL §2.1) |
| Content | IDs and status only, never PHI |
| Retention | 7 days |
| Owner | `/operations` is shared platform code: x-owner Thulasi (`backend/app/core/`), agreed (T26) |

## 14. Search involving PHI (VD-G2, ADR-0005)

### 14.1 Rule

Any search or filter on a PHI field uses `POST /<collection>/search` with a JSON body. Never a query string, because URLs are written to Nginx logs, browser history, proxies and monitoring tools.

### 14.2 Shape

```json
POST /api/v1/patients/search
{
  "criteria": { "family": "Kuhlman72", "birthDate": "1984-07-19" },
  "limit": 25,
  "cursor": null
}
```

Response: `200` with the list envelope of `PatientSummary` items.

| Rule | Detail |
|---|---|
| Minimum criteria | Patient search needs either an **exact identifier** (MRN, driver's license number, member ID, or the **full phone number**) or at least two criteria (for example family name of 2 or more characters + date of birth). Stops browsing the whole patient list. |
| Phone search | The phone number is patient data, so it is only ever sent in the body. **Exact match on the full number only**, compared as normalized digits (E.164). **No partial-number search in the MVP**: partial matching makes it easy to fish through records (Vimal's answer to M7, 2026-10-22). |
| Result cap | At most 50 results per page for patient search |
| Logging | Criteria values are never logged. Audit records which criteria **fields** were used and which patient IDs were returned (SECURITY_MODEL §6). |
| Caching | `Cache-Control: no-store` |
| Audit | `x-audit` category `phi-read` |

### 14.3 PHI field denylist for URLs (enforced by lint)

Path segments and query parameter names must not include: `name`, `given`, `family`, `firstName`, `lastName`, `birthDate`, `dob`, `phone`, `email`, `address`, `postalCode`, `zip`, `mrn`, `ssn`, `ssnLast4`, `memberId`, `subscriberId`, `licenseNumber`, `driversLicense`, `policyNumber`, `search`, `q` (on patient-scoped collections). Allowed exception: `q` on non-PHI catalogs (`/codes/search`, `/pharmacies`, `/lab-compendium`), and `postalCode` on `/pharmacies` (the pharmacy's ZIP code), because these search reference data, not patients.

## 15. Files (uploads and downloads)

Files never pass through module endpoints. Module endpoints only reference a `fileId` (CAT Anand section; VG Step 2). Every detail below is agreed by Anand (A24, D28).

1. **Request an upload:** `POST /files/upload-url` with `{ purpose, contentType, sizeBytes, sha256 }` → `{ fileId, uploadUrl, uploadHeaders, expiresAt }`.
2. **Upload:** the browser `PUT`s the bytes directly to `uploadUrl` (object-store quarantine).
3. **Complete:** `POST /files/{fileId}/complete` → `202` + operation; the file service scans, hashes and encrypts it. File states: `pending-upload` → `quarantined` → `clean` | `rejected`.
4. **Attach:** the module endpoint receives `fileId` (for example `POST /patients/{patientId}/coverages/{coverageId}/card-images` with `{ fileId, side: "front" }`). The module checks the file is `clean`, has the expected `purpose`, and belongs to the same clinic; otherwise `422 file-not-ready`.
5. **Download:** `GET /files/{fileId}/download-url` → `{ url, expiresAt }`, valid for a short time (**PROPOSED**: at most 5 minutes). Permission depends on the file's purpose (for example card images need `coverages:read`).

| Rule | Detail |
|---|---|
| `purpose` values | `insurance-card`, `identity` (license images, D56), `receipt` (payment receipts, D58; server-generated), `encounter-audio`, `after-visit-summary`, `document`, `fax`, `ccda`, `export`, `onboarding-import`. Each purpose maps to one read permission for the download link (`FilePurpose` in `files.yaml`); a purpose with no mapping is denied |
| Allowed types and sizes | Declared per purpose. `insurance-card`: **JPEG and PNG for P0**, at most 10 MB (agreed, Minalini M13 and Vimal). HEIC (iPhone photo format) only if Anand's file service converts it for display — **pending Anand** |
| Long audio | Multipart upload with several part URLs (agreed, A24) |
| Secrecy | Upload and download URLs are bearer secrets: never logged, never stored by clients, never put in events |
| File names | Not stored from the client by default (a name can contain PHI) — **PROPOSED** |

## 16. Webhooks

### 16.1 Inbound partner callbacks (`/hooks/{partner}`, owner Thulasi)

| Rule | Detail |
|---|---|
| Location | Outside `/api/v1` (§2), public through Nginx, e.g. `/hooks/clearinghouse`, `/hooks/erx`, `/hooks/fax`, `/hooks/sms` (CAT; agreed T24) |
| Audit | Callbacks carry PHI: audited as `phi-write` with the **partner as actor** (agreed, T37; SECURITY_MODEL §6) |
| Authentication | Partner's signature scheme verified by middleware; no session or CSRF. `x-permission: partner-signed` |
| Replay protection | Reject timestamps outside a 5-minute window where the partner's scheme carries a timestamp; deduplicate on the partner's event or message ID |
| Processing | Store the raw payload (encrypted) first, reply `2xx`, then process asynchronously (TA §7.1) |
| Responses | No PHI and no internal detail in responses. Invalid signature → `401` with an empty-detail Problem |
| Contract | Documented under tag `partner-callbacks`, excluded from the generated browser client |

### 16.2 Outbound webhooks

None in the MVP. If added later, follow the Standard Webhooks specification and the OpenAPI 3.1 `webhooks` section. **PROPOSED**

## 17. Rate limits

| Rule | Detail |
|---|---|
| Who sets them | Thulasi: coarse limits in Nginx, per-user limits in the app (D3; agreed T23) |
| Response on limit | `429 rate-limited` with `Retry-After` (RFC 9110) |
| Advertising limits | `RateLimit-Policy` and `RateLimit` headers as in IETF draft-ietf-httpapi-ratelimit-headers-11 (an active draft, not an RFC; checked 2026-10-22), e.g. `RateLimit: "default";r=50;t=30`. **Agreed (T23)**: adopt now, since only our SPA reads them; revisit when the RFC is published |
| Login and search | Stricter limits on `/auth/*` and every `POST …/search` (enumeration risk); agreed (T23) |

## 18. Standard headers

| Header | Direction | Rule |
|---|---|---|
| `X-Request-ID` | Both | A client-sent value is accepted **only if it is a valid UUID**; otherwise the server generates one (stops log injection). The server always returns it; repeated in Problem `requestId`. Agreed (T20) |
| `traceparent` | Both | W3C Trace Context for OpenTelemetry (TA §8); propagated (T20) |
| `X-CSRF-Token` | Request | Required on every unsafe method, including `/auth/refresh` and `/auth/logout`; `Origin` also required (SECURITY_MODEL §2.2; agreed T8) |
| `Idempotency-Key` | Request | §10 |
| `If-Match` / `ETag` | Both | §11 |
| `Location` | Response | On `201` and `202` |
| `Retry-After` | Response | On `202` (polling), `429`, `503` |
| `Deprecation`, `Sunset`, `Link` | Response | §2 |
| `RateLimit-Policy`, `RateLimit` | Response | §17 |
| `Cache-Control: no-store` | Response | Every `/api/v1` response (§7.2) |
| `Idempotent-Replayed` | Response | §10 |

## 19. Events

Domain events and the Server-Sent Events stream follow [EVENTS.md](EVENTS.md). Event payloads carry IDs only, never PHI.

## 20. Examples and test data

Examples in the contract are what the mock server returns, so they must be safe:

| Rule | Detail | Source |
|---|---|---|
| Synthetic only | Invented people; no real patient data ever | D12, FRS §6 |
| Names | Synthea-style: a common first or last name followed by digits, as Synthea generates them (e.g. `Ramona980 Kuhlman72`). Never celebrity, staff or real patient names | Your Stage 2 review; D12 (Synthea) |
| Phone numbers | U.S. fictional range `555-0100` to `555-0199` (e.g. `+16175550123`) | **PROPOSED** |
| Email | `@example.com`, `@example.org`, `@example.net` only (reserved, RFC 2606) | |
| Identifiers | MRNs, member IDs and license numbers carry a `TEST` prefix | **PROPOSED** |
| SSN | Never in examples, not even last 4 (VD-SSN) | |
| Codes | ICD-10-CM codes may show descriptions (public domain). CPT codes appear **without** descriptions until the AMA license question (TA ADR-18) is settled | **PROPOSED** |
| Dates | Plausible but invented; birth dates of adults | |
| Lint | Spectral rules check phone, email and SSN patterns in examples (CONTRACT_GOVERNANCE §5) | |

## 21. Contract extensions (vendor fields)

| Extension | On | Values | Required | Purpose |
|---|---|---|---|---|
| `x-owner` | Operation | `vimal`, `thulasi`, `anand`, `minalini` | Yes | Who implements and approves it (VD-SIGN) |
| `x-permission` | Operation | `resource:action`, or `public`, `authenticated`, `partner-signed` | Yes | Thulasi builds checks from it (VG Day 1 item 3; SECURITY_MODEL §4) |
| `x-audit` | Operation | `{ action: C\|R\|U\|E, category, patient: <path param or "body"> }` | Yes | What the middleware audits (SECURITY_MODEL §6) |
| `x-phi` | Schema property | `identifier`, `clinical`, `financial`, `none` | Yes, every property | PHI classification (SECURITY_MODEL §7) |
| `x-idempotency` | Operation | `required`, `supported` | On POSTs | §10 |
| `x-concurrency` | Operation | `if-match-required`, `if-match-optional` | On PATCH, PUT, listed actions | §11 |
| `x-async` | Operation | `true` | When it returns 202 | §13 |
| `x-storage` | Operation | `clinical`, `admin`, `audit`, `files` (ADR-0011) | Yes (informational) | DATA_OWNERSHIP |
| `x-events` | Operation | List of event types published | When it publishes | EVENTS.md |
| `x-release` | Operation | `P0`, `P0-stretch` | Yes | FRS §2 |
| `x-extensible-enum` | String schema in a response | List of known values, in place of `enum` | Only for response enums that may grow | §6.5; CONTRACT_GOVERNANCE §4.1 |

## 22. Open items in this document

Settled on 2026-10-22: JSON casing and list shape (Minalini, #5); hooks and health paths, cursor encryption, idempotency in middleware, facility scope, rate-limit headers, `X-Request-ID` (Thulasi, #3).

| Item | Pending | PROPOSED answer |
|---|---|---|
| `COMPANY_DOMAIN` value (§0) | Vimal (management) | Open: placeholder `company-domain.invalid` |
| Problem `type` URI form | — | `tag:company-domain.invalid,2026:problem/<code>` (accepted form, matches Thulasi's code in PR #7; domain open) |
| Money shape | Anand | `{ value: "125.00", currency: "USD" }` |
| Facility IANA time zone | Anand | Yes |
| File service flow, purposes, limits, multipart; HEIC conversion | Anand | As §15 |
| HCPCS system URI | Anand | Confirm |
