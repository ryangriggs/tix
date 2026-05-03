# Security & Performance Audit — Full Issue List

Generated from audit of full codebase. Last updated: 2026-05.

---

## 1. Annotation route missing ticket access check ✅ FIXED
`src/routes/annotate.js` — Added party-membership / admin check in `resolveAnnotationTarget`.

## 2. Path traversal in annotation file path ✅ FIXED
`src/routes/annotate.js` — `storedName` now validated against regex before use in file path.
Regex: `(\d+-)?[0-9a-f]{8}-...-[0-9a-f]{12}(\.[a-zA-Z0-9]{1,10})?` (allows ticketId prefix).
Also validates `page` as small positive integer.

## 3. Mailgun inbound webhook unauthenticated ✅ ADDRESSED
User decision: acceptable risk. Webhook is only active when `mail_transport = mailgun`.

## 4. SSE `broadcastToAll` leaks ticket IDs ✅ RESOLVED
SSE was removed entirely. Issue no longer exists.

## 5. No HTTP security headers (Helmet) ✅ FIXED
Helmet added in `src/tix.js` with `useDefaults: false` and explicit CSP.
CSP: `scriptSrc: ["'self'", "'unsafe-inline'"]`, `styleSrc: ["'self'", "'unsafe-inline'"]`
All third-party JS (Quill, fabric, pdf.js) is now self-hosted — no external script domains needed.

## 6. Debug logging in Mailgun webhook ✅ FIXED
`console.log` lines removed from `src/routes/inbound.js`.

## 7. No login rate limiting per IP ✅ FIXED
In-memory rate limiter on POST /auth/login per IP and per email.
Configurable via Settings UI.

## 8. No pagination on ticket list and admin views ✅ FIXED
Pagination added with sizes 10/50/100/All, default 50.

## 9. SSE — removed ✅ DONE
SSE entirely removed. `src/services/sse.js` still exists but not mounted.

## 10. `express.json()` body parser has no size limit ✅ FIXED
`{ limit: '1mb' }` added to `express.json()` and `express.urlencoded()`.
Annotation POST validates size/structure.

## 11. Weak default JWT secret ⏳ DEFERRED
`src/config.js` line ~8 — default `'dev-secret-change-in-production'` still used if JWT_SECRET unset.
Fix when ready: log warning and refuse to start if using default in non-dev mode.

## 12. Auto-updater supply chain risk ⏳ DEFERRED
`src/services/updater.js` — repo URL is DB-editable. Risk: compromised admin account → malicious update.
Fix when ready: hard-code URL or require allowlist match + confirmation step.

## 13. Unsubscribe token doesn't expire ⏳ DEFERRED
HMAC-signed but no expiry. Low severity. Fix when ready: include timestamp, reject tokens > 90 days old.

## 14. Attachment path in commitAttachments ✅ SAFE
storedName is UUID-generated server-side. Not user-supplied.

## 15. CORS not configured ⏳ DEFERRED / LOW
No CORS headers set. Fine for same-origin app. CSRF token required for mutations anyway.

## 16. Inbound email To/CC auto-adds arbitrary users ⚠️ HIGH — DEFERRED (user reviewed, not urgent)
`src/services/inbound.js` — To/CC addresses auto-added as collaborators.
Attacker can force a third party onto a ticket's party list.
Fix: remove To/CC auto-add loop, or require confirmation link.

## 17. Forwarded-email sender auto-extracted and added ⚠️ MEDIUM — DEFERRED
`src/services/inbound.js` — regex-parses email body for `From:` line, adds as collaborator.
Fix: remove forwarded-sender extraction, or require confirmation.

## 18. Message-ID reply adds non-party as collaborator ⚠️ LOW — DEFERRED
In-Reply-To match bypasses party check. Practical risk low (Message-IDs are unguessable).
Fix: apply same party-check as subject-tag path.

## 19. `data:` URI in link hrefs ⚠️ LOW — DEFERRED
`src/routes/tickets.js` sanitize() — `allowedSchemes` includes `data:` for all tags.
Not needed for hrefs (only needed for img src).
Fix: `allowedSchemes: ['http','https','mailto'], allowedSchemesByTag: { img: ['data:'] }`

## 20. OTP brute-force via multiple concurrent tokens ⚠️ LOW — DEFERRED
5 tokens × 5 attempts each = 25 OTP guesses/minute. Fix: global OTP failure tracking per email.

## 21. JWT algorithm not explicitly constrained ⚠️ LOW — DEFERRED
`jwt.verify()` omits `{ algorithms: ['HS256'] }`. jsonwebtoken v9+ rejects `alg:none` anyway.
Fix: add `{ algorithms: ['HS256'] }` option.

## 22. Default assignee config creates ghost user accounts ⚠️ LOW — DEFERRED
`findOrCreateUser(defaultEmail)` called without first checking user exists.
Fix: use `getUserByEmail` first; log warning and skip if not found.

## 23. Admin impersonation — no audit log ⚠️ LOW — DEFERRED
Impersonation start/return not written to audit log. 8-hour session with no re-auth.
Fix: log to audit; reduce maxAge to 30 minutes.

## 24. User search exposes all accounts for org-less users ✅ FIXED
`src/routes/api.js` — `GET /api/users/search`. Regular users scoped to `organization_id`, but if that was null the org filter was skipped and all users were returned, allowing full email enumeration.
Fix: early return `[]` for non-privileged users with no org. They can still add collaborators by typing an email directly.

---

## Findings NOT confirmed / dismissed
- **Stored XSS via `<%-`**: NOT a vulnerability. `<%-` renders pre-sanitized HTML correctly.
- **CSRF on report GET endpoints**: NOT exploitable. CORS same-origin + SameSite=Lax.
- **Attachment TOCTOU**: NOT realistic. Node.js single-threaded + synchronous SQLite.
- **Bulk delete not scoped**: NOT an issue — admins see all tickets.
- **Unsubscribe rate limiting**: NOT needed — operation is idempotent.
- **Plaintext credentials in DB**: TRUE but standard for self-hosted apps. Deferred.
