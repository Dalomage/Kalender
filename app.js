// Familien-Kalender — App-Logik
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore, collection, query, where, onSnapshot, getDocs, getDoc,
  addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, Timestamp,
  deleteField, increment, writeBatch
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
let notes = [];
const unsubs = {
  households: null,
  calendarsDirect: null,
  calendarsHousehold: null,
  listsDirect: null,
  listsHousehold: null,
  notesDirect: null,
  notesHousehold: null,
  events: null,
  items: null
};
let fcInstance = null;

// aktuelle Ansicht: 'home' | 'household' | 'calendar' | 'list'
let view = 'home';
let homeTab = 'dashboard'; // 'dashboard' | 'calendars' | 'lists' | 'notes'
let householdTab = 'dashboard'; // 'dashboard' | 'calendars' | 'lists' | 'notes' | 'members'
let currentHousehold = null;
let currentCalendar = null;
let currentList = null;

// Timer-IDs für lokale Erinnerungen — beim Logout löschen
const reminderTimers = new Set();

// Nutzerprofil-Cache: uid -> { name, email }
const userCache = new Map();
let myProfile = null;

// ── Auth-State ────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  loadingEl.classList.add('hidden');
  currentUser = user;
  if (user) {
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');
    await loadMyProfile();
    startSubscriptions();
    goHome();
    scheduleAllReminders();
    setInterval(scheduleAllReminders, 15 * 60 * 1000);
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
  reminderTimers.forEach(id => clearTimeout(id));
  reminderTimers.clear();
  userCache.clear();
  myProfile = null;
  households = [];
  calendars = [];
  lists = [];
  notes = [];
  currentHousehold = null;
  currentCalendar = null;
  currentList = null;
}

// ── Nutzerprofile ─────────────────────────────────────────────
async function loadMyProfile() {
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    const data = snap.exists() ? snap.data() : {};
    myProfile = {
      name: data.name || currentUser.email.split('@')[0],
      email: currentUser.email
    };
  } catch {
    myProfile = { name: currentUser.email.split('@')[0], email: currentUser.email };
  }
  userCache.set(currentUser.uid, myProfile);
}

async function ensureUserLoaded(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  // Platzhalter setzen, damit parallele Aufrufe nicht mehrfach fetchen
  userCache.set(uid, { name: uid.slice(0, 6), email: '' });
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const data = snap.exists() ? snap.data() : {};
    const profile = {
      name: data.name || (data.email ? data.email.split('@')[0] : uid.slice(0, 6)),
      email: data.email || ''
    };
    userCache.set(uid, profile);
    return profile;
  } catch {
    return userCache.get(uid);
  }
}

function nameFor(uid) {
  if (!uid) return '';
  if (uid === currentUser?.uid) return myProfile?.name || currentUser.email.split('@')[0];
  return userCache.get(uid)?.name || uid.slice(0, 6);
}

// Lädt Namen zu allen uids, ruft danach den Callback für Re-Rendering auf.
async function ensureNamesFor(uids, rerender) {
  const missing = uids.filter(u => u && !userCache.has(u));
  if (!missing.length) return;
  await Promise.all(missing.map(ensureUserLoaded));
  if (rerender) rerender();
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

  // Notizen, in denen ich direkt Mitglied bin
  unsubs.notesDirect = onSnapshot(
    query(collection(db, 'notes'), where(`members.${currentUser.uid}`, '==', 'owner')),
    snap => {
      mergeNotes(snap, 'direct');
      renderCurrent();
    },
    err => console.error('notes direct sub failed:', err)
  );
}

