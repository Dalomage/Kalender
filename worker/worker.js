// Cloudflare Worker — kalender-api
// Routen:
//   GET  /recipe?url=<rezept-url>     → { name, ingredients:[{qty,text}], servings, image } (30d Edge-Cache)
//   POST /photo-ingredients            → { dish, ingredients:[{qty,text}] } via Claude (Haiku 5.5, Structured Outputs)
//   GET  /health                       → Status
//
// Sicherheit:
//   - /recipe gibt NUR die extrahierten Rezeptdaten (JSON) zurück, nie fremdes HTML
//     → kein offener Proxy. Nur http(s), Antwort max. 3 MB, Timeout 10 s.
//   - /photo-ingredients: Body max 5 MB, IP-basiertes Tages-Limit via KV
//   - CORS: nur die eigenen Domains (inkl. Cloudflare-Vorschauen)

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)?kalenderkaiser\.pages\.dev$/;
const DEV_ORIGINS = new Set([
  'http://localhost:8765', 'http://127.0.0.1:8765',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:8788',
]);
const isAllowedOrigin = o => ORIGIN_RE.test(o) || DEV_ORIGINS.has(o);

const DAILY_PHOTO_LIMIT = 20;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const PHOTO_MODEL = 'claude-haiku-5-5';

const PHOTO_PROMPT = `Du bekommst ein Foto (z. B. Rezeptzettel, Kochbuchseite, Kühlschrankinhalt oder Lebensmittel).
Erfasse alle sichtbaren Lebensmittel-Zutaten.
- qty: ganze Stückzahl >= 1. Gramm, Liter, Esslöffel usw. gehören in text, dann ist qty 1.
- text: Zutat, falls sichtbar mit Menge und Einheit (z. B. "500 g Hackfleisch").
- dish: das Gericht, falls erkennbar (Rezeptüberschrift oder naheliegende Idee), sonst leer.
- Nur was tatsächlich im Bild zu sehen ist, nichts erfinden.
- Ist kein Lebensmittel und kein Rezept zu sehen: dish leer, ingredients leer.
Antworte auf Deutsch.`;

const PhotoResult = z.object({
  dish: z.string(),
  ingredients: z.array(z.object({
    qty: z.number().int(),
    text: z.string(),
  })),
});

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : 'https://kalenderkaiser.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, init = {}, origin = '') {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...(init.headers || {}) },
  });
}

// ── Rezept aus HTML (schema.org Recipe als JSON-LD) ─────────────
function findRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipe(n); if (r) return r; }
    return null;
  }
  const t = node['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return node;
  if (node['@graph']) return findRecipe(node['@graph']);
  if (node.mainEntity) return findRecipe(node.mainEntity);
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
const clean = s => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ').replace(/(\s*,\s*){2,}/g, ', ').replace(/\(\s*,\s*/g, '(').trim();

export function extractRecipe(html) {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const r = findRecipe(data);
    if (!r) continue;
    const ings = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : (r.ingredients || []))
      .map(clean).filter(Boolean).slice(0, 80);
    if (!ings.length) continue;
    const img = Array.isArray(r.image) ? r.image[0] : r.image;
    const yieldRaw = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
    return {
      name: clean(r.name).slice(0, 120),
      ingredients: ings,
      servings: yieldRaw ? clean(yieldRaw).slice(0, 40) : '',
      image: typeof img === 'string' ? img : (img?.url || ''),
    };
  }
  return null;
}

