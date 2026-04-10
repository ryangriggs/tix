'use strict';

const fs        = require('fs');
const path      = require('path');
const ejs       = require('ejs');
const crypto    = require('crypto');
const nodemailer = require('nodemailer');
const config = require('../config');
const db     = require('../db');

// ============================================================
// Unsubscribe token helpers (used by mail + unsubscribe route)
// ============================================================
function makeUnsubToken(replyToken, email) {
  const payload = Buffer.from(JSON.stringify({ r: replyToken, e: email })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwtSecret)
    .update('unsub:' + payload).digest('base64url').slice(0, 16);
  return payload + '.' + sig;
}

function parseUnsubToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.jwtSecret)
    .update('unsub:' + payload).digest('base64url').slice(0, 16);
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { return null; }
}

function logEmail(to, subject, error = null) {
  if (!config.emailLog) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const recipient = Array.isArray(to) ? to.join(', ') : to;
  const line = error
    ? `${ts} | [ERROR] ${recipient} | ${subject} | ${error}\n`
    : `${ts} | ${recipient} | ${subject}\n`;
  try {
    fs.appendFileSync(config.emailLog, line, 'utf8');
  } catch (err) {
    console.error('[Mail] Failed to write email log:', err.message);
  }
}

const TEMPLATE_DIR = path.join(__dirname, '../../views/emails');

function renderEmail(template, data) {
  return ejs.renderFile(
    path.join(TEMPLATE_DIR, `${template}.ejs`),
    { siteName: config.siteName, appUrl: config.appUrl, ticketPrefix: config.ticketPrefix, ...data },
  );
}

// Lazily initialised transport (allows config to be fully loaded first)
let _transport = null;

