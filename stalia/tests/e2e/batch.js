#!/usr/bin/env node
/*
 * A month's work in a real browser against the real server (needs Playwright + Chromium and server/node_modules):
 * a contract with its rules for delays, a scan cut into voyages and read under that contract, the calculations it
 * leaves in the company space, the counterparty's figures pasted next to them and the gap explained.
 * The reading itself is a stand-in that answers like a reader would; everything else is the real thing.
 *   node tests/e2e/batch.js             SHOTS=/some/dir node tests/e2e/batch.js   also saves screenshots
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { build } = require('../../tools/build-site.js');
const { makeSampleDocs } = require('./sample-docs.js');
const { extractionOf } = require('../helpers/extraction.js');
const E = require('../../app/engine.js');
const M = require('../../app/model.js');
const A = require('../../app/audit.js');

const SHOTS = process.env.SHOTS || '';
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failures.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + String(detail).slice(0, 500) : '')); }
}
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
const usd = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- what the stand-in reader answers
/** The built-in bulk example as a time sheet read `days` later, the way a reader returns it when the contract came in words. */
function voyage(days, change) {
  const calc = M.normalizeCalc(M.examples('en')[0].calc);
  const ex = extractionOf(calc);
  ex.documents = { charter_party: 'absent', statement_of_facts: 'read' };
  ex.laytime.delay_rules = [];
  const shift = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v || '') ? E.fmtDT(E.parseDT(v) + days * 1440) : v);
  for (const p of ex.ports) {
    p.notice.tendered = shift(p.notice.tendered); p.operations_commenced = shift(p.operations_commenced); p.operations_completed = shift(p.operations_completed);
    // the holidays the time sheet names move with the voyage
    p.working_time.holidays = p.working_time.holidays.map((h) => ({ date: shift(h.date + 'T00:00').slice(0, 10), name: h.name }));
    for (const e of p.events) { e.from = shift(e.from); e.to = shift(e.to); }
  }
  ex.notes = [];
  if (change) change(ex);
  return ex;
}
const ANSWERS = {
  // two pages: the reader took the rain as not counting at all and deducted on demurrage too; the contract says half
  2: () => voyage(0, (ex) => {
    ex.fixture.voyage = 'V.014';
    const rain = ex.ports[0].events.find((e) => e.type === 'weather');
    rain.counts_percent = '0'; rain.on_demurrage = 'stops_too';
    ex.notes.push({ field: 'nor_tendered', port: 1, status: 'ambiguous', comment: 'The notice time reads 09:00 or 09:30: check it.' });
  }),
  // three pages: the next voyage, four weeks later
  3: () => voyage(28, (ex) => { ex.fixture.voyage = 'V.015'; }),
  // one page: only the loading port made it into the scan
  1: () => voyage(56, (ex) => { ex.fixture.voyage = 'V.016'; ex.ports[1].notice.tendered = ''; ex.ports[1].operations_commenced = ''; ex.ports[1].operations_completed = ''; ex.ports[1].events = []; }),
};

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-batch-e2e-'));
  build(out);
  const node = await import('../../server/node-server.js');
  const { MemoryStore } = await import('../../server/src/limits.js');
  const asked = [];
  let failNext = 1; // the first reading of the three-page voyage fails once, as a busy service would
  const read = async ({ pages, lang, terms }) => {
    asked.push({ pages: pages.length, lang, terms, docs: pages.map((p) => p.doc).join('') });
    await new Promise((r) => setTimeout(r, 120));
    if (pages.length === 3 && failNext-- > 0) throw Object.assign(new Error('overloaded'), { code: 'overloaded' });
    return { extraction: ANSWERS[pages.length](), model: 'stand-in', usage: { input: 1, output: 1 } };
  };
  const server = await node.start({ STATIC_DIR: out, SPACE_DB: ':memory:', ANTHROPIC_API_KEY: 'stand-in', FREE_PER_DAY: '40' },
    { port: 0, host: '127.0.0.1', deps: { store: new MemoryStore(), log: () => {}, read, createClient: () => ({}) } });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const docs = await makeSampleDocs(browser, out);
  const errors = [];
  const person = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 }, locale: 'en-US', acceptDownloads: true }, opts || {}));
    await ctx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/status of (40[1-9]|409|5\d\d)/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const text = async (page, sel) => norm(await page.locator(sel).first().innerText());
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };

  // ------------------------------------------------------------ the contract's rules for delays
  console.log('a contract with rules for delays');
  const a = await person();
  await a.goto(base + '/app/', { waitUntil: 'networkidle' });
  const before = await text(a, '#summary');
  check('the terms have a place for the contract’s rules on delays, empty at first', (await a.locator('#f-rules .rule').count()) === 0 && /How delays count under this contract/.test(await text(a, '#f-rules')));
  await a.click('[data-act="add-rule"]');
  check('a new rule starts from the usual effect of its kind and changes nothing', (await a.inputValue('#f-rules-0-type')) === 'weather' && (await a.inputValue('#f-rules-0-countPct')) === '0' && (await text(a, '#summary')) === before);
  await a.fill('#f-rules-0-countPct', '50');
  const rule = M.normalizeCalc(M.examples('en')[0].calc);
  rule.rules = [{ type: 'weather', countPct: '50', alsoOnDemurrage: false }];
  M.applyRules(rule);
  const withRule = E.compute(rule).totals.net;
  await a.waitForFunction((want) => document.querySelector('#summary').innerText.replace(/\s+/g, ' ').includes(want), usd(withRule));
  check('editing the rule moves every event of that kind, and the result with it', (await a.inputValue('#f-ports-0-events-2-countPct')) === '50' && (await text(a, '#summary')) !== before, await a.inputValue('#f-ports-0-events-2-countPct'));
  check('the caret stays in the field being typed in', await a.evaluate(() => document.activeElement && document.activeElement.id === 'f-rules-0-countPct'));
  await a.selectOption('#f-ports-0-events-2-type', 'shifting');
  await a.selectOption('#f-ports-0-events-2-type', 'weather');
  check('an event switched to a ruled kind takes the rule, not the usual effect', (await a.inputValue('#f-ports-0-events-2-countPct')) === '50');
  check('one rule per kind: the other rules cannot be given the same one', (await a.locator('[data-act="add-rule"]').count()) === 1 && await (async () => {
    await a.click('[data-act="add-rule"]');
    const opts = await a.locator('#f-rules-1-type option').allInnerTexts();
    await a.click('[data-act="del-rule"][data-idx="1"]');
    return opts.length === M.RULE_TYPES.length - 1 && (await a.locator('#f-rules .rule').count()) === 1;
  })());
  await shot(a, 'batch-01-rules');

  // ------------------------------------------------------------ a space and the contract in it
  await a.click('#space-btn');
  await a.fill('#sp-company', 'ACME Shipping LLP');
  await a.fill('#sp-name', 'Aigerim');
  await a.click('[data-act="sp-create"]');
  await a.waitForSelector('.sp-tabs');
  check('a scan can be read only under a contract', await (async () => {
    await a.click('[data-act="sp-tab"][data-tab="batch"]');
    return /Save a contract first/.test(await text(a, '.sp-pane'));
  })());
  await a.click('.sp-pane [data-act="sp-tab"][data-tab="contracts"]');
  await a.fill('#sp-ct-name', 'Grain 2026');
  await a.click('[data-act="sp-ct-save"]');
  await a.waitForSelector('.sp-list li');
  check('the contract is kept, and offers to read a scan under it', /Grain 2026/.test(await text(a, '.sp-list')) && (await a.locator('.sp-list [data-act="sp-b-start"]').count()) === 1);

  // ------------------------------------------------------------ the scan, cut into voyages
  console.log('a scan cut into voyages');
  await a.click('.sp-list [data-act="sp-b-start"]');
  check('the scan screen opens under that contract', /Voyages from a scan/.test(await text(a, '.sp-tab.on')) && /Grain 2026/.test(await text(a, '#sp-b-ct option:checked')) && (await a.inputValue('#sp-b-per')) === '2');
  await a.fill('#sp-b-per', '3');
  await a.locator('#sp-b-per').dispatchEvent('change');
  await a.setInputFiles('#sp-b-file', [docs.cpPdf, docs.sofLoad, docs.sofDischarge, docs.cpPages[0], docs.cpPages[1]]);
  await a.waitForSelector('.sp-b-voy');
  check('a PDF and photos become pages, three to a voyage', (await a.locator('.sp-b-voy figure').count()) === 6 && (await a.locator('.sp-b-voy').count()) === 2 && /Pages: 6\. Voyages: 2\./.test(await text(a, '#sp-b-count')), await text(a, '#sp-b-count'));
  await a.click('[data-act="sp-b-cut"][data-i="2"]');
  check('a voyage can be cut where it really starts', (await a.locator('.sp-b-voy').count()) === 3 && /Pages: 6\. Voyages: 3\./.test(await text(a, '#sp-b-count')) && /Read the voyages: 3/.test(await text(a, '[data-act="sp-b-go"]')));
  check('and the cut can be taken back', await (async () => {
    await a.click('[data-act="sp-b-cut"][data-i="2"]');
    const two = (await a.locator('.sp-b-voy').count()) === 2;
    await a.click('[data-act="sp-b-cut"][data-i="2"]');
    return two && (await a.locator('.sp-b-voy').count()) === 3 && /Join to the voyage before/.test(await text(a, '[data-act="sp-b-cut"][data-i="2"]'));
  })());
  await shot(a, 'batch-02-cut');

  // ------------------------------------------------------------ reading
  console.log('reading the voyages');
  await a.click('[data-act="sp-b-go"]');
  await a.waitForFunction(() => /Saved as calculations: 2 of 3/.test((document.querySelector('#sp-b-status') || {}).innerText || ''));
  check('each voyage went to the reader as time sheets with the contract in words, the rule for weather among them',
    asked.length === 3 && asked.every((q) => /^(sof)+$/.test(q.docs) && /Demurrage USD 14500 per day/.test(q.terms) && /type "weather"\): counts 50% as laytime; on demurrage such time counts in full/.test(q.terms)) &&
    asked.map((q) => q.pages).sort().join() === '1,2,3', JSON.stringify(asked.map((q) => [q.pages, q.docs, q.terms.slice(0, 60)])));
  let rows = await text(a, '.sp-pane .sp-table');
  check('two voyages are saved, the third says what went wrong and can be tried again', /V\.014/.test(rows) && /V\.016/.test(rows) && (await a.locator('tr[data-st="failed"] [data-act="sp-b-retry"]').count()) === 1 && /returned an error|try again/i.test(await text(a, 'tr[data-st="failed"]')), rows);
  // the one-page voyage lacks its second port: that it does not add up, and the two times that are missing
  check('what was left to check is counted per voyage', /to check: 1/.test(await text(a, 'tr[data-k="0"]')) && /to check: 3/.test(await text(a, 'tr[data-k="1"]')) && / — /.test(' ' + await text(a, 'tr[data-k="1"]') + ' '), rows);
  await a.click('[data-act="sp-b-retry"]');
  await a.waitForFunction(() => /Saved as calculations: 3 of 3/.test((document.querySelector('#sp-b-status') || {}).innerText || ''));
  rows = await text(a, '.sp-pane .sp-table');
  check('the retry reads the missing voyage and nothing else twice', asked.length === 4 && /V\.015/.test(rows) && /nothing flagged/.test(await text(a, 'tr[data-k="2"]')), rows);
  check('the result of a voyage is the contract’s reading of it, not the reader’s', new RegExp('Demurrage USD ' + usd(withRule).replace(/[.]/g, '\\.')).test(await text(a, 'tr[data-k="0"]')), await text(a, 'tr[data-k="0"]'));
  check('the summary says how much is left to look at', /To check: 4 points in 2 voyages/.test(await text(a, '.sp-pane')), await text(a, '.sp-pane .note'));
  await shot(a, 'batch-03-done');

  // ------------------------------------------------------------ the calculations it left
  console.log('the calculations in the space');
  await a.click('[data-act="sp-b-list"]');
  await a.waitForSelector('.sp-pane .sp-table tr[data-id]');
  const titles = await a.locator('.sp-pane .sp-table tr[data-id] .sp-open b').allInnerTexts();
  check('three calculations under the contract, the latest voyage first', titles.length === 3 && /V\.016/.test(titles[0]) && /V\.015/.test(titles[1]) && /V\.014/.test(titles[2]) && /Grain 2026/.test(await text(a, '.sp-pane .sp-table')), titles.join(' | '));
  check('the list marks what still needs a look', (await a.locator('.sp-pane .sp-flags').count()) === 2);
  await a.click('.sp-pane .sp-table tr[data-id] >> nth=2 >> .sp-open');
  await a.waitForFunction(() => /version 1 of 1/.test(document.querySelector('#cloudbar').innerText));
  check('a voyage opens with the contract’s terms and the time sheet’s facts', (await a.inputValue('#f-demurrageRate')) === '14500' && (await a.inputValue('#f-meta-voyage')) === 'V.014' && (await a.inputValue('#f-rules-0-countPct')) === '50' && (await a.inputValue('#f-ports-0-nor-tendered')) === '2026-03-06T09:00');
  check('a voyage that was just opened has nothing unsaved', !/not saved/.test(await text(a, '#cloudbar')) && (await a.locator('[data-act="sp-save"]').isDisabled()), await text(a, '#cloudbar'));
  check('the rain counts as the contract says, whatever the reader made of it', (await a.inputValue('#f-ports-0-events-2-countPct')) === '50' && !(await a.isChecked('#f-ports-0-events-2-alsoOnDemurrage')));
  check('what the reading left to check is shown to whoever opens it', /09:00 or 09:30/.test(await text(a, '#banner')), await text(a, '#banner').catch(() => 'no banner'));
  // dealing with the point is a change worth saving: the list then stops asking for a look
  await a.click('[data-act="notes-close"]');
  await a.waitForFunction(() => /not saved/.test(document.querySelector('#cloudbar').innerText));
  await a.click('[data-act="sp-save"]');
  await a.fill('#sp-note', 'Notice time checked against the original');
  await a.click('[data-act="sp-save-go"]');
  await a.waitForFunction(() => /version 2 of 2/.test(document.querySelector('#cloudbar').innerText));
  await a.click('#space-btn');
  await a.waitForSelector('.sp-pane .sp-table tr[data-id]');
  check('a point that was dealt with and saved no longer shows in the list', (await a.locator('.sp-pane .sp-flags').count()) === 1);
  await a.click('[data-act="sp-close"]');
  await shot(a, 'batch-04-voyage');

  // ------------------------------------------------------------ the counterparty's figures
  console.log('the counterparty’s figures');
  // their figure for the first voyage is ours with the rain counted in full; for the second they agree; the third is not theirs to claim yet
  const full = JSON.parse(JSON.stringify(rule));
  full.ports[0].events.find((e) => e.type === 'weather').countPct = '100';
  const theirs = A.signedNet(full);
  await a.click('#space-btn');
  await a.waitForSelector('.sp-pane .sp-table tr[data-id]');
  await a.click('[data-act="sp-claims"]');
  await a.fill('#sp-cl-text', theirs.toFixed(2) + '\n' + withRule.toFixed(2));
  check('two lines for three voyages are not saved', /Lines: 2\. Voyages in the list: 3\./.test(await text(a, '#sp-cl-preview')) && (await a.locator('#sp-cl-go').isDisabled()));
  await a.fill('#sp-cl-text', usd(theirs) + '\n' + withRule.toFixed(2).replace('.', ',') + '\n0');
  check('a pasted column lands on the voyages from the earliest to the latest, with the gap shown before saving', await (async () => {
    const p = await text(a, '#sp-cl-preview');
    return /Lines: 3\. Voyages in the list: 3\./.test(p) && /1 [^|]*V\.014.*2 [^|]*V\.015.*3 [^|]*V\.016/.test(p) && /matches/.test(p) && !(await a.locator('#sp-cl-go').isDisabled());
  })(), await text(a, '#sp-cl-preview'));
  await a.click('#sp-cl-go');
  await a.waitForSelector('#sp-claims-total');
  const list = await text(a, '.sp-pane');
  const gap = Math.round((theirs - withRule) * 100) / 100;
  check('the list shows their figure and the gap for each voyage, and the totals', /Counterparty/.test(list) && /Gap/.test(list) && new RegExp('\\+USD ' + usd(gap).replace(/[.]/g, '\\.')).test(list) && /matches/.test(list) &&
    new RegExp('Counterparty: USD ' + usd(theirs + withRule).replace(/[.]/g, '\\.') + ' · gap: \\+USD ' + usd(gap).replace(/[.]/g, '\\.')).test(await text(a, '#sp-claims-total')), await text(a, '#sp-claims-total'));
  await shot(a, 'batch-05-claims');
  const [download] = await Promise.all([a.waitForEvent('download'), a.click('[data-act="sp-csv"]')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check('the monthly table carries both figures and the gap', /Counterparty,Gap\r?\n/.test(csv.split('\n')[0] + '\n') && csv.includes('"' + usd(withRule) + '","' + usd(theirs) + '","' + usd(gap) + '"'), csv.slice(0, 400));

  await a.click('.sp-pane .sp-table tr[data-id] >> nth=2 >> .sp-open');
  await a.waitForFunction(() => /version 3 of 3/.test(document.querySelector('#cloudbar').innerText));
  check('the figure is kept with the voyage as a version of its own', (await a.inputValue('#f-meta-claimAmount')) === theirs.toFixed(2) && new RegExp('Counterparty USD ' + usd(theirs).replace(/[.]/g, '\\.')).test(await text(a, '#claim')) && new RegExp('\\+USD ' + usd(gap).replace(/[.]/g, '\\.')).test(await text(a, '#claim-gap')), await text(a, '#claim'));
  await a.click('[data-act="claim-why"]');
  await a.waitForSelector('#claim-why');
  const why = await text(a, '#claim-why');
  check('the gap is explained: their amount is ours with the rain counted in full', /The two amounts are the same if one thing in our calculation is changed/.test(why) && /Port 1 \(Novorossiysk\): «[^»]+» \([^)]*09[^)]*\) counts in full/.test(await text(a, '#claim-matches')), why);
  check('and shown as one moment moved, for looking it up in the documents', /The same gap as one moment moved/.test(why) && /laytime starts at .* earlier/.test(await text(a, '#claim-shifts')), why);
  await shot(a, 'batch-06-why');
  await a.click('#dlg [data-act="dlg-close"]');
  await a.fill('#f-meta-claimAmount', withRule.toFixed(2));
  await a.waitForFunction(() => /matches/.test(document.querySelector('#claim').innerText));
  check('when the figures agree there is nothing to explain', (await a.locator('[data-act="claim-why"]').count()) === 0);
  await a.fill('#f-meta-claimAmount', '');
  check('and without their figure the line is gone', (await a.locator('#claim .claim').count()) === 0);

  // ------------------------------------------------------------ on a phone, in Russian
  await a.click('#space-btn');
  await a.waitForSelector('.sp-tabs');
  await a.click('[data-act="sp-tab"][data-tab="people"]');
  await a.click('[data-act="sp-invite"]');
  await a.waitForSelector('#sp-inv-link');
  const invite = await a.locator('#sp-inv-link').innerText();
  const phone = await person({ viewport: { width: 390, height: 844 } });
  await phone.goto(invite, { waitUntil: 'networkidle' });
  await phone.fill('#sp-name2', 'Phone');
  await phone.click('[data-act="sp-join"]');
  await phone.waitForSelector('.sp-table');
  await phone.click('[data-act="sp-close"]');
  await phone.selectOption('#lang-select', 'ru');
  await phone.click('#space-btn');
  await phone.waitForSelector('.sp-table');
  await phone.click('[data-act="sp-tab"][data-tab="batch"]');
  await phone.setInputFiles('#sp-b-file', [docs.sofLoad, docs.sofDischarge, docs.cpPages[0]]);
  await phone.waitForSelector('.sp-b-voy');
  check('phone, Russian: the scan screen fits and speaks the language', await phone.evaluate(() => document.querySelector('#space').scrollWidth <= document.querySelector('#space').clientWidth + 1) &&
    /Рейсы из скана/.test(await text(phone, '.sp-tabs')) && /Страниц: 3\. Рейсов: 2\./.test(await text(phone, '#sp-b-count')) && /Отсюда новый рейс/.test(await text(phone, '.sp-b-grid')), await text(phone, '#sp-b-count'));
  await shot(phone, 'batch-07-phone');
  await phone.click('[data-act="sp-tab"][data-tab="calcs"]');
  check('phone, Russian: the list with the counterparty’s figures fits too', await phone.evaluate(() => document.querySelector('#space').scrollWidth <= document.querySelector('#space').clientWidth + 1) && /Контрагент/.test(await text(phone, '.sp-pane')));

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(out, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
