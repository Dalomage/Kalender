# Familien-Kalender

Gemeinsamer Kalender-Webapp für Familie und Freunde. Login-basiert, mehrere
Kalender pro Konto, Freigaben mit Rollen (Owner / Editor / Viewer).

Live-App: _wird nach Cloudflare-Deploy hier eingetragen_

## Stack

- **Hosting:** Cloudflare Pages, Auto-Deploy aus `main`
- **Backend:** Firebase (Auth + Firestore)
- **Frontend:** Statische PWA — HTML/CSS/JS, kein Build-Step

## Projektstruktur

```text
index.html            App-Shell (Loading / Login / App-Container)
app.js                App-Logik (Auth-State, Kalender-Rendering, Modals)
styles.css            Styling (Dark-Mode Standard)
firebase-config.js    Firebase-Projektkonfiguration (Werte eintragen!)
manifest.json         PWA-Manifest
sw.js                 Service Worker (Offline-Cache für App-Shell)
firestore.rules       Firestore Security Rules — in Firebase-Console eintragen
logo.png              App-Icon (Platzhalter — noch zu ersetzen)
```

## Einrichtung

1. **Firebase-Projekt anlegen** — siehe [docs/SETUP.md](docs/SETUP.md)
2. Werte aus der Firebase-Console in `firebase-config.js` eintragen
3. Security Rules aus `firestore.rules` in die Firebase-Console kopieren
4. Lokal testen: einen kleinen Webserver starten, z.B.
   `npx http-server .` oder `python -m http.server 8000`
5. Nach `main` pushen → Cloudflare Pages deployt automatisch

## Deployment (Cloudflare Pages)

- Cloudflare Dashboard → Workers & Pages → Create → Pages → GitHub-Repo verbinden
- Build-Command: _leer lassen_
- Output-Verzeichnis: `/` (Root)

## Datenmodell (Firestore)

```text
users/{uid}                     Profil (email, name)
calendars/{calId}               Kalender (name, color, owner, members{uid: role})
calendars/{calId}/events/{id}   Termine (start, end, title, rrule, reminder)
calendars/{calId}/lists/{id}    Listen (name, type: shopping/todo)
    /items/{id}                 Listen-Items (text, done, checkedBy)
```

## Aktueller Stand (MVP)

- [x] Login / Registrierung mit Email + Passwort
- [x] Kalender anlegen mit Farbwahl
- [x] Kalender-Übersicht für angemeldeten Nutzer
- [ ] Kalender öffnen und Termine sehen (FullCalendar-Integration)
- [ ] Termine anlegen / bearbeiten / löschen
- [ ] Wiederkehrende Termine
- [ ] Erinnerungen (Web Push via FCM)
- [ ] Kalender mit anderen teilen
- [ ] Einkaufs- und To-Do-Listen