function getTransport() {
  if (_transport) return _transport;

  if (config.mailTransport === 'smtp') {
    // SMTP relay (e.g. Google Workspace smtp-relay.gmail.com)
    // port 587 → STARTTLS, port 465 → implicit TLS
    _transport = nodemailer.createTransport({
      host:       config.smtpRelay.host,
      port:       config.smtpRelay.port,
      secure:     config.smtpRelay.port === 465,
      requireTLS: true,
      auth: {
        user: config.smtpRelay.user,
        pass: config.smtpRelay.pass,
      },
    });
  } else if (config.mailTransport === 'gmail') {
    // Gmail API via OAuth2 — no SMTP port required, ~2,000 emails/day (Workspace)
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      config.gmail.clientId,
      config.gmail.clientSecret,
    );
    oauth2Client.setCredentials({ refresh_token: config.gmail.refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    _transport = {
      async sendMail(opts) {
        const boundary = `tix_${Date.now()}`;
        const lines = [
          `From: ${opts.from}`,
          `To: ${Array.isArray(opts.to) ? opts.to.join(', ') : opts.to}`,
          `Subject: ${opts.subject}`,
          ...(opts.replyTo    ? [`Reply-To: ${opts.replyTo}`]         : []),
          ...(opts.messageId  ? [`Message-ID: ${opts.messageId}`]     : []),
          ...(opts.inReplyTo  ? [`In-Reply-To: ${opts.inReplyTo}`]    : []),
          ...(opts.references     ? [`References: ${opts.references}`]                              : []),
          ...(opts.unsubscribeUrl ? [`List-Unsubscribe: <${opts.unsubscribeUrl}>`]                 : []),
          ...(opts.unsubscribeUrl ? ['List-Unsubscribe-Post: List-Unsubscribe=One-Click']          : []),
          'Auto-Submitted: auto-generated',
          'Precedence: bulk',
          'X-Auto-Response-Suppress: All',
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          opts.text || '',
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          '',
          opts.html || '',
          `--${boundary}--`,
        ];
        const raw = Buffer.from(lines.join('\r\n'))
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        return gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      }
    };
  } else if (config.mailTransport === 'resend') {
    // Resend REST API — uses Node 18+ native fetch, no extra package needed
    function _resendBody(opts) {
      return {
        from:     opts.from,
        to:       Array.isArray(opts.to) ? opts.to : [opts.to],
        subject:  opts.subject,
        html:     opts.html   || undefined,
        text:     opts.text   || undefined,
        reply_to: opts.replyTo || undefined,
        headers: {
          'Auto-Submitted':           'auto-generated',
          'Precedence':               'bulk',
          'X-Auto-Response-Suppress': 'All',
          ...(opts.messageId     && { 'Message-ID':        opts.messageId }),
          ...(opts.inReplyTo     && { 'In-Reply-To':       opts.inReplyTo }),
          ...(opts.references    && { 'References':         opts.references }),
          ...(opts.unsubscribeUrl && { 'List-Unsubscribe': `<${opts.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }),
        },
      };
    }
    async function _resendFetch(url, body) {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${config.resend.apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Resend API error ${res.status}: ${err.message || JSON.stringify(err)}`);
      }
      return res.json();
    }
    _transport = {
      sendMail:      opts       => _resendFetch('https://api.resend.com/emails',       _resendBody(opts)),
      sendMailBatch: optsArray  => _resendFetch('https://api.resend.com/emails/batch', optsArray.map(_resendBody)),
    };
  } else {
    // Mailgun REST API (default for production)
    const Mailgun  = require('mailgun.js');
    const FormData = require('form-data');
    const mg = new Mailgun(FormData).client({ username: 'api', key: config.mailgun.apiKey });

    // Wrap in the same sendMail interface as nodemailer
    _transport = {
      async sendMail(opts) {
        const msg = {
          from:    opts.from,
          to:      Array.isArray(opts.to) ? opts.to : [opts.to],
          subject: opts.subject,
          html:    opts.html,
          text:    opts.text,
        };
        if (opts.messageId)  msg['h:Message-Id']  = opts.messageId;
        if (opts.inReplyTo)  msg['h:In-Reply-To'] = opts.inReplyTo;
        if (opts.references) msg['h:References']  = opts.references;
        if (opts.replyTo)    msg['h:Reply-To']    = opts.replyTo;
        msg['h:Auto-Submitted']           = 'auto-generated';
        msg['h:Precedence']               = 'bulk';
        msg['h:X-Auto-Response-Suppress'] = 'All';
        if (opts.unsubscribeUrl) {
          msg['h:List-Unsubscribe']      = `<${opts.unsubscribeUrl}>`;
          msg['h:List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
        }
        return mg.messages.create(config.mailgun.domain, msg);
      }
    };
  }

  return _transport;
}

// ============================================================
// Send queue — serialises all outbound sends with a configurable
// inter-message delay, preventing rate-limit errors (e.g. Resend
// allows 2 req/sec; set mail_queue_delay_ms to 600 to stay under).
// ============================================================
const _queue = [];
let _draining = false;

async function _drainQueue() {
  if (_draining) return;
  _draining = true;
  try {
    while (_queue.length > 0) {
      const opts = _queue.shift();
      try   { await _doSend(opts); }
      catch  { /* already logged inside _doSend */ }
      const delay = config.mailQueueDelayMs;
      if (delay > 0 && _queue.length > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  } finally {
    _draining = false;
  }
}

// Internal: actually delivers one message — called only by _drainQueue
async function _doSend({ to, subject, html, text, messageId, inReplyTo, references, replyTo, unsubscribeUrl }) {
  const from = `${config.mailFromName} <${config.ticketEmail}>`;
  const transport = getTransport();
  try {
    if (config.mailTransport === 'mailgun' || config.mailTransport === 'resend' || config.mailTransport === 'gmail') {
      await transport.sendMail({ from, to, subject, html, text, messageId, inReplyTo, references, replyTo, unsubscribeUrl });
    } else {
      // nodemailer SMTP relay
      await transport.sendMail({
        from, to, subject, html, text,
        messageId,
        replyTo,
        headers: {
          'Auto-Submitted':           'auto-generated',
          'Precedence':               'bulk',
          'X-Auto-Response-Suppress': 'All',
          ...(inReplyTo      && { 'In-Reply-To':          inReplyTo }),
          ...(references     && { References:              references }),
          ...(unsubscribeUrl && { 'List-Unsubscribe':     `<${unsubscribeUrl}>` }),
          ...(unsubscribeUrl && { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }),
        },
      });
    }
    logEmail(to, subject);
  } catch (err) {
    logEmail(to, subject, err.message || String(err));
    throw err;
  }
}

// Public: enqueues a message and returns immediately (fire-and-forget).
// Delivery happens asynchronously; errors are written to the email log.
function send(opts) {
  _queue.push(opts);
  _drainQueue();
}

// ============================================================
// Public helpers
// ============================================================

async function sendMagicLink(toEmail, magicLinkUrl, otp) {
  const html = await renderEmail('login', { magicLinkUrl, otp });
  await send({
    to: toEmail,
    subject: 'Your login link',
    html,
    text: `Login link (expires 15 min): ${magicLinkUrl}\nOr enter code: ${otp}`,
  });
}

async function sendTicketNotification({ to, ticketSubject, body, ticketId, messageId, inReplyTo, references, replyToken }) {
  let replyTo;
  if (replyToken) {
    const mailDomain = config.ticketEmail.includes('@') ? config.ticketEmail.split('@')[1] : 'tix.local';
    const localPart  = config.ticketEmail.split('@')[0];
    replyTo = `${config.mailFromName} <${localPart}+${replyToken}@${mailDomain}>`;
  }

  const html    = await renderEmail('ticket-notification', { body, ticketId, ticketSubject });
  const text    = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const subject = `${ticketSubject} [Ticket #${config.ticketPrefix}${ticketId}]`;

  const recipients = db.filterNotificationRecipients(Array.isArray(to) ? to : [to]);
  if (!recipients.length) return;
  const transport  = getTransport();

  // Per-recipient unsubscribe URL (signed token, no DB lookup needed)
  const unsubUrl = replyToken
    ? email => `${config.appUrl}/unsubscribe?t=${makeUnsubToken(replyToken, email)}`
    : () => null;

  // Resend batch: send all recipients in one API call to avoid the 2 msg/sec rate limit
  if (config.mailTransport === 'resend' && recipients.length > 1) {
    const from  = `${config.mailFromName} <${config.ticketEmail}>`;
    const batch = recipients.map(email => ({ from, to: email, subject, html, text, messageId, inReplyTo, references, replyTo, unsubscribeUrl: unsubUrl(email) }));
    try {
      await transport.sendMailBatch(batch);
      for (const email of recipients) logEmail(email, subject);
    } catch (err) {
      for (const email of recipients) logEmail(email, subject, err.message || String(err));
      throw err;
    }
    return;
  }

  for (const email of recipients) {
    send({ to: email, subject, html, text, messageId, inReplyTo, references, replyTo, unsubscribeUrl: unsubUrl(email) });
  }
}

async function sendDueReminder(email, ticket) {
  if (!db.filterNotificationRecipients([email]).length) return;
  const dueDate = new Date(ticket.due_date * 1000).toLocaleDateString();
  let replyTo;
  if (ticket.reply_token) {
    const mailDomain = config.ticketEmail.includes('@') ? config.ticketEmail.split('@')[1] : 'tix.local';
    const localPart  = config.ticketEmail.split('@')[0];
    replyTo = `${config.mailFromName} <${localPart}+${ticket.reply_token}@${mailDomain}>`;
  }
  const html = await renderEmail('due-reminder', { ticket, dueDate });
  await send({
    to: email,
    subject: `Due date reminder [Ticket #${config.ticketPrefix}${ticket.id}]`,
    html,
    text: `Ticket #${config.ticketPrefix}${ticket.id}: ${ticket.subject} is due on ${dueDate}.`,
    replyTo,
  });
}

async function sendInactivityReminder(email, ticket, hours) {
  if (!db.filterNotificationRecipients([email]).length) return;
  let replyTo;
  if (ticket.reply_token) {
    const mailDomain = config.ticketEmail.includes('@') ? config.ticketEmail.split('@')[1] : 'tix.local';
    const localPart  = config.ticketEmail.split('@')[0];
    replyTo = `${config.mailFromName} <${localPart}+${ticket.reply_token}@${mailDomain}>`;
  }
  const html = await renderEmail('inactivity-reminder', { ticket, hours });
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  await send({
    to:      email,
    subject: `Reminder: no recent activity [Ticket #${config.ticketPrefix}${ticket.id}]`,
    html,
    text:    `Ticket #${config.ticketPrefix}${ticket.id} "${ticket.subject}" has had no activity for ${hoursLabel}. Reply to add a comment.`,
    replyTo,
  });
}

function resetMailTransport() { _transport = null; }

async function sendAdminNewUserNotification(user, source) {
  const adminEmail = config.adminEmail || db.getSetting('admin_email');
  if (!adminEmail) return;

  const nameRow = user.name ? `<li><strong>Name:</strong> ${user.name}</li>` : '';
  const html = `<p>A new user account has been created:</p>
<ul>
  <li><strong>Email:</strong> ${user.email}</li>
  ${nameRow}
  <li><strong>Source:</strong> ${source}</li>
</ul>
<p><a href="${config.appUrl}/admin/users">View all users</a></p>`;

  const text = [
    'A new user account has been created.',
    `Email:  ${user.email}`,
    user.name ? `Name:   ${user.name}` : null,
    `Source: ${source}`,
    `Users:  ${config.appUrl}/admin/users`,
  ].filter(Boolean).join('\n');

  send({ to: adminEmail, subject: `New user: ${user.email}`, html, text });
}

module.exports = { send, sendMagicLink, sendTicketNotification, sendDueReminder, sendInactivityReminder, sendAdminNewUserNotification, resetMailTransport, makeUnsubToken, parseUnsubToken, logEmail };
