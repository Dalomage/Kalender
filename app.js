// Familien-Kalender — App-Logik
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore, collection, query, where, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, Timestamp
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

// ── State ─────────────────────────────────────────────────────
let currentUser = null;
let calendarsUnsub = null;
let eventsUnsub = null;
let fcInstance = null;
let currentCalendar = null;

// ── Auth-State ────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  loadingEl.classList.add('hidden');
  currentUser = user;
  if (user) {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    showCalendarList();
  } else {
    appEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
    cleanupSubscriptions();
    renderLogin();
  }
});

function cleanupSubscriptions() {
  if (calendarsUnsub) { calendarsUnsub(); calendarsUnsub = null; }
  if (eventsUnsub) { eventsUnsub(); eventsUnsub = null; }
  if (fcInstance) { fcInstance.destroy(); fcInstance = null; }
  currentCalendar = null;
}

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

// ── Topbar ────────────────────────────────────────────────────
function topbarHtml(extra = '') {
  return `
    <header class="topbar">
      <h1>📅 Kalender</h1>
      ${extra}
      <div class="topbar-spacer"></div>
      <span class="user-badge">${escapeHtml(currentUser.email)}</span>
      <button class="logout-btn" id="logout-btn">Abmelden</button>
    </header>
  `;
}

function wireLogout() {
  $('logout-btn').addEventListener('click', () => signOut(auth));
}

// ── Kalender-Liste ────────────────────────────────────────────
const CALENDAR_COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#22c55e', '#0ea5e9'];

function showCalendarList() {
  cleanupSubscriptions();
  appEl.innerHTML = `
    ${topbarHtml()}
    <main class="content">
      <div class="section-title">
        <span>Meine Kalender</span>
        <button class="btn" style="width:auto;padding:8px 16px;" id="new-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="calendars"></div>
    </main>
  `;
  wireLogout();
  $('new-cal-btn').addEventListener('click', openNewCalendarModal);
  subscribeCalendars();
}

function subscribeCalendars() {
  const q = query(collection(db, 'calendars'), where(`members.${currentUser.uid}`, 'in', ['owner', 'editor', 'viewer']));
  calendarsUnsub = onSnapshot(q, snap => {
    const cals = [];
    snap.forEach(d => cals.push({ id: d.id, ...d.data() }));
    renderCalendarCards(cals);
  }, err => {
    $('calendars').innerHTML = `<div class="msg msg-error">Konnte Kalender nicht laden: ${escapeHtml(err.message)}</div>`;
  });
}

function renderCalendarCards(cals) {
  const el = $('calendars');
  if (!el) return;
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
      <div class="cal-role">${c.members?.[currentUser.uid] || '—'}</div>
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('.calendar-card').forEach(card => {
    card.addEventListener('click', () => {
      const cal = cals.find(c => c.id === card.dataset.id);
      if (cal) showCalendarView(cal);
    });
  });
}

