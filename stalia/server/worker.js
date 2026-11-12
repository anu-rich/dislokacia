/*
 * Stalia on Cloudflare Workers: the document reader, the company spaces and — when the site has been built
 * into ./public — the site itself, all on one address.
 *
 * Secret:   ANTHROPIC_API_KEY (reading documents; without it the rest still works)
 * Bindings: DB      a D1 database: the company spaces. Without it the spaces are switched off.
 *           LIMITS  a KV namespace, so that the reading allowances hold across all copies of the Worker.
 *                   Without it the counters live in memory and are only approximate.
 *           ASSETS  the built site (see wrangler.toml). Pages are served from it; the API lives under /api.
 * Other settings are plain variables: see .env.example.
 */
import { createHandler } from './src/handler.js';
import { KVStore, MemoryStore } from './src/limits.js';
import { createSpaceApi } from './src/space.js';
import { d1Db } from './src/space-db.js';

const memory = new MemoryStore();
let handler = null, boundKv = null, boundDb = null;

export default {
  fetch(request, env) {
    // with the site on the same address everything outside /api is a page or a file of the site
    if (env.ASSETS && !/^\/api(\/|$)/.test(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
    const kv = env.LIMITS || null, d1 = env.DB || null;
    if (!handler || boundKv !== kv || boundDb !== d1) {
      boundKv = kv; boundDb = d1;
      const store = kv ? new KVStore(kv) : memory;
      handler = createHandler({ store, log: (o) => console.log(JSON.stringify(o)), space: d1 ? createSpaceApi({ db: d1Db(d1), store }) : undefined });
    }
    return handler(request, env, { ip: request.headers.get('cf-connecting-ip') || '', signal: request.signal });
  },
};
