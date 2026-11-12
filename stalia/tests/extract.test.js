'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const I = require('../app/i18n.js');
const X = require('../app/extract.js');
const { extractionOf } = require('./helpers/extraction.js');

const examples = () => M.examples('en');
const totalsOf = (calc) => { const r = E.compute(calc); assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.totals; };

test('the schema is one that structured outputs accept', () => {
  let objects = 0;
  (function walk(s, where) {
    assert.ok(['object', 'array', 'string', 'integer'].includes(s.type), where + ' has type ' + s.type);
    for (const k of Object.keys(s)) assert.ok(['type', 'description', 'enum', 'properties', 'required', 'additionalProperties', 'items'].includes(k), where + ' uses keyword ' + k);
    if (s.type === 'object') {
      objects++;
      assert.equal(s.additionalProperties, false, where);
      assert.deepEqual(s.required, Object.keys(s.properties), where + ': every property is required');
      for (const k of Object.keys(s.properties)) walk(s.properties[k], where + '.' + k);
    }
    if (s.type === 'array') walk(s.items, where + '[]');
    if (s.enum) assert.ok(s.enum.length > 1 && s.enum.every((v) => typeof v === 'string'), where);
  })(X.SCHEMA, 'schema');
  assert.ok(objects >= 10);
  assert.ok(JSON.stringify(X.SCHEMA).length < 20000, 'the schema stays small');
});

test('every note field has a label in every language and points at a real form path', () => {
  const calc = examples()[0].calc;
  for (const code of X.FIELD_CODES) {
    const f = X.FIELDS[code];
    if (code === 'other') continue;
    for (const lang of I.LANGS) assert.ok(I.STRINGS[lang][f.label], lang + ' has no string ' + f.label);
    const path = X.notePath({ field: code, port: f.perPort ? 1 : null }, calc);
    const parts = path.split('.');
    let o = calc;
    for (const k of parts) { assert.ok(o != null && k in o, code + ' -> ' + path); o = o[k]; }
  }
  assert.equal(X.notePath({ field: 'nor_tendered', port: null }, calc), '');
  assert.equal(X.notePath({ field: 'other', port: null }, calc), '');
  assert.deepEqual(X.SCHEMA.properties.notes.items.properties.field.enum, X.FIELD_CODES);
});

test('a blank answer has the shape of the schema; broken answers are caught', () => {
  const b = X.blankExtraction();
  assert.equal(X.shapeError(b, X.SCHEMA), '');
  b.ports.push(X.blankExtractionPort('discharge'));
  assert.equal(X.shapeError(b, X.SCHEMA), '');
  assert.match(X.shapeError(Object.assign({}, b, { extra: 1 }), X.SCHEMA), /extra is not expected/);
  const bad = JSON.parse(JSON.stringify(b)); bad.ports[0].operation = 'transit';
  assert.match(X.shapeError(bad, X.SCHEMA), /ports\[0\]\.operation has an unexpected value/);
  const bad2 = JSON.parse(JSON.stringify(b)); delete bad2.money.currency;
  assert.match(X.shapeError(bad2, X.SCHEMA), /money\.currency is missing/);
  const bad3 = JSON.parse(JSON.stringify(b)); bad3.notes.push({ field: 'vessel', port: 1.5, status: 'redacted', comment: '' });
  assert.match(X.shapeError(bad3, X.SCHEMA), /whole number/);
  assert.match(X.shapeError(null, X.SCHEMA), /must be an object/);
});

test('reading the documents of each built-in example gives exactly the result of typing them in', () => {
  for (const ex of examples()) {
    const answer = extractionOf(ex.calc);
    assert.equal(X.shapeError(answer, X.SCHEMA), '', ex.id);
    const read = X.toCalc(answer);
    assert.equal(read.empty, false);
    assert.deepEqual(read.notes, [], ex.id + ': nothing to flag');
    assert.deepEqual(read.documents, { cp: true, sof: true });
    const a = totalsOf(ex.calc), b = totalsOf(read.calc);
    for (const k of ['allowedMin', 'usedMin', 'demMin', 'desMin', 'demurrage', 'despatch', 'commission', 'net', 'outcome', 'mode']) assert.equal(b[k], a[k], ex.id + ' ' + k);
    assert.equal(read.calc.meta.vessel, ex.calc.meta.vessel);
    assert.equal(read.calc.ports.length, ex.calc.ports.length);
    read.calc.ports.forEach((p, i) => assert.equal(p.events.length, ex.calc.ports[i].events.length));
  }
  assert.equal(Math.round(totalsOf(X.toCalc(extractionOf(examples()[0].calc)).calc).net * 100) / 100, 23841.93);
});