function openNewCalendarModal() {
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
        owner: currentUser.uid,
        members: { [currentUser.uid]: 'owner' },
        createdAt: serverTimestamp()
      });
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ── Kalender-Detailansicht (FullCalendar) ─────────────────────
function showCalendarView(cal) {
  cleanupSubscriptions();
  currentCalendar = cal;
  const myRole = cal.members?.[currentUser.uid] || 'viewer';
  const canEdit = myRole === 'owner' || myRole === 'editor';

  appEl.innerHTML = `
    ${topbarHtml(`
      <button class="logout-btn" id="back-btn">← Zurück</button>
      <span class="topbar-cal">
        <span class="color-dot" style="background:${escapeHtml(cal.color)};"></span>
        ${escapeHtml(cal.name)}
      </span>
    `)}
    <main class="content content-wide">
      <div id="fc-container"></div>
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', showCalendarList);

  const container = $('fc-container');
  fcInstance = new FullCalendar.Calendar(container, {
    locale: 'de',
    initialView: window.innerWidth < 700 ? 'listWeek' : 'dayGridMonth',
    firstDay: 1,
    height: 'auto',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: window.innerWidth < 700 ? 'dayGridMonth,listWeek' : 'dayGridMonth,timeGridWeek,listWeek'
    },
    buttonText: { today: 'Heute', month: 'Monat', week: 'Woche', list: 'Liste' },
    eventColor: cal.color,
    selectable: canEdit,
    editable: false,
    dateClick: canEdit ? info => openEventModal(cal, { start: info.dateStr, allDay: info.allDay }) : undefined,
    eventClick: info => openEventModal(cal, info.event.extendedProps._doc, canEdit),
    events: (_info, success, failure) => {
      // wird durch onSnapshot ersetzt — leer, damit FC nichts selbst lädt
      success([]);
    }
  });
  fcInstance.render();

  // Live-Sync der Events aus Firestore
  eventsUnsub = onSnapshot(collection(db, 'calendars', cal.id, 'events'), snap => {
    fcInstance.removeAllEvents();
    snap.forEach(d => {
      const data = d.data();
      fcInstance.addEvent({
        id: d.id,
        title: data.title,
        start: tsToDate(data.start),
        end: tsToDate(data.end),
        allDay: !!data.allDay,
        color: cal.color,
        extendedProps: {
          _doc: { id: d.id, ...data }
        }
      });
    });
  }, err => {
    console.error('Events laden fehlgeschlagen:', err);
  });
}

function tsToDate(ts) {
  if (!ts) return null;
  if (ts instanceof Timestamp) return ts.toDate();
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

// ── Termin-Modal (anlegen/bearbeiten) ─────────────────────────
function openEventModal(cal, existing, canEdit = true) {
  const isNew = !existing?.id;
  const startDefault = existing?.start ? toLocalInput(tsToDate(existing.start), existing.allDay) : toLocalInput(new Date(), false);
  const endDefault = existing?.end ? toLocalInput(tsToDate(existing.end), existing.allDay) : startDefault;
  const allDay = !!existing?.allDay;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${isNew ? 'Neuer Termin' : (canEdit ? 'Termin bearbeiten' : 'Termin')}</h2>
      <div id="ev-msg"></div>
      <div class="field">
        <label>Titel</label>
        <input type="text" id="ev-title" value="${escapeHtml(existing?.title || '')}" ${canEdit ? '' : 'disabled'} required />
      </div>
      <div class="field field-inline">
        <label><input type="checkbox" id="ev-allday" ${allDay ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /> Ganztägig</label>
      </div>
      <div class="field">
        <label>Start</label>
        <input type="${allDay ? 'date' : 'datetime-local'}" id="ev-start" value="${startDefault}" ${canEdit ? '' : 'disabled'} required />
      </div>
      <div class="field">
        <label>Ende</label>
        <input type="${allDay ? 'date' : 'datetime-local'}" id="ev-end" value="${endDefault}" ${canEdit ? '' : 'disabled'} />
      </div>
      <div class="field">
        <label>Notiz (optional)</label>
        <textarea id="ev-note" rows="2" ${canEdit ? '' : 'disabled'}>${escapeHtml(existing?.note || '')}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">${canEdit ? 'Abbrechen' : 'Schließen'}</button>
        ${!isNew && canEdit ? '<button class="btn btn-danger" id="delete-btn">Löschen</button>' : ''}
        ${canEdit ? `<button class="btn" id="save-btn">${isNew ? 'Anlegen' : 'Speichern'}</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  if (canEdit) $('ev-title').focus();

  const allDayCheckbox = $('ev-allday');
  allDayCheckbox?.addEventListener('change', () => {
    const now = allDayCheckbox.checked;
    const startEl = $('ev-start');
    const endEl = $('ev-end');
    const startDate = fromLocalInput(startEl.value, !now);
    const endDate = fromLocalInput(endEl.value, !now);
    startEl.type = now ? 'date' : 'datetime-local';
    endEl.type = now ? 'date' : 'datetime-local';
    startEl.value = toLocalInput(startDate, now);
    endEl.value = toLocalInput(endDate, now);
  });

  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  if (canEdit) {
    $('save-btn').addEventListener('click', async () => {
      const title = $('ev-title').value.trim();
      if (!title) { showEvMsg('Titel fehlt.'); return; }
      const isAllDay = allDayCheckbox.checked;
      const start = fromLocalInput($('ev-start').value, !isAllDay);
      let end = fromLocalInput($('ev-end').value, !isAllDay);
      if (!start) { showEvMsg('Startzeit ungültig.'); return; }
      if (!end || end < start) end = start;
      const note = $('ev-note').value.trim();

      const btn = $('save-btn');
      btn.disabled = true;
      try {
        const payload = {
          title,
          start: Timestamp.fromDate(start),
          end: Timestamp.fromDate(end),
          allDay: isAllDay,
          note,
          updatedAt: serverTimestamp()
        };
        if (isNew) {
          payload.createdAt = serverTimestamp();
          payload.createdBy = currentUser.uid;
          await addDoc(collection(db, 'calendars', cal.id, 'events'), payload);
        } else {
          await updateDoc(doc(db, 'calendars', cal.id, 'events', existing.id), payload);
        }
        overlay.remove();
      } catch (err) {
        showEvMsg(err.message);
        btn.disabled = false;
      }
    });

    const delBtn = $('delete-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('Diesen Termin wirklich löschen?')) return;
        delBtn.disabled = true;
        try {
          await deleteDoc(doc(db, 'calendars', cal.id, 'events', existing.id));
          overlay.remove();
        } catch (err) {
          showEvMsg(err.message);
          delBtn.disabled = false;
        }
      });
    }
  }
}

function showEvMsg(msg) {
  $('ev-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(msg)}</div>`;
}

// Format Date -> value für <input type="datetime-local"> oder "date"
function toLocalInput(date, allDay) {
  if (!date) date = new Date();
  const pad = n => String(n).padStart(2, '0');
  const y = date.getFullYear(), m = pad(date.getMonth() + 1), d = pad(date.getDate());
  if (allDay) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value, withTime) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return null;
  return d;
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
