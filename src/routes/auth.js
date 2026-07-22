'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const express = require('express');
const router  = express.Router();

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { generateSecret: totpGenerateSecret, generateSync: totpGenerateSync, verifySync: totpVerifySync } = require('otplib');
const config = require('../config');
const db = require('../db');
const { sendMagicLink, sendMfaOtp, sendAdminNewUserNotification } = require('../services/mail');
const { issueSessionCookie } = require('../middleware/auth');

// ============================================================
// Login rate limiting — in-memory, resets on restart
// ============================================================

// TOTP MFA attempt tracking: key = `${userId}:${iat}` (identifies one mfa_pending JWT)
const _mfaTotpAttempts = new Map(); // key → { tries, expiresAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _mfaTotpAttempts) {
    if (v.expiresAt < now) _mfaTotpAttempts.delete(k);
  }
}, 5 * 60_000).unref();

const _loginByIp    = new Map(); // ip  → [timestamp, ...]
const _loginByEmail = new Map(); // email → [timestamp, ...]

// Prune stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _loginByIp)    { const r = ts.filter(t => now - t < 3_600_000); r.length ? _loginByIp.set(k, r)    : _loginByIp.delete(k);    }
  for (const [k, ts] of _loginByEmail) { const r = ts.filter(t => now - t < 60_000);    r.length ? _loginByEmail.set(k, r) : _loginByEmail.delete(k); }
}, 5 * 60_000).unref();

function checkLoginRateLimit(ip, email) {
  const now = Date.now();

  const ipLimit    = config.loginRateLimitPerIpPerHour   || 20;
  const emailLimit = config.loginRateLimitPerEmailPerMin || 5;

  const recentIp    = (_loginByIp.get(ip)       || []).filter(t => now - t < 3_600_000);
  const recentEmail = (_loginByEmail.get(email)  || []).filter(t => now - t < 60_000);

  if (recentIp.length >= ipLimit)       return 'ip';
  if (recentEmail.length >= emailLimit) return 'email';

  recentIp.push(now);
  recentEmail.push(now);
  _loginByIp.set(ip, recentIp);
  _loginByEmail.set(email, recentEmail);
  return null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Only allow relative same-origin redirects (starts with / but not //)
function safeRedirectUrl(url) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return url;
  return '/tickets';
}

function logUser(email, status) {
  if (!config.userLog) return;
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts} | ${email} | ${status}\n`;
  try {
    fs.appendFileSync(config.userLog, line, 'utf8');
  } catch (err) {
    console.error('[Auth] Failed to write user log:', err.message);
  }
}

function loginRender(res, opts) {
  res.render('auth/login', { title: 'Log in', ...opts });
}

function signupRender(res, opts) {
  res.render('auth/signup', { title: 'Verify you\'re human', turnstileSiteKey: config.turnstileSiteKey, ...opts });
}

// Shared: issue OTP + magic link, then redirect to verify page.
async function sendOtp(res, user, email, next, onError) {
  const otp = String(crypto.randomInt(100000, 1000000));
  const { tokenId, rawToken } = db.createAuthToken(user.id, otp);
  const magicLink = `${config.appUrl}/auth/verify?t=${tokenId}&k=${rawToken}&next=${encodeURIComponent(next)}`;
  try {
    await sendMagicLink(email, magicLink, otp);
    res.redirect(`/auth/verify?t=${tokenId}&sent=1&next=${encodeURIComponent(next)}`);
  } catch (err) {
    console.error('[Auth] Failed to send magic link:', err);
    onError();
  }
}

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.cookies.session) return res.redirect('/');
  const next = safeRedirectUrl(req.query.next);
  const errorMap = { mfa_locked: 'Too many incorrect MFA attempts. Please log in again.' };
  loginRender(res, { error: errorMap[req.query.error] || null, email: '', next });
});

// POST /auth/login
// - Existing active user  → send OTP immediately
// - Existing blocked user → show "account disabled"
// - Unknown email + Turnstile configured → redirect to /auth/signup captcha page
// - Unknown email + Turnstile not configured → create account and send OTP directly
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const next  = safeRedirectUrl(req.body.next);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return loginRender(res, { error: 'Please enter a valid email address.', email, next });
  }

  const limited = checkLoginRateLimit(clientIp(req), email);
  if (limited === 'ip') {
    logUser(email, 'FAILED - IP rate limited');
    return loginRender(res, { error: 'Too many login attempts from your network. Please try again later.', email, next });
  }
  if (limited === 'email') {
    logUser(email, 'FAILED - email rate limited');
    return loginRender(res, { error: 'Too many login attempts. Please try again in a minute.', email, next });
  }

  const existingUser = db.getUserByEmail(email);

  if (!existingUser) {
    if (config.turnstileEnabled && config.turnstileSiteKey) {
      return res.redirect(`/auth/signup?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
    }
    // Turnstile not configured — create account and send OTP directly
    const user = db.findOrCreateUser(email);
    if (user._isNew) sendAdminNewUserNotification(user, 'First login (magic link request)').catch(console.error);
    return sendOtp(res, user, email, next, () =>
      loginRender(res, { error: 'Could not send login email. Please try again.', email, next })
    );
  }

  if (existingUser.blocked_at) {
    logUser(email, 'FAILED - account disabled');
    return loginRender(res, { error: 'This account is disabled.', email, next });
  }

  return sendOtp(res, existingUser, email, next, () =>
    loginRender(res, { error: 'Could not send login email. Please try again.', email, next })
  );
});

