'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { parseUnsubToken } = require('../services/mail');

function resolve(req) {
  const token = (req.query.t || req.body.t || '').trim();
  if (!token) return null;
  const data = parseUnsubToken(token);
  if (!data || !data.r || !data.e) return null;
  const ticket = db.getTicketByReplyToken(data.r);
  if (!ticket) return null;
  return { ticket, email: data.e, token };
}

// GET /unsubscribe?t=TOKEN  — show confirmation page
router.get('/', (req, res) => {
  const ctx = resolve(req);
  if (!ctx) return res.status(400).send(page('Invalid or expired unsubscribe link.', false));
  res.send(page(
    `You will be removed from notifications for ticket <strong>#${ctx.ticket.id}: ${esc(ctx.ticket.subject)}</strong>.`,
    true,
    ctx.token,
  ));
});

// POST /unsubscribe  — one-click (RFC 8058) or confirmation form submit
router.post('/', express.urlencoded({ extended: false }), (req, res) => {
  const ctx = resolve(req);
  if (!ctx) return res.status(400).send(page('Invalid or expired unsubscribe link.', false));
  db.disablePartyNotifications(ctx.ticket.id, ctx.email);
  res.send(page(`You have been unsubscribed from notifications for ticket <strong>#${ctx.ticket.id}: ${esc(ctx.ticket.subject)}</strong>.`, false));
});

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function page(message, showButton, token) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>
  body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:2rem 2.5rem;max-width:480px;width:90%;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.08)}
  h1{font-size:1.1rem;color:#1f2937;margin:0 0 1rem}
  p{color:#4b5563;font-size:.95rem;margin:0 0 1.5rem;line-height:1.5}
  .btn{background:#2563eb;color:#fff;border:none;border-radius:5px;padding:.6rem 1.5rem;font-size:.95rem;cursor:pointer}
  .btn:hover{background:#1d4ed8}
</style></head><body>
<div class="card">
  <h1>Email Notifications</h1>
  <p>${message}</p>
  ${showButton ? `<form method="POST"><input type="hidden" name="t" value="${esc(token)}"><button class="btn" type="submit">Confirm Unsubscribe</button></form>` : ''}
</div></body></html>`;
}

module.exports = router;
