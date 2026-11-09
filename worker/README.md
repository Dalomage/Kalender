# kalender-api Worker

Cloudflare Worker für den Menüplan des Familien-Kalenders:

- `GET /recipe?url=<rezept-url>`: Ruft die Rezeptseite ab, liest das schema.org-Rezept (JSON-LD) **im Worker** aus und gibt nur `{ name, ingredients[], servings, image }` zurück (30 Tage Edge-Cache). Kein offener Proxy, funktioniert mit jeder Seite, die Rezepte nach schema.org auszeichnet (Chefkoch, EatSmarter, Kitchen Stories, Lecker, …).
- `POST /photo-ingredients`: Bild rein (Rohdaten im Body, `Content-Type: image/jpeg|png|gif|webp`), `{ dish, ingredients:[{qty,text}] }` raus. Läuft über Claude Haiku 5.5 (`claude-haiku-5-5`) mit Structured Outputs über das offizielle SDK `@anthropic-ai/sdk`. Tageslimit 20 Fotos pro IP.
- `GET /health`: Status (`photo`: Schlüssel gesetzt?, `rateLimit`: KV verbunden?).

## Erst-Setup

```bash
cd worker
npm install
npx wrangler login

# KV-Namespace für das Foto-Tageslimit anlegen, ausgegebene id in wrangler.toml eintragen
npx wrangler kv namespace create RATE_LIMIT

# Nur für den Foto-Import: Anthropic-API-Schlüssel als Secret (nie committen!)
npx wrangler secret put ANTHROPIC_API_KEY

npx wrangler deploy
# Ausgabe zeigt die URL, z.B. https://kalender-api.<subdomain>.workers.dev
```

Danach in `app.js` die Konstante `WORKER_URL` auf diese URL setzen. Ohne `ANTHROPIC_API_KEY` funktioniert der Link-Import trotzdem, nur der Foto-Import antwortet mit „nicht eingerichtet“.

## Änderungen live ziehen

```bash
cd worker && npx wrangler deploy
```

## Kosten

- Workers Free Tier: 100.000 Anfragen/Tag, KV: 100.000 Lese- und 1.000 Schreibvorgänge/Tag frei
- Claude Haiku 5.5: $0,10 / $0,50 pro Mio. Ein-/Ausgabe-Tokens → ein Foto kostet grob einen Bruchteil eines Cents

## Sicherheit

- **CORS:** nur `kalenderkaiser.pages.dev`, deren Vorschau-Subdomains und lokale Dev-Ports.
- **/recipe** liefert nie fremdes HTML aus, nur die extrahierten Rezeptfelder; Seiten > 3 MB werden abgelehnt, Timeout 10 s.
- **/photo-ingredients:** max. 5 MB, nur gängige Bildformate, Tageslimit pro IP über KV.
