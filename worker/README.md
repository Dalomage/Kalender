# kalender-api Worker

Ein Cloudflare Worker mit zwei Routen für KalenderKaiser:

- `GET /recipe?url=<rezept-url>` — fetcht die Rezeptseite mit Browser-User-Agent, cached 30 Tage. Client extrahiert dann JSON-LD lokal.
- `POST /photo-ingredients` — Bild rein (raw bytes im Body, `Content-Type: image/*`), JSON `{dish, ingredients:[{qty,text}]}` raus. Läuft über Claude Haiku 4.5. Rate-Limit: 20 Fotos/Tag pro IP.
- `GET /health` — Status-Check.

## Erst-Setup

Einmalig, ~15 min:

```bash
# 1. Wrangler installieren (falls nicht vorhanden)
npm install -g wrangler

# 2. Login
wrangler login

# 3. In diesen Ordner wechseln
cd worker

# 4. KV-Namespace für Rate-Limiting anlegen
wrangler kv:namespace create RATE_LIMIT
# Ausgabe zeigt die id. Diese in wrangler.toml bei `id = "..."` einsetzen.

# 5. Anthropic-API-Key als Secret setzen
wrangler secret put ANTHROPIC_KEY
# → Key einfügen (nicht committen!)

# 6. Deploy
wrangler deploy
# Ausgabe zeigt die URL, z.B. https://kalender-api.<subdomain>.workers.dev
```

Danach in `app.js` die Konstante `WORKER_URL` auf die tatsächliche URL setzen.

## Änderungen live ziehen

```bash
cd worker
wrangler deploy
```

## Kosten

- Workers Free Tier: 100.000 Requests/Tag → ausreichend
- KV: 100.000 Reads + 1.000 Writes pro Tag frei → ausreichend
- Anthropic Haiku 4.5 Vision: ~0,003 $ pro Bild → bei 30 Fotos/Monat < 0,10 $/Monat

Kein Blaze bei Firebase nötig — der Worker läuft komplett bei Cloudflare.

## Whitelist erweitern

Neue Rezeptseite in `worker.js` bei `ALLOWED_RECIPE_HOSTS` eintragen und redeployen.

## Sicherheit

- **CORS:** nur `kalenderkaiser.pages.dev` (+ localhost für Dev) darf den Worker aufrufen.
- **Recipe-Host-Whitelist:** verhindert Missbrauch als offener Proxy.
- **Photo-Rate-Limit:** 20/Tag pro IP. Bei Missbrauchsverdacht auf 5/Tag senken.
- **Photo-Bytes-Limit:** 5 MB.
- **Anthropic-Key:** nur als Cloudflare-Secret, nie im Repo.
