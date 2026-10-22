# ADR-0002: Contract first with OpenAPI 3.1, one file per module

Status: **Proposed** · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Thulasi (CI), Minalini (generated client)

Vimal accepted OpenAPI 3.1 on 2026-10-22; still needs Thulasi and Minalini.

## Context

Four people build the backend and the screens in parallel. TW §1 and §5 require every endpoint to be defined in OpenAPI before it is built, with screens using a generated client so a breaking change fails the build. Technical Architecture v1.1 §7 instead says the OpenAPI contract is "generated" (code-first); TW and VG rank above TA in DECISIONS.md's precedence order. VG Day 1 asks for one file, `contracts/openapi/shri-health.yaml`; Vimal decided on one file per module plus shared components, bundled for tools (VD-G8).

Tool support checked on 2026-10-22 (TOOLCHAIN §1): Prism 5.16.0 (mock server) lists OpenAPI 2.0, 3.0 and 3.1; Spectral 6.17.0, oasdiff v1.34.1 and Schemathesis 4.32.3 also list 3.2. The latest specification releases are 3.1.2 (2025-09-19) and 3.2.1 (2026-09-10).

## Decision

1. The OpenAPI document in `contracts/openapi/` is written by hand before implementation and is the source of truth. FastAPI's generated spec is checked against it (CONTRACT_GOVERNANCE §6).
2. Format: **OpenAPI 3.1** (`openapi: 3.1.2`, falling back to `3.1.0` if a tool rejects the patch version in Stage 5).
3. Layout: a root file, `shared/` components, one file per module in `modules/`, bundled with Redocly into `dist/shri-health.bundled.yaml`, which is committed and checked for staleness in CI (TOOLCHAIN §3).

## Alternatives considered

| Option | Why not |
|---|---|
| Code-first (FastAPI generates the spec) | Screens and other modules would wait for backend code; contract reviews would happen after the fact; contradicts TW §5 |
| OpenAPI 3.2 | Prism, our mock server, does not list 3.2 support |
| OpenAPI 3.0 | 3.1 is supported by every chosen tool and aligns with JSON Schema 2020-12 (cleaner nullability and examples) |
| Single file | Four owners editing one large file daily would conflict constantly (VD-G8) |

## Consequences

- Every endpoint change starts with a contract PR (CONTRACT_GOVERNANCE §2).
- A bundling step is needed before any tool runs; CI must keep `dist/` in sync.
- Moving to 3.2 later requires only a Prism upgrade check and a version-string change.
- CODEOWNERS lines per module file can enforce owner approval (pending Thulasi).

## References

TW §1, §4, §5; VG Day 1, Step 1; TA §7; VD-G8; TOOLCHAIN.md; CONTRACT_GOVERNANCE.md.
