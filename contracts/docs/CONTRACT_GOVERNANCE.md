# Contract governance

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Vimal (contract owner); Thulasi (CI and branch protection, which she owns)

Fixed by source documents:

- `contracts/openapi/` is the single source of truth; nobody changes an endpoint's shape without a contract pull request first (TW §1, §5).
- Vimal reviews every contract change (TW §5 step 1); CODEOWNERS gives `/contracts/` to Vimal (TW §3).
- Module owners approve the contract sections they implement (`x-owner`); Vimal approves standards conformance for all (VD-SIGN).
- CI checks: Spectral lint, oasdiff breaking-change check against `main`, generated client up to date, Schemathesis against the running API (TW §4).
- Small pull requests (aim under about 400 changed lines), merged at least daily, branch names `<name>/<short-task>` (TW §3).
- Branch protection is not available on the organization's current GitHub plan for private repositories, so "PR only" and "code-owner review required" are kept by agreement until it is (ADR-0001). The approval and label rules below are therefore also kept by agreement until then.

## 1. Roles

| Role | Who | Responsibility |
|---|---|---|
| Contract owner | Vimal | Standards, shared components, final approval on conformance, release notes |
| Module owner (`x-owner`) | Thulasi, Anand, Minalini, Vimal | Approves shape and behavior of operations they implement |
| Security reviewer | Thulasi | Required when a change touches `x-permission`, `x-audit`, `x-phi`, security schemes, a `public` or `partner-signed` endpoint, or file and webhook endpoints |
| Data reviewer | Anand | Required when a change affects storage (`x-storage`), FHIR mapping, or needs a schema change |
| Main consumer | Minalini | Informed of every change; approval needed when a change affects screens already wired |

## 2. How anyone proposes an API change

1. **Small change you need now** (new optional field, new filter): open a pull request directly.
   **Larger change** (new endpoint, new resource, anything breaking): open a GitHub issue first with the template "API change request" (problem, proposed endpoints, who consumes it, PHI involved?). Vimal replies within one working day (**PROPOSED**).
2. Branch: `<name>/contract-<topic>`, e.g. `anand/contract-superbill-lines`.
3. Edit only the module file under `contracts/openapi/modules/` plus its examples; shared components only with Vimal's agreement first.
4. Run locally: bundle, lint, mock smoke (TOOLCHAIN §4). CI runs them again.
5. Open the pull request with the template below. Label `contract`. Label `breaking-change` if oasdiff reports one.
6. After merge, CI regenerates the mock and the TypeScript client (TW §5 step 2). Implementation follows in a separate pull request by the module owner.

**Pull request template (contract):**

```markdown
## What changes and why
## Endpoints touched (method + path, x-owner)
## Consumers affected (screens, other modules, events)
## Checklist
- [ ] Follows API_STANDARDS (names, IDs, dates, money, errors, pagination)
- [ ] No PHI in path or query parameters; PHI search uses POST …/search
- [ ] x-owner, x-permission, x-audit on every new operation; x-phi on every new property
- [ ] Idempotency-Key / If-Match / 202 declared where the standards require
- [ ] Responses contain only what the consumer needs (minimum necessary)
- [ ] Examples are synthetic (555-01xx phones, example.com, Synthea-style names, TEST identifiers)
- [ ] Bundle regenerated; lint passes; oasdiff result explained below
## oasdiff result
## Breaking? If yes: migration plan and deprecation dates
```

## 3. Review rules

