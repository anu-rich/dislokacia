/*! Stalia — reading documents: how a reader's answer becomes a calculation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./model.js'), require('./schema.js'));
  else root.StaliaExtract = factory(root.StaliaEngine, root.StaliaModel, root.StaliaSchema);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, M, S) {
  'use strict';
  const { SCHEMA, FIELD_CODES, EVENT_TYPES, STATUSES, blankExtraction, blankExtractionPort, shapeError } = S;

  /**
   * What a note can be about: the label shown to the user (a key of the interface strings), the form field
   * it points at, and whether it belongs to the charter party terms or to the statement of facts.
   */
  const FIELDS = {
    vessel: { label: 'f.vessel', path: () => 'meta.vessel', group: 'fixture', meta: 'vessel' },
    voyage: { label: 'f.voyage', path: () => 'meta.voyage', group: 'fixture', meta: 'voyage' },
    cp_form: { label: 'f.cpForm', path: () => 'meta.cpForm', group: 'fixture', meta: 'cpForm' },
    cp_date: { label: 'f.cpDate', path: () => 'meta.cpDate', group: 'fixture', meta: 'cpDate' },
    owners: { label: 'f.owners', path: () => 'meta.owners', group: 'fixture', meta: 'owners' },
    charterers: { label: 'f.charterers', path: () => 'meta.charterers', group: 'fixture', meta: 'charterers' },
    cargo: { label: 'f.cargo', path: () => 'meta.cargo', group: 'fixture', meta: 'cargo' },
    currency: { label: 't.currency', path: () => 'currency', group: 'terms' },
    demurrage_rate: { label: 't.demRate', path: () => 'demurrageRate', group: 'terms' },
    despatch: { label: 't.despatch', path: () => 'despatchMode', group: 'terms' },
    despatch_basis: { label: 't.basis', path: () => 'despatchBasis', group: 'terms' },
    commission: { label: 't.commission', path: () => 'commissionPct', group: 'terms' },
    laytime_between_ports: { label: 't.mode', path: () => 'laytimeMode', group: 'terms' },
    exceptions_on_demurrage: { label: 't.once', path: () => 'onceOnDemurrage', group: 'terms' },
    delay_rules: { label: 't.rules', path: () => 'rules', group: 'terms' },
    port: { label: 'p.name', path: (i) => 'ports.' + i + '.name', group: 'facts', perPort: true },
    laytime_allowed: { label: 'a.title', path: (i, p) => 'ports.' + i + '.allowed.' + (p && p.allowed.type === 'rate' ? 'quantity' : 'days'), group: 'terms', perPort: true },
    working_time: { label: 'c.preset', path: (i) => 'ports.' + i + '.calendar.preset', group: 'terms', perPort: true },
    holidays: { label: 'c.holidays', path: (i) => 'ports.' + i + '.calendar.preset', group: 'facts', perPort: true },
    work_in_excepted_time: { label: 'c.uu', path: (i, p) => 'ports.' + i + '.calendar.' + (p && p.calendar.preset !== 'SHINC' ? 'unlessUsed' : 'preset'), group: 'terms', perPort: true },
    notice_rule: { label: 'n.rule', path: (i) => 'ports.' + i + '.nor.rule', group: 'terms', perPort: true },
    office_hours: { label: 'n.office', path: (i) => 'ports.' + i + '.nor.officeHours.enabled', group: 'terms', perPort: true },
    nor_tendered: { label: 'n.tendered', path: (i) => 'ports.' + i + '.nor.tendered', group: 'facts', perPort: true },
    operations_commenced: { label: 'n.commenced', path: (i) => 'ports.' + i + '.commenced', group: 'facts', perPort: true },
    operations_completed: { label: 'n.completed', path: (i) => 'ports.' + i + '.completed', group: 'facts', perPort: true },
    events: { label: 'e.title', path: (i) => 'ports.' + i + '.name', group: 'facts', perPort: true },
    other: { label: '', path: () => '', group: 'other' },
  };

  // ---------------------------------------------------------------- small converters
  const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 160);
  /** "14,500.00", "USD 14 500", "0,125" -> "14500", "14500", "0.125"; anything that is not a number -> "". */
  function numText(v) {
    const s = text(v, 40).replace(/[^\d.,\-\s]/g, '').trim();
    if (s === '') return '';
    const n = E.num(s);
    return isNaN(n) || n < 0 ? '' : String(Math.round(n * 1e6) / 1e6);
  }
  const dtText = (v) => { const p = E.parseDT(text(v, 30).replace(' ', 'T')); return p == null ? '' : E.fmtDT(p); };
  const dateText = (v) => dtText(text(v, 30).slice(0, 10)).slice(0, 10);
  function timeText(v) {
    let s = text(v, 10);
    if (/^\d{4}$/.test(s)) s = s.slice(0, 2) + ':' + s.slice(2);
    const m = E.timeToMin(s, null);
    if (m == null || m >= E.DAY + 1) return '';
    const h = Math.floor(m / 60) % 24, mi = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const hasFacts = (p) => !!(p.nor.tendered || p.commenced || p.completed || p.events.length);
  const firstTime = (p) => E.parseDT(p.nor.tendered || p.commenced || p.completed || '');

  // ---------------------------------------------------------------- answer -> calculation
  /**
   * @param {object} ex  the reader's answer (shape of SCHEMA)
   * @returns {{calc: object, notes: Array<{field:string, port:(number|null), status:string, comment:string}>, documents: object, empty: boolean}}
   *          `calc` is a normalised calculation; `notes[].port` is an index into calc.ports
   */
  function toCalc(ex) {
    ex = ex && typeof ex === 'object' ? ex : {};
    const fx = ex.fixture || {}, mo = ex.money || {}, lt = ex.laytime || {};
    const raw = M.blankCalc();
    raw.meta = {
      vessel: text(fx.vessel), voyage: text(fx.voyage), cpForm: text(fx.charter_party_form), cpDate: dateText(fx.charter_party_date),
      owners: text(fx.owners), charterers: text(fx.charterers), cargo: text(fx.cargo), remarks: '',
      // the charter party's own rules for the count, kept in words for the next time sheet under the same contract
      clauses: String(lt.clauses == null ? '' : lt.clauses).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000),
    };
    const cur = text(mo.currency, 3).toUpperCase();
    raw.currency = /^[A-Z]{3}$/.test(cur) ? cur : 'USD';
    raw.demurrageRate = numText(mo.demurrage_per_day);
    raw.despatchMode = mo.despatch === 'own_rate' ? 'custom' : (mo.despatch === 'none' ? 'none' : 'half');
    raw.despatchRate = numText(mo.despatch_per_day);
    if (raw.despatchMode === 'custom' && !raw.despatchRate) raw.despatchMode = 'half';
    raw.despatchBasis = mo.despatch_basis === 'all_time_saved' ? 'ATS' : 'WTS';
    raw.commissionPct = numText(mo.commission_percent);
    raw.onceOnDemurrage = lt.exceptions_apply_on_demurrage !== 'yes';
    // how the contract counts each kind of delay: decided once here, then applied by the calculator to every event of that kind
    raw.rules = (Array.isArray(lt.delay_rules) ? lt.delay_rules : []).map((r) => {
      r = r && typeof r === 'object' ? r : {};
      const pct = numText(r.counts_percent);
      return M.RULE_TYPES.indexOf(r.type) >= 0 && pct !== '' && Number(pct) <= 100 ? { type: r.type, countPct: pct, alsoOnDemurrage: r.on_demurrage === 'stops_too' } : null;
    }).filter(Boolean);

    raw.ports = (Array.isArray(ex.ports) ? ex.ports : []).slice(0, M.LIMITS.ports).map((src) => {
      src = src && typeof src === 'object' ? src : {};
      const a = src.allowed || {}, w = src.working_time || {}, n = src.notice || {};
      const p = M.blankPort(src.operation === 'discharge' ? 'discharge' : 'load');
      p.name = text(src.name, 80);

      const qty = numText(a.cargo_quantity), rate = numText(a.rate);
      const fixed = { days: numText(a.days), hours: numText(a.hours), minutes: numText(a.minutes) };
      const anyFixed = !!(fixed.days || fixed.hours || fixed.minutes);
      const type = a.basis === 'cargo_and_rate' ? 'rate' : (a.basis === 'fixed_time' ? 'fixed' : (rate && !anyFixed ? 'rate' : 'fixed'));
      p.allowed = { type, quantity: qty, rate, rateUnit: a.rate_per === 'hour' ? 'hour' : 'day', days: fixed.days, hours: fixed.hours, minutes: fixed.minutes };

      const cal = p.calendar;
      cal.preset = M.CAL_PRESETS.indexOf(w.regime) >= 0 ? w.regime : 'SHINC';
      if (cal.preset === 'CUSTOM') {
        const ft = timeText(w.custom_from_time), tt = timeText(w.custom_to_time);
        if (w.custom_from_day in DOW && w.custom_to_day in DOW && ft && tt) {
          cal.weekly = { fromDow: DOW[w.custom_from_day], fromTime: ft, toDow: DOW[w.custom_to_day], toTime: tt };
        } else cal.preset = 'SHINC'; // an unusable weekly period: the user is told through a note
      }
      cal.holidaysExcluded = w.holidays_excepted !== 'no';
      cal.holidayFromPrev = timeText(w.holiday_from_previous_day_at);
      cal.holidayToNext = timeText(w.holiday_until_next_day_at);
      cal.unlessUsed = w.work_in_excepted_time === 'counts';
      cal.holidays = (Array.isArray(w.holidays) ? w.holidays : []).map((h) => ({ date: dateText(h && h.date), name: text(h && h.name, 60) })).filter((h) => h.date);

      p.nor.tendered = dtText(n.tendered);
      if (n.rule === 'noon_rule') {
        p.nor.rule = 'gencon';
        p.nor.amStart = timeText(n.noon_rule_morning_start) || '13:00';
        p.nor.pmStart = timeText(n.noon_rule_afternoon_start) || '06:00';
      } else if (n.rule === 'next_working_day') {
        p.nor.rule = 'nextday';
        p.nor.nextDayStart = timeText(n.next_working_day_start) || '08:00';
      } else if (n.rule === 'stated_time' && dtText(n.laytime_commenced_at)) {
        p.nor.rule = 'manual';
        p.nor.manualStart = dtText(n.laytime_commenced_at);
      } else {
        p.nor.rule = 'turn';
        const h = numText(n.hours_after_notice);
        if (h !== '') p.nor.turnHours = h;
      }
      p.nor.unlessSoonerCommenced = n.unless_sooner_commenced !== 'no';
      const of = timeText(n.office_from), ot = timeText(n.office_to);
      if (n.office_hours_only === 'yes' && of && ot) p.nor.officeHours = { enabled: true, from: of, to: ot, satTo: timeText(n.office_saturday_to) };

      p.commenced = dtText(src.operations_commenced);
      p.completed = dtText(src.operations_completed);
      p.events = (Array.isArray(src.events) ? src.events : []).slice(0, M.LIMITS.events).map((e) => {
        e = e && typeof e === 'object' ? e : {};
        const tp = M.eventType(EVENT_TYPES.indexOf(e.type) >= 0 ? e.type : 'custom');
        const ev = M.blankEvent(tp.id, dtText(e.from), tp.kind === 'note' ? '' : dtText(e.to));
        ev.desc = text(e.description, 200);
        if (tp.kind === 'exception') {
          const pct = numText(e.counts_percent);
          if (pct !== '' && Number(pct) <= 100) ev.countPct = pct;
          if (e.on_demurrage === 'stops_too') ev.alsoOnDemurrage = true;
          else if (e.on_demurrage === 'keeps_running') ev.alsoOnDemurrage = false;
        }
        return ev;
      }).filter((ev) => ev.from);
      // a note that only repeats notice, commencement or completion would show that moment twice on the time sheet
      const own = [p.nor.tendered, p.commenced, p.completed].filter(Boolean);
      p.events = p.events.filter((ev) => !(ev.kind === 'note' && own.indexOf(ev.from) >= 0));
      return p;
    });

    // how the ports share laytime: stated, or the reading that fits the allowances found
    const withTime = raw.ports.filter((p) => E.allowedMinutes(p.allowed) > 0).length;
    raw.laytimeMode = ['reversible', 'separate', 'average'].indexOf(lt.between_ports) >= 0 ? lt.between_ports
      : (raw.ports.length > 1 && withTime === raw.ports.length ? 'separate' : 'reversible');

    const names = raw.ports.map((p) => p.name).filter(Boolean);
    raw.name = text([raw.meta.cargo, names.join(' — ')].filter(Boolean).join(', '), 120);

    const calc = M.normalizeCalc(raw);
    M.applyRules(calc);

    // notes: the reader's own, then anything essential that is still empty and went unmentioned
    const notes = [];
    for (const nRaw of Array.isArray(ex.notes) ? ex.notes : []) {
      const n = nRaw && typeof nRaw === 'object' ? nRaw : {};
      const field = FIELDS[n.field] ? n.field : 'other';
      const idx = Number.isInteger(n.port) && n.port >= 1 && n.port <= calc.ports.length ? n.port - 1 : null;
      notes.push({ field, port: FIELDS[field].perPort ? idx : null, status: STATUSES.indexOf(n.status) >= 0 ? n.status : 'ambiguous', comment: text(n.comment, 400) });
    }
    const mentioned = (field, port) => notes.some((n) => n.field === field && (n.port == null || port == null || n.port === port));
    const missing = (field, port) => { if (!mentioned(field, port)) notes.push({ field, port: port == null ? null : port, status: 'not_found', comment: '' }); };
    const docs = ex.documents || {};
    if (!calc.demurrageRate) missing('demurrage_rate', null);
    if (calc.ports.length > 1 && ['reversible', 'separate', 'average'].indexOf(lt.between_ports) < 0) missing('laytime_between_ports', null);
    const exPorts = Array.isArray(ex.ports) ? ex.ports : [];
    calc.ports.forEach((p, i) => {
      const src = exPorts[i] || {}, mins = E.allowedMinutes(p.allowed);
      if (isNaN(mins) || (mins <= 0 && (i === 0 || calc.laytimeMode !== 'reversible'))) missing('laytime_allowed', i);
      if (M.CAL_PRESETS.indexOf((src.working_time || {}).regime) < 0) missing('working_time', i);
      const rule = (src.notice || {}).rule;
      if ((rule !== 'hours_after_notice' && rule !== 'noon_rule' && rule !== 'next_working_day' && p.nor.rule !== 'manual') || (rule === 'hours_after_notice' && numText((src.notice || {}).hours_after_notice) === '')) missing('notice_rule', i);
      if (!p.nor.tendered) missing('nor_tendered', i);
      if (!p.completed) missing('operations_completed', i);
    });

    const m = calc.meta;
    return {
      calc, notes,
      documents: { cp: docs.charter_party === 'read', sof: docs.statement_of_facts === 'read' },
      // nothing usable at all: no port, no rate, no fixture detail
      empty: !exPorts.length && !calc.demurrageRate && !(m.vessel || m.cpForm || m.cpDate || m.cargo || m.owners || m.charterers),
    };
  }

  // ---------------------------------------------------------------- one document only: keep the other half
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const FACT_KEYS = ['commenced', 'completed'];

  /** Pair each incoming port with a port of the current calculation: same operation, in order. */
  function pairPorts(basePorts, incPorts) {
    const used = new Set(), pairs = [];
    incPorts.forEach((p, j) => {
      const k = basePorts.findIndex((b, i) => !used.has(i) && b.operation === p.operation);
      if (k >= 0) used.add(k);
      pairs.push({ inc: j, base: k });
    });
    return { pairs, used };
  }

  /**
   * Combine what was read with the calculation on screen.
   * @param {object} base      the current calculation
   * @param {{calc:object, notes:Array}} read   result of toCalc()
   * @param {'terms'|'facts'} keep  'terms': only a statement of facts was read — keep the charter party terms of `base`;
   *                                'facts': only a charter party was read — keep the times and events of `base`
   * @returns {{calc: object, notes: Array}}  notes re-pointed at the ports of the combined calculation
   */
  function merge(base, read, keep) {
    const inc = read.calc, out = keep === 'terms' ? clone(base) : clone(inc);
    const { pairs, used } = pairPorts(base.ports, inc.ports);
    const portOf = new Map(); // incoming port index -> the port object in the result
    const matched = new Set();

    // fixture details: what was just read wins, what it left empty stays
    for (const k of Object.keys(out.meta)) out.meta[k] = (k === 'remarks' ? base.meta[k] : inc.meta[k] || base.meta[k]) || '';
    out.name = keep === 'terms' ? (base.name || inc.name) : (inc.name || base.name);

    if (keep === 'terms') {
      const kept = [];
      out.ports.forEach((bp, i) => {
        const pair = pairs.find((x) => x.base === i);
        if (!pair) { kept.push({ port: bp, fresh: false }); return; }
        const ip = inc.ports[pair.inc];
        if (ip.name) bp.name = ip.name;
        bp.nor.tendered = ip.nor.tendered;
        if (bp.nor.rule === 'manual') bp.nor.manualStart = ip.nor.manualStart || '';
        for (const k of FACT_KEYS) bp[k] = ip[k];
        bp.events = ip.events;
        bp.calendar.holidays = ip.calendar.holidays;
        if (bp.allowed.type === 'rate' && ip.allowed.quantity) bp.allowed.quantity = ip.allowed.quantity;
        portOf.set(pair.inc, bp); matched.add(pair.inc);
        kept.push({ port: bp, fresh: true });
      });
      // ports the statement of facts covers but the calculation does not have yet: terms follow the last port
      pairs.filter((x) => x.base < 0).forEach((x) => {
        const ip = clone(inc.ports[x.inc]), last = out.ports[out.ports.length - 1];
        if (last) {
          const hol = ip.calendar.holidays;
          ip.calendar = clone(last.calendar); ip.calendar.holidays = hol;
          ip.nor = Object.assign(clone(last.nor), { tendered: ip.nor.tendered, manualStart: last.nor.rule === 'manual' ? ip.nor.manualStart : '' });
        }
        portOf.set(x.inc, ip);
        kept.push({ port: ip, fresh: true });
      });
      // a port left over from an earlier voyage would sit out of time order: it goes
      let latest = null;
      out.ports = kept.filter((x) => {
        const tm = firstTime(x.port);
        if (!x.fresh && latest != null && tm != null && tm < latest) return false;
        if (tm != null && (latest == null || tm > latest)) latest = tm;
        return true;
      }).map((x) => x.port);
      if (!out.ports.some((p) => hasFacts(p))) out.ports = kept.map((x) => x.port);
    } else {
      out.ports.forEach((ip, j) => {
        portOf.set(j, ip);
        const pair = pairs[j];
        if (pair.base < 0) return;
        const bp = base.ports[pair.base];
        if (!hasFacts(bp)) return;
        if (!ip.name) ip.name = bp.name;
        ip.nor.tendered = bp.nor.tendered;
        if (ip.nor.rule === 'manual' && !ip.nor.manualStart) ip.nor.manualStart = bp.nor.manualStart || '';
        for (const k of FACT_KEYS) ip[k] = bp[k];
        ip.events = clone(bp.events);
        if (!ip.calendar.holidays.length) ip.calendar.holidays = clone(bp.calendar.holidays);
        if (ip.allowed.type === 'rate' && !ip.allowed.quantity && bp.allowed.quantity) ip.allowed.quantity = bp.allowed.quantity;
        matched.add(j);
      });
      base.ports.forEach((bp, i) => { if (!used.has(i) && hasFacts(bp)) out.ports.push(clone(bp)); });
    }

    const calc = M.normalizeCalc(out);
    // the contract's rules for delays hold for the events that were just read as well as for those that were kept
    M.applyRules(calc);
    // notes: drop those about the half that was kept, re-point the rest
    const keptGroup = keep === 'terms' ? 'terms' : 'facts';
    const notes = [];
    for (const n of read.notes) {
      const f = FIELDS[n.field] || FIELDS.other;
      if (f.group === keptGroup && (!f.perPort || n.port == null || matched.has(n.port))) continue;
      if (f.meta && n.status === 'not_found' && calc.meta[f.meta]) continue; // the current calculation already has it
      let port = null;
      if (n.port != null) {
        const target = portOf.get(n.port);
        port = target ? calc.ports.findIndex((p) => p.id === target.id) : -1;
        if (port < 0) continue;
      }
      notes.push({ field: n.field, port, status: n.status, comment: n.comment });
    }
    return { calc, notes };
  }

  /** The form field a note points at ('' when it has none). */
  function notePath(note, calc) {
    const f = FIELDS[note.field];
    if (!f) return '';
    if (f.perPort && (note.port == null || !calc.ports[note.port])) return '';
    return f.path(note.port, f.perPort ? calc.ports[note.port] : null);
  }

  return {
    SCHEMA, FIELDS, FIELD_CODES, EVENT_TYPES, STATUSES,
    blankExtraction, blankExtractionPort, shapeError, toCalc, merge, notePath, hasFacts,
  };
});
