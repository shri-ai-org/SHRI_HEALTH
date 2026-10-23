# Shri Health API contract

This folder is the **single source of truth** for every endpoint of the Shri Health API (ADR-0002). Endpoints are written here first, then built. Owner: Vimal (`/contracts/` in CODEOWNERS); each module file also has its implementing owner.

> **Stage 3 status:** shared components only, no endpoints yet. Endpoints arrive in Stage 4, module by module.

## What is where

| Path | What |
|---|---|
| `openapi/shri-health.yaml` | Root file: info, servers, security, tags, and references to everything else |
| `openapi/modules/<module>.yaml` | One file per module (empty until Stage 4). The comment at the top names its owner |
| `openapi/components/` | Shared pieces: `schemas/`, `parameters/`, `responses/`, `headers/`, `securitySchemes/`, `examples/` |
| `openapi/dist/shri-health.bundled.yaml` | **Generated** single file that all tools read. Never edit it by hand; commit it after `npm run bundle` |
| `openapi/.spectral.yaml`, `openapi/rules/` | Lint ruleset and its custom rule functions (CONTRACT_GOVERNANCE §5) |
| `openapi/redocly.yaml` | Structural validation against OpenAPI 3.1 |
| `tests/lint-fixtures/` | One deliberately broken file per lint rule, plus a compliant sample in `valid/` |
| `scripts/` | Layout check, mock launcher, sample builder, breaking-change check, oasdiff installer |
| `docs/` | The rules: API_STANDARDS, SECURITY_MODEL, DATA_OWNERSHIP, EXTENSIONS, and the rest |

## First-time setup

1. Use Node.js 24 LTS (the version is in `.nvmrc`; with nvm: `nvm use`). Node 22 also works.
2. Install the pinned tools from the lockfile:

```bash
cd contracts && npm ci
```

The versions are exact and were at least 7 days old when chosen (TOOLCHAIN §5). `oasdiff` is installed on first use by `npm run breaking` from its GitHub release, with a pinned SHA-256 check. **Never** `npm install oasdiff`: that npm package is not the tool.

## Everyday commands (run inside `contracts/`)

| Command | What it does |
|---|---|
| `npm run bundle` | Builds `openapi/dist/shri-health.bundled.yaml` from the split files |
| `npm run lint` | Bundles, checks the layout, validates the bundle as OpenAPI 3.1, then runs the full lint ruleset. Fails on any error |
| `npm run lint:fixtures` | Proves every lint rule catches what it claims, and that a compliant sample passes |
| `npm test` | `lint` + `lint:fixtures` |
| `npm run mock` | Starts the Prism mock server on port 4010 from the bundle. Until Stage 4 adds endpoints there is nothing to mock, and it says so |
| `npm run mock:sample` | Starts Prism on the compliant sample, to try the shared components now |
| `npm run breaking` | Compares the bundle with the one on `origin/main` (set `BASE_REF` to compare with another branch). Exit code 0: no breaking change; **3: a real breaking change**, listed in the output; 2: a tool or setup failure (oasdiff install or run, bundling, missing base ref), with a message saying so. In CI, only exit code 3 can be approved with the `breaking-change-approved` label |
| `npm run check:bundle-fresh` | Fails if the committed bundle is out of date (used by CI) |

Prism serves paths at the root of `http://127.0.0.1:4010`, without the `/api/v1` prefix. It returns the examples from the contract, and validates requests (a bad UUID gives a `422` Problem response).

Redocly is always run with `REDOCLY_TELEMETRY=off`: no usage data leaves the machine.

## Adding or changing an endpoint (Stage 4 onward)

1. Read [docs/API_STANDARDS.md](docs/API_STANDARDS.md) and [docs/EXTENSIONS.md](docs/EXTENSIONS.md).
2. Add the path item to the right `openapi/modules/<module>.yaml`, and reference it from `paths:` in `openapi/shri-health.yaml`.
3. Reuse shared components (`#/components/schemas/Id`, `#/components/responses/NotFound`, …); never copy them.
4. Give every operation `x-owner`, `x-permission`, `x-audit`, `operationId`, one tag and a description; give every property `x-phi`.
5. Use synthetic examples only: 555-0100 to 555-0199 phones, `example.com` email, Synthea-style names (`Kuhlman72`), `TEST` identifiers, no SSNs.
6. Run `npm test` and `npm run breaking`, commit the regenerated bundle, and open a pull request (CONTRACT_GOVERNANCE §2).

## Rules in one line each

- No PHI in URLs: PHI searches use `POST …/search` with a body (ADR-0005).
- Errors are Problem Details with a stable `code` (ADR-0003).
- Lists are `{ items, nextCursor }` with an opaque cursor (ADR-0004).
- `Idempotency-Key` on partner-bound and money-moving POSTs (ADR-0007).
- `ETag`/`If-Match` on every PATCH and PUT (ADR-0008).
- Session cookie plus CSRF header (ADR-0006).
- No DELETE; clinical records use entered-in-error.
- Long-running work returns `202` and an operation.