test('an answer that is almost in shape can be brought into shape', () => {
  const S = require('../app/schema.js');
  assert.deepEqual(S.conform(null, S.SCHEMA), X.blankExtraction());
  const good = extractionOf(examples()[0].calc);
  assert.deepEqual(S.conform(good, S.SCHEMA), good, 'a correct answer is left exactly as it is');
  const rough = JSON.parse(JSON.stringify(good));
  delete rough.money.despatch_basis;                 // a missing field
  rough.money.demurrage_per_day = 14500;             // a number where text is expected
  rough.extra = { anything: true };                  // a field nobody asked for
  rough.ports[0].operation = 'loading';              // not one of the allowed words
  rough.ports[0].working_time.regime = 'WWD';
  rough.ports[1].events = null;
  rough.notes = [{ field: 'demurrage', port: '1', status: 'redacted' }];
  const fixed = S.conform(rough, S.SCHEMA);
  assert.equal(S.shapeError(fixed, S.SCHEMA), '');
  assert.equal(fixed.money.despatch_basis, 'unknown');
  assert.equal(fixed.money.demurrage_per_day, '14500');
  assert.equal('extra' in fixed, false);
  assert.equal(fixed.ports[0].operation, 'load');
  assert.equal(fixed.ports[0].working_time.regime, 'unknown');
  assert.deepEqual(fixed.ports[1].events, []);
  assert.deepEqual(fixed.notes, [{ field: 'vessel', port: 1, status: 'redacted', comment: '' }]);
  assert.equal(X.toCalc(fixed).calc.demurrageRate, '14500');
});

test('sloppy values from a reader are cleaned, never trusted', () => {
  const a = extractionOf(examples()[0].calc);
  a.money.demurrage_per_day = 'USD 14,500.00';
  a.money.currency = 'usd';
  a.money.commission_percent = '3,75';
  a.fixture.vessel = '  MV   <script>alert(1)</script>  ';
  a.fixture.charter_party_date = '2026-02-20T00:00';
  a.ports[0].notice.tendered = '2026-03-06 09:00';
  a.ports[0].notice.office_from = '0800';
  a.ports[0].operations_completed = '2026-03-11T21:00:00';
  a.ports[0].events.push({ type: 'weather', from: 'yesterday', to: '', description: 'x', counts_percent: '', on_demurrage: 'default' });
  a.ports[0].events.push({ type: 'weather', from: '2026-03-10T01:00', to: '2026-03-10T02:00', description: 'Rain', counts_percent: '250', on_demurrage: 'default' });
  a.ports[1].working_time.holidays.push({ date: 'soon', name: 'x' });
  a.notes.push({ field: 'nor_tendered', port: 99, status: 'weird', comment: 'x'.repeat(900) });
  const r = X.toCalc(a);
  assert.equal(r.calc.demurrageRate, '14500');
  assert.equal(r.calc.currency, 'USD');
  assert.equal(r.calc.commissionPct, '3.75');
  assert.equal(r.calc.meta.vessel, 'MV <script>alert(1)</script>'); // kept as text; every renderer escapes
  assert.equal(r.calc.meta.cpDate, '2026-02-20');
  assert.equal(r.calc.ports[0].nor.tendered, '2026-03-06T09:00');
  assert.equal(r.calc.ports[0].nor.officeHours.from, '08:00');
  assert.equal(r.calc.ports[0].completed, '2026-03-11T21:00');
  assert.equal(r.calc.ports[0].events.length, 4, 'the event without a real time is dropped');
  assert.equal(r.calc.ports[0].events[3].countPct, '0', 'an impossible percentage falls back to the usual effect');
  assert.equal(r.calc.ports[1].calendar.holidays.length, 1);
  assert.deepEqual(r.notes.map((n) => [n.field, n.port, n.status, n.comment.length]), [['nor_tendered', null, 'ambiguous', 400]]);
  assert.equal(E.compute(r.calc).ok, true);
});

test('what the documents do not say is left at the default and flagged', () => {
  const a = extractionOf(examples()[0].calc);
  a.money.demurrage_per_day = '';
  a.money.despatch = 'unknown';
  a.laytime.between_ports = 'unknown';
  a.ports[0].working_time.regime = 'unknown';
  a.ports[0].notice.rule = 'unknown';
  a.ports[1].notice.tendered = '';
  a.ports[1].allowed = X.blankExtractionPort().allowed;
  a.notes.push({ field: 'demurrage_rate', port: 0, status: 'redacted', comment: 'The rate is under a blacked-out area.' });
  const r = X.toCalc(a);
  assert.equal(r.calc.demurrageRate, '');
  assert.equal(r.calc.despatchMode, 'half');
  assert.equal(r.calc.ports[0].calendar.preset, 'SHINC');
  assert.equal(r.calc.ports[0].nor.rule, 'turn');
  const flat = r.notes.map((n) => n.field + '/' + n.port + '/' + n.status);
  assert.deepEqual(flat, [
    'demurrage_rate/null/redacted', // the reader's own note is not doubled
    'laytime_between_ports/null/not_found', 'working_time/0/not_found', 'notice_rule/0/not_found', 'nor_tendered/1/not_found',
  ]);
  assert.equal(r.calc.laytimeMode, 'reversible', 'one allowance for two ports reads as a pooled one, so the empty second port is not flagged');
  assert.equal(X.notePath(r.notes[2], r.calc), 'ports.0.calendar.preset');
  // with separate laytime the port without an allowance is flagged, and the note points at the field to fill in
  a.laytime.between_ports = 'separate';
  const r2 = X.toCalc(a), n2 = r2.notes.find((n) => n.field === 'laytime_allowed');
  assert.deepEqual([n2.port, n2.status], [1, 'not_found']);
  assert.equal(X.notePath(n2, r2.calc), 'ports.1.allowed.days');
  assert.equal(X.notePath({ field: 'laytime_allowed', port: 0 }, r2.calc), 'ports.0.allowed.quantity');
});

