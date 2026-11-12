'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const I = require('../app/i18n.js');

const H = 60;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || '') + ` expected ${b}, got ${a}`);

test('example 1 (dry bulk, non-reversible): hand-checked figures', () => {
  const ex = M.examples('en').find((x) => x.id === 'bulk');
  const r = E.compute(ex.calc);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  const [load, dis] = r.ports;
  near(load.allowedMin, 82.5 * H);
  assert.equal(E.fmtDT(load.start), '2026-03-06T13:00');
  assert.equal(E.fmtDT(load.expiry), '2026-03-11T16:00');
  near(load.demMin, 5 * H);
  near(dis.allowedMin, 132 * H);
  assert.equal(E.fmtDT(dis.start), '2026-03-15T13:00');
  assert.equal(E.fmtDT(dis.expiry), '2026-03-23T06:00');
  near(dis.demMin, 36 * H);
  near(r.totals.demMin, 41 * H);
  assert.equal(r.totals.demurrage, 24770.83);
  assert.equal(r.totals.commission, 928.91);
  assert.equal(r.totals.net, 23841.93);
  assert.equal(r.totals.outcome, 'demurrage');
});

test('example 2 (tanker, 72 h reversible): hand-checked figures', () => {
  const r = E.compute(M.examples('en').find((x) => x.id === 'tanker').calc);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.equal(E.fmtDT(r.ports[0].start), '2026-04-02T09:00');
  near(r.ports[0].usedMin, 52 * H + 50);
  assert.equal(E.fmtDT(r.ports[1].start), '2026-04-09T12:30');
  assert.equal(E.fmtDT(r.ports[1].expiry), '2026-04-10T09:10');
  near(r.totals.demMin, 13 * H);
  assert.equal(r.totals.demurrage, 17333.33);
  assert.equal(r.totals.commission, 433.33);
  assert.equal(r.totals.net, 16900);
});

test('example 3 (Caspian tanker): hand-checked figures', () => {
  const r = E.compute(M.examples('ru').find((x) => x.id === 'caspian').calc);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(E.fmtDT(r.ports[0].start), '2026-02-10T13:00');
  near(r.ports[0].usedMin, 36 * H);
  near(r.ports[0].demMin, 3 * H + 40);
  assert.equal(E.fmtDT(r.ports[1].start), '2026-02-14T02:15');
  near(r.ports[1].savedMin, 4 * H + 30);
  assert.equal(r.totals.demurrage, 1375);
  assert.equal(r.totals.despatch, 0);
});

test('examples exist in both languages and stay valid after normalisation', () => {
  for (const lang of I.LANGS) {
    const list = M.examples(lang);
    assert.equal(list.length, 3);
    for (const ex of list) {
      assert.ok(ex.title && ex.calc.name);
      assert.deepEqual(M.normalizeCalc(JSON.parse(JSON.stringify(ex.calc))), ex.calc, 'normalisation is idempotent');
      assert.ok(E.compute(ex.calc).ok);
    }
  }
  assert.notEqual(M.examples('ru')[0].title, M.examples('en')[0].title);
});

test('blank calculation: two ports, reports what is missing, no crash', () => {
  const c = M.blankCalc();
  assert.equal(c.ports.length, 2);
  const r = E.compute(c);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'nor_missing' && e.port === 0));
  assert.ok(r.errors.some((e) => e.code === 'completed_missing' && e.port === 1));
});

