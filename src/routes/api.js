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
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json([]);

  const orgs = db.searchOrganizations(q);
  res.json(orgs.map(o => ({ id: o.id, name: o.name })));
});

module.exports = router;