// GET /auth/signup — Turnstile verification page for new accounts only
router.get('/signup', (req, res) => {
  if (!config.turnstileEnabled || !config.turnstileSiteKey) return res.redirect('/auth/login');
  const email = (req.query.email || '').trim().toLowerCase();
  const next  = safeRedirectUrl(req.query.next);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.redirect('/auth/login');
  if (db.getUserByEmail(email)) return res.redirect('/auth/login');
  signupRender(res, { error: null, email, next });
});

// POST /auth/signup — verify Turnstile token, then create account and send OTP
router.post('/signup', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const next  = safeRedirectUrl(req.body.next);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.redirect('/auth/login');
  if (db.getUserByEmail(email)) return res.redirect('/auth/login');

  const limited = checkLoginRateLimit(clientIp(req), email);
  if (limited === 'ip') {
    return signupRender(res, { error: 'Too many attempts from your network. Please try again later.', email, next });
  }
  if (limited === 'email') {
    return signupRender(res, { error: 'Too many attempts. Please try again in a minute.', email, next });
  }

  // Verify Turnstile
  if (config.turnstileEnabled && config.turnstileSecretKey) {
    const token = req.body['cf-turnstile-response'];
    let ok = false;
    if (token) {
      try {
        const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: config.turnstileSecretKey, response: token, remoteip: clientIp(req) }),
        });
        const data = await resp.json();
        ok = data.success === true;
      } catch (_) {}
    }
    if (!ok) {
      logUser(email, 'FAILED - Turnstile verification failed');
      return signupRender(res, { error: 'Verification failed. Please try again.', email, next });
    }
  }

  const user = db.findOrCreateUser(email);
  if (user._isNew) sendAdminNewUserNotification(user, 'First login (magic link request)').catch(console.error);

  return sendOtp(res, user, email, next, () =>
    signupRender(res, { error: 'Could not send login email. Please try again.', email, next })
  );
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
      logUser(db.getAuthTokenEmail(tokenId) || '(unknown)', 'FAILED - invalid or expired link');
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
      logUser(db.getAuthTokenEmail(tokenId) || '(unknown)', 'FAILED - invalid code');
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
      logUser(db.getAuthTokenEmail(tokenId) || '(unknown)', 'FAILED - too many attempts, locked');
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
  logUser(user.email, 'SUCCESS');
  issueSessionCookie(res, user);
  res.redirect(redirectTo);
});

