# ADR-0004: Cursor pagination for every list

Status: **Proposed** · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Anand (HAPI paging through the FHIR client), Minalini (list screens)

## Context

VG Step 1 requires cursor pagination on every list (`?cursor=&limit=`). Lists come from two stores: our PostgreSQL and HAPI, whose search paging uses its own server-side links. Counting rows is expensive in both, especially through FHIR. Cursors that encode sort keys can leak PHI (for example a family name) into URLs.

## Decision

1. Every list accepts `limit` (default 25, maximum 100) and `cursor`, and returns `{ "items": [...], "nextCursor": "…" }`. No `nextCursor` means the last page.
2. No total count by default; an endpoint that needs one documents a `count` field explicitly.
3. Cursors are opaque, URL-safe, at most 512 characters, valid for 24 hours, and **never contain readable PHI**. PROPOSED: the middleware encrypts and authenticates them, bound to tenant, user and endpoint (pending Thulasi). Bad or expired cursor → `400 invalid-cursor`.
4. For `POST …/search`, `limit` and `cursor` go in the body.
5. Our lists use keyset pagination; HAPI-backed lists wrap HAPI's paging inside our cursor so HAPI URLs never reach clients (pending Anand).

## Alternatives considered

| Option | Why not |
|---|---|
| Offset / page number | Slow on large tables; pages shift when records are inserted; HAPI paging is link-based anyway |
| Exposing HAPI's paging links | Leaks internal URLs and couples screens to HAPI |
| Link headers (RFC 8288) instead of a body field | Harder to use from the generated client; body field is simpler |

## Consequences

- Screens cannot jump to "page 7"; they load more or narrow filters. Acceptable for clinic lists.
- The FHIR client must implement cursor wrapping for HAPI searches.
- A shared pagination component in `shared/pagination.yaml` and a lint rule enforce the shape.

## References

VG Step 1; API_STANDARDS §8; SECURITY_MODEL §8.
