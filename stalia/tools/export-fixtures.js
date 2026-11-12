#!/usr/bin/env node
/*
 * Writes random voyages as Excel workbooks, each with the cells that matter and a few edits a reader might make,
 * together with what the calculation engine says the result must be after every edit.
 * tools/check-export.py opens them in LibreOffice and compares. Usage: node tools/export-fixtures.js <folder> [count]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/export.js');
const { rng, randomFixture } = require('../tests/helpers/random.js');

const DAY = 1440;
const out = process.argv[2], want = Math.max(4, +process.argv[3] || 24);
if (!out) { console.error('usage: node tools/export-fixtures.js <folder> [count]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const rand = rng(777);
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));

/** Terms the base generator does not vary: notice time, rates, despatch, laytime by cargo rate, a short pooled allowance. */
function enrich(fx, tight) {
  fx.currency = 'USD'; fx.meta = { vessel: 'MV TEST' };
  if (tight) { fx.laytimeMode = 'reversible'; fx.ports.forEach((p) => { p.allowed.minutes = int(0, DAY - 1); }); }
  fx.despatchMode = pick(['half', 'half', 'custom', 'none']);
  if (fx.despatchMode === 'custom') fx.despatchRate = pick([3000, 4500.5, 8000]);
  fx.commissionPct = pick([0, 0, 1.25, 2.5, 3.75]);
  if (rand() < 0.4) fx.demurrageAtNextPort = 'laytimeStart';
  fx.ports.forEach((p) => {
    if (rand() < 0.5) {
      const hours = pick([6, 12, 24, 30]);
      p.nor = { rule: 'turn', tendered: E.fmtDT(E.parseDT(p.nor.manualStart) - hours * 60), turnHours: hours, unlessSoonerCommenced: false };
    }
    if (rand() < 0.3) {
      const hour = rand() < 0.5;
      p.allowed = { type: 'rate', quantity: p.allowed.minutes * 5, rate: hour ? 300 : 7200, rateUnit: hour ? 'hour' : 'day' };
    }
  });
  return fx;
}
function expected(calc) {
  const r = E.compute(calc);
  if (!r.ok) throw new Error('fixture does not compute');
  const t = r.totals;
  return {
    allowed: t.allowedMin / DAY, used: t.usedMin / DAY, dem: t.demMin / DAY, des: t.desMin / DAY,
    demurrage: t.demurrage, commission: -t.commission, despatch: -t.despatch, amount: Math.abs(t.net),
    ports: r.ports.map((p) => ({ counted: p.usedMin / DAY, dem: p.demMin / DAY })),
  };
}

const kinds = { ats: 0, notice: 0, average: 0, other: 0 }, each = Math.ceil(want / 4);
let made = 0;
for (let n = 0; made < want && n < 5000; n++) {
  const calc = enrich(randomFixture(rand), n % 3 === 0), r = E.compute(calc);
  if (!r.ok) continue;
  const t = r.totals;
  const kind = t.basis === 'ATS' && t.savedATSMin > t.savedWTSMin + 1 ? 'ats'
    : r.ports.some((p) => p.arrivedOnDemurrage && p.norRaw != null && p.start === p.norRaw) ? 'notice'
      : t.mode === 'average' && calc.ports.length > 1 ? 'average' : 'other';
  if (kinds[kind] >= each) continue;
  kinds[kind]++; made++;
  const opts = { today: '2026-11-12' }, model = X.xlsxModel(calc, r, 'en', opts), cells = model.cells;
  const job = { kind, refs: model.refs, asIs: expected(calc), edits: [] };
  const minutesOf = (row) => Math.round((cells['D' + row].v - cells['C' + row].v) * DAY);

  // 1. laytime allowed (or the cargo quantity behind it) changes at every port
  const c1 = JSON.parse(JSON.stringify(calc)), set = [];
  c1.ports.forEach((p, i) => {
    const minutes = int(0, Math.round(r.ports[i].allowedMin) + Math.floor((7 * DAY) / c1.ports.length)), P = model.refs.ports[i];
    if (p.allowed.type === 'rate') { p.allowed.quantity = minutes * 5; set.push([P.quantity, minutes * 5]); }
    else { p.allowed = { type: 'fixed', minutes }; set.push([P.allowed, minutes / DAY]); }
  });
  job.edits.push({ name: 'allowance', set, expect: expected(c1) });

  // 2. a period is split by inserting a row below it; then the new half is made not to count at all
  const k = int(0, calc.ports.length - 1), P = model.refs.ports[k], long = [];
  for (let row = P.first; row <= P.last; row++) if (minutesOf(row) >= 2) long.push(row);
  if (long.length) {
    const row = pick(long), len = minutesOf(row), cut = int(1, len - 1);
    const start = Math.round((cells['A' + row].v - 25569) * DAY + cells['C' + row].v * DAY);
    const c2 = JSON.parse(JSON.stringify(calc));
    c2.ports[k].events.push({ kind: 'exception', from: E.fmtDT(start + cut), to: E.fmtDT(start + len), desc: 'inserted', countPct: 0, alsoOnDemurrage: true });
    job.edits.push({ name: 'insert', row, at: cells['C' + row].v + cut / DAY, pure: expected(calc), expect: expected(c2) });
  }

  // 3. a row inserted above the first period of a port, its formulas copied from the row below
  const top = pick(model.refs.ports).first;
  if (minutesOf(top) >= 2) job.edits.push({ name: 'top', row: top, at: cells['C' + top].v + int(1, minutesOf(top) - 1) / DAY, pure: expected(calc) });

  fs.writeFileSync(path.join(out, made + '.xlsx'), X.xlsx(calc, r, 'en', opts));
  fs.writeFileSync(path.join(out, made + '.json'), JSON.stringify(job));
}
console.log('workbooks written: ' + made + ' ' + JSON.stringify(kinds));
