'use strict';

const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const sanitizeHtml = require('sanitize-html');

const config = require('../config');
const db = require('../db');
const { sendTicketNotification, sendAdminNewUserNotification, logEmail } = require('./mail');
const audit = require('./audit');

// ============================================================
// Auto-response / bounce detection (RFC 3834 + common conventions)
// getHeader(name) — case-insensitive header lookup (returns string or falsy)
// ============================================================

// mailparser can return strings, structured objects, or arrays for header values.
// Normalise whatever it gives us into a plain string.
function headerString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return headerString(val[0]);
  if (typeof val === 'object') return typeof val.text === 'string' ? val.text : String(val);
  return String(val);
}

function isAutoResponse(fromEmail, getHeader) {
  // Never process mail sent by our own ticketing address
  if (fromEmail === config.ticketEmail.trim().toLowerCase()) return true;

  // Standard bounce / daemon addresses
  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) return true;

  // RFC 3834 — Auto-Submitted: anything other than "no" means automated
  const autoSubmitted = getHeader('auto-submitted').toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  // Precedence: bulk / list / junk
  const precedence = getHeader('precedence').toLowerCase().trim();
  if (['bulk', 'list', 'junk'].includes(precedence)) return true;

  // Empty Return-Path (<>) is the RFC 5321 indicator for a bounce / NDR
  if (getHeader('return-path').trim() === '<>') return true;

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

// Strip HTML tags and decode basic entities to produce a plain-text string.
// Used when an email has no text/plain part.
function htmlToPlaintext(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Convert an email body to safe display HTML by treating everything as plain text.
// This eliminates tracking pixels, external CSS, scripts, and all other HTML attack vectors.
function formatEmailAsPlaintext(parsed) {
  const raw = parsed.text || (parsed.html ? htmlToPlaintext(parsed.html) : '');
  if (!raw.trim()) return '';

  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  const escaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return '<p>' + escaped
    .split('\n\n')
    .map(p => p.trim().replace(/\n/g, '<br>'))
    .filter(Boolean)
    .join('</p><p>') + '</p>';
}

// Sanitize an email HTML body and resolve cid: inline image references.
// Returns safe HTML suitable for storing/displaying in the ticket system.
// Falls back to plaintext rendering if no usable HTML is present.
function formatEmailBody(parsed, cidMap) {
  if (!parsed.html || !parsed.html.trim()) {
    return formatEmailAsPlaintext(parsed);
  }

  // Replace cid: image references with our stored attachment URLs before sanitizing
  let html = parsed.html;
  if (cidMap && cidMap.size > 0) {
    html = html.replace(/\bsrc=["'](cid:([^"'>\s]+))["']/gi, (match, fullCid, cid) => {
      const storedName = cidMap.get(cid) || cidMap.get(cid.replace(/^<|>$/g, ''));
      if (storedName) {
        return `src="/tickets/attachments/${encodeURIComponent(storedName)}"`;
      }
      return match; // leave unknown cid refs; sanitizer will strip them
    });
  }

  const clean = sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'b', 'i', 'strong', 'em', 'u', 's', 'strike',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'div', 'span',
    ],
    allowedAttributes: {
      a:   ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      td:  ['colspan', 'rowspan'],
      th:  ['colspan', 'rowspan'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', '/'],
    allowedSchemesByTag: {
      img: ['http', 'https', '/'],
    },
    // Strip src attributes that are still cid: references (unresolved inline images)
    // and any external tracking pixel URLs we shouldn't load
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      img: (tagName, attribs) => {
        const src = attribs.src || '';
        // Drop cid: references that weren't resolved (no attachment match)
        if (src.startsWith('cid:')) return { tagName: 'span', attribs: {} };
        return { tagName, attribs };
      },
    },
    // Limit style attributes to safe visual properties only
    allowedStyles: {
      '*': {
        color:            [/.*/],
        'background-color': [/.*/],
        'font-size':      [/.*/],
        'font-weight':    [/.*/],
        'font-style':     [/.*/],
        'text-decoration':[/.*/],
        'text-align':     [/.*/],
        width:            [/.*/],
        height:           [/.*/],
        'max-width':      [/.*/],
        padding:          [/.*/],
        margin:           [/.*/],
      },
    },
  });

  if (!clean.trim()) return formatEmailAsPlaintext(parsed);
  return clean;
}

