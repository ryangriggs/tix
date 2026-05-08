# Views & Frontend

## Template Structure
```
views/
  partials/head.ejs, nav.ejs, foot.ejs
  tickets/list.ejs, detail.ejs, new.ejs
  admin/users.ejs, organizations.ejs, settings.ejs, logs.ejs
  reports/index.ejs
  timeline.ejs
  annotate/index.ejs
  emails/_header.ejs, _footer.ejs, login.ejs, ticket-notification.ejs, due-reminder.ejs
  error.ejs
```

## foot.ejs
Loads `src/public/js/app.js` (defines createAutocomplete, sidebarPost, global shortcuts).
Because it's at the end of body, any inline script that uses these functions MUST be wrapped
in `document.addEventListener('DOMContentLoaded', ...)`.
Exception: Quill is loaded from `/js/quill.min.js` in detail.ejs/new.ejs directly, so `new Quill(...)` can run in inline script directly.

## nav.ejs — Tickets dropdown
"Tickets" in the nav is a dropdown (`.nav-dropdown`):
- `/tickets` → List
- `/timeline` → Timeline
Dropdown triggered on hover (CSS). On mobile: static items always shown when hamburger is open.

## createAutocomplete (app.js)
```js
createAutocomplete(inputEl, {
  fetchUrl:    q => `/api/some/endpoint?q=${encodeURIComponent(q)}`, // FUNCTION, not string
  formatItem:  item => item.name,           // returns display HTML
  onSelect:    item => { ... },             // called on selection
  minChars:    1,                           // default 1
  showOnFocus: false,                       // if true, shows on focus even with no input
})
```
- Appends a `<ul class="autocomplete-dropdown">` to inputEl.parentElement
- Parent needs `position:relative` (auto-sets if static)
- Arrow keys navigate, Enter selects, Escape closes
- Blur closes after 150ms delay
- DO NOT call twice on same input (creates duplicate dropdown)
- To support dynamic fetchUrl (e.g. org changes), make fetchUrl read from input.dataset at call time

## sidebarPost (app.js)
```js
const data = await sidebarPost(url, { key: value });
// Sends urlencoded POST with _csrf from res.locals.csrfToken
// Returns parsed JSON
```

## views/tickets/list.ejs

### Filter bar
Hidden inputs: `filter-status`, `filter-priority`, `filter-since`, `sort`, `order`.
Visible selects: org, owner (admin/tech only). All changes submit `filter-form`.

### Sort persistence
Sort state is in the URL query string. On page load, `restoreSort()` IIFE checks if `?sort` is absent;
if so, reads `localStorage.getItem('adminUserSort')` (oops — for tickets this is a separate key,
actually tickets do not persist sort — see admin/users for the pattern).

### Empty state
When `tickets.length === 0` and `filters.q` is non-empty: shows "Clear filters" button.
- `clearFiltersKeepSearch()` resets status, priority, since, org, owner to "" (All/Any) and submits form
- Keeps the search text in place — intent is to widen filters without losing the search term
- Existing "Show all time" button (shown when `filters.since` is set) is preserved alongside it

## views/tickets/detail.ejs — key sections

### Timestamps
Comment outer div uses `data-comment-ts` (NOT `data-ts`) to store the timestamp.
`localiseTimestamps()` in tix.js only processes `[data-ts]` elements — using `data-comment-ts` prevents
it from overwriting comment content with "just now". The `reorderAfterPin()` JS function also reads
`dataset.commentTs`.

### Reply form
- Quill editor → hidden `#comment-body` input
- File attachments input
- If isTechOrAdmin: billable hours number input + location text input (disabled if no org or closed)
  - Location: `name="location_name"` (visible) + `name="location_id"` hidden int
  - `data-org-id` on location input — updated by org-change handler when org changes
  - Autocomplete init in DOMContentLoaded (see JS section below)
- Status change select (canManage only, Closed option only if canClose)
- Post comment button

