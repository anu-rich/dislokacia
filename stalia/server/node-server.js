#!/usr/bin/env node
/*
 * Stalia reading server for any Node host (a VPS, Render, Railway …).
 *
 *   ANTHROPIC_API_KEY=sk-ant-… node node-server.js
 *
 * Settings come from the environment or from a ".env" file next to this script (see .env.example).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, settings } from './src/handler.js';
import { MemoryStore } from './src/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** KEY=value lines of ".env"; variables already set in the environment win. */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function start(env, options) {
  options = options || {};
  const handle = createHandler(Object.assign({ store: new MemoryStore(), log: (o) => console.log(JSON.stringify(o)) }, options.deps || {}));
  const trustProxy = env.TRUST_PROXY === '1';
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); }); // the person closed the page: stop paying for the reading
    try {
      const max = settings(env).maxBodyBytes;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > max) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"too_big"}'); req.destroy(); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      // Behind a proxy (Render, nginx) the caller's address is in X-Forwarded-For; without one that header could be forged.
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const response = await handle(request, env, { ip: forwarded || req.socket.remoteAddress || '', signal: abort.signal });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"server"}');
    }
  });
  server.requestTimeout = 10 * 60 * 1000; // reading many pages takes a while
  return new Promise((resolve) => {
    server.listen(options.port != null ? options.port : (parseInt(env.PORT, 10) || 8787), options.host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(path.join(here, '.env'));
  const cfg = settings(process.env);
  start(process.env).then((server) => {
    console.log('Stalia reading server is listening on port ' + server.address().port);
    console.log(cfg.apiKey ? 'Models: ' + cfg.model + ' (Pro), ' + cfg.modelFree + ' (free) · free ' + cfg.freePerDay + ' a day per visitor · Pro ' + cfg.proPerMonth + ' a month per licence'
      : 'ANTHROPIC_API_KEY is not set: the server answers, but reading is switched off.');
    if (!cfg.origins.length) console.log('ALLOWED_ORIGINS is empty: any site may call this server. Set it to the address of your site.');
  });
}