test('a notice rule without its hours is flagged, not filled in silently', () => {
  const a = extractionOf(examples()[1].calc);
  a.ports.forEach((p) => { p.notice.rule = 'hours_after_notice'; p.notice.hours_after_notice = '0'; });
  assert.deepEqual(X.toCalc(a).notes.filter((n) => n.field === 'notice_rule'), [], 'laytime from the moment notice is tendered is a complete rule');
  assert.deepEqual(X.toCalc(a).calc.ports.map((p) => p.nor.turnHours), ['0', '0']);
  a.ports[1].notice.hours_after_notice = '';
  const r = X.toCalc(a);
  assert.equal(r.calc.ports[1].nor.turnHours, '6', 'the form keeps its default');
  assert.deepEqual(r.notes.filter((n) => n.field === 'notice_rule').map((n) => n.port + '/' + n.status), ['1/not_found'], 'and the user is sent to check it');
});

test('“08:00 on the next working day after notice” is its own rule, there and back', () => {
  const a = extractionOf(examples()[0].calc);
  a.ports[1].notice = Object.assign(a.ports[1].notice, { rule: 'next_working_day', next_working_day_start: '0800', hours_after_notice: '', noon_rule_morning_start: '', noon_rule_afternoon_start: '' });
  const r = X.toCalc(a), nor = r.calc.ports[1].nor;
  assert.equal(nor.rule, 'nextday'); assert.equal(nor.nextDayStart, '08:00');
  assert.deepEqual(r.notes.filter((n) => n.field === 'notice_rule'), []);
  assert.equal(E.compute(r.calc).ok, true);
  const back = extractionOf(r.calc).ports[1].notice;       // what the form holds reads back as the same answer
  assert.equal(back.rule, 'next_working_day'); assert.equal(back.next_working_day_start, '08:00');
  a.ports[1].notice.next_working_day_start = '';            // the time left out: the usual 08:00
  assert.equal(X.toCalc(a).calc.ports[1].nor.nextDayStart, '08:00');
  // an older calculation without the field still opens
  const old = M.normalizeCalc(JSON.parse(JSON.stringify(examples()[0].calc)));
  delete old.ports[0].nor.nextDayStart;
  assert.equal(M.normalizeCalc(old).ports[0].nor.nextDayStart, '08:00');
});

test('the next-working-day rule read from a recap: the count starts where the clause says', () => {
  const S = require('../app/schema.js');
  const nt = X.SCHEMA.properties.ports.items.properties.notice.properties;
  assert.ok(nt.rule.enum.includes('next_working_day') && nt.next_working_day_start.type === 'string', 'the schema has the rule and its time');
  // a recap read the way the instruction asks: notice on Tuesday 3 March 10:00, completed on Friday
  const a = X.blankExtraction();
  a.documents = { charter_party: 'read', statement_of_facts: 'read' };
  a.money.demurrage_per_day = '12000';
  const p = X.blankExtractionPort('load');
  p.name = 'Constanta';
  p.allowed = Object.assign(p.allowed, { basis: 'fixed_time', hours: '48' });
  p.working_time = Object.assign(p.working_time, { regime: 'SSHEX', holidays_excepted: 'yes', work_in_excepted_time: 'does_not_count' });
  p.notice = Object.assign(p.notice, { tendered: '2026-03-03T10:00', rule: 'next_working_day', next_working_day_start: '0800', unless_sooner_commenced: 'yes' });
  p.operations_commenced = '2026-03-04T09:15';
  p.operations_completed = '2026-03-06T20:00';
  a.ports.push(p);
  assert.equal(X.shapeError(a, X.SCHEMA), '');
  assert.deepEqual(S.conform(JSON.parse(JSON.stringify(a)), S.SCHEMA), a, 'the answer is in shape as it is: nothing is dropped or reset');
  const r = X.toCalc(a), port = r.calc.ports[0];
  assert.deepEqual([port.nor.rule, port.nor.nextDayStart, port.nor.unlessSoonerCommenced, port.nor.tendered], ['nextday', '08:00', true, '2026-03-03T10:00']);
  assert.deepEqual(r.notes, [], 'a rule read in full leaves nothing to flag');
  const res = E.compute(r.calc);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(E.fmtDT(res.ports[0].start), '2026-03-04T08:00', 'Wednesday 08:00, not the Tuesday of the notice');
  assert.equal(E.fmtDT(res.ports[0].expiry), '2026-03-06T08:00');
  assert.equal(res.totals.demurrage, 6000); // 12 hours over
  // what the reader had to answer before — the noon rule with both times at 08:00 — starts the count on the day of the notice
  const before = JSON.parse(JSON.stringify(a));
  Object.assign(before.ports[0].notice, { rule: 'noon_rule', noon_rule_morning_start: '08:00', noon_rule_afternoon_start: '08:00', next_working_day_start: '' });
  assert.equal(E.fmtDT(E.compute(X.toCalc(before).calc).ports[0].start), '2026-03-03T10:00');

  // operations that began before that moment start laytime, unless the charter party says otherwise
  p.operations_commenced = '2026-03-03T15:30';
  assert.equal(E.fmtDT(E.compute(X.toCalc(a).calc).ports[0].start), '2026-03-03T15:30');
  p.notice.unless_sooner_commenced = 'no';
  assert.deepEqual([X.toCalc(a).calc.ports[0].nor.unlessSoonerCommenced, E.fmtDT(E.compute(X.toCalc(a).calc).ports[0].start)], [false, '2026-03-04T08:00']);
  // office hours travel with it: a notice at 19:00 is deemed tendered the next morning, and laytime starts the working day after that
  Object.assign(p.notice, { tendered: '2026-03-03T19:00', office_hours_only: 'yes', office_from: '08:00', office_to: '17:00' });
  assert.equal(E.fmtDT(E.compute(X.toCalc(a).calc).ports[0].start), '2026-03-05T08:00');
  Object.assign(p.notice, { tendered: '2026-03-03T10:00', office_hours_only: 'unknown', office_from: '', office_to: '' });

  // another time is kept as written; times of the other rules do not leak in
  Object.assign(p.notice, { next_working_day_start: '06:30', noon_rule_morning_start: '13:00', noon_rule_afternoon_start: '06:00', hours_after_notice: '12' });
  const other = X.toCalc(a).calc.ports[0];
  assert.deepEqual([other.nor.rule, other.nor.nextDayStart], ['nextday', '06:30']);
  assert.equal(E.fmtDT(E.compute(X.toCalc(a).calc).ports[0].start), '2026-03-04T06:30');
  Object.assign(p.notice, { noon_rule_morning_start: '', noon_rule_afternoon_start: '', hours_after_notice: '' });

  // an answer that is a little out of shape keeps the rule; a word that is not a rule is not taken for one
  const rough = JSON.parse(JSON.stringify(a));
  delete rough.ports[0].notice.laytime_commenced_at; rough.ports[0].notice.next_working_day_start = 800; rough.ports[0].notice.extra = 'x';
  const fixed = S.conform(rough, S.SCHEMA);
  assert.equal(S.shapeError(fixed, S.SCHEMA), '');
  assert.deepEqual([fixed.ports[0].notice.rule, fixed.ports[0].notice.next_working_day_start], ['next_working_day', '800']);
  const odd = JSON.parse(JSON.stringify(a)); odd.ports[0].notice.rule = 'next_day';
  assert.equal(S.conform(odd, S.SCHEMA).ports[0].notice.rule, 'unknown');
  assert.match(X.shapeError(odd, X.SCHEMA), /ports\[0\]\.notice\.rule has an unexpected value/);
  const lost = JSON.parse(JSON.stringify(a)); delete lost.ports[0].notice.next_working_day_start;
  assert.match(X.shapeError(lost, X.SCHEMA), /notice\.next_working_day_start is missing/);
});

