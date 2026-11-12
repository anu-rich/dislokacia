/*! Stalia — calculator screen: state, form, storage, licence UI. */
(function () {
  'use strict';
  const E = window.StaliaEngine, I = window.StaliaI18n, M = window.StaliaModel, V = window.StaliaView, L = window.StaliaLicense;
  const X = window.StaliaExtract, S = window.StaliaSchema, XP = window.StaliaExport, AU = window.StaliaAudit;
  const CFG = window.STALIA_CONFIG || {};
  const PREVIEW = !!CFG.preview; // sandboxed preview: no printing, downloads or share links
  const NATIVE = !!CFG.native;   // packaged Android / iOS app (set by mobile/scripts/build-web.js)
  const STORE = !!CFG.store;     // app-store build: no prices or purchase links inside the app
  const capBridge = () => (NATIVE && window.Capacitor && typeof window.Capacitor.nativePromise === 'function' ? window.Capacitor : null);
  const hasPlugin = (name) => { const c = capBridge(); return !!(c && (c.PluginHeaders || []).some((h) => h.name === name)); };
  const hasNativePrint = () => hasPlugin('StaliaPrint');
  const hasNativeShare = () => hasPlugin('StaliaShare'); // the phone's share sheet, for files and links
  const canPrint = () => !PREVIEW && (!NATIVE || hasNativePrint());
  const canShareFiles = () => {
    try { return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }); } catch (e) { return false; }
  };
  /** Can a file made by the page reach the user: a browser download, the phone's share sheet, or the preview's host. */
  const canSave = () => (PREVIEW ? typeof CFG.saver === 'function' : NATIVE ? hasNativeShare() || canShareFiles() : true);
  const coarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
  const canCopyLink = () => !PREVIEW && (!NATIVE || !!CFG.siteUrl); // a link needs a public address to point at
  const canSendLink = () => canCopyLink() && (NATIVE ? hasNativeShare() || typeof navigator.share === 'function' : typeof navigator.share === 'function' && coarse());
  const FREE = Object.assign({ maxSaved: 3, maxPorts: 2 }, CFG.free || {});
  const esc = V.esc;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // ---------------------------------------------------------------- storage (never throws)
  const K = { current: 'stalia.current.v1', saved: 'stalia.saved.v1', lang: 'stalia.lang', brand: 'stalia.brand.v1', seen: 'stalia.welcome.v1', trialEnd: 'stalia.trialEndSeen' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  const state = {
    lang: 'en', calc: null, result: null, calcId: null,
    source: 'example', exampleId: null, pristine: true,
    stLang: null, stOpen: false, open: {}, confirm: null, shareHash: '', undo: null,
    notes: [], // what to check after a calculation was read from documents: [{field, port, status, comment}]
    cloud: null,     // the calculation's place in the company space: { id, base, head, role, guest, … } (see space.js)
    contractId: '',  // the contract of the space this voyage is counted under
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
      txt('meta.cargo', 'f.cargo', c.meta.cargo, { cls: 'f-2', max: 160 }) +
      // what the other side's own calculation comes to: the result then shows the gap and what could explain it
      numf('meta.claimAmount', 'f.claim', c.meta.claimAmount, { cls: 'f-2', hint: t('f.claim.hint') }) + '</div>';
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
    // the contract's own rules in words: filled in when a charter party is read, handed back with later time sheets
    h += '<div class="f-clauses" style="margin-top:12px"><label class="f-l" for="' + idOf('meta.clauses') + '">' + esc(t('t.clauses')) + '</label>' +
      '<textarea id="' + idOf('meta.clauses') + '" data-path="meta.clauses" maxlength="3000" rows="' + (c.meta.clauses ? Math.min(8, 2 + c.meta.clauses.split('\n').length) : 2) + '">' + esc(c.meta.clauses || '') + '</textarea>' +
      '<p class="f-hint">' + esc(t('t.clauses.hint')) + '</p></div>';
    // how the contract counts each kind of delay: decided once here, applied to every event of that kind
    const taken = c.rules.map((r) => r.type);
    h += '<div class="f-rules" id="' + idOf('rules') + '" tabindex="-1"><span class="f-l">' + esc(t('t.rules')) + '</span>';
    c.rules.forEach((r, k) => {
      const rp = 'rules.' + k + '.';
      h += '<div class="rule">' +
        fld(rp + 'type', 'e.type', sel(rp + 'type', r.type, M.RULE_TYPES.filter((x) => x === r.type || taken.indexOf(x) < 0).map((x) => [x, t('et.' + x)]), { rr: 1 }), { cls: 'rule-type' }) +
        numf(rp + 'countPct', 'e.pct', r.countPct, { max: 6, cls: 'rule-pct' }) +
        ck(rp + 'alsoOnDemurrage', r.alsoOnDemurrage, t('e.dem'), { rr: 1 }) +
        '<button type="button" class="btn btn-sm btn-ghost btn-icon" data-act="del-rule" data-idx="' + k + '" aria-label="' + esc(t('t.rules.remove')) + '" title="' + esc(t('t.rules.remove')) + '">✕</button></div>';
    });
    if (c.rules.length < M.RULE_TYPES.length) h += '<button type="button" class="btn btn-sm" data-act="add-rule">+ ' + esc(t('t.rules.add')) + '</button>';
    h += '<p class="f-hint">' + esc(t('t.rules.hint')) + '</p></div>';
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
      fld(pre + 'nor.rule', 'n.rule', sel(pre + 'nor.rule', n.rule, [['turn', t('n.rule.turn')], ['gencon', t('n.rule.gencon')], ['nextday', t('n.rule.nextday')], ['manual', t('n.rule.manual')]], { rr: 1 }), { cls: 'f-2' });
    if (n.rule === 'turn') h += numf(pre + 'nor.turnHours', 'n.turnHours', n.turnHours, { max: 6 });
    if (n.rule === 'gencon') h += timef(pre + 'nor.amStart', 'n.amStart', n.amStart) + timef(pre + 'nor.pmStart', 'n.pmStart', n.pmStart);
    if (n.rule === 'nextday') h += timef(pre + 'nor.nextDayStart', 'n.nextDayStart', n.nextDayStart);
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
    $$('#form .chk').forEach((el) => el.classList.remove('chk'));
    for (const n of state.notes) {
      const path = X.notePath(n, c), el = path && document.getElementById(idOf(path));
      if (el) el.classList.add('chk');
    }
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
    const files = canSave();
    if (XP && files) {
      h += '<button type="button" class="btn btn-sm" data-act="word"' + dis + '>Word</button>' +
        '<button type="button" class="btn btn-sm" data-act="excel"' + dis + '>Excel</button>';
    }
    if (canSendLink()) h += '<button type="button" class="btn btn-sm" data-act="send-link"' + dis + '>' + esc(t('act.sendLink')) + '</button>';
    if (canCopyLink()) h += '<button type="button" class="btn btn-sm" data-act="share"' + dis + '>' + esc(t('act.share')) + '</button>';
    h += '<button type="button" class="btn btn-sm" data-act="copy-summary"' + dis + '>' + esc(t('act.copyText')) + '</button>';
    if (files) {
      h += '<button type="button" class="btn btn-sm" data-act="csv"' + dis + '>' + esc(t('act.csv')) + proTag + '</button>' +
        '<button type="button" class="btn btn-sm" data-act="json">' + esc(t('act.json')) + proTag + '</button>';
    }
    if (!PREVIEW) h += '<button type="button" class="btn btn-sm" data-act="open-file">' + esc(t('act.open')) + '</button>';
    return h;
  }

  function renderResult() {
    const c = state.calc, r = state.result;
    $('#summary').innerHTML = V.summaryHTML(c, r, state.lang);
    $('#claim').innerHTML = claimHTML();
    $('#timelines').innerHTML = r.ok ? r.ports.map((p) => V.timelineHTML(p, state.lang)).join('') : '';
    $('#actions').innerHTML = actionsHTML();
    $('#sheet-sec').hidden = !r.ok;
    $('#sheet').innerHTML = V.sheetHTML(c, r, state.lang);
    refreshDerived();
    if (state.stOpen) renderStatement();
  }

  // ---------------------------------------------------------------- our figure next to the counterparty's
  const claimed = () => { const v = state.calc.meta.claimAmount; return String(v == null ? '' : v).trim() === '' ? NaN : E.num(v); };
  const signedMoney = (v, cur) => (v < 0 ? '−' : '') + V.fmtMoney(Math.abs(v), cur, state.lang);
  function claimHTML() {
    const c = state.calc, r = state.result, theirs = claimed();
    if (!r || !r.ok || isNaN(theirs)) return '';
    const gap = Math.round((theirs - AU.signedNet(c)) * 100) / 100, same = Math.abs(gap) < 0.005;
    return '<div class="claim"><div><span class="claim-l">' + esc(t('cl.theirs')) + '</span><b>' + esc(signedMoney(theirs, c.currency)) + '</b></div>' +
      '<div><span class="claim-l">' + esc(t('cl.gap')) + '</span><b class="' + (same ? 'same' : gap > 0 ? 'up' : 'down') + '" id="claim-gap">' +
      esc(same ? t('cl.same') : (gap > 0 ? '+' : '−') + V.fmtMoney(Math.abs(gap), c.currency, state.lang)) + '</b></div>' +
      (same ? '' : '<button type="button" class="btn btn-sm" data-act="claim-why">' + esc(t('cl.why')) + '</button>') + '</div>';
  }
  /** Which change to our own calculation would give their amount: single changes first, then one moment moved. */
  function claimWhyHTML() {
    const c = state.calc, x = AU.explain(c, claimed());
    if (!x) return '';
    const lang = state.lang, at = (v) => V.fmtDT(E.parseDT(v), lang), dur = (m) => V.fmtDur(Math.abs(m), lang);
    const port = (i) => (i == null || !c.ports[i] ? '' : t('p.port', { n: i + 1 }) + (c.ports[i].name ? ' (' + c.ports[i].name + ')' : '') + ': ');
    const what = (l) => (!l ? '' : l.what === 'nor' ? t('cl.w.nor') : l.what === 'commenced' ? t('cl.w.commenced') : (l.desc || t('et.' + l.type)));
    const line = (k) => {
      if (k.kind === 'start_at' || k.kind === 'end_at') return port(k.port) + t('cl.k.' + k.kind, { at: at(k.value), what: what(k.label) });
      if (k.kind === 'notice_hours') return port(k.port) + t('cl.k.notice_hours', { h: k.value });
      if (!k.event) return t('cl.k.' + k.kind);
      return port(k.port) + t('cl.k.' + k.kind, { ev: '«' + (k.event.desc || t('et.' + k.event.type)) + '» (' + at(k.event.from) + ' – ' + at(k.event.to) + ')' });
    };
    let h = '<div class="dlg-h"><h2>' + esc(t('cl.why')) + '</h2><button type="button" class="btn btn-sm" data-act="dlg-close">' + esc(t('common.close')) + '</button></div><div class="dlg-b" id="claim-why">' +
      '<p>' + esc(t('cl.why.sum', { ours: signedMoney(x.ours, c.currency), theirs: signedMoney(x.claimed, c.currency), gap: (x.gap > 0 ? '+' : '−') + V.fmtMoney(Math.abs(x.gap), c.currency, lang) })) +
      (x.gapMin ? ' ' + esc(t('cl.why.time', { dur: dur(x.gapMin) })) : '') + '</p>';
    if (x.matches.length) h += '<p><b>' + esc(t('cl.why.matches')) + '</b></p><ul class="cl-list" id="claim-matches">' + x.matches.map((m) => '<li>' + esc(m.kinds.map(line).join('; ')) + '</li>').join('') + '</ul>';
    else h += '<p id="claim-none">' + esc(t('cl.why.none')) + '</p>';
    if (x.shifts.length) {
      h += '<p><b>' + esc(t('cl.why.shifts')) + '</b></p><ul class="cl-list" id="claim-shifts">' + x.shifts.map((sh) => '<li>' +
        esc(port(sh.port) + t(sh.kind === 'start_shift' ? 'cl.s.start' : 'cl.s.end', { at: at(sh.at), dur: dur(sh.byMin), dir: t(sh.byMin > 0 ? 'cl.later' : 'cl.earlier') })) + '</li>').join('') + '</ul>';
    }
    if (x.rate) h += '<p>' + esc(t('cl.why.rate', { rate: V.fmtMoney(x.rate, c.currency, lang) })) + '</p>';
    return h + '<p class="f-hint">' + esc(t('cl.why.hint')) + '</p></div>';
  }

  let saveTimer = null, shareTimer = null;
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    if (state.calc) store.set(K.current, { calc: state.calc, calcId: state.calcId, source: state.source, exampleId: state.exampleId, pristine: state.pristine, notes: state.notes, cloud: state.cloud, contractId: state.contractId });
  }
  // typing without a pause keeps postponing the save: closing or leaving the page must not lose that work
  window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });
  function recalc() {
    state.result = E.compute(state.calc);
    renderResult();
    space.changed();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
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
  /** The calculation carried by a link: "…/app/#c=CODE" on the site, "stalia://c/CODE" for the phone app. */
  const codeOf = (url) => { const m = /(?:#c=|\/c\/)([zj][A-Za-z0-9_-]{4,200000})$/.exec(String(url || '')); return m ? m[1] : ''; };
  /** Show a shared calculation. With `undoable`, whatever was on screen can be brought back. */
  async function openShared(code, undoable) {
    if (!code) return false;
    try {
      const data = await decodeShare(code);
      const prev = undoable && !blankish() ? snapshot() : null;
      setCalc(M.normalizeCalc(data), { source: 'shared', code });
      if (prev) toast(t('toast.linkOpened'), { label: t('common.undo'), fn: () => setCalc(prev.calc, prev) });
      return true;
    } catch (e) { return false; }
  }
  async function loadFromHash() {
    const ok = await openShared(codeOf(location.hash));
    if (ok) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ } }
    return ok;
  }
  // The phone app is opened by a link: at start it asks which one, and while it runs it is told.
  async function openLaunchLink() {
    const c = capBridge();
    if (!c || !hasNativeShare()) return false;
    try { const r = await c.nativePromise('StaliaShare', 'launchUrl', {}); return await openShared(codeOf(r && r.url)); } catch (e) { return false; }
  }
  window.addEventListener('staliaLink', (e) => { openShared(codeOf(e && e.url), true); });
  /** The address a calculation is shared at, or '' while it is not ready. */
  const shareUrl = () => (state.shareHash ? (NATIVE ? String(CFG.siteUrl).replace(/\/+$/, '') + '/app/' : location.href.split('#')[0]) + '#c=' + state.shareHash : '');
  const shareTitle = () => t('share.text', { name: state.calc.name || (state.calc.meta || {}).vessel || t('st.title') });
  /** For somebody who opened a shared link in a browser: the way into the app. */
  function appButton() {
    if (PREVIEW || NATIVE) return '';
    const play = String((CFG.apps || {}).android || ''), id = (/^https:\/\/play\.google\.com\/.*[?&]id=([\w.]+)/.exec(play) || [])[1];
    if (id && state.sharedCode && /Android/i.test(navigator.userAgent)) {
      // opens the calculation in the app when it is installed, the store page when it is not
      return '<a class="btn btn-sm" href="intent://c/' + state.sharedCode + '#Intent;scheme=stalia;package=' + esc(id) +
        ';S.browser_fallback_url=' + encodeURIComponent(play) + ';end">' + esc(t('banner.openApp')) + '</a>';
    }
    return $('#btn-install').hidden ? '' : '<button type="button" class="btn btn-sm" data-act="install">' + esc(t('app.install')) + '</button>';
  }

  // ---------------------------------------------------------------- calculation lifecycle
  function setCalc(calc, meta) {
    meta = meta || {};
    state.calc = calc;
    state.calcId = meta.calcId || null;
    state.source = meta.source || 'blank';
    state.exampleId = meta.exampleId || null;
    state.pristine = meta.pristine !== false;
    state.notes = cleanNotes(meta.notes, calc);
    state.sharedCode = state.source === 'shared' ? meta.code || '' : '';
    state.cloud = meta.cloud && meta.cloud.id ? meta.cloud : null;
    state.contractId = meta.contractId || (state.cloud && state.cloud.contractId) || '';
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
    return { calc: JSON.parse(JSON.stringify(state.calc)), calcId: state.calcId, source: state.source, exampleId: state.exampleId, pristine: state.pristine, notes: state.notes.slice(), cloud: state.cloud, contractId: state.contractId };
  }
  /** Notes come back from storage: keep only well-formed ones that still point at something. */
  function cleanNotes(list, calc) {
    return (Array.isArray(list) ? list : []).filter((n) => n && X.FIELDS[n.field] && S.STATUSES.indexOf(n.status) >= 0 &&
      (n.port == null || (Number.isInteger(n.port) && calc.ports[n.port]))).slice(0, 60)
      .map((n) => ({ field: n.field, port: n.port == null ? null : n.port, status: n.status, comment: String(n.comment || '').slice(0, 400) }));
  }
  /** Nothing of the user's own is on screen: a new, untouched calculation or an untouched example. */
  const blankish = () => state.pristine && (state.source === 'blank' || state.source === 'example');
  function touched() {
    if (!state.pristine) return;
    state.pristine = false;
    if (state.source === 'example') { state.source = 'edited'; renderBanner(); }
  }

  // ---------------------------------------------------------------- banner, header, menus
  function renderBanner() {
    let h = '';
    if (PREVIEW) h += '<div class="b-plain"><p>' + esc(t('banner.preview')) + '</p></div>';
    const fromDocs = '<button type="button" class="btn btn-sm btn-primary" data-act="imp-open">' + esc(t('imp.open')) + '</button>';
    if (state.notes.length || state.source === 'import') {
      h += '<div class="b-notes"><p>' + esc(t('imp.banner')) + '</p><button type="button" class="btn btn-sm" data-act="notes-close">' + esc(t('common.close')) + '</button>' +
        (state.notes.length ? '<div class="b-list"><b>' + esc(t('imp.review.notes')) + '</b><ul class="imp-notes">' +
          state.notes.map((n) => imp.noteHTML(n, state.calc, true)).join('') + '</ul></div>' : '') + '</div>';
    } else if (state.source === 'example') {
      h += '<div><p>' + esc(t('banner.example')) + '</p><button type="button" class="btn btn-sm" data-act="new">' + esc(t('banner.startNew')) + '</button>' + fromDocs + '</div>';
    } else if (state.source === 'blank' && state.pristine) {
      h += '<div class="b-plain"><p>' + esc(t('imp.cta')) + '</p>' + fromDocs + '</div>';
    } else if (state.source === 'shared') {
      h += '<div class="b-plain"><p>' + esc(t('banner.shared')) + '</p><button type="button" class="btn btn-sm" data-act="save">' + esc(t('nav.save')) + '</button>' + appButton() + '</div>';
    }
    $('#banner').innerHTML = h;
  }

  function renderHeader() {
    $('#lang-select').innerHTML = I.LANGS.map((l) => '<option value="' + l + '" lang="' + l + '"' + (l === state.lang ? ' selected' : '') + '>' + esc(I.t(l, 'lang.name')) + '</option>').join('');
    const s = lic.get(), b = $('#lic');
    if (s.pro) { b.className = 'lic pill pill-lay'; b.textContent = s.type === 'trial' ? t('trial.pill', { n: lic.trial().daysLeft }) : 'Pro' + (s.licensee ? ' · ' + s.licensee.slice(0, 28) : ''); }
    else { b.className = 'lic pill pill-pro'; b.textContent = STORE ? 'Pro' : t('nav.upgrade'); }
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
      showDialog();
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
  const b64 = (bytes) => { let str = ''; for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(str); };
  /** Hand a file to the user: the browser downloads it, the phone app opens the share sheet, the preview asks its host. */
  async function saveFile(name, mime, content) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    if (PREVIEW) { await CFG.saver(name, new Blob([bytes], { type: mime })); return; }
    if (NATIVE) {
      const c = capBridge();
      if (c && hasNativeShare()) { await c.nativePromise('StaliaShare', 'file', { name, mime, data: b64(bytes) }); return; }
      await navigator.share({ files: [new File([bytes], name, { type: mime })] });
      return;
    }
    download(name, mime, bytes);
  }
  /** The user changed their mind in the share sheet or the save prompt: nothing to report. */
  const gaveUp = (e) => !!e && (e.name === 'AbortError' || e.code === 'declined');
  const exportFailed = (e) => { if (!gaveUp(e)) toast(t('toast.exportFailed')); };
  /** The site's address for the footer of a document; the phone app and the preview have none of their own. */
  const siteAddress = () => CFG.siteUrl || (/^https?:/.test(location.protocol) && !PREVIEW && !NATIVE ? location.origin : '');
  /** Word and Excel cannot show a WebP logo: it is redrawn as PNG. Anything else goes as it is. */
  function exportBrand() {
    const b = Object.assign({}, getBrand());
    if (!isPro() || !/^data:image\/webp;base64,/.test(b.logo || '')) return Promise.resolve(b);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          b.logo = c.toDataURL('image/png');
        } catch (e) { delete b.logo; }
        resolve(b);
      };
      img.onerror = () => { delete b.logo; resolve(b); };
      img.src = b.logo;
    });
  }
  /** The statement as a Word document or the time sheet as a live Excel workbook, in the statement's language. */
  async function exportFile(kind) {
    if (!XP || !state.result || !state.result.ok) return;
    try {
      const opts = { pro: isPro(), brand: await exportBrand(), siteUrl: siteAddress(), today: todayStr() };
      const lang = state.stLang || state.lang;
      const bytes = kind === 'docx' ? XP.docx(state.calc, state.result, lang, opts) : XP.xlsx(state.calc, state.result, lang, opts);
      await saveFile(fileStem() + '.' + kind, XP.MIME[kind], bytes);
    } catch (e) { exportFailed(e); }
  }
  const fileStem = () => ('stalia-' + (state.calc.name || state.calc.meta.vessel || 'laytime')).toLowerCase().replace(/[^a-z0-9а-яёәғқңөұүһі]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'stalia';

  // ---------------------------------------------------------------- statement overlay
  const getBrand = () => { const b = store.get(K.brand, {}); return b && typeof b === 'object' ? b : {}; };
  function renderStatement() {
    $('#st-paper').innerHTML = V.statementHTML(state.calc, state.result, state.stLang || state.lang, { pro: isPro(), brand: getBrand(), siteUrl: siteAddress(), today: todayStr() });
    fitPaper();
  }
  /** On a phone the A4 sheet is shown whole, scaled down to the screen (print always uses full size). */
  function fitPaper() {
    const box = $('#st-paper'), paper = box && box.querySelector('.paper');
    if (!paper) return;
    const k = box.clientWidth ? Math.min(1, box.clientWidth / 620) : 1;
    paper.style.zoom = k < 0.999 ? String(Math.round(k * 1000) / 1000) : '';
  }
  window.addEventListener('resize', () => { if (state.stOpen) fitPaper(); });
  function renderStatementSide() {
    const b = getBrand(), pro = isPro();
    const logoOk = /^data:image\/(png|jpeg|webp|gif);base64,/.test(b.logo || '');
    $('#st-lang').innerHTML = I.LANGS.map((l) => '<option value="' + l + '"' + (l === (state.stLang || state.lang) ? ' selected' : '') + '>' + esc(I.t(l, 'lang.name')) + '</option>').join('');
    $('#btn-print').hidden = !canPrint();
    $('#btn-word').hidden = $('#btn-excel').hidden = !(XP && canSave());
    $('#st-side').innerHTML =
      '<fieldset' + (pro ? '' : ' disabled') + '><legend>' + esc(t('st.brand')) + (pro ? '' : ' <span class="pill pill-pro">Pro</span>') + '</legend>' +
      '<div class="f"><label class="f-l" for="br-company">' + esc(t('st.brand.company')) + '</label><input id="br-company" data-brand="company" maxlength="120" value="' + esc(b.company || '') + '"></div>' +
      '<div class="f"><label class="f-l" for="br-details">' + esc(t('st.brand.details')) + '</label><textarea id="br-details" data-brand="details" maxlength="300" rows="2">' + esc(b.details || '') + '</textarea></div>' +
      '<div class="f"><span class="f-l">' + esc(t('st.brand.logo')) + '</span><div class="logo-row">' + (logoOk ? '<img src="' + b.logo + '" alt="">' : '') +
      '<label class="btn btn-sm">' + esc(t('st.brand.logoPick')) + '<input type="file" id="br-logo" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>' +
      (logoOk ? '<button type="button" class="btn btn-sm btn-ghost" data-act="logo-remove">' + esc(t('st.brand.logoRemove')) + '</button>' : '') + '</div></div></fieldset>' +
      (pro ? '' : '<p class="f-hint">' + esc(t('st.brand.proOnly')) + ' <button type="button" class="btn btn-sm" data-act="pro">' + esc(STORE ? 'Pro' : t('nav.upgrade')) + '</button></p>') +
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
    fitPaper();
    document.body.style.overflow = 'hidden';
    overlayOpened('statement');
  }
  function hideStatement() {
    state.stOpen = false;
    $('#statement').hidden = true;
    document.body.style.overflow = '';
  }
  function closeStatement() {
    hideStatement();
    overlayClosed('statement');
  }

  // ---------------------------------------------------------------- overlays and the Back button
  // Each open overlay (statement, dialog) owns one history entry. Back — the phone's button or
  // gesture, or the browser's — closes the top overlay instead of leaving the calculator.
  const overlays = [];
  let skipPop = 0;
  function overlayOpened(name) {
    let pushed = false;
    try { history.pushState({ staliaOverlay: overlays.length + 1 }, ''); pushed = true; } catch (e) { /* sandboxed page */ }
    overlays.push({ name, pushed });
  }
  /** The page itself closed an overlay: drop its history entry too. */
  function overlayClosed(name) {
    let i = -1;
    for (let k = overlays.length - 1; k >= 0; k--) if (overlays[k].name === name) { i = k; break; }
    if (i < 0) return;
    const entry = overlays.splice(i, 1)[0];
    if (entry.pushed) { skipPop++; try { history.back(); } catch (e) { skipPop--; } }
  }
  window.addEventListener('popstate', () => {
    if (skipPop > 0) { skipPop--; return; }
    const top = overlays.pop();
    if (!top) return;
    if (top.name === 'dialog') { if ($('#dlg').open) $('#dlg').close(); }
    else if (top.name === 'redact') imp.hideRedact();
    else if (top.name === 'import') imp.hide();
    else if (top.name === 'space') space.hide();
    else if (top.name === 'help') hideHelp();
    else hideStatement();
  });
  function showDialog() {
    const d = $('#dlg');
    if (d.open) return;
    d.showModal();
    overlayOpened('dialog');
  }
  $('#dlg').addEventListener('close', () => overlayClosed('dialog'));

  // ---------------------------------------------------------------- Pro dialog
  // Prices are shown in tenge only to visitors in Kazakhstan; everyone else sees dollars.
  const IN_KAZAKHSTAN = (() => {
    try { return /^Asia\/(Almaty|Qyzylorda|Qostanay|Aqtobe|Aqtau|Atyrau|Oral)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { return false; }
  })();
  function priceText(period) {
    const p = CFG.pricing || {}, local = IN_KAZAKHSTAN && state.lang !== 'en' && p.kzt, src = local ? p.kzt : (p.usd || {});
    const v = src[period];
    if (v == null) return '';
    return local ? V.fmtNumber(v, state.lang, 0) + ' ₸' : '$' + V.fmtNumber(v, 'en', 0);
  }
  function renderPro(notice) {
    const s = lic.get(), d = $('#dlg'), co = CFG.checkout || {}, email = CFG.contactEmail || '', tr = lic.trial();
    const trialEnd = () => V.fmtDate(E.parseDT(s.expires), state.lang);
    let h = '<div class="dlg-h"><h2>' + esc(t('pro.title')) + '</h2><button type="button" class="btn btn-sm" data-act="dlg-close">' + esc(t('common.close')) + '</button></div><div class="dlg-b">';
    if (notice) h += '<p class="note note-warn">' + esc(notice) + '</p>';
    if (s.pro && s.type !== 'trial') {
      h += '<p class="note note-ok">' + esc(t('pro.active')) + '</p>';
      if (s.status === 'grace') h += '<p class="note note-warn">' + esc(t('pro.status.grace')) + '</p>';
      h += '<dl class="kv"><dt>' + esc(t('pro.licensee')) + '</dt><dd>' + esc(s.licensee || '—') + '</dd><dt>' + esc(t('pro.plan')) + '</dt><dd>' + esc(s.plan || 'Pro') + '</dd><dt>' + esc(t('pro.expires')) + '</dt><dd>' +
        esc(s.expires ? V.fmtDate(E.parseDT(s.expires), state.lang) : t('pro.noExpiry')) + '</dd></dl>' +
        '<div><button type="button" class="btn btn-sm" data-act="lic-remove">' + esc(t('pro.remove')) + '</button></div>';
    } else {
      if (s.type === 'trial') h += '<p class="note note-ok">' + esc(t('trial.active', { n: tr.daysLeft, date: trialEnd() })) + '</p>';
      else if (s.status === 'expired') h += '<p class="note note-warn">' + esc(t('pro.status.expired')) + '</p>';
      else if (s.error === 'offline_too_long') h += '<p class="note note-warn">' + esc(t('pro.err.offline_too_long')) + '</p>';
      else if (tr.state === 'ended' && !notice) h += '<p class="note note-warn">' + esc(t('trial.ended')) + '</p>';
      h += '<p>' + esc(STORE ? t('pro.storeNote') : t('pro.lead')) + '</p><ul>' + (space.enabled ? ['f8', 'f9'] : []).concat(['f1', 'f2', 'f3', 'f4', 'f5', 'f7', 'f6']).map((k) => '<li>' + esc(t('pro.' + k)) + '</li>').join('') + '</ul>';
      if (tr.state === 'available') {
        h += '<div class="trialbox"><button type="button" class="btn btn-primary btn-lg" data-act="trial-start">' + esc(t('trial.start', { n: tr.days })) + '</button>' +
          '<p class="f-hint">' + esc(t('trial.note')) + '</p></div>';
      }
      if (!STORE) {
      h += '<div class="plans">';
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
      }
      h += '<div class="keybox"><label class="f-l" for="lic-key"><b>' + esc(t('pro.haveKey')) + '</b></label><textarea id="lic-key" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="' + esc(t('pro.keyPlaceholder')) + '"></textarea>' +
        '<div id="lic-msg"></div><div><button type="button" class="btn btn-primary" data-act="lic-activate" id="lic-btn">' + esc(t('pro.activate')) + '</button></div></div>';
    }
    d.innerHTML = h + '</div>';
    showDialog();
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
      const l = el.dataset.lang || el.value;
      if (!I.STRINGS[l] || l === state.lang) return;
      state.lang = l; store.set(K.lang, l);
      applyI18n(); renderHeader(); renderMenus(); imp.render(); space.render(); renderHelp();
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
      const ev = M.blankEvent('weather', se[0], se[1], state.calc);
      ev.desc = t('et.d.weather');
      p.events.push(ev); touched(); renderForm(); recalc();
      const first = document.getElementById(idOf('ports.' + i + '.events.' + (p.events.length - 1) + '.type'));
      if (first) first.focus();
    },
    'del-event'(el) { state.calc.ports[+el.dataset.port].events.splice(+el.dataset.idx, 1); touched(); renderForm(); recalc(); },
    'add-rule'() {
      const c = state.calc, type = M.RULE_TYPES.find((x) => !c.rules.some((r) => r.type === x));
      if (!type) return;
      const tp = M.eventType(type);
      // a new rule starts from the usual effect of its kind, so adding it changes nothing until it is edited
      c.rules.push({ type, countPct: String(tp.pct), alsoOnDemurrage: tp.dem });
      M.applyRules(c, type); touched(); renderForm(); recalc();
      const first = document.getElementById(idOf('rules.' + (c.rules.length - 1) + '.type'));
      if (first) first.focus();
    },
    'del-rule'(el) { state.calc.rules.splice(+el.dataset.idx, 1); touched(); renderForm(); recalc(); },
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
    print() {
      const c = capBridge();
      if (c && hasNativePrint()) c.nativePromise('StaliaPrint', 'print', { name: fileStem() }).catch(() => window.print());
      else window.print();
    },
    install() {
      if (installEvent) { installEvent.prompt(); installEvent = null; return; }
      const d = $('#dlg'), apps = CFG.apps || {};
      let h = '<div class="dlg-h"><h2>' + esc(t('app.install.title')) + '</h2><button type="button" class="btn btn-sm" data-act="dlg-close">' + esc(t('common.close')) + '</button></div><div class="dlg-b">' +
        '<p>' + esc(t('app.install.lead')) + '</p><ul><li>' + esc(t('app.install.android')) + '</li><li>' + esc(t('app.install.ios')) + '</li><li>' + esc(t('app.install.desktop')) + '</li></ul>';
      const stores = [['android', 'Google Play'], ['ios', 'App Store']].filter((x) => /^https:\/\//.test(apps[x[0]] || ''));
      if (stores.length) {
        h += '<p>' + esc(t('app.install.store')) + '</p><p class="copyline">' + stores.map((x) => '<a class="btn" href="' + esc(apps[x[0]]) + '" target="_blank" rel="noopener">' + x[1] + '</a>').join('') + '</p>';
      }
      d.innerHTML = h + '</div>';
      showDialog();
    },
    share() {
      const url = shareUrl();
      if (url) copyText(url, 'toast.linkCopied'); else toast(t('toast.copyFailed'));
    },
    'send-link'() { // the phone's own "share" sheet: messengers, mail, anything installed
      const url = shareUrl(), title = shareTitle(), c = capBridge();
      if (!url) { toast(t('toast.copyFailed')); return; }
      let sent;
      try {
        sent = c && hasNativeShare() ? c.nativePromise('StaliaShare', 'text', { title, text: title + '\n' + url }) : navigator.share({ title, text: title, url });
      } catch (e) { sent = Promise.reject(e); }
      Promise.resolve(sent).catch((e) => { if (!gaveUp(e)) copyText(url, 'toast.linkCopied'); });
    },
    word() { exportFile('docx'); },
    excel() { exportFile('xlsx'); },
    'copy-summary'() { copyText(V.summaryText(state.calc, state.result, state.lang)); },
    csv() {
      if (needPro()) return;
      saveFile(fileStem() + '.csv', 'text/csv;charset=utf-8', V.sheetCSV(state.calc, state.result, state.lang)).catch(exportFailed);
    },
    json() {
      if (needPro()) return;
      saveFile(fileStem() + '.json', 'application/json', JSON.stringify({ stalia: M.VERSION, calc: state.calc }, null, 2)).catch(exportFailed);
    },
    'open-file'() { $('#file-open').click(); },
    pro() { renderPro(); },
    'dlg-close'() { $('#dlg').close(); },
    'lic-activate'() { activateKey($('#lic-key').value); },
    'lic-remove'() { lic.remove().then(() => { toast(t('toast.licenseRemoved')); renderPro(); }); },
    'trial-start'() {
      if (!lic.startTrial().ok) { renderPro(); return; }
      $('#dlg').close();
      toast(t('trial.started', { n: lic.trial().days, date: V.fmtDate(E.parseDT(lic.get().expires), state.lang) }));
    },
    'copy-email'() { copyText(CFG.contactEmail || ''); },
    'logo-remove'() { const b = getBrand(); delete b.logo; store.set(K.brand, b); renderStatementSide(); renderStatement(); },
    'notes-close'() { state.notes = []; if (state.source === 'import') state.source = 'edited'; renderBanner(); recalc(); },
    'note-go'(el) { showField(el.dataset.path); },
    'claim-why'() { const h = claimWhyHTML(); if (h) { $('#dlg').innerHTML = h; showDialog(); } },
    help() { openHelp('guide', false); },
    'help-lang'(el) { actions.lang(el); helpState.step = 'guide'; renderHelp(); $('#help').scrollTop = 0; },
    'help-pick-lang'() { helpState.step = 'lang'; renderHelp(); $('#help').scrollTop = 0; },
    'help-close'() { closeHelp(); },
  };

  // ---------------------------------------------------------------- welcome: the language first, then how to use
  // Shown by itself on the first visit; afterwards behind the "How to use" button.
  const helpState = { open: false, step: 'guide', first: false };
  // the one heading a newcomer must understand before a language is chosen: the word itself, in every language
  const LANGUAGE_WORD = I.LANGS.map((l) => I.t(l, 'help.lang')).join(' · ');
  function helpHTML() {
    if (helpState.step === 'lang') {
      return '<div class="help-card"><p class="help-brand">STALIA</p><h2 class="help-langs-h">' + esc(LANGUAGE_WORD) + '</h2><div class="help-langs">' +
        I.LANGS.map((l) => '<button type="button" class="btn btn-lg' + (l === state.lang ? ' btn-primary' : '') + '" data-act="help-lang" data-lang="' + l + '" lang="' + l + '">' +
          esc(I.t(l, 'lang.name')) + '</button>').join('') + '</div></div>';
    }
    // button names are taken from the buttons themselves, so the instruction can never call them something else
    const names = { new: t('nav.new'), examples: t('nav.examples'), docs: t('imp.open'), read: t('imp.read'), statement: t('act.statement'), save: t('nav.save'),
      share: t(canSendLink() ? 'act.sendLink' : 'act.share') };
    const steps = [1, 2, 3, 4, 5].map((n) => '<li><h3>' + esc(t('help.s' + n + '.h')) + '</h3><p>' + esc(t('help.s' + n + '.p', names)) +
      (n === 5 && XP && canSave() ? ' ' + esc(t('help.s5.files')) : '') + (n === 5 && canCopyLink() ? ' ' + esc(t('help.s5.share', names)) : '') + '</p></li>').join('');
    return '<div class="help-card"><div class="help-top"><p class="help-brand">STALIA</p>' +
      '<button type="button" class="btn btn-sm" data-act="help-pick-lang">' + esc(t('help.lang')) + ': ' + esc(t('lang.name')) + '</button></div>' +
      '<h2 class="help-h">' + esc(t('help.title')) + '</h2><p class="help-lead">' + esc(t('help.lead')) + '</p><ol class="help-steps">' + steps + '</ol>' +
      '<p class="fine">' + esc(t('disclaimer')) + '</p><div class="help-go"><button type="button" class="btn btn-primary btn-lg" data-act="help-close">' +
      esc(t(helpState.first ? 'help.start' : 'common.close')) + '</button></div></div>';
  }
  function renderHelp() { if (helpState.open) $('#help-body').innerHTML = helpHTML(); }
  function openHelp(step, first) {
    helpState.step = step; helpState.first = !!first;
    if (!helpState.open) {
      helpState.open = true;
      const el = $('#help');
      el.hidden = false; el.scrollTop = 0;
      document.body.style.overflow = 'hidden';
      overlayOpened('help');
    }
    renderHelp();
  }
  function hideHelp() {
    if (!helpState.open) return;
    helpState.open = false;
    $('#help').hidden = true;
    document.body.style.overflow = '';
    store.set(K.seen, true); // however it was closed, it does not come back by itself
  }
  function closeHelp() { if (!helpState.open) return; hideHelp(); overlayClosed('help'); }

  // ---------------------------------------------------------------- reading documents
  /** Bring a form field into view: its port is opened if it was folded. */
  function showField(path) {
    const m = /^ports\.(\d+)\./.exec(path || ''), port = m && state.calc.ports[+m[1]];
    if (port && state.open[port.id] === false) { state.open[port.id] = true; renderForm(); }
    if (port) { const d = $('#form details.port[data-pid="' + port.id + '"]'); if (d && !d.open) d.open = true; }
    const el = document.getElementById(idOf(path));
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }
  const imp = window.StaliaImport.create({
    t, esc, state, config: CFG, engine: E, model: M, view: V, extract: X, schema: S,
    licenceKey: () => lic.storedKey(), isPro, toast, overlayOpened, overlayClosed, blankish,
    apply(calc, notes) {
      const prev = snapshot();
      // a reading fills in the calculation on screen: it stays the same calculation of the space, under the same contract
      setCalc(calc, { source: 'import', pristine: false, notes, cloud: prev.cloud, contractId: prev.contractId });
      window.scrollTo(0, 0);
      toast(t('imp.applied'), { label: t('common.undo'), fn: () => setCalc(prev.calc, prev) });
    },
  });
  Object.assign(actions, imp.actions);

  // ---------------------------------------------------------------- the company space
  const space = window.StaliaSpace.create({
    t, esc, state, config: CFG, preview: PREVIEW, engine: E, model: M, view: V, core: window.StaliaSpaceCore, extract: X, reader: imp,
    toast, overlayOpened, overlayClosed, setCalc, copy: copyText, download: saveFile, touch: saveNow,
    dialog(html) { $('#dlg').innerHTML = html; showDialog(); },
    closeDialog() { if ($('#dlg').open) $('#dlg').close(); },
    // where a link to this calculator points: this very page on the web, the site's address from inside the app
    link: () => (NATIVE ? String(CFG.siteUrl || '').replace(/\/+$/, '') + '/app/' : location.href.split('#')[0].split('?')[0]),
  });
  Object.assign(actions, space.actions);

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
      const rule = tp.kind === 'exception' ? M.ruleFor(state.calc, tp.id) : null;
      ev.kind = tp.kind; ev.countPct = rule ? String(rule.countPct) : String(tp.pct); ev.alsoOnDemurrage = rule ? rule.alsoOnDemurrage : tp.dem;
      if (tp.kind === 'note') ev.to = ''; else if (prev === 'note' && ev.from) ev.to = E.fmtDT(E.parseDT(ev.from) + 60);
    }
    // a rule of the contract was edited: every event of that kind follows it
    const rm = /^rules\.(\d+)\.(\w+)$/.exec(path), rule = rm && state.calc.rules[+rm[1]];
    if (rule && rm[2] === 'type') { const tp = M.eventType(rule.type); rule.countPct = String(tp.pct); rule.alsoOnDemurrage = tp.dem; }
    const followed = rule ? M.applyRules(state.calc, rule.type) : 0;
    if (state.notes.length) {
      const at = rule ? 'rules' : path;
      const left = state.notes.filter((n) => X.notePath(n, state.calc) !== at);
      if (left.length !== state.notes.length) { state.notes = left; renderBanner(); }
    }
    touched();
    if (el.dataset.rr || followed) renderForm();
    recalc();
  }
  document.addEventListener('input', (e) => { if (isTextLike(e.target)) onField(e.target); });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'st-lang') { state.stLang = el.value; renderStatement(); return; }
    if (el.id === 'lang-select') { actions.lang(el); return; }
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('#dlg').open) return;
    if (imp.isRedacting()) imp.closeRedact(); else if (imp.isOpen()) imp.close(); else if (helpState.open) closeHelp(); else if (state.stOpen) closeStatement();
  });
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

  // ---------------------------------------------------------------- install as an app, work offline
  let installEvent = null;
  function setupInstall() {
    if (PREVIEW || NATIVE) return;
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    const btn = $('#btn-install');
    btn.hidden = standalone;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; btn.hidden = false; });
    window.addEventListener('appinstalled', () => { installEvent = null; btn.hidden = true; });
    const secure = location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if ('serviceWorker' in navigator && secure) {
      window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is optional */ }); });
    }
  }

  // ---------------------------------------------------------------- start
  async function start() {
    // language: "?lang=ru" from the site wins, then the last choice, then the browser's language
    const storedLang = store.get(K.lang, null);
    let urlLang = null;
    try { urlLang = new URLSearchParams(location.search).get('lang'); } catch (e) { /* sandboxed */ }
    if (I.STRINGS[urlLang]) { state.lang = urlLang; store.set(K.lang, urlLang); }
    else state.lang = I.STRINGS[storedLang] ? storedLang : I.detect();
    $('#year').textContent = String(new Date().getFullYear());
    if (PREVIEW || NATIVE) { $('#site-link').hidden = true; $('#brand-link').removeAttribute('href'); }
    setupInstall();
    applyI18n(); renderHeader(); renderMenus();
    lic.onChange(() => {
      renderHeader();
      if (state.result) $('#actions').innerHTML = actionsHTML();
      if (state.stOpen) { renderStatementSide(); renderStatement(); }
    });

    // "#join=…" and "#open=…" are links of the company space; "#c=…" carries a whole calculation in the link itself
    const spaceLink = /^#(join|open)=/.test(location.hash) ? location.hash : '';
    const shared = (!spaceLink && (await loadFromHash())) || (await openLaunchLink());
    if (!shared) {
      const cur = store.get(K.current, null);
      // "?example=tanker" — links from the guides open a specific built-in example
      let urlExample = null;
      try { urlExample = new URLSearchParams(location.search).get('example'); } catch (e) { /* sandboxed */ }
      if (urlExample && M.examples(state.lang).some((x) => x.id === urlExample)) loadExample(urlExample);
      else if (cur && cur.calc && Array.isArray(cur.calc.ports)) {
        if (cur.source === 'example' && cur.pristine !== false) loadExample(cur.exampleId);
        else setCalc(M.normalizeCalc(cur.calc), { source: cur.source === 'shared' ? 'edited' : cur.source, calcId: cur.calcId, exampleId: cur.exampleId, pristine: cur.pristine, notes: cur.notes, cloud: cur.cloud, contractId: cur.contractId });
      } else loadExample('bulk');
    }

    await lic.init();
    renderHeader();
    // "?license_key=…" — the link in the purchase e-mail activates Pro in one click
    let activating = false;
    try {
      const q = new URLSearchParams(location.search), key = q.get('license_key') || q.get('key');
      if (key) {
        activating = true;
        q.delete('license_key'); q.delete('key');
        history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
        const problem = await activateKey(key, true);
        if (problem) renderPro(problem);
      }
    } catch (e) { /* sandboxed */ }
    // First visit: choose the language, then read how it works. Not in front of a calculation somebody
    // shared or a licence being activated: those visitors came for something else, and the button is always there.
    const viaSpace = await space.start(spaceLink);
    if (!store.get(K.seen, false) && !shared && !activating && !spaceLink && !viaSpace) openHelp('lang', true);
    // the free trial ran out since the last visit: say so once, with the ways to keep Pro
    else if (lic.trial().state === 'ended' && !isPro() && !activating && !store.get(K.trialEnd, false)) {
      store.set(K.trialEnd, true);
      if (!shared) renderPro();
    }
  }
  start();
  // the preview's host says a little later whether it can save files for the page
  document.addEventListener('stalia-saver', () => {
    if (state.result) $('#actions').innerHTML = actionsHTML();
    if (state.stOpen) renderStatementSide();
  });

  // for automated checks
  window.__stalia = { state, lic, recalc, setCalc, imp, help: helpState };
})();
