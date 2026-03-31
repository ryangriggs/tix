'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const db = require('../db');
const config = require('../config');
const { issueSessionCookie } = require('../middleware/auth');
const { resetMailTransport } = require('../services/mail');
const updater = require('../services/updater');
const backup  = require('../services/backup');
const audit   = require('../services/audit');

function maskSecret(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '***';
  return val.slice(0, 4) + '···' + val.slice(-4);
}

// GET /admin/users
router.get('/users', (req, res) => {
  const validSorts = ['name', 'email', 'role', 'organization_name', 'created_at'];
  const sort  = validSorts.includes(req.query.sort) ? req.query.sort : 'organization_name';
  const order = req.query.order === 'desc' ? 'desc' : 'asc';

  const users = db.getUsersSorted(sort, order);
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
    sort,
    order,
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
  const id         = parseInt(req.params.id, 10);
  const editTarget = db.getUserById(id);
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

  const notificationsMuted = req.body.notifications_muted === '1' ? 1 : 0;
  db.setUserNotificationsMuted(id, notificationsMuted);

  audit.log(req, `edited user ${editTarget?.email || id}`);
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
  audit.log(req, `added user ${email}`);
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
  const blockTarget = db.getUserById(id);
  db.blockUser(id);
  audit.log(req, `blocked user ${blockTarget?.email || id}`);
  res.redirect('/admin/users?message=User+blocked');
});

// POST /admin/users/:id/unblock
router.post('/users/:id/unblock', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const unblockTarget = db.getUserById(id);
  db.unblockUser(id);
  audit.log(req, `unblocked user ${unblockTarget?.email || id}`);
  res.redirect('/admin/users?message=User+unblocked');
});

// POST /admin/users/:id/delete
router.post('/users/:id/delete', (req, res) => {
  const id         = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.redirect('/admin/users?message=Cannot+delete+yourself');
  const delTarget  = db.getUserById(id);
  db.deleteUser(id);
  audit.log(req, `deleted user ${delTarget?.email || id}`);
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
  const renameOrg = db.getOrganizationById(id);
  db.renameOrganization(id, name);
  audit.log(req, `renamed organization "${renameOrg?.name || id}" to "${name}"`);
  res.redirect('/admin/organizations?message=Organization+renamed');
});

