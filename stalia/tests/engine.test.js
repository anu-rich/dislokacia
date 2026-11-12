'use strict';
/* Run: node --test stalia/tests/  */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');

const H = 60, DAY = 1440;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol == null ? 1e-6 : tol), (msg || '') + ` expected ${b}, got ${a}`);
const dt = (s) => E.parseDT(s);

function port(over) {
  return Object.assign({
    name: 'Port', operation: 'load',
    allowed: { type: 'fixed', hours: 72 },
    calendar: { preset: 'SHINC' },
    nor: { rule: 'manual', manualStart: '2026-03-06T00:00' },
    completed: '2026-03-09T00:00',
    events: [],
  }, over || {});
}
function fix(over) {
  return Object.assign({
    demurrageRate: 24000, despatchMode: 'half', despatchBasis: 'WTS',
    laytimeMode: 'reversible', onceOnDemurrage: true, ports: [port()],
  }, over || {});
}

// 2026-03-01 is a Sunday; 6 Mar = Friday, 7 = Saturday, 8 = Sunday, 9 = Monday.
test('calendar sanity: day of week', () => {
  assert.equal(E.dow(dt('2026-03-01T00:00')), 0);
  assert.equal(E.dow(dt('2026-03-06T12:00')), 5);
  assert.equal(E.dow(dt('2026-03-07T23:59')), 6);
  assert.equal(E.dow(dt('1969-12-31T10:00')), 3); // negative day index
  assert.equal(E.dow(dt('2024-02-29T00:00')), 4); // leap day, Thursday
});

test('parseDT / fmtDT round trip and rejects', () => {
  assert.equal(E.fmtDT(dt('2026-12-31T23:59')), '2026-12-31T23:59');
  assert.equal(E.fmtDT(dt('2026-03-06 07:05')), '2026-03-06T07:05');
  assert.equal(E.fmtDT(dt('2026-03-06')), '2026-03-06T00:00');
  assert.equal(dt('2026-02-30T10:00'), null);
  assert.equal(dt('2026-13-01T10:00'), null);
  assert.equal(dt('06.03.2026 10:00'), null);
  assert.equal(dt(''), null);
  assert.equal(E.fmtDT(dt('2026-03-06T24:00')), '2026-03-07T00:00');
});

test('allowed time: fixed and by rate', () => {
  near(E.allowedMinutes({ type: 'fixed', days: 2, hours: 12, minutes: 30 }), 2 * DAY + 12 * H + 30);
  near(E.allowedMinutes({ type: 'rate', quantity: 30000, rate: 10000 }), 3 * DAY);
  near(E.allowedMinutes({ type: 'rate', quantity: '27 500', rate: '5000' }), 5.5 * DAY);
  near(E.allowedMinutes({ type: 'rate', quantity: 60000, rate: 2500, rateUnit: 'hour' }), 24 * H);
  near(E.allowedMinutes({ type: 'rate', quantity: '1,5', rate: 1 }), 1.5 * DAY); // decimal comma
  assert.ok(isNaN(E.allowedMinutes({ type: 'rate', quantity: 1000, rate: 0 })));
  assert.ok(isNaN(E.allowedMinutes({ type: 'fixed', hours: -5 })));
});

test('number parsing: thousands separators and decimal commas', () => {
  const cases = [
    ['14,500', 14500], ['14 500', 14500], ['14\u00A0500', 14500], ["14'500", 14500], ['14500.50', 14500.5],
    ['14500,5', 14500.5], ['14,5', 14.5], ['0,125', 0.125], ['3,75', 3.75], ['1,250,000', 1250000],
    ['1,250,000.75', 1250000.75], ['1.250.000,75', 1250000.75], ['1.250.000', 1250000], ['14.5', 14.5],
    ['27500', 27500], [' 8000 ', 8000], [12.5, 12.5], ['-3', -3],
  ];
  for (const [input, want] of cases) assert.equal(E.num(input), want, JSON.stringify(input));
  for (const bad of ['', '  ', 'abc', '12a', '1,2,3', '1.2.3', null, undefined, NaN, Infinity]) assert.ok(isNaN(E.num(bad)), JSON.stringify(bad));
});

