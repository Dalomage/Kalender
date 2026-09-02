# Firebase-Einrichtung — Schritt für Schritt

## 1. Firebase-Projekt anlegen

1. https://console.firebase.google.com öffnen und mit Google-Konto anmelden
2. **Projekt hinzufügen** klicken
3. Projektname: z.B. `familien-kalender` (bekommt eine Zufalls-ID angehängt)
4. Google Analytics: **deaktivieren** (brauchen wir nicht, macht Setup einfacher)
5. **Projekt erstellen** — kurz warten

## 2. Web-App zum Projekt hinzufügen

1. Auf der Projekt-Übersichtsseite das **`</>`-Symbol** klicken (Web-App hinzufügen)
2. App-Name: `Kalender`
3. **Firebase Hosting NICHT anhaken** (wir nutzen Cloudflare Pages)
4. **App registrieren**
5. Der nächste Screen zeigt einen `firebaseConfig`-Block —
   diese Werte kopieren und in `firebase-config.js` einsetzen

## 3. Authentication aktivieren

1. Linkes Menü: **Build → Authentication**
2. **Los geht's** klicken
3. Reiter **Sign-in method** → **E-Mail/Passwort** → **Aktivieren** (der obere Schalter reicht) → Speichern

## 4. Firestore-Datenbank anlegen

1. Linkes Menü: **Build → Firestore Database**
2. **Datenbank erstellen**
3. Modus: **Produktionsmodus** (Rules kommen gleich)
4. Region: **eur3 (europe-west)** oder **europe-west3 (Frankfurt)**
5. **Aktivieren**

## 5. Security Rules einspielen

1. In Firestore Database den Reiter **Rules** öffnen
2. Kompletten Inhalt von `firestore.rules` aus diesem Repo einfügen
3. **Veröffentlichen**

## 6. Domain für Auth freigeben (nach Deploy)

Sobald die App auf Cloudflare Pages läuft, die dortige Domain
(`kalender.pages.dev` o.ä.) unter
**Authentication → Settings → Autorisierte Domains** hinzufügen.
`localhost` und `*.firebaseapp.com` sind schon drin.

## Fertig!

`firebase-config.js` ist ausgefüllt, `git commit`, `git push` — die App läuft.
