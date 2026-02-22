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

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
});

// ============================================================
// Access helpers
// ============================================================

function getTicketAccess(ticket, user) {
  if (!ticket) return null;
  if (user.role === 'admin') return 'admin';
  return db.getUserTicketRole(ticket.id, user.id); // 'submitter'|'owner'|'collaborator'|null
}

function canManage(ticket, user) {
  const access = getTicketAccess(ticket, user);
  return access === 'admin' || access === 'submitter' || access === 'owner';
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
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}

// Helper: save uploaded files and create attachment records
function saveUploadedFiles(files, ticketId, commentId) {
  if (!files || !files.length) return;
  for (const file of files) {
    db.addAttachment({
      ticketId,
      commentId,
      originalName: file.originalname,
      storedName: file.filename,
      mimeType: file.mimetype,
      size: file.size,
    });
  }
}

// Helper: notify all parties except the actor
async function notifyParties(ticket, actorEmail, messageBody, commentId, inReplyTo) {
  const parties = db.getParties(ticket.id);
  const toEmails = parties.filter(p => p.email !== actorEmail).map(p => p.email);
  if (!toEmails.length) return;

  const domain = config.ticketEmail.split('@')[1] || 'ticketing.local';
  const msgId = `<ticket-${ticket.id}-c${commentId}-${Date.now()}@${domain}>`;
  db.recordEmailMessage(ticket.id, msgId, 'out');

  await sendTicketNotification({
    to: toEmails,
    ticketSubject: ticket.subject,
    body: messageBody,
    ticketId: ticket.id,
    messageId: msgId,
    inReplyTo: inReplyTo || `<ticket-${ticket.id}@${domain}>`,
  });
}

// ============================================================
// Routes
// ============================================================

const SINCE_SECONDS = { '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
const DEFAULT_PREFS  = { status: 'open', priority: '', sort: 'priority', order: 'desc', since: '1d' };

// GET /tickets
router.get('/', (req, res) => {
  // No query params → redirect to saved prefs (or defaults)
  if (Object.keys(req.query).length === 0) {
    const saved = db.getUserPrefs(req.user.id);
    const prefs = { ...DEFAULT_PREFS, ...saved };
    const qs = new URLSearchParams({ ...prefs, q: '' }).toString();
    return res.redirect(`/tickets?${qs}`);
  }

  const { status, priority, sort, order, q, since } = req.query;

  // Persist filter choices (not the search query)
  db.setUserPrefs(req.user.id, {
    status:   status   || '',
    priority: priority || '',
    sort:     sort     || DEFAULT_PREFS.sort,
    order:    order    || DEFAULT_PREFS.order,
    since:    since    || DEFAULT_PREFS.since,
  });

  const sinceSeconds = SINCE_SECONDS[since];
  const dateFrom = sinceSeconds ? Math.floor(Date.now() / 1000) - sinceSeconds : null;

  const tickets = db.getTickets({
    userId:   req.user.id,
    userRole: req.user.role,
    status:   status   || '',
    priority: priority || '',
    sort:     sort     || DEFAULT_PREFS.sort,
    order:    order    || DEFAULT_PREFS.order,
    search:   q        || '',
    dateFrom,
  });

  res.render('tickets/list', {
    title: 'Tickets',
    tickets,
    filters: {
      status:   status   || '',
      priority: priority || '',
      sort:     sort     || DEFAULT_PREFS.sort,
      order:    order    || DEFAULT_PREFS.order,
      q:        q        || '',
      since:    since    || DEFAULT_PREFS.since,
    },
  });
});

// GET /tickets/new
router.get('/new', (req, res) => {
  res.render('tickets/new', { title: 'New Ticket', error: null });
});

// POST /tickets — create a ticket
router.post('/', upload.array('attachments'), async (req, res) => {
  const { subject, body, priority, due_date } = req.body;

  if (!subject || !subject.trim()) {
    return res.render('tickets/new', { title: 'New Ticket', error: 'Subject is required.' });
  }

  const cleanBody = sanitize(body);
  const dueDate = due_date ? Math.floor(new Date(due_date).getTime() / 1000) : null;

  const ticket = db.createTicket({ subject: subject.trim(), body: cleanBody, priority: priority || 'medium', dueDate });
  db.addParty(ticket.id, req.user.id, 'submitter');

  saveUploadedFiles(req.files, ticket.id, null);

  // Notify the default assignee if different from creator
  const defaultEmail = config.defaultAssigneeEmail || db.getSetting('default_assignee_email');
  if (defaultEmail && defaultEmail.toLowerCase() !== req.user.email) {
    const assignee = db.findOrCreateUser(defaultEmail);
    db.addParty(ticket.id, assignee.id, 'owner');
  }

  sse.broadcastToAll({ type: 'ticket_created', ticketId: ticket.id });

  res.redirect(`/tickets/${ticket.id}`);
});

// GET /tickets/attachments/:storedName — must be before /:id to avoid param collision
const INLINE_MIME = /^(image\/|application\/pdf$|text\/plain$|video\/|audio\/)/;

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

  const { action, bulkStatus, bulkPriority } = req.body;
  if (action === 'delete') {
    db.bulkDeleteTickets(ids);
    sse.broadcastToAll({ type: 'tickets_deleted', ticketIds: ids });
  } else if (action === 'status') {
    const validStatuses = ['open', 'pending', 'on_hold', 'completed', 'cancelled'];
    if (validStatuses.includes(bulkStatus)) {
      db.bulkUpdateStatus(ids, bulkStatus);
      sse.broadcastToAll({ type: 'tickets_updated', ticketIds: ids });
    }
  } else if (action === 'priority') {
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (validPriorities.includes(bulkPriority)) {
      db.bulkUpdatePriority(ids, bulkPriority);
      sse.broadcastToAll({ type: 'tickets_updated', ticketIds: ids });
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

  const comments = db.getComments(ticket.id);
  const parties = db.getParties(ticket.id);

  // Fetch attachments grouped by comment (plus ticket-level attachments)
  const attachments = db.getAttachments(ticket.id);
  const ticketAttachments = attachments.filter(a => !a.comment_id);
  const commentAttachmentsMap = {};
  for (const a of attachments.filter(a => a.comment_id)) {
    if (!commentAttachmentsMap[a.comment_id]) commentAttachmentsMap[a.comment_id] = [];
    commentAttachmentsMap[a.comment_id].push(a);
  }

  res.render('tickets/detail', {
    title: `#${ticket.id} — ${ticket.subject}`,
    ticket,
    comments,
    parties,
    ticketAttachments,
    commentAttachmentsMap,
    access,
    canManage: canManage(ticket, req.user),
  });
});

// POST /tickets/:id/comments — add a comment
router.post('/:id/comments', upload.array('attachments'), async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const access = getTicketAccess(ticket, req.user);
  if (!access) return res.status(403).json({ error: 'Forbidden' });

  const body = sanitize(req.body.body);
  if (!body.trim() && !req.files?.length) return res.redirect(`/tickets/${ticket.id}`);

  const comment = db.addComment(ticket.id, req.user.id, body);
  saveUploadedFiles(req.files, ticket.id, comment.id);

  try {
    await notifyParties(
      ticket,
      req.user.email,
      `<p><strong>${req.user.email}</strong> commented:</p>${body}`,
      comment.id
    );
  } catch (err) {
    console.error('[Tickets] Notification error:', err);
  }

  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'comment_added', ticketId: ticket.id, commentId: comment.id });

  res.redirect(`/tickets/${ticket.id}#comment-${comment.id}`);
});

