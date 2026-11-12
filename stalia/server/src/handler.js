/*
 * The reading service as one function: a web Request in, a web Response out.
 * It runs unchanged under Node (node-server.js) and on Cloudflare Workers (worker.js).
 *
 *   GET  /   -> { ok, service, ready, limits }           is it up, is it configured
 *   POST /   -> { ok, extraction, quota } | { ok:false, error }
 *
 * Request body of POST:
 *   { v: 1, lang: 'en', license: '<licence key or empty>', pages: [{ doc: 'cp'|'sof', type: 'image/jpeg', data: '<base64>' }] }
 *
 * Nothing from a request is stored: page images go to the model and are dropped; the log line has sizes and timings only.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readDocuments, DEFAULT_MODEL, DEFAULT_FREE_MODEL, DEFAULT_EFFORT } from './reader.js';
import { planOf, sha256Hex } from './licence.js';
import { LANGUAGE_NAMES } from './prompt.js';

/** The first base64 characters of each image type we accept. */
const IMAGE_START = { 'image/jpeg': '/9j/', 'image/png': 'iVBOR', 'image/webp': 'UklGR' };
/** The packaged Android and iPhone apps load their page from these origins. */
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];
const DAY_SECONDS = 2 * 86400;
const MONTH_SECONDS = 33 * 86400;

const whole = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : dflt; };

/** Settings from the environment, with their defaults. */
export function settings(env) {
  env = env || {};
  return {
    apiKey: String(env.ANTHROPIC_API_KEY || '').trim(),
    baseURL: String(env.STALIA_API_BASE_URL || '').trim() || 'https://api.anthropic.com',
    model: String(env.STALIA_MODEL || '').trim() || DEFAULT_MODEL,
    modelFree: String(env.STALIA_MODEL_FREE || '').trim() || DEFAULT_FREE_MODEL,
    effort: String(env.STALIA_EFFORT || '').trim() || DEFAULT_EFFORT,
    origins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    freePerDay: whole(env.FREE_PER_DAY, 2),      // without a licence: readings a day for one visitor
    proPerMonth: whole(env.PRO_PER_MONTH, 200),  // with a Pro licence: readings a calendar month for one licence
    maxPages: Math.min(40, whole(env.MAX_PAGES, 20) || 20),
    maxBodyBytes: (whole(env.MAX_BODY_MB, 24) || 24) * 1024 * 1024,
    maxPageChars: 6 * 1024 * 1024, // about 4.5 MB of image
    salt: String(env.IP_SALT || 'stalia'),
  };
}

