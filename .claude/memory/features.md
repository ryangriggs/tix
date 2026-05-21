# Feature Details

## Billable Hours
- Stored on `comments.billable_hours REAL`
- Admin/tech only to enter; disabled on closed tickets
- `ticket.total_billable_hours` = subquery SUM in `getTicketById`
- Sidebar shows total: admin only, only if > 0
- Per-comment badge `.badge-billing`: admin/tech only
- No work_type (was dropped — column removed via migration)

## Locations
- `locations` table: id, organization_id, name, distance_miles (default 0)
- `comments.location_id` FK — nullable
- Admin/tech only to set on reply; visible to all users if set (`.badge-location` with 📍)
- Location input disabled if ticket has no org, or ticket is closed
- Freeform input → `findOrCreateLocation(orgId, name)` creates with distance=0
- Selected from autocomplete → `location_id` hidden input carries the ID
- New locations created from reply always get distance=0; admin edits distance in Orgs page
- Deletion blocked if any comments reference location (`isLocationReferenced`)
- When org changes on ticket: client updates `locInput.dataset.orgId`, clears value, enables/disables

## Settings (DB-backed)
Managed in `src/routes/admin.js` GET/POST /settings.
All settings stored in `settings` table, seeded from .env on first boot (INSERT OR IGNORE).
Applied to live `config` object via `config.applySettings(map)` at startup and on save.
Mail transport cache cleared via `resetMailTransport()` on settings save.

Settings that stay in .env (restart-required):
- PORT, SMTP_PORT, DATA_DIR, UPLOADS_DIR, EMAIL_LOG, USER_LOG

Settings in DB (editable in UI):
- Site & Identity: site_name, app_url, ticket_prefix, ticket_email, ticket_silent_email, mail_from_name, admin_email, default_assignee_email
- Security: jwt_secret, secure_session, otp_max_tries, otp_lockout_seconds, login_rate_limit_ip, login_rate_limit_email
- Mail transport: mail_transport, mail_queue_delay_ms, mailgun_api_key, mailgun_domain, smtp_relay_host/port/user/pass, resend_api_key, gmail_client_id/secret/refresh_token/user
- Inbound email security: mailgun_webhook_enabled, enforce_spf, enforce_dkim
- Notifications: notify_email_submitter, notify_email_status_change, urgent_notify_user_ids
- Uploads: upload_max_size_mb, upload_allowed_extensions, upload_blocked_extensions, annotation_extensions, email_rate_limit_per_ticket/new_tickets
- Reminders: reminder_count, reminder_frequency_hours, inactivity_hours_urgent/high/medium/low
- Features: enable_billable_hours, enable_location
- Updates: update_check_enabled, update_repo_url, update_check_interval_hours
- Backups: backup_frequency_hours, backup_retention_days (requires BACKUP_DIR in .env)

Note: changing ticket_email in UI updates outbound links immediately but NOT the SMTP server's domain filter (that's bound at startup).

## Due-date Reminders (cron in src/tix.js)
Runs every hour. Reads `reminder_count` and `reminder_frequency_hours` from DB settings.
Only sends to admin/tech parties on the ticket (not regular users/collaborators).
Tracks `tickets.reminders_sent` counter — advances past expired slots without sending.
Resets `reminders_sent` to 0 when due_date is changed.
Logic: for slot 0..count-1, sendTime = due_date - (count-slot)*freqSecs.
If sendTime is within the 1-hour cron window → send. If past → skip (advance counter). If future → stop.

## Reports
### Billing Report (GET /reports/billing.csv)
- Admin only
- Filters: closed tickets by close_date range
- HAVING COALESCE(SUM(billable_hours),0) > 0 — excludes 0-hour tickets
- CSV: Ticket ID, Ticket Title, Creation Date, Close Date, Organization, Total Billable Hours

### Travel Report (GET /reports/travel.csv)
- Admin only
- Filters: comments with location_id, by comment created_at date range
- Any ticket status (open or closed)
- Groups by location: organization, location name, visit count, distance one way
- CSV: Organization, Location, Number of Visits, Distance One Way (miles)
- Does NOT calculate total distance (shows per-location distance once)

