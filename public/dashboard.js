/* PXCUTZZ owner booking dashboard — vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'pxcutzz_admin_token';
const CLOSED_WEEKDAY = 2; // Tuesday (0=Sunday)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const state = {
  adminToken: localStorage.getItem(TOKEN_KEY) || '',
  services: [],
  bookings: [],
  members: [],
  blocked: new Set(),
  viewYear: 0,
  viewMonth: 0,
  selectedDate: null, // YYYY-MM-DD
  addSelectedTime: null, // time string picked in the Add slot grid
  editSelectedTime: null, // time string picked in the Edit slot grid
};

function vancouverToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function weekdayOf(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// Advance a YYYY-MM-DD date until it is not a Tuesday (closed day),
// so a default selection never lands on a closed Tuesday.
function nextOpenDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  while (dt.getUTCDay() === CLOSED_WEEKDAY) dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function dateStrOf(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Minutes since midnight "now" in the salon timezone.
function nowMinutesVancouver() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const [h, m] = parts.split(':').map(Number);
  return h * 60 + m;
}

// "9:00 AM" -> minutes since midnight (null when unparsable).
function timeStrToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((t || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return null;
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + min;
}

// True when a date+time is a past slot (past date, or today at/before
// now, salon timezone). Past slots are never shown in the slot grids.
function isPastSlot(dateStr, timeStr) {
  const today = vancouverToday();
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  const mins = timeStrToMinutes(timeStr);
  return mins === null ? true : mins <= nowMinutesVancouver();
}

function showError(msg) {
  const el = $('dashError');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg; el.classList.remove('hidden');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(state.adminToken ? { 'x-admin-token': state.adminToken } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function needToken() {
  $('dashTokenRow').classList.remove('hidden');
  $('dashContent').classList.add('hidden');
  $('dashTokenInput').focus();
}

function unlockDashboard() {
  const token = $('dashTokenInput').value.trim();
  if (!token) return;
  state.adminToken = token;
  localStorage.setItem(TOKEN_KEY, token);
  $('dashTokenRow').classList.add('hidden');
  $('dashTokenInput').value = '';
  loadAll();
}

async function loadAll() {
  showError('');
  try {
    const [services, bookings, blocked, members] = await Promise.all([
      api('/api/services'),
      api('/api/bookings'),
      api('/api/blocked-days'),
      api('/api/members'),
    ]);
    state.services = services;
    state.bookings = bookings;
    state.members = members;
    state.blocked = new Set(blocked.dates || []);
    $('dashContent').classList.remove('hidden');
    $('dashTokenRow').classList.add('hidden');
    fillServiceSelect();
    renderCalendar();
    renderDayDetail();
    renderMembers();
  } catch (e) {
    if (e.message.includes('Admin token') || e.message.includes('401')) needToken();
    else showError(e.message);
  }
}

function fillServiceSelect() {
  [$('addService'), $('editService')].forEach((sel) => {
    sel.innerHTML = '';
    state.services.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} — ${s.priceLabel} (${s.duration} min)`;
      sel.appendChild(opt);
    });
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
// Calendar badges count customer bookings only (cancelled and blocked
// slots excluded, completed still counted).
function countsByDate() {
  const counts = {};
  state.bookings.forEach((b) => {
    if (b.status === 'cancelled' || b.blocked) return;
    counts[b.date] = (counts[b.date] || 0) + 1;
  });
  return counts;
}

function renderCalendar() {
  const y = state.viewYear;
  const m = state.viewMonth;
  $('calMonthLabel').textContent = `${MONTHS[m]} ${y}`;
  const counts = countsByDate();
  const today = vancouverToday();
  const grid = $('calGrid');
  grid.innerHTML = '';

  const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const daysInPrevMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  for (let i = 0; i < firstWeekday; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell other-month';
    cell.textContent = daysInPrevMonth - firstWeekday + 1 + i;
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = dateStrOf(y, m, d);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';
    const wd = weekdayOf(ds);
    // Tuesdays are closed: the cell is disabled (not clickable at
    // all), not just labelled — the owner asked for the Tuesday
    // option itself to be off.
    const isClosedDay = wd === CLOSED_WEEKDAY;
    if (isClosedDay) { cell.classList.add('closed'); cell.disabled = true; }
    if (state.blocked.has(ds)) cell.classList.add('blocked');
    if (ds === today) cell.classList.add('today');
    if (ds === state.selectedDate) cell.classList.add('selected');

    const num = document.createElement('span');
    num.className = 'cal-num';
    num.textContent = d;
    cell.appendChild(num);

    if (counts[ds]) {
      const badge = document.createElement('span');
      badge.className = 'cal-badge';
      badge.textContent = counts[ds];
      cell.appendChild(badge);
    }
    if (isClosedDay) {
      const lbl = document.createElement('span');
      lbl.className = 'cal-closed';
      lbl.textContent = 'Tue closed';
      cell.appendChild(lbl);
    } else if (state.blocked.has(ds)) {
      const lbl = document.createElement('span');
      lbl.className = 'cal-closed';
      lbl.textContent = 'blocked';
      cell.appendChild(lbl);
    }

    if (!isClosedDay) cell.onclick = () => { state.selectedDate = ds; hideAddForm(); renderCalendar(); renderDayDetail(); };
    grid.appendChild(cell);
  }
}

function changeMonth(delta) {
  let y = state.viewYear;
  let m = state.viewMonth + delta;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  state.viewYear = y;
  state.viewMonth = m;
  const today = vancouverToday();
  const [ty, tm] = today.split('-').map(Number);
  state.selectedDate = (y === ty && m === tm - 1) ? today : nextOpenDate(dateStrOf(y, m, 1));
  hideAddForm();
  renderCalendar();
  renderDayDetail();
}

// ---------------------------------------------------------------------------
// Day detail
// ---------------------------------------------------------------------------
function formatDay(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, mo - 1, d)));
}

function smsBody(b) {
  return `Hi ${b.name}! Your PXCUTZZ appointment is booked: ${b.serviceName} on ${b.date} at ${b.time}. Please arrive 5 minutes early. Need to change it? Just reply to this text. — PXCUTZZ`;
}

// Services that count as one of a member's 3 haircuts (mirrors the server).
const HAIRCUT_SERVICE_IDS = ['skin-fade-haircut', 'haircut-beard', 'membership'];
// Compare phone numbers by their last 10 digits (mirrors the server).
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
// Same-name, different-number warning. The owner has several clients
// who share a name, and the system tells people apart ONLY by phone
// number (last 10 digits) — the name is never used to match anyone.
// When the name typed in a form matches an existing member or booking
// but the number is different, list the existing numbers so the owner
// can check he typed the right one before saving: a wrong number
// links the booking or membership to the wrong person. Non-blocking —
// same names are normal here, so this is a nudge, not an error.
function sameNameMatches(name, phone) {
  const want = (name || '').trim().toLowerCase();
  if (!want) return [];
  const num = normalizePhone(phone);
  const seen = new Map();
  const add = (n, p) => {
    if (!n || !p) return;
    if (n.trim().toLowerCase() !== want) return;
    const key = normalizePhone(p);
    if (!key) return;
    if (num && key === num) return; // same person — no warning
    if (!seen.has(key)) seen.set(key, { name: n.trim(), phone: p });
  };
  (state.members || []).forEach((m) => add(m.name, m.phone));
  (state.bookings || []).forEach((b) => { if (!b.blocked) add(b.name, b.phone); });
  return [...seen.values()];
}
function showSameNameWarning(el, name, phone) {
  if (!el) return;
  const matches = sameNameMatches(name, phone);
  if (!matches.length) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = '⚠️ Same name, different number: '
    + matches.map((m) => `${m.name} — ${m.phone}`).join(' · ')
    + '. Check the number before saving — the system tells people apart by number only.';
  el.classList.remove('hidden');
}
// Is this booking one of the member's 3 membership haircuts? It counts
// when the client is an active member, the service is a haircut, the
// date is inside the membership month, and the booking is among the
// member's first 3 such haircuts (in time order). The tag shows on
// future appointments too — it is the appointment's number among the
// 3 (what it WILL be), so the owner can see at a glance that it is a
// member's haircut. That number can be ahead of the member's count in
// the Members table, which only includes haircuts already done.
// Returns the haircut number (1–3), or 0 when it is not a membership
// appointment.
function membershipHaircutNumber(b) {
  if (b.blocked || b.status === 'cancelled') return 0;
  if (!HAIRCUT_SERVICE_IDS.includes(b.serviceId)) return 0;
  const phone = normalizePhone(b.phone);
  if (!phone) return 0;
  const member = state.members.find((m) => m.active && normalizePhone(m.phone) === phone);
  if (!member || !member.expiryDate) return 0;
  if (b.date < member.joinedDate || b.date > member.expiryDate) return 0;
  // Only bookings made after the member was added count — ones already
  // on the books are inside the "haircuts already done" number the
  // owner typed, so this appointment has no number among the 3.
  const since = member.createdAt || '';
  if (since && (b.createdAt || '') < since) return 0;
  const haircuts = state.bookings
    .filter((x) => !x.blocked && x.status !== 'cancelled'
      && HAIRCUT_SERVICE_IDS.includes(x.serviceId)
      && normalizePhone(x.phone) === phone
      && x.date >= member.joinedDate && x.date <= member.expiryDate
      && (!since || (x.createdAt || '') >= since))
    .sort((x, y) => (x.date === y.date
      ? (x.startMinutes ?? 0) - (y.startMinutes ?? 0)
      : (x.date < y.date ? -1 : 1)));
  const idx = haircuts.findIndex((x) => x.id === b.id);
  // The appointment's number among the 3: haircuts already done when
  // the member was added, plus its place among the bookings since.
  const no = (member.priorHaircuts ?? 0) + idx + 1;
  return idx >= 0 && no <= 3 ? no : 0;
}

function renderDayDetail() {
  const ds = state.selectedDate;
  // Cancelled appointments are not shown at all — once cancelled, the
  // row disappears and the slot simply looks free again.
  const rows = state.bookings
    .filter((b) => b.date === ds && b.status !== 'cancelled')
    .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
  const isTuesday = weekdayOf(ds) === CLOSED_WEEKDAY;
  const isBlocked = state.blocked.has(ds);
  // Day count counts customer bookings only (cancelled and blocked
  // slots excluded, completed still counted).
  const activeCount = rows.filter((b) => b.status !== 'cancelled' && !b.blocked).length;

  $('dayTitle').textContent = formatDay(ds);
  $('dayCount').textContent = isTuesday
    ? 'Closed — the salon is closed on Tuesdays.'
    : isBlocked
      ? `Blocked by the owner · ${activeCount} booking${activeCount === 1 ? '' : 's'}`
      : `${activeCount} booking${activeCount === 1 ? '' : 's'}`;

  const blockBtn = $('blockDayBtn');
  if (isTuesday) {
    blockBtn.classList.add('hidden');
  } else {
    blockBtn.classList.remove('hidden');
    blockBtn.textContent = isBlocked ? 'Unblock day' : 'Block whole day';
  }
  $('addBookingBtn').classList.toggle('hidden', isTuesday || isBlocked);

  // Daily lunch break row (2:00–2:30 PM, blocked every open day).
  const LUNCH_END = 14 * 60 + 30;
  function lunchRow() {
    const tr = document.createElement('tr');
    tr.className = 'row-lunch';
    const tdTime = document.createElement('td');
    tdTime.textContent = '2:00 PM';
    tr.appendChild(tdTime);
    const tdNote = document.createElement('td');
    tdNote.colSpan = 4;
    tdNote.className = 'muted';
    tdNote.textContent = '🍽️ Lunch break — 2:00–2:30 PM (blocked daily)';
    tr.appendChild(tdNote);
    return tr;
  }
  const showLunch = !isTuesday && !isBlocked;

  const tbody = $('dayRows');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${isTuesday ? 'Closed on Tuesdays.' : isBlocked ? 'Day blocked — no bookings.' : 'No bookings yet.'}</td></tr>`;
    if (showLunch) tbody.appendChild(lunchRow());
    return;
  }
  tbody.innerHTML = '';
  let lunchInserted = false;
  rows.forEach((b) => {
    // Insert the lunch row in time order, before the first booking
    // starting at/after 2:30 PM.
    if (showLunch && !lunchInserted && (b.startMinutes ?? 0) >= LUNCH_END) {
      tbody.appendChild(lunchRow());
      lunchInserted = true;
    }
    const tr = document.createElement('tr');
    if (b.status === 'completed') tr.classList.add('row-done');
    if (b.status === 'cancelled') tr.classList.add('row-cancelled');
    if (b.blocked) tr.classList.add('row-blocked');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    const tds = tr.querySelectorAll('td');
    // TIME: start time, with the duration beneath it. A blocked row
    // has no service — its length is the time it occupies.
    const timeEl = document.createElement('div');
    timeEl.textContent = b.time;
    tds[0].appendChild(timeEl);
    const svc = state.services.find((s) => s.id === b.serviceId);
    const durMin = b.blocked
      ? (b.endMinutes ?? 0) - (b.startMinutes ?? 0)
      : (svc ? svc.duration : 0);
    if (durMin > 0) {
      const dur = document.createElement('div');
      dur.className = 'time-dur';
      dur.textContent = `${durMin} min`;
      tds[0].appendChild(dur);
    }
    // CUSTOMER (+ status tag for completed/cancelled/blocked rows).
    if (b.blocked) {
      tds[1].textContent = 'Blocked';
      const tag = document.createElement('span');
      tag.className = 'status-tag';
      tag.textContent = 'Blocked';
      tds[1].appendChild(document.createElement('br'));
      tds[1].appendChild(tag);
    } else {
      tds[1].textContent = b.name;
      if (b.status === 'completed' || b.status === 'cancelled') {
        const tag = document.createElement('span');
        tag.className = 'status-tag';
        tag.textContent = b.status === 'completed' ? 'Completed' : 'Cancelled';
        tds[1].appendChild(document.createElement('br'));
        tds[1].appendChild(tag);
      }
      // Membership appointment: gold "Member n/3" tag under the name,
      // so the owner sees at a glance that this is one of the member's
      // 3 membership haircuts (and which one it is).
      const memberNo = membershipHaircutNumber(b);
      if (memberNo) {
        const mtag = document.createElement('span');
        mtag.className = 'status-tag member';
        mtag.textContent = `Member ${memberNo}/3`;
        tds[1].appendChild(document.createElement('br'));
        tds[1].appendChild(mtag);
      }
    }
    // SERVICE (+ the owner's note underneath, when present).
    tds[2].textContent = b.serviceName;
    if (b.notes) {
      const note = document.createElement('div');
      note.className = 'booking-note';
      note.textContent = b.notes;
      tds[2].appendChild(note);
    }
    tds[3].textContent = b.blocked ? '—' : b.phone;
    // ACTIONS: blocked rows can only be cancelled (which frees the
    // slot again). Cancelled rows show no actions at all; completed
    // rows lose the Complete button.
    const actions = tds[4];
    actions.classList.add('dash-actions');
    if (b.status !== 'cancelled') {
      if (b.blocked) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'row-action danger';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => rowAction(b, 'cancel', cancelBtn);
        actions.appendChild(cancelBtn);
      } else {
        const sms = document.createElement('a');
        sms.className = 'sms-link';
        sms.textContent = 'Send SMS';
        sms.href = `sms:${encodeURIComponent(b.phone)}?&body=${encodeURIComponent(smsBody(b))}`;
        actions.appendChild(sms);
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'row-action';
        editBtn.textContent = 'Edit';
        editBtn.onclick = () => showEditForm(b);
        actions.appendChild(editBtn);
        if (b.status !== 'completed') {
          const doneBtn = document.createElement('button');
          doneBtn.type = 'button';
          doneBtn.className = 'row-action';
          doneBtn.textContent = 'Complete';
          doneBtn.onclick = () => rowAction(b, 'complete', doneBtn);
          actions.appendChild(doneBtn);
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'row-action danger';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => rowAction(b, 'cancel', cancelBtn);
        actions.appendChild(cancelBtn);
      }
    }
    tbody.appendChild(tr);
  });
  // No booking at/after 2:30 PM — the lunch row goes at the end.
  if (showLunch && !lunchInserted) tbody.appendChild(lunchRow());
}

// ---------------------------------------------------------------------------
// Members ($110 for 3 haircuts) — the only clients who get the 9-day
// reminder texts.
// ---------------------------------------------------------------------------
function renderMembers() {
  const tbody = $('memberRows');
  // Summary line above the table: how many are still going, how many
  // used all 3 haircuts (finished), how many ran out of time (expired),
  // how many were stopped by the owner.
  const summary = $('memberSummary');
  if (summary) {
    const active = state.members.filter((m) => m.active && !m.finishedReason).length;
    const finished = state.members.filter((m) => m.active && m.finishedReason === 'haircuts').length;
    const expired = state.members.filter((m) => m.active && m.finishedReason === 'expired').length;
    const stopped = state.members.filter((m) => !m.active).length;
    summary.textContent = state.members.length
      ? `${active} active · ${finished} finished (3/3 haircuts) · ${expired} expired · ${stopped} stopped`
      : '';
  }
  if (!state.members.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No members yet.</td></tr>';
    return;
  }
  tbody.innerHTML = '';
  state.members.forEach((m) => {
    const used = m.haircutsUsed ?? 0;
    const finished = !!m.finishedReason;
    const status = !m.active ? 'Stopped'
      : (m.finishedReason === 'haircuts' ? 'Finished'
      : (m.finishedReason === 'expired' ? 'Expired' : 'Active'));
    const tr = document.createElement('tr');
    if (!m.active || finished) tr.classList.add('row-cancelled');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td>';
    const tds = tr.querySelectorAll('td');
    tds[0].textContent = m.name;
    const tag = document.createElement('span');
    tag.className = `status-tag ${status.toLowerCase()}`;
    tag.textContent = status;
    tds[0].appendChild(document.createElement('br'));
    tds[0].appendChild(tag);
    tds[1].textContent = m.phone;
    tds[2].textContent = m.joinedDate;
    if (m.expiryDate) {
      const exp = document.createElement('div');
      exp.className = 'muted small';
      exp.textContent = `Expires ${m.expiryDate}`;
      tds[2].appendChild(exp);
    }
    tds[3].textContent = `${used} / 3`;
    tds[4].textContent = (!m.active || finished) ? '—' : (m.nextReminderDate || '—');
    const actions = tds[5];
    actions.classList.add('dash-actions');
    // A finished or expired member's natural next step is a new cycle,
    // so they get Reactivate (not Stop reminders) — same as a stopped member.
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'row-action';
    toggleBtn.textContent = (m.active && !finished) ? 'Stop reminders' : 'Reactivate';
    toggleBtn.onclick = () => memberAction(m, (m.active && !finished) ? 'deactivate' : 'reactivate', toggleBtn);
    actions.appendChild(toggleBtn);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'row-action danger';
    delBtn.textContent = 'Remove';
    delBtn.onclick = () => memberAction(m, 'delete', delBtn);
    actions.appendChild(delBtn);
    tbody.appendChild(tr);
  });
}

async function reloadMembers() {
  state.members = await api('/api/members');
  renderMembers();
}

async function memberAction(m, action, btn) {
  if (action === 'delete' && !window.confirm(`Remove ${m.name} from the membership? Their reminders will stop.`)) return;
  if (action === 'reactivate' && !window.confirm(`Reactivate ${m.name}? A new membership cycle starts today (join date today, first reminder in 9 days, haircut count restarts).`)) return;
  showError('');
  if (btn) btn.disabled = true;
  try {
    if (action === 'delete') await api(`/api/members/${m.id}`, { method: 'DELETE' });
    else await api(`/api/members/${m.id}/${action}`, { method: 'POST' });
    await reloadMembers();
  } catch (e) {
    showError(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('addMemberForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('addMemberError');
  const ok = $('addMemberSuccess');
  err.classList.add('hidden'); ok.classList.add('hidden');
  const btn = $('addMemberBtn');
  btn.disabled = true;
  try {
    const name = $('addMemberName').value.trim();
    const phone = $('addMemberPhone').value.trim();
    if (!name) throw new Error('Please enter the member name.');
    if (!phone) throw new Error('Please enter the member phone number.');
    const joinedDate = $('addMemberJoined').value || undefined;
    const priorHaircuts = Math.min(3, Math.max(0, parseInt($('addMemberPrior').value, 10) || 0));
    await api('/api/members', { method: 'POST', body: JSON.stringify({ name, phone, joinedDate, priorHaircuts }) });
    $('addMemberName').value = '';
    $('addMemberPhone').value = '';
    $('addMemberJoined').value = '';
    $('addMemberPrior').value = '0';
    const w = $('addMemberNameWarn');
    if (w) { w.classList.add('hidden'); w.textContent = ''; }
    ok.textContent = `${name} is now a member — first reminder goes in 9 days.`;
    ok.classList.remove('hidden');
    await reloadMembers();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// One-tap Complete, confirmed Cancel — then reload the bookings list.
async function rowAction(b, action, btn) {
  if (action === 'cancel') {
    const msg = b.blocked
      ? `Unblock ${b.serviceName} at ${b.time} on ${b.date}? The time slot will be free again.`
      : `Cancel ${b.name}'s ${b.serviceName} booking on ${b.date} at ${b.time}? The time slot will be freed.`;
    if (!window.confirm(msg)) return;
  }
  showError('');
  if (btn) btn.disabled = true;
  try {
    await api(`/api/bookings/${b.id}/${action}`, { method: 'POST' });
    state.bookings = await api('/api/bookings');
    renderCalendar();
    renderDayDetail();
  } catch (e) {
    showError(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function toggleBlockDay() {
  const ds = state.selectedDate;
  const isBlocked = state.blocked.has(ds);
  try {
    const res = isBlocked
      ? await api(`/api/blocked-days/${ds}`, { method: 'DELETE' })
      : await api('/api/blocked-days', { method: 'POST', body: JSON.stringify({ date: ds }) });
    state.blocked = new Set(res.dates || []);
    hideAddForm();
    renderCalendar();
    renderDayDetail();
  } catch (e) {
    showError(e.message);
  }
}

// ---------------------------------------------------------------------------
// Slot grid (shared by the Add and Edit forms): clickable time buttons,
// the chosen one highlighted. onSelect receives the picked time string.
// ---------------------------------------------------------------------------
function renderSlotGrid(container, times, selected, onSelect) {
  container.innerHTML = '';
  times.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (t === selected ? ' selected' : '');
    b.textContent = t;
    b.onclick = () => onSelect(t);
    container.appendChild(b);
  });
}

// ---------------------------------------------------------------------------
// Add booking
// ---------------------------------------------------------------------------
function hideAddForm() {
  $('addBookingForm').classList.add('hidden');
  $('addSuccess').classList.add('hidden');
  $('addError').classList.add('hidden');
  const w = $('addNameWarn');
  if (w) { w.classList.add('hidden'); w.textContent = ''; }
  $('addBookingBtn').classList.remove('hidden');
  hideEditForm();
}

// "Block this time (no customer)": customer fields don't apply —
// disable and grey them out, and the submit button says what it does.
// Blocking needs a length, not a service — show the duration field
// and hide the service picker.
function syncBlockFields() {
  const blocked = $('addBlock').checked;
  [$('addName'), $('addPhone'), $('addEmail')].forEach((el) => {
    el.disabled = blocked;
    if (blocked) el.value = '';
  });
  $('addName').required = !blocked;
  $('addPhone').required = !blocked;
  $('addSubmitBtn').textContent = blocked ? 'Block this time' : 'Save booking';
  $('addDurationRow').classList.toggle('hidden', !blocked);
  $('addServiceRow').classList.toggle('hidden', blocked);
}

async function loadAddSlots() {
  const blocked = $('addBlock').checked;
  const hint = $('addTimeHint');
  const grid = $('addSlotGrid');
  grid.innerHTML = '';
  hint.textContent = 'Loading times…';
  try {
    // Blocking a time: the slot grid is built for the duration the
    // owner set, not for a service's length.
    const qs = blocked
      ? `duration=${encodeURIComponent($('addDuration').value)}`
      : `serviceId=${encodeURIComponent($('addService').value)}`;
    const data = await api(`/api/slots?date=${encodeURIComponent(state.selectedDate)}&${qs}`);
    if (data.closed || data.slots.length === 0) {
      hint.textContent = data.message || 'No times available on that day.';
      state.addSelectedTime = null;
      return;
    }
    hint.textContent = '';
    const times = data.slots.map((s) => s.time);
    if (!times.includes(state.addSelectedTime)) state.addSelectedTime = null;
    const pick = (t) => {
      state.addSelectedTime = t;
      renderSlotGrid(grid, times, state.addSelectedTime, pick);
    };
    renderSlotGrid(grid, times, state.addSelectedTime, pick);
  } catch (e) {
    hint.textContent = e.message;
  }
}

function showAddForm() {
  hideEditForm();
  $('addDateLabel').textContent = formatDay(state.selectedDate);
  $('addName').value = '';
  $('addPhone').value = '';
  $('addEmail').value = '';
  $('addNotes').value = '';
  $('addBlock').checked = false;
  $('addDuration').value = '30';
  state.addSelectedTime = null;
  syncBlockFields();
  $('addBookingForm').classList.remove('hidden');
  $('addSuccess').classList.add('hidden');
  const w = $('addNameWarn');
  if (w) { w.classList.add('hidden'); w.textContent = ''; }
  $('addError').classList.add('hidden');
  loadAddSlots();
  $('addBookingForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitAddBooking(ev) {
  ev.preventDefault();
  const err = $('addError');
  const ok = $('addSuccess');
  err.classList.add('hidden');
  ok.classList.add('hidden');
  const blocked = $('addBlock').checked;
  if (!state.addSelectedTime) {
    err.textContent = 'Please pick a time slot.';
    err.classList.remove('hidden');
    return;
  }
  const btn = $('addSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const email = $('addEmail').value.trim();
    const body = {
      date: state.selectedDate,
      time: state.addSelectedTime,
      name: blocked ? '' : $('addName').value.trim(),
      phone: blocked ? '' : $('addPhone').value.trim(),
      // Email is required by the booking API; when the owner leaves it
      // blank we store a placeholder so no confirmation is attempted.
      email: blocked ? '' : (email || 'no-email@pxcutzz.local'),
      notes: $('addNotes').value.trim(),
      blocked,
    };
    // A block has a duration the owner sets, not a service.
    if (blocked) body.duration = Number($('addDuration').value);
    else body.serviceId = $('addService').value;
    const res = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const b = res.booking;
    ok.textContent = b.blocked
      ? `Blocked ${b.endMinutes - b.startMinutes} min on ${b.date} at ${b.time} — no customer, no confirmation sent.`
      : `Booked: ${b.name} — ${b.serviceName} on ${b.date} at ${b.time}.` + (res.smsSent ? ' Confirmation text sent.' : ' (Confirmation text could not be sent — the client will still get the 3-hour reminder.)');
    ok.classList.remove('hidden');
    $('addName').value = '';
    $('addPhone').value = '';
    $('addEmail').value = '';
    $('addNotes').value = '';
    $('addBlock').checked = false;
    state.addSelectedTime = null;
    syncBlockFields();
    const bookings = await api('/api/bookings');
    state.bookings = bookings;
    renderCalendar();
    renderDayDetail();
    loadAddSlots();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    syncBlockFields();
  }
}

// ---------------------------------------------------------------------------
// Edit booking
// ---------------------------------------------------------------------------
function hideEditForm() {
  $('editBookingForm').classList.add('hidden');
  $('editSuccess').classList.add('hidden');
  $('editError').classList.add('hidden');
  const w = $('editNameWarn');
  if (w) { w.classList.add('hidden'); w.textContent = ''; }
}

async function loadEditSlots() {
  const id = $('editId').value;
  const original = state.bookings.find((b) => String(b.id) === String(id));
  const blocked = !!(original && original.blocked);
  const date = $('editDate').value;
  const hint = $('editTimeHint');
  const grid = $('editSlotGrid');
  grid.innerHTML = '';
  hint.textContent = 'Loading times…';
  try {
    // A blocked row's grid is built for its duration, not a service's.
    const qs = blocked
      ? `duration=${encodeURIComponent($('editDuration').value)}`
      : `serviceId=${encodeURIComponent($('editService').value)}`;
    const data = await api(`/api/slots?date=${encodeURIComponent(date)}&${qs}`);
    hint.textContent = (data.closed || data.slots.length === 0) ? (data.message || 'No times available on that day.') : '';
    const times = data.slots.map((s) => s.time);
    // Keep the booking's current time selectable when the date and
    // service are unchanged — /api/slots excludes it as "taken" — but
    // never when that time is already past (past slots are never shown).
    if (original && original.date === date && (blocked || original.serviceId === $('editService').value)
      && !times.includes(original.time) && !isPastSlot(date, original.time)) {
      times.unshift(original.time);
    }
    if (!times.includes(state.editSelectedTime)) state.editSelectedTime = null;
    const pick = (t) => {
      state.editSelectedTime = t;
      renderSlotGrid(grid, times, state.editSelectedTime, pick);
    };
    renderSlotGrid(grid, times, state.editSelectedTime, pick);
  } catch (e) {
    hint.textContent = e.message;
  }
}

function showEditForm(b) {
  hideAddForm();
  $('editId').value = b.id;
  $('editNameLabel').textContent = b.blocked ? 'Blocked time' : b.name;
  // A blocked slot has a duration, not a service — show the duration
  // field (with the length it already has) and hide the service picker.
  const blocked = !!b.blocked;
  state.editBlocked = blocked;
  $('editServiceRow').classList.toggle('hidden', blocked);
  $('editDurationRow').classList.toggle('hidden', !blocked);
  if (blocked) $('editDuration').value = (b.endMinutes ?? 0) - (b.startMinutes ?? 0) || 30;
  else $('editService').value = b.serviceId;
  $('editDate').value = b.date;
  $('editName').value = b.name;
  $('editPhone').value = b.phone;
  // Owner-added bookings without an email store a placeholder; show it
  // as blank and restore the placeholder on save if still blank.
  $('editEmail').value = b.email === 'no-email@pxcutzz.local' ? '' : b.email;
  $('editNotes').value = b.notes || '';
  // A blocked slot has no customer — grey the customer fields out.
  $('editBlockedNote').classList.toggle('hidden', !b.blocked);
  [$('editName'), $('editPhone'), $('editEmail')].forEach((el) => { el.disabled = !!b.blocked; });
  $('editName').required = !b.blocked;
  $('editPhone').required = !b.blocked;
  state.editSelectedTime = b.time;
  $('editBookingForm').classList.remove('hidden');
  $('editSuccess').classList.add('hidden');
  $('editError').classList.add('hidden');
  // Same-name check on the pre-filled details (warns if another client
  // shares this name under a different number).
  showSameNameWarning($('editNameWarn'), $('editName').value, $('editPhone').value);
  loadEditSlots();
  $('editBookingForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitEditBooking(ev) {
  ev.preventDefault();
  const err = $('editError');
  const ok = $('editSuccess');
  err.classList.add('hidden');
  ok.classList.add('hidden');
  if (!state.editSelectedTime) {
    err.textContent = 'Please pick a time slot.';
    err.classList.remove('hidden');
    return;
  }
  const btn = $('editSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const body = {
      date: $('editDate').value,
      time: state.editSelectedTime,
      name: $('editName').value.trim(),
      phone: $('editPhone').value.trim(),
      email: $('editEmail').value.trim() || 'no-email@pxcutzz.local',
      notes: $('editNotes').value.trim(),
    };
    // A blocked row keeps its duration, not a service.
    if (state.editBlocked) body.duration = Number($('editDuration').value);
    else body.serviceId = $('editService').value;
    const updated = await api(`/api/bookings/${$('editId').value}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    state.bookings = await api('/api/bookings');
    // If the booking moved to another day, jump the view to that day.
    state.selectedDate = updated.date;
    const [y, m] = updated.date.split('-').map(Number);
    state.viewYear = y;
    state.viewMonth = m - 1;
    hideEditForm();
    renderCalendar();
    renderDayDetail();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const today = vancouverToday();
const [cy, cm] = today.split('-').map(Number);
state.viewYear = cy;
state.viewMonth = cm - 1;
state.selectedDate = today;

$('prevMonthBtn').onclick = () => changeMonth(-1);
$('nextMonthBtn').onclick = () => changeMonth(1);
$('blockDayBtn').onclick = toggleBlockDay;
$('addBookingBtn').onclick = showAddForm;
$('cancelAddBtn').onclick = hideAddForm;
$('addBookingForm').addEventListener('submit', submitAddBooking);
$('addService').addEventListener('change', loadAddSlots);
$('addBlock').addEventListener('change', () => { syncBlockFields(); loadAddSlots(); });
$('addDuration').addEventListener('change', () => { if ($('addBlock').checked) loadAddSlots(); });
$('cancelEditBtn').onclick = hideEditForm;
$('editBookingForm').addEventListener('submit', submitEditBooking);
$('editService').addEventListener('change', loadEditSlots);
$('editDuration').addEventListener('change', loadEditSlots);
$('editDate').addEventListener('change', loadEditSlots);
$('dashUnlockBtn').onclick = unlockDashboard;
$('dashTokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockDashboard(); });
// Same-name warning: as the owner types a name or number in any form,
// show the numbers of existing clients with that name (if different).
const warnAdd = () => showSameNameWarning($('addNameWarn'), $('addName').value, $('addPhone').value);
const warnEdit = () => showSameNameWarning($('editNameWarn'), $('editName').value, $('editPhone').value);
const warnMember = () => showSameNameWarning($('addMemberNameWarn'), $('addMemberName').value, $('addMemberPhone').value);
$('addName').addEventListener('input', warnAdd);
$('addPhone').addEventListener('input', warnAdd);
$('editName').addEventListener('input', warnEdit);
$('editPhone').addEventListener('input', warnEdit);
$('addMemberName').addEventListener('input', warnMember);
$('addMemberPhone').addEventListener('input', warnMember);

loadAll();
