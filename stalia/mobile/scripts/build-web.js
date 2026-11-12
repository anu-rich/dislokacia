#!/usr/bin/env node
/*
 * Builds mobile/www — the copy of the calculator that goes inside the Android / iOS app.
 * The app screen becomes the root page; nothing is fetched from the internet at run time.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'www');
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of ['app.css', 'engine.js', 'license.js', 'i18n.js', 'model.js', 'view.js', 'app.js']) copy(path.join(ROOT, 'app', f), path.join(OUT, f));
copy(path.join(ROOT, 'assets', 'base.css'), path.join(OUT, 'assets', 'base.css'));
copy(path.join(ROOT, 'assets', 'favicon.svg'), path.join(OUT, 'assets', 'favicon.svg'));
for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) copy(path.join(ROOT, 'assets', 'fonts', f), path.join(OUT, 'assets', 'fonts', f));

// config: same settings as the site, plus the two switches of the packaged app
const cfg = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
fs.writeFileSync(path.join(OUT, 'config.js'), cfg +
  '\n// added by mobile/scripts/build-web.js\n' +
  ';(function () { var c = typeof STALIA_CONFIG !== "undefined" && STALIA_CONFIG; if (c) { c.native = true; c.store = true; } })();\n');

// page: assets move next to it; web-only tags (manifest, canonical, CSP) are dropped —
// Capacitor injects its bridge as an inline script, which a strict CSP would block.
let html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
html = html
  .replace(/(href|src)="\.\.\/assets\//g, '$1="assets/')
  .replace(/^<link rel="(canonical|manifest|apple-touch-icon)"[^>]*>\n/gm, '')
  .replace(/^<meta http-equiv="Content-Security-Policy"[^>]*>\n/gm, '')
  .replace(/^<meta name="(mobile-web-app-capable|apple-mobile-web-app-[a-z-]+)"[^>]*>\n/gm, '');
if (/\.\.\//.test(html.replace(/href="\.\.\/"/g, ''))) throw new Error('index.html still points outside the bundle');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(OUT);
const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log('www: ' + files.length + ' files, ' + Math.round(bytes / 1024) + ' KB');
