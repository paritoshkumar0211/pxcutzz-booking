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
  if (n === 4) updateJoinVisibility();
}

// Hide the "Join membership" option for clients who are already
// members: when the phone number is typed, check it (only a yes/no
// answer comes back — no member details) and hide the option when the
// number belongs to someone with an active, unfinished membership.
// A finished or expired member still sees the option, so they can
// join the next membership.
let memberCheckTimer = null;
let lastCheckedPhone = '';
async function updateJoinVisibility() {
  const row = $('joinMembershipRow');
  const note = $('joinMembershipNote');
  if (!row || !note) return;
  const phone = $('phoneInput').value.replace(/\D/g, '');
  if (phone.length < 10) {
    // Not a full number yet — show the option again.
    lastCheckedPhone = '';
    row.classList.remove('hidden');
    note.classList.remove('hidden');
    return;
  }
  if (phone === lastCheckedPhone) return;
  lastCheckedPhone = phone;
  try {
    const data = await api(`/api/members/check?phone=${encodeURIComponent(phone)}`);
    const isMember = !!data.isMember;
    if (isMember) $('joinMembershipInput').checked = false;
    row.classList.toggle('hidden', isMember);
    note.classList.toggle('hidden', isMember);
  } catch (_) { /* check failed — leave the option visible */ }
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
    card.innerHTML = `<h3></h3><div class="price"></div><button class="btn">Book this</button>`;
    card.querySelector('h3').textContent = s.name;
    card.querySelector('.price').textContent = s.priceLabel;
    card.querySelector('button').onclick = () => { selectService(s.id); setStep(2); };
    grid.appendChild(card);

    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} — ${s.priceLabel}`;
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
      : `${state.service.name}: ${state.service.priceLabel}.`;
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
        joinMembership: $('joinMembershipInput').checked,
      }),
    });
    const b = res.booking;
    $('confirmationText').textContent =
      `${b.name}, your ${b.serviceName} is booked for ${b.date} at ${b.time} – ${b.endTime} at PXCUTZZ, 9385 120 St, Unit 102, Surrey, BC.`;
    $('emailNote').textContent = res.emailNote || '';
    $('emailNote').classList.toggle('hidden', !res.emailNote);
    $('membershipNote').textContent = res.membershipJoined
      ? `You're now a PXCUTZZ member — we'll text you every 9 days to remind you to book your next haircut.`
      : '';
    $('membershipNote').classList.toggle('hidden', !res.membershipJoined);
    setStep(5);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm booking';
  }
}

$('serviceSelect').addEventListener('change', (e) => selectService(e.target.value));
$('toDayBtn').onclick = () => { if (!state.service) { showError('Please choose a service.'); return; } setupDateInput(); setStep(2); };
$('backToServiceBtn').onclick = () => setStep(1);
$('toTimeBtn').onclick = loadSlots;
$('backToDayBtn').onclick = () => setStep(2);
$('backToTimeBtn').onclick = () => setStep(3);
$('bookingForm').addEventListener('submit', submitBooking);
$('bookAnotherBtn').onclick = () => { $('bookingForm').reset(); setStep(1); };
$('dateInput').addEventListener('change', () => { if (!$('stepTime').classList.contains('hidden')) loadSlots(); });
$('phoneInput').addEventListener('input', () => {
  clearTimeout(memberCheckTimer);
  memberCheckTimer = setTimeout(updateJoinVisibility, 500);
});

loadServices();
