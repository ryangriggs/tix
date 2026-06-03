'use strict';

const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const db = require('../db');
const config = require('../config');
const audit = require('../services/audit');

// Convert a YYYY-MM-DD date string to UTC timestamp bounds for a given IANA timezone.
// Uses noon-UTC offset calculation to avoid DST boundary ambiguity.
function localDayToUtcRange(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Sample the offset at noon UTC — DST transitions virtually never happen at noon.
  const noonUtcMs = Date.UTC(y, m - 1, d, 12, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(noonUtcMs));
  const get = type => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  // "24" can appear for midnight in some Intl implementations
  const localNoonMs = Date.UTC(y, m - 1, d, get('hour') % 24, get('minute'), get('second'));
  const offsetMs = noonUtcMs - localNoonMs; // positive = west of UTC (e.g. US), negative = east
  return {
    fromTs: Math.floor((Date.UTC(y, m - 1, d,  0,  0,  0) + offsetMs) / 1000),
    toTs:   Math.floor((Date.UTC(y, m - 1, d, 23, 59, 59) + offsetMs) / 1000),
  };
}

function tzAbbr(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || tz;
  } catch (_) { return tz; }
}

// GET /reports
router.get('/', (req, res) => {
  const organizations = (req.user && req.user.role === 'admin') ? db.getAllOrganizations() : [];
  const tz = config.timezone || 'UTC';
  res.render('reports/index', {
    title: 'Reports',
    enableBillableHours: config.enableBillableHours,
    enableLocation:      config.enableLocation,
    organizations,
    siteTimezone:     tz,
    siteTimezoneAbbr: tzAbbr(tz),
  });
});

// GET /reports/billing.csv — admin only
router.get('/billing.csv', requireAdmin, (req, res) => {
  if (!config.enableBillableHours) return res.status(404).send('Billing report is disabled.');
  const { from, to, org } = req.query;
  if (!from || !to) return res.status(400).send('from and to query parameters are required');

  const tz = config.timezone || 'UTC';
  let fromTs, toTs;
  try {
    ({ fromTs } = localDayToUtcRange(from, tz));
    ({ toTs }   = localDayToUtcRange(to,   tz));
  } catch (_) { return res.status(400).send('Invalid date format'); }

  let orgFilter = null;
  if (org) {
    orgFilter = org.split(',').map(v => v.trim()).filter(Boolean);
    for (const v of orgFilter) {
      if (v !== 'unassigned' && !/^\d+$/.test(v)) return res.status(400).send('Invalid org filter');
    }
  }

  const rows = db.getBillingReport(fromTs, toTs, orgFilter);
  const orgDesc = orgFilter ? ` orgs=[${orgFilter.join(',')}]` : '';
  console.log(`[Reports] Billing: from=${from}(${fromTs}) to=${to}(${toTs}) tz=${tz}${orgDesc}, rows=${rows.length}`);
  audit.log(req, `ran Billing report (${from} to ${to}, tz=${tz}${orgDesc})`);

  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;

  // One output row per (ticket, calendar date). Same-day comments are summed.
  // Use a Map keyed by "ticketId|YYYY-MM-DD" to preserve insertion order per ticket.
  const dayMap = new Map();
  for (const r of rows) {
    // Group by the company timezone's local date, not the server's system timezone
    const dateStr = new Date(r.comment_ts * 1000).toLocaleDateString('en-CA', { timeZone: tz });
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
    escape(`${config.ticketPrefix}${e.id}`),
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