function resubscribeHouseholdCalendars() {
  if (unsubs.calendarsHousehold) { unsubs.calendarsHousehold(); unsubs.calendarsHousehold = null; }
  if (unsubs.listsHousehold) { unsubs.listsHousehold(); unsubs.listsHousehold = null; }
  if (unsubs.notesHousehold) { unsubs.notesHousehold(); unsubs.notesHousehold = null; }
  const hhIds = households.map(h => h.id);
  if (hhIds.length === 0) {
    calendars = calendars.filter(c => c._source !== 'household');
    lists = lists.filter(l => l._source !== 'household');
    notes = notes.filter(n => n._source !== 'household');
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
  unsubs.notesHousehold = onSnapshot(
    query(collection(db, 'notes'), where('householdId', 'in', hhIds.slice(0, 30))),
    snap => { mergeNotes(snap, 'household'); renderCurrent(); },
    err => console.error('notes household sub failed:', err)
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
function mergeNotes(snap, source) {
  notes = notes.filter(n => n._source !== source);
  snap.forEach(d => {
    if (notes.find(n => n.id === d.id)) return;
    notes.push({ id: d.id, _source: source, ...d.data() });
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
  if (view === 'home') {
    // Home-Layout nicht komplett neu bauen wenn schon da — sonst
    // rennen bei jedem Snapshot mehrere Dashboard-Fetches parallel
    // und der User sieht ein Ladeflackern
    if (document.querySelector('.home-tabs')) {
      renderHouseholdCards();
      renderHomeTab();
    } else {
      renderHome();
    }
  }
  else if (view === 'household') {
    const fresh = households.find(h => h.id === currentHousehold?.id);
    if (!fresh) { goHome(); return; }
    currentHousehold = fresh;
    // Wenn Tab-Bar schon aufgebaut ist, nur den Tab-Inhalt neu rendern —
    // sonst rennen mehrere Dashboard-Fetches parallel und überschreiben sich
    if (document.querySelector('[data-hhtab]')) {
      const myRole = fresh.members?.[currentUser.uid];
      const isOwner = myRole === 'owner';
      renderHouseholdTab(fresh, isOwner);
    } else {
      renderHousehold();
    }
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
      <button class="user-badge user-badge-btn" id="profile-btn" title="Profil">${escapeHtml(myProfile?.name || currentUser.email)}</button>
      <button class="logout-btn" id="logout-btn">Abmelden</button>
    </header>
  `;
}
function wireLogout() {
  $('logout-btn').addEventListener('click', () => signOut(auth));
  const sb = $('search-btn');
  if (sb) sb.addEventListener('click', openSearchModal);
  const pb = $('profile-btn');
  if (pb) pb.addEventListener('click', openProfileModal);
}

// ── Profil-Modal ──────────────────────────────────────────────
function openProfileModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Dein Profil</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Anzeigename</label>
        <input type="text" id="pf-name" value="${escapeHtml(myProfile?.name || '')}" maxlength="40" />
      </div>
      <div class="field">
        <label>E-Mail (kann nicht geändert werden)</label>
        <input type="text" value="${escapeHtml(currentUser.email)}" disabled />
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        <button class="btn" id="save-btn">Speichern</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('pf-name').focus();
  $('cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  $('save-btn').addEventListener('click', async () => {
    const name = $('pf-name').value.trim();
    if (!name) { $('modal-msg').innerHTML = `<div class="msg msg-error">Name darf nicht leer sein.</div>`; return; }
    const btn = $('save-btn');
    btn.disabled = true;
    try {
      await setDoc(doc(db, 'users', currentUser.uid), {
        name, email: currentUser.email, updatedAt: serverTimestamp()
      }, { merge: true });
      myProfile.name = name;
      userCache.set(currentUser.uid, myProfile);
      overlay.remove();
      renderCurrent();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ── Home: Haushalte + persönliche Kalender ────────────────────
const CALENDAR_COLORS = ['#14b8a6', '#3b82f6', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#22c55e', '#0ea5e9'];

const EVENT_CATEGORIES = [
  { id: 'none',    label: 'Keine',      icon: '' },
  { id: 'work',    label: 'Arbeit',     icon: '💼' },
  { id: 'family',  label: 'Familie',    icon: '👨‍👩‍👧' },
  { id: 'sport',   label: 'Sport',      icon: '⚽' },
  { id: 'medical', label: 'Arzt',       icon: '🚑' },
  { id: 'leisure', label: 'Freizeit',   icon: '🎉' },
  { id: 'travel',  label: 'Reise',      icon: '🧳' },
  { id: 'food',    label: 'Essen',      icon: '🍽️' },
  { id: 'birthday',label: 'Geburtstag', icon: '🎂' },
  { id: 'other',   label: 'Sonstiges',  icon: '📌' }
];
function categoryIcon(id) {
  return EVENT_CATEGORIES.find(c => c.id === id)?.icon || '';
}

function renderHome() {
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

      <div class="home-tabs">
        <button data-tab="dashboard" class="${homeTab === 'dashboard' ? 'active' : ''}">📊 Dashboard</button>
        <button data-tab="calendars" class="${homeTab === 'calendars' ? 'active' : ''}">📅 Kalender</button>
        <button data-tab="lists" class="${homeTab === 'lists' ? 'active' : ''}">📝 Listen</button>
        <button data-tab="notes" class="${homeTab === 'notes' ? 'active' : ''}">📌 Notizen</button>
      </div>

      <div id="home-tab-content"></div>
    </main>
  `;
  wireLogout();
  $('new-hh-btn').addEventListener('click', openNewHouseholdModal);
  $('join-hh-btn').addEventListener('click', openJoinHouseholdModal);

  appEl.querySelectorAll('.home-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      homeTab = btn.dataset.tab;
      renderHome();
    });
  });

  renderHouseholdCards();
  renderHomeTab();
}

function renderHomeTab() {
  const content = $('home-tab-content');
  if (!content) return;
  if (homeTab === 'dashboard') renderDashboard(content);
  else if (homeTab === 'calendars') renderCalendarsTab(content);
  else if (homeTab === 'lists') renderListsTab(content);
  else if (homeTab === 'notes') renderNotesTab(content);
}

function renderNotesTab(content) {
  const personalNotes = notes.filter(n => !n.householdId);
  content.innerHTML = `
    <div class="section-title">
      <span>Persönliche Notizen</span>
      <button class="btn btn-small" id="new-note-btn">+ Neue Notiz</button>
    </div>
    <div id="personal-notes"></div>
  `;
  $('new-note-btn').addEventListener('click', () => openNoteModal(null, null));
  renderNoteCards($('personal-notes'), personalNotes, 'Noch keine persönliche Notiz.');
}

function renderCalendarsTab(content) {
  const personalCals = calendars.filter(c => !c.householdId);
  content.innerHTML = `
    <div class="section-title">
      <span>Persönliche Kalender</span>
      <button class="btn btn-small" id="new-cal-btn">+ Neuer Kalender</button>
    </div>
    <div id="personal-cals"></div>
  `;
  $('new-cal-btn').addEventListener('click', () => openNewCalendarModal(null));
  renderPersonalCals(personalCals);
}

function renderListsTab(content) {
  const personalLists = lists.filter(l => !l.householdId);
  content.innerHTML = `
    <div class="section-title">
      <span>Persönliche Listen</span>
      <button class="btn btn-small" id="new-list-btn">+ Neue Liste</button>
    </div>
    <div id="personal-lists"></div>
  `;
  $('new-list-btn').addEventListener('click', () => openNewListModal(null));
  renderListCards($('personal-lists'), personalLists, 'Noch keine persönliche Liste. Anlegen z.B. für eigene To-Dos.');
}

// ── Dashboard (allgemein, gefiltert nach Scope) ───────────────
// scope: null = nur persönlich (Home), oder ein Haushalt-Objekt = nur dessen Content
let dashboardClockTimer = null;
let dashboardRenderToken = 0;
function updateDashboardClock() {
  const el = document.getElementById('dash-clock-time');
  const dateEl = document.getElementById('dash-clock-date');
  if (!el || !dateEl) {
    if (dashboardClockTimer) { clearInterval(dashboardClockTimer); dashboardClockTimer = null; }
    return;
  }
  const now = new Date();
  el.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  dateEl.textContent = now.toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

async function renderDashboard(content, scope = null) {
  const myToken = ++dashboardRenderToken;
  const scopeFilter = scope
    ? (item) => item.householdId === scope.id
    : (item) => !item.householdId;

  const scopeLists = lists.filter(scopeFilter);
  const scopeCals = calendars.filter(scopeFilter);
  const scopeNotes = notes.filter(scopeFilter);
  const openLists = scopeLists.filter(l => (l.openCount || 0) > 0)
    .sort((a, b) => (b.openCount || 0) - (a.openCount || 0));
  const favNotes = scopeNotes.filter(n => n.favorite);

  // Grundgerüst nur einmalig aufbauen; bei erneuten Aufrufen nur befüllen.
  // Verhindert, dass parallele Snapshots das "Lade …"-Placeholder wieder
  // dazwischen schieben.
  const alreadyBuilt = content.querySelector('.dash-clock') !== null;
  if (!alreadyBuilt) {
    const emptyHint = !scope
      ? `<div id="dash-empty-hint" class="empty" style="display:none;padding:1.5rem;text-align:center;"><p style="margin-bottom:0.5rem;">Du hast noch keine <b>persönlichen</b> Kalender, Listen oder Notizen.</p><p style="color:var(--muted);font-size:0.85rem;">Alle Inhalte deiner Haushalte findest du oben unter „Haushalte".</p></div>`
      : '';
    content.innerHTML = `
      <div class="dash-clock">
        <div class="dash-clock-time" id="dash-clock-time">--:--</div>
        <div class="dash-clock-date" id="dash-clock-date">…</div>
      </div>

      ${emptyHint}

      <div id="dash-fav-notes-section" style="display:none;margin-top:1.5rem;">
        <div class="section-title"><span>⭐ Favoriten</span></div>
        <div id="dash-fav-notes"></div>
      </div>

      <div class="dash-grid">
        <section class="dash-col dash-col-events">
          <div class="section-title"><span>Kommende Termine (7 Tage)</span></div>
          <div id="dash-events"></div>
        </section>
        <section class="dash-col dash-col-lists">
          <div class="section-title"><span>Offene Listen</span></div>
          <div id="dash-lists"></div>
        </section>
      </div>
    `;
    updateDashboardClock();
    if (dashboardClockTimer) clearInterval(dashboardClockTimer);
    dashboardClockTimer = setInterval(updateDashboardClock, 30_000);
  }

  // Empty-Hinweis (nur Home-Dashboard) an/aus
  const hint = $('dash-empty-hint');
  if (hint) {
    const isEmpty = !scopeCals.length && !scopeLists.length && !scopeNotes.length;
    hint.style.display = isEmpty ? '' : 'none';
  }

  // Favoriten-Sektion an/aus schalten
  const favSection = $('dash-fav-notes-section');
  if (favSection) favSection.style.display = favNotes.length ? '' : 'none';

  if (favNotes.length) {
    renderNoteCards($('dash-fav-notes'), favNotes, '');
  }

  // Offene Listen sofort
  const lel = $('dash-lists');
  if (!openLists.length) {
    lel.innerHTML = `<div class="empty" style="padding:1rem;"><p>Alle Listen sind abgehakt.</p></div>`;
  } else {
    lel.innerHTML = `<div class="calendar-grid">${openLists.map(l => `
      <div class="calendar-card" data-list="${l.id}">
        <div class="cal-name">
          <span style="font-size:1.3em;">${escapeHtml(l.icon || '📝')}</span>
          ${escapeHtml(l.name)}
          <span class="count-badge">${l.openCount}</span>
        </div>
        <div class="cal-role">${l.householdId ? '🏠 ' + escapeHtml(households.find(h => h.id === l.householdId)?.name || '') : 'Persönlich'}</div>
      </div>
    `).join('')}</div>`;
    lel.querySelectorAll('[data-list]').forEach(card => {
      card.addEventListener('click', () => {
        const l = lists.find(x => x.id === card.dataset.list);
        if (l) openList(l);
      });
    });
  }

  // Kommende Termine — Kalender im Scope
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const all = [];
  try {
    await Promise.all(scopeCals.map(async c => {
      const snap = await getDocs(collection(db, 'calendars', c.id, 'events'));
      snap.forEach(d => {
        const data = d.data();
        expandRecurrence(data).forEach(occ => {
          if (occ.start >= now && occ.start <= in7Days) {
            all.push({ id: d.id, calendar: c, title: data.title || '', allDay: !!data.allDay, start: occ.start, note: data.note, location: data.location, assignee: data.assignee, raw: data });
          }
        });
      });
    }));
  } catch (err) {
    if (myToken !== dashboardRenderToken) return;
    const evEl = $('dash-events');
    if (evEl) evEl.innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
    return;
  }
  // Wenn zwischenzeitlich ein neuerer Render gestartet wurde: dessen Fetch übernimmt.
  if (myToken !== dashboardRenderToken) return;
  const evEl = $('dash-events');
  if (!evEl) return;
  all.sort((a, b) => a.start - b.start);
  if (!all.length) {
    evEl.innerHTML = `<div class="empty" style="padding:1rem;"><p>Keine Termine in den nächsten 7 Tagen.</p></div>`;
    return;
  }
  ensureNamesFor(all.map(e => e.assignee).filter(Boolean), () => renderDashboard(content, scope));
  evEl.innerHTML = `<div class="event-list">${all.slice(0, 30).map(e => {
    const assigneeName = e.assignee ? nameFor(e.assignee) : '';
    return `
    <div class="event-row" data-cal="${e.calendar.id}" data-date="${e.start.toISOString()}">
      <div class="event-date">
        <div class="event-day">${e.start.getDate()}</div>
        <div class="event-month">${e.start.toLocaleDateString('de-DE', { month: 'short' })}</div>
      </div>
      <div class="event-body">
        <div class="event-title">
          <span class="color-dot" style="background:${escapeHtml(e.calendar.color)};"></span>
          ${e.raw?.category ? categoryIcon(e.raw.category) + ' ' : ''}${escapeHtml(e.title)}
        </div>
        <div class="event-meta">
          ${e.allDay ? 'Ganztägig' : e.start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'}
          · ${escapeHtml(e.calendar.name)}
          ${e.location ? ' · 📍 ' + escapeHtml(e.location) : ''}
          ${assigneeName ? ' · 👤 ' + escapeHtml(assigneeName) : ''}
        </div>
      </div>
    </div>
    `;
  }).join('')}</div>`;
  evEl.querySelectorAll('.event-row').forEach(row => {
    row.addEventListener('click', () => {
      const c = calendars.find(x => x.id === row.dataset.cal);
      if (!c) return;
      openCalendar(c);
      const target = new Date(row.dataset.date);
      setTimeout(() => { if (fcInstance) fcInstance.gotoDate(target); }, 60);
    });
  });
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

let sortableLists = null;
function renderListCards(el, ls, emptyText) {
  if (!el) return;
  if (sortableLists) { try { sortableLists.destroy(); } catch {} sortableLists = null; }
  if (!ls.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>${escapeHtml(emptyText)}</p></div>`;
    return;
  }
  // Nach user-definierter Reihenfolge sortieren (Fallback: älteste zuerst)
  const sorted = [...ls].sort((a, b) => {
    const ao = a.order ?? 999999;
    const bo = b.order ?? 999999;
    if (ao !== bo) return ao - bo;
    return (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0);
  });
  el.innerHTML = `<div class="calendar-grid sortable-list-grid">${sorted.map(l => {
    const open = l.openCount || 0;
    return `
    <div class="calendar-card" data-list="${l.id}">
      <span class="card-drag-handle" title="Ziehen zum Sortieren">⋮⋮</span>
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
    card.addEventListener('click', e => {
      if (e.target.closest('.card-drag-handle')) return;
      const l = lists.find(x => x.id === card.dataset.list);
      if (l) openList(l);
    });
  });

  const grid = el.querySelector('.sortable-list-grid');
  if (grid && typeof Sortable !== 'undefined') {
    sortableLists = Sortable.create(grid, {
      handle: '.card-drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      onEnd: async () => {
        const ids = Array.from(grid.querySelectorAll('[data-list]')).map(el => el.dataset.list);
        try {
          const batch = writeBatch(db);
          ids.forEach((id, idx) => {
            batch.update(doc(db, 'lists', id), { order: idx + 1 });
          });
          await batch.commit();
        } catch (err) {
          console.error('list reorder failed:', err);
        }
      }
    });
  }
}

let sortableCals = null;
function renderPersonalCals(cals) {
  const el = $('personal-cals');
  if (!el) return;
  if (sortableCals) { try { sortableCals.destroy(); } catch {} sortableCals = null; }
  if (!cals.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Keine persönlichen Kalender. Kalender innerhalb eines Haushalts findest du dort.</p></div>`;
    return;
  }
  const sorted = [...cals].sort((a, b) => {
    const ao = a.order ?? 999999;
    const bo = b.order ?? 999999;
    if (ao !== bo) return ao - bo;
    return (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0);
  });
  el.innerHTML = `<div class="calendar-grid sortable-cal-grid">${sorted.map(c => `
    <div class="calendar-card" data-cal="${c.id}">
      <span class="card-drag-handle" title="Ziehen zum Sortieren">⋮⋮</span>
      <div class="cal-name">
        <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
        ${escapeHtml(c.name)}
      </div>
      <div class="cal-role">${c.members?.[currentUser.uid] || '—'}</div>
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('[data-cal]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.card-drag-handle')) return;
      const cal = calendars.find(c => c.id === card.dataset.cal);
      if (cal) openCalendar(cal);
    });
  });
  wireCalendarSortable(el.querySelector('.sortable-cal-grid'), s => sortableCals = s);
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

  appEl.innerHTML = `
    ${topbarHtml(`
      <button class="logout-btn" id="back-btn">← Zurück</button>
      <span class="topbar-cal"><span style="font-size:1.2em;">🏠</span> ${escapeHtml(hh.name)}</span>
    `)}
    <main class="content">
      <div class="home-tabs">
        <button data-hhtab="dashboard" class="${householdTab === 'dashboard' ? 'active' : ''}">📊 Dashboard</button>
        <button data-hhtab="calendars" class="${householdTab === 'calendars' ? 'active' : ''}">📅 Kalender</button>
        <button data-hhtab="lists" class="${householdTab === 'lists' ? 'active' : ''}">📝 Listen</button>
        <button data-hhtab="notes" class="${householdTab === 'notes' ? 'active' : ''}">📌 Notizen</button>
        <button data-hhtab="members" class="${householdTab === 'members' ? 'active' : ''}">👥 Mitglieder</button>
      </div>
      <div id="hh-tab-content"></div>
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', goHome);
  appEl.querySelectorAll('[data-hhtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      householdTab = btn.dataset.hhtab;
      renderHousehold();
    });
  });
  renderHouseholdTab(hh, isOwner);
}

function renderHouseholdTab(hh, isOwner) {
  const content = $('hh-tab-content');
  if (!content) return;
  if (householdTab === 'dashboard') {
    renderDashboard(content, hh);
  } else if (householdTab === 'calendars') {
    content.innerHTML = `
      <div class="section-title">
        <span>Kalender in diesem Haushalt</span>
        <button class="btn btn-small" id="new-hh-cal-btn">+ Neuer Kalender</button>
      </div>
      <div id="hh-cals"></div>
    `;
    $('new-hh-cal-btn').addEventListener('click', () => openNewCalendarModal(hh));
    renderHhCals(calendars.filter(c => c.householdId === hh.id));
  } else if (householdTab === 'lists') {
    content.innerHTML = `
      <div class="section-title">
        <span>Listen in diesem Haushalt</span>
        <button class="btn btn-small" id="new-hh-list-btn">+ Neue Liste</button>
      </div>
      <div id="hh-lists"></div>
    `;
    $('new-hh-list-btn').addEventListener('click', () => openNewListModal(hh));
    renderListCards($('hh-lists'), lists.filter(l => l.householdId === hh.id), 'Noch keine Liste in diesem Haushalt.');
  } else if (householdTab === 'notes') {
    content.innerHTML = `
      <div class="section-title">
        <span>Notizen im Haushalt</span>
        <button class="btn btn-small" id="new-hh-note-btn">+ Neue Notiz</button>
      </div>
      <div id="hh-notes"></div>
    `;
    $('new-hh-note-btn').addEventListener('click', () => openNoteModal(null, hh));
    renderNoteCards($('hh-notes'), notes.filter(n => n.householdId === hh.id), 'Noch keine Notiz in diesem Haushalt.');
  } else if (householdTab === 'members') {
    content.innerHTML = `
      <div class="section-title">
        <span>Mitglieder</span>
        ${isOwner ? '<button class="btn btn-small" id="invite-btn">🔗 Einladungscodes</button>' : ''}
      </div>
      <div id="members"></div>

      ${isOwner ? `
        <div style="margin-top:3rem;text-align:right;">
          <button class="btn btn-danger btn-small" id="delete-hh-btn">Haushalt löschen</button>
        </div>
      ` : `
        <div style="margin-top:3rem;text-align:right;">
          <button class="btn btn-secondary btn-small" id="leave-hh-btn">Haushalt verlassen</button>
        </div>
      `}
    `;
    if (isOwner) {
      $('invite-btn').addEventListener('click', () => openInviteModal(hh));
      $('delete-hh-btn').addEventListener('click', () => confirmDeleteHousehold(hh));
    } else {
      $('leave-hh-btn').addEventListener('click', () => confirmLeaveHousehold(hh));
    }
    renderMembers(hh, isOwner);
  }
}

function renderMembers(hh, canEdit) {
  const el = $('members');
  const entries = Object.entries(hh.members || {});
  el.innerHTML = `<div class="member-list">${entries.map(([uid, role]) => `
    <div class="member-row">
      <div>
        <div class="member-name">${escapeHtml(nameFor(uid))}</div>
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
  ensureNamesFor(entries.map(([uid]) => uid), () => renderMembers(hh, canEdit));
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

let sortableHhCals = null;
function renderHhCals(cals) {
  const el = $('hh-cals');
  if (!el) return;
  if (sortableHhCals) { try { sortableHhCals.destroy(); } catch {} sortableHhCals = null; }
  if (!cals.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Noch kein Kalender in diesem Haushalt.</p></div>`;
    return;
  }
  const sorted = [...cals].sort((a, b) => {
    const ao = a.order ?? 999999;
    const bo = b.order ?? 999999;
    if (ao !== bo) return ao - bo;
    return (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0);
  });
  el.innerHTML = `<div class="calendar-grid sortable-cal-grid">${sorted.map(c => `
    <div class="calendar-card" data-cal="${c.id}">
      <span class="card-drag-handle" title="Ziehen zum Sortieren">⋮⋮</span>
      <div class="cal-name">
        <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
        ${escapeHtml(c.name)}
      </div>
      <div class="cal-role">Im Haushalt</div>
    </div>
  `).join('')}</div>`;
  el.querySelectorAll('[data-cal]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.card-drag-handle')) return;
      const cal = calendars.find(c => c.id === card.dataset.cal);
      if (cal) openCalendar(cal);
    });
  });
  wireCalendarSortable(el.querySelector('.sortable-cal-grid'), s => sortableHhCals = s);
}

