# Domain events and the live stream

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Thulasi (owner of `events.publish()` and `/events/stream`), Anand (billing and inbox consume events), Minalini (screens consume the stream). **Thulasi signed off on issue #3 (T27, T28), 2026-10-22; Minalini's review of §4 is pending (M10).**

Fixed by source documents:

- Modules publish events with `events.publish()` (Thulasi; VG §4).
- Browsers receive live updates over Server-Sent Events at `GET /api/v1/events/stream` (CAT; TA ADR-24).
- Events travel through PostgreSQL LISTEN/NOTIFY and a PostgreSQL-backed job queue; Redis only if load tests demand it (TA ADR-23).
- Closing an encounter publishes `encounter.closed`; Anand's billing builds the superbill from it (VG Step 5, §4).
- Check-in updates the status board within a second (VG Step 3); new results reach the ordering clinician within 60 seconds (FRS FR-ORD-02).

OpenAPI does not describe event streams well, so events are documented here and their payload schemas live in the contract as `components/schemas/Event…` (Stage 3).

## 1. Rules

| # | Rule | Reason |
|---|---|---|
| 1 | **Thin events.** An event carries IDs and status only, never PHI. Screens re-fetch details through the normal API, with the user's own permissions. | A stream reaching many screens must not widen access; matches minimum necessary (SECURITY_MODEL §8) |
| 2 | **Name** = `<resource>.<what-happened>`, lowercase kebab-case, past tense or new state: `appointment.checked-in`, `note.signed` | Readable, matches path names |
| 3 | **At-least-once delivery.** Consumers must handle duplicates (deduplicate on `id`). | Outbox and retries can repeat |
| 4 | **Ordering** is guaranteed only per `subject` (one record). | Parallel workers |
| 5 | **Publishing happens after commit** (outbox in the same transaction). An event never announces a change that was rolled back. | Consistency |
| 6 | **Adding** fields to `data` is non-breaking. Changing a field's meaning needs a new event type. | Same policy as the API (CONTRACT_GOVERNANCE §4) |
| 7 | Every operation that publishes declares `x-events` in the contract. | Traceability |

Agreed by Thulasi (T27).

## 2. Envelope

Aligned with CloudEvents 1.0 attribute names, so the format is familiar and tooling exists. **PROPOSED.**

```json
{
  "specversion": "1.0",
  "id": "4d6f2a9e-8f0b-4c55-9a3e-2b1f7c0d9e11",
  "type": "appointment.checked-in",
  "source": "/scheduling",
  "subject": "appointment/1f0c3b8e-5d6a-4b7e-9c2d-8e7f6a5b4c3d",
  "time": "2026-11-03T14:30:02.120Z",
  "datacontenttype": "application/json",
  "data": {
    "appointmentId": "1f0c3b8e-5d6a-4b7e-9c2d-8e7f6a5b4c3d",
    "patientId": "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    "encounterId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
    "facilityId": "9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
    "status": "checked-in"
  }
}
```

| Attribute | Rule |
|---|---|
| `id` | UUID, unique per event |
| `type` | From the catalogue (§4) |
| `source` | Module path: `/patients`, `/scheduling`, `/encounters`, `/notes`, `/medications`, `/orders`, `/billing`, `/documents`, `/inbox`, `/communications`, `/platform` |
| `subject` | `<resource>/<uuid>` |
| `time` | UTC, RFC 3339 |
| `data` | IDs (`x-phi: internal-id`), enum statuses, and counts only |
| Internal-only attributes | `organizationid`, `actorid`, `requestid` (CloudEvents extension attributes). Used by the middleware for filtering and tracing; **stripped before reaching browsers** |

## 3. Server-Sent Events stream

`GET /api/v1/events/stream` (`x-permission: authenticated`), response `text/event-stream`. Agreed by Thulasi (T28), with the additions marked T28/T9.

```
retry: 5000

id: 4d6f2a9e-8f0b-4c55-9a3e-2b1f7c0d9e11
event: appointment.checked-in
data: {"specversion":"1.0","id":"4d6f…","type":"appointment.checked-in",…}

: keep-alive
```

| Topic | PROPOSED rule |
|---|---|
| Authentication | Session cookie (same origin); no CSRF needed for GET |
| Filtering | The middleware sends an event only if the user belongs to the event's organization, is assigned to its facility, and holds the read permission for the event's resource type. Events about restricted patients go only to users with a current break-glass grant, or are reduced to the type and subject. Personal events (`operation.completed`, `inbox.item-assigned`) go only to the target user. **Replayed events are filtered again at replay time** (T28). |
| Keep-alive | Comment line every 25 seconds (keeps proxies from closing the connection). **Keep-alives and the stream itself never reset the idle timer** (T9, T28) |
| Resume | Browser sends `Last-Event-ID` on reconnect; the server replays from a 5-minute buffer. If the gap is longer, the server sends `stream.reset` and the screen re-fetches |
| Connections | At most 5 open streams per user (several tabs) |
| Session end | Stream closes when the session expires; the browser gets `401` on reconnect |
| Nginx | Response buffering is already off for `/api/` (Thulasi, T28) |

