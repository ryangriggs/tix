'use strict';

const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const db = require('../db');
const config = require('../config');
const { issueSessionCookie } = require('../middleware/auth');

function maskSecret(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '***';
  return val.slice(0, 4) + '···' + val.slice(-4);
}

// GET /admin/users
router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  const organizations = db.getAllOrganizations();

  // Build techOrgMap: userId → [org, ...] for technician rows
  const techOrgMap = {};
  for (const u of users.filter(u => u.role === 'technician')) {
    techOrgMap[u.id] = db.getTechnicianOrganizations(u.id);
  }

  res.render('admin/users', {
    title: 'User Management',
    users,
    organizations,
    techOrgMap,
    message: req.query.message || null,
  });
});

// GET /admin/users/:id/tech-orgs — JSON for dialog
router.get('/users/:id/tech-orgs', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(db.getTechnicianOrganizations(id));
});

// POST /admin/users/:id/edit — combined property update from dialog
router.post('/users/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const role = req.body.role;
  const orgName = (req.body.organization_name || '').trim();
  const isSuperuser = req.body.is_group_superuser === '1' ? 1 : 0;

  db.updateUserName(id, name || null);

  if (role && ['admin', 'user', 'technician'].includes(role)) {
    if (id !== req.user.id) db.updateUserRole(id, role);
  }

  let orgId = null;
  if (orgName) {
    const org = db.findOrCreateOrganization(orgName);
    orgId = org ? org.id : null;
  }
  db.updateUserOrganization(id, orgId);

  const effectiveRole = role || (db.getUserById(id)?.role ?? 'user');
  if (effectiveRole === 'user') db.updateUserSuperuser(id, isSuperuser);

  if (id !== req.user.id) {
    const isActive = req.body.active === '1';
    if (isActive) db.unblockUser(id); else db.blockUser(id);
  }

  res.redirect('/admin/users?message=User+updated');
});

// POST /admin/users/:id/impersonate — sign in as another user
router.post('/users/:id/impersonate', (req, res) => {
  const target = db.getUserById(parseInt(req.params.id, 10));
  if (!target) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
  if (target.id === req.user.id) return res.redirect('/admin/users?message=Cannot+impersonate+yourself');
  if (target.blocked_at) return res.redirect('/admin/users?message=Cannot+impersonate+a+blocked+user');

  // Stash the current admin session so we can restore it later
  res.cookie('admin_session', req.cookies.session, {
    httpOnly: true,
    secure:   config.secureSession,
    maxAge:   8 * 60 * 60 * 1000, // 8-hour window
    sameSite: 'lax',
  });

  issueSessionCookie(res, target);
  res.redirect('/tickets');
});

// POST /admin/users/pre-add — must be before /:id routes
router.post('/users/pre-add', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const name  = (req.body.name  || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect('/admin/users?message=Invalid+email');
  }
  db.findOrCreateUser(email, name || null);
  res.redirect('/admin/users?message=User+added');
});

// POST /admin/users/:id/role
router.post('/users/:id/role', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = req.body.role;
  if (!['admin', 'user', 'technician'].includes(role)) return res.redirect('/admin/users');

  if (id === req.user.id && role !== 'admin') {
    return res.redirect('/admin/users?message=Cannot+remove+your+own+admin+role');
  }

  db.updateUserRole(id, role);
  res.redirect('/admin/users?message=Role+updated');
});

// POST /admin/users/:id/name
router.post('/users/:id/name', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  db.updateUserName(id, name || null);
  res.redirect('/admin/users?message=Name+updated');
});

// POST /admin/users/:id/organization
router.post('/users/:id/organization', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const orgName = (req.body.organization_name || '').trim();
  let orgId = null;
  if (orgName) {
    const org = db.findOrCreateOrganization(orgName);
    orgId = org ? org.id : null;
  }
  db.updateUserOrganization(id, orgId);
  res.redirect('/admin/users?message=Organization+updated');
});

// POST /admin/users/:id/superuser
router.post('/users/:id/superuser', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const val = req.body.is_group_superuser === '1' ? 1 : 0;
  db.updateUserSuperuser(id, val);
  res.redirect('/admin/users?message=Superuser+flag+updated');
});

// POST /admin/users/:id/tech-orgs/add
router.post('/users/:id/tech-orgs/add', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const orgName = (req.body.organization_name || '').trim();
  if (!orgName) return res.redirect('/admin/users');
  const org = db.findOrCreateOrganization(orgName);
  if (org) db.addTechnicianOrganization(id, org.id);
  res.redirect('/admin/users?message=Organization+assigned');
});

// POST /admin/users/:id/tech-orgs/remove
router.post('/users/:id/tech-orgs/remove', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const orgId = parseInt(req.body.organization_id, 10);
  if (orgId) db.removeTechnicianOrganization(id, orgId);
  res.redirect('/admin/users?message=Organization+removed');
});

// POST /admin/users/:id/block
router.post('/users/:id/block', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/admin/users?message=Cannot+block+yourself');
  db.blockUser(id);
  res.redirect('/admin/users?message=User+blocked');
});

// POST /admin/users/:id/unblock
router.post('/users/:id/unblock', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.unblockUser(id);
  res.redirect('/admin/users?message=User+unblocked');
});

