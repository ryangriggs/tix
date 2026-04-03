'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sanitizeHtml = require('sanitize-html');

const config = require('../config');
const db = require('../db');
const { sendTicketNotification } = require('../services/mail');
const sse = require('../services/sse');
const audit = require('../services/audit');

// ============================================================
// Multer — uploads to data/uploads with UUID filenames
// ============================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  },
});

function buildFileFilter() {
  const allowed = config.uploadAllowedExtensions
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const blocked = config.uploadBlockedExtensions
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

  return (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (blocked.length && blocked.includes(ext)) {
      return cb(new Error(`File type .${ext} is not allowed.`));
    }
    if (allowed.length && !allowed.includes(ext)) {
      return cb(new Error(`File type .${ext} is not allowed. Permitted types: ${allowed.join(', ')}`));
    }
    cb(null, true);
  };
}

// Rebuilt per-request so runtime config changes (max size, extensions) take effect immediately
function upload(req, res, next) {
  multer({
    storage,
    limits: { fileSize: (config.uploadMaxSizeMb || 25) * 1024 * 1024 },
    fileFilter: buildFileFilter(),
  }).array('attachments')(req, res, next);
}

// ============================================================
// Access helpers
// ============================================================

function getTicketAccess(ticket, user) {
  if (!ticket) return null;
  if (user.role === 'admin') return 'admin';
  if (user.role === 'technician' && ticket.organization_id &&
      (user.techOrgIds || []).includes(ticket.organization_id)) return 'technician';
  if (user.isGroupSuperuser && user.organization_id && (
      ticket.organization_id === user.organization_id ||
      (user.techOrgIds || []).includes(ticket.organization_id)
  )) return 'superuser';
  return db.getUserTicketRole(ticket.id, user.id); // 'submitter'|'owner'|'collaborator'|null
}

function canManage(ticket, user) {
  const access = getTicketAccess(ticket, user);
  return ['admin', 'submitter', 'owner', 'technician'].includes(access);
}

function canCloseTicket(user)  { return user.role === 'admin' || user.role === 'technician'; }
function canReopenTicket(user) { return user.role === 'admin'; }

const VISIBILITY_RANK = { user: 0, technician: 1, admin: 2 };
function userVisibilityCap(user) {
  if (user.role === 'admin') return 'admin';
  if (user.role === 'technician') return 'technician';
  return 'user';
}
function canSeeComment(comment, user) {
  return (VISIBILITY_RANK[comment.visibility || 'user'] ?? 0) <= (VISIBILITY_RANK[userVisibilityCap(user)] ?? 0);
}

// Sanitize Quill-generated HTML (trusted tags only)
const ALLOWED_TAGS = [
  'p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'del',
  'h1', 'h2', 'h3', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'a', 'img',
];

function sanitize(html) {
  return sanitizeHtml(html || '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'target'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    transformTags: {
      // Strip data: URIs that are not safe raster image types (SVG can contain scripts)
      img(tagName, attribs) {
        const src = attribs.src || '';
        if (src.startsWith('data:') && !/^data:image\/(png|jpe?g|gif|webp|bmp|ico);base64,/i.test(src)) {
          return false; // remove the tag
        }
        return { tagName, attribs };
      },
    },
  });
}

// Helper: save uploaded files and create attachment records
// Renames the stored file to {ticketId}-{uuid}.{ext} for easy manual recovery.
function saveUploadedFiles(files, ticketId, commentId) {
  if (!files || !files.length) return;
  for (const file of files) {
    const ext = path.extname(file.filename);
    const newName = `${ticketId}-${path.basename(file.filename, ext)}${ext}`;
    let storedName = file.filename;
    try {
      fs.renameSync(
        path.join(config.uploadsDir, file.filename),
        path.join(config.uploadsDir, newName)
      );
      storedName = newName;
    } catch (err) {
      console.error('[Upload] Could not rename file:', err.message);
    }
    db.addAttachment({
      ticketId,
      commentId,
      originalName: file.originalname,
      storedName,
      mimeType: file.mimetype,
      size: file.size,
    });
  }
}

