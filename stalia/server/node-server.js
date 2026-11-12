#!/usr/bin/env node
/*
 * Stalia server for any Node host (a VPS, Render, Railway …): it reads documents with Claude, keeps the
 * company spaces, and — when the site has been built into ./public — hands out the site itself.
 *
 *   ANTHROPIC_API_KEY=sk-ant-… node node-server.js
 *
 * With ./public present (node ../tools/build-site.js) one address is everything: the pages at "/", the API
 * at "/api". Without it the server is the API alone, at "/", as before.
 * The spaces live in an SQLite file: SPACE_DB (default ./data/space.db; "off" switches the spaces off).
 * It must be on a disk that survives restarts.
 * Settings come from the environment or from a ".env" file next to this script (see .env.example).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, settings } from './src/handler.js';
import { MemoryStore } from './src/limits.js';
import { createSpaceApi } from './src/space.js';
import { sqliteDb } from './src/space-db.js';

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

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
/** A file of the built site for this address, or null. Nothing outside `root` can be reached. */
function siteFile(root, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
  if (rel.includes('\0') || rel.split('/').some((part) => part === '..' || part.startsWith('.'))) return null;
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return null;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    return fs.statSync(file).isFile() ? file : null;
  } catch (e) { return null; }
}

export async function start(env, options) {
  options = options || {};
  const deps = Object.assign({ store: new MemoryStore(), log: (o) => console.log(JSON.stringify(o)) }, options.deps || {});
  if (!deps.space && env.SPACE_DB !== 'off') {
    // the company spaces: an SQLite file on this server's disk
    const file = env.SPACE_DB || path.join(here, 'data', 'space.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    deps.space = createSpaceApi({ db: sqliteDb(DatabaseSync, file), store: deps.store, now: deps.now, fetch: deps.fetch });
  }
  const handle = createHandler(deps);
  const trustProxy = env.TRUST_PROXY === '1';
  const pub = env.STATIC_DIR === 'off' ? '' : path.resolve(here, env.STATIC_DIR || 'public');
  const site = pub && fs.existsSync(path.join(pub, 'index.html')) ? pub : '';
  const server = http.createServer(async (req, res) => {
    if (site && (req.method === 'GET' || req.method === 'HEAD') && !/^\/api(\/|$|\?)/.test(req.url)) {
      const file = siteFile(site, new URL(req.url, 'http://localhost').pathname);
      if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
      return;
    }
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
  server.site = site;
  return new Promise((resolve) => {
    server.listen(options.port != null ? options.port : (parseInt(env.PORT, 10) || 8787), options.host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile(path.join(here, '.env'));
  const cfg = settings(process.env);
  start(process.env).then((server) => {
    console.log('Stalia server is listening on port ' + server.address().port + (server.site ? ': the site at /, the API at /api' : ': the API only (run "node ../tools/build-site.js" to serve the site too)'));
    console.log(process.env.SPACE_DB === 'off' ? 'Company spaces are switched off.' : 'Company spaces are kept in ' + (process.env.SPACE_DB || path.join(here, 'data', 'space.db')));
    console.log(cfg.apiKey ? 'Models: ' + cfg.model + ' (Pro), ' + cfg.modelFree + ' (free) · free ' + cfg.freePerDay + ' a day per visitor · Pro ' + cfg.proPerMonth + ' a month per licence'
      : 'ANTHROPIC_API_KEY is not set: the server answers, but reading is switched off.');
    if (!cfg.origins.length) console.log('ALLOWED_ORIGINS is empty: any site may call this server. Set it to the address of your site.');
  });
}