### Attachments section (id="attachments")
- Loop over `attachments` array
- Per attachment: filename link, size, date, uploader name
- "..." button (`.attach-btn-wrap` > `button.btn-icon`) opens actions dropdown (`.attach-menu.attach-actions-menu`)
- Dropdown items:
  - View — always shown (links to `/tickets/attachments/:storedName`)
  - Annotate — only if annotatable extension AND `canManageAtt`
  - Rename — only if `canManageAtt`; calls `startAttachRename(btn, storedName)`
  - Delete — only if `canManageAtt`; calls `deleteAttach(storedName)` (shows confirm dialog, submits hidden form)
- `canManageAtt = isTechOrAdmin || ['owner', 'superuser'].includes(access)`
- `toggleAttachActionsMenu(btn)` — opens/closes menu; closes all other open menus first
- Document click listener closes all `.attach-actions-menu.open` when clicking outside `.attach-btn-wrap`
- Rename form + delete form rendered (hidden, `display:none`) only when `canManageAtt`
- `toggleAttachRename(storedName)` shows/hides the rename form

### Comments
- Loop over `comments` array (newest first — ORDER BY created_at DESC from DB)
- Per comment: author, via-email badge, billable badge (admin/tech if hours set), location badge (all users if set)
- `.badge-billing` for hours (admin/tech only). `.badge-location` with 📍 (all users).
- Admin: delete button
- Technician-visibility comments (visibility='technician') rendered with a staff-only indicator

### Sidebar
- Status pills: `.pill-btn .pill-status-{val}` — onclick posts to `/tickets/:id/status` via JS
- Priority pills: same pattern
- Due date: date input + Set button, posts to `/tickets/:id/due-date`
- Organization: text input with autocomplete, posts to `/tickets/:id/organization`
  - On success: also updates location input orgId, enables/disables it, clears value
- Billable hours total: admin only, if ticket.total_billable_hours > 0 (`.billing-total`)
- Parties list: add/remove via AJAX; "Add Participant" button only visible when `canAddParticipants`

### Inline JS in detail.ejs
```js
// These run immediately (Quill available, app.js not yet):
const quill = new Quill(...)
form.addEventListener('submit', ...)

// This must be in DOMContentLoaded (needs createAutocomplete from app.js):
document.addEventListener('DOMContentLoaded', function() {
  createAutocomplete(locInput, { fetchUrl: q => `...${locInput.dataset.orgId}...`, ... })
})

// Org-change handler (in DOMContentLoaded block further down) also updates locInput:
locInput.dataset.orgId = data.orgId || '';
locInput.disabled = !hasOrg || ticketStatus === 'closed';
```

## views/admin/users.ejs

### Sort persistence
`setUserSort(col)` saves `{sort, order}` to `localStorage` key `'adminUserSort'` before submitting.
`restoreSort()` IIFE on page load: if no `?sort` in URL, reads localStorage and does `location.replace`
to restore the preferred sort. POST redirects go to `/admin/users?message=...` (no sort param),
so this automatically re-applies the last sort after every edit.

### Edit dialog
`openEditDialog(btn)` reads data attributes from the button:
`data-user-id`, `data-user-email`, `data-user-name`, `data-user-role`, `data-user-org`,
`data-user-superuser`, `data-user-blocked`, `data-user-notifications-muted`, `data-user-can-add-participants`
(both table-row Edit button and mobile user-card have all these attributes)

Dialog form fields:
- Name, Role (select), Organization (autocomplete)
- Superuser checkbox (only shown for role=user)
- Account active checkbox
- Mute email notifications checkbox
- **Allow adding participants to tickets** checkbox — `name="can_add_participants"` value="1"
  - Controls both email CC auto-add and web UI "Add Participant"
  - Bypassed server-side for admin/tech/superuser regardless of this flag

## views/admin/organizations.ejs
- Table: org name + Edit + Delete buttons
- Edit opens `<dialog id="org-dialog">` (native HTML dialog, `.showModal()`)
- Dialog JS: `openOrgDialog(id, name)` → fetch `/admin/organizations/:id/json` → render locations
- Location row: inline name + distance inputs, Save + Delete buttons → fetch POSTs
- Add location: name + distance inputs → POST to `.../locations/add`
- All fetch POSTs send `_csrf` via URLSearchParams body
- `escHtml(s)` helper defined in script for rendering location names safely
- Delete blocked by server if `isLocationReferenced(id)` → shows alert with error message