// Helper: notify all parties except the actor
async function notifyParties(ticket, actorEmail, messageBody, commentId, inReplyTo, visibility = 'user') {
  const parties = db.getParties(ticket.id);
  const commentRank = VISIBILITY_RANK[visibility] ?? 0;
  const toEmails = parties
    .filter(p => {
      if (p.email === actorEmail || p.notifications_disabled) return false;
      return (VISIBILITY_RANK[userVisibilityCap({ role: p.user_role })] ?? 0) >= commentRank;
    })
    .map(p => p.email);
  if (!toEmails.length) return;

  const domain = config.ticketEmail.split('@')[1] || 'tix.local';
  const msgId = `<ticket-${ticket.id}-c${commentId}-${Date.now()}@${domain}>`;
  db.recordEmailMessage(ticket.id, msgId, 'out');

  await sendTicketNotification({
    to: toEmails,
    ticketSubject: ticket.subject,
    body: messageBody,
    ticketId: ticket.id,
    messageId: msgId,
    inReplyTo: inReplyTo || `<ticket-${ticket.id}@${domain}>`,
    replyToken: ticket.reply_token,
  });
}

// ============================================================
// Routes
// ============================================================

const SINCE_SECONDS    = { '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
const DEFAULT_PREFS    = { status: 'new,pending,open,on_hold', priority: '', sort: 'priority', order: 'desc', since: '', org: '', q: '', owner: 'me' };
const VALID_STATUSES   = ['new', 'pending', 'open', 'on_hold', 'closed'];
const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const FILTER_COOKIE  = 'tix_filters';

function readFilterCookie(req) {
  try { return JSON.parse(req.cookies[FILTER_COOKIE] || '{}'); } catch (_) { return {}; }
}

// GET /tickets
router.get('/', (req, res) => {
  // No query params → redirect to saved prefs (or defaults)
  if (Object.keys(req.query).length === 0) {
    const saved = readFilterCookie(req);
    const prefs = { ...DEFAULT_PREFS, ...saved };
    const qs = new URLSearchParams(prefs).toString();
    return res.redirect(`/tickets?${qs}`);
  }

  const { status, priority, sort, order, q, since, org, date_from, date_to, owner } = req.query;

  // Strip ticket prefix from search term; if remainder is a plain integer treat as ID lookup
  const prefix = config.ticketPrefix;
  let search = q || '';
  let idSearch = null;
  if (prefix && search.toLowerCase().startsWith(prefix.toLowerCase())) {
    search = search.slice(prefix.length);
  }
  if (/^\d+$/.test(search.trim())) {
    idSearch = parseInt(search.trim(), 10);
    search = '';
  }

  // Persist filter choices to cookie (including search query).
  const savedPrefs = {
    status:    'status'   in req.query ? (status   || '') : DEFAULT_PREFS.status,
    priority:  'priority' in req.query ? (priority || '') : DEFAULT_PREFS.priority,
    sort:      sort     || DEFAULT_PREFS.sort,
    order:     order    || DEFAULT_PREFS.order,
    since:     'since'  in req.query ? (since ?? '') : DEFAULT_PREFS.since,
    org:       org      || '',
    q:         q        || '',
    date_from: date_from || '',
    date_to:   date_to   || '',
    owner:     owner !== undefined ? (owner || '') : 'me',
  };
  res.cookie(FILTER_COOKIE, JSON.stringify(savedPrefs), {
    httpOnly: false,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  });

  // Compute date window
  let dateFrom = null;
  let dateTo   = null;
  if (since === 'custom') {
    if (date_from) dateFrom = Math.floor(new Date(date_from).getTime() / 1000);
    if (date_to)   dateTo   = Math.floor(new Date(date_to).getTime()   / 1000) + 86399; // end of day
  } else {
    const sinceSeconds = SINCE_SECONDS[since];
    if (sinceSeconds) dateFrom = Math.floor(Date.now() / 1000) - sinceSeconds;
  }

  // Parse comma-separated multi-select values, validating against known values
  const statusValues   = (status   || '').split(',').filter(s => VALID_STATUSES.includes(s));
  const priorityValues = (priority || '').split(',').filter(p => VALID_PRIORITIES.includes(p));

  // Owner filter — admin and technician only
  const canFilterOwner = req.user.role === 'admin' || req.user.role === 'technician';
  let ownerFilter = null;
  if (canFilterOwner) {
    const ov = savedPrefs.owner;
    if (ov === 'me')          ownerFilter = 'me';
    else if (ov === 'unassigned' && req.user.role === 'admin') ownerFilter = 'unassigned';
    else if (/^\d+$/.test(ov)) ownerFilter = parseInt(ov, 10);
    // empty string ('') = no filter (show all)
  }

  const tickets = db.getTickets({
    userId:          req.user.id,
    userRole:        req.user.role,
    userOrgId:       req.user.organization_id || null,
    userIsSuperuser: req.user.isGroupSuperuser,
    userTechOrgIds:  req.user.techOrgIds || [],
    status:          statusValues,
    priority:        priorityValues,
    sort:            sort     || DEFAULT_PREFS.sort,
    order:           order    || DEFAULT_PREFS.order,
    search,
    idSearch,
    dateFrom,
    dateTo,
    orgFilter:       org === 'unassigned' ? -1 : (org ? parseInt(org, 10) : null),
    ownerFilter,
  });

  // Org filter dropdown — visible to admins, technicians, and superusers
  const canFilterOrg = req.user.role === 'admin' || req.user.role === 'technician' || req.user.isGroupSuperuser;
  let organizations = [];
  if (canFilterOrg) {
    if (req.user.role === 'admin') {
      organizations = db.getAllOrganizations();
    } else {
      // Technicians and superusers only see their assigned orgs
      const scopedIds = [...new Set([
        ...(req.user.techOrgIds || []),
        ...(req.user.organization_id ? [req.user.organization_id] : []),
      ])];
      organizations = db.getOrganizationsByIds(scopedIds);
    }
  }

  const distinctOwners = canFilterOwner
    ? db.getDistinctOwners({ userRole: req.user.role, userId: req.user.id, userTechOrgIds: req.user.techOrgIds || [] })
    : [];

  const assignableUsers = req.user.role === 'admin' ? db.getAssignableUsers() : [];

  res.render('tickets/list', {
    title: 'Tickets',
    tickets,
    organizations,
    distinctOwners,
    canFilterOwner,
    assignableUsers,
    filters: savedPrefs,
  });
});

// GET /tickets/new
router.get('/new', (req, res) => {
  res.render('tickets/new', { title: 'New Ticket', error: null, uploadMaxSizeMb: config.uploadMaxSizeMb || 25 });
});

// POST /tickets — create a ticket
router.post('/', upload, async (req, res) => {
  const { subject, body, priority, due_date, organization_name } = req.body;

  if (!subject || !subject.trim()) {
    return res.render('tickets/new', { title: 'New Ticket', error: 'Subject is required.' });
  }

  const cleanBody = sanitize(body);
  const dueDate = due_date ? Math.floor(new Date(due_date).getTime() / 1000) : null;

  // Resolve organization — use typed name or fall back to submitter's org
  let orgId = null;
  if (organization_name && organization_name.trim()) {
    const org = db.findOrCreateOrganization(organization_name.trim());
    orgId = org ? org.id : null;
  } else if (req.user.organization_id) {
    orgId = req.user.organization_id;
  }

  const ticket = db.createTicket({ subject: subject.trim(), body: cleanBody, priority: priority || 'medium', dueDate, organizationId: orgId });
  db.addParty(ticket.id, req.user.id, 'submitter');

  // Add collaborators specified at creation time — collect emails for notification
  const collabIds    = [].concat(req.body['collaboratorIds[]']    || req.body.collaboratorIds    || []).filter(Boolean);
  const collabEmails = [].concat(req.body['collaboratorEmails[]'] || req.body.collaboratorEmails || []).filter(Boolean);
  const notifyCollabEmails = [];
  for (const id of collabIds) {
    const u = db.getUserById(parseInt(id, 10));
    if (u && u.id !== req.user.id) { db.addParty(ticket.id, u.id, 'collaborator'); notifyCollabEmails.push(u.email); }
  }
  for (const email of collabEmails) {
    const e = email.trim().toLowerCase();
    if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e !== req.user.email) {
      const u = db.findOrCreateUser(e);
      db.addParty(ticket.id, u.id, 'collaborator');
      notifyCollabEmails.push(e);
    }
  }

  saveUploadedFiles(req.files, ticket.id, null);

  // Assign to default assignee (always owner, even if they are also the creator)
  const defaultEmail = config.defaultAssigneeEmail || db.getSetting('default_assignee_email');
  if (defaultEmail) {
    const assignee = db.findOrCreateUser(defaultEmail);
    db.addParty(ticket.id, assignee.id, 'owner');
  }

  audit.log(req, `created ticket "${ticket.subject}"`, ticket.id);
  sse.broadcastToAll({ type: 'ticket_created', ticketId: ticket.id });

  // Notify default assignee and collaborators (creator is excluded — they just submitted it)
  const ticketUrl = `${config.appUrl}/tickets/${ticket.id}`;
  const notifyErrors = [];
  if (defaultEmail && defaultEmail.toLowerCase() !== req.user.email) {
    try {
      await sendTicketNotification({
        to: defaultEmail,
        ticketSubject: ticket.subject,
        body: `<p>A new ticket has been assigned to you: <strong>#${config.ticketPrefix}${ticket.id} — ${ticket.subject}</strong></p>
               <p>Submitted by: <strong>${req.user.email}</strong></p>
               <p><a href="${ticketUrl}">View ticket</a></p>`,
        ticketId: ticket.id,
        replyToken: ticket.reply_token,
      });
    } catch (err) { notifyErrors.push(err); }
  }
  for (const email of notifyCollabEmails) {
    try {
      await sendTicketNotification({
        to: email,
        ticketSubject: ticket.subject,
        body: `<p>You have been added to ticket <strong>#${config.ticketPrefix}${ticket.id} — ${ticket.subject}</strong> as a collaborator.</p>
               <p><a href="${ticketUrl}">View ticket</a></p>`,
        ticketId: ticket.id,
        replyToken: ticket.reply_token,
      });
    } catch (err) { notifyErrors.push(err); }
  }
  if (notifyErrors.length) console.error('[Tickets] Notification error(s) on ticket creation:', notifyErrors);

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/attachments/:storedName/delete — admin only; must be before /:id
router.post('/attachments/:storedName/delete', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: '403', message: 'Forbidden.' });

  const att = db.getAttachmentByStoredName(req.params.storedName);
  if (!att) return res.status(404).render('error', { title: '404', message: 'Attachment not found.' });

  db.deleteAttachment(att.stored_name);
  try { fs.unlinkSync(path.join(config.uploadsDir, att.stored_name)); } catch (_) {}

  audit.log(req, `deleted attachment "${att.original_name}"`, att.ticket_id);
  res.redirect(`/tickets/${att.ticket_id}`);
});

