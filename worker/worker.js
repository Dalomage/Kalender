// Cloudflare Worker — kalender-api
// Routen:
//   GET  /recipe?url=<rezept-url>     → HTML der Rezeptseite (30d Edge-Cache)
//   POST /photo-ingredients            → { dish, ingredients:[{qty,text}] } via Claude Vision
//
// Sicherheit:
//   - /recipe: nur whitelisted Rezept-Hosts
//   - /photo-ingredients: Body max 5 MB, IP-basiertes Tages-Limit via KV
//   - CORS: nur die eigenen Domains

const ALLOWED_ORIGINS = new Set([
  'https://kalenderkaiser.pages.dev',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8788',
]);

const ALLOWED_RECIPE_HOSTS = new Set([
  'chefkoch.de', 'www.chefkoch.de',
  'kitchenstories.io', 'www.kitchenstories.io', 'de.kitchenstories.io',
  'springlane.de', 'www.springlane.de',
  'eatsmarter.de', 'www.eatsmarter.de',
  'lecker.de', 'www.lecker.de',
  'essen-und-trinken.de', 'www.essen-und-trinken.de',
  'einfachbacken.de', 'www.einfachbacken.de',
  'daskochrezept.de', 'www.daskochrezept.de',
  'brigitte.de', 'www.brigitte.de',
  'kochbar.de', 'www.kochbar.de',
  'gutekueche.de', 'www.gutekueche.de',
  'gutekueche.at', 'www.gutekueche.at',
  'ichkoche.at', 'www.ichkoche.at',
  'rezeptwelt.de', 'www.rezeptwelt.de',
  'thermomix.de', 'www.thermomix.de',
  'maggi.de', 'www.maggi.de',
  'knorr.com', 'www.knorr.com',
  'edeka.de', 'www.edeka.de',
  'rewe.de', 'www.rewe.de',
  'kaufland.de', 'www.kaufland.de',
  'lidl.de', 'www.lidl.de',
  'oetker.de', 'www.oetker.de',
  'dr-oetker.de', 'www.dr-oetker.de',
  'nyt.com', 'cooking.nytimes.com',
  'bbcgoodfood.com', 'www.bbcgoodfood.com',
  'allrecipes.com', 'www.allrecipes.com',
]);

const DAILY_PHOTO_LIMIT = 20;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const PHOTO_PROMPT = `Du bekommst ein Foto. Extrahiere alle sichtbaren Lebensmittel-Zutaten und antworte NUR mit JSON in diesem Format:
{"dish":"<Freie Rate was daraus entstehen könnte oder ''>","ingredients":[{"qty":1,"text":"500 g Hackfleisch"},{"qty":2,"text":"Zwiebeln"}]}
Regeln:
- qty ist eine ganze Zahl >= 1 (Stückzahl). Grammangaben/Liter/ml gehören in text, nicht in qty.
- text enthält falls sichtbar Menge und Einheit, sonst nur die Zutat.
- Nur was tatsächlich im Bild ist. Nichts erfinden.
- Wenn kein Lebensmittel-Foto: {"dish":"","ingredients":[]}
- Keine Prosa, keine Codefences, nur pures JSON.`;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://kalenderkaiser.pages.dev';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, init = {}, origin = '') {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...(init.headers || {}) },
  });
}

function text(body, init = {}, origin = '') {
  return new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin), ...(init.headers || {}) },
  });
}

async function handleRecipe(request, env, ctx, origin) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return json({ error: 'missing url' }, { status: 400 }, origin);

  let parsed;
  try { parsed = new URL(target); } catch { return json({ error: 'invalid url' }, { status: 400 }, origin); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ error: 'invalid protocol' }, { status: 400 }, origin);
  }
  if (!ALLOWED_RECIPE_HOSTS.has(parsed.hostname)) {
    return json({ error: 'host not allowed', host: parsed.hostname }, { status: 403 }, origin);
  }

  const cacheKey = new Request(`https://cache.kalender-api/recipe?u=${encodeURIComponent(target)}`, { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return text(body, { headers: { 'X-Cache': 'HIT' } }, origin);
  }

  let resp;
  try {
    resp = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      cf: { cacheTtl: 2592000, cacheEverything: true },
    });
  } catch (e) {
    return json({ error: 'fetch failed', detail: e.message }, { status: 502 }, origin);
  }
  if (!resp.ok) return json({ error: 'upstream ' + resp.status }, { status: 502 }, origin);

  const html = await resp.text();
  const stored = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=2592000',
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, stored.clone()));
  return text(html, { headers: { 'X-Cache': 'MISS' } }, origin);
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { ok: true };
  const day = new Date().toISOString().slice(0, 10);
  const key = `photo:${day}:${ip}`;
  const raw = await env.RATE_LIMIT.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  if (n >= DAILY_PHOTO_LIMIT) return { ok: false, count: n };
  await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: 172800 });
  return { ok: true, count: n + 1 };
}

async function handlePhoto(request, env, origin) {
  if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY not configured' }, { status: 500 }, origin);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) return json({ error: `Tageslimit erreicht (${DAILY_PHOTO_LIMIT} Fotos/Tag)` }, { status: 429 }, origin);

  let body;
  try { body = await request.arrayBuffer(); } catch { return json({ error: 'invalid body' }, { status: 400 }, origin); }
  if (body.byteLength > MAX_PHOTO_BYTES) return json({ error: 'Bild zu groß (max 5 MB)' }, { status: 413 }, origin);
  if (body.byteLength < 200) return json({ error: 'Bild fehlt' }, { status: 400 }, origin);

  const mediaType = request.headers.get('Content-Type') || 'image/jpeg';
  if (!mediaType.startsWith('image/')) return json({ error: 'nur Bilder erlaubt' }, { status: 400 }, origin);

  const b64 = base64FromBytes(new Uint8Array(body));

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: PHOTO_PROMPT },
          ],
        }],
      }),
    });
  } catch (e) {
    return json({ error: 'LLM-Aufruf fehlgeschlagen', detail: e.message }, { status: 502 }, origin);
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    return json({ error: 'LLM ' + resp.status, detail: errBody.slice(0, 500) }, { status: 502 }, origin);
  }
  const data = await resp.json();
  const raw = data?.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return json({ error: 'LLM-Antwort nicht parsebar', raw }, { status: 502 }, origin);

  let parsed;
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {
    return json({ error: 'JSON-Parse fehlgeschlagen', raw }, { status: 502 }, origin);
  }
  const ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients
    .filter(i => i && typeof i.text === 'string' && i.text.trim())
    .map(i => ({
      qty: Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1)),
      text: String(i.text).trim().slice(0, 200),
    }))
    .slice(0, 60) : [];

  return json({
    dish: String(parsed.dish || '').trim().slice(0, 100),
    ingredients,
    usage: { today: rl.count, limit: DAILY_PHOTO_LIMIT },
  }, {}, origin);
}

function base64FromBytes(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/recipe' && request.method === 'GET') {
      return handleRecipe(request, env, ctx, origin);
    }
    if (url.pathname === '/photo-ingredients' && request.method === 'POST') {
      return handlePhoto(request, env, origin);
    }
    if (url.pathname === '/health') {
      return json({ ok: true, hasKey: !!env.ANTHROPIC_KEY, hasKv: !!env.RATE_LIMIT }, {}, origin);
    }
    return json({ error: 'not found' }, { status: 404 }, origin);
  },
};
