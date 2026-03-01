'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// Ensure data directories exist at require-time
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

const DB_PATH = path.join(config.dataDir, 'db.sqlite');

// Live sql.js database instance — set by initDb()
let _db = null;

// ============================================================
// sql.js wrapper — mimics better-sqlite3's synchronous API
// so all query functions below need no changes.
// ============================================================

function save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Returns an object with .get(), .all(), .run() — same as better-sqlite3
function prepare(sql) {
  return {
    get(...args) {
      const stmt = _db.prepare(sql);
      stmt.bind(args);
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },
    all(...args) {
      const stmt = _db.prepare(sql);
      stmt.bind(args);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    run(...args) {
      _db.run(sql, args);
      const stmt = _db.prepare('SELECT last_insert_rowid() AS id');
      stmt.step();
      const { id } = stmt.getAsObject();
      stmt.free();
      save();
      return { lastInsertRowid: id ?? null };
    },
  };
}

// Internal db object — same surface as better-sqlite3 for this module's use
const db = {
  prepare,
  exec(sql) { _db.exec(sql); save(); },
  pragma(str) {
    // WAL journal mode is for file-based SQLite; sql.js is in-memory so we skip it.
    // We still honour foreign_keys.
    if (str.toLowerCase().includes('foreign_keys')) {
      try { _db.run(`PRAGMA ${str}`); } catch (_) {}
    }
  },
};

// ============================================================
// Schema
// ============================================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    blocked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    otp TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    priority TEXT NOT NULL DEFAULT 'medium',
    due_date INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS ticket_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'collaborator',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(ticket_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    is_email INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    comment_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS email_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    direction TEXT NOT NULL DEFAULT 'out',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS technician_organizations (
    technician_id   INTEGER NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    PRIMARY KEY (technician_id, organization_id)
  );

  CREATE TABLE IF NOT EXISTS locations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    distance_miles  REAL    NOT NULL DEFAULT 0,
    UNIQUE(organization_id, name COLLATE NOCASE)
  );

  CREATE INDEX IF NOT EXISTS idx_tech_orgs_tech ON technician_organizations(technician_id);
  CREATE INDEX IF NOT EXISTS idx_tech_orgs_org  ON technician_organizations(organization_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_parties_ticket ON ticket_parties(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_parties_user   ON ticket_parties(user_id);
  CREATE INDEX IF NOT EXISTS idx_comments_ticket       ON comments(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_attachments_ticket    ON attachments(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_email_msg_id          ON email_messages(message_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_status        ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_updated       ON tickets(updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS ticket_fts USING fts4(
    text,
    tokenize=unicode61
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS comment_fts USING fts4(
    text,
    tokenize=unicode61
  );

  CREATE TRIGGER IF NOT EXISTS fts_ticket_ai
  AFTER INSERT ON tickets BEGIN
    INSERT INTO ticket_fts(rowid, text)
    VALUES (NEW.id, CAST(NEW.id AS TEXT) || ' ' || NEW.subject || ' ' || COALESCE(NEW.body, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS fts_ticket_au
  AFTER UPDATE OF subject, body ON tickets BEGIN
    DELETE FROM ticket_fts WHERE rowid = OLD.id;
    INSERT INTO ticket_fts(rowid, text)
    SELECT NEW.id,
      CAST(NEW.id AS TEXT) || ' ' || NEW.subject || ' ' || COALESCE(NEW.body, '') || ' ' ||
      COALESCE(u.name, '') || ' ' || COALESCE(u.email, '')
    FROM tickets t
    LEFT JOIN ticket_parties tp ON tp.ticket_id = NEW.id AND tp.role = 'submitter'
    LEFT JOIN users u ON u.id = tp.user_id
    WHERE t.id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS fts_ticket_ad
  BEFORE DELETE ON tickets BEGIN
    DELETE FROM comment_fts WHERE rowid IN (SELECT id FROM comments WHERE ticket_id = OLD.id);
    DELETE FROM ticket_fts WHERE rowid = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS fts_party_submitter_ai
  AFTER INSERT ON ticket_parties
  WHEN NEW.role = 'submitter' BEGIN
    DELETE FROM ticket_fts WHERE rowid = NEW.ticket_id;
    INSERT INTO ticket_fts(rowid, text)
    SELECT NEW.ticket_id,
      CAST(t.id AS TEXT) || ' ' || t.subject || ' ' || COALESCE(t.body, '') || ' ' ||
      COALESCE(u.name, '') || ' ' || COALESCE(u.email, '')
    FROM tickets t
    JOIN users u ON u.id = NEW.user_id
    WHERE t.id = NEW.ticket_id;
  END;

  CREATE TRIGGER IF NOT EXISTS fts_comment_ai
  AFTER INSERT ON comments BEGIN
    INSERT INTO comment_fts(rowid, text) VALUES (NEW.id, NEW.body);
  END;

  CREATE TRIGGER IF NOT EXISTS fts_comment_au
  AFTER UPDATE OF body ON comments BEGIN
    DELETE FROM comment_fts WHERE rowid = OLD.id;
    INSERT INTO comment_fts(rowid, text) VALUES (NEW.id, NEW.body);
  END;

  CREATE TRIGGER IF NOT EXISTS fts_comment_ad
  AFTER DELETE ON comments BEGIN
    DELETE FROM comment_fts WHERE rowid = OLD.id;
  END;
`;

// ============================================================
// Async initialisation — call once from app.js before starting servers
// ============================================================

async function initDb() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }

  _db.exec(SCHEMA);

  // Migrations — safe to run repeatedly (fail silently if column already exists)
  try { _db.exec('ALTER TABLE users ADD COLUMN name TEXT'); } catch (_) {}
  try { _db.exec('ALTER TABLE auth_tokens ADD COLUMN otp_tries INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { _db.exec('ALTER TABLE auth_tokens ADD COLUMN locked_until INTEGER'); } catch (_) {}
  try { _db.exec('ALTER TABLE tickets ADD COLUMN reply_token TEXT'); } catch (_) {}
  try { _db.exec('ALTER TABLE users   ADD COLUMN organization_id    INTEGER REFERENCES organizations(id) ON DELETE SET NULL'); } catch (_) {}
  try { _db.exec('ALTER TABLE users   ADD COLUMN is_group_superuser INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { _db.exec('ALTER TABLE tickets ADD COLUMN organization_id    INTEGER REFERENCES organizations(id) ON DELETE SET NULL'); } catch (_) {}
  try { _db.exec('ALTER TABLE tickets  ADD COLUMN close_date      INTEGER'); } catch (_) {}
  try { _db.exec('ALTER TABLE comments ADD COLUMN billable_hours  REAL'); } catch (_) {}
  try { _db.exec('ALTER TABLE comments DROP COLUMN work_type'); } catch (_) {}
  try { _db.exec('ALTER TABLE tickets  ADD COLUMN reminders_sent  INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  try { _db.exec('ALTER TABLE comments ADD COLUMN location_id     INTEGER REFERENCES locations(id)'); } catch (_) {}
  _db.exec('CREATE INDEX IF NOT EXISTS idx_comments_location ON comments(location_id)');
  // Back-fill close_date for tickets closed before this column existed
  _db.exec(`UPDATE tickets SET close_date = updated_at WHERE status = 'closed' AND close_date IS NULL`);
  _db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(organization_id)');
  _db.exec('CREATE INDEX IF NOT EXISTS idx_users_org   ON users(organization_id)');
  // Back-fill reply tokens for any existing tickets that pre-date this migration
  _db.exec(`UPDATE tickets SET reply_token = lower(hex(randomblob(16))) WHERE reply_token IS NULL`);
  _db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_reply_token ON tickets(reply_token)');

  // One-time FTS population for existing data (new installs have nothing to populate)
  const ftsMigrated = prepare('SELECT value FROM settings WHERE key = ?').get('fts_migrated');
  if (!ftsMigrated) {
    _db.exec(`
      INSERT INTO ticket_fts(rowid, text)
      SELECT t.id,
        CAST(t.id AS TEXT) || ' ' || t.subject || ' ' || COALESCE(t.body, '') || ' ' ||
        COALESCE(u.name, '') || ' ' || COALESCE(u.email, '')
      FROM tickets t
      LEFT JOIN ticket_parties tp ON tp.ticket_id = t.id AND tp.role = 'submitter'
      LEFT JOIN users u ON u.id = tp.user_id;

      INSERT INTO comment_fts(rowid, text)
      SELECT id, body FROM comments;

      INSERT OR REPLACE INTO settings (key, value) VALUES ('fts_migrated', '1');
    `);
    save();
    console.log('[DB] FTS index populated');
  }

  save();
  console.log('[DB] SQLite ready:', DB_PATH);
}

// ============================================================
// Users
// ============================================================

function findOrCreateUser(email, name = null) {
  const normalised = email.trim().toLowerCase();
  const cleanName = name && name.trim() ? name.trim() : null;

  let user = prepare('SELECT * FROM users WHERE email = ?').get(normalised);
  if (user) {
    // Update name if we have a better one (non-empty, different from what's stored)
    if (cleanName && cleanName !== user.name) {
      prepare('UPDATE users SET name = ? WHERE id = ?').run(cleanName, user.id);
      user = prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }
    return user;
  }

  const isFirstUser = prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  const isAdminEmail = config.adminEmail &&
    normalised === config.adminEmail.trim().toLowerCase();
  const role = (isFirstUser || isAdminEmail) ? 'admin' : 'user';

  const result = prepare('INSERT INTO users (email, role, name) VALUES (?, ?, ?)').run(normalised, role, cleanName);
  return prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

function updateUserName(id, name) {
  prepare('UPDATE users SET name = ? WHERE id = ?').run(name || null, id);
}

function getUserById(id) {
  return prepare('SELECT u.*, o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?').get(id);
}

function getUserByEmail(email) {
  return prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
}

function getAllUsers() {
  return prepare('SELECT u.*, o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id = u.organization_id ORDER BY u.created_at DESC').all();
}

function getAssignableUsers() {
  return prepare(`
    SELECT u.id, u.email, u.name, o.name AS organization_name
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE u.role IN ('admin', 'technician') AND u.blocked_at IS NULL
    ORDER BY COALESCE(NULLIF(u.name, ''), u.email) ASC
  `).all();
}

function updateUserOrganization(userId, orgId) {
  prepare('UPDATE users SET organization_id = ? WHERE id = ?').run(orgId || null, userId);
}

function updateUserSuperuser(userId, val) {
  prepare('UPDATE users SET is_group_superuser = ? WHERE id = ?').run(val ? 1 : 0, userId);
}

function searchUsers(q, scopeOrgId = null) {
  const like = `%${q}%`;
  let sql = `
    SELECT u.id, u.email, u.name, u.role, u.organization_id, o.name AS organization_name
    FROM users u LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE (u.name LIKE ? OR u.email LIKE ? OR o.name LIKE ?) AND u.blocked_at IS NULL
  `;
  const params = [like, like, like];
  if (scopeOrgId != null) { sql += ' AND u.organization_id = ?'; params.push(scopeOrgId); }
  sql += ' ORDER BY u.name ASC, u.email ASC LIMIT 20';
  return prepare(sql).all(...params);
}

function updateUserRole(id, role) {
  prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

function blockUser(id) {
  prepare('UPDATE users SET blocked_at = unixepoch() WHERE id = ?').run(id);
}

function unblockUser(id) {
  prepare('UPDATE users SET blocked_at = NULL WHERE id = ?').run(id);
}

function deleteUser(id) {
  prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ============================================================
// Auth tokens
// ============================================================

function createAuthToken(userId, otp) {
  const tokenId = uuidv4();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

  prepare(`
    INSERT INTO auth_tokens (id, user_id, token_hash, otp, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenId, userId, tokenHash, otp, expiresAt);

  return { tokenId, rawToken };
}

function verifyAuthToken(tokenId, rawToken) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = Math.floor(Date.now() / 1000);

  const record = prepare(`
    SELECT * FROM auth_tokens
    WHERE id = ? AND token_hash = ? AND expires_at > ? AND used_at IS NULL
  `).get(tokenId, tokenHash, now);

  if (!record) return null;
  prepare('UPDATE auth_tokens SET used_at = unixepoch() WHERE id = ?').run(tokenId);
  return record;
}

function getAuthTokenEmail(tokenId) {
  const row = prepare(
    'SELECT u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?'
  ).get(tokenId);
  return row ? row.email : null;
}

// Returns: a token record on success; { locked, lockedUntil } on lockout; null on wrong OTP.
function verifyOTPByTokenId(tokenId, otp) {
  const now = Math.floor(Date.now() / 1000);

  // Fetch the record first without checking the OTP, so we can track attempts
  const record = prepare(`
    SELECT * FROM auth_tokens
    WHERE id = ? AND expires_at > ? AND used_at IS NULL
  `).get(tokenId, now);

  if (!record) return null;

  // Enforce lockout before checking the OTP
  if (record.locked_until && record.locked_until > now) {
    return { locked: true, lockedUntil: record.locked_until };
  }

  if (record.otp !== otp.trim()) {
    const tries = (record.otp_tries || 0) + 1;
    if (tries >= config.otpMaxTries) {
      const lockedUntil = now + config.otpLockoutSeconds;
      prepare('UPDATE auth_tokens SET otp_tries = ?, locked_until = ? WHERE id = ?')
        .run(tries, lockedUntil, tokenId);
      return { locked: true, lockedUntil };
    }
    prepare('UPDATE auth_tokens SET otp_tries = ? WHERE id = ?').run(tries, tokenId);
    return null;
  }

  prepare('UPDATE auth_tokens SET used_at = unixepoch() WHERE id = ?').run(tokenId);
  return record;
}

// ============================================================
// Tickets
// ============================================================

function createTicket({ subject, body, priority = 'medium', dueDate = null, organizationId = null }) {
  const replyToken = uuidv4().replace(/-/g, '');
  const result = prepare(`
    INSERT INTO tickets (subject, body, status, priority, due_date, reply_token, organization_id)
    VALUES (?, ?, 'new', ?, ?, ?, ?)
  `).run(subject, body, priority, dueDate, replyToken, organizationId || null);
  return prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);
}

function getTicketById(id) {
  return prepare(`
    SELECT t.*, o.name AS organization_name,
      (SELECT COALESCE(SUM(c.billable_hours), 0) FROM comments c WHERE c.ticket_id = t.id) AS total_billable_hours
    FROM tickets t LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.id = ?
  `).get(id);
}

function updateTicket(id, fields) {
  const allowed = ['subject', 'body', 'status', 'priority', 'due_date', 'organization_id', 'close_date'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return;

  const sets = [...keys.map(k => `${k} = ?`), 'updated_at = unixepoch()'];
  const values = [...keys.map(k => fields[k]), id];
  prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function getDistinctOwners({ userRole, userId, userTechOrgIds = [] }) {
  let query = `
    SELECT DISTINCT u.id, u.email, u.name, o.name AS organization_name
    FROM ticket_parties tp
    JOIN users u ON u.id = tp.user_id
    LEFT JOIN organizations o ON o.id = u.organization_id
    JOIN tickets t ON t.id = tp.ticket_id
    WHERE tp.role = 'owner'
  `;
  const params = [];
  if (userRole !== 'admin') {
    const ph = userTechOrgIds.length ? userTechOrgIds.map(() => '?').join(',') : 'NULL';
    query += ` AND (t.organization_id IN (${ph}) OR EXISTS (
      SELECT 1 FROM ticket_parties tp2 WHERE tp2.ticket_id = t.id AND tp2.user_id = ?
    ))`;
    params.push(...userTechOrgIds, userId);
  }
  query += ` ORDER BY COALESCE(NULLIF(u.name, ''), u.email) ASC`;
  return prepare(query).all(...params);
}

function getTickets({ userId, userRole, userOrgId, userIsSuperuser, userTechOrgIds = [],
                      status, priority, sort = 'updated_at', order = 'desc', search = '',
                      dateFrom = null, dateTo = null, orgFilter = null, idSearch = null,
                      ownerFilter = null }) {
  const validSorts = {
    created_at:    't.created_at',
    updated_at:    't.updated_at',
    due_date:      't.due_date',
    priority:      "CASE t.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END",
    status:        "CASE t.status WHEN 'new' THEN 4 WHEN 'open' THEN 3 WHEN 'on_hold' THEN 2 WHEN 'closed' THEN 1 ELSE 0 END",
    comment_count: 'comment_count',
    id:            't.id',
    subject:       't.subject',
    submitter:     'submitter_name',
    organization:  'organization_name',
  };
  const sortCol   = validSorts[sort] || 't.updated_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

  let query = `
    SELECT DISTINCT t.*,
      (SELECT o.name FROM organizations o WHERE o.id = t.organization_id) AS organization_name,
      (SELECT COUNT(*) FROM comments WHERE ticket_id = t.id) AS comment_count,
      (SELECT u.email FROM ticket_parties tp2
         JOIN users u ON u.id = tp2.user_id
         WHERE tp2.ticket_id = t.id AND tp2.role = 'submitter'
         LIMIT 1) AS submitter_email,
      (SELECT u.name FROM ticket_parties tp2
         JOIN users u ON u.id = tp2.user_id
         WHERE tp2.ticket_id = t.id AND tp2.role = 'submitter'
         LIMIT 1) AS submitter_name,
      (SELECT COALESCE(NULLIF(u.name, ''), u.email)
         FROM comments c JOIN users u ON u.id = c.user_id
         WHERE c.ticket_id = t.id
         ORDER BY c.created_at DESC LIMIT 1) AS last_actor,
      (SELECT u.email
         FROM comments c JOIN users u ON u.id = c.user_id
         WHERE c.ticket_id = t.id
         ORDER BY c.created_at DESC LIMIT 1) AS last_actor_email
    FROM tickets t
  `;

  const conditions = [];
  const params = [];

  if (userRole === 'admin') {
    // no restriction
  } else if (userRole === 'technician') {
    const ph = userTechOrgIds.length ? userTechOrgIds.map(() => '?').join(',') : 'NULL';
    conditions.push(`(t.organization_id IN (${ph}) OR EXISTS (SELECT 1 FROM ticket_parties tp2 WHERE tp2.ticket_id = t.id AND tp2.user_id = ?))`);
    params.push(...userTechOrgIds, userId);
  } else if (userIsSuperuser && userOrgId) {
    const allOrgIds = [userOrgId, ...userTechOrgIds.filter(id => id !== userOrgId)];
    const ph = allOrgIds.map(() => '?').join(',');
    conditions.push(`(t.organization_id IN (${ph}) OR EXISTS (SELECT 1 FROM ticket_parties tp2 WHERE tp2.ticket_id = t.id AND tp2.user_id = ?))`);
    params.push(...allOrgIds, userId);
  } else {
    query += ' JOIN ticket_parties tp ON t.id = tp.ticket_id';
    conditions.push('tp.user_id = ?');
    params.push(userId);
  }

  if (orgFilter === -1) { conditions.push('t.organization_id IS NULL'); }
  else if (orgFilter)  { conditions.push('t.organization_id = ?'); params.push(orgFilter); }
  if (status && status.length) {
    const ph = status.map(() => '?').join(',');
    conditions.push(`t.status IN (${ph})`);
    params.push(...status);
  }
  if (priority && priority.length) {
    const ph = priority.map(() => '?').join(',');
    conditions.push(`t.priority IN (${ph})`);
    params.push(...priority);
  }
  if (dateFrom)  { conditions.push('t.updated_at >= ?');     params.push(dateFrom); }
  if (dateTo)    { conditions.push('t.updated_at <= ?');     params.push(dateTo); }
  if (idSearch)  { conditions.push('t.id = ?');              params.push(idSearch); }
  if (ownerFilter === 'me') {
    conditions.push('EXISTS (SELECT 1 FROM ticket_parties tp_o WHERE tp_o.ticket_id = t.id AND tp_o.role = \'owner\' AND tp_o.user_id = ?)');
    params.push(userId);
  } else if (ownerFilter === 'unassigned') {
    conditions.push('NOT EXISTS (SELECT 1 FROM ticket_parties tp_o WHERE tp_o.ticket_id = t.id AND tp_o.role = \'owner\')');
  } else if (typeof ownerFilter === 'number') {
    conditions.push('EXISTS (SELECT 1 FROM ticket_parties tp_o WHERE tp_o.ticket_id = t.id AND tp_o.role = \'owner\' AND tp_o.user_id = ?)');
    params.push(ownerFilter);
  }
  if (search && !idSearch) {
    // Build an FTS4 MATCH query: each whitespace-delimited token becomes a prefix search.
    // e.g. "john smith" → `john* smith*`  (both tokens must appear, prefix-matched)
    const ftsQuery = search.trim().split(/\s+/).filter(Boolean)
      .map(t => `${t.replace(/['"*:]/g, '')}*`).join(' ');
    conditions.push(`(t.id IN (
      SELECT rowid FROM ticket_fts WHERE ticket_fts MATCH ?
      UNION
      SELECT c.ticket_id FROM comments c
      WHERE c.id IN (SELECT rowid FROM comment_fts WHERE comment_fts MATCH ?)
    ) OR EXISTS (
      SELECT 1 FROM organizations o WHERE o.id = t.organization_id AND o.name LIKE ?
    ))`);
    params.push(ftsQuery, ftsQuery, `%${search}%`);
  }

  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY CASE t.status WHEN 'new' THEN 0 ELSE 1 END ASC, ${sortCol} ${sortOrder}`;

  return prepare(query).all(...params);
}

function deleteTicket(id) {
  prepare('DELETE FROM tickets WHERE id = ?').run(id);
}

function bulkDeleteTickets(ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  prepare(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ids);
}

function bulkUpdateStatus(ids, status) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  prepare(`UPDATE tickets SET status = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`).run(status, ...ids);
}

function bulkUpdatePriority(ids, priority) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  prepare(`UPDATE tickets SET priority = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`).run(priority, ...ids);
}

// ============================================================
// Ticket parties
// ============================================================

function addParty(ticketId, userId, role = 'collaborator') {
  prepare(`
    INSERT INTO ticket_parties (ticket_id, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(ticket_id, user_id) DO UPDATE SET role = excluded.role
  `).run(ticketId, userId, role);
}

function removeParty(ticketId, userId) {
  prepare('DELETE FROM ticket_parties WHERE ticket_id = ? AND user_id = ?').run(ticketId, userId);
}

function getParties(ticketId) {
  return prepare(`
    SELECT tp.*, u.email, u.name, u.role AS user_role, o.name AS organization_name
    FROM ticket_parties tp
    JOIN users u ON tp.user_id = u.id
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE tp.ticket_id = ?
    ORDER BY tp.created_at ASC
  `).all(ticketId);
}

function getUserTicketRole(ticketId, userId) {
  const row = prepare('SELECT role FROM ticket_parties WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId);
  return row ? row.role : null;
}

function getPartyUserIds(ticketId) {
  return prepare('SELECT user_id FROM ticket_parties WHERE ticket_id = ?')
    .all(ticketId).map(r => r.user_id);
}

// ============================================================
// Comments
// ============================================================

function addComment(ticketId, userId, body, isEmail = false, billableHours = null, locationId = null) {
  const result = prepare(`
    INSERT INTO comments (ticket_id, user_id, body, is_email, billable_hours, location_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(ticketId, userId, body, isEmail ? 1 : 0, billableHours || null, locationId || null);
  prepare('UPDATE tickets SET updated_at = unixepoch() WHERE id = ?').run(ticketId);
  return prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);
}

function deleteComment(id) {
  prepare('DELETE FROM comments WHERE id = ?').run(id);
}

function getComments(ticketId) {
  return prepare(`
    SELECT c.*, u.email AS user_email, u.name AS user_name,
           l.name AS location_name, l.distance_miles AS location_distance
    FROM comments c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN locations l ON l.id = c.location_id
    WHERE c.ticket_id = ?
    ORDER BY c.created_at DESC
  `).all(ticketId);
}

// ============================================================
// Attachments
// ============================================================

function addAttachment({ ticketId, commentId = null, originalName, storedName, mimeType, size }) {
  const result = prepare(`
    INSERT INTO attachments (ticket_id, comment_id, original_name, stored_name, mime_type, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ticketId, commentId, originalName, storedName, mimeType, size);
  return prepare('SELECT * FROM attachments WHERE id = ?').get(result.lastInsertRowid);
}

function getAttachments(ticketId) {
  return prepare(`
    SELECT a.*,
      COALESCE(NULLIF(u.name, ''), u.email) AS uploader_name
    FROM attachments a
    LEFT JOIN comments c ON c.id = a.comment_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE a.ticket_id = ?
    ORDER BY a.created_at ASC
  `).all(ticketId);
}

function getAttachmentsByComment(commentId) {
  return prepare('SELECT * FROM attachments WHERE comment_id = ?').all(commentId);
}

function getAttachmentByStoredName(storedName) {
  return prepare('SELECT * FROM attachments WHERE stored_name = ?').get(storedName);
}

function deleteAttachment(storedName) {
  prepare('DELETE FROM attachments WHERE stored_name = ?').run(storedName);
}

// ============================================================
// Email message tracking
// ============================================================

function recordEmailMessage(ticketId, messageId, direction) {
  try {
    prepare(`
      INSERT INTO email_messages (ticket_id, message_id, direction) VALUES (?, ?, ?)
    `).run(ticketId, messageId, direction);
  } catch (_) { /* ignore duplicate message_id */ }
}

function findTicketByMessageId(messageId) {
  const row = prepare('SELECT ticket_id FROM email_messages WHERE message_id = ?').get(messageId);
  return row ? row.ticket_id : null;
}

function findTicketByReplyToken(token) {
  if (!token) return null;
  const row = prepare('SELECT id FROM tickets WHERE reply_token = ?').get(token);
  return row ? row.id : null;
}

// ============================================================
// Settings
// ============================================================

function getSetting(key) {
  const row = prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function seedSetting(key, value) {
  if (value === null || value === undefined) return;
  prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = prepare(
    "SELECT key, value FROM settings WHERE key NOT LIKE 'user_prefs_%' AND key != 'fts_migrated'"
  ).all();
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

function getUserPrefs(userId) {
  const raw = getSetting(`user_prefs_${userId}`);
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

function setUserPrefs(userId, prefs) {
  setSetting(`user_prefs_${userId}`, JSON.stringify(prefs));
}

// ============================================================
// Organizations
// ============================================================

function findOrCreateOrganization(name) {
  const t = (name || '').trim();
  if (!t) return null;
  let o = prepare('SELECT * FROM organizations WHERE name = ?').get(t);
  if (!o) {
    const r = prepare('INSERT INTO organizations (name) VALUES (?)').run(t);
    o = prepare('SELECT * FROM organizations WHERE id = ?').get(r.lastInsertRowid);
  }
  return o;
}

function getAllOrganizations() {
  return prepare('SELECT * FROM organizations ORDER BY name ASC').all();
}

function getOrganizationsByIds(ids) {
  if (!ids || !ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return prepare(`SELECT * FROM organizations WHERE id IN (${ph}) ORDER BY name ASC`).all(...ids);
}

function searchOrganizations(q) {
  return prepare('SELECT * FROM organizations WHERE name LIKE ? ORDER BY name ASC LIMIT 20').all(`%${q}%`);
}

function renameOrganization(id, name) {
  prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name.trim(), id);
}

function deleteOrganization(id) {
  prepare('DELETE FROM organizations WHERE id = ?').run(id);
}

function getOrganizationById(id) {
  return prepare('SELECT * FROM organizations WHERE id = ?').get(id);
}

// ============================================================
// Locations
// ============================================================

function getLocationsByOrg(orgId) {
  return prepare('SELECT * FROM locations WHERE organization_id = ? ORDER BY name ASC').all(orgId);
}

function getLocationById(id) {
  return prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

function createLocation(orgId, name, distance_miles = 0) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  try {
    const r = prepare(
      'INSERT INTO locations (organization_id, name, distance_miles) VALUES (?, ?, ?)'
    ).run(orgId, trimmed, distance_miles || 0);
    return prepare('SELECT * FROM locations WHERE id = ?').get(r.lastInsertRowid);
  } catch (_) {
    return prepare(
      'SELECT * FROM locations WHERE organization_id = ? AND name = ? COLLATE NOCASE'
    ).get(orgId, trimmed);
  }
}

function findOrCreateLocation(orgId, name) {
  return createLocation(orgId, name, 0);
}

function updateLocation(id, { name, distance_miles } = {}) {
  if (name !== undefined) prepare('UPDATE locations SET name = ? WHERE id = ?').run((name || '').trim(), id);
  if (distance_miles !== undefined) prepare('UPDATE locations SET distance_miles = ? WHERE id = ?').run(distance_miles, id);
}

function isLocationReferenced(id) {
  return prepare('SELECT COUNT(*) AS cnt FROM comments WHERE location_id = ?').get(id).cnt > 0;
}

function deleteLocation(id) {
  prepare('DELETE FROM locations WHERE id = ?').run(id);
}

function getTravelReport(fromTs, toTs) {
  return prepare(`
    SELECT o.name AS organization_name,
           l.name AS location_name,
           l.distance_miles,
           COUNT(*) AS visit_count
    FROM comments c
    JOIN locations l ON l.id = c.location_id
    JOIN tickets t ON t.id = c.ticket_id
    LEFT JOIN organizations o ON o.id = l.organization_id
    WHERE c.location_id IS NOT NULL
      AND c.created_at >= ? AND c.created_at <= ?
    GROUP BY l.id
    ORDER BY o.name ASC, l.name ASC
  `).all(fromTs, toTs);
}

// ============================================================
// Technician org assignments
// ============================================================

function getTechnicianOrganizations(techId) {
  return prepare(`
    SELECT o.* FROM technician_organizations t
    JOIN organizations o ON o.id = t.organization_id
    WHERE t.technician_id = ? ORDER BY o.name ASC
  `).all(techId);
}

function addTechnicianOrganization(techId, orgId) {
  try { prepare('INSERT INTO technician_organizations (technician_id, organization_id) VALUES (?, ?)').run(techId, orgId); } catch (_) {}
}

function removeTechnicianOrganization(techId, orgId) {
  prepare('DELETE FROM technician_organizations WHERE technician_id = ? AND organization_id = ?').run(techId, orgId);
}

// ============================================================
// Due-date reminders
// ============================================================

function getTicketsDueSoon(withinHours = 24) {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now + withinHours * 3600;
  return prepare(`
    SELECT t.*, u.email AS party_email
    FROM tickets t
    JOIN ticket_parties tp ON tp.ticket_id = t.id
    JOIN users u ON u.id = tp.user_id
    WHERE t.status NOT IN ('closed')
      AND t.due_date IS NOT NULL
      AND t.due_date BETWEEN ? AND ?
      AND (tp.role = 'owner' OR tp.role = 'submitter')
  `).all(now, cutoff);
}

function getBillingReport(fromTs, toTs) {
  return prepare(`
    SELECT t.id, t.subject, t.created_at, t.close_date,
           o.name AS organization_name,
           COALESCE(SUM(c.billable_hours), 0) AS total_hours
    FROM tickets t
    LEFT JOIN organizations o ON o.id = t.organization_id
    LEFT JOIN comments c ON c.ticket_id = t.id
    WHERE t.status = 'closed'
      AND t.close_date IS NOT NULL
      AND t.close_date >= ? AND t.close_date <= ?
    GROUP BY t.id
    HAVING COALESCE(SUM(c.billable_hours), 0) > 0
    ORDER BY t.close_date ASC
  `).all(fromTs, toTs);
}

function getTicketsForReminders() {
  return prepare(`
    SELECT t.id, t.subject, t.due_date, t.reply_token, t.reminders_sent,
           u.email AS party_email
    FROM tickets t
    JOIN ticket_parties tp ON tp.ticket_id = t.id AND (tp.role = 'owner' OR tp.role = 'submitter')
    JOIN users u ON u.id = tp.user_id AND (u.role = 'admin' OR u.role = 'technician')
    WHERE t.status NOT IN ('closed')
      AND t.due_date IS NOT NULL
    ORDER BY t.id ASC
  `).all();
}

function setTicketRemindersSent(ticketId, count) {
  prepare('UPDATE tickets SET reminders_sent = ? WHERE id = ?').run(count, ticketId);
}

module.exports = {
  initDb,
  // Users
  findOrCreateUser, getUserById, getUserByEmail, getAllUsers, getAssignableUsers,
  updateUserRole, updateUserName, blockUser, unblockUser, deleteUser,
  updateUserOrganization, updateUserSuperuser, searchUsers,
  // Auth
  createAuthToken, verifyAuthToken, verifyOTPByTokenId, getAuthTokenEmail,
  // Tickets
  createTicket, getTicketById, updateTicket, getTickets,
  deleteTicket, bulkDeleteTickets, bulkUpdateStatus, bulkUpdatePriority,
  // Parties
  addParty, removeParty, getParties, getUserTicketRole, getPartyUserIds,
  // Comments
  addComment, getComments, deleteComment,
  // Attachments
  addAttachment, getAttachments, getAttachmentsByComment, getAttachmentByStoredName, deleteAttachment,
  // Email threading
  recordEmailMessage, findTicketByMessageId, findTicketByReplyToken,
  // Settings
  getDistinctOwners,
  getSetting, setSetting, seedSetting, getAllSettings, getUserPrefs, setUserPrefs,
  // Reminders
  getTicketsDueSoon, getTicketsForReminders, setTicketRemindersSent,
  // Reports
  getBillingReport,
  // Organizations
  findOrCreateOrganization, getAllOrganizations, getOrganizationsByIds, searchOrganizations,
  renameOrganization, deleteOrganization, getOrganizationById,
  // Locations
  getLocationsByOrg, getLocationById, createLocation, findOrCreateLocation,
  updateLocation, isLocationReferenced, deleteLocation, getTravelReport,
  // Technician orgs
  getTechnicianOrganizations, addTechnicianOrganization, removeTechnicianOrganization,
};
