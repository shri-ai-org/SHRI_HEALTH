# ADR-0005: PHI never in URLs; PHI search through POST

Status: **Accepted** (2026-10-23: the rule is DECISIONS D13, approved by all four: Vimal, VD-G2; Thulasi and Minalini in PR #2, with Thulasi's rate-limit and redaction rules, issue #3 T18, T23, and Minalini's search rules, M7; Anand, D28) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal (decided as VD-G2), Thulasi (logging, rate limits, audit)

## Context

URLs are copied into Nginx access logs, browser history, proxy and monitoring tools, and error trackers, which are outside the controls applied to request bodies. API_Catalogue.md lists `GET /patients?search=`, which would put names, birth dates, phone numbers and MRNs into URLs. Vimal decided (VD-G2): opaque UUIDs are allowed in URLs; names, date of birth, phone, MRN, driver's license numbers, member IDs and SSN never are; such searches use `POST …/search`.

## Decision

1. No PHI in path or query parameters. Opaque UUIDs (`x-phi: internal-id`) are allowed.
2. Any search or filter on a PHI field uses `POST /<collection>/search` with a JSON body; `200` response; `Cache-Control: no-store`. Patient search is `POST /patients/search`.
3. A lint rule rejects path and query parameters from a PHI denylist (API_STANDARDS §14.3). Free-text `q` is allowed only on reference catalogs (codes, pharmacies, lab compendium).
4. Patient search requires either an exact identifier (MRN, driver's license number, member ID, or the full phone number) or at least two criteria, and caps results, to prevent browsing the whole patient list. Phone search is an exact match on the full number as normalized digits; no partial-number search in the MVP (Vimal's answer to M7).
5. Search criteria values are never logged; audit records the criteria fields used and the patient IDs returned.

## Alternatives considered

| Option | Why not |
|---|---|
| GET with PHI in the query, and scrubbed logs | Depends on every log, proxy and tool being configured perfectly, forever |
| HTTP `QUERY` method | OpenAPI 3.1 has no `query` operation (it was added in 3.2), and our mock server supports only 3.1 (TOOLCHAIN §1); POST works everywhere today. Revisit when we move to 3.2 |
| Encrypt query values | Complex; still leaks into history and caches as opaque blobs |

## Consequences

- Search endpoints are not cacheable or bookmarkable (acceptable for PHI).
- POST search must be treated as read-only by the backend and audited as `phi-read`.
- Rate limits on `…/search` are stricter (Thulasi).

## References

VD-G2; API_STANDARDS §14; SECURITY_MODEL §6–§8.
