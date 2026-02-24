'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUserById, getTechnicianOrganizations } = require('../db');

// ============================================================
// CSRF — HMAC token tied to the session cookie value.
// No server-side state needed; changes automatically on logout.
// ============================================================

function makeCsrfToken(sessionCookie) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(sessionCookie || '')
    .digest('base64url');
}

function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Body for url-encoded forms; query for multipart (enctype="multipart/form-data") forms;
  // header for AJAX callers.
  const submitted = req.body?._csrf || req.query._csrf || req.headers['x-csrf-token'] || '';
  const expected  = makeCsrfToken(req.cookies.session || '');
  let ok = false;
  try {
    ok = submitted.length === expected.length &&
         crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
  } catch (_) {}
  if (!ok) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Invalid or missing CSRF token. Please go back and try again.',
    });
  }
  next();
}

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = getUserById(payload.userId);
    if (!user || user.blocked_at) {
      res.clearCookie('session');
      return res.redirect('/auth/login');
    }
    req.user = user;
    req.user.isGroupSuperuser = !!user.is_group_superuser;
    req.user.techOrgIds = user.role === 'technician'
      ? getTechnicianOrganizations(user.id).map(o => o.id)
      : [];
    res.locals.user = user;
    // Expose CSRF token to every authenticated view
    res.locals.csrfToken = makeCsrfToken(token);
    next();
  } catch (_) {
    res.clearCookie('session');
    res.redirect('/auth/login');
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.' });
  }
  next();
}

// Attaches user to req if a valid session cookie exists, but does not redirect
function optionalAuth(req, res, next) {
  const token = req.cookies.session;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = getUserById(payload.userId);
    if (user && !user.blocked_at) {
      req.user = user;
      res.locals.user = user;
    }
  } catch (_) { /* ignore */ }
  next();
}

function issueSessionCookie(res, user) {
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiry }
  );
  res.cookie('session', token, {
    httpOnly: true,
    secure: config.secureSession,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
  });
}

module.exports = { requireAuth, requireAdmin, optionalAuth, issueSessionCookie, verifyCsrf };
