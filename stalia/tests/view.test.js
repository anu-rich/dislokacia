'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const I = require('../app/i18n.js');
const V = require('../app/view.js');

const ex = (id, lang) => M.examples(lang || 'en').find((x) => x.id === id).calc;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

test('formatting in three languages', () => {
  const m = E.parseDT('2026-03-06T14:05');
  assert.equal(V.fmtDT(m, 'en'), '06 Mar 2026 14:05');
  assert.equal(V.fmtDT(m, 'ru'), '06.03.2026 14:05');
  assert.equal(V.fmtDT(m, 'kk'), '06.03.2026 14:05');
  assert.equal(V.fmtDow(m, 'en'), 'Fri'); assert.equal(V.fmtDow(m, 'ru'), 'Пт'); assert.equal(V.fmtDow(m, 'kk'), 'Жм');
  assert.equal(V.fmtDur(3 * 1440 + 10 * 60 + 30, 'en'), '3d 10h 30m');
  assert.equal(V.fmtDur(3 * 1440 + 10 * 60 + 30, 'ru'), '3 сут 10 ч 30 мин');
  assert.equal(V.fmtDur(3 * 1440 + 10 * 60 + 30, 'kk'), '3 тәул 10 сағ 30 мин');
  assert.equal(V.fmtDur(59.6, 'en'), '0d 01h 00m'); // rounds to the minute
  assert.equal(V.fmtMoney(23841.93, 'USD', 'en'), 'USD 23,841.93');
  assert.equal(V.fmtMoney(23841.93, 'USD', 'ru').replace(/\s/g, ' '), 'USD 23 841,93');
  assert.equal(V.fmtMoney(23841.93, 'KZT', 'kk').replace(/\s/g, ' '), 'KZT 23 841,93');
  assert.equal(V.fmtRate(14500, 'USD', 'en'), 'USD 14,500');
  assert.equal(V.fmtRate(14500.5, 'USD', 'en'), 'USD 14,500.50');
  assert.equal(V.fmtDays(41 * 60, 'en'), '1.70833');
  assert.equal(V.fmtPct(0), '—'); assert.equal(V.fmtPct(0.5), '50%'); assert.equal(V.fmtPct(1), '100%');
  assert.equal(V.fmtDT(null, 'en'), '');
});

test('summary: amounts, outcome wording and per-port chips', () => {
  const calc = ex('bulk'), r = E.compute(calc);
  const s = text(V.summaryHTML(calc, r, 'en'));
  assert.match(s, /Demurrage due to Owners/);
  assert.match(s, /USD 23,841\.93/);
  assert.match(s, /1d 17h 00m on demurrage/);
  assert.match(s, /Demurrage at USD 14,500 per day 24,770\.83/);
  assert.match(s, /Less commission 3\.75% −928\.91/);
  assert.match(s, /Novorossiysk .*0d 05h 00m on demurrage/);
  assert.match(s, /Alexandria .*1d 12h 00m on demurrage/);
  const ru = text(V.summaryHTML(ex('bulk', 'ru'), r, 'ru'));
  assert.match(ru, /Демередж в пользу судовладельца/);
  assert.match(ru.replace(/\u00A0|\u202F/g, ' '), /USD 23 841,93/);
  const kk = text(V.summaryHTML(ex('bulk', 'kk'), r, 'kk'));
  assert.match(kk, /Кеме иесінің пайдасына демередж/);
  assert.match(kk, /1 тәул 17 сағ 00 мин демереджде/);
});

test('summary: despatch, even and incomplete states', () => {
  const des = { demurrageRate: '12000', despatchMode: 'half', currency: 'EUR', laytimeMode: 'reversible', ports: [{ allowed: { type: 'fixed', hours: '48' }, calendar: { preset: 'SHINC' }, nor: { rule: 'manual', manualStart: '2026-03-02T00:00' }, completed: '2026-03-03T00:00' }] };
  const c = M.normalizeCalc(des), r = E.compute(c);
  const s = text(V.summaryHTML(c, r, 'en'));
  assert.match(s, /Despatch due to Charterers/); assert.match(s, /EUR 6,000\.00/); assert.match(s, /1d 00h 00m saved/);
  const blank = M.blankCalc(), rb = E.compute(blank);
  const sb = text(V.summaryHTML(blank, rb, 'en'));
  assert.match(sb, /Enter the missing times/);
  assert.match(sb, /Port 1: enter when NOR was tendered/);
  assert.match(text(V.summaryHTML(blank, rb, 'kk')), /1-порт: нотис қашан берілгенін көрсетіңіз/);
});

