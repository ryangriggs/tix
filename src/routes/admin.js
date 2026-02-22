'use strict';

const express = require('express');
const router = express.Router();

const db = require('../db');

// GET /admin/users
router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.render('admin/users', { title: 'User Management', users, message: req.query.message || null });
});

// POST /admin/users/:id/role
router.post('/users/:id/role', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = req.body.role;
  if (!['admin', 'user'].includes(role)) return res.redirect('/admin/users');

  // Prevent removing your own admin role
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
