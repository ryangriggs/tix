'use strict';

const router = require('express').Router();
const multer = require('multer');
const config = require('../config');
const { processMailgunWebhook } = require('../services/inbound');

// Use memory storage so attachment buffers are available in req.files
const upload = multer({ storage: multer.memoryStorage() });

// POST /inbound/mailgun
// Configure in Mailgun dashboard: forward("http://YOUR_IP:3000/inbound/mailgun")
// Disabled unless mailgun_webhook_enabled=true in Settings (auto-enabled when transport=mailgun).

router.post('/mailgun', (req, res, next) => {
  if (!config.mailgunWebhookEnabled) return res.sendStatus(404);
  next();
}, upload.any(), async (req, res) => {
  // Acknowledge immediately — Mailgun will retry if it doesn't get a 200 quickly
  res.sendStatus(200);

  try {
    await processMailgunWebhook(req.body, req.files);
  } catch (err) {
    console.error('[Inbound/Mailgun] Error processing webhook:', err);
  }
});

module.exports = router;
