'use strict';

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const jwt = require('jsonwebtoken');
const config = require('./config');
const { requireAuth, requireAdmin, optionalAuth, verifyCsrf } = require('./middleware/auth');
const { startSMTPServer } = require('./smtp');
const sse = require('./services/sse');
const { initDb, getTicketsForReminders, setTicketRemindersSent, getSetting, seedSetting, getAllSettings } = require('./db');
const { sendDueReminder } = require('./services/mail');

const app = express();

// ============================================================
// View engine
// ============================================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ============================================================
// Middleware
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const { version } = require('../package.json');

// Template helpers available in all views
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.appVersion = version;

  // Detect admin impersonation
  res.locals.impersonatingAdminEmail = null;
  if (req.cookies.admin_session) {
    try {
      const payload = jwt.verify(req.cookies.admin_session, config.jwtSecret);
      if (payload.role === 'admin') res.locals.impersonatingAdminEmail = payload.email;
      else res.clearCookie('admin_session');
    } catch (_) { res.clearCookie('admin_session'); }
  }
  try { res.locals.siteName = getSetting('site_name') || config.siteName; } catch (_) { res.locals.siteName = config.siteName; }

  res.locals.formatDate = function (ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60)     return 'just now';
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  };

  res.locals.formatDateFull = function (ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  res.locals.formatDateInput = function (ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toISOString().slice(0, 10);
  };

  res.locals.formatDateOnly = function (ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString();
  };

  res.locals.formatTicketId = id => `${config.ticketPrefix}${id}`;

  next();
});

// ============================================================
// Routes
// ============================================================
app.use('/auth', optionalAuth, require('./routes/auth'));
app.use('/tickets', requireAuth, verifyCsrf, require('./routes/tickets'));
app.use('/admin', requireAuth, requireAdmin, verifyCsrf, require('./routes/admin'));
app.use('/api', requireAuth, require('./routes/api'));
app.use('/reports', requireAuth, require('./routes/reports'));
app.use('/inbound', require('./routes/inbound'));

// Root
app.get('/', requireAuth, (req, res) => res.redirect('/tickets'));

// ============================================================
// Server-Sent Events
// ============================================================
app.get('/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering when behind reverse proxy
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', userId: req.user.id })}\n\n`);

  sse.addClient(req.user.id, res);

  // Keepalive ping every 25 seconds (browsers time out SSE after ~30s of silence)
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sse.removeClient(req.user.id, res);
  });
});

// ============================================================
// Error handlers
// ============================================================
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).render('error', { title: '404', message: 'Page not found.' });
});

app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).render('error', { title: 'File too large', message: 'One or more files exceed the 25 MB size limit.' });
  }
  if (err.message?.startsWith('File type')) {
    return res.status(400).render('error', { title: 'File type not allowed', message: err.message });
  }
  console.error('[App] Unhandled error:', err);
  res.status(500).render('error', { title: 'Error', message: 'An unexpected error occurred.' });
});

// ============================================================
// Start — DB must be ready before accepting requests
// ============================================================
async function start() {
  await initDb();

  // Seed configurable settings from .env defaults (INSERT OR IGNORE — won't overwrite DB values).
  // This runs once on first boot, migrating .env values into the DB.
  const seedDefaults = {
    app_url:                        config.appUrl,
    ticket_email:                   config.ticketEmail,
    ticket_silent_email:            config.ticketSilentEmail,
    ticket_prefix:                  config.ticketPrefix,
    mail_from_name:                 config.mailFromName,
    admin_email:                    config.adminEmail,
    site_name:                      config.siteName,
    default_assignee_email:         config.defaultAssigneeEmail,
    jwt_secret:                     config.jwtSecret,
    secure_session:                 String(config.secureSession),
    otp_max_tries:                  String(config.otpMaxTries),
    otp_lockout_seconds:            String(config.otpLockoutSeconds),
    mail_transport:                 config.mailTransport,
    mailgun_api_key:                config.mailgun.apiKey,
    mailgun_domain:                 config.mailgun.domain,
    smtp_relay_host:                config.smtpRelay.host,
    smtp_relay_port:                String(config.smtpRelay.port),
    smtp_relay_user:                config.smtpRelay.user,
    smtp_relay_pass:                config.smtpRelay.pass,
    gmail_client_id:                config.gmail.clientId,
    gmail_client_secret:            config.gmail.clientSecret,
    gmail_refresh_token:            config.gmail.refreshToken,
    gmail_user:                     config.gmail.user,
    upload_max_size_mb:             String(config.uploadMaxSizeMb),
    upload_allowed_extensions:      config.uploadAllowedExtensions,
    upload_blocked_extensions:      config.uploadBlockedExtensions,
    email_rate_limit_per_ticket:    String(config.emailRateLimitPerTicket),
    email_rate_limit_new_tickets:   String(config.emailRateLimitNewTickets),
    reminder_count:                 '1',
    reminder_frequency_hours:       '24',
    notify_email_submitter:         'true',
    enable_billable_hours:          'true',
    enable_location:                'true',
  };
  for (const [key, val] of Object.entries(seedDefaults)) {
    if (val !== null && val !== undefined) seedSetting(key, val);
  }

  // Apply DB settings on top of config (DB values win over .env).
  config.applySettings(getAllSettings());

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[HTTP] Listening on port ${config.port} (${process.env.NODE_ENV || 'development'})`);
  });

  // Prevent keep-alive race condition: mobile browsers reuse idle TCP connections
  // more aggressively than desktop. If Node closes a connection (default 5s timeout)
  // just as the browser reuses it, the request hangs until TCP timeout (~30-90s on
  // mobile). Setting a long keepAliveTimeout avoids this entirely.
  server.keepAliveTimeout = 65000; // ms — keep connections alive for 65s
  server.headersTimeout   = 66000; // must be slightly > keepAliveTimeout

  startSMTPServer();

  // Due-date reminders — check every hour
  setInterval(async () => {
    try {
      const reminderCount = parseInt(getSetting('reminder_count') || '1', 10);
      const freqHours     = parseFloat(getSetting('reminder_frequency_hours') || '24');
      if (reminderCount < 1 || !(freqHours > 0)) return;

      const freqSecs   = Math.round(freqHours * 3600);
      const cronWindow = 3600; // 1-hour window matches cron interval
      const now        = Math.floor(Date.now() / 1000);

      // Group rows by ticket (one row per admin/tech party)
      const rowMap = new Map();
      for (const row of getTicketsForReminders()) {
        if (!rowMap.has(row.id)) rowMap.set(row.id, { ...row, emails: [] });
        rowMap.get(row.id).emails.push(row.party_email);
      }

      for (const t of rowMap.values()) {
        for (let slot = t.reminders_sent; slot < reminderCount; slot++) {
          const sendTime  = t.due_date - (reminderCount - slot) * freqSecs;
          if (sendTime > now) break; // this and all later slots are in the future

          const overdueBy = now - sendTime;
          if (overdueBy <= cronWindow && t.emails.length > 0) {
            // Within the cron window — send reminder to all admin/tech parties
            for (const email of t.emails) {
              await sendDueReminder(email, t).catch(console.error);
            }
            setTicketRemindersSent(t.id, slot + 1);
            break; // only one reminder per ticket per run
          } else {
            // Slot is in the past (or no eligible parties) — skip it, advance
            setTicketRemindersSent(t.id, slot + 1);
            t.reminders_sent = slot + 1;
          }
        }
      }
    } catch (err) {
      console.error('[Reminders] Error:', err);
    }
  }, 60 * 60 * 1000);
}

start().catch(err => {
  console.error('[App] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
