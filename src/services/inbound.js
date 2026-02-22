'use strict';

const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const db = require('../db');
const { sendTicketNotification } = require('./mail');
const sse = require('./sse');

// ============================================================
// Auto-response / bounce detection (RFC 3834 + common conventions)
// getHeader(name) — case-insensitive header lookup (returns string or falsy)
// ============================================================

function isAutoResponse(fromEmail, getHeader) {
  // Never process mail sent by our own ticketing address
  if (fromEmail === config.ticketEmail.trim().toLowerCase()) return true;

  // Standard bounce / daemon addresses
  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) return true;

  // RFC 3834 — Auto-Submitted: anything other than "no" means automated
  const autoSubmitted = (getHeader('auto-submitted') || '').toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  // Precedence: bulk / list / junk
  const precedence = (getHeader('precedence') || '').toLowerCase().trim();
  if (['bulk', 'list', 'junk'].includes(precedence)) return true;

  // Empty Return-Path (<>) is the RFC 5321 indicator for a bounce / NDR
  if ((getHeader('return-path') || '').trim() === '<>') return true;

  // Microsoft Exchange: if present on an inbound message it's an auto-response
  if (getHeader('x-auto-response-suppress')) return true;

  return false;
}

// Common patterns that appear in forwarded email bodies
const FORWARD_PATTERNS = [
  /---------- Forwarded message ---------/i,
  /Begin forwarded message:/i,
  /-----Original Message-----/i,
  /^\s*From:.*\n\s*Sent:/im,
];

function isForwarded(parsed) {
  const text = parsed.text || '';
  return FORWARD_PATTERNS.some(p => p.test(text));
}

