# ADR-0010: Major version in the path; additive change within v1

> **Partly superseded by ADR-0011: outside systems use our own read-only `/fhir` API (Anand), not HAPI's. The rest of this ADR stands.**

Status: **Proposed** (Thulasi agreed, issue #3 T24, T25; Minalini pending) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Thulasi (Nginx routing, CI breaking-change check), Minalini (client)

## Context

CAT fixes the base path `/api/v1`. TW §4 runs oasdiff against `main` to catch breaking changes. Today the only consumer of `/api/v1` is our own SPA; outside systems use HAPI's `/fhir` (CAT). RFC 9745 (March 2025) standardizes the `Deprecation` response header; RFC 8594 defines `Sunset`.

## Decision

1. The major version lives in the path only (`/api/v1`). No version headers or media-type versions.
2. Within v1, only additive, non-breaking changes (CONTRACT_GOVERNANCE §4.1). Breaking needs are met by adding a new field or endpoint and deprecating the old.
3. Deprecation: `deprecated: true` in the contract, `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers, a `Link` to the change note; at least 30 days or two releases before removal; then `410 gone`.
4. `/v2` only for a system-wide redesign, run in parallel with v1 during migration.
5. `/health` and `/hooks/{partner}` are outside the versioned path and public through Nginx; `/ready` is internal only and not in the contract (agreed, T24). Load balancers and partner callback registrations never change with the API version.
6. The contract's `info.version` follows `1.MINOR.PATCH` (CONTRACT_GOVERNANCE §3).

## Alternatives considered

| Option | Why not |
|---|---|
| Header or media-type versioning | Harder to route, cache-key and debug; the generated client handles paths more simply |
| Date-based versions per request | Heavy machinery for one internal consumer |
| No versioning | Leaves no path for a future incompatible change or outside consumers |

## Consequences

- oasdiff in CI enforces the rule; breaking changes need the approved label.
- Deprecation headers must be supported by the middleware or a shared response helper (Thulasi).

## References

CAT conventions; TW §4; RFC 9745; RFC 8594; API_STANDARDS §2.