// GET /tickets/attachments/:storedName — must be before /:id to avoid param collision
// SVG is excluded from inline display to prevent script execution.
const INLINE_MIME = /^(image\/(?!svg)|application\/pdf$|text\/plain$|video\/|audio\/)/;

router.get('/attachments/:storedName', (req, res) => {
  const att = db.getAttachmentByStoredName(req.params.storedName);
  if (!att) return res.status(404).send('Not found');

  const ticket = db.getTicketById(att.ticket_id);
  if (!getTicketAccess(ticket, req.user)) return res.status(403).send('Forbidden');

  const filePath = path.join(config.uploadsDir, att.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');

  if (INLINE_MIME.test(att.mime_type)) {
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${att.original_name}"`);
    res.sendFile(path.resolve(filePath));
  } else {
    res.download(filePath, att.original_name);
  }
});

// POST /tickets/bulk — bulk delete or status change (admin only)
router.post('/bulk', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const ids = [].concat(req.body.ticketIds || []).map(Number).filter(Boolean);
  if (!ids.length) return res.redirect('/tickets');

  const { action, bulkStatus, bulkPriority, bulkAssignee } = req.body;
  if (action === 'delete') {
    db.bulkDeleteTickets(ids);
    audit.log(req, `bulk deleted ${ids.length} ticket(s): ${ids.join(', ')}`);
    sse.broadcastToAll({ type: 'tickets_deleted', ticketIds: ids });
  } else if (action === 'status') {
    const validStatuses = ['new', 'pending', 'open', 'on_hold', 'closed'];
    if (validStatuses.includes(bulkStatus)) {
      db.bulkUpdateStatus(ids, bulkStatus);
      audit.log(req, `bulk changed status to ${bulkStatus} on ${ids.length} ticket(s): ${ids.join(', ')}`);
      sse.broadcastToAll({ type: 'tickets_updated', ticketIds: ids });
    }
  } else if (action === 'priority') {
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (validPriorities.includes(bulkPriority)) {
      db.bulkUpdatePriority(ids, bulkPriority);
      audit.log(req, `bulk changed priority to ${bulkPriority} on ${ids.length} ticket(s): ${ids.join(', ')}`);
      sse.broadcastToAll({ type: 'tickets_updated', ticketIds: ids });
    }
  } else if (action === 'assign') {
    const assigneeId = parseInt(bulkAssignee, 10);
    if (assigneeId) {
      const assignee = db.getUserById(assigneeId);
      if (assignee && ['admin', 'technician'].includes(assignee.role)) {
        for (const id of ids) {
          db.addParty(id, assignee.id, 'owner');
        }
        audit.log(req, `bulk assigned ${assignee.email} as owner on ${ids.length} ticket(s): ${ids.join(', ')}`);
        sse.broadcastToAll({ type: 'tickets_updated', ticketIds: ids });
      }
    }
  }

  res.redirect('/tickets');
});

