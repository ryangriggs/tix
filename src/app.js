'use strict';

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { requireAuth, requireAdmin, optionalAuth } = require('./middleware/auth');
const { startSMTPServer } = require('./smtp');
const sse = require('./services/sse');
const { initDb, getTicketsDueSoon } = require('./db');
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

  next();
});

// ============================================================
// Routes
// ============================================================
app.use('/auth', optionalAuth, require('./routes/auth'));
app.use('/tickets', requireAuth, require('./routes/tickets'));
app.use('/admin', requireAuth, requireAdmin, require('./routes/admin'));
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
  console.error('[App] Unhandled error:', err);
  res.status(500).render('error', { title: 'Error', message: 'An unexpected error occurred.' });
});

// ============================================================
// Start — DB must be ready before accepting requests
// ============================================================
async function start() {
  await initDb();

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[HTTP] Listening on port ${config.port} (${config.nodeEnv})`);
  });

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