test('tanker: 72 h total reversible, 6 h notice, SHINC — 12 h demurrage', () => {
  const r = E.compute(fix({
    demurrageRate: 30000, despatchMode: 'none',
    ports: [
      port({
        name: 'Load', allowed: { type: 'fixed', hours: 72 },
        nor: { rule: 'turn', tendered: '2026-03-01T06:00', turnHours: 6, unlessSoonerCommenced: true },
        commenced: '2026-03-01T14:00', completed: '2026-03-02T18:00',
      }),
      port({
        name: 'Discharge', operation: 'discharge', allowed: { type: 'fixed', hours: 0 },
        nor: { rule: 'turn', tendered: '2026-03-06T10:00', turnHours: 6, unlessSoonerCommenced: true },
        commenced: '2026-03-06T15:00', completed: '2026-03-08T21:00',
      }),
    ],
  }));
  assert.ok(r.ok);
  assert.equal(E.fmtDT(r.ports[0].start), '2026-03-01T12:00'); // NOR + 6 h (berthing later)
  near(r.ports[0].usedMin, 30 * H);
  assert.equal(E.fmtDT(r.ports[1].start), '2026-03-06T15:00'); // all fast sooner than NOR + 6 h
  assert.ok(r.ports[1].sooner);
  assert.equal(E.fmtDT(r.ports[1].expiry), '2026-03-08T09:00');
  near(r.totals.usedMin, 72 * H);
  near(r.totals.demMin, 12 * H);
  assert.equal(r.totals.demurrage, 15000);
  assert.equal(r.totals.despatch, 0);
  assert.equal(r.totals.outcome, 'demurrage');
});

test('dry bulk: Gencon start, SHEX, rain — despatch on working time saved', () => {
  const r = E.compute(fix({
    demurrageRate: 10000,
    ports: [port({
      allowed: { type: 'rate', quantity: 30000, rate: 10000 },
      calendar: { preset: 'SHEX' },
      nor: { rule: 'gencon', tendered: '2026-03-06T09:00', amStart: '13:00', pmStart: '06:00' },
      completed: '2026-03-10T10:00',
      events: [{ from: '2026-03-07T10:00', to: '2026-03-07T14:00', desc: 'Rain', countPct: 0 }],
    })],
  }));
  assert.ok(r.ok);
  assert.equal(E.fmtDT(r.ports[0].start), '2026-03-06T13:00');
  // Fri 11 h + Sat 20 h + Sun 0 + Mon 24 h + Tue 10 h = 65 h
  near(r.totals.usedMin, 65 * H);
  near(r.totals.desMin, 7 * H);
  assert.equal(r.totals.despatch, 1458.33); // 7/24 day x 5000
  assert.equal(r.totals.outcome, 'despatch');
  near(r.ports[0].notCountedMin, 28 * H); // 4 h rain + 24 h Sunday
});

test('despatch: all time saved vs working time saved across a Sunday', () => {
  const base = {
    demurrageRate: 12000,
    ports: [port({
      allowed: { type: 'fixed', hours: 30 },
      calendar: { preset: 'SHEX' },
      nor: { rule: 'manual', manualStart: '2026-03-07T00:00' }, // Saturday
      completed: '2026-03-07T20:00',
    })],
  };
  const wts = E.compute(fix(Object.assign({}, base, { despatchBasis: 'WTS' })));
  near(wts.totals.desMin, 10 * H);
  assert.equal(wts.totals.despatch, 2500);
  const ats = E.compute(fix(Object.assign({}, base, { despatchBasis: 'ATS' })));
  // 10 h left: Sat 20:00-24:00 (4 h), Sunday excepted, Mon 00:00-06:00 (6 h) => expiry Mon 06:00
  assert.equal(E.fmtDT(ats.ports[0].projectedExpiry), '2026-03-09T06:00');
  near(ats.totals.desMin, 34 * H);
  assert.equal(ats.totals.despatch, 8500);
});

test('once on demurrage, always on demurrage (and the opposite clause)', () => {
  const ports = [port({
    allowed: { type: 'fixed', hours: 24 },
    calendar: { preset: 'SHEX' },
    nor: { rule: 'manual', manualStart: '2026-03-06T00:00' }, // Friday
    completed: '2026-03-09T12:00', // Monday noon
  })];
  const a = E.compute(fix({ ports, onceOnDemurrage: true }));
  assert.equal(E.fmtDT(a.ports[0].expiry), '2026-03-07T00:00');
  near(a.totals.demMin, 60 * H); // Sat + Sun + 12 h Mon
  assert.equal(a.totals.demurrage, 60000);
  const b = E.compute(fix({ ports, onceOnDemurrage: false }));
  near(b.totals.demMin, 36 * H); // Sunday still excepted
});