// GET /tickets/:id
router.get('/:id', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.' });

  const access = getTicketAccess(ticket, req.user);
  if (!access) return res.status(403).render('error', { title: '403', message: 'You do not have access to this ticket.' });

  const comments = db.getComments(ticket.id).filter(c => canSeeComment(c, req.user));
  const parties = db.getParties(ticket.id);

  const attachments = db.getAttachments(ticket.id);

  const isTechOrAdmin = req.user.role === 'admin' || req.user.role === 'technician';
  const _localPart = config.ticketEmail.split('@')[0];
  const _domain    = config.ticketEmail.split('@')[1] || 'tix.local';
  res.render('tickets/detail', {
    title: `#${ticket.id} — ${ticket.subject}`,
    ticket,
    comments,
    parties,
    attachments,
    access,
    canManage: canManage(ticket, req.user),
    isSuperuser: req.user.isGroupSuperuser,
    organizations: db.getAllOrganizations(),
    isTechOrAdmin,
    enableBillableHours: config.enableBillableHours,
    enableLocation:      config.enableLocation,
    canClose:  canCloseTicket(req.user),
    canReopen: canReopenTicket(req.user),
    userVisibilityCap: userVisibilityCap(req.user),
    ticketUrl:        `${config.appUrl}/tickets/${ticket.id}`,
    ticketReplyEmail: `${_localPart}+${ticket.reply_token}@${_domain}`,
  });
});

