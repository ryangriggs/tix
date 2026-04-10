'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// GET /api/users/search?q=
router.get('/users/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json([]);

  // Admins and technicians see all users; others are scoped to their own org
  const scopeOrgId = (req.user.role === 'admin' || req.user.role === 'technician')
    ? null
    : (req.user.organization_id || null);

  const users = db.searchUsers(q, scopeOrgId);
  res.json(users.map(u => ({
    id:    u.id,
    email: u.email,
    name:  u.name  || null,
    org:   u.organization_name || null,
  })));
});

// GET /api/organizations/search?q=
router.get('/organizations/search', (req, res) => {
  const q    = (req.query.q || '').trim();
  const user = req.user;

  let orgs = db.searchOrganizations(q);

  if (user.role === 'technician') {
    // Technicians only see their assigned orgs
    const ids = new Set(user.techOrgIds || []);
    orgs = orgs.filter(o => ids.has(o.id));
  } else if (user.role !== 'admin') {
    // Regular users only see their own org
    orgs = user.organization_id
      ? orgs.filter(o => o.id === user.organization_id)
      : [];
  }

  res.json(orgs.map(o => ({ id: o.id, name: o.name })));
});

// GET /api/organizations/:id/locations?q= — admin/tech only (used by reply form autocomplete)
router.get('/organizations/:id/locations', (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'technician')
    return res.json([]);
  const id = parseInt(req.params.id, 10);
  const q  = (req.query.q || '').toLowerCase();
  let locs = db.getLocationsByOrg(id);
  if (q) locs = locs.filter(l => l.name.toLowerCase().includes(q));
  res.json(locs);
});

// GET /api/tickets/:id/poll — lightweight endpoint for ticket detail polling.
// Returns comment_count + updated_at so the client can detect new activity
// without fetching the full ticket page. Access-controlled same as the ticket route.
router.get('/tickets/:id/poll', (req, res) => {
  const ticket = db.getTicketById(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  const user = req.user;
  if (user.role !== 'admin') {
    // Must be a party — same rule as GET /tickets/:id
    if (!db.getUserTicketRole(ticket.id, user.id)) {
      // Technicians can also see tickets in their orgs
      const inOrgAccess = (user.role === 'technician' && ticket.organization_id &&
        (user.techOrgIds || []).includes(ticket.organization_id));
      const isSuperuser = user.isGroupSuperuser && ticket.organization_id &&
        (user.techOrgIds || []).includes(ticket.organization_id);
      if (!inOrgAccess && !isSuperuser) return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const count = db.getCommentCount(ticket.id);
  res.json({ comment_count: count, updated_at: ticket.updated_at });
});

module.exports = router;
