/* Copy of ../../app/license.js — do not edit here. Edit the original, then run: node tools/sync-server.js */
/*!
 * Stalia — Pro licence handling (browser + Node).
 *
 * Two kinds of keys unlock Pro:
 *  1. "STL1.<payload>.<signature>" — signed offline keys issued with tools/keygen
 *     (ECDSA P-256 / SHA-256). Verified locally, no network.
 *  2. Lemon Squeezy licence keys — activated and re-validated through the public
 *     Lemon Squeezy License API (no API key needed, CORS enabled).
 *
 * Without a key, Pro can be tried once for TRIAL_DAYS days: the trial is a date kept in this
 * browser's storage, starts when the user asks for it and cannot be started again.
 *
 * This is honest-user licensing: everything runs in the browser, so it keeps
 * honest customers honest and nothing more.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.StaliaLicense = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const PREFIX = 'STL1';
  const STORE_KEY = 'stalia.license.v1';
  const LS_API = 'https://api.lemonsqueezy.com/v1/licenses/';
  const HOUR = 3600 * 1000;
  const RECHECK_MS = 24 * HOUR;       // re-validate online keys once a day
  const GRACE_MS = 14 * 24 * HOUR;    // keep Pro this long if the licence server is unreachable
  const TRIAL_KEY = 'stalia.trial.v1';
  const TRIAL_DAYS = 14;
  const DAY = 24 * HOUR;

  // ------------------------------------------------------------ base64url / utf-8
  function b64uToBytes(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64u(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const utf8 = (s) => new TextEncoder().encode(s);
  const fromUtf8 = (b) => new TextDecoder().decode(b);

  const isOfflineKey = (k) => /^STL1\./.test(String(k || '').trim());

  /** Licence is valid through the whole `exp` day anywhere on Earth. */
  function expiryMs(exp) {
    const t = Date.parse(String(exp) + 'T23:59:59Z');
    return isNaN(t) ? NaN : t + 14 * HOUR;
  }

  /**
   * Verify a signed offline key.
   * @returns {Promise<{ok:boolean, error?:string, payload?:object}>}
   *   error: 'format' | 'no_crypto' | 'no_keys' | 'signature' | 'expired'
   */
  async function verifyOfflineKey(keyStr, publicKeys, nowMs) {
    const parts = String(keyStr || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'format' };
    let payload, sig;
    try {
      payload = JSON.parse(fromUtf8(b64uToBytes(parts[1])));
      sig = b64uToBytes(parts[2]);
    } catch (e) { return { ok: false, error: 'format' }; }
    if (!payload || typeof payload !== 'object' || sig.length !== 64) return { ok: false, error: 'format' };
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) return { ok: false, error: 'no_crypto' };
    if (!publicKeys || !publicKeys.length) return { ok: false, error: 'no_keys' };
    const data = utf8(parts[0] + '.' + parts[1]);
    let good = false;
    for (const jwk of publicKeys) {
      try {
        const key = await subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        if (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data)) { good = true; break; }
      } catch (e) { /* try the next key */ }
    }
    if (!good) return { ok: false, error: 'signature' };
    if (payload.exp) {
      const lim = expiryMs(payload.exp);
      if (isNaN(lim) || (nowMs == null ? Date.now() : nowMs) > lim) return { ok: false, error: 'expired', payload };
    }
    return { ok: true, payload };
  }

  function memoryStorage() {
    const m = {};
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
  }
  function safeStorage() {
    try {
      const ls = root.localStorage;
      ls.setItem('stalia.probe', '1'); ls.removeItem('stalia.probe');
      return ls;
    } catch (e) { return memoryStorage(); }
  }

  const NONE = { pro: false, type: null, status: 'none', licensee: '', plan: '', expires: null, error: null };

  /**
   * Licence manager.
   * @param {{config:object, storage?:object, fetch?:Function, now?:Function, instanceName?:string}} opts
   */
  function create(opts) {
    opts = opts || {};
    const cfg = opts.config || {};
    const storage = opts.storage || safeStorage();
    const now = opts.now || (() => Date.now());
    const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    const listeners = [];
    let state = Object.assign({}, NONE);

    const load = () => { try { return JSON.parse(storage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } };
    const save = (rec) => { try { rec ? storage.setItem(STORE_KEY, JSON.stringify(rec)) : storage.removeItem(STORE_KEY); } catch (e) { /* private mode */ } };
    const notify = () => { listeners.forEach((fn) => { try { fn(state); } catch (e) { /* listener error */ } }); };
    /** What the licence alone gives; a running trial fills in where it gives nothing. */
    let own = Object.assign({}, NONE);
    const set = (s) => { own = Object.assign({}, NONE, s); state = withTrial(own); notify(); return state; };

    // ---------------------------------------------------------- the free trial
    const trialDays = cfg.trialDays === 0 ? 0 : (Number(cfg.trialDays) > 0 ? Number(cfg.trialDays) : TRIAL_DAYS);
    const loadTrial = () => { try { const r = JSON.parse(storage.getItem(TRIAL_KEY) || 'null'); return r && r.startedAt > 0 ? r : null; } catch (e) { return null; } };
    /** The clock as the trial sees it: it never runs backwards, so setting the date back does not bring days back. */
    function trialNow(rec) {
      const t = now();
      if (!rec) return t;
      if (t > (rec.seenAt || 0) + HOUR) { rec.seenAt = t; try { storage.setItem(TRIAL_KEY, JSON.stringify(rec)); } catch (e) { /* private mode */ } }
      return Math.max(t, rec.seenAt || 0);
    }
    /**
     * @returns {{state:'off'|'available'|'active'|'ended', days:number, endsAt:(number|null), daysLeft:number}}
     *   'off' when this site gives no trial; daysLeft counts the day in progress (1 on the last day)
     */
    function trial() {
      if (!trialDays) return { state: 'off', days: 0, endsAt: null, daysLeft: 0 };
      const rec = loadTrial();
      if (!rec) return { state: 'available', days: trialDays, endsAt: null, daysLeft: trialDays };
      const endsAt = rec.startedAt + trialDays * DAY, left = endsAt - trialNow(rec);
      return left > 0 ? { state: 'active', days: trialDays, endsAt, daysLeft: Math.ceil(left / DAY) } : { state: 'ended', days: trialDays, endsAt, daysLeft: 0 };
    }
    /** The calendar day, where the user is, on which the trial ends. */
    const dateOf = (ms) => { const d = new Date(ms), two = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); };
    function withTrial(s) {
      if (s.pro) return s;
      const tr = trial();
      if (tr.state !== 'active') return s;
      return Object.assign({}, NONE, { pro: true, type: 'trial', status: 'trial', plan: 'trial', expires: dateOf(tr.endsAt) });
    }
    /**
     * Start the trial. One per browser, and only while no licence is active.
     * @returns {{ok:boolean, error?:'off'|'used'|'licensed'}}
     */
    function startTrial() {
      if (!trialDays) return { ok: false, error: 'off' };
      if (own.pro) return { ok: false, error: 'licensed' };
      if (loadTrial()) return { ok: false, error: 'used' };
      const t = now();
      try { storage.setItem(TRIAL_KEY, JSON.stringify({ startedAt: t, seenAt: t })); } catch (e) { /* private mode: the trial lasts for this visit */ }
      if (!loadTrial()) return { ok: false, error: 'off' };
      state = withTrial(own); notify();
      return { ok: true };
    }
    /** The state right now: a trial that ran out while the page was open stops counting as Pro. */
    function current() {
      if (state.type === 'trial' && trial().state !== 'active') { state = withTrial(own); notify(); }
      return state;
    }

    const lsCfg = () => cfg.lemonSqueezy || {};
    function lsMatches(meta) {
      const ls = lsCfg();
      if (!meta) return false;
      if (String(meta.store_id) !== String(ls.storeId)) return false;
      const ids = (ls.productIds || []).map(String);
      return !ids.length || ids.indexOf(String(meta.product_id)) >= 0;
    }
    async function lsCall(endpoint, params) {
      const res = await fetchFn(LS_API + endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* non-JSON body */ }
      return { status: res.status, json: json || {} };
    }
    const lsDate = (s) => (s ? String(s).slice(0, 10) : null);
    function lsState(rec, extra) {
      return Object.assign({
        pro: true, type: 'ls', status: 'active', licensee: rec.licensee || rec.email || '',
        plan: rec.product || 'Pro', expires: rec.expires || null, error: null,
      }, extra || {});
    }

    async function applyOffline(key) {
      const v = await verifyOfflineKey(key, cfg.licensePublicKeys || [], now());
      const p = v.payload || {};
      if (v.ok) return set({ pro: true, type: 'offline', status: 'active', licensee: p.n || '', plan: p.p || 'pro', expires: p.exp || null });
      return set({ pro: false, type: 'offline', status: v.error === 'expired' ? 'expired' : 'invalid', licensee: p.n || '', expires: p.exp || null, error: v.error });
    }

    /** Re-check an online (Lemon Squeezy) licence. Never throws. */
    async function revalidate(force) {
      const rec = load();
      if (!rec || rec.type !== 'ls') return state;
      if (!force && now() - (rec.checkedAt || 0) < RECHECK_MS) return state;
      if (!fetchFn) return state;
      try {
        const r = await lsCall('validate', { license_key: rec.key, instance_id: rec.instanceId });
        const lk = r.json.license_key || {};
        if (r.json.valid && lsMatches(r.json.meta)) {
          rec.checkedAt = now(); rec.expires = lsDate(lk.expires_at); rec.status = lk.status || 'active';
          save(rec);
          return set(lsState(rec));
        }
        if (r.status >= 500) throw new Error('server ' + r.status);
        rec.status = lk.status || 'invalid'; rec.checkedAt = now();
        save(rec);
        return set(lsState(rec, { pro: false, status: rec.status === 'expired' ? 'expired' : 'invalid', error: rec.status === 'expired' ? 'expired' : 'revoked' }));
      } catch (e) {
        if (now() - (rec.checkedAt || 0) < GRACE_MS) return set(lsState(rec, { status: 'grace' }));
        return set(lsState(rec, { pro: false, status: 'invalid', error: 'offline_too_long' }));
      }
    }

    /** Load the stored licence. Resolves with the state; online re-validation continues in the background. */
    async function init() {
      const rec = load();
      if (!rec) return set(NONE);
      if (rec.type === 'offline') return applyOffline(rec.key);
      if (rec.type === 'ls') {
        const stale = now() - (rec.checkedAt || 0);
        if (rec.status === 'expired' || rec.status === 'disabled' || rec.status === 'invalid') {
          set(lsState(rec, { pro: false, status: rec.status === 'expired' ? 'expired' : 'invalid', error: rec.status === 'expired' ? 'expired' : 'revoked' }));
        } else if (stale < GRACE_MS) set(lsState(rec, stale < RECHECK_MS ? null : { status: 'grace' }));
        else set(lsState(rec, { pro: false, status: 'invalid', error: 'offline_too_long' }));
        if (stale >= RECHECK_MS) revalidate(true); // background, intentionally not awaited
        return state;
      }
      return set(NONE);
    }

    /**
     * Activate a key typed by the user.
     * @returns {Promise<{ok:boolean, error?:string, detail?:string}>}
     */
    async function activate(keyStr) {
      const key = String(keyStr || '').trim().replace(/\s+/g, '');
      if (!key) return { ok: false, error: 'empty' };
      if (isOfflineKey(key)) {
        const v = await verifyOfflineKey(key, cfg.licensePublicKeys || [], now());
        if (!v.ok) return { ok: false, error: v.error };
        save({ type: 'offline', key });
        await applyOffline(key);
        return { ok: true };
      }
      const ls = lsCfg();
      if (!ls.enabled || !ls.storeId) return { ok: false, error: 'format' };
      if (!fetchFn) return { ok: false, error: 'network' };
      let r;
      try {
        const name = (opts.instanceName || 'Stalia web') + ' ' + new Date(now()).toISOString().slice(0, 10);
        r = await lsCall('activate', { license_key: key, instance_name: name });
      } catch (e) { return { ok: false, error: 'network' }; }
      const j = r.json;
      if (!j.activated) {
        const msg = String(j.error || '');
        if (r.status === 404) return { ok: false, error: 'not_found' };
        if (/activation limit/i.test(msg)) return { ok: false, error: 'limit', detail: msg };
        if (/expired/i.test(msg)) return { ok: false, error: 'expired', detail: msg };
        if (/disabled/i.test(msg)) return { ok: false, error: 'revoked', detail: msg };
        return { ok: false, error: r.status >= 500 ? 'network' : 'rejected', detail: msg };
      }
      const inst = j.instance || {};
      if (!lsMatches(j.meta)) {
        // A key from another shop or product: release the seat we just took and refuse.
        try { await lsCall('deactivate', { license_key: key, instance_id: inst.id }); } catch (e) { /* best effort */ }
        return { ok: false, error: 'wrong_product' };
      }
      const lk = j.license_key || {}, meta = j.meta || {};
      const rec = {
        type: 'ls', key, instanceId: inst.id, status: lk.status || 'active', expires: lsDate(lk.expires_at),
        licensee: meta.customer_name || '', email: meta.customer_email || '',
        product: [meta.product_name, meta.variant_name].filter(Boolean).join(' — '), checkedAt: now(),
      };
      save(rec);
      set(lsState(rec));
      return { ok: true };
    }

    /** Remove the licence from this browser (and free the Lemon Squeezy activation seat). */
    async function remove() {
      const rec = load();
      if (rec && rec.type === 'ls' && fetchFn && rec.instanceId) {
        try { await lsCall('deactivate', { license_key: rec.key, instance_id: rec.instanceId }); } catch (e) { /* offline */ }
      }
      save(null);
      return set(NONE);
    }

    return {
      init, activate, remove, revalidate, trial, startTrial,
      get: current,
      onChange: (fn) => { listeners.push(fn); },
      storedKey: () => { const r = load(); return r ? r.key : ''; },
    };
  }

  return { PREFIX, STORE_KEY, TRIAL_KEY, TRIAL_DAYS, create, verifyOfflineKey, isOfflineKey, b64uToBytes, bytesToB64u, memoryStorage, expiryMs };
});