test('time sheet rows: day split, wording, running totals', () => {
  const calc = ex('bulk'), r = E.compute(calc);
  const rows = V.sheetRows(r.ports[0], 'en');
  assert.equal(rows[0].date, '06 Mar 2026'); assert.equal(rows[0].dow, 'Fri');
  assert.equal(rows[0].from, '13:00'); assert.equal(rows[0].to, '24:00');
  assert.equal(rows[0].remarks, 'Laytime counts'); assert.equal(rows[0].counted, '0d 11h 00m');
  const sat = rows.filter((x) => x.date === '07 Mar 2026');
  assert.deepEqual(sat.map((x) => x.from + '-' + x.to), ['00:00-08:00', '08:00-20:00', '20:00-24:00']);
  assert.equal(sat[0].remarks, 'Excepted period — not counted');
  assert.equal(sat[1].remarks, 'Excepted period, work performed, time used counts');
  assert.equal(sat[1].pct, '100%'); assert.equal(sat[0].pct, '—');
  const rain = rows.find((x) => /Rain/.test(x.remarks));
  assert.equal(rain.from, '10:00'); assert.equal(rain.to, '14:30'); assert.equal(rain.counted, '0d 00h 00m');
  const last = rows[rows.length - 1];
  assert.equal(last.state, 'dem'); assert.equal(last.remarks, 'On demurrage');
  assert.equal(last.balance, '0d 05h 00m over'); assert.equal(last.total, '3d 10h 30m');
  assert.ok(rows.filter((x) => x.first).length === 6, 'six calendar days');
  // owner's fault keeps applying on demurrage; weather does not
  const dis = V.sheetRows(r.ports[1], 'en');
  assert.match(dis.find((x) => /crane/.test(x.remarks)).remarks, /crane No\. 2 out of order/);
  assert.match(dis.find((x) => /holiday/i.test(x.remarks)).remarks, /Holiday \(Public holiday\)/);
});

test('facts are listed in time order and name the laytime milestones', () => {
  const r = E.compute(ex('tanker'));
  const f = V.portFacts(r.ports[1], 'en');
  assert.deepEqual(f.map((x) => x.kind), ['nor', 'ops', 'start', 'expiry', 'end']);
  assert.match(f[2].label, /operations started before notice time ran out/);
  for (let i = 1; i < f.length; i++) assert.ok(f[i].t >= f[i - 1].t);
  const load = V.portFacts(r.ports[0], 'en');
  assert.ok(load.some((x) => x.kind === 'note' && x.label === 'Hoses connected'));
});