function corsHeaders(request, cfg) {
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  const h = { Vary: 'Origin' };
  if (origin && (!cfg.origins.length || cfg.origins.includes(origin) || APP_ORIGINS.includes(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
const originAllowed = (request, cfg) => {
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  return !origin || !cfg.origins.length || cfg.origins.includes(origin) || APP_ORIGINS.includes(origin);
};

/** What the model's failures mean to the person waiting, and the HTTP status that goes with it. */
const FAILURES = {
  config: [503, 'unavailable'], busy: [503, 'server'], upstream: [502, 'server'], network: [502, 'server'], too_long: [502, 'server'],
  bad_request: [400, 'bad_request'], too_big: [413, 'too_big'], refused: [422, 'refused'], unreadable: [422, 'refused'], aborted: [499, 'aborted'],
};

/**
 * @param {{store: object, now?: Function, fetch?: Function, log?: Function, createClient?: Function, read?: Function, space?: Function}} deps
 *        `space` is the handler of the shared space (src/space.js); without it the server only reads documents
 * @returns {(request: Request, env: object, ctx?: {ip?: string, signal?: AbortSignal}) => Promise<Response>}
 */
export function createHandler(deps) {
  const d = Object.assign({
    now: Date.now,
    fetch: (...a) => fetch(...a),
    log: () => {},
    createClient: (cfg) => new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
    read: readDocuments,
  }, deps);
  if (!d.store) throw new Error('createHandler needs a store for the counters');

  return async function handle(request, env, ctx) {
    const cfg = settings(env);
    ctx = ctx || {};
    const cors = corsHeaders(request, cfg);
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors),
    });
    const fail = (status, error, extra) => reply(status, Object.assign({ ok: false, error }, extra || {}));

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // the shared space lives under /v1/ on the same server
    if (/\/v1\//.test(new URL(request.url).pathname)) {
      if (!d.space) return fail(404, 'not_found');
      if (!originAllowed(request, cfg)) return fail(403, 'origin');
      try { return await d.space(request, env, ctx, { reply, fail }); } catch (e) {
        d.log({ t: new Date(d.now()).toISOString(), space: true, ok: false, detail: String((e && e.message) || e).slice(0, 200) });
        return fail(500, 'server');
      }
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return reply(200, { ok: true, service: 'stalia-reader', ready: !!cfg.apiKey, space: !!d.space, limits: { pages: cfg.maxPages, freePerDay: cfg.freePerDay, proPerMonth: cfg.proPerMonth } });
    }
    if (request.method !== 'POST') return fail(405, 'bad_request');
    if (!originAllowed(request, cfg)) return fail(403, 'origin');
    if (!cfg.apiKey) return fail(503, 'unavailable');

    // ---- the request
    if (whole(request.headers.get('content-length'), 0) > cfg.maxBodyBytes) return fail(413, 'too_big');
    let raw, body;
    try { raw = await request.text(); } catch (e) { return fail(400, 'bad_request'); }
    if (raw.length > cfg.maxBodyBytes) return fail(413, 'too_big');
    try { body = JSON.parse(raw); } catch (e) { return fail(400, 'bad_request'); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.pages) || !body.pages.length) return fail(400, 'bad_request');
    if (body.pages.length > cfg.maxPages) return fail(400, 'too_many', { limit: cfg.maxPages });
    const pages = [];
    for (const p of body.pages) {
      const ok = p && (p.doc === 'cp' || p.doc === 'sof') && IMAGE_START[p.type] && typeof p.data === 'string' &&
        p.data.length >= 200 && p.data.length % 4 === 0 && p.data.startsWith(IMAGE_START[p.type]);
      if (!ok) return fail(400, 'bad_request');
      if (p.data.length > cfg.maxPageChars) return fail(413, 'too_big');
      pages.push({ doc: p.doc, type: p.type, data: p.data });
    }
    pages.sort((a, b) => (a.doc === b.doc ? 0 : (a.doc === 'cp' ? -1 : 1))); // charter party first; the order inside each stays
    const lang = LANGUAGE_NAMES[body.lang] ? body.lang : 'en';
    // the charter party in words, sent along with a time sheet when the calculation already has its terms
    const terms = typeof body.terms === 'string' && !pages.some((p) => p.doc === 'cp') ? body.terms.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 6000).trim() : '';

    // ---- who is asking, and how much they have left
    // Two allowances and nothing else: free readings are counted per visitor and day, Pro readings per licence
    // and calendar month. What all visitors together may spend is capped in the Anthropic console, not here.
    const lic = await planOf(body.license, env, d);
    const pro = lic.plan === 'pro';
    const limit = pro ? cfg.proPerMonth : cfg.freePerDay;
    const day = new Date(d.now()).toISOString().slice(0, 10);
    const counter = pro ? day.slice(0, 7) + ':k:' + lic.id : day + ':ip:' + (await sha256Hex(cfg.salt + '|' + (ctx.ip || 'unknown'))).slice(0, 32);
    const ttl = pro ? MONTH_SECONDS : DAY_SECONDS;
    const quota = (left) => Object.assign({ plan: lic.plan, left: Math.max(0, left) }, pro ? { perMonth: limit } : { perDay: limit });
    if (limit <= 0) return fail(429, pro ? 'limit' : 'pro', { quota: quota(0) });
    // The reading is counted before the call, so parallel requests cannot overrun the allowance; `giveBack` returns it.
    const used = await d.store.add(counter, 1, ttl);
    const giveBack = () => d.store.add(counter, -1, ttl);
    if (used > limit) { await giveBack(); return fail(429, pro ? 'limit' : 'pro', { quota: quota(0) }); }

    // ---- the reading
    const started = d.now();
    const line = { t: new Date(started).toISOString(), plan: lic.plan, pages: pages.length, kb: Math.round(raw.length / 1024) };
    try {
      const out = await d.read({ client: d.createClient(cfg), model: pro ? cfg.model : cfg.modelFree, effort: cfg.effort, pages, lang, terms, signal: ctx.signal });
      d.log(Object.assign(line, { ms: d.now() - started, ok: true, model: out.model, in: out.usage.input, out: out.usage.output }));
      return reply(200, { ok: true, extraction: out.extraction, quota: quota(limit - used) });
    } catch (e) {
      const code = e && e.code && FAILURES[e.code] ? e.code : 'upstream';
      if (!(e && e.billed)) await giveBack(); // nothing was read: the attempt is given back
      d.log(Object.assign(line, { ms: d.now() - started, ok: false, error: code, detail: String((e && e.message) || '').slice(0, 200) }));
      return fail(FAILURES[code][0], FAILURES[code][1], { quota: quota(limit - used + (e && e.billed ? 0 : 1)) });
    }
  };
}