// POST /tickets/:id/comments — add a comment
router.post('/:id/comments', upload, async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const access = getTicketAccess(ticket, req.user);
  if (!access) return res.status(403).json({ error: 'Forbidden' });

  const body = sanitize(req.body.body);
  if (!body.trim()) return res.redirect(`/tickets/${ticket.id}`);

  // Optional status change submitted alongside the comment
  const validStatuses = ['new', 'pending', 'open', 'on_hold', 'closed'];
  const statusChange = req.body.status_change;
  let willChangeStatus = statusChange && validStatuses.includes(statusChange) &&
                         statusChange !== ticket.status && canManage(ticket, req.user);

  // Restrict closing/reopening via comment form
  if (willChangeStatus && statusChange === 'closed' && !canCloseTicket(req.user)) willChangeStatus = false;
  if (willChangeStatus && ticket.status === 'closed' && !canReopenTicket(req.user)) willChangeStatus = false;

  // Billable hours and location (admin/tech only)
  const isTechOrAdmin = req.user.role === 'admin' || req.user.role === 'technician';
  const rawHours = parseFloat(req.body.billable_hours);
  const billableHours = isTechOrAdmin && config.enableBillableHours && rawHours > 0 ? rawHours : null;

  let locationId = null;
  if (isTechOrAdmin && config.enableLocation && ticket.organization_id) {
    const submittedId   = parseInt(req.body.location_id, 10);
    const submittedName = (req.body.location_name || '').trim();
    if (submittedId) {
      const loc = db.getLocationById(submittedId);
      if (loc && loc.organization_id === ticket.organization_id) locationId = loc.id;
    } else if (submittedName) {
      const loc = db.findOrCreateLocation(ticket.organization_id, submittedName);
      if (loc) locationId = loc.id;
    }
  }

  // Visibility — clamp to the user's own cap so they can't escalate
  const cap = userVisibilityCap(req.user);
  const rawVis = req.body.visibility || 'user';
  const visibility = (VISIBILITY_RANK[rawVis] ?? 0) <= (VISIBILITY_RANK[cap] ?? 0) ? rawVis : cap;

  // Checkbox sends notify=1 when checked, absent when unchecked
  const shouldNotify = req.body.notify === '1';

  const comment = db.addComment(ticket.id, req.user.id, body, false, billableHours, locationId, visibility);
  saveUploadedFiles(req.files, ticket.id, comment.id);

  if (willChangeStatus) {
    const closeFields = { status: statusChange };
    if (statusChange === 'closed') closeFields.close_date = Math.floor(Date.now() / 1000);
    if (ticket.status === 'closed' && statusChange !== 'closed') closeFields.close_date = null;
    db.updateTicket(ticket.id, closeFields);
  }

  if (shouldNotify) {
    try {
      await notifyParties(
        ticket,
        req.user.email,
        `<p>Ticket #: <strong>${config.ticketPrefix}${ticket.id}</strong></p>
        <p>Status: <strong>${willChangeStatus ? statusChange : ticket.status}</strong></p>
        <p>Subject: <strong>${ticket.subject}</strong></p>
        <p><strong>${req.user.email}</strong> commented:</p>
        ${body}`,
        comment.id,
        null,
        visibility
      );
    } catch (err) {
      console.error('[Tickets] Notification error:', err);
    }
  }

  audit.log(req, willChangeStatus ? `added comment, changed status to ${statusChange}` : 'added comment', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'comment_added', ticketId: ticket.id, commentId: comment.id });
  if (willChangeStatus) {
    sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'status', value: statusChange });
  }

  res.redirect(`/tickets/${ticket.id}#comment-${comment.id}`);
});