// Try to pull an email address out of the forwarded body text
function extractForwardedSender(text) {
  const match = text.match(/From:\s+.*?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
  return match ? match[1].toLowerCase() : null;
}

// Remove empty block elements and collapse consecutive <br> tags.
// Runs iteratively so nested empty divs (e.g. <div><div><br></div></div>) are caught.
function cleanEmailHtml(html) {
  if (!html) return html;
  let result = html;
  let prev;
  do {
    prev = result;
    // Remove <div>/<p> that contain only whitespace and an optional single <br>
    result = result.replace(/<(div|p)(\s[^>]*)?>[ \t\r\n]*(<br\s*\/?>)?[ \t\r\n]*<\/(div|p)>/gi, '');
    // Collapse two or more consecutive <br> into one
    result = result.replace(/(<br\s*\/?>\s*){2,}/gi, '<br>');
  } while (result !== prev);
  return result.trim();
}

// Sanitize HTML from untrusted sources (email bodies)
function sanitizeBody(html, text) {
  if (html) {
    const sanitized = sanitizeHtml(html, {
      allowedTags: [
        ...sanitizeHtml.defaults.allowedTags,
        'h1', 'h2', 'h3', 'img', 'pre', 'del',
      ],
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    });
    return cleanEmailHtml(sanitized);
  }
  if (text) {
    const cleaned = text.replace(/\n{3,}/g, '\n\n');
    const escaped = cleaned
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;font-family:inherit">${escaped}</pre>`;
  }
  return '';
}

function getMailDomain() {
  return config.ticketEmail.includes('@')
    ? config.ticketEmail.split('@')[1]
    : 'ticketing.local';
}

// ============================================================
// Main entry point called by the SMTP server
// ============================================================

async function processInboundEmail(rawEmail) {
  const parsed = await simpleParser(rawEmail);

  const fromAddr = parsed.from?.value?.[0];
  if (!fromAddr?.address) {
    console.log('[Inbound] Ignoring email with no From address');
    return;
  }
  const fromEmail = fromAddr.address.toLowerCase();

  // Drop auto-responses and bounces before doing anything else
  if (isAutoResponse(fromEmail, name => parsed.headers?.get(name))) {
    console.log(`[Inbound] Auto-response/bounce from ${fromEmail} — ignoring`);
    return;
  }

  // --- Reply detection ---
  // Prefer In-Reply-To, then walk References, then fall back to subject tag.
  // Track whether we matched via subject tag — that path requires authorization.
  let existingTicketId = null;
  let subjectFallback   = false;

  if (parsed.inReplyTo) {
    existingTicketId = db.findTicketByMessageId(parsed.inReplyTo);
  }

  if (!existingTicketId && parsed.references) {
    const refs = Array.isArray(parsed.references) ? parsed.references : [parsed.references];
    for (const ref of refs) {
      existingTicketId = db.findTicketByMessageId(ref);
      if (existingTicketId) break;
    }
  }

  if (!existingTicketId && parsed.subject) {
    const m = parsed.subject.match(/\[Ticket\s*#(\d+)\]/i) || parsed.subject.match(/\[#(\d+)\]/i);
    if (m) { existingTicketId = parseInt(m[1], 10); subjectFallback = true; }
  }

  if (existingTicketId) {
    await handleReply(existingTicketId, fromEmail, parsed, subjectFallback);
  } else {
    await handleNewTicket(fromEmail, parsed);
  }
}

// ============================================================
// Reply to an existing ticket
// ============================================================

async function handleReply(ticketId, fromEmail, parsed, subjectFallback = false) {
  const ticket = db.getTicketById(ticketId);
  if (!ticket) {
    console.log(`[Inbound] Reply references unknown ticket #${ticketId} — creating new ticket instead`);
    await handleNewTicket(fromEmail, parsed);
    return;
  }

  const fromName = parsed.from?.value?.[0]?.name || '';
  const user = db.findOrCreateUser(fromEmail, fromName);

  // Subject-tag matches ([Ticket #N]) are only trusted if the sender is already
  // a party — otherwise anyone who knows a ticket number could post to it.
  // Message-ID matches (In-Reply-To / References) are always trusted because
  // the IDs are random, unguessable tokens.
  if (subjectFallback && !db.getUserTicketRole(ticketId, user.id)) {
    console.log(`[Inbound] Subject-tag reply from non-party ${fromEmail} to #${ticketId} — treating as new ticket`);
    await handleNewTicket(fromEmail, parsed);
    return;
  }

  // Add them as collaborator if not already a party
  if (!db.getUserTicketRole(ticketId, user.id)) {
    db.addParty(ticketId, user.id, 'collaborator');
  }

  const { prepared, cidMap } = prepareAttachments(parsed.attachments);
  const body = resolveCidReferences(sanitizeBody(parsed.html, parsed.text), cidMap);
  const comment = db.addComment(ticketId, user.id, body, true);
  commitAttachments(prepared, ticketId, comment.id);

  // Email all other parties
  const parties = db.getParties(ticketId);
  const notifyEmails = parties.filter(p => p.email !== fromEmail).map(p => p.email);

  if (notifyEmails.length) {
    const domain = getMailDomain();
    const msgId = `<ticket-${ticketId}-c${comment.id}-${Date.now()}@${domain}>`;
    db.recordEmailMessage(ticketId, msgId, 'out');

    await sendTicketNotification({
      to: notifyEmails,
      ticketSubject: ticket.subject,
      body: `<p><strong>${fromEmail}</strong> replied:</p>${body}`,
      ticketId,
      messageId: msgId,
      inReplyTo: `<ticket-${ticketId}@${domain}>`,
    });
  }

  // Push SSE update to connected clients who are parties
  sse.broadcast(db.getPartyUserIds(ticketId), { type: 'comment_added', ticketId, commentId: comment.id });

  console.log(`[Inbound] Comment added to ticket #${ticketId} from ${fromEmail}`);
}

// ============================================================
// New ticket from an inbound email
// ============================================================

async function handleNewTicket(fromEmail, parsed) {
  const fromName = parsed.from?.value?.[0]?.name || '';
  const senderUser = db.findOrCreateUser(fromEmail, fromName);

  // Strip Re:/Fwd: prefixes from subject
  let subject = (parsed.subject || '(No Subject)').replace(/^(Re|Fwd?|Rv):\s*/gi, '').trim();

  const { prepared, cidMap } = prepareAttachments(parsed.attachments);
  const body = resolveCidReferences(sanitizeBody(parsed.html, parsed.text), cidMap);
  const ticket = db.createTicket({ subject, body });

  // Sender is submitter (and an owner)
  db.addParty(ticket.id, senderUser.id, 'submitter');

  // If this looks like a forward, try to add the original sender too
  let originalSenderEmail = null;
  if (isForwarded(parsed)) {
    const origEmail = extractForwardedSender(parsed.text || '');
    if (origEmail && origEmail !== fromEmail) {
      const origUser = db.findOrCreateUser(origEmail);
      db.addParty(ticket.id, origUser.id, 'collaborator');
      originalSenderEmail = origEmail;
      console.log(`[Inbound] Forwarded email — added original sender ${origEmail} as collaborator`);
    }
  }

  // Assign to default assignee if configured
  const defaultEmail = config.defaultAssigneeEmail || db.getSetting('default_assignee_email');
  if (defaultEmail) {
    const assignee = db.findOrCreateUser(defaultEmail);
    if (!db.getUserTicketRole(ticket.id, assignee.id)) {
      db.addParty(ticket.id, assignee.id, 'owner');
    }
  }

  commitAttachments(prepared, ticket.id, null);

  // Record original email's Message-ID for later reply matching
  if (parsed.messageId) {
    db.recordEmailMessage(ticket.id, parsed.messageId, 'in');
  }

  // Send confirmation to sender
  const domain = getMailDomain();
  const outMsgId = `<ticket-${ticket.id}-${Date.now()}@${domain}>`;
  db.recordEmailMessage(ticket.id, outMsgId, 'out');

  await sendTicketNotification({
    to: fromEmail,
    ticketSubject: ticket.subject,
    body: `
      <p>Your ticket has been received and assigned ID <strong>#${ticket.id}</strong>.</p>`,
    ticketId: ticket.id,
    messageId: outMsgId,
  });

  // Notify original sender if this was a forwarded email
  if (originalSenderEmail) {
    await sendTicketNotification({
      to: originalSenderEmail,
      ticketSubject: ticket.subject,
      body: `
        <p>A ticket has been created on your behalf with ID <strong>#${ticket.id}</strong>.</p>`,
      ticketId: ticket.id,
      messageId: `<ticket-${ticket.id}-orig-${Date.now()}@${domain}>`,
    });
  }

  // Notify default assignee if they're different from the sender
  if (defaultEmail && defaultEmail.toLowerCase() !== fromEmail) {
    await sendTicketNotification({
      to: defaultEmail,
      ticketSubject: ticket.subject,
      body: `<p>New ticket <strong>#${ticket.id}</strong> from ${fromEmail}:</p>${body}`,
      ticketId: ticket.id,
      messageId: `<ticket-${ticket.id}-notify-${Date.now()}@${domain}>`,
    });
  }

  // Push SSE to all connected clients (admins see it immediately)
  sse.broadcastToAll({ type: 'ticket_created', ticketId: ticket.id });

  console.log(`[Inbound] Created ticket #${ticket.id} from ${fromEmail}`);
}

// ============================================================
// Helpers
// ============================================================

// Phase 1: write files to disk, build cid→storedName map.
// Returns { prepared: [...], cidMap: Map<cid, storedName> }
function prepareAttachments(attachments) {
  const cidMap = new Map();
  const prepared = [];
  for (const att of attachments || []) {
    if (!att.content) continue;
    const ext = path.extname(att.filename || '').toLowerCase().slice(0, 10);
    const storedName = `${uuidv4()}${ext}`;
    fs.writeFileSync(path.join(config.uploadsDir, storedName), att.content);
    prepared.push({
      originalName: att.filename || 'attachment',
      storedName,
      mimeType: att.contentType || 'application/octet-stream',
      size: att.size || att.content.length,
    });
    if (att.contentId) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      cidMap.set(cid, storedName);
    }
  }
  return { prepared, cidMap };
}

// Phase 2: save attachment records to the database.
function commitAttachments(prepared, ticketId, commentId) {
  for (const att of prepared) {
    db.addAttachment({
      ticketId,
      commentId,
      originalName: att.originalName,
      storedName: att.storedName,
      mimeType: att.mimeType,
      size: att.size,
    });
  }
}

// Replace cid: src references in HTML with served attachment URLs.
function resolveCidReferences(html, cidMap) {
  if (!cidMap.size || !html) return html;
  return html.replace(/src="cid:([^"]+)"/gi, (match, cid) => {
    const storedName = cidMap.get(cid);
    return storedName ? `src="/tickets/attachments/${storedName}"` : match;
  });
}

