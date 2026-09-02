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
  deleteField, increment
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
let households = [];
let calendars = [];
let lists = [];
const unsubs = {
  households: null,
  calendarsDirect: null,
  calendarsHousehold: null,
  listsDirect: null,
  listsHousehold: null,
  events: null,
  items: null
};
let fcInstance = null;

// aktuelle Ansicht: 'home' | 'household' | 'calendar' | 'list'
let view = 'home';
let currentHousehold = null;
let currentCalendar = null;
let currentList = null;

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
  lists = [];
  currentHousehold = null;
  currentCalendar = null;
  currentList = null;
}

// ── Firestore-Subscriptions ───────────────────────────────────
function startSubscriptions() {
  // Haushalte, in denen ich Mitglied bin
  unsubs.households = onSnapshot(
    query(collection(db, 'households'), where(`members.${currentUser.uid}`, 'in', ['owner', 'member'])),
    snap => {
      households = [];
      snap.forEach(d => households.push({ id: d.id, ...d.data() }));
      resubscribeHouseholdCalendars();
      renderCurrent();
    },
    err => console.error('households sub failed:', err)
  );

  // Kalender, in denen ich direkt Mitglied bin
  unsubs.calendarsDirect = onSnapshot(
    query(collection(db, 'calendars'), where(`members.${currentUser.uid}`, 'in', ['owner', 'editor', 'viewer'])),
    snap => {
      mergeCalendars(snap, 'direct');
      renderCurrent();
    },
    err => console.error('calendars direct sub failed:', err)
  );

  // Listen, in denen ich direkt Mitglied bin
  unsubs.listsDirect = onSnapshot(
    query(collection(db, 'lists'), where(`members.${currentUser.uid}`, '==', 'owner')),
    snap => {
      mergeLists(snap, 'direct');
      renderCurrent();
    },
    err => console.error('lists direct sub failed:', err)
  );
}

function resubscribeHouseholdCalendars() {
  if (unsubs.calendarsHousehold) { unsubs.calendarsHousehold(); unsubs.calendarsHousehold = null; }
  if (unsubs.listsHousehold) { unsubs.listsHousehold(); unsubs.listsHousehold = null; }
  const hhIds = households.map(h => h.id);
  if (hhIds.length === 0) {
    calendars = calendars.filter(c => c._source !== 'household');
    lists = lists.filter(l => l._source !== 'household');
    return;
  }
  unsubs.calendarsHousehold = onSnapshot(
    query(collection(db, 'calendars'), where('householdId', 'in', hhIds.slice(0, 30))),
    snap => { mergeCalendars(snap, 'household'); renderCurrent(); },
    err => console.error('calendars household sub failed:', err)
  );
  unsubs.listsHousehold = onSnapshot(
    query(collection(db, 'lists'), where('householdId', 'in', hhIds.slice(0, 30))),
    snap => { mergeLists(snap, 'household'); renderCurrent(); },
    err => console.error('lists household sub failed:', err)
  );
}

