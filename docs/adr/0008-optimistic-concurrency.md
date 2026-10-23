# ADR-0008: Optimistic concurrency with ETag / If-Match

> **Partly superseded by ADR-0011: there is no HAPI, so no ETag translation to HAPI `meta.versionId`; every ETag comes from the row version in our own PostgreSQL. The rest of this ADR stands.**

Status: **Proposed** (Thulasi agreed for prescriptions, issue #3 T31; Anand pending) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Thulasi (prescriptions), Anand (version columns~~, HAPI versions~~)

## Context

VG Step 1 and CAT require `ETag` / `If-Match` on note and prescription updates "so two people can't silently overwrite each other"; VG Step 5 applies it to note autosave across two tabs. Your Stage 2 brief extends it to other edited clinical records. ~~Records live in our PostgreSQL and in HAPI, which has its own version IDs and weak ETags.~~ Records live in our PostgreSQL (ADR-0011). RFC 9110 requires strong comparison for `If-Match`.

## Decision

1. Every single-resource response carries a **strong, opaque** `ETag`.
2. `If-Match` is **required on every PATCH and PUT**, and on the actions `sign`, `cosign`, `addenda` (notes) and `sign-and-send`, `change` (prescriptions). One rule for all edits, not only clinical ones.
3. Missing → `428 precondition-required`; mismatch → `412 precondition-failed` with the current `ETag`.
4. Our records: ETag from a row version counter (pending schema). ~~HAPI records: the FHIR client translates our ETag to HAPI's `meta.versionId` and does a version-aware update; HAPI's weak ETags never reach clients (pending Anand).~~
5. Booking is the exception: a pessimistic provider-day lock (VG Step 3), because two different appointments conflict without editing the same row.

## Alternatives considered

| Option | Why not |
|---|---|
| Last write wins | Silent loss of clinical edits; forbidden by VG Step 1 |
| `If-Match` only on notes and prescriptions | Two rules to remember; demographics and coverage edits also collide at the front desk |
| Pessimistic locks ("note is being edited") | Locks get stuck when tabs close; poor fit for autosave |
| Version number in the body instead of headers | Non-standard; HTTP already defines the mechanism |

## Consequences

- Screens must keep the latest ETag and handle `412` by reloading and showing the difference.
- Every edited table needs a version column (Anand).
- Lint checks `If-Match`, `412` and `428` on every PATCH/PUT.

## References

VG Step 1, Step 3, Step 5; RFC 9110 §13.1.1; RFC 6585 (428); API_STANDARDS §11; DATA_OWNERSHIP §4.