test('the next-working-day rule typed into the form reads back exactly: every example, with and without “unless sooner commenced”', () => {
  const incomplete = [];
  for (const ex of examples()) {
    for (const sooner of [true, false]) {
      const calc = JSON.parse(JSON.stringify(ex.calc));
      calc.ports.forEach((p, i) => { p.calendar.preset = 'SSHEX'; Object.assign(p.nor, { rule: 'nextday', nextDayStart: i ? '06:00' : '08:00', unlessSoonerCommenced: sooner }); });
      const answer = extractionOf(calc), label = ex.id + (sooner ? ' sooner' : ' strict');
      assert.equal(X.shapeError(answer, X.SCHEMA), '', label);
      assert.deepEqual(answer.ports.map((p) => [p.notice.rule, p.notice.next_working_day_start, p.notice.noon_rule_morning_start, p.notice.hours_after_notice]),
        [['next_working_day', '08:00', '', ''], ['next_working_day', '06:00', '', '']], label);
      const read = X.toCalc(answer);
      assert.deepEqual(read.notes, [], label + ': nothing to flag');
      assert.deepEqual(read.calc.ports.map((p) => [p.nor.rule, p.nor.nextDayStart, p.nor.unlessSoonerCommenced]), calc.ports.map((p) => ['nextday', p.nor.nextDayStart, sooner]), label);
      const a = E.compute(calc), b = E.compute(read.calc);
      assert.deepEqual([b.ok, b.errors], [a.ok, a.errors], label);
      if (!a.ok) { incomplete.push(label + ': ' + a.errors.map((e) => e.code + '/' + e.port).join()); continue; }
      assert.deepEqual(b.ports.map((p) => E.fmtDT(p.start)), a.ports.map((p) => E.fmtDT(p.start)), label + ' start');
      for (const k of ['allowedMin', 'usedMin', 'demMin', 'desMin', 'demurrage', 'despatch', 'commission', 'net', 'outcome', 'mode']) assert.equal(b.totals[k], a.totals[k], label + ' ' + k);
    }
  }
  // Baku: notice on Friday night, discharge completed on Sunday. Without “unless sooner commenced” laytime would start on
  // Monday, after completion — typed or read, the calculator says so instead of counting.
  assert.deepEqual(incomplete, ['caspian strict: end_before_start/1']);
});

