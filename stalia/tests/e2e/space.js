#!/usr/bin/env node
/*
 * The company space in real browsers against the real server (needs Playwright + Chromium and server/node_modules).
 * Three people — the owner, a colleague and a counterparty — each in a browser of their own, work on one calculation.
 *   node tests/e2e/space.js             SHOTS=/some/dir node tests/e2e/space.js   also saves screenshots
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { build } = require('../../tools/build-site.js');

const SHOTS = process.env.SHOTS || '';
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failures.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
const norm = (s) => String(s).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'stalia-space-e2e-'));
  build(out);
  const node = await import('../../server/node-server.js');
  const { MemoryStore } = await import('../../server/src/limits.js');
  const server = await node.start({ STATIC_DIR: out, SPACE_DB: ':memory:' }, { port: 0, host: '127.0.0.1', deps: { store: new MemoryStore(), log: () => {} } });
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = [];
  const person = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1360, height: 900 }, locale: 'en-US', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] }, opts || {}));
    await ctx.addInitScript(() => { try { localStorage.setItem('stalia.welcome.v1', 'true'); } catch (e) { /* no storage */ } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[1-9]|status of 409/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const text = async (page, sel) => norm(await page.locator(sel).first().innerText());
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  const bar = (page) => text(page, '#cloudbar');
  const settled = (page) => page.waitForLoadState('networkidle');

  // ------------------------------------------------------------ the owner starts a space
  console.log('a space is started');
  const a = await person();
  await a.goto(base + '/app/', { waitUntil: 'networkidle' });
  check('the calculator offers the company space', await a.locator('#space-btn').isVisible());
  check('an untouched example is not offered for saving', !(await a.locator('#cloudbar').isVisible()));
  await a.click('#space-btn');
  check('first visit: what it is, that it is encrypted, create or join', /One place for all the calculations/.test(await text(a, '#space-body')) && /cannot read them/.test(await text(a, '#space-body')) && (await a.locator('#sp-create, [data-act="sp-create"]').count()) === 1);
  await a.click('[data-act="sp-create"]');
  check('a space needs a company and a name', /Enter a name/.test(await text(a, '#space-body')));
  await a.fill('#sp-company', 'ACME Shipping LLP');
  await a.fill('#sp-name', 'Aigerim');
  await a.click('[data-act="sp-create"]');
  await a.waitForSelector('.sp-tabs');
  check('the space opens: its name, the role, the trial', /ACME SHIPPING LLP/i.test(await text(a, '.sp-head')) && /Owner/.test(await text(a, '.sp-head')) && /Trial until/.test(await text(a, '.sp-head')));
  check('and it is empty', /No calculations here yet/.test(await text(a, '.sp-pane')));
  await shot(a, 'space-01-empty');
  await a.click('[data-act="sp-close"]');

  // ------------------------------------------------------------ a calculation goes in, then a second version
  console.log('saving and history');
  await a.fill('#f-name', 'Wheat, Novorossiysk — Alexandria, March');
  check('an edited calculation can be saved to the space', /on this device only/.test(await bar(a)) && (await a.locator('[data-act="sp-add"]').count()) === 1);
  await a.click('[data-act="sp-add"]');
  await a.waitForFunction(() => /version 1 of 1/.test(document.querySelector('#cloudbar').innerText));
  check('saved: version 1 of 1, nothing unsaved', /In the company space/.test(await bar(a)) && !/not saved/.test(await bar(a)) && (await a.locator('[data-act="sp-save"]').isDisabled()));
  await a.fill('#f-demurrageRate', '16000');
  await a.waitForFunction(() => /not saved/.test(document.querySelector('#cloudbar').innerText));
  check('a change is marked as not saved', !(await a.locator('[data-act="sp-save"]').isDisabled()));
  await a.click('[data-act="sp-save"]');
  await a.fill('#sp-note', 'Rate as per addendum 2');
  await a.click('[data-act="sp-save-go"]');
  await a.waitForFunction(() => /version 2 of 2/.test(document.querySelector('#cloudbar').innerText));
  check('second version saved', !/not saved/.test(await bar(a)));
  await a.click('[data-act="sp-history"]');
  await a.waitForSelector('.sp-hist');
  let hist = await text(a, '#dlg');
  check('history: both versions, who and why, and what the change did to the result', /v2/.test(hist) && /v1/.test(hist) && /Aigerim/.test(hist) && /Rate as per addendum 2/.test(hist) && /\+\d/.test(hist) && /first version/.test(hist), hist);
  await a.click('.sp-hist [data-act="sp-diff"]');
  await a.waitForSelector('.sp-diff li');
  check('what changed between them, in the form’s own words', /Demurrage rate[^:]*: 14500 → 16000/.test(await text(a, '.sp-diff')), await text(a, '.sp-diff'));
  await shot(a, 'space-02-history');
  await a.click('.sp-hist [data-act="sp-open-v"]');
  await a.waitForFunction(() => /version 1 of 2/.test(document.querySelector('#cloudbar').innerText));
  check('an old version opens, marked as old', (await a.inputValue('#f-demurrageRate')) === '14500' && /You are looking at version 1\. The latest is 2/.test(await bar(a)));
  await a.click('[data-act="sp-latest"]');
  await a.waitForFunction(() => /version 2 of 2/.test(document.querySelector('#cloudbar').innerText));
  check('and the latest comes back', (await a.inputValue('#f-demurrageRate')) === '16000');

  // ------------------------------------------------------------ a link for the counterparty
  console.log('a counterparty by link');
  await a.click('[data-act="sp-access"]');
  await a.waitForSelector('#sp-share-label');
  await a.fill('#sp-share-label', 'Charterers — J. Smith');
  await a.selectOption('#sp-share-role', 'edit');
  await a.click('[data-act="sp-share"]');
  await a.waitForSelector('#sp-share-link');
  const shareLink = await a.locator('#sp-share-link').innerText();
  check('a link is made, with the key after the #', new RegExp('^' + base.replace(/[.:/]/g, '\\$&') + '/app/#open=ca_[\\w-]+~s\\.sh_[\\w-]+\\.[\\w-]+~[\\w-]{43}$').test(shareLink), shareLink);
  check('the list of links says who has one', /Charterers — J\. Smith/.test(await text(a, '#dlg .sp-list')) && /not opened yet/.test(await text(a, '#dlg .sp-list')));
  await a.click('[data-act="dlg-close"]');

  const g = await person();
  await g.goto(shareLink, { waitUntil: 'networkidle' });
  await g.waitForFunction(() => /version 2 of 2/.test(document.querySelector('#cloudbar').innerText));
  check('the counterparty sees the calculation without an account', (await g.inputValue('#f-demurrageRate')) === '16000' && /Opened by a link/.test(await bar(g)) && /^http[^#]*$/.test(g.url()), g.url());
  check('but not the company’s space', (await g.locator('[data-act="sp-access"]').count()) === 0 && (await g.locator('#cb-status').count()) === 0);
  await g.click('[data-act="sp-talk"]');
  await g.waitForSelector('#sp-say');
  await g.fill('#sp-say', 'We do not accept the rain on the 7th as counting.');
  await g.click('[data-act="sp-say-go"]');
  check('a guest signs before writing', /Enter a name/.test(await text(g, '#dlg')));
  await g.fill('#sp-guest-name', 'J. Smith, Example Trading');
  await g.click('[data-act="sp-say-go"]');
  await g.waitForSelector('.sp-talk li');
  check('their comment is there, under their name', /J\. Smith, Example Trading/.test(await text(g, '.sp-talk')) && /rain on the 7th/.test(await text(g, '.sp-talk')));
  await g.click('[data-act="dlg-close"]');
  await g.fill('#f-ports-0-nor-tendered', '2026-03-06T11:00');
  await g.waitForFunction(() => /not saved/.test(document.querySelector('#cloudbar').innerText));
  await g.click('[data-act="sp-save"]');
  await g.fill('#sp-note', 'NOR as per our agents');
  await g.click('[data-act="sp-save-go"]');
  await g.waitForFunction(() => /version 3 of 3/.test(document.querySelector('#cloudbar').innerText));
  check('the counterparty’s own count becomes version 3', true);
  await shot(g, 'space-03-guest');

  // ------------------------------------------------------------ back at the company
  console.log('the company sees it');
  await a.reload({ waitUntil: 'networkidle' });
  await a.waitForFunction(() => /saved version 3/.test(document.querySelector('#cloudbar').innerText));
  check('the owner is told that somebody saved a newer version', /J\. Smith, Example Trading saved version 3/.test(await bar(a)) && /Discussion · 1/.test(await bar(a)), await bar(a));
  await a.click('.cb-note [data-act="sp-latest"]');
  await a.waitForFunction(() => /version 3 of 3/.test(document.querySelector('#cloudbar').innerText));
  check('and opens it', (await a.inputValue('#f-ports-0-nor-tendered')) === '2026-03-06T11:00');
  await a.click('[data-act="sp-history"]');
  await a.waitForSelector('.sp-hist');
  hist = await text(a, '#dlg');
  check('history tells the counterparty’s version from the company’s', /v3 .{0,40}J\. Smith, Example Trading counterparty/.test(hist) && /NOR as per our agents/.test(hist), hist);
  await a.click('.sp-hist li[data-n="3"] [data-act="sp-diff"]');
  await a.waitForSelector('#sp-diff-3 li');
  check('and what exactly they changed', /Port 1: NOR tendered[^:]*: .*09:00 → .*11:00/.test(await text(a, '#sp-diff-3')), await text(a, '#sp-diff-3'));
  await a.click('[data-act="dlg-close"]');
  await a.selectOption('#cb-status', 'disputed');
  await settled(a);

  // ------------------------------------------------------------ a colleague joins; two people save at once
  console.log('a colleague joins');
  await a.click('#space-btn');
  await a.waitForSelector('.sp-table');
  let list = await text(a, '.sp-table');
  check('the list: the calculation, its status, result and who changed it last', /Wheat, Novorossiysk — Alexandria, March/.test(list) && /Disputed/.test(list) && /Demurrage USD/.test(list) && /J\. Smith, Example Trading · counterparty · v3/.test(list), list);
  await a.click('[data-act="sp-tab"][data-tab="people"]');
  await a.click('[data-act="sp-invite"]');
  await a.waitForSelector('#sp-inv-link');
  const invite = await a.locator('#sp-inv-link').innerText();
  check('an invitation link is made', /#join=i\.in_[\w-]+\.[\w-]+~[\w-]{43}$/.test(invite), invite);
  await shot(a, 'space-04-people');
  await a.click('[data-act="sp-close"]');

  const d = await person();
  await d.goto(invite, { waitUntil: 'networkidle' });
  await d.waitForSelector('#sp-link');
  check('the invitation opens the join form with the link filled in', /^#join=/.test(await d.inputValue('#sp-link')) && !/#join/.test(d.url()));
  await d.fill('#sp-name2', 'Daniyar');
  await d.click('[data-act="sp-join"]');
  await d.waitForSelector('.sp-table');
  check('the colleague is in and sees the same list', /ACME SHIPPING LLP/i.test(await text(d, '.sp-head')) && /Editor/.test(await text(d, '.sp-head')) && /Wheat, Novorossiysk/.test(await text(d, '.sp-table')));
  await d.click('.sp-table [data-act="sp-open"]');
  await d.waitForFunction(() => /version 3 of 3/.test(document.querySelector('#cloudbar').innerText));
  check('opens the calculation from the list', (await d.inputValue('#f-ports-0-nor-tendered')) === '2026-03-06T11:00' && /Disputed/.test(await d.locator('#cb-status option:checked').innerText()));
  // both change it; the owner saves first
  await a.fill('#f-commissionPct', '5');
  await a.click('[data-act="sp-save"]');
  await a.click('[data-act="sp-save-go"]');
  await a.waitForFunction(() => /version 4 of 4/.test(document.querySelector('#cloudbar').innerText));
  await d.fill('#f-demurrageRate', '15000');
  await d.click('[data-act="sp-save"]');
  await d.click('[data-act="sp-save-go"]');
  await d.waitForSelector('[data-act="sp-save-over"]');
  check('the colleague is told instead of overwriting', /Aigerim saved version 4 while you were working/.test(await text(d, '#dlg')) && (await d.inputValue('#f-demurrageRate')) === '15000', await text(d, '#dlg'));
  await shot(d, 'space-05-conflict');
  await d.click('[data-act="sp-save-over"]');
  await d.waitForFunction(() => /version 5 of 5/.test(document.querySelector('#cloudbar').innerText));
  check('and can still save theirs on top, as version 5', true);

  // ------------------------------------------------------------ contracts and the monthly table
  console.log('contracts and the summary');
  await a.reload({ waitUntil: 'networkidle' });
  await a.click('.cb-note [data-act="sp-latest"]');
  await a.waitForFunction(() => /version 5 of 5/.test(document.querySelector('#cloudbar').innerText));
  await a.click('#space-btn');
  await a.waitForSelector('.sp-tabs');
  await a.click('[data-act="sp-tab"][data-tab="contracts"]');
  await a.fill('#sp-ct-name', 'Novorossiysk grain 2026');
  await a.fill('#sp-ct-clauses', 'Rain counts as half laytime.');
  await a.click('[data-act="sp-ct-save"]');
  await a.waitForSelector('.sp-list [data-act="sp-ct-new"]');
  check('the terms are saved as a contract', /Novorossiysk grain 2026/.test(await text(a, '.sp-list')) && /voyages: 0/.test(await text(a, '.sp-list')) && /Rain counts as half laytime/.test(await text(a, '.sp-list')));
  await a.click('.sp-list [data-act="sp-ct-new"]');
  await a.waitForFunction(() => /New voyage under/.test(document.querySelector('#cloudbar').innerText));
  check('a new voyage starts with the contract’s terms and no facts', (await a.inputValue('#f-demurrageRate')) === '15000' && (await a.inputValue('#f-ports-0-nor-tendered')) === '' && (await a.inputValue('#f-meta-vessel')) === '');
  await a.fill('#f-meta-vessel', 'MV SECOND');
  await a.fill('#f-name', 'April voyage');
  await a.fill('#f-ports-0-allowed-quantity', '20000');
  await a.fill('#f-ports-1-allowed-quantity', '20000');
  await a.fill('#f-ports-0-nor-tendered', '2026-04-02T09:00');
  await a.fill('#f-ports-0-completed', '2026-04-09T12:00');
  await a.fill('#f-ports-1-nor-tendered', '2026-04-14T09:00');
  await a.fill('#f-ports-1-completed', '2026-04-24T18:00');
  await a.click('[data-act="sp-add"]');
  await a.waitForFunction(() => /version 1 of 1/.test(document.querySelector('#cloudbar').innerText));
  await a.click('#space-btn');
  await a.waitForSelector('.sp-table');
  check('two calculations, with a total', (await a.locator('.sp-table tbody tr').count()) === 2 && /Shown: 2\. Total: Demurrage USD/.test(await text(a, '#sp-total')), await text(a, '#sp-total'));
  await a.selectOption('.sp-tools select[data-sp="contract"]', { label: 'Novorossiysk grain 2026' });
  check('filtered by contract: one voyage, its own total', (await a.locator('.sp-table tbody tr').count()) === 1 && /April voyage/.test(await text(a, '.sp-table')) && /Shown: 1\./.test(await text(a, '#sp-total')));
  await a.selectOption('.sp-tools select[data-sp="contract"]', '');
  await a.fill('#sp-q', 'second');
  check('search finds by vessel', (await a.locator('.sp-table tbody tr').count()) === 1 && /MV SECOND/.test(await text(a, '.sp-table')));
  await a.fill('#sp-q', '');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('[data-act="sp-csv"]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  check('the summary downloads as a table', /\.csv$/.test(dl.suggestedFilename()) && csv.split('\r\n').filter(Boolean).length === 3 && /MV SECOND/.test(csv) && /Novorossiysk grain 2026/.test(csv) && /Amount/.test(csv), csv.slice(0, 300));
  await shot(a, 'space-06-list');

  // ------------------------------------------------------------ withdrawing access; small screens; other languages
  console.log('withdrawing, phone, Russian');
  await a.click('.sp-table tbody tr:last-child [data-act="sp-open"]');
  await a.waitForFunction(() => /version 5 of 5/.test(document.querySelector('#cloudbar').innerText));
  await a.click('[data-act="sp-access"]');
  await a.waitForSelector('#dlg .sp-list');
  check('the link shows that it was used', /last opened/.test(await text(a, '#dlg .sp-list')));
  await a.click('[data-act="sp-unshare"]');
  await a.waitForFunction(() => /No links yet/.test(document.querySelector('#dlg').innerText));
  await a.click('[data-act="dlg-close"]');
  await g.reload({ waitUntil: 'networkidle' });
  check('a withdrawn link stops working', !(await g.locator('#cloudbar').isVisible()) || !/version/.test(await bar(g)), await bar(g).catch(() => ''));

  const phone = await person({ viewport: { width: 390, height: 844 } });
  await phone.goto(invite, { waitUntil: 'networkidle' });
  await phone.fill('#sp-name2', 'Phone');
  await phone.click('[data-act="sp-join"]');
  await phone.waitForSelector('.sp-table');
  check('phone: the space fits the screen', await phone.evaluate(() => document.querySelector('#space').scrollWidth <= document.querySelector('#space').clientWidth + 1));
  await shot(phone, 'space-07-phone');
  await phone.click('[data-act="sp-close"]');
  await phone.selectOption('#lang-select', 'ru');
  await phone.click('#space-btn');
  await phone.waitForSelector('.sp-table');
  check('Russian: the space speaks it', /Расчёты · 2/.test(await text(phone, '.sp-tabs')) && /Показано: 2\. Итого: Демередж/.test(await text(phone, '#sp-total')), await text(phone, '#sp-total'));

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(out, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
