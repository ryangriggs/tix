'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const db      = require('../db');
const config  = require('../config');

// Validate that storedName is a UUID (optionally followed by a file extension).
// This prevents path traversal — storedName comes from the URL and must match
// what we generate server-side, never be a relative path like ../../etc/passwd.
const STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-zA-Z0-9]{1,10})?$/i;

function annotationFile(storedName, page) {
  // storedName is already validated before this is called
  const safePage = Math.max(1, Math.min(9999, parseInt(page, 10) || 1));
  return path.join(config.annotationsDir, `${storedName}-p${safePage}.json`);
}

// Shared access check: ticket must exist, attachment must belong to ticket,
// user must be admin or a party to the ticket, storedName must be a valid UUID.
function resolveAnnotationTarget(req, res, renderErrors) {
  const { ticketId, storedName, page } = req.params;

  if (!STORED_NAME_RE.test(storedName)) {
    if (renderErrors) res.status(400).render('error', { title: 'Bad request', message: 'Invalid attachment name.' });
    else res.status(400).json({ error: 'Invalid attachment name' });
    return null;
  }

  const ticket = db.getTicketById(ticketId);
  if (!ticket) {
    if (renderErrors) res.status(404).render('error', { title: '404', message: 'Ticket not found.' });
    else res.status(404).json({ error: 'Not found' });
    return null;
  }

  const att = db.getAttachmentByStoredName(storedName);
  if (!att || att.ticket_id !== ticket.id) {
    if (renderErrors) res.status(404).render('error', { title: '404', message: 'Attachment not found.' });
    else res.status(404).json({ error: 'Not found' });
    return null;
  }

  // Access control: admin bypasses; everyone else must be a party
  const user = req.user;
  if (user.role !== 'admin' && !db.getUserTicketRole(ticket.id, user.id)) {
    if (renderErrors) res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this ticket.' });
    else res.status(403).json({ error: 'Forbidden' });
    return null;
  }

  return { ticket, att, page: Math.max(1, Math.min(9999, parseInt(page, 10) || 1)) };
}

// GET /tickets/:ticketId/attachments/:storedName/annotate
router.get('/:ticketId/attachments/:storedName/annotate', (req, res) => {
  const ctx = resolveAnnotationTarget(req, res, true);
  if (!ctx) return;

  const ext = path.extname(ctx.att.original_name || '').toLowerCase().replace('.', '');
  const exts = config.annotationExtensions.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!exts.includes(ext))
    return res.status(400).render('error', { title: 'Not supported', message: 'This file type does not support annotation.' });

  res.render('annotate/index', {
    ticket: ctx.ticket,
    attachment: ctx.att,
    ext,
    isPdf: ext === 'pdf',
    isSvg: ext === 'svg',
    title: `Annotate — ${ctx.att.original_name}`,
  });
});

// GET /tickets/:ticketId/attachments/:storedName/annotations/:page
router.get('/:ticketId/attachments/:storedName/annotations/:page', (req, res) => {
  const ctx = resolveAnnotationTarget(req, res, false);
  if (!ctx) return;

  const filePath = annotationFile(req.params.storedName, ctx.page);
  try {
    if (!fs.existsSync(filePath)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    console.error('[Annotate] Read error:', err.message);
    res.status(503).json({ error: 'Annotation folder not available' });
  }
});

// POST /tickets/:ticketId/attachments/:storedName/annotations/:page
const MAX_ANNOTATION_BYTES = 512 * 1024; // 512 KB per page
router.post('/:ticketId/attachments/:storedName/annotations/:page', express.json({ limit: '512kb' }), (req, res) => {
  const ctx = resolveAnnotationTarget(req, res, false);
  if (!ctx) return;

  // Validate structure: must be an object or array (not a primitive)
  if (typeof req.body !== 'object' || req.body === null) {
    return res.status(400).json({ error: 'Invalid annotation data' });
  }

  const serialized = JSON.stringify(req.body);
  if (serialized.length > MAX_ANNOTATION_BYTES) {
    return res.status(413).json({ error: 'Annotation data too large' });
  }

  const filePath = annotationFile(req.params.storedName, ctx.page);
  try {
    fs.writeFileSync(filePath, serialized, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Annotate] Save error:', err);
    res.status(500).json({ error: 'Failed to save annotations' });
  }
});

module.exports = router;
