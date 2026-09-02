// Familien-Kalender — App-Logik
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore, collection, query, where, onSnapshot,
  addDoc, doc, setDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

// ── Firebase init ─────────────────────────────────────────────
const configOk = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME';
let app, auth, db;
if (configOk) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('loading').innerHTML =
      '<div style="max-width:500px;text-align:center;padding:2rem;">' +
      '<h2 style="color:#ef4444;margin-bottom:1rem;">Firebase noch nicht konfiguriert</h2>' +
      '<p style="color:#94a3b8;">Bitte <code>firebase-config.js</code> mit den Werten aus der Firebase-Console ausfüllen.</p>' +
      '</div>';
  });
  throw new Error('firebase-config.js unvollständig');
}

// ── Element-Referenzen ────────────────────────────────────────
const $ = id => document.getElementById(id);
const loadingEl = $('loading');
const loginEl = $('login');
const appEl = $('app');

// ── Auth-State ────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  loadingEl.classList.add('hidden');
  if (user) {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    renderApp(user);
  } else {
    appEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
    renderLogin();
  }
});

// ── Login-Screen ──────────────────────────────────────────────
function renderLogin() {
  let mode = 'login';
  loginEl.innerHTML = `
    <div class="login-box">
      <div class="login-title">📅 Kalender</div>
      <div class="login-sub">Melde dich an oder erstelle ein Konto</div>
      <div class="login-tabs">
        <button data-mode="login" class="active">Anmelden</button>
        <button data-mode="register">Registrieren</button>
      </div>
      <div id="login-msg"></div>
      <form id="login-form">
        <div class="field" id="name-field" style="display:none;">
          <label>Anzeigename</label>
          <input type="text" id="in-name" autocomplete="name" />
        </div>
        <div class="field">
          <label>E-Mail</label>
          <input type="email" id="in-email" autocomplete="email" required />
        </div>
        <div class="field">
          <label>Passwort</label>
          <input type="password" id="in-pass" autocomplete="current-password" required minlength="6" />
        </div>
        <button type="submit" class="btn" id="submit-btn">Anmelden</button>
      </form>
    </div>
  `;

  const tabs = loginEl.querySelectorAll('.login-tabs button');
  const submitBtn = $('submit-btn');
  const nameField = $('name-field');
  const passInput = $('in-pass');

  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
    submitBtn.textContent = mode === 'login' ? 'Anmelden' : 'Konto erstellen';
    nameField.style.display = mode === 'register' ? 'block' : 'none';
    passInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    showMsg('');
  }));

  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    submitBtn.disabled = true;
    const email = $('in-email').value.trim();
    const pass = $('in-pass').value;
    const name = $('in-name').value.trim();
    try {
      if (mode === 'login') {
        await signInWithEmailAndPassword(auth, email, pass);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, 'users', cred.user.uid), {
          email, name: name || email.split('@')[0],
          createdAt: serverTimestamp()
        });
      }
    } catch (err) {
      showMsg(friendlyAuthError(err.code), 'error');
      submitBtn.disabled = false;
    }
  });
}

function showMsg(text, type = 'error') {
  const el = $('login-msg');
  if (!el) return;
  if (!text) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="msg msg-${type}">${text}</div>`;
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email': 'Ungültige E-Mail-Adresse.',
    'auth/invalid-credential': 'E-Mail oder Passwort falsch.',
    'auth/user-not-found': 'Kein Konto mit dieser E-Mail gefunden.',
    'auth/wrong-password': 'Passwort falsch.',
    'auth/email-already-in-use': 'Diese E-Mail wird bereits verwendet.',
    'auth/weak-password': 'Passwort zu kurz (mindestens 6 Zeichen).',
    'auth/network-request-failed': 'Keine Verbindung — Internet prüfen.'
  };
  return map[code] || `Fehler: ${code}`;
}

// ── Hauptansicht ──────────────────────────────────────────────
const CALENDAR_COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#22c55e', '#0ea5e9'];
let calendarUnsub = null;

function renderApp(user) {
  appEl.innerHTML = `
    <header class="topbar">
      <h1>📅 Kalender</h1>
      <div class="topbar-spacer"></div>
      <span class="user-badge">${escapeHtml(user.email)}</span>
      <button class="logout-btn" id="logout-btn">Abmelden</button>
    </header>
    <main class="content">
      <div class="section-title">
        <span>Meine Kalender</span>
        <button class="btn" style="width:auto;padding:8px 16px;" id="new-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="calendars"></div>
    </main>
  `;

  $('logout-btn').addEventListener('click', () => signOut(auth));
  $('new-cal-btn').addEventListener('click', () => openNewCalendarModal(user));

  subscribeCalendars(user);
}

function subscribeCalendars(user) {
  if (calendarUnsub) calendarUnsub();
  const q = query(collection(db, 'calendars'), where(`members.${user.uid}`, 'in', ['owner', 'editor', 'viewer']));
  calendarUnsub = onSnapshot(q, snap => {
    const cals = [];
    snap.forEach(d => cals.push({ id: d.id, ...d.data() }));
    renderCalendars(cals, user);
  }, err => {
    $('calendars').innerHTML = `<div class="msg msg-error">Konnte Kalender nicht laden: ${escapeHtml(err.message)}</div>`;
  });
}

function renderCalendars(cals, user) {
  const el = $('calendars');
  if (!cals.length) {
    el.innerHTML = `
      <div class="empty">
        <p style="margin-bottom:1rem;">Noch kein Kalender vorhanden.</p>
        <p>Leg deinen ersten Kalender an — z.B. „Familie" oder „Termine".</p>
      </div>
    `;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${cals.map(c => `
    <div class="calendar-card" data-id="${c.id}">
      <div class="cal-name">
        <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
        ${escapeHtml(c.name)}
      </div>
      <div class="cal-role">${c.members?.[user.uid] || '—'}</div>
    </div>
  `).join('')}</div>`;
}

function openNewCalendarModal(user) {
  let selectedColor = CALENDAR_COLORS[0];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Neuer Kalender</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="cal-name" placeholder="z.B. Familie" required />
      </div>
      <div class="field">
        <label>Farbe</label>
        <div class="color-picker">
          ${CALENDAR_COLORS.map((c, i) => `
            <div class="color-swatch ${i === 0 ? 'selected' : ''}" data-color="${c}" style="background:${c};"></div>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="create-btn">Erstellen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('cal-name').focus();

  overlay.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      selectedColor = sw.dataset.color;
    });
  });

  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('create-btn').addEventListener('click', async () => {
    const name = $('cal-name').value.trim();
    if (!name) return;
    const btn = $('create-btn');
    btn.disabled = true;
    try {
      await addDoc(collection(db, 'calendars'), {
        name,
        color: selectedColor,
        owner: user.uid,
        members: { [user.uid]: 'owner' },
        createdAt: serverTimestamp()
      });
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Service Worker ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
