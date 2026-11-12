/*
 * Test helper: writes the answer a perfect reader would give for a known calculation.
 * Used to check that reading documents leads to exactly the same result as typing them in.
 */
'use strict';
const X = require('../../app/extract.js');

const DAY = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };

/** @param {object} calc a normalised calculation  @returns {object} an answer in the shape of X.SCHEMA */
function extractionOf(calc) {
  const ex = X.blankExtraction();
  ex.documents = { charter_party: 'read', statement_of_facts: 'read' };
  const m = calc.meta;
  ex.fixture = { vessel: m.vessel, voyage: m.voyage, charter_party_form: m.cpForm, charter_party_date: m.cpDate, owners: m.owners, charterers: m.charterers, cargo: m.cargo };
  ex.money = {
    currency: calc.currency, demurrage_per_day: calc.demurrageRate,
    despatch: { half: 'half_demurrage', custom: 'own_rate', none: 'none' }[calc.despatchMode],
    despatch_per_day: calc.despatchRate, despatch_basis: calc.despatchBasis === 'ATS' ? 'all_time_saved' : 'working_time_saved',
    commission_percent: calc.commissionPct,
  };
  ex.laytime = {
    between_ports: calc.laytimeMode, clauses: (calc.meta && calc.meta.clauses) || '', exceptions_apply_on_demurrage: calc.onceOnDemurrage ? 'no' : 'yes',
    delay_rules: (calc.rules || []).map((r) => ({ type: r.type, counts_percent: r.countPct, on_demurrage: r.alsoOnDemurrage ? 'stops_too' : 'keeps_running' })),
  };
  ex.ports = calc.ports.map((p) => {
    const o = X.blankExtractionPort(p.operation), c = p.calendar, n = p.nor;
    o.name = p.name;
    o.allowed = {
      basis: p.allowed.type === 'rate' ? 'cargo_and_rate' : 'fixed_time', cargo_quantity: p.allowed.quantity, rate: p.allowed.rate, rate_per: p.allowed.rateUnit,
      days: p.allowed.days, hours: p.allowed.hours, minutes: p.allowed.minutes,
    };
    o.working_time = {
      regime: c.preset,
      custom_from_day: c.preset === 'CUSTOM' ? DAY[c.weekly.fromDow] : '', custom_from_time: c.preset === 'CUSTOM' ? c.weekly.fromTime : '',
      custom_to_day: c.preset === 'CUSTOM' ? DAY[c.weekly.toDow] : '', custom_to_time: c.preset === 'CUSTOM' ? c.weekly.toTime : '',
      holidays_excepted: c.holidaysExcluded ? 'yes' : 'no', holiday_from_previous_day_at: c.holidayFromPrev, holiday_until_next_day_at: c.holidayToNext,
      work_in_excepted_time: c.unlessUsed ? 'counts' : 'does_not_count',
      holidays: c.holidays.map((h) => ({ date: h.date, name: h.name })),
    };
    o.notice = {
      tendered: n.tendered, rule: { turn: 'hours_after_notice', gencon: 'noon_rule', nextday: 'next_working_day', manual: 'stated_time' }[n.rule],
      hours_after_notice: n.rule === 'turn' ? n.turnHours : '', noon_rule_morning_start: n.rule === 'gencon' ? n.amStart : '',
      noon_rule_afternoon_start: n.rule === 'gencon' ? n.pmStart : '', next_working_day_start: n.rule === 'nextday' ? n.nextDayStart : '', laytime_commenced_at: n.rule === 'manual' ? n.manualStart : '',
      unless_sooner_commenced: n.unlessSoonerCommenced ? 'yes' : 'no',
      office_hours_only: n.officeHours.enabled ? 'yes' : 'no', office_from: n.officeHours.enabled ? n.officeHours.from : '',
      office_to: n.officeHours.enabled ? n.officeHours.to : '', office_saturday_to: n.officeHours.enabled ? n.officeHours.satTo : '',
    };
    o.operations_commenced = p.commenced;
    o.operations_completed = p.completed;
    o.events = p.events.map((e) => ({
      type: e.type === 'halfweather' ? 'weather' : (e.type === 'partial' ? 'custom' : e.type),
      from: e.from, to: e.to, description: e.desc,
      counts_percent: e.kind === 'exception' ? e.countPct : '',
      on_demurrage: e.kind === 'exception' ? (e.alsoOnDemurrage ? 'stops_too' : 'keeps_running') : 'default',
    }));
    return o;
  });
  return ex;
}

module.exports = { extractionOf };
