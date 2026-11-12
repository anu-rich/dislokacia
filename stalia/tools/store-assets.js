#!/usr/bin/env node
/*
 * Draws what a store listing asks for (Google Play): the 512 px icon, the 1024 x 500 feature graphic and
 * phone screenshots 1080 x 1920 — taken from the very bundle that goes into the app, with the built-in example.
 * Needs Playwright with Chromium.   node tools/store-assets.js   ->  marketing/play/
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const V = require('../app/view.js');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'mobile', 'www');
const OUT = path.join(ROOT, 'marketing', 'play');
const LANGS = ['en', 'ru'];
const HEAD = {
  en: ['Laytime and demurrage,', 'counted to the minute', 'Time sheet · PDF, Word, Excel · reads your documents', 60],
  ru: ['Сталия и демередж —', 'с точностью до минуты', 'Таймшит · PDF, Word, Excel · читает ваши документы', 50],
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

function feature(lang) {
  const calc = M.examples(lang).find((x) => x.id === 'bulk').calc, res = E.compute(calc), h = HEAD[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="../assets/base.css"><link rel="stylesheet" href="../assets/site.css">
<style>
  html, body { margin: 0; width: 1024px; height: 500px; overflow: hidden; }
  body { background: var(--paper); display: grid; grid-template-rows: 1fr auto; }
  .og { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 36px; padding: 40px 52px 30px; align-items: center; }
  .og b.w { font-family: var(--font-display); font-size: 36px; letter-spacing: 0.08em; display: block; margin-bottom: 20px; }
  .og h1 { font-family: var(--font-display); font-weight: 700; font-size: 60px; line-height: 0.98; text-transform: uppercase; letter-spacing: 0.01em; margin: 0; }
  .og .txt > p { font-size: 20px; color: var(--ink-2); margin-top: 20px; line-height: 1.35; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 18px; display: grid; gap: 14px; }
  .card .res-amount { font-size: 44px; } .card .res-label { font-size: 17px; } .card .res-sub { font-size: 14px; }
  .card .res-lines, .card .rp, .card .msgs, .card .tl-legend { display: none; }
  .card .tl-cap { font-size: 13px; } .card .tkl, .card .mk span { font-size: 11px; }
  .scale { height: 10px; }
</style></head><body>
<div class="og"><div class="txt"><b class="w">STALIA</b><h1 style="font-size:${h[3]}px">${V.esc(h[0])}<br>${V.esc(h[1])}</h1><p>${V.esc(h[2])}</p></div>
<div class="card">${V.summaryHTML(calc, res, lang)}${V.timelineHTML(res.ports[1], lang)}</div></div>
<div class="scale"></div></body></html>`;
}

(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'mobile', 'scripts', 'build-web.js')], { stdio: 'ignore' });
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(WWW, p), (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();

  // icon and feature graphic
  // the icon through a canvas: that gives the 32-bit PNG (with an alpha channel) the store asks for
  const icon = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const png = await icon.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, 512, 512);
    return c.toDataURL('image/png').split(',')[1];
  }, 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'icons', 'store-icon-1024.png')).toString('base64'));
  fs.writeFileSync(path.join(OUT, 'icon-512.png'), Buffer.from(png, 'base64'));
  await icon.close();
  for (const lang of LANGS) {
    const tmp = path.join(ROOT, 'tools', '.feature-' + lang + '.html');
    fs.writeFileSync(tmp, feature(lang));
    const p = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1, colorScheme: 'light' });
    await p.goto('file://' + tmp);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(OUT, 'feature-' + lang + '.png') });
    await p.close();
    fs.unlinkSync(tmp);
  }

  // phone screenshots: 360 x 640 at three device pixels = 1080 x 1920
  for (const lang of LANGS) {
    const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, name + '-' + lang + '.png') }); console.log('marketing/play/' + name + '-' + lang + '.png'); };
    const open = async (firstVisit) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, colorScheme: 'light', locale: lang === 'ru' ? 'ru-RU' : 'en-US' });
      await ctx.addInitScript(([l, seen]) => {
        try { localStorage.setItem('stalia.lang', JSON.stringify(l)); if (seen) localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ }
        // a stand-in for the phone: the app then shows what it shows on a phone
        window.Capacitor = { PluginHeaders: [{ name: 'StaliaPrint' }, { name: 'StaliaShare' }], nativePromise: () => Promise.resolve({}) };
      }, [lang, !firstVisit]);
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      return page;
    };
    const page = await open(false);
    await shot(page, '1-result');
    await page.evaluate(() => document.querySelector('#actions').scrollIntoView({ block: 'center' }));
    await shot(page, '2-word-excel');
    await page.evaluate(() => { const s = document.querySelector('#sheet-sec'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 8); });
    await shot(page, '3-time-sheet');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#actions [data-act="statement"]');
    await page.evaluate(() => { const el = document.querySelector('#statement'); el.scrollTop = document.querySelector('#st-paper').offsetTop - 8; });
    await shot(page, '4-statement');
    await page.click('[data-act="st-close"]');

    // "From documents": the sample pages, one of them with a name blacked out
    await page.click('.bar [data-act="imp-open"]');
    const add = async (doc, files) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.imp-slot[data-doc="' + doc + '"] [data-act="imp-add"]')]);
      await chooser.setFiles(files.map((f) => path.join(ROOT, 'samples', f)));
      await page.waitForFunction(() => !window.__stalia.imp._state.busy);
    };
    await add('cp', ['charter-party-recap.pdf']);
    await add('sof', ['sof-novorossiysk.png', 'sof-alexandria.jpg']);
    await page.evaluate(() => { document.querySelector('#import').scrollTop = 0; });
    await shot(page, '5-documents');
    await page.locator('.imp-slot[data-doc="cp"] .imp-thumb').first().click();
    await page.waitForSelector('#rd-page img');
    await page.waitForTimeout(400);
    const box = await page.locator('#rd-page').boundingBox();
    for (const r of [[0.12, 0.14, 0.62, 0.19], [0.12, 0.30, 0.5, 0.335]]) {
      await page.mouse.move(box.x + box.width * r[0], box.y + box.height * r[1]);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * r[2], box.y + box.height * r[3], { steps: 6 });
      await page.mouse.up();
    }
    await shot(page, '6-black-out');
    await page.context().close();

    const first = await open(true);
    await shot(first, '7-languages');
    await first.context().close();
  }
  await browser.close();
  server.close();
  console.log('marketing/play/icon-512.png, feature-en.png, feature-ru.png');
})().catch((e) => { console.error(e); process.exit(1); });
