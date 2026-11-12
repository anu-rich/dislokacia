#!/usr/bin/env node
/*
 * End-to-end smoke test of the calculator in a real browser (needs Playwright + Chromium).
 *   node tests/e2e/smoke.js            run all checks
 *   SHOTS=/some/dir node tests/e2e/smoke.js   also save screenshots and a PDF there
 * It starts its own static server and uses a throw-away licence key pair, so it never touches real keys.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const K = require('../../tools/keygen.js');
const I = require('../../app/i18n.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SHOTS || '';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.png': 'image/png' };

const kp = K.generateKeyPair();
const tmpCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-e2e-')), 'config.js');
fs.copyFileSync(path.join(ROOT, 'app', 'config.js'), tmpCfg);
K.writeConfigKeys([kp.publicJwk], tmpCfg);
const PRO_KEY = K.issueKey(kp.privatePem, { name: 'E2E Shipping LLP', exp: '2099-12-31' });

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = p === '/app/config.js' ? tmpCfg : path.join(ROOT, p);
    if (!file.startsWith(ROOT) && file !== tmpCfg) { res.writeHead(403); res.end(); return; }
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
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (opts, firstVisit) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 }, locale: 'en-US', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }, opts || {}));
    // the welcome screen of a first visit has its own checks; everywhere else the visitor has already seen it
    if (!firstVisit) await ctx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => errors.push('request failed: ' + r.url()));
    return page;
  };
  const shot = async (page, name, full) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); };
  const text = async (page, sel) => norm(await page.locator(sel).first().innerText());

  const page = await newPage();
  await page.goto(base + '/app/', { waitUntil: 'networkidle' });

  console.log('first view');
  check('example is loaded and computed', /USD 23,841\.93/.test(await text(page, '#summary')), await text(page, '#summary'));
  check('outcome label', /Demurrage due to Owners/i.test(await text(page, '#summary')));
  check('example banner shown', /example/i.test(await text(page, '#banner')));
  check('two time lines drawn', (await page.locator('.tl').count()) === 2);
  check('time sheet has rows', (await page.locator('#sheet table.ts tbody tr').count()) > 20);
  check('web fonts loaded', await page.evaluate(() => document.fonts.check('700 20px "Fira Condensed"') && document.fonts.check('14px "Plex Sans"') && document.fonts.check('12px "Plex Mono"')));
  check('no horizontal scroll (desktop)', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot(page, '01-desktop-en');

  console.log('languages');
  await page.selectOption("#lang-select", "ru");
  check('Russian: result label', /Демередж в пользу судовладельца/i.test(await text(page, '#summary')));
  check('Russian: example text is localised', (await page.inputValue('#f-name')) === 'Пшеница, Новороссийск — Александрия');
  check('Russian: html lang', (await page.getAttribute('html', 'lang')) === 'ru');
  await shot(page, '02-desktop-ru');
  await page.selectOption("#lang-select", "kk");
  check('Kazakh: result label', /Кеме иесінің пайдасына демередж/i.test(await text(page, '#summary')));
  check('Kazakh: example text is localised', (await page.inputValue('#f-name')) === 'Бидай, Новороссийск — Александрия');
  check('Kazakh: port caption', /1-порт · Тиеу · Novorossiysk/i.test(await text(page, '#ptitle-0')));
  check('Kazakh letters render in the heading font', await page.evaluate(() => document.fonts.check('700 20px "Fira Condensed"', 'ҚОРЫТЫНДЫ әғқңөұүһі')));
  await shot(page, '03-desktop-kk');
  await page.selectOption("#lang-select", "en");

  console.log('editing');
  await page.fill('#f-demurrageRate', '20,000');
  check('rate "20,000" is read as twenty thousand', /USD 32,885\.42/.test(await text(page, '#summary')), await text(page, '#summary'));
  check('editing an example hides the example banner', !/example/i.test(await text(page, '#banner').catch(() => '')));
  await page.fill('#f-demurrageRate', '14500');
  const evBefore = await page.locator('.port').first().locator('.ev').count();
  await page.locator('.port').first().locator('[data-act="add-event"]').click();
  check('event row added', (await page.locator('.port').first().locator('.ev').count()) === evBefore + 1);
  const j = evBefore;
  check('new event has default wording and times', (await page.inputValue('#f-ports-0-events-' + j + '-desc')) === 'Rain — cargo work suspended' && (await page.inputValue('#f-ports-0-events-' + j + '-from')) !== '');
  await page.selectOption('#f-ports-0-events-' + j + '-type', 'breakdown');
  check('type change applies its defaults', (await page.isChecked('#f-ports-0-events-' + j + '-alsoOnDemurrage')) && (await page.inputValue('#f-ports-0-events-' + j + '-desc')) === 'Breakdown of ship’s gear');
  await page.fill('#f-ports-0-events-' + j + '-desc', 'My own wording');
  await page.selectOption('#f-ports-0-events-' + j + '-type', 'weather');
  check('custom wording survives a type change', (await page.inputValue('#f-ports-0-events-' + j + '-desc')) === 'My own wording');
  await page.locator('.port').first().locator('[data-act="del-event"]').nth(j).click();
  check('event removed, result back', (await page.locator('.port').first().locator('.ev').count()) === evBefore && /USD 23,841\.93/.test(await text(page, '#summary')));
  await page.fill('#f-ports-0-completed', '2026-03-05T10:00');
  check('impossible dates are explained, not computed', /completion is earlier than the start of laytime/i.test(await text(page, '#summary')) && (await page.locator('#f-ports-0-completed.bad').count()) === 1);
  await page.fill('#f-ports-0-completed', '2026-03-11T21:00');
  await page.selectOption('#f-laytimeMode', 'reversible');
  check('reversible mode shows the next-port rule', (await page.locator('#f-demurrageAtNextPort').count()) === 1 && /USD 23,841\.93/.test(await text(page, '#summary')));
  await page.selectOption('#f-laytimeMode', 'separate');
  await page.selectOption('#f-ports-0-nor-rule', 'nextday');
  check('“next working day” rule: its time field appears with 08:00, cargo work that started sooner still starts laytime',
    (await page.inputValue('#f-ports-0-nor-nextDayStart')) === '08:00' && /USD 23,163\.50/.test(await text(page, '#summary')), await text(page, '#summary'));
  await page.uncheck('#f-ports-0-nor-unlessSoonerCommenced');
  check('“next working day” rule: Friday’s notice starts laytime on Monday 08:00', /USD 13,080\.21/.test(await text(page, "#summary")) && /Time on demurrage 1d 12h 00m/.test(await text(page, "#summary")), await text(page, "#summary"));
  await page.click('[data-act="statement"]');
  check('the statement states the rule', /laytime to commence at 08:00 on the next working day after NOR/.test(await text(page, '#st-paper')));
  await page.keyboard.press('Escape');
  await page.check('#f-ports-0-nor-unlessSoonerCommenced');
  await page.selectOption('#f-ports-0-nor-rule', 'gencon');
  check('back to the noon rule, back to the first result', /USD 23,841\.93/.test(await text(page, '#summary')));
  await page.fill('#f-meta-vessel', '<img src=x onerror="window.__xss=1"> MV TEST');
  check('markup typed by the user stays text', (await page.evaluate(() => window.__xss)) === undefined);
  await page.fill('#f-meta-vessel', 'MV EXAMPLE TRADER');

  console.log('notice rule: the next working day');
  // The example's first port: notice on Friday 6 March 09:00, Saturdays and Sundays excepted, loading began Friday 14:10.
  const rule = '#f-ports-0-nor-rule', startTime = '#f-ports-0-nor-nextDayStart', sooner = '#f-ports-0-nor-unlessSoonerCommenced';
  const facts = () => text(page, '#sheet .tsp .facts');
  check('the selector offers the rule between the noon rule and a time entered by hand',
    (await page.locator(rule + ' option').evaluateAll((os) => os.map((o) => o.value).join())) === 'turn,gencon,nextday,manual' &&
    norm(await page.locator(rule + ' option[value="nextday"]').textContent()) === I.t('en', 'n.rule.nextday') && I.t('en', 'n.rule.nextday') !== 'n.rule.nextday');
  check('as shipped, the noon rule starts laytime on the day of the notice', (await page.inputValue(rule)) === 'gencon' && /06 Mar 2026 13:00 Laytime commenced/.test(await facts()), await facts());
  await page.selectOption(rule, 'nextday');
  check('choosing it shows one time field in place of the two of the noon rule',
    await page.locator(startTime).isVisible() && (await page.getAttribute(startTime, 'type')) === 'time' &&
    norm(await page.locator('label[for="f-ports-0-nor-nextDayStart"]').innerText()) === I.t('en', 'n.nextDayStart') && I.t('en', 'n.nextDayStart') !== 'n.nextDayStart' &&
    (await page.locator('#f-ports-0-nor-amStart, #f-ports-0-nor-pmStart, #f-ports-0-nor-turnHours, #f-ports-0-nor-manualStart').count()) === 0);
  check('“unless sooner commenced” and office hours stay on offer', await page.isChecked(sooner) && await page.isChecked('#f-ports-0-nor-officeHours-enabled'));
  check('loading began before the next working day: the time sheet says laytime started with it',
    /06 Mar 2026 14:10 Laytime commenced \(operations started before notice time ran out\)/.test(await facts()), await facts());
  await page.uncheck(sooner);
  check('without “unless sooner commenced” the time sheet starts on Monday at 08:00', /09 Mar 2026 08:00 Laytime commenced/.test(await facts()) &&
    !/0[678] Mar 2026 \d\d:\d\d Laytime commenced/.test(await facts()) && /^09 Mar 2026 Mon 08:00 /.test(await text(page, '#sheet .tsp table.ts tbody tr')), await facts());
  await page.fill(startTime, '06:00');
  let nd = await text(page, '#summary');
  check('another start time moves the start and the result', /09 Mar 2026 06:00 Laytime commenced/.test(await facts()) && /USD 13,684\.38/.test(nd) && /1d 00h 00m saved/.test(nd), nd);
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'networkidle' });
  nd = await text(page, '#summary');
  check('the rule, its time and the result survive a reload', (await page.inputValue(rule)) === 'nextday' && (await page.inputValue(startTime)) === '06:00' && !(await page.isChecked(sooner)) && /USD 13,684\.38/.test(nd), nd);
  await page.fill(startTime, '08:00');
  await page.click('[data-act="statement"]');
  await page.selectOption('#st-lang', 'ru');
  const ndPaper = await text(page, '#st-paper');
  check('the statement words the rule in its own language, with the start it gave', ndPaper.includes(I.t('ru', 'st.term.nor.nextday', { at: '08:00' })) && !/[{}]/.test(ndPaper) && /09\.03\.2026 08:00/.test(ndPaper), ndPaper.slice(0, 700));
  await page.selectOption('#st-lang', 'en');
  await page.keyboard.press('Escape');
  await page.selectOption(rule, 'gencon');
  await page.check(sooner);
  check('back on the noon rule its two times and the result are as they were',
    (await page.inputValue('#f-ports-0-nor-amStart')) === '13:00' && (await page.inputValue('#f-ports-0-nor-pmStart')) === '08:00' && (await page.locator(startTime).count()) === 0 &&
    /06 Mar 2026 13:00 Laytime commenced/.test(await facts()) && /USD 23,841\.93/.test(await text(page, '#summary')), await text(page, '#summary'));

  console.log('time line tooltip');
  await page.locator('.tl .seg-dem').first().hover();
  check('tooltip shows on hover', await page.locator('#tip').isVisible() && /On demurrage/.test(await text(page, '#tip')));
  await page.mouse.move(5, 5);

  console.log('statement');
  await page.click('[data-act="statement"]');
  check('statement opens', await page.locator('#statement .paper').isVisible());
  let paper = await text(page, '#st-paper');
  check('statement has header, terms, summary and signatures', /Laytime statement/i.test(paper) && /once on demurrage, always on demurrage/.test(paper) && /Demurrage due to Owners USD 23,841\.93/.test(paper) && /For and on behalf of Owners/.test(paper));
  check('free statement carries the free-version line', /Prepared with Stalia \(free version\)/.test(paper));
  check('letterhead is locked without Pro', await page.locator('#br-company').isDisabled());
  await shot(page, '04-statement-free', true);
  await page.selectOption('#st-lang', 'kk');
  check('statement language switches independently', /Сталиялық уақыт есебі/i.test(await text(page, '#st-paper')) && /Laytime statement/i.test(await text(page, '.st-bar')));
  await page.selectOption('#st-lang', 'en');
  await page.keyboard.press('Escape');
  check('Escape closes the statement', !(await page.locator('#statement').isVisible()));

  console.log('licence');
  await page.click('#lic');
  check('Pro dialog opens with prices', await page.locator('#dlg').isVisible() && /\$19/.test(await text(page, '#dlg')) && /\$149/.test(await text(page, '#dlg')));
  await shot(page, '05-pro-dialog');
  await page.fill('#lic-key', 'STL1.not-a-real-key.xxxx');
  await page.click('#lic-btn');
  await page.waitForSelector('#lic-msg .note-err');
  check('bad key is refused with a clear message', /does not look like a Stalia licence key|not valid/i.test(await text(page, '#lic-msg')));
  await page.fill('#lic-key', PRO_KEY.slice(0, 50) + '\n' + PRO_KEY.slice(50));
  await page.click('#lic-btn');
  await page.waitForFunction(() => /Pro · E2E/.test(document.querySelector('#lic').textContent));
  check('valid key activates Pro', /E2E Shipping LLP/.test(await text(page, '#dlg')) && /31 Dec 2099/.test(await text(page, '#dlg')));
  await page.click('#dlg [data-act="dlg-close"]');
  await page.click('[data-act="statement"]');
  await page.fill('#br-company', 'E2E Shipping LLP');
  await page.fill('#br-details', 'Aktau · chartering@e2e.example');
  await page.fill('#f-meta-remarks', 'Without prejudice.');
  paper = await text(page, '#st-paper');
  check('Pro statement: letterhead, remarks, no free line', /E2E Shipping LLP/.test(paper) && /chartering@e2e\.example/.test(paper) && /Without prejudice\./.test(paper) && !/free version/.test(paper));
  await shot(page, '06-statement-pro', true);

  console.log('print');
  await page.emulateMedia({ media: 'print' });
  const vis = await page.evaluate(() => ({
    form: getComputedStyle(document.querySelector('#form')).display !== 'none' && document.querySelector('main').offsetParent !== null,
    paper: !!document.querySelector('#statement .paper') && getComputedStyle(document.querySelector('#statement')).display !== 'none',
    tools: getComputedStyle(document.querySelector('.st-bar')).display,
  }));
  check('print shows only the statement', !vis.form && vis.paper && vis.tools === 'none', JSON.stringify(vis));
  if (SHOTS) await page.pdf({ path: path.join(SHOTS, 'statement.pdf'), format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  await page.click('[data-act="st-close"]');

  console.log('exports');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="csv"]')]);
  const csv = fs.readFileSync(await csvDl.path(), 'utf8');
  check('CSV download', /\.csv$/.test(csvDl.suggestedFilename()) && csv.includes('Novorossiysk,06 Mar 2026,Fri,13:00,24:00,Laytime counts'), csvDl.suggestedFilename());
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="json"]')]);
  const backupPath = await jsonDl.path();
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  check('backup file holds the calculation', backup.stalia === 1 && backup.calc.ports.length === 2 && backup.calc.meta.vessel === 'MV EXAMPLE TRADER');
  await page.click('[data-act="copy-summary"]');
  check('summary copied to clipboard', /Demurrage due to Owners: USD 23,841\.93/.test(await page.evaluate(() => navigator.clipboard.readText())));

  console.log('save / open / share');
  await page.click('[data-act="save"]');
  await page.click('[data-act="new"]');
  check('new sheet asks for the missing times', /Enter the missing times/.test(await text(page, '#summary')) && /Port 1: enter when NOR was tendered/.test(await text(page, '#summary')));
  check('undo offered after "New"', await page.locator('#toast button').isVisible());
  await shot(page, '07-blank');
  await page.click('#menu-saved > summary');
  check('saved calculation is listed', (await page.locator('#saved-list [data-act="open-saved"]').count()) === 1);
  await page.click('#saved-list [data-act="open-saved"]');
  check('saved calculation reopens', /USD 23,841\.93/.test(await text(page, '#summary')));
  await page.waitForTimeout(500);
  await page.click('[data-act="share"]');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check('share link copied', /#c=[zj][A-Za-z0-9_-]+$/.test(link), link.slice(0, 80));
  const p2 = await newPage();
  await p2.goto(link, { waitUntil: 'networkidle' });
  check('shared link opens the same calculation elsewhere', /USD 23,841\.93/.test(await text(p2, '#summary')) && /shared link/i.test(await text(p2, '#banner')));
  check('shared link is removed from the address bar', !(await p2.evaluate(() => location.hash)));
  await p2.context().close();

  console.log('reload keeps work');
  await page.fill('#f-name', 'Edited before reload');
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'networkidle' });
  check('work restored after reload', (await page.inputValue('#f-name')) === 'Edited before reload' && /Pro · E2E/.test(await text(page, '#lic')));

  console.log('free limits');
  await page.click('#lic');
  await page.click('[data-act="lic-remove"]');
  await page.click('#dlg [data-act="dlg-close"]');
  await page.click('[data-act="add-port"]');
  check('third port asks for Pro', await page.locator('#dlg').isVisible() && /2 ports per calculation/.test(await text(page, '#dlg')) && (await page.locator('.port').count()) === 2);
  await page.click('#dlg [data-act="dlg-close"]');
  await page.click('[data-act="csv"]');
  check('CSV export asks for Pro', await page.locator('#dlg').isVisible());
  await page.click('#dlg [data-act="dlg-close"]');

  console.log('licence link from the purchase e-mail');
  const p3 = await newPage();
  await p3.goto(base + '/app/?license_key=' + encodeURIComponent(PRO_KEY), { waitUntil: 'networkidle' });
  await p3.waitForFunction(() => /Pro · E2E/.test(document.querySelector('#lic').textContent));
  check('?license_key= activates Pro and is cleaned from the URL', !/license_key/.test(await p3.evaluate(() => location.search)));
  await p3.context().close();

  console.log('phone');
  const m = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m.goto(base + '/app/', { waitUntil: 'networkidle' });
  check('phone: no horizontal scroll', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), String(await m.evaluate(() => document.documentElement.scrollWidth)));
  check('phone: result comes before the form', await m.evaluate(() => document.querySelector('#summary').getBoundingClientRect().top < document.querySelector('#form').getBoundingClientRect().top));
  await shot(m, '08-phone', false);
  await m.click('[data-act="statement"]');
  check('phone: statement does not widen the page', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot(m, '09-phone-statement', false);
  await m.context().close();

  console.log('installable, works offline');
  const octx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  await octx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } });
  const o = await octx.newPage();
  await o.goto(base + '/app/', { waitUntil: 'networkidle' });
  const manifest = await o.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  check('manifest: name, standalone display, three icons', manifest.short_name === 'Stalia' && manifest.display === 'standalone' && manifest.icons.length === 3 && manifest.icons.some((i) => i.purpose === 'maskable'));
  const iconsOk = await o.evaluate(async (icons) => (await Promise.all(icons.map((i) => fetch(new URL(i.src, document.querySelector('link[rel=manifest]').href)).then((r) => r.ok && /image\/png/.test(r.headers.get('content-type')))))).every(Boolean), manifest.icons);
  check('manifest icons exist', iconsOk);
  await o.evaluate(() => navigator.serviceWorker.ready);
  // wait until every file of the offline shell is really in the cache: going offline earlier would be a race
  const shellSize = new Function('self', fs.readFileSync(path.join(ROOT, 'app', 'sw.js'), 'utf8') + '; return SHELL.length;')({ addEventListener() {}, location: {} });
  const cached = await o.evaluate(async (want) => {
    for (let i = 0; i < 300; i++) {
      const name = (await caches.keys()).find((n) => n.startsWith('stalia-'));
      const have = name ? (await (await caches.open(name)).keys()).length : 0;
      if (have >= want) return have;
      await new Promise((r) => setTimeout(r, 100));
    }
    return -1;
  }, shellSize);
  check('the whole offline shell is cached (' + shellSize + ' files)', cached >= shellSize, cached);
  check('install button is offered in the browser', await o.locator('#btn-install').isVisible());
  await o.click('#btn-install');
  check('install instructions name Android and iPhone', /Android/.test(await text(o, '#dlg')) && /iPhone/.test(await text(o, '#dlg')));
  await o.click('#dlg [data-act="dlg-close"]');
  await octx.setOffline(true);
  await o.reload({ waitUntil: 'load' });
  await o.waitForSelector('#summary .res-amount');
  check('offline: the calculator opens and computes', /USD 23,841\.93/.test(await text(o, '#summary')));
  check('offline: fonts and styles are there', await o.evaluate(() => document.fonts.check('700 20px "Fira Condensed"') && getComputedStyle(document.querySelector('.fix')).borderRadius !== '0px'));
  await o.fill('#f-demurrageRate', '10000');
  check('offline: editing still recalculates', /USD 16,442\.71/.test(await text(o, '#summary')), await text(o, '#summary'));
  await o.goto(base + '/app/?lang=ru', { waitUntil: 'load' });
  check('offline: any address of the app resolves to the cached page', (await o.getAttribute('html', 'lang')) === 'ru');
  await octx.close();

  console.log('back button');
  const bp = await newPage({ viewport: { width: 390, height: 844 } });
  await bp.goto(base + '/app/', { waitUntil: 'networkidle' });
  const settle = () => bp.waitForTimeout(150);
  await bp.click('[data-act="statement"]');
  await bp.goBack(); await settle();
  check('Back closes the statement and stays in the calculator', !(await bp.locator('#statement').isVisible()) && /\/app\/$/.test(bp.url()) && /USD 23,841\.93/.test(await text(bp, '#summary')));
  await bp.click('#lic');
  await bp.goBack(); await settle();
  check('Back closes a dialog', !(await bp.locator('#dlg').isVisible()) && /\/app\/$/.test(bp.url()));
  await bp.click('[data-act="statement"]');
  await bp.click('#st-side [data-act="pro"]');
  await bp.goBack(); await settle();
  check('Back closes only the dialog on top of the statement', !(await bp.locator('#dlg').isVisible()) && (await bp.locator('#statement').isVisible()));
  await bp.goBack(); await settle();
  check('the next Back closes the statement', !(await bp.locator('#statement').isVisible()) && /\/app\/$/.test(bp.url()));
  await bp.click('[data-act="statement"]');
  await bp.click('[data-act="st-close"]'); await settle();
  await bp.click('#lic');
  await bp.click('#dlg [data-act="dlg-close"]'); await settle();
  await bp.click('[data-act="statement"]');
  await bp.keyboard.press('Escape'); await settle();
  check('closing with buttons or Escape leaves the calculator as it was', !(await bp.locator('#statement').isVisible()) && !(await bp.locator('#dlg').isVisible()) && /USD 23,841\.93/.test(await text(bp, '#summary')));
  await bp.click('[data-act="statement"]');
  await bp.goBack(); await settle();
  check('Back still works after overlays were closed by hand', !(await bp.locator('#statement').isVisible()) && /\/app\/$/.test(bp.url()));
  await bp.context().close();

  console.log('site pages');
  const SITE = require('../../tools/site.js');
  for (const width of [390, 1280]) {
    const sp = await newPage({ viewport: { width, height: 900 } });
    for (const pg of SITE.PAGES.filter((x) => x.group !== 'app')) {
      await sp.goto(base + pg.url, { waitUntil: 'networkidle' });
      const info = await sp.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        h1: (document.querySelector('h1') || {}).textContent || '',
        demo: document.querySelectorAll('#demo-body .tl').length,
        fonts: document.fonts.check('700 30px "Fira Condensed"', document.querySelector('h1').textContent),
      }));
      check(pg.url + ' @' + width + ': fits the screen, heading font covers its letters', info.fits && info.h1.length > 10 && info.fonts, JSON.stringify(info));
      if (pg.group === 'home') check(pg.url + ' @' + width + ': live example drawn', info.demo === 2);
    }
    await sp.context().close();
  }
  // the Russian and Kazakh pages show tenge to visitors in Kazakhstan and dollars to everyone else
  const abroad = await newPage({ timezoneId: 'Europe/Istanbul', locale: 'ru-RU' });
  await abroad.goto(base + '/ru/', { waitUntil: 'networkidle' });
  const priceAbroad = norm(await abroad.locator('#pricing').innerText());
  check('landing (ru) outside Kazakhstan: dollars only', /\$19/.test(priceAbroad) && /\$149/.test(priceAbroad) && /\$0/.test(priceAbroad) && !/₸/.test(priceAbroad), priceAbroad.slice(0, 200));
  await abroad.goto(base + '/app/?lang=ru', { waitUntil: 'networkidle' });
  await abroad.click('#lic');
  check('calculator (ru) outside Kazakhstan: Pro prices in dollars', /\$19/.test(await text(abroad, '#dlg')) && !/₸/.test(await text(abroad, '#dlg')));
  await abroad.context().close();
  const lp = await newPage({ timezoneId: 'Asia/Almaty', locale: 'ru-RU' });
  await lp.goto(base + '/kk/', { waitUntil: 'networkidle' });
  check('landing (kk) in Kazakhstan: tenge', /9\s?900 ₸/.test(norm(await lp.locator('#pricing').innerText())) && /0 ₸/.test(norm(await lp.locator('#pricing').innerText())));
  await lp.goto(base + '/ru/', { waitUntil: 'networkidle' });
  check('landing (ru) in Kazakhstan: tenge, with the card price in dollars alongside', /9\s?900 ₸/.test(norm(await lp.locator('#pricing').innerText())) && /\$19/.test(await lp.locator('#pricing').innerText()));
  check('landing: buy button falls back to the contact block', (await lp.getAttribute('a[data-buy="monthly"]', 'href')) === '#contact');
  await lp.click('.hero .cta a');
  await lp.waitForSelector('#summary .res-amount');
  check('landing → calculator opens in the page language', (await lp.getAttribute('html', 'lang')) === 'ru' && /app\/\?lang=ru/.test(lp.url()));
  await lp.goto(base + '/guides/how-to-calculate-laytime.html', { waitUntil: 'networkidle' });
  await lp.click('.try a');
  await lp.waitForSelector('#summary .res-amount');
  check('guide → opens its example in English', /USD 23,841\.93/.test(await text(lp, '#summary')) && (await lp.inputValue('#f-name')) === 'Wheat, Novorossiysk to Alexandria');
  await lp.context().close();

  console.log('first visit: the language, then how to use');
  const w = await newPage({ viewport: { width: 390, height: 844 }, locale: 'de-DE' }, true);
  await w.goto(base + '/app/', { waitUntil: 'networkidle' });
  check('a first visit opens on the choice of language', await w.locator('#help').isVisible() && (await w.locator('#help [data-act="help-lang"]').count()) === 7);
  check('“language” is written in every language', /Language · 语言 · Язык · Тіл · Мова · Dil · Γλώσσα/.test(await text(w, '#help')));
  check('each language is offered under its own name', norm(await w.locator('#help .help-langs').innerText()) === 'English 中文 Русский Қазақша Українська Türkçe Ελληνικά');
  check('the language screen fits a phone', await w.evaluate(() => document.getElementById('help').scrollWidth <= document.getElementById('help').clientWidth + 1));
  await shot(w, '20-welcome-language');
  await w.click('#help [data-act="help-lang"][data-lang="ru"]');
  const guide = await text(w, '#help');
  check('then comes the instruction, in the chosen language', /Как пользоваться Stalia/i.test(guide) && (await w.locator('#help .help-steps li').count()) === 5 && (await w.getAttribute('html', 'lang')) === 'ru');
  check('the instruction calls the buttons by the names they have on screen', ['nav.examples', 'nav.new', 'imp.open', 'imp.read', 'act.statement', 'nav.save', 'act.share'].every((k) => guide.includes('«' + I.t('ru', k) + '»')), guide);
  check('nothing is left unfilled in it', !/[{}]/.test(guide));
  check('the instruction fits a phone', await w.evaluate(() => document.getElementById('help').scrollWidth <= document.getElementById('help').clientWidth + 1));
  await shot(w, '21-welcome-guide');
  await w.click('#help [data-act="help-pick-lang"]');
  check('the language can be changed from the instruction', (await w.locator('#help [data-act="help-lang"]').count()) === 7 && /btn-primary/.test(await w.getAttribute('#help [data-lang="ru"]', 'class')));
  await w.click('#help [data-act="help-lang"][data-lang="zh"]');
  check('Chinese instruction', /如何使用 Stalia/i.test(await text(w, '#help')) && (await text(w, '#help')).includes('“' + I.t('zh', 'imp.open') + '”'));
  await w.click('#help [data-act="help-pick-lang"]');
  await w.click('#help [data-act="help-lang"][data-lang="ru"]');
  check('the button says “Start” on a first visit', (await text(w, '#help [data-act="help-close"]')) === 'Начать');
  await w.click('#help [data-act="help-close"]');
  check('“Start” leads to the calculator in that language', !(await w.locator('#help').isVisible()) && /Демередж в пользу судовладельца/i.test(await text(w, '#summary')));
  await w.reload({ waitUntil: 'networkidle' });
  check('it does not come back on the next visit', !(await w.locator('#help').isVisible()) && (await w.getAttribute('html', 'lang')) === 'ru');
  await w.click('.bar [data-act="help"]');
  check('the “How to use” button opens the instruction again, with “Close”', await w.locator('#help').isVisible() && /Как пользоваться Stalia/i.test(await text(w, '#help')) && (await text(w, '#help [data-act="help-close"]')) === 'Закрыть');
  await w.goBack();
  await w.waitForFunction(() => document.getElementById('help').hidden);
  check('Back closes it', true);
  await w.click('.bar [data-act="help"]');
  await w.keyboard.press('Escape');
  check('Escape closes it', !(await w.locator('#help').isVisible()));
  await w.context().close();
  // a visitor who came for a shared calculation is not stopped at the door
  const ws = await newPage(null, true);
  await ws.goto(base + '/app/', { waitUntil: 'networkidle' });
  await ws.click('#help [data-act="help-lang"][data-lang="en"]');
  await ws.click('#help [data-act="help-close"]');
  await ws.waitForFunction(() => window.__stalia.state.shareHash);
  const sharedLink = base + '/app/#c=' + await ws.evaluate(() => window.__stalia.state.shareHash);
  await ws.context().close();
  const wr = await newPage(null, true);
  await wr.goto(sharedLink, { waitUntil: 'networkidle' });
  check('a shared link opens the calculation, not the welcome screen', !(await wr.locator('#help').isVisible()) && /USD 23,841\.93/.test(await text(wr, '#summary')));
  check('the button is still there for them', (await wr.locator('.bar [data-act="help"]').count()) === 1);
  await wr.context().close();

  console.log('free trial');
  const tp = await newPage();
  await tp.goto(base + '/app/', { waitUntil: 'networkidle' });
  await tp.click('#lic');
  check('Pro dialog offers the free trial', /Try Pro free for 14 days/.test(await text(tp, '#dlg')) && /No card and no sign-up/.test(await text(tp, '#dlg')));
  await shot(tp, '12-trial-offer');
  await tp.click('[data-act="trial-start"]');
  await tp.waitForFunction(() => /trial/.test(document.querySelector('#lic').textContent));
  check('trial starts: the dialog closes and the header counts the days', !(await tp.locator('#dlg').isVisible()) && /Pro · trial, 14 d/.test(await text(tp, '#lic')), await text(tp, '#lic'));
  await tp.click('[data-act="statement"]');
  check('trial: no free-version line, the letterhead is open', !/free version/.test(await text(tp, '#st-paper')) && !(await tp.locator('#br-company').isDisabled()));
  await tp.keyboard.press('Escape');
  await tp.click('#lic');
  let trialDlg = await text(tp, '#dlg');
  check('trial: the dialog says how long is left and still sells Pro', /days left: 14/.test(trialDlg) && !/Try Pro free/.test(trialDlg) && /\$19/.test(trialDlg) && (await tp.locator('#lic-key').count()) === 1, trialDlg.slice(0, 200));
  await shot(tp, '13-trial-active');
  await tp.click('[data-act="dlg-close"]');
  // fifteen days later
  await tp.evaluate(() => { const r = JSON.parse(localStorage.getItem('stalia.trial.v1')); r.startedAt -= 15 * 864e5; r.seenAt = r.startedAt; localStorage.setItem('stalia.trial.v1', JSON.stringify(r)); });
  await tp.reload({ waitUntil: 'networkidle' });
  await tp.waitForSelector('#dlg[open]');
  trialDlg = await text(tp, '#dlg');
  check('after 14 days Pro is off and the visitor is told, with the ways to keep it', /free Pro trial has ended/.test(trialDlg) && /\$19/.test(trialDlg) && !/Try Pro free/.test(trialDlg) && /Get Pro/.test(await text(tp, '#lic')), trialDlg.slice(0, 200));
  await tp.click('[data-act="dlg-close"]');
  await tp.click('[data-act="statement"]');
  check('after the trial the statement is the free one again', /free version/.test(await text(tp, '#st-paper')) && (await tp.locator('#br-company').isDisabled()));
  await tp.keyboard.press('Escape');
  await tp.reload({ waitUntil: 'networkidle' });
  check('the end-of-trial notice is shown once', !(await tp.locator('#dlg').isVisible()));
  await tp.context().close();

  console.log('dark theme');
  const d = await newPage({ colorScheme: 'dark' });
  await d.goto(base + '/app/', { waitUntil: 'networkidle' });
  const dark = await d.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
  check('dark theme applies', dark.bg === 'rgb(11, 22, 29)' && dark.ink === 'rgb(230, 238, 242)', JSON.stringify(dark));
  await shot(d, '10-dark');
  await d.click('[data-act="statement"]');
  const paperBg = await d.evaluate(() => getComputedStyle(document.querySelector('.paper')).backgroundColor);
  check('the paper stays white in the dark theme', paperBg === 'rgb(255, 255, 255)', paperBg);
  await shot(d, '11-dark-statement');
  await d.context().close();

  check('no console errors or failed requests', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  server.close();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
