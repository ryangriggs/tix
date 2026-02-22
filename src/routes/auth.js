'use strict';

const express = require('express');
const router = express.Router();

const config = require('../config');
const db = require('../db');
const { sendMagicLink } = require('../services/mail');
const { issueSessionCookie } = require('../middleware/auth');

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.cookies.session) return res.redirect('/');
  res.render('auth/login', { title: 'Log in', error: null, email: '', next: req.query.next || '/' });
});

// POST /auth/login — send magic link + OTP
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const next = req.body.next || '/';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('auth/login', { title: 'Log in', error: 'Please enter a valid email address.', email, next });
  }

  const user = db.findOrCreateUser(email);
  if (user.blocked_at) {
    return res.render('auth/login', { title: 'Log in', error: 'This account has been blocked.', email, next });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const { tokenId, rawToken } = db.createAuthToken(user.id, otp);

  const magicLink = `${config.appUrl}/auth/verify?t=${tokenId}&k=${rawToken}&next=${encodeURIComponent(next)}`;

  try {
    await sendMagicLink(email, magicLink, otp);
  } catch (err) {
    console.error('[Auth] Failed to send magic link:', err);
    return res.render('auth/login', { title: 'Log in', error: 'Could not send login email. Please try again.', email, next });
  }

  res.redirect(`/auth/verify?t=${tokenId}&sent=1&next=${encodeURIComponent(next)}`);
});

// GET /auth/verify
// Renders the verify page. Magic link tokens (t + k) are intentionally NOT
// consumed here — email security scanners pre-fetch URLs, which would mark
// the token used before the real user arrives. Verification happens on POST.
router.get('/verify', (req, res) => {
  const { t: tokenId, k: rawToken, sent, next } = req.query;
  const redirectTo = next || '/';

  res.render('auth/verify', {
    title: 'Check your email',
    error: null,
    tokenId: tokenId || null,
    rawToken: rawToken || null,
    sent: sent === '1',
    next: redirectTo,
  });
});

// POST /auth/verify — OTP submission or magic link confirmation
router.post('/verify', (req, res) => {
  const { tokenId, otp, rawToken, next } = req.body;
  const redirectTo = next || '/';

  if (!tokenId) {
    return res.render('auth/verify', { title: 'Verify', error: 'Missing token.', tokenId: null, rawToken: null, sent: false, next: redirectTo });
  }

  let record;

  if (rawToken) {
    // Magic link confirmation — user clicked the "Log in" button in the browser
    record = db.verifyAuthToken(tokenId, rawToken);
    if (!record) {
      return res.render('auth/verify', {
        title: 'Check your email',
        error: 'This link has expired or already been used. Please request a new one.',
        tokenId: null,
        rawToken: null,
        sent: false,
        next: redirectTo,
      });
    }
  } else if (otp) {
    // 6-digit OTP entry
    record = db.verifyOTPByTokenId(tokenId, otp.trim());
    if (!record) {
      return res.render('auth/verify', {
        title: 'Check your email',
        error: 'Invalid or expired code. Please try again or request a new link.',
        tokenId,
        rawToken: null,
        sent: false,
        next: redirectTo,
      });
    }
  } else {
    return res.render('auth/verify', { title: 'Verify', error: 'Missing token or code.', tokenId, rawToken: null, sent: false, next: redirectTo });
  }

  const user = db.getUserById(record.user_id);
  issueSessionCookie(res, user);
  res.redirect(redirectTo);
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/auth/login');
});

module.exports = router;