// POST /tickets/:id/comments/:commentId/edit — admin or comment owner
router.post('/:id/comments/:commentId/edit', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

  const commentId = parseInt(req.params.commentId, 10);
  const comment = db.getComments(ticket.id).find(c => c.id === commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });

  const isAdmin = req.user.role === 'admin';
  const isOwner = comment.user_id === req.user.id;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden.' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment body cannot be empty.' });

  db.updateComment(commentId, body);
  audit.log(req, 'edited comment', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.json({ ok: true, body });
});

// POST /tickets/:id/comments/:commentId/visibility — admin or comment owner
router.post('/:id/comments/:commentId/visibility', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!getTicketAccess(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const commentId = parseInt(req.params.commentId, 10);
  const comment = db.getComments(ticket.id).find(c => c.id === commentId);
  if (!comment || !canSeeComment(comment, req.user)) return res.status(404).json({ error: 'Comment not found' });

  const isAdmin = req.user.role === 'admin';
  const isOwner = comment.user_id === req.user.id;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });

  const newVis = req.body.visibility;
  if (!['user', 'technician', 'admin'].includes(newVis)) return res.status(400).json({ error: 'Invalid visibility' });
  if ((VISIBILITY_RANK[newVis] ?? 0) > (VISIBILITY_RANK[userVisibilityCap(req.user)] ?? 0))
    return res.status(403).json({ error: 'Cannot set visibility above your own level' });

  db.updateCommentVisibility(commentId, newVis);
  audit.log(req, `set comment ${commentId} visibility to ${newVis}`, ticket.id);

  res.json({ ok: true, visibility: newVis });
});

