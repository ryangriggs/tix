'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/', (req, res) => {
  const stats = db.getDashboardStats();
  res.render('dashboard/index', { title: 'Dashboard', stats });
});

module.exports = router;
