'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { getUserById } = require('../db');

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
    res.locals.user = user;
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

module.exports = { requireAuth, requireAdmin, optionalAuth, issueSessionCookie };