// POST /admin/organizations/:id/delete
router.post('/organizations/:id/delete', (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const delOrg  = db.getOrganizationById(id);
  db.deleteOrganization(id);
  audit.log(req, `deleted organization "${delOrg?.name || id}"`);
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

// GET /admin/logs?tab=email|users|audit
router.get('/logs', (req, res) => {
  const validTabs = ['email', 'users', 'audit'];
  const tab = validTabs.includes(req.query.tab) ? req.query.tab : 'email';

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

  // Audit log
  let auditEntries = [];
  let auditTotal = 0;
  if (config.auditLog) {
    const { total, lines } = readLogFile(config.auditLog);
    auditTotal = total;
    auditEntries = lines.map(line => {
      const parts = line.split(' | ');
      const ts = Math.floor(Date.parse((parts[0] || '').replace(' ', 'T') + 'Z') / 1000) || 0;
      return {
        timestamp: parts[0] || '',
        ts,
        ip:       parts[1] || '',
        email:    parts[2] || '',
        ticket:   parts[3] || '',
        action:   parts[4] || '',
      };
    });
  }

  res.render('admin/logs', {
    title: 'Logs',
    tab,
    emailEntries, emailTotal, emailLogPath: config.emailLog || '',
    userEntries,  userTotal,  userLogPath:  config.userLog  || '',
    auditEntries, auditTotal, auditLogPath: config.auditLog || '',
  });
});

// GET /admin/settings
router.get('/settings', async (req, res) => {
  const s = db.getAllSettings();

  // Run a fresh update check on every settings page load so the displayed
  // result is never stale. Swallow errors — a failed check just shows the
  // last cached state rather than breaking the page.
  const repoUrl = s.update_repo_url || 'https://github.com/ryangriggs/tix.git';
  if (s.update_check_enabled !== 'false') {
    await updater.checkForUpdates(repoUrl).catch(() => {});
  }
  res.render('admin/settings', {
    title:   'Settings',
    s,
    infra: {
      PORT:       config.port,
      SMTP_PORT:  config.smtpPort,
      DATA_DIR:   config.dataDir,
      UPLOADS_DIR: config.uploadsDir,
      BACKUP_DIR: config.backupDir || '(not set)',
      EMAIL_LOG:  config.emailLog  || '(not set)',
      USER_LOG:   config.userLog   || '(not set)',
      AUDIT_LOG:  config.auditLog  || '(not set)',
    },
    backupStatus: (() => {
      let dbSizeMb = 0;
      try { dbSizeMb = Math.round(fs.statSync(path.join(config.dataDir, 'db.sqlite')).size / 1024 / 1024 * 10) / 10; } catch (_) {}
      return {
        dbSizeMb,
        dirSizeMb:   backup.getBackupDirSizeMb(),
        recentFiles: backup.getRecentBackups(5),
        lastBackupAt: db.getSetting('last_backup_at') || null,
        backupDir:   config.backupDir || '',
        dirExists:   !!(config.backupDir && fs.existsSync(config.backupDir)),
      };
    })(),
    message:     req.query.message || null,
    updateState: updater.getState(),
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
  if (mailTransport && !['mailgun', 'smtp', 'gmail', 'resend'].includes(mailTransport))
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
    mail_queue_delay_ms:            String(int('mail_queue_delay_ms', 0)),
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
    resend_api_key:                 trim('resend_api_key'),
    annotation_extensions:          trim('annotation_extensions'),
    upload_max_size_mb:             String(uploadMaxSizeMb),
    upload_allowed_extensions:      trim('upload_allowed_extensions'),
    upload_blocked_extensions:      trim('upload_blocked_extensions'),
    email_rate_limit_per_ticket:    String(rateLimitPerTicket),
    email_rate_limit_new_tickets:   String(rateLimitNew),
    reminder_count:                 String(reminderCount),
    reminder_frequency_hours:       String(reminderFreq),
    notify_email_submitter:         req.body.notify_email_submitter    === '1' ? 'true' : 'false',
    notify_email_status_change:     req.body.notify_email_status_change === '1' ? 'true' : 'false',
    enable_billable_hours:          req.body.enable_billable_hours     === '1' ? 'true' : 'false',
    enable_location:                req.body.enable_location           === '1' ? 'true' : 'false',
    update_check_enabled:           req.body.update_check_enabled      === '1' ? 'true' : 'false',
    update_repo_url:                trim('update_repo_url') || 'https://github.com/ryangriggs/tix.git',
    update_check_interval_hours:    String(Math.max(1, flt('update_check_interval_hours', 24))),
    backup_frequency_hours:         String(Math.max(0, int('backup_frequency_hours', 0))),
    backup_retention_days:          String(Math.max(0, int('backup_retention_days', 30))),
    inactivity_hours_urgent:        String(Math.max(0, flt('inactivity_hours_urgent', 0))),
    inactivity_hours_high:          String(Math.max(0, flt('inactivity_hours_high',   0))),
    inactivity_hours_medium:        String(Math.max(0, flt('inactivity_hours_medium', 0))),
    inactivity_hours_low:           String(Math.max(0, flt('inactivity_hours_low',    0))),
  };

  for (const [key, val] of Object.entries(updates)) {
    if (val !== null && val !== undefined) db.setSetting(key, val);
  }

  // Apply new settings to live config
  config.applySettings(updates);

  // Reset cached mail transport so new credentials take effect
  resetMailTransport();

  // Reset update timer with new settings (takes effect immediately)
  updater.resetTimer(
    updates.update_check_enabled === 'true',
    updates.update_repo_url,
    parseFloat(updates.update_check_interval_hours)
  );

  audit.log(req, 'changed Settings');
  res.redirect('/admin/settings?message=Settings+saved');
});

// ── Backup endpoints ─────────────────────────────────────────

// POST /admin/backup/now
router.post('/backup/now', async (req, res) => {
  try {
    const { filename } = await backup.createBackup();
    db.setSetting('last_backup_at',     String(Math.floor(Date.now() / 1000)));
    db.setSetting('last_backup_failed', 'false');
    const retDays = parseInt(db.getSetting('backup_retention_days') || '0', 10);
    if (retDays > 0) backup.purgeOldBackups(retDays);
    audit.log(req, 'created manual backup');
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/backup/download/:filename
router.get('/backup/download/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^backup-[\d-]+\.zip$/.test(filename)) return res.status(400).send('Invalid filename');
  if (!config.backupDir) return res.status(404).send('Backup directory not configured');
  const filePath = path.join(config.backupDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath, filename);
});

// ── Update endpoints ─────────────────────────────────────────

// POST /admin/update/check — immediate check, returns JSON
router.post('/update/check', async (req, res) => {
  try {
    const repoUrl = db.getSetting('update_repo_url') || 'https://github.com/ryangriggs/tix.git';
    const state = await updater.checkForUpdates(repoUrl);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/update/ping — liveness probe used by the install polling loop
router.get('/update/ping', (req, res) => res.json({ ok: true }));

// POST /admin/update/install — git reset + npm install + process.exit(0)
router.post('/update/install', async (req, res) => {
  if (config.backupDir) {
    try {
      await backup.createBackup();
      db.setSetting('last_backup_at',     String(Math.floor(Date.now() / 1000)));
      db.setSetting('last_backup_failed', 'false');
    } catch (err) {
      return res.status(500).json({ error: 'Pre-update backup failed: ' + err.message });
    }
  }
  res.json({ ok: true });
  setTimeout(() => {
    try { updater.installUpdate(); }
    catch (err) { console.error('[Updater] Install failed:', err.message); }
  }, 200);
});

// ── Server stats ─────────────────────────────────────────────

function dirSizeBytes(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else try { total += fs.statSync(full).size; } catch (_) {}
    }
  } catch (_) {}
  return total;
}

function toMb(bytes) { return Math.round(bytes / 1024 / 1024 * 10) / 10; }

// GET /admin/stats — on-demand server statistics
router.get('/stats', (req, res) => {
  // Ticket counts
  const tickets = db.getTicketCountsByStatus();

  // Attachment count + storage
  const attCount = db.getAttachmentCount();
  let attSizeMb = 0;
  if (fs.existsSync(config.uploadsDir)) {
    let total = 0;
    for (const f of fs.readdirSync(config.uploadsDir)) {
      try { total += fs.statSync(path.join(config.uploadsDir, f)).size; } catch (_) {}
    }
    attSizeMb = toMb(total);
  }

  // Database size
  let dbSizeMb = 0;
  try { dbSizeMb = toMb(fs.statSync(path.join(config.dataDir, 'db.sqlite')).size); } catch (_) {}

  // Log files total size
  let logBytes = 0;
  for (const p of [config.emailLog, config.userLog, config.auditLog].filter(Boolean)) {
    try { logBytes += fs.statSync(p).size; } catch (_) {}
  }
  const logSizeMb = toMb(logBytes);

  // App directory size (excluding node_modules and .git)
  const appSizeMb = toMb(dirSizeBytes(process.cwd()));

  // Email counts from log (timestamps are UTC ISO)
  let emailsSentToday = null;
  let emailsSentThisMonth = null;
  if (config.emailLog) {
    try {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);   // YYYY-MM-DD UTC
      const monthStr = now.toISOString().slice(0, 7);    // YYYY-MM UTC
      let today = 0, month = 0;
      const lines = fs.readFileSync(config.emailLog, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const ts = line.split(' | ')[0] || '';
        if (line.includes(' | [ERROR] ')) continue;  // skip errors
        if (ts.startsWith(monthStr)) { month++; if (ts.startsWith(todayStr)) today++; }
      }
      emailsSentToday = today;
      emailsSentThisMonth = month;
    } catch (_) {}
  }

  res.json({
    tickets,
    attachments: { count: attCount, sizeMb: attSizeMb },
    dbSizeMb,
    logSizeMb,
    appSizeMb,
    emailsSentToday,
    emailsSentThisMonth,
  });
});

module.exports = router;