function mergeCalendars(snap, source) {
  calendars = calendars.filter(c => c._source !== source);
  snap.forEach(d => {
    if (calendars.find(c => c.id === d.id)) return;
    calendars.push({ id: d.id, _source: source, ...d.data() });
  });
}
function mergeLists(snap, source) {
  lists = lists.filter(l => l._source !== source);
  snap.forEach(d => {
    if (lists.find(l => l.id === d.id)) return;
    lists.push({ id: d.id, _source: source, ...d.data() });
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
    const fresh = households.find(h => h.id === currentHousehold?.id);
    if (!fresh) { goHome(); return; }
    currentHousehold = fresh;
    renderHousehold();
  } else if (view === 'calendar') {
    const fresh = calendars.find(c => c.id === currentCalendar?.id);
    if (!fresh) { goHome(); return; }
    updateCalendarHeader(fresh);
    currentCalendar = fresh;
  } else if (view === 'list') {
    const fresh = lists.find(l => l.id === currentList?.id);
    if (!fresh) { goHome(); return; }
    currentList = fresh;
    updateListHeader(fresh);
  }
}

function goHome() {
  view = 'home';
  currentHousehold = null;
  currentCalendar = null;
  currentList = null;
  if (unsubs.events) { unsubs.events(); unsubs.events = null; }
  if (unsubs.items) { unsubs.items(); unsubs.items = null; }
  if (fcInstance) { fcInstance.destroy(); fcInstance = null; }
  renderHome();
}

// ── Topbar ────────────────────────────────────────────────────
function topbarHtml(extra = '', showSearch = false) {
  return `
    <header class="topbar">
      <h1>📅 Kalender</h1>
      ${extra}
      <div class="topbar-spacer"></div>
      ${showSearch ? '<button class="logout-btn" id="search-btn" title="Termine suchen">🔍</button>' : ''}
      <span class="user-badge">${escapeHtml(currentUser.email)}</span>
      <button class="logout-btn" id="logout-btn">Abmelden</button>
    </header>
  `;
}
function wireLogout() {
  $('logout-btn').addEventListener('click', () => signOut(auth));
  const sb = $('search-btn');
  if (sb) sb.addEventListener('click', openSearchModal);
}

// ── Home: Haushalte + persönliche Kalender ────────────────────
const CALENDAR_COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#22c55e', '#0ea5e9'];

function renderHome() {
  const personalCals = calendars.filter(c => !c.householdId);
  const personalLists = lists.filter(l => !l.householdId);
  appEl.innerHTML = `
    ${topbarHtml('', true)}
    <main class="content">
      <div class="section-title">
        <span>Haushalte</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-small" id="join-hh-btn">🔗 Beitreten</button>
          <button class="btn btn-small" id="new-hh-btn">+ Neuer Haushalt</button>
        </div>
      </div>
      <div id="households"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Persönliche Kalender</span>
        <button class="btn btn-small" id="new-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="personal-cals"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Persönliche Listen</span>
        <button class="btn btn-small" id="new-list-btn">+ Neue Liste</button>
      </div>
      <div id="personal-lists"></div>
    </main>
  `;
  wireLogout();
  $('new-hh-btn').addEventListener('click', openNewHouseholdModal);
  $('join-hh-btn').addEventListener('click', openJoinHouseholdModal);
  $('new-cal-btn').addEventListener('click', () => openNewCalendarModal(null));
  $('new-list-btn').addEventListener('click', () => openNewListModal(null));

  renderHouseholdCards();
  renderPersonalCals(personalCals);
  renderListCards($('personal-lists'), personalLists, 'Noch keine persönliche Liste. Anlegen z.B. für eigene To-Dos.');
}

function renderHouseholdCards() {
  const el = $('households');
  if (!el) return;
  if (!households.length) {
    el.innerHTML = `
      <div class="empty" style="padding:1.5rem;">
        <p>Noch kein Haushalt. Leg einen an und lade andere ein — dann seht ihr alle Kalender und Listen im Haushalt automatisch gemeinsam.</p>
      </div>
    `;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${households.map(h => {
    const memberCount = Object.keys(h.members || {}).length;
    const calCount = calendars.filter(c => c.householdId === h.id).length;
    const listCount = lists.filter(l => l.householdId === h.id).length;
    return `
      <div class="calendar-card" data-hh="${h.id}">
        <div class="cal-name">
          <span style="font-size:1.3em;">🏠</span>
          ${escapeHtml(h.name)}
        </div>
        <div class="cal-role">${memberCount} Mitglied${memberCount === 1 ? '' : 'er'} · ${calCount} Kalender · ${listCount} Liste${listCount === 1 ? '' : 'n'}</div>
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

function renderListCards(el, ls, emptyText) {
  if (!el) return;
  if (!ls.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>${escapeHtml(emptyText)}</p></div>`;
    return;
  }
  el.innerHTML = `<div class="calendar-grid">${ls.map(l => {
    const open = l.openCount || 0;
    return `
    <div class="calendar-card" data-list="${l.id}">
      <div class="cal-name">
        <span style="font-size:1.3em;">${escapeHtml(l.icon || '📝')}</span>
        ${escapeHtml(l.name)}
        ${open > 0 ? `<span class="count-badge">${open}</span>` : ''}
      </div>
      <div class="cal-role">${open > 0 ? `${open} offen` : 'Liste'}</div>
    </div>
    `;
  }).join('')}</div>`;
  el.querySelectorAll('[data-list]').forEach(card => {
    card.addEventListener('click', () => {
      const l = lists.find(x => x.id === card.dataset.list);
      if (l) openList(l);
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
        ${isOwner ? '<button class="btn btn-small" id="invite-btn">🔗 Einladungscodes</button>' : ''}
      </div>
      <div id="members"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Kalender in diesem Haushalt</span>
        <button class="btn btn-small" id="new-hh-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="hh-cals"></div>

      <div class="section-title" style="margin-top:2rem;">
        <span>Listen in diesem Haushalt</span>
        <button class="btn btn-small" id="new-hh-list-btn">+ Neue Liste</button>
      </div>
      <div id="hh-lists"></div>

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
  $('new-hh-list-btn').addEventListener('click', () => openNewListModal(hh));

  renderMembers(hh, isOwner);
  renderHhCals(hhCals);
  renderListCards($('hh-lists'), lists.filter(l => l.householdId === hh.id), 'Noch keine Liste in diesem Haushalt.');
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

// ── Einladungscodes ───────────────────────────────────────────
const INVITE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I, O, 0, 1
function generateInviteCode(len = 8) {
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += INVITE_CODE_CHARS[arr[i] % INVITE_CODE_CHARS.length];
  return out;
}

async function openInviteModal(hh) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <h2>Einladungscodes für „${escapeHtml(hh.name)}"</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem;">
        Erstelle einen Code und schick ihn per Nachricht an die Person.
        Sie wählt in ihrer App „🔗 Beitreten" und gibt den Code ein.
      </p>
      <div id="modal-msg"></div>
      <div id="codes-list"><div class="empty" style="padding:1rem;"><p>Lade Codes …</p></div></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Schließen</button>
        <button class="btn" id="new-code-btn">+ Neuen Code erstellen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const listEl = $('codes-list');

  async function refreshCodes() {
    try {
      const snap = await getDocs(query(collection(db, 'invites'), where('householdId', '==', hh.id)));
      const codes = [];
      snap.forEach(d => codes.push({ id: d.id, ...d.data() }));
      if (!codes.length) {
        listEl.innerHTML = `<div class="empty" style="padding:1rem;"><p>Noch kein Code erstellt.</p></div>`;
        return;
      }
      listEl.innerHTML = `<div class="member-list">${codes.map(c => `
        <div class="member-row">
          <div>
            <div class="invite-code">${escapeHtml(c.id)}</div>
            <div class="member-role">Gültig bis widerrufen</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-secondary btn-small" data-copy="${escapeHtml(c.id)}">Kopieren</button>
            <button class="btn btn-danger btn-small" data-revoke="${escapeHtml(c.id)}">Widerrufen</button>
          </div>
        </div>
      `).join('')}</div>`;
      listEl.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.copy);
            btn.textContent = '✓ Kopiert';
            setTimeout(() => { btn.textContent = 'Kopieren'; }, 1500);
          } catch {
            prompt('Code manuell kopieren:', btn.dataset.copy);
          }
        });
      });
      listEl.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Code „${btn.dataset.revoke}" widerrufen?`)) return;
          try {
            await deleteDoc(doc(db, 'invites', btn.dataset.revoke));
            await refreshCodes();
          } catch (err) {
            alert('Fehler: ' + err.message);
          }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
  }

  $('new-code-btn').addEventListener('click', async () => {
    const btn = $('new-code-btn');
    btn.disabled = true;
    try {
      const code = generateInviteCode();
      await setDoc(doc(db, 'invites', code), {
        householdId: hh.id,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp()
      });
      await refreshCodes();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
    btn.disabled = false;
  });

  refreshCodes();
}

function openJoinHouseholdModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Haushalt beitreten</h2>
      <p style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem;">
        Gib den Einladungscode ein, den du bekommen hast.
      </p>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Einladungscode</label>
        <input type="text" id="join-code" placeholder="z.B. AB3XZK9M" style="text-transform:uppercase;font-family:monospace;letter-spacing:2px;" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="join-btn">Beitreten</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('join-code').focus();
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const submit = async () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (!code) return;
    const btn = $('join-btn');
    btn.disabled = true;
    try {
      const inviteRef = doc(db, 'invites', code);
      const inviteSnap = await getDocs(query(collection(db, 'invites'), where('__name__', '==', code)));
      if (inviteSnap.empty) throw new Error('Ungültiger oder abgelaufener Code.');
      const invite = inviteSnap.docs[0].data();
      const hhId = invite.householdId;

      // Prüfen ob wir schon Mitglied sind — dafür müsste household lesbar sein, was ohne Mitgliedschaft fehlschlägt.
      // Also: Update direkt versuchen. Rules verhindern doppeltes Beitreten.
      await updateDoc(doc(db, 'households', hhId), {
        [`members.${currentUser.uid}`]: 'member',
        [`memberEmails.${currentUser.uid}`]: currentUser.email,
        _lastJoinCode: code
      });
      overlay.remove();
    } catch (err) {
      const msg = err.code === 'permission-denied'
        ? 'Beitritt fehlgeschlagen — du bist evtl. schon Mitglied, oder der Code passt nicht.'
        : err.message;
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(msg)}</div>`;
      btn.disabled = false;
    }
  };
  $('join-btn').addEventListener('click', submit);
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
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
      left: 'prev,next today jumpTo',
      center: 'title',
      right: window.innerWidth < 700 ? 'dayGridMonth,listWeek' : 'dayGridMonth,timeGridWeek,listWeek'
    },
    buttonText: { today: 'Heute', month: 'Monat', week: 'Woche', list: 'Liste' },
    customButtons: {
      jumpTo: {
        text: '📅→',
        hint: 'Zu Datum springen',
        click: () => openJumpToModal(cal)
      }
    },
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
      const occurrences = expandRecurrence(data);
      occurrences.forEach((occ, idx) => {
        fcInstance.addEvent({
          id: `${d.id}__${idx}`,
          title: data.title,
          start: occ.start,
          end: occ.end,
          allDay: !!data.allDay,
          color: cal.color,
          extendedProps: { _doc: { id: d.id, ...data } }
        });
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

// ── Listen ────────────────────────────────────────────────────
const LIST_ICONS = ['🛒', '✅', '📝', '📋', '🍳', '🎁', '🧳', '🔧'];

function openNewListModal(preselectedHousehold) {
  let selectedIcon = LIST_ICONS[0];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hhOptions = households.map(h =>
    `<option value="${h.id}" ${preselectedHousehold?.id === h.id ? 'selected' : ''}>🏠 ${escapeHtml(h.name)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal">
      <h2>Neue Liste</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="list-name" placeholder="z.B. Einkauf" required />
      </div>
      <div class="field">
        <label>Zuordnung</label>
        <select id="list-hh">
          <option value="">Persönlich (nur ich)</option>
          ${hhOptions}
        </select>
      </div>
      <div class="field">
        <label>Symbol</label>
        <div class="icon-picker">
          ${LIST_ICONS.map((ic, i) => `
            <div class="icon-swatch ${i === 0 ? 'selected' : ''}" data-icon="${ic}">${ic}</div>
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
  $('list-name').focus();
  overlay.querySelectorAll('.icon-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.icon-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      selectedIcon = sw.dataset.icon;
    });
  });
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('create-btn').addEventListener('click', async () => {
    const name = $('list-name').value.trim();
    if (!name) return;
    const hhId = $('list-hh').value || null;
    const btn = $('create-btn');
    btn.disabled = true;
    try {
      const payload = {
        name,
        icon: selectedIcon,
        owner: currentUser.uid,
        members: { [currentUser.uid]: 'owner' },
        createdAt: serverTimestamp()
      };
      if (hhId) payload.householdId = hhId;
      await addDoc(collection(db, 'lists'), payload);
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

let listItems = [];

function openList(list) {
  view = 'list';
  currentList = list;
  listItems = [];
  if (unsubs.items) { unsubs.items(); unsubs.items = null; }

  const hh = list.householdId ? households.find(h => h.id === list.householdId) : null;

  appEl.innerHTML = `
    ${topbarHtml(`
      <button class="logout-btn" id="back-btn">← Zurück</button>
      <span class="topbar-cal" id="list-header">
        <span style="font-size:1.2em;">${escapeHtml(list.icon || '📝')}</span>
        ${escapeHtml(list.name)}
        ${hh ? `<span class="cal-hh-badge">🏠 ${escapeHtml(hh.name)}</span>` : ''}
      </span>
    `)}
    <main class="content">
      <form id="add-item-form" class="add-item-row">
        <input type="number" id="item-qty" min="1" max="99" value="1" title="Menge" />
        <input type="text" id="item-input" placeholder="Neuen Eintrag hinzufügen …" autocomplete="off" />
        <button type="submit" class="btn btn-small">+ Hinzufügen</button>
      </form>
      <div id="item-list"></div>
      ${list.owner === currentUser.uid ? `
        <div style="margin-top:1.5rem;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-small" id="clear-done-btn">Erledigte entfernen</button>
          <button class="btn btn-secondary btn-small" id="list-settings-btn">Einstellungen</button>
        </div>
      ` : `
        <div style="margin-top:1.5rem;">
          <button class="btn btn-secondary btn-small" id="clear-done-btn">Erledigte entfernen</button>
        </div>
      `}
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', () => hh ? openHousehold(hh) : goHome());
  $('add-item-form').addEventListener('submit', e => {
    e.preventDefault();
    addItem(list);
  });
  $('clear-done-btn').addEventListener('click', () => clearDoneItems(list));
  if (list.owner === currentUser.uid) {
    $('list-settings-btn').addEventListener('click', () => openListSettingsModal(list));
  }

  unsubs.items = onSnapshot(collection(db, 'lists', list.id, 'items'), snap => {
    listItems = [];
    snap.forEach(d => listItems.push({ id: d.id, ...d.data() }));
    renderItems(list);

    // Selbstheilung: openCount aus den geladenen Items neu berechnen
    const actual = listItems.filter(i => !i.done).length;
    const stored = currentList?.openCount || 0;
    if (currentList && stored !== actual) {
      updateDoc(doc(db, 'lists', list.id), { openCount: actual }).catch(() => {});
    }
  }, err => console.error('items sub failed:', err));
}

function updateListHeader(list) {
  const el = $('list-header');
  if (!el) return;
  const hh = list.householdId ? households.find(h => h.id === list.householdId) : null;
  el.innerHTML = `
    <span style="font-size:1.2em;">${escapeHtml(list.icon || '📝')}</span>
    ${escapeHtml(list.name)}
    ${hh ? `<span class="cal-hh-badge">🏠 ${escapeHtml(hh.name)}</span>` : ''}
  `;
}

function renderItems(list) {
  const el = $('item-list');
  if (!el) return;
  // Offene zuerst (nach Reihenfolge/Anlagedatum), erledigte unten
  const open = listItems.filter(i => !i.done).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = listItems.filter(i => i.done).sort((a, b) => (b.doneAt?.seconds ?? 0) - (a.doneAt?.seconds ?? 0));
  const emails = list.householdId
    ? (households.find(h => h.id === list.householdId)?.memberEmails || {})
    : {};

  if (!open.length && !done.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Noch keine Einträge.</p></div>`;
    return;
  }

  const itemHtml = i => `
    <div class="list-item ${i.done ? 'done' : ''}" data-id="${i.id}">
      <label class="item-check">
        <input type="checkbox" ${i.done ? 'checked' : ''} data-toggle="${i.id}" />
        <span class="item-text">${i.qty && i.qty > 1 ? `<b>${i.qty}×</b> ` : ''}${escapeHtml(i.text)}</span>
      </label>
      ${i.done && i.doneBy ? `<span class="item-meta">${escapeHtml(shortName(emails[i.doneBy] || i.doneBy))}</span>` : ''}
      <button class="item-del" data-del="${i.id}" title="Löschen">✕</button>
    </div>
  `;

  el.innerHTML = `
    <div class="list-items">${open.map(itemHtml).join('')}</div>
    ${done.length ? `
      <div class="list-section-label">Erledigt (${done.length})</div>
      <div class="list-items">${done.map(itemHtml).join('')}</div>
    ` : ''}
  `;

  el.querySelectorAll('[data-toggle]').forEach(cb => {
    cb.addEventListener('change', () => toggleItem(list, cb.dataset.toggle, cb.checked));
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteItem(list, btn.dataset.del));
  });
}

function shortName(s) {
  if (!s) return '';
  return s.length > 20 ? s.split('@')[0] : s;
}

async function addItem(list) {
  const input = $('item-input');
  const qtyInput = $('item-qty');
  const text = input.value.trim();
  if (!text) return;
  const qty = Math.max(1, Math.min(99, parseInt(qtyInput.value, 10) || 1));
  input.value = '';
  qtyInput.value = '1';
  input.focus();
  const maxOrder = listItems.reduce((m, i) => Math.max(m, i.order || 0), 0);
  try {
    await addDoc(collection(db, 'lists', list.id, 'items'), {
      text,
      qty,
      done: false,
      order: maxOrder + 1,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, 'lists', list.id), { openCount: increment(1) });
  } catch (err) {
    alert('Fehler: ' + err.message);
    input.value = text;
  }
}

async function toggleItem(list, itemId, done) {
  try {
    await updateDoc(doc(db, 'lists', list.id, 'items', itemId), {
      done,
      doneBy: done ? currentUser.uid : null,
      doneAt: done ? serverTimestamp() : null
    });
    await updateDoc(doc(db, 'lists', list.id), { openCount: increment(done ? -1 : 1) });
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

async function deleteItem(list, itemId) {
  const item = listItems.find(i => i.id === itemId);
  const wasOpen = item && !item.done;
  try {
    await deleteDoc(doc(db, 'lists', list.id, 'items', itemId));
    if (wasOpen) {
      await updateDoc(doc(db, 'lists', list.id), { openCount: increment(-1) });
    }
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

async function clearDoneItems(list) {
  const doneItems = listItems.filter(i => i.done);
  if (!doneItems.length) return;
  if (!confirm(`${doneItems.length} erledigte Einträge löschen?`)) return;
  try {
    await Promise.all(doneItems.map(i => deleteDoc(doc(db, 'lists', list.id, 'items', i.id))));
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

function openListSettingsModal(list) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hhOptions = households.map(h =>
    `<option value="${h.id}" ${list.householdId === h.id ? 'selected' : ''}>🏠 ${escapeHtml(h.name)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal">
      <h2>Listen-Einstellungen</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="ls-name" value="${escapeHtml(list.name)}" />
      </div>
      <div class="field">
        <label>Zuordnung</label>
        <select id="ls-hh">
          <option value="">Persönlich (nur ich)</option>
          ${hhOptions}
        </select>
      </div>
      <div class="field">
        <label>Symbol</label>
        <div class="icon-picker">
          ${LIST_ICONS.map(ic => `
            <div class="icon-swatch ${list.icon === ic ? 'selected' : ''}" data-icon="${ic}">${ic}</div>
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
  let selectedIcon = list.icon || LIST_ICONS[0];
  overlay.querySelectorAll('.icon-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      overlay.querySelectorAll('.icon-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      selectedIcon = sw.dataset.icon;
    });
  });
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('save-btn').addEventListener('click', async () => {
    const name = $('ls-name').value.trim();
    if (!name) return;
    const hhId = $('ls-hh').value || null;
    try {
      const payload = { name, icon: selectedIcon };
      if (hhId) payload.householdId = hhId;
      else payload.householdId = deleteField();
      await updateDoc(doc(db, 'lists', list.id), payload);
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
  });

  $('delete-btn').addEventListener('click', async () => {
    if (!confirm(`Liste „${list.name}" wirklich mit allen Einträgen löschen?`)) return;
    try {
      // Items zuerst löschen (Firestore kaskadiert nicht automatisch)
      const itemsSnap = await getDocs(collection(db, 'lists', list.id, 'items'));
      await Promise.all(itemsSnap.docs.map(d => deleteDoc(d.ref)));
      await deleteDoc(doc(db, 'lists', list.id));
      overlay.remove();
      goHome();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// ── „Zu Datum springen"-Modal ─────────────────────────────────
function openJumpToModal() {
  const today = new Date();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Zu Datum springen</h2>
      <div class="field">
        <label>Datum</label>
        <input type="date" id="jump-date" value="${toLocalInput(today, true)}" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="go-btn">Springen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('jump-date').focus();
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const go = () => {
    const val = $('jump-date').value;
    if (val && fcInstance) fcInstance.gotoDate(val);
    overlay.remove();
  };
  $('go-btn').addEventListener('click', go);
  $('jump-date').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ── Globale Termin-Suche ──────────────────────────────────────
async function openSearchModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal modal-wide">
      <h2>Termine suchen</h2>
      <div class="field">
        <input type="text" id="search-input" placeholder="Titel oder Notiz suchen …" autocomplete="off" autofocus />
      </div>
      <div id="search-results" class="search-results">
        <div class="empty" style="padding:1rem;"><p>Lade Termine …</p></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Schließen</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  // Alle Events aller sichtbaren Kalender einmal laden
  const allEvents = [];
  try {
    await Promise.all(calendars.map(async c => {
      const snap = await getDocs(collection(db, 'calendars', c.id, 'events'));
      snap.forEach(d => {
        const data = d.data();
        allEvents.push({
          id: d.id, calendar: c,
          title: data.title || '', note: data.note || '',
          start: tsToDate(data.start),
          allDay: !!data.allDay,
          recurrence: data.recurrence || 'none',
          raw: { id: d.id, ...data }
        });
      });
    }));
  } catch (err) {
    $('search-results').innerHTML = `<div class="msg msg-error">Fehler: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const input = $('search-input');
  const results = $('search-results');

  const doSearch = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      results.innerHTML = `<div class="empty" style="padding:1rem;"><p>${allEvents.length} Termine geladen. Suchbegriff eingeben.</p></div>`;
      return;
    }
    const matches = allEvents.filter(e =>
      e.title.toLowerCase().includes(q) || e.note.toLowerCase().includes(q)
    );
    if (!matches.length) {
      results.innerHTML = `<div class="empty" style="padding:1rem;"><p>Keine Treffer für „${escapeHtml(q)}".</p></div>`;
      return;
    }
    matches.sort((a, b) => (a.start?.getTime() || 0) - (b.start?.getTime() || 0));
    results.innerHTML = matches.map((e, i) => `
      <div class="search-hit" data-idx="${i}">
        <div class="search-hit-title">
          <span class="color-dot" style="background:${escapeHtml(e.calendar.color)};"></span>
          ${escapeHtml(e.title)}
          ${e.recurrence !== 'none' ? '<span class="cal-hh-badge">wiederkehrend</span>' : ''}
        </div>
        <div class="search-hit-meta">
          ${e.start ? formatDate(e.start, e.allDay) : ''} · ${escapeHtml(e.calendar.name)}
        </div>
      </div>
    `).join('');
    results.querySelectorAll('.search-hit').forEach(row => {
      row.addEventListener('click', () => {
        const hit = matches[parseInt(row.dataset.idx, 10)];
        overlay.remove();
        openCalendar(hit.calendar);
        // FC braucht kurzen Moment bis fertig, dann gotoDate
        setTimeout(() => { if (fcInstance && hit.start) fcInstance.gotoDate(hit.start); }, 60);
      });
    });
  };
  input.addEventListener('input', doSearch);
  doSearch();
}

function formatDate(d, allDay) {
  const opts = allDay
    ? { day: '2-digit', month: '2-digit', year: 'numeric' }
    : { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('de-DE', opts) + (allDay ? '' : ' Uhr');
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
        <label>Wiederholung</label>
        <select id="ev-recurrence" ${canEdit ? '' : 'disabled'}>
          <option value="none">Keine</option>
          <option value="daily">Täglich</option>
          <option value="weekly">Wöchentlich</option>
          <option value="monthly">Monatlich</option>
          <option value="yearly">Jährlich (z.B. Geburtstag)</option>
        </select>
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
  $('ev-recurrence').value = existing?.recurrence || 'none';

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
          recurrence: $('ev-recurrence').value || 'none',
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

// Wiederkehrende Termine expandieren:
// Aus einem Firestore-Event mit recurrence-Feld werden alle sichtbaren
// Vorkommen für die nächsten ~5 Jahre erzeugt (bzw. 100 Wochen bei weekly).
function expandRecurrence(data) {
  const start = tsToDate(data.start);
  const end = tsToDate(data.end) || start;
  if (!start) return [];
  const duration = end.getTime() - start.getTime();
  const rec = data.recurrence || 'none';
  if (rec === 'none') return [{ start, end }];

  const now = new Date();
  const horizonYearsBack = 1;   // ein Jahr rückwärts sichtbar
  const horizonYearsFwd = 5;    // fünf Jahre in die Zukunft
  const limitPast = new Date(now.getFullYear() - horizonYearsBack, 0, 1);
  const limitFuture = new Date(now.getFullYear() + horizonYearsFwd, 11, 31);

  const out = [];
  const push = d => {
    out.push({ start: new Date(d), end: new Date(d.getTime() + duration) });
  };

  // Rückwärts nur bis limitPast, vorwärts bis limitFuture. Absoluter Cap 500.
  const cap = 500;
  const step = new Date(start);
  // Erst mal vorwärts vom Startdatum
  while (step <= limitFuture && out.length < cap) {
    if (step >= limitPast) push(step);
    advance(step, rec);
  }
  // Rückwärts (nur wenn Start in Zukunft liegt)
  const stepBack = new Date(start);
  retreat(stepBack, rec);
  while (stepBack >= limitPast && out.length < cap) {
    push(stepBack);
    retreat(stepBack, rec);
  }
  return out;
}

function advance(d, rec) {
  if (rec === 'daily') d.setDate(d.getDate() + 1);
  else if (rec === 'weekly') d.setDate(d.getDate() + 7);
  else if (rec === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (rec === 'yearly') d.setFullYear(d.getFullYear() + 1);
}
function retreat(d, rec) {
  if (rec === 'daily') d.setDate(d.getDate() - 1);
  else if (rec === 'weekly') d.setDate(d.getDate() - 7);
  else if (rec === 'monthly') d.setMonth(d.getMonth() - 1);
  else if (rec === 'yearly') d.setFullYear(d.getFullYear() - 1);
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
