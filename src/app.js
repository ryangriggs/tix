'use strict';

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { requireAuth, requireAdmin, optionalAuth, verifyCsrf } = require('./middleware/auth');
const { startSMTPServer } = require('./smtp');
const sse = require('./services/sse');
const { initDb, getTicketsDueSoon, getSetting } = require('./db');
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

  // Due-date reminder — check every hour
  setInterval(async () => {
    try {
      const due = getTicketsDueSoon(24);
      for (const row of due) {
        await sendDueReminder(row.party_email, row).catch(console.error);
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
