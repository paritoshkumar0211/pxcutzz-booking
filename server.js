/**
 * PXCUTZZ — online booking website
 * Men's salon / barbershop, Surrey, BC, Canada.
 *
 * Single Node.js (Express) app, no build step.
 * Storage: Turso (hosted libSQL) when TURSO_DATABASE_URL and
 * TURSO_AUTH_TOKEN are set — bookings then survive redeploys/restarts.
 * Otherwise a local SQLite file (better-sqlite3) in DATA_DIR, with a
 * JSON-file fallback if the native module cannot load. NOTE: on Render's
 * free tier the local disk is ephemeral — bookings are lost on
 * redeploy/restart. See README.md for the persistent-storage options.
 *
 * Email: nodemailer over Gmail SMTP, only when GMAIL_USER and
 * GMAIL_APP_PASSWORD are set. Bookings always save even if email is
 * not configured; the API reports emailSent: false in that case.
 *
 * SMS: Twilio, only when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_PHONE_NUMBER are all set. Booking confirmations and
 * 1-day-before reminders are sent fire-and-forget — a booking never
 * fails because SMS is unconfigured or a send fails. The API reports
 * smsConfigured in /api/health.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const TZ = 'America/Vancouver';
const SALON_NAME = 'PXCUTZZ';
const SALON_EMAIL = process.env.SALON_EMAIL || 'pxcutzz@gmail.com';
const SALON_PHONE = '+1 672-588-2101';
const SALON_ADDRESS = '9385 120 St, Unit 102, Surrey, BC, Canada';
const OPEN_MINUTES = 9 * 60; // 9:00 AM
const CLOSE_MINUTES = 21 * 60; // 9:00 PM
const CLOSED_WEEKDAY = 2; // Tuesday (0=Sunday)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // if set, Manage view needs it
// Owner's phone for booking alerts and the SMS test endpoint.
const OWNER_PHONE = process.env.OWNER_PHONE || '+16725882101';

// Services — prices/durations exactly as provided by the owner.
// Durations marked "placeholder: true" were not given by the owner and
// were set to 30 minutes. Do not present them as owner-confirmed.
const SERVICES = [
  { id: 'mens-haircuts', name: "Men's Haircut", price: 25, priceLabel: '$25', duration: 30, placeholderDuration: true },
  { id: 'haircut-beard', name: 'Haircut & Beard', price: 45, priceLabel: '$45', duration: 45 },
  { id: 'skin-fades', name: 'Skin Fades', price: 30, priceLabel: '$30', duration: 30 },
  { id: 'hair-perms', name: 'Hair Perms', price: 120, priceLabel: '$120', duration: 45 },
  { id: 'mens-facial', name: "Men's Facial Treatments", price: 50, priceLabel: 'from $50', duration: 30 },
  { id: 'beard-trimming-styling', name: 'Beard Trimming and Lineup', price: 20, priceLabel: '$20', duration: 30, placeholderDuration: true },
  { id: 'beard-trim-waxing', name: 'Beard Trim and Waxing', price: 25, priceLabel: '$25', duration: 30 },
  { id: 'beard-lineup', name: 'Lineup with Straight Razor Beard', price: 10, priceLabel: '$10', duration: 30, placeholderDuration: true },
  { id: 'd-tan', name: 'D Tan', price: 15, priceLabel: '$15', duration: 30, placeholderDuration: true },
  { id: 'scrub', name: 'Scrub', price: 25, priceLabel: '$25', duration: 30, placeholderDuration: true },
];

const OPENING_HOURS = { open: '9:00 AM', close: '9:00 PM', closedDay: 'Tuesday' };

// ---------------------------------------------------------------------------
// Storage: SQLite with JSON-file fallback
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

let store = null; // { kind, ... } — unified interface below

function initSqlite() {
  const Database = require('better-sqlite3');
  const dbPath = path.join(DATA_DIR, 'bookings.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    date TEXT NOT NULL,
    start_minutes INTEGER NOT NULL,
    end_minutes INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    email_sent INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS blocked_days (
    date TEXT PRIMARY KEY
  )`);
  // Migration: reminder flag for 1-day-before SMS. Tolerates DBs created
  // before this column existed (ALTER fails harmlessly if present).
  try {
    const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
    if (!cols.includes('reminder_sent')) {
      db.exec('ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: notes + blocked-slot flag ("Block this time" in the
    // owner dashboard). Same tolerance as above.
    if (!cols.includes('notes')) {
      db.exec("ALTER TABLE bookings ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.includes('blocked')) {
      db.exec('ALTER TABLE bookings ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
    }
  } catch (e) {
    console.warn('reminder_sent migration skipped:', e.message);
  }
  return {
    kind: 'sqlite',
    listBlocked: () => db.prepare('SELECT date FROM blocked_days ORDER BY date').all().map((r) => r.date),
    isBlocked: (date) => !!db.prepare('SELECT 1 FROM blocked_days WHERE date = ?').get(date),
    block: (date) => { db.prepare('INSERT OR IGNORE INTO blocked_days (date) VALUES (?)').run(date); },
    unblock: (date) => { db.prepare('DELETE FROM blocked_days WHERE date = ?').run(date); },
    list: () => db.prepare('SELECT * FROM bookings ORDER BY date, start_minutes').all(),
    listOnDate: (date) =>
      db.prepare("SELECT * FROM bookings WHERE date = ? AND status != 'cancelled'").all(date),
    insert: (b) => {
      const r = db.prepare(
        `INSERT INTO bookings (service_id, service_name, date, start_minutes, end_minutes,
          name, phone, email, status, email_sent, created_at, notes, blocked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`
      ).run(b.serviceId, b.serviceName, b.date, b.startMinutes, b.endMinutes,
        b.name, b.phone, b.email, b.emailSent ? 1 : 0, new Date().toISOString(),
        b.notes || '', b.blocked ? 1 : 0);
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid);
    },
    confirm: (id) => {
      const r = db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(id);
      return r.changes > 0 ? db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) : null;
    },
    complete: (id) => {
      db.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").run(id);
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;
    },
    cancel: (id) => {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;
    },
    // Edit a booking. f holds the new field values (camelCase keys);
    // resetReminder clears the reminder flag when the date moved, so a
    // reminder can still go out for the new date.
    update: (id, f) => {
      const map = {
        serviceId: 'service_id', serviceName: 'service_name', date: 'date',
        startMinutes: 'start_minutes', endMinutes: 'end_minutes',
        name: 'name', phone: 'phone', email: 'email', notes: 'notes',
      };
      const cols = [];
      const args = [];
      for (const [key, col] of Object.entries(map)) {
        if (f[key] !== undefined) { cols.push(`${col} = ?`); args.push(f[key]); }
      }
      if (f.resetReminder) cols.push('reminder_sent = 0');
      if (cols.length) {
        args.push(id);
        db.prepare(`UPDATE bookings SET ${cols.join(', ')} WHERE id = ?`).run(...args);
      }
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;
    },
    markEmailSent: (id) => {
      db.prepare('UPDATE bookings SET email_sent = 1 WHERE id = ?').run(id);
    },
    // Confirmed bookings on a date whose reminder SMS has not gone out.
    // Blocked slots are not customer bookings — they get no reminder.
    listDueReminders: (date) => db.prepare(
      "SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' AND COALESCE(reminder_sent, 0) = 0 AND COALESCE(blocked, 0) = 0 ORDER BY start_minutes"
    ).all(date),
    markReminderSent: (id) => {
      db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(id);
    },
  };
}

// Turso (hosted libSQL) — used when TURSO_DATABASE_URL and
// TURSO_AUTH_TOKEN are set. Same tables, columns and SQL as the local
// SQLite store (libSQL is SQLite-compatible); only the driver calls
// are async (client.execute with args arrays). Rows come back as
// objects keyed by column name, exactly like better-sqlite3.
async function initTurso() {
  const { createClient } = require('@libsql/client');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  await client.execute(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    date TEXT NOT NULL,
    start_minutes INTEGER NOT NULL,
    end_minutes INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    email_sent INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS blocked_days (
    date TEXT PRIMARY KEY
  )`);
  // Same reminder_sent migration as the SQLite store.
  const cols = await client.execute('PRAGMA table_info(bookings)');
  const names = cols.rows.map((c) => c.name);
  if (!names.includes('reminder_sent')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0');
  }
  // Same notes/blocked migration as the SQLite store.
  if (!names.includes('notes')) {
    await client.execute("ALTER TABLE bookings ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes('blocked')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  }
  const rowsOf = (r) => r.rows;
  return {
    kind: 'turso',
    listBlocked: async () => rowsOf(await client.execute('SELECT date FROM blocked_days ORDER BY date')).map((r) => r.date),
    isBlocked: async (date) => rowsOf(await client.execute({ sql: 'SELECT 1 FROM blocked_days WHERE date = ?', args: [date] })).length > 0,
    block: async (date) => { await client.execute({ sql: 'INSERT OR IGNORE INTO blocked_days (date) VALUES (?)', args: [date] }); },
    unblock: async (date) => { await client.execute({ sql: 'DELETE FROM blocked_days WHERE date = ?', args: [date] }); },
    list: async () => rowsOf(await client.execute('SELECT * FROM bookings ORDER BY date, start_minutes')),
    listOnDate: async (date) =>
      rowsOf(await client.execute({ sql: "SELECT * FROM bookings WHERE date = ? AND status != 'cancelled'", args: [date] })),
    insert: async (b) => {
      const r = await client.execute({
        sql: `INSERT INTO bookings (service_id, service_name, date, start_minutes, end_minutes,
          name, phone, email, status, email_sent, created_at, notes, blocked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
        args: [b.serviceId, b.serviceName, b.date, b.startMinutes, b.endMinutes,
          b.name, b.phone, b.email, b.emailSent ? 1 : 0, new Date().toISOString(),
          b.notes || '', b.blocked ? 1 : 0],
      });
      let id = (r.lastInsertRowid !== undefined && r.lastInsertRowid !== null)
        ? Number(r.lastInsertRowid) : null;
      if (id === null) {
        const maxRow = await client.execute('SELECT MAX(id) AS max_id FROM bookings');
        id = Number(maxRow.rows[0].max_id);
      }
      const row = await client.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [id] });
      return row.rows[0];
    },
    confirm: async (id) => {
      await client.execute({ sql: "UPDATE bookings SET status = 'confirmed' WHERE id = ?", args: [id] });
      const row = await client.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [id] });
      return row.rows[0] || null;
    },
    complete: async (id) => {
      await client.execute({ sql: "UPDATE bookings SET status = 'completed' WHERE id = ?", args: [id] });
      const row = await client.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [id] });
      return row.rows[0] || null;
    },
    cancel: async (id) => {
      await client.execute({ sql: "UPDATE bookings SET status = 'cancelled' WHERE id = ?", args: [id] });
      const row = await client.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [id] });
      return row.rows[0] || null;
    },
    // Edit a booking. f holds the new field values (camelCase keys);
    // resetReminder clears the reminder flag when the date moved.
    update: async (id, f) => {
      const map = {
        serviceId: 'service_id', serviceName: 'service_name', date: 'date',
        startMinutes: 'start_minutes', endMinutes: 'end_minutes',
        name: 'name', phone: 'phone', email: 'email', notes: 'notes',
      };
      const cols = [];
      const args = [];
      for (const [key, col] of Object.entries(map)) {
        if (f[key] !== undefined) { cols.push(`${col} = ?`); args.push(f[key]); }
      }
      if (f.resetReminder) cols.push('reminder_sent = 0');
      if (cols.length) {
        args.push(id);
        await client.execute({ sql: `UPDATE bookings SET ${cols.join(', ')} WHERE id = ?`, args });
      }
      const row = await client.execute({ sql: 'SELECT * FROM bookings WHERE id = ?', args: [id] });
      return row.rows[0] || null;
    },
    // Confirmed bookings on a date whose reminder SMS has not gone out.
    // Blocked slots are not customer bookings — they get no reminder.
    listDueReminders: async (date) => rowsOf(await client.execute({
      sql: "SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' AND COALESCE(reminder_sent, 0) = 0 AND COALESCE(blocked, 0) = 0 ORDER BY start_minutes",
      args: [date],
    })),
    markReminderSent: async (id) => {
      await client.execute({ sql: 'UPDATE bookings SET reminder_sent = 1 WHERE id = ?', args: [id] });
    },
    markEmailSent: async (id) => {
      await client.execute({ sql: 'UPDATE bookings SET email_sent = 1 WHERE id = ?', args: [id] });
    },
  };
}

function initJsonFallback() {
  const file = path.join(DATA_DIR, 'bookings.json');
  let rows = [];
  try {
    if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) rows = [];
  } catch (_) { rows = []; }
  let dirty = false;
  const flush = () => { try { fs.writeFileSync(file, JSON.stringify(rows, null, 2)); } catch (_) { /* in-memory only */ } };
  // Blocked days (owner-blocked dates) — separate JSON file, same pattern.
  const blockedFile = path.join(DATA_DIR, 'blocked-days.json');
  let blocked = [];
  try {
    if (fs.existsSync(blockedFile)) blocked = JSON.parse(fs.readFileSync(blockedFile, 'utf8'));
    if (!Array.isArray(blocked)) blocked = [];
  } catch (_) { blocked = []; }
  const flushBlocked = () => { try { fs.writeFileSync(blockedFile, JSON.stringify(blocked, null, 2)); } catch (_) { /* in-memory only */ } };
  return {
    kind: 'json',
    listBlocked: () => [...blocked].sort(),
    isBlocked: (date) => blocked.includes(date),
    block: (date) => { if (!blocked.includes(date)) { blocked.push(date); blocked.sort(); flushBlocked(); } },
    unblock: (date) => { blocked = blocked.filter((d) => d !== date); flushBlocked(); },
    list: () => [...rows].sort((a, b) => (a.date + a.startMinutes) - (b.date + b.startMinutes)),
    listOnDate: (date) => rows.filter((r) => r.date === date && r.status !== 'cancelled'),
    insert: (b) => {
      const row = { id: (rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1), ...b, status: 'confirmed', emailSent: !!b.emailSent, createdAt: new Date().toISOString(), notes: b.notes || '', blocked: !!b.blocked };
      rows.push(row); flush(); return row;
    },
    confirm: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      row.status = 'confirmed'; flush(); return row;
    },
    complete: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      row.status = 'completed'; flush(); return row;
    },
    cancel: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      row.status = 'cancelled'; flush(); return row;
    },
    // Edit a booking. f holds the new field values (camelCase keys);
    // resetReminder clears the reminder flag when the date moved.
    update: (id, f) => {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      for (const k of ['serviceId', 'serviceName', 'date', 'startMinutes', 'endMinutes', 'name', 'phone', 'email', 'notes']) {
        if (f[k] !== undefined) row[k] = f[k];
      }
      if (f.resetReminder) row.reminderSent = false;
      flush(); return row;
    },
    listDueReminders: (date) => rows
      .filter((r) => r.date === date && r.status === 'confirmed' && !r.reminderSent && !r.blocked)
      .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0)),
    markReminderSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.reminderSent = true; flush(); }
    },
    markEmailSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.emailSent = true; flush(); }
    },
  };
}

