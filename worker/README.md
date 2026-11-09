# kalender-api Worker

Cloudflare Worker für den Menüplan des Familien-Kalenders. Läuft komplett im kostenlosen Rahmen von Cloudflare, ohne externe API-Schlüssel.

Live: `https://kalender-api.thunkdarts.workers.dev` (persönliches Cloudflare-Konto, Workers-Subdomain „thunkdarts“).

- `GET /recipe?url=<rezept-url>`: Ruft die Rezeptseite ab, liest das schema.org-Rezept (JSON-LD) **im Worker** aus und gibt nur `{ name, ingredients[], servings, image }` zurück (30 Tage Edge-Cache). Kein offener Proxy, funktioniert mit jeder Seite, die Rezepte nach schema.org auszeichnet (Chefkoch, EatSmarter, Kitchen Stories, Lecker, …).
- `POST /photo-ingredients`: Bild rein (Rohdaten im Body, `Content-Type: image/jpeg|png|gif|webp`), `{ dish, ingredients:[{qty,text}] }` raus. Läuft über **Cloudflare Workers AI** (`@cf/meta/llama-4-scout-17b-16e-instruct`, JSON-Schema-Ausgabe). Tageslimit 20 Fotos pro IP.
- `GET /health`: Status (`photo`: KI-Anbindung vorhanden?, `rateLimit`: KV verbunden?).

## Erst-Setup

```bash
cd worker
npm install
npx wrangler login

# KV-Namespace für das Foto-Tageslimit anlegen, ausgegebene id in wrangler.toml eintragen
npx wrangler kv namespace create RATE_LIMIT

npx wrangler deploy
```

Danach in `app.js` die Konstante `WORKER_URL` auf die ausgegebene URL setzen. Die KI-Anbindung (`[ai]` in `wrangler.toml`) braucht keinen Schlüssel.

## Änderungen live ziehen

```bash
cd worker && npx wrangler deploy
```

Unter Windows-PowerShell ggf. `npx.cmd` statt `npx` (Skriptausführung für `npx.ps1` ist gesperrt).

Fehler ansehen: `npx wrangler tail kalender-api`

## Kosten: 0 €

- Workers Free: 100.000 Anfragen/Tag, KV: 100.000 Lese- und 1.000 Schreibvorgänge/Tag
- Workers AI: 10.000 Neuronen/Tag kostenlos (ein Foto ≈ 50–100 Neuronen). **Im Workers-Free-Tarif gibt es bei Überschreitung einen Fehler, keine Rechnung** – die App meldet dann „Tageskontingent aufgebraucht“. Wichtig: Das Konto muss im Free-Tarif bleiben (bei Workers Paid würde Mehrverbrauch berechnet).

## Sicherheit

- **CORS:** nur `kalenderkaiser.pages.dev`, deren Vorschau-Subdomains und lokale Dev-Ports.
- **/recipe** liefert nie fremdes HTML aus, nur die extrahierten Rezeptfelder; Seiten > 3 MB werden abgelehnt, Timeout 10 s.
- **/photo-ingredients:** max. 5 MB, nur gängige Bildformate, Tageslimit pro IP über KV.
