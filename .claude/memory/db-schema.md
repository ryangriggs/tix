# DB Schema & Functions

## Engine
sql.js (SQLite WASM). All queries in `src/db/index.js`. Synchronous API (mimics better-sqlite3).
FTS4 (not FTS5) — required for sql.js. Saves to disk on every write via `save()`.

## Migration Pattern
```js
try { _db.exec('ALTER TABLE foo ADD COLUMN bar TEXT'); } catch (_) {}
```
Run on every startup — safe to repeat. New tables go in the SCHEMA string (CREATE TABLE IF NOT EXISTS).
DROP COLUMN requires SQLite 3.35+; sql.js WASM may or may not support it — use try/catch.

## Tables

### users
id, email (unique), name, role (admin|technician|user), organization_id FK,
is_group_superuser (0/1), blocked_at (timestamp or null), created_at,
notifications_muted (0/1 default 0),
can_add_participants (0/1 default 0) — gate for CC/web-UI collaborator add

### tickets
id, subject, body (HTML), status (new|open|on_hold|closed), priority (low|normal|high|urgent),
organization_id FK, due_date (unix), close_date (unix — set on close, cleared on reopen),
reply_token (unique hex), reminders_sent (int, reset when due_date changes),
schedule_type (NULL|asap|window|appointment|someday),
schedule_window_start (unix), schedule_window_end (unix),
schedule_time_of_day (business|tonight|allday),
schedule_exact_at (unix — appointments only),
created_at, updated_at

### ticket_parties
ticket_id, user_id, role (submitter|owner|collaborator)
Many-to-many. One row per user per ticket.

### comments
id, ticket_id, user_id, body (HTML), is_email (0/1),
billable_hours (REAL nullable), location_id (FK → locations, nullable),
visibility (user|technician|admin — default 'user'),
created_at
NOTE: work_type was dropped (migration: DROP COLUMN work_type, try/catch)
visibility='technician' means only admin/tech-role users see the comment (used for internal notes).

### attachments
id, ticket_id, comment_id (nullable), original_name, stored_name, mime_type, size, created_at
stored_name format: `{ticketId}-{uuid}.{ext}` (ticketId prefix added for manual recovery)

### organizations
id, name (unique COLLATE NOCASE)

### locations
id, organization_id FK (CASCADE DELETE), name TEXT, distance_miles REAL DEFAULT 0
UNIQUE(organization_id, name COLLATE NOCASE)
New locations added from ticket reply get distance_miles=0; admin sets actual distance in Orgs page.

### technician_organizations
technician_id FK, organization_id FK — which orgs a tech can see

### settings
key TEXT PRIMARY KEY, value TEXT
Used for both app settings (site_name, mail credentials etc.) AND user prefs (user_prefs_{userId} JSON).
System keys excluded from getAllSettings(): user_prefs_*, fts_migrated.

### auth_tokens
id, user_id FK, token, otp, otp_tries, locked_until, created_at, used_at

### email_messages
id, ticket_id FK, message_id (RFC2822), direction (in|out), created_at
Used for threading inbound email replies to the right ticket.

## Key DB Functions (src/db/index.js exports)

### Tickets
- `getTicketById(id)` — includes `total_billable_hours` subquery SUM, org name JOIN
- `getTickets(filters)` — list with filtering/sorting
- `updateTicket(id, fields)` — allowed fields: subject, body, status, priority, due_date, organization_id, close_date
- `createTicket(...)` — returns new ticket row

### Comments
- `addComment(ticketId, userId, body, isEmail=false, billableHours=null, locationId=null, visibility='user')`
  - visibility='technician' creates an internal note visible only to admin/tech
- `getComments(ticketId)` — JOINs users (email, name) + locations (location_name, location_distance). ORDER BY created_at DESC.
- `deleteComment(id)`

### Attachments
- `addAttachment({ticketId, commentId, originalName, storedName, mimeType, size})`
- `getAttachments(ticketId)`
- `getAttachmentByStoredName(storedName)`
- `deleteAttachment(storedName)`
- `renameAttachment(storedName, newOriginalName)` — updates original_name only; stored_name unchanged

### Organizations & Locations
- `getAllOrganizations()` — ORDER BY name ASC
- `getOrganizationById(id)`
- `findOrCreateOrganization(name)` — INSERT OR IGNORE, returns row
- `searchOrganizations(q)` — LIKE %q% LIMIT 20
- `renameOrganization(id, name)`
- `deleteOrganization(id)`
- `getLocationsByOrg(orgId)` — ORDER BY name ASC
- `getLocationById(id)`
- `createLocation(orgId, name, distance_miles=0)` — INSERT, catches UNIQUE collision, returns row
- `findOrCreateLocation(orgId, name)` — calls createLocation with distance=0 (used from ticket reply)
- `updateLocation(id, {name, distance_miles})` — partial update ok
- `isLocationReferenced(id)` — returns bool (checks comments.location_id)
- `deleteLocation(id)` — only call after checking isLocationReferenced

### Settings
- `getSetting(key)` → string|null
- `setSetting(key, value)` — INSERT OR REPLACE
- `seedSetting(key, value)` — INSERT OR IGNORE (won't overwrite existing)
- `getAllSettings()` — returns {key:value} map, excludes user_prefs_* and fts_migrated
- `getUserPrefs(userId)` / `setUserPrefs(userId, prefs)`

### Timeline
- `getTimelineTickets(userId)` — non-closed tickets where user is owner (ticket_parties JOIN), includes org name
- `setTicketSchedule(ticketId, {type, window_start, window_end, time_of_day, exact_at})` — UPDATE schedule fields

### Reports
- `getBillingReport(fromTs, toTs)` — closed tickets with billable hours, HAVING COALESCE(SUM(billable_hours),0)>0
- `getTravelReport(fromTs, toTs)` — comments with location_id, grouped by location, date filter on comment created_at

### Reminders
- `getTicketsForReminders()` — open tickets with due_date, one row per admin/tech party_email
- `setTicketRemindersSent(ticketId, count)` — updates counter WITHOUT touching updated_at

### Users
- `findOrCreateUser(email, name?)` — returns user; sets `_isNew = true` property when newly inserted
- `getUserById(id)`, `getUserByEmail(email)`
- `getUsersSorted(sort, order)` — name sort uses `u.name COLLATE NOCASE` (NULLs first in ASC, so blank-named users appear at top)
- `updateUserRole(id, role)`, `updateUserName(id, name)`, `blockUser(id)`, `unblockUser(id)`
- `updateUserOrganization(userId, orgId)`
- `updateUserSuperuser(userId, val)`
- `setUserNotificationsMuted(userId, val)`
- `updateUserCanAddParticipants(userId, val)` — sets can_add_participants 0/1