## views/admin/settings.ejs
Organized sections (all in one form, one Save button):
1. General (app_url, site_name, ticket_email, ticket_silent_email, ticket_prefix, mail_from_name, admin_email, default_assignee_email)
2. Security (jwt_secret password input, secure_session checkbox, otp_max_tries, otp_lockout_seconds)
3. Due-date reminders (reminder_count, reminder_frequency_hours)
4. Email Transport (mail_transport select + conditional subsections for mailgun/smtp/gmail)
   - JS hides/shows transport subsections based on select value
5. Uploads & Rate Limits (extensions, rate limits)
6. Infrastructure — read-only table from `infra` object (PORT, SMTP_PORT, etc.)
7. Browser Cache — clear SW cache button

## views/reports/index.ejs
- Billing Report card: date range → `/reports/billing.csv`
- Travel Report card: date range → `/reports/travel.csv`
- Both cards: admin only. Non-admin sees "No reports available" message.

## views/timeline.ejs
- Layout: `.timeline-page` flex row — `.timeline-main` (left) + `.timeline-sidebar` (right, 250px)
- Mobile: stacks vertically; sidebar has Show/Hide toggle button
- Sections rendered server-side via EJS helper functions `cardHtml(t, schedNote, cls)` and `escStr(s)`
  - These are defined at the BOTTOM of the file but work because EJS compiles to a JS function (hoisting)
- Sections: overdue, NOW bar, asap, todayBusiness/todayTonight/todayAllDay, tomorrow, thisWeek, nextWeek, thisMonth, beyond, someday
- Sidebar: unscheduled tickets (no schedule_type)
- Schedule dialog (`<dialog id="sched-dialog">`): quick preset buttons + custom window/appointment fields
- CARDS JSON array embedded from server for JS access
- `openScheduleDialog(ticketId)`, `selectType(btn)`, `saveSchedule()`, `buildPayload(type)` — client-side JS
- Save: `fetch POST /timeline/tickets/:id/schedule` with `X-CSRF-Token` header, then `window.location.reload()`
- Time constants `BUSINESS_START_H`, `BUSINESS_END_H`, `TONIGHT_START_H`, `TONIGHT_END_H` passed from route

## views/emails/ticket-notification.ejs
Footer contains a prominent "View Ticket #N" button (solid blue, table-based for email client compat)
followed by smaller "Reply to this email to add a comment" text.
Images are stripped from the body before this template renders (handled in mail.js `stripImagesFromBody`).

## CSS classes (src/public/css/style.css)
- `.badge-billing` — green tint, billing hours on comments
- `.badge-location` — blue tint, location on comments
- `.badge-email` — "via email" label
- `.pill-btn`, `.pill-status-*`, `.pill-priority-*`, `.pill-active`
- `.flat-dot`, `.flat-dot-{status}` — status circles in filter tabs
- `.reports-grid`, `.report-card`, `.report-card-title`, `.report-card-desc`
- `.modal-dialog`, `.modal-header`, `.modal-body`, `.modal-footer` — native `<dialog>` styling
- `.settings-section-title`, `.settings-sub-title`, `.settings-transport-section`
- `.billing-total` — sidebar billable hours total
- `.nav-dropdown`, `.nav-dropdown-menu`, `.nav-dropdown-item`, `.nav-dropdown-toggle`
- `.timeline-page`, `.timeline-main`, `.timeline-sidebar`, `.timeline-sidebar-header`, `.timeline-sidebar-body`
- `.tl-section`, `.tl-section-header`, `.tl-section--overdue`, `.tl-section--asap`, `.tl-section-empty`
- `.tl-now-bar`
- `.tl-card`, `.tl-card--open`, `.tl-card--pending`, `.tl-card--on-hold`, `.tl-card-title`, `.tl-card-meta`, `.tl-card-id`, `.tl-card-sched`
- `.attach-btn-wrap` — wrapper for attachment "..." action button + dropdown
- `.attach-menu` — attachment action dropdown base class (also used for camera upload dropdown)
- `.attach-actions-menu` — specific class for the per-attachment "..." actions dropdown
- `.attach-menu-item` — action item (no text-decoration)
- `.attach-menu-item-danger` — danger-colored item (delete)
