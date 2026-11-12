/*
 * Counters behind the reading allowances (a day for free readings, a calendar month for a Pro licence).
 * Two stores with the same two methods:
 *   get(key) -> number            add(key, delta, ttlSeconds) -> the new number
 */

/** Counters in memory: right for one Node process; they start again when it restarts. */
export class MemoryStore {
  constructor(now) {
    this.now = now || Date.now;
    this.map = new Map();
  }
  async get(key) {
    const e = this.map.get(key);
    return e && e.until > this.now() ? e.n : 0;
  }
  async add(key, delta, ttlSeconds) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || e.until <= t) e = { n: 0, until: t + ttlSeconds * 1000 };
    e.n = Math.max(0, e.n + delta);
    this.map.set(key, e);
    if (this.map.size > 20000) for (const [k, v] of this.map) if (v.until <= t) this.map.delete(k);
    return e.n;
  }
}

/** Counters in a Cloudflare KV namespace: shared by every copy of the Worker. */
export class KVStore {
  constructor(kv) { this.kv = kv; }
  async get(key) {
    const v = await this.kv.get(key);
    return v ? parseInt(v, 10) || 0 : 0;
  }
  async add(key, delta, ttlSeconds) {
    const n = Math.max(0, (await this.get(key)) + delta);
    await this.kv.put(key, String(n), { expirationTtl: Math.max(60, ttlSeconds) });
    return n;
  }
}