| Rule | Detail |
|---|---|
| Approvals | Vimal **and** the `x-owner` of every touched operation, plus security or data reviewers when §1 says so. Enforced by CODEOWNERS lines per module file (TOOLCHAIN §3, **pending Thulasi**) |
| Review time | Within one working day (**PROPOSED**) so contracts never block daily merges (TW §3) |
| What reviewers check | The PR checklist above, plus: does the change fit the state machine (DATA_OWNERSHIP §5)? Are new error cases mapped to existing Problem codes before adding new ones? Is a new permission really needed, or does an existing one fit? |
| Conflicts | If an owner and Vimal disagree, the standards win unless an ADR changes them; the ADR is decided at the weekly review |
| Generated code | Never edited by hand (TW §7: `frontend/src/api/generated/`) |
| Release notes | Every merged contract PR adds a line to `contracts/CHANGELOG.md` (**PROPOSED**) |
| Contract version | `info.version` follows `1.MINOR.PATCH`: MINOR for added endpoints or fields, PATCH for descriptions and examples. The `v1` path changes only with a new major version (ADR-0010) |

## 4. Breaking changes

### 4.1 Definitions

| Breaking (needs the process in §4.2) | Not breaking |
|---|---|
| Removing or renaming an endpoint, parameter, field or enum value | Adding an endpoint |
| Changing a type or format (e.g. string → number, date → date-time) | Adding an optional request field or parameter |
| Making an optional request field or parameter required | Adding a response field |
| Adding a required request field | Relaxing a constraint (longer `maxLength`, wider range) |
| Tightening validation (shorter `maxLength`, narrower pattern, removing an accepted enum value) | Adding a new Problem `code` for a new situation |
| Changing the meaning of a field, status code or error `code` | Improving descriptions and examples |
| Changing the permission of an endpoint to a stricter one (users lose access) | |
| Changing success status (e.g. 200 → 202) | |
| Removing a response field, even if "unused" | |

**Governed (announce, not blocked):** adding an enum value to a **response** (clients must tolerate unknown values, API_STANDARDS §6.5, but exhaustive `switch` statements in TypeScript will notice); adding a new event type.

### 4.2 Process

1. **Avoid it.** Prefer an additive alternative: a new field next to the old one, a new endpoint next to the old one.
2. If it cannot be avoided: label `breaking-change`; list every consumer; get approval from Vimal and every affected owner. CI's oasdiff check passes only with the `breaking-change-approved` label, which only Vimal applies.
3. **Deprecate first:** mark `deprecated: true`, add `Deprecation` and `Sunset` headers (API_STANDARDS §2), announce in `#shri-dev` and the changelog.
4. Remove after the deprecation period (at least 30 days or two releases), once consumers have moved.
5. **Exception:** a security fix may break immediately with Vimal's and Thulasi's approval; consumers are told the same day.

## 5. Lint ruleset (enforced by Spectral in CI)

Base: `spectral:oas` (recommended rules) plus `@stoplight/spectral-owasp-ruleset` (TOOLCHAIN §5), plus our custom rules. Severity `error` fails CI; `warn` is shown in review.