// Storage selection (async — Turso needs network + schema setup).
// Turso first when its env vars are set; if it fails at startup the
// server falls back to local SQLite and keeps working (bookings still
// save) instead of crashing. Without the Turso vars, local SQLite is
// the default, with the JSON-file fallback as a last resort.
// The returned store has an async interface for every backend (await
// works on the sync SQLite/JSON methods too), and rows are normalised
// to camelCase — see norm() below. `store` is assigned before the
// server starts listening (see the storeReady.then at the bottom).
async function initStore() {
  let raw = null;
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    try {
      raw = await initTurso();
      console.log('Storage: Turso (hosted libSQL) — bookings survive redeploys');
    } catch (e) {
      console.warn('TURSO UNAVAILABLE, falling back to local SQLite — bookings will NOT survive redeploys:', e.message);
    }
  }
  if (!raw) {
    try {
      raw = initSqlite();
      console.log('Storage: SQLite file at', path.join(DATA_DIR, 'bookings.db'));
    } catch (e) {
      console.warn('SQLite unavailable, using JSON-file fallback:', e.message);
      raw = initJsonFallback();
      console.log('Storage: JSON file fallback');
    }
  }
  return {
    kind: raw.kind,
    list: async () => (await raw.list()).map(norm),
    listOnDate: async (d) => (await raw.listOnDate(d)).map(norm),
    insert: async (b) => norm(await raw.insert(b)),
    confirm: async (id) => norm(await raw.confirm(id)),
    complete: async (id) => norm(await raw.complete(id)),
    cancel: async (id) => norm(await raw.cancel(id)),
    update: async (id, f) => norm(await raw.update(id, f)),
    listDueReminders: async (d) => (await raw.listDueReminders(d)).map(norm),
    markReminderSent: async (id) => { await raw.markReminderSent(id); },
    markEmailSent: async (id) => { await raw.markEmailSent(id); },
    listBlocked: async () => await raw.listBlocked(),
    isBlocked: async (d) => await raw.isBlocked(d),
    block: async (d) => { await raw.block(d); },
    unblock: async (d) => { await raw.unblock(d); },
  };
}
const storeReady = initStore().then((s) => { store = s; });