async function handleRecipe(request, ctx, origin) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target) return json({ error: 'Link fehlt' }, { status: 400 }, origin);
  let parsed;
  try { parsed = new URL(target); } catch { return json({ error: 'Ungültiger Link' }, { status: 400 }, origin); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ error: 'Ungültiger Link' }, { status: 400 }, origin);
  }

  const cacheKey = new Request(`https://cache.kalender-api/recipe-v2?u=${encodeURIComponent(parsed.href)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return json(await cached.json(), { headers: { 'X-Cache': 'HIT' } }, origin);
  }

  let resp;
  try {
    resp = await fetch(parsed.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
  } catch (e) {
    return json({ error: 'Seite nicht erreichbar', detail: e.name }, { status: 502 }, origin);
  }
  if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
    return json({ error: 'blocked', status: resp.status }, { status: 502 }, origin);
  }
  if (!resp.ok) return json({ error: `Seite antwortet mit ${resp.status}` }, { status: 502 }, origin);
  const len = +(resp.headers.get('Content-Length') || 0);
  if (len > MAX_PAGE_BYTES) return json({ error: 'Seite zu groß' }, { status: 413 }, origin);

  const html = (await resp.text()).slice(0, MAX_PAGE_BYTES);
  const recipe = extractRecipe(html);
  if (!recipe) {
    // Sperrseiten (Bot-Schutz) sind klein; normale Seiten können „captcha“ o. Ä. im Code enthalten
    const blocked = html.length < 40000 && /captcha|cf-chl|access denied|just a moment/i.test(html);
    return json({ error: blocked ? 'blocked' : 'no-recipe' }, { status: 422 }, origin);
  }
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(recipe), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=2592000' },
  })));
  return json(recipe, { headers: { 'X-Cache': 'MISS' } }, origin);
}

// ── Foto → Zutaten ─────────────────────────────────────────────
async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { ok: true, count: 0 };
  const day = new Date().toISOString().slice(0, 10);
  const key = `photo:${day}:${ip}`;
  const n = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (n >= DAILY_PHOTO_LIMIT) return { ok: false, count: n };
  await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: 172800 });
  return { ok: true, count: n + 1 };
}

function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function handlePhoto(request, env, origin) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Foto-Erkennung ist nicht eingerichtet' }, { status: 503 }, origin);

  const mediaType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    return json({ error: 'Bitte ein JPG-, PNG-, GIF- oder WebP-Bild wählen' }, { status: 415 }, origin);
  }
  let body;
  try { body = await request.arrayBuffer(); } catch { return json({ error: 'Bild konnte nicht gelesen werden' }, { status: 400 }, origin); }
  if (body.byteLength > MAX_PHOTO_BYTES) return json({ error: 'Bild zu groß (max. 5 MB)' }, { status: 413 }, origin);
  if (body.byteLength < 200) return json({ error: 'Bild fehlt' }, { status: 400 }, origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) return json({ error: `Tageslimit erreicht (${DAILY_PHOTO_LIMIT} Fotos pro Tag)` }, { status: 429 }, origin);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45_000 });
  let response;
  try {
    response = await client.messages.parse({
      model: PHOTO_MODEL,
      max_tokens: 4096,
      output_config: { effort: 'low', format: zodOutputFormat(PhotoResult) },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64FromBytes(new Uint8Array(body)) } },
          { type: 'text', text: PHOTO_PROMPT },
        ],
      }],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: 'Erkennung gerade ausgelastet, bitte gleich nochmal' }, { status: 503 }, origin);
    if (error instanceof Anthropic.AuthenticationError) return json({ error: 'Foto-Erkennung falsch eingerichtet (Schlüssel)' }, { status: 503 }, origin);
    if (error instanceof Anthropic.BadRequestError) return json({ error: 'Bild konnte nicht ausgewertet werden' }, { status: 422 }, origin);
    if (error instanceof Anthropic.APIError) return json({ error: `Erkennung fehlgeschlagen (${error.status ?? 'Netz'})` }, { status: 502 }, origin);
    return json({ error: 'Erkennung fehlgeschlagen' }, { status: 502 }, origin);
  }

  if (response.stop_reason === 'refusal') return json({ error: 'Dieses Bild kann nicht ausgewertet werden' }, { status: 422 }, origin);
  const out = response.parsed_output;
  if (!out) return json({ error: 'Erkennung lieferte kein Ergebnis' }, { status: 502 }, origin);

  const ingredients = out.ingredients
    .filter(i => i.text && i.text.trim())
    .map(i => ({ qty: Math.max(1, Math.min(99, Math.round(i.qty) || 1)), text: i.text.trim().slice(0, 200) }))
    .slice(0, 60);

  return json({
    dish: out.dish.trim().slice(0, 100),
    ingredients,
    usage: { today: rl.count, limit: DAILY_PHOTO_LIMIT },
  }, {}, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (pathname === '/recipe' && request.method === 'GET') return handleRecipe(request, ctx, origin);
    if (pathname === '/photo-ingredients' && request.method === 'POST') return handlePhoto(request, env, origin);
    if (pathname === '/health') return json({ ok: true, photo: !!env.ANTHROPIC_API_KEY, rateLimit: !!env.RATE_LIMIT }, {}, origin);
    return json({ error: 'not found' }, { status: 404 }, origin);
  },
};
