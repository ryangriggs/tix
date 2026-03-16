'use strict';

const { SMTPServer } = require('smtp-server');
const config = require('./config');
const { processInboundEmail } = require('./services/inbound');

function startSMTPServer() {
  const ticketDomain = config.ticketEmail.split('@')[1];

  const server = new SMTPServer({
    // No authentication required for receiving
    authOptional: true,
    disabledCommands: ['STARTTLS'], // plain text is fine for inbound on port 25

    // Accept mail addressed to anything @our domain
    onRcptTo(address, session, callback) {
      if (address.address.toLowerCase().endsWith(`@${ticketDomain}`)) {
        return callback();
      }
      callback(new Error(`550 Unknown recipient: ${address.address}`));
    },

    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stream.on('end', async () => {
        const rawEmail = Buffer.concat(chunks);
        try {
          await processInboundEmail(rawEmail);
          callback();
        } catch (err) {
          // Reject at the SMTP protocol level so the sender's MTA logs the failure
          // and their postmaster is notified — no outbound email needed on our side.
          const smtpErr = new Error('Message processing failed. Please contact support.');
          smtpErr.responseCode = 451; // temporary local error — sender will retry
          callback(smtpErr);
        }
      });
      stream.on('error', err => {
        console.error('[SMTP] Stream error:', err);
        callback(err);
      });
    },

    onError(err) {
      console.error('[SMTP] Server error:', err);
    },
  });

  server.listen(config.smtpPort, '0.0.0.0', () => {
    console.log(`[SMTP] Listening on port ${config.smtpPort} (domain: ${ticketDomain})`);
  });

  server.on('error', err => {
    console.error('[SMTP] Fatal error:', err);
  });

  return server;
}

module.exports = { startSMTPServer };
