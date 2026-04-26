// shared.js
const TOKEN = localStorage.getItem('sp_token');
const UNAME = localStorage.getItem('sp_user');
if (!TOKEN && !location.pathname.includes('/login')) location.href = '/login';

function logout() { localStorage.clear(); location.href = '/login'; }

async function api(path, method='GET', data=null) {
  const opts = { method, headers: { 'Authorization':'Bearer '+TOKEN, 'Content-Type':'application/json' } };
  if (data) opts.body = JSON.stringify(data);
  const r = await fetch(path, opts);
  if (r.status === 401) { localStorage.clear(); location.href='/login'; }
  return r.json();
}

// Clock
setInterval(() => {
  const el = document.getElementById('nav-clk');
  if (el) el.textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

// Nav active
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-link').forEach(l => {
    const href = l.getAttribute('href');
    if (location.pathname === href || (location.pathname==='/'&&href==='/dashboard')) l.classList.add('active');
  });
  const uel = document.getElementById('nav-user');
  if (uel) uel.textContent = UNAME||'User';
});

// Toast
function showToast(msg, type='info') {
  const w = document.getElementById('toast-wrap');
  if (!w) return;
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.innerHTML = msg;
  w.appendChild(d);
  setTimeout(() => { d.style.opacity='0'; d.style.transition='opacity .4s'; }, 4000);
  setTimeout(() => d.remove(), 4500);
}

// Kill switch toggles (shared)
async function toggleSystem() {
  const btn = document.getElementById('sys-kill');
  const running = btn.classList.contains('sys-off'); // toggling
  await api('/api/system/kill', 'POST', { running });
  updateKillBtns(running, null);
}

async function toggleAI() {
  const btn = document.getElementById('ai-kill');
  const enabled = btn.classList.contains('ai-off');
  await api('/api/system/ai-toggle', 'POST', { enabled });
  updateKillBtns(null, enabled);
}

function updateKillBtns(running, aiEnabled) {
  const sBtn = document.getElementById('sys-kill');
  const aBtn = document.getElementById('ai-kill');
  if (sBtn && running !== null) {
    sBtn.className = `kill-pill ${running?'sys-on':'sys-off'}`;
    sBtn.innerHTML = `<span class="dot"></span>${running?'⚡ System ON':'⛔ System OFF'}`;
  }
  if (aBtn && aiEnabled !== null) {
    aBtn.className = `kill-pill ${aiEnabled?'ai-on':'ai-off'}`;
    aBtn.innerHTML = `<span class="dot"></span>${aiEnabled?'🧠 AI ON':'🧠 AI OFF'}`;
  }
}