test('exceptions after expiry: weather ignored, owner\'s fault still deducted', () => {
  const mk = (ev) => E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 24 },
      nor: { rule: 'manual', manualStart: '2026-03-02T00:00' },
      completed: '2026-03-04T00:00',
      events: [ev],
    })],
  }));
  const rain = mk({ from: '2026-03-03T06:00', to: '2026-03-03T12:00', desc: 'Rain', countPct: 0 });
  near(rain.totals.demMin, 24 * H);
  const breakdown = mk({ from: '2026-03-03T06:00', to: '2026-03-03T12:00', desc: 'Crane breakdown (vessel)', countPct: 0, alsoOnDemurrage: true });
  near(breakdown.totals.demMin, 18 * H);
  const half = mk({ from: '2026-03-03T06:00', to: '2026-03-03T12:00', desc: 'Weather (half rate clause)', countPct: 50, alsoOnDemurrage: true });
  near(half.totals.demMin, 21 * H);
});

test('unless used vs even if used', () => {
  const mk = (uu) => E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 100 },
      calendar: { preset: 'SHEX', unlessUsed: uu },
      nor: { rule: 'manual', manualStart: '2026-03-07T00:00' }, // Sat
      completed: '2026-03-09T00:00', // Mon 00:00
      events: [{ kind: 'worked', from: '2026-03-08T08:00', to: '2026-03-08T16:00', desc: 'Loading on Sunday' }],
    })],
  }));
  near(mk(true).totals.usedMin, 32 * H);
  const eiu = mk(false);
  near(eiu.totals.usedMin, 24 * H);
  assert.ok(eiu.warnings.some((w) => w.code === 'worked_no_effect'));
});

test('partial counting and expiry in the middle of a half-count period', () => {
  const r = E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 12 },
      nor: { rule: 'manual', manualStart: '2026-03-02T00:00' },
      completed: '2026-03-02T20:00',
      events: [{ from: '2026-03-02T10:00', to: '2026-03-02T16:00', desc: '2 of 4 gangs', countPct: 50 }],
    })],
  }));
  // 00-10 counts 10 h; then 50 %: 2 h remaining are used up after 4 clock hours => expiry 14:00
  assert.equal(E.fmtDT(r.ports[0].expiry), '2026-03-02T14:00');
  near(r.totals.usedMin, 12 * H);
  near(r.totals.demMin, 6 * H); // 14:00-20:00 in full (exception not applicable on demurrage)
  const rows = r.ports[0].rows;
  // 00-10 full, 10-14 at 50 %, 14-16 on demurrage with the exception switched off, 16-20 on demurrage
  assert.deepEqual(rows.map((x) => x.regime), ['laytime', 'laytime', 'demurrage', 'demurrage']);
  near(rows[1].counted, 2 * H);
  assert.ok(rows[2].reasons.some((q) => q.code === 'exceptions_off'));
  near(rows[2].counted, 2 * H);
  assert.deepEqual(rows[3].reasons, []);
});

test('non-reversible vs averaging', () => {
  const ports = [
    port({ name: 'L', allowed: { type: 'fixed', hours: 48 }, nor: { rule: 'manual', manualStart: '2026-03-02T00:00' }, completed: '2026-03-04T12:00' }),
    port({ name: 'D', operation: 'discharge', allowed: { type: 'fixed', hours: 48 }, nor: { rule: 'manual', manualStart: '2026-03-10T00:00' }, completed: '2026-03-11T12:00' }),
  ];
  const sep = E.compute(fix({ ports, laytimeMode: 'separate', demurrageRate: 12000 }));
  near(sep.ports[0].demMin, 12 * H); near(sep.ports[1].savedMin, 12 * H);
  assert.equal(sep.totals.demurrage, 6000);
  assert.equal(sep.totals.despatch, 3000);
  assert.equal(sep.totals.net, 3000);
  assert.equal(sep.totals.outcome, 'net_demurrage');
  const avg = E.compute(fix({ ports, laytimeMode: 'average', demurrageRate: 12000 }));
  near(avg.totals.demMin, 0); near(avg.totals.desMin, 0);
  assert.equal(avg.totals.net, 0);
  assert.equal(avg.totals.outcome, 'even');
  const rev = E.compute(fix({ ports, laytimeMode: 'reversible', demurrageRate: 12000 }));
  near(rev.totals.usedMin, 96 * H); near(rev.totals.demMin, 0); near(rev.totals.desMin, 0);
});

