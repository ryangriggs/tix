'use strict';

const fs = require('fs');
const config = require('../config');

function getIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : (req.ip || '—');
}

function write(ip, email, ticketId, action) {
  if (!config.auditLog) return;
  const ts     = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const ticket = ticketId ? `#${ticketId}` : '—';
  const line   = `${ts} | ${ip} | ${email || '—'} | ${ticket} | ${action}\n`;
  fs.appendFile(config.auditLog, line, err => {
    if (err) console.error('[Audit] Write failed:', err.message);
  });
}

// For HTTP request context — extracts email + IP from req
function log(req, action, ticketId = null) {
  write(getIp(req), req.user?.email || '—', ticketId, action);
}

// For inbound email context — no HTTP request available
function logEmail(fromEmail, action, ticketId = null) {
  write('email', fromEmail, ticketId, action);
}

module.exports = { log, logEmail };
