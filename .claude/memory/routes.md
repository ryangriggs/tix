# Routes

## Mounting (src/tix.js)
```
/auth       — optionalAuth + routes/auth.js           (login/logout/OTP)
/tickets    — requireAuth + verifyCsrf + routes/tickets.js
/admin      — requireAuth + requireAdmin + verifyCsrf + routes/admin.js
/api        — requireAuth + routes/api.js
/reports    — requireAuth + routes/reports.js
/timeline   — requireAuth + verifyCsrf + routes/timeline.js
/inbound    — no auth (SMTP webhook / inbound email handler)
```
Note: SSE (/events) was removed. No real-time updates; page refreshes manually.

## src/routes/tickets.js

### Key helpers
- `canManage(ticket, user)` — admin, assigned tech, or group superuser can manage
- `canCloseTicket(user)` — admin or technician
- `canReopenTicket(user)` — admin only
- `getTicketAccess(ticket, user)` — returns access level or null if forbidden

### GET /:id
Passes to detail.ejs: `ticket`, `comments`, `attachments`, `parties`, `isTechOrAdmin`, `canClose`, `canReopen`, `canManage`

### POST /:id/comments
- Validates access, optional status change, close/reopen permission checks
- Billable hours: admin/tech only, disabled on closed tickets
- Location: admin/tech only, only if ticket.organization_id set. Submits `location_name` (text) + `location_id` (hidden int). Server verifies loc belongs to ticket's org; calls `findOrCreateLocation` for freeform.
- Sets close_date when closing, clears when reopening

### POST /:id/status (sidebar pill — JSON)
- Returns JSON `{ok, status}`
- Enforces close/reopen permissions, sets/clears close_date

### POST /:id/organization (sidebar — JSON)
- Returns `{ok, orgName, orgId}` — orgId needed by client to update location input
- Client (detail.ejs) updates `locInput.dataset.orgId`, enables/disables location input

### POST /:id/due-date
- Resets `reminders_sent` to 0 when due date changes

### POST /attachments/:storedName/rename (admin only)
- Updates `original_name` in DB. Stored filename on disk unchanged.
- Redirects to `/tickets/:id#attachments`

### POST /attachments/:storedName/delete (admin only)
- Deletes DB record + file from disk

## src/routes/admin.js

### Organizations
- `GET  /organizations` — list page
- `GET  /organizations/:id/json` — JSON {org, locations} for edit dialog
- `POST /organizations/:id/rename`
- `POST /organizations/:id/delete`
- `POST /organizations/:id/locations/add` — returns JSON location row
- `POST /organizations/:id/locations/:locId/update` — returns JSON {ok}
- `POST /organizations/:id/locations/:locId/delete` — returns JSON {ok} or {error} if referenced

### Settings
- `GET  /settings` — passes `s` (getAllSettings() map) + `infra` (read-only .env values: PORT, SMTP_PORT, DATA_DIR, UPLOADS_DIR, EMAIL_LOG, USER_LOG)
- `POST /settings` — saves all, calls `config.applySettings(updates)` + `resetMailTransport()`

### Logs
- `GET /logs?tab=email|users` — reads EMAIL_LOG and USER_LOG files

## src/routes/api.js
All require auth. Technicians/users see filtered results.
- `GET /users/search?q=` — admin/tech see all; user scoped to own org
- `GET /organizations/search?q=`
- `GET /organizations/:id/locations?q=` — admin/tech only; returns locations for autocomplete

## src/routes/reports.js
- `GET /` — renders reports/index.ejs (visible to all auth users)
- `GET /billing.csv?from=&to=` — admin only; filters by ticket close_date; HAVING prevents 0-hour rows
- `GET /travel.csv?from=&to=` — admin only; filters by comment created_at date

## src/routes/timeline.js
- `GET /` — renders timeline.ejs; calls `getTimelineTickets(userId)`, classifies into sections, builds labels
- `POST /tickets/:id/schedule` — JSON body `{type, window_start?, window_end?, time_of_day?, exact_at?}`. Requires owner or admin. Calls `setTicketSchedule()`. Returns `{ok:true}`.

## src/routes/annotate.js
Mounted under `/tickets` in tix.js. Handles PDF/image annotation.
- `GET  /:ticketId/attachments/:storedName/annotate` — annotation editor
- `GET  /:ticketId/attachments/:storedName/annotations/:page` — load annotations JSON
- `POST /:ticketId/attachments/:storedName/annotations/:page` — save annotations JSON
- `storedName` validated against regex: `(\d+-)?UUID(.ext)?` (ticketId prefix is optional)

## CSRF
`verifyCsrf` reads `req.body._csrf` OR `req.headers['x-csrf-token']`. Token is HMAC-SHA256 of session cookie (stateless).
For AJAX JSON POST: send as `X-CSRF-Token` header.
For form POST: send as `_csrf` hidden field.
`csrfToken` is in `res.locals` (set by auth middleware) — available in all views as `<%= csrfToken %>`.

## New user notification
`sendAdminNewUserNotification(user, source)` in `src/services/mail.js`.
Called whenever a new user account is created:
- `src/routes/auth.js` — first magic-link login
- `src/routes/admin.js` — admin pre-add
- `src/routes/tickets.js` — collaborator added on new ticket, default assignee
- `src/services/inbound.js` — inbound email creates new user