// POST /auth/login/password — password-based login entry point
router.post('/login/password', async (req, res) => {
  if (!config.passwordLoginEnabled) return res.redirect('/auth/login');

  const email    = (req.body.email    || '').trim().toLowerCase();
  const password =  req.body.password || '';
  const next     = safeRedirectUrl(req.body.next);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
    return loginRender(res, { error: 'Please enter your email and password.', email, next, tab: 'password' });
  }

  const limited = checkLoginRateLimit(clientIp(req), email);
  if (limited === 'ip') {
    logUser(email, 'FAILED - IP rate limited (password)');
    return loginRender(res, { error: 'Too many login attempts from your network. Please try again later.', email, next, tab: 'password' });
  }
  if (limited === 'email') {
    logUser(email, 'FAILED - email rate limited (password)');
    return loginRender(res, { error: 'Too many login attempts. Please try again in a minute.', email, next, tab: 'password' });
  }

  const user = db.getUserByEmail(email);

  // No account or no password set → fall back to magic link silently
  if (!user || !user.password_hash) {
    if (user && user.blocked_at) {
      logUser(email, 'FAILED - account disabled');
      return loginRender(res, { error: 'This account is disabled.', email, next, tab: 'password' });
    }
    if (!user) {
      if (config.turnstileEnabled && config.turnstileSiteKey) {
        return res.redirect(`/auth/signup?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
      }
      const newUser = db.findOrCreateUser(email);
      if (newUser._isNew) sendAdminNewUserNotification(newUser, 'First login (password form)').catch(console.error);
      return sendOtp(res, newUser, email, next, () =>
        loginRender(res, { error: 'Could not send login email. Please try again.', email, next, tab: 'password' })
      );
    }
    // Has account but no password → send magic link
    return sendOtp(res, user, email, next, () =>
      loginRender(res, { error: 'Could not send login email. Please try again.', email, next, tab: 'password' })
    );
  }

  if (user.blocked_at) {
    logUser(email, 'FAILED - account disabled');
    return loginRender(res, { error: 'This account is disabled.', email, next, tab: 'password' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    logUser(email, 'FAILED - wrong password');
    return loginRender(res, { error: 'Incorrect email or password.', email, next, tab: 'password' });
  }

  // Password correct — issue short-lived MFA pending cookie
  const pendingJwt = jwt.sign({ userId: user.id, purpose: 'mfa_pending' }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie('mfa_pending', pendingJwt, { httpOnly: true, secure: config.secureSession, maxAge: 10 * 60 * 1000, sameSite: 'lax' });

  if (user.totp_enabled) {
    return res.redirect(`/auth/mfa?mode=totp&next=${encodeURIComponent(next)}`);
  }

  // Send email OTP
  const otp = String(crypto.randomInt(100000, 1000000));
  const { tokenId } = db.createAuthToken(user.id, otp);
  try {
    await sendMfaOtp(email, otp);
    return res.redirect(`/auth/mfa?mode=email&t=${tokenId}&next=${encodeURIComponent(next)}&sent=1`);
  } catch (err) {
    console.error('[Auth] Failed to send MFA email:', err);
    res.clearCookie('mfa_pending');
    return loginRender(res, { error: 'Could not send verification email. Please try again.', email, next, tab: 'password' });
  }
});

// GET /auth/mfa
router.get('/mfa', (req, res) => {
  const pendingJwt = req.cookies.mfa_pending;
  if (!pendingJwt) return res.redirect('/auth/login');

  let payload;
  try {
    payload = jwt.verify(pendingJwt, config.jwtSecret);
    if (payload.purpose !== 'mfa_pending') throw new Error('wrong purpose');
  } catch (_) {
    res.clearCookie('mfa_pending');
    return res.redirect('/auth/login');
  }

  const user = db.getUserById(payload.userId);
  if (!user || user.blocked_at) {
    res.clearCookie('mfa_pending');
    return res.redirect('/auth/login');
  }

  const mode    = req.query.mode || (user.totp_enabled ? 'totp' : 'email');
  const tokenId = req.query.t   || null;
  const next    = safeRedirectUrl(req.query.next);
  const sent    = req.query.sent === '1';

  res.render('auth/mfa', { title: 'Verify your identity', error: null, mode, tokenId, next, sent });
});

// POST /auth/mfa
router.post('/mfa', async (req, res) => {
  const pendingJwt = req.cookies.mfa_pending;
  const next       = safeRedirectUrl(req.body.next);
  const mode       = req.body.mode   || 'email';
  const tokenId    = req.body.tokenId || null;

  if (!pendingJwt) return res.redirect('/auth/login');

  let payload;
  try {
    payload = jwt.verify(pendingJwt, config.jwtSecret);
    if (payload.purpose !== 'mfa_pending') throw new Error('wrong purpose');
  } catch (_) {
    res.clearCookie('mfa_pending');
    return res.redirect('/auth/login');
  }

  const user = db.getUserById(payload.userId);
  if (!user || user.blocked_at) {
    res.clearCookie('mfa_pending');
    return res.redirect('/auth/login');
  }

  function mfaError(msg) {
    return res.render('auth/mfa', { title: 'Verify your identity', error: msg, mode, tokenId, next, sent: false });
  }

  // Key that uniquely identifies this mfa_pending token (userId + issued-at)
  const totpKey = `${payload.userId}:${payload.iat}`;

  if (mode === 'totp') {
    const code = (req.body.totp_code || '').trim().replace(/\s/g, '');
    if (!user.totp_secret || !user.totp_enabled) return mfaError('Authenticator not configured. Please contact support.');

    // Enforce TOTP attempt limit (same threshold as OTP)
    const maxTries = config.otpMaxTries || 5;
    const entry = _mfaTotpAttempts.get(totpKey);
    if (entry && entry.tries >= maxTries) {
      logUser(user.email, 'FAILED - TOTP locked out');
      res.clearCookie('mfa_pending');
      return res.redirect('/auth/login?error=mfa_locked');
    }

    let valid = false;
    try { valid = totpVerifySync({ token: code, secret: user.totp_secret }).valid; } catch (_) {}
    if (!valid) {
      const tries = (entry ? entry.tries : 0) + 1;
      _mfaTotpAttempts.set(totpKey, { tries, expiresAt: Date.now() + 10 * 60_000 });
      logUser(user.email, 'FAILED - invalid TOTP');
      if (tries >= maxTries) {
        res.clearCookie('mfa_pending');
        return res.redirect('/auth/login?error=mfa_locked');
      }
      return mfaError(`Invalid code. ${maxTries - tries} attempt${maxTries - tries === 1 ? '' : 's'} remaining.`);
    }
    _mfaTotpAttempts.delete(totpKey);
  } else {
    if (!tokenId) return mfaError('Missing verification token. Please start over.');
    const code   = (req.body.otp || '').trim();
    const result = db.verifyOTPByTokenId(tokenId, code);
    if (!result) {
      logUser(user.email, 'FAILED - invalid MFA email code');
      return mfaError('Invalid or expired code. Please try again.');
    }
    if (result.locked) {
      const waitMins = Math.ceil((result.lockedUntil - Math.floor(Date.now() / 1000)) / 60);
      return mfaError(waitMins > 1
        ? `Too many incorrect attempts. Please wait ${waitMins} minutes.`
        : 'Too many incorrect attempts. Please wait a moment.');
    }
    // CRITICAL: ensure this OTP token was issued for the same user as mfa_pending
    if (result.user_id !== user.id) {
      logUser(user.email, 'BLOCKED - MFA token user mismatch');
      res.clearCookie('mfa_pending');
      return res.redirect('/auth/login');
    }
  }

  logUser(user.email, 'SUCCESS (password + MFA)');
  res.clearCookie('mfa_pending');
  issueSessionCookie(res, user);
  res.redirect(next);
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.clearCookie('admin_session');
  res.clearCookie('mfa_pending');
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
