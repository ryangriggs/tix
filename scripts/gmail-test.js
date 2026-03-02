'use strict';

/**
 * Test the Gmail API transport by sending a test email.
 * Reads credentials from .env — ensure MAIL_TRANSPORT=gmail and all
 * GMAIL_* variables are set before running.
 *
 * Usage:
 *   npm run gmail-test -- recipient@example.com
 */

require('dotenv').config();
const { google } = require('googleapis');

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER } = process.env;
const to = process.argv[2];

if (!to) {
  console.error('Usage: npm run gmail-test -- recipient@example.com');
  process.exit(1);
}

const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'GMAIL_USER']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing required .env variables:', missing.join(', '));
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

const subject  = 'Tix Gmail API test';
const bodyText = 'This is a test email from the tix Gmail API transport. If you received this, it is working correctly.';
const bodyHtml = `<p>${bodyText}</p>`;
const boundary = `tix_test_${Date.now()}`;

const lines = [
  `From: Tix <${GMAIL_USER}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  'MIME-Version: 1.0',
  `Content-Type: multipart/alternative; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/plain; charset=UTF-8',
  '',
  bodyText,
  `--${boundary}`,
  'Content-Type: text/html; charset=UTF-8',
  '',
  bodyHtml,
  `--${boundary}--`,
];

const raw = Buffer.from(lines.join('\r\n'))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

console.log(`Sending test email from ${GMAIL_USER} to ${to}...`);

gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  .then(() => console.log('Success! Check your inbox.'))
  .catch(err => {
    console.error('Failed:', err.message);
    if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  });
