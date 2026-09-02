// Familien-Kalender — App-Logik
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore, collection, query, where, onSnapshot, getDocs,
  addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, Timestamp,
  deleteField
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

// Live-Daten (aus Firestore, werden immer synchron gehalten)
let households = [];        // { id, name, owner, members: {uid: role} }
let calendars = [];         // { id, name, color, owner, householdId?, members: {uid: role} }
const unsubs = {
  households: null,
  calendarsDirect: null,
  calendarsHousehold: null,
  events: null
};
let fcInstance = null;

// aktuelle Ansicht: 'home' | 'household' | 'calendar'
let view = 'home';
let currentHousehold = null;
let currentCalendar = null;

// ── Auth-State ────────────────────────────────────────────────
onAuthStateChanged(auth, user => {
  loadingEl.classList.add('hidden');
  currentUser = user;
  if (user) {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    startSubscriptions();
    goHome();
  } else {
    appEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
    stopAll();
    renderLogin();
  }
});

function stopAll() {
  Object.keys(unsubs).forEach(k => {
    if (unsubs[k]) { unsubs[k](); unsubs[k] = null; }
  });
  if (fcInstance) { fcInstance.destroy(); fcInstance = null; }
  households = [];
  calendars = [];
  currentHousehold = null;
  currentCalendar = null;
}

// ── Firestore-Subscriptions ───────────────────────────────────
function startSubscriptions() {
  // Haushalte, in denen ich Mitglied bin
  unsubs.households = onSnapshot(collection(db, 'households'), snap => {
    // Firestore-Rules filtern; wir bekommen nur, was wir lesen dürfen
    households = [];
    snap.forEach(d => households.push({ id: d.id, ...d.data() }));
    resubscribeHouseholdCalendars();
    renderCurrent();
  }, err => console.error('households sub failed:', err));

  // Kalender, in denen ich direkt Mitglied bin
  unsubs.calendarsDirect = onSnapshot(
    query(collection(db, 'calendars'), where(`members.${currentUser.uid}`, 'in', ['owner', 'editor', 'viewer'])),
    snap => {
      mergeCalendars(snap, 'direct');
      renderCurrent();
    },
    err => console.error('calendars direct sub failed:', err)
  );
}

function resubscribeHouseholdCalendars() {
  if (unsubs.calendarsHousehold) { unsubs.calendarsHousehold(); unsubs.calendarsHousehold = null; }
  const hhIds = households.map(h => h.id);
  if (hhIds.length === 0) {
    // Nichts über Haushalte, aber vorhandene "household"-Einträge entfernen
    calendars = calendars.filter(c => c._source !== 'household');
    return;
  }
  // Firestore erlaubt bis zu 30 IDs in "in" — für ein Familientool reichlich
  unsubs.calendarsHousehold = onSnapshot(
    query(collection(db, 'calendars'), where('householdId', 'in', hhIds.slice(0, 30))),
    snap => {
      mergeCalendars(snap, 'household');
      renderCurrent();
    },
    err => console.error('calendars household sub failed:', err)
  );
}

