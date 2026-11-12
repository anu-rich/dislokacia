/*! Stalia — "From documents": add pages, black out what stays private, have them read, check the result. */
(function () {
  'use strict';

  const MAX_EDGE = 2200;        // longest side of a page sent for reading, in pixels (the reader's limit is a little higher)
  const KEEP_PAGES = 60;        // pages that may sit in the list while the user picks the ones that matter
  const THUMB_EDGE = 360;
  const DOCS = ['cp', 'sof'];

  /**
   * @param {object} app  what the calculator screen lends to this module:
   *   t, esc, state, config, engine, model, view, extract, schema, licenceKey(), isPro(), toast(), showPro(),
   *   apply(calc, notes), overlayOpened(name), overlayClosed(name), blankish()
   */
  function create(app) {
    const { t, esc, engine: E, view: V, extract: X, schema: S } = app;
    const AI = Object.assign({
      endpoint: '', maxPages: 20, maxMb: 18, pdfjs: 'vendor/pdfjs/pdf.min.js', pdfWorker: 'vendor/pdfjs/pdf.worker.min.js',
      ownKey: true, directReader: 'vendor/reader/stalia-reader.js', directBaseUrl: '',
    }, app.config.ai || {});

    // ------------------------------------------------------------ one's own Claude API key
    // Anyone with a key of their own can read documents without the reading server: the pages then go from this
    // device straight to Anthropic. The key is kept in this browser only and is never sent anywhere else.
    const OWN = 'stalia.ai.v1';
    const OWN_MODELS = [['claude-haiku-5-5', 'Claude Haiku 5.5 · ~$0.01'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 · ~$0.10']];
    const own = {
      allowed: () => AI.ownKey !== false && typeof AI.reader !== 'function',
      load() {
        try {
          const v = JSON.parse(localStorage.getItem(OWN) || 'null');
          return v && typeof v.key === 'string' && v.key ? { key: v.key, model: OWN_MODELS.some((m) => m[0] === v.model) ? v.model : OWN_MODELS[0][0] } : null;
        } catch (e) { return null; }
      },
      save(v) { try { localStorage.setItem(OWN, JSON.stringify(v)); return true; } catch (e) { return false; } },
      clear() { try { localStorage.removeItem(OWN); } catch (e) { /* nothing was kept */ } },
    };
    const mine = () => (own.allowed() ? own.load() : null);
    const $ = (s, r) => (r || document).querySelector(s);
    const els = { box: $('#import'), body: $('#imp-body'), file: $('#imp-file'), cam: $('#imp-cam'), redact: $('#redact'), stage: $('#rd-stage') };

    const st = {
      open: false, step: 'docs', pages: [], busy: '', error: '', errorPro: false, target: 'cp',
      read: null, keep: true, quota: null, abort: null, seq: 0,
    };
    const rd = { open: false, id: null, zoom: 1, fit: 0, pointers: new Map(), draw: null, pinch: null };
    const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    // ------------------------------------------------------------ images
    function canvasOf(w, h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
      return c;
    }
    const toBlob = (canvas, quality) => new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality);
    });
    /** Decode any image the browser understands; phone photos come out upright. */
    async function decode(blob) {
      if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(blob); } catch (e) { /* fall through to <img> */ }
      }
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('decode')); img.src = url; });
        return img;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    const sizeOf = (im) => ({ w: im.naturalWidth || im.width, h: im.naturalHeight || im.height });
    const release = (im) => { if (im && typeof im.close === 'function') im.close(); };

    /** Draw a page with its marks painted solid black. `turn` = quarter turns clockwise applied first (used by Rotate). */
    function paint(im, marks, edge, turn) {
      const s = sizeOf(im), q = ((turn || 0) % 4 + 4) % 4;
      const k = Math.min(1, edge / Math.max(s.w, s.h));
      const w = s.w * k, h = s.h * k;
      const c = q % 2 ? canvasOf(h, w) : canvasOf(w, h), g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.save();
      g.translate(c.width / 2, c.height / 2);
      g.rotate(q * Math.PI / 2);
      g.imageSmoothingQuality = 'high';
      g.drawImage(im, -w / 2, -h / 2, w, h);
      g.restore();
      g.fillStyle = '#000';
      for (const m of marks || []) {
        // one pixel wider on every side: nothing of a covered letter is left at the edge
        g.fillRect(Math.floor(m.x * c.width) - 1, Math.floor(m.y * c.height) - 1, Math.ceil(m.w * c.width) + 2, Math.ceil(m.h * c.height) + 2);
      }
      return c;
    }
    async function refreshThumb(p) {
      const im = await decode(p.blob);
      try { p.thumb = paint(im, p.marks, THUMB_EDGE).toDataURL('image/jpeg', 0.7); } finally { release(im); }
    }
    async function addCanvas(canvas, doc) {
      const blob = await toBlob(canvas, 0.9);
      const p = { id: 'pg' + (++st.seq), doc, blob, w: canvas.width, h: canvas.height, marks: [], thumb: '' };
      p.thumb = paint(canvas, [], THUMB_EDGE).toDataURL('image/jpeg', 0.7);
      st.pages.push(p);
    }

    // ------------------------------------------------------------ files in
    let pdfLib = null;
    async function pdfjs() {
      if (!pdfLib) {
        const lib = await import(new URL(AI.pdfjs, document.baseURI).href);
        lib.GlobalWorkerOptions.workerSrc = new URL(AI.pdfWorker, document.baseURI).href;
        pdfLib = lib;
      }
      return pdfLib;
    }
    const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
    const isImage = (f) => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name || '');

    async function addPdf(file, doc) {
      const lib = await pdfjs();
      const dir = new URL('.', new URL(AI.pdfjs, document.baseURI)).href;
      const task = lib.getDocument({
        data: new Uint8Array(await file.arrayBuffer()),
        cMapUrl: dir + 'cmaps/', cMapPacked: true, standardFontDataUrl: dir + 'standard_fonts/', // fonts for PDFs that do not carry their own
      });
      const pdf = await task.promise;
      try {
        for (let n = 1; n <= pdf.numPages && st.pages.length < KEEP_PAGES; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: MAX_EDGE / Math.max(base.width, base.height) });
          const canvas = canvasOf(viewport.width, viewport.height), g = canvas.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: g, viewport, canvas }).promise;
          await addCanvas(canvas, doc);
          page.cleanup();
          render();
        }
      } finally { try { await task.destroy(); } catch (e) { /* already gone */ } }
    }
    async function addImage(file, doc) {
      const im = await decode(file);
      try { await addCanvas(paint(im, [], MAX_EDGE), doc); } finally { release(im); }
    }
    async function addFiles(files, doc) {
      files = Array.from(files || []);
      if (!files.length || st.busy) return;
      st.busy = 'opening'; st.error = ''; st.errorPro = false; st.target = doc;
      render();
      let problem = '';
      for (const f of files) {
        if (st.pages.length >= KEEP_PAGES) { problem = t('imp.tooMany', { n: AI.maxPages }); break; }
        try {
          if (isPdf(f)) await addPdf(f, doc);
          else if (isImage(f)) await addImage(f, doc);
          else problem = t('imp.imgFail');
        } catch (e) { problem = t(isPdf(f) ? 'imp.pdfFail' : 'imp.imgFail'); }
      }
      st.busy = ''; st.error = problem;
      render();
    }

    // ------------------------------------------------------------ pages out
    const base64Of = (blob) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
      r.onerror = () => reject(new Error('read'));
      r.readAsDataURL(blob);
    });
    /** The pages exactly as they leave the device: marks painted in, JPEG, within the size budget. null if they cannot fit. */
    async function flatten() {
      const budget = AI.maxMb * 1024 * 1024;
      const ordered = DOCS.flatMap((d) => st.pages.filter((p) => p.doc === d));
      for (const [edge, quality] of [[MAX_EDGE, 0.82], [MAX_EDGE, 0.66], [1800, 0.62], [1500, 0.55]]) {
        const out = [];
        let total = 0;
        for (const p of ordered) {
          const im = await decode(p.blob);
          let data;
          try { data = await base64Of(await toBlob(paint(im, p.marks, edge), quality)); } finally { release(im); }
          total += data.length;
          if (total > budget) break;
          out.push({ doc: p.doc, type: 'image/jpeg', data });
        }
        if (out.length === ordered.length) return out;
      }
      return null;
    }

    // ------------------------------------------------------------ the reading
    const ERRORS = {
      network: 'imp.err.network', unavailable: 'imp.err.unavailable', origin: 'imp.err.unavailable', limit: 'imp.err.limit', pro: 'imp.err.pro',
      refused: 'imp.err.refused', too_big: 'imp.err.tooBig', server: 'imp.err.server', bad_request: 'imp.err.server', empty: 'imp.err.empty',
    };
    /** Sends the pages; never throws. A different reader (tests, the preview build) can be put in config.ai.reader. */
    async function send(payload, signal) {
      if (typeof AI.reader === 'function') {
        try { return await AI.reader(payload, signal); } catch (e) { return { ok: false, error: e && e.name === 'AbortError' ? 'aborted' : 'server' }; }
      }
      const key = mine();
      if (key) {
        try {
          const lib = await import(new URL(AI.directReader, document.baseURI).href);
          return await lib.readDirect({ apiKey: key.key, model: key.model, pages: payload.pages, lang: payload.lang, signal, baseURL: AI.directBaseUrl || undefined });
        } catch (e) { return { ok: false, error: 'server' }; }
      }
      if (!/^https?:\/\//.test(AI.endpoint || '')) return { ok: false, error: 'unavailable' };
      try {
        const res = await fetch(AI.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
        let j = null;
        try { j = await res.json(); } catch (e) { /* not JSON: a server error page */ }
        if (res.ok && j && j.ok && j.extraction) return j;
        return { ok: false, error: (j && j.error) || 'server', quota: j && j.quota, limit: j && j.limit };
      } catch (e) {
        return { ok: false, error: e && e.name === 'AbortError' ? 'aborted' : 'network' };
      }
    }
    const available = () => typeof AI.reader === 'function' || /^https?:\/\//.test(AI.endpoint || '') || !!mine();

    async function read() {
      if (st.busy) return;
      st.error = ''; st.errorPro = false;
      if (!st.pages.length) { st.error = t('imp.needDoc'); render(); return; }
      if (st.pages.length > AI.maxPages) { st.error = t('imp.tooMany', { n: AI.maxPages }); render(); return; }
      if (!available()) { st.error = t('imp.err.unavailable'); render(); return; }
      st.busy = 'reading';
      render();
      const fail = (code, vars) => { st.busy = ''; st.abort = null; st.error = t(ERRORS[code] || 'imp.err.server', vars); st.errorPro = code === 'pro'; render(); };
      let pages;
      try { pages = await flatten(); } catch (e) { pages = null; }
      if (!st.open || st.busy !== 'reading') return; // closed meanwhile
      if (!pages) { fail('too_big'); return; }
      st.abort = typeof AbortController === 'function' ? new AbortController() : null;
      const res = await send({ v: 1, lang: app.state.lang, license: app.licenceKey() || '', pages }, st.abort ? st.abort.signal : undefined);
      if (!st.open || res.error === 'aborted') { st.busy = ''; st.abort = null; return; }
      if (res.quota) st.quota = res.quota;
      if (!res.ok) {
        if (res.error === 'too_many') { st.busy = ''; st.error = t('imp.tooMany', { n: res.limit || AI.maxPages }); render(); }
        else if (res.error === 'key') { st.busy = ''; st.abort = null; st.error = t('imp.err.key', { text: res.said || '—' }); render(); }
        else fail(res.error);
        return;
      }
      if (S.shapeError(res.extraction, S.SCHEMA)) { fail('server'); return; }
      const got = X.toCalc(res.extraction);
      if (got.empty) { fail('empty'); return; }
      st.read = got; st.busy = ''; st.abort = null; st.step = 'review'; st.keep = true;
      render();
      els.box.scrollTop = 0;
    }

    // ------------------------------------------------------------ what will be applied
    /** With one document only, the other half can stay as it is in the calculation on screen. */
    function keepMode() {
      if (!st.read) return '';
      const have = { cp: st.pages.some((p) => p.doc === 'cp'), sof: st.pages.some((p) => p.doc === 'sof') };
      if (have.cp === have.sof || app.blankish()) return '';
      const base = app.state.calc;
      if (have.sof) return 'terms';
      return base.ports.some((p) => X.hasFacts(p)) ? 'facts' : '';
    }
    function outcome() {
      const mode = keepMode();
      return mode && st.keep ? X.merge(app.state.calc, st.read, mode) : { calc: st.read.calc, notes: st.read.notes };
    }
    /** The money terms in words, also when the times are still missing and no result can be computed. */
    function termsText(calc) {
      const dem = E.num(calc.demurrageRate) || 0, com = E.num(calc.commissionPct) || 0;
      const probe = {
        ports: calc.ports,
        totals: {
          demRate: dem, despatchMode: calc.despatchMode, desRate: calc.despatchMode === 'custom' ? (E.num(calc.despatchRate) || 0) : dem / 2,
          basis: calc.despatchBasis, mode: calc.laytimeMode, once: calc.onceOnDemurrage, commissionPct: com,
        },
      };
      const words = V.termsText(calc, probe, app.state.lang);
      if (dem > 0) return words;
      // no rate was read: leave the sentence about it out rather than print a rate of zero
      const rest = words.slice(words.indexOf('; ') + 2);
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
    const portCaption = (p, i) => t('p.port', { n: i + 1 }) + ' · ' + t('p.op.' + p.operation) + (p.name ? ' · ' + p.name : '');
    function noteHTML(n, calc, withLink) {
      const f = X.FIELDS[n.field] || X.FIELDS.other;
      const label = (f.label ? t(f.label) : '') + (n.port != null && calc.ports[n.port] ? (f.label ? ' — ' : '') + portCaption(calc.ports[n.port], n.port) : '');
      const path = withLink ? X.notePath(n, calc) : '';
      return '<li class="imp-note imp-note-' + esc(n.status) + '"><span class="pill">' + esc(t('imp.note.' + n.status)) + '</span><span class="imp-note-t">' +
        (label ? '<b>' + esc(label) + '</b>' : '') + (n.comment ? (label ? ' — ' : '') + esc(n.comment) : '') + '</span>' +
        (path ? '<button type="button" class="btn btn-sm" data-act="note-go" data-path="' + esc(path) + '">' + esc(t('imp.fix')) + '</button>' : '') + '</li>';
    }

    // ------------------------------------------------------------ screens
    function pageTile(p, n) {
      return '<figure class="imp-page"><button type="button" class="imp-thumb" data-act="imp-redact" data-page="' + p.id + '" title="' + esc(t('imp.redact')) + '">' +
        '<img src="' + p.thumb + '" alt="' + esc(t('imp.page', { n })) + '" width="' + Math.round(p.w / 10) + '" height="' + Math.round(p.h / 10) + '"></button>' +
        '<figcaption><b>' + esc(t('imp.page', { n })) + '</b>' + (p.marks.length ? '<span>' + esc(t('imp.marks', { n: p.marks.length })) + '</span>' : '') + '</figcaption>' +
        '<div class="imp-page-acts"><button type="button" class="btn btn-sm" data-act="imp-redact" data-page="' + p.id + '">' + esc(t('imp.redact')) + '</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-act="imp-remove" data-page="' + p.id + '">' + esc(t('imp.removePage')) + '</button></div></figure>';
    }
    function docsHTML() {
      const dis = st.busy ? ' disabled' : '';
      let h = '<p class="imp-lead">' + esc(t('imp.lead')) + '</p>';
      if (!available()) h += '<p class="note note-warn">' + esc(t('imp.err.unavailable')) + '</p>';
      h += '<div class="imp-slots">';
      for (const d of DOCS) {
        const pages = st.pages.filter((p) => p.doc === d);
        h += '<section class="imp-slot" data-doc="' + d + '"><h3>' + esc(t('imp.' + d)) + '</h3><p class="f-hint">' + esc(t('imp.' + d + '.hint')) + '</p>' +
          (pages.length ? '<div class="imp-pages">' + pages.map((p, i) => pageTile(p, i + 1)).join('') + '</div>' : '') +
          '<div class="imp-add"><button type="button" class="btn" data-act="imp-add" data-doc="' + d + '"' + dis + '>+ ' + esc(t('imp.addFile')) + '</button>' +
          (touch ? '<button type="button" class="btn" data-act="imp-cam" data-doc="' + d + '"' + dis + '>' + esc(t('imp.takePhoto')) + '</button>' : '') + '</div></section>';
      }
      h += '</div><p class="imp-privacy">' + esc(t('imp.privacy')) + '</p>';
      if (own.allowed()) {
        const key = own.load();
        h += '<details class="imp-key" id="imp-key"' + (st.keyOpen || (!key && !available()) ? ' open' : '') + '><summary>' + esc(t('imp.key.title')) + '</summary><div class="imp-key-b">' +
          '<p class="f-hint">' + esc(t('imp.key.hint')) + '</p>';
        if (key) {
          h += '<p class="note note-ok">' + esc(t('imp.key.saved')) + ' <code>' + esc(key.key.slice(0, 7) + '…' + key.key.slice(-4)) + '</code></p>' +
            '<div class="f"><label class="f-l" for="imp-key-model">' + esc(t('imp.key.model')) + '</label><select id="imp-key-model">' +
            OWN_MODELS.map((m) => '<option value="' + m[0] + '"' + (m[0] === key.model ? ' selected' : '') + '>' + esc(m[1]) + '</option>').join('') + '</select></div>' +
            '<div><button type="button" class="btn btn-sm" data-act="imp-key-remove">' + esc(t('imp.key.remove')) + '</button></div>';
        } else {
          h += '<div class="imp-key-row"><input type="password" id="imp-key-in" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(t('imp.key.title')) + '">' +
            '<button type="button" class="btn" data-act="imp-key-save">' + esc(t('imp.key.save')) + '</button></div>';
        }
        h += '</div></details>';
      }
      if (st.busy === 'opening') h += '<p class="note imp-wait" role="status">' + esc(t('imp.opening')) + '</p>';
      if (st.busy === 'reading') h += '<p class="note imp-wait" role="status">' + esc(t('imp.reading')) + '</p>';
      if (st.error) {
        h += '<p class="note note-err" role="alert">' + esc(st.error) + (st.errorPro && !app.isPro() ? ' <button type="button" class="btn btn-sm" data-act="pro">' + esc(t('nav.upgrade')) + '</button>' : '') + '</p>';
      }
      if (st.quota && !st.error) h += '<p class="f-hint">' + esc(t('imp.quota', { n: st.quota.left })) + '</p>';
      h += '<div class="imp-go"><button type="button" class="btn btn-primary btn-lg" data-act="imp-read"' + (st.busy || !st.pages.length ? ' disabled' : '') + '>' +
        esc(st.busy === 'reading' ? t('imp.reading') : t('imp.read')) + '</button></div>';
      return h;
    }
    function reviewHTML() {
      const lang = app.state.lang, mode = keepMode(), out = outcome(), calc = out.calc, m = calc.meta;
      const result = E.compute(calc);
      const kv = (k, v) => (v ? '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>' : '');
      const when = (s) => (s ? V.fmtDT(E.parseDT(s), lang) : '—');
      let h = '<h2 class="imp-h">' + esc(t('imp.review.title')) + '</h2><p class="imp-lead">' + esc(t('imp.review.lead')) + '</p>';
      if (mode) {
        h += '<label class="ck imp-keep"><input type="checkbox" id="imp-keep"' + (st.keep ? ' checked' : '') + '><span>' + esc(t('imp.keep.' + mode)) + '</span></label>';
      }
      h += '<section class="imp-sec"><h3>' + esc(t('imp.review.found')) + '</h3>';
      const cpDate = m.cpDate ? V.fmtDate(E.parseDT(m.cpDate), lang) : '';
      const fix = kv(t('f.vessel'), m.vessel) + kv(t('f.voyage'), m.voyage) + kv(t('st.cp'), m.cpForm && cpDate ? t('st.cpDated', { form: m.cpForm, date: cpDate }) : (m.cpForm || cpDate)) +
        kv(t('f.owners'), m.owners) + kv(t('f.charterers'), m.charterers) + kv(t('f.cargo'), m.cargo);
      if (fix) h += '<dl class="kv">' + fix + '</dl>';
      h += '<p class="imp-terms">' + esc(termsText(calc)) + '</p>';
      calc.ports.forEach((p, i) => {
        const mins = E.allowedMinutes(p.allowed);
        h += '<div class="imp-port"><h4>' + esc(portCaption(p, i)) + '</h4><p class="imp-terms">' + esc(V.portTermsText(p, lang)) +
          (mins > 0 ? ' <b>' + esc(t('r.allowed')) + ': ' + esc(V.fmtDur(mins, lang)) + '</b>' : '') + '</p>' +
          '<dl class="kv">' + '<dt>' + esc(t('n.tendered')) + '</dt><dd>' + esc(when(p.nor.tendered)) + '</dd>' +
          '<dt>' + esc(t('n.commenced')) + '</dt><dd>' + esc(when(p.commenced)) + '</dd>' +
          '<dt>' + esc(t('n.completed')) + '</dt><dd>' + esc(when(p.completed)) + '</dd></dl>' +
          '<p class="f-hint">' + esc(t('imp.review.events', { n: p.events.filter((e) => e.kind !== 'note').length })) + '</p></div>';
      });
      if (result.ok) {
        // the lines about time always; the line with the amount only when there is a rate to work it out with
        const lines = V.summaryText(calc, result, lang).split('\n').slice(1);
        h += '<pre class="imp-result">' + esc((E.num(calc.demurrageRate) > 0 ? lines : lines.slice(0, -1)).join('\n')) + '</pre>';
      }
      h += '</section><section class="imp-sec"><h3>' + esc(t('imp.review.notes')) + '</h3>' +
        (out.notes.length ? '<ul class="imp-notes">' + out.notes.map((n) => noteHTML(n, calc, false)).join('') + '</ul>' : '<p class="empty">' + esc(t('imp.review.none')) + '</p>') + '</section>';
      if (st.quota) h += '<p class="f-hint">' + esc(t('imp.quota', { n: st.quota.left })) + '</p>';
      h += '<div class="imp-go"><button type="button" class="btn btn-primary btn-lg" data-act="imp-apply">' + esc(t('imp.review.apply')) + '</button>' +
        '<button type="button" class="btn" data-act="imp-back">' + esc(t('imp.review.back')) + '</button></div>';
      return h;
    }
    function render() {
      if (!st.open) return;
      els.body.innerHTML = st.step === 'review' && st.read ? reviewHTML() : docsHTML();
    }

    // ------------------------------------------------------------ open / close
    function open() {
      if (st.open) return;
      st.open = true; st.error = ''; st.errorPro = false;
      if (st.step === 'review' && !st.read) st.step = 'docs';
      els.box.hidden = false; els.box.scrollTop = 0;
      document.body.style.overflow = 'hidden';
      render();
      app.overlayOpened('import');
    }
    /** Hide without touching the history (the Back button already did). */
    function hide() {
      if (rd.open) hideRedact();
      if (st.abort) { try { st.abort.abort(); } catch (e) { /* nothing to stop */ } }
      st.open = false; st.busy = ''; st.abort = null;
      els.box.hidden = true;
      document.body.style.overflow = '';
    }
    function close() { if (!st.open) return; hide(); app.overlayClosed('import'); }
    function reset() { st.pages = []; st.read = null; st.step = 'docs'; st.error = ''; st.quota = null; }

    function apply() {
      if (!st.read) return;
      const out = outcome();
      close();
      reset();
      app.apply(out.calc, out.notes);
    }

    // ------------------------------------------------------------ blacking out
    const pageById = (id) => st.pages.find((p) => p.id === id);
    const ordered = () => DOCS.flatMap((d) => st.pages.filter((p) => p.doc === d));
    let rdUrl = '';
    function rdRender() {
      const p = pageById(rd.id);
      if (!p) { closeRedact(); return; }
      const all = ordered(), i = all.indexOf(p);
      if (rdUrl) URL.revokeObjectURL(rdUrl);
      rdUrl = URL.createObjectURL(p.blob);
      $('#rd-count').textContent = (i + 1) + ' / ' + all.length;
      $('#rd-prev').disabled = i <= 0; $('#rd-next').disabled = i >= all.length - 1;
      els.stage.innerHTML = '<div class="rd-page" id="rd-page"><img src="' + rdUrl + '" alt="" draggable="false">' + '</div>';
      rd.zoom = 1;
      rdLayout();
      rdMarks();
      els.stage.scrollTop = 0; els.stage.scrollLeft = 0;
    }
    function rdLayout() {
      const p = pageById(rd.id), box = $('#rd-page');
      if (!p || !box) return;
      const availW = Math.max(120, els.stage.clientWidth - 16), availH = Math.max(160, els.stage.clientHeight - 16);
      // at 1× the whole page is visible; zooming enlarges it inside the scrolling stage
      rd.fit = Math.min(availW, availH * p.w / p.h, p.w);
      box.style.width = Math.round(rd.fit * rd.zoom) + 'px';
      box.style.aspectRatio = p.w + ' / ' + p.h;
    }
    function rdMarks() {
      const p = pageById(rd.id), box = $('#rd-page');
      if (!p || !box) return;
      box.querySelectorAll('.rd-mark').forEach((n) => n.remove());
      p.marks.forEach((m, i) => {
        const d = document.createElement('div');
        d.className = 'rd-mark'; d.dataset.i = String(i);
        d.style.cssText = 'left:' + m.x * 100 + '%;top:' + m.y * 100 + '%;width:' + m.w * 100 + '%;height:' + m.h * 100 + '%';
        box.appendChild(d);
      });
      $('#rd-undo').disabled = !p.marks.length; $('#rd-clear').disabled = !p.marks.length;
    }
    function setZoom(z, cx, cy) {
      const box = $('#rd-page');
      if (!box) return;
      z = Math.max(1, Math.min(6, z));
      const r = box.getBoundingClientRect(), sr = els.stage.getBoundingClientRect();
      if (cx == null) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
      const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height; // the point of the page under the fingers stays there
      rd.zoom = z;
      rdLayout();
      const r2 = box.getBoundingClientRect();
      els.stage.scrollLeft += (r2.left + fx * r2.width) - cx;
      els.stage.scrollTop += (r2.top + fy * r2.height) - cy;
    }
    const norm = (e, box) => { const r = box.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r }; };

    els.stage.addEventListener('pointerdown', (e) => {
      const box = $('#rd-page');
      if (!rd.open || !box || !box.contains(e.target)) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { els.stage.setPointerCapture(e.pointerId); } catch (x) { /* older browsers */ }
      rd.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (rd.pointers.size === 1) {
        const a = norm(e, box), el = document.createElement('div');
        el.className = 'rd-mark rd-new';
        box.appendChild(el);
        rd.draw = { id: e.pointerId, x0: a.x, y0: a.y, x1: a.x, y1: a.y, el, hit: e.target.classList.contains('rd-mark') ? e.target.dataset.i : null };
      } else if (rd.pointers.size === 2) {
        // a second finger: this is moving and zooming, not marking
        if (rd.draw) { rd.draw.el.remove(); rd.draw = null; }
        const [a, b] = Array.from(rd.pointers.values());
        rd.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: rd.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    els.stage.addEventListener('pointermove', (e) => {
      if (!rd.pointers.has(e.pointerId)) return;
      rd.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const box = $('#rd-page');
      if (!box) return;
      if (rd.pinch && rd.pointers.size >= 2) {
        const [a, b] = Array.from(rd.pointers.values());
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        els.stage.scrollLeft -= mx - rd.pinch.mx; els.stage.scrollTop -= my - rd.pinch.my;
        rd.pinch.mx = mx; rd.pinch.my = my;
        setZoom(rd.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / rd.pinch.dist, mx, my);
        return;
      }
      const d = rd.draw;
      if (!d || d.id !== e.pointerId) return;
      const a = norm(e, box);
      d.x1 = a.x; d.y1 = a.y;
      d.el.style.cssText = 'left:' + Math.min(d.x0, d.x1) * 100 + '%;top:' + Math.min(d.y0, d.y1) * 100 + '%;width:' + Math.abs(d.x1 - d.x0) * 100 + '%;height:' + Math.abs(d.y1 - d.y0) * 100 + '%';
    });
    function pointerEnd(e) {
      if (!rd.pointers.has(e.pointerId)) return;
      rd.pointers.delete(e.pointerId);
      if (rd.pinch) { if (rd.pointers.size === 0) rd.pinch = null; return; }
      const d = rd.draw, p = pageById(rd.id), box = $('#rd-page');
      if (!d || d.id !== e.pointerId) return;
      rd.draw = null;
      d.el.remove();
      if (!p || !box || e.type === 'pointercancel') return;
      const r = box.getBoundingClientRect();
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w * r.width >= 6 && h * r.height >= 6) p.marks.push({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w, h });
      else if (d.hit != null) p.marks.splice(+d.hit, 1); // a tap on a mark takes it off
      p.dirty = true;
      rdMarks();
    }
    els.stage.addEventListener('pointerup', pointerEnd);
    els.stage.addEventListener('pointercancel', pointerEnd);
    els.stage.addEventListener('wheel', (e) => {
      if (!rd.open || !(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls; with Ctrl it zooms
      e.preventDefault();
      setZoom(rd.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('resize', () => { if (rd.open) rdLayout(); });

    async function rotate() {
      const p = pageById(rd.id);
      if (!p || rd.busy) return;
      rd.busy = true;
      try {
        const im = await decode(p.blob);
        let c;
        try { c = paint(im, [], Math.max(p.w, p.h), 1); } finally { release(im); }
        p.blob = await toBlob(c, 0.92);
        p.w = c.width; p.h = c.height;
        p.marks = p.marks.map((m) => ({ x: 1 - m.y - m.h, y: m.x, w: m.h, h: m.w })); // the marks turn with the page
        p.dirty = true;
        rdRender();
      } finally { rd.busy = false; }
    }
    function openRedact(id) {
      if (!pageById(id) || st.busy) return;
      rd.id = id; rd.open = true; rd.pointers.clear(); rd.draw = null; rd.pinch = null;
      els.redact.hidden = false;
      rdRender();
      app.overlayOpened('redact');
    }
    function hideRedact() {
      if (!rd.open) return;
      rd.open = false;
      els.redact.hidden = true;
      els.stage.innerHTML = '';
      if (rdUrl) { URL.revokeObjectURL(rdUrl); rdUrl = ''; }
      const dirty = st.pages.filter((p) => p.dirty);
      dirty.forEach((p) => { p.dirty = false; });
      Promise.all(dirty.map((p) => refreshThumb(p).catch(() => {}))).then(render);
      render();
    }
    function closeRedact() { if (!rd.open) return; hideRedact(); app.overlayClosed('redact'); }
    function step(delta) {
      const all = ordered(), i = all.findIndex((p) => p.id === rd.id) + delta;
      if (i >= 0 && i < all.length) { rd.id = all[i].id; rdRender(); }
    }

    // ------------------------------------------------------------ wiring
    let pickFor = 'cp';
    const actions = {
      'imp-open': open,
      'imp-close': close,
      'imp-add'(el) { pickFor = el.dataset.doc; els.file.value = ''; els.file.click(); },
      'imp-cam'(el) { pickFor = el.dataset.doc; els.cam.value = ''; els.cam.click(); },
      'imp-remove'(el) { st.pages = st.pages.filter((p) => p.id !== el.dataset.page); st.error = ''; render(); },
      'imp-redact'(el) { openRedact(el.dataset.page); },
      'imp-read': read,
      'imp-back'() { st.step = 'docs'; st.error = ''; render(); },
      'imp-apply': apply,
      'imp-key-save'() {
        const el = $('#imp-key-in'), key = el ? el.value.trim() : '';
        if (!/^sk-[\w-]{20,400}$/.test(key)) { if (el) { el.classList.add('bad'); el.focus(); } return; }
        own.save({ key, model: OWN_MODELS[0][0] });
        st.error = ''; st.keyOpen = true;
        render();
      },
      'imp-key-remove'() { own.clear(); st.keyOpen = true; render(); },
      'rd-done': closeRedact,
      'rd-undo'() { const p = pageById(rd.id); if (p && p.marks.length) { p.marks.pop(); p.dirty = true; rdMarks(); } },
      'rd-clear'() { const p = pageById(rd.id); if (p && p.marks.length) { p.marks = []; p.dirty = true; rdMarks(); } },
      'rd-rotate': rotate,
      'rd-prev'() { step(-1); },
      'rd-next'() { step(1); },
      'rd-in'() { setZoom(rd.zoom * 1.5); },
      'rd-out'() { setZoom(rd.zoom / 1.5); },
    };
    els.file.addEventListener('change', () => { addFiles(els.file.files, pickFor); });
    els.cam.addEventListener('change', () => { addFiles(els.cam.files, pickFor); });
    els.box.addEventListener('change', (e) => {
      if (e.target.id === 'imp-keep') { st.keep = e.target.checked; render(); }
      if (e.target.id === 'imp-key-model') { const key = own.load(); if (key) own.save({ key: key.key, model: e.target.value }); }
    });
    els.box.addEventListener('toggle', (e) => { if (e.target.id === 'imp-key') st.keyOpen = e.target.open; }, true);
    // files dropped on a slot, and screenshots pasted with Ctrl+V
    els.box.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('.imp-slot')) e.preventDefault(); });
    els.box.addEventListener('drop', (e) => {
      const slot = e.target.closest && e.target.closest('.imp-slot');
      if (!slot || !e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files, slot.dataset.doc);
    });
    document.addEventListener('paste', (e) => {
      if (!st.open || rd.open || st.step !== 'docs' || !e.clipboardData) return;
      const files = Array.from(e.clipboardData.files || []).filter((f) => isImage(f) || isPdf(f));
      if (files.length) { e.preventDefault(); addFiles(files, st.target); }
    });
    document.addEventListener('keydown', (e) => {
      if (rd.open && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); actions['rd-undo'](); }
    });

    return {
      actions, open, close, hide, hideRedact, closeRedact, render, noteHTML, available,
      isOpen: () => st.open, isRedacting: () => rd.open,
      // for automated checks
      _state: st, _flatten: flatten, _addFiles: addFiles,
    };
  }

  window.StaliaImport = { create };
})();
