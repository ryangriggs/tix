# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Memory

Detailed reference notes are in `.claude/memory/`. Read `.claude/memory/MEMORY.md` for the index, then load whichever files are relevant to the current task:
- `db-schema.md` — full schema, all tables, all DB functions
- `routes.md` — all routes, access control, CSRF patterns
- `views.md` — template structure, JS patterns, CSS class reference
- `features.md` — billable hours, locations, party roles, settings, reminders, attachments
- `security-audit.md` — all 23 audit items with current status (some fixed, some deferred)
- `timeline-feature-design.md` — timeline POC design + implementation notes

## Commands

```bash
# Run in development (auto-restart on changes)
npm run dev

# Run in production
npm start

# Run with Docker Compose (includes MailHog for email testing)
docker compose up
```

No build step, no linter, no test suite — this is a plain Node.js project.

## Architecture

A server-rendered email ticketing system. Users submit tickets via web UI or by sending email; staff reply via web or email. No client-side framework — EJS templates + vanilla JS for SSE.

**Request flow**: Express routes (`src/routes/`) → service layer (`src/services/`) → database (`src/db/index.js`)

### Key files

| File | Purpose |
|------|---------|
| `src/tix.js` | Express app setup, server startup, cron jobs |
| `src/config.js` | All environment variable definitions with defaults |
| `src/db/index.js` | SQLite schema, all SQL queries, migrations |
| `src/middleware/auth.js` | JWT session validation, CSRF verification |
| `src/smtp.js` | Inbound SMTP server (port 25) |
| `src/services/inbound.js` | Parses inbound email → creates tickets or appends comments |
| `src/services/mail.js` | Outbound email (nodemailer/Mailgun); selects transport from config |
| `src/services/sse.js` | Server-Sent Events broadcaster (present but unused — SSE was removed) |

### Database

SQLite via `sql.js` (wraps the WASM build). `src/db/index.js` exposes a synchronous API mimicking `better-sqlite3`. All schema, migrations, and queries live in this single file. FTS4 (not FTS5) is used for full-text search — required for sql.js compatibility.

Schema core: `users`, `tickets`, `ticket_parties` (many-to-many roles), `comments`, `attachments`, `email_messages` (threading), `auth_tokens`, `settings`. Tickets also have schedule columns for the timeline view (`schedule_type`, `schedule_window_start`, `schedule_window_end`, `schedule_time_of_day`, `schedule_exact_at`).

### Authentication

Magic-link + OTP flow — no passwords. JWT stored in httpOnly cookie. CSRF tokens are HMAC-SHA256 of the session cookie (stateless; invalidate by clearing the cookie).

### Email threading (inbound)

Priority order when matching inbound email to a ticket:
1. `tickets+TOKEN@domain` reply-to token in To/CC
2. Message-ID lookup via In-Reply-To / References headers
3. `[Ticket #N]` subject tag — only accepted from existing ticket parties

### Outbound email transport

Configured via `MAIL_TRANSPORT=mailgun|smtp|gmail`. The Gmail transport builds a raw RFC 2822 message and sends via the Gmail API over HTTPS (avoids SMTP port blocking). Run `npm run gmail-setup` once to obtain a refresh token.

### Real-time updates

SSE was removed. There are no real-time updates — the page refreshes manually.

## Configuration

Copy `.env.example` to `.env`. Required in production:
- `JWT_SECRET` — long random string
- `APP_URL` — public URL used in outbound email links
- `TICKET_EMAIL` — inbound address (e.g. `tickets@yourdomain.com`)
- `ADMIN_EMAIL` — first user created with this email gets admin role
- Mail transport credentials (`MAILGUN_*` or `SMTP_RELAY_*`)

## Docker

`Dockerfile` uses Node 20 Alpine. Data persisted to `/app/data` (mount a volume). The container runs both the HTTP server (3000) and SMTP server (25).