## Ticket Party Roles
There are two distinct role systems: **account role** (admin/technician/user) and **party role** (submitter/owner/collaborator).

### Party roles (ticket_parties.role)
**submitter** — the person who created the ticket (web form sender, or email originator).
- Can manage: reply, change status/priority/due date/org, add/remove parties
- Gets all email notifications

**owner** — the responsible person / assignee.
- Identical manage permissions to submitter
- Gets all email notifications
- Set via: default_assignee_email config, silent-ticket-email sender, or manual sidebar add
- The sidebar "Owner" option adds with this role
- Used by Timeline view: `getTimelineTickets(userId)` returns tickets where user is owner

**collaborator** — passive participant (CC'd on inbound email, or manually added).
- CANNOT manage: cannot change status, priority, due date, org, or parties
- CAN view the ticket and post comments
- Gets all email notifications — same as owner/submitter
- The sidebar "Collaborator" option adds with this role

### How roles are assigned automatically (inbound email)
- Email sender → submitter (or owner if using silent ticket address)
- To:/CC: recipients → collaborator (only if sender has `can_add_participants` — see below)
- default_assignee_email → owner (if not already a party)

### Important: addParty uses ON CONFLICT DO UPDATE SET role
So adding an existing party with a different role CHANGES their role.
To promote a collaborator to owner: add them again with role=owner via the sidebar.

### Submitter removal
Any party including the only submitter can be removed.
Intended workflow: triage admin is auto-assigned as owner via default_assignee_email, reviews ticket,
assigns to tech/other admin as owner, removes themselves as submitter to exit the notification chain.

### Assigned To filter (ticket list)
- Visible to: admin and technician only (canFilterOwner)
- Options: "Assigned to me" (default, value='me'), "All" (value=''), "Unassigned" (admin only), then distinct owners from viewable tickets
- ownerFilter in getTickets: 'me', 'unassigned', number (userId), or null (no filter)
- Stored in filter cookie under key 'owner', default 'me'

### notifyParties
Sends to ALL parties (all roles) except the actor. No distinction between roles for notifications.
Visibility param filters which staff tiers receive (admin/tech-only comments go to staff only).

### Account role vs party role interaction
- canManage: true if account role is admin/technician, OR party role is submitter/owner
- canCloseTicket: checks ACCOUNT role only (admin or technician) — a regular user who is owner/submitter CANNOT close
- canReopenTicket: admin account role only
- Ticket visibility for regular users: only tickets where they have any party role

## Close/Reopen Permissions
- Close: `canCloseTicket(user)` = admin or technician
- Reopen: `canReopenTicket(user)` = admin only
- Closing sets `tickets.close_date = now()`; reopening clears it
- Billing hours + location disabled on closed tickets
- Confirm dialogs: closing warns no more billable hours; reopening warns billing impact

## Config Architecture (src/config.js)
config object exported as module.exports. Also exports `applySettings(map)` function.
`applySettings` mutates the config object in-place — all require('./config') users see the change
immediately since they hold a reference to the same object.
Nested objects (config.mailgun, config.smtpRelay, config.gmail) are mutated directly.
Type coercions handled in applySettings: parseInt for numeric fields, === 'true' for booleans.

## Inbound Email Threading (src/services/inbound.js)
Priority order for matching email to ticket:
1. tickets+TOKEN@domain reply-to token in To/CC
2. Message-ID lookup via In-Reply-To / References headers
3. [Ticket #N] subject tag — only from existing parties

## Inbound Email — Image / Attachment Handling
`prepareAttachments()` writes all email attachments to disk and builds `cidMap` (cid → storedName) for inline images.
`formatEmailBody()` resolves `cid:` references in HTML body → `/tickets/attachments/{storedName}` URLs before sanitizing.

**SMTP path (processInboundEmail):** inline CID images ARE re-embedded in body. ✓
**Mailgun webhook path (processMailgunWebhook):** ⚠️ MISSING FEATURE — multer files have no contentId, cidMap is always empty, so cid: refs in the HTML body are stripped by the sanitizer. Inline images arrive as orphaned attachments only. Fix: parse Mailgun's `content-id-map` field and attach contentId to the matching multer file before calling prepareAttachments.

## Inbound Email — CC Auto-Add (can_add_participants gate)
On new ticket creation (`handleNewTicket` in inbound.js), To:/CC: recipients are added as collaborators
ONLY if the sender has `can_add_participants` permission.

Permission check (snake_case from DB — inbound.js uses senderUser.is_group_superuser):
```js
const ok = ['admin','technician'].includes(senderUser.role)
  || !!senderUser.is_group_superuser
  || !!senderUser.can_add_participants;
```

When blocked: all blocked email addresses are collected, then a single internal technician-visibility
comment is added to the ticket:
> "User X attempted to CC the ticket to other user(s) a@b, c@d but does not have permission to add
> collaborators to the ticket. Contact administrator for approval."

Same gate applies to forwarded-sender extraction (the `From:` line parsed from forwarded body).
CC auto-add does NOT exist in `handleReply` — only in `handleNewTicket`.

## can_add_participants Permission
- Column: `users.can_add_participants INTEGER NOT NULL DEFAULT 0`
- Controls BOTH email CC auto-add AND web UI "Add Participant" (POST /tickets/:id/parties)
- Also gates collaborator fields on web new-ticket form (POST /tickets)
- Bypassed for: admin role, technician role, is_group_superuser=1
- Regular users (including owners/submitters) require explicit admin grant
- Admin toggles via checkbox in user edit dialog (`/admin/users`)
- DB function: `updateUserCanAddParticipants(userId, val)`

## Outbound Email — Image Handling
`sendTicketNotification` in `src/services/mail.js` strips all `<img>` tags from the body before
sending, replacing them with a notice:
> "📷 This message contains images. Open ticket to view them." (links to ticket, anchored to
> `#comment-{commentId}` when a comment ID is available)

This keeps notification emails lightweight and avoids broken-image problems (attachments require login).
`commentId` is passed from `notifyParties` → `sendTicketNotification` so the anchor points to the right comment.

## Admin Impersonation
Admin can impersonate another user. Current admin session stashed in `admin_session` cookie.
Banner shown when impersonating. Can restore original session.
Blocked users cannot be impersonated.

## Admin New User Notification
`sendAdminNewUserNotification(user, source)` in `src/services/mail.js`.
Triggered whenever a new user account is auto-created via any path (magic link, admin pre-add,
inbound email, ticket creation with collaborator/assignee email not yet in system).
Sends email to `config.adminEmail` with the new user's email and the source label.

## Attachment Management
- Upload: stored as `{ticketId}-{uuid}.{ext}` on disk for manual recovery
- Download/view: `GET /tickets/attachments/:storedName` — inline for images/PDF/video/audio, download otherwise; requires login
- Delete: admin/tech/owner/superuser via `POST /tickets/attachments/:storedName/delete`
- Rename: admin/tech/owner/superuser via `POST /tickets/attachments/:storedName/rename` — changes `original_name` in DB, disk file unchanged
- Annotate: PDF/image files; access restricted to admin/tech/superuser/ticket-owner only
  - Uses fabric.js (canvas) + pdf.js (for PDFs), both self-hosted in `src/public/js/`
  - Annotations stored as JSON files in `config.annotationsDir`
- UI: "..." button per attachment opens a dropdown with: View, Annotate (if annotatable + canManageAtt), Rename (canManageAtt), Delete (canManageAtt)
  - `canManageAtt = isTechOrAdmin || ['owner','superuser'].includes(access)`
  - Dropdown: `.attach-btn-wrap` > `<button>` + `.attach-menu.attach-actions-menu`
  - `toggleAttachActionsMenu(btn)` opens/closes; document click listener closes all open menus

## Git Hooks (version increment)
- `.githooks/pre-commit` — increments patch version in package.json on every commit
- Persists across fresh clones via `package.json` `prepare` script:
  `node -e "const{execSync}=require('child_process');try{execSync('git config core.hooksPath .githooks')}catch(e){}"`
  This runs on `npm install` and sets `core.hooksPath` automatically.
