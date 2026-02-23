'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

// Lazily initialised transport (allows config to be fully loaded first)
let _transport = null;

function getTransport() {
  if (_transport) return _transport;

  if (config.isDev) {
    // MailHog - catches all outbound emails in a local web UI
    _transport = nodemailer.createTransport({
      host: config.mailhog.host,
      port: config.mailhog.port,
      secure: false,
      ignoreTLS: true,
    });
  } else {
    // Mailgun via their SMTP relay
    // Uses nodemailer so the send() interface stays identical
    const Mailgun = require('mailgun.js');
    const FormData = require('form-data');
    const mg = new Mailgun(FormData).client({ username: 'api', key: config.mailgun.apiKey });

    // Wrap Mailgun REST API in the same interface as nodemailer
    _transport = {
      async sendMail(opts) {
        const msg = {
          from: opts.from,
          to: Array.isArray(opts.to) ? opts.to : [opts.to],
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
        };
        if (opts.messageId)  msg['h:Message-Id']  = opts.messageId;
        if (opts.inReplyTo)  msg['h:In-Reply-To'] = opts.inReplyTo;
        if (opts.references) msg['h:References']  = opts.references;
        if (opts.replyTo)    msg['h:Reply-To']    = opts.replyTo;
        // Prevent auto-replies and bounce loops
        msg['h:Auto-Submitted']          = 'auto-generated';
        msg['h:Precedence']              = 'bulk';
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

  if (config.isDev) {
    // nodemailer format
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
  } else {
    await transport.sendMail({ from, to, subject, html, text, messageId, inReplyTo, references, replyTo });
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
