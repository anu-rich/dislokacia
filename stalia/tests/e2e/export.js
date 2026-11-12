#!/usr/bin/env node
/*
 * End-to-end test of the editable exports and of sharing by link, in a real browser (needs Playwright + Chromium).
 *   node tests/e2e/export.js
 * Covers: Word and Excel downloads from the result and from the statement, the statement language, the Pro
 * letterhead (a WebP logo included), "Send link" on a phone, the invitation into the app for somebody who opened
 * a shared link, and the phone app itself — simulated: the same page with the native switches on and a stand-in
 * for the bridge to the phone.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const K = require('../../tools/keygen.js');
const { unzip, textOf } = require('../helpers/zip.js');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const kp = K.generateKeyPair();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-export-'));
const baseCfg = path.join(tmp, 'config.js');
fs.copyFileSync(path.join(ROOT, 'app', 'config.js'), baseCfg);
K.writeConfigKeys([kp.publicJwk], baseCfg);
const PRO_KEY = K.issueKey(kp.privatePem, { name: 'E2E Shipping LLP', exp: '2099-12-31' });
/** A copy of the settings with a few of them changed, as a later script in the same file. */
function variant(name, patch) {
  const file = path.join(tmp, name + '.js');
  fs.writeFileSync(file, fs.readFileSync(baseCfg, 'utf8') + '\n;(function () { var c = STALIA_CONFIG; ' + patch + ' })();\n');
  return file;
}
const PLAY = 'https://play.google.com/store/apps/details?id=app.stalia.laytime';
const CONFIGS = {
  site: baseCfg,
  store: variant('store', 'c.apps = { android: ' + JSON.stringify(PLAY) + ', ios: "" };'),
  app: variant('app', 'c.native = true; c.store = true;'),
  appWithSite: variant('app-site', 'c.native = true; c.store = true; c.siteUrl = "https://stalia.example";'),
};

function serve(cfg) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = p === '/app/config.js' ? cfg : path.join(ROOT, p);
    if (!file.startsWith(ROOT) && file !== cfg) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failures.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
const plain = (xml) => xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