function wireCalendarSortable(grid, setter) {
  if (!grid || typeof Sortable === 'undefined') return;
  const s = Sortable.create(grid, {
    handle: '.card-drag-handle',
    animation: 150,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: async () => {
      const ids = Array.from(grid.querySelectorAll('[data-cal]')).map(el => el.dataset.cal);
      try {
        const batch = writeBatch(db);
        ids.forEach((id, idx) => {
          batch.update(doc(db, 'calendars', id), { order: idx + 1 });
        });
        await batch.commit();
      } catch (err) {
        console.error('calendar reorder failed:', err);
      }
    }
  });
  setter(s);
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
    editable: canEdit,
    eventStartEditable: canEdit,
    eventDurationEditable: canEdit,
    dateClick: canEdit ? info => openEventModal(cal, { start: info.dateStr, allDay: info.allDay }) : undefined,
    eventClick: info => openEventModal(cal, info.event.extendedProps._doc, canEdit),
    eventDrop: info => handleEventChange(cal, info, 'drop'),
    eventResize: info => handleEventChange(cal, info, 'resize'),
    events: (_info, success) => success([])
  });
  fcInstance.render();

  unsubs.events = onSnapshot(collection(db, 'calendars', cal.id, 'events'), snap => {
    fcInstance.removeAllEvents();
    snap.forEach(d => {
      const data = d.data();
      const occurrences = expandRecurrence(data);
      occurrences.forEach((occ, idx) => {
        const iconPrefix = categoryIcon(data.category);
        fcInstance.addEvent({
          id: `${d.id}__${idx}`,
          title: iconPrefix ? `${iconPrefix} ${data.title}` : data.title,
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
      <div style="margin-top:1.5rem;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-small" id="clear-done-btn">Erledigte entfernen</button>
          <button class="btn btn-secondary btn-small" id="reopen-all-btn">Alle wieder öffnen</button>
          <button class="btn btn-secondary btn-small" id="duplicate-btn">Als Vorlage duplizieren</button>
        </div>
        ${list.owner === currentUser.uid ? '<button class="btn btn-secondary btn-small" id="list-settings-btn">Einstellungen</button>' : ''}
      </div>
    </main>
  `;
  wireLogout();
  $('back-btn').addEventListener('click', () => hh ? openHousehold(hh) : goHome());
  $('add-item-form').addEventListener('submit', e => {
    e.preventDefault();
    addItem(list);
  });
  $('clear-done-btn').addEventListener('click', () => clearDoneItems(list));
  $('reopen-all-btn').addEventListener('click', () => reopenAllItems(list));
  $('duplicate-btn').addEventListener('click', () => duplicateList(list));
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

let sortableOpen = null;
function renderItems(list) {
  const el = $('item-list');
  if (!el) return;
  if (sortableOpen) { try { sortableOpen.destroy(); } catch {} sortableOpen = null; }
  const open = listItems.filter(i => !i.done).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = listItems.filter(i => i.done).sort((a, b) => (b.doneAt?.seconds ?? 0) - (a.doneAt?.seconds ?? 0));
  const emails = list.householdId
    ? (households.find(h => h.id === list.householdId)?.memberEmails || {})
    : {};

  if (!open.length && !done.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>Noch keine Einträge.</p></div>`;
    return;
  }

  const itemHtml = (i, draggable) => `
    <div class="list-item ${i.done ? 'done' : ''}" data-id="${i.id}">
      ${draggable ? '<span class="drag-handle" title="Ziehen zum Sortieren">⋮⋮</span>' : ''}
      <label class="item-check">
        <input type="checkbox" ${i.done ? 'checked' : ''} data-toggle="${i.id}" />
        <span class="item-text">${i.qty && i.qty > 1 ? `<b>${i.qty}×</b> ` : ''}${escapeHtml(i.text)}</span>
      </label>
      ${i.done && i.doneBy ? `<span class="item-meta">${escapeHtml(nameFor(i.doneBy))}</span>` : ''}
      <button class="item-del" data-del="${i.id}" title="Löschen">✕</button>
    </div>
  `;

  el.innerHTML = `
    <div class="list-items" id="open-items">${open.map(i => itemHtml(i, true)).join('')}</div>
    ${done.length ? `
      <div class="list-section-label">Erledigt (${done.length})</div>
      <div class="list-items">${done.map(i => itemHtml(i, false)).join('')}</div>
    ` : ''}
  `;

  el.querySelectorAll('[data-toggle]').forEach(cb => {
    cb.addEventListener('change', () => toggleItem(list, cb.dataset.toggle, cb.checked));
  });
  el.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteItem(list, btn.dataset.del));
  });

  // Drag & Drop nur für offene Items
  const openList = $('open-items');
  if (openList && typeof Sortable !== 'undefined') {
    // Namen der Abhaker prefetchen für Re-Render
    ensureNamesFor(listItems.map(i => i.doneBy).filter(Boolean), () => renderItems(list));

    sortableOpen = Sortable.create(openList, {
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      onEnd: async () => {
        const ids = Array.from(openList.querySelectorAll('.list-item')).map(el => el.dataset.id);
        try {
          const batch = writeBatch(db);
          ids.forEach((id, idx) => {
            batch.update(doc(db, 'lists', list.id, 'items', id), { order: idx + 1 });
          });
          await batch.commit();
        } catch (err) {
          console.error('reorder failed:', err);
        }
      }
    });
  }
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

async function reopenAllItems(list) {
  const doneItems = listItems.filter(i => i.done);
  if (!doneItems.length) return;
  if (!confirm(`${doneItems.length} erledigte Einträge wieder auf offen setzen? Praktisch für Wocheneinkauf: einmal Einkaufsliste anlegen, jede Woche neu abhaken.`)) return;
  try {
    const batch = writeBatch(db);
    doneItems.forEach(i => {
      batch.update(doc(db, 'lists', list.id, 'items', i.id), {
        done: false, doneBy: null, doneAt: null
      });
    });
    batch.update(doc(db, 'lists', list.id), { openCount: increment(doneItems.length) });
    await batch.commit();
  } catch (err) {
    alert('Fehler: ' + err.message);
  }
}

async function duplicateList(list) {
  const name = prompt('Name für die neue Liste:', `${list.name} (Kopie)`);
  if (!name || !name.trim()) return;
  try {
    // Neue Liste anlegen — als persönliche Liste des aktuellen Users,
    // gleiche Zuordnung wie das Original
    const payload = {
      name: name.trim(),
      icon: list.icon,
      owner: currentUser.uid,
      members: { [currentUser.uid]: 'owner' },
      openCount: 0,
      createdAt: serverTimestamp()
    };
    if (list.householdId) payload.householdId = list.householdId;
    const newListRef = await addDoc(collection(db, 'lists'), payload);

    // Alle offenen Items kopieren (erledigte nicht)
    const openItems = listItems.filter(i => !i.done);
    if (openItems.length) {
      const batch = writeBatch(db);
      openItems.forEach((i, idx) => {
        const newDocRef = doc(collection(db, 'lists', newListRef.id, 'items'));
        batch.set(newDocRef, {
          text: i.text,
          qty: i.qty || 1,
          done: false,
          order: idx + 1,
          createdBy: currentUser.uid,
          createdAt: serverTimestamp()
        });
      });
      batch.update(newListRef, { openCount: openItems.length });
      await batch.commit();
    }
    alert(`Liste „${name.trim()}" angelegt.`);
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

// ── Notizen ───────────────────────────────────────────────────
const NOTE_COLORS = ['#fef08a', '#fed7aa', '#fecaca', '#e9d5ff', '#c7d2fe', '#bae6fd', '#bbf7d0', '#f5f5f4'];

function renderNoteCards(el, ns, emptyText) {
  if (!el) return;
  if (!ns.length) {
    el.innerHTML = `<div class="empty" style="padding:1.5rem;"><p>${escapeHtml(emptyText)}</p></div>`;
    return;
  }
  // Favoriten zuerst, danach nach letzter Änderung
  const sorted = [...ns].sort((a, b) => {
    const af = a.favorite ? 1 : 0;
    const bf = b.favorite ? 1 : 0;
    if (af !== bf) return bf - af;
    return (b.updatedAt?.seconds ?? b.createdAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? a.createdAt?.seconds ?? 0);
  });
  el.innerHTML = `<div class="notes-grid">${sorted.map(n => {
    const color = n.color || NOTE_COLORS[0];
    const authorName = n.createdBy ? nameFor(n.createdBy) : '';
    return `
      <div class="note-card ${n.favorite ? 'favorite' : ''}" data-note="${n.id}" style="background:${escapeHtml(color)};">
        <button class="note-fav" data-fav="${n.id}" title="${n.favorite ? 'Favorit entfernen' : 'Als Favorit markieren'}">${n.favorite ? '★' : '☆'}</button>
        <div class="note-text">${escapeHtml(n.text || '').replace(/\n/g, '<br>')}</div>
        ${authorName ? `<div class="note-author">— ${escapeHtml(authorName)}</div>` : ''}
      </div>
    `;
  }).join('')}</div>`;
  el.querySelectorAll('[data-note]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.note-fav')) return;
      const n = notes.find(x => x.id === card.dataset.note);
      if (n) openNoteModal(n, null);
    });
  });
  el.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const n = notes.find(x => x.id === btn.dataset.fav);
      if (!n) return;
      try {
        await updateDoc(doc(db, 'notes', n.id), { favorite: !n.favorite });
      } catch (err) {
        alert('Fehler: ' + err.message);
      }
    });
  });
  ensureNamesFor(sorted.map(n => n.createdBy).filter(Boolean), () => renderNoteCards(el, ns, emptyText));
}