function getMailDomain() {
  return config.ticketEmail.includes('@')
    ? config.ticketEmail.split('@')[1]
    : 'tix.local';
}

// Returns true if the address belongs to the ticket system itself
// (exact match, or local+token variant like tickets+abc123@domain)
function isTicketSystemAddress(email) {
  const domain    = getMailDomain();
  const localPart = config.ticketEmail.split('@')[0].toLowerCase();
  const lc        = email.toLowerCase();
  if (lc === config.ticketEmail.toLowerCase()) return true;
  const at = lc.lastIndexOf('@');
  if (at === -1) return false;
  const addrLocal  = lc.slice(0, at);
  const addrDomain = lc.slice(at + 1);
  return addrDomain === domain &&
    (addrLocal === localPart || addrLocal.startsWith(localPart + '+'));
}

// Parse a RFC 2822 address list string (e.g. Mailgun To/CC fields) into
// the same { address, name } shape that mailparser produces.
function parseAddressString(str) {
  if (!str) return [];
  return str.split(',').flatMap(part => {
    part = part.trim();
    const angled = part.match(/<([^>]+)>/);
    if (angled) {
      const name = part.slice(0, part.indexOf('<')).replace(/["']/g, '').trim();
      return [{ address: angled[1].toLowerCase(), name }];
    }
    if (part.includes('@')) return [{ address: part.toLowerCase(), name: '' }];
    return [];
  });
}

// ============================================================
// In-memory sliding-window rate limiter
// ============================================================

const _rateLimits = new Map();

function isRateLimited(key, maxPerMinute) {
  if (!maxPerMinute) return false;
  const now = Date.now();
  const recent = (_rateLimits.get(key) || []).filter(t => now - t < 60_000);
  if (recent.length >= maxPerMinute) {
    _rateLimits.set(key, recent);
    return true;
  }
  recent.push(now);
  _rateLimits.set(key, recent);
  return false;
}

// Prune stale entries every 5 minutes so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of _rateLimits) {
    const recent = timestamps.filter(t => now - t < 60_000);
    if (recent.length === 0) _rateLimits.delete(key);
    else _rateLimits.set(key, recent);
  }
}, 5 * 60_000).unref();

// ============================================================
// Reply-token extraction
// Looks for tickets+{token}@domain in a list of address objects
// (the shape mailparser returns for To/CC headers).
// ============================================================

function extractReplyToken(addressValues) {
  const domain    = getMailDomain();
  const localPart = config.ticketEmail.split('@')[0].toLowerCase();
  const prefix    = localPart + '+';

  for (const addr of addressValues || []) {
    const email      = (addr.address || '').toLowerCase();
    const atIdx      = email.lastIndexOf('@');
    if (atIdx === -1) continue;
    const addrLocal  = email.slice(0, atIdx);
    const addrDomain = email.slice(atIdx + 1);
    if (addrDomain === domain && addrLocal.startsWith(prefix)) {
      const token = addrLocal.slice(prefix.length);
      if (token) return token;
    }
  }
  return null;
}

// ============================================================
// Main entry point called by the SMTP server
// ============================================================