function mergeCalendars(snap, source) {
  // Alte Einträge dieser Quelle entfernen, neue rein, dedup nach id
  calendars = calendars.filter(c => c._source !== source);
  snap.forEach(d => {
    if (calendars.find(c => c.id === d.id)) return; // schon über andere Quelle drin
    calendars.push({ id: d.id, _source: source, ...d.data() });
  });
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
    const email = $('in-email').value.trim().toLowerCase();
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

// ── Rendering-Router ──────────────────────────────────────────
function renderCurrent() {
  if (view === 'home') renderHome();
  else if (view === 'household') {
    // Falls Haushalt gelöscht/verlassen wurde → zurück
    const fresh = households.find(h => h.id === currentHousehold?.id);
    if (!fresh) { goHome(); return; }
    currentHousehold = fresh;
    renderHousehold();
  } else if (view === 'calendar') {
    const fresh = calendars.find(c => c.id === currentCalendar?.id);
    if (!fresh) { goHome(); return; }
    // FullCalendar bleibt bestehen; nur die Header-Info aktualisieren
    updateCalendarHeader(fresh);
    currentCalendar = fresh;
  }
}

function goHome() {
  view = 'home';
  currentHousehold = null;
  currentCalendar = null;
  if (unsubs.events) { unsubs.events(); unsubs.events = null; }
  if (fcInstance) { fcInstance.destroy(); fcInstance = null; }
  renderHome();
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
function wireLogout() { $('logout-btn').addEventListener('click', () => signOut(auth)); }

// ── Home: Haushalte + persönliche Kalender ────────────────────
const CALENDAR_COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#22c55e', '#0ea5e9'];

function renderHome() {
  const personalCals = calendars.filter(c => !c.householdId);
  appEl.innerHTML = `
    ${topbarHtml()}
    <main class="content">
      <div class="section-title">
        <span>Haushalte</span>
        <button class="btn btn-small" id="new-hh-btn">+ Neuer Haushalt</button>
      </div>
      <div id="households"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Persönliche Kalender</span>
        <button class="btn btn-small" id="new-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="personal-cals"></div>
    </main>
  `;
  wireLogout();
  $('new-hh-btn').addEventListener('click', openNewHouseholdModal);
  $('new-cal-btn').addEventListener('click', () => openNewCalendarModal(null));

  renderHouseholdCards();
  renderPersonalCals(personalCals);
}

function renderHouseholdCards() {
  const el = $('households');
  if (!el) return;
  if (!households.length) {
    el.innerHTML = `
      <div class="empty" style="padding:1.5rem;">
        <p>Noch kein Haushalt. Leg einen an und lade andere ein — dann seht ihr alle Kalender im Haushalt automatisch gemeinsam.</p>
      </div>
    `;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${households.map(h => {
    const memberCount = Object.keys(h.members || {}).length;
    const calCount = calendars.filter(c => c.householdId === h.id).length;
    return `
      <div class="calendar-card" data-hh="${h.id}">
        <div class="cal-name">
          <span style="font-size:1.3em;">🏠</span>
          ${escapeHtml(h.name)}
        </div>
        <div class="cal-role">${memberCount} Mitglied${memberCount === 1 ? '' : 'er'} · ${calCount} Kalender</div>
      </div>
    `;
  }).join('')}</div>`;
  el.querySelectorAll('[data-hh]').forEach(card => {
    card.addEventListener('click', () => {
      const hh = households.find(h => h.id === card.dataset.hh);
      if (hh) openHousehold(hh);
    });
  });
}

function renderPersonalCals(cals) {
  const el = $('personal-cals');
  if (!el) return;
  if (!cals.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Keine persönlichen Kalender. Kalender innerhalb eines Haushalts findest du dort.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${cals.map(c => `
    <div class="calendar-card" data-cal="${c.id}">
      <div class="cal-name">
        <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
        ${escapeHtml(c.name)}
      </div>
      <div class="cal-role">${c.members?.[currentUser.uid] || '—'}</div>
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('[data-cal]').forEach(card => {
    card.addEventListener('click', () => {
      const cal = calendars.find(c => c.id === card.dataset.cal);
      if (cal) openCalendar(cal);
    });
  });
}

// ── Household-Detail ──────────────────────────────────────────
function openHousehold(hh) {
  view = 'household';
  currentHousehold = hh;
  renderHousehold();
}

function renderHousehold() {
  const hh = currentHousehold;
  const myRole = hh.members?.[currentUser.uid];
  const isOwner = myRole === 'owner';
  const hhCals = calendars.filter(c => c.householdId === hh.id);

  appEl.innerHTML = `
    ${topbarHtml(`
      <button class="logout-btn" id="back-btn">← Zurück</button>
      <span class="topbar-cal"><span style="font-size:1.2em;">🏠</span> ${escapeHtml(hh.name)}</span>
    `)}
    <main class="content">
      <div class="section-title">
        <span>Mitglieder</span>
        ${isOwner ? '<button class="btn btn-small" id="invite-btn">+ Einladen</button>' : ''}
      </div>
      <div id="members"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Kalender in diesem Haushalt</span>
        <button class="btn btn-small" id="new-hh-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="hh-cals"></div>

      ${isOwner ? `
        <div style="margin-top:3rem;text-align:right;">
          <button class="btn btn-danger btn-small" id="delete-hh-btn">Haushalt löschen</button>
        </div>
      ` : `
        <div style="margin-top:3rem;text-align:right;">
          <button class="btn btn-secondary btn-small" id="leave-hh-btn">Haushalt verlassen</button>
        </div>
      `}
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', goHome);
  if (isOwner) {
    $('invite-btn').addEventListener('click', () => openInviteModal(hh));
    $('delete-hh-btn').addEventListener('click', () => confirmDeleteHousehold(hh));
  } else {
    $('leave-hh-btn').addEventListener('click', () => confirmLeaveHousehold(hh));
  }
  $('new-hh-cal-btn').addEventListener('click', () => openNewCalendarModal(hh));

  renderMembers(hh, isOwner);
  renderHhCals(hhCals);
}

function renderMembers(hh, canEdit) {
  const el = $('members');
  const entries = Object.entries(hh.members || {});
  const emails = hh.memberEmails || {};
  el.innerHTML = `<div class="member-list">${entries.map(([uid, role]) => `
    <div class="member-row">
      <div>
        <div class="member-name">${escapeHtml(emails[uid] || uid)}</div>
        <div class="member-role">${role === 'owner' ? 'Owner' : 'Mitglied'}</div>
      </div>
      ${canEdit && uid !== currentUser.uid && role !== 'owner' ? `
        <button class="btn btn-secondary btn-small" data-remove-uid="${uid}">Entfernen</button>
      ` : ''}
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('[data-remove-uid]').forEach(btn => {
    btn.addEventListener('click', () => removeHouseholdMember(hh, btn.dataset.removeUid));
  });
}

async function removeHouseholdMember(hh, uid) {
  if (!confirm('Diese Person wirklich aus dem Haushalt entfernen?')) return;
  try {
    const newMembers = { ...hh.members };
    delete newMembers[uid];
    const newEmails = { ...(hh.memberEmails || {}) };
    delete newEmails[uid];
    await updateDoc(doc(db, 'households', hh.id), {
      members: newMembers,
      memberEmails: newEmails
    });
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

async function confirmLeaveHousehold(hh) {
  if (!confirm(`Haushalt „${hh.name}" wirklich verlassen? Du verlierst dann Zugriff auf alle Kalender darin.`)) return;
  try {
    const newMembers = { ...hh.members };
    delete newMembers[currentUser.uid];
    const newEmails = { ...(hh.memberEmails || {}) };
    delete newEmails[currentUser.uid];
    await updateDoc(doc(db, 'households', hh.id), { members: newMembers, memberEmails: newEmails });
    goHome();
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

async function confirmDeleteHousehold(hh) {
  const hhCals = calendars.filter(c => c.householdId === hh.id);
  const msg = hhCals.length
    ? `Haushalt „${hh.name}" wirklich löschen? ${hhCals.length} Kalender darin bleiben bestehen (werden zu persönlichen Kalendern des Owners).`
    : `Haushalt „${hh.name}" wirklich löschen?`;
  if (!confirm(msg)) return;
  try {
    // Kalender aus dem Haushalt lösen (householdId entfernen)
    for (const c of hhCals) {
      if (c.owner === currentUser.uid) {
        await updateDoc(doc(db, 'calendars', c.id), { householdId: deleteField() });
      }
    }
    await deleteDoc(doc(db, 'households', hh.id));
    goHome();
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

function renderHhCals(cals) {
  const el = $('hh-cals');
  if (!cals.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Noch kein Kalender in diesem Haushalt.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${cals.map(c => `
    <div class="calendar-card" data-cal="${c.id}">
      <div class="cal-name">
        <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
        ${escapeHtml(c.name)}
      </div>
      <div class="cal-role">Im Haushalt</div>
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('[data-cal]').forEach(card => {
    card.addEventListener('click', () => {
      const cal = calendars.find(c => c.id === card.dataset.cal);
      if (cal) openCalendar(cal);
    });
  });
}

// ── Neuer Haushalt ────────────────────────────────────────────
function openNewHouseholdModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Neuer Haushalt</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="hh-name" placeholder="z.B. Familie" required />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="create-btn">Erstellen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('hh-name').focus();
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('create-btn').addEventListener('click', async () => {
    const name = $('hh-name').value.trim();
    if (!name) return;
    const btn = $('create-btn');
    btn.disabled = true;
    try {
      await addDoc(collection(db, 'households'), {
        name,
        owner: currentUser.uid,
        members: { [currentUser.uid]: 'owner' },
        memberEmails: { [currentUser.uid]: currentUser.email },
        createdAt: serverTimestamp()
      });
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ── Einladen (E-Mail-Lookup) ──────────────────────────────────
function openInviteModal(hh) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Person einladen</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem;">
        Die Person muss sich vorher unter <b>kalenderkaiser.pages.dev</b> ein Konto erstellt haben.
      </p>
      <div id="modal-msg"></div>
      <div class="field">
        <label>E-Mail der Person</label>
        <input type="email" id="inv-email" placeholder="frau@example.de" required />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="invite-btn">Einladen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('inv-email').focus();
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('invite-btn').addEventListener('click', async () => {
    const email = $('inv-email').value.trim().toLowerCase();
    if (!email) return;
    const btn = $('invite-btn');
    btn.disabled = true;
    try {
      const q = query(collection(db, 'users'), where('email', '==', email));
      const snap = await getDocs(q);
      if (snap.empty) {
        throw new Error(`Kein Konto mit dieser E-Mail gefunden. Die Person muss sich zuerst registrieren.`);
      }
      const targetUid = snap.docs[0].id;
      if (hh.members?.[targetUid]) {
        throw new Error(`Diese Person ist bereits im Haushalt.`);
      }
      await updateDoc(doc(db, 'households', hh.id), {
        [`members.${targetUid}`]: 'member',
        [`memberEmails.${targetUid}`]: email
      });
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ── Neuer Kalender (mit optionalem Haushalt) ──────────────────
function openNewCalendarModal(preselectedHousehold) {
  let selectedColor = CALENDAR_COLORS[0];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hhOptions = households.map(h =>
    `<option value="${h.id}" ${preselectedHousehold?.id === h.id ? 'selected' : ''}>🏠 ${escapeHtml(h.name)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal">
      <h2>Neuer Kalender</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="cal-name" placeholder="z.B. Familie" required />
      </div>
      <div class="field">
        <label>Zuordnung</label>
        <select id="cal-hh">
          <option value="">Persönlich (nur ich)</option>
          ${hhOptions}
        </select>
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
    const hhId = $('cal-hh').value || null;
    const btn = $('create-btn');
    btn.disabled = true;
    try {
      const payload = {
        name,
        color: selectedColor,
        owner: currentUser.uid,
        members: { [currentUser.uid]: 'owner' },
        createdAt: serverTimestamp()
      };
      if (hhId) payload.householdId = hhId;
      await addDoc(collection(db, 'calendars'), payload);
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ── Kalender-Detail (FullCalendar) ────────────────────────────
function openCalendar(cal) {
  view = 'calendar';
  currentCalendar = cal;
  const hh = cal.householdId ? households.find(h => h.id === cal.householdId) : null;
  const canEdit = canEditCalendar(cal, hh);

  appEl.innerHTML = `
    ${topbarHtml(`
      <button class="logout-btn" id="back-btn">← Zurück</button>
      <span class="topbar-cal" id="cal-header">
        <span class="color-dot" style="background:${escapeHtml(cal.color)};"></span>
        ${escapeHtml(cal.name)}
        ${hh ? `<span class="cal-hh-badge">🏠 ${escapeHtml(hh.name)}</span>` : ''}
      </span>
    `)}
    <main class="content content-wide">
      <div id="fc-container"></div>
      ${cal.owner === currentUser.uid ? `
        <div style="margin-top:1rem;text-align:right;">
          <button class="btn btn-secondary btn-small" id="cal-settings-btn">Einstellungen</button>
        </div>
      ` : ''}
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', () => hh ? openHousehold(hh) : goHome());
  if (cal.owner === currentUser.uid) {
    $('cal-settings-btn').addEventListener('click', () => openCalendarSettingsModal(cal));
  }

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
    events: (_info, success) => success([])
  });
  fcInstance.render();

  unsubs.events = onSnapshot(collection(db, 'calendars', cal.id, 'events'), snap => {
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
        extendedProps: { _doc: { id: d.id, ...data } }
      });
    });
  }, err => console.error('events sub failed:', err));
}

function updateCalendarHeader(cal) {
  const el = $('cal-header');
  if (!el) return;
  const hh = cal.householdId ? households.find(h => h.id === cal.householdId) : null;
  el.innerHTML = `
    <span class="color-dot" style="background:${escapeHtml(cal.color)};"></span>
    ${escapeHtml(cal.name)}
    ${hh ? `<span class="cal-hh-badge">🏠 ${escapeHtml(hh.name)}</span>` : ''}
  `;
}

function canEditCalendar(cal, hh) {
  if (cal.householdId && hh?.members?.[currentUser.uid]) return true;
  const role = cal.members?.[currentUser.uid];
  return role === 'owner' || role === 'editor';
}

// ── Kalender-Einstellungen (Owner) ────────────────────────────
function openCalendarSettingsModal(cal) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hhOptions = households.map(h =>
    `<option value="${h.id}" ${cal.householdId === h.id ? 'selected' : ''}>🏠 ${escapeHtml(h.name)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal">
      <h2>Kalender-Einstellungen</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="cs-name" value="${escapeHtml(cal.name)}" />
      </div>
      <div class="field">
        <label>Zuordnung</label>
        <select id="cs-hh">
          <option value="">Persönlich (nur ich)</option>
          ${hhOptions}
        </select>
      </div>
      <div class="field">
        <label>Farbe</label>
        <div class="color-picker">
          ${CALENDAR_COLORS.map(c => `
            <div class="color-swatch ${cal.color === c ? 'selected' : ''}" data-color="${c}" style="background:${c};"></div>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn btn-danger" id="delete-btn">Löschen</button>
        <button class="btn" id="save-btn">Speichern</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  let selectedColor = cal.color;
  overlay.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      selectedColor = sw.dataset.color;
    });
  });
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('save-btn').addEventListener('click', async () => {
    const name = $('cs-name').value.trim();
    if (!name) return;
    const hhId = $('cs-hh').value || null;
    try {
      const payload = { name, color: selectedColor };
      if (hhId) payload.householdId = hhId;
      else payload.householdId = deleteField();
      await updateDoc(doc(db, 'calendars', cal.id), payload);
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
  });

  $('delete-btn').addEventListener('click', async () => {
    if (!confirm(`Kalender „${cal.name}" wirklich mit allen Terminen löschen?`)) return;
    try {
      await deleteDoc(doc(db, 'calendars', cal.id));
      overlay.remove();
      goHome();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ── Termin-Modal ──────────────────────────────────────────────
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
    const startDate = new Date(startEl.value);
    const endDate = new Date(endEl.value);
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
      const start = new Date($('ev-start').value);
      let end = new Date($('ev-end').value);
      if (isNaN(start)) { showEvMsg('Startzeit ungültig.'); return; }
      if (isNaN(end) || end < start) end = start;
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

function tsToDate(ts) {
  if (!ts) return null;
  if (ts instanceof Timestamp) return ts.toDate();
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

function toLocalInput(date, allDay) {
  if (!date || isNaN(date)) date = new Date();
  const pad = n => String(n).padStart(2, '0');
  const y = date.getFullYear(), m = pad(date.getMonth() + 1), d = pad(date.getDate());
  if (allDay) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