test('Gencon: afternoon NOR rolls to next working day; Saturday-noon weekend', () => {
  const shex = E.laytimeStart({ nor: { rule: 'gencon', tendered: '2026-03-07T15:00', amStart: '13:00', pmStart: '06:00' } }, E.resolveCalendar({ preset: 'SHEX' }));
  assert.equal(E.fmtDT(shex.start), '2026-03-09T06:00'); // Sunday skipped
  const noon = E.resolveCalendar({ preset: 'SATNOON' });
  const fri = E.laytimeStart({ nor: { rule: 'gencon', tendered: '2026-03-06T15:00', pmStart: '08:00' } }, noon);
  assert.equal(E.fmtDT(fri.start), '2026-03-07T08:00'); // Saturday morning is working time
  const sat = E.laytimeStart({ nor: { rule: 'gencon', tendered: '2026-03-07T15:00', pmStart: '08:00' } }, noon);
  assert.equal(E.fmtDT(sat.start), '2026-03-09T08:00'); // Sunday 08:00 is excepted -> Monday 08:00
  const exactNoon = E.laytimeStart({ nor: { rule: 'gencon', tendered: '2026-03-06T12:00' } }, E.resolveCalendar({ preset: 'SHINC' }));
  assert.equal(E.fmtDT(exactNoon.start), '2026-03-06T13:00'); // "up to and including 12.00"
  // counting then really starts Monday 08:00 if NOR Saturday 11:00 under Sat-noon terms
  const r = E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 100 }, calendar: { preset: 'SATNOON' },
      nor: { rule: 'gencon', tendered: '2026-03-07T11:00', amStart: '13:00' },
      completed: '2026-03-09T18:00',
    })],
  }));
  assert.equal(E.fmtDT(r.ports[0].start), '2026-03-07T13:00');
  near(r.totals.usedMin, 10 * H);
});

test('NOR office hours', () => {
  const cal = E.resolveCalendar({ preset: 'SHEX' });
  const oh = { enabled: true, from: '08:00', to: '17:00', satTo: '12:00' };
  const f = (s) => E.fmtDT(E.norInOfficeHours(dt(s), oh, cal));
  assert.equal(f('2026-03-06T10:00'), '2026-03-06T10:00'); // inside
  assert.equal(f('2026-03-06T05:00'), '2026-03-06T08:00'); // before opening
  assert.equal(f('2026-03-06T17:00'), '2026-03-06T17:00'); // closing minute still valid
  assert.equal(f('2026-03-06T19:00'), '2026-03-07T08:00'); // Friday evening -> Saturday
  assert.equal(f('2026-03-07T14:00'), '2026-03-09T08:00'); // Saturday afternoon -> Monday
  assert.equal(f('2026-03-08T10:00'), '2026-03-09T08:00'); // Sunday -> Monday
  const ls = E.laytimeStart({ nor: { rule: 'gencon', tendered: '2026-03-07T14:00', officeHours: oh } }, cal);
  assert.equal(E.fmtDT(ls.norEff), '2026-03-09T08:00');
  assert.ok(ls.norAdjusted);
  assert.equal(E.fmtDT(ls.start), '2026-03-09T13:00');
  // holiday on Monday pushes it further
  const calH = E.resolveCalendar({ preset: 'SHEX', holidays: [{ date: '2026-03-09', name: 'Holiday' }] });
  assert.equal(E.fmtDT(E.norInOfficeHours(dt('2026-03-07T14:00'), oh, calH)), '2026-03-10T08:00');
});

test('holidays: plain day, and with eve / next-morning extension; SHINC ignores them', () => {
  const mk = (cal) => E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 500 }, calendar: cal,
      nor: { rule: 'manual', manualStart: '2026-03-10T00:00' }, completed: '2026-03-13T00:00', // Tue..Fri
    })],
  }));
  const hol = [{ date: '2026-03-11', name: 'National Day' }];
  near(mk({ preset: 'SHEX', holidays: hol }).totals.usedMin, 48 * H);
  near(mk({ preset: 'SHEX', holidays: hol, holidayFromPrev: '17:00', holidayToNext: '08:00' }).totals.usedMin, (72 - 39) * H);
  near(mk({ preset: 'SHINC', holidays: hol }).totals.usedMin, 72 * H);
  const r = mk({ preset: 'SHEX', holidays: hol });
  const hrow = r.ports[0].rows.find((x) => x.reasons.some((q) => q.code === 'holiday'));
  assert.equal(hrow.reasons[0].name, 'National Day');
  assert.equal(E.fmtDT(hrow.from), '2026-03-11T00:00');
});

