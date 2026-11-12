'use strict';
/* Random voyages for tests: the same seed always gives the same fixtures. */
const E = require('../../app/engine.js');

const H = 60, DAY = 1440;
const dt = (s) => E.parseDT(s);
const pad2 = (n) => (n < 10 ? '0' : '') + n;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function randomFixture(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const mode = pick(['reversible', 'separate', 'average']);
  const nPorts = int(1, 3);
  const ports = [];
  let cursor = dt('2026-02-20T00:00') + int(0, 20 * DAY);
  for (let i = 0; i < nPorts; i++) {
    const S = cursor + int(0, 3 * DAY);
    const En = S + int(1, 9 * DAY);
    cursor = En + int(60, 4 * DAY);
    const preset = pick(['SHINC', 'SHEX', 'SSHEX', 'SATNOON', 'FRI17', 'FHEX', 'FSHEX', 'TFHEX', 'CUSTOM']);
    const cal = { preset, unlessUsed: rand() < 0.5 };
    if (preset === 'CUSTOM') {
      cal.weekly = { fromDow: int(0, 6), fromTime: pad2(int(0, 23)) + ':' + pad2(pick([0, 15, 30])), toDow: int(0, 6), toTime: pad2(int(0, 23)) + ':' + pad2(pick([0, 30, 45])) };
      if (cal.weekly.fromDow === cal.weekly.toDow && cal.weekly.fromTime === cal.weekly.toTime) cal.weekly.toTime = '23:59';
      cal.holidaysExcluded = rand() < 0.7;
    }
    cal.holidays = [];
    for (let h = int(0, 2); h > 0; h--) cal.holidays.push({ date: E.fmtDT(S + int(0, 9 * DAY)).slice(0, 10), name: 'H' });
    if (rand() < 0.4) { cal.holidayFromPrev = pick(['17:00', '12:00', '18:30']); cal.holidayToNext = pick(['08:00', '06:00', '']); }
    const events = [];
    for (let e = int(0, 6); e > 0; e--) {
      const a = S - 300 + int(0, En - S + 600), b = a + int(1, 30 * H);
      const worked = rand() < 0.25;
      events.push(worked
        ? { kind: 'worked', from: E.fmtDT(a), to: E.fmtDT(b), desc: 'work' }
        : { kind: 'exception', from: E.fmtDT(a), to: E.fmtDT(b), desc: 'exc', countPct: pick([0, 0, 0, 50, 25, 80, 100]), alsoOnDemurrage: rand() < 0.4 });
    }
    ports.push({
      name: 'P' + i, allowed: { type: 'fixed', minutes: int(0, 7 * DAY) }, calendar: cal,
      nor: { rule: 'manual', manualStart: E.fmtDT(S) }, completed: E.fmtDT(En), events,
    });
  }
  return { demurrageRate: 10000, laytimeMode: mode, onceOnDemurrage: rand() < 0.6, despatchBasis: pick(['WTS', 'ATS']), ports };
}

module.exports = { rng, randomFixture };
