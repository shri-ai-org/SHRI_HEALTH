# Contract extensions (`x-…` fields)

Status: **PROPOSED** (Stage 3, 2026-10-22) · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Vimal; Thulasi (`x-permission`, `x-audit`, `x-phi` are read by her middleware)

OpenAPI lets a contract carry extra fields whose names start with `x-`. We use them to tell people, the middleware and CI what each operation and field needs. The four below are **required** and enforced by the lint ruleset (`contracts/openapi/.spectral.yaml`); the rest are listed in API_STANDARDS §21.

## Required extensions

### `x-owner` — who implements and approves the operation

| | |
|---|---|
| On | Every operation; also each tag in `shri-health.yaml` |
| Values | `vimal`, `thulasi`, `anand`, `minalini` |
| Read by | Reviewers: the owner approves the operation's contract; Vimal approves standards conformance (VD-SIGN). CODEOWNERS adds the owner on each module file (TOOLCHAIN §3, Thulasi T2) |
| Lint rule | `shri-x-owner` |

```yaml
x-owner: vimal
```

### `x-permission` — the permission `require()` checks

| | |
|---|---|
| On | Every operation |
| Values | `resource:action` (pattern `^[a-z][a-z-]*:[a-z][a-z-]*$`), or one of the special values `public`, `authenticated`, `partner-signed` |
| Meaning | `public`: no session (only `/auth/login`, `/auth/callback`, `/health`). `authenticated`: any signed-in user acting on their own data. `partner-signed`: a partner callback verified by signature. Otherwise the user's roles must include the permission (SECURITY_MODEL §1, §4) |
| Read by | Thulasi's middleware: `Depends(require("<permission>"))`, checked before any data is read (API_STANDARDS §12) |
| Lint rules | `shri-x-permission`, `shri-public-allowlist`, `shri-security` |

```yaml
x-permission: notes:sign
```

### `x-audit` — what the middleware writes to the audit log

| | |
|---|---|
| On | Every operation |
| Shape | `{ action, category, patient?, actor? }` — no other members |
| `action` | FHIR AuditEvent action: `C` create, `R` read (including search), `U` update, `E` execute (actions) |
| `category` | `phi-read`, `phi-write`, `sign`, `export`, `security`, `ai`, `admin`, or `none` (only health checks, the public bot-check challenge (D96), session reads and reference catalogs: codes, pharmacies, payer directory, lab providers, lab compendium, slots, booking lists) |
| `patient` | Where the patient ID comes from: a path parameter name (e.g. `patientId`), `body:/<json-pointer>`, `result` (the patients the endpoint reports: the IDs returned by a search or list, or the patient of a downloaded file, for a download link and the download itself, D105), or `session` (portal operations: the signed-in patient, D84). **Required** on paths containing `{patientId}`, and `session` on every operation with a portal session except the five practice-data and session reads allowed `none` (SECURITY_MODEL §6); `session` only under `/portal/` |
| `actor` | `user` (default), `partner` (partner callbacks, Thulasi T37), `patient` (every `/portal/` operation and only those; ADR-0013 §6) or `anonymous` (public operations with no user and no patient session, such as pre-registration, and only those; D96) |
| Behavior | Audit **fails closed**: if the audit write fails, the request fails. Writes are audited in the same transaction; reads before the response is returned. Audit entries never contain request or response bodies (SECURITY_MODEL §6) |
| Read by | Thulasi's middleware |
| Lint rule | `shri-x-audit` |

```yaml
x-audit: { action: R, category: phi-read, patient: patientId }
```

### `x-phi` — how sensitive each field is

| | |
|---|---|
| On | Every property of every schema (also properties that are a `$ref`; OpenAPI 3.1 allows the sibling) |
| Values | `identifier` (a HIPAA identifier: names, patient-related dates, phone, email, address below state, MRN, member ID, license number, photos), `clinical` (health information), `financial` (payment and insurance details), `internal-id` (our opaque UUIDs), `none` (not about a patient) |
| Read by | Middleware log redaction: values of `identifier`, `clinical` and `financial` fields are never logged; `internal-id` may be (SECURITY_MODEL §7). Also reviewers (minimum necessary), the AI gateway (per-task field allowlist), de-identified exports, and the example check |
| Rule of thumb | For a property holding an object or array, use the most sensitive value inside it. Shared types (e.g. `Coding`) mark their own members with the most protective value that applies when they describe a patient |
| Lint rule | `shri-x-phi` |

```yaml
birthDate:
  $ref: '#/components/schemas/Date'
  x-phi: identifier
```

## Optional extensions (API_STANDARDS §21)

| Extension | On | Values | Lint rule |
|---|---|---|---|
| `x-idempotency` | POST operations | `required` (reaches a partner or moves money) or `supported` | `shri-idempotency` |
| `x-concurrency` | Actions that need a version check | `if-match-required` (PATCH and PUT always need `If-Match`) | `shri-if-match` |
| `x-async` | Operations returning `202` | `true` | `shri-async` |
| `x-storage` | Operations | `clinical`, `admin`, `audit`, `files` (informational; one database, ADR-0011; DATA_OWNERSHIP) | not linted; reviewed |
| `x-events` | Operations that publish events | List of event types (EVENTS.md §4) | not linted; reviewed |
| `x-release` | Operations | `P0`, `P0-stretch`, `P1` (the patient portal, D89) | not linted; reviewed |
| `x-extensible-enum` | String schemas in responses that may gain values | List of known values, in place of `enum`; clients render unknown values safely (API_STANDARDS §6.5) | not linted; reviewed. oasdiff reads it natively and does not report an added value (CONTRACT_GOVERNANCE §4.1) |
| `x-internal` | Servers | `false` for our public servers (OWASP API9 inventory rule) | `owasp:api9:2023-inventory-access` |

## Where they are enforced

`npm run lint` (in `contracts/`) checks every rule above on the bundled contract. `npm run lint:fixtures` proves each rule fires on a deliberately broken fixture (`contracts/tests/lint-fixtures/<rule>.yaml`) and stays quiet on a compliant sample (CONTRACT_GOVERNANCE §5).
