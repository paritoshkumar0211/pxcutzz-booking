/**
 * PXCUTZZ — online booking website
 * Men's salon / barbershop, Surrey, BC, Canada.
 *
 * Single Node.js (Express) app, no build step.
 * Storage: SQLite file (better-sqlite3) in DATA_DIR, with a JSON-file
 * fallback if the native module cannot load. NOTE: on Render's free tier
 * the disk is ephemeral — bookings are lost on redeploy/restart. See
 * README.md for the persistent-storage options.
 *
 * Email: nodemailer over Gmail SMTP, only when GMAIL_USER and
 * GMAIL_APP_PASSWORD are set. Bookings always save even if email is
 * not configured; the API reports emailSent: false in that case.
 *
 * No SMS gateway is connected — SMS is a future step (see README).
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

// Services — prices/durations exactly as provided by the owner.
// Durations marked "placeholder: true" were not given by the owner and
// were set to 30 minutes. Do not present them as owner-confirmed.
const SERVICES = [
  { id: 'mens-haircuts', name: "Men's Haircut", price: 25, priceLabel: '$25', duration: 30, placeholderDuration: true },
  { id: 'haircut-beard', name: 'Haircut & Beard', price: 45, priceLabel: '$45', duration: 45 },
  { id: 'skin-fades', name: 'Skin Fades', price: 30, priceLabel: '$30', duration: 30 },
  { id: 'hair-perms', name: 'Hair Perms', price: 120, priceLabel: '$120', duration: 45 },
  { id: 'mens-facial', name: "Men's Facial Treatments", price: 50, priceLabel: 'from $50', duration: 30 },
  { id: 'beard-trim-threading', name: 'Beard Trim and Threading', price: 25, priceLabel: '$25', duration: 30, placeholderDuration: true },
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
    created_at TEXT NOT NULL
  )`);
  return {
    kind: 'sqlite',
    list: () => db.prepare('SELECT * FROM bookings ORDER BY date, start_minutes').all(),
    listOnDate: (date) =>
      db.prepare("SELECT * FROM bookings WHERE date = ? AND status != 'cancelled'").all(date),
    insert: (b) => {
      const r = db.prepare(
        `INSERT INTO bookings (service_id, service_name, date, start_minutes, end_minutes,
          name, phone, email, status, email_sent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(b.serviceId, b.serviceName, b.date, b.startMinutes, b.endMinutes,
        b.name, b.phone, b.email, b.emailSent ? 1 : 0, new Date().toISOString());
      return db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.lastInsertRowid);
    },
    confirm: (id) => {
      const r = db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(id);
      return r.changes > 0 ? db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) : null;
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
  return {
    kind: 'json',
    list: () => [...rows].sort((a, b) => (a.date + a.startMinutes) - (b.date + b.startMinutes)),
    listOnDate: (date) => rows.filter((r) => r.date === date && r.status !== 'cancelled'),
    insert: (b) => {
      const row = { id: (rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1), ...b, status: 'pending', emailSent: !!b.emailSent, createdAt: new Date().toISOString() };
      rows.push(row); flush(); return row;
    },
    confirm: (id) => {
      const row = rows.find((r) => r.id === Number(id));
      if (!row) return null;
      row.status = 'confirmed'; flush(); return row;
    },
  };
}

try {
  store = initSqlite();
  console.log('Storage: SQLite file at', path.join(DATA_DIR, 'bookings.db'));
} catch (e) {
  console.warn('SQLite unavailable, using JSON-file fallback:', e.message);
  store = initJsonFallback();
  console.log('Storage: JSON file fallback');
}

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
    emailSent: !!(b.email_sent ?? b.emailSent),
    createdAt: b.created_at || b.createdAt,
  };
}
{
  const raw = store;
  store = {
    kind: raw.kind,
    list: () => raw.list().map(norm),
    listOnDate: (d) => raw.listOnDate(d).map(norm),
    insert: (b) => norm(raw.insert(b)),
    confirm: (id) => norm(raw.confirm(id)),
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
// A slot is offered only if the whole service finishes by 9 PM, and on
// "today" only if the slot starts in the future (Salon time).
function availableSlots(service, dateStr) {
  if (weekdayOf(dateStr) === CLOSED_WEEKDAY) return [];
  const taken = store.listOnDate(dateStr);
  const nowMinutes = (() => {
    if (dateStr !== todayInSalonTz()) return -1;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const [h, m] = parts.split(':').map(Number);
    return h * 60 + m;
  })();
  const slots = [];
  for (let start = OPEN_MINUTES; start + service.duration <= CLOSE_MINUTES; start += 30) {
    const end = start + service.duration;
    if (start <= nowMinutes) continue;
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
  const when = `${booking.date} at ${minutesToTime(booking.startMinutes)} – ${minutesToTime(booking.endMinutes)} (${TZ})`;
  const clientMail = {
    from: `"${SALON_NAME}" <${process.env.GMAIL_USER}>`,
    to: booking.email,
    subject: `Your ${SALON_NAME} appointment is booked — ${booking.date}`,
    text: `Hi ${booking.name},\n\nYour appointment at ${SALON_NAME} is booked:\n\nService: ${service.name} (${service.priceLabel}, ${service.duration} min)\nWhen: ${when}\nSalon: ${SALON_ADDRESS} — ${SALON_PHONE}\n\nIf you need to change or cancel, please reply to this email or call ${SALON_PHONE}.\n\nThanks for booking with ${SALON_NAME}!`,
  };
  const salonMail = {
    from: `"${SALON_NAME} bookings" <${process.env.GMAIL_USER}>`,
    to: SALON_EMAIL,
    subject: `New booking: ${service.name} — ${booking.date} ${minutesToTime(booking.startMinutes)} (${booking.name})`,
    text: `New booking at ${SALON_NAME}:\n\nService: ${service.name} (${service.priceLabel}, ${service.duration} min)\nWhen: ${when}\nClient: ${booking.name}\nPhone: ${booking.phone}\nEmail: ${booking.email}\n\nOpen the PXCUTZZ booking app (Manage view) to confirm this booking.`,
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
    time: minutesToTime(b.startMinutes),
    endTime: minutesToTime(b.endMinutes),
    name: b.name, phone: b.phone, email: b.email,
    status: b.status, emailSent: !!b.emailSent,
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
  emailConfigured: !!mailer, adminProtected: !!ADMIN_TOKEN,
}));

app.get('/api/info', (req, res) => res.json({
  salon: SALON_NAME, phone: SALON_PHONE, email: SALON_EMAIL, address: SALON_ADDRESS,
  timezone: TZ, hours: OPENING_HOURS,
  services: SERVICES,
}));

app.get('/api/services', (req, res) => res.json(SERVICES));

app.get('/api/slots', (req, res) => {
  const { date, serviceId } = req.query;
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Unknown service.' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  if (date < todayInSalonTz()) return res.status(400).json({ error: 'Please pick today or a future date.' });
  if (weekdayOf(date) === CLOSED_WEEKDAY)
    return res.json({ date, closed: true, message: 'The salon is closed on Tuesdays.', slots: [] });
  res.json({ date, closed: false, slots: availableSlots(service, date) });
});

app.post('/api/bookings', async (req, res) => {
  const { serviceId, date, time, name, phone, email } = req.body || {};
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) return res.status(400).json({ error: 'Please choose a service.' });
  if (!isValidDate(date) || date < todayInSalonTz())
    return res.status(400).json({ error: 'Please pick today or a future date.' });
  if (weekdayOf(date) === CLOSED_WEEKDAY)
    return res.status(400).json({ error: 'The salon is closed on Tuesdays.' });
  const startMinutes = timeToMinutes(time);
  if (startMinutes === null) return res.status(400).json({ error: 'Please choose a valid time slot.' });
  if (startMinutes < OPEN_MINUTES || startMinutes + service.duration > CLOSE_MINUTES)
    return res.status(400).json({ error: 'That time is outside opening hours (9:00 AM – 9:00 PM).' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Please enter your phone number.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
    return res.status(400).json({ error: 'Please enter a valid email address.' });

  const endMinutes = startMinutes + service.duration;
  const clash = store.listOnDate(date).some((b) => startMinutes < b.endMinutes && endMinutes > b.startMinutes);
  if (clash) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another slot.' });

  const row = store.insert({
    serviceId: service.id, serviceName: service.name, date, startMinutes, endMinutes,
    name: String(name).trim(), phone: String(phone).trim(), email: String(email).trim().toLowerCase(),
    emailSent: false,
  });
  const saved = publicBooking(row);
  const emailSent = await sendBookingEmails(saved, service);
  if (emailSent && store.kind === 'sqlite') {
    // best-effort flag update (JSON fallback already stored false; acceptable)
    try {
      const Database = require('better-sqlite3');
      const db = new Database(path.join(DATA_DIR, 'bookings.db'));
      db.prepare('UPDATE bookings SET email_sent = 1 WHERE id = ?').run(row.id);
      saved.emailSent = true;
    } catch (_) { /* flag stays false; the emails did go out */ }
  }
  saved.emailSent = emailSent;
  res.status(201).json({
    booking: saved,
    emailSent,
    emailNote: emailSent
      ? 'Confirmation email sent to the client and an alert sent to the salon.'
      : 'Booking saved, but email was NOT sent — email is not configured on this server (see README: set GMAIL_USER and GMAIL_APP_PASSWORD).',
  });
});

app.get('/api/bookings', requireAdmin, (req, res) => {
  res.json(store.list().map(publicBooking));
});

app.post('/api/bookings/:id/confirm', requireAdmin, (req, res) => {
  const row = store.confirm(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found.' });
  res.json(publicBooking(row));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`${SALON_NAME} booking app listening on port ${PORT} (storage: ${store.kind}, email: ${mailer ? 'configured' : 'not configured'})`);
});
