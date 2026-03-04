'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const db      = require('../db');
const config  = require('../config');

function annotationFile(storedName, page) {
  return path.join(config.annotationsDir, `${storedName}-p${page}.json`);
}

// GET /tickets/:ticketId/attachments/:storedName/annotate
router.get('/:ticketId/attachments/:storedName/annotate', (req, res) => {
  const ticket = db.getTicketById(req.params.ticketId);
  if (!ticket) return res.status(404).render('error', { title: '404', message: 'Ticket not found.' });

  const att = db.getAttachmentByStoredName(req.params.storedName);
  if (!att || att.ticket_id !== ticket.id)
    return res.status(404).render('error', { title: '404', message: 'Attachment not found.' });

  const ext = path.extname(att.original_name || '').toLowerCase().replace('.', '');
  const exts = config.annotationExtensions.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!exts.includes(ext))
    return res.status(400).render('error', { title: 'Not supported', message: 'This file type does not support annotation.' });

  res.render('annotate/index', {
    ticket,
    attachment: att,
    ext,
    isPdf: ext === 'pdf',
    isSvg: ext === 'svg',
    title: `Annotate — ${att.original_name}`,
  });
});

// GET /tickets/:ticketId/attachments/:storedName/annotations/:page
router.get('/:ticketId/attachments/:storedName/annotations/:page', (req, res) => {
  const page     = Math.max(1, parseInt(req.params.page, 10) || 1);
  const filePath = annotationFile(req.params.storedName, page);
  if (!fs.existsSync(filePath)) return res.json(null);
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    res.json(null);
  }
});

// POST /tickets/:ticketId/attachments/:storedName/annotations/:page
router.post('/:ticketId/attachments/:storedName/annotations/:page', express.json(), (req, res) => {
  const ticket = db.getTicketById(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  const att = db.getAttachmentByStoredName(req.params.storedName);
  if (!att || att.ticket_id !== ticket.id)
    return res.status(403).json({ error: 'Forbidden' });

  const page     = Math.max(1, parseInt(req.params.page, 10) || 1);
  const filePath = annotationFile(req.params.storedName, page);
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('[Annotate] Save error:', err);
    res.status(500).json({ error: 'Failed to save annotations' });
  }
});

module.exports = router;
