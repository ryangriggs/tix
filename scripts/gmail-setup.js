'use strict';

/**
 * One-time setup: obtain a Gmail API refresh token.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com/
 *   2. Create a project (or select existing), enable "Gmail API"
 *   3. OAuth consent screen → fill in app name and support email → Save
 *      Scopes → Add scope → paste: https://www.googleapis.com/auth/gmail.send → Update
 *   4. Credentials → Create Credentials → OAuth client ID → Desktop app
 *   5. Copy the Client ID and Client Secret into your .env:
 *        GMAIL_CLIENT_ID=...
 *        GMAIL_CLIENT_SECRET=...
 *        GMAIL_USER=tickets@yourdomain.com
 *        MAIL_TRANSPORT=gmail
 *
 * Then run:
 *   npm run gmail-setup
 *
 * A browser window will open. Sign in and approve access. The refresh token
 * is printed to the terminal — add it to your .env as GMAIL_REFRESH_TOKEN.
 * The refresh token does not expire unless revoked or unused for 6+ months.
 */

require('dotenv').config();
const { google } = require('googleapis');
const http       = require('http');
const { exec }   = require('child_process');
const fs         = require('fs');
const path       = require('path');

const ENV_PATH = path.resolve(__dirname, '../.env');

function writeRefreshToken(token) {
  let contents = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  if (/^GMAIL_REFRESH_TOKEN=.*/m.test(contents)) {
    contents = contents.replace(/^GMAIL_REFRESH_TOKEN=.*/m, `GMAIL_REFRESH_TOKEN=${token}`);
  } else {
    contents += `\nGMAIL_REFRESH_TOKEN=${token}\n`;
  }
  fs.writeFileSync(ENV_PATH, contents);
}

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const PORT         = 9999;
const REDIRECT_URI = `http://localhost:${PORT}`;

const oauth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt:      'consent', // force refresh_token even if previously authorized
  scope:       ['https://www.googleapis.com/auth/gmail.send'],
});

const server = http.createServer(async (req, res) => {
  const url   = new URL(req.url, REDIRECT_URI);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
    server.close();
    console.error(`\nAuthorisation denied: ${error}`);
    process.exit(1);
  }

  if (!code) {
    res.end('<h2>Waiting for authorisation...</h2>');
    return;
  }

  res.end('<h2>Success! You can close this tab and return to the terminal.</h2>');
  server.close();

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\nNo refresh token returned. The account may have previously');
      console.error('authorised this app. Revoke access at');
      console.error('https://myaccount.google.com/permissions and run this script again.');
      process.exit(1);
    }
    writeRefreshToken(tokens.refresh_token);
    console.log(`\nSuccess! GMAIL_REFRESH_TOKEN has been written to .env`);
    console.log('Also ensure MAIL_TRANSPORT=gmail is set in your .env.\n');
  } catch (err) {
    console.error('\nFailed to exchange code for tokens:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n--- Gmail API Setup ---\n');
  console.log('Opening browser for Google authorisation...');
  console.log('If the browser does not open, visit this URL manually:\n');
  console.log(' ', authUrl, '\n');

  const opener =
    process.platform === 'win32'  ? `start "" "${authUrl}"` :
    process.platform === 'darwin' ? `open "${authUrl}"` :
    `xdg-open "${authUrl}"`;
  exec(opener);
});