async function processInboundEmail(rawEmail) {
  let fromEmail = null;
  try {
    const parsed = await simpleParser(rawEmail);

    const fromAddr = parsed.from?.value?.[0];
    if (!fromAddr?.address) {
      console.log('[Inbound] Ignoring email with no From address');
      return;
    }
    fromEmail = fromAddr.address.toLowerCase();

    // Drop auto-responses and bounces before doing anything else
    if (isAutoResponse(fromEmail, name => headerString(parsed.headers?.get(name)))) {
      const subject = parsed.subject || '(no subject)';
      console.log(`[Inbound] Auto-response/bounce from ${fromEmail} — ignoring`);
      logEmail(`[BOUNCE] ${fromEmail}`, subject);
      return;
    }

    // --- Reply detection ---
    // 1. Reply-To token in To/CC (survives forwarding — primary mechanism)
    // 2. In-Reply-To / References Message-ID lookup (legacy fallback)
    // 3. Subject tag [Ticket #N] — only trusted for existing parties
    let existingTicketId = null;
    let subjectFallback  = false;

    const toAddrs = [
      ...(parsed.to?.value  || []),
      ...(parsed.cc?.value  || []),
    ];
    const replyToken = extractReplyToken(toAddrs);
    if (replyToken) {
      existingTicketId = db.findTicketByReplyToken(replyToken);
    }

    if (!existingTicketId && parsed.inReplyTo) {
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
      const pfx = config.ticketPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = parsed.subject.match(new RegExp(`\\[Ticket\\s*#${pfx}(\\d+)\\]`, 'i'))
             || parsed.subject.match(new RegExp(`\\[#${pfx}(\\d+)\\]`, 'i'));
      if (m) { existingTicketId = parseInt(m[1], 10); subjectFallback = true; }
    }

    const isSilent = !!(config.ticketSilentEmail &&
      toAddrs.some(a => (a.address || '').toLowerCase() === config.ticketSilentEmail.toLowerCase()));

    if (existingTicketId) {
      await handleReply(existingTicketId, fromEmail, parsed, subjectFallback);
    } else {
      await handleNewTicket(fromEmail, parsed, { silent: isSilent });
    }

  } catch (err) {
    console.error(`[Inbound] Failed to process email${fromEmail ? ` from ${fromEmail}` : ''}: ${err.message}`, err);
    throw err; // propagate to SMTP layer for protocol-level rejection
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
  if (user._isNew) sendAdminNewUserNotification(user, 'Inbound email reply').catch(console.error);

  if (user.blocked_at) {
    console.log(`[Inbound] Ignoring email from blocked user ${fromEmail}`);
    return;
  }

  if (isRateLimited(`reply:${fromEmail}:${ticketId}`, config.emailRateLimitPerTicket)) {
    console.log(`[Inbound] Rate limit exceeded for ${fromEmail} replying to ticket #${ticketId}`);
    return;
  }

  // Subject-tag matches ([Ticket #N]) are only trusted if the sender is already
  // a party — otherwise anyone who knows a ticket number could post to it.
  // Reply-token and Message-ID matches are always trusted because the tokens are
  // unguessable; the token also survives email forwarding.
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
  const body = formatEmailBody(parsed, cidMap);
  const comment = db.addComment(ticketId, user.id, body, true);
  commitAttachments(prepared, ticketId, comment.id);

  // Auto-reopen closed tickets when a reply arrives
  const wasReopened = ticket.status === 'closed';
  if (wasReopened) {
    db.updateTicket(ticketId, { status: 'open', close_date: null });
    console.log(`[Inbound] Ticket #${ticketId} reopened by reply from ${fromEmail}`);
  }

  // Email all other parties
  const parties = db.getParties(ticketId);
  const notifyEmails = parties.filter(p => p.email !== fromEmail).map(p => p.email);

  if (notifyEmails.length) {
    const domain = getMailDomain();
    const msgId = `<ticket-${ticketId}-c${comment.id}-${Date.now()}@${domain}>`;
    db.recordEmailMessage(ticketId, msgId, 'out');

    const notifyBody = wasReopened
      ? `<p><strong>${fromEmail}</strong> replied and reopened this ticket:</p>${body}`
      : `<p><strong>${fromEmail}</strong> replied:</p>${body}`;

    await sendTicketNotification({
      to: notifyEmails,
      ticketSubject: ticket.subject,
      body: notifyBody,
      ticketId,
      messageId: msgId,
      inReplyTo: `<ticket-${ticketId}@${domain}>`,
      replyToken: ticket.reply_token,
    });
  }

  audit.logEmail(fromEmail, wasReopened ? 'replied and reopened ticket' : 'added comment via email', ticketId);
  console.log(`[Inbound] Comment added to ticket #${ticketId} from ${fromEmail}`);
}

// ============================================================
// New ticket from an inbound email
// ============================================================

async function handleNewTicket(fromEmail, parsed, { silent = false } = {}) {
  const fromName = parsed.from?.value?.[0]?.name || '';
  const senderUser = db.findOrCreateUser(fromEmail, fromName);
  if (senderUser._isNew) sendAdminNewUserNotification(senderUser, 'Inbound email — new ticket').catch(console.error);

  if (senderUser.blocked_at) {
    console.log(`[Inbound] Ignoring email from blocked user ${fromEmail}`);
    return;
  }

  if (isRateLimited(`new:${fromEmail}`, config.emailRateLimitNewTickets)) {
    console.log(`[Inbound] Rate limit exceeded for new tickets from ${fromEmail}`);
    return;
  }

  // Strip Re:/Fwd: prefixes from subject
  let subject = (parsed.subject || '(No Subject)').replace(/^(Re|Fwd?|Rv):\s*/gi, '').trim();

  const { prepared, cidMap } = prepareAttachments(parsed.attachments);
  const body = formatEmailBody(parsed, cidMap);
  const ticket = db.createTicket({ subject, body, organizationId: senderUser.organization_id || null });

  // Sender is submitter
  db.addParty(ticket.id, senderUser.id, 'submitter');

  // Add To:/CC: recipients as collaborators.
  // This handles the "reply to a user and CC the ticket system" workflow —
  // the To: party gets added and notified so they're part of the thread.
  const toAndCc = [
    ...(parsed.to?.value  || []),
    ...(parsed.cc?.value  || []),
  ];
  const ccCollaboratorEmails = [];
  for (const addr of toAndCc) {
    const email = (addr.address || '').toLowerCase();
    if (!email) continue;
    if (isTicketSystemAddress(email)) continue;  // skip ourselves
    if (config.ticketSilentEmail && email === config.ticketSilentEmail.toLowerCase()) continue; // skip silent address
    if (email === fromEmail) continue;            // skip sender (already submitter)
    const u = db.findOrCreateUser(email, addr.name || null);
    if (u._isNew) sendAdminNewUserNotification(u, 'Inbound email — CC recipient on new ticket').catch(console.error);
    if (u.blocked_at) continue;
    if (!db.getUserTicketRole(ticket.id, u.id)) {
      db.addParty(ticket.id, u.id, 'collaborator');
      ccCollaboratorEmails.push(email);
      console.log(`[Inbound] Added To/CC recipient ${email} as collaborator on ticket #${ticket.id}`);
    }
  }

  // If this looks like a forward, try to add the original sender too
  let originalSenderEmail = null;
  if (isForwarded(parsed)) {
    const origEmail = extractForwardedSender(parsed.text || '');
    if (origEmail && origEmail !== fromEmail) {
      const origUser = db.findOrCreateUser(origEmail);
      if (origUser._isNew) sendAdminNewUserNotification(origUser, 'Inbound email — forwarded sender').catch(console.error);
      db.addParty(ticket.id, origUser.id, 'collaborator');
      originalSenderEmail = origEmail;
      console.log(`[Inbound] Forwarded email — added original sender ${origEmail} as collaborator`);
    }
  }

  // Assign to default assignee as owner — always, regardless of whether they
  // appear in From/To/CC (overrides submitter or collaborator role if needed).
  const defaultEmail = config.defaultAssigneeEmail || db.getSetting('default_assignee_email');
  if (defaultEmail) {
    const assignee = db.findOrCreateUser(defaultEmail);
    if (assignee._isNew) sendAdminNewUserNotification(assignee, 'Default assignee config — user did not exist').catch(console.error);
    db.addParty(ticket.id, assignee.id, 'owner');
  }

  // Silent mode: all parties added above, but notifications disabled and no emails sent.
  if (silent) {
    db.disableAllPartyNotifications(ticket.id);
    commitAttachments(prepared, ticket.id, null);
    if (parsed.messageId) db.recordEmailMessage(ticket.id, parsed.messageId, 'in');
    audit.logEmail(fromEmail, 'created ticket via email (silent)', ticket.id);
    console.log(`[Inbound] Created silent ticket #${ticket.id} from ${fromEmail}`);
    return;
  }

  commitAttachments(prepared, ticket.id, null);

  // Record original email's Message-ID for later reply matching
  if (parsed.messageId) {
    db.recordEmailMessage(ticket.id, parsed.messageId, 'in');
  }

  // Send confirmation to sender (if enabled in settings)
  const domain = getMailDomain();
  const outMsgId = `<ticket-${ticket.id}-${Date.now()}@${domain}>`;
  db.recordEmailMessage(ticket.id, outMsgId, 'out');

  if (config.notifyEmailSubmitter) {
    await sendTicketNotification({
      to: fromEmail,
      ticketSubject: ticket.subject,
      body: `
        <p>Your ticket has been received and assigned ID <strong>#${config.ticketPrefix}${ticket.id}</strong>.</p>
        <p>Ticket Subject: <strong>${ticket.subject}</strong></p>
        `,
      ticketId: ticket.id,
      messageId: outMsgId,
      replyToken: ticket.reply_token,
    });
  }

  // Notify original sender if this was a forwarded email
  if (originalSenderEmail) {
    await sendTicketNotification({
      to: originalSenderEmail,
      ticketSubject: ticket.subject,
      body: `
        <p>A ticket has been created on your behalf with ID <strong>#${config.ticketPrefix}${ticket.id}</strong>.</p>
        <p>Ticket Subject: <strong>${ticket.subject}</strong></p>
        <p>Created by: <strong>${fromEmail}</strong><p>
        <p>${body}</p>
        `,
      ticketId: ticket.id,
      messageId: `<ticket-${ticket.id}-orig-${Date.now()}@${domain}>`,
      replyToken: ticket.reply_token,
    });
  }

  // Notify default assignee if they're different from the sender
  if (defaultEmail && defaultEmail.toLowerCase() !== fromEmail) {
    await sendTicketNotification({
      to: defaultEmail,
      ticketSubject: ticket.subject,
      body: `<p>New ticket <strong>#${config.ticketPrefix}${ticket.id}</strong> from ${fromEmail}:</p>${body}`,
      ticketId: ticket.id,
      messageId: `<ticket-${ticket.id}-notify-${Date.now()}@${domain}>`,
      replyToken: ticket.reply_token,
    });
  }

  // Notify To/CC collaborators (skip any already notified above)
  const alreadyNotified = new Set([
    fromEmail,
    originalSenderEmail,
    defaultEmail?.toLowerCase(),
  ].filter(Boolean));
  for (const email of ccCollaboratorEmails) {
    if (alreadyNotified.has(email)) continue;
    await sendTicketNotification({
      to: email,
      ticketSubject: ticket.subject,
      body: `
        <p>You have been added to ticket <strong>#${config.ticketPrefix}${ticket.id}</strong>.</p>
        <p>Ticket Subject: <strong>${ticket.subject}</strong></p>
        <p>${body}</p>
        `,
      ticketId: ticket.id,
      messageId: `<ticket-${ticket.id}-cc-${Date.now()}@${domain}>`,
      replyToken: ticket.reply_token,
    });
  }

  audit.logEmail(fromEmail, 'created ticket via email', ticket.id);
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
    to:          { value: parseAddressString(fields.To || fields.to || '') },
    cc:          { value: parseAddressString(fields.Cc || fields.cc || '') },
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

  // Reply detection — same order as processInboundEmail
  let existingTicketId = null;
  let subjectFallback  = false;

  // 1. Reply-token: Mailgun provides the envelope RCPT TO as `recipient`
  const recipientAddr = (fields.recipient || fields.to || '').trim();
  const replyToken = extractReplyToken([{ address: recipientAddr }]);
  if (replyToken) {
    existingTicketId = db.findTicketByReplyToken(replyToken);
  }

  if (!existingTicketId && inReplyTo) {
    existingTicketId = db.findTicketByMessageId(inReplyTo);
  }
  if (!existingTicketId) {
    for (const ref of references) {
      existingTicketId = db.findTicketByMessageId(ref);
      if (existingTicketId) break;
    }
  }
  if (!existingTicketId && parsed.subject) {
    const pfx = config.ticketPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = parsed.subject.match(new RegExp(`\\[Ticket\\s*#${pfx}(\\d+)\\]`, 'i'))
           || parsed.subject.match(new RegExp(`\\[#${pfx}(\\d+)\\]`, 'i'));
    if (m) { existingTicketId = parseInt(m[1], 10); subjectFallback = true; }
  }

  const allAddrs = [
    ...(parsed.to?.value || []),
    ...(parsed.cc?.value || []),
    { address: fields.recipient || '' },
  ];
  const isSilent = !!(config.ticketSilentEmail &&
    allAddrs.some(a => (a.address || '').toLowerCase() === config.ticketSilentEmail.toLowerCase()));

  if (existingTicketId) {
    await handleReply(existingTicketId, fromEmail, parsed, subjectFallback);
  } else {
    await handleNewTicket(fromEmail, parsed, { silent: isSilent });
  }
}

module.exports = { processInboundEmail, processMailgunWebhook };
