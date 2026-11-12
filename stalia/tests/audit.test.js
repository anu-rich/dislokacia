'use strict';
/*
 * Checking a counterparty's figure: which single change to our own calculation gives their amount,
 * and the same gap put as one moment moved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const A = require('../app/audit.js');

const tanker = () => M.normalizeCalc(M.examples('en')[1].calc);
const bulk = () => M.normalizeCalc(M.examples('en')[0].calc);
/** What the other side would arrive at with one thing counted differently. */
const their = (calc, change) => { const c = JSON.parse(JSON.stringify(calc)); change(c); return A.signedNet(c); };
const kinds = (x) => x.matches.map((m) => m.kinds.map((k) => k.kind).join('+'));

test('the outcome as one signed number: demurrage up, despatch down, nothing while a time is missing', () => {
  const c = bulk();
  assert.equal(A.signedNet(c), E.compute(c).totals.net);
  assert.ok(A.signedNet(c) > 0);
  const early = bulk();
  early.ports[1].completed = '2026-03-17T10:00';
  early.ports[1].events = [];
  // each port on its own: demurrage at the loading port, more despatch at the discharging port
  const r = E.compute(early);
  assert.equal(r.totals.outcome, 'net_despatch');
  assert.equal(A.signedNet(early), -Math.abs(r.totals.net));
  assert.ok(A.signedNet(early) < 0);
  const mixed = bulk();
  mixed.ports[1].completed = '2026-03-23T00:00';
  mixed.ports[1].events = mixed.ports[1].events.filter((e) => e.to <= mixed.ports[1].completed);
  const rm = E.compute(mixed);
  assert.equal(rm.totals.outcome, 'net_demurrage', JSON.stringify([rm.totals.demurrage, rm.totals.despatch]));
  assert.equal(A.signedNet(mixed), Math.abs(rm.totals.net));
  const open = bulk();
  open.ports[1].completed = '';
  assert.equal(A.signedNet(open), null);
  assert.equal(A.explain(open, 1000), null, 'nothing to explain until our own side adds up');
  assert.equal(A.explain(c, NaN), null);
});

test('the same figure needs no explaining; a cent or a rounded minute apart is still the same figure', () => {
  const c = tanker(), ours = A.signedNet(c);
  for (const claimed of [ours, ours + 0.01, ours - 10]) {
    const x = A.explain(c, claimed);
    assert.deepEqual([x.matches.length, x.shifts.length, x.rate], [0, 0, null], String(claimed));
  }
  const x = A.explain(c, ours);
  assert.deepEqual([x.ours, x.claimed, x.gap, x.gapMin], [ours, ours, 0, 0]);
});

test('one thing counted differently is found: a stoppage, the notice time, where laytime starts, commission', () => {
  const c = tanker(), ours = A.signedNet(c);

  // they did not deduct the pump breakdown (1 h 30 min)
  let x = A.explain(c, their(c, (k) => { k.ports[1].events[0].countPct = '100'; }));
  assert.deepEqual(kinds(x), ['event_full']);
  assert.equal(x.matches[0].kinds[0].port, 1);
  assert.equal(x.matches[0].kinds[0].event.type, 'breakdown');
  assert.equal(x.matches[0].kinds[0].event.from, '2026-04-10T02:00');
  assert.equal(x.gapMin, 90);
  assert.ok(x.gap > 0, 'they claim more');
  assert.equal(x.matches[0].amount, x.claimed);

  // they counted the shifting to the berth
  x = A.explain(c, their(c, (k) => { k.ports[0].events[0].countPct = '100'; }));
  assert.deepEqual(kinds(x), ['event_full']);
  assert.equal(x.matches[0].kinds[0].event.type, 'shifting');

  // no notice time at the first port: said once, as hours, not a second time as "starts when notice is tendered"
  x = A.explain(c, their(c, (k) => { k.ports[0].nor.turnHours = '0'; }));
  assert.deepEqual(kinds(x), ['notice_hours']);
  assert.deepEqual([x.matches[0].kinds[0].port, x.matches[0].kinds[0].value], [0, '0']);
  assert.equal(x.gapMin, 360);

  // laytime from a moment the documents record under another name
  const late = their(c, (k) => { k.ports[1].nor.rule = 'manual'; k.ports[1].nor.manualStart = '2026-04-10T02:00'; });
  x = A.explain(c, late);
  const start = x.matches.find((m) => m.kinds[0].kind === 'start_at');
  assert.ok(start, JSON.stringify(kinds(x)));
  assert.deepEqual([start.kinds[0].port, start.kinds[0].value, start.kinds[0].label.what, start.kinds[0].label.edge], [1, '2026-04-10T02:00', 'event', 'from']);

  // commission left out
  x = A.explain(c, their(c, (k) => { k.commissionPct = ''; }));
  assert.deepEqual(kinds(x), ['no_commission']);
  assert.ok(x.gap > 0 && Math.abs(x.gap - (E.compute(c).totals.demurrage - ours)) < 0.01);
});

