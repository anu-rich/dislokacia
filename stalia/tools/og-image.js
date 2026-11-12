#!/usr/bin/env node
/*
 * Draws the link-preview images (assets/og-en.png, og-ru.png, og-kk.png, 1200 x 630):
 * what Telegram, WhatsApp, LinkedIn and others show when someone shares a link to the site.
 * Needs Playwright with Chromium. Run after changing the brand name or colours:
 *   node tools/og-image.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const V = require('../app/view.js');

const ROOT = path.resolve(__dirname, '..');
const HEAD = {
  en: ['Laytime and demurrage,', 'counted to the minute', 'Free online calculator · printable time sheet'],
  ru: ['Сталия и демередж —', 'с точностью до минуты', 'Бесплатный онлайн-калькулятор · таймшит для печати'],
  kk: ['Сталия мен демередж —', 'минутына дейін дәл', 'Тегін онлайн-калькулятор · баспа таймшиті'],
};

function page(lang) {
  const calc = M.examples(lang).find((x) => x.id === 'bulk').calc;
  const res = E.compute(calc);
  const h = HEAD[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="../assets/base.css"><link rel="stylesheet" href="../assets/site.css">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body { background: var(--paper); display: grid; grid-template-rows: 1fr auto; }
  .og { display: grid; grid-template-columns: 1.02fr 0.98fr; gap: 44px; padding: 56px 64px 40px; align-items: center; }
  .og b.w { font-family: var(--font-display); font-size: 44px; letter-spacing: 0.08em; display: block; margin-bottom: 26px; }
  .og h1 { font-family: var(--font-display); font-weight: 700; font-size: 74px; line-height: 0.98; text-transform: uppercase; letter-spacing: 0.01em; margin: 0; }
  .og .txt > p { font-size: 25px; color: var(--ink-2); margin-top: 26px; line-height: 1.35; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 22px; display: grid; gap: 18px; }
  .card .res-amount { font-size: 54px; }
  .card .res-label { font-size: 21px; }
  .card .res-sub { font-size: 17px; }
  .card .res-lines, .card .rp, .card .msgs, .card .tl-legend { display: none; }
  .card .tl-cap { font-size: 15px; } .card .tkl, .card .mk span { font-size: 13px; }
  .scale { height: 12px; }
</style></head><body>
<div class="og"><div class="txt"><b class="w">STALIA</b><h1>${V.esc(h[0])}<br>${V.esc(h[1])}</h1><p>${V.esc(h[2])}</p></div>
<div class="card">${V.summaryHTML(calc, res, lang)}${V.timelineHTML(res.ports[1], lang)}</div></div>
<div class="scale"></div></body></html>`;
}

(async () => {
  const browser = await chromium.launch();
  for (const lang of Object.keys(HEAD)) {
    const tmp = path.join(ROOT, 'tools', '.og-' + lang + '.html');
    fs.writeFileSync(tmp, page(lang));
    const p = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' });
    await p.goto('file://' + tmp);
    await p.evaluate(() => document.fonts.ready);
    if (!(await p.evaluate(() => document.fonts.check('700 40px "Fira Condensed"')))) throw new Error('fonts did not load');
    await p.screenshot({ path: path.join(ROOT, 'assets', 'og-' + lang + '.png') });
    await p.close();
    fs.unlinkSync(tmp);
    console.log('assets/og-' + lang + '.png');
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
