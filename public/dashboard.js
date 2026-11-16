/* PXCUTZZ owner booking dashboard — vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'pxcutzz_admin_token';
const CLOSED_WEEKDAY = 2; // Tuesday (0=Sunday)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const state = {
  adminToken: localStorage.getItem(TOKEN_KEY) || '',
  services: [],
  bookings: [],
  blocked: new Set(),
  viewYear: 0,
  viewMonth: 0,
  selectedDate: null, // YYYY-MM-DD
};

function vancouverToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function weekdayOf(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function dateStrOf(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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
    const [services, bookings, blocked] = await Promise.all([
      api('/api/services'),
      api('/api/bookings'),
      api('/api/blocked-days'),
    ]);
    state.services = services;
    state.bookings = bookings;
    state.blocked = new Set(blocked.dates || []);
    $('dashContent').classList.remove('hidden');
    $('dashTokenRow').classList.add('hidden');
    fillServiceSelect();
    renderCalendar();
    renderDayDetail();
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
// Calendar badges count active bookings only (cancelled excluded,
// completed still counted).
function countsByDate() {
  const counts = {};
  state.bookings.forEach((b) => {
    if (b.status === 'cancelled') return;
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
    if (wd === CLOSED_WEEKDAY) cell.classList.add('closed');
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
    if (wd === CLOSED_WEEKDAY) {
      const lbl = document.createElement('span');
      lbl.className = 'cal-closed';
      lbl.textContent = 'closed';
      cell.appendChild(lbl);
    } else if (state.blocked.has(ds)) {
      const lbl = document.createElement('span');
      lbl.className = 'cal-closed';
      lbl.textContent = 'blocked';
      cell.appendChild(lbl);
    }

    cell.onclick = () => { state.selectedDate = ds; hideAddForm(); renderCalendar(); renderDayDetail(); };
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
  state.selectedDate = (y === ty && m === tm - 1) ? today : dateStrOf(y, m, 1);
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

function renderDayDetail() {
  const ds = state.selectedDate;
  const rows = state.bookings
    .filter((b) => b.date === ds)
    .sort((a, b) => (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
  const isTuesday = weekdayOf(ds) === CLOSED_WEEKDAY;
  const isBlocked = state.blocked.has(ds);
  // Day count counts active bookings only (cancelled excluded,
  // completed still counted).
  const activeCount = rows.filter((b) => b.status !== 'cancelled').length;

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

  const tbody = $('dayRows');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${isTuesday ? 'Closed on Tuesdays.' : isBlocked ? 'Day blocked — no bookings.' : 'No bookings yet.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  rows.forEach((b) => {
    const tr = document.createElement('tr');
    if (b.status === 'completed') tr.classList.add('row-done');
    if (b.status === 'cancelled') tr.classList.add('row-cancelled');
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td>';
    const tds = tr.querySelectorAll('td');
    // TIME: start time, with the service duration beneath it.
    const timeEl = document.createElement('div');
    timeEl.textContent = b.time;
    tds[0].appendChild(timeEl);
    const svc = state.services.find((s) => s.id === b.serviceId);
    if (svc) {
      const dur = document.createElement('div');
      dur.className = 'time-dur';
      dur.textContent = `${svc.duration} min`;
      tds[0].appendChild(dur);
    }
    // CUSTOMER (+ status tag for completed/cancelled rows).
    tds[1].textContent = b.name;
    if (b.status === 'completed' || b.status === 'cancelled') {
      const tag = document.createElement('span');
      tag.className = 'status-tag';
      tag.textContent = b.status === 'completed' ? 'Completed' : 'Cancelled';
      tds[1].appendChild(document.createElement('br'));
      tds[1].appendChild(tag);
    }
    tds[2].textContent = b.serviceName;
    tds[3].textContent = b.phone;
    // ACTIONS: Send SMS + Edit / Complete / Cancel. Cancelled rows
    // show no actions at all; completed rows lose the Complete button.
    const actions = tds[4];
    actions.classList.add('dash-actions');
    if (b.status !== 'cancelled') {
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
    tbody.appendChild(tr);
  });
}

// One-tap Complete, confirmed Cancel — then reload the bookings list.
async function rowAction(b, action, btn) {
  if (action === 'cancel' && !window.confirm(`Cancel ${b.name}'s ${b.serviceName} booking on ${b.date} at ${b.time}? The time slot will be freed.`)) return;
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
// Add booking
// ---------------------------------------------------------------------------
function hideAddForm() {
  $('addBookingForm').classList.add('hidden');
  $('addSuccess').classList.add('hidden');
  $('addError').classList.add('hidden');
  $('addBookingBtn').classList.remove('hidden');
  hideEditForm();
}

async function loadAddSlots() {
  const serviceId = $('addService').value;
  const hint = $('addTimeHint');
  const sel = $('addTime');
  sel.innerHTML = '';
  hint.textContent = 'Loading times…';
  try {
    const data = await api(`/api/slots?date=${encodeURIComponent(state.selectedDate)}&serviceId=${encodeURIComponent(serviceId)}`);
    if (data.closed || data.slots.length === 0) {
      hint.textContent = data.message || 'No times available on that day.';
      return;
    }
    hint.textContent = '';
    data.slots.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.time;
      opt.textContent = s.time;
      sel.appendChild(opt);
    });
  } catch (e) {
    hint.textContent = e.message;
  }
}

function showAddForm() {
  hideEditForm();
  $('addDateLabel').textContent = formatDay(state.selectedDate);
  $('addBookingForm').classList.remove('hidden');
  $('addSuccess').classList.add('hidden');
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
  const btn = $('addSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const email = $('addEmail').value.trim();
    const res = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: $('addService').value,
        date: state.selectedDate,
        time: $('addTime').value,
        name: $('addName').value.trim(),
        phone: $('addPhone').value.trim(),
        // Email is required by the booking API; when the owner leaves it
        // blank we store a placeholder so no confirmation is attempted.
        email: email || 'no-email@pxcutzz.local',
      }),
    });
    const b = res.booking;
    ok.textContent = `Booked: ${b.name} — ${b.serviceName} on ${b.date} at ${b.time}.`;
    ok.classList.remove('hidden');
    $('addName').value = '';
    $('addPhone').value = '';
    $('addEmail').value = '';
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
    btn.textContent = 'Save booking';
  }
}

// ---------------------------------------------------------------------------
// Edit booking
// ---------------------------------------------------------------------------
function hideEditForm() {
  $('editBookingForm').classList.add('hidden');
  $('editSuccess').classList.add('hidden');
  $('editError').classList.add('hidden');
}

async function loadEditSlots() {
  const id = $('editId').value;
  const original = state.bookings.find((b) => String(b.id) === String(id));
  const serviceId = $('editService').value;
  const date = $('editDate').value;
  const hint = $('editTimeHint');
  const sel = $('editTime');
  const prev = sel.value;
  sel.innerHTML = '';
  hint.textContent = 'Loading times…';
  try {
    const data = await api(`/api/slots?date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(serviceId)}`);
    hint.textContent = (data.closed || data.slots.length === 0) ? (data.message || 'No times available on that day.') : '';
    const times = data.slots.map((s) => s.time);
    // Keep the booking's current time selectable when the date and
    // service are unchanged — /api/slots excludes it as "taken".
    if (original && original.date === date && original.serviceId === serviceId && !times.includes(original.time)) {
      times.unshift(original.time);
    }
    times.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    });
    if (prev && times.includes(prev)) sel.value = prev;
    else if (original && original.date === date && original.serviceId === serviceId) sel.value = original.time;
  } catch (e) {
    hint.textContent = e.message;
  }
}

function showEditForm(b) {
  hideAddForm();
  $('editId').value = b.id;
  $('editNameLabel').textContent = b.name;
  $('editService').value = b.serviceId;
  $('editDate').value = b.date;
  $('editName').value = b.name;
  $('editPhone').value = b.phone;
  // Owner-added bookings without an email store a placeholder; show it
  // as blank and restore the placeholder on save if still blank.
  $('editEmail').value = b.email === 'no-email@pxcutzz.local' ? '' : b.email;
  $('editBookingForm').classList.remove('hidden');
  $('editSuccess').classList.add('hidden');
  $('editError').classList.add('hidden');
  loadEditSlots();
  $('editBookingForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitEditBooking(ev) {
  ev.preventDefault();
  const err = $('editError');
  const ok = $('editSuccess');
  err.classList.add('hidden');
  ok.classList.add('hidden');
  const btn = $('editSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const updated = await api(`/api/bookings/${$('editId').value}`, {
      method: 'PUT',
      body: JSON.stringify({
        serviceId: $('editService').value,
        date: $('editDate').value,
        time: $('editTime').value,
        name: $('editName').value.trim(),
        phone: $('editPhone').value.trim(),
        email: $('editEmail').value.trim() || 'no-email@pxcutzz.local',
      }),
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
$('cancelEditBtn').onclick = hideEditForm;
$('editBookingForm').addEventListener('submit', submitEditBooking);
$('editService').addEventListener('change', loadEditSlots);
$('editDate').addEventListener('change', loadEditSlots);
$('dashUnlockBtn').onclick = unlockDashboard;
$('dashTokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockDashboard(); });

loadAll();
