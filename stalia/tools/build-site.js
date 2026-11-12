#!/usr/bin/env node
/*
 * Puts everything a web server may hand out into server/public: the site, the calculator and their assets,
 * and nothing else of this folder (no keys, no tools, no tests, no app builds).
 *
 *   node tools/build-site.js
 *
 * The server in server/ serves that folder next to its own API under /api, so one address is the site,
 * the calculator, the document reader and the company space. In the copy of app/config.js the reader and
 * the space point at "/api" unless config.js already names another server.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'server', 'public');
/** The only things that are published. */
const INCLUDE = ['index.html', 'privacy.html', 'terms.html', 'robots.txt', 'sitemap.xml', 'app', 'assets', 'guides', 'zh', 'ru', 'kk', 'uk', 'tr', 'el'];
const SAME_SERVER = '\n;(function () { var c = typeof STALIA_CONFIG !== "undefined" && STALIA_CONFIG; if (!c) return; ' +
  'c.ai = c.ai || {}; if (!c.ai.endpoint) c.ai.endpoint = "/api"; c.space = c.space || {}; if (!c.space.endpoint) c.space.endpoint = "/api"; })();\n';

function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (!name.startsWith('.')) copy(path.join(from, name), path.join(to, name));
  } else if (st.isFile()) fs.copyFileSync(from, to);
}

function build(out) {
  out = out || OUT;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let files = 0;
  for (const name of INCLUDE) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) continue;
    copy(from, path.join(out, name));
    files++;
  }
  const cfg = path.join(out, 'app', 'config.js');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8') + SAME_SERVER);
  return { out, entries: files };
}

module.exports = { build, INCLUDE };

if (require.main === module) {
  const r = build();
  console.log('Site written to ' + path.relative(ROOT, r.out) + ' (' + r.entries + ' entries). Start it with:  cd server && npm start');
}