test('normalizeCalc: hostile and broken input becomes a safe, well-typed calculation', () => {
  const evil = {
    name: '<img src=x onerror=alert(1)>'.repeat(40), currency: 'usd', demurrageRate: '14,500', commissionPct: 'abc',
    laytimeMode: 'weird', onceOnDemurrage: 'yes', meta: { vessel: { toString: () => 'x' }, cpDate: '2026-02-31', remarks: 'a'.repeat(5000) },
    ports: [
      {
        id: '"><script>', operation: 'explode', name: 42,
        allowed: { type: 'magic', quantity: '1e5; drop', rate: [] },
        calendar: { preset: 'NOPE', weekly: { fromDow: 9, fromTime: '25:99' }, holidays: [{ date: 'x', name: 5 }, null, 7] },
        nor: { tendered: 'yesterday', rule: 7, turnHours: 0, officeHours: 'nope' },
        completed: '2026-03-06T10:00:00',
        events: [{ type: 'weather', from: '2026-03-06T10:00', to: 'bad', countPct: 250, alsoOnDemurrage: 1 }, 'junk', { type: 'unknown', kind: 'virus' }],
      },
      'not a port', null,
    ],
    extra: { nested: true },
  };
  const c = M.normalizeCalc(evil);
  assert.equal(c.name.length, 120);
  assert.equal(c.currency, 'USD');
  assert.equal(c.demurrageRate, '14,500');
  assert.equal(c.commissionPct, '');
  assert.equal(c.laytimeMode, 'reversible');
  assert.equal(c.onceOnDemurrage, true);
  assert.equal(c.meta.cpDate, '');
  assert.equal(c.meta.remarks.length, 2000);
  assert.equal(c.extra, undefined);
  assert.equal(c.ports.length, 3);
  const p = c.ports[0];
  assert.match(p.id, /^[\w-]+$/);
  assert.equal(p.operation, 'load'); assert.equal(p.name, '42');
  assert.equal(p.allowed.type, 'fixed'); assert.equal(p.allowed.quantity, ''); assert.equal(p.allowed.rate, '');
  assert.equal(p.calendar.preset, 'SHINC');
  assert.deepEqual(p.calendar.weekly, { fromDow: 6, fromTime: '12:00', toDow: 1, toTime: '08:00' });
  assert.equal(p.calendar.holidays.length, 3);
  assert.equal(p.nor.tendered, ''); assert.equal(p.nor.rule, 'turn'); assert.equal(p.nor.turnHours, '0');
  assert.equal(p.nor.officeHours.enabled, false);
  assert.equal(p.completed, '2026-03-06T10:00');
  assert.equal(p.events.length, 3);
  assert.equal(p.events[0].to, ''); assert.equal(p.events[0].countPct, '250'); assert.equal(p.events[0].alsoOnDemurrage, false);
  assert.equal(p.events[2].type, 'custom'); assert.equal(p.events[2].kind, 'exception');
  // every leaf is a string, number or boolean — nothing exotic survives
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') { assert.equal(Object.getPrototypeOf(v), Object.prototype); return Object.values(v).forEach(walk); }
    assert.ok(['string', 'number', 'boolean'].includes(typeof v), 'leaf type ' + typeof v);
  })(c);
  // garbage in general
  for (const junk of [null, undefined, 5, 'x', [], { ports: 'no' }]) assert.equal(M.normalizeCalc(junk).ports.length, 2);
  assert.equal(M.normalizeCalc({ ports: new Array(50).fill({}) }).ports.length, M.LIMITS.ports);
});

test('i18n: every language defines exactly the same keys and placeholders as English', () => {
  const en = I.STRINGS.en;
  assert.deepEqual(I.LANGS, ['en', 'zh', 'ru', 'kk', 'uk', 'tr', 'el']);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const lang of I.LANGS) {
    const d = I.STRINGS[lang];
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort(), 'key set of ' + lang);
    for (const k of Object.keys(en)) assert.equal(ph(d[k]), ph(en[k]), 'placeholders differ in ' + lang + ':' + k);
    assert.ok(I.LANG_LABELS[lang]);
  }
  // the translations are real, not copies of English
  const same = (lang) => Object.keys(en).filter((k) => I.STRINGS[lang][k] === en[k] && en[k].length > 12);
  for (const lang of I.LANGS.filter((l) => l !== 'en')) assert.ok(same(lang).length < 8, 'untranslated ' + lang + ': ' + same(lang));
  assert.equal(I.t('kk', 'p.port', { n: 2 }), '2-порт');
  assert.equal(I.t('ru', 'p.port', { n: 2 }), 'Порт 2');
  assert.equal(I.t('xx', 'p.port', { n: 2 }), 'Port 2');
  assert.equal(I.t('en', 'no.such.key'), 'no.such.key');
  for (const tp of M.EVENT_TYPES) { assert.ok(en['et.' + tp.id], tp.id); assert.ok('et.d.' + tp.id in en, tp.id); }
  for (const p of M.CAL_PRESETS) assert.ok(en['c.' + p], p);
});
