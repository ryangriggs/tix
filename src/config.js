'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  smtpPort: parseInt(process.env.SMTP_PORT || '25', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiry: '30d',
  secureSession: process.env.SECURE_SESSION === 'true',

  otpMaxTries: parseInt(process.env.OTP_MAX_TRIES || '5', 10),
  otpLockoutSeconds: parseInt(process.env.OTP_LOCKOUT_SECONDS || '300', 10),

  // Inbound email rate limiting — max messages per minute per sender.
  // 0 disables the limit entirely.
  emailRateLimitPerTicket:  parseInt(process.env.EMAIL_RATE_LIMIT_PER_TICKET  || '10', 10),
  emailRateLimitNewTickets: parseInt(process.env.EMAIL_RATE_LIMIT_NEW_TICKETS || '3',  10),

  // Login rate limiting (in-process, resets on restart)
  loginRateLimitPerIpPerHour:    parseInt(process.env.LOGIN_RATE_LIMIT_IP    || '20', 10),
  loginRateLimitPerEmailPerMin:  parseInt(process.env.LOGIN_RATE_LIMIT_EMAIL || '5',  10),

  // Mailgun inbound webhook — enable or disable the /inbound/mailgun POST endpoint.
  // Automatically defaults to true when mail_transport is mailgun.
  mailgunWebhookEnabled: false, // set dynamically via applySettings

  // Comma-separated extension lists (without leading dot, case-insensitive).
  // Whitelist: only these extensions are accepted. Empty = allow all.
  // Blacklist: always rejected, even if in the whitelist.
  uploadMaxSizeMb: parseInt(process.env.UPLOAD_MAX_SIZE_MB || '25', 10),
  uploadAllowedExtensions: process.env.UPLOAD_ALLOWED_EXTENSIONS
    || 'jpg,jpeg,png,gif,webp,bmp,pdf,txt,md,csv,zip,doc,docx,xls,xlsx,ppt,pptx',
  uploadBlockedExtensions: process.env.UPLOAD_BLOCKED_EXTENSIONS || '',

  siteName: process.env.SITE_NAME || '✅ Tix',

  ticketEmail:        process.env.TICKET_EMAIL        || 'tickets@example.com',
  ticketSilentEmail:  process.env.TICKET_SILENT_EMAIL || '',
  ticketPrefix:       process.env.TICKET_PREFIX       || '',
  mailFromName:  process.env.MAIL_FROM_NAME  || 'Ticketing',
  defaultAssigneeEmail: process.env.DEFAULT_ASSIGNEE_EMAIL || null,
  adminEmail: process.env.ADMIN_EMAIL || null,
  notifyEmailSubmitter: true,
  notifyEmailStatusChange: true,
  enableBillableHours: true,
  enableLocation: true,

  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),

  dataDir: process.env.DATA_DIR || '/app/data',
  backupDir: process.env.BACKUP_DIR || '',
  uploadsDir:     process.env.UPLOADS_DIR     || '/app/data/uploads',
  annotationsDir: process.env.ANNOTATIONS_DIR || '/app/data/annotations',
  annotationExtensions: 'pdf,jpg,jpeg,gif,png,svg',
  emailLog:  process.env.EMAIL_LOG  || '',
  userLog:   process.env.USER_LOG   || '',
  auditLog:  process.env.AUDIT_LOG  || '',

  mailgun: {
    apiKey: process.env.MAILGUN_API_KEY || '',
    domain: process.env.MAILGUN_DOMAIN || '',
  },

  // Outbound mail transport: 'mailgun' (default), 'smtp', 'gmail', or 'resend'
  mailTransport: process.env.MAIL_TRANSPORT || 'mailgun',

  // Milliseconds to wait between outgoing emails (0 = no delay).
  // Set to 500–600 when using Resend to stay under their 2 msg/sec limit.
  mailQueueDelayMs: parseInt(process.env.MAIL_QUEUE_DELAY_MS || '0', 10),

  // Resend API — used when MAIL_TRANSPORT=resend
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
  },

  // SMTP relay — used when MAIL_TRANSPORT=smtp
  smtpRelay: {
    host: process.env.SMTP_RELAY_HOST || '',
    port: parseInt(process.env.SMTP_RELAY_PORT || '587', 10),
    user: process.env.SMTP_RELAY_USER || '',
    pass: process.env.SMTP_RELAY_PASS || '',
  },

  // Gmail API — used when MAIL_TRANSPORT=gmail
  // Run `npm run gmail-setup` to obtain GMAIL_REFRESH_TOKEN
  gmail: {
    clientId:     process.env.GMAIL_CLIENT_ID     || '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN || '',
    user:         process.env.GMAIL_USER          || '',
  },

};