// POST /admin/users/:id/delete
router.post('/users/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/admin/users?message=Cannot+delete+yourself');
  db.deleteUser(id);
  res.redirect('/admin/users?message=User+deleted');
});

// GET /admin/organizations
router.get('/organizations', (req, res) => {
  const organizations = db.getAllOrganizations();
  res.render('admin/organizations', {
    title: 'Organizations',
    organizations,
    message: req.query.message || null,
  });
});

// POST /admin/organizations/:id/rename
router.post('/organizations/:id/rename', (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  if (!name) return res.redirect('/admin/organizations?message=Name+required');
  db.renameOrganization(id, name);
  res.redirect('/admin/organizations?message=Organization+renamed');
});

// POST /admin/organizations/:id/delete
router.post('/organizations/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.deleteOrganization(id);
  res.redirect('/admin/organizations?message=Organization+deleted');
});

// Helper — read last N lines of a log file, newest first
function readLogFile(filePath, limit = 100) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    return { total: lines.length, lines: lines.slice(-limit).reverse() };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[Admin] Log read error:', err.message);
    return { total: 0, lines: [] };
  }
}

// GET /admin/logs?tab=email|users
router.get('/logs', (req, res) => {
  const tab = req.query.tab === 'users' ? 'users' : 'email';

  // Email log
  let emailEntries = [];
  let emailTotal = 0;
  if (config.emailLog) {
    const { total, lines } = readLogFile(config.emailLog);
    emailTotal = total;
    emailEntries = lines.map(line => {
      const parts = line.split(' | ');
      const isError = (parts[1] || '').startsWith('[ERROR] ');
      return {
        timestamp: parts[0] || '',
        isError,
        recipient: isError ? parts[1].slice(8) : (parts[1] || ''),
        subject:   parts[2] || '',
        error:     isError ? (parts[3] || '') : null,
      };
    });
  }

  // User log
  let userEntries = [];
  let userTotal = 0;
  if (config.userLog) {
    const { total, lines } = readLogFile(config.userLog);
    userTotal = total;
    userEntries = lines.map(line => {
      const parts = line.split(' | ');
      const isFailure = (parts[2] || '').startsWith('FAILED');
      return {
        timestamp: parts[0] || '',
        email:     parts[1] || '',
        status:    parts[2] || '',
        isFailure,
      };
    });
  }

  res.render('admin/logs', {
    title: 'Logs',
    tab,
    emailEntries, emailTotal, emailLogPath: config.emailLog || '',
    userEntries,  userTotal,  userLogPath:  config.userLog  || '',
  });
});

// GET /admin/settings
router.get('/settings', (req, res) => {
  const configDisplay = {
    application: { APP_URL: config.appUrl, TICKET_EMAIL: config.ticketEmail, PORT: config.port, SMTP_PORT: config.smtpPort, ADMIN_EMAIL: config.adminEmail || '(not set)' },
    security:    { JWT_SECRET: maskSecret(config.jwtSecret), OTP_MAX_TRIES: config.otpMaxTries, OTP_LOCKOUT_SECONDS: config.otpLockoutSeconds, SECURE_SESSION: config.secureSession },
    email:       { MAIL_TRANSPORT: config.mailTransport },
    mailgun:     { MAILGUN_API_KEY: maskSecret(config.mailgun.apiKey), MAILGUN_DOMAIN: config.mailgun.domain || '(not set)' },
    smtp:        { SMTP_RELAY_HOST: config.smtpRelay.host || '(not set)', SMTP_RELAY_PORT: config.smtpRelay.port, SMTP_RELAY_USER: config.smtpRelay.user || '(not set)', SMTP_RELAY_PASS: config.smtpRelay.pass ? '***' : '(not set)' },
    gmail:       { GMAIL_CLIENT_ID: maskSecret(config.gmail.clientId), GMAIL_CLIENT_SECRET: maskSecret(config.gmail.clientSecret), GMAIL_REFRESH_TOKEN: config.gmail.refreshToken ? 'Set ✓' : '(not set)', GMAIL_USER: config.gmail.user || '(not set)' },
    uploads:     { UPLOAD_ALLOWED_EXTENSIONS: config.uploadAllowedExtensions, UPLOAD_BLOCKED_EXTENSIONS: config.uploadBlockedExtensions || '(none)', EMAIL_RATE_LIMIT_PER_TICKET: config.emailRateLimitPerTicket, EMAIL_RATE_LIMIT_NEW_TICKETS: config.emailRateLimitNewTickets },
  };
  res.render('admin/settings', {
    title: 'Settings',
    siteName:       db.getSetting('site_name') ?? config.siteName,
    defaultAssignee: db.getSetting('default_assignee_email') ?? config.defaultAssigneeEmail ?? '',
    configDisplay,
    message: req.query.message || null,
  });
});

// POST /admin/settings
router.post('/settings', (req, res) => {
  const siteName = (req.body.site_name || '').trim();
  const email = (req.body.default_assignee_email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect('/admin/settings?message=Invalid+email+address');
  }
  if (siteName) db.setSetting('site_name', siteName);
  db.setSetting('default_assignee_email', email);
  res.redirect('/admin/settings?message=Settings+saved');
});

module.exports = router;
