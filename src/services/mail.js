'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

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
          // Sender header lets Gmail honour a From != the authenticated account
          // (works for Google Workspace; personal Gmail requires a verified alias)
          ...(config.gmail.user ? [`Sender: ${config.gmail.user}`] : []),
          `To: ${Array.isArray(opts.to) ? opts.to.join(', ') : opts.to}`,
          `Subject: ${opts.subject}`,
          ...(opts.replyTo    ? [`Reply-To: ${opts.replyTo}`]         : []),
          ...(opts.messageId  ? [`Message-ID: ${opts.messageId}`]     : []),
          ...(opts.inReplyTo  ? [`In-Reply-To: ${opts.inReplyTo}`]    : []),
          ...(opts.references ? [`References: ${opts.references}`]    : []),
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
        return mg.messages.create(config.mailgun.domain, msg);
      }
    };
  }

  return _transport;
}

// Low-level send — all helpers funnel through here
async function send({ to, subject, html, text, messageId, inReplyTo, references, replyTo }) {
  const from = `Ticketing <${config.ticketEmail}>`;
  const transport = getTransport();

  if (config.mailTransport === 'mailgun') {
    // Mailgun REST wrapper expects flat options; headers are passed as h:* keys
    await transport.sendMail({ from, to, subject, html, text, messageId, inReplyTo, references, replyTo });
  } else if (config.mailTransport === 'gmail') {
    // Gmail transport handles all headers internally via raw RFC 2822 message
    await transport.sendMail({ from, to, subject, html, text, messageId, inReplyTo, references, replyTo });
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
        ...(inReplyTo  && { 'In-Reply-To': inReplyTo }),
        ...(references && { References: references }),
      },
    });
  }
}

// ============================================================
// Public helpers
// ============================================================

async function sendMagicLink(toEmail, magicLinkUrl, otp) {
  await send({
    to: toEmail,
    subject: 'Your login link',
    html: `
      <p>Click the link below to log in. It expires in 15 minutes.</p>
      <p><a href="${magicLinkUrl}">${magicLinkUrl}</a></p>
      <p>Or enter this code on the verification page: <strong style="font-size:1.4em;letter-spacing:0.1em">${otp}</strong></p>
      <p style="color:#888;font-size:.9em">If you did not request this, you can ignore it.</p>
    `,
    text: `Login link (expires 15 min): ${magicLinkUrl}\nOr enter code: ${otp}`,
  });
}

async function sendTicketNotification({ to, ticketSubject, body, ticketId, messageId, inReplyTo, references, replyToken }) {
  let replyTo;
  if (replyToken) {
    const mailDomain = config.ticketEmail.includes('@') ? config.ticketEmail.split('@')[1] : 'ticketing.local';
    const localPart  = config.ticketEmail.split('@')[0];
    replyTo = `Ticketing <${localPart}+${replyToken}@${mailDomain}>`;
  }

  const footer = `
    <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0">
    <p style="color:#666;font-size:.85em;margin:0">
      You can reply to this email to add a comment, or
      <a href="${config.appUrl}/tickets/${ticketId}">view ticket #${ticketId} online</a>.
    </p>
  `;
  const fullHtml = body + footer;

  const recipients = Array.isArray(to) ? to : [to];
  for (const email of recipients) {
    await send({
      to: email,
      subject: `[Ticket #${ticketId}] ${ticketSubject}`,
      html: fullHtml,
      text: fullHtml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      messageId,
      inReplyTo,
      references,
      replyTo,
    });
  }
}

async function sendDueReminder(email, ticket) {
  const dueDate = new Date(ticket.due_date * 1000).toLocaleDateString();
  let replyTo;
  if (ticket.reply_token) {
    const mailDomain = config.ticketEmail.includes('@') ? config.ticketEmail.split('@')[1] : 'ticketing.local';
    const localPart  = config.ticketEmail.split('@')[0];
    replyTo = `Ticketing <${localPart}+${ticket.reply_token}@${mailDomain}>`;
  }
  await send({
    to: email,
    subject: `[Ticket #${ticket.id}] Due date reminder`,
    html: `<p>Ticket <strong>#${ticket.id}: ${ticket.subject}</strong> is due on <strong>${dueDate}</strong>.</p>`,
    text: `Ticket #${ticket.id}: ${ticket.subject} is due on ${dueDate}.`,
    replyTo,
  });
}

module.exports = { send, sendMagicLink, sendTicketNotification, sendDueReminder };