| Rule | Severity | Checks |
|---|---|---|
| `shri-x-owner` | error | Every operation has `x-owner` with an allowed value |
| `shri-x-permission` | error | Every operation has `x-permission`; value is `public`, `authenticated`, `partner-signed`, or matches `^[a-z][a-z-]*:[a-z][a-z-]*$` |
| `shri-public-allowlist` | error | `public` only on `/auth/login`, `/auth/callback`, `/health`, `/ready` |
| `shri-x-audit` | error | Every operation has `x-audit` with `action`, `category`; patient-scoped paths name the `patient` source |
| `shri-x-phi` | error | Every schema property has `x-phi` with an allowed value |
| `shri-no-phi-in-query` | error | No query or path parameter named in the PHI denylist (API_STANDARDS §14.3) |
| `shri-no-delete` | error | No `delete` operations |
| `shri-paths-kebab` | error | Path segments are lowercase kebab-case; parameters are `{camelCaseId}` |
| `shri-properties-camel` | error | Property and query parameter names are camelCase |
| `shri-us-spelling` | error | No British spellings from a word list (`favourite`, `licence`, `colour`, `organisation`, `authorisation`, `cancelled` is allowed because it is the FHIR code) |
| `shri-operation-id` | error | operationId present, camelCase, unique |
| `shri-tags` | error | Exactly one tag per operation, from the module list |
| `shri-problem-responses` | error | Every 4xx/5xx response uses `application/problem+json` and the shared Problem schema |
| `shri-standard-errors` | error | Every operation documents 401, 403, 429, 500; operations with a path ID document 404 |
| `shri-list-envelope` | error | GET operations returning arrays use the list envelope and accept `limit` and `cursor` |
| `shri-search-post` | error | Operations ending in `/search` are POST and take `limit` and `cursor` in the body |
| `shri-idempotency` | error | Operations with `x-idempotency: required` declare the `Idempotency-Key` header as required and document 400, 409, 422 |
| `shri-if-match` | error | PATCH and PUT declare `If-Match` as required and document 412 and 428 |
| `shri-async` | error | Operations with `x-async: true` return 202 with `Location` and the Operation schema |
| `shri-request-closed` | error | Request body schemas have `additionalProperties: false` |
| `shri-string-limits` | error | Every string property has `maxLength`, `enum`, `format` (date, date-time, uuid, email) or `const` |
| `shri-money` | error | Properties named `*Amount`, `copay`, `deductible`, `balance` use the shared `Money` schema |
| `shri-dates` | error | Properties ending in `At` are `date-time`; ending in `Date` are `date` or `PartialDate` |
| `shri-examples-synthetic` | error | Example phone numbers match `+1XXX55501XX`; emails end in `example.com/.org/.net`; no SSN-shaped strings; identifier examples start with `TEST`; person-name examples are Synthea-style (end in digits) |
| `shri-no-secrets` | error | No examples or defaults that look like tokens or keys (also covered by gitleaks, TW §4) |
| `shri-security` | error | Every non-public operation has a security requirement; POST/PUT/PATCH include `csrfHeader` |
| `shri-cache-control` | warn | Responses document `Cache-Control: no-store` (via shared response headers) |
| `shri-description` | warn | Every operation and schema has a description |

The custom rule functions live in `contracts/openapi/rules/` (Stage 3/5).

## 6. Checking the FastAPI implementation against the contract (described only; built later)

Contract tests run in CI (Thulasi owns CI; each module owner fixes failures in their module).

| Layer | What it does | Tool |
|---|---|---|
| 1. Shape drift | Compare the OpenAPI document FastAPI generates from the code with the contract bundle; any difference in paths, parameters, schemas or status codes fails. FastAPI's own `/openapi.json` is served only in non-production environments (**PROPOSED**: it would reveal the full surface in production). | oasdiff (contract vs generated) |
| 2. Behavior against the schema | Generate valid and invalid requests from the contract, call the running API, and check every response's status code, headers, content type and body against the contract. Uses OpenAPI links for stateful sequences (create → get → update). | Schemathesis |
| 3. Security matrix | For every operation, call it as each test role (SECURITY_MODEL §4.3): expect success only for roles with the operation's `x-permission`, `403 permission-denied` otherwise; no session → `401`; a record of another test clinic → `404`; missing CSRF header on unsafe methods → `403` | Pytest suite generated from `x-permission` and the role matrix |
| 4. Standards checks at runtime | Every error body validates as Problem Details; no PHI-looking values in `detail`; `Cache-Control: no-store` present; required `If-Match` and `Idempotency-Key` behavior (412, 428, 409, 422 replay rules) | Pytest |
| 5. Mock parity | Every example in the contract validates against its schema, and the implementation accepts the request examples | Spectral + Schemathesis examples mode |
| 6. AI-off suite | Rerun layers 2–4 with AI switched off; only AI endpoints may change behavior (`409 feature-disabled`) | Same tools (IP "Testing", FRS §3.4) |

Test environment: Docker Compose with the API, our PostgreSQL, a HAPI test instance and synthetic data from Synthea (TA §8); two test clinics to prove isolation; one test user per role. No real patient data (D12).
