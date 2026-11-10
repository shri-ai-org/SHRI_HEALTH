# Day timeline

This folder is the clinicians' Dashboard **Today** chart from Shri Health (doctors-portal
`src/shri/myday/DayTimeline.tsx`), ported so Care Entry draws the same chart, bar for bar.
It is one row of coloured bars from 7 AM to 7 PM, with the hours above, a red Now line, a
hover card, and the key with the day's busy and free time underneath.

| File | What it holds |
|---|---|
| `DayTimeline.tsx` | `<DayTimeline>` (the row) and `<DayTimelineKey>` (the key and totals) |
| `dayModel.ts` | `dayModel()`, which turns a doctor's day into bars, free time and breaks, plus the 12-hour time helpers |
| `dayTimeline.css` | All the styling, in plain CSS with `dtl-` classes and the Dashboard's light and dark colours. The component imports it. |

It needs only `react` and `lucide-react`, which Care Entry already has, and no Tailwind classes.

## Use

```tsx
import { DayTimeline, DayTimelineKey } from '../components/dayTimeline/DayTimeline'
import { dayModel } from '../components/dayTimeline/dayModel'

const model = useMemo(() => dayModel({ date, now, activities, bookings, blocks, openings, work }), [/* … */])

<DayTimeline
  model={model}
  onSchedule={(at, until) => /* open Schedule Appointment at minute `at` */}
  // (breaks are drawn and never tapped; there is no off-hours callback)
  onBlocked={(blockId) => /* offer to unblock */}
  onOpen={(item) => /* optional: an activity bar was tapped */}
/>
<DayTimelineKey model={model} />
```

Every time is in **minutes after midnight**: 9:30 AM is `570`. `minutesFrom('09:30')` converts
Care Entry's `"HH:MM"` slots, and `atMinute(date, 570)` turns a minute back into a `Date`.

### What goes in

- `activities` are the doctor's own sessions: OPD, ward round, teleconsult block, paperwork and so on.
  Each has an `id`, a `kind`, `start`, `end` and `title`; `detail` is read out by screen readers, and
  `icon` (a lucide icon) replaces the kind's default.
- `bookings` are booked patients. A booking inside an activity is covered by it and is not drawn
  as its own bar, the way the Dashboard's OPD block covers its queue. Use kind `'patient'` (OPD green)
  or `'tele'`.
- `blocks` are blocked time (`{ id, start, end, reason, allDay? }`).
- `openings` are extra hours opened on the day; they become bookable free time.
- `work` is the working hours. It defaults to 8 AM to 5 PM less lunch (12:30 to 2 PM), Monday to Saturday.
  Pass `[]` for a day on leave.
- `now` defaults to the clock. The Now line shows only when `date` is today.

### From Care Entry's store (a sketch)

```ts
const s = getDoctorSchedule(state, providerId, date)          // null on a day off
const work = !s || s.onLeave ? [] : minus(
  [[minutesFrom(s.sessionStart), minutesFrom(s.sessionEnd)]],
  s.breaks.map((b) => [minutesFrom(b.start), minutesFrom(b.end)] as Span),
)
const bookings = state.appointments
  .filter((a) => a.providerId === providerId && a.date === date && a.status !== 'Cancelled')
  .map((a) => ({
    id: a.appointmentId,
    kind: a.mode === 'Teleconsult' ? 'tele' as const : 'patient' as const,
    start: minutesFrom(a.slot),
    end: minutesFrom(a.slot) + (s?.slotMinutes ?? 15),
    title: patientNameOf(a.patientId),
  }))
const model = dayModel({ date: new Date(`${date}T00:00`), now, activities: [], bookings, work })
```

When there are no `activities`, every booking is drawn as its own bar.

### What a tap does

The chart only reports a tap; the dialogs are Care Entry's own.

- **Free time still to come** calls `onSchedule(at, until)`. `at` is exactly the minute under the
  pointer, which is the minute the hover card shows, rounded to 5 minutes. From the keyboard it is
  the start of the free time. `until` is where that free time ends. The Dashboard opens
  "Schedule an appointment" at that minute and does not ask for the time again. Round `at` to the
  doctor's slot length if bookings must sit on the slot grid.
- **Breaks** (lunch, inside the working day) are drawn and never tapped. Hours outside the working day are not drawn.
- **Blocked time** calls `onBlocked(blockId)`. The Dashboard offers to unblock it.
- **An activity** calls `onOpen(item)` when it is given. Without `onOpen`, activities are not buttons.
- Free time and breaks that have already gone are drawn but cannot be tapped.

`nextPatient={{ name, token }}` is optional. When it is given, hovering the OPD that is on now names
the queue's next patient, as on the Dashboard.

## Look

- The colours are the Dashboard's own (`--act-opd`, `--avail-edge`, `--now-line` and the rest) and are set on
  `.dtl`. Dark mode follows `data-theme="dark"` on `<html>`, the same switch Care Entry uses.
- The ring round the Now dot uses Care Entry's card colour (`--color-surface-1`). If the chart sits on a
  different background, set `--dtl-card`.
- The chart uses Care Entry's typeface. To get the Dashboard's Inter, set `--dtl-font: 'Inter', sans-serif`
  (Inter must be loaded).
- The row is the same size on every screen: 1.85px a minute, and at least 72px for any stretch of
  5 minutes or more. On a narrow screen it scrolls sideways and opens at Now.

The Dashboard panel's header (Today, the day arrows and the Now pill) and its event cards under the
key are not part of this folder.