// Apply DB-stored settings on top of config (called after DB is ready).
// Uses INSERT OR IGNORE seeding so .env values serve as one-time defaults.
function applySettings(map) {
  if ('app_url'                in map) config.appUrl                = (map.app_url || '').replace(/\/$/, '') || config.appUrl;
  if ('ticket_email'           in map) config.ticketEmail           = map.ticket_email           || config.ticketEmail;
  if ('ticket_silent_email'    in map) config.ticketSilentEmail     = map.ticket_silent_email    || '';
  if ('ticket_prefix'          in map) config.ticketPrefix          = map.ticket_prefix          || '';
  if ('mail_from_name'         in map) config.mailFromName          = map.mail_from_name         || config.mailFromName;
  if ('admin_email'            in map) config.adminEmail            = map.admin_email            || null;
  if ('site_name'              in map) config.siteName              = map.site_name              || config.siteName;
  if ('default_assignee_email'   in map) config.defaultAssigneeEmail  = map.default_assignee_email || null;
  if ('notify_email_submitter'    in map) config.notifyEmailSubmitter    = map.notify_email_submitter    !== 'false';
  if ('notify_email_status_change' in map) config.notifyEmailStatusChange = map.notify_email_status_change !== 'false';
  if ('enable_billable_hours'    in map) config.enableBillableHours   = map.enable_billable_hours   !== 'false';
  if ('enable_location'          in map) config.enableLocation         = map.enable_location          !== 'false';

  if ('jwt_secret'          in map) config.jwtSecret         = map.jwt_secret          || config.jwtSecret;
  if ('secure_session'      in map) config.secureSession      = map.secure_session      === 'true';
  if ('otp_max_tries'       in map) config.otpMaxTries        = parseInt(map.otp_max_tries,       10) || config.otpMaxTries;
  if ('otp_lockout_seconds' in map) config.otpLockoutSeconds  = parseInt(map.otp_lockout_seconds, 10) || config.otpLockoutSeconds;

  if ('mail_transport'     in map) config.mailTransport    = map.mail_transport     || config.mailTransport;
  if ('mail_queue_delay_ms' in map) config.mailQueueDelayMs = parseInt(map.mail_queue_delay_ms, 10) || 0;

  if ('mailgun_api_key' in map) config.mailgun.apiKey  = map.mailgun_api_key || '';
  if ('mailgun_domain'  in map) config.mailgun.domain  = map.mailgun_domain  || '';

  if ('smtp_relay_host' in map) config.smtpRelay.host = map.smtp_relay_host || '';
  if ('smtp_relay_port' in map) config.smtpRelay.port = parseInt(map.smtp_relay_port, 10) || 587;
  if ('smtp_relay_user' in map) config.smtpRelay.user = map.smtp_relay_user || '';
  if ('smtp_relay_pass' in map) config.smtpRelay.pass = map.smtp_relay_pass || '';

  if ('gmail_client_id'     in map) config.gmail.clientId     = map.gmail_client_id     || '';
  if ('gmail_client_secret' in map) config.gmail.clientSecret = map.gmail_client_secret || '';
  if ('gmail_refresh_token' in map) config.gmail.refreshToken = map.gmail_refresh_token || '';
  if ('gmail_user'          in map) config.gmail.user         = map.gmail_user          || '';

  if ('resend_api_key' in map) config.resend.apiKey = map.resend_api_key || '';

  if ('annotation_extensions'       in map) config.annotationExtensions      = map.annotation_extensions       || '';
  if ('upload_max_size_mb'          in map) config.uploadMaxSizeMb           = parseInt(map.upload_max_size_mb, 10) || 25;
  if ('upload_allowed_extensions'   in map) config.uploadAllowedExtensions   = map.upload_allowed_extensions   || config.uploadAllowedExtensions;
  if ('upload_blocked_extensions'   in map) config.uploadBlockedExtensions   = map.upload_blocked_extensions   || '';
  if ('email_rate_limit_per_ticket'  in map) config.emailRateLimitPerTicket  = parseInt(map.email_rate_limit_per_ticket,  10) || 0;
  if ('email_rate_limit_new_tickets' in map) config.emailRateLimitNewTickets = parseInt(map.email_rate_limit_new_tickets, 10) || 0;

  if ('login_rate_limit_ip'    in map) config.loginRateLimitPerIpPerHour   = parseInt(map.login_rate_limit_ip,    10) || 20;
  if ('login_rate_limit_email' in map) config.loginRateLimitPerEmailPerMin = parseInt(map.login_rate_limit_email, 10) || 5;

  if ('mailgun_webhook_enabled' in map) {
    config.mailgunWebhookEnabled = map.mailgun_webhook_enabled === 'true';
  } else {
    // Auto-enable when transport is mailgun
    config.mailgunWebhookEnabled = config.mailTransport === 'mailgun';
  }
}

module.exports = config;
module.exports.applySettings = applySettings;