function openNoteModal(existing, preselectedHousehold) {
  const isNew = !existing;
  let selectedColor = existing?.color || NOTE_COLORS[0];
  const canEdit = isNew || existing.members?.[currentUser.uid] === 'owner' || (existing.householdId && households.find(h => h.id === existing.householdId));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const hhOptions = households.map(h =>
    `<option value="${h.id}" ${(existing?.householdId || preselectedHousehold?.id) === h.id ? 'selected' : ''}>🏠 ${escapeHtml(h.name)}</option>`
  ).join('');
  overlay.innerHTML = `
    <div class="modal">
      <h2>${isNew ? 'Neue Notiz' : 'Notiz bearbeiten'}</h2>
      <div id="modal-msg"></div>
      <div class="field">
        <label>Text</label>
        <textarea id="note-text" rows="6" placeholder="Was möchtest du festhalten?">${escapeHtml(existing?.text || '')}</textarea>
      </div>
      <div class="field field-inline">
        <label><input type="checkbox" id="note-fav-cb" ${existing?.favorite ? 'checked' : ''} /> ⭐ Als Favorit — erscheint auch im Dashboard</label>
      </div>
      ${isNew ? `
        <div class="field">
          <label>Zuordnung</label>
          <select id="note-hh">
            <option value="">Persönlich (nur ich)</option>
            ${hhOptions}
          </select>
        </div>
      ` : ''}
      <div class="field">
        <label>Farbe</label>
        <div class="color-picker">
          ${NOTE_COLORS.map(c => `
            <div class="color-swatch ${selectedColor === c ? 'selected' : ''}" data-color="${c}" style="background:${c};"></div>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cancel-btn">Abbrechen</button>
        ${!isNew ? '<button class="btn btn-danger" id="delete-btn">Löschen</button>' : ''}
        <button class="btn" id="save-btn">${isNew ? 'Anlegen' : 'Speichern'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('note-text').focus();
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
    const text = $('note-text').value.trim();
    if (!text) { $('modal-msg').innerHTML = `<div class="msg msg-error">Text darf nicht leer sein.</div>`; return; }
    const btn = $('save-btn');
    btn.disabled = true;
    try {
      const fav = $('note-fav-cb').checked;
      if (isNew) {
        const hhId = $('note-hh').value || null;
        const payload = {
          text,
          color: selectedColor,
          favorite: fav,
          owner: currentUser.uid,
          members: { [currentUser.uid]: 'owner' },
          createdBy: currentUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        if (hhId) payload.householdId = hhId;
        await addDoc(collection(db, 'notes'), payload);
      } else {
        await updateDoc(doc(db, 'notes', existing.id), {
          text, color: selectedColor, favorite: fav, updatedAt: serverTimestamp()
        });
      }
      overlay.remove();
    } catch (err) {
      $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });

  const delBtn = $('delete-btn');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm('Diese Notiz wirklich löschen?')) return;
      try {
        await deleteDoc(doc(db, 'notes', existing.id));
        overlay.remove();
      } catch (err) {
        $('modal-msg').innerHTML = `<div class="msg msg-error">${escapeHtml(err.message)}</div>`;
      }
    });
  }
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
        <label>Kategorie</label>
        <select id="ev-category" ${canEdit ? '' : 'disabled'}>
          ${EVENT_CATEGORIES.map(c => `<option value="${c.id}">${c.icon ? c.icon + ' ' : ''}${escapeHtml(c.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Ort (optional)</label>
        <input type="text" id="ev-location" value="${escapeHtml(existing?.location || '')}" ${canEdit ? '' : 'disabled'} placeholder="z.B. Zuhause, Zahnarzt, ..." />
      </div>
      <div class="field">
        <label>Wer (optional)</label>
        <select id="ev-assignee" ${canEdit ? '' : 'disabled'}>
          <option value="">— nicht zugewiesen —</option>
        </select>
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
        <label>Erinnerung (lokal — Browser muss offen sein)</label>
        <select id="ev-reminder" ${canEdit ? '' : 'disabled'}>
          <option value="0">Keine</option>
          <option value="5">5 Minuten vorher</option>
          <option value="15">15 Minuten vorher</option>
          <option value="30">30 Minuten vorher</option>
          <option value="60">1 Stunde vorher</option>
          <option value="1440">1 Tag vorher</option>
        </select>
      </div>
      ${isNew && canEdit ? `
        <div class="field" id="ev-copy-field">
          <label>Auch in andere Kalender kopieren (optional)</label>
          <div id="ev-copy-list" class="copy-cal-list"></div>
          <div class="field-hint">Kopien werden bei späteren Änderungen nicht mit-synchronisiert.</div>
        </div>
      ` : ''}
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
  $('ev-reminder').value = String(existing?.reminderMinutes || 0);
  $('ev-category').value = existing?.category || 'none';

  // Assignee-Dropdown mit Mitgliedern befüllen (Haushalt, sonst nur ich)
  const assigneeSel = $('ev-assignee');
  const hh = cal.householdId ? households.find(h => h.id === cal.householdId) : null;
  const uids = hh ? Object.keys(hh.members || {}) : [currentUser.uid];
  uids.forEach(uid => {
    const opt = document.createElement('option');
    opt.value = uid;
    opt.textContent = nameFor(uid);
    if (existing?.assignee === uid) opt.selected = true;
    assigneeSel.appendChild(opt);
  });
  ensureNamesFor(uids, () => {
    uids.forEach(uid => {
      const opt = assigneeSel.querySelector(`option[value="${uid}"]`);
      if (opt) opt.textContent = nameFor(uid);
    });
  });

  // "Auch in andere Kalender kopieren"-Liste befüllen (nur bei Neu-Anlage)
  const copyList = $('ev-copy-list');
  if (copyList) {
    const others = calendars.filter(c => c.id !== cal.id);
    if (!others.length) {
      copyList.innerHTML = `<div class="field-hint">Du hast keine weiteren Kalender.</div>`;
    } else {
      copyList.innerHTML = others.map(c => {
        const hh = c.householdId ? households.find(h => h.id === c.householdId) : null;
        return `
          <label class="copy-cal-item">
            <input type="checkbox" data-copy-cal="${c.id}" />
            <span class="color-dot" style="background:${escapeHtml(c.color || '#14b8a6')};"></span>
            ${escapeHtml(c.name)}
            ${hh ? `<span class="copy-cal-hh">🏠 ${escapeHtml(hh.name)}</span>` : ''}
          </label>
        `;
      }).join('');
    }
  }

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
      const reminderMinutes = parseInt($('ev-reminder').value, 10) || 0;
      const location = $('ev-location').value.trim();
      const assignee = $('ev-assignee').value || null;
      const category = $('ev-category').value || 'none';

      // Notification-Permission einholen, wenn Reminder gewünscht
      if (reminderMinutes > 0 && 'Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch {}
      }

      try {
        const payload = {
          title,
          start: Timestamp.fromDate(start),
          end: Timestamp.fromDate(end),
          allDay: isAllDay,
          note,
          location,
          assignee,
          category,
          recurrence: $('ev-recurrence').value || 'none',
          reminderMinutes,
          updatedAt: serverTimestamp()
        };
        if (isNew) {
          payload.createdAt = serverTimestamp();
          payload.createdBy = currentUser.uid;
          await addDoc(collection(db, 'calendars', cal.id, 'events'), payload);
          // Kopien in weitere ausgewählte Kalender
          const copyTargets = Array.from(document.querySelectorAll('[data-copy-cal]:checked')).map(cb => cb.dataset.copyCal);
          if (copyTargets.length) {
            await Promise.all(copyTargets.map(async calId => {
              try {
                await addDoc(collection(db, 'calendars', calId, 'events'), { ...payload });
              } catch (err) { console.warn('Kopie fehlgeschlagen für', calId, err); }
            }));
          }
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

// ── Termin per Drag/Resize verschieben ────────────────────────
async function handleEventChange(cal, info, kind) {
  const docData = info.event.extendedProps._doc;
  if (!docData) { info.revert(); return; }
  if (docData.recurrence && docData.recurrence !== 'none') {
    const ok = confirm(
      kind === 'resize'
        ? 'Dauer ändern — gilt für die gesamte Serie. Fortfahren?'
        : 'Dieser Termin gehört zu einer Serie. Verschieben ändert das Startdatum der Serie um denselben Betrag. Fortfahren?'
    );
    if (!ok) { info.revert(); return; }
  }
  try {
    const oldStart = tsToDate(docData.start);
    const oldEnd = tsToDate(docData.end) || oldStart;
    const newStart = info.event.start;
    const duration = info.event.end
      ? (info.event.end.getTime() - info.event.start.getTime())
      : (oldEnd.getTime() - oldStart.getTime());
    // Für recurring: originalen Serien-Start um Delta shiften
    let seriesStart = newStart;
    if (docData.recurrence && docData.recurrence !== 'none') {
      const clickedStart = tsToDate(docData.start);
      // info.event.start ist die verschobene Instanz. Serien-Start = clickedStart + (newStart - Instanz-Original-Start)
      // Aber wir haben die Original-Instanz-Zeit nicht direkt. Approximation: Delta = newStart - info.oldEvent.start
      const delta = info.event.start.getTime() - info.oldEvent.start.getTime();
      seriesStart = new Date(clickedStart.getTime() + delta);
    }
    await updateDoc(doc(db, 'calendars', cal.id, 'events', docData.id), {
      start: Timestamp.fromDate(seriesStart),
      end: Timestamp.fromDate(new Date(seriesStart.getTime() + duration)),
      allDay: info.event.allDay,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    alert('Verschieben fehlgeschlagen: ' + err.message);
    info.revert();
  }
}

// ── Lokale Erinnerungen ───────────────────────────────────────
async function scheduleAllReminders() {
  reminderTimers.forEach(id => clearTimeout(id));
  reminderTimers.clear();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = Date.now();
  const horizon = now + 24 * 60 * 60 * 1000; // nächste 24 Stunden

  for (const cal of calendars) {
    let snap;
    try { snap = await getDocs(collection(db, 'calendars', cal.id, 'events')); }
    catch { continue; }
    snap.forEach(d => {
      const data = d.data();
      const mins = data.reminderMinutes || 0;
      if (!mins) return;
      expandRecurrence(data).forEach(occ => {
        const remindAt = occ.start.getTime() - mins * 60 * 1000;
        if (remindAt > now && remindAt < horizon) {
          const delay = remindAt - now;
          const id = setTimeout(() => showLocalNotification(cal, data, occ), delay);
          reminderTimers.add(id);
        }
      });
    });
  }
}

function showLocalNotification(cal, data, occ) {
  try {
    const timeStr = data.allDay
      ? 'heute'
      : occ.start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
    const body = [timeStr, data.location, cal.name].filter(Boolean).join(' · ');
    new Notification(data.title || 'Termin', {
      body,
      icon: './logo.svg',
      tag: `event-${cal.id}-${occ.start.getTime()}`
    });
  } catch (e) { console.warn('notification failed', e); }
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

// ── Service Worker + Auto-Update ──────────────────────────────
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Nur nach echtem Update reloaden — nicht beim allerersten Register
    if (hadController) window.location.reload();
    hadController = true;
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // Alle 60 Sekunden nach neuer Version fragen (nur im aktiven Tab)
      setInterval(() => reg.update().catch(() => {}), 60_000);
    }).catch(() => {});
  });
}
