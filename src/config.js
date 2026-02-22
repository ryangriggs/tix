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

  mailhog: {
    host: process.env.MAILHOG_HOST || 'mailhog',
    port: parseInt(process.env.MAILHOG_PORT || '1025', 10),
  },
};

module.exports = config;
