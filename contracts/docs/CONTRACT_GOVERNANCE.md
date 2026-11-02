# Contract governance

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Vimal (contract owner); Thulasi (CI and branch protection, which she owns). **Thulasi signed off T2–T6 on issue #3 (2026-10-22); applied below.**

Fixed by source documents:

- `contracts/openapi/` is the single source of truth; nobody changes an endpoint's shape without a contract pull request first (TW §1, §5).
- Vimal reviews every contract change (TW §5 step 1); CODEOWNERS gives `/contracts/` to Vimal (TW §3).
- Module owners approve the contract sections they implement (`x-owner`); Vimal approves standards conformance for all (VD-SIGN).
- CI checks: Spectral lint, oasdiff breaking-change check against `main`, generated client up to date, Schemathesis against the running API (TW §4).
- Small pull requests (aim under about 400 changed lines), merged at least daily, branch names `<name>/<short-task>` (TW §3).
- Branch protection is not available on the organization's current GitHub plan for private repositories, so "PR only" and "code-owner review required" are kept by agreement until it is (ADR-0001). The approval and label rules below are therefore also kept by agreement until then, with the team's merge rule (DECISIONS D74): every requested file owner has approved the PR's latest commit, and CI is green.

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

**Extensible and strict enums.** A response enum that is expected to grow (new values with later batches) is written as an **`x-extensible-enum`** list instead of `enum` (API_STANDARDS §6.5). Clients must render a value they do not know safely: show the raw value, or fall back to a generic label, never fail or hide the record. Every other enum stays a strict `enum`.

| Enum change | Classification |
|---|---|
| Adding a value to an `x-extensible-enum` | Governed: announce it in the PR and the changelog; not blocked. oasdiff does not report it |
| Adding a value to a strict `enum` in a response | **Breaking** (§4.2): clients may rely on the closed list. oasdiff reports `response-property-enum-value-added` as an error |
| Removing a value from any enum, or turning an `x-extensible-enum` back into a strict `enum` | **Breaking** (§4.2). oasdiff reports it for request enums; for an `x-extensible-enum` in a response it is caught in review |
| Making a strict response enum extensible | Needs Vimal's approval in the PR; oasdiff does not report it as breaking |

There is no severity override for oasdiff: the breaking check runs with its default levels and fails on warnings as well as errors (`--fail-on WARN`). oasdiff rates some changes that this table calls breaking as warnings, for example removing a request property, because it does not consider `additionalProperties: false`.

**Governed (announce, not blocked):** adding a value to an `x-extensible-enum`; adding a new event type.

### 4.2 Process

1. **Avoid it.** Prefer an additive alternative: a new field next to the old one, a new endpoint next to the old one.
2. If it cannot be avoided: label `breaking-change`; list every consumer; get approval from Vimal and every affected owner. CI's oasdiff check passes only with the `breaking-change-approved` label applied **by Vimal after the PR's latest commit**; a new commit needs the label re-applied. Labels cannot be restricted on the Free plan, so the CI job checks through the GitHub API who applied the label (T3).
3. **Deprecate first:** mark `deprecated: true`, add `Deprecation` and `Sunset` headers (API_STANDARDS §2), announce in `#shri-dev` and the changelog.
4. Remove after the deprecation period (at least 30 days or two releases), once consumers have moved.
5. **Exception:** a security fix may break immediately with Vimal's and Thulasi's approval; consumers are told the same day.

## 5. Lint ruleset (enforced by Spectral in CI)

Base: `spectral:oas` (recommended rules) plus `@stoplight/spectral-owasp-ruleset` (TOOLCHAIN §5), plus our custom rules. Severity `error` fails CI; `warn` is shown in review. Implemented in Stage 3: `contracts/openapi/.spectral.yaml`, with the custom rule functions in `contracts/openapi/rules/`.

**Every custom rule is tested.** `npm run lint:fixtures` checks that each rule has a fixture `contracts/tests/lint-fixtures/<rule>.yaml` that breaks only that rule, runs the rule on its own against it, and fails unless the rule reports it. It also lints a compliant sample module (`tests/lint-fixtures/valid/sample-module.yaml`, added to a copy of the real root) with the full ruleset and fails on any error, so the rules do not fire on correct input.

**Base rules we changed, and why:**

| Base rule | Change | Reason |
|---|---|---|
| `operation-operationId-unique` | Raised to error | Uniqueness is part of `shri-operation-id` |
| `oas3-unused-component` | Off in Stage 3 | No paths reference the components yet; re-enable (warn) in Stage 4 |
| `info-contact` | Off | API contact not decided |
| `owasp:api2:2023-no-credentials-in-url` | Redefined with the same check and message on real parameter lists (`rules/noCredentialsInUrl.js`), with **one exception**: `token` in the query of `GET /files/{fileId}/content` (D105), allowed only while that operation needs the session cookie and its `200` sends `Referrer-Policy: no-referrer`; `tests/no-credentials-in-url.test.mjs` proves the exception stays that narrow | The original JSONPath also visits schema properties named `in` (our `FieldError.in`, API_STANDARDS §9.1) and crashes Spectral. The exception: the browser follows a download link as a plain download, so the one-time token has to be in the URL; it is not a credential on its own (the same user's session must come with it), it is accepted once for about one minute, the query string is never logged on that route, and it is never sent on as a Referer |
| `owasp:api2:2023-write-restricted` | Off | Partner callbacks are verified by signature in middleware, not by an OpenAPI security scheme; `shri-security` enforces session and CSRF on every other write |
| `owasp:api4:2023-string-restricted` | Off | Free text has no meaningful pattern; `shri-string-limits` requires `maxLength` (or enum, const, format) on every string |
| `owasp:api8:2023-define-cors-origin` | Off | The API is same-origin (SPA, API and Keycloak at `/kc/`), so no CORS headers (SECURITY_MODEL §2.1) |

We comply with the other OWASP rules, for example integer formats and limits, rate-limit headers on every 2xx and 4xx response, and `x-internal` on servers.

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
| `shri-infra-server` | error | `/health` and `/hooks/*` override `servers` with `/`; no other path overrides `servers`; `/ready` is not in the contract (added in Stage 3 for API_STANDARDS §2 and Thulasi T24) |
| `shri-no-dev-user` | error | The `X-Dev-User` header (Thulasi's development and test stand-in login, PR #7) never appears anywhere in the contract (added 2026-10-22) |
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

Test environment: Docker Compose with the API, PostgreSQL 18 with the locked schema (ADR-0011), the RDS pgvector version and C.UTF-8 collation (D31, D33), the read-only `/fhir` API, and synthetic data from Synthea (TA §8); two test clinics to prove isolation; one test user per role from SECURITY_MODEL §4.3 (Thulasi's skeleton already has the two clinics, T5). FastAPI's own `/openapi.json` is served only outside production (already so in the skeleton, T6). No real patient data (D12).