// POST /tickets/:id/comments/:commentId/delete — admin only
router.post('/:id/comments/:commentId/delete', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: '403', message: 'Forbidden.' });

  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.' });

  const commentId = parseInt(req.params.commentId, 10);

  db.deleteComment(commentId);
  audit.log(req, 'deleted comment', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/body — edit ticket body (admin or party-role owner)
router.post('/:id/body', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  const access = getTicketAccess(ticket, req.user);
  if (access !== 'admin' && access !== 'owner') return res.status(403).json({ error: 'Forbidden' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Body cannot be empty.' });

  db.updateTicket(ticket.id, { body });
  audit.log(req, 'edited ticket body', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.json({ ok: true, body });
});

// POST /tickets/:id/subject — rename ticket (admin only)
router.post('/:id/subject', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const subject = (req.body.subject || '').trim();
  if (!subject) {
    if (req.accepts('json')) return res.status(400).json({ error: 'Subject cannot be empty.' });
    return res.redirect(`/tickets/${ticket.id}`);
  }

  db.updateTicket(ticket.id, { subject });
  audit.log(req, `changed subject to "${subject}"`, ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'subject', value: subject });

  if (req.accepts('json')) return res.json({ ok: true, subject });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/status — change status
router.post('/:id/status', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const validStatuses = ['new', 'pending', 'open', 'on_hold', 'closed'];
  const status = req.body.status;
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const isClosing   = status === 'closed';
  const isReopening = ticket.status === 'closed' && status !== 'closed';
  if (isClosing   && !canCloseTicket(req.user))  return res.status(403).json({ error: 'Only admins and technicians can close tickets.' });
  if (isReopening && !canReopenTicket(req.user)) return res.status(403).json({ error: 'Only admins can reopen closed tickets.' });

  const statusFields = { status };
  if (isClosing)   statusFields.close_date = Math.floor(Date.now() / 1000);
  if (isReopening) statusFields.close_date = null;
  db.updateTicket(ticket.id, statusFields);

  const comment = db.addComment(ticket.id, req.user.id, `<em>Status changed to <strong>${status}</strong></em>`);

  if (config.notifyEmailStatusChange) {
    try {
      await notifyParties(ticket, req.user.email,
        `<p>${req.user.email} changed status to <strong>${status}</strong>.</p>`,
        comment.id);
    } catch (err) { console.error('[Tickets] Notification error:', err); }
  }

  audit.log(req, `changed status to ${status}`, ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'status', value: status });

  if (req.accepts('json')) return res.json({ ok: true, status });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/priority — change priority
router.post('/:id/priority', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const validPriorities = ['low', 'medium', 'high', 'urgent'];
  const priority = req.body.priority;
  if (!validPriorities.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });

  db.updateTicket(ticket.id, { priority });
  audit.log(req, `changed priority to ${priority}`, ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'priority', value: priority });

  if (req.accepts('json')) return res.json({ ok: true, priority });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/due-date
router.post('/:id/due-date', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const dueDate = req.body.due_date ? Math.floor(new Date(req.body.due_date).getTime() / 1000) : null;
  db.updateTicket(ticket.id, { due_date: dueDate });
  if (dueDate !== ticket.due_date) db.setTicketRemindersSent(ticket.id, 0);
  audit.log(req, dueDate ? `changed due date to ${req.body.due_date}` : 'cleared due date', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'due_date', value: dueDate });

  if (req.accepts('json')) {
    const formatted = dueDate ? new Date(dueDate * 1000).toLocaleDateString() : null;
    return res.json({ ok: true, dueDate, formatted });
  }
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/organization — set or clear ticket org (canManage)
router.post('/:id/organization', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const orgName = (req.body.organization_name || '').trim();
  let orgId = null, resolvedOrgName = null;
  if (orgName) {
    const org = db.findOrCreateOrganization(orgName);
    orgId = org ? org.id : null;
    resolvedOrgName = org ? org.name : null;
  }
  db.updateTicket(ticket.id, { organization_id: orgId });
  audit.log(req, orgId ? `changed organization to "${resolvedOrgName}"` : 'cleared organization', ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'org', value: resolvedOrgName });
  if (req.accepts('json')) return res.json({ ok: true, orgName: resolvedOrgName, orgId: orgId || null });
  res.redirect(`/tickets/${ticket.id}`);
});