// POST /tickets/:id/status — change status
router.post('/:id/status', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const validStatuses = ['open', 'pending', 'on_hold', 'completed', 'cancelled'];
  const status = req.body.status;
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.updateTicket(ticket.id, { status });

  const comment = db.addComment(ticket.id, req.user.id, `<em>Status changed to <strong>${status}</strong></em>`);

  try {
    await notifyParties(ticket, req.user.email,
      `<p>${req.user.email} changed status to <strong>${status}</strong>.</p>`,
      comment.id);
  } catch (err) { console.error('[Tickets] Notification error:', err); }

  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'status', value: status });

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

  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id, field: 'priority', value: priority });

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/due-date
router.post('/:id/due-date', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const dueDate = req.body.due_date ? Math.floor(new Date(req.body.due_date).getTime() / 1000) : null;
  db.updateTicket(ticket.id, { due_date: dueDate });

  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/parties — add a party
router.post('/:id/parties', async (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const email = (req.body.email || '').trim().toLowerCase();
  const role = ['owner', 'collaborator'].includes(req.body.role) ? req.body.role : 'collaborator';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect(`/tickets/${ticket.id}?error=invalid_email`);
  }

  const newUser = db.findOrCreateUser(email);
  db.addParty(ticket.id, newUser.id, role);

  // Notify the newly added party
  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    await sendTicketNotification({
      to: email,
      ticketSubject: ticket.subject,
      body: `<p>You have been added to ticket <strong>#${ticket.id}: ${ticket.subject}</strong> as a ${role}.</p>
             <p><a href="${appUrl}/tickets/${ticket.id}">View ticket</a></p>`,
      ticketId: ticket.id,
    });
  } catch (err) { console.error('[Tickets] Notification error:', err); }

  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/parties/remove — remove a party
router.post('/:id/parties/remove', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!canManage(ticket, req.user)) return res.status(403).json({ error: 'Forbidden' });

  const userId = parseInt(req.body.userId, 10);
  if (!userId) return res.redirect(`/tickets/${ticket.id}`);

  // Don't allow removing the only submitter
  const parties = db.getParties(ticket.id);
  const target = parties.find(p => p.user_id === userId);
  if (target?.role === 'submitter' && parties.filter(p => p.role === 'submitter').length === 1) {
    return res.redirect(`/tickets/${ticket.id}?error=cannot_remove_submitter`);
  }

  db.removeParty(ticket.id, userId);
  sse.broadcast(db.getPartyUserIds(ticket.id), { type: 'ticket_updated', ticketId: ticket.id });

  res.redirect(`/tickets/${ticket.id}`);
});

// POST /tickets/:id/delete — admin only
router.post('/:id/delete', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.' });
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: '403', message: 'Forbidden.' });

  db.deleteTicket(ticket.id);
  sse.broadcastToAll({ type: 'ticket_deleted', ticketId: ticket.id });
  res.redirect('/tickets');
});

module.exports = router;