// Normalise rows to camelCase — SQLite returns snake_case columns,
// the JSON fallback stores camelCase. Every consumer below relies on
// the camelCase shape.
function norm(b) {
  if (!b) return null;
  return {
    id: b.id,
    serviceId: b.service_id || b.serviceId,
    serviceName: b.service_name || b.serviceName,
    date: b.date,
    startMinutes: b.start_minutes ?? b.startMinutes,
    endMinutes: b.end_minutes ?? b.endMinutes,
    name: b.name, phone: b.phone, email: b.email,
    status: b.status,
    notes: b.notes || '',
    blocked: !!(b.blocked ?? 0),
    emailSent: !!(b.email_sent ?? b.emailSent),
    reminderSent: !!(b.reminder_sent ?? b.reminderSent),
    createdAt: b.created_at || b.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function minutesToTime(m) {
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm} ${ampm}`;
}

// "2026-11-15" -> "Sun, Nov 15, 2026" (noon avoids timezone shifts).
function formatDate(d) {
  const dt = new Date(`${d}T12:00:00`);
  if (isNaN(dt)) return d;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(dt);
}

function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((t || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + min;
}

// Today's date (YYYY-MM-DD) in the salon timezone.
function todayInSalonTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Minutes since midnight "now" in the salon timezone. hourCycle h23
// (not hour12:false) so midnight formats as 00, never 24.
function nowMinutesInSalonTz() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

// True when a date+start is in the past and must never be bookable or
// shown: any past date, or today with a start at or before the current
// time (salon timezone). Future dates are never past.
function isPastSlot(dateStr, startMinutes) {
  const today = todayInSalonTz();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return startMinutes <= nowMinutesInSalonTz();
}

// Tomorrow's date (YYYY-MM-DD) in the salon timezone.
function tomorrowInSalonTz() {
  const [y, mo, d] = todayInSalonTz().split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

// Weekday (0=Sunday) of a YYYY-MM-DD date.
function weekdayOf(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === dateStr;
}

// Slots available for a service on a date: 30-min starts, 9 AM–9 PM.
// A slot is offered only if the whole service finishes by 9 PM, and
// never when it is in the past (past dates offer nothing; for today
// only slots starting after the current time, salon timezone).
async function availableSlots(service, dateStr) {
  if (weekdayOf(dateStr) === CLOSED_WEEKDAY) return [];
  const taken = await store.listOnDate(dateStr);
  const slots = [];
  for (let start = OPEN_MINUTES; start + service.duration <= CLOSE_MINUTES; start += 30) {
    const end = start + service.duration;
    if (isPastSlot(dateStr, start)) continue;
    const clash = taken.some((b) => start < b.endMinutes && end > b.startMinutes);
    if (!clash) slots.push({ time: minutesToTime(start), startMinutes: start, endMinutes: end });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Email (optional — bookings save even when not configured)
// ---------------------------------------------------------------------------
let mailer = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  try {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    console.log('Email: Gmail SMTP configured for', process.env.GMAIL_USER);
  } catch (e) {
    console.warn('Email: nodemailer failed to initialise:', e.message);
  }
} else {
  console.log('Email: NOT configured (set GMAIL_USER and GMAIL_APP_PASSWORD). Bookings will still save; emailSent will be false.');
}

async function sendBookingEmails(booking, service) {
  if (!mailer) return false;
  // booking is the public shape: time/endTime are already formatted
  // strings; startMinutes/endMinutes are NOT present (recomputing them
  // here produced "NaN:NaN AM").
  const when = `${formatDate(booking.date)} at ${booking.time} – ${booking.endTime} (${TZ})`;
  const clientMail = {
    from: `"${SALON_NAME}" <${process.env.GMAIL_USER}>`,
    to: booking.email,
    subject: `Your ${SALON_NAME} appointment is booked — ${formatDate(booking.date)}`,
    text: `Hi ${booking.name},\n\nYour appointment at ${SALON_NAME} is booked:\n\nService: ${service.name} (${service.priceLabel}, ${service.duration} min)\nWhen: ${when}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nIf you need to change or cancel, please reply to this email or call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  const salonMail = {
    from: `"${SALON_NAME} bookings" <${process.env.GMAIL_USER}>`,
    to: SALON_EMAIL,
    subject: `New booking: ${service.name} — ${formatDate(booking.date)} ${booking.time} (${booking.name})`,
    text: `New booking at ${SALON_NAME}:\n\nService: ${service.name} (${service.priceLabel}, ${service.duration} min)\nWhen: ${when}\nClient: ${booking.name}\nPhone: ${booking.phone}\nEmail: ${booking.email}\n\nThis booking is confirmed automatically — no action needed. You can view it in the owner dashboard at https://pxcutzz.com/dashboard.`,
  };
  try {
    await mailer.sendMail(clientMail);
    await mailer.sendMail(salonMail);
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// SMS via Twilio (optional — everything still works when not configured)
// ---------------------------------------------------------------------------
// The client only initialises when all three env vars are set. The
// account SID / auth token / phone number are NEVER written to code,
// logs or responses — they live in Render env vars only.
let smsClient = null;
const SMS_FROM = process.env.TWILIO_PHONE_NUMBER || '';
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && SMS_FROM) {
  try {
    const twilio = require('twilio');
    smsClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('SMS: Twilio configured, sending from', SMS_FROM);
  } catch (e) {
    console.warn('SMS: twilio failed to initialise:', e.message);
  }
} else {
  console.log('SMS: NOT configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER). Bookings will still save; no texts will be sent.');
}

// Send one SMS. Returns true on success, false otherwise — never throws,
// so callers can fire-and-forget without risking the booking response.
async function sendSms(to, body) {
  if (!smsClient) return false;
  try {
    await smsClient.messages.create({ from: SMS_FROM, to, body });
    return true;
  } catch (e) {
    console.error('SMS send failed to', to, ':', e.message);
    return false;
  }
}

// Booking confirmation texts: one to the client, one to the owner.
// Fire-and-forget — failures are logged by sendSms and never thrown.
async function sendBookingSms(booking, service) {
  // booking is the public shape: time is already formatted, startMinutes
  // is NOT present — recomputing it here produced "NaN:NaN AM".
  const time = booking.time;
  const date = formatDate(booking.date);
  const clientBody = `PXCUTZZ: Your ${service.name} appointment is confirmed for ${date} at ${time}. See you at ${SALON_ADDRESS}. To change or cancel call 6725882101.`;
  await sendSms(booking.phone, clientBody);
  const ownerBody = `PXCUTZZ booking: ${service.name} — ${date} at ${time} (${booking.name}, ${booking.phone}).`;
  await sendSms(OWNER_PHONE, ownerBody);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function publicBooking(b) {
  return {
    id: b.id,
    serviceId: b.service_id || b.serviceId,
    serviceName: b.service_name || b.serviceName,
    date: b.date,
    startMinutes: b.startMinutes,
    endMinutes: b.endMinutes,
    time: minutesToTime(b.startMinutes),
    endTime: minutesToTime(b.endMinutes),
    name: b.name, phone: b.phone, email: b.email,
    status: b.status, emailSent: !!b.emailSent,
    notes: b.notes || '', blocked: !!b.blocked,
    reminderSent: !!b.reminderSent,
    createdAt: b.created_at || b.createdAt,
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.query.token || req.headers['x-admin-token'];
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Admin token required. Set it in the Manage view.' });
}

app.get('/api/health', (req, res) => res.json({
  ok: true, salon: SALON_NAME, storage: store.kind,
  emailConfigured: !!mailer, smsConfigured: !!smsClient, adminProtected: !!ADMIN_TOKEN,
}));

app.get('/api/info', (req, res) => res.json({
  salon: SALON_NAME, phone: SALON_PHONE, email: SALON_EMAIL, address: SALON_ADDRESS,
  timezone: TZ, hours: OPENING_HOURS,
  services: SERVICES,
}));

app.get('/api/services', (req, res) => res.json(SERVICES));

app.get('/api/slots', async (req, res) => {
  const { date, serviceId } = req.query;
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Unknown service.' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  if (date < todayInSalonTz()) return res.status(400).json({ error: 'Please pick today or a future date.' });
  if (weekdayOf(date) === CLOSED_WEEKDAY)
    return res.json({ date, closed: true, message: 'The salon is closed on Tuesdays.', slots: [] });
  if (await store.isBlocked(date))
    return res.json({ date, closed: true, blocked: true, message: 'The salon is closed on this day.', slots: [] });
  res.json({ date, closed: false, slots: await availableSlots(service, date) });
});

app.post('/api/bookings', async (req, res) => {
  const { serviceId, date, time, name, phone, email, notes, blocked } = req.body || {};
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Please choose a service.' });
  // "Block this time (no customer)" — an owner-only action. The public
  // booking form must never be able to create a blocked slot, so a
  // blocked request needs the same valid admin token as the other
  // admin endpoints (requireAdmin's rule, applied inline here because
  // this endpoint is otherwise public).
  const isBlockedBooking = !!blocked;
  if (isBlockedBooking && ADMIN_TOKEN) {
    const token = req.query.token || req.headers['x-admin-token'];
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Admin token required. Set it in the Manage view.' });
    }
  }
  if (!isValidDate(date) || date < todayInSalonTz())
    return res.status(400).json({ error: 'Please pick today or a future date.' });
  if (weekdayOf(date) === CLOSED_WEEKDAY)
    return res.status(400).json({ error: 'The salon is closed on Tuesdays.' });
  if (await store.isBlocked(date))
    return res.status(400).json({ error: 'The salon is closed on that day.' });
  const startMinutes = timeToMinutes(time);
  if (startMinutes === null) return res.status(400).json({ error: 'Please choose a valid time slot.' });
  if (startMinutes < OPEN_MINUTES || startMinutes + service.duration > CLOSE_MINUTES)
    return res.status(400).json({ error: 'That time is outside opening hours (9:00 AM – 9:00 PM).' });
  // A past slot can never be booked, even by a direct API call — the
  // slot list hides it, and this rejects it too.
  if (isPastSlot(date, startMinutes))
    return res.status(400).json({ error: 'That time has already passed. Please pick a later slot.' });
  // A blocked slot has no customer, so name/phone/email don't apply.
  if (!isBlockedBooking) {
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Please enter your phone number.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const cleanNotes = String(notes || '').trim().slice(0, 500);

  const endMinutes = startMinutes + service.duration;
  const clash = (await store.listOnDate(date)).some((b) => startMinutes < b.endMinutes && endMinutes > b.startMinutes);
  if (clash) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another slot.' });

  const row = await store.insert({
    serviceId: service.id, serviceName: service.name, date, startMinutes, endMinutes,
    name: isBlockedBooking ? '' : String(name).trim(),
    phone: isBlockedBooking ? '' : String(phone).trim(),
    email: isBlockedBooking ? '' : String(email).trim().toLowerCase(),
    emailSent: false,
    notes: cleanNotes,
    blocked: isBlockedBooking,
  });
  const saved = publicBooking(row);
  // A blocked slot is not a customer booking: no confirmation email,
  // no SMS — it just occupies the time.
  if (isBlockedBooking) {
    return res.status(201).json({
      booking: saved,
      emailSent: false,
      emailNote: 'Time blocked — no customer booking, so no confirmation was sent.',
    });
  }
  const emailSent = await sendBookingEmails(saved, service);
  if (emailSent) {
    // best-effort flag update (works on every backend); the emails did
    // go out either way, so a failure here never fails the booking.
    try { await store.markEmailSent(row.id); saved.emailSent = true; } catch (_) { /* flag stays false */ }
  }
  saved.emailSent = emailSent;
  // Confirmation texts (client + owner). Fire-and-forget: the booking
  // response never waits on Twilio and never fails because of SMS.
  sendBookingSms(saved, service).catch((e) => console.error('SMS send failed:', e.message));
  res.status(201).json({
    booking: saved,
    emailSent,
    emailNote: emailSent
      ? 'Confirmation email sent to the client and an alert sent to the salon.'
      : 'A confirmation text message has been sent to your phone.',
  });
});

app.get('/api/bookings', requireAdmin, async (req, res) => {
  res.json((await store.list()).map(publicBooking));
});

app.post('/api/bookings/:id/confirm', requireAdmin, async (req, res) => {
  const row = await store.confirm(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  res.json(publicBooking(row));
});

// Mark a booking completed. Completed bookings still block their slot.
app.post('/api/bookings/:id/complete', requireAdmin, async (req, res) => {
  const row = await store.complete(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  res.json(publicBooking(row));
});

// Cancel a booking. Cancelled bookings no longer block their slot
// (listOnDate excludes them), so the time becomes bookable again.
app.post('/api/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const row = await store.cancel(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  res.json(publicBooking(row));
});

// Edit a booking (owner). Validates exactly like creation: service
// exists, date valid and not in the past, not Tuesday, not a blocked
// day, time valid and within opening hours, and no clash with other
// (non-cancelled) bookings — excluding the booking itself.
app.put('/api/bookings/:id', requireAdmin, async (req, res) => {
  const all = await store.list();
  const existing = all.find((b) => String(b.id) === String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Booking not found.' });
  const { serviceId, date, time, name, phone, email, notes } = req.body || {};
  const service = SERVICES.find((s) => s.id === (serviceId || existing.serviceId));
  if (!service) return res.status(400).json({ error: 'Please choose a service.' });
  const newDate = date || existing.date;
  // Stored rows carry startMinutes, not a formatted time string — fall
  // back to that when the caller sends no time (e.g. a notes-only edit).
  const newTime = time || minutesToTime(existing.startMinutes);
  if (!isValidDate(newDate) || newDate < todayInSalonTz())
    return res.status(400).json({ error: 'Please pick today or a future date.' });
  if (weekdayOf(newDate) === CLOSED_WEEKDAY)
    return res.status(400).json({ error: 'The salon is closed on Tuesdays.' });
  if (await store.isBlocked(newDate))
    return res.status(400).json({ error: 'The salon is closed on that day.' });
  const startMinutes = timeToMinutes(newTime);
  if (startMinutes === null) return res.status(400).json({ error: 'Please choose a valid time slot.' });
  if (startMinutes < OPEN_MINUTES || startMinutes + service.duration > CLOSE_MINUTES)
    return res.status(400).json({ error: 'That time is outside opening hours (9:00 AM – 9:00 PM).' });
  // Moving a booking into a past slot is never allowed. Keeping the
  // booking's existing slot (e.g. a notes-only edit of a booking whose
  // time has since passed) is history, not a new booking — allowed.
  const slotChanged = newDate !== existing.date || startMinutes !== existing.startMinutes;
  if (slotChanged && isPastSlot(newDate, startMinutes))
    return res.status(400).json({ error: 'That time has already passed. Please pick a later slot.' });
  // A blocked slot has no customer — its name/phone/email stay empty.
  const newName = existing.blocked ? existing.name : (name ?? existing.name);
  const newPhone = existing.blocked ? existing.phone : (phone ?? existing.phone);
  const newEmail = existing.blocked ? existing.email : (email ?? existing.email);
  if (!existing.blocked) {
    if (!newName || !String(newName).trim()) return res.status(400).json({ error: 'Please enter your name.' });
    if (!newPhone || !String(newPhone).trim()) return res.status(400).json({ error: 'Please enter your phone number.' });
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(newEmail).trim()))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const endMinutes = startMinutes + service.duration;
  const clash = (await store.listOnDate(newDate)).some((b) =>
    String(b.id) !== String(existing.id) && startMinutes < b.endMinutes && endMinutes > b.startMinutes);
  if (clash) return res.status(409).json({ error: 'That time is already taken. Please pick another slot.' });
  const row = await store.update(existing.id, {
    serviceId: service.id, serviceName: service.name, date: newDate,
    startMinutes, endMinutes,
    name: String(newName || '').trim(), phone: String(newPhone || '').trim(),
    email: String(newEmail || '').trim().toLowerCase(),
    notes: notes !== undefined ? String(notes).trim().slice(0, 500) : existing.notes,
    resetReminder: newDate !== existing.date,
  });
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  res.json(publicBooking(row));
});

// 1-day-before reminder texts. Admin-only; call it once a day (e.g. from
// a scheduled job). Idempotent: a booking is flagged reminder_sent only
// after its text succeeds, and only unflagged bookings are picked up,
// so a second call never double-texts anyone.
app.post('/api/reminders/send-due', requireAdmin, async (req, res) => {
  const tomorrow = tomorrowInSalonTz();
  const due = await store.listDueReminders(tomorrow);
  let sent = 0, failed = 0, skipped = 0;
  for (const b of due) {
    if (!smsClient) { skipped++; continue; }
    const body = `PXCUTZZ reminder: your ${b.serviceName} appointment is tomorrow (${formatDate(b.date)}) at ${minutesToTime(b.startMinutes)}. See you soon! To change or cancel call 6725882101.`;
    const ok = await sendSms(b.phone, body);
    if (ok) { await store.markReminderSent(b.id); sent++; }
    else failed++;
  }
  res.json({ date: tomorrow, sent, failed, skipped, smsConfigured: !!smsClient });
});

// Send a test text to the owner to prove the SMS service works.
app.post('/api/sms/test', requireAdmin, async (req, res) => {
  if (!smsClient) {
    return res.status(503).json({ ok: false, error: 'SMS is not configured on this server (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER).' });
  }
  const ok = await sendSms(OWNER_PHONE, 'PXCUTZZ: SMS service is working. Booking confirmations and reminders will come from this number.');
  if (ok) return res.json({ ok: true, message: 'Test SMS sent to the owner.' });
  return res.status(502).json({ ok: false, error: 'Test SMS failed to send. Check the Twilio credentials and number.' });
});

// Owner-blocked days — dates the salon is closed (e.g. holidays).
// All three endpoints need the admin token.
app.get('/api/blocked-days', requireAdmin, async (req, res) => {
  res.json({ dates: await store.listBlocked() });
});

app.post('/api/blocked-days', requireAdmin, async (req, res) => {
  const { date } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  await store.block(date);
  res.status(201).json({ dates: await store.listBlocked() });
});

app.delete('/api/blocked-days/:date', requireAdmin, async (req, res) => {
  if (!isValidDate(req.params.date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  await store.unblock(req.params.date);
  res.json({ dates: await store.listBlocked() });
});

// Owner booking dashboard (separate page; the Manage section on the
// main site is unchanged).
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start listening only once storage is ready (Turso schema setup is
// async) — no request can arrive before `store` is assigned.
storeReady.then(() => {
  app.listen(PORT, () => {
    console.log(`${SALON_NAME} booking app listening on port ${PORT} (storage: ${store.kind}, email: ${mailer ? 'configured' : 'not configured'}, sms: ${smsClient ? 'configured' : 'not configured'})`);
  });
});
