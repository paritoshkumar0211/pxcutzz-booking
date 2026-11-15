/* PXCUTZZ booking frontend — vanilla JS, no build step. */
const $ = (id) => document.getElementById(id);
const state = { services: [], service: null, date: null, slot: null, adminToken: localStorage.getItem('pxcutzz_admin_token') || '' };

function showError(msg) {
  const el = $('stepError');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg; el.classList.remove('hidden');
}

function setStep(n) {
  ['stepService', 'stepDay', 'stepTime', 'stepDetails', 'stepDone'].forEach((id, i) => {
    $(id).classList.toggle('hidden', i !== n - 1);
  });
  document.querySelectorAll('#steps li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  });
  showError('');
  window.scrollTo({ top: $('book').offsetTop - 70, behavior: 'smooth' });
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(state.adminToken ? { 'x-admin-token': state.adminToken } : {}) }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadServices() {
  state.services = await api('/api/services');
  const grid = $('serviceGrid');
  grid.innerHTML = '';
  const sel = $('serviceSelect');
  sel.innerHTML = '';
  state.services.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'service-card';
    card.innerHTML = `<h3></h3><div class="price"></div><div class="dur"></div><button class="btn">Book this</button>`;
    card.querySelector('h3').textContent = s.name;
    card.querySelector('.price').textContent = s.priceLabel;
    card.querySelector('.dur').textContent = `${s.duration} min${s.placeholderDuration ? ' *' : ''}`;
    card.querySelector('button').onclick = () => { selectService(s.id); setStep(2); };
    grid.appendChild(card);

    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} — ${s.priceLabel} (${s.duration} min${s.placeholderDuration ? ' *' : ''})`;
    sel.appendChild(opt);
  });
  selectService(state.services[0]?.id);
}

function selectService(id) {
  state.service = state.services.find((s) => s.id === id) || null;
  if (state.service) {
    $('serviceSelect').value = state.service.id;
    $('serviceHint').textContent = state.service.priceOnRequest
      ? 'Price on request — the salon will confirm the price with you.'
      : `${state.service.name}: ${state.service.priceLabel}, about ${state.service.duration} minutes.`;
  }
}

function vancouverToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function setupDateInput() {
  const input = $('dateInput');
  input.min = vancouverToday();
  const max = new Date(); max.setDate(max.getDate() + 60);
  input.max = max.toISOString().slice(0, 10);
  input.value = vancouverToday();
}

async function loadSlots() {
  const date = $('dateInput').value;
  if (!date) { showError('Please pick a day.'); return; }
  state.date = date;
  $('slotSummary').textContent = `${state.service.name} · ${date}`;
  const list = $('slotList');
  list.innerHTML = '<p class="muted">Loading times…</p>';
  setStep(3);
  try {
    const data = await api(`/api/slots?date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(state.service.id)}`);
    list.innerHTML = '';
    if (data.closed || data.slots.length === 0) {
      list.innerHTML = `<p>${data.message || 'No times available on that day. Please pick another day.'}</p>`;
      return;
    }
    data.slots.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'slot';
      b.textContent = s.time;
      b.onclick = () => { state.slot = s; $('detailsSummary').textContent = `${state.service.name} · ${date} · ${s.time}`; setStep(4); };
      list.appendChild(b);
    });
  } catch (e) {
    list.innerHTML = '';
    showError(e.message);
  }
}

async function submitBooking(ev) {
  ev.preventDefault();
  const btn = $('submitBtn');
  btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const res = await api('/api/bookings', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: state.service.id,
        date: state.date,
        time: state.slot.time,
        name: $('nameInput').value.trim(),
        phone: $('phoneInput').value.trim(),
        email: $('emailInput').value.trim(),
      }),
    });
    const b = res.booking;
    $('confirmationText').textContent =
      `${b.name}, your ${b.serviceName} is booked for ${b.date} at ${b.time} – ${b.endTime} at PXCUTZZ, 9385 120 St, Unit 102, Surrey, BC.`;
    $('emailNote').textContent = res.emailNote;
    setStep(5);
    loadBookings();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm booking';
  }
}

async function loadBookings() {
  const tbody = $('bookingRows');
  const err = $('manageError');
  err.classList.add('hidden');
  try {
    const rows = await api('/api/bookings');
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted">No bookings yet.</td></tr>'; return; }
    tbody.innerHTML = '';
    rows.forEach((b) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td></td><td></td><td></td><td></td><td></td><td><span class="status ${b.status}"></span></td><td></td>`;
      const tds = tr.querySelectorAll('td');
      tds[0].textContent = b.date;
      tds[1].textContent = `${b.time} – ${b.endTime}`;
      tds[2].textContent = b.serviceName;
      tds[3].textContent = b.name;
      tds[4].textContent = b.phone;
      tds[5].textContent = b.status;
      if (b.status !== 'confirmed') {
        const btn = document.createElement('button');
        btn.className = 'btn'; btn.textContent = 'Confirm';
        btn.onclick = async () => { await api(`/api/bookings/${b.id}/confirm`, { method: 'POST' }); loadBookings(); };
        tds[6].appendChild(btn);
      }
      tbody.appendChild(tr);
    });
  } catch (e) {
    if (e.message.includes('Admin token')) {
      err.textContent = 'Admin token required to view bookings. Enter it below to unlock.';
      err.classList.remove('hidden');
      $('adminTokenRow').classList.remove('hidden');
      $('adminTokenInput').focus();
    } else {
      err.textContent = e.message; err.classList.remove('hidden');
    }
  }
}

function unlockBookings() {
  const token = $('adminTokenInput').value.trim();
  if (!token) return;
  state.adminToken = token;
  localStorage.setItem('pxcutzz_admin_token', token);
  $('adminTokenRow').classList.add('hidden');
  $('adminTokenInput').value = '';
  loadBookings();
}

$('serviceSelect').addEventListener('change', (e) => selectService(e.target.value));
$('toDayBtn').onclick = () => { if (!state.service) { showError('Please choose a service.'); return; } setupDateInput(); setStep(2); };
$('backToServiceBtn').onclick = () => setStep(1);
$('toTimeBtn').onclick = loadSlots;
$('backToDayBtn').onclick = () => setStep(2);
$('backToTimeBtn').onclick = () => setStep(3);
$('bookingForm').addEventListener('submit', submitBooking);
$('bookAnotherBtn').onclick = () => { $('bookingForm').reset(); setStep(1); };
$('refreshBookingsBtn').onclick = loadBookings;
$('unlockBtn').onclick = unlockBookings;
$('adminTokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockBookings(); });
$('dateInput').addEventListener('change', () => { if (!$('stepTime').classList.contains('hidden')) loadSlots(); });

loadServices();
loadBookings();
