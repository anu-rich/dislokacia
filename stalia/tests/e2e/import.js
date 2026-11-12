#!/usr/bin/env node
/*
 * End-to-end check of "From documents" in a real browser (needs Playwright + Chromium and "npm install" in server/).
 *   node tests/e2e/import.js
 *   SHOTS=/some/dir node tests/e2e/import.js      also keep screenshots and the sample documents there
 *
 * The whole chain runs for real — the site, the reading server, the Anthropic SDK — except the model itself:
 * a scripted stand-in answers in its place, so no API key is needed and nothing is spent.
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const K = require('../../tools/keygen.js');
const M = require('../../app/model.js');
const I = require('../../app/i18n.js');
const X = require('../../app/extract.js');
const { extractionOf } = require('../helpers/extraction.js');
const { startMockAnthropic } = require('../helpers/mock-anthropic.js');
const { makeSampleDocs } = require('./sample-docs.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SHOTS || '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-imp-'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const kp = K.generateKeyPair();
const PRO_KEY = K.issueKey(kp.privatePem, { name: 'E2E Shipping LLP', exp: '2099-12-31' });

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 300) : '')); }
}
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

function serveSite(configFor) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (p === '/app/config.js') { res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }); res.end(configFor(req)); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

(async () => {
  // ---- the model's stand-in, the reading server, the site
  const bulk = M.examples('en')[0].calc;
  const scenario = { name: 'full' };
  const answers = {
    full() { // both documents, with the demurrage rate blacked out
      const a = extractionOf(bulk);
      a.money.demurrage_per_day = '';
      a.notes.push({ field: 'demurrage_rate', port: 0, status: 'redacted', comment: 'The demurrage rate is under a blacked-out area: enter it by hand.' });
      a.notes.push({ field: 'events', port: 2, status: 'assumed', comment: 'The crane breakdown was treated as time lost through the vessel: check clause 22.' });
      return { text: JSON.stringify(a) };
    },
    sofOnly() { // a statement of facts for a later voyage, nothing else
      const a = X.blankExtraction();
      a.documents = { charter_party: 'absent', statement_of_facts: 'read' };
      a.fixture.vessel = 'MV EXAMPLE TRADER';
      a.fixture.voyage = 'V.015';
      const p = X.blankExtractionPort('load');
      p.name = 'Novorossiysk';
      p.allowed.cargo_quantity = '26800';
      p.notice.tendered = '2026-06-01T09:30';
      p.operations_commenced = '2026-06-01T15:00';
      p.operations_completed = '2026-06-04T22:00';
      p.events.push({ type: 'weather', from: '2026-06-02T03:00', to: '2026-06-02T06:00', description: 'Rain — loading suspended', counts_percent: '', on_demurrage: 'default' });
      a.ports.push(p);
      return { text: JSON.stringify(a) };
    },
    refusal: () => ({ text: '', stop: 'refusal' }),
    nothing: () => ({ text: JSON.stringify(Object.assign(X.blankExtraction(), { notes: [{ field: 'other', port: 0, status: 'not_found', comment: 'These pages are not shipping documents.' }] })) }),
  };
  const mock = await startMockAnthropic(() => answers[scenario.name]());
  const [node, limits, sdk] = await Promise.all([
    import(path.join(ROOT, 'server', 'node-server.js')), import(path.join(ROOT, 'server', 'src', 'limits.js')),
    import(path.join(ROOT, 'server', 'node_modules', '@anthropic-ai', 'sdk', 'index.mjs')),
  ]);
  const serverLog = [];
  const reader = await node.start(
    { ANTHROPIC_API_KEY: 'sk-test', STALIA_API_BASE_URL: mock.url, FREE_PER_DAY: '8', PRO_PER_DAY: '20', STALIA_PUBLIC_KEYS: JSON.stringify([kp.publicJwk]) },
    { port: 0, host: '127.0.0.1', deps: { store: new limits.MemoryStore(), log: (o) => serverLog.push(o), createClient: (cfg) => new sdk.default({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0 }) } });
  const readerUrl = 'http://127.0.0.1:' + reader.address().port + '/';

  let cfgSrc = fs.readFileSync(path.join(ROOT, 'app', 'config.js'), 'utf8');
  const tmpCfg = path.join(TMP, 'config.js');
  fs.writeFileSync(tmpCfg, cfgSrc);
  K.writeConfigKeys([kp.publicJwk], tmpCfg);
  cfgSrc = fs.readFileSync(tmpCfg, 'utf8');
  if (!/ai: \{ endpoint: '', maxPages: 20 \}/.test(cfgSrc)) throw new Error('app/config.js: the ai setting is not where the test expects it');
  const withReader = cfgSrc.replace("ai: { endpoint: '', maxPages: 20 }", "ai: { endpoint: '" + readerUrl + "', maxPages: 20 }");
  const site = await serveSite(() => withReader);
  const base = 'http://127.0.0.1:' + site.address().port;
  // a second copy of the site with no reading server; its browser-side reader is pointed at the stand-in instead of Anthropic
  const noServer = cfgSrc.replace("ai: { endpoint: '', maxPages: 20 }", "ai: { endpoint: '', maxPages: 20, directBaseUrl: '" + mock.url + "' }");
  const siteOff = await serveSite(() => noServer);
  const baseOff = 'http://127.0.0.1:' + siteOff.address().port;

  const browser = await chromium.launch();
  const errors = [];
  const newPage = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 }, locale: 'en-US' }, opts || {}));
    await ctx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } }); // not a first visit
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    return page;
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const text = async (page, sel) => norm(await page.locator(sel).first().innerText());
  const docsDir = SHOTS ? path.join(SHOTS, 'documents') : path.join(TMP, 'documents');
  const docs = await makeSampleDocs(browser, docsDir);

  /** Click an "add" button of a slot and hand it files, as a person would through the file dialog. */
  const addTo = async (page, doc, files) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.imp-slot[data-doc="' + doc + '"] [data-act="imp-add"]')]);
    await chooser.setFiles(files);
  };
  const tiles = (page, doc) => page.locator('.imp-slot[data-doc="' + doc + '"] .imp-page');
  const dragOnPage = async (page, fx0, fy0, fx1, fy1) => {
    const r = await page.locator('#rd-page').boundingBox();
    await page.mouse.move(r.x + r.width * fx0, r.y + r.height * fy0);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * (fx0 + fx1) / 2, r.y + r.height * (fy0 + fy1) / 2, { steps: 4 });
    await page.mouse.move(r.x + r.width * fx1, r.y + r.height * fy1, { steps: 4 });
    await page.mouse.up();
  };
  /** Average colour of a region of a JPEG given as base64 (decoded in the browser). */
  const sample = (page, b64, fx, fy) => page.evaluate(async ([data, x, y]) => {
    const im = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + data)).blob());
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(Math.round(im.width * x) - 3, Math.round(im.height * y) - 3, 6, 6).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return { w: im.width, h: im.height, level: Math.round(sum / (d.length / 4 * 3)) };
  }, [b64, fx, fy]);

  const page = await newPage();
  await page.goto(base + '/app/', { waitUntil: 'networkidle' });

  console.log('opening');
  check('toolbar has “From documents”', norm(await page.locator('.bar [data-act="imp-open"]').innerText()) === 'From documents');
  check('the example banner offers it too', (await page.locator('#banner [data-act="imp-open"]').count()) === 1);
  await page.click('.bar [data-act="imp-open"]');
  check('the screen opens', await page.locator('#import').isVisible());
  check('two places for documents', (await page.locator('.imp-slot').count()) === 2 && /Charter party or recap/.test(await text(page, '.imp-slot[data-doc="cp"]')) && /Statement of facts or time sheet/.test(await text(page, '.imp-slot[data-doc="sof"]')));
  check('nothing to read yet: the button waits', await page.locator('[data-act="imp-read"]').isDisabled());
  check('says what leaves the device', /painted over/.test(await text(page, '.imp-privacy')));
  check('no camera button on a computer', (await page.locator('[data-act="imp-cam"]').count()) === 0);

  console.log('adding pages');
  await addTo(page, 'cp', docs.cpPdf);
  await page.waitForFunction(() => document.querySelectorAll('.imp-slot[data-doc="cp"] .imp-page').length === 2 && !window.__stalia.imp._state.busy, null, { timeout: 30000 });
  check('a two-page PDF becomes two pages', (await tiles(page, 'cp').count()) === 2);
  await addTo(page, 'sof', [docs.sofLoad, docs.sofDischarge]);
  await page.waitForFunction(() => document.querySelectorAll('.imp-slot[data-doc="sof"] .imp-page').length === 2 && !window.__stalia.imp._state.busy);
  check('two photos become two pages', (await tiles(page, 'sof').count()) === 2);
  const sizes = await page.evaluate(() => window.__stalia.imp._state.pages.map((p) => [p.w, p.h, p.blob.type, Math.round(p.blob.size / 1024)]));
  check('pages are kept as JPEG no larger than 2200 px', sizes.every((s) => Math.max(s[0], s[1]) <= 2200 && Math.max(s[0], s[1]) >= 1500 && s[2] === 'image/jpeg'), JSON.stringify(sizes));
  check('PDF pages are rendered sharp (A4 at 2200 px)', sizes[0][1] === 2200 && Math.abs(sizes[0][0] - 1556) <= 2, JSON.stringify(sizes[0]));
  check('thumbnails are shown', await page.evaluate(() => Array.from(document.querySelectorAll('.imp-thumb img')).every((im) => im.complete && im.naturalWidth > 50)));
  check('the button is ready', !(await page.locator('[data-act="imp-read"]').isDisabled()));
  await shot(page, 'imp-01-documents');

  console.log('blacking out');
  await tiles(page, 'cp').first().locator('.imp-thumb').click();
  check('the page opens for marking', await page.locator('#redact').isVisible() && (await text(page, '#rd-count')) === '1 / 4');
  await page.waitForFunction(() => { const im = document.querySelector('#rd-page img'); return im && im.complete && im.naturalWidth > 0; });
  const fit = await page.locator('#rd-page').boundingBox();
  check('the whole page is visible', fit.height <= 900 && fit.width > 300 && fit.y >= 0, JSON.stringify(fit));
  check('nothing to undo yet', await page.locator('#rd-undo').isDisabled());
  await dragOnPage(page, 0.30, 0.215, 0.80, 0.262);      // the lines with owners and charterers
  await dragOnPage(page, 0.30, 0.505, 0.62, 0.530);      // the demurrage rate
  check('two marks drawn', (await page.locator('.rd-mark').count()) === 2);
  await page.click('#rd-undo');
  check('undo removes the last one', (await page.locator('.rd-mark').count()) === 1);
  await dragOnPage(page, 0.30, 0.505, 0.62, 0.530);
  await dragOnPage(page, 0.10, 0.80, 0.30, 0.85);
  check('three marks', (await page.locator('.rd-mark').count()) === 3);
  const third = await page.locator('.rd-mark').nth(2).boundingBox();
  await page.mouse.click(third.x + third.width / 2, third.y + third.height / 2);
  check('a click on a mark takes it off', (await page.locator('.rd-mark').count()) === 2);
  await page.keyboard.press('Control+z');
  check('Ctrl+Z undoes', (await page.locator('.rd-mark').count()) === 1);
  await dragOnPage(page, 0.30, 0.505, 0.62, 0.530);
  // zoom
  await page.click('[data-act="rd-in"]');
  const zoomed = await page.locator('#rd-page').boundingBox();
  check('zoom in enlarges the page', zoomed.width > fit.width * 1.4, zoomed.width + ' vs ' + fit.width);
  check('marks stay on their text when zoomed', await page.evaluate(() => { const m = document.querySelector('.rd-mark'), b = document.querySelector('#rd-page').getBoundingClientRect(), r = m.getBoundingClientRect(); return Math.abs((r.left - b.left) / b.width - 0.30) < 0.01; }));
  await page.click('[data-act="rd-out"]');
  // rotate there and back: marks turn with the page
  const before = await page.evaluate(() => JSON.stringify(window.__stalia.imp._state.pages[0].marks.map((m) => [m.x, m.y, m.w, m.h].map((v) => Math.round(v * 1000)))));
  await page.click('[data-act="rd-rotate"]');
  await page.waitForFunction(() => window.__stalia.imp._state.pages[0].w > window.__stalia.imp._state.pages[0].h);
  check('rotate turns the page', true);
  const turned = await page.evaluate(() => window.__stalia.imp._state.pages[0].marks[0]);
  check('and the marks with it', turned.w < turned.h, JSON.stringify(turned));
  for (let i = 0; i < 3; i++) {
    await page.click('[data-act="rd-rotate"]');
    await page.waitForFunction((n) => { const p = window.__stalia.imp._state.pages[0]; return (n % 2 === 0) === (p.w > p.h) && !document.querySelector('#rd-rotate-busy'); }, i);
    await page.waitForTimeout(150);
  }
  const after = await page.evaluate(() => JSON.stringify(window.__stalia.imp._state.pages[0].marks.map((m) => [m.x, m.y, m.w, m.h].map((v) => Math.round(v * 1000)))));
  check('four quarter turns bring page and marks back', before === after, before + ' / ' + after);
  await shot(page, 'imp-02-blacking-out');
  await page.click('[data-act="rd-next"]');
  check('next page', (await text(page, '#rd-count')) === '2 / 4' && (await page.locator('.rd-mark').count()) === 0);
  await page.click('[data-act="rd-done"]');
  check('back to the list', !(await page.locator('#redact').isVisible()) && await page.locator('#import').isVisible());
  await page.waitForFunction(() => /Blacked out: 2/.test(document.querySelector('.imp-slot[data-doc="cp"] .imp-page').innerText));
  check('the page shows how much is blacked out', /Blacked out: 2/.test(await text(page, '.imp-slot[data-doc="cp"] .imp-page')));

  // what will leave the device
  const flat = await page.evaluate(async () => { const p = await window.__stalia.imp._flatten(); return p.map((x) => ({ doc: x.doc, type: x.type, data: x.data })); });
  check('pages leave in order: charter party, then statement of facts', flat.map((p) => p.doc).join(',') === 'cp,cp,sof,sof' && flat.every((p) => p.type === 'image/jpeg' && p.data.startsWith('/9j/')));
  const inside = await sample(page, flat[0].data, 0.55, 0.238), rate = await sample(page, flat[0].data, 0.45, 0.517), paper = await sample(page, flat[0].data, 0.92, 0.95);
  check('the marked areas are solid black in the outgoing image', inside.level < 12 && rate.level < 12, JSON.stringify([inside, rate]));
  check('the rest of the page is untouched', paper.level > 240, JSON.stringify(paper));

  console.log('reading');
  await page.click('[data-act="imp-read"]');
  check('says it is reading', /Reading/.test(await text(page, '.imp-wait')));
  await page.waitForSelector('.imp-h', { timeout: 30000 });
  check('one request reached the model', mock.requests.length === 1);
  const sent = mock.requests[0].body.messages[0].content;
  const images = sent.filter((c) => c.type === 'image');
  check('with four pages, labelled by document', images.length === 4 && sent[0].text === 'Charter party / recap — page 1 of 2:' && sent[4].text === 'Statement of facts / time sheet — page 1 of 2:', sent.filter((c) => c.type === 'text').map((c) => c.text).join(' | '));
  const got = await sample(page, images[0].source.data, 0.55, 0.238), gotRate = await sample(page, images[0].source.data, 0.45, 0.517);
  check('what the model received has the names and the rate blacked out', got.level < 12 && gotRate.level < 12, JSON.stringify([got, gotRate]));
  check('the server logged sizes only', serverLog.length === 1 && serverLog[0].ok === true && serverLog[0].pages === 4 && serverLog[0].plan === 'free');

  console.log('checking what was read');
  const review = await text(page, '#imp-body');
  check('the review lists the fixture', /MV EXAMPLE TRADER/.test(review) && /Gencon 1994/.test(review) && /27,500 MT wheat in bulk/.test(review), review);
  check('terms in words', /SSHEX/.test(review) && /FHEX/.test(review) && /despatch/i.test(review));
  check('both ports with their times', /Port 1 · Loading · Novorossiysk/.test(review) && /Port 2 · Discharging · Alexandria/.test(review) && /06 Mar 2026 09:00/.test(review) && /24 Mar 2026 18:00/.test(review), review);
  check('interruptions counted', (review.match(/Interruptions: 2/g) || []).length === 2);
  check('the missing rate is flagged as blacked out', /blacked out/i.test(await text(page, '.imp-notes')) && /Demurrage rate, per day/.test(await text(page, '.imp-notes')) && /enter it by hand/.test(await text(page, '.imp-notes')));
  check('a note about a port names the port', /Statement of facts: interruptions — Port 2 · Discharging · Alexandria/.test(await text(page, '.imp-notes')), await text(page, '.imp-notes'));
  check('readings left are shown', /Readings left today: 7/.test(review));
  check('no “keep” question when both documents were read', (await page.locator('#imp-keep').count()) === 0);
  await shot(page, 'imp-03-review');
  await page.click('[data-act="imp-back"]');
  check('“Back” returns to the pages, which are still there', (await page.locator('.imp-page').count()) === 4);
  await page.evaluate(() => { const s = window.__stalia.imp._state; s.step = 'review'; window.__stalia.imp.render(); });

  console.log('into the calculator');
  await page.click('[data-act="imp-apply"]');
  check('the screen closes', !(await page.locator('#import').isVisible()));
  check('the form is filled in', (await page.inputValue('#f-meta-vessel')) === 'MV EXAMPLE TRADER' && (await page.inputValue('#f-ports-0-nor-tendered')) === '2026-03-06T09:00' && (await page.inputValue('#f-ports-1-allowed-rate')) === '5000');
  check('the toast offers undo', /Filled in from the documents/.test(await text(page, '#toast')) && /Undo/.test(await text(page, '#toast')));
  check('the banner asks to check and lists the notes', /Check every value/.test(await text(page, '#banner')) && (await page.locator('#banner .imp-note').count()) === 2);
  check('the empty rate is highlighted', await page.evaluate(() => document.getElementById('f-demurrageRate').classList.contains('chk')));
  check('time is computed although the rate is missing', /1d 17h 00m/.test(await text(page, '#summary')), await text(page, '#summary'));
  await shot(page, 'imp-04-applied');
  await page.locator('#banner .imp-note').first().locator('[data-act="note-go"]').click();
  check('“Show the field” puts the cursor there', await page.evaluate(() => document.activeElement && document.activeElement.id) === 'f-demurrageRate');
  await page.keyboard.type('14500');
  check('with the rate typed in, the result is the known one', /USD 23,841\.93/.test(await text(page, '#summary')), await text(page, '#summary'));
  check('the note is gone once its field is edited', (await page.locator('#banner .imp-note').count()) === 1 && !(await page.evaluate(() => document.getElementById('f-demurrageRate').classList.contains('chk'))));
  await page.reload({ waitUntil: 'networkidle' });
  check('after a reload the calculation and its note are still there', /USD 23,841\.93/.test(await text(page, '#summary')) && (await page.locator('#banner .imp-note').count()) === 1);
  await page.click('[data-act="notes-close"]');
  check('the banner can be closed', (await page.locator('#banner .b-notes').count()) === 0);

  console.log('one document only');
  scenario.name = 'sofOnly';
  await page.click('.bar [data-act="imp-open"]');
  check('pages of the previous reading are gone', (await page.locator('.imp-page').count()) === 0);
  await addTo(page, 'sof', docs.sofLoad);
  await page.waitForFunction(() => document.querySelectorAll('.imp-page').length === 1 && !window.__stalia.imp._state.busy);
  await page.click('[data-act="imp-read"]');
  await page.waitForSelector('.imp-h', { timeout: 30000 });
  check('the model was told there is no charter party', /No charter party pages were supplied/.test(mock.requests[1].body.messages[0].content.slice(-1)[0].text));
  check('asks whether to keep the terms', await page.locator('#imp-keep').isChecked() && /keep the terms of the current calculation/.test(await text(page, '.imp-keep')));
  const kept = await text(page, '#imp-body');
  check('with “keep”: old terms, new times, nothing to flag', /Demurrage USD 14,500/.test(kept) && /SSHEX/.test(kept) && /01 Jun 2026 09:30/.test(kept) && /Nothing to flag/.test(kept), kept);
  await page.uncheck('#imp-keep');
  const fresh = await text(page, '#imp-body');
  check('without it: a new calculation, and the missing terms are flagged', !/14,500/.test(fresh) && /not found/i.test(fresh) && /Laytime allowed/.test(fresh), fresh);
  await page.check('#imp-keep');
  await page.click('[data-act="imp-apply"]');
  const merged = await page.evaluate(() => { const c = window.__stalia.state.calc; return { ports: c.ports.length, rate: c.demurrageRate, nor: c.ports[0].nor.tendered, qty: c.ports[0].allowed.quantity, r: c.ports[0].allowed.rate, cal: c.ports[0].calendar.preset, ev: c.ports[0].events.length, voyage: c.meta.voyage, cp: c.meta.cpForm }; });
  check('the calculation keeps its terms and takes the new voyage', JSON.stringify(merged) === JSON.stringify({ ports: 1, rate: '14500', nor: '2026-06-01T09:30', qty: '26800', r: '8000', cal: 'SSHEX', ev: 1, voyage: 'V.015', cp: 'Gencon 1994' }), JSON.stringify(merged));
  check('and computes', /USD/.test(await text(page, '#summary')) && !/incomplete/i.test(await text(page, '#summary')), await text(page, '#summary'));
  await page.locator('#toast button').click();
  check('Undo brings the previous calculation back', (await page.evaluate(() => window.__stalia.state.calc.ports.length)) === 2 && /USD 23,841\.93/.test(await text(page, '#summary')));

  console.log('when reading fails');
  scenario.name = 'refusal';
  await page.click('.bar [data-act="imp-open"]');
  await addTo(page, 'cp', docs.cpPages[0]);
  await page.waitForFunction(() => document.querySelectorAll('.imp-page').length === 1 && !window.__stalia.imp._state.busy);
  await page.click('[data-act="imp-read"]');
  await page.waitForSelector('#imp-body .note-err');
  check('a refused reading is explained', /could not be read/.test(await text(page, '#imp-body .note-err')));
  check('the pages stay for another try', (await page.locator('.imp-page').count()) === 1 && !(await page.locator('[data-act="imp-read"]').isDisabled()));
  scenario.name = 'nothing';
  await page.click('[data-act="imp-read"]');
  await page.waitForFunction(() => /No laytime terms/.test(document.querySelector('#imp-body .note-err') ? document.querySelector('#imp-body .note-err').innerText : ''));
  check('pages without laytime terms are said to be so', true);
  // too many pages are stopped before anything is sent
  const sentBefore = mock.requests.length;
  await page.evaluate(() => { const s = window.__stalia.imp._state; const p = s.pages[0]; for (let i = 0; i < 21; i++) s.pages.push(Object.assign({}, p, { id: 'x' + i, marks: [] })); window.__stalia.imp.render(); });
  await page.click('[data-act="imp-read"]');
  check('more than 20 pages: asked to remove some', /more than 20 pages/.test(await text(page, '#imp-body .note-err')) && mock.requests.length === sentBefore);
  await page.locator('.imp-page [data-act="imp-remove"]').first().click();
  check('a page can be removed', (await page.locator('.imp-page').count()) === 21);
  // the free allowance runs out
  await page.evaluate(() => { const s = window.__stalia.imp._state; s.pages = s.pages.slice(0, 1); window.__stalia.imp.render(); });
  scenario.name = 'sofOnly';
  let outOfFree = '';
  for (let i = 0; i < 9 && !outOfFree; i++) {
    await page.click('[data-act="imp-read"]');
    await page.waitForFunction(() => !window.__stalia.imp._state.busy);
    if (await page.locator('#imp-body .note-err').count()) outOfFree = await text(page, '#imp-body .note-err');
    else await page.click('[data-act="imp-back"]');
  }
  check('when the free readings are used up, Pro is offered', /free readings for today are used up/.test(outOfFree) && (await page.locator('#imp-body .note-err [data-act="pro"]').count()) === 1, outOfFree);
  await page.click('#imp-body .note-err [data-act="pro"]');
  check('the Pro window opens above', await page.locator('#dlg').isVisible() && /More document readings per day/.test(await text(page, '#dlg')));
  await page.fill('#lic-key', PRO_KEY);
  await page.click('#lic-btn');
  await page.waitForFunction(() => window.__stalia.lic.get().pro);
  await page.click('#dlg [data-act="dlg-close"]');
  await page.click('[data-act="imp-read"]');
  await page.waitForSelector('.imp-h', { timeout: 30000 });
  check('with a Pro licence the reading goes through', /Readings left today: 19/.test(await text(page, '#imp-body')) && serverLog[serverLog.length - 1].plan === 'pro', await text(page, '#imp-body'));
  check('the licence key itself never reaches the model', !JSON.stringify(mock.requests[mock.requests.length - 1].body).includes(PRO_KEY.slice(0, 40)));

  console.log('Back and Escape');
  await page.click('[data-act="imp-back"]');
  await page.locator('.imp-thumb').first().click();
  check('marking is open', await page.locator('#redact').isVisible());
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('redact').hidden);
  check('Back closes the marking screen only', await page.locator('#import').isVisible());
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('import').hidden);
  check('Back again closes “From documents”', (await page.url()).startsWith(base + '/app/'));
  await page.click('.bar [data-act="imp-open"]');
  await page.locator('.imp-thumb').first().click();
  await page.keyboard.press('Escape');
  check('Escape closes marking', !(await page.locator('#redact').isVisible()) && await page.locator('#import').isVisible());
  await page.keyboard.press('Escape');
  check('Escape closes the screen', !(await page.locator('#import').isVisible()));

  console.log('pasting and dropping');
  await page.click('.bar [data-act="imp-open"]');
  const n0 = await page.locator('.imp-page').count();
  const png = fs.readFileSync(docs.cpPages[1]).toString('base64');
  await page.evaluate(async (b64) => {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.waitForFunction((n) => document.querySelectorAll('.imp-page').length === n + 1 && !window.__stalia.imp._state.busy, n0);
  check('a pasted screenshot becomes a page', true);
  await page.evaluate(async (b64) => {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'page.png', { type: 'image/png' }));
    const slot = document.querySelector('.imp-slot[data-doc="cp"]');
    slot.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    slot.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.waitForFunction((n) => document.querySelectorAll('.imp-page').length === n + 2 && !window.__stalia.imp._state.busy, n0);
  check('a dropped file lands in the slot it was dropped on', (await tiles(page, 'cp').count()) >= 1);
  await addTo(page, 'cp', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForFunction(() => !window.__stalia.imp._state.busy && document.querySelector('#imp-body .note-err'));
  check('a file that is not a picture or a PDF is turned away', /could not be opened/.test(await text(page, '#imp-body .note-err')));
  await addTo(page, 'cp', { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 this is not a real pdf') });
  await page.waitForFunction(() => !window.__stalia.imp._state.busy && /PDF could not be opened/.test(document.querySelector('#imp-body .note-err') ? document.querySelector('#imp-body .note-err').innerText : ''));
  check('a broken PDF is turned away with advice', true);
  await page.click('[data-act="imp-close"]');

  console.log('every language');
  for (const lang of I.LANGS) {
    await page.selectOption('#lang-select', lang);
    await page.click('.bar [data-act="imp-open"]');
    const title = await text(page, '#import .cap'), bodyText = await text(page, '#imp-body');
    // the heading is shown in capitals, and Greek capitals drop their accents
    const plain = (v) => norm(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ς/g, 'σ');
    const ok = plain(title) === plain(I.t(lang, 'imp.title')) && bodyText.includes(norm(I.t(lang, 'imp.privacy'))) && bodyText.includes(norm(I.t(lang, 'imp.cp')));
    check(lang + ': the screen is translated', ok, title + ' / ' + bodyText.slice(0, 120));
    check(lang + ': no sideways scroll', await page.evaluate(() => document.getElementById('import').scrollWidth <= document.getElementById('import').clientWidth + 1));
    if (lang === 'zh' || lang === 'el') await shot(page, 'imp-lang-' + lang);
    await page.click('[data-act="imp-close"]');
  }
  await page.selectOption('#lang-select', 'en');

  console.log('no reading server: one’s own key');
  const off = await newPage();
  await off.goto(baseOff + '/app/', { waitUntil: 'networkidle' });
  await off.click('.bar [data-act="imp-open"]');
  check('without a reading server the screen says so at once', /not switched on/.test(await text(off, '#imp-body .note-warn')));
  check('and offers reading with one’s own key', await off.locator('#imp-key').evaluate((d) => d.open) && /kept on this device only/.test(await text(off, '#imp-key')));
  await off.fill('#imp-key-in', 'not a key');
  await off.click('[data-act="imp-key-save"]');
  check('something that is not a key is not saved', (await off.locator('#imp-key-in').count()) === 1 && await off.evaluate(() => localStorage.getItem('stalia.ai.v1') === null));
  const OWN_KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyzABCD';
  await off.fill('#imp-key-in', '  ' + OWN_KEY + ' ');
  await off.click('[data-act="imp-key-save"]');
  check('a key is saved and shown only in part', /in use on this device/.test(await text(off, '#imp-key')) && /sk-ant-…ABCD/.test(await text(off, '#imp-key')) && !(await text(off, '#imp-key')).includes(OWN_KEY));
  check('the warning is gone', (await off.locator('#imp-body .note-warn').count()) === 0);
  scenario.name = 'full';
  await addTo(off, 'cp', docs.cpPages[0]);
  await off.waitForFunction(() => document.querySelectorAll('.imp-page').length === 1 && !window.__stalia.imp._state.busy);
  let n = mock.requests.length;
  await off.click('[data-act="imp-read"]');
  await off.waitForSelector('.imp-h', { timeout: 30000 });
  let direct = mock.requests[n];
  check('the pages go straight to the API with that key', mock.requests.length === n + 1 && (direct.headers['x-api-key'] === OWN_KEY || direct.headers.authorization === 'Bearer ' + OWN_KEY));
  check('as a declared call from a browser', direct.headers['anthropic-dangerous-direct-browser-access'] === 'true' && /^http:\/\/127\.0\.0\.1/.test(direct.headers.origin || ''));
  check('on the cheaper model by default, with the same instruction as the server uses', direct.body.model === 'claude-haiku-5-5' && /Solid black rectangles are deliberate/.test(direct.body.system) && direct.body.messages[0].content.filter((c) => c.type === 'image').length === 1);
  check('the review appears as usual', /MV EXAMPLE TRADER/.test(await text(off, '#imp-body')));
  await off.click('[data-act="imp-back"]');
  await off.selectOption('#imp-key-model', 'claude-sonnet-5-5');
  n = mock.requests.length;
  await off.click('[data-act="imp-read"]');
  await off.waitForSelector('.imp-h', { timeout: 30000 });
  check('the other model can be chosen', mock.requests[n].body.model === 'claude-sonnet-5-5' && mock.requests[n].body.fallbacks === 'default');
  await off.click('[data-act="imp-close"]');
  await off.reload({ waitUntil: 'networkidle' });
  await off.click('.bar [data-act="imp-open"]');
  check('with a key saved the option is folded away', !(await off.locator('#imp-key').evaluate((d) => d.open)));
  await off.locator('#imp-key summary').click();
  check('key and model are remembered on this device', /sk-ant-…ABCD/.test(await text(off, '#imp-key')) && (await off.inputValue('#imp-key-model')) === 'claude-sonnet-5-5');
  // Anthropic turning the request down is explained in its own words
  const turnDown = answers.full; answers.full = () => ({ status: 401, error: 'authentication_error' });
  await addTo(off, 'cp', docs.cpPages[0]);
  await off.waitForFunction(() => document.querySelectorAll('.imp-page').length === 1 && !window.__stalia.imp._state.busy);
  await off.click('[data-act="imp-read"]');
  await off.waitForSelector('#imp-body .note-err');
  check('a key that Anthropic refuses is reported with Anthropic’s reason', /Anthropic did not accept the request: scripted failure/.test(await text(off, '#imp-body .note-err')), await text(off, '#imp-body .note-err'));
  answers.full = turnDown;
  await off.click('[data-act="imp-key-remove"]');
  check('the key can be removed', await off.evaluate(() => localStorage.getItem('stalia.ai.v1') === null) && (await off.locator('#imp-key-in').count()) === 1 && (await off.locator('#imp-body .note-warn').count()) === 1);
  await off.close();

  console.log('on a phone');
  const phone = await newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await phone.goto(base + '/app/', { waitUntil: 'networkidle' });
  scenario.name = 'full';
  await phone.evaluate((k) => window.__stalia.lic.activate(k), PRO_KEY); // the free readings of this address were used up above
  await phone.click('.bar [data-act="imp-open"]');
  check('phone: the camera button is offered', (await phone.locator('[data-act="imp-cam"]').count()) === 2);
  check('phone: the camera input asks for the back camera', (await phone.getAttribute('#imp-cam', 'capture')) === 'environment');
  await addTo(phone, 'cp', docs.cpPages);
  await phone.waitForFunction(() => document.querySelectorAll('.imp-page').length === 2 && !window.__stalia.imp._state.busy);
  await addTo(phone, 'sof', [docs.sofLoad, docs.sofDischarge]);
  await phone.waitForFunction(() => document.querySelectorAll('.imp-page').length === 4 && !window.__stalia.imp._state.busy);
  check('phone: no sideways scroll in the list', await phone.evaluate(() => document.getElementById('import').scrollWidth <= document.getElementById('import').clientWidth + 1));
  await shot(phone, 'imp-phone-01-documents');
  await phone.locator('.imp-thumb').first().tap();
  await phone.waitForFunction(() => { const im = document.querySelector('#rd-page img'); return im && im.complete && im.naturalWidth > 0; });
  const pr = await phone.locator('#rd-page').boundingBox();
  check('phone: the page fits the screen', pr.width <= 390 && pr.height <= 800 && pr.width > 250, JSON.stringify(pr));
  check('phone: tools fit', await phone.evaluate(() => document.getElementById('redact').scrollWidth <= 391));
  // one finger marks; two fingers move and zoom
  const finger = (type, id, x, y) => phone.evaluate(([t, i, px, py]) => {
    const target = document.elementFromPoint(px, py) || document.getElementById('rd-stage');
    target.dispatchEvent(new PointerEvent(t, { pointerId: i, pointerType: 'touch', isPrimary: i === 1, clientX: px, clientY: py, bubbles: true, cancelable: true, button: 0, buttons: t === 'pointerup' ? 0 : 1 }));
  }, [type, id, x, y]);
  const at = (fx, fy) => [pr.x + pr.width * fx, pr.y + pr.height * fy];
  let [x0, y0] = at(0.30, 0.215), [x1, y1] = at(0.80, 0.262);
  await finger('pointerdown', 1, x0, y0); await finger('pointermove', 1, (x0 + x1) / 2, (y0 + y1) / 2); await finger('pointermove', 1, x1, y1); await finger('pointerup', 1, x1, y1);
  check('phone: one finger draws a mark', (await phone.locator('.rd-mark').count()) === 1);
  [x0, y0] = at(0.4, 0.5); [x1, y1] = at(0.6, 0.6);
  await finger('pointerdown', 1, x0, y0); await finger('pointerdown', 2, x1, y1);
  await finger('pointermove', 1, x0 - 50, y0 - 60); await finger('pointermove', 2, x1 + 50, y1 + 60);
  await finger('pointerup', 1, x0 - 50, y0 - 60); await finger('pointerup', 2, x1 + 50, y1 + 60);
  const pz = await phone.locator('#rd-page').boundingBox();
  check('phone: two fingers zoom and leave no mark', pz.width > pr.width * 1.3 && (await phone.locator('.rd-mark').count()) === 1, pz.width + ' vs ' + pr.width);
  await shot(phone, 'imp-phone-02-blacking-out');
  await phone.locator('[data-act="rd-done"]').tap();
  await phone.locator('[data-act="imp-read"]').tap();
  await phone.waitForSelector('.imp-h', { timeout: 30000 });
  check('phone: the review fits', await phone.evaluate(() => document.getElementById('import').scrollWidth <= document.getElementById('import').clientWidth + 1));
  await shot(phone, 'imp-phone-03-review');
  await phone.locator('[data-act="imp-apply"]').tap();
  check('phone: applied, banner fits', await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth) && (await phone.locator('#banner .imp-note').count()) === 2);
  await shot(phone, 'imp-phone-04-applied');
  await phone.close();

  check('no console errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  for (const s of [site, siteOff, reader]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await mock.close();
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
