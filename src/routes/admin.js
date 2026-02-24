'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');

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

// GET /admin/organizations
router.get('/organizations', (req, res) => {
  const organizations = db.getAllOrganizations();
  res.render('admin/organizations', {
    title: 'Organizations',
    organizations,
    message: req.query.message || null,
  });
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

// GET /admin/settings
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Settings',
    defaultAssignee: db.getSetting('default_assignee_email') || '',
    message: req.query.message || null,
  });
});

// POST /admin/settings
router.post('/settings', (req, res) => {
  const email = (req.body.default_assignee_email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('admin/settings', {
      title: 'Settings',
      defaultAssignee: email,
      message: 'Invalid email address.',
    });
  }
  db.setSetting('default_assignee_email', email);
  res.redirect('/admin/settings?message=Settings+saved');
});

module.exports = router;
