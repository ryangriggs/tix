'use strict';

const router = require('express').Router();
const multer = require('multer');
const { processMailgunWebhook } = require('../services/inbound');

// Use memory storage so attachment buffers are available in req.files
const upload = multer({ storage: multer.memoryStorage() });

// POST /inbound/mailgun
// Configure in Mailgun dashboard: forward("http://YOUR_IP:3000/inbound/mailgun")

router.post('/mailgun', upload.any(), async (req, res) => {
  // Acknowledge immediately — Mailgun will retry if it doesn't get a 200 quickly
  res.sendStatus(200);

  // Debug: log received field names (remove once confirmed working)
  console.log('[Inbound/Mailgun] Fields received:', Object.keys(req.body));
  if (req.files?.length) {
    console.log('[Inbound/Mailgun] Files received:', req.files.map(f => f.fieldname));
  }

  try {
    await processMailgunWebhook(req.body, req.files);
  } catch (err) {
    console.error('[Inbound/Mailgun] Error processing webhook:', err);
  }
});

module.exports = router;
