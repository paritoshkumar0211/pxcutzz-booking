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
 * Email: Resend API when RESEND_API_KEY is set (sends from
 * bookings@pxcutzz.com once the domain is verified in Resend), else
 * nodemailer over Gmail SMTP when GMAIL_USER and GMAIL_APP_PASSWORD
 * are set. Bookings always save even if email is not configured; the
 * API reports emailSent: false in that case.
 *
 * SMS: Twilio, only when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_PHONE_NUMBER are all set. 3-hour appointment reminders and
 * membership texts are sent fire-and-forget — a booking never
 * fails because SMS is unconfigured or a send fails. Booking
 * confirmation texts were removed 2026-11-16 at the owner's request.
 * The API reports smsConfigured in /api/health.
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
// Daily lunch break, every open day (added 2026-11-16 at the owner's
// request): no booking may overlap 2:00–2:30 PM. A service may end
// exactly at 2:00 PM or start exactly at 2:30 PM.
const LUNCH_START_MINUTES = 14 * 60; // 2:00 PM
const LUNCH_END_MINUTES = 14 * 60 + 30; // 2:30 PM
function overlapsLunch(startMinutes, endMinutes) {
  return startMinutes < LUNCH_END_MINUTES && endMinutes > LUNCH_START_MINUTES;
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // if set, Manage view needs it
// Owner's phone for booking alerts and the SMS test endpoint.
const OWNER_PHONE = process.env.OWNER_PHONE || '+16725882101';

// Services — prices/durations exactly as provided by the owner.
// Durations marked "placeholder: true" were not given by the owner and
// were set to 30 minutes. Do not present them as owner-confirmed.
const SERVICES = [
  { id: 'skin-fade-haircut', name: 'Skin Fade (Haircut)', price: 25, priceLabel: '$25', duration: 30 },
  { id: 'haircut-beard', name: 'Haircut & Beard', price: 45, priceLabel: '$45', duration: 45 },
  { id: 'hair-perms', name: 'Hair Perms', price: 120, priceLabel: '$120', duration: 60 },
  { id: 'mens-facial', name: "Men's Facial Treatments", price: 50, priceLabel: 'from $50', duration: 30 },
  { id: 'beard-trimming-styling', name: 'Beard Trimming and Lineup', price: 20, priceLabel: '$20', duration: 30, placeholderDuration: true },
  { id: 'beard-trim-waxing', name: 'Beard Trim and Waxing', price: 25, priceLabel: '$25', duration: 30 },
  { id: 'beard-lineup', name: 'Beard Lineup (Straight Razor)', price: 10, priceLabel: '$10', duration: 15 },
  { id: 'd-tan', name: 'D Tan', price: 15, priceLabel: '$15', duration: 15, placeholderDuration: true },
  { id: 'scrub', name: 'Scrub', price: 25, priceLabel: '$25', duration: 15, placeholderDuration: true },
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
    reminder_3h_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS blocked_days (
    date TEXT PRIMARY KEY
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    joined_date TEXT NOT NULL,
    next_reminder_date TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    renewal_reminder_sent INTEGER NOT NULL DEFAULT 0,
    prior_haircuts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  // Migration: reminder flag for 1-day-before SMS. Tolerates DBs created
  // before this column existed (ALTER fails harmlessly if present).
  try {
    const cols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
    if (!cols.includes('reminder_sent')) {
      db.exec('ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: 3-hours-before reminder flag. Same tolerance as above.
    if (!cols.includes('reminder_3h_sent')) {
      db.exec('ALTER TABLE bookings ADD COLUMN reminder_3h_sent INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: 1-day-before email reminder flag. Same tolerance.
    if (!cols.includes('email_reminder_sent')) {
      db.exec('ALTER TABLE bookings ADD COLUMN email_reminder_sent INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: notes + blocked-slot flag ("Block this time" in the
    // owner dashboard). Same tolerance as above.
    if (!cols.includes('notes')) {
      db.exec("ALTER TABLE bookings ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.includes('blocked')) {
      db.exec('ALTER TABLE bookings ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: renewal-reminder flag on members (added with the
    // 1-month membership expiry). Tolerates tables created before it.
    const memberCols = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
    if (!memberCols.includes('renewal_reminder_sent')) {
      db.exec('ALTER TABLE members ADD COLUMN renewal_reminder_sent INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: haircuts already used before the member was added
    // (old clients added by the owner). Same tolerance as above.
    if (!memberCols.includes('prior_haircuts')) {
      db.exec('ALTER TABLE members ADD COLUMN prior_haircuts INTEGER NOT NULL DEFAULT 0');
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
      if (f.resetReminder) cols.push('reminder_sent = 0', 'reminder_3h_sent = 0', 'email_reminder_sent = 0');
      if (cols.length) {
        args.push(id);
        db.prepare(`UPDATE bookings SET ${cols.join(', ')} WHERE id = ?`).run(...args);
      }
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;
    },
    markEmailSent: (id) => {
      db.prepare('UPDATE bookings SET email_sent = 1 WHERE id = ?').run(id);
    },
    markEmailReminderSent: (id) => {
      db.prepare('UPDATE bookings SET email_reminder_sent = 1 WHERE id = ?').run(id);
    },
    // Members ($110 for 3 haircuts) — the only clients who get the
    // 9-day reminder texts.
    listMembers: () => db.prepare('SELECT * FROM members ORDER BY name').all(),
    insertMember: (m) => {
      const r = db.prepare(
        `INSERT INTO members (name, phone, email, joined_date, next_reminder_date, active, renewal_reminder_sent, prior_haircuts, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(m.name, m.phone, m.email || '', m.joinedDate, m.nextReminderDate, m.priorHaircuts || 0, m.createdAt || new Date().toISOString());
      return db.prepare('SELECT * FROM members WHERE id = ?').get(r.lastInsertRowid);
    },
    updateMember: (id, f) => {
      const cols = [];
      const args = [];
      if (f.joinedDate !== undefined) { cols.push('joined_date = ?'); args.push(f.joinedDate); }
      if (f.nextReminderDate !== undefined) { cols.push('next_reminder_date = ?'); args.push(f.nextReminderDate); }
      if (f.active !== undefined) { cols.push('active = ?'); args.push(f.active ? 1 : 0); }
      if (f.renewalReminderSent !== undefined) { cols.push('renewal_reminder_sent = ?'); args.push(f.renewalReminderSent ? 1 : 0); }
      if (f.priorHaircuts !== undefined) { cols.push('prior_haircuts = ?'); args.push(f.priorHaircuts); }
      if (cols.length) {
        args.push(id);
        db.prepare(`UPDATE members SET ${cols.join(', ')} WHERE id = ?`).run(...args);
      }
      return db.prepare('SELECT * FROM members WHERE id = ?').get(id) || null;
    },
    deleteMember: (id) => { db.prepare('DELETE FROM members WHERE id = ?').run(id); },
    // Confirmed bookings on a date whose reminder SMS has not gone out.
    // Blocked slots are not customer bookings — they get no reminder.
    listDueReminders: (date) => db.prepare(
      "SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' AND COALESCE(reminder_sent, 0) = 0 AND COALESCE(blocked, 0) = 0 ORDER BY start_minutes"
    ).all(date),
    markReminderSent: (id) => {
      db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(id);
    },
    // Confirmed bookings today whose start is upcoming within (from, to]
    // minutes from now — the 3-hours-before reminder window. Same
    // exclusions as the 1-day reminder (cancelled, blocked, already sent).
    listDue3hReminders: (date, fromMinutes, toMinutes) => db.prepare(
      "SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' AND COALESCE(reminder_3h_sent, 0) = 0 AND COALESCE(blocked, 0) = 0 AND start_minutes > ? AND start_minutes <= ? ORDER BY start_minutes"
    ).all(date, fromMinutes, toMinutes),
    markReminder3hSent: (id) => {
      db.prepare('UPDATE bookings SET reminder_3h_sent = 1 WHERE id = ?').run(id);
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
    reminder_3h_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS blocked_days (
    date TEXT PRIMARY KEY
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    joined_date TEXT NOT NULL,
    next_reminder_date TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    renewal_reminder_sent INTEGER NOT NULL DEFAULT 0,
    prior_haircuts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  // Same reminder_sent migration as the SQLite store.
  const cols = await client.execute('PRAGMA table_info(bookings)');
  const names = cols.rows.map((c) => c.name);
  if (!names.includes('reminder_sent')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0');
  }
  // Same 3-hours-before reminder migration as the SQLite store.
  if (!names.includes('reminder_3h_sent')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN reminder_3h_sent INTEGER NOT NULL DEFAULT 0');
  }
  // Same 1-day-before email reminder migration as the SQLite store.
  if (!names.includes('email_reminder_sent')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN email_reminder_sent INTEGER NOT NULL DEFAULT 0');
  }
  // Same notes/blocked migration as the SQLite store.
  if (!names.includes('notes')) {
    await client.execute("ALTER TABLE bookings ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes('blocked')) {
    await client.execute('ALTER TABLE bookings ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  }
  // Same renewal-reminder migration as the SQLite store.
  const memberCols = await client.execute('PRAGMA table_info(members)');
  if (!memberCols.rows.map((c) => c.name).includes('renewal_reminder_sent')) {
    await client.execute('ALTER TABLE members ADD COLUMN renewal_reminder_sent INTEGER NOT NULL DEFAULT 0');
  }
  // Same prior-haircuts migration as the SQLite store.
  if (!memberCols.rows.map((c) => c.name).includes('prior_haircuts')) {
    await client.execute('ALTER TABLE members ADD COLUMN prior_haircuts INTEGER NOT NULL DEFAULT 0');
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
      if (f.resetReminder) cols.push('reminder_sent = 0', 'reminder_3h_sent = 0', 'email_reminder_sent = 0');
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
    // 3-hours-before window: confirmed bookings today starting within
    // (fromMinutes, toMinutes]. Same exclusions as the 1-day reminder.
    listDue3hReminders: async (date, fromMinutes, toMinutes) => rowsOf(await client.execute({
      sql: "SELECT * FROM bookings WHERE date = ? AND status = 'confirmed' AND COALESCE(reminder_3h_sent, 0) = 0 AND COALESCE(blocked, 0) = 0 AND start_minutes > ? AND start_minutes <= ? ORDER BY start_minutes",
      args: [date, fromMinutes, toMinutes],
    })),
    markReminder3hSent: async (id) => {
      await client.execute({ sql: 'UPDATE bookings SET reminder_3h_sent = 1 WHERE id = ?', args: [id] });
    },
    markEmailSent: async (id) => {
      await client.execute({ sql: 'UPDATE bookings SET email_sent = 1 WHERE id = ?', args: [id] });
    },
    markEmailReminderSent: async (id) => {
      await client.execute({ sql: 'UPDATE bookings SET email_reminder_sent = 1 WHERE id = ?', args: [id] });
    },
    // Members ($110 for 3 haircuts) — the only clients who get the
    // 9-day reminder texts.
    listMembers: async () => rowsOf(await client.execute('SELECT * FROM members ORDER BY name')),
    insertMember: async (m) => {
      const r = await client.execute({
        sql: `INSERT INTO members (name, phone, email, joined_date, next_reminder_date, active, renewal_reminder_sent, prior_haircuts, created_at)
              VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        args: [m.name, m.phone, m.email || '', m.joinedDate, m.nextReminderDate, m.priorHaircuts || 0, m.createdAt || new Date().toISOString()],
      });
      let id = (r.lastInsertRowid !== undefined && r.lastInsertRowid !== null)
        ? Number(r.lastInsertRowid) : null;
      if (id === null) {
        const maxRow = await client.execute('SELECT MAX(id) AS max_id FROM members');
        id = Number(maxRow.rows[0].max_id);
      }
      const row = await client.execute({ sql: 'SELECT * FROM members WHERE id = ?', args: [id] });
      return row.rows[0];
    },
    updateMember: async (id, f) => {
      const cols = [];
      const args = [];
      if (f.joinedDate !== undefined) { cols.push('joined_date = ?'); args.push(f.joinedDate); }
      if (f.nextReminderDate !== undefined) { cols.push('next_reminder_date = ?'); args.push(f.nextReminderDate); }
      if (f.active !== undefined) { cols.push('active = ?'); args.push(f.active ? 1 : 0); }
      if (f.renewalReminderSent !== undefined) { cols.push('renewal_reminder_sent = ?'); args.push(f.renewalReminderSent ? 1 : 0); }
      if (f.priorHaircuts !== undefined) { cols.push('prior_haircuts = ?'); args.push(f.priorHaircuts); }
      if (cols.length) {
        args.push(id);
        await client.execute({ sql: `UPDATE members SET ${cols.join(', ')} WHERE id = ?`, args });
      }
      const row = await client.execute({ sql: 'SELECT * FROM members WHERE id = ?', args: [id] });
      return row.rows[0] || null;
    },
    deleteMember: async (id) => {
      await client.execute({ sql: 'DELETE FROM members WHERE id = ?', args: [id] });
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
  // Members ($110 for 3 haircuts) — separate JSON file, same pattern.
  const membersFile = path.join(DATA_DIR, 'members.json');
  let members = [];
  try {
    if (fs.existsSync(membersFile)) members = JSON.parse(fs.readFileSync(membersFile, 'utf8'));
    if (!Array.isArray(members)) members = [];
  } catch (_) { members = []; }
  const flushMembers = () => { try { fs.writeFileSync(membersFile, JSON.stringify(members, null, 2)); } catch (_) { /* in-memory only */ } };
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
      if (f.resetReminder) { row.reminderSent = false; row.reminder3hSent = false; row.emailReminderSent = false; }
      flush(); return row;
    },
    listDueReminders: (date) => rows
      .filter((r) => r.date === date && r.status === 'confirmed' && !r.reminderSent && !r.blocked)
      .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0)),
    markReminderSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.reminderSent = true; flush(); }
    },
    listDue3hReminders: (date, fromMinutes, toMinutes) => rows
      .filter((r) => r.date === date && r.status === 'confirmed' && !r.reminder3hSent && !r.blocked
        && (r.startMinutes ?? 0) > fromMinutes && (r.startMinutes ?? 0) <= toMinutes)
      .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0)),
    markReminder3hSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.reminder3hSent = true; flush(); }
    },
    markEmailSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.emailSent = true; flush(); }
    },
    markEmailReminderSent: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (row) { row.emailReminderSent = true; flush(); }
    },
    // Members ($110 for 3 haircuts) — the only clients who get the
    // 9-day reminder texts.
    listMembers: () => [...members].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    insertMember: (m) => {
      const row = {
        id: (members.reduce((mx, r) => Math.max(mx, r.id || 0), 0) + 1),
        name: m.name, phone: m.phone, email: m.email || '',
        joinedDate: m.joinedDate, nextReminderDate: m.nextReminderDate,
        active: true, renewalReminderSent: false, priorHaircuts: m.priorHaircuts || 0,
        createdAt: m.createdAt || new Date().toISOString(),
      };
      members.push(row); flushMembers(); return row;
    },
    updateMember: (id, f) => {
      const row = members.find((r) => r.id === Number(id));
      if (!row) return null;
      if (f.joinedDate !== undefined) row.joinedDate = f.joinedDate;
      if (f.nextReminderDate !== undefined) row.nextReminderDate = f.nextReminderDate;
      if (f.active !== undefined) row.active = !!f.active;
      if (f.renewalReminderSent !== undefined) row.renewalReminderSent = !!f.renewalReminderSent;
      if (f.priorHaircuts !== undefined) row.priorHaircuts = f.priorHaircuts;
      flushMembers(); return row;
    },
    deleteMember: (id) => {
      members = members.filter((r) => r.id !== Number(id));
      flushMembers();
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
    listDue3hReminders: async (d, from, to) => (await raw.listDue3hReminders(d, from, to)).map(norm),
    markReminder3hSent: async (id) => { await raw.markReminder3hSent(id); },
    markEmailSent: async (id) => { await raw.markEmailSent(id); },
    markEmailReminderSent: async (id) => { await raw.markEmailReminderSent(id); },
    listBlocked: async () => await raw.listBlocked(),
    isBlocked: async (d) => await raw.isBlocked(d),
    block: async (d) => { await raw.block(d); },
    unblock: async (d) => { await raw.unblock(d); },
    listMembers: async () => (await raw.listMembers()).map(normMember),
    // Find a member by phone, matching on the last 10 digits so
    // "+1 672-..." and "672-..." are the same person.
    findMemberByPhone: async (phone) => {
      const want = normalizePhone(phone);
      const all = await raw.listMembers();
      return normMember(all.find((m) => normalizePhone(m.phone) === want)) || null;
    },
    insertMember: async (m) => normMember(await raw.insertMember(m)),
    updateMember: async (id, f) => normMember(await raw.updateMember(id, f)),
    deleteMember: async (id) => { await raw.deleteMember(id); },
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
    emailReminderSent: !!(b.email_reminder_sent ?? b.emailReminderSent),
    createdAt: b.created_at || b.createdAt,
  };
}

// Normalise member rows to camelCase (same snake_case/camelCase split
// as bookings).
function normMember(m) {
  if (!m) return null;
  return {
    id: m.id,
    name: m.name, phone: m.phone, email: m.email || '',
    joinedDate: m.joined_date || m.joinedDate,
    nextReminderDate: m.next_reminder_date || m.nextReminderDate,
    active: !!(m.active ?? 1),
    renewalReminderSent: !!(m.renewal_reminder_sent ?? m.renewalReminderSent),
    priorHaircuts: m.prior_haircuts ?? m.priorHaircuts ?? 0,
    createdAt: m.created_at || m.createdAt,
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

// A date (YYYY-MM-DD) n days after the given date.
function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Membership ($110 for 3 haircuts): members get a reminder text every
// 9 days after joining, telling them to book their next haircut.
// Reminders go ONLY to members — never to other clients.
// A membership lasts ONE MONTH from the join date and finishes when
// all 3 haircuts are used or the month runs out, whichever comes first.
const MEMBERSHIP_REMINDER_DAYS = 9;
const MEMBERSHIP_DURATION_MONTHS = 1;
// Add calendar months to a YYYY-MM-DD date, clamping to the target
// month's last day (Jan 31 + 1 month = Feb 28).
function addMonths(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, mo - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}
function memberExpiryDate(member) { return addMonths(member.joinedDate, MEMBERSHIP_DURATION_MONTHS); }
// Why a membership is finished: 'haircuts' (all 3 used) or 'expired'
// (the month ran out) — null while it is still going.
function memberFinishedReason(member, bookings, today) {
  if (haircutsUsed(member, bookings, today) >= 3) return 'haircuts';
  if ((today || todayInSalonTz()) > memberExpiryDate(member)) return 'expired';
  return null;
}
function memberFinished(member, bookings, today) { return !!memberFinishedReason(member, bookings, today); }
// Services that count as one of the member's 3 haircuts.
const HAIRCUT_SERVICE_IDS = ['skin-fade-haircut', 'haircut-beard', 'membership'];
// Compare phone numbers by their last 10 digits, so "+1 672-..." and
// "672-..." match the same person.
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
// Haircuts a member has used: haircuts already done before they were
// added to the list (old clients — walk-ins, not in the booking
// system), plus confirmed, non-blocked bookings inside the membership
// month (join date to expiry date), for a haircut service, matched by
// phone. Only haircuts ALREADY DONE count: a booking counts once its
// appointment day has arrived (date <= today) — a future appointment
// is not one of the 3 until its day comes. A haircut booked after the
// month ran out is not one of the 3 — the client pays for it
// separately. A booking only counts if it was made AFTER the member
// was added: appointments already on the books when the owner adds an
// old client are inside the "haircuts already done" number they typed
// — counting them again would show 3 when they entered 2. (A member
// with no created date keeps the old count.)
function haircutsUsed(member, bookings, today) {
  const prior = member.priorHaircuts ?? member.prior_haircuts ?? 0;
  const phone = normalizePhone(member.phone);
  if (!phone) return prior;
  const since = member.createdAt || member.created_at || '';
  const doneBy = today || todayInSalonTz();
  return prior + bookings.filter((b) =>
    normalizePhone(b.phone) === phone
    && HAIRCUT_SERVICE_IDS.includes(b.serviceId)
    && b.status !== 'cancelled' && !b.blocked
    && b.date >= member.joinedDate
    && b.date <= memberExpiryDate(member)
    && b.date <= doneBy
    && (!since || (b.createdAt || '') >= since)
  ).length;
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

// A block-time duration (minutes) from the dashboard: a whole number
// of 15-minute steps, 15–480. Returns the minutes, or null when the
// value is missing or invalid.
function parseBlockDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 15 || n > 480 || n % 15 !== 0) return null;
  return n;
}

// Slots available for a service on a date: 15-min starts, 9 AM–9 PM.
// A slot is offered only if the whole service finishes by 9 PM, and
// never when it is in the past (past dates offer nothing; for today
// only slots starting after the current time, salon timezone).
async function availableSlots(service, dateStr) {
  if (weekdayOf(dateStr) === CLOSED_WEEKDAY) return [];
  const taken = await store.listOnDate(dateStr);
  const slots = [];
  for (let start = OPEN_MINUTES; start + service.duration <= CLOSE_MINUTES; start += 15) {
    const end = start + service.duration;
    if (isPastSlot(dateStr, start)) continue;
    if (overlapsLunch(start, end)) continue;
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
}
// Resend (preferred when its API key is set): sends from
// bookings@pxcutzz.com once the domain is verified in Resend. No
// Gmail 2-Step / app password needed.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = `"${SALON_NAME}" <bookings@pxcutzz.com>`;
const RESEND_FROM_BOOKINGS = `"${SALON_NAME} bookings" <bookings@pxcutzz.com>`;
function emailIsConfigured() { return !!mailer || !!RESEND_API_KEY; }
if (!emailIsConfigured()) {
  console.log('Email: NOT configured (set RESEND_API_KEY, or GMAIL_USER and GMAIL_APP_PASSWORD). Bookings will still save; emailSent will be false.');
}

// Send one email through Resend's API (built-in fetch, no extra
// dependency). Throws on a non-2xx response so the caller can log it.
async function sendViaResend(mail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${errText.slice(0, 200)}`);
  }
}

async function sendBookingEmails(booking, service) {
  if (!emailIsConfigured()) return false;
  // booking is the public shape: time/endTime are already formatted
  // strings; startMinutes/endMinutes are NOT present (recomputing them
  // here produced "NaN:NaN AM").
  const when = `${formatDate(booking.date)} at ${booking.time} – ${booking.endTime} (${TZ})`;
  // Clients see the start time only (e.g. 6:00 PM, not 6:00–6:30 PM):
  // the end time is the owner's detail, not the client's.
  const clientWhen = `${formatDate(booking.date)} at ${booking.time} (${TZ})`;
  const gmailFrom = `"${SALON_NAME}" <${process.env.GMAIL_USER}>`;
  const clientMail = {
    from: RESEND_API_KEY ? RESEND_FROM : gmailFrom,
    to: booking.email,
    subject: `Your ${SALON_NAME} appointment is booked — ${formatDate(booking.date)}`,
    text: `Hi ${booking.name},\n\nYour appointment at ${SALON_NAME} is booked:\n\nService: ${service.name} (${service.priceLabel})\nWhen: ${clientWhen}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nIf you need to change or cancel, please call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  const salonMail = {
    from: RESEND_API_KEY ? RESEND_FROM_BOOKINGS : `"${SALON_NAME} bookings" <${process.env.GMAIL_USER}>`,
    to: SALON_EMAIL,
    subject: `New booking: ${service.name} — ${formatDate(booking.date)} ${booking.time} (${booking.name})`,
    text: `New booking at ${SALON_NAME}:\n\nService: ${service.name} (${service.priceLabel}, ${service.duration} min)\nWhen: ${when}\nClient: ${booking.name}\nPhone: ${booking.phone}\nEmail: ${booking.email}\n\nThis booking is confirmed automatically — no action needed. You can view it in the owner dashboard at https://pxcutzz.com/dashboard.`,
  };
  try {
    if (RESEND_API_KEY) {
      await sendViaResend(clientMail);
      await sendViaResend(salonMail);
    } else {
      await mailer.sendMail(clientMail);
      await mailer.sendMail(salonMail);
    }
    return true;
  } catch (e) {
    console.error('Email send failed:', e.message);
    return false;
  }
}

// 1-day-before reminder email (client only — the owner gets no booking
// emails about reminders). Same style as the confirmation email:
// start time only, and "please call" instead of "reply to this email".
async function sendReminderEmail(booking, service) {
  if (!emailIsConfigured()) return false;
  const clientWhen = `${formatDate(booking.date)} at ${minutesToTime(booking.startMinutes)} (${TZ})`;
  const gmailFrom = `"${SALON_NAME}" <${process.env.GMAIL_USER}>`;
  const mail = {
    from: RESEND_API_KEY ? RESEND_FROM : gmailFrom,
    to: booking.email,
    subject: `Reminder: your ${SALON_NAME} appointment is tomorrow — ${formatDate(booking.date)}`,
    text: `Hi ${booking.name},\n\nThis is a reminder that your appointment at ${SALON_NAME} is tomorrow:\n\nService: ${service.name}${service.priceLabel ? ` (${service.priceLabel})` : ''}\nWhen: ${clientWhen}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nSee you soon! If you need to change or cancel, please call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  try {
    if (RESEND_API_KEY) await sendViaResend(mail);
    else await mailer.sendMail(mail);
    return true;
  } catch (e) {
    console.error('Reminder email send failed:', e.message);
    return false;
  }
}

// Reschedule email (client only — the owner makes the change in the
// dashboard, so they need no email about their own action). Same style
// as the confirmation email: start time only, "please call" instead
// of "reply to this email". oldDate/oldStartMinutes describe the
// appointment before the change.
async function sendRescheduleEmail(booking, service, oldDate, oldStartMinutes) {
  if (!emailIsConfigured()) return false;
  const newWhen = `${formatDate(booking.date)} at ${minutesToTime(booking.startMinutes)} (${TZ})`;
  const oldWhen = `${formatDate(oldDate)} at ${minutesToTime(oldStartMinutes)} (${TZ})`;
  const gmailFrom = `"${SALON_NAME}" <${process.env.GMAIL_USER}>`;
  const mail = {
    from: RESEND_API_KEY ? RESEND_FROM : gmailFrom,
    to: booking.email,
    subject: `Your ${SALON_NAME} appointment has been rescheduled — ${formatDate(booking.date)}`,
    text: `Hi ${booking.name},\n\nYour appointment at ${SALON_NAME} has been rescheduled:\n\nService: ${service.name}${service.priceLabel ? ` (${service.priceLabel})` : ''}\nWas: ${oldWhen}\nNow: ${newWhen}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nSee you soon! If you need to change or cancel, please call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  try {
    if (RESEND_API_KEY) await sendViaResend(mail);
    else await mailer.sendMail(mail);
    return true;
  } catch (e) {
    console.error('Reschedule email send failed:', e.message);
    return false;
  }
}

// Cancellation email (client only, same style as above).
async function sendCancelEmail(booking, service) {
  if (!emailIsConfigured()) return false;
  const when = `${formatDate(booking.date)} at ${minutesToTime(booking.startMinutes)} (${TZ})`;
  const gmailFrom = `"${SALON_NAME}" <${process.env.GMAIL_USER}>`;
  const mail = {
    from: RESEND_API_KEY ? RESEND_FROM : gmailFrom,
    to: booking.email,
    subject: `Your ${SALON_NAME} appointment has been cancelled — ${formatDate(booking.date)}`,
    text: `Hi ${booking.name},\n\nYour appointment at ${SALON_NAME} has been cancelled:\n\nService: ${service.name}${service.priceLabel ? ` (${service.priceLabel})` : ''}\nWhen: ${when}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nIf you'd like to book again, visit pxcutzz.com or call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  try {
    if (RESEND_API_KEY) await sendViaResend(mail);
    else await mailer.sendMail(mail);
    return true;
  } catch (e) {
    console.error('Cancel email send failed:', e.message);
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

// Membership welcome text: start + expiry dates, so the member knows
// exactly how long their membership lasts. Sent when a member joins —
// whether they join while booking or the owner adds them from the
// dashboard. Fire-and-forget; failures are logged by sendSms.
function sendMembershipWelcomeSms(name, phone, joinedDate) {
  const expiry = memberExpiryDate({ joinedDate });
  const body = `PXCUTZZ: Hi ${name}, welcome to the membership! Your membership is active from ${formatDate(joinedDate)} to ${formatDate(expiry)} — 3 haircuts for $110. Book online at pxcutzz.com or call 6725882101.`;
  sendSms(phone, body).catch((e) => console.error('Membership welcome SMS failed:', e.message));
}

// Confirmation text for a booking the OWNER makes on the dashboard:
// the client didn't book it themselves, so they get a text telling
// them about the appointment (online self-bookings still get email
// only — the confirmation text stays off there, per the owner's
// 2026-11-16 decision). Returns true when the text went out.
async function sendDashboardBookingSms(booking, service) {
  if (!booking.phone) return false;
  const when = `${formatDate(booking.date)} at ${minutesToTime(booking.startMinutes)} (${TZ})`;
  const body = `PXCUTZZ: Hi ${booking.name}, your appointment is confirmed — ${service.name} on ${when}. See you soon! To change or cancel call 6725882101.`;
  return sendSms(booking.phone, body);
}

// Booking confirmation texts were removed 2026-11-16 at the owner's
// request: clients now get a confirmation email instead, and only the
// 3-hour reminder still goes by SMS. Membership texts (welcome,
// 9-day and renewal reminders) are unchanged.

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  // Booking code must never be stale on a client's phone: a cached
  // app.js from before a fix looks like the site is broken (the date
  // picker stops working) with no visible cause. Photos stay cached.
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));

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
    emailReminderSent: !!b.emailReminderSent,
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
  emailConfigured: emailIsConfigured(), smsConfigured: !!smsClient, adminProtected: !!ADMIN_TOKEN,
}));

app.get('/api/info', (req, res) => res.json({
  salon: SALON_NAME, phone: SALON_PHONE, email: SALON_EMAIL, address: SALON_ADDRESS,
  timezone: TZ, hours: OPENING_HOURS,
  services: SERVICES,
}));

app.get('/api/services', (req, res) => res.json(SERVICES));

app.get('/api/slots', async (req, res) => {
  const { date, serviceId, duration } = req.query;
  // Blocking a time: the owner sets the length, so the slot grid is
  // built for that duration instead of a service's.
  let service = null;
  if (duration !== undefined && duration !== '') {
    const blockDuration = parseBlockDuration(duration);
    if (blockDuration === null) return res.status(400).json({ error: 'Duration must be 15–480 minutes, in 15-minute steps.' });
    service = { id: 'blocked', name: 'Blocked', duration: blockDuration };
  } else {
    service = SERVICES.find((s) => s.id === serviceId);
  }
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
  const { serviceId, date, time, name, phone, email, notes, blocked, joinMembership, duration } = req.body || {};
  // "Block this time (no customer)" — an owner-only action. The public
  // booking form must never be able to create a blocked slot, so a
  // blocked request needs the same valid admin token as the other
  // admin endpoints (requireAdmin's rule, applied inline here because
  // this endpoint is otherwise public).
  const isBlockedBooking = !!blocked;
  // A booking made from the dashboard carries the admin token (the
  // dashboard sends it on every request; the public form never does).
  // The owner books it for the client, so the client gets a text.
  const isDashboardBooking = !!ADMIN_TOKEN && (req.query.token || req.headers['x-admin-token']) === ADMIN_TOKEN;
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service && !isBlockedBooking) return res.status(400).json({ error: 'Please choose a service.' });
  // A blocked slot has no service — the owner sets how long to block
  // (default 30 min). A regular booking's length is its service's.
  let blockDuration = 30;
  if (isBlockedBooking && duration !== undefined && duration !== '') {
    blockDuration = parseBlockDuration(duration);
    if (blockDuration === null) return res.status(400).json({ error: 'Duration must be 15–480 minutes, in 15-minute steps.' });
  }
  const apptDuration = isBlockedBooking ? blockDuration : service.duration;
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
  if (startMinutes < OPEN_MINUTES || startMinutes + apptDuration > CLOSE_MINUTES)
    return res.status(400).json({ error: 'That time is outside opening hours (9:00 AM – 9:00 PM).' });
  // Daily lunch break: no booking may overlap 2:00–2:30 PM.
  if (overlapsLunch(startMinutes, startMinutes + apptDuration))
    return res.status(400).json({ error: 'The salon is on lunch break 2:00–2:30 PM. Please pick another slot.' });
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

  const endMinutes = startMinutes + apptDuration;
  const clash = (await store.listOnDate(date)).some((b) => startMinutes < b.endMinutes && endMinutes > b.startMinutes);
  if (clash) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another slot.' });

  const row = await store.insert({
    serviceId: isBlockedBooking ? 'blocked' : service.id, serviceName: isBlockedBooking ? 'Blocked' : service.name, date, startMinutes, endMinutes,
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
  // Membership join: a client ticking "Join membership" while booking
  // is recorded as a member (join date = today, first reminder 9 days
  // later). A phone number that is already a member is kept as-is —
  // no duplicate member, no restarted reminder cycle.
  let membershipJoined = false;
  if (joinMembership) {
    const existing = await store.findMemberByPhone(saved.phone);
    if (!existing) {
      const today = todayInSalonTz();
      await store.insertMember({
        name: saved.name, phone: saved.phone, email: saved.email,
        joinedDate: today, nextReminderDate: addDays(today, MEMBERSHIP_REMINDER_DAYS),
        // Created at the same moment as the booking, so this booking
        // counts as the member's first haircut once its day arrives
        // (see haircutsUsed — future appointments don't count yet).
        createdAt: saved.createdAt,
      });
      membershipJoined = true;
      // Welcome text with the membership start + expiry dates.
      sendMembershipWelcomeSms(saved.name, saved.phone, today);
    }
  }
  const emailSent = await sendBookingEmails(saved, service);
  if (emailSent) {
    // best-effort flag update (works on every backend); the emails did
    // go out either way, so a failure here never fails the booking.
    try { await store.markEmailSent(row.id); saved.emailSent = true; } catch (_) { /* flag stays false */ }
  }
  saved.emailSent = emailSent;
  // Dashboard bookings: the owner books it for the client, so the
  // client gets a confirmation text. A failed text never fails the
  // booking. Online self-bookings still get email only.
  let smsSent = false;
  if (isDashboardBooking && saved.phone) {
    smsSent = await sendDashboardBookingSms(saved, service);
  }
  // No booking confirmation text for online self-bookings (removed
  // 2026-11-16 at the owner's request) — the confirmation email above
  // is the confirmation, and the 3-hour reminder SMS still goes out
  // via /api/reminders/send-due. Dashboard bookings are the exception:
  // the owner books for the client, so the client gets a text (above).
  // If this booking finished the member's membership (their 3rd
  // haircut, counting only haircuts whose day has arrived — a future
  // booking does not finish it yet), invite them to join the next
  // one — fire-and-forget, so it never blocks or fails the booking
  // response.
  sendRenewalRemindersIfDue().catch((e) => console.error('Renewal reminder failed:', e.message));
  res.status(201).json({
    booking: saved,
    emailSent,
    smsSent,
    emailNote: emailSent
      ? 'Confirmation email sent to the client and an alert sent to the salon.'
      : 'We could not send a confirmation email. To change or cancel call 6725882101.',
    membershipJoined,
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
// The client gets a cancellation email (the owner does the cancelling
// in the dashboard, so they need no email about it). Cancelling an
// already-cancelled booking sends nothing — no double email.
app.post('/api/bookings/:id/cancel', requireAdmin, async (req, res) => {
  const all = await store.list();
  const existing = all.find((b) => String(b.id) === String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Booking not found.' });
  if (existing.status === 'cancelled') return res.json(publicBooking(existing));
  const row = await store.cancel(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  let emailSent = false;
  if (!row.blocked && row.email) {
    const service = SERVICES.find((s) => s.id === row.serviceId)
      || { name: row.serviceName, priceLabel: '' };
    emailSent = await sendCancelEmail(row, service);
  }
  res.json({ ...publicBooking(row), cancelEmailSent: emailSent });
});

// Edit a booking (owner). Validates exactly like creation: service
// exists, date valid and not in the past, not Tuesday, not a blocked
// day, time valid and within opening hours, and no clash with other
// (non-cancelled) bookings — excluding the booking itself.
app.put('/api/bookings/:id', requireAdmin, async (req, res) => {
  const all = await store.list();
  const existing = all.find((b) => String(b.id) === String(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Booking not found.' });
  const { serviceId, date, time, name, phone, email, notes, duration } = req.body || {};
  const isBlockedRow = !!existing.blocked;
  const service = SERVICES.find((s) => s.id === (serviceId || existing.serviceId));
  if (!service && !isBlockedRow) return res.status(400).json({ error: 'Please choose a service.' });
  // A blocked slot has no service — its length is the duration the
  // owner sets (default: the length it already has).
  let blockDuration = (existing.endMinutes ?? 0) - (existing.startMinutes ?? 0);
  if (!(blockDuration > 0)) blockDuration = 30;
  if (isBlockedRow && duration !== undefined && duration !== '') {
    const parsed = parseBlockDuration(duration);
    if (parsed === null) return res.status(400).json({ error: 'Duration must be 15–480 minutes, in 15-minute steps.' });
    blockDuration = parsed;
  }
  const apptDuration = isBlockedRow ? blockDuration : service.duration;
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
  if (startMinutes < OPEN_MINUTES || startMinutes + apptDuration > CLOSE_MINUTES)
    return res.status(400).json({ error: 'That time is outside opening hours (9:00 AM – 9:00 PM).' });
  // Moving a booking into a past slot is never allowed. Keeping the
  // booking's existing slot (e.g. a notes-only edit of a booking whose
  // time has since passed) is history, not a new booking — allowed.
  const slotChanged = newDate !== existing.date || startMinutes !== existing.startMinutes;
  if (slotChanged && isPastSlot(newDate, startMinutes))
    return res.status(400).json({ error: 'That time has already passed. Please pick a later slot.' });
  // Daily lunch break: a booking moved into 2:00–2:30 PM is rejected
  // (a notes-only edit of an existing slot is left alone).
  if (slotChanged && overlapsLunch(startMinutes, startMinutes + apptDuration))
    return res.status(400).json({ error: 'The salon is on lunch break 2:00–2:30 PM. Please pick another slot.' });
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
  const endMinutes = startMinutes + apptDuration;
  const clash = (await store.listOnDate(newDate)).some((b) =>
    String(b.id) !== String(existing.id) && startMinutes < b.endMinutes && endMinutes > b.startMinutes);
  if (clash) return res.status(409).json({ error: 'That time is already taken. Please pick another slot.' });
  const row = await store.update(existing.id, {
    serviceId: isBlockedRow ? existing.serviceId : service.id, serviceName: isBlockedRow ? existing.serviceName : service.name, date: newDate,
    startMinutes, endMinutes,
    name: String(newName || '').trim(), phone: String(newPhone || '').trim(),
    email: String(newEmail || '').trim().toLowerCase(),
    notes: notes !== undefined ? String(notes).trim().slice(0, 500) : existing.notes,
    resetReminder: newDate !== existing.date,
  });
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  // The appointment moved — tell the client the new time (the owner
  // does the moving in the dashboard, so they need no email about it).
  // A notes/service-only edit is not a reschedule and sends nothing.
  let emailSent = false;
  let emailAttempted = false;
  if (slotChanged && existing.status !== 'cancelled' && !existing.blocked && row.email) {
    emailAttempted = true;
    emailSent = await sendRescheduleEmail(row, service, existing.date, existing.startMinutes);
  }
  if (emailAttempted) return res.json({ ...publicBooking(row), rescheduleEmailSent: emailSent });
  res.json(publicBooking(row));
});

// Reminder texts — 3-hours-before only (the 1-day-before reminder was
// removed 2026-11-15 at the owner's request). Admin-only; call it often
// (e.g. every 30 min from a scheduled job): the reminders go to confirmed
// bookings today starting within the next 3 hours.
// Idempotent: a booking is flagged only after its text succeeds, and
// only unflagged bookings are picked up, so a repeat call never
// double-texts anyone.
app.post('/api/reminders/send-due', requireAdmin, async (req, res) => {
  // 1-day-before reminders are disabled — sent/failed/skipped stay 0.
  const tomorrow = tomorrowInSalonTz();
  let sent = 0, failed = 0, skipped = 0;
  const today = todayInSalonTz();
  const now = nowMinutesInSalonTz();
  const due3h = await store.listDue3hReminders(today, now, now + 180);
  let sent3h = 0, failed3h = 0, skipped3h = 0;
  for (const b of due3h) {
    if (!smsClient) { skipped3h++; continue; }
    const body = `PXCUTZZ reminder: your ${b.serviceName} appointment is today (${formatDate(b.date)}) at ${minutesToTime(b.startMinutes)}. See you soon! To change or cancel call 6725882101.`;
    const ok = await sendSms(b.phone, body);
    if (ok) { await store.markReminder3hSent(b.id); sent3h++; }
    else failed3h++;
  }
  res.json({ date: tomorrow, sent, failed, skipped, today, sent3h, failed3h, skipped3h, smsConfigured: !!smsClient });
});

// 1-day-before reminder email. Admin-only; call once a day (e.g. 9 AM
// from a scheduled job): clients with a confirmed appointment
// tomorrow get one reminder email. The 3-hour reminder SMS is a
// different job and is untouched; the 1-day-before SMS stays off.
// Idempotent: a booking is flagged only after its email succeeds, so
// a repeat call never double-emails anyone. An admin may pass
// {"date": "YYYY-MM-DD"} to send for a different date (testing);
// otherwise tomorrow is used.
app.post('/api/reminders/send-due-email', requireAdmin, async (req, res) => {
  const targetDate = isValidDate(req.body?.date) ? req.body.date : tomorrowInSalonTz();
  let sent = 0, failed = 0, skipped = 0;
  const bookings = await store.list();
  const due = bookings.filter((b) =>
    b.date === targetDate && b.status === 'confirmed' && !b.blocked
    && b.email && !b.emailReminderSent);
  for (const b of due) {
    if (!emailIsConfigured()) { skipped++; continue; }
    const service = SERVICES.find((s) => s.id === b.serviceId)
      || { name: b.serviceName, priceLabel: '' };
    const ok = await sendReminderEmail(b, service);
    if (ok) { await store.markEmailReminderSent(b.id); sent++; }
    else failed++;
  }
  res.json({ date: targetDate, sent, failed, skipped, emailConfigured: emailIsConfigured() });
});

// Send a test text to the owner to prove the SMS service works.
app.post('/api/sms/test', requireAdmin, async (req, res) => {
  if (!smsClient) {
    return res.status(503).json({ ok: false, error: 'SMS is not configured on this server (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER).' });
  }
  const ok = await sendSms(OWNER_PHONE, 'PXCUTZZ: SMS service is working. Appointment reminders will come from this number.');
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

// Membership ($110 for 3 haircuts) — owner-only. Members are the ONLY
// clients who get the 9-day reminder texts; other clients never do.
// Public membership check for the booking form: does this phone belong
// to someone with an active, unfinished membership? Returns only
// true/false — never the member's name or details — so the booking
// form can hide the "Join membership" option for people who are
// already members. A finished, expired or stopped member still sees
// the option, so they can join the next membership.
app.get('/api/members/check', async (req, res) => {
  const phone = normalizePhone(req.query.phone || '');
  if (!phone) return res.json({ isMember: false });
  const today = todayInSalonTz();
  const members = await store.listMembers();
  const bookings = await store.list();
  const isMember = members.some((m) =>
    normalizePhone(m.phone) === phone && m.active && !memberFinished(m, bookings, today));
  res.json({ isMember });
});

app.get('/api/members', requireAdmin, async (req, res) => {
  const today = todayInSalonTz();
  const members = await store.listMembers();
  const bookings = await store.list();
  res.json(members.map((m) => {
    const finishedReason = memberFinishedReason(m, bookings, today);
    // The dashboard shows when the member will actually be nudged
    // next: if they already have a haircut booked in advance, the
    // reminder waits until the day after it (the same rule the
    // send-due applies) instead of showing a date that will only be
    // skipped when the day comes.
    let nextReminderDate = m.nextReminderDate;
    if (m.active && !finishedReason) {
      const latestUpcoming = latestUpcomingHaircut(m, bookings, today);
      if (latestUpcoming && nextReminderDate <= latestUpcoming) {
        nextReminderDate = addDays(latestUpcoming, 1);
      }
    }
    return {
      ...m,
      nextReminderDate,
      haircutsUsed: haircutsUsed(m, bookings, today),
      expiryDate: memberExpiryDate(m),
      finishedReason,
    };
  }));
});

app.post('/api/members', requireAdmin, async (req, res) => {
  const { name, phone, email, joinedDate, priorHaircuts } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter the member name.' });
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Please enter the member phone number.' });
  const joined = isValidDate(joinedDate) ? joinedDate : todayInSalonTz();
  const today = todayInSalonTz();
  // Haircuts already done before the member was added (old clients).
  const prior = Math.min(3, Math.max(0, parseInt(priorHaircuts, 10) || 0));
  // First reminder is 9 days after the member's LAST haircut — not 9
  // days after joining. A new member (no haircuts yet) is reminded 9
  // days after joining. An old client added with haircuts already done
  // had them about 10 days apart (3 haircuts in a month, starting on
  // the join date), so with `d` done the last one was on join +
  // 10*(d-1) and the next reminder is 9 days after that. That is why
  // (joined Nov 1, 2 done) reminds on Nov 20, not Nov 10 or Nov 19:
  // last haircut Nov 11, + 9 days = Nov 20, and the next haircut
  // follows the day after (Nov 21). For 1 done this is just join + 9,
  // the same as a new member. If that date is already today or in the
  // past, it is tomorrow, so the member is reminded right away instead
  // of the dashboard showing a past date.
  const lastHaircut = prior > 0 ? addDays(joined, 10 * (prior - 1)) : joined;
  const firstReminder = addDays(lastHaircut, MEMBERSHIP_REMINDER_DAYS);
  let nextReminderDate = firstReminder > today ? firstReminder : addDays(today, 1);
  // Already has a haircut booked in advance? The first reminder is
  // the day after that haircut, not join date + 9 — no point nudging
  // someone to book when their next haircut is already on the books
  // (and the send-due would only skip that date and move it anyway).
  const bookings = await store.list();
  const latestUpcoming = latestUpcomingHaircut({ phone, joinedDate: joined }, bookings, today);
  if (latestUpcoming && nextReminderDate <= latestUpcoming) {
    nextReminderDate = addDays(latestUpcoming, 1);
  }
  const existing = await store.findMemberByPhone(phone);
  if (existing) return res.status(409).json({ error: 'This phone number is already a member.' });
  const member = await store.insertMember({
    name: String(name).trim(), phone: String(phone).trim(),
    email: String(email || '').trim().toLowerCase(),
    joinedDate: joined, nextReminderDate,
    priorHaircuts: prior,
  });
  // Welcome text with the membership start + expiry dates (same as the
  // booking join path). Fire-and-forget — the response never waits on it.
  sendMembershipWelcomeSms(member.name, member.phone, member.joinedDate);
  res.status(201).json(member);
});

app.delete('/api/members/:id', requireAdmin, async (req, res) => {
  await store.deleteMember(req.params.id);
  res.json({ ok: true });
});

// Stop a member's reminders (the member stays on the list).
app.post('/api/members/:id/deactivate', requireAdmin, async (req, res) => {
  const member = await store.updateMember(req.params.id, { active: false });
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json(member);
});

// Set a member's next reminder date (owner). Used when the owner
// wants a member reminded on a specific day instead of the 9-day
// grid — e.g. their next haircut is already booked, so the reminder
// should wait until the day after it.
app.post('/api/members/:id/next-reminder', requireAdmin, async (req, res) => {
  const { date } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  const member = await store.updateMember(req.params.id, { nextReminderDate: date });
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json(member);
});

// Correct a member's join date (owner). The membership month — and so
// the expiry date — follows the join date, and the next reminder is
// recomputed the same way as when the member was added: 9 days after
// their last haircut (haircuts ~10 days apart from the join date), or
// tomorrow when that date is already past, and the day after their
// latest upcoming haircut when one is already booked.
app.post('/api/members/:id/joined-date', requireAdmin, async (req, res) => {
  const { date } = req.body || {};
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  const members = await store.listMembers();
  const member = members.find((m) => String(m.id) === String(req.params.id));
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  const today = todayInSalonTz();
  const prior = member.priorHaircuts ?? 0;
  const lastHaircut = prior > 0 ? addDays(date, 10 * (prior - 1)) : date;
  let nextReminderDate = addDays(lastHaircut, MEMBERSHIP_REMINDER_DAYS);
  if (nextReminderDate <= today) nextReminderDate = addDays(today, 1);
  const bookings = await store.list();
  const latestUpcoming = latestUpcomingHaircut({ phone: member.phone, joinedDate: date }, bookings, today);
  if (latestUpcoming && nextReminderDate <= latestUpcoming) {
    nextReminderDate = addDays(latestUpcoming, 1);
  }
  const updated = await store.updateMember(member.id, { joinedDate: date, nextReminderDate });
  res.json(updated);
});

// Restart a member: a new membership cycle starting today (join date
// today, first reminder 9 days later, haircut count restarts, and the
// renewal reminder becomes due again when this cycle finishes).
app.post('/api/members/:id/reactivate', requireAdmin, async (req, res) => {
  const today = todayInSalonTz();
  const member = await store.updateMember(req.params.id, {
    active: true, joinedDate: today, nextReminderDate: addDays(today, MEMBERSHIP_REMINDER_DAYS),
    renewalReminderSent: false,
  });
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json(member);
});

// Renewal reminder: when a membership finishes (3 haircuts used, or
// the month ran out), the member gets ONE text inviting them to join
// the next membership. renewalReminderSent makes sure it never
// repeats. Called from the daily send-due job (covers month expiry)
// and from the booking endpoint (covers the 3rd haircut finishing a
// membership right away).
async function sendRenewalRemindersIfDue() {
  const today = todayInSalonTz();
  const members = await store.listMembers();
  const bookings = await store.list();
  let sent = 0, failed = 0, skipped = 0;
  for (const m of members) {
    if (!m.active) { skipped++; continue; }
    if (!memberFinished(m, bookings, today)) { skipped++; continue; }
    if (m.renewalReminderSent) { skipped++; continue; }
    if (!smsClient) { skipped++; continue; }
    const body = `PXCUTZZ reminder: Hi ${m.name}, your membership has finished. Join your next membership — 3 haircuts for $110! Book online at pxcutzz.com or call 6725882101.`;
    const ok = await sendSms(m.phone, body);
    if (ok) {
      await store.updateMember(m.id, { renewalReminderSent: true });
      sent++;
    } else failed++;
  }
  return { sent, failed, skipped };
}

// Next 9-day reminder on a member's own grid (join date + 9 days, +18,
// +27 …), strictly after today. A late (catch-up) send must not push
// the whole schedule later — e.g. a reminder due Nov 15 but sent
// Nov 17 used to set the next one to Nov 26, shoving the member's
// next haircut into the last 10 days of the membership month.
function nextReminderOnGrid(joinedDate, today) {
  let next = addDays(joinedDate, MEMBERSHIP_REMINDER_DAYS);
  while (next <= today) next = addDays(next, MEMBERSHIP_REMINDER_DAYS);
  return next;
}

// The member's latest upcoming haircut booking inside the membership
// month (confirmed, not blocked, date from today to expiry) — or null
// when they have none booked in advance. A member with a haircut
// already coming needs no "book your appointment" nudge until after
// that haircut, so their next reminder is the day after this date.
function latestUpcomingHaircut(member, bookings, today) {
  const memberPhone = normalizePhone(member.phone);
  const upcomingDates = bookings
    .filter((b) => normalizePhone(b.phone) === memberPhone
      && HAIRCUT_SERVICE_IDS.includes(b.serviceId)
      && b.status !== 'cancelled' && !b.blocked
      && b.date >= today && b.date <= memberExpiryDate(member))
    .map((b) => b.date);
  return upcomingDates.length ? upcomingDates.sort().pop() : null;
}

// Membership reminders — every 9 days after joining, ONLY to members.
// Admin-only; call once a day from a scheduled job. A member is due
// when active, not finished (3 haircuts used or the month ran out),
// and their next reminder date is today or earlier. After a text goes
// out, the next reminder is the next date on the member's 9-day grid
// from their join date, so a repeat call never double-texts and a late
// send never drifts the schedule. A member who already has a haircut
// booked in advance gets NO "book your appointment" text — the
// reminder waits until the day after their latest upcoming haircut, so
// they are nudged to book the one after that. (The 3-hour appointment
// reminder is a different job and still goes out.) The same call also
// sends the one-time renewal reminder to members whose membership has
// finished.
app.post('/api/members/reminders/send-due', requireAdmin, async (req, res) => {
  const today = todayInSalonTz();
  const members = await store.listMembers();
  const bookings = await store.list();
  let sent = 0, failed = 0, skipped = 0, skippedAlreadyBooked = 0;
  for (const m of members) {
    if (!m.active) { skipped++; continue; }
    if (memberFinished(m, bookings, today)) { skipped++; continue; }
    if (m.nextReminderDate > today) { skipped++; continue; }
    // Already booked in advance? Don't send the "book your appointment"
    // text — the member already has a haircut coming. Move the next
    // reminder to the day after their latest upcoming haircut inside
    // the membership month, so they are reminded to book the next one.
    const latestUpcoming = latestUpcomingHaircut(m, bookings, today);
    if (latestUpcoming) {
      await store.updateMember(m.id, { nextReminderDate: addDays(latestUpcoming, 1) });
      skippedAlreadyBooked++;
      skipped++;
      continue;
    }
    if (!smsClient) { skipped++; continue; }
    const body = `PXCUTZZ reminder: Hi ${m.name}, it's time to book your next membership haircut! Book online at pxcutzz.com or call 6725882101.`;
    const ok = await sendSms(m.phone, body);
    if (ok) {
      await store.updateMember(m.id, { nextReminderDate: nextReminderOnGrid(m.joinedDate, today) });
      sent++;
    } else failed++;
  }
  const renewals = await sendRenewalRemindersIfDue();
  res.json({ date: today, sent, failed, skipped, skippedAlreadyBooked, renewals: renewals.sent, renewalsFailed: renewals.failed, smsConfigured: !!smsClient });
});

// Owner booking dashboard (separate page; the Manage section on the
// main site is unchanged).
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Start listening only once storage is ready (Turso schema setup is
// async) — no request can arrive before `store` is assigned.
storeReady.then(() => {
  app.listen(PORT, () => {
    console.log(`${SALON_NAME} booking app listening on port ${PORT} (storage: ${store.kind}, email: ${emailIsConfigured() ? 'configured' : 'not configured'}, sms: ${smsClient ? 'configured' : 'not configured'})`);
  });
});
