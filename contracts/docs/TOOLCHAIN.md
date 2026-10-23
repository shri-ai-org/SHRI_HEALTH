# Contract toolchain and versions

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Vimal; Thulasi (CI in `.github/`, which she owns); Minalini (TypeScript client generator). **Thulasi signed off T2–T4 and Minalini chose the client generator (M3) on 2026-10-22; applied below.**

Your rule 5: use current stable versions, checked live, never from memory. Every version below was checked on **2026-10-22** from the source named. Nothing is installed or pinned yet; pinning happens in Stage 5.

## 1. Versions checked on 2026-10-22

| Tool | Purpose | Latest stable | Released | Checked at | OpenAPI support (from the tool's own README/docs) |
|---|---|---|---|---|---|
| OpenAPI Specification | Contract format | **3.1.2** (latest 3.1.x); 3.2.1 is the newest overall | 3.1.2: 2025-09-19; 3.2.1: 2026-09-10 | GitHub releases, OAI/OpenAPI-Specification | — |
| `@stoplight/spectral-cli` | Lint | 6.17.0 | 2026-10-01 | npm | README: OpenAPI 2.0, 3.0, 3.1, 3.2 |
| `@stoplight/spectral-owasp-ruleset` | Security lint rules | 2.0.1 | 2024-03-12 | npm | Built for Spectral. **No release in over two years**; see §5 |
| `@stoplight/prism-cli` | Mock server | 5.16.0 | 2026-07-17 | npm | README: OpenAPI 2.0, 3.0, **3.1** (3.2 not listed) |
| `@redocly/cli` | Bundle multi-file contract; docs preview | 2.67.1 | 2026-10-21 | npm | 3.x |
| `oasdiff` | Breaking-change check against `main` | v1.34.1 | 2026-10-21 | GitHub releases, oasdiff/oasdiff | README: "OpenAPI 3.1 and 3.2 support" page; open issues on some 3.1 edge cases (e.g. `allOf` flattening of 3.1 keywords) |
| `schemathesis` (Python) | Contract tests against the running API | 4.32.3 | 2026-10-21 | PyPI (requires Python ≥ 3.11) | Docs: OpenAPI 2.0, 3.0, 3.1, 3.2 |
| `openapi-typescript` | Considered for TS client types | 7.13.0 | 2026-02-11 | npm | Not chosen (M3) |
| `orval` | **Chosen** TS client generator (Minalini, M3) | 8.44.0 | 2026-10-21 | npm | Minalini pins the version at install, with a custom mutator (one fetch wrapper) that applies the M4 rules: CSRF header, `ETag`/`If-Match`, `Idempotency-Key` per user action, Problem `code` handling |
| Node.js | Runs the npm tools | **24.22.1 LTS "Krypton"** | 2026-10-20 | nodejs.org/dist/index.json | Node 26.12.1 is "Current", not LTS |
| Python | Runs Schemathesis in CI | 3.13 (D12) | — | D12 | Patch version pinned by Thulasi with the backend image |
| PostgreSQL and pgvector | Database for contract tests in CI | PostgreSQL 18, latest 18.x minor; pgvector at the version Amazon RDS ships for PostgreSQL 18 (0.8.2 today); C.UTF-8 collation | — | D24, D31, D33 | Same image in development and CI (Thulasi, with Anand); upgraded only when RDS upgrades |

Not adopted: AsyncAPI (`@asyncapi/cli` 6.2.1 exists). Events are documented in EVENTS.md and as JSON schemas in the contract; a second spec format is not worth it for one SSE stream. **PROPOSED.**

## 2. Decision: OpenAPI 3.1 (ADR-0002)

**Accepted by Vimal on 2026-10-22**, together with the 7-day rule in §5. Still needs Thulasi (CI) and Minalini (client) per ADR-0002.


- **3.1, not 3.2.** The mock server, Prism, lists support up to 3.1 only. Choosing 3.2 would break Stage 5. Spectral, oasdiff and Schemathesis already support 3.2, so we can move when Prism does.
- **3.1, not 3.0.** 3.1 is aligned with JSON Schema 2020-12 (cleaner nullability, `examples`, `const`), and every tool in §1 supports it.
- **Version string.** PROPOSED: `openapi: 3.1.2`, the latest 3.1 patch (patch releases are clarifications only). **Verify in Stage 5** that Prism, Spectral, Redocly, oasdiff and Schemathesis accept `3.1.2`; fall back to `3.1.0` if any rejects it.

## 3. File layout (VD-G8; built in Stage 3)

One file per module plus shared components, bundled into one file for tools. Stage 3 uses a `components/` folder with one file per component, grouped by component type (Vimal's Stage 3 brief), instead of the `shared/*.yaml` files first sketched here.

```
contracts/
├── README.md                     # plain steps
├── package.json, package-lock.json, .nvmrc, .gitignore
├── docs/                         # these documents
├── openapi/
│   ├── shri-health.yaml          # root: info, servers, security, tags (with x-owner), $refs to components and module paths
│   ├── components/
│   │   ├── schemas/              # Id, Timestamp, Date, PartialDate, Money, Coding, CodeableConcept, Quantity, HumanName,
│   │   │                         # Address, PhoneNumber, EmailAddress, Cursor, Limit, ListEnvelope, SearchPaging,
│   │   │                         # Problem, ProblemCode, FieldError, FieldErrorCode, Operation, OperationKind,
│   │   │                         # OperationStatus, EventEnvelope
│   │   ├── parameters/           # Limit, Cursor, IdempotencyKey, IdempotencyKeyOptional, IfMatch, XRequestId, Traceparent
│   │   ├── responses/            # BadRequest 400, Unauthorized 401, Forbidden 403, NotFound 404, Conflict 409,
│   │   │                         # PreconditionFailed 412, UnprocessableContent 422, PreconditionRequired 428,
│   │   │                         # TooManyRequests 429, InternalError 500, ServiceUnavailable 503, Accepted 202
│   │   ├── headers/              # X-Request-ID, Cache-Control, ETag, Location, Retry-After, RateLimit, RateLimit-Policy,
│   │   │                         # Deprecation, Sunset, Link, Idempotent-Replayed, traceparent
│   │   ├── securitySchemes/      # sessionCookie, csrfHeader, delegatedToken
│   │   └── examples/             # synthetic Problem and Operation examples
│   ├── modules/                  # 19 files, one per module tag (partner callbacks live in platform.yaml):
│   │                             # platform, files, practice-setup, onboarding, patients, scheduling, eligibility,
│   │                             # encounters, history, ai, medications, orders, billing, documents, ccda, inbox,
│   │                             # exports, communications, dashboards
│   ├── rules/                    # Spectral custom rule functions (JavaScript)
│   ├── .spectral.yaml            # lint ruleset (CONTRACT_GOVERNANCE §5)
│   ├── redocly.yaml              # structural validation (OpenAPI 3.1)
│   └── dist/shri-health.bundled.yaml   # generated by `npm run bundle`; committed; CI fails if stale
├── scripts/                      # check-layout, build-sample, mock, check-breaking, install-oasdiff
└── tests/lint-fixtures/          # one failing fixture per shri- rule, plus valid/sample-module.yaml
```

| Rule | Reason |
|---|---|
| Each module file holds that module's paths and module-specific schemas | Owners review one file (VD-SIGN) |
| Shared components only in `components/`; modules never copy them | One definition of each thing (your rule 4) |
| Module files may reference `components/` and, rarely, another module's schema; never circular | Keeps bundling predictable |
| `dist/` is generated, never edited by hand; committed so Prism, oasdiff, Schemathesis and the TS generator all read one file | Tools work on a single document (VD-G8) |
| CODEOWNERS adds the implementing owner to each module file (e.g. `/contracts/openapi/modules/billing.yaml @vimalshriai @anandshriai`). **Agreed (T2):** Thulasi adds the lines now that the module files exist, **after** the `/contracts/` line, because the last matching pattern wins. The list is in the Stage 3 PR description | Makes "owners approve their sections" visible in GitHub review requests |

## 4. Commands (scripted in Stage 3)

All tools run from `contracts/` through npm scripts, with exact versions from the lockfile; see [../README.md](../README.md). `oasdiff` is installed by `scripts/install-oasdiff.sh` from its GitHub release with a pinned SHA-256 (the npm package named `oasdiff` is a security placeholder, not the tool). Redocly runs with `REDOCLY_TELEMETRY=off`.

### Versions pinned in Stage 3 (7-day rule; cut-off 2026-10-15, checked 2026-10-22)

| Tool | Pinned | Released | Newest at check | Why not newest |
|---|---|---|---|---|
| `@redocly/cli` | 2.64.0 | 2026-10-15 | 2.67.1 (2026-10-21) | Newer releases are under 7 days old |
| `@stoplight/spectral-cli` | 6.17.0 | 2026-10-01 | 6.17.0 | — |
| `@stoplight/prism-cli` | 5.16.0 | 2026-07-17 | 5.16.0 | — |
| `@stoplight/spectral-owasp-ruleset` | 2.0.1 | 2024-03-12 | 2.0.1 | — |
| `yaml` (scripts) | 2.9.1 | 2026-09-11 | — | — |
| `oasdiff` (GitHub release) | v1.33.0 | 2026-10-01 | v1.34.1 (2026-10-21) | v1.34.x under 7 days old |
| `gitleaks` (local secret scan) | v8.30.1 | 2026-03-21 | v8.30.1 | — |
| Node.js | 24.22.0 in `.nvmrc` | 2026-10-14 | 24.22.1 (2026-10-20) | 24.22.1 under 7 days old |

All npm dependencies, including transitive ones, were resolved with `npm install --before=2026-10-15T23:59:59Z`, so the 7-day rule applies to the whole tree. `npm audit` reports known issues in transitive dependencies of Prism and Spectral (12 high, 6 moderate, 0 critical, on 2026-10-22). They are local development tools that only read our own contract files; re-check at each version review.

## 5. Version policy

| Rule | Reason |
|---|---|
| Exact versions in `contracts/package.json` and `package-lock.json`; no `^` or `~` | Reproducible CI |
| Adopt a release only once it is at least 7 days old | Several tools released yesterday (Redocly, oasdiff, orval, Schemathesis); a short wait avoids broken or compromised releases |
| Re-check versions at Stage 5 and then monthly; record the check date here | Your rule 5 |
| OWASP ruleset 2.0.1 has had no release since March 2024. **PROPOSED:** use it, but copy the rules we rely on into `rules/` if it stops working with the Spectral version we pin | It is still the standard Spectral security ruleset; we must not depend on an unmaintained package silently |
| Node 24 LTS in CI (Thulasi) and locally | LTS = maintained (agreed, T4) |
| GitHub Actions pinned by **commit SHA**, not by tag | A moved tag cannot change what CI runs (agreed, Thulasi T4) |

## 6. CI jobs (agreed by Thulasi, T3; she owns `.github/`)

Two limits of the GitHub Free plan on a private repository (T3): (a) Actions has a monthly minutes cap, so jobs stay lean; (b) labels cannot be restricted to certain people, so `contract-breaking` checks through the GitHub API that the `breaking-change-approved` label was applied by Vimal.

| Job | Runs | Fails when |
|---|---|---|
| `contract-bundle` | Redocly bundle, then `git diff --exit-code contracts/openapi/dist/` | The committed bundle is stale |
| `contract-lint` | Spectral with our ruleset | Any `error` rule fails (CONTRACT_GOVERNANCE §5) |
| `contract-breaking` | oasdiff against `main`'s bundle | A breaking change without the `breaking-change-approved` label **applied by Vimal**, verified through the API (CONTRACT_GOVERNANCE §4) |
| `contract-mock-smoke` | Start Prism, call a few endpoints | Mock does not start or returns invalid examples |
| `client-generated` | Regenerate the TS client, `git diff --exit-code frontend/src/api/generated/` (TW §4) | Screens use a stale client (Minalini's generator) |
| `contract-tests` (later) | Schemathesis against the running API (CONTRACT_GOVERNANCE §6) | Implementation differs from contract |
| `fhir-conformance` (Anand) | HL7 FHIR Validator with the US Core package against the read-only `/fhir` API (TW §4; ADR-0011) | A resource served by `/fhir` fails US Core validation. The validator stays after HAPI's retirement; its version is pinned by Anand when the job is built, under the 7-day rule |

## 7. Open items

| Item | Pending | PROPOSED answer |
|---|---|---|
| CODEOWNERS lines per module file | Thulasi | Added once Stage 3 creates the module files (T2) |
| Where the shared mock runs (local only, or also on staging) | Thulasi, Minalini | Both: local `npx` and a staging mock redeployed on merge (TW §5) |
| `openapi: 3.1.2` accepted by all tools | Stage 5 test | Fall back to `3.1.0` |
