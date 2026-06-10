'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const audit   = require('../services/audit');

const VIS_LEVEL  = { admin: 4, tech: 3, supervisor: 2, user: 1 };
const VIS_LABELS = { admin: 'Admin only', tech: 'Tech & above', supervisor: 'Supervisor & above', user: 'All users' };

function userNoteLevel(user) {
  if (user.role === 'admin')      return 4;
  if (user.role === 'technician') return 3;
  if (user.is_group_superuser)    return 2;
  return 1;
}

// Returns true only if this user should be able to see any notes for this org.
// Always 404 (not 403) on failure — avoids confirming that an org ID exists.
function canAccessOrg(user, orgId) {
  if (user.role === 'admin') return true;
  // techOrgIds covers both technicians and group superusers assigned to this org
  if (Array.isArray(user.techOrgIds) && user.techOrgIds.includes(orgId)) return true;
  // Regular user whose account is assigned to this org
  if (user.organization_id === orgId) return true;
  return false;
}

function parseId(str) {
  const n = parseInt(str, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /organizations/:id/notes
router.get('/:id/notes', (req, res) => {
  const orgId = parseId(req.params.id);
  const org   = orgId ? db.getOrganizationById(orgId) : null;
  if (!org || !canAccessOrg(req.user, org.id))
    return res.status(404).render('error', { title: '404', message: 'Not found.' });

  const level = userNoteLevel(req.user);
  const notes = db.getOrgNotes(org.id, level);

  res.render('orgnotes/index', {
    title: `${org.name} — Notes`,
    org,
    notes,
    userNoteLevel: level,
    VIS_LEVEL,
    VIS_LABELS,
  });
});

// POST /organizations/:id/notes — create
router.post('/:id/notes', (req, res) => {
  const orgId = parseId(req.params.id);
  const org   = orgId ? db.getOrganizationById(orgId) : null;
  if (!org || !canAccessOrg(req.user, org.id))
    return res.status(404).json({ error: 'Not found' });

  const level = userNoteLevel(req.user);
  if (level < 2) return res.status(403).json({ error: 'Forbidden' });

  const body       = (req.body.body || '').trim();
  const visibility = req.body.visibility;

  if (!body)                  return res.status(400).json({ error: 'Note body is required' });
  if (!VIS_LEVEL[visibility]) return res.status(400).json({ error: 'Invalid visibility' });
  if (VIS_LEVEL[visibility] > level)
    return res.status(403).json({ error: 'Cannot set visibility above your access level' });

  const info = db.addOrgNote(org.id, body, visibility, req.user.id);
  const note = db.getOrgNoteByIdWithUsers(info.lastInsertRowid);
  audit.log(req, `added note to org "${org.name}" (${visibility})`);

  res.json({ ok: true, note });
});

// POST /organizations/:id/notes/:noteId/update
router.post('/:id/notes/:noteId/update', (req, res) => {
  const orgId  = parseId(req.params.id);
  const noteId = parseId(req.params.noteId);
  if (!orgId || !noteId) return res.status(404).json({ error: 'Not found' });

  const org  = db.getOrganizationById(orgId);
  if (!org || !canAccessOrg(req.user, org.id))
    return res.status(404).json({ error: 'Not found' });

  const note = db.getOrgNoteById(noteId);
  if (!note || note.organization_id !== orgId)
    return res.status(404).json({ error: 'Note not found' });

  const level = userNoteLevel(req.user);
  // Require supervisor+ AND sufficient level for this note's visibility
  if (level < 2 || level < VIS_LEVEL[note.visibility])
    return res.status(403).json({ error: 'Forbidden' });

  const body       = (req.body.body || '').trim();
  const visibility = req.body.visibility || note.visibility;

  if (!body)                  return res.status(400).json({ error: 'Note body is required' });
  if (!VIS_LEVEL[visibility]) return res.status(400).json({ error: 'Invalid visibility' });
  if (VIS_LEVEL[visibility] > level)
    return res.status(403).json({ error: 'Cannot set visibility above your access level' });

  db.updateOrgNote(note.id, body, visibility, req.user.id);
  const updated = db.getOrgNoteByIdWithUsers(note.id);
  audit.log(req, `updated org note ${note.id} (org "${org.name}")`);

  res.json({ ok: true, note: updated });
});

// POST /organizations/:id/notes/:noteId/delete
router.post('/:id/notes/:noteId/delete', (req, res) => {
  const orgId  = parseId(req.params.id);
  const noteId = parseId(req.params.noteId);
  if (!orgId || !noteId) return res.status(404).json({ error: 'Not found' });

  const org = db.getOrganizationById(orgId);
  if (!org || !canAccessOrg(req.user, org.id))
    return res.status(404).json({ error: 'Not found' });

  const note = db.getOrgNoteById(noteId);
  if (!note || note.organization_id !== orgId)
    return res.status(404).json({ error: 'Note not found' });

  const level = userNoteLevel(req.user);
  // Require supervisor+ AND sufficient level for this note's visibility
  if (level < 2 || level < VIS_LEVEL[note.visibility])
    return res.status(403).json({ error: 'Forbidden' });

  db.deleteOrgNote(note.id);
  audit.log(req, `deleted org note ${note.id} (org "${org.name}")`);

  res.json({ ok: true });
});

module.exports = router;
