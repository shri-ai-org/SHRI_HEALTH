# Architecture decision records

Owner: everyone (TW §2). One short record per decision that affects more than one person (TW §6).

Numbering: files are named `NNNN-short-title.md` and referred to as `ADR-NNNN`. The two-digit numbers `ADR-01` to `ADR-29` belong to Technical Architecture v1.1 and are not repeated here.

Status values: **Proposed** → **Accepted** (all named sign-offs given) → **Superseded by ADR-xxxx** or **Rejected**. A decision is closed when its owners sign it (IP "Governance"). Accepted ADRs that change the system are also added as a row to `docs/context/DECISIONS.md`.

| ADR | Title | Status | Needs sign-off from |
|---|---|---|---|
| [ADR-0001](0001-repo-ownership-and-workflow.md) | Repository ownership and workflow | Accepted | Vimal, Thulasi, Anand, Minalini (decided) |
| [ADR-0002](0002-contract-first-openapi-3-1.md) | Contract first with OpenAPI 3.1, one file per module | **Accepted** | Vimal, Thulasi, Minalini |
| [ADR-0003](0003-error-format-problem-details.md) | Errors as Problem Details (RFC 9457) with a stable code catalogue | **Accepted** | Vimal, Thulasi |
| [ADR-0004](0004-cursor-pagination.md) | Cursor pagination for every list (partly superseded by ADR-0011) | **Accepted** | Minalini, Thulasi, Anand (2026-10-23) |
| [ADR-0005](0005-no-phi-in-urls.md) | PHI never in URLs; PHI search through POST | **Accepted** | Vimal, Thulasi, Minalini, Anand (2026-10-23, as D13) |
| [ADR-0006](0006-cookie-session-and-csrf.md) | Session cookie with reference token, plus CSRF header | **Accepted** | Thulasi, Minalini |
| [ADR-0007](0007-idempotency-keys.md) | Idempotency-Key for partner-bound and money-moving requests | **Accepted** | Thulasi, Anand (2026-10-23) |
| [ADR-0008](0008-optimistic-concurrency.md) | Optimistic concurrency with ETag / If-Match (partly superseded by ADR-0011) | **Accepted** | Thulasi, Anand (2026-10-23) |
| [ADR-0009](0009-id-strategy.md) | UUIDs everywhere (UUIDv4)~~, same UUID in HAPI~~ (HAPI part superseded by ADR-0011; amended 2026-10-23) | **Accepted** | Anand, Vimal (2026-10-23) |
| [ADR-0010](0010-api-versioning.md) | Major version in the path; additive change within v1 (partly superseded by ADR-0011) | **Accepted** | Thulasi, Minalini (2026-10-23) |
| [ADR-0011](0011-single-postgresql-retire-hapi.md) | Single PostgreSQL with FHIR-shaped clinical tables; HAPI retired | **Accepted** | Decided by the team (2026-10-23) |
| [ADR-0012](0012-hosting-amazon-rds.md) | Host the database on Amazon RDS for PostgreSQL 18 | **Accepted** | Decided by the team (2026-10-23) |

Template:

```markdown
# ADR-NNNN: Title
Status: Proposed · Date · Author · Needs sign-off from
## Context
## Decision
## Alternatives considered
## Consequences
## References
```
