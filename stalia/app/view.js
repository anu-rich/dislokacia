/*! Stalia — formatting and pure HTML renderers (result, time line, time sheet, statement, CSV). No DOM access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./i18n.js'), require('./model.js'));
  else root.StaliaView = factory(root.StaliaEngine, root.StaliaI18n, root.StaliaModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, I, M) {
  'use strict';

  const DAY = E.DAY;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** Escape text for HTML content and attribute values. Every user-supplied string goes through this. */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const T = (lang) => (key, vars) => I.t(lang, key, vars);
  /** Kazakh follows the same number and date conventions as Russian (14 500,00 and 06.03.2026). */
  /** Number, date and duration conventions of a language (lang/<code>.js -> format). */
  const F = (lang) => I.format(lang);

  // ---------------------------------------------------------------- formatting
  function fmtNumber(v, lang, digits) {
    const d = digits == null ? 0 : digits;
    try {
      return new Intl.NumberFormat(F(lang).locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    } catch (e) { return Number(v).toFixed(d); }
  }
  /** "USD 14,500.00" — currency code first, the way freight invoices are written. */
  const fmtMoney = (v, cur, lang) => (cur || '') + ' ' + fmtNumber(v, lang, 2);
  /** Rates keep cents only when they have them: "USD 14,500". */
  const fmtRate = (v, cur, lang) => (cur || '') + ' ' + fmtNumber(v, lang, Math.abs(v - Math.round(v)) > 0.004 ? 2 : 0);
  function fmtDur(min, lang) {
    const p = E.splitDur(min), t = T(lang), sp = F(lang).durSpace ? ' ' : '';
    return (p.neg ? '−' : '') + p.d + sp + t('u.d') + ' ' + pad(p.h) + sp + t('u.h') + ' ' + pad(p.m) + sp + t('u.m');
  }
  /** A duration in a sentence: the days are said only when there are any ("2 h 15 min", "1 d 02 h 15 min"). */
  function fmtDurShort(min, lang) {
    const p = E.splitDur(min), t = T(lang), sp = F(lang).durSpace ? ' ' : '';
    return (p.neg ? '−' : '') + (p.d ? p.d + sp + t('u.d') + ' ' + pad(p.h) : String(p.h)) + sp + t('u.h') + ' ' + pad(p.m) + sp + t('u.m');
  }
  const fmtDays = (min, lang) => fmtNumber(min / DAY, lang, 5);
  function parts(min) {
    const d = new Date(Math.round(min) * 60000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
  }
  /** Fill a pattern made of DD, MM, MMM and YYYY, e.g. "DD MMM YYYY" or "YYYY-MM-DD". */
  function datePattern(pattern, p, lang) {
    return pattern.replace(/YYYY|MMM|MM|DD/g, (k) =>
      (k === 'YYYY' ? String(p.y) : k === 'MMM' ? I.t(lang, 'mon.' + p.mo) : k === 'MM' ? pad(p.mo + 1) : pad(p.d)));
  }
  function fmtDate(min, lang) {
    if (min == null) return '';
    return datePattern(F(lang).date, parts(min), lang);
  }
  const fmtDayShort = (min, lang) => datePattern(F(lang).dayShort, parts(min), lang);
  /** A month given as "YYYY-MM", the way this language writes dates but without the day: "May 2026", "05.2026", "2026-05". */
  function fmtMonth(period, lang) {
    const at = E.parseDT(String(period || '') + '-01T00:00');
    if (at == null) return '';
    return datePattern(F(lang).date.replace(/^DD[^A-Za-z]+|[^A-Za-z]+DD$/, ''), parts(at), lang);
  }
  const fmtTime = (min) => { const p = parts(min); return pad(p.h) + ':' + pad(p.mi); };
  const fmtDT = (min, lang) => (min == null ? '' : fmtDate(min, lang) + ' ' + fmtTime(min));
  const fmtDow = (min, lang) => I.t(lang, 'dows.' + parts(min).dow);
  const fmtPct = (f) => (f <= 0 ? '—' : Math.round(f * 100) + '%');
  /** 'HH:MM' on weekday name, e.g. "Saturday 12:00". */
  const fmtWeekly = (dow, time, lang) => I.t(lang, 'dow.' + dow) + ' ' + time;

  // ---------------------------------------------------------------- wording of time-sheet rows
  function reasonText(r, lang) {
    const t = T(lang);
    switch (r.code) {
      case 'weekend': return t('s.row.weekend');
      case 'holiday': return r.name ? t('s.row.holidayNamed', { name: r.name }) : t('s.row.holiday');
      case 'worked_counts': return t('s.row.worked_counts');
      case 'worked_ignored': return t('s.row.worked_ignored');
      case 'exceptions_off': return t('s.row.exceptions_off');
      case 'event': {
        const d = (r.desc || '').trim() || (r.type && r.type !== 'custom' ? t('et.' + r.type) : t('s.row.unnamedEvent'));
        return r.pct > 0 && r.pct < 100 ? t('s.row.eventPct', { desc: d, pct: r.pct }) : d;
      }
      default: return '';
    }
  }
  function rowRemarks(row, lang) {
    const t = T(lang);
    // "Excepted period, work performed, time used counts" — not "…not counted; …counts"
    const used = row.reasons.some((r) => r.code === 'worked_counts');
    const rs = row.reasons.map((r) => {
      if (used && r.code === 'weekend') return t('s.row.weekendBare');
      if (used && r.code === 'holiday') return r.name ? t('s.row.holidayNamedBare', { name: r.name }) : t('s.row.holidayBare');
      return reasonText(r, lang);
    }).filter(Boolean);
    if (row.regime === 'demurrage') return t('s.row.demurrage') + (rs.length ? ': ' + rs.join('; ') : '');
    return rs.length ? rs.join(used ? ', ' : '; ') : t('s.row.counts');
  }
  /** Visual state of a row: lay | part | exc | dem | dempart | demexc */
  function rowState(row) {
    const d = row.regime === 'demurrage';
    if (row.factor >= 1 - 1e-9) return d ? 'dem' : 'lay';
    if (row.factor <= 1e-9) return d ? 'demexc' : 'exc';
    return d ? 'dempart' : 'part';
  }

  /** Dated facts of a port call, in time order. */
  function portFacts(pr, lang) {
    const t = T(lang), out = [];
    const add = (time, label, kind) => { if (time != null) out.push({ t: time, label, kind }); };
    add(pr.norRaw, t('s.fact.nor'), 'nor');
    if (pr.norAdjusted) add(pr.norEff, t('s.fact.norEff'), 'nor');
    add(pr.commenced, t('s.fact.commenced'), 'ops');
    add(pr.start, t(pr.arrivedOnDemurrage ? 's.fact.startDem' : (pr.sooner ? 's.fact.startSooner' : 's.fact.start')), 'start');
    for (const n of pr.notes || []) add(n.from, n.desc || t('et.note'), 'note');
    if (pr.expiry != null) add(pr.expiry, t('s.fact.expiry'), 'expiry');
    add(pr.end, t('s.fact.completed'), 'end');
    if (pr.savedMin > 0 && pr.projectedExpiry != null) add(pr.projectedExpiry, t('s.fact.wouldExpire'), 'proj');
    const order = { nor: 0, ops: 1, start: 2, note: 3, expiry: 4, end: 5, proj: 6 };
    return out.map((f, i) => ({ f, i })).sort((a, b) => a.f.t - b.f.t || order[a.f.kind] - order[b.f.kind] || a.i - b.i).map((x) => x.f);
  }

  function messageText(m, lang, prefix) {
    return I.t(lang, prefix + '.' + m.code, { n: m.port == null ? '' : m.port + 1 });
  }

  const portTitle = (pr, lang) => I.t(lang, 'p.port', { n: pr.idx + 1 }) + ' · ' + I.t(lang, 'p.op.' + pr.operation) + (pr.name ? ' · ' + pr.name : '');

  // ---------------------------------------------------------------- result summary
  function outcomeOf(result) {
    const tt = result.totals;
    const amount = Math.abs(tt.net);
    const kind = tt.outcome === 'even' ? 'even' : (tt.outcome === 'demurrage' || tt.outcome === 'net_demurrage' ? 'dem' : 'des');
    return { kind, amount };
  }

  function summaryHTML(calc, result, lang) {
    const t = T(lang), cur = calc.currency;
    if (!result.ok) {
      return '<div class="res res-wait"><p class="res-label">' + esc(t('sec.result')) + '</p><p class="res-hint">' + esc(t('r.incomplete')) + '</p></div>' +
        messagesHTML(result, lang);
    }
    const tt = result.totals, oc = outcomeOf(result);
    const sub = [];
    if (tt.demMin > 0) sub.push(fmtDur(tt.demMin, lang) + ' ' + t('r.onDem') + ' · ' + fmtDays(tt.demMin, lang) + ' ' + t('r.days'));
    if (tt.desMin > 0 && (tt.despatchMode !== 'none' || tt.demMin <= 0)) sub.push(fmtDur(tt.desMin, lang) + ' ' + t('r.saved') + ' · ' + fmtDays(tt.desMin, lang) + ' ' + t('r.days'));
    let h = '<div class="res res-' + oc.kind + '">' +
      '<p class="res-label">' + esc(t('r.outcome.' + tt.outcome)) + '</p>' +
      '<p class="res-amount"><span class="res-cur">' + esc(cur) + '</span> ' + esc(fmtNumber(oc.amount, lang, 2)) + '</p>' +
      (sub.length ? '<p class="res-sub">' + esc(sub.join('  /  ')) + '</p>' : '') + '</div>';

    const line = (label, value, cls) => '<div class="rl' + (cls ? ' ' + cls : '') + '"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
    h += '<dl class="res-lines">';
    h += line(t('r.allowed'), fmtDur(tt.allowedMin, lang));
    h += line(t('r.used'), fmtDur(tt.usedMin, lang));
    if (tt.demMin > 0 || tt.demGrossMin > 0) h += line(t('r.timeOnDem'), fmtDur(tt.demMin, lang));
    if (tt.desMin > 0) h += line(t('r.timeSaved.' + tt.basis), fmtDur(tt.desMin, lang));
    if (tt.demurrage > 0) h += line(t('r.demAt', { rate: fmtRate(tt.demRate, cur, lang) }), fmtNumber(tt.demurrage, lang, 2));
    if (tt.commission > 0) h += line(t('r.commission', { pct: fmtNumber(tt.commissionPct, lang, tt.commissionPct % 1 ? 2 : 0) }), '−' + fmtNumber(tt.commission, lang, 2));
    if (tt.despatch > 0) h += line(t('r.desAt', { rate: fmtRate(tt.desRate, cur, lang) }), (tt.demurrage > 0 ? '−' : '') + fmtNumber(tt.despatch, lang, 2));
    if (tt.commission > 0 || (tt.demurrage > 0 && tt.despatch > 0)) h += line(t('r.net'), fmtMoney(oc.amount, cur, lang), 'rl-total');
    h += '</dl>';
    if (tt.mode === 'average' && result.ports.length > 1) h += '<p class="res-note">' + esc(t('r.avgNote')) + '</p>';

    if (result.ports.length > 1) {
      // one compact row per port: name and outcome on top, the two durations underneath
      h += '<ul class="rp">';
      for (const pr of result.ports) {
        h += '<li><div class="rp-top"><b>' + esc(pr.name || t('p.port', { n: pr.idx + 1 })) + '</b>' + portChip(pr, tt, lang) + '</div><div class="rp-sub">' +
          (tt.mode === 'reversible' ? '' : esc(t('r.colAllowed') + ' ' + fmtDur(pr.allowedMin, lang)) + ' · ') + esc(t('r.colUsed') + ' ' + fmtDur(pr.usedMin, lang)) +
          (pr.arrivedOnDemurrage ? ' · ' + esc(t('r.arrivedOnDem')) : '') + '</div></li>';
      }
      h += '</ul>';
    }
    return h + messagesHTML(result, lang);
  }

  function portChip(pr, tt, lang) {
    const t = T(lang);
    if (pr.demMin > 0) return '<span class="pill pill-dem">' + esc(fmtDur(pr.demMin, lang) + ' ' + t('r.onDem')) + '</span>';
    const s = tt.basis === 'ATS' ? pr.savedAllMin : pr.savedMin;
    if (s > 0) return '<span class="pill pill-good">' + esc(fmtDur(s, lang) + ' ' + t('r.saved')) + '</span>';
    return '<span class="pill">—</span>';
  }

  function messagesHTML(result, lang) {
    let h = '';
    const errs = result.errors || [], warns = result.warnings || [];
    if (errs.length) {
      h += '<ul class="msgs msgs-err">' + errs.map((m) => '<li>' + esc(messageText(m, lang, 'err')) + '</li>').join('') + '</ul>';
    }
    if (warns.length) {
      const seen = {};
      const items = warns.map((m) => messageText(m, lang, 'warn')).filter((s) => (seen[s] ? false : (seen[s] = true)));
      h += '<ul class="msgs msgs-warn">' + items.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>';
    }
    return h;
  }

  // ---------------------------------------------------------------- time line (one strip per port)
  function timelineHTML(pr, lang) {
    const t = T(lang);
    if (!pr.rows.length) return '';
    const t0 = Math.min(pr.start, pr.norRaw == null ? pr.start : pr.norRaw), t1 = pr.end;
    const span = Math.max(t1 - t0, 1);
    const pos = (x) => ((x - t0) / span) * 100;
    const pc = (v) => (Math.round(v * 1000) / 1000) + '%';
    const present = {};
    let segs = '';
    if (pr.start - t0 > 0.5) {
      segs += '<i class="seg seg-wait" tabindex="0" style="left:0;width:' + pc(pos(pr.start)) + '" data-tv="' + esc(fmtDur(pr.start - t0, lang)) +
        '" data-tt="' + esc(fmtDT(t0, lang) + ' – ' + fmtDT(pr.start, lang) + '\n' + t('s.fact.nor') + ' → ' + t('s.fact.start')) + '"></i>';
    }
    for (const r of pr.rows) {
      const st = rowState(r);
      present[st] = true;
      segs += '<i class="seg seg-' + st + '" tabindex="0" style="left:' + pc(pos(r.from)) + ';width:' + pc(pos(r.to) - pos(r.from)) + '" data-tv="' +
        esc(fmtDur(r.counted, lang) + (r.factor > 0 && r.factor < 1 ? ' (' + fmtPct(r.factor) + ')' : '')) +
        '" data-tt="' + esc(fmtDT(r.from, lang) + ' – ' + fmtDT(r.to, lang) + '\n' + rowRemarks(r, lang)) + '"></i>';
    }
    // day ticks
    const days = [];
    for (let d = E.startOfDay(t0) + DAY; d < t1; d += DAY) days.push(d);
    const step = Math.max(1, Math.ceil((days.length + 1) / 6));
    let ticks = '';
    days.forEach((d, i) => {
      ticks += '<i class="tk" style="left:' + pc(pos(d)) + '"></i>';
      if (i % step === 0 && pos(d) < 92) ticks += '<span class="tkl" style="left:' + pc(pos(d)) + '">' + esc(fmtDayShort(d, lang)) + '</span>';
    });
    let marks = '';
    if (pr.expiry != null && pr.expiry > t0 && pr.expiry < t1) {
      const p = pos(pr.expiry), right = p > 55;
      marks += '<div class="mk mk-exp' + (right ? ' mk-r' : '') + '" style="left:' + pc(p) + '"><span>' + esc(t('tl.expiry') + ' ' + fmtDayShort(pr.expiry, lang) + ' ' + fmtTime(pr.expiry)) + '</span></div>';
    }
    const lg = (cls, key) => '<span class="lg"><i class="sw sw-' + cls + '"></i>' + esc(t(key)) + '</span>';
    let legend = lg('lay', 'tl.counts');
    if (present.part || present.dempart) legend += lg('part', 'tl.partial');
    if (present.exc || present.demexc) legend += lg('exc', 'tl.excluded');
    if (present.dem || present.dempart || present.demexc) legend += lg('dem', 'tl.demurrage');
    return '<figure class="tl" role="group" aria-label="' + esc(t('tl.aria', { name: pr.name || pr.idx + 1 })) + '">' +
      '<figcaption class="tl-cap"><span class="tl-name">' + esc(pr.name || t('p.port', { n: pr.idx + 1 })) + '</span>' +
      '<span class="tl-range">' + esc(fmtDayShort(t0, lang) + ' ' + fmtTime(t0) + ' – ' + fmtDayShort(t1, lang) + ' ' + fmtTime(t1)) + '</span></figcaption>' +
      '<div class="tl-plot">' + marks + '<div class="tl-track">' + segs + '</div><div class="tl-axis">' + ticks + '</div></div>' +
      '<div class="tl-legend">' + legend + '</div></figure>';
  }

  // ---------------------------------------------------------------- time sheet
  function factsHTML(pr, lang) {
    return '<ol class="facts">' + portFacts(pr, lang).map((f) =>
      '<li class="fact fact-' + f.kind + '"><time>' + esc(fmtDT(f.t, lang)) + '</time><span>' + esc(f.label) + '</span></li>').join('') + '</ol>';
  }

  /** Day-by-day rows of one port, as plain data (shared by the table, the statement and the CSV). */
  function sheetRows(pr, lang) {
    const t = T(lang), out = [];
    let lastDay = null;
    for (const r of E.splitRowsByDay(pr.rows)) {
      const day = E.startOfDay(r.from);
      const endOfDay = Math.abs(r.to - (day + DAY)) < 1e-6;
      out.push({
        state: rowState(r), first: day !== lastDay,
        date: fmtDate(r.from, lang), dow: fmtDow(r.from, lang),
        from: fmtTime(r.from), to: endOfDay ? '24:00' : fmtTime(r.to),
        remarks: rowRemarks(r, lang), pct: fmtPct(r.factor),
        counted: fmtDur(r.counted, lang), countedMin: r.counted,
        total: fmtDur(r.cumUsed, lang),
        balance: r.regime === 'demurrage' ? t('s.over', { dur: fmtDur(r.cumDem, lang) }) : t('s.left', { dur: fmtDur(r.remaining, lang) }),
      });
      lastDay = day;
    }
    return out;
  }

  function sheetTableHTML(pr, lang) {
    const t = T(lang);
    const rows = sheetRows(pr, lang);
    let h = '<table class="ts"><thead><tr><th class="sc" aria-hidden="true"></th><th>' + esc(t('s.date')) + '</th><th>' + esc(t('s.day')) + '</th><th class="n">' + esc(t('s.from')) +
      '</th><th class="n">' + esc(t('s.to')) + '</th><th>' + esc(t('s.remarks')) + '</th><th class="n">' + esc(t('s.pct')) + '</th><th class="n">' + esc(t('s.counted')) +
      '</th><th class="n">' + esc(t('s.total')) + '</th><th class="n">' + esc(t('s.balance')) + '</th></tr></thead><tbody>';
    for (const r of rows) {
      h += '<tr class="r-' + r.state + (r.first ? ' r-first' : '') + '"><td class="sc"><i class="sw sw-' + r.state.replace('dempart', 'dem').replace('demexc', 'exc') + '"></i></td>' +
        '<td class="d">' + (r.first ? esc(r.date) : '') + '</td><td class="d">' + (r.first ? esc(r.dow) : '') + '</td>' +
        '<td class="n">' + esc(r.from) + '</td><td class="n">' + esc(r.to) + '</td><td class="rm">' + esc(r.remarks) + '</td>' +
        '<td class="n">' + esc(r.pct) + '</td><td class="n">' + esc(r.counted) + '</td><td class="n">' + esc(r.total) + '</td><td class="n">' + esc(r.balance) + '</td></tr>';
    }
    return h + '</tbody></table>';
  }

  function portSummaryHTML(pr, tt, lang) {
    const t = T(lang);
    const cell = (k, v) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>';
    let h = '<dl class="psum">';
    if (tt.mode !== 'reversible') h += cell(t('r.allowed'), fmtDur(pr.allowedMin, lang));
    h += cell(t('r.used'), fmtDur(pr.usedMin, lang));
    if (pr.notCountedMin > 0) h += cell(t('r.notCounted'), fmtDur(pr.notCountedMin, lang));
    if (pr.demMin > 0) h += cell(t('r.timeOnDem'), fmtDur(pr.demMin, lang));
    const s = tt.basis === 'ATS' ? pr.savedAllMin : pr.savedMin;
    if (s > 0) h += cell(t('r.timeSaved.' + tt.basis), fmtDur(s, lang));
    return h + '</dl>';
  }

  function sheetHTML(calc, result, lang) {
    if (!result.ok) return '';
    let h = '';
    for (const pr of result.ports) {
      h += '<section class="tsp"><h3 class="tsp-h">' + esc(portTitle(pr, lang)) + '</h3>' +
        factsHTML(pr, lang) + '<div class="ts-wrap">' + sheetTableHTML(pr, lang) + '</div>' + portSummaryHTML(pr, result.totals, lang) + '</section>';
    }
    return h;
  }

  // ---------------------------------------------------------------- terms in words (statement)
  function calendarText(cal, lang) {
    const t = T(lang);
    const c = E.resolveCalendar(cal);
    let s;
    if (c.preset && c.preset !== 'CUSTOM') s = t('c.' + c.preset);
    else if (c.weekly) {
      s = t('st.term.custom', {
        from: fmtWeekly(c.weekly.fromDow, c.weekly.fromTime, lang), to: fmtWeekly(c.weekly.toDow, c.weekly.toTime, lang),
        hol: t(c.holidaysExcluded ? 'st.term.holEx' : 'st.term.holIn'),
      });
    } else s = t('c.SHINC');
    if (c.weekly || c.holidaysExcluded) s += ', ' + t(c.unlessUsed ? 'st.term.uu' : 'st.term.eiu');
    return s;
  }
  function portTermsText(p, lang) {
    const t = T(lang), a = p.allowed || {}, n = p.nor || {}, bits = [];
    if (a.type === 'rate') {
      bits.push(t('st.term.rate', { qty: fmtNumber(E.num(a.quantity) || 0, lang, 0), rate: fmtNumber(E.num(a.rate) || 0, lang, 0), unit: t(a.rateUnit === 'hour' ? 'a.perHour' : 'a.perDay') }));
    }
    bits.push(calendarText(p.calendar, lang));
    let nor;
    if (n.rule === 'gencon') nor = t('st.term.nor.gencon', { am: n.amStart || '13:00', pm: n.pmStart || '06:00' });
    else if (n.rule === 'nextday') nor = t('st.term.nor.nextday', { at: n.nextDayStart || '08:00' });
    else if (n.rule === 'manual') nor = t('st.term.nor.manual');
    else nor = t('st.term.nor.turn', { h: fmtNumber(E.num(n.turnHours) || 0, lang, (E.num(n.turnHours) || 0) % 1 ? 1 : 0) });
    if (n.rule !== 'manual' && n.unlessSoonerCommenced !== false) nor += ', ' + t('st.term.sooner');
    bits.push(nor);
    return bits.join('; ');
  }
  function termsText(calc, result, lang) {
    const t = T(lang), tt = result.totals, cur = calc.currency, bits = [];
    bits.push(t('st.term.dem', { rate: fmtRate(tt.demRate, cur, lang) }));
    if (tt.despatchMode === 'none') bits.push(t('st.term.des.none'));
    else bits.push(t('st.term.des.' + tt.despatchMode, { rate: fmtRate(tt.desRate, cur, lang), basis: t('st.term.basis.' + tt.basis) }));
    if (result.ports.length > 1) bits.push(t('st.term.mode.' + tt.mode));
    bits.push(t(tt.once ? 'st.term.once' : 'st.term.notOnce'));
    if (tt.commissionPct > 0) bits.push(t('st.term.commission', { pct: fmtNumber(tt.commissionPct, lang, tt.commissionPct % 1 ? 2 : 0) }));
    return bits.join('; ') + '.';
  }

  /** The contract's rules for delays in one line, in the reader's language; '' when it has none. */
  function rulesText(calc, lang) {
    const t = T(lang);
    return ((calc && calc.rules) || []).filter((r) => M.ruleFor(calc, r.type))
      .map((r) => t('et.' + r.type) + ': ' + fmtNumber(E.num(r.countPct), lang, E.num(r.countPct) % 1 ? 1 : 0) + '%' + (r.alsoOnDemurrage ? ' (' + t('e.dem') + ')' : '')).join(' · ');
  }

  /**
   * The terms of a calculation in plain English lines, for the document reader: with these it can count a time
   * sheet under a contract whose pages are not attached. Needs no result, so it works before any time is entered.
   */
  function readerTerms(calc) {
    const lines = [], n = (v) => (v === '' || v == null ? 'not stated' : String(v));
    lines.push('Demurrage ' + (calc.currency || '') + ' ' + n(calc.demurrageRate) + ' per day. Despatch: ' +
      (calc.despatchMode === 'none' ? 'none' : calc.despatchMode === 'custom' ? n(calc.despatchRate) + ' per day' : 'half the demurrage rate') +
      '. Laytime between ports: ' + (calc.laytimeMode || 'reversible') + '. ' +
      (calc.onceOnDemurrage === false ? 'Excepted periods also interrupt demurrage.' : 'Once on demurrage, always on demurrage.'));
    (calc.ports || []).forEach((p, i) => {
      lines.push('Port ' + (i + 1) + ' (' + (p.operation === 'discharge' ? 'discharging' : 'loading') + (p.name ? ', ' + p.name : '') + '): ' + portTermsText(p, 'en') + '.');
    });
    const rules = (calc.rules || []).filter((r) => M.ruleFor(calc, r.type));
    if (rules.length) {
      lines.push('How each kind of delay counts under this charter party (the calculator applies these shares itself; give such events the type named):');
      for (const r of rules) {
        const pct = E.num(r.countPct);
        lines.push('- ' + RULE_WORDS[r.type] + ' (type "' + r.type + '"): ' +
          (pct === 0 ? 'does not count as laytime' : pct === 100 ? 'counts in full as laytime' : 'counts ' + pct + '% as laytime') + '; on demurrage ' +
          (r.alsoOnDemurrage && pct !== 100 ? 'the same applies' : 'such time counts in full') + '.');
      }
    }
    if (calc.meta && calc.meta.clauses) lines.push('Clauses of the charter party:', calc.meta.clauses);
    return lines.join('\n').slice(0, 6000);
  }
  const RULE_WORDS = {
    weather: 'bad weather, a port closed by weather', shifting: 'shifting', awaiting: 'awaiting tide, daylight, pilot, tugs or a berth',
    breakdown: 'breakdown of the vessel or her gear', owner: 'bunkering, ballasting and other owners\' purposes', survey: 'surveys, inspections and sampling', strike: 'strikes',
  };

  // ---------------------------------------------------------------- statement (print document)
  /**
   * @param {object} opts { pro:boolean, brand:{company,details,logo}, siteUrl:string, today:string(YYYY-MM-DD) }
   */
  function statementHTML(calc, result, lang, opts) {
    const t = T(lang);
    opts = opts || {};
    if (!result.ok) return '<div class="paper"><p>' + esc(t('r.incomplete')) + '</p></div>';
    const tt = result.totals, m = calc.meta || {}, cur = calc.currency, oc = outcomeOf(result);
    const brand = opts.pro ? (opts.brand || {}) : {};
    const kv = (k, v) => (v ? '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>' : '');
    const safeLogo = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(brand.logo || '') ? brand.logo : '';

    let h = '<article class="paper" lang="' + esc(lang) + '">';
    h += '<header class="p-head"><div class="p-brand">' +
      (safeLogo ? '<img class="p-logo" src="' + safeLogo + '" alt="">' : '') +
      '<div>' + (brand.company ? '<p class="p-co">' + esc(brand.company) + '</p>' : '') +
      (brand.details ? '<p class="p-det">' + esc(brand.details) + '</p>' : '') + '</div></div>' +
      '<div class="p-title"><h1>' + esc(t('st.title')) + '</h1><p>' +
      (m.voyage ? esc(t('st.ref')) + ': ' + esc(m.voyage) + ' · ' : '') + esc(t('st.dateOf')) + ': ' + esc(fmtDate(E.parseDT(opts.today || ''), lang) || '') + '</p></div></header>';

    const cpDate = m.cpDate ? fmtDate(E.parseDT(m.cpDate), lang) : '';
    const cp = m.cpForm && cpDate ? t('st.cpDated', { form: m.cpForm, date: cpDate }) : (m.cpForm || cpDate);
    h += '<dl class="p-fix">' + kv(t('f.vessel'), m.vessel) + kv(t('st.cp'), cp) + kv(t('f.owners'), m.owners) + kv(t('f.charterers'), m.charterers) + kv(t('f.cargo'), m.cargo) + '</dl>';
    h += '<p class="p-terms"><b>' + esc(t('s.terms')) + ':</b> ' + esc(termsText(calc, result, lang)) + '</p>';

    result.ports.forEach((pr, i) => {
      const p = calc.ports[i] || {};
      h += '<section class="p-port"><h2>' + esc(portTitle(pr, lang)) + '</h2>' +
        '<p class="p-pterms">' + esc(portTermsText(p, lang)) + (tt.mode !== 'reversible' || result.ports.length === 1 || pr.allowedMin > 0
          ? ' <b>' + esc(t('r.allowed')) + ': ' + esc(fmtDur(pr.allowedMin, lang)) + '</b>' : '') + '</p>' +
        factsHTML(pr, lang) + sheetTableHTML(pr, lang) + portSummaryHTML(pr, tt, lang) + '</section>';
    });

    const line = (k, v, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + '><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>';
    h += '<section class="p-sum"><h2>' + esc(t('st.summary')) + '</h2><table>';
    h += line(t('st.totalAllowed'), fmtDur(tt.allowedMin, lang) + '  (' + fmtDays(tt.allowedMin, lang) + ' ' + t('r.days') + ')');
    h += line(t('st.totalUsed'), fmtDur(tt.usedMin, lang) + '  (' + fmtDays(tt.usedMin, lang) + ' ' + t('r.days') + ')');
    if (tt.demMin > 0) h += line(t('r.timeOnDem'), fmtDur(tt.demMin, lang) + '  (' + fmtDays(tt.demMin, lang) + ' ' + t('r.days') + ')');
    if (tt.desMin > 0) h += line(t('r.timeSaved.' + tt.basis), fmtDur(tt.desMin, lang) + '  (' + fmtDays(tt.desMin, lang) + ' ' + t('r.days') + ')');
    if (tt.demurrage > 0) h += line(t('r.demAt', { rate: fmtRate(tt.demRate, cur, lang) }), fmtMoney(tt.demurrage, cur, lang));
    if (tt.commission > 0) h += line(t('r.commission', { pct: fmtNumber(tt.commissionPct, lang, tt.commissionPct % 1 ? 2 : 0) }), '− ' + fmtMoney(tt.commission, cur, lang));
    if (tt.despatch > 0) h += line(t('r.desAt', { rate: fmtRate(tt.desRate, cur, lang) }), (tt.demurrage > 0 ? '− ' : '') + fmtMoney(tt.despatch, cur, lang));
    h += line(t('r.outcome.' + tt.outcome), fmtMoney(oc.amount, cur, lang), 'p-total');
    h += '</table></section>';

    if ((m.remarks || '').trim()) h += '<p class="p-remarks">' + esc(m.remarks).replace(/\n/g, '<br>') + '</p>';
    h += '<div class="p-sign"><div><span></span>' + esc(t('st.signOwners')) + '</div><div><span></span>' + esc(t('st.signCharterers')) + '</div></div>';
    const site = (opts.siteUrl || '').replace(/^https?:\/\//, '');
    h += '<footer class="p-foot"><span>' + esc(t('st.eoe')) + '</span><span>' +
      (opts.pro ? '' : esc(t('st.freeFooter')) + (site ? ' · ' + esc(site) : '')) + '</span></footer>';
    return h + '</article>';
  }

  // ---------------------------------------------------------------- exports
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // never let a spreadsheet run a cell as a formula
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function sheetCSV(calc, result, lang) {
    const t = T(lang);
    const sepLine = F(lang).csvSep;
    const rows = [[t('r.port'), t('s.date'), t('s.day'), t('s.from'), t('s.to'), t('s.remarks'), t('s.pct'), t('s.counted'), t('s.total'), t('s.balance')]];
    if (result.ok) {
      for (const pr of result.ports) {
        const name = pr.name || t('p.port', { n: pr.idx + 1 });
        for (const r of sheetRows(pr, lang)) rows.push([name, r.date, r.dow, r.from, r.to, r.remarks, r.pct === '—' ? '0%' : r.pct, r.counted, r.total, r.balance]);
      }
    }
    return '\uFEFF' + rows.map((r) => r.map(csvCell).join(sepLine)).join('\r\n') + '\r\n';
  }

  function summaryText(calc, result, lang) {
    const t = T(lang);
    if (!result.ok) return '';
    const tt = result.totals, m = calc.meta || {}, cur = calc.currency, oc = outcomeOf(result), L = [];
    L.push([m.vessel, calc.name].filter(Boolean).join(' — ') || t('st.title'));
    for (const pr of result.ports) {
      const bits = [t('r.used') + ' ' + fmtDur(pr.usedMin, lang)];
      if (pr.demMin > 0) bits.push(fmtDur(pr.demMin, lang) + ' ' + t('r.onDem'));
      if (pr.expiry != null) bits.push(t('r.expiredAt', { dt: fmtDT(pr.expiry, lang) }));
      L.push(portTitle(pr, lang) + ': ' + bits.join(', '));
    }
    L.push(t('r.allowed') + ': ' + fmtDur(tt.allowedMin, lang) + '; ' + t('r.used') + ': ' + fmtDur(tt.usedMin, lang));
    if (tt.demMin > 0) L.push(t('r.timeOnDem') + ': ' + fmtDur(tt.demMin, lang) + ' (' + fmtDays(tt.demMin, lang) + ' ' + t('r.days') + ')');
    if (tt.desMin > 0) L.push(t('r.timeSaved.' + tt.basis) + ': ' + fmtDur(tt.desMin, lang));
    L.push(t('r.outcome.' + tt.outcome) + ': ' + fmtMoney(oc.amount, cur, lang));
    return L.join('\n');
  }

  return {
    esc, fmtNumber, fmtMoney, fmtRate, fmtDur, fmtDays, fmtDate, fmtDayShort, fmtTime, fmtDT, fmtDow, fmtPct,
    reasonText, rowRemarks, rowState, portFacts, portTitle, messageText, outcomeOf,
    summaryHTML, messagesHTML, timelineHTML, factsHTML, sheetRows, sheetTableHTML, sheetHTML, portSummaryHTML,
    fmtDurShort, fmtMonth, calendarText, portTermsText, termsText, rulesText, readerTerms, statementHTML, sheetCSV, summaryText, portChip,
  };
});
