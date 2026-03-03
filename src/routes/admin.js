'use strict';

const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const db = require('../db');
const config = require('../config');
const { issueSessionCookie } = require('../middleware/auth');
const { resetMailTransport } = require('../services/mail');

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

// GET /admin/organizations/:id/json — org + locations for dialog
router.get('/organizations/:id/json', (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const org = db.getOrganizationById(id);
  if (!org) return res.status(404).json({ error: 'Not found' });
  res.json({ org, locations: db.getLocationsByOrg(id) });
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

// POST /admin/organizations/:id/locations/add
router.post('/organizations/:id/locations/add', (req, res) => {
  const orgId = parseInt(req.params.id, 10);
  const name  = (req.body.name || '').trim();
  const dist  = parseFloat(req.body.distance_miles) || 0;
  if (!name) return res.json({ error: 'Name is required' });
  const loc = db.createLocation(orgId, name, dist);
  if (!loc) return res.json({ error: 'Could not create location' });
  res.json(loc);
});

// POST /admin/organizations/:id/locations/:locId/update
router.post('/organizations/:id/locations/:locId/update', (req, res) => {
  const locId = parseInt(req.params.locId, 10);
  const name  = (req.body.name || '').trim();
  const dist  = parseFloat(req.body.distance_miles);
  db.updateLocation(locId, {
    ...(name                 ? { name }                          : {}),
    ...(!isNaN(dist)         ? { distance_miles: dist }          : {}),
  });
  res.json({ ok: true });
});

// POST /admin/organizations/:id/locations/:locId/delete
router.post('/organizations/:id/locations/:locId/delete', (req, res) => {
  const locId = parseInt(req.params.locId, 10);
  if (db.isLocationReferenced(locId))
    return res.json({ error: 'This location is used in one or more comments and cannot be deleted.' });
  db.deleteLocation(locId);
  res.json({ ok: true });
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
      const ts = Math.floor(Date.parse((parts[0] || '').replace(' ', 'T') + 'Z') / 1000) || 0;
      return {
        timestamp: parts[0] || '',
        ts,
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
      const ts = Math.floor(Date.parse((parts[0] || '').replace(' ', 'T') + 'Z') / 1000) || 0;
      return {
        timestamp: parts[0] || '',
        ts,
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
  const s = db.getAllSettings();
  res.render('admin/settings', {
    title:   'Settings',
    s,
    // Infrastructure (restart-required) — read-only display
    infra: {
      PORT:       config.port,
      SMTP_PORT:  config.smtpPort,
      DATA_DIR:   config.dataDir,
      UPLOADS_DIR: config.uploadsDir,
      EMAIL_LOG:  config.emailLog  || '(not set)',
      USER_LOG:   config.userLog   || '(not set)',
    },
    message: req.query.message || null,
  });
});

// POST /admin/settings
router.post('/settings', (req, res) => {
  const trim = k => (req.body[k] || '').trim();
  const int  = (k, def) => { const v = parseInt(req.body[k], 10); return isFinite(v) ? v : def; };
  const flt  = (k, def) => { const v = parseFloat(req.body[k]);   return isFinite(v) ? v : def; };

  // Validate emails
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const defaultAssignee = trim('default_assignee_email').toLowerCase();
  if (defaultAssignee && !emailRe.test(defaultAssignee))
    return res.redirect('/admin/settings?message=Invalid+default+assignee+email');
  const adminEmail = trim('admin_email').toLowerCase();
  if (adminEmail && !emailRe.test(adminEmail))
    return res.redirect('/admin/settings?message=Invalid+admin+email');
  const ticketEmail = trim('ticket_email').toLowerCase();
  if (ticketEmail && !emailRe.test(ticketEmail))
    return res.redirect('/admin/settings?message=Invalid+ticket+email');
  const gmailUser = trim('gmail_user').toLowerCase();
  if (gmailUser && !emailRe.test(gmailUser))
    return res.redirect('/admin/settings?message=Invalid+Gmail+user+email');

  // Validate numerics
  const reminderCount = int('reminder_count', 1);
  const reminderFreq  = flt('reminder_frequency_hours', 24);
  if (reminderCount < 0) return res.redirect('/admin/settings?message=Invalid+reminder+count');
  if (reminderFreq  <= 0) return res.redirect('/admin/settings?message=Invalid+reminder+frequency');
  const otpMaxTries       = int('otp_max_tries', 5);
  const otpLockout        = int('otp_lockout_seconds', 300);
  const rateLimitPerTicket = int('email_rate_limit_per_ticket', 10);
  const rateLimitNew      = int('email_rate_limit_new_tickets', 3);
  const uploadMaxSizeMb   = int('upload_max_size_mb', 25);
  if (uploadMaxSizeMb < 1) return res.redirect('/admin/settings?message=Upload+size+must+be+at+least+1+MB');
  const smtpRelayPort     = int('smtp_relay_port', 587);

  const mailTransport = trim('mail_transport');
  if (mailTransport && !['mailgun', 'smtp', 'gmail'].includes(mailTransport))
    return res.redirect('/admin/settings?message=Invalid+mail+transport');

  const updates = {
    app_url:                        trim('app_url').replace(/\/$/, ''),
    ticket_email:                   ticketEmail,
    ticket_silent_email:            trim('ticket_silent_email').toLowerCase(),
    ticket_prefix:                  trim('ticket_prefix'),
    mail_from_name:                 trim('mail_from_name'),
    admin_email:                    adminEmail,
    site_name:                      trim('site_name'),
    default_assignee_email:         defaultAssignee,
    jwt_secret:                     trim('jwt_secret'),
    secure_session:                 req.body.secure_session === '1' ? 'true' : 'false',
    otp_max_tries:                  String(otpMaxTries),
    otp_lockout_seconds:            String(otpLockout),
    mail_transport:                 mailTransport,
    mailgun_api_key:                trim('mailgun_api_key'),
    mailgun_domain:                 trim('mailgun_domain'),
    smtp_relay_host:                trim('smtp_relay_host'),
    smtp_relay_port:                String(smtpRelayPort),
    smtp_relay_user:                trim('smtp_relay_user'),
    smtp_relay_pass:                trim('smtp_relay_pass'),
    gmail_client_id:                trim('gmail_client_id'),
    gmail_client_secret:            trim('gmail_client_secret'),
    gmail_refresh_token:            trim('gmail_refresh_token'),
    gmail_user:                     gmailUser,
    upload_max_size_mb:             String(uploadMaxSizeMb),
    upload_allowed_extensions:      trim('upload_allowed_extensions'),
    upload_blocked_extensions:      trim('upload_blocked_extensions'),
    email_rate_limit_per_ticket:    String(rateLimitPerTicket),
    email_rate_limit_new_tickets:   String(rateLimitNew),
    reminder_count:                 String(reminderCount),
    reminder_frequency_hours:       String(reminderFreq),
    notify_email_submitter:         req.body.notify_email_submitter === '1' ? 'true' : 'false',
    enable_billable_hours:          req.body.enable_billable_hours  === '1' ? 'true' : 'false',
    enable_location:                req.body.enable_location         === '1' ? 'true' : 'false',
  };

  for (const [key, val] of Object.entries(updates)) {
    if (val !== null && val !== undefined) db.setSetting(key, val);
  }

  // Apply new settings to live config
  config.applySettings(updates);

  // Reset cached mail transport so new credentials take effect
  resetMailTransport();

  res.redirect('/admin/settings?message=Settings+saved');
});

module.exports = router;
