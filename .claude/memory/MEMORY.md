# Tix Project Memory

## Project
Node.js/Express server-rendered ticketing system. Path varies by machine — check `pwd`.
No build step, no linter, no test suite. Run with `npm run dev`.

## Detailed notes (read these for deep dives)
- `db-schema.md` — full schema, all tables, migration pattern, all DB functions
- `routes.md` — all routes, access control, JSON vs redirect responses
- `views.md` — template structure, JS patterns, autocomplete, Quill, sidebar
- `features.md` — billable hours, locations, reports, settings, reminders, party roles
- `security-audit.md` — full security/performance audit with status (23 items, some deferred)
- `timeline-feature-design.md` — full design discussion + POC implementation notes for timeline view

## Key Architecture
- EJS templates + vanilla JS, SQLite via sql.js (WASM, synchronous)
- Auth: magic-link + OTP, JWT in httpOnly cookie, stateless CSRF
- `res.locals` set in `src/app.js`: `formatDate`, `formatDateFull`, `formatDateOnly`, `formatDateInput`, `formatTicketId`, `siteName`, `user`, `impersonatingAdminEmail`, `appVersion`
- Config: all settings (except PORT, SMTP_PORT, DATA_DIR, UPLOADS_DIR, EMAIL_LOG, USER_LOG) are DB-backed and editable in Settings page. Seeded from .env on first boot via `seedSetting()`. Applied to in-memory config object via `config.applySettings(getAllSettings())` at startup.
- No SSE — real-time updates were removed. Page refreshes manually.
- Inbound email: SMTP port 25 → `src/services/inbound.js`
- Outbound: `config.mailTransport` = mailgun|smtp|gmail. Transport cached in `_transport` var in mail.js; call `resetMailTransport()` to clear after credential changes.

## Roles & Access
- Roles: `admin`, `technician`, `user`; flag: `is_group_superuser`
- Close ticket: admin or tech only (`canCloseTicket`). Reopen: admin only (`canReopenTicket`).
- Billable hours + location: admin/tech only to set. Location visible to all if set.
- `req.user.techOrgIds` pre-loaded in `src/middleware/auth.js`

## UI Patterns & Conventions
- **Autocomplete**: `createAutocomplete(input, { fetchUrl(q), formatItem, onSelect, showOnFocus })` in `src/public/js/app.js`. `fetchUrl` is a FUNCTION `q => url`, NOT a string. Parent needs `position:relative`. MUST wrap init in `DOMContentLoaded` because app.js loads in foot.ejs AFTER inline scripts.
- **Pill buttons**: `.pill-btn .pill-status-{val}` / `.pill-priority-{val}` + `.pill-active`. Inline onclick sets hidden input + submits form.
- **Inline scripts**: Must use `DOMContentLoaded` for anything needing app.js functions.
- **Quill editor**: loaded from `/js/quill.min.js` (local). `keyboard.bindings` for Ctrl+Enter submit. `quill.root.innerHTML` → hidden `#comment-body` on submit.
- **Sidebar AJAX**: `sidebarPost(url, data)` helper — sends urlencoded POST, returns JSON.
- **Status/priority badges**: transparent bg, colored text + `border: 1px solid currentColor`.
- **Global shortcuts**: Ctrl+N → new ticket (app.js).
- **Dialog centering**: use `position:fixed; inset:0; margin:auto` — NOT `transform:translate(-50%,-50%)`. Transforms create new containing blocks that break `position:fixed` children (e.g. autocomplete dropdowns).

## Third-party JS (all self-hosted in src/public/js/)
- `quill.min.js` — rich text editor (used in ticket detail + new ticket)
- `fabric.min.js` — canvas annotation tool (used in annotate view)
- `pdf.min.js` + `pdf.worker.min.js` — PDF rendering (used in annotate view for PDFs)

## User Preferences
- Flat UI: no gradient fills, no emoji shading, outlined pill badges
- Pill buttons over dropdowns for status/priority changes
- Mobile-first (tested Android A51 Chrome); `overflow-x: hidden` on body
- No unnecessary abstraction, no gold-plating, no unprompted refactoring