test('one document only: the next-working-day rule is a term — kept with the terms, replaced with the charter party', () => {
  const base = JSON.parse(JSON.stringify(examples()[0].calc));
  base.ports.forEach((p) => Object.assign(p.nor, { rule: 'nextday', nextDayStart: '07:00' }));
  // a statement of facts for a new voyage: the rule and its time stay, the new notice is counted by them
  const sof = X.blankExtraction();
  sof.documents = { charter_party: 'absent', statement_of_facts: 'read' };
  const load = X.blankExtractionPort('load');
  load.name = 'Novorossiysk';
  load.notice.tendered = '2026-06-02T11:00'; // a Tuesday
  load.operations_commenced = '2026-06-03T09:00';
  load.operations_completed = '2026-06-05T03:00';
  sof.ports.push(load);
  const dis = X.blankExtractionPort('discharge');
  dis.name = 'Alexandria';
  dis.notice.tendered = '2026-06-09T16:00';
  dis.operations_completed = '2026-06-12T10:00';
  sof.ports.push(dis);
  const kept = X.merge(base, X.toCalc(sof), 'terms');
  assert.deepEqual(kept.calc.ports.map((p) => [p.nor.rule, p.nor.nextDayStart, p.nor.tendered]), [['nextday', '07:00', '2026-06-02T11:00'], ['nextday', '07:00', '2026-06-09T16:00']]);
  assert.deepEqual(kept.notes, []);
  const r = E.compute(kept.calc);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(E.fmtDT(r.ports[0].start), '2026-06-03T07:00');
  // a port the calculation did not have yet takes the rule of the port before it, as with “Add port”
  const one = M.normalizeCalc(Object.assign({}, base, { ports: [base.ports[0]] }));
  const added = X.merge(one, X.toCalc(sof), 'terms');
  assert.deepEqual(added.calc.ports.map((p) => [p.name, p.nor.rule, p.nor.nextDayStart]), [['Novorossiysk', 'nextday', '07:00'], ['Alexandria', 'nextday', '07:00']]);
  // a charter party read on its own brings the rule; the times already entered stay and are counted by it
  const cp = extractionOf(examples()[0].calc);
  cp.documents = { charter_party: 'read', statement_of_facts: 'absent' };
  for (const p of cp.ports) {
    p.notice = Object.assign(X.blankExtractionPort().notice, { rule: 'next_working_day', next_working_day_start: '08:00', unless_sooner_commenced: 'no' });
    p.operations_commenced = ''; p.operations_completed = ''; p.events = [];
  }
  const typed = examples()[0].calc;
  const m = X.merge(typed, X.toCalc(cp), 'facts');
  assert.deepEqual(m.calc.ports.map((p) => [p.nor.rule, p.nor.nextDayStart, p.nor.tendered]), [['nextday', '08:00', '2026-03-06T09:00'], ['nextday', '08:00', '2026-03-15T10:00']]);
  assert.deepEqual(m.notes, []);
  const rm = E.compute(m.calc);
  assert.equal(rm.ok, true, JSON.stringify(rm.errors));
  assert.deepEqual(rm.ports.map((p) => E.fmtDT(p.start)), ['2026-03-09T08:00', '2026-03-16T08:00']); // Friday -> Monday; Sunday -> Monday
});

test('the charter party’s own rules are kept in words and stay when only a time sheet is read later', () => {
  const V = require('../app/view.js');
  const a = extractionOf(examples()[1].calc);
  a.documents = { charter_party: 'read', statement_of_facts: 'read' };
  a.laytime.clauses = '  Laytime at the loading port ends when the documents are on board.\r\n\n\n\nWeather delays count   as half laytime, in full on demurrage.  ';
  const first = X.toCalc(a).calc;
  assert.equal(first.meta.clauses, 'Laytime at the loading port ends when the documents are on board.\n\nWeather delays count as half laytime, in full on demurrage.');
  // a contract that long is cut, and a calculation saved before this field existed still opens
  a.laytime.clauses = 'x'.repeat(5000);
  assert.equal(X.toCalc(a).calc.meta.clauses.length, 3000);
  const old = JSON.parse(JSON.stringify(first)); delete old.meta.clauses;
  assert.equal(M.normalizeCalc(old).meta.clauses, '');

  // what the reader is given next time, when only the time sheet is attached
  const said = V.readerTerms(first);
  assert.match(said, /^Demurrage USD \d+ per day\. Despatch: none\. Laytime between ports: reversible\. Once on demurrage, always on demurrage\./);
  assert.match(said, /\nPort 1 \(loading, [^)]+\): .*NOR/);
  assert.match(said, /\nPort 2 \(discharging, /);
  assert.ok(said.endsWith('Clauses of the charter party:\nLaytime at the loading port ends when the documents are on board.\n\nWeather delays count as half laytime, in full on demurrage.'));
  assert.doesNotMatch(V.readerTerms(M.blankCalc()), /Clauses/);
  assert.match(V.readerTerms(M.blankCalc()), /Demurrage USD not stated per day/, 'works before anything is entered');

  // the next voyage: only a time sheet is read; the terms and the clauses stay, the times are the new ones
  const next = extractionOf(examples()[1].calc);
  next.documents = { charter_party: 'absent', statement_of_facts: 'read' };
  next.laytime.clauses = '';
  next.ports[0].notice.tendered = '2026-05-01T08:00';
  const merged = X.merge(first, X.toCalc(next), 'terms').calc;
  assert.equal(merged.meta.clauses, first.meta.clauses);
  assert.equal(merged.demurrageRate, first.demurrageRate);
  assert.equal(merged.ports[0].nor.tendered, '2026-05-01T08:00');
});