// ============================================================
// Mailgun webhook entry point
// Mailgun forward() sends individual parsed fields, not raw MIME.
// We reconstruct a parsed-like object and feed it into the same handlers.
// ============================================================

async function processMailgunWebhook(fields, files) {
  const fromEmail = (fields.sender || '').trim().toLowerCase();
  if (!fromEmail) {
    console.log('[Inbound/Mailgun] No sender field, ignoring');
    return;
  }

  // Parse the message-headers JSON array: [[name, value], ...]
  let headers = {};
  try {
    const headerArray = JSON.parse(fields['message-headers'] || '[]');
    for (const [name, value] of headerArray) {
      headers[name.toLowerCase()] = value;
    }
  } catch (_) {
    console.warn('[Inbound/Mailgun] Could not parse message-headers');
  }

  const messageId  = fields['Message-Id']  || headers['message-id']  || null;
  const inReplyTo  = headers['in-reply-to'] || null;
  const references = headers['references']
    ? headers['references'].trim().split(/\s+/)
    : [];

  // Map multer files → attachment shape that saveAttachments() expects
  const attachments = (files || [])
    .filter(f => f.fieldname.startsWith('attachment-'))
    .map(f => ({
      filename:    f.originalname,
      content:     f.buffer,
      contentType: f.mimetype,
      size:        f.size,
    }));

  // Extract display name from raw "Name <email>" or "email" From header
  const rawFrom = (fields.from || '').trim();
  const fromDisplayName = rawFrom.replace(/<[^>]+>/g, '').replace(/["']/g, '').trim();
  const fromName = fromDisplayName && fromDisplayName.toLowerCase() !== fromEmail ? fromDisplayName : '';

  const parsed = {
    from:        { value: [{ address: fromEmail, name: fromName }] },
    subject:     fields.subject || '(No Subject)',
    html:        fields['body-html']   || null,
    text:        fields['body-plain']  || null,
    messageId,
    inReplyTo,
    references,
    attachments,
  };

  // Drop auto-responses and bounces
  if (isAutoResponse(fromEmail, name => headers[name])) {
    console.log(`[Inbound/Mailgun] Auto-response/bounce from ${fromEmail} — ignoring`);
    return;
  }

  // Reply detection — same logic as processInboundEmail
  let existingTicketId = null;
  let subjectFallback   = false;

  if (inReplyTo) {
    existingTicketId = db.findTicketByMessageId(inReplyTo);
  }
  if (!existingTicketId) {
    for (const ref of references) {
      existingTicketId = db.findTicketByMessageId(ref);
      if (existingTicketId) break;
    }
  }
  if (!existingTicketId && parsed.subject) {
    const m = parsed.subject.match(/\[Ticket\s*#(\d+)\]/i) || parsed.subject.match(/\[#(\d+)\]/i);
    if (m) { existingTicketId = parseInt(m[1], 10); subjectFallback = true; }
  }

  if (existingTicketId) {
    await handleReply(existingTicketId, fromEmail, parsed, subjectFallback);
  } else {
    await handleNewTicket(fromEmail, parsed);
  }
}

module.exports = { processInboundEmail, processMailgunWebhook };