// POST /tickets/:id/parties — add a party
router.post('/:id/parties', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const role = ['owner', 'collaborator'].includes(req.body.role) ? req.body.role : 'collaborator';
  let newUser;

  if (req.body.userId) {
    // Selected from autocomplete
    newUser = db.getUserById(parseInt(req.body.userId, 10));
    if (!newUser) return res.redirect(`/tickets/${ticket.id}?error=user_not_found`);
  } else {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.redirect(`/tickets/${ticket.id}?error=invalid_email`);
    }
    newUser = db.findOrCreateUser(email);
  }
  const full = db.getUserById(newUser.id); // includes organization_name via JOIN
  db.addParty(ticket.id, full.id, role);
  audit.log(req, `added ${full.email} as ${role}`, ticket.id);

  // Notify the newly added party
  try {
    await sendTicketNotification({
      to: full.email,
      ticketSubject: ticket.subject,
      body: `<p>You have been added to ticket <strong>#${ticket.id}: ${ticket.subject}</strong> as a ${role}.</p>
             <p><a href="${config.appUrl}/tickets/${ticket.id}">View ticket</a></p>`,
      ticketId: ticket.id,
      replyToken: ticket.reply_token,
    });
  } catch (err) { console.error('[Tickets] Notification error:', err); }

  const partyPayload = { userId: full.id, name: full.name || null, email: full.email, orgName: full.organization_name || null, role, notificationsDisabled: false };
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'party_added', party: partyPayload });

  if (req.accepts('json')) return res.json({ ok: true, party: partyPayload });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/parties/role — change a party's role (admin only)
router.post('/:id/parties/role', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const userId = parseInt(req.body.userId, 10);
  const role   = req.body.role;
  if (!userId || !['submitter', 'owner', 'collaborator'].includes(role))
    return res.status(400).json({ error: 'Invalid' });
  if (!db.getUserTicketRole(ticket.id, userId))
    return res.status(404).json({ error: 'User is not a party to this ticket' });

  const affected = db.getUserById(userId);
  db.addParty(ticket.id, userId, role);
  audit.log(req, `changed ${affected?.email || userId}'s role to ${role}`, ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'party_updated', userId, role });

  // Notify the affected user (skip if they made the change themselves)
  if (affected && affected.email !== req.user.email) {
    try {
      await sendTicketNotification({
        to: affected.email,
        ticketSubject: ticket.subject,
        body: `<p>Your role on ticket <strong>#${config.ticketPrefix}${ticket.id} — ${ticket.subject}</strong> has been changed to <strong>${role}</strong>.</p>
               <p><a href="${config.appUrl}/tickets/${ticket.id}">View ticket</a></p>`,
        ticketId: ticket.id,
        replyToken: ticket.reply_token,
      });
    } catch (err) { console.error('[Tickets] Role-change notification error:', err); }
  }

  if (req.accepts('json')) return res.json({ ok: true, role });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/parties/notify — toggle notifications for a party (canManage)
router.post('/:id/parties/notify', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const userId = parseInt(req.body.userId, 10);
  if (!userId) return res.status(400).json({ error: 'Invalid' });
  if (!db.getUserTicketRole(ticket.id, userId))
    return res.status(404).json({ error: 'User is not a party to this ticket' });

  const disabled = db.togglePartyNotifications(ticket.id, userId);
  return res.json({ ok: true, notificationsDisabled: disabled });
});

// POST /tickets/:id/parties/remove — remove a party
router.post('/:id/parties/remove', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const userId = parseInt(req.body.userId, 10);
  if (!userId) return res.redirect(`/tickets/${ticket.id}`);

  const removedUser = db.getUserById(userId);
  db.removeParty(ticket.id, userId);
  audit.log(req, `removed ${removedUser?.email || userId}`, ticket.id);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'party_removed', userId });

  if (req.accepts('json')) return res.json({ ok: true });
  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/delete — admin only
router.post('/:id/delete', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.' });
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: '403', message: 'Forbidden.' });

  db.deleteTicket(ticket.id);
  audit.log(req, `deleted ticket "${ticket.subject}"`, ticket.id);
  sse.broadcastToAll({ type: 'ticket_deleted', ticketId: ticket.id });
  res.redirect('/tickets');
});

module.exports = router;