test('reversible: already on demurrage at the next port — runs from NOR (or from laytime start)', () => {
  const ports = [
    port({ name: 'L', allowed: { type: 'fixed', hours: 24 }, nor: { rule: 'manual', manualStart: '2026-03-02T00:00' }, completed: '2026-03-03T12:00' }),
    port({
      name: 'D', operation: 'discharge', allowed: { type: 'fixed', hours: 0 },
      nor: { rule: 'turn', tendered: '2026-03-06T10:00', turnHours: 6, unlessSoonerCommenced: false },
      completed: '2026-03-07T10:00',
    }),
  ];
  const a = E.compute(fix({ ports }));
  near(a.ports[0].demMin, 12 * H);
  assert.ok(a.ports[1].arrivedOnDemurrage);
  assert.equal(E.fmtDT(a.ports[1].start), '2026-03-06T10:00');
  near(a.ports[1].demMin, 24 * H);
  near(a.totals.demMin, 36 * H);
  const b = E.compute(fix({ ports, demurrageAtNextPort: 'laytimeStart' }));
  assert.equal(E.fmtDT(b.ports[1].start), '2026-03-06T16:00');
  near(b.totals.demMin, 30 * H);
});

test('commission on demurrage and custom despatch rate', () => {
  const r = E.compute(fix({
    demurrageRate: 20000, commissionPct: 3.75,
    ports: [port({ allowed: { type: 'fixed', hours: 24 }, nor: { rule: 'manual', manualStart: '2026-03-02T00:00' }, completed: '2026-03-04T00:00' })],
  }));
  assert.equal(r.totals.demurrage, 20000);
  assert.equal(r.totals.commission, 750);
  assert.equal(r.totals.net, 19250);
  const d = E.compute(fix({
    demurrageRate: 20000, despatchMode: 'custom', despatchRate: 7000,
    ports: [port({ allowed: { type: 'fixed', hours: 48 }, nor: { rule: 'manual', manualStart: '2026-03-02T00:00' }, completed: '2026-03-03T00:00' })],
  }));
  assert.equal(d.totals.despatch, 7000);
  assert.equal(d.totals.net, -7000);
});

test('validation errors and warnings', () => {
  const codes = (r) => r.errors.map((e) => e.code);
  assert.deepEqual(codes(E.compute({})), ['no_ports']);
  assert.ok(codes(E.compute(fix({ ports: [port({ completed: '' })] }))).includes('completed_missing'));
  assert.ok(codes(E.compute(fix({ ports: [port({ nor: { rule: 'turn', tendered: '' } })] }))).includes('nor_missing'));
  assert.ok(codes(E.compute(fix({ ports: [port({ completed: '2026-03-01T00:00' })] }))).includes('end_before_start'));
  assert.ok(codes(E.compute(fix({ ports: [port({ allowed: { type: 'rate', quantity: 5, rate: '' } })] }))).includes('allowed_invalid'));
  assert.ok(codes(E.compute(fix({ ports: [port({ events: [{ from: '2026-03-07T10:00', to: '2026-03-07T09:00', desc: 'x' }] })] }))).includes('event_range_invalid'));
  assert.ok(codes(E.compute(fix({ ports: [port({ events: [{ from: '2026-03-07T10:00', to: '', desc: 'x' }] })] }))).includes('event_time_missing'));
  assert.ok(codes(E.compute(fix({ ports: [port({ calendar: { preset: 'CUSTOM', weekly: { fromDow: 1, fromTime: '08:00', toDow: 1, toTime: '08:00' } } })] }))).includes('weekly_invalid'));
  // blank event rows are ignored, events outside laytime are only a warning
  const ok = E.compute(fix({ ports: [port({ events: [{ from: '', to: '', desc: '' }, { from: '2026-04-01T00:00', to: '2026-04-01T05:00', desc: 'late' }] })] }));
  assert.ok(ok.ok);
  assert.ok(ok.warnings.some((w) => w.code === 'event_outside'));
  const noRate = E.compute(fix({ demurrageRate: '' }));
  assert.ok(noRate.ok && noRate.warnings.some((w) => w.code === 'demurrage_rate_missing'));
});