test('a contract rules on a kind of delay once: every event of that kind follows it, whatever a later reading says', () => {
  const V = require('../app/view.js');
  // the contract, read alone: weather counts half as laytime and in full on demurrage; time lost through the vessel never counts
  const cp = extractionOf(examples()[1].calc);
  cp.documents = { charter_party: 'read', statement_of_facts: 'absent' };
  cp.ports.forEach((p) => { p.notice.tendered = ''; p.operations_commenced = ''; p.operations_completed = ''; p.events = []; });
  cp.laytime.delay_rules = [
    { type: 'weather', counts_percent: '50', on_demurrage: 'keeps_running' },
    { type: 'owner', counts_percent: '0', on_demurrage: 'stops_too' },
    { type: 'weather', counts_percent: '0', on_demurrage: 'stops_too' },  // a second entry for the same kind is ignored
    { type: 'worked', counts_percent: '0', on_demurrage: 'stops_too' },   // not a kind of delay
    { type: 'survey', counts_percent: '150', on_demurrage: 'stops_too' }, // not a share
  ];
  assert.equal(X.shapeError(cp, X.SCHEMA).replace(/.*delay_rules\[3\]\.type.*/, ''), '', 'only the entry of an unknown kind is out of shape');
  const contract = X.toCalc(cp).calc;
  assert.deepEqual(contract.rules, [{ type: 'weather', countPct: '50', alsoOnDemurrage: false }, { type: 'owner', countPct: '0', alsoOnDemurrage: true }]);

  // the words that go with the next time sheet name the rules, so the reader gives such events their kind
  const said = V.readerTerms(contract);
  assert.match(said, /\nHow each kind of delay counts under this charter party[^\n]*\n- bad weather, a port closed by weather \(type "weather"\): counts 50% as laytime; on demurrage such time counts in full\.\n- bunkering, ballasting and other owners' purposes \(type "owner"\): does not count as laytime; on demurrage the same applies\./);
  assert.doesNotMatch(V.readerTerms(M.blankCalc()), /How each kind/);

  // a time sheet read later under that contract. The reader took the weather clause the other way on the second line
  // (half on demurrage too) and forgot the share on the third; shifting has no rule and stays as it was read
  const sof = extractionOf(examples()[1].calc);
  sof.documents = { charter_party: 'absent', statement_of_facts: 'read' };
  sof.ports[1].events = [
    { type: 'weather', from: '2026-04-09T14:00', to: '2026-04-09T16:00', description: 'Port closed, weather', counts_percent: '50', on_demurrage: 'keeps_running' },
    { type: 'breakdown', from: '2026-04-10T02:00', to: '2026-04-10T03:30', description: 'Stripping pump failure', counts_percent: '0', on_demurrage: 'stops_too' },
    { type: 'weather', from: '2026-04-10T12:00', to: '2026-04-10T14:00', description: 'Port closed, weather', counts_percent: '50', on_demurrage: 'stops_too' },
    { type: 'weather', from: '2026-04-10T18:00', to: '2026-04-10T19:00', description: 'Port closed, weather', counts_percent: '', on_demurrage: 'default' },
    { type: 'shifting', from: '2026-04-10T20:00', to: '2026-04-10T20:30', description: 'Shifting', counts_percent: '100', on_demurrage: 'keeps_running' },
  ];
  const read = X.toCalc(sof);
  assert.deepEqual(read.calc.rules, [], 'a time sheet brings no rules of its own');
  const merged = X.merge(contract, read, 'terms').calc;
  assert.deepEqual(merged.rules, contract.rules);
  const weather = merged.ports[1].events.filter((e) => e.type === 'weather');
  assert.deepEqual(weather.map((e) => [e.countPct, e.alsoOnDemurrage]), [['50', false], ['50', false], ['50', false]]);
  assert.deepEqual(merged.ports[1].events.filter((e) => e.type === 'shifting').map((e) => [e.countPct, e.alsoOnDemurrage]), [['100', false]]);
  // laytime would expire 10 April 09:10; the first stoppage (2 h at half) moves that to 10:10, the two on demurrage change nothing
  assert.equal(totalsOf(merged).demMin, 780 - 60);
  // without the contract's rule the same reading would have taken another hour off, on the reader's say-so
  const loose = X.merge(Object.assign(JSON.parse(JSON.stringify(contract)), { rules: [] }), read, 'terms').calc;
  assert.equal(totalsOf(loose).demMin, 780 - 60 - 60);

  // the contract read after the facts were typed in: the events on screen follow the rules it brings
  const typed = M.normalizeCalc(merged);
  typed.rules = []; typed.ports[1].events.forEach((e) => { if (e.type === 'weather') { e.countPct = '0'; e.alsoOnDemurrage = true; } });
  const after = X.merge(typed, X.toCalc(cp), 'facts').calc;
  assert.deepEqual(after.ports[1].events.filter((e) => e.type === 'weather').map((e) => [e.countPct, e.alsoOnDemurrage]), [['50', false], ['50', false], ['50', false]]);

  // one reading with both documents: the rules it states apply to its own events
  const both = extractionOf(merged);
  both.ports[1].events.forEach((e) => { if (e.type === 'weather') { e.counts_percent = '0'; e.on_demurrage = 'stops_too'; } });
  assert.equal(totalsOf(X.toCalc(both).calc).demMin, 780 - 60);
});

test('“72 hours in total” for two ports reads as reversible; separate allowances read as separate', () => {
  const tanker = extractionOf(examples()[1].calc);
  tanker.laytime.between_ports = 'unknown';
  tanker.ports[1].allowed.hours = '';
  assert.equal(X.toCalc(tanker).calc.laytimeMode, 'reversible');
  const bulk = extractionOf(examples()[0].calc);
  bulk.laytime.between_ports = 'unknown';
  assert.equal(X.toCalc(bulk).calc.laytimeMode, 'separate');
});

test('a custom weekly period, the noon rule, a stated start and event overrides survive the trip', () => {
  const a = X.blankExtraction();
  a.documents = { charter_party: 'read', statement_of_facts: 'read' };
  const p = X.blankExtractionPort('discharge');
  p.name = 'Poti';
  p.allowed = { basis: 'unknown', cargo_quantity: '5 000', rate: '1,250', rate_per: 'day', days: '', hours: '', minutes: '' };
  p.working_time = Object.assign(p.working_time, { regime: 'CUSTOM', custom_from_day: 'thu', custom_from_time: '1700', custom_to_day: 'sat', custom_to_time: '08:00', holidays_excepted: 'no', work_in_excepted_time: 'counts', holiday_from_previous_day_at: '17:00', holiday_until_next_day_at: '08:00' });
  p.notice = Object.assign(p.notice, { tendered: '2026-05-04T09:00', rule: 'stated_time', laytime_commenced_at: '2026-05-04T14:00', office_hours_only: 'yes', office_from: '09:00', office_to: '18:00', office_saturday_to: '' });
  p.operations_commenced = '2026-05-04T15:00';
  p.operations_completed = '2026-05-08T12:00';
  p.events = [
    { type: 'weather', from: '2026-05-05T10:00', to: '2026-05-05T12:00', description: 'Rain', counts_percent: '50', on_demurrage: 'stops_too' },
    { type: 'note', from: '2026-05-05T13:00', to: '2026-05-05T13:30', description: 'Samples drawn', counts_percent: '', on_demurrage: 'default' },
    { type: 'nonsense', from: '2026-05-06T10:00', to: '2026-05-06T11:00', description: 'Something', counts_percent: '', on_demurrage: 'keeps_running' },
  ];
  a.ports.push(p);
  a.money.demurrage_per_day = '6000';
  a.laytime.exceptions_apply_on_demurrage = 'yes';
  const r = X.toCalc(a), port = r.calc.ports[0];
  assert.equal(r.calc.onceOnDemurrage, false);
  assert.deepEqual(port.allowed, { type: 'rate', quantity: '5000', rate: '1250', rateUnit: 'day', days: '', hours: '', minutes: '' });
  assert.deepEqual(port.calendar.weekly, { fromDow: 4, fromTime: '17:00', toDow: 6, toTime: '08:00' });
  assert.equal(port.calendar.holidaysExcluded, false);
  assert.equal(port.calendar.unlessUsed, true);
  assert.equal(port.calendar.holidayFromPrev, '17:00');
  assert.equal(port.nor.rule, 'manual');
  assert.equal(port.nor.manualStart, '2026-05-04T14:00');
  assert.deepEqual(port.nor.officeHours, { enabled: true, from: '09:00', to: '18:00', satTo: '' });
  assert.deepEqual(port.events.map((e) => [e.type, e.kind, e.to, e.countPct, e.alsoOnDemurrage]), [
    ['weather', 'exception', '2026-05-05T12:00', '50', true], ['note', 'note', '', '100', false], ['custom', 'exception', '2026-05-06T11:00', '0', false],
  ]);
  assert.equal(r.calc.name, 'Poti');
  assert.equal(E.compute(r.calc).ok, true);
  // a note that only repeats the notice, commencement or completion is dropped: those moments are shown anyway
  p.events.push({ type: 'note', from: '2026-05-04T09:00', to: '', description: 'Notice of readiness tendered', counts_percent: '', on_demurrage: 'default' });
  p.events.push({ type: 'note', from: '2026-05-08T12:00', to: '', description: 'Discharging completed', counts_percent: '', on_demurrage: 'default' });
  p.events.push({ type: 'weather', from: '2026-05-08T12:00', to: '2026-05-08T13:00', description: 'Rain after completion', counts_percent: '', on_demurrage: 'default' });
  assert.deepEqual(X.toCalc(a).calc.ports[0].events.map((e) => e.desc), ['Rain', 'Samples drawn', 'Something', 'Rain after completion']);
  p.events.length = 3;
  // an unusable custom period falls back and is not silently wrong: the reader is asked to note it, and the regime shows SHINC
  p.working_time.custom_to_time = '';
  assert.equal(X.toCalc(a).calc.ports[0].calendar.preset, 'SHINC');
});

test('an answer with nothing in it is recognised as empty', () => {
  const r = X.toCalc(X.blankExtraction());
  assert.equal(r.empty, true);
  assert.deepEqual(r.documents, { cp: false, sof: false });
  const some = X.blankExtraction(); some.money.demurrage_per_day = '9000';
  assert.equal(X.toCalc(some).empty, false);
  assert.equal(X.toCalc(null).empty, true);
  assert.equal(X.toCalc({ ports: 'x', notes: 'y' }).empty, true);
});

// ---------------------------------------------------------------- one document only
const factsOf = (p) => [p.nor.tendered, p.commenced, p.completed, p.events.length];

test('statement of facts only: the times change, the charter party terms stay', () => {
  const base = examples()[0].calc; // Novorossiysk / Alexandria, with terms and old times
  const a = X.blankExtraction();
  a.documents = { charter_party: 'absent', statement_of_facts: 'read' };
  a.fixture.vessel = 'MV NEW VOYAGE';
  const load = X.blankExtractionPort('load');
  load.name = 'Novorossiysk, berth 21';
  load.allowed.cargo_quantity = '30000';
  load.notice.tendered = '2026-06-01T10:00';
  load.operations_commenced = '2026-06-01T15:00';
  load.operations_completed = '2026-06-05T03:00';
  load.events = [{ type: 'weather', from: '2026-06-02T01:00', to: '2026-06-02T05:00', description: 'Rain', counts_percent: '', on_demurrage: 'default' }];
  a.ports.push(load);
  const read = X.toCalc(a);
  assert.ok(read.notes.some((n) => n.field === 'demurrage_rate'), 'on its own the statement of facts has no rate');
  const m = X.merge(base, read, 'terms');
  assert.equal(m.calc.ports.length, 1, 'the discharge port of the earlier voyage would be out of time order: it is left out');
  const p = m.calc.ports[0];
  assert.deepEqual(factsOf(p), ['2026-06-01T10:00', '2026-06-01T15:00', '2026-06-05T03:00', 1]);
  assert.equal(p.name, 'Novorossiysk, berth 21');
  assert.equal(p.allowed.quantity, '30000', 'the cargo figure of this voyage');
  assert.equal(p.allowed.rate, '8000');
  assert.equal(p.calendar.preset, 'SSHEX');
  assert.equal(p.nor.rule, 'gencon');
  assert.equal(p.nor.officeHours.enabled, true);
  assert.equal(m.calc.demurrageRate, '14500');
  assert.equal(m.calc.commissionPct, '3.75');
  assert.equal(m.calc.meta.vessel, 'MV NEW VOYAGE');
  assert.equal(m.calc.meta.cpForm, 'Gencon 1994');
  assert.deepEqual(m.notes, [], 'notes about terms are dropped: the terms were kept');
  assert.equal(E.compute(m.calc).ok, true);
});

test('statement of facts for the next port is added after the port already entered', () => {
  const base = M.normalizeCalc(Object.assign({}, examples()[0].calc, { ports: [examples()[0].calc.ports[0]] })); // load port only
  const a = X.blankExtraction();
  a.documents.statement_of_facts = 'read';
  const dis = X.blankExtractionPort('discharge');
  dis.name = 'Alexandria';
  dis.notice.tendered = '2026-03-15T10:00';
  dis.operations_completed = '2026-03-24T18:00';
  a.ports.push(dis);
  a.notes.push({ field: 'operations_commenced', port: 1, status: 'not_found', comment: 'Commencement of discharge is not in the statement.' });
  const m = X.merge(base, X.toCalc(a), 'terms');
  assert.deepEqual(m.calc.ports.map((p) => p.name), ['Novorossiysk', 'Alexandria']);
  assert.deepEqual(factsOf(m.calc.ports[0]), factsOf(base.ports[0]), 'the first port is untouched');
  const p = m.calc.ports[1];
  assert.equal(p.calendar.preset, 'SSHEX', 'terms follow the last port, as with “Add port”');
  assert.equal(p.nor.rule, 'gencon');
  assert.equal(p.nor.tendered, '2026-03-15T10:00');
  // this port is new, so what is missing in its terms is still flagged, and the note follows the port to its new place
  assert.deepEqual(m.notes.map((n) => n.field + '/' + n.port), ['operations_commenced/1', 'laytime_allowed/1', 'working_time/1', 'notice_rule/1']);
});

test('charter party only: the terms change, the times already entered stay', () => {
  const base = examples()[0].calc;
  const a = extractionOf(examples()[0].calc);
  a.documents = { charter_party: 'read', statement_of_facts: 'absent' };
  a.money.demurrage_per_day = '16000';
  a.fixture.vessel = '';
  for (const p of a.ports) {
    p.working_time.regime = 'SHINC'; p.working_time.holidays = [];
    p.notice = Object.assign(X.blankExtractionPort().notice, { rule: 'hours_after_notice', hours_after_notice: '12', unless_sooner_commenced: 'no' });
    p.operations_commenced = ''; p.operations_completed = ''; p.events = []; p.name = '';
  }
  const read = X.toCalc(a);
  assert.ok(read.notes.some((n) => n.field === 'nor_tendered'));
  const m = X.merge(base, read, 'facts');
  assert.equal(m.calc.demurrageRate, '16000');
  assert.equal(m.calc.meta.vessel, 'MV EXAMPLE TRADER', 'kept: the charter party page did not give it');
  m.calc.ports.forEach((p, i) => {
    assert.deepEqual(factsOf(p), factsOf(base.ports[i]));
    assert.equal(p.name, base.ports[i].name);
    assert.equal(p.calendar.preset, 'SHINC');
    assert.equal(p.nor.rule, 'turn');
    assert.equal(p.nor.turnHours, '12');
    assert.equal(p.nor.unlessSoonerCommenced, false);
  });
  assert.equal(m.calc.ports[1].calendar.holidays.length, 1, 'holidays came with the facts');
  assert.deepEqual(m.notes, [], 'notes about times are dropped: the times were kept');
  const r = E.compute(m.calc);
  assert.equal(r.ok, true);
  assert.equal(r.totals.demRate, 16000);
});

test('charter party only, nothing entered yet: ports come from the charter party and wait for their times', () => {
  const a = extractionOf(examples()[1].calc);
  a.documents = { charter_party: 'read', statement_of_facts: 'absent' };
  for (const p of a.ports) { p.notice.tendered = ''; p.operations_commenced = ''; p.operations_completed = ''; p.events = []; }
  const read = X.toCalc(a);
  const m = X.merge(M.blankCalc(), read, 'facts');
  assert.equal(m.calc.ports.length, 2);
  assert.deepEqual(m.notes.map((n) => n.field + '/' + n.port), ['nor_tendered/0', 'operations_completed/0', 'nor_tendered/1', 'operations_completed/1']);
  assert.equal(m.calc.demurrageRate, '32000');
});
