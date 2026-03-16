'use strict';

const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../db');
const config = require('../config');
const audit = require('../services/audit');
const { ticketPrefix } = config;

// GET /reports
router.get('/', (req, res) => {
  res.render('reports/index', {
    title: 'Reports',
    enableBillableHours: config.enableBillableHours,
    enableLocation:      config.enableLocation,
  });
});

// GET /reports/billing.csv — admin only
router.get('/billing.csv', requireAdmin, (req, res) => {
  if (!config.enableBillableHours) return res.status(404).send('Billing report is disabled.');
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('from and to query parameters are required');

  const fromTs = Math.floor(new Date(from + 'T00:00:00').getTime() / 1000);
  const toTs   = Math.floor(new Date(to   + 'T23:59:59').getTime() / 1000);
  if (isNaN(fromTs) || isNaN(toTs)) return res.status(400).send('Invalid date format');

  const rows = db.getBillingReport(fromTs, toTs);
  console.log(`[Reports] Billing: from=${from}(${fromTs}) to=${to}(${toTs}), rows=${rows.length}`);
  audit.log(req, `ran Billing report (${from} to ${to})`);

  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;

  // One output row per (ticket, calendar date). Same-day comments are summed.
  // Use a Map keyed by "ticketId|YYYY-MM-DD" to preserve insertion order per ticket.
  const dayMap = new Map();
  for (const r of rows) {
    const dateStr = new Date(r.comment_ts * 1000).toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz
    const key     = `${r.id}|${dateStr}`;
    if (!dayMap.has(key)) {
      dayMap.set(key, { id: r.id, subject: r.subject, organization_name: r.organization_name, dateStr, hours: 0 });
    }
    dayMap.get(key).hours += r.billable_hours;
  }

  const header = 'Organization Name,Ticket Title,Billable Hours,Ticket Number,Date of Work';
  const lines  = [...dayMap.values()].map(e => [
    escape(e.organization_name || ''),
    escape(e.subject),
    e.hours,
    escape(`${ticketPrefix}${e.id}`),
    escape(e.dateStr),
  ].join(','));

  const csv = [header, ...lines].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="billing-${from}-to-${to}.csv"`);
  res.send(csv);
});

// GET /reports/travel.csv — admin only
router.get('/travel.csv', requireAdmin, (req, res) => {
  if (!config.enableLocation) return res.status(404).send('Travel report is disabled.');
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('from and to query parameters are required');

  const fromTs = Math.floor(new Date(from + 'T00:00:00').getTime() / 1000);
  const toTs   = Math.floor(new Date(to   + 'T23:59:59').getTime() / 1000);
  if (isNaN(fromTs) || isNaN(toTs)) return res.status(400).send('Invalid date format');

  const rows = db.getTravelReport(fromTs, toTs);
  console.log(`[Reports] Travel: from=${from}(${fromTs}) to=${to}(${toTs}), rows=${rows.length}`);
  audit.log(req, `ran Travel report (${from} to ${to})`);

  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;

  const header = 'Organization,Location,Number of Visits,Distance One Way (miles)';
  const lines  = rows.map(r => [
    escape(r.organization_name || ''),
    escape(r.location_name),
    r.visit_count,
    r.distance_miles,
  ].join(','));

  const csv = [header, ...lines].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="travel-${from}-to-${to}.csv"`);
  res.send(csv);
});

module.exports = router;
