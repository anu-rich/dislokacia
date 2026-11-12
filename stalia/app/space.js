/*! Stalia — the company space on screen: every calculation in one place, its history, who may see it, the talk under it. */
(function () {
  'use strict';

  /** Form paths and the labels the form itself uses for them, for "what changed". */
  const LABEL = {
    name: 'f.name', currency: 't.currency', demurrageRate: 't.demRate', despatchMode: 't.despatch', despatchRate: 't.desRate', despatchBasis: 't.basis',
    commissionPct: 't.commission', laytimeMode: 't.mode', demurrageAtNextPort: 't.nextPort',
    'meta.vessel': 'f.vessel', 'meta.voyage': 'f.voyage', 'meta.cpForm': 'f.cpForm', 'meta.cpDate': 'f.cpDate', 'meta.owners': 'f.owners', 'meta.charterers': 'f.charterers', 'meta.cargo': 'f.cargo',
    operation: 'p.operation', commenced: 'n.commenced', completed: 'n.completed',
    'allowed.quantity': 'a.quantity', 'allowed.rate': 'a.rate', 'allowed.rateUnit': 'a.rate', 'allowed.days': 'a.days', 'allowed.hours': 'a.hours', 'allowed.minutes': 'a.minutes',
    'calendar.preset': 'c.preset', 'calendar.unlessUsed': 'c.uu', 'calendar.holidayFromPrev': 'c.holFromPrev', 'calendar.holidayToNext': 'c.holToNext',
    'nor.tendered': 'n.tendered', 'nor.rule': 'n.rule', 'nor.turnHours': 'n.turnHours', 'nor.amStart': 'n.amStart', 'nor.pmStart': 'n.pmStart', 'nor.nextDayStart': 'n.nextDayStart', 'nor.manualStart': 'n.manualStart',
  };
  const PORT_NAME = 'p.name';

  /**
   * @param {object} app  what the calculator screen lends to this module:
   *   t, esc, state, config, preview, engine, model, view, core, toast(), overlayOpened(), overlayClosed(), setCalc(),
   *   dialog(html), closeDialog(), copy(text), download(name, mime, content), link(), touch()
   */
  function create(app) {
    const { t, esc, engine: E, model: M, view: V, core: C, state, extract: X, reader } = app;
    const $ = (s) => document.querySelector(s);
    const endpoint = (app.config.space && app.config.space.endpoint) || (app.config.ai && app.config.ai.endpoint) || '';
    if (!endpoint || app.preview || !C) {
      return { enabled: false, actions: {}, changed() {}, render() {}, start: async () => false, hide() {}, contractOf: () => null };
    }
    const sp = C.create({ endpoint, engine: E });
    const ui = { open: false, tab: 'calcs', busy: false, error: '', over: null, list: null, contracts: null, f: { q: '', contract: '', month: '', status: '' }, invite: null };
    let timer = null;

    // ------------------------------------------------------------ small helpers
    const two = (n) => String(n).padStart(2, '0');
    const local = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes()); };
    const when = (ms) => (ms ? V.fmtDT(E.parseDT(local(ms)), state.lang) : '');
    const day = (ms) => (ms ? V.fmtDate(E.parseDT(local(ms)), state.lang) : '');
    const errText = (e) => { const k = 'sp.err.' + ((e && e.code) || 'other'), s = t(k); return s === k ? t('sp.err.other') : s; };
    const role = () => (sp.session() ? sp.session().role : '');
    const canEdit = () => role() === 'owner' || role() === 'editor';
    const btn = (act, label, cls, attrs) => '<button type="button" class="btn ' + (cls || 'btn-sm') + '" data-act="' + act + '"' + (attrs || '') + '>' + esc(label) + '</button>';
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(label) + '</option>';
    const field = (id, label, value, attrs) => '<label class="f-l" for="' + id + '">' + esc(label) + '</label><input type="text" id="' + id + '" value="' + esc(value || '') + '" autocomplete="off"' + (attrs || '') + '>';
    const val = (id) => { const el = $('#' + id); return el ? String(el.value || '').trim() : ''; };
    /** The result of a calculation in a few words, for a list. */
    function resultText(sum) {
      if (!sum || sum.net == null) return '—';
      // "net_demurrage" / "net_despatch": demurrage at one port set against despatch at another; the balance is what is owed
      if (/demurrage$/.test(sum.outcome)) return t('sp.out.demurrage') + ' ' + V.fmtMoney(Math.abs(sum.net), sum.currency, state.lang);
      if (/despatch$/.test(sum.outcome)) return t('sp.out.despatch') + ' ' + V.fmtMoney(Math.abs(sum.net), sum.currency, state.lang);
      return t('sp.out.none');
    }
    const signed = (sum) => (sum && sum.net != null ? (/despatch$/.test(sum.outcome) ? -Math.abs(sum.net) : (/demurrage$/.test(sum.outcome) ? Math.abs(sum.net) : 0)) : null);
    async function run(fn, quiet) {
      ui.error = '';
      try { return await fn(); } catch (e) {
        if (e && e.code === 'auth' && !state.cloud) { /* the space was deleted or this member removed */ }
        ui.error = errText(e);
        if (!quiet) app.toast(ui.error);
        return undefined;
      }
    }
    const title = (m) => m.title || [m.vessel, m.voyage].filter(Boolean).join(' ') || t('sp.untitled');

    // ------------------------------------------------------------ the bar above the form
    // what would be saved: the calculation and how many things a reading left to check
    const fresh = () => JSON.stringify(state.calc) + '#' + (state.notes || []).length;
    const dirty = () => !!state.cloud && fresh() !== state.cloud.saved;
    /** Everything the bar shows, in one line: it is drawn again only when this changes. */
    const barSig = () => { const c = state.cloud; return c ? [c.id, c.base, c.head, c.role, c.status, c.comments, c.active, c.newer ? c.newer.n : 0, dirty(), role()].join('|') : ['-', role(), state.contractId, state.source, state.pristine, (ui.contracts || []).length].join('|'); };
    let drawn = null;
    function renderBar() {
      const el = $('#cloudbar'), c = state.cloud, s = sp.session();
      drawn = barSig() + '|' + state.lang;
      let h = '';
      if (c) {
        const write = c.active && (c.guest ? c.role === 'edit' : canEdit());
        const old = c.base < c.head;
        h = '<div class="cb"><span class="cb-where">' + esc(c.guest ? t('sp.bar.link') : t('sp.bar.in')) + '</span>' +
          '<span class="cb-ver">' + esc(t('sp.bar.version', { n: c.base, m: c.head })) + '</span>' +
          (dirty() ? '<span class="pill pill-pro" id="cb-dirty">' + esc(t('sp.bar.unsaved')) + '</span>' : '') +
          (c.active ? '' : '<span class="pill">' + esc(t('sp.bar.readonly')) + '</span>') +
          '<span class="grow"></span>' +
          (!c.guest && canEdit() ? '<select id="cb-status" data-sp="status" aria-label="' + esc(t('sp.calcs.col.status')) + '">' + C.STATUSES.map((x) => opt(x, t('sp.status.' + x), c.status)).join('') + '</select>' : '') +
          (write ? btn('sp-save', t('sp.bar.save'), 'btn-sm btn-primary', dirty() || old ? '' : ' disabled') : '') +
          btn('sp-history', t('sp.bar.history')) + btn('sp-talk', t('sp.bar.talk') + (c.comments ? ' · ' + c.comments : '')) +
          (!c.guest && canEdit() ? btn('sp-access', t('sp.bar.access')) : '') + '</div>';
        if (c.newer) h += '<div class="cb cb-note"><span>' + esc(t('sp.bar.newer', { name: c.newer.by || t('sp.hist.guest'), n: c.newer.n })) + '</span>' + btn('sp-latest', t('sp.bar.latest')) + '</div>';
        else if (old) h += '<div class="cb cb-note"><span>' + esc(t('sp.bar.old', { n: c.base, m: c.head })) + '</span>' + btn('sp-latest', t('sp.bar.latest')) + '</div>';
      } else if (s && canEdit() && state.calc && !(state.source === 'example' && state.pristine)) {
        const ct = state.contractId && contractOf(state.contractId);
        h = '<div class="cb cb-plain"><span>' + esc(ct ? t('sp.bar.under', { name: ct.data.name }) : t('sp.bar.notIn')) + '</span><span class="grow"></span>' + btn('sp-add', t('sp.bar.saveNew'), 'btn-sm btn-primary') + '</div>';
      }
      el.innerHTML = h;
      el.hidden = !h;
      const nav = $('#space-btn');
      if (nav) nav.hidden = false;
    }
    /** The calculator tells us that the calculation on screen changed. */
    function changed() {
      if ($('#cloudbar') && drawn !== barSig() + '|' + state.lang) renderBar();
    }
    function watch() {
      clearInterval(timer);
      timer = setInterval(async () => {
        const c = state.cloud;
        if (!c || document.hidden) return;
        try {
          const p = await sp.peek(c.id, { guest: c.guest });
          let touched = false;
          if (p.head > c.head) { c.head = p.head; c.newer = { n: p.head, by: p.by }; touched = true; }
          if (p.comments !== c.comments) { c.comments = p.comments; touched = true; }
          if (p.active !== c.active) { c.active = p.active; touched = true; }
          if (touched) renderBar();
        } catch (e) { /* offline for a moment: the next round will tell */ }
      }, 30000);
    }

    // ------------------------------------------------------------ opening and saving
    async function openCalc(id, o) {
      o = o || {};
      const r = await sp.load(id, { guest: !!o.guest, n: o.n });
      const calc = M.normalizeCalc(r.calc);
      app.setCalc(calc, {
        source: 'space', pristine: false,
        cloud: { id, base: r.n, head: r.head, role: r.role, guest: r.guest, active: r.active, contractId: r.contractId, status: (r.meta && r.meta.status) || 'draft', comments: r.comments, saved: '', newer: null },
        contractId: r.contractId, notes: r.notes,
      });
      // what is on screen now is exactly what is stored: say so (the bar was drawn before this was known)
      state.cloud.saved = fresh();
      renderBar();
      if (ui.open) hide();
      window.scrollTo(0, 0);
      watch();
      return r;
    }
    async function saveVersion(note, force) {
      const c = state.cloud;
      const base = force ? c.head : c.base;
      try {
        const r = await sp.save(c.id, base, state.calc, state.result, { guest: c.guest, note, status: c.status === 'agreed' ? 'sent' : c.status, notes: state.notes });
        if (c.status === 'agreed') c.status = 'sent';
        Object.assign(c, { base: r.head, head: r.head, saved: fresh(), newer: null });
        ui.list = null;
        app.touch();
        renderBar();
        app.toast(t('sp.save.done', { n: r.head }));
      } catch (e) {
        if (e.code !== 'conflict') { app.toast(errText(e)); return; }
        c.head = (e.body && e.body.head) || c.head;
        let by = '';
        try { by = (await sp.peek(c.id, { guest: c.guest })).by; } catch (x) { /* the name is a nicety */ }
        c.newer = { n: c.head, by };
        renderBar();
        app.dialog('<div class="dlg-h"><h2>' + esc(t('sp.conflict.h')) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b">' +
          '<p>' + esc(t('sp.conflict.text', { name: by || t('sp.hist.guest'), n: c.head })) + '</p>' +
          '<div class="sp-row">' + btn('sp-latest', t('sp.conflict.theirs'), 'btn') + btn('sp-save-over', t('sp.conflict.mine', { n: c.head + 1 }), 'btn btn-primary') + '</div></div>');
      }
    }
    function askNote(act, heading, goLabel) {
      app.dialog('<div class="dlg-h"><h2>' + esc(heading) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b">' +
        (state.cloud && state.cloud.guest && !sp.guestName() ? '<div>' + field('sp-guest-name', t('sp.talk.name'), '', ' maxlength="80"') + '</div>' : '') +
        '<div>' + field('sp-note', t('sp.save.note'), '', ' maxlength="200"') + '</div><div id="sp-dlg-msg"></div>' +
        '<div>' + btn(act, goLabel, 'btn btn-primary') + '</div></div>');
      const el = $('#sp-guest-name') || $('#sp-note');
      if (el) el.focus();
    }
    /** A guest signs what they write: asked once, kept on this device. */
    function guestSigned() {
      if (!state.cloud || !state.cloud.guest || sp.guestName()) return true;
      const name = val('sp-guest-name');
      if (!name) { const m = $('#sp-dlg-msg'); if (m) m.innerHTML = '<p class="note note-err">' + esc(t('sp.err.name')) + '</p>'; return false; }
      sp.setGuestName(name.slice(0, 80));
      return true;
    }

    // ------------------------------------------------------------ the overlay
    function contractOf(id) { return (ui.contracts || []).find((c) => c.id === id) || null; }
    async function refresh() {
      if (!sp.session()) { render(); return; }
      ui.busy = true; render();
      await run(async () => {
        ui.over = await sp.overview();
        ui.contracts = await sp.contracts();
        ui.list = await sp.list();
        // entries left behind by a counterparty's version are brought up to date here, a few at a time
        for (const row of ui.list.filter((r) => r.stale).slice(0, 8)) {
          try { const meta = await sp.refreshMeta(row); if (meta) { row.meta = meta; row.metaHead = row.head; row.stale = false; row.fromGuest = true; } } catch (e) { /* stays marked */ }
        }
      }, true);
      if (ui.error && /auth/.test(ui.error) === false && !ui.over) { /* shown in the body */ }
      ui.busy = false; render(); renderBar();
    }
    function show(tab) {
      if (tab) ui.tab = tab;
      if (!ui.open) { ui.open = true; $('#space').hidden = false; app.overlayOpened('space'); }
      refresh();
    }
    function hide() {
      if (!ui.open) return;
      ui.open = false; $('#space').hidden = true; app.overlayClosed('space');
    }

    function planHTML(space) {
      const now = Date.now();
      if (space.paidUntil > now) return '<span class="pill pill-lay">' + esc(t('sp.plan.paid', { date: day(space.paidUntil) })) + '</span>';
      if (space.trialUntil > now) return '<span class="pill pill-pro">' + esc(t('sp.plan.trial', { date: day(space.trialUntil) })) + '</span>';
      return '<span class="pill pill-dem">' + esc(t('sp.plan.locked')) + '</span>';
    }
    /** When the voyage of a list entry began; entries saved before that was recorded fall back on their month. */
    const startKey = (r) => r.meta.start || (r.meta.period ? r.meta.period + '-99' : '');
    /** The rows to show: the latest voyage first, and within one moment the latest change first. */
    function filtered() {
      const f = ui.f, q = f.q.toLowerCase();
      return (ui.list || []).filter((r) => {
        const m = r.meta;
        if (f.contract && (f.contract === '-' ? r.contractId : r.contractId !== f.contract)) return false;
        if (f.month && m.period !== f.month) return false;
        if (f.status && (m.status || 'draft') !== f.status) return false;
        if (q && [m.title, m.vessel, m.voyage, m.charterers, m.owners, m.ports].join(' ').toLowerCase().indexOf(q) < 0) return false;
        return true;
      }).sort((a, b) => (startKey(a) < startKey(b) ? 1 : startKey(a) > startKey(b) ? -1 : b.updatedAt - a.updatedAt));
    }
    /** The counterparty's figure of a row and how far it is from ours; nulls when either is missing. */
    function claimOf(r) {
      const ours = signed(r.meta.sum), theirs = typeof r.meta.claimed === 'number' ? r.meta.claimed : null;
      return { ours, theirs, gap: ours != null && theirs != null ? Math.round((theirs - ours) * 100) / 100 : null };
    }
    const money = (v, cur) => (v < 0 ? '−' : '') + V.fmtMoney(Math.abs(v), cur, state.lang);
    const gapHTML = (gap, cur) => (gap == null ? '' : Math.abs(gap) < 0.005 ? '<span class="pill pill-lay">' + esc(t('cl.same')) + '</span>'
      : '<span class="' + (gap > 0 ? 'up' : 'down') + '">' + (gap > 0 ? '+' : '−') + esc(V.fmtMoney(Math.abs(gap), cur, state.lang)) + '</span>');
    function calcsHTML() {
      const all = ui.list || [], rows = filtered();
      if (!all.length) return '<p class="sp-empty">' + esc(t('sp.calcs.empty')) + '</p>';
      const months = Array.from(new Set(all.map((r) => r.meta.period).filter(Boolean))).sort().reverse();
      const monthName = (p) => V.fmtMonth(p, state.lang);
      let h = '<div class="sp-tools"><input type="search" id="sp-q" data-sp="q" placeholder="' + esc(t('sp.calcs.search')) + '" value="' + esc(ui.f.q) + '">' +
        '<select data-sp="contract">' + opt('', t('sp.calcs.allContracts'), ui.f.contract) + (ui.contracts || []).map((c) => opt(c.id, c.data.name || '—', ui.f.contract)).join('') + opt('-', t('sp.calcs.noContract'), ui.f.contract) + '</select>' +
        '<select data-sp="month">' + opt('', t('sp.calcs.allMonths'), ui.f.month) + months.map((p) => opt(p, monthName(p), ui.f.month)).join('') + '</select>' +
        '<select data-sp="status">' + opt('', t('sp.calcs.allStatuses'), ui.f.status) + C.STATUSES.map((x) => opt(x, t('sp.status.' + x), ui.f.status)).join('') + '</select></div>';
      // the counterparty's figures get their two columns as soon as one voyage on screen has one
      const withClaims = rows.some((r) => typeof r.meta.claimed === 'number');
      const heads = [t('sp.calcs.col.title'), t('sp.calcs.col.period'), t('sp.calcs.col.status'), t('sp.calcs.col.result')].concat(withClaims ? [t('cl.col.theirs'), t('cl.col.gap')] : [], [t('sp.calcs.col.changed')]);
      h += '<div class="sp-table-wrap"><table class="sp-table"><thead><tr><th>' + heads.map(esc).join('</th><th>') + '</th><th></th></tr></thead><tbody>';
      for (const r of rows) {
        const m = r.meta, ct = contractOf(r.contractId), cl = claimOf(r), cur = (m.sum && m.sum.currency) || 'USD';
        h += '<tr data-id="' + esc(r.id) + '"><td><button type="button" class="sp-open" data-act="sp-open" data-id="' + esc(r.id) + '"><b>' + esc(title(m)) + '</b>' +
          '<span>' + esc([m.vessel, m.voyage, m.ports].filter(Boolean).join(' · ')) + (ct ? ' · ' + esc(ct.data.name || '') : '') + '</span></button>' +
          (m.flags ? ' <span class="pill pill-dem sp-flags">' + esc(t('sp.calcs.flags', { n: m.flags })) + '</span>' : '') + '</td>' +
          '<td>' + esc(m.period ? monthName(m.period) : '') + '</td>' +
          '<td><span class="pill sp-st-' + esc(m.status || 'draft') + '">' + esc(t('sp.status.' + (C.STATUSES.includes(m.status) ? m.status : 'draft'))) + '</span></td>' +
          '<td class="num">' + esc(resultText(m.sum)) + '</td>' +
          (withClaims ? '<td class="num">' + (cl.theirs == null ? '' : esc(money(cl.theirs, cur))) + '</td><td class="num">' + gapHTML(cl.gap, cur) + '</td>' : '') +
          '<td>' + esc(when(r.updatedAt)) + '<span class="sp-by">' + esc(m.by || '') + (m.guest || r.stale ? ' · ' + esc(t('sp.hist.guest')) : '') + ' · v' + r.head + '</span></td>' +
          '<td>' + (canEdit() ? btn('sp-del', t('sp.calcs.delete'), 'btn-sm btn-ghost', ' data-id="' + esc(r.id) + '"') : '') + '</td></tr>';
      }
      h += '</tbody></table></div>';
      // the foot of the table: what the rows on screen add up to, one line per currency
      const sums = {}, theirs = {}, gaps = {};
      for (const r of rows) {
        const v = signed(r.meta.sum), cl = claimOf(r);
        if (v == null) continue;
        const cur = r.meta.sum.currency;
        sums[cur] = (sums[cur] || 0) + v;
        if (cl.gap != null) { theirs[cur] = (theirs[cur] || 0) + cl.theirs; gaps[cur] = (gaps[cur] || 0) + cl.gap; }
      }
      const parts = Object.keys(sums).sort().map((cur) => (sums[cur] < 0 ? t('sp.out.despatch') : t('sp.out.demurrage')) + ' ' + V.fmtMoney(Math.abs(sums[cur]), cur, state.lang));
      const claimParts = Object.keys(theirs).sort().map((cur) => t('cl.total', { theirs: money(theirs[cur], cur), gap: (gaps[cur] > 0 ? '+' : '') + money(Math.round(gaps[cur] * 100) / 100, cur) }));
      h += '<div class="sp-foot"><span id="sp-total">' + esc(t('sp.calcs.total', { n: rows.length })) + ' <b>' + esc(parts.join(' · ') || '—') + '</b>' +
        (claimParts.length ? '<span id="sp-claims-total" class="sp-claims-total">' + esc(claimParts.join(' · ')) + '</span>' : '') + '</span><span class="grow"></span>' +
        (rows.length && canEdit() ? btn('sp-claims', t('cl.paste')) : '') + (rows.length ? btn('sp-csv', t('sp.calcs.csv')) : '') + '</div>';
      return h;
    }
    function contractsHTML() {
      const list = ui.contracts || [];
      let h = '';
      if (canEdit() && state.calc) {
        h += '<details class="sp-box"' + (list.length ? '' : ' open') + '><summary>' + esc(t('sp.ct.saveCurrent')) + '</summary><div class="sp-form">' +
          '<div>' + field('sp-ct-name', t('sp.ct.name'), [state.calc.meta.cpForm, state.calc.meta.charterers].filter(Boolean).join(', '), ' maxlength="120"') + '</div>' +
          '<div>' + field('sp-ct-cp', t('sp.ct.counterparty'), state.calc.meta.charterers || '', ' maxlength="120"') + '</div>' +
          '<div class="sp-wide"><label class="f-l" for="sp-ct-clauses">' + esc(t('sp.ct.clauses')) + '</label><textarea id="sp-ct-clauses" rows="4" maxlength="3000">' + esc(state.calc.meta.clauses || '') + '</textarea></div>' +
          '<div>' + btn('sp-ct-save', t('sp.ct.save'), 'btn btn-primary') + '</div></div></details>';
      }
      if (!list.length) return h + '<p class="sp-empty">' + esc(t('sp.ct.empty')) + '</p>';
      h += '<ul class="sp-list">';
      for (const c of list) {
        const n = (ui.list || []).filter((r) => r.contractId === c.id).length;
        h += '<li><div><b>' + esc(c.data.name || '—') + '</b><span>' + esc([c.data.counterparty, V.termsText ? '' : ''].filter(Boolean).join(' · ')) + (c.data.counterparty ? ' · ' : '') + esc(t('sp.ct.voyages', { n })) + '</span>' +
          (c.data.terms && V.rulesText(c.data.terms, state.lang) ? '<p class="sp-clauses sp-rules"><b>' + esc(t('t.rules')) + ':</b> ' + esc(V.rulesText(c.data.terms, state.lang)) + '</p>' : '') +
          (c.data.clauses ? '<p class="sp-clauses">' + esc(c.data.clauses) + '</p>' : '') + '</div><div class="sp-row">' +
          (canEdit() ? btn('sp-ct-new', t('sp.ct.new'), 'btn-sm btn-primary', ' data-id="' + esc(c.id) + '"') + btn('sp-b-start', t('sp.batch.tab'), 'btn-sm', ' data-id="' + esc(c.id) + '"') : '') +
          btn('sp-ct-filter', t('sp.ct.show'), 'btn-sm', ' data-id="' + esc(c.id) + '"') +
          (canEdit() ? btn('sp-ct-update', t('sp.ct.update'), 'btn-sm', ' data-id="' + esc(c.id) + '"') + btn('sp-ct-del', t('sp.calcs.delete'), 'btn-sm btn-ghost', ' data-id="' + esc(c.id) + '"') : '') +
          '</div></li>';
      }
      return h + '</ul>';
    }
    function peopleHTML() {
      const o = ui.over, me = o.me, owner = me.role === 'owner';
      let h = '<div class="sp-box"><div class="sp-form"><div>' + field('sp-me', t('sp.me.name'), sp.session().name, ' maxlength="80"') + '</div><div>' + btn('sp-me-save', t('sp.me.save'), 'btn') + '</div></div></div>';
      h += '<ul class="sp-list">';
      for (const m of o.members) {
        h += '<li><div><b>' + esc(m.name || '—') + (m.id === me.id ? ' <span class="pill">' + esc(t('sp.people.you')) + '</span>' : '') + '</b><span>' + esc(t('sp.people.seen', { date: when(m.seenAt) })) + '</span></div><div class="sp-row">' +
          (owner && m.id !== me.id ? '<select data-sp="role" data-id="' + esc(m.id) + '">' + ['owner', 'editor', 'viewer'].map((r) => opt(r, t('sp.role.' + r), m.role)).join('') + '</select>' + btn('sp-kick', t('sp.people.remove'), 'btn-sm btn-ghost', ' data-id="' + esc(m.id) + '"')
            : '<span class="pill">' + esc(t('sp.role.' + m.role)) + '</span>') + '</div></li>';
      }
      h += '</ul>';
      if (owner) {
        h += '<div class="sp-box"><h3>' + esc(t('sp.people.invite.h')) + '</h3><div class="sp-form"><div><label class="f-l" for="sp-inv-role">' + esc(t('sp.people.invite.role')) + '</label><select id="sp-inv-role">' +
          ['editor', 'viewer', 'owner'].map((r) => opt(r, t('sp.role.' + r), 'editor')).join('') + '</select></div><div>' + btn('sp-invite', t('sp.people.invite.make'), 'btn btn-primary') + '</div></div>' +
          (ui.invite ? '<p class="note note-ok">' + esc(t('sp.people.invite.made', { days: 14 })) + '</p><p class="copyline"><code id="sp-inv-link">' + esc(ui.invite) + '</code>' + btn('sp-copy', t('common.copy'), 'btn-sm', ' data-from="sp-inv-link"') + '</p>' : '') + '</div>';
        h += '<div class="sp-box"><h3>' + esc(t('sp.plan.attach')) + '</h3><p>' + planHTML(o.space) + '</p><div class="sp-form"><div class="sp-wide">' + field('sp-lic', t('sp.plan.key'), '', ' spellcheck="false"') + '</div><div>' + btn('sp-licence', t('pro.activate'), 'btn') + '</div></div></div>';
      }
      h += '<div class="sp-box"><h3>' + esc(t('sp.recovery.h')) + '</h3><p>' + esc(t('sp.recovery.lead')) + '</p><div class="sp-row">' + btn('sp-recovery', t('sp.recovery.get'), 'btn') + '</div></div>';
      h += '<div class="sp-row sp-danger">' + btn('sp-leave', t('sp.leave'), 'btn-sm btn-ghost') + (owner ? btn('sp-delete', t('sp.delete'), 'btn-sm btn-ghost') : '') + '</div>';
      return h;
    }
    function welcomeHTML() {
      return '<p class="imp-lead">' + esc(t('sp.intro.lead')) + '</p><p class="imp-privacy">' + esc(t('sp.intro.private')) + ' ' + esc(t('sp.intro.trial', { n: 14 })) + '</p>' +
        (ui.error ? '<p class="note note-err" role="alert">' + esc(ui.error) + '</p>' : '') +
        '<div class="imp-slots"><div class="imp-slot"><h3>' + esc(t('sp.create.h')) + '</h3>' +
        '<div>' + field('sp-company', t('sp.create.company'), '', ' maxlength="120"') + '</div><div>' + field('sp-name', t('sp.create.me'), '', ' maxlength="80"') + '</div>' +
        '<div>' + btn('sp-create', t('sp.create.go'), 'btn btn-primary') + '</div></div>' +
        '<div class="imp-slot"><h3>' + esc(t('sp.join.h')) + '</h3><p class="f-hint">' + esc(t('sp.join.hint')) + '</p>' +
        '<div>' + field('sp-link', t('sp.join.link'), ui.pending || '', ' spellcheck="false"') + '</div><div>' + field('sp-name2', t('sp.create.me'), '', ' maxlength="80"') + '</div>' +
        '<div>' + btn('sp-join', t('sp.join.go'), 'btn btn-primary') + '</div></div></div>' +
        '<p><label class="btn btn-sm btn-ghost" for="sp-restore-file">' + esc(t('sp.restore')) + '</label><input type="file" id="sp-restore-file" data-sp="restore" accept="application/json,.json" hidden></p>';
    }
    function render() {
      const body = $('#space-body');
      if (!body || !ui.open) return;
      const keep = document.activeElement && document.activeElement.id === 'sp-q';
      if (!sp.session()) { body.innerHTML = welcomeHTML(); return; }
      if (!ui.over) { body.innerHTML = '<p class="sp-empty">' + esc(ui.busy ? t('sp.loading') : (ui.error || t('sp.loading'))) + '</p>' + (ui.busy ? '' : '<p>' + btn('sp-forget', t('sp.leave'), 'btn-sm btn-ghost') + '</p>'); return; }
      const o = ui.over;
      let h = '<div class="sp-head"><h2 class="imp-h">' + esc(o.space.name || t('sp.title')) + '</h2><span class="pill">' + esc(t('sp.role.' + o.me.role)) + '</span>' + planHTML(o.space) + '</div>';
      if (ui.error) h += '<p class="note note-err" role="alert">' + esc(ui.error) + '</p>';
      const tabs = [['calcs', t('sp.tab.calcs') + ' · ' + (ui.list || []).length], ['contracts', t('sp.tab.contracts') + ' · ' + (ui.contracts || []).length]]
        .concat(canEdit() && reader ? [['batch', t('sp.batch.tab')]] : [], [['people', t('sp.tab.people') + ' · ' + o.members.length]]);
      if (ui.tab === 'batch' && !(canEdit() && reader)) ui.tab = 'calcs';
      h += '<div class="sp-tabs" role="tablist">' + tabs
        .map((x) => '<button type="button" role="tab" class="sp-tab' + (ui.tab === x[0] ? ' on' : '') + '" data-act="sp-tab" data-tab="' + x[0] + '" aria-selected="' + (ui.tab === x[0]) + '">' + esc(x[1]) + '</button>').join('') + '</div>';
      h += '<div class="sp-pane">' + (ui.tab === 'people' ? peopleHTML() : ui.tab === 'contracts' ? contractsHTML() : ui.tab === 'batch' ? batchHTML() : calcsHTML()) + '</div>';
      body.innerHTML = h;
      if (keep) { const q = $('#sp-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    }

    // ------------------------------------------------------------ dialogs: history, access, discussion
    function fmtChange(c, lang) {
      const label = (k) => { const key = LABEL[k]; return key ? t(key) : k; };
      const show = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? V.fmtDT(E.parseDT(v), lang) : (v === '' ? '—' : v));
      const where = c.port != null ? t('sp.diff.port', { n: c.port + 1 }) + ': ' : '';
      if (c.scope === 'event') {
        const ev = (s) => { const p = String(s).split('|'); return p[0] ? show(p[0]) + (p[1] ? ' – ' + show(p[1]) : '') + (p[2] ? ', ' + p[2] : '') : ''; };
        return where + t('sp.diff.' + c.field) + ' «' + c.what + '»' + (c.field === 'changed' ? ': ' + ev(c.from) + ' → ' + ev(c.to) : ': ' + ev(c.to || c.from));
      }
      if (c.scope === 'port' && (c.field === 'added' || c.field === 'removed')) return where + t('sp.diff.' + c.field) + (c.to || c.from ? ' «' + (c.to || c.from) + '»' : '');
      return where + (c.scope === 'port' && c.field === 'name' ? t(PORT_NAME) : label(c.field)) + ': ' + show(c.from) + ' → ' + show(c.to);
    }
    async function historyDialog() {
      const c = state.cloud;
      const r = await run(() => sp.load(c.id, { guest: c.guest, n: c.base }));
      if (!r) return;
      c.head = r.head; c.comments = r.comments;
      let h = '<div class="dlg-h"><h2>' + esc(t('sp.hist.h')) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b"><ol class="sp-hist">';
      r.versions.forEach((v, i) => {
        const prev = r.versions[i + 1], d = prev && v.sum && prev.sum && signed(v.sum) != null && signed(prev.sum) != null && v.sum.currency === prev.sum.currency ? signed(v.sum) - signed(prev.sum) : null;
        h += '<li data-n="' + v.n + '"><div class="sp-hist-h"><b>v' + v.n + '</b><span>' + esc(when(v.at)) + '</span><span>' + esc(v.by || '—') + (v.guest ? ' <i class="pill">' + esc(t('sp.hist.guest')) + '</i>' : '') + '</span></div>' +
          (v.note ? '<p class="sp-note">' + esc(v.note) + '</p>' : '') +
          '<div class="sp-hist-r"><span>' + esc(resultText(v.sum)) + (d ? ' <i class="' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '−') + esc(V.fmtNumber(Math.abs(d), state.lang, 2)) + '</i>' : '') + '</span><span class="grow"></span>' +
          (prev ? btn('sp-diff', t('sp.hist.changes'), 'btn-sm btn-ghost', ' data-n="' + v.n + '"') : '<span class="f-hint">' + esc(t('sp.hist.first')) + '</span>') +
          (v.n === c.base ? '<span class="pill pill-lay">' + esc(t('sp.hist.current')) + '</span>' : btn('sp-open-v', t('sp.hist.open'), 'btn-sm', ' data-n="' + v.n + '"')) + '</div><div class="sp-diff" id="sp-diff-' + v.n + '"></div></li>';
      });
      app.dialog(h + '</ol></div>');
    }
    async function accessDialog(made) {
      const c = state.cloud;
      const list = await run(() => sp.shares(c.id));
      if (!list) return;
      let h = '<div class="dlg-h"><h2>' + esc(t('sp.acc.h')) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b"><p>' + esc(t('sp.acc.lead')) + '</p>';
      if (made) h += '<p class="note note-ok">' + esc(t('sp.acc.made')) + '</p><p class="copyline"><code id="sp-share-link">' + esc(made) + '</code>' + btn('sp-copy', t('common.copy'), 'btn-sm', ' data-from="sp-share-link"') + '</p>';
      h += '<div class="sp-form"><div>' + field('sp-share-label', t('sp.acc.label'), '', ' maxlength="80"') + '</div><div><label class="f-l" for="sp-share-role">' + esc(t('sp.acc.role')) + '</label><select id="sp-share-role">' +
        ['comment', 'edit', 'view'].map((r) => opt(r, t('sp.role.' + r), 'comment')).join('') + '</select></div><div>' + btn('sp-share', t('sp.acc.make'), 'btn btn-primary') + '</div></div><div id="sp-dlg-msg"></div>';
      h += list.length ? '<ul class="sp-list">' + list.map((s) => '<li><div><b>' + esc(s.label || '—') + '</b><span>' + esc(t('sp.role.' + s.role)) + ' · ' + esc(s.seenAt ? t('sp.acc.seen', { date: when(s.seenAt) }) : t('sp.acc.never')) + '</span></div>' +
        '<div class="sp-row">' + btn('sp-unshare', t('sp.acc.revoke'), 'btn-sm btn-ghost', ' data-id="' + esc(s.id) + '"') + '</div></li>').join('') + '</ul>' : '<p class="sp-empty">' + esc(t('sp.acc.none')) + '</p>';
      app.dialog(h + '</div>');
    }
    async function talkDialog() {
      const c = state.cloud;
      const list = await run(() => sp.comments(c.id, { guest: c.guest }));
      if (!list) return;
      c.comments = list.length; renderBar();
      const may = c.active && (!c.guest || c.role !== 'view');
      let h = '<div class="dlg-h"><h2>' + esc(t('sp.talk.h')) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b">';
      h += list.length ? '<ol class="sp-talk">' + list.map((m) => '<li class="' + (m.type === 'agree' ? 'agree' : '') + '"><div class="sp-hist-h"><b>' + esc(m.by || '—') + (m.guest ? ' <i class="pill">' + esc(t('sp.hist.guest')) + '</i>' : '') + '</b><span>' + esc(when(m.at)) + '</span></div>' +
        '<p>' + esc(m.type === 'agree' ? t('sp.talk.agreed', { n: m.n }) : m.text) + '</p></li>').join('') + '</ol>' : '<p class="sp-empty">' + esc(t('sp.talk.empty')) + '</p>';
      if (may) {
        h += (c.guest && !sp.guestName() ? '<div>' + field('sp-guest-name', t('sp.talk.name'), '', ' maxlength="80"') + '</div>' : '') +
          '<div><label class="f-l" for="sp-say">' + esc(t('sp.talk.write')) + '</label><textarea id="sp-say" rows="3" maxlength="2000"></textarea></div><div id="sp-dlg-msg"></div>' +
          '<div class="sp-row">' + btn('sp-say-go', t('sp.talk.send'), 'btn btn-primary') + btn('sp-agree', t('sp.talk.agree', { n: c.base }), 'btn') + '</div>';
      }
      app.dialog(h + '</div>');
    }

    // ------------------------------------------------------------ a month's scan read into voyages
    // The scan is cut into voyages (so many pages each; any cut can be moved), every voyage is read under the terms
    // of one contract, and each becomes a calculation of the space with what the reading left to check.
    const MAX_BATCH = 120;
    const B = { contractId: '', pages: [], starts: [0], per: 2, busy: '', error: '', run: null, quota: null };
    const canRead = () => !!(reader && reader.available());
    /** A new calculation that carries a contract's terms and nothing of any voyage. */
    function contractCalc(c) {
      const calc = M.normalizeCalc(JSON.parse(JSON.stringify(c.data.terms)));
      calc.meta.clauses = c.data.clauses || calc.meta.clauses || '';
      return calc;
    }
    function voyageName(calc) {
      const st = C.startOf(calc), m = calc.meta;
      return [[m.vessel, m.voyage].filter(Boolean).join(' '), calc.ports.map((p) => p.name).filter(Boolean).join(' — '), st ? V.fmtDate(E.parseDT(st), state.lang) : ''].filter(Boolean).join(' · ').slice(0, 120);
    }
    const pagesText = (g) => (g.length > 1 ? (g[0] + 1) + '–' + (g[g.length - 1] + 1) : String(g[0] + 1));
    function batchHTML() {
      const cts = ui.contracts || [];
      if (!cts.length) return '<p class="sp-empty">' + esc(t('sp.batch.needContract')) + '</p><p>' + btn('sp-tab', t('sp.tab.contracts'), 'btn', ' data-tab="contracts"') + '</p>';
      if (!contractOf(B.contractId)) B.contractId = cts[0].id;
      if (B.run) return runHTML();
      const groups = C.groupPages(B.pages.length, B.starts), max = reader.maxPages;
      let h = '<p class="sp-lead">' + esc(t('sp.batch.lead')) + '</p>';
      if (!canRead()) h += '<p class="note note-err">' + esc(t('imp.err.unavailable')) + '</p>';
      h += '<div class="sp-form"><div><label class="f-l" for="sp-b-ct">' + esc(t('sp.batch.contract')) + '</label><select id="sp-b-ct" data-sp="b-contract">' + cts.map((c) => opt(c.id, c.data.name || '—', B.contractId)).join('') + '</select></div>' +
        '<div><label class="f-l" for="sp-b-per">' + esc(t('sp.batch.per')) + '</label><input type="number" id="sp-b-per" data-sp="b-per" min="1" max="' + max + '" step="1" inputmode="numeric" value="' + B.per + '"></div>' +
        '<div><label class="btn' + (B.busy ? ' disabled' : '') + '" for="sp-b-file">' + esc(t(B.pages.length ? 'sp.batch.addMore' : 'sp.batch.add')) + '</label><input type="file" id="sp-b-file" data-sp="b-files" accept="application/pdf,image/*" multiple hidden' + (B.busy ? ' disabled' : '') + '></div></div>';
      if (B.busy === 'opening') return h + '<p class="sp-empty" role="status">' + esc(t('sp.batch.opening', { n: B.pages.length })) + '</p>';
      if (B.error) h += '<p class="note note-err" role="alert">' + esc(B.error) + '</p>';
      if (!B.pages.length) return h;
      h += '<div class="sp-b-grid">';
      groups.forEach((g, k) => {
        h += '<fieldset class="sp-b-voy' + (g.length > max ? ' bad' : '') + '"><legend>' + esc(t('sp.batch.voyage', { n: k + 1 })) + (g.length > max ? ' · ' + esc(t('imp.tooMany', { n: max })) : '') + '</legend>';
        for (const i of g) {
          const p = B.pages[i];
          h += '<figure><img src="' + p.thumb + '" alt="" loading="lazy" width="' + Math.round(p.w / 10) + '" height="' + Math.round(p.h / 10) + '"><figcaption>' + esc(t('imp.page', { n: i + 1 })) + '</figcaption>' +
            (i > 0 ? btn('sp-b-cut', t(i === g[0] ? 'sp.batch.join' : 'sp.batch.cut'), 'btn-sm btn-ghost', ' data-i="' + i + '"') : '') + '</figure>';
        }
        h += '</fieldset>';
      });
      h += '</div><p class="f-hint">' + esc(t('imp.privacy')) + ' ' + esc(t('sp.batch.cost')) + '</p>';
      h += '<div class="sp-foot"><span id="sp-b-count">' + esc(t('sp.batch.count', { pages: B.pages.length, n: groups.length })) + '</span><span class="grow"></span>' +
        btn('sp-b-clear', t('sp.batch.clear'), 'btn-sm btn-ghost') +
        btn('sp-b-go', t('sp.batch.go', { n: groups.length }), 'btn btn-primary', canRead() && !groups.some((g) => g.length > max) ? '' : ' disabled') + '</div>';
      return h;
    }
    function runHTML() {
      const R = B.run, saved = R.rows.filter((r) => r.status === 'saved'), failed = R.rows.filter((r) => r.status === 'failed').length;
      let h = '<p class="sp-lead" role="status" id="sp-b-status">' + esc(R.active ? t('sp.batch.running', { done: saved.length + failed, n: R.rows.length }) : t('sp.batch.done', { done: saved.length, n: R.rows.length })) + '</p>';
      if (!R.active && saved.length) {
        const flags = saved.reduce((a, r) => a + r.flags, 0);
        h += '<p class="note ' + (flags ? 'note-warn' : 'note-ok') + '">' + esc(flags ? t('sp.batch.check', { n: flags, k: saved.filter((r) => r.flags).length }) : t('sp.batch.allClean')) + '</p>';
      }
      h += '<div class="sp-table-wrap"><table class="sp-table"><thead><tr><th>#</th><th>' + [t('sp.batch.col.pages'), t('sp.batch.col.result'), t('sp.batch.col.check')].map(esc).join('</th><th>') + '</th><th></th></tr></thead><tbody>';
      R.rows.forEach((r, k) => {
        h += '<tr data-k="' + k + '" data-st="' + r.status + '"><td>' + (k + 1) + '</td><td>' + esc(pagesText(r.pages)) + '</td><td>' +
          (r.status === 'saved' ? '<b>' + esc(r.title) + '</b><span class="sp-by">' + esc(resultText(r.sum)) + '</span>'
            : r.status === 'failed' ? '<span class="sp-b-err">' + esc(r.error) + '</span>' : esc(t(r.status === 'reading' ? 'sp.batch.st.reading' : 'sp.batch.st.wait'))) + '</td><td>' +
          (r.status === 'saved' ? (r.flags ? '<span class="pill pill-dem">' + esc(t('sp.calcs.flags', { n: r.flags })) + '</span>' : '<span class="pill pill-lay">' + esc(t('sp.batch.clean')) + '</span>') : '') + '</td><td>' +
          (r.status === 'saved' ? btn('sp-open', t('sp.batch.open'), 'btn-sm', ' data-id="' + esc(r.id) + '"') : (r.status === 'failed' && !R.active ? btn('sp-b-retry', t('sp.batch.retry'), 'btn-sm', ' data-k="' + k + '"') : '')) + '</td></tr>';
      });
      h += '</tbody></table></div><div class="sp-foot"><span>' + (B.quota ? esc(reader.quotaWords(B.quota)) : '') + '</span><span class="grow"></span>' +
        (R.active ? btn('sp-b-stop', t('sp.batch.stop'), 'btn') : btn('sp-b-new', t('sp.batch.again'), 'btn-sm btn-ghost') + btn('sp-b-list', t('sp.batch.toList'), 'btn btn-primary')) + '</div>';
      return h;
    }
    /** Read the voyages that are still waiting, two at a time, and file each as a calculation of the space. */
    async function runBatch() {
      const ct = contractOf(B.contractId), R = B.run;
      if (!ct || !R || R.active) return;
      R.active = true; R.stop = false; render();
      const base = contractCalc(ct), terms = V.readerTerms(base);
      const next = () => (R.stop ? null : R.rows.find((r) => r.status === 'wait'));
      const worker = async () => {
        for (let row = next(); row; row = next()) {
          row.status = 'reading'; render();
          const ac = typeof AbortController === 'function' ? new AbortController() : null;
          if (ac) R.aborts.add(ac);
          const res = await reader.readSheets(row.pages.map((i) => B.pages[i]), terms, ac ? ac.signal : undefined);
          if (ac) R.aborts.delete(ac);
          if (res.quota) B.quota = res.quota;
          if (res.error === 'aborted') { row.status = 'wait'; break; }
          if (!res.ok) {
            row.status = 'failed'; row.error = reader.errorText(res);
            // nothing further can succeed once the allowance is spent or the service is away
            if (['limit', 'pro', 'unavailable', 'network'].indexOf(res.error) >= 0) R.stop = true;
            render(); continue;
          }
          try {
            const got = X.toCalc(res.extraction);
            if (got.empty || !got.calc.ports.some((p) => X.hasFacts(p))) { row.status = 'failed'; row.error = t('imp.err.empty'); render(); continue; }
            const out = X.merge(JSON.parse(JSON.stringify(base)), got, 'terms');
            out.calc.name = voyageName(out.calc);
            const result = E.compute(out.calc), notes = out.notes.slice();
            // a voyage that does not add up yet is kept all the same, with that said first
            if (!result.ok) notes.unshift({ field: 'other', port: null, status: 'not_found', comment: t('sp.batch.incomplete') });
            const made = await sp.add(out.calc, result, { contractId: ct.id, notes, note: t('sp.batch.note', { pages: pagesText(row.pages) }) });
            Object.assign(row, { status: 'saved', id: made.id, title: out.calc.name, sum: C.summaryOf(out.calc, result), flags: notes.length });
          } catch (e) {
            row.status = 'failed'; row.error = errText(e);
            if (e && ['plan', 'auth', 'forbidden', 'limit', 'full'].indexOf(e.code) >= 0) R.stop = true;
          }
          render();
        }
      };
      await Promise.all([worker(), worker()]);
      R.active = false;
      try { ui.list = await sp.list(); } catch (e) { ui.list = null; }
      render();
    }

    // ------------------------------------------------------------ the counterparty's figures, pasted as a column
    /** The rows on screen from the earliest voyage to the latest: the order of a claim sent for the month. */
    const inVoyageOrder = () => filtered().slice().reverse();
    const parseColumn = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => E.num(x.replace(/[^\d.,\-\s]/g, '')));
    function claimsPreview() {
      const box = $('#sp-cl-preview'), go = $('#sp-cl-go');
      if (!box) return;
      const rows = inVoyageOrder(), nums = parseColumn(val('sp-cl-text')), bad = nums.some((n) => isNaN(n));
      const ok = nums.length === rows.length && !bad;
      let h = '<p class="note ' + (ok ? 'note-ok' : 'note-warn') + '">' + esc(bad ? t('cl.paste.bad') : t('cl.paste.count', { lines: nums.length, n: rows.length })) + '</p>';
      if (nums.length && !bad) {
        h += '<table class="sp-table"><tbody>' + rows.map((r, i) => {
          const cur = (r.meta.sum && r.meta.sum.currency) || 'USD', ours = signed(r.meta.sum), theirs = i < nums.length ? nums[i] : null;
          return '<tr><td>' + (i + 1) + '</td><td>' + esc(title(r.meta)) + '</td><td class="num">' + (ours == null ? '—' : esc(money(ours, cur))) + '</td><td class="num">' + (theirs == null ? '' : esc(money(theirs, cur))) + '</td><td class="num">' +
            (theirs == null || ours == null ? '' : gapHTML(Math.round((theirs - ours) * 100) / 100, cur)) + '</td></tr>';
        }).join('') + '</tbody></table>';
      }
      box.innerHTML = h;
      if (go) go.disabled = !ok;
    }
    function claimsDialog() {
      const rows = inVoyageOrder();
      app.dialog('<div class="dlg-h"><h2>' + esc(t('cl.paste')) + '</h2>' + btn('dlg-close', t('common.close')) + '</div><div class="dlg-b">' +
        '<p>' + esc(t('cl.paste.lead', { n: rows.length })) + '</p>' +
        '<div><label class="f-l" for="sp-cl-text">' + esc(t('cl.paste.label')) + '</label><textarea id="sp-cl-text" data-sp="cl-text" rows="8" inputmode="decimal" spellcheck="false"></textarea></div>' +
        '<div id="sp-cl-preview"></div><div id="sp-dlg-msg"></div>' +
        '<div>' + btn('sp-claims-go', t('cl.paste.go'), 'btn btn-primary', ' id="sp-cl-go" disabled') + '</div></div>');
      claimsPreview();
      const el = $('#sp-cl-text');
      if (el) el.focus();
    }
    /** Write each figure into its voyage as a new version, so it is kept with the calculation and its history. */
    async function saveClaims() {
      const rows = inVoyageOrder(), nums = parseColumn(val('sp-cl-text')), msg = $('#sp-dlg-msg'), go = $('#sp-cl-go');
      if (nums.length !== rows.length || nums.some((n) => isNaN(n))) return;
      if (go) go.disabled = true;
      let done = 0, failed = 0;
      for (let i = 0; i < rows.length; i++) {
        if (msg) msg.innerHTML = '<p class="f-hint" role="status">' + esc(t('cl.paste.saving', { done: i, n: rows.length })) + '</p>';
        try {
          const r = await sp.load(rows[i].id), calc = M.normalizeCalc(r.calc), amount = String(Math.round(nums[i] * 100) / 100);
          if (E.num(calc.meta.claimAmount) === Number(amount)) { done++; continue; }
          calc.meta.claimAmount = amount;
          await sp.save(rows[i].id, r.head, calc, E.compute(calc), { note: t('cl.paste.note'), status: (r.meta && r.meta.status) || 'draft', notes: r.notes });
          done++;
        } catch (e) { failed++; }
      }
      app.closeDialog();
      app.toast(failed ? t('cl.paste.partly', { done, n: rows.length }) : t('cl.paste.done', { n: done }));
      // the calculation on screen may be one of them: the bar will offer its newer version
      await refresh();
    }

    // ------------------------------------------------------------ the monthly table
    function csv() {
      const f = V.fmtNumber, sep = state.lang === 'en' || state.lang === 'zh' ? ',' : ';';
      const q = (v) => { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      // words typed by people (some of them outside the company) must stay words when a spreadsheet opens the file
      const w = (v) => { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
      const dur = (min) => (min == null ? '' : Math.floor(Math.round(min) / 60) + ':' + two(Math.round(min) % 60));
      const head = ['#', t('f.vessel'), t('f.voyage'), t('sp.calcs.col.title'), t('sp.calcs.col.period'), t('sp.csv.contract'), t('sp.calcs.col.status'), t('sp.csv.time'), t('t.demRate'), t('t.currency'), t('sp.csv.amount'), t('cl.col.theirs'), t('cl.col.gap')];
      const lines = [head.map(q).join(sep)];
      const n2 = (v) => (v == null ? '' : f(v, state.lang, 2).replace(/\s/g, ''));
      filtered().slice().reverse().forEach((r, i) => {
        const m = r.meta, s = m.sum || {}, ct = contractOf(r.contractId), cl = claimOf(r);
        lines.push([i + 1, w(m.vessel), w(m.voyage), w(title(m)), m.period, w(ct ? ct.data.name : ''), t('sp.status.' + (m.status || 'draft')), dur(s.outcome === 'despatch' ? s.desMin : s.demMin), s.rate == null ? '' : f(s.rate, state.lang, 2).replace(/\s/g, ''), s.currency || '', n2(signed(s)), n2(cl.theirs), n2(cl.gap)].map(q).join(sep));
      });
      app.download('stalia-' + (ui.f.month || 'summary') + '.csv', 'text/csv;charset=utf-8', '﻿' + lines.join('\r\n') + '\r\n');
    }

    // ------------------------------------------------------------ what buttons do
    const actions = {
      'sp-show'() { show('calcs'); },
      'sp-close'() { hide(); },
      'sp-tab'(el) { ui.tab = el.dataset.tab; ui.error = ''; render(); },
      async 'sp-create'() {
        const company = val('sp-company'), me = val('sp-name');
        if (!company || !me) { ui.error = t('sp.err.name'); render(); return; }
        if (await run(() => sp.createSpace(company.slice(0, 120), me.slice(0, 80)), true)) { ui.tab = 'calcs'; app.toast(t('sp.toast.joined', { name: company })); }
        refresh();
      },
      async 'sp-join'() {
        const link = C.parseLink(val('sp-link')), me = val('sp-name2');
        if (!link || link.kind !== 'join') { ui.error = t('sp.err.link'); render(); return; }
        if (!me) { ui.error = t('sp.err.name'); render(); return; }
        if (await run(() => sp.join(link.token, link.key, me.slice(0, 80)), true)) { ui.pending = ''; ui.tab = 'calcs'; }
        await refresh();
        if (ui.over) app.toast(t('sp.toast.joined', { name: ui.over.space.name }));
      },
      'sp-forget'() { sp.forget(); ui.over = ui.list = ui.contracts = null; ui.error = ''; render(); renderBar(); },
      async 'sp-open'(el) { await run(() => openCalc(el.dataset.id)); },
      async 'sp-del'(el) {
        if (!window.confirm(t('sp.calcs.deleteAsk'))) return;
        if ((await run(() => sp.remove(el.dataset.id))) === undefined && ui.error) return;
        if (state.cloud && state.cloud.id === el.dataset.id) { state.cloud = null; app.touch(); }
        refresh();
      },
      'sp-csv'() { csv(); },
      'sp-claims'() { claimsDialog(); },
      'sp-claims-go'() { saveClaims(); },
      // a month's scan
      'sp-b-start'(el) { B.contractId = el.dataset.id; ui.tab = 'batch'; ui.error = ''; render(); },
      'sp-b-cut'(el) {
        const i = parseInt(el.dataset.i, 10), at = B.starts.indexOf(i);
        if (at >= 0) B.starts.splice(at, 1); else B.starts.push(i);
        render();
      },
      'sp-b-clear'() { B.pages = []; B.starts = [0]; B.error = ''; B.run = null; render(); },
      'sp-b-go'() {
        if (B.run || !B.pages.length || !canRead()) return;
        B.run = { rows: C.groupPages(B.pages.length, B.starts).map((g) => ({ pages: g, status: 'wait', error: '', id: '', title: '', sum: null, flags: 0 })), active: false, stop: false, aborts: new Set() };
        runBatch();
      },
      'sp-b-stop'() { const R = B.run; if (!R) return; R.stop = true; for (const a of R.aborts) a.abort(); },
      'sp-b-retry'(el) { const R = B.run, r = R && R.rows[parseInt(el.dataset.k, 10)]; if (!r || R.active) return; r.status = 'wait'; r.error = ''; runBatch(); },
      'sp-b-new'() { B.pages = []; B.starts = [0]; B.error = ''; B.run = null; render(); },
      'sp-b-list'() { ui.f.contract = B.contractId; ui.f.month = ''; ui.f.status = ''; ui.f.q = ''; ui.tab = 'calcs'; render(); },
      // the open calculation
      async 'sp-add'() {
        if (!sp.session()) { show(); return; }
        const r = await run(() => sp.add(state.calc, state.result, { contractId: state.contractId || '', notes: state.notes }));
        if (!r) return;
        state.cloud = { id: r.id, base: 1, head: 1, role: role(), guest: false, active: true, contractId: state.contractId || '', status: 'draft', comments: 0, saved: fresh(), newer: null };
        if (state.source === 'example' || state.source === 'blank') state.source = 'space';
        ui.list = null; app.touch(); renderBar(); watch();
        app.toast(t('sp.save.added'));
      },
      'sp-save'() { askNote('sp-save-go', t('sp.bar.save'), t('sp.save.go')); },
      async 'sp-save-go'() { if (!guestSigned()) return; const note = val('sp-note'); app.closeDialog(); await saveVersion(note, false); },
      async 'sp-save-over'() { app.closeDialog(); await saveVersion('', true); },
      async 'sp-latest'() { app.closeDialog(); const c = state.cloud; if (c) await run(() => openCalc(c.id, { guest: c.guest })); },
      'sp-history'() { historyDialog(); },
      async 'sp-open-v'(el) { app.closeDialog(); const c = state.cloud; await run(() => openCalc(c.id, { guest: c.guest, n: parseInt(el.dataset.n, 10) })); },
      async 'sp-diff'(el) {
        const c = state.cloud, n = parseInt(el.dataset.n, 10), box = $('#sp-diff-' + n);
        if (!box) return;
        if (box.innerHTML) { box.innerHTML = ''; return; }
        const pair = await run(async () => [await sp.version(c.id, n - 1, { guest: c.guest }), await sp.version(c.id, n, { guest: c.guest })]);
        if (!pair) return;
        const d = C.diff(M.normalizeCalc(pair[0]), M.normalizeCalc(pair[1]));
        box.innerHTML = d.length ? '<ul>' + d.slice(0, 60).map((x) => '<li>' + esc(fmtChange(x, state.lang)) + '</li>').join('') + '</ul>' : '<p class="f-hint">' + esc(t('sp.hist.none')) + '</p>';
      },
      'sp-access'() { accessDialog(); },
      async 'sp-share'() {
        const label = val('sp-share-label'), r = $('#sp-share-role').value, c = state.cloud;
        if (!label) { $('#sp-dlg-msg').innerHTML = '<p class="note note-err">' + esc(t('sp.err.name')) + '</p>'; return; }
        const s = await run(() => sp.share(c.id, r, label.slice(0, 80)));
        if (s) accessDialog(C.shareLink(app.link(), s.calcId, s.token, s.key));
      },
      async 'sp-unshare'(el) { await run(() => sp.unshare(el.dataset.id)); accessDialog(); },
      'sp-talk'() { talkDialog(); },
      async 'sp-say-go'() {
        const text = val('sp-say'), c = state.cloud;
        if (!guestSigned() || !text) return;
        await run(() => sp.comment(c.id, text, { guest: c.guest }));
        talkDialog();
      },
      async 'sp-agree'() {
        const c = state.cloud;
        if (!guestSigned()) return;
        await run(() => sp.comment(c.id, '', { guest: c.guest, type: 'agree', n: c.base }));
        talkDialog();
      },
      'sp-copy'(el) { const src = $('#' + el.dataset.from); if (src) app.copy(src.textContent); },
      // contracts
      async 'sp-ct-save'() {
        const name = val('sp-ct-name');
        if (!name) { ui.error = t('sp.err.name'); render(); return; }
        const data = { name: name.slice(0, 120), counterparty: val('sp-ct-cp').slice(0, 120), clauses: val('sp-ct-clauses').slice(0, 3000), terms: termsOf(state.calc) };
        if (await run(() => sp.saveContract(data))) app.toast(t('sp.ct.saved'));
        refresh();
      },
      async 'sp-ct-update'(el) {
        const c = contractOf(el.dataset.id);
        if (!c || !window.confirm(t('sp.ct.updateAsk', { name: c.data.name }))) return;
        if (await run(() => sp.saveContract(Object.assign({}, c.data, { terms: termsOf(state.calc), clauses: state.calc.meta.clauses || c.data.clauses || '' }), c.id, c.rev))) app.toast(t('sp.ct.saved'));
        refresh();
      },
      async 'sp-ct-del'(el) { if (!window.confirm(t('sp.ct.deleteAsk'))) return; await run(() => sp.removeContract(el.dataset.id)); refresh(); },
      'sp-ct-filter'(el) { ui.f.contract = el.dataset.id; ui.tab = 'calcs'; render(); },
      'sp-ct-new'(el) {
        const c = contractOf(el.dataset.id);
        if (!c) return;
        const calc = M.normalizeCalc(JSON.parse(JSON.stringify(c.data.terms)));
        calc.meta.clauses = c.data.clauses || calc.meta.clauses || '';
        app.setCalc(calc, { source: 'space', pristine: false, contractId: c.id });
        hide();
        window.scrollTo(0, 0);
        app.toast(t('sp.ct.started', { name: c.data.name }));
      },
      // people
      async 'sp-me-save'() { const me = val('sp-me'); if (!me) return; await run(() => sp.rename(me.slice(0, 80))); refresh(); },
      async 'sp-invite'() {
        const inv = await run(() => sp.invite($('#sp-inv-role').value, 14, 20));
        if (inv) { ui.invite = C.inviteLink(app.link(), inv.token, inv.key); render(); }
      },
      async 'sp-kick'(el) { if (!window.confirm(t('sp.people.removeAsk'))) return; await run(() => sp.removeMember(el.dataset.id)); refresh(); },
      async 'sp-licence'() { if (await run(() => sp.licence(val('sp-lic')))) app.toast(t('sp.plan.ok')); refresh(); },
      'sp-recovery'() { app.download('stalia-space-recovery.json', 'application/json', JSON.stringify(sp.recovery(), null, 2)); },
      async 'sp-leave'() {
        if (!window.confirm(t('sp.leave.ask'))) return;
        await run(() => sp.leave(), true);
        sp.forget(); ui.over = ui.list = ui.contracts = null; state.cloud = state.cloud && state.cloud.guest ? state.cloud : null; app.touch(); render(); renderBar();
      },
      async 'sp-delete'() {
        if (!window.confirm(t('sp.delete.ask'))) return;
        if ((await run(() => sp.deleteSpace())) === undefined && ui.error) { render(); return; }
        ui.over = ui.list = ui.contracts = null; if (state.cloud && !state.cloud.guest) state.cloud = null; app.touch(); render(); renderBar();
      },
    };
    /** The terms of a calculation without what happened on one voyage: what a contract keeps. */
    function termsOf(calc) {
      const c = M.normalizeCalc(JSON.parse(JSON.stringify(calc)));
      c.name = ''; c.meta.voyage = ''; c.meta.vessel = ''; c.meta.remarks = '';
      for (const p of c.ports) {
        p.nor.tendered = ''; p.nor.manualStart = ''; p.commenced = ''; p.completed = ''; p.events = [];
        if (p.allowed.type === 'rate') p.allowed.quantity = '';
        p.calendar.holidays = [];
      }
      return c;
    }

    // typing and choosing inside the overlay and the bar
    document.addEventListener('input', (e) => {
      const k = e.target && e.target.dataset && e.target.dataset.sp;
      if (k === 'q') { ui.f.q = e.target.value; render(); }
      if (k === 'cl-text') claimsPreview();
    });
    document.addEventListener('change', async (e) => {
      const el = e.target, k = el && el.dataset && el.dataset.sp;
      if (!k) return;
      if (k === 'contract' || k === 'month' || k === 'status' && el.id !== 'cb-status') { ui.f[k] = el.value; render(); return; }
      if (k === 'b-contract') { B.contractId = el.value; return; }
      if (k === 'b-per') {
        B.per = Math.min(reader.maxPages, Math.max(1, parseInt(el.value, 10) || 1));
        B.starts = C.evenStarts(B.pages.length, B.per);
        render(); return;
      }
      if (k === 'b-files') {
        if (B.busy || !el.files || !el.files.length) return;
        B.busy = 'opening'; B.error = ''; render();
        let last = 0;
        const problem = await reader.pagesInto(B.pages, el.files, MAX_BATCH, () => { const now = Date.now(); if (now - last > 250) { last = now; render(); } });
        B.busy = '';
        B.error = problem === 'too_many' ? t('sp.batch.tooMany', { n: MAX_BATCH }) : problem === 'office' ? t('imp.officeFile') : problem === 'pdf' ? t('imp.pdfFail') : problem === 'image' ? t('imp.imgFail') : '';
        B.starts = C.evenStarts(B.pages.length, B.per);
        render(); return;
      }
      if (k === 'role') { await run(() => sp.setRole(el.dataset.id, el.value)); refresh(); return; }
      if (k === 'status') {
        const c = state.cloud;
        if (!c) return;
        const row = (ui.list || []).find((r) => r.id === c.id) || (await run(async () => (await sp.list()).find((r) => r.id === c.id)));
        if (!row) return;
        // the list entry may still describe an older version (a counterparty saved since): bring it up to date first
        if (row.stale) { const m = await run(() => sp.refreshMeta(row), true); if (m) { row.meta = m; row.metaHead = row.head; row.stale = false; } }
        if (await run(() => sp.setMeta(row, { meta: { status: el.value } }))) { c.status = el.value; ui.list = null; app.touch(); }
        renderBar();
        return;
      }
      if (k === 'restore' && el.files && el.files[0]) {
        try { sp.restore(JSON.parse(await el.files[0].text())); ui.error = ''; } catch (x) { ui.error = t('sp.err.link'); }
        refresh();
      }
    });

    /**
     * Links that came with the page's address: "#join=…" (an invitation) and "#open=…" (one calculation).
     * @returns {Promise<boolean>} true when a calculation was opened from a link
     */
    async function start(hash) {
      renderBar();
      const link = C.parseLink(hash || '');
      if (link) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ } }
      if (link && link.kind === 'join') {
        if (sp.session()) { show(); app.toast(t('sp.err.already')); }
        else { ui.pending = '#join=' + link.token + '~' + link.key; show(); }
        return false;
      }
      if (link && link.kind === 'open') {
        sp.rememberGuest(link.calcId, link.token, link.key);
        try { await openCalc(link.calcId, { guest: true }); return true; } catch (e) { app.toast(errText(e)); return false; }
      }
      // a calculation from the space was on screen when the page was closed: see where it stands now
      const c = state.cloud;
      if (c) {
        watch();
        try {
          const p = await sp.peek(c.id, { guest: c.guest });
          if (p.head > c.head) { c.head = p.head; c.newer = { n: p.head, by: p.by }; }
          c.comments = p.comments; c.active = p.active;
        } catch (e) { if (e.code === 'auth' || e.code === 'not_found') { state.cloud = null; app.touch(); } }
        renderBar();
      }
      if (sp.session() && !ui.contracts) { try { ui.contracts = await sp.contracts(); renderBar(); } catch (e) { /* the bar says less */ } }
      return false;
    }

    return { enabled: true, actions, changed, render() { render(); renderBar(); }, start, hide, contractOf, core: sp, _ui: ui };
  }

  window.StaliaSpace = { create };
})();
