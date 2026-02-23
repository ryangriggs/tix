'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  smtpPort: parseInt(process.env.SMTP_PORT || '25', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiry: '30d',
  secureSession: process.env.SECURE_SESSION === 'true',

  otpMaxTries: parseInt(process.env.OTP_MAX_TRIES || '5', 10),
  otpLockoutSeconds: parseInt(process.env.OTP_LOCKOUT_SECONDS || '300', 10),

  // Inbound email rate limiting — max messages per minute per sender.
  // 0 disables the limit entirely.
  emailRateLimitPerTicket:  parseInt(process.env.EMAIL_RATE_LIMIT_PER_TICKET  || '10', 10),
  emailRateLimitNewTickets: parseInt(process.env.EMAIL_RATE_LIMIT_NEW_TICKETS || '3',  10),

  // Comma-separated extension lists (without leading dot, case-insensitive).
  // Whitelist: only these extensions are accepted. Empty = allow all.
  // Blacklist: always rejected, even if in the whitelist.
  uploadAllowedExtensions: process.env.UPLOAD_ALLOWED_EXTENSIONS
    || 'jpg,jpeg,png,gif,webp,bmp,pdf,txt,md,csv,zip,doc,docx,xls,xlsx,ppt,pptx',
  uploadBlockedExtensions: process.env.UPLOAD_BLOCKED_EXTENSIONS || '',

  ticketEmail: process.env.TICKET_EMAIL || 'tickets@example.com',
  defaultAssigneeEmail: process.env.DEFAULT_ASSIGNEE_EMAIL || null,
  adminEmail: process.env.ADMIN_EMAIL || null,

  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),

  dataDir: process.env.DATA_DIR || '/app/data',
  uploadsDir: process.env.UPLOADS_DIR || '/app/data/uploads',

  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY || '',
    domain: process.env.MAILGUN_DOMAIN || '',
  },

  // Outbound mail transport: 'mailgun' (default) or 'smtp'
  mailTransport: process.env.MAIL_TRANSPORT || 'mailgun',

  // SMTP relay — used when MAIL_TRANSPORT=smtp
  smtpRelay: {
    host: process.env.SMTP_RELAY_HOST || 'smtp-relay.gmail.com',
    port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
    user: process.env.SMTP_RELAY_USER || '',
    pass: process.env.SMTP_RELAY_PASS || '',
  },

};

module.exports = config;