(async () => {
  const servers = {}, base = {};
  for (const k of Object.keys(CONFIGS)) { servers[k] = await serve(CONFIGS[k]); base[k] = 'http://127.0.0.1:' + servers[k].address().port; }
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (opts, init) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 }, locale: 'en-US', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }, opts || {}));
    await ctx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } });
    if (init) await ctx.addInitScript(init.fn, init.arg);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    return page;
  };
  const text = async (page, sel) => norm(await page.locator(sel).first().innerText());
  const grab = async (page, selector) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
    return { name: dl.suggestedFilename(), files: unzip(new Uint8Array(fs.readFileSync(await dl.path()))) };
  };

  // ------------------------------------------------------------------ the site, free
  console.log('Word and Excel from the result');
  const page = await newPage();
  await page.goto(base.site + '/app/', { waitUntil: 'networkidle' });
  const acts = await page.locator('#actions [data-act]').evaluateAll((els) => els.map((e) => e.dataset.act));
  check('the result offers Word and Excel next to the statement', acts.join(',').indexOf('statement,word,excel') === 0, acts.join(','));
  check('a computer gets "Copy link", not the phone\'s share sheet', acts.indexOf('share') > 0 && acts.indexOf('send-link') < 0, acts.join(','));
  const w = await grab(page, '#actions [data-act="word"]');
  const doc = plain(textOf(w.files, 'word/document.xml'));
  check('Word: a .docx named after the calculation', /^stalia-wheat-novorossiysk-to-alexandria\.docx$/.test(w.name), w.name);
  check('Word: the statement — title, vessel, time sheet, result', /Laytime statement/.test(doc) && /MV EXAMPLE TRADER/.test(doc) && /Rain — loading suspended/.test(doc) && /Demurrage due to Owners\s*USD 23,841\.93/.test(doc.replace(/\n/g, ' ')), doc.slice(0, 200));
  check('Word: the free version says so in the footer, with the site', /Prepared with Stalia \(free version\) · 127\.0\.0\.1:\d+/.test(textOf(w.files, 'word/footer1.xml')));
  const x = await grab(page, '#actions [data-act="excel"]');
  const sheet = textOf(x.files, 'xl/worksheets/sheet1.xml');
  check('Excel: an .xlsx named after the calculation', /^stalia-wheat-novorossiysk-to-alexandria\.xlsx$/.test(x.name), x.name);
  check('Excel: the result is a formula with its value stored', /<f>ABS\(ROUND\(.*?\)\)<\/f><v>23841\.93<\/v>/.test(sheet) && /fullCalcOnLoad="1"/.test(textOf(x.files, 'xl/workbook.xml')));
  check('Excel: the hint about yellow cells is there', /Yellow cells are yours to change/.test(textOf(x.files, 'xl/sharedStrings.xml')));

  // an edit in the form reaches the next export
  await page.fill('#f-demurrageRate', '20000');
  await page.waitForFunction(() => /32,885\.42/.test(document.querySelector('#summary').textContent));
  const x2 = await grab(page, '#actions [data-act="excel"]');
  check('Excel follows the form: a new rate, a new result', /<v>32885\.42<\/v>/.test(textOf(x2.files, 'xl/worksheets/sheet1.xml')) && /<v>20000<\/v>/.test(textOf(x2.files, 'xl/worksheets/sheet1.xml')));
  await page.fill('#f-demurrageRate', '14500');
  await page.waitForFunction(() => /23,841\.93/.test(document.querySelector('#summary').textContent));

  console.log('from the statement, in its language');
  await page.click('#actions [data-act="statement"]');
  check('the statement bar has Word and Excel beside Print', await page.locator('#btn-word').isVisible() && await page.locator('#btn-excel').isVisible());
  await page.selectOption('#st-lang', 'ru');
  const wr = await grab(page, '#btn-word');
  const xr = await grab(page, '#btn-excel');
  check('Word in the statement language', /Расчёт сталийного времени/.test(plain(textOf(wr.files, 'word/document.xml'))) && /Демередж в пользу судовладельца/.test(plain(textOf(wr.files, 'word/document.xml'))));
  check('Excel in the statement language', /Жёлтые ячейки/.test(textOf(xr.files, 'xl/sharedStrings.xml')) && /<sheet name="Таймшит"/.test(textOf(xr.files, 'xl/workbook.xml')));
  await page.click('[data-act="st-close"]');

  console.log('an unfinished calculation');
  await page.click('.bar [data-act="new"]');
  check('Word and Excel wait for a result', await page.locator('#actions [data-act="word"]').isDisabled() && await page.locator('#actions [data-act="excel"]').isDisabled());
  await page.click('#toast button');
  await page.waitForFunction(() => /23,841\.93/.test(document.querySelector('#summary').textContent));

  // ------------------------------------------------------------------ Pro letterhead
  console.log('Pro: letterhead and logo');
  await page.click('#lic');
  await page.fill('#lic-key', PRO_KEY);
  await page.click('[data-act="lic-activate"]');
  await page.waitForFunction(() => /E2E Shipping LLP/.test(document.querySelector('#dlg').textContent));
  await page.click('[data-act="dlg-close"]');
  // a WebP logo, as a customer might upload: Word and Excel cannot show WebP, so it has to arrive as PNG
  await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 40;
    const g = c.getContext('2d'); g.fillStyle = '#0f4c81'; g.fillRect(0, 0, 120, 40);
    const logo = c.toDataURL('image/webp');
    if (!/^data:image\/webp/.test(logo)) throw new Error('this browser cannot make WebP');
    localStorage.setItem('stalia.brand.v1', JSON.stringify({ company: 'Northwind Chartering Ltd.', details: 'Quay 1\nops@northwind.example', logo }));
  });
  const wp = await grab(page, '#actions [data-act="word"]');
  const xp = await grab(page, '#actions [data-act="excel"]');
  const png = (b) => b && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  check('Pro Word: company on top, no “free version” line', /Northwind Chartering Ltd\./.test(plain(textOf(wp.files, 'word/document.xml'))) && !/Prepared with Stalia/.test(textOf(wp.files, 'word/footer1.xml')));
  check('Pro Word: the WebP logo went in as PNG', png(wp.files['word/media/image1.png']) && /<a:blip r:embed="rId3"\/>/.test(textOf(wp.files, 'word/document.xml')));
  check('Pro Excel: company, logo, no “free version” line', /Northwind Chartering Ltd\./.test(textOf(xp.files, 'xl/sharedStrings.xml')) && png(xp.files['xl/media/image1.png']) && !/Prepared with Stalia/.test(textOf(xp.files, 'xl/sharedStrings.xml')));
  await page.context().close();

  // ------------------------------------------------------------------ a phone browser: the share sheet
  console.log('a phone: sending the link');
  const stubShare = { fn: () => { window.__shared = []; navigator.share = (d) => { window.__shared.push(d); return Promise.resolve(); }; } };
  const phone = await newPage(Object.assign({}, devices['Pixel 7']), stubShare);
  await phone.goto(base.site + '/app/', { waitUntil: 'networkidle' });
  check('a phone gets "Send link" as well as "Copy link"', await phone.locator('#actions [data-act="send-link"]').isVisible() && await phone.locator('#actions [data-act="share"]').isVisible());
  await phone.waitForFunction(() => !!window.__stalia.state.shareHash);
  await phone.click('#actions [data-act="send-link"]');
  const sent = await phone.evaluate(() => window.__shared[0]);
  check('"Send link" opens the share sheet with the link and a title', !!sent && /\/app\/#c=[zj][A-Za-z0-9_-]+$/.test(sent.url) && sent.title === 'Laytime calculation: Wheat, Novorossiysk to Alexandria', JSON.stringify(sent).slice(0, 160));
  check('phone: the buttons do not widen the page', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await phone.click('#actions [data-act="statement"]');
  check('phone: the statement bar still fits', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth) && await phone.locator('#btn-word').isVisible());
  await phone.click('[data-act="st-close"]');
  // the instruction names the buttons that are really there
  await phone.click('.bar [data-act="help"]');
  const help = await text(phone, '#help');
  check('the instruction mentions Word, Excel and "Send link"', /“Word” and “Excel” save the same statement/.test(help) && /“Send link” sends it to a colleague/.test(help), help.slice(-300));
  await phone.click('#help [data-act="help-close"]');

  // the receiver: a browser on an Android phone, the app is in the store
  const link = sent.url.replace(base.site, base.store);
  const got = await newPage(Object.assign({}, devices['Pixel 7']));
  await got.goto(link, { waitUntil: 'networkidle' });
  check('the receiver sees the calculation', /USD 23,841\.93/.test(await text(got, '#summary')) && /shared link/i.test(await text(got, '#banner')));
  const href = await got.locator('#banner a.btn').getAttribute('href').catch(() => '');
  check('…and a button that opens it in the app, or the store if the app is not there',
    /^intent:\/\/c\/[zj][A-Za-z0-9_-]+#Intent;scheme=stalia;package=app\.stalia\.laytime;S\.browser_fallback_url=https%3A%2F%2Fplay\.google\.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dapp\.stalia\.laytime;end$/.test(href || '') &&
    /Open in the app/.test(await text(got, '#banner')), String(href).slice(0, 120));
  check('the code in that button is the calculation itself', (href || '').indexOf('intent://c/' + link.split('#c=')[1] + '#Intent') === 0);
  await got.context().close();
  // without a store address the receiver is offered the installable web app instead
  const got2 = await newPage(Object.assign({}, devices['Pixel 7']));
  await got2.goto(sent.url, { waitUntil: 'networkidle' });
  check('no app in the store yet: "Install app" in the banner', await got2.locator('#banner [data-act="install"]').isVisible() && (await got2.locator('#banner a.btn').count()) === 0);
  await got2.context().close();
  await phone.context().close();

  // ------------------------------------------------------------------ the phone app (simulated bridge)
  console.log('the phone app');
  const bridge = {
    fn: (launch) => {
      window.__calls = [];
      window.Capacitor = {
        PluginHeaders: [{ name: 'StaliaPrint' }, { name: 'StaliaShare' }],
        nativePromise: (plugin, method, args) => {
          window.__calls.push({ plugin, method, args });
          return Promise.resolve(plugin === 'StaliaShare' && method === 'launchUrl' ? { url: launch || '' } : {});
        },
      };
    },
  };
  const app = await newPage(Object.assign({}, devices['Pixel 7']), bridge);
  await app.goto(base.app + '/app/', { waitUntil: 'networkidle' });
  const appActs = await app.locator('#actions [data-act]').evaluateAll((els) => els.map((e) => e.dataset.act));
  check('the app offers Word and Excel', appActs.indexOf('word') > 0 && appActs.indexOf('excel') > 0, appActs.join(','));
  check('without a site address the app offers no links', appActs.indexOf('send-link') < 0 && appActs.indexOf('share') < 0, appActs.join(','));
  await app.click('#actions [data-act="excel"]');
  await app.waitForFunction(() => window.__calls.some((c) => c.method === 'file'));
  const call = await app.evaluate(() => window.__calls.find((c) => c.method === 'file'));
  const shared = unzip(new Uint8Array(Buffer.from(call.args.data, 'base64')));
  check('Excel goes to the share sheet as a real .xlsx', call.plugin === 'StaliaShare' && /\.xlsx$/.test(call.args.name) && call.args.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && !!shared['xl/worksheets/sheet1.xml']);
  check('the app\'s documents carry no made-up site address', !/localhost|127\.0\.0\.1/.test(textOf(shared, 'xl/sharedStrings.xml')) && /Prepared with Stalia \(free version\)/.test(textOf(shared, 'xl/sharedStrings.xml')));
  await app.context().close();

  const code = sent.url.split('#c=')[1];
  const app2 = await newPage(Object.assign({}, devices['Pixel 7']), { fn: bridge.fn, arg: 'stalia://c/' + code });
  await app2.goto(base.appWithSite + '/app/', { waitUntil: 'networkidle' });
  check('the app opened by a link shows that calculation', /USD 23,841\.93/.test(await text(app2, '#summary')) && /shared link/i.test(await text(app2, '#banner')), await text(app2, '#banner'));
  check('…and does not advertise itself inside itself', (await app2.locator('#banner [data-act="install"]').count()) === 0 && (await app2.locator('#banner a.btn').count()) === 0);
  await app2.waitForFunction(() => !!window.__stalia.state.shareHash);
  await app2.click('#actions [data-act="send-link"]');
  const out = await app2.evaluate(() => window.__calls.find((c) => c.method === 'text'));
  check('with a site address the app sends links to the site', !!out && /^Laytime calculation: .*\nhttps:\/\/stalia\.example\/app\/#c=[zj][A-Za-z0-9_-]+$/.test(out.args.text), out && out.args.text.slice(0, 120));
  // a second link arrives while the app is open, on top of work in progress
  await app2.fill('#f-name', 'My own work');
  await app2.evaluate((c) => { const e = new Event('staliaLink'); e.url = 'stalia://c/' + c; window.dispatchEvent(e); }, code);
  await app2.waitForFunction(() => document.querySelector('#f-name').value !== 'My own work');
  check('a link arriving later opens too, and what was on screen can be brought back', /Calculation opened from a link/.test(await text(app2, '#toast')) && await app2.locator('#toast button').isVisible());
  await app2.click('#toast button');
  check('Undo brings the work back', (await app2.inputValue('#f-name')) === 'My own work');
  await app2.evaluate(() => { const e = new Event('staliaLink'); e.url = 'stalia://c/not-a-calculation'; window.dispatchEvent(e); });
  await app2.waitForTimeout(300);
  check('a link that carries nothing changes nothing', (await app2.inputValue('#f-name')) === 'My own work');
  await app2.context().close();

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  for (const k of Object.keys(servers)) servers[k].close();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
