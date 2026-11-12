/*
 * Is the licence key that came with a request a valid Pro licence?
 * Keys issued by tools/keygen.js are checked here by their signature. Keys sold through
 * Lemon Squeezy are checked with its licence API (no secret needed) and remembered for ten minutes.
 */
import L from '../shared/license.cjs';
import builtInKeys from './public-keys.js';

const LS_VALIDATE = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const REMEMBER_MS = 10 * 60 * 1000;
const remembered = new Map();

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function publicKeys(env) {
  if (env.STALIA_PUBLIC_KEYS) {
    try { const k = JSON.parse(env.STALIA_PUBLIC_KEYS); if (Array.isArray(k)) return k; } catch (e) { /* fall through to the built-in keys */ }
  }
  return builtInKeys;
}

/**
 * @returns {Promise<{plan: 'pro'|'free', id: string}>} `id` identifies the licence without revealing the key
 */
export async function planOf(key, env, deps) {
  key = String(key || '').trim();
  if (!key || key.length > 4000) return { plan: 'free', id: '' };
  const id = (await sha256Hex(key)).slice(0, 32);
  const now = deps.now();

  if (L.isOfflineKey(key)) {
    const v = await L.verifyOfflineKey(key, publicKeys(env), now);
    return { plan: v.ok ? 'pro' : 'free', id };
  }

  const storeId = String(env.LS_STORE_ID || '').trim();
  if (!storeId) return { plan: 'free', id };
  const seen = remembered.get(id);
  if (seen && seen.until > now) return { plan: seen.plan, id };
  let plan = 'free';
  try {
    const res = await deps.fetch(LS_VALIDATE, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ license_key: key }).toString(),
    });
    const j = await res.json();
    const meta = (j && j.meta) || {};
    const products = String(env.LS_PRODUCT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (j && j.valid === true && String(meta.store_id) === storeId && (!products.length || products.includes(String(meta.product_id)))) plan = 'pro';
  } catch (e) {
    return { plan: 'free', id }; // the licence server cannot be reached: not remembered, so the next request asks again
  }
  remembered.set(id, { plan, until: now + REMEMBER_MS });
  if (remembered.size > 5000) for (const [k, v] of remembered) if (v.until <= now) remembered.delete(k);
  return { plan, id };
}
