# Timeline View — Feature Design & Implementation

## Implementation Status
**POC built** — `src/routes/timeline.js` + `views/timeline.ejs` + schedule columns on `tickets` table.
Accessible via Tickets → Timeline in the nav. Time periods are hardcoded in the route (marked with TODO to move to Settings).
No drag-and-drop in POC — tap/click any card to open schedule dialog.

---

## Problem Statement

The user (solo IT tech / admin) has a substantial backlog of planned work constantly interrupted by reactive calls (5–10/day). When an interruption ends, the mental burden of re-evaluating the entire backlog to determine what to work on next is the core friction. The goal is a system that removes the need to remember what needs to be done when, and surfaces the right work at the right time without requiring constant manual review.

**Workflow summary:**
- Substantial pending backlog at all times, varying urgency and time constraints
- Reactive calls interrupt planned work constantly
- When resurfacing after interruption: needs to quickly identify what's most pressing given current available time
- Three criteria apply at varying weights depending on context:
  1. What's most urgent?
  2. What can I realistically finish in the time I have right now?
  3. What's been waiting longest and is at risk of being forgotten?
- Currently manually triages across 4 status buckets (New → Pending → Open → On Hold) as separate filter trips
- Works after hours and weekends — time-of-day matters for scheduling
- Does NOT want auto-close or automated customer reminders (accountability is on his side)
- Creates most tickets himself on behalf of customers (submitter ≠ customer)

---

## What Was Ruled Out

- **Auto-close tickets** — rejected. Accountability is on the tech's side.
- **Customer reminders for "Waiting" status** — rejected. Tech creates most tickets; submitter = tech, not customer. Contact often happens outside the system (phone/SMS).
- **Gantt-style horizontal timeline** — discussed but deprioritized. Overlap problem is unsolved elegantly, horizontal scroll is awkward on mobile, coarse time windows don't benefit from precise horizontal axis.
- **Inactivity nudges to tech** — rejected. Nudges at wrong times just result in ticket being put back on hold.
- **Recurring tasks** — out of scope for now, revisit later.
- **Drag-and-drop** — not in POC. Click-to-schedule dialog used instead.

---

## Chosen Direction: Vertical Timeline with Sections

### Core Concept
A new view (alongside existing views) that shows all scheduled tickets as cards in time-based sections, with "NOW" as a fixed bar. Overdue items appear above NOW in red. Future items appear below NOW grouped by time proximity. Backlog sidebar shows unscheduled tickets.

### Time Sections (progressive granularity)
Near future is fine-grained; far future is coarse.

```
▲ OVERDUE                          ← red, always visible above NOW
━━━━━━━━━━ NOW ━━━━━━━━━━━━━━━━━━
  ASAP                             ← no specific date
  TODAY (business hours)           ← 8am–5pm (hardcoded in POC)
  TODAY (tonight)                  ← 5pm–11pm (hardcoded in POC)
  TODAY (all day)
  TOMORROW (same sub-sections)
  THIS WEEK
  NEXT WEEK
  THIS MONTH
  BEYOND
  SOMEDAY                          ← no specific date, low pressure
▼ BACKLOG SIDEBAR                  ← unscheduled (no schedule_type set)
```

---

## DB Schema (implemented)
```sql
ALTER TABLE tickets ADD COLUMN schedule_type TEXT;
  -- NULL=unscheduled, 'asap', 'window', 'appointment', 'someday'
ALTER TABLE tickets ADD COLUMN schedule_window_start INTEGER;
ALTER TABLE tickets ADD COLUMN schedule_window_end INTEGER;
ALTER TABLE tickets ADD COLUMN schedule_time_of_day TEXT;
  -- 'business' | 'tonight' | 'allday'
ALTER TABLE tickets ADD COLUMN schedule_exact_at INTEGER;
  -- unix timestamp, used for appointment type only
```

---

## Key Implementation Details

### Route: src/routes/timeline.js
- `GET /` — `getTimelineTickets(userId)` (owner role only), runs `buildSections()` + `buildLabels()`, renders `views/timeline.ejs`
- `POST /tickets/:id/schedule` — JSON body, validates owner or admin, calls `setTicketSchedule()`
- Hardcoded constants: `BUSINESS_START_H=8`, `BUSINESS_END_H=17`, `TONIGHT_START_H=17`, `TONIGHT_END_H=23`
- TODO: move time period constants to DB settings

### View: views/timeline.ejs
- EJS helper functions `cardHtml()` and `escStr()` defined at bottom (hoisted by EJS compiler)
- `CARDS` JSON array embedded server-side for JS dialog access
- Schedule dialog: 14 quick preset buttons + custom window fields + appointment datetime-local
- `buildPayload(type)` computes unix timestamps for all presets from today's local midnight
- Saves via `fetch POST` with `X-CSRF-Token` header, then `window.location.reload()`

### Quick preset buttons in schedule dialog
- ASAP, Today · AM, Today · Tonight, Today · All day
- Tomorrow · AM, Tomorrow · Tonight, Tomorrow · All day
- This Weekend, This Week, Next Week
- Custom Window… (shows date range + time_of_day select)
- Appointment… (shows datetime-local input)
- Someday, ✕ Unschedule

---

## Layout

### Desktop
```
┌─────────────────────────┬──────────────┐
│   TIMELINE              │   BACKLOG    │
│                         │              │
│ ▲ OVERDUE               │ ┌──────────┐ │
│ [UPS Replace]           │ │Office    │ │
│                         │ │rearrange │ │
│ ━━━ NOW ━━━━━━━━━━━━    │ └──────────┘ │
│                         │ ┌──────────┐ │
│ TONIGHT                 │ │Update    │ │
│ [Printer visit]         │ │firewall  │ │
│                         │ └──────────┘ │
│ THIS WEEKEND            │              │
│ [Cables — Site A]       │              │
└─────────────────────────┴──────────────┘
```

### Mobile
- Backlog becomes a collapsed section with Show/Hide toggle button
- Timeline takes full width

---

## Multi-User Considerations
- Each user sees their own timeline (tickets where they are **owner** in ticket_parties)
- Closed tickets never shown
- Team/admin view not yet built

---

## Open Design Questions (not resolved in POC)

1. **Drag vs tap on mobile** — POC uses tap only; drag would be more natural for desktop
2. **Backlog card aging** — visual urgency indicator as cards age; threshold not defined
3. **On Hold auto-promote** — when unblocked, does card just change color or need explicit user action?
4. **ASAP soft limit** — how many ASAP tickets before view flags it?
5. **Relationship to existing statuses** — does scheduling implicitly change ticket status?
6. **Team view design** — admin-only; shows all techs' timelines side by side
7. **Configurable time periods** — hardcoded in POC; should be in Settings

---

## Practical Use Case

**8:00am** — Open Timeline. See OVERDUE: Replace UPS. ASAP: Email follow-up. TODAY: Patch server.
Go straight to server patch — no mental evaluation needed.

**8:47am** — Phone rings. Quick-create ticket, tap "Tonight." 15 seconds. Back to server patch.

**9:15am** — Done. Back to timeline. ASAP shows Smith Co follow-up. Send email, close ticket.

**12:30pm** — UPS still overdue. Tap it, select "This Week." Drops out of overdue.

**6:00pm** — Tonight section shows printer visit. Go do it. Close ticket.