test('time line: segments cover the plot, expiry is labelled, legend matches', () => {
  const r = E.compute(ex('bulk'));
  const h = V.timelineHTML(r.ports[0], 'en');
  const widths = [...h.matchAll(/class="seg seg-(\w+)"[^>]*style="left:([\d.]+)%?;width:([\d.]+)%/g)].map((m) => ({ st: m[1], l: +m[2], w: +m[3] }));
  assert.ok(widths.length >= 6);
  const sum = widths.reduce((s, x) => s + x.w, 0);
  assert.ok(Math.abs(sum - 100) < 0.1, 'segments sum to 100%, got ' + sum);
  for (const x of widths) assert.ok(x.l >= 0 && x.l + x.w <= 100.01);
  assert.match(h, /Laytime expires 11 Mar 16:00/);
  assert.match(h, /Laytime counts/); assert.match(h, /Not counted/); assert.match(h, /On demurrage/);
  assert.doesNotMatch(h, /Counts in part/);
  assert.equal(V.timelineHTML({ rows: [] }, 'en'), '');
});

test('statement: complete document, free footer vs Pro letterhead', () => {
  const calc = ex('bulk'), r = E.compute(calc);
  const free = V.statementHTML(calc, r, 'en', { pro: false, siteUrl: 'https://stalia.example', today: '2026-11-12', brand: { company: 'Should Not Show' } });
  const tf = text(free);
  assert.match(tf, /Laytime statement/);
  assert.match(tf, /MV EXAMPLE TRADER/);
  assert.match(tf, /Gencon 1994 dated 20 Feb 2026/);
  assert.match(tf, /Demurrage USD 14,500 per day or pro rata; despatch at half demurrage on working time saved; laytime non-reversible; once on demurrage, always on demurrage; commission 3\.75% on demurrage\./);
  assert.match(tf, /27,500 MT at 8,000 MT per day; SSHEX — Saturdays, Sundays and holidays excepted, unless used; NOR by 12:00 — laytime from 13:00/);
  assert.match(tf, /Demurrage due to Owners USD 23,841\.93/);
  assert.match(tf, /For and on behalf of Owners/);
  assert.match(tf, /Prepared with Stalia \(free version\) · stalia\.example/);
  assert.doesNotMatch(tf, /Should Not Show/);
  const pro = V.statementHTML(calc, r, 'en', { pro: true, today: '2026-11-12', brand: { company: 'ACME Shipping LLP', details: 'Aktau · ops@acme.example', logo: 'data:image/png;base64,iVBORw0KGgo=' } });
  assert.match(text(pro), /ACME Shipping LLP/);
  assert.match(pro, /<img class="p-logo" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(text(pro), /free version/);
  // Kazakh and Russian documents
  assert.match(text(V.statementHTML(ex('bulk', 'kk'), r, 'kk', { today: '2026-11-12' })), /Сталиялық уақыт есебі/);
  assert.match(text(V.statementHTML(ex('bulk', 'ru'), r, 'ru', { today: '2026-11-12' })), /Gencon 1994 от 20\.02\.2026/);
});

test('nothing a user types can break out of the markup', () => {
  const calc = ex('bulk');
  const bad = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  calc.name = bad; calc.meta.vessel = bad; calc.meta.remarks = bad + '\nline two'; calc.meta.voyage = bad; calc.meta.cpForm = bad;
  calc.ports[0].name = bad; calc.ports[0].events[2].desc = bad; calc.ports[0].events[0].desc = bad;
  calc.ports[1].calendar.holidays[0].name = bad;
  const r = E.compute(calc);
  const all = V.summaryHTML(calc, r, 'en') + V.sheetHTML(calc, r, 'en') + r.ports.map((p) => V.timelineHTML(p, 'en')).join('') +
    V.statementHTML(calc, r, 'en', { pro: true, brand: { company: bad, details: bad, logo: 'javascript:alert(1)' }, today: '2026-11-12' });
  assert.doesNotMatch(all, /<script/i);
  assert.doesNotMatch(all, /<img src=x/i);
  assert.doesNotMatch(all, /javascript:/i);
  assert.ok(all.includes('&lt;script&gt;'));
  // a logo that is not a plain raster data URL is dropped
  for (const logo of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil.example/x.png', 'data:text/html;base64,AAAA', 'data:image/png;base64,AAA" onerror="x']) {
    assert.doesNotMatch(V.statementHTML(calc, r, 'en', { pro: true, brand: { logo }, today: '2026-11-12' }), /p-logo/);
  }
});

test('CSV export: header, rows, separators and formula-safe cells', () => {
  const calc = ex('bulk'), r = E.compute(calc);
  const csv = V.sheetCSV(calc, r, 'en');
  assert.ok(csv.startsWith('\uFEFFPort,Date,Day,From,To,Remarks,Counts,Time counted,Laytime used,Balance\r\n'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 1 + V.sheetRows(r.ports[0], 'en').length + V.sheetRows(r.ports[1], 'en').length);
  assert.match(lines[1], /^Novorossiysk,06 Mar 2026,Fri,13:00,24:00,Laytime counts,100%,0d 11h 00m,0d 11h 00m,2d 23h 30m left$/);
  assert.ok(V.sheetCSV(ex('bulk', 'ru'), r, 'ru').includes(';'));
  calc.ports[0].events[2].desc = '=HYPERLINK("http://x","click"), with comma';
  const evil = V.sheetCSV(calc, E.compute(calc), 'en');
  assert.ok(evil.includes('"\'=HYPERLINK(""http://x"",""click""), with comma"'));
});

test('plain-text summary for messengers', () => {
  const calc = ex('tanker'), r = E.compute(calc);
  const s = V.summaryText(calc, r, 'en');
  assert.match(s, /^MT EXAMPLE SPIRIT — Crude, Ceyhan to Trieste\n/);
  assert.match(s, /Port 2 · Discharging · Trieste: Laytime used 0d 19h 10m, 0d 13h 00m on demurrage, Laytime expired 10 Apr 2026 09:10/);
  assert.match(s, /Demurrage due to Owners: USD 16,900\.00$/);
  assert.equal(V.summaryText(M.blankCalc(), E.compute(M.blankCalc()), 'en'), '');
});

test('every string key used by the views exists', () => {
  const fs = require('node:fs'), path = require('node:path');
  const keys = new Set(Object.keys(I.STRINGS.en));
  const missing = new Set();
  for (const f of ['view.js', 'app.js']) {
    const p = path.join(__dirname, '..', 'app', f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    // complete literal keys only: t('a.b') or t('a.b', …); prefixes such as t('et.' + id) are built at run time
    for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'\s*[,)]/g)) if (!keys.has(m[1])) missing.add(f + ':' + m[1]);
    for (const m of src.matchAll(/I\.t\(\s*\w+\s*,\s*'([\w.]+)'\s*[,)]/g)) if (!keys.has(m[1])) missing.add(f + ':' + m[1]);
  }
  assert.deepEqual([...missing], []);
});