test('zero allowance: on demurrage from the first minute', () => {
  const r = E.compute(fix({ ports: [port({ allowed: { type: 'fixed', hours: 0 }, completed: '2026-03-06T12:00' })] }));
  near(r.totals.demMin, 12 * H);
  assert.equal(E.fmtDT(r.ports[0].expiry), '2026-03-06T00:00');
});

test('splitRowsByDay keeps totals and running balances', () => {
  const r = E.compute(fix({
    ports: [port({
      allowed: { type: 'fixed', hours: 40 }, calendar: { preset: 'SSHEX' },
      nor: { rule: 'manual', manualStart: '2026-03-05T09:30' }, completed: '2026-03-11T17:45',
      events: [{ from: '2026-03-05T22:00', to: '2026-03-06T03:00', desc: 'Rain', countPct: 0 }],
    })],
  }));
  const rows = r.ports[0].rows, days = E.splitRowsByDay(rows);
  const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
  near(sum(days, 'counted'), sum(rows, 'counted'), 1e-6);
  near(sum(days, 'counted'), r.ports[0].usedMin + r.ports[0].demMin, 1e-6);
  for (const d of days) assert.ok(E.startOfDay(d.from) === E.startOfDay(d.to - 0.0001), 'row within one day');
  const lay = days.filter((d) => d.regime === 'laytime');
  near(lay[lay.length - 1].cumUsed, 40 * H); near(lay[lay.length - 1].remaining, 0);
  for (let i = 1; i < lay.length; i++) assert.ok(lay[i].cumUsed >= lay[i - 1].cumUsed - 1e-9);
  const dem = days.filter((d) => d.regime === 'demurrage');
  near(dem[dem.length - 1].cumDem, r.ports[0].demMin, 1e-6);
});

// ------------------------------------------------------------------ brute-force cross-check
// Independent minute-by-minute simulator. It shares no counting code with the engine.
function refFactor(p, once, t, onDem) {
  const cal = E.resolveCalendar(p.calendar);
  let calEx = false;
  if (cal.weekly) {
    const s = cal.weekly.fromDow * DAY + E.timeToMin(cal.weekly.fromTime, 0);
    let e = cal.weekly.toDow * DAY + E.timeToMin(cal.weekly.toTime, 0);
    if (e <= s) e += 7 * DAY;
    const d = new Date(t * 60000);
    const mow = d.getUTCDay() * DAY + d.getUTCHours() * 60 + d.getUTCMinutes();
    if ((((mow - s) % (7 * DAY)) + 7 * DAY) % (7 * DAY) < e - s) calEx = true;
  }
  if (cal.holidaysExcluded) {
    const lead = cal.holidayFromPrev ? DAY - E.timeToMin(cal.holidayFromPrev, DAY) : 0;
    const tail = cal.holidayToNext ? E.timeToMin(cal.holidayToNext, 0) : 0;
    for (const h of cal.holidays) {
      const d0 = dt(h.date);
      if (t >= d0 - lead && t < d0 + DAY + tail) calEx = true;
    }
  }
  let worked = false, fExc = 1, fExcD = 1;
  for (const ev of p.events || []) {
    const a = dt(ev.from), b = dt(ev.to);
    if (!(t >= a && t < b)) continue;
    if (ev.kind === 'worked') worked = true;
    else if (ev.kind !== 'note') {
      const f = (ev.countPct || 0) / 100;
      fExc = Math.min(fExc, f);
      if (ev.alsoOnDemurrage) fExcD = Math.min(fExcD, f);
    }
  }
  const fCal = calEx && !(cal.unlessUsed && worked) ? 0 : 1;
  const fL = Math.min(fCal, fExc);
  return onDem ? (once ? fExcD : fL) : fL;
}
function refRun(p, once, state) {
  const S = dt(p.nor.manualStart), En = dt(p.completed);
  let used = 0, dem = 0;
  for (let t = S; t < En; t++) {
    if (!state.onDem && state.remaining <= 1e-9) state.onDem = true;
    if (state.onDem) { dem += refFactor(p, once, t, true); continue; }
    const f = refFactor(p, once, t, false);
    if (f < state.remaining - 1e-9) { state.remaining -= f; used += f; } else {
      const frac = f > 0 ? state.remaining / f : 0;
      used += state.remaining; state.remaining = 0; state.onDem = true;
      dem += (1 - frac) * refFactor(p, once, t, true);
    }
  }
  if (!state.onDem && state.remaining <= 1e-9) state.onDem = true;
  return { used, dem };
}
function refATS(p, remaining) {
  let t = dt(p.completed), rem = remaining, n = 0;
  const bare = Object.assign({}, p, { events: [] });
  while (rem > 1e-9 && n++ < 400000) {
    const f = refFactor(bare, true, t, false);
    if (f >= rem) return t + rem / f - dt(p.completed);
    rem -= f; t++;
  }
  return t - dt(p.completed);
}

