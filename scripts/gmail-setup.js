'use strict';

/**
 * One-time setup: obtain a Gmail API refresh token.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com/
 *   2. Create a project (or select existing), enable "Gmail API"
 *   3. OAuth consent screen → External (or Internal for Workspace) → add scope:
 *        https://www.googleapis.com/auth/gmail.send
 *   4. Credentials → Create OAuth client ID → Desktop app
 *   5. Copy the Client ID and Client Secret into your .env:
 *        GMAIL_CLIENT_ID=...
 *        GMAIL_CLIENT_SECRET=...
 *        GMAIL_USER=tickets@yourdomain.com
 *
 * Then run:
 *   npm run gmail-setup
 *
 * Paste the refresh token printed at the end into your .env as GMAIL_REFRESH_TOKEN.
 * The refresh token does not expire unless revoked or unused for 6+ months.
 */

require('dotenv').config();
const { google } = require('googleapis');
const readline   = require('readline');

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob', // out-of-band: Google shows the code on screen
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt:      'consent', // force refresh_token to be returned even if previously authorized
  scope:       ['https://www.googleapis.com/auth/gmail.send'],
});

console.log('\n--- Gmail API Setup ---\n');
console.log('1. Open this URL in your browser:\n');
console.log('  ', authUrl);
console.log('\n2. Sign in with the Google account that will send emails.');
console.log('   (This should be the same address as GMAIL_USER in your .env)\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('3. Paste the authorisation code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    if (!tokens.refresh_token) {
      console.error('\nNo refresh token returned. This usually means the account already');
      console.error('authorised this app without "prompt: consent". Revoke access at');
      console.error('https://myaccount.google.com/permissions and run this script again.');
      process.exit(1);
    }
    console.log('\nSuccess! Add this to your .env:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nAlso set MAIL_TRANSPORT=gmail in your .env.\n');
  } catch (err) {
    console.error('\nFailed to exchange code for tokens:', err.message);
    process.exit(1);
  }
});
