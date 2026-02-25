'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { sendMagicLink } = require('../services/mail');
const { issueSessionCookie } = require('../middleware/auth');

// Only allow relative same-origin redirects (starts with / but not //)
function safeRedirectUrl(url) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
  return '/tickets';
}

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.cookies.session) return res.redirect('/');
  const next = safeRedirectUrl(req.query.next);
  res.render('auth/login', { title: 'Log in', error: null, email: '', next });
});

// POST /auth/login — send magic link + OTP
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const next  = safeRedirectUrl(req.body.next);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('auth/login', { title: 'Log in', error: 'Please enter a valid email address.', email, next });
  }

  const user = db.findOrCreateUser(email);
  if (user.blocked_at) {
    return res.render('auth/login', { title: 'Log in', error: 'This account has been blocked.', email, next });
  }

  // Cryptographically secure 6-digit OTP
  const otp = String(crypto.randomInt(100000, 1000000));
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
  const { t: tokenId, k: rawToken, sent } = req.query;
  const next = safeRedirectUrl(req.query.next);

  res.render('auth/verify', {
    title: 'Check your email',
    error: null,
    tokenId: tokenId || null,
    rawToken: rawToken || null,
    sent: sent === '1',
    next,
  });
});

// POST /auth/verify — OTP submission or magic link confirmation
router.post('/verify', (req, res) => {
  const { tokenId, otp, rawToken } = req.body;
  const redirectTo = safeRedirectUrl(req.body.next);

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
    const result = db.verifyOTPByTokenId(tokenId, otp.trim());

    if (!result) {
      return res.render('auth/verify', {
        title: 'Check your email',
        error: 'Invalid or expired code. Please try again or request a new link.',
        tokenId,
        rawToken: null,
        sent: false,
        next: redirectTo,
      });
    }

    if (result.locked) {
      const waitSecs = result.lockedUntil - Math.floor(Date.now() / 1000);
      const waitMins = Math.ceil(waitSecs / 60);
      const msg = waitMins > 1
        ? `Too many incorrect attempts. Please wait ${waitMins} minutes or request a new link.`
        : 'Too many incorrect attempts. Please wait a moment or request a new link.';
      return res.render('auth/verify', {
        title: 'Check your email',
        error: msg,
        tokenId,
        rawToken: null,
        sent: false,
        next: redirectTo,
      });
    }

    record = result;
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
  res.clearCookie('admin_session');
  res.redirect('/auth/login');
});

// POST /auth/impersonate-return — restore admin session
router.post('/impersonate-return', (req, res) => {
  const adminToken = req.cookies.admin_session;
  if (!adminToken) return res.redirect('/tickets');
  try {
    const payload = jwt.verify(adminToken, config.jwtSecret);
    if (payload.role !== 'admin') throw new Error('not admin');
    // Restore the admin's session cookie verbatim
    res.cookie('session', adminToken, {
      httpOnly: true,
      secure:   config.secureSession,
      maxAge:   30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    res.clearCookie('admin_session');
    res.redirect('/admin/users');
  } catch (_) {
    res.clearCookie('admin_session');
    res.redirect('/tickets');
  }
});

module.exports = router;