const { rng, randomFixture } = require('./helpers/random.js');

test('engine agrees with a minute-by-minute reference on 400 random fixtures', () => {
  const rand = rng(20261112);
  for (let n = 0; n < 400; n++) {
    const fx = randomFixture(rand);
    const r = E.compute(fx);
    assert.ok(r.ok, 'fixture ' + n + ' invalid: ' + JSON.stringify(r.errors));
    const once = fx.onceOnDemurrage;
    let refUsed = 0, refDem = 0, refSavedW = 0, refSavedA = 0;
    if (fx.laytimeMode === 'reversible') {
      const state = { remaining: fx.ports.reduce((s, p) => s + p.allowed.minutes, 0), onDem: false };
      fx.ports.forEach((p, i) => {
        const q = refRun(p, once, state);
        near(r.ports[i].usedMin, q.used, 1e-4, `#${n} port ${i} used:`);
        near(r.ports[i].demMin, q.dem, 1e-4, `#${n} port ${i} dem:`);
        refUsed += q.used; refDem += q.dem;
      });
      if (!state.onDem) { refSavedW = state.remaining; refSavedA = refATS(fx.ports[fx.ports.length - 1], state.remaining); }
    } else {
      fx.ports.forEach((p, i) => {
        const state = { remaining: p.allowed.minutes, onDem: false };
        const q = refRun(p, once, state);
        near(r.ports[i].usedMin, q.used, 1e-4, `#${n} port ${i} used:`);
        near(r.ports[i].demMin, q.dem, 1e-4, `#${n} port ${i} dem:`);
        refUsed += q.used; refDem += q.dem;
        if (!state.onDem) { refSavedW += state.remaining; refSavedA += refATS(p, state.remaining); }
      });
    }
    near(r.totals.usedMin, refUsed, 1e-3, `#${n} used total:`);
    near(r.totals.demGrossMin, refDem, 1e-3, `#${n} dem total:`);
    near(r.totals.savedWTSMin, refSavedW, 1e-3, `#${n} saved WTS:`);
    near(r.totals.savedATSMin, refSavedA, 1e-3, `#${n} saved ATS:`);
    const savedBasis = fx.despatchBasis === 'ATS' ? refSavedA : refSavedW;
    if (fx.laytimeMode === 'average') {
      near(r.totals.demMin, Math.max(refDem - savedBasis, 0), 1e-3, `#${n} avg dem:`);
      near(r.totals.desMin, Math.max(savedBasis - refDem, 0), 1e-3, `#${n} avg des:`);
    } else {
      near(r.totals.demMin, refDem, 1e-3); near(r.totals.desMin, savedBasis, 1e-3);
    }
    // structural invariants
    for (const p of r.ports) {
      const rows = p.rows;
      for (let i = 1; i < rows.length; i++) near(rows[i].from, rows[i - 1].to, 1e-6, `#${n} rows contiguous:`);
      if (rows.length) { near(rows[0].from, p.start, 1e-6); near(rows[rows.length - 1].to, p.end, 1e-6); }
      near(rows.reduce((s, x) => s + x.counted, 0), p.usedMin + p.demMin, 1e-4, `#${n} rows sum:`);
      assert.ok(rows.every((x) => x.counted <= x.to - x.from + 1e-6 && x.counted >= -1e-9));
      const firstDem = rows.findIndex((x) => x.regime === 'demurrage');
      if (firstDem >= 0) assert.ok(rows.slice(firstDem).every((x) => x.regime === 'demurrage'), 'no laytime after demurrage');
    }
    assert.ok(r.totals.usedMin <= r.totals.allowedMin + 1e-4, 'used never exceeds allowed');
  }
});
