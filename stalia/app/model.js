/*! Stalia — calculation model: defaults, presets, input clean-up, built-in examples. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./i18n.js'));
  else root.StaliaModel = factory(root.StaliaEngine, root.StaliaI18n);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, I) {
  'use strict';

  const VERSION = 1;
  const CAL_PRESETS = ['SHINC', 'SHEX', 'SSHEX', 'SATNOON', 'FRI17', 'FHEX', 'FSHEX', 'CUSTOM'];
  const CURRENCIES = ['USD', 'EUR', 'GBP', 'KZT', 'RUB', 'AED', 'TRY', 'CNY'];
  const LIMITS = { ports: 12, events: 200, holidays: 60 };

  /** SOF event types: what each one does to the clock by default. */
  const EVENT_TYPES = [
    { id: 'weather', kind: 'exception', pct: 0, dem: false },
    { id: 'shifting', kind: 'exception', pct: 0, dem: false },
    { id: 'awaiting', kind: 'exception', pct: 0, dem: false },
    { id: 'breakdown', kind: 'exception', pct: 0, dem: true },
    { id: 'owner', kind: 'exception', pct: 0, dem: true },
    { id: 'survey', kind: 'exception', pct: 0, dem: false },
    { id: 'strike', kind: 'exception', pct: 0, dem: false },
    { id: 'halfweather', kind: 'exception', pct: 50, dem: true },
    { id: 'partial', kind: 'exception', pct: 50, dem: false },
    { id: 'worked', kind: 'worked', pct: 100, dem: false },
    { id: 'note', kind: 'note', pct: 100, dem: false },
    { id: 'custom', kind: 'exception', pct: 0, dem: false },
  ];
  const eventType = (id) => EVENT_TYPES.find((x) => x.id === id) || EVENT_TYPES[EVENT_TYPES.length - 1];

  let seq = 0;
  const uid = (p) => (p || 'x') + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  function blankCalendar() {
    return {
      preset: 'SHINC', weekly: { fromDow: 6, fromTime: '12:00', toDow: 1, toTime: '08:00' },
      holidaysExcluded: true, holidays: [], holidayFromPrev: '', holidayToNext: '', unlessUsed: false,
    };
  }
  function blankPort(operation) {
    return {
      id: uid('p'), name: '', operation: operation || 'load',
      allowed: { type: 'fixed', quantity: '', rate: '', rateUnit: 'day', days: '', hours: '', minutes: '' },
      calendar: blankCalendar(),
      nor: {
        tendered: '', rule: 'turn', turnHours: '6', amStart: '13:00', pmStart: '06:00', manualStart: '',
        unlessSoonerCommenced: true, officeHours: { enabled: false, from: '08:00', to: '17:00', satTo: '12:00' },
      },
      commenced: '', completed: '', events: [],
    };
  }
  function blankCalc() {
    return {
      v: VERSION, name: '',
      meta: { vessel: '', voyage: '', cpForm: '', cpDate: '', owners: '', charterers: '', cargo: '', remarks: '' },
      currency: 'USD', demurrageRate: '', despatchMode: 'half', despatchRate: '', despatchBasis: 'WTS',
      commissionPct: '', laytimeMode: 'reversible', onceOnDemurrage: true, demurrageAtNextPort: 'nor',
      ports: [blankPort('load'), blankPort('discharge')],
    };
  }
  function blankEvent(typeId, from, to) {
    const tp = eventType(typeId || 'weather');
    return { id: uid('e'), type: tp.id, kind: tp.kind, from: from || '', to: to || '', desc: '', countPct: String(tp.pct), alsoOnDemurrage: tp.dem };
  }

  // ---------------------------------------------------------------- clean-up of untrusted input
  const str = (v, max) => (v == null ? '' : String(v)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max || 160);
  const oneOf = (v, list, dflt) => (list.indexOf(v) >= 0 ? v : dflt);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  const dtStr = (v) => { const p = E.parseDT(v); return p == null ? '' : E.fmtDT(p); };
  const dateStr = (v) => dtStr(v).slice(0, 10);
  const timeStr = (v, dflt) => {
    const m = E.timeToMin(v, null);
    if (m == null) return dflt;
    return (m >= 600 ? '' : '0') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60);
  };
  const numStr = (v, max) => { const s = str(v, max || 24).trim(); return s === '' || isNaN(E.num(s)) ? '' : s; };
  const dowNum = (v, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 6 ? n : dflt; };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);

  /**
   * Turn anything (a shared link, an imported file, an old saved calculation) into a
   * well-formed calculation. Unknown fields are dropped, every value is type-checked.
   */
  function normalizeCalc(input) {
    const src = obj(input), b = blankCalc(), m = obj(src.meta);
    const out = {
      v: VERSION,
      name: str(src.name, 120),
      meta: {
        vessel: str(m.vessel), voyage: str(m.voyage), cpForm: str(m.cpForm), cpDate: dateStr(m.cpDate),
        owners: str(m.owners), charterers: str(m.charterers), cargo: str(m.cargo), remarks: str(m.remarks, 2000),
      },
      currency: (/^[A-Za-z]{3}$/.test(src.currency || '') ? String(src.currency).toUpperCase() : b.currency),
      demurrageRate: numStr(src.demurrageRate),
      despatchMode: oneOf(src.despatchMode, ['half', 'custom', 'none'], 'half'),
      despatchRate: numStr(src.despatchRate),
      despatchBasis: oneOf(src.despatchBasis, ['WTS', 'ATS'], 'WTS'),
      commissionPct: numStr(src.commissionPct),
      laytimeMode: oneOf(src.laytimeMode, ['reversible', 'separate', 'average'], 'reversible'),
      onceOnDemurrage: bool(src.onceOnDemurrage, true),
      demurrageAtNextPort: oneOf(src.demurrageAtNextPort, ['nor', 'laytimeStart'], 'nor'),
      ports: [],
    };
    for (const pRaw of arr(src.ports).slice(0, LIMITS.ports)) {
      const p = obj(pRaw), bp = blankPort(), a = obj(p.allowed), c = obj(p.calendar), n = obj(p.nor), oh = obj(n.officeHours), w = obj(c.weekly);
      const port = {
        id: /^[\w-]{1,40}$/.test(p.id || '') ? p.id : uid('p'),
        name: str(p.name, 80),
        operation: oneOf(p.operation, ['load', 'discharge'], 'load'),
        allowed: {
          type: oneOf(a.type, ['rate', 'fixed'], 'fixed'),
          quantity: numStr(a.quantity), rate: numStr(a.rate), rateUnit: oneOf(a.rateUnit, ['day', 'hour'], 'day'),
          days: numStr(a.days), hours: numStr(a.hours), minutes: numStr(a.minutes),
        },
        calendar: {
          preset: oneOf(c.preset, CAL_PRESETS, 'SHINC'),
          weekly: {
            fromDow: dowNum(w.fromDow, bp.calendar.weekly.fromDow), fromTime: timeStr(w.fromTime, bp.calendar.weekly.fromTime),
            toDow: dowNum(w.toDow, bp.calendar.weekly.toDow), toTime: timeStr(w.toTime, bp.calendar.weekly.toTime),
          },
          holidaysExcluded: bool(c.holidaysExcluded, true),
          holidays: arr(c.holidays).slice(0, LIMITS.holidays).map((h) => ({ date: dateStr(obj(h).date), name: str(obj(h).name, 60) })),
          holidayFromPrev: timeStr(c.holidayFromPrev, ''), holidayToNext: timeStr(c.holidayToNext, ''),
          unlessUsed: bool(c.unlessUsed, false),
        },
        nor: {
          tendered: dtStr(n.tendered),
          rule: oneOf(n.rule, ['turn', 'gencon', 'manual'], 'turn'),
          turnHours: numStr(n.turnHours === 0 ? '0' : n.turnHours) || (n.turnHours === '' ? '' : bp.nor.turnHours),
          amStart: timeStr(n.amStart, bp.nor.amStart), pmStart: timeStr(n.pmStart, bp.nor.pmStart),
          manualStart: dtStr(n.manualStart),
          unlessSoonerCommenced: bool(n.unlessSoonerCommenced, true),
          officeHours: {
            enabled: bool(oh.enabled, false), from: timeStr(oh.from, '08:00'), to: timeStr(oh.to, '17:00'), satTo: timeStr(oh.satTo, ''),
          },
        },
        commenced: dtStr(p.commenced), completed: dtStr(p.completed),
        events: [],
      };
      for (const eRaw of arr(p.events).slice(0, LIMITS.events)) {
        const e = obj(eRaw);
        const tp = eventType(e.type);
        const kind = oneOf(e.kind, ['exception', 'worked', 'note'], tp.kind);
        port.events.push({
          id: /^[\w-]{1,40}$/.test(e.id || '') ? e.id : uid('e'),
          type: tp.id, kind,
          from: dtStr(e.from), to: dtStr(e.to), desc: str(e.desc, 200),
          countPct: kind === 'exception' ? (numStr(e.countPct === 0 ? '0' : e.countPct) || '0') : '100',
          alsoOnDemurrage: kind === 'exception' ? bool(e.alsoOnDemurrage, tp.dem) : false,
        });
      }
      out.ports.push(port);
    }
    if (!out.ports.length) out.ports = b.ports;
    return out;
  }

  // ---------------------------------------------------------------- examples

  /** Built-in example calculations (made-up fixtures) in the given language. */
  function examples(lang) {
    const x = I.examplesText(lang);
    const P = (o) => Object.assign(blankPort(o.operation), o);
    const C = (o) => Object.assign(blankCalendar(), o);
    const N = (o) => Object.assign(blankPort().nor, o);
    const ev = (type, from, to, desc, over) => Object.assign(blankEvent(type, from, to), { desc }, over || {});
    const list = [
      {
        id: 'bulk', title: x.bulkName,
        calc: {
          name: x.bulkName,
          meta: { vessel: 'MV EXAMPLE TRADER', voyage: 'V.014', cpForm: 'Gencon 1994', cpDate: '2026-02-20', owners: x.owners, charterers: x.charterers, cargo: x.bulkCargo, remarks: '' },
          currency: 'USD', demurrageRate: '14500', despatchMode: 'half', despatchBasis: 'WTS', commissionPct: '3.75',
          laytimeMode: 'separate', onceOnDemurrage: true,
          ports: [
            P({
              name: 'Novorossiysk', operation: 'load',
              allowed: { type: 'rate', quantity: '27500', rate: '8000', rateUnit: 'day', days: '', hours: '', minutes: '' },
              calendar: C({ preset: 'SSHEX', unlessUsed: true }),
              nor: N({ tendered: '2026-03-06T09:00', rule: 'gencon', amStart: '13:00', pmStart: '08:00', officeHours: { enabled: true, from: '08:00', to: '17:00', satTo: '12:00' } }),
              commenced: '2026-03-06T14:10', completed: '2026-03-11T21:00',
              events: [
                ev('note', '2026-03-06T14:00', '', x.draft),
                ev('worked', '2026-03-07T08:00', '2026-03-07T20:00', x.satWork),
                ev('weather', '2026-03-09T10:00', '2026-03-09T14:30', x.rain),
              ],
            }),
            P({
              name: 'Alexandria', operation: 'discharge',
              allowed: { type: 'rate', quantity: '27500', rate: '5000', rateUnit: 'day', days: '', hours: '', minutes: '' },
              calendar: C({ preset: 'FHEX', unlessUsed: false, holidays: [{ date: '2026-03-21', name: x.holiday }] }),
              nor: N({ tendered: '2026-03-15T10:00', rule: 'gencon', amStart: '13:00', pmStart: '08:00' }),
              commenced: '2026-03-16T09:30', completed: '2026-03-24T18:00',
              events: [
                ev('shifting', '2026-03-16T06:00', '2026-03-16T09:00', x.shift),
                ev('breakdown', '2026-03-18T14:00', '2026-03-18T16:00', x.crane),
              ],
            }),
          ],
        },
      },
      {
        id: 'tanker', title: x.tankName,
        calc: {
          name: x.tankName,
          meta: { vessel: 'MT EXAMPLE SPIRIT', voyage: 'V.027', cpForm: 'Asbatankvoy', cpDate: '2026-03-18', owners: x.owners, charterers: x.charterers, cargo: x.tankCargo, remarks: '' },
          currency: 'USD', demurrageRate: '32000', despatchMode: 'none', commissionPct: '2.5',
          laytimeMode: 'reversible', onceOnDemurrage: true, demurrageAtNextPort: 'nor',
          ports: [
            P({
              name: 'Ceyhan', operation: 'load',
              allowed: { type: 'fixed', quantity: '', rate: '', rateUnit: 'day', days: '', hours: '72', minutes: '' },
              calendar: C({ preset: 'SHINC' }),
              nor: N({ tendered: '2026-04-02T03:00', rule: 'turn', turnHours: '6' }),
              commenced: '2026-04-03T14:20', completed: '2026-04-04T16:40',
              events: [
                ev('shifting', '2026-04-03T11:30', '2026-04-03T14:20', x.shiftPilot),
                ev('note', '2026-04-03T15:40', '', x.hosesOn),
              ],
            }),
            P({
              name: 'Trieste', operation: 'discharge',
              allowed: { type: 'fixed', quantity: '', rate: '', rateUnit: 'day', days: '', hours: '0', minutes: '' },
              calendar: C({ preset: 'SHINC' }),
              nor: N({ tendered: '2026-04-09T08:00', rule: 'turn', turnHours: '6' }),
              commenced: '2026-04-09T12:30', completed: '2026-04-10T22:10',
              events: [ev('breakdown', '2026-04-10T02:00', '2026-04-10T03:30', x.pump)],
            }),
          ],
        },
      },
      {
        id: 'caspian', title: x.caspName,
        calc: {
          name: x.caspName,
          meta: { vessel: 'MT EXAMPLE CASPIAN', voyage: 'V.103', cpForm: 'Tanker voyage C/P', cpDate: '2026-02-02', owners: x.owners, charterers: x.charterers, cargo: x.caspCargo, remarks: '' },
          currency: 'USD', demurrageRate: '9000', despatchMode: 'none', commissionPct: '',
          laytimeMode: 'separate', onceOnDemurrage: true,
          ports: [
            P({
              name: 'Aktau', operation: 'load',
              allowed: { type: 'fixed', quantity: '', rate: '', rateUnit: 'day', days: '', hours: '36', minutes: '' },
              calendar: C({ preset: 'SHINC' }),
              nor: N({ tendered: '2026-02-10T07:00', rule: 'turn', turnHours: '6' }),
              commenced: '2026-02-11T03:40', completed: '2026-02-12T19:10',
              events: [ev('weather', '2026-02-11T16:00', '2026-02-12T06:30', x.storm)],
            }),
            P({
              name: 'Baku', operation: 'discharge',
              allowed: { type: 'fixed', quantity: '', rate: '', rateUnit: 'day', days: '', hours: '36', minutes: '' },
              calendar: C({ preset: 'SHINC' }),
              nor: N({ tendered: '2026-02-13T22:00', rule: 'turn', turnHours: '6' }),
              commenced: '2026-02-14T02:15', completed: '2026-02-15T09:45',
              events: [ev('note', '2026-02-14T03:00', '', x.sampling)],
            }),
          ],
        },
      },
    ];
    list.forEach((e) => { e.calc = normalizeCalc(e.calc); });
    return list;
  }

  return { VERSION, CAL_PRESETS, CURRENCIES, EVENT_TYPES, LIMITS, eventType, uid, blankCalc, blankPort, blankEvent, blankCalendar, normalizeCalc, examples };
});
