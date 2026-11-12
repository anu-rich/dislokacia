/*!
 * Stalia — laytime & demurrage calculation engine.
 * Pure functions, no DOM. Browser: window.StaliaEngine. Node: require('./engine.js').
 *
 * All date-times are "port local time" strings 'YYYY-MM-DDTHH:MM'. They are handled as
 * naive minutes (no time zones, no DST) — exactly how a time sheet is written.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaliaEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 1440;
  const EPS = 1e-7;

  // ---------------------------------------------------------------- time helpers
  const pad = (n) => (n < 10 ? '0' : '') + n;

  /** 'YYYY-MM-DDTHH:MM' (or with a space, or date only) -> minutes since epoch, or null. */
  function parseDT(s) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return isFinite(s) ? s : null;
    const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*$/.exec(String(s));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const h = m[4] == null ? 0 : +m[4], mi = m[5] == null ? 0 : +m[5];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59) return null;
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null; // e.g. 30 Feb
    return Math.round(Date.UTC(y, mo - 1, d, h, mi) / 60000);
  }

  /** minutes -> 'YYYY-MM-DDTHH:MM' (rounded to the minute). */
  function fmtDT(min) {
    if (min == null || !isFinite(min)) return '';
    const d = new Date(Math.round(min) * 60000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  /** 'HH:MM' -> minutes of day (0..1440), or dflt. */
  function timeToMin(s, dflt) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s == null ? '' : s));
    if (!m) return dflt;
    const v = +m[1] * 60 + +m[2];
    return v >= 0 && v <= DAY && +m[2] < 60 ? v : dflt;
  }

  const startOfDay = (min) => Math.floor(min / DAY) * DAY;
  /** Day of week, 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
  const dow = (min) => (((Math.floor(min / DAY) % 7) + 11) % 7);

  /** minutes -> {d,h,m,neg} rounded to the nearest minute. */
  function splitDur(min) {
    const neg = min < 0;
    let t = Math.round(Math.abs(min || 0));
    const d = Math.floor(t / DAY); t -= d * DAY;
    const h = Math.floor(t / 60); t -= h * 60;
    return { d, h, m: t, neg };
  }

  /**
   * Parse a number typed by a human: "14,500" / "14 500" / "14'500" (thousands), "14500.50",
   * "14500,5" and "0,125" (decimal comma), "1.250.000,75" and "1,250,000.75".
   */
  const num = (v) => {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v == null) return NaN;
    let s = String(v).trim().replace(/[\s\u00A0\u2009\u202F'’_]/g, '');
    if (s === '' || !/^[+-]?[\d.,]+$/.test(s)) return NaN;
    const hasC = s.indexOf(',') >= 0, hasD = s.indexOf('.') >= 0;
    if (hasC && hasD) {
      // the right-most separator is the decimal one
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasC) {
      if (/^[+-]?[1-9]\d{0,2}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');      // 14,500 -> 14500
      else if ((s.match(/,/g) || []).length === 1) s = s.replace(',', '.');      // 14,5 -> 14.5
      else return NaN;
    } else if (hasD && (s.match(/\./g) || []).length > 1) {
      if (/^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');           // 1.250.000
      else return NaN;
    }
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  };
  /**
   * Money to the cent. Halves go away from zero for a negative amount as for a positive one, and the number is
   * rounded as it is written with 15 digits — 39553.125 becomes 39553.13 even when it is stored a hair below.
   * This is also how a spreadsheet rounds, so an exported sheet recalculates to the same cents.
   */
  const round2 = (v) => {
    if (!isFinite(v)) return v;
    const x = Math.round(Number((Math.abs(v) * 100).toPrecision(15))) / 100;
    return v < 0 ? -x : x;
  };

  /** Minutes to six decimals. */
  const snapMinutes = (v) => (isFinite(v) ? Math.round(Number((v * 1e6).toPrecision(15))) / 1e6 : v);

  // ---------------------------------------------------------------- calendar
  /**
   * Working-time presets. `weekly` is the weekly period that does NOT count as laytime.
   * dow: 0 = Sunday … 6 = Saturday.
   */
  const CALENDAR_PRESETS = {
    SHINC: { weekly: null, holidaysExcluded: false },
    SHEX: { weekly: { fromDow: 0, fromTime: '00:00', toDow: 1, toTime: '00:00' }, holidaysExcluded: true },
    SSHEX: { weekly: { fromDow: 6, fromTime: '00:00', toDow: 1, toTime: '00:00' }, holidaysExcluded: true },
    SATNOON: { weekly: { fromDow: 6, fromTime: '12:00', toDow: 1, toTime: '08:00' }, holidaysExcluded: true },
    FRI17: { weekly: { fromDow: 5, fromTime: '17:00', toDow: 1, toTime: '08:00' }, holidaysExcluded: true },
    FHEX: { weekly: { fromDow: 5, fromTime: '00:00', toDow: 6, toTime: '00:00' }, holidaysExcluded: true },
    FSHEX: { weekly: { fromDow: 5, fromTime: '00:00', toDow: 0, toTime: '00:00' }, holidaysExcluded: true },
    TFHEX: { weekly: { fromDow: 4, fromTime: '12:00', toDow: 6, toTime: '08:00' }, holidaysExcluded: true },
  };

  /** Normalise a calendar object (resolving `preset` unless it is CUSTOM). */
  function resolveCalendar(cal) {
    cal = cal || {};
    const p = cal.preset && cal.preset !== 'CUSTOM' ? CALENDAR_PRESETS[cal.preset] : null;
    return {
      preset: cal.preset || (p ? cal.preset : 'CUSTOM'),
      weekly: p ? p.weekly : (cal.weekly || null),
      holidaysExcluded: p ? p.holidaysExcluded : !!cal.holidaysExcluded,
      holidays: Array.isArray(cal.holidays) ? cal.holidays : [],
      holidayFromPrev: cal.holidayFromPrev || '',
      holidayToNext: cal.holidayToNext || '',
      unlessUsed: !!cal.unlessUsed,
    };
  }

  /** Periods excluded by the calendar that intersect [from, to]. Not merged; sorted by start. */
  function calendarWindows(cal, from, to) {
    const out = [];
    if (!cal) return out;
    const w = cal.weekly;
    if (w && w.fromDow != null && w.toDow != null) {
      const s = (+w.fromDow) * DAY + timeToMin(w.fromTime, 0);
      let e = (+w.toDow) * DAY + timeToMin(w.toTime, 0);
      if (e <= s) e += 7 * DAY;
      if (e - s < 7 * DAY) {
        let base = startOfDay(from) - dow(from) * DAY - 14 * DAY;
        for (; base <= to; base += 7 * DAY) {
          const a = base + s, b = base + e;
          if (b > from && a < to) out.push({ from: a, to: b, code: 'weekend' });
        }
      }
    }
    if (cal.holidaysExcluded && cal.holidays && cal.holidays.length) {
      const lead = cal.holidayFromPrev ? DAY - timeToMin(cal.holidayFromPrev, DAY) : 0;
      const tail = cal.holidayToNext ? timeToMin(cal.holidayToNext, 0) : 0;
      for (const h of cal.holidays) {
        const p = parseDT(h && h.date);
        if (p == null) continue;
        const d0 = startOfDay(p);
        const a = d0 - lead, b = d0 + DAY + tail;
        if (b > from && a < to) out.push({ from: a, to: b, code: 'holiday', name: (h.name || '').trim() });
      }
    }
    out.sort((x, y) => x.from - y.from || x.to - y.to);
    return out;
  }

  function mergeWindows(wins) {
    const out = [];
    for (const w of wins.slice().sort((a, b) => a.from - b.from)) {
      const last = out[out.length - 1];
      if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
      else out.push({ from: w.from, to: w.to });
    }
    return out;
  }

  const inWindows = (wins, t) => wins.some((w) => w.from <= t && t < w.to);

  /**
   * When would `remaining` minutes of laytime run out if counting started at `from`
   * and only the calendar (weekends/holidays) interrupted it? Used for "all time saved".
   */
  function projectExpiry(cal, from, remaining) {
    if (!(remaining > EPS)) return from;
    let t = from, rem = remaining;
    for (let guard = 0; guard < 60; guard++) {
      const horizon = t + rem * 3 + 30 * DAY;
      const wins = mergeWindows(calendarWindows(cal, t, horizon));
      for (const w of wins) {
        if (w.to <= t) continue;
        if (w.from > t) {
          const avail = w.from - t;
          if (avail >= rem - EPS) return t + rem;
          rem -= avail;
        }
        t = Math.max(t, w.to);
      }
      if (t < horizon) {
        const avail = horizon - t;
        if (avail >= rem - EPS) return t + rem;
        rem -= avail;
        t = horizon;
      }
    }
    return t + rem;
  }

  // ---------------------------------------------------------------- allowed time
  /** Laytime allowed at a port, in minutes (NaN if the input is invalid). */
  function allowedMinutes(a) {
    if (!a) return NaN;
    if (a.type === 'rate') {
      const q = num(a.quantity), r = num(a.rate);
      if (!(q >= 0) || !(r > 0)) return NaN;
      return (q / r) * (a.rateUnit === 'hour' ? 60 : DAY);
    }
    const d = a.days === '' || a.days == null ? 0 : num(a.days);
    const h = a.hours === '' || a.hours == null ? 0 : num(a.hours);
    const m = a.minutes === '' || a.minutes == null ? 0 : num(a.minutes);
    const v = d * DAY + h * 60 + m;
    return v >= 0 ? v : NaN;
  }

  // ---------------------------------------------------------------- NOR / commencement
  /** NOR tendered outside office hours is deemed tendered at the next opening of office hours. */
  function norInOfficeHours(t, oh, cal) {
    if (!oh || !oh.enabled) return t;
    const from = timeToMin(oh.from, 8 * 60), to = timeToMin(oh.to, 17 * 60);
    const satTo = oh.satTo ? timeToMin(oh.satTo, to) : null;
    const wins = calendarWindows(cal, t - 2 * DAY, t + 75 * DAY);
    const d0 = startOfDay(t);
    for (let i = 0; i < 70; i++) {
      const day = d0 + i * DAY;
      const open = day + from;
      const close = day + (satTo != null && dow(day) === 6 ? satTo : to);
      if (close <= open) continue;
      if (inWindows(wins, open)) continue; // not a working day at opening time
      if (i === 0) {
        if (t <= open) return open;
        if (t <= close) return t;
        continue;
      }
      return open;
    }
    return t;
  }

  /**
   * Laytime commencement for a port.
   * nor.rule: 'turn'   — N hours after NOR (turn / notice time)
   *           'gencon' — NOR up to noon -> starts `amStart` same day; after noon -> `pmStart` next working day
 *           'nextday' — at `nextDayStart` on the first working day after the day of the notice, whatever its hour
   *           'manual' — explicit date-time
   * unlessSoonerCommenced: if operations start before that moment, laytime starts with them.
   */
  function laytimeStart(port, cal) {
    const nor = port.nor || {};
    const rule = nor.rule || 'turn';
    const norRaw = parseDT(nor.tendered);
    const commenced = parseDT(port.commenced);
    if (rule === 'manual') {
      const s = parseDT(nor.manualStart);
      return { start: s, norRaw, norEff: norRaw, norAdjusted: false, sooner: false, error: s == null ? 'manual_start_missing' : null };
    }
    if (norRaw == null) return { start: null, norRaw, norEff: null, error: 'nor_missing' };
    const norEff = norInOfficeHours(norRaw, nor.officeHours, cal);
    let start;
    if (rule === 'gencon') {
      const day = startOfDay(norEff);
      if (norEff <= day + 720) {
        start = Math.max(day + timeToMin(nor.amStart, 13 * 60), norEff);
      } else {
        const pm = timeToMin(nor.pmStart, 6 * 60);
        const wins = calendarWindows(cal, day, day + 75 * DAY);
        let c = day + DAY + pm;
        for (let i = 0; i < 70 && inWindows(wins, c); i++) c += DAY;
        start = c;
      }
    } else if (rule === 'nextday') {
      const day = startOfDay(norEff), at = timeToMin(nor.nextDayStart, 8 * 60);
      const wins = calendarWindows(cal, day, day + 75 * DAY);
      let c = day + DAY + at;
      for (let i = 0; i < 70 && inWindows(wins, c); i++) c += DAY;
      start = c;
    } else {
      const th = nor.turnHours === '' || nor.turnHours == null ? 0 : num(nor.turnHours);
      if (!(th >= 0)) return { start: null, norRaw, norEff, error: 'turn_invalid' };
      start = norEff + th * 60;
    }
    let sooner = false;
    if (nor.unlessSoonerCommenced !== false && commenced != null && commenced < start) {
      start = commenced;
      sooner = true;
    }
    return { start, norRaw, norEff, norAdjusted: norEff !== norRaw, sooner, error: null };
  }

  // ---------------------------------------------------------------- port preparation
  function prepPort(p, idx, errors, warnings) {
    p = p || {};
    const cal = resolveCalendar(p.calendar);
    const pp = {
      idx, id: p.id || 'p' + idx, name: p.name || '', operation: p.operation || 'load',
      cal, allowed: allowedMinutes(p.allowed), events: [], notes: [],
      commenced: parseDT(p.commenced), completed: parseDT(p.completed),
    };
    if (isNaN(pp.allowed)) errors.push({ code: 'allowed_invalid', port: idx });
    if (cal.weekly) {
      const s = (+cal.weekly.fromDow) * DAY + timeToMin(cal.weekly.fromTime, 0);
      const e = (+cal.weekly.toDow) * DAY + timeToMin(cal.weekly.toTime, 0);
      if (s === e) errors.push({ code: 'weekly_invalid', port: idx });
    }
    const ls = laytimeStart(p, cal);
    pp.norRaw = ls.norRaw; pp.norEff = ls.norEff; pp.norAdjusted = !!ls.norAdjusted; pp.sooner = !!ls.sooner;
    pp.S = ls.start; pp.E = pp.completed;
    if (ls.error) errors.push({ code: ls.error, port: idx });
    if (pp.E == null) errors.push({ code: 'completed_missing', port: idx });
    if (pp.S != null && pp.E != null && pp.E < pp.S) errors.push({ code: 'end_before_start', port: idx });
    if (pp.commenced != null && pp.E != null && pp.commenced > pp.E) warnings.push({ code: 'commenced_after_completed', port: idx });
    if (pp.commenced != null && pp.norRaw != null && pp.commenced < pp.norRaw) warnings.push({ code: 'commenced_before_nor', port: idx });

    (p.events || []).forEach((ev, j) => {
      if (!ev) return;
      const kind = ev.kind || 'exception';
      const from = parseDT(ev.from), to = parseDT(ev.to);
      const id = ev.id || 'e' + j;
      if (kind === 'note') {
        if (from != null) pp.notes.push({ id, from, to, desc: ev.desc || '', type: ev.type || 'note' });
        return;
      }
      if (from == null && to == null && !(ev.desc || '').trim()) return; // blank row
      if (from == null || to == null) { errors.push({ code: 'event_time_missing', port: idx, event: id }); return; }
      if (to <= from) { errors.push({ code: 'event_range_invalid', port: idx, event: id }); return; }
      let f = 0;
      if (kind === 'exception') {
        const pct = ev.countPct === '' || ev.countPct == null ? 0 : num(ev.countPct);
        if (!(pct >= 0 && pct <= 100)) { errors.push({ code: 'event_pct_invalid', port: idx, event: id }); return; }
        f = pct / 100;
      }
      pp.events.push({
        id, kind, from, to, f, desc: ev.desc || '', type: ev.type || 'custom',
        alsoOnDemurrage: !!ev.alsoOnDemurrage,
      });
      if (kind === 'worked' && (!cal.unlessUsed || (!cal.weekly && !cal.holidaysExcluded))) {
        warnings.push({ code: 'worked_no_effect', port: idx, event: id });
      }
      if (pp.S != null && pp.E != null && (to <= pp.S || from >= pp.E)) {
        warnings.push({ code: 'event_outside', port: idx, event: id });
      }
    });
    return pp;
  }

  // ---------------------------------------------------------------- core run
  function classify(pp, wins, t0, t1, once) {
    const calHits = [];
    for (const w of wins) if (w.from <= t0 + EPS && w.to >= t1 - EPS) calHits.push(w);
    const excHits = [];
    let worked = false;
    for (const e of pp.events) {
      if (e.from <= t0 + EPS && e.to >= t1 - EPS) {
        if (e.kind === 'worked') worked = true; else excHits.push(e);
      }
    }
    const uu = pp.cal.unlessUsed;
    const fCal = calHits.length && !(uu && worked) ? 0 : 1;
    let fExc = 1, fExcD = 1;
    for (const e of excHits) {
      fExc = Math.min(fExc, e.f);
      if (e.alsoOnDemurrage) fExcD = Math.min(fExcD, e.f);
    }
    const fL = Math.min(fCal, fExc);
    const fD = once ? fExcD : fL;

    const reasonsL = [];
    const seen = {};
    for (const w of calHits) {
      const k = w.code + '|' + (w.name || '');
      if (seen[k]) continue; seen[k] = 1;
      reasonsL.push(w.code === 'holiday' ? { code: 'holiday', name: w.name || '' } : { code: 'weekend' });
    }
    if (calHits.length && worked) reasonsL.push({ code: uu ? 'worked_counts' : 'worked_ignored' });
    for (const e of excHits) reasonsL.push({ code: 'event', id: e.id, desc: e.desc, type: e.type, pct: Math.round(e.f * 100) });

    let reasonsD;
    if (once) {
      reasonsD = excHits.filter((e) => e.alsoOnDemurrage)
        .map((e) => ({ code: 'event', id: e.id, desc: e.desc, type: e.type, pct: Math.round(e.f * 100) }));
      if (fL < fD - EPS) reasonsD.push({ code: 'exceptions_off' });
    } else reasonsD = reasonsL;
    return { fL, fD, reasonsL, reasonsD };
  }

  /** Every moment between S and E at which the way time counts may change: calendar and event boundaries. */
  function cutPoints(pp, wins, S, E) {
    const clamp = (t) => Math.min(E, Math.max(S, t));
    const set = new Set([S, E]);
    for (const w of wins) { set.add(clamp(w.from)); set.add(clamp(w.to)); }
    for (const e of pp.events) { set.add(clamp(e.from)); set.add(clamp(e.to)); }
    return Array.from(set).sort((a, b) => a - b);
  }

  /**
   * Run one port against a shared state {remaining, onDem}. Mutates state.
   * Returns the per-port result with time-sheet rows.
   */
  function runPort(pp, state, opts) {
    let S = pp.S;
    const E = pp.E;
    const arrivedOnDemurrage = state.onDem;
    if (arrivedOnDemurrage && opts.demFromNor && pp.norRaw != null && pp.norRaw < S) S = pp.norRaw;

    const wins = calendarWindows(pp.cal, S, E);
    const pts = cutPoints(pp, wins, S, E);

    const rows = [];
    let used = 0, dem = 0, expiry = arrivedOnDemurrage ? null : (state.remaining <= EPS ? S : null);
    if (!state.onDem && state.remaining <= EPS) { state.remaining = 0; state.onDem = true; }

    const push = (from, to, regime, factor, counted, reasons) => {
      const key = regime + '|' + factor + '|' + JSON.stringify(reasons);
      const last = rows[rows.length - 1];
      if (last && last.key === key && Math.abs(last.to - from) < EPS) {
        last.to = to; last.counted += counted;
      } else {
        rows.push({ key, from, to, regime, factor, counted, reasons });
      }
      const r = rows[rows.length - 1];
      r.cumUsed = opts.usedBefore + used;
      r.remaining = state.remaining;
      r.cumDem = opts.demBefore + dem;
    };

    for (let i = 0; i + 1 < pts.length; i++) {
      const t0 = pts[i], t1 = pts[i + 1];
      if (t1 - t0 < EPS) continue;
      const c = classify(pp, wins, t0, t1, opts.once);
      if (!state.onDem) {
        const cnt = (t1 - t0) * c.fL;
        if (cnt < state.remaining - EPS) {
          state.remaining -= cnt; used += cnt;
          push(t0, t1, 'laytime', c.fL, cnt, c.reasonsL);
        } else {
          // laytime expires inside (or exactly at the end of) this segment; here c.fL > 0
          const texp = Math.min(t1, t0 + state.remaining / c.fL);
          const part = state.remaining;
          used += part; state.remaining = 0; state.onDem = true; expiry = texp;
          if (texp - t0 > EPS) push(t0, texp, 'laytime', c.fL, part, c.reasonsL);
          if (t1 - texp > EPS) {
            const d = (t1 - texp) * c.fD;
            dem += d;
            push(texp, t1, 'demurrage', c.fD, d, c.reasonsD);
          }
        }
      } else {
        const d = (t1 - t0) * c.fD;
        dem += d;
        push(t0, t1, 'demurrage', c.fD, d, c.reasonsD);
      }
    }
    rows.forEach((r) => { delete r.key; });

    let notCounted = 0;
    for (const r of rows) if (r.regime === 'laytime') notCounted += (r.to - r.from) - r.counted;

    return {
      idx: pp.idx, id: pp.id, name: pp.name, operation: pp.operation,
      allowedMin: pp.allowed, norRaw: pp.norRaw, norEff: pp.norEff, norAdjusted: pp.norAdjusted,
      sooner: pp.sooner, commenced: pp.commenced,
      start: S, end: E, arrivedOnDemurrage,
      usedMin: used, demMin: dem, notCountedMin: notCounted, expiry,
      remainingMin: state.onDem ? 0 : state.remaining,
      savedMin: 0, savedAllMin: 0, projectedExpiry: null,
      notes: pp.notes, rows,
    };
  }

  // ---------------------------------------------------------------- public: compute
  /**
   * @param {object} input  see README / examples.js for the full shape
   * @returns {{ok:boolean, errors:Array, warnings:Array, ports:Array, totals:object|null}}
   */
  function compute(input) {
    input = input || {};
    const errors = [], warnings = [];
    const mode = ['reversible', 'separate', 'average'].indexOf(input.laytimeMode) >= 0 ? input.laytimeMode : 'reversible';
    const once = input.onceOnDemurrage !== false;
    const demFromNor = input.demurrageAtNextPort !== 'laytimeStart';
    const basis = input.despatchBasis === 'ATS' ? 'ATS' : 'WTS';
    const despatchMode = ['half', 'custom', 'none'].indexOf(input.despatchMode) >= 0 ? input.despatchMode : 'half';

    const portsIn = Array.isArray(input.ports) ? input.ports : [];
    if (!portsIn.length) errors.push({ code: 'no_ports' });
    const pps = portsIn.map((p, i) => prepPort(p, i, errors, warnings));

    let demRate = num(input.demurrageRate);
    if (!(demRate >= 0)) { demRate = 0; warnings.push({ code: 'demurrage_rate_missing' }); }
    let desRate = 0;
    if (despatchMode === 'half') desRate = demRate / 2;
    else if (despatchMode === 'custom') {
      desRate = num(input.despatchRate);
      if (!(desRate >= 0)) { desRate = 0; warnings.push({ code: 'despatch_rate_missing' }); }
    }
    let commissionPct = input.commissionPct === '' || input.commissionPct == null ? 0 : num(input.commissionPct);
    if (!(commissionPct >= 0 && commissionPct <= 100)) { commissionPct = 0; warnings.push({ code: 'commission_invalid' }); }

    if (errors.length) return { ok: false, errors, warnings, ports: [], totals: null };

    const results = [];
    let allowedTotal = 0, usedTotal = 0, demGross = 0, savedWTS = 0, savedATS = 0;
    const saved = (r) => (basis === 'ATS' ? r.savedAllMin : r.savedMin);

    if (mode === 'reversible') {
      for (let i = 1; i < pps.length; i++) {
        if (pps[i].S < pps[i - 1].E - EPS) warnings.push({ code: 'ports_not_chronological', port: i });
      }
      allowedTotal = pps.reduce((s, p) => s + p.allowed, 0);
      const state = { remaining: allowedTotal, onDem: false };
      for (const pp of pps) {
        const r = runPort(pp, state, { once, demFromNor, usedBefore: usedTotal, demBefore: demGross });
        usedTotal += r.usedMin; demGross += r.demMin;
        results.push(r);
      }
      if (!state.onDem && state.remaining > EPS) {
        const last = pps[pps.length - 1], lr = results[results.length - 1];
        savedWTS = state.remaining;
        lr.projectedExpiry = projectExpiry(last.cal, last.E, savedWTS);
        savedATS = lr.projectedExpiry - last.E;
        lr.savedMin = savedWTS; lr.savedAllMin = savedATS;
      }
    } else {
      for (const pp of pps) {
        const state = { remaining: pp.allowed, onDem: false };
        const r = runPort(pp, state, { once, demFromNor: false, usedBefore: 0, demBefore: 0 });
        if (!state.onDem && state.remaining > EPS) {
          r.savedMin = state.remaining;
          r.projectedExpiry = projectExpiry(pp.cal, pp.E, r.savedMin);
          r.savedAllMin = r.projectedExpiry - pp.E;
        }
        allowedTotal += pp.allowed; usedTotal += r.usedMin; demGross += r.demMin;
        savedWTS += r.savedMin; savedATS += r.savedAllMin;
        results.push(r);
      }
    }

    // Time on demurrage / time saved that money is charged on.
    let demMin = demGross, desMin = basis === 'ATS' ? savedATS : savedWTS;
    if (mode === 'average') {
      const net = demGross - results.reduce((s, r) => s + saved(r), 0);
      demMin = Math.max(net, 0); desMin = Math.max(-net, 0);
    }
    if (demMin < EPS) demMin = 0;
    if (desMin < EPS) desMin = 0;
    // Money is charged on time taken to a millionth of a minute: the dust that arithmetic leaves behind must not
    // decide which way an exact half cent is rounded (an exported sheet makes the same step, see export.js).
    demMin = snapMinutes(demMin); desMin = snapMinutes(desMin);

    const demurrage = (demMin / DAY) * demRate;
    const despatch = despatchMode === 'none' ? 0 : (desMin / DAY) * desRate;
    const commission = demurrage * commissionPct / 100;
    const net = demurrage - commission - despatch;
    let outcome = 'even';
    if (demurrage > 0.004 && despatch > 0.004) outcome = net >= 0 ? 'net_demurrage' : 'net_despatch';
    else if (demurrage > 0.004) outcome = 'demurrage';
    else if (despatch > 0.004) outcome = 'despatch';
    else if (demMin > 0) outcome = 'demurrage';
    else if (desMin > 0) outcome = 'despatch';

    return {
      ok: true, errors, warnings, ports: results,
      totals: {
        mode, basis, despatchMode, once,
        allowedMin: allowedTotal, usedMin: usedTotal,
        demGrossMin: demGross, savedWTSMin: savedWTS, savedATSMin: savedATS,
        demMin, desMin, demRate, desRate, commissionPct,
        demurrage: round2(demurrage), despatch: round2(despatch), commission: round2(commission),
        net: round2(net), outcome,
      },
    };
  }

  // ---------------------------------------------------------------- public: periods
  /**
   * The periods of every port call with the share of each that counts — while laytime runs (fL) and once the vessel
   * is on demurrage (fD) — without deciding which of the two applies. An editable time sheet is built from these:
   * there laytime and demurrage are told apart by formulas, so the split follows whatever the reader corrects.
   *
   * `notice` marks the time between NOR and the commencement of laytime at a later port of a reversible voyage:
   * it counts only if the vessel arrives there already on demurrage (see `demurrageAtNextPort`).
   *
   * @returns {Array<{idx:number,start:number,end:number,periods:Array}>|null} null when the input does not compute
   */
  function periods(input) {
    input = input || {};
    const errors = [];
    const mode = ['reversible', 'separate', 'average'].indexOf(input.laytimeMode) >= 0 ? input.laytimeMode : 'reversible';
    const once = input.onceOnDemurrage !== false;
    const fromNor = mode === 'reversible' && input.demurrageAtNextPort !== 'laytimeStart';
    const pps = (Array.isArray(input.ports) ? input.ports : []).map((p, i) => prepPort(p, i, errors, []));
    if (!pps.length || errors.length) return null;
    return pps.map((pp, i) => {
      const S = pp.S, End = pp.E;
      const from = fromNor && i > 0 && pp.norRaw != null && pp.norRaw < S ? pp.norRaw : S;
      const wins = calendarWindows(pp.cal, from, End);
      const set = new Set(cutPoints(pp, wins, from, End));
      set.add(S);
      const pts = Array.from(set).sort((a, b) => a - b);
      const out = [];
      for (let k = 0; k + 1 < pts.length; k++) {
        const t0 = pts[k], t1 = pts[k + 1];
        if (t1 - t0 < EPS) continue;
        const c = classify(pp, wins, t0, t1, once);
        const notice = t1 <= S + EPS;
        const fL = notice ? 0 : c.fL;
        const key = (notice ? 'n' : '') + '|' + fL + '|' + c.fD + '|' + JSON.stringify(c.reasonsL);
        const last = out[out.length - 1];
        if (last && last.key === key && Math.abs(last.to - t0) < EPS) last.to = t1;
        else out.push({ key, from: t0, to: t1, fL, fD: c.fD, notice, reasons: c.reasonsL });
      }
      out.forEach((r) => { delete r.key; });
      return { idx: pp.idx, start: S, end: End, periods: out };
    });
  }

  // ---------------------------------------------------------------- presentation helpers
  /** Split time-sheet rows at midnight so that the sheet reads day by day. */
  function splitRowsByDay(rows) {
    const out = [];
    for (const r of rows) {
      const total = r.to - r.from;
      let a = r.from;
      let acc = 0;
      while (a < r.to - EPS) {
        const b = Math.min(r.to, startOfDay(a) + DAY);
        const part = total > 0 ? r.counted * ((b - a) / total) : 0;
        acc += part;
        const back = r.counted - acc; // counted in the rest of the original row
        out.push({
          from: a, to: b, regime: r.regime, factor: r.factor, counted: part, reasons: r.reasons,
          cumUsed: r.regime === 'laytime' ? r.cumUsed - back : r.cumUsed,
          remaining: r.regime === 'laytime' ? r.remaining + back : r.remaining,
          cumDem: r.regime === 'demurrage' ? r.cumDem - back : r.cumDem,
        });
        a = b;
      }
    }
    return out;
  }

  return {
    DAY, EPS,
    parseDT, fmtDT, timeToMin, startOfDay, dow, splitDur, num, round2,
    CALENDAR_PRESETS, resolveCalendar, calendarWindows, mergeWindows, projectExpiry,
    allowedMinutes, norInOfficeHours, laytimeStart,
    compute, periods, splitRowsByDay,
  };
});