## 4. Initial event catalogue

"Browser" = delivered over the stream. "Internal" = consumed by backend code through the job queue.

| Type | Subject | `data` (beyond IDs of the subject) | Published by | Consumers | Delivery |
|---|---|---|---|---|---|
| `patient.created` | patient | — | Vimal (patients) | Minalini (communications preferences defaults) | Internal |
| `patient.updated` | patient | — | Vimal | — (nothing is mirrored since ADR-0011) | Internal |
| `patient.merged` | patient (surviving) | `mergedPatientId` | Vimal | Anand (billing, documents re-point), Minalini | Internal + browser |
| `appointment.booked` | appointment | `patientId`, `providerId`, `facilityId`, `start` | Vimal (scheduling) | Minalini (reminders), status board | Internal + browser |
| `appointment.rescheduled` | appointment | same | Vimal | Minalini, status board | Internal + browser |
| `appointment.cancelled` | appointment | `reasonCode` | Vimal | Minalini, status board | Internal + browser |
| `appointment.checked-in` | appointment | `encounterId`, `status` | Vimal | Status board, clinician lists | Browser (within 1 s, VG Step 3) |
| `appointment.status-changed` | appointment | `visitStatus` | Vimal | Status board, dashboard | Browser |
| `appointment.checked-out` | appointment | — | Vimal | Status board, Anand (copay reconciliation) | Internal + browser |
| `eligibility.completed` | eligibility-check | `appointmentId`, `coverageStatus` | Vimal (eligibility) | Front-desk screens | Browser |
| `encounter.opened` | encounter | `patientId` | Vimal (encounters) | Clinician lists | Browser |
| `encounter.status-changed` | encounter | `status` | Vimal | Status board | Browser |
| `encounter.closed` | encounter | `patientId` | Vimal | **Anand (superbill)** | Internal (+ browser) |
| `encounter.entered-in-error` | encounter | — | Vimal | Anand (billing) | Internal. Also raised by undo check-in (D55) |
| `note.signed` | note | `encounterId`, `cosignStatus` | Vimal (notes) | Anand (inbox: remove "unsigned note", add co-sign task) | Internal + browser |
| `note.cosigned` | note | `encounterId` | Vimal | Anand (inbox, billing hold release) | Internal + browser |
| `note.amended` | note | `encounterId` | Vimal | Anand (billing notice if claimed) | Internal |
| `note.entered-in-error` | note | `encounterId` | Vimal | Anand (billing) | Internal |
| `operation.completed` | operation | `kind`, `status`, `resultType`, `resultId` | Platform (Thulasi) | The requesting user's screen | Browser (personal) |
| `prescription.signed` | prescription | `patientId` | Thulasi | — | Internal |
| `prescription.transmission-updated` | prescription | `transmissionStatus` | Thulasi | Anand (inbox on failure), prescriber screen | Internal + browser |
| `refill-request.received` | refill-request | `patientId` | Thulasi | Anand (inbox) | Internal |
| `order.status-changed` | order | `fulfillmentStatus` | Thulasi | Clinician screens | Browser |
| `result.received` | result | `orderId`, `patientId`, `abnormal`, `critical` | Thulasi | Anand (inbox, within 60 s, FRS FR-ORD-02); critical escalation | Internal + browser |
| `result.acknowledged` | result | — | Thulasi | Escalation stops | Internal + browser |
| `unmatched-result.received` | unmatched-result | — | Thulasi | Unmatched queue screen | Browser |
| `file.scanned` | file | `status` (`clean`, `rejected`) | Anand (files) | Operation completion | Internal |
| `fax.received` | fax | — | Anand | Fax inbox screen | Browser |
| `claim.status-changed` | claim | `status` | Anand | Billing screens | Browser |
| `inbox.item-assigned` | inbox-item | `itemType`, `priority` | Anand | Assigned user | Browser (personal) |
| `communication.delivery-updated` | communication | `deliveryStatus` | Minalini | Communications screen | Browser |
| `break-glass.granted` | patient | `grantId`, `userId` | Platform (Thulasi) | **Anand (inbox item for CO)**: the privacy-officer notice is an inbox item, never an email with PHI (T16) | Internal |
| `stream.reset` | — | — | Platform | All screens: re-fetch | Browser |

## 5. Open items

Settled 2026-10-22: envelope and naming, filtering (including replay), keep-alive, resume buffer, connection limit (Thulasi, T27, T28).

| Item | Pending | PROPOSED answer |
|---|---|---|
| Who maintains this catalogue | Thulasi, Vimal | Vimal (contract owner) keeps the catalogue; publishers add events by contract PR |
| Event list for billing, inbox and documents, including the CO inbox item for `break-glass.granted` | Anand | §4 rows |
| Screens that need live updates and their events | Minalini | §4 "Browser" rows (her review pending, M10) |
