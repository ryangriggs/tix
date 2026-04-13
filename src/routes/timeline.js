'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// ============================================================
// Hardcoded time period definitions — POC
// TODO: Move these to Settings page
// ============================================================
const BUSINESS_START_H = 8;   // 8am
const BUSINESS_END_H   = 17;  // 5pm
const TONIGHT_START_H  = 17;  // 5pm
const TONIGHT_END_H    = 23;  // 11pm

// ============================================================
// Section builder — classifies tickets into time buckets
// ============================================================
function buildSections(tickets) {
  const now = Math.floor(Date.now() / 1000);

  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const todayStart    = Math.floor(d.getTime() / 1000);
  const todayEnd      = todayStart + 86400 - 1;
  const tomorrowStart = todayStart + 86400;
  const tomorrowEnd   = tomorrowStart + 86400 - 1;

  // This week ends at start of next Monday
  const dow          = d.getDay(); // 0=Sun
  const daysToMon    = dow === 0 ? 1 : (8 - dow);
  const thisWeekEnd  = todayStart + daysToMon * 86400;
  const nextWeekEnd  = thisWeekEnd + 7 * 86400;
  const in31Days     = todayStart + 31 * 86400;

  const sections = {
    overdue:       [],
    asap:          [],
    todayBusiness: [],
    todayTonight:  [],
    todayAllDay:   [],
    tomorrow:      [],
    thisWeek:      [],
    nextWeek:      [],
    thisMonth:     [],
    beyond:        [],
    someday:       [],
    unscheduled:   [],
  };

  for (const t of tickets) {
    if (!t.schedule_type) { sections.unscheduled.push(t); continue; }

    if (t.schedule_type === 'asap')   { sections.asap.push(t);    continue; }
    if (t.schedule_type === 'someday') { sections.someday.push(t); continue; }

    if (t.schedule_type === 'appointment') {
      const at = t.schedule_exact_at || 0;
      if      (at < now)             sections.overdue.push(t);
      else if (at <= todayEnd)        sections.todayBusiness.push(t);
      else if (at <= tomorrowEnd)     sections.tomorrow.push(t);
      else if (at < thisWeekEnd)      sections.thisWeek.push(t);
      else if (at < nextWeekEnd)      sections.nextWeek.push(t);
      else if (at < in31Days)         sections.thisMonth.push(t);
      else                            sections.beyond.push(t);
      continue;
    }

    if (t.schedule_type === 'window') {
      const ws  = t.schedule_window_start || 0;
      const we  = t.schedule_window_end   || ws;
      const tod = t.schedule_time_of_day  || 'allday';

      if (we < now) {
        sections.overdue.push(t);
      } else if (ws <= todayEnd) {
        if      (tod === 'tonight') sections.todayTonight.push(t);
        else if (tod === 'allday')  sections.todayAllDay.push(t);
        else                        sections.todayBusiness.push(t);
      } else if (ws <= tomorrowEnd) {
        sections.tomorrow.push(t);
      } else if (ws < thisWeekEnd) {
        sections.thisWeek.push(t);
      } else if (ws < nextWeekEnd) {
        sections.nextWeek.push(t);
      } else if (ws < in31Days) {
        sections.thisMonth.push(t);
      } else {
        sections.beyond.push(t);
      }
    }
  }

  // Sort sections by schedule date ascending (earliest first)
  const sortKey = t => {
    if (t.schedule_type === 'appointment') return t.schedule_exact_at || 0;
    if (t.schedule_type === 'window')      return t.schedule_window_start || 0;
    return t.updated_at || 0;
  };
  for (const arr of Object.values(sections)) arr.sort((a, b) => sortKey(a) - sortKey(b));

  return sections;
}

// Human-readable date range labels for section headers
function buildLabels() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);

  const fmt = (date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayName = (date) => date.toLocaleDateString(undefined, { weekday: 'long' });

  const today    = new Date(d);
  const tomorrow = new Date(d); tomorrow.setDate(d.getDate() + 1);

  // This week: remaining days up to end of Sunday
  const dow         = d.getDay();
  const daysToSun   = dow === 0 ? 0 : (7 - dow);
  const endOfWeek   = new Date(d); endOfWeek.setDate(d.getDate() + daysToSun);

  const nextMon     = new Date(d); nextMon.setDate(d.getDate() + (dow === 0 ? 1 : (8 - dow)));
  const nextSun     = new Date(nextMon); nextSun.setDate(nextMon.getDate() + 6);

  const in32        = new Date(d); in32.setDate(d.getDate() + 32);

  return {
    today:     `Today — ${dayName(today)}, ${fmt(today)}`,
    tomorrow:  `Tomorrow — ${dayName(tomorrow)}, ${fmt(tomorrow)}`,
    thisWeek:  `This Week — ${fmt(new Date(d.getTime() + 86400000 * 2))}–${fmt(endOfWeek)}`,
    nextWeek:  `Next Week — ${fmt(nextMon)}–${fmt(nextSun)}`,
    thisMonth: `This Month — through ${fmt(in32)}`,
    beyond:    'Beyond',
  };
}

// ============================================================
// GET /timeline
// ============================================================
router.get('/', (req, res) => {
  const tickets  = db.getTimelineTickets(req.user.id);
  const sections = buildSections(tickets);
  const labels   = buildLabels();

  res.render('timeline', {
    title: 'Timeline',
    sections,
    labels,
    BUSINESS_START_H,
    BUSINESS_END_H,
    TONIGHT_START_H,
    TONIGHT_END_H,
  });
});

// ============================================================
// POST /timeline/tickets/:id/schedule
// ============================================================
router.post('/tickets/:id/schedule', (req, res) => {
  const ticketId = parseInt(req.params.id, 10);
  if (!ticketId) return res.status(400).json({ error: 'Invalid ticket ID' });

  const ticket = db.getTicketById(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  // Must be owner (or admin)
  const role = db.getUserTicketRole(ticketId, req.user.id);
  if (role !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden — must be ticket owner' });
  }

  const { type, window_start, window_end, time_of_day, exact_at } = req.body;

  const validTypes = ['asap', 'window', 'appointment', 'someday', ''];
  if (!validTypes.includes(type || '')) {
    return res.status(400).json({ error: 'Invalid schedule type' });
  }

  db.setTicketSchedule(ticketId, {
    type:         type        || null,
    window_start: window_start ? parseInt(window_start, 10) : null,
    window_end:   window_end   ? parseInt(window_end,   10) : null,
    time_of_day:  time_of_day  || null,
    exact_at:     exact_at     ? parseInt(exact_at,     10) : null,
  });

  res.json({ ok: true });
});

module.exports = router;
