'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { generateSecret: totpGenerateSecret, verifySync: totpVerifySync } = require('otplib');
const QRCode   = require('qrcode');
const jwt      = require('jsonwebtoken');

const config = require('../config');
const db     = require('../db');

const SUCCESS_MESSAGES = {
  password:      'Password updated successfully.',
  totp_enabled:  'Authenticator app enabled.',
  totp_disabled: 'Authenticator app removed.',
};

// GET /account/security
router.get('/security', (req, res) => {
  const user = db.getUserById(req.user.id);
  res.render('account/security', {
    title:     'Security',
    success:   SUCCESS_MESSAGES[req.query.success] || null,
    error:     req.query.error === 'totp_expired' ? 'Setup session expired. Please try again.' : null,
    user,
    totpSetup: null,
  });
});

// POST /account/password — set or change password
router.post('/password', async (req, res) => {
  const user = db.getUserById(req.user.id);
  const { current_password, new_password, confirm_password } = req.body;

  function fail(msg) {
    return res.render('account/security', { title: 'Security', error: msg, success: null, user, totpSetup: null });
  }

  if (user.password_hash) {
    if (!current_password) return fail('Please enter your current password.');
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return fail('Current password is incorrect.');
  }

  if (!new_password || new_password.length < 8) return fail('Password must be at least 8 characters.');
  if (new_password !== confirm_password)          return fail('Passwords do not match.');

  const hash = await bcrypt.hash(new_password, 12);
  db.setUserPassword(user.id, hash);
  return res.redirect('/account/security?success=password');
});

// POST /account/totp/setup — generate pending secret and render setup page with QR code
router.post('/totp/setup', async (req, res) => {
  const user   = db.getUserById(req.user.id);
  const secret = totpGenerateSecret();

  const pendingJwt = jwt.sign({ userId: user.id, secret, purpose: 'totp_setup' }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie('totp_setup', pendingJwt, { httpOnly: true, secure: config.secureSession, maxAge: 10 * 60 * 1000, sameSite: 'lax' });

  const label   = encodeURIComponent(user.email);
  const issuer  = encodeURIComponent(config.siteName || 'Tix');
  const otpauth = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`;
  const qrData  = await QRCode.toDataURL(otpauth);

  res.render('account/security', { title: 'Security', error: null, success: null, user, totpSetup: { secret, qrData } });
});

// POST /account/totp/enable — verify code and activate TOTP
router.post('/totp/enable', async (req, res) => {
  const pendingJwt = req.cookies.totp_setup;
  if (!pendingJwt) return res.redirect('/account/security?error=totp_expired');

  let payload;
  try {
    payload = jwt.verify(pendingJwt, config.jwtSecret);
    if (payload.purpose !== 'totp_setup' || payload.userId !== req.user.id) throw new Error('invalid');
  } catch (_) {
    res.clearCookie('totp_setup');
    return res.redirect('/account/security?error=totp_expired');
  }

  const code = (req.body.totp_code || '').trim().replace(/\s/g, '');
  let valid = false;
  try { valid = totpVerifySync({ token: code, secret: payload.secret }).valid; } catch (_) {}

  if (!valid) {
    const user    = db.getUserById(req.user.id);
    const label   = encodeURIComponent(user.email);
    const issuer  = encodeURIComponent(config.siteName || 'Tix');
    const otpauth = `otpauth://totp/${issuer}:${label}?secret=${payload.secret}&issuer=${issuer}`;
    const qrData  = await QRCode.toDataURL(otpauth);
    return res.render('account/security', { title: 'Security', error: 'Invalid code. Please try again.', success: null, user, totpSetup: { secret: payload.secret, qrData } });
  }

  db.setUserTotp(req.user.id, payload.secret);
  res.clearCookie('totp_setup');
  return res.redirect('/account/security?success=totp_enabled');
});

// POST /account/totp/disable — verify current TOTP code and remove
router.post('/totp/disable', (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user.totp_enabled || !user.totp_secret) return res.redirect('/account/security');

  const code = (req.body.totp_code || '').trim().replace(/\s/g, '');
  let valid = false;
  try { valid = totpVerifySync({ token: code, secret: user.totp_secret }).valid; } catch (_) {}

  if (!valid) {
    return res.render('account/security', {
      title: 'Security', error: 'Invalid authenticator code. TOTP was not disabled.', success: null, user, totpSetup: null,
    });
  }

  db.disableUserTotp(req.user.id);
  return res.redirect('/account/security?success=totp_disabled');
});

module.exports = router;
