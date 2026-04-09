'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/', (req, res) => {
  const stats = db.getDashboardStats({
    userId:          req.user.id,
    userRole:        req.user.role,
    userOrgId:       req.user.organization_id || null,
    userIsSuperuser: req.user.isGroupSuperuser,
    userTechOrgIds:  req.user.techOrgIds || [],
  });
  res.render('dashboard/index', { title: 'Dashboard', stats });
});

module.exports = router;