test('a gap no single change explains is shown as one moment moved, and that moment really gives their amount', () => {
  const c = tanker(), ours = A.signedNet(c), claimed = Math.round((ours - 1234.56) * 100) / 100;
  const x = A.explain(c, claimed);
  assert.deepEqual(x.matches, [], 'two changes at once are not tried: with two free choices amounts coincide by chance');
  assert.equal(x.gap, -1234.56);
  assert.ok(x.gapMin < 0);
  assert.deepEqual(x.shifts.map((s) => s.kind + s.port), ['start_shift0', 'end_shift0', 'start_shift1', 'end_shift1']);
  for (const s of x.shifts) {
    // a later start or an earlier stop: either takes the same minutes out of the count
    assert.ok(s.kind === 'start_shift' ? s.byMin > 0 : s.byMin < 0, JSON.stringify(s));
    assert.ok(Math.abs(Math.abs(s.byMin) - Math.abs(x.gapMin)) <= 1, JSON.stringify(s));
    const got = their(c, (k) => { if (s.kind === 'start_shift') { k.ports[s.port].nor.rule = 'manual'; k.ports[s.port].nor.manualStart = s.at; } else k.ports[s.port].completed = s.at; });
    assert.ok(Math.abs(got - claimed) <= x.tolerance, s.kind + ' gives ' + got + ', wanted ' + claimed);
  }
});

test('the same time at another round rate is said too, when no commission blurs it', () => {
  const c = tanker();
  c.commissionPct = '';
  const mins = E.compute(c).totals.demMin;
  const x = A.explain(c, Math.round(mins / 1440 * 30000 * 100) / 100);
  assert.equal(x.rate, 30000);
  assert.equal(A.explain(c, Math.round(mins / 1440 * 30123 * 100) / 100).rate, null, 'an odd rate is no explanation');
  assert.equal(A.explain(tanker(), Math.round(mins / 1440 * 30000 * 100) / 100).rate, null, 'with commission the amounts are not time times rate');
});

test('every candidate changes one thing only and leaves the calculation it was given untouched', () => {
  const c = bulk(), before = JSON.stringify(c), list = A.candidates(c);
  assert.ok(list.length > 15 && list.length < 80, String(list.length));
  for (const h of list) {
    const k = JSON.parse(before);
    h.apply(k);
    assert.notEqual(JSON.stringify(k), before, h.kind);
    assert.ok(typeof h.key === 'string' && h.key, h.kind);
  }
  assert.equal(JSON.stringify(c), before);
  A.explain(c, 12345.67);
  assert.equal(JSON.stringify(c), before, 'explaining does not touch the calculation either');
  // notes and "worked" periods are never offered as deductions
  assert.ok(list.every((h) => !h.event || (h.event.from && h.event.to)));
});
