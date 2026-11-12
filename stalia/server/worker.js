/*
 * Stalia reading server on Cloudflare Workers.
 *
 * Secret:   ANTHROPIC_API_KEY
 * Optional: a KV namespace bound as LIMITS, so that the daily limits hold across all copies of the Worker.
 *           Without it the counters live in memory and are only approximate.
 * Other settings are plain variables: see .env.example.
 */
import { createHandler } from './src/handler.js';
import { KVStore, MemoryStore } from './src/limits.js';

const memory = new MemoryStore();
let handler = null, boundTo = null;

export default {
  fetch(request, env, context) {
    const kv = env.LIMITS || null;
    if (!handler || boundTo !== kv) {
      boundTo = kv;
      handler = createHandler({ store: kv ? new KVStore(kv) : memory, log: (o) => console.log(JSON.stringify(o)) });
    }
    return handler(request, env, { ip: request.headers.get('cf-connecting-ip') || '', signal: request.signal });
  },
};
