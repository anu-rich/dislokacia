/*! Stalia — calculator screen: state, form, storage, licence UI. */
(function () {
  'use strict';
  const E = window.StaliaEngine, I = window.StaliaI18n, M = window.StaliaModel, V = window.StaliaView, L = window.StaliaLicense;
  const CFG = window.STALIA_CONFIG || {};
  const PREVIEW = !!CFG.preview; // sandboxed preview: no printing, downloads or share links
  const FREE = Object.assign({ maxSaved: 3, maxPorts: 2 }, CFG.free || {});
  const esc = V.esc;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------------------------------------------------------------- storage (never throws)
  const K = { current: 'stalia.current.v1', saved: 'stalia.saved.v1', lang: 'stalia.lang', brand: 'stalia.brand.v1' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  const state = {
    lang: 'en', calc: null, result: null, calcId: null,
    source: 'example', exampleId: null, pristine: true,
    stLang: null, stOpen: false, open: {}, confirm: null, shareHash: '', undo: null,
  };
  const lic = L.create({ config: CFG });
  const t = (k, v) => I.t(state.lang, k, v);
  const isPro = () => lic.get().pro;
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ---------------------------------------------------------------- small helpers
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
  function setPath(obj, path, value) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) return false; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = value;
    return true;
  }
  const idOf = (p) => 'f-' + p.replace(/\./g, '-');
  const attr = (name, v) => (v == null || v === false ? '' : ' ' + name + '="' + esc(v === true ? '' : v) + '"');

  function inp(path, val, o) {
    o = o || {};
    return '<input id="' + idOf(path) + '" data-path="' + path + '" type="' + (o.type || 'text') + '" value="' + esc(val == null ? '' : val) + '"' +
      attr('inputmode', o.inputmode) + attr('placeholder', o.placeholder) + attr('maxlength', o.max) + attr('list', o.list) + attr('step', o.step) +
      attr('aria-label', o.aria) + attr('data-rr', o.rr ? '1' : null) + attr('class', o.icls) + ' autocomplete="off">';
  }
  function sel(path, val, opts, o) {
    o = o || {};
    return '<select id="' + idOf(path) + '" data-path="' + path + '"' + attr('data-rr', o.rr ? '1' : null) + attr('data-type', o.type) + attr('aria-label', o.aria) + '>' +
      opts.map((x) => '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(val) ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('') + '</select>';
  }
  function fld(path, labelKey, control, o) {
    o = o || {};
    return '<div class="f' + (o.cls ? ' ' + o.cls : '') + '"><label class="f-l" for="' + idOf(path) + '">' + esc(o.label || t(labelKey)) + '</label>' + control +
      (o.hint ? '<span class="f-hint">' + esc(o.hint) + '</span>' : '') + '</div>';
  }
  const txt = (path, key, val, o) => fld(path, key, inp(path, val, o), o);
  const numf = (path, key, val, o) => txt(path, key, val, Object.assign({ inputmode: 'decimal', max: 24 }, o || {}));
  const dtf = (path, key, val, o) => fld(path, key, inp(path, val, Object.assign({ type: 'datetime-local', step: 60 }, o || {})), o);
  const timef = (path, key, val, o) => fld(path, key, inp(path, val, Object.assign({ type: 'time' }, o || {})), o);
  function ck(path, checked, label, o) {
    o = o || {};
    return '<label class="ck"><input type="checkbox" id="' + idOf(path) + '" data-path="' + path + '"' + (checked ? ' checked' : '') + attr('data-rr', o.rr ? '1' : null) + '>' +
      '<span>' + esc(label) + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</span></label>';
  }
  function segCtl(path, val, opts) {
    return '<span class="seg-ctl" role="radiogroup">' + opts.map((x) =>
      '<label><input type="radio" id="' + idOf(path) + '-' + x[0] + '" name="' + idOf(path) + '" data-path="' + path + '" data-rr="1" value="' + esc(x[0]) + '"' +
      (x[0] === val ? ' checked' : '') + '><span>' + esc(x[1]) + '</span></label>').join('') + '</span>';
  }
  const card = (titleKey, body) => '<section class="card"><div class="card-h"><h2 class="cap">' + esc(t(titleKey)) + '</h2></div><div class="card-b">' + body + '</div></section>';

  // ---------------------------------------------------------------- form
  function fixtureHTML(c) {
    return '<div class="fg">' +
      txt('name', 'f.name', c.name, { cls: 'f-2', max: 120 }) +
      txt('meta.vessel', 'f.vessel', c.meta.vessel, { max: 160 }) +
      txt('meta.voyage', 'f.voyage', c.meta.voyage, { max: 160 }) +
      txt('meta.cpForm', 'f.cpForm', c.meta.cpForm, { max: 160 }) +
      fld('meta.cpDate', 'f.cpDate', inp('meta.cpDate', c.meta.cpDate, { type: 'date' })) +
      txt('meta.owners', 'f.owners', c.meta.owners, { max: 160 }) +
      txt('meta.charterers', 'f.charterers', c.meta.charterers, { max: 160 }) +
      txt('meta.cargo', 'f.cargo', c.meta.cargo, { cls: 'f-2', max: 160 }) + '</div>';
  }

  function termsHTML(c) {
    let h = '<div class="fg">' +
      numf('demurrageRate', 't.demRate', c.demurrageRate) +
      fld('currency', 't.currency', inp('currency', c.currency, { list: 'cur-list', max: 3 }) +
        '<datalist id="cur-list">' + M.CURRENCIES.map((x) => '<option value="' + x + '">').join('') + '</datalist>') +
      fld('despatchMode', 't.despatch', sel('despatchMode', c.despatchMode, [['half', t('t.despatch.half')], ['custom', t('t.despatch.custom')], ['none', t('t.despatch.none')]], { rr: 1 }));
    if (c.despatchMode === 'custom') h += numf('despatchRate', 't.desRate', c.despatchRate);
    if (c.despatchMode !== 'none') h += fld('despatchBasis', 't.basis', sel('despatchBasis', c.despatchBasis, [['WTS', t('t.basis.WTS')], ['ATS', t('t.basis.ATS')]]));
    h += numf('commissionPct', 't.commission', c.commissionPct);
    h += fld('laytimeMode', 't.mode', sel('laytimeMode', c.laytimeMode, [['reversible', t('t.mode.reversible')], ['separate', t('t.mode.separate')], ['average', t('t.mode.average')]], { rr: 1 }), { cls: 'f-2' });
    if (c.laytimeMode === 'reversible' && c.ports.length > 1) {
      h += fld('demurrageAtNextPort', 't.nextPort', sel('demurrageAtNextPort', c.demurrageAtNextPort, [['nor', t('t.nextPort.nor')], ['laytimeStart', t('t.nextPort.laytimeStart')]]), { cls: 'f-2' });
    }
    h += '</div><div style="margin-top:12px">' + ck('onceOnDemurrage', c.onceOnDemurrage, t('t.once'), { hint: t('t.once.hint') }) + '</div>';
    return h;
  }

  const portCap = (p, i) => t('p.port', { n: i + 1 }) + ' · ' + t('p.op.' + p.operation) + ' · ' + (p.name || t('p.unnamed'));

  function eventHTML(ev, i, j) {
    const ep = 'ports.' + i + '.events.' + j + '.';
    return '<div class="ev" data-ev="' + j + '">' +
      fld(ep + 'type', 'e.type', sel(ep + 'type', ev.type, M.EVENT_TYPES.map((x) => [x.id, t('et.' + x.id)]), { rr: 1 }), { cls: 'ev-type' }) +
      dtf(ep + 'from', 'e.from', ev.from) +
      (ev.kind === 'note' ? '<div></div>' : dtf(ep + 'to', 'e.to', ev.to)) +
      '<button type="button" class="btn btn-sm btn-ghost btn-icon ev-x" data-act="del-event" data-port="' + i + '" data-idx="' + j + '" aria-label="' + esc(t('e.remove')) + '" title="' + esc(t('e.remove')) + '">✕</button>' +
      txt(ep + 'desc', 'e.desc', ev.desc, { cls: 'ev-desc', max: 200 }) +
      (ev.kind === 'exception'
        ? '<div class="ev-opt">' + numf(ep + 'countPct', 'e.pct', ev.countPct, { max: 6 }) + ck(ep + 'alsoOnDemurrage', ev.alsoOnDemurrage, t('e.dem')) + '</div>'
        : '<div class="ev-opt"></div>') + '</div>';
  }

  function portHTML(p, i) {
    const c = state.calc, pre = 'ports.' + i + '.', cal = p.calendar, n = p.nor, oh = n.officeHours;
    const open = state.open[p.id] !== false;
    let h = '<details class="port" data-pid="' + esc(p.id) + '"' + (open ? ' open' : '') + '>' +
      '<summary><span class="cap" id="ptitle-' + i + '">' + esc(portCap(p, i)) + '</span><span class="chips" id="chip-' + i + '"></span></summary><div class="port-b">';

    h += '<div class="blk"><div class="fg">' + txt(pre + 'name', 'p.name', p.name, { max: 80 }) +
      fld(pre + 'operation', 'p.operation', sel(pre + 'operation', p.operation, [['load', t('p.op.load')], ['discharge', t('p.op.discharge')]])) + '</div></div>';

    // laytime allowed
    h += '<div class="blk"><div class="blk-h"><span>' + esc(t('a.title')) + '</span><span class="grow"></span>' +
      segCtl(pre + 'allowed.type', p.allowed.type, [['rate', t('a.type.rate')], ['fixed', t('a.type.fixed')]]) + '</div>';
    if (p.allowed.type === 'rate') {
      const per = (k) => (t('a.per') + ' ' + t(k)).trim();
      h += '<div class="fg fg-3">' + numf(pre + 'allowed.quantity', 'a.quantity', p.allowed.quantity) + numf(pre + 'allowed.rate', 'a.rate', p.allowed.rate) +
        fld(pre + 'allowed.rateUnit', 'a.rate', sel(pre + 'allowed.rateUnit', p.allowed.rateUnit, [['day', per('a.perDay')], ['hour', per('a.perHour')]], { aria: t('a.rate') }), { label: '\u00A0' }) + '</div>';
    } else {
      h += '<div class="fg fg-3">' + numf(pre + 'allowed.days', 'a.days', p.allowed.days) + numf(pre + 'allowed.hours', 'a.hours', p.allowed.hours) + numf(pre + 'allowed.minutes', 'a.minutes', p.allowed.minutes) + '</div>';
    }
    h += '<p class="f-out" id="alw-' + i + '"></p>';
    if (c.laytimeMode === 'reversible' && c.ports.length > 1 && i === 0) h += '<p class="f-hint">' + esc(t('a.poolHint')) + '</p>';
    h += '</div>';

    // working time
    const excepts = cal.preset !== 'SHINC';
    h += '<div class="blk"><div class="blk-h">' + esc(t('c.title')) + '</div><div class="fg">' +
      fld(pre + 'calendar.preset', 'c.preset', sel(pre + 'calendar.preset', cal.preset, M.CAL_PRESETS.map((k) => [k, t('c.' + k)]), { rr: 1 }), { cls: 'f-2' });
    if (excepts) {
      h += fld(pre + 'calendar.unlessUsed', 'c.uu', sel(pre + 'calendar.unlessUsed', String(cal.unlessUsed), [['false', t('c.uu.false')], ['true', t('c.uu.true')]], { type: 'bool' }), { cls: 'f-2' });
    }
    h += '</div>';
    if (cal.preset === 'CUSTOM') {
      const dows = [1, 2, 3, 4, 5, 6, 0].map((d) => [d, t('dow.' + d)]);
      h += '<div class="fg fg-3">' +
        fld(pre + 'calendar.weekly.fromDow', 'c.weeklyFrom', sel(pre + 'calendar.weekly.fromDow', cal.weekly.fromDow, dows, { type: 'int' })) +
        timef(pre + 'calendar.weekly.fromTime', 'c.weeklyFrom', cal.weekly.fromTime, { label: '\u00A0', aria: t('c.weeklyFrom') }) +
        fld(pre + 'calendar.weekly.toDow', 'c.weeklyTo', sel(pre + 'calendar.weekly.toDow', cal.weekly.toDow, dows, { type: 'int' })) +
        timef(pre + 'calendar.weekly.toTime', 'c.weeklyTo', cal.weekly.toTime, { label: '\u00A0', aria: t('c.weeklyTo') }) + '</div>' +
        ck(pre + 'calendar.holidaysExcluded', cal.holidaysExcluded, t('c.holExcluded'), { rr: 1 });
    }
    if (excepts && (cal.preset !== 'CUSTOM' || cal.holidaysExcluded)) {
      h += '<div class="blk-h">' + esc(t('c.holidays')) + '</div>';
      if (!cal.holidays.length) h += '<p class="empty">' + esc(t('c.holNone')) + '</p>';
      cal.holidays.forEach((hd, j) => {
        const hp = pre + 'calendar.holidays.' + j + '.';
        h += '<div class="hol">' + inp(hp + 'date', hd.date, { type: 'date', aria: t('c.holDate') }) + inp(hp + 'name', hd.name, { placeholder: t('c.holName'), max: 60, aria: t('c.holName') }) +
          '<button type="button" class="btn btn-sm btn-ghost btn-icon" data-act="del-holiday" data-port="' + i + '" data-idx="' + j + '" aria-label="' + esc(t('saved.delete')) + '">✕</button></div>';
      });
      h += '<div><button type="button" class="btn btn-sm" data-act="add-holiday" data-port="' + i + '">+ ' + esc(t('c.holAdd')) + '</button></div>' +
        '<details class="adv"' + (cal.holidayFromPrev || cal.holidayToNext ? ' open' : '') + '><summary>' + esc(t('c.advanced')) + '</summary><div class="fg">' +
        timef(pre + 'calendar.holidayFromPrev', 'c.holFromPrev', cal.holidayFromPrev) + timef(pre + 'calendar.holidayToNext', 'c.holToNext', cal.holidayToNext) + '</div></details>';
    }
    h += '</div>';

    // NOR and commencement
    h += '<div class="blk"><div class="blk-h">' + esc(t('n.title')) + '</div><div class="fg">' +
      dtf(pre + 'nor.tendered', 'n.tendered', n.tendered) +
      fld(pre + 'nor.rule', 'n.rule', sel(pre + 'nor.rule', n.rule, [['turn', t('n.rule.turn')], ['gencon', t('n.rule.gencon')], ['manual', t('n.rule.manual')]], { rr: 1 }), { cls: 'f-2' });
    if (n.rule === 'turn') h += numf(pre + 'nor.turnHours', 'n.turnHours', n.turnHours, { max: 6 });
    if (n.rule === 'gencon') h += timef(pre + 'nor.amStart', 'n.amStart', n.amStart) + timef(pre + 'nor.pmStart', 'n.pmStart', n.pmStart);
    if (n.rule === 'manual') h += dtf(pre + 'nor.manualStart', 'n.manualStart', n.manualStart);
    h += dtf(pre + 'commenced', 'n.commenced', p.commenced) + dtf(pre + 'completed', 'n.completed', p.completed) + '</div>';
    if (n.rule !== 'manual') {
      h += ck(pre + 'nor.unlessSoonerCommenced', n.unlessSoonerCommenced !== false, t('n.sooner')) +
        ck(pre + 'nor.officeHours.enabled', oh.enabled, t('n.office'), { rr: 1 });
      if (oh.enabled) {
        h += '<div class="fg fg-3">' + timef(pre + 'nor.officeHours.from', 'n.ohFrom', oh.from) + timef(pre + 'nor.officeHours.to', 'n.ohTo', oh.to) + timef(pre + 'nor.officeHours.satTo', 'n.satTo', oh.satTo) + '</div>';
      }
    }
    h += '</div>';

    // statement of facts
    h += '<div class="blk"><div class="blk-h">' + esc(t('e.title')) + '</div>';
    if (!p.events.length) h += '<p class="empty">' + esc(t('e.empty')) + '</p>';
    p.events.forEach((ev, j) => { h += eventHTML(ev, i, j); });
    h += '<div><button type="button" class="btn btn-sm" data-act="add-event" data-port="' + i + '">+ ' + esc(t('e.add')) + '</button></div></div>';

    if (c.ports.length > 1) {
      h += '<div class="blk">' + (state.confirm === 'port:' + p.id
        ? '<span class="confirm">' + esc(t('p.removeConfirm')) + ' <button type="button" class="btn btn-sm" data-act="del-port-yes" data-port="' + i + '">' + esc(t('common.yes')) +
          '</button><button type="button" class="btn btn-sm btn-ghost" data-act="confirm-cancel">' + esc(t('common.cancel')) + '</button></span>'
        : '<div><button type="button" class="btn btn-sm btn-ghost" data-act="del-port" data-port="' + i + '">' + esc(t('p.remove')) + '</button></div>') + '</div>';
    }
    return h + '</div></details>';
  }

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.id || !$('#form').contains(a)) return null;
    let s = null, e = null;
    try { s = a.selectionStart; e = a.selectionEnd; } catch (x) { /* not a text field */ }
    return { id: a.id, s, e };
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = document.getElementById(f.id);
    if (!el) return;
    el.focus({ preventScroll: true });
    try { if (f.s != null && el.setSelectionRange) el.setSelectionRange(f.s, f.e); } catch (x) { /* date/time inputs */ }
  }

  function renderForm() {
    const c = state.calc, f = captureFocus();
    $$('#form details.port').forEach((d) => { state.open[d.dataset.pid] = d.open; });
    let h = card('sec.fixture', fixtureHTML(c)) + card('sec.terms', termsHTML(c));
    h += '<div class="card-h" style="padding:4px 2px 0"><h2 class="cap">' + esc(t('sec.ports')) + '</h2></div>';
    c.ports.forEach((p, i) => { h += portHTML(p, i); });
    h += '<div><button type="button" class="btn" data-act="add-port">+ ' + esc(t('p.add')) + '</button></div>';
    $('#form').innerHTML = h;
    restoreFocus(f);
    refreshDerived();
  }

  // ---------------------------------------------------------------- derived bits inside the form
  function refreshDerived() {
    const c = state.calc, r = state.result;
    c.ports.forEach((p, i) => {
      const out = document.getElementById('alw-' + i);
      if (out) {
        const m = E.allowedMinutes(p.allowed);
        out.textContent = isNaN(m) ? '' : t('a.equals', { dur: V.fmtDur(m, state.lang), days: V.fmtDays(m, state.lang) });
      }
      const title = document.getElementById('ptitle-' + i);
      if (title) title.textContent = portCap(p, i);
      const chip = document.getElementById('chip-' + i);
      if (chip) chip.innerHTML = r && r.ok && r.ports[i] ? V.portChip(r.ports[i], r.totals, state.lang) : '';
    });
    $$('#form .bad').forEach((el) => el.classList.remove('bad'));
    if (!r) return;
    const mark = (path) => { const el = document.getElementById(idOf(path)); if (el) el.classList.add('bad'); };
    for (const e of r.errors || []) {
      if (e.port == null) continue;
      const pre = 'ports.' + e.port + '.', p = c.ports[e.port];
      if (!p) continue;
      if (e.code === 'nor_missing') mark(pre + 'nor.tendered');
      else if (e.code === 'manual_start_missing') mark(pre + 'nor.manualStart');
      else if (e.code === 'turn_invalid') mark(pre + 'nor.turnHours');
      else if (e.code === 'completed_missing' || e.code === 'end_before_start') mark(pre + 'completed');
      else if (e.code === 'allowed_invalid') ['quantity', 'rate', 'days', 'hours', 'minutes'].forEach((k) => mark(pre + 'allowed.' + k));
      else if (e.code === 'weekly_invalid') ['fromTime', 'toTime'].forEach((k) => mark(pre + 'calendar.weekly.' + k));
      else if (e.event) {
        const j = p.events.findIndex((x) => x.id === e.event);
        if (j < 0) continue;
        if (e.code === 'event_pct_invalid') mark(pre + 'events.' + j + '.countPct');
        else { mark(pre + 'events.' + j + '.from'); mark(pre + 'events.' + j + '.to'); }
      }
    }
  }

  // ---------------------------------------------------------------- results
  function actionsHTML() {
    const ok = state.result && state.result.ok, dis = ok ? '' : ' disabled';
    const proTag = isPro() ? '' : ' <span class="pill pill-pro">Pro</span>';
    let h = '<button type="button" class="btn btn-primary" data-act="statement"' + dis + '>' + esc(t('act.statement')) + '</button>';
    if (!PREVIEW) h += '<button type="button" class="btn btn-sm" data-act="share"' + dis + '>' + esc(t('act.share')) + '</button>';
    h += '<button type="button" class="btn btn-sm" data-act="copy-summary"' + dis + '>' + esc(t('act.copyText')) + '</button>';
    if (!PREVIEW) {
      h += '<button type="button" class="btn btn-sm" data-act="csv"' + dis + '>' + esc(t('act.csv')) + proTag + '</button>' +
        '<button type="button" class="btn btn-sm" data-act="json">' + esc(t('act.json')) + proTag + '</button>' +
        '<button type="button" class="btn btn-sm" data-act="open-file">' + esc(t('act.open')) + '</button>';
    }
    return h;
  }

  function renderResult() {
    const c = state.calc, r = state.result;
    $('#summary').innerHTML = V.summaryHTML(c, r, state.lang);
    $('#timelines').innerHTML = r.ok ? r.ports.map((p) => V.timelineHTML(p, state.lang)).join('') : '';
    $('#actions').innerHTML = actionsHTML();
    $('#sheet-sec').hidden = !r.ok;
    $('#sheet').innerHTML = V.sheetHTML(c, r, state.lang);
    refreshDerived();
    if (state.stOpen) renderStatement();
  }

  let saveTimer = null, shareTimer = null;
  function recalc() {
    state.result = E.compute(state.calc);
    renderResult();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set(K.current, { calc: state.calc, calcId: state.calcId, source: state.source, exampleId: state.exampleId, pristine: state.pristine });
    }, 400);
    clearTimeout(shareTimer);
    shareTimer = setTimeout(() => { encodeShare(state.calc).then((s) => { state.shareHash = s; }).catch(() => { state.shareHash = ''; }); }, 300);
  }

  // ---------------------------------------------------------------- share links (#c=…)
  const b64u = (bytes) => L.bytesToB64u(bytes);
  async function encodeShare(calc) {
    const json = JSON.stringify(calc);
    if (typeof CompressionStream === 'function') {
      const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
      return 'z' + b64u(new Uint8Array(buf));
    }
    return 'j' + b64u(new TextEncoder().encode(json));
  }
  async function decodeShare(s) {
    const bytes = L.b64uToBytes(s.slice(1));
    if (s[0] === 'z') {
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      return JSON.parse(new TextDecoder().decode(buf));
    }
    if (s[0] === 'j') return JSON.parse(new TextDecoder().decode(bytes));
    throw new Error('unknown share format');
  }
  async function loadFromHash() {
    const m = /^#c=([zj][A-Za-z0-9_-]{4,200000})$/.exec(location.hash || '');
    if (!m) return false;
    try {
      const data = await decodeShare(m[1]);
      setCalc(M.normalizeCalc(data), { source: 'shared' });
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ }
      return true;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- calculation lifecycle
  function setCalc(calc, meta) {
    meta = meta || {};
    state.calc = calc;
    state.calcId = meta.calcId || null;
    state.source = meta.source || 'blank';
    state.exampleId = meta.exampleId || null;
    state.pristine = meta.pristine !== false;
    state.open = {};
    state.confirm = null;
    renderBanner();
    renderForm();
    recalc();
  }
  function loadExample(id) {
    const ex = M.examples(state.lang).find((x) => x.id === id) || M.examples(state.lang)[0];
    setCalc(ex.calc, { source: 'example', exampleId: ex.id });
  }
  function snapshot() {
    return { calc: JSON.parse(JSON.stringify(state.calc)), calcId: state.calcId, source: state.source, exampleId: state.exampleId, pristine: state.pristine };
  }
  function touched() {
    if (!state.pristine) return;
    state.pristine = false;
    if (state.source === 'example') { state.source = 'edited'; renderBanner(); }
  }

  // ---------------------------------------------------------------- banner, header, menus
  function renderBanner() {
    let h = '';
    if (PREVIEW) h += '<div class="b-plain"><p>' + esc(t('banner.preview')) + '</p></div>';
    if (state.source === 'example') {
      h += '<div><p>' + esc(t('banner.example')) + '</p><button type="button" class="btn btn-sm" data-act="new">' + esc(t('banner.startNew')) + '</button></div>';
    } else if (state.source === 'shared') {
      h += '<div class="b-plain"><p>' + esc(t('banner.shared')) + '</p><button type="button" class="btn btn-sm" data-act="save">' + esc(t('nav.save')) + '</button></div>';
    }
    $('#banner').innerHTML = h;
  }

  function renderHeader() {
    $('#langs').innerHTML = I.LANGS.map((l) => '<button type="button" data-act="lang" data-lang="' + l + '" aria-pressed="' + (l === state.lang) + '" title="' + esc(I.t(l, 'lang.name')) + '">' + esc(I.LANG_LABELS[l]) + '</button>').join('');
    const s = lic.get(), b = $('#lic');
    if (s.pro) { b.className = 'lic pill pill-lay'; b.textContent = 'Pro' + (s.licensee ? ' · ' + s.licensee.slice(0, 28) : ''); }
    else { b.className = 'lic pill pill-pro'; b.textContent = t('nav.upgrade'); }
  }
  function applyI18n() {
    document.documentElement.lang = state.lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    if (!PREVIEW) document.title = t('app.tagline') + ' — Stalia';
  }

  const getSaved = () => { const a = store.get(K.saved, []); return Array.isArray(a) ? a.filter((x) => x && x.id && x.calc) : []; };
  function renderMenus() {
    $('#examples-list').innerHTML = M.examples(state.lang).map((ex) =>
      '<div class="mi"><button type="button" class="mi-main" data-act="example" data-id="' + ex.id + '"><b>' + esc(ex.title) + '</b><small>' + esc(ex.calc.meta.cpForm) + '</small></button></div>').join('');
    const list = getSaved();
    $('#saved-list').innerHTML = list.length ? list.map((x) => {
      const when = V.fmtDate(Math.round((x.updatedAt || 0) / 60000) - new Date().getTimezoneOffset(), state.lang);
      return '<div class="mi"><button type="button" class="mi-main" data-act="open-saved" data-id="' + esc(x.id) + '"><b>' + esc(x.name || t('saved.untitled')) + '</b><small>' + esc(t('saved.updated', { date: when })) + '</small></button>' +
        (state.confirm === 'saved:' + x.id
          ? '<button type="button" class="btn btn-sm" data-act="del-saved-yes" data-id="' + esc(x.id) + '">' + esc(t('saved.deleteConfirm')) + '</button>'
          : '<button type="button" class="btn btn-sm btn-ghost btn-icon" data-act="del-saved" data-id="' + esc(x.id) + '" aria-label="' + esc(t('saved.delete')) + '" title="' + esc(t('saved.delete')) + '">✕</button>') + '</div>';
    }).join('') : '<p>' + esc(t('saved.empty')) + '</p>';
  }
  const closeMenus = (except) => $$('details.menu[open]').forEach((d) => { if (d !== except) d.removeAttribute('open'); });

  // ---------------------------------------------------------------- toast, clipboard, downloads
  let toastTimer = null;
  function toast(text, action) {
    const el = $('#toast');
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', () => { el.hidden = true; action.fn(); });
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3200);
  }
  function copyText(text, okKey) {
    const fallback = () => {
      const d = $('#dlg');
      d.innerHTML = '<div class="dlg-h"><h2>' + esc(t('act.copyText')) + '</h2><button type="button" class="btn btn-sm" data-act="dlg-close">' + esc(t('common.close')) + '</button></div>' +
        '<div class="dlg-b"><p class="note note-warn">' + esc(t('toast.copyFailed')) + '</p><textarea id="copy-area" rows="8" readonly></textarea></div>';
      $('#copy-area').value = text;
      if (!d.open) d.showModal();
      $('#copy-area').select();
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast(t(okKey || 'toast.copied')), fallback);
    } catch (e) { fallback(); }
  }
  function download(name, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileStem = () => ('stalia-' + (state.calc.name || state.calc.meta.vessel || 'laytime')).toLowerCase().replace(/[^a-z0-9а-яёәғқңөұүһі]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'stalia';

  // ---------------------------------------------------------------- statement overlay
  const getBrand = () => { const b = store.get(K.brand, {}); return b && typeof b === 'object' ? b : {}; };
  function renderStatement() {
    const site = CFG.siteUrl || (/^https?:/.test(location.protocol) && !PREVIEW ? location.origin : '');
    $('#st-paper').innerHTML = V.statementHTML(state.calc, state.result, state.stLang || state.lang, { pro: isPro(), brand: getBrand(), siteUrl: site, today: todayStr() });
  }
  function renderStatementSide() {
    const b = getBrand(), pro = isPro();
    const logoOk = /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.logo || '');
    $('#st-lang').innerHTML = I.LANGS.map((l) => '<option value="' + l + '"' + (l === (state.stLang || state.lang) ? ' selected' : '') + '>' + esc(I.t(l, 'lang.name')) + '</option>').join('');
    $('#btn-print').hidden = PREVIEW;
    $('#st-side').innerHTML =
      '<fieldset' + (pro ? '' : ' disabled') + '><legend>' + esc(t('st.brand')) + (pro ? '' : ' <span class="pill pill-pro">Pro</span>') + '</legend>' +
      '<div class="f"><label class="f-l" for="br-company">' + esc(t('st.brand.company')) + '</label><input id="br-company" data-brand="company" maxlength="120" value="' + esc(b.company || '') + '"></div>' +
      '<div class="f"><label class="f-l" for="br-details">' + esc(t('st.brand.details')) + '</label><textarea id="br-details" data-brand="details" maxlength="300" rows="2">' + esc(b.details || '') + '</textarea></div>' +
      '<div class="f"><span class="f-l">' + esc(t('st.brand.logo')) + '</span><div class="logo-row">' + (logoOk ? '<img src="' + b.logo + '" alt="">' : '') +
      '<label class="btn btn-sm">' + esc(t('st.brand.logoPick')) + '<input type="file" id="br-logo" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
      (logoOk ? '<button type="button" class="btn btn-sm btn-ghost" data-act="logo-remove">' + esc(t('st.brand.logoRemove')) + '</button>' : '') + '</div></div></fieldset>' +
      (pro ? '' : '<p class="f-hint">' + esc(t('st.brand.proOnly')) + ' <button type="button" class="btn btn-sm" data-act="pro">' + esc(t('nav.upgrade')) + '</button></p>') +
      '<fieldset><legend>' + esc(t('st.remarks')) + '</legend><textarea id="' + idOf('meta.remarks') + '" data-path="meta.remarks" maxlength="2000" rows="4" aria-label="' + esc(t('st.remarks')) + '">' + esc(state.calc.meta.remarks || '') + '</textarea></fieldset>';
  }
  function openStatement() {
    if (!state.result || !state.result.ok) return;
    state.stOpen = true;
    state.stLang = state.stLang || state.lang;
    renderStatementSide();
    renderStatement();
    const el = $('#statement');
    el.hidden = false; el.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }
  function closeStatement() {
    state.stOpen = false;
    $('#statement').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------------------------------------------------------------- Pro dialog
  function priceText(period) {
    const p = CFG.pricing || {}, local = state.lang !== 'en' && p.kzt, src = local ? p.kzt : (p.usd || {});
    const v = src[period];
    if (v == null) return '';
    return local ? V.fmtNumber(v, state.lang, 0) + ' ₸' : '$' + V.fmtNumber(v, 'en', 0);
  }
  function renderPro(notice) {
    const s = lic.get(), d = $('#dlg'), co = CFG.checkout || {}, email = CFG.contactEmail || '';
    let h = '<div class="dlg-h"><h2>' + esc(t('pro.title')) + '</h2><button type="button" class="btn btn-sm" data-act="dlg-close">' + esc(t('common.close')) + '</button></div><div class="dlg-b">';
    if (notice) h += '<p class="note note-warn">' + esc(notice) + '</p>';
    if (s.pro) {
      h += '<p class="note note-ok">' + esc(t('pro.active')) + '</p>';
      if (s.status === 'grace') h += '<p class="note note-warn">' + esc(t('pro.status.grace')) + '</p>';
      h += '<dl class="kv"><dt>' + esc(t('pro.licensee')) + '</dt><dd>' + esc(s.licensee || '—') + '</dd><dt>' + esc(t('pro.plan')) + '</dt><dd>' + esc(s.plan || 'Pro') + '</dd><dt>' + esc(t('pro.expires')) + '</dt><dd>' +
        esc(s.expires ? V.fmtDate(E.parseDT(s.expires), state.lang) : t('pro.noExpiry')) + '</dd></dl>' +
        '<div><button type="button" class="btn btn-sm" data-act="lic-remove">' + esc(t('pro.remove')) + '</button></div>';
    } else {
      if (s.status === 'expired') h += '<p class="note note-warn">' + esc(t('pro.status.expired')) + '</p>';
      else if (s.error === 'offline_too_long') h += '<p class="note note-warn">' + esc(t('pro.err.offline_too_long')) + '</p>';
      h += '<p>' + esc(t('pro.lead')) + '</p><ul>' + ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((k) => '<li>' + esc(t('pro.' + k)) + '</li>').join('') + '</ul><div class="plans">';
      [['monthly', 'pro.monthly', 'pro.perMonth', co.monthlyUrl, 'pro.buyMonthly'], ['yearly', 'pro.yearly', 'pro.perYear', co.yearlyUrl, 'pro.buyYearly']].forEach((x) => {
        const price = priceText(x[0]);
        h += '<div class="plan"><h3>' + esc(t(x[1])) + '</h3>' + (price ? '<p class="price">' + esc(price) + ' <small>' + esc(t(x[2])) + '</small></p>' : '') +
          (/^https:\/\//.test(x[3] || '') ? '<a class="btn btn-primary" href="' + esc(x[3]) + '" target="_blank" rel="noopener">' + esc(t(x[4])) + '</a>' : '') + '</div>';
      });
      h += '</div>';
      if (email) {
        const hasCheckout = /^https:\/\//.test(co.monthlyUrl || '') || /^https:\/\//.test(co.yearlyUrl || '');
        h += '<div><p>' + esc(hasCheckout ? t('pro.invoice', { email }) : t('pro.contact')) + '</p><p class="copyline"><code id="contact-email">' + esc(email) + '</code>' +
          '<button type="button" class="btn btn-sm" data-act="copy-email">' + esc(t('common.copy')) + '</button>' +
          (CFG.telegram ? '<a class="btn btn-sm" href="https://t.me/' + esc(String(CFG.telegram).replace(/^@/, '')) + '" target="_blank" rel="noopener">Telegram</a>' : '') + '</p></div>';
      }
      h += '<div class="keybox"><label class="f-l" for="lic-key"><b>' + esc(t('pro.haveKey')) + '</b></label><textarea id="lic-key" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="' + esc(t('pro.keyPlaceholder')) + '"></textarea>' +
        '<div id="lic-msg"></div><div><button type="button" class="btn btn-primary" data-act="lic-activate" id="lic-btn">' + esc(t('pro.activate')) + '</button></div></div>';
    }
    d.innerHTML = h + '</div>';
    if (!d.open) d.showModal();
  }
  /** @returns {Promise<string>} empty string on success, otherwise the message shown to the user */
  async function activateKey(key, quiet) {
    const btn = $('#lic-btn'), msg = $('#lic-msg');
    if (btn) { btn.disabled = true; btn.textContent = t('pro.activating'); }
    const r = await lic.activate(key);
    if (r.ok) {
      toast(t('toast.licenseOk'));
      if ($('#dlg').open) renderPro();
      return '';
    }
    if (btn) { btn.disabled = false; btn.textContent = t('pro.activate'); }
    const text = t('pro.err.' + r.error);
    if (msg) { msg.innerHTML = '<p class="note note-err">' + esc(text) + '</p>'; } else if (!quiet) toast(text);
    return text;
  }
  function needPro(noticeKey, vars) {
    if (isPro()) return false;
    renderPro(t(noticeKey || 'toast.proNeeded', vars));
    return true;
  }

  // ---------------------------------------------------------------- actions
  function smartEventStart(p, i) {
    const last = p.events.filter((e) => e.to).slice(-1)[0];
    const r = state.result;
    const base = (last && last.to) || p.commenced || (r && r.ok && r.ports[i] ? E.fmtDT(r.ports[i].start) : '') || p.nor.tendered || '';
    const m = E.parseDT(base);
    return m == null ? ['', ''] : [E.fmtDT(m), E.fmtDT(m + 60)];
  }
  const isDefaultDesc = (desc, typeId) => !desc || I.LANGS.some((l) => I.t(l, 'et.d.' + typeId) === desc);

  const actions = {
    lang(el) {
      const l = el.dataset.lang;
      if (!I.STRINGS[l] || l === state.lang) return;
      state.lang = l; store.set(K.lang, l);
      applyI18n(); renderHeader(); renderMenus();
      if (state.source === 'example' && state.pristine) loadExample(state.exampleId);
      else { renderBanner(); renderForm(); recalc(); }
      if (state.stOpen) { renderStatementSide(); renderStatement(); }
    },
    new() {
      const prev = snapshot();
      setCalc(M.blankCalc(), { source: 'blank' });
      toast(t('toast.newStarted'), { label: t('common.undo'), fn: () => setCalc(prev.calc, prev) });
    },
    example(el) { closeMenus(); loadExample(el.dataset.id); },
    save() {
      const list = getSaved(), idx = list.findIndex((x) => x.id === state.calcId);
      if (idx < 0 && !isPro() && list.length >= FREE.maxSaved) { renderPro(t('saved.limit', { n: FREE.maxSaved })); return; }
      const rec = { id: idx >= 0 ? state.calcId : M.uid('c'), name: state.calc.name || state.calc.meta.vessel || '', updatedAt: Date.now(), calc: state.calc };
      if (idx >= 0) list[idx] = rec; else list.unshift(rec);
      if (!store.set(K.saved, list)) { toast(t('toast.saveFailed')); return; }
      state.calcId = rec.id; state.source = 'saved'; state.pristine = false;
      renderBanner(); renderMenus(); recalc();
      toast(t('toast.saved'));
    },
    'open-saved'(el) {
      const rec = getSaved().find((x) => x.id === el.dataset.id);
      closeMenus();
      if (rec) setCalc(M.normalizeCalc(rec.calc), { source: 'saved', calcId: rec.id, pristine: false });
    },
    'del-saved'(el) { state.confirm = 'saved:' + el.dataset.id; renderMenus(); },
    'del-saved-yes'(el) {
      store.set(K.saved, getSaved().filter((x) => x.id !== el.dataset.id));
      if (state.calcId === el.dataset.id) state.calcId = null;
      state.confirm = null; renderMenus(); toast(t('toast.deleted'));
    },
    'add-port'() {
      const c = state.calc;
      if (c.ports.length >= M.LIMITS.ports) return;
      if (!isPro() && c.ports.length >= FREE.maxPorts) { renderPro(t('p.addLimit', { n: FREE.maxPorts })); return; }
      const p = M.blankPort(c.ports.length && c.ports[c.ports.length - 1].operation === 'load' ? 'discharge' : 'load');
      const last = c.ports[c.ports.length - 1];
      if (last) { p.calendar = JSON.parse(JSON.stringify(last.calendar)); p.calendar.holidays = []; p.nor = Object.assign(JSON.parse(JSON.stringify(last.nor)), { tendered: '', manualStart: '' }); }
      c.ports.push(p); touched(); renderForm(); recalc();
    },
    'del-port'(el) { state.confirm = 'port:' + state.calc.ports[+el.dataset.port].id; renderForm(); },
    'del-port-yes'(el) { state.calc.ports.splice(+el.dataset.port, 1); state.confirm = null; touched(); renderForm(); recalc(); },
    'confirm-cancel'() { state.confirm = null; renderForm(); renderMenus(); },
    'add-event'(el) {
      const i = +el.dataset.port, p = state.calc.ports[i];
      if (p.events.length >= M.LIMITS.events) return;
      const se = smartEventStart(p, i);
      const ev = M.blankEvent('weather', se[0], se[1]);
      ev.desc = t('et.d.weather');
      p.events.push(ev); touched(); renderForm(); recalc();
      const first = document.getElementById(idOf('ports.' + i + '.events.' + (p.events.length - 1) + '.type'));
      if (first) first.focus();
    },
    'del-event'(el) { state.calc.ports[+el.dataset.port].events.splice(+el.dataset.idx, 1); touched(); renderForm(); recalc(); },
    'add-holiday'(el) {
      const i = +el.dataset.port, hs = state.calc.ports[i].calendar.holidays;
      if (hs.length >= M.LIMITS.holidays) return;
      hs.push({ date: '', name: '' }); touched(); renderForm(); recalc();
      const f = document.getElementById(idOf('ports.' + i + '.calendar.holidays.' + (hs.length - 1) + '.date'));
      if (f) f.focus();
    },
    'del-holiday'(el) { state.calc.ports[+el.dataset.port].calendar.holidays.splice(+el.dataset.idx, 1); touched(); renderForm(); recalc(); },
    statement() { openStatement(); },
    'st-close'() { closeStatement(); },
    print() { window.print(); },
    share() {
      if (!state.shareHash) { toast(t('toast.copyFailed')); return; }
      copyText(location.href.split('#')[0] + '#c=' + state.shareHash, 'toast.linkCopied');
    },
    'copy-summary'() { copyText(V.summaryText(state.calc, state.result, state.lang)); },
    csv() {
      if (needPro()) return;
      download(fileStem() + '.csv', 'text/csv;charset=utf-8', V.sheetCSV(state.calc, state.result, state.lang));
    },
    json() {
      if (needPro()) return;
      download(fileStem() + '.json', 'application/json', JSON.stringify({ stalia: M.VERSION, calc: state.calc }, null, 2));
    },
    'open-file'() { $('#file-open').click(); },
    pro() { renderPro(); },
    'dlg-close'() { $('#dlg').close(); },
    'lic-activate'() { activateKey($('#lic-key').value); },
    'lic-remove'() { lic.remove().then(() => { toast(t('toast.licenseRemoved')); renderPro(); }); },
    'copy-email'() { copyText(CFG.contactEmail || ''); },
    'logo-remove'() { const b = getBrand(); delete b.logo; store.set(K.brand, b); renderStatementSide(); renderStatement(); },
  };

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!e.target.closest('details.menu')) closeMenus();
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (fn) { if (el.tagName !== 'A') e.preventDefault(); fn(el); }
  });
  document.addEventListener('toggle', (e) => { if (e.target.matches && e.target.matches('details.menu') && e.target.open) closeMenus(e.target); }, true);

  const isTextLike = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|file)$/.test(el.type));
  function onField(el) {
    if (el.dataset && el.dataset.brand) {
      const b = getBrand(); b[el.dataset.brand] = el.value.slice(0, 300); store.set(K.brand, b); renderStatement();
      return;
    }
    const path = el.dataset && el.dataset.path;
    if (!path) return;
    if (el.type === 'radio' && !el.checked) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'bool') v = v === 'true';
    else if (el.dataset.type === 'int') v = parseInt(v, 10);
    if (path === 'currency') v = String(v).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    const old = getPath(state.calc, path);
    if (!setPath(state.calc, path, v)) return;
    const m = /^ports\.(\d+)\.events\.(\d+)\.type$/.exec(path);
    if (m) {
      // a new event type brings its own defaults; wording is replaced only if it was still the default one
      const ev = state.calc.ports[+m[1]].events[+m[2]], prev = ev.kind, tp = M.eventType(v);
      if (isDefaultDesc(ev.desc, old)) ev.desc = t('et.d.' + tp.id);
      ev.kind = tp.kind; ev.countPct = String(tp.pct); ev.alsoOnDemurrage = tp.dem;
      if (tp.kind === 'note') ev.to = ''; else if (prev === 'note' && ev.from) ev.to = E.fmtDT(E.parseDT(ev.from) + 60);
    }
    touched();
    if (el.dataset.rr) renderForm();
    recalc();
  }
  document.addEventListener('input', (e) => { if (isTextLike(e.target)) onField(e.target); });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'st-lang') { state.stLang = el.value; renderStatement(); return; }
    if (el.id === 'br-logo') {
      const f = el.files && el.files[0];
      if (!f) return;
      if (f.size > 300 * 1024) { toast(t('st.brand.logoTooBig')); el.value = ''; return; }
      const rd = new FileReader();
      rd.onload = () => { const b = getBrand(); b.logo = String(rd.result); store.set(K.brand, b); renderStatementSide(); renderStatement(); };
      rd.readAsDataURL(f);
      return;
    }
    if (el.id === 'file-open') {
      const f = el.files && el.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const data = JSON.parse(String(rd.result));
          const raw = data && data.calc ? data.calc : data;
          if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ports)) throw new Error('shape');
          setCalc(M.normalizeCalc(raw), { source: 'file', pristine: false });
          toast(t('toast.imported'));
        } catch (x) { toast(t('toast.importFailed')); }
        el.value = '';
      };
      rd.readAsText(f);
      return;
    }
    if (!isTextLike(el)) onField(el);
  });
  $('#form').addEventListener('submit', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.stOpen && !$('#dlg').open) closeStatement(); });
  window.addEventListener('hashchange', () => { loadFromHash(); });

  // Ctrl+P anywhere prints the statement, not the form.
  let printRestore = null;
  window.addEventListener('beforeprint', () => {
    if (state.stOpen || !state.result || !state.result.ok) return;
    state.stLang = state.stLang || state.lang;
    renderStatement();
    $('#statement').hidden = false;
    printRestore = true;
  });
  window.addEventListener('afterprint', () => { if (printRestore) { $('#statement').hidden = true; printRestore = null; } });

  // time-line tooltips (hover and keyboard focus)
  const tip = $('#tip');
  function showTip(seg) {
    tip.firstElementChild.textContent = seg.dataset.tv || '';
    tip.lastElementChild.textContent = seg.dataset.tt || '';
    tip.hidden = false;
    const r = seg.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 8;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  document.addEventListener('pointerover', (e) => { const s = e.target.closest && e.target.closest('.seg'); if (s) showTip(s); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest && e.target.closest('.seg')) tip.hidden = true; });
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('seg')) showTip(e.target); });
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('seg')) tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, true);

  // ---------------------------------------------------------------- start
  async function start() {
    const storedLang = store.get(K.lang, null);
    state.lang = I.STRINGS[storedLang] ? storedLang : I.detect();
    $('#year').textContent = String(new Date().getFullYear());
    if (PREVIEW) { $('#site-link').hidden = true; $('#brand-link').removeAttribute('href'); }
    applyI18n(); renderHeader(); renderMenus();
    lic.onChange(() => {
      renderHeader();
      if (state.result) $('#actions').innerHTML = actionsHTML();
      if (state.stOpen) { renderStatementSide(); renderStatement(); }
    });

    if (!(await loadFromHash())) {
      const cur = store.get(K.current, null);
      if (cur && cur.calc && Array.isArray(cur.calc.ports)) {
        if (cur.source === 'example' && cur.pristine !== false) loadExample(cur.exampleId);
        else setCalc(M.normalizeCalc(cur.calc), { source: cur.source === 'shared' ? 'edited' : cur.source, calcId: cur.calcId, exampleId: cur.exampleId, pristine: cur.pristine });
      } else loadExample('bulk');
    }

    await lic.init();
    renderHeader();
    // "?license_key=…" — the link in the purchase e-mail activates Pro in one click
    try {
      const q = new URLSearchParams(location.search), key = q.get('license_key') || q.get('key');
      if (key) {
        q.delete('license_key'); q.delete('key');
        history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
        const problem = await activateKey(key, true);
        if (problem) renderPro(problem);
      }
    } catch (e) { /* sandboxed */ }
  }
  start();

  // for automated checks
  window.__stalia = { state, lic, recalc, setCalc };
})();
