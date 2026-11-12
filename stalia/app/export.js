/*!
 * Stalia — editable exports. The laytime statement as a Word document, and the time sheet as an Excel workbook
 * whose totals are formulas: change a time, a percentage, the laytime allowed or a rate, and the result follows.
 * Pure functions, no DOM. Browser: window.StaliaExport. Node: require('./export.js').
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./i18n.js'), require('./view.js'));
  else root.StaliaExport = factory(root.StaliaEngine, root.StaliaI18n, root.StaliaView);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E, I, V) {
  'use strict';

  const DAY = E.DAY;
  const MIME = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const XE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  /** Text for XML: escaped, and without the control characters XML does not allow. */
  const xe = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, (c) => XE[c]);
  const utf8 = (s) => new TextEncoder().encode(s);

  // ---------------------------------------------------------------- zip (stored, no compression)
  const CRC = (() => {
    const tb = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; tb[n] = c >>> 0; }
    return tb;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  /**
   * A zip archive of the given files, stored as they are. Word and Excel files are such archives.
   * @param {Array<{name:string, data:(Uint8Array|string)}>} files
   * @param {string} [day] 'YYYY-MM-DD' stamped on the entries (today by default)
   */
  function zip(files, day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '') || /^(\d{4})-(\d{2})-(\d{2})/.exec(new Date().toISOString());
    const dosDate = ((Math.max(1980, +m[1]) - 1980) << 9) | (+m[2] << 5) | +m[3];
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
      const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); local.set(name, 30);
      const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); cen.set(name, 46);
      parts.push(local, data); central.push(cen);
      offset += local.length + data.length;
    }
    const cenSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + cenSize + 22);
    let p = 0;
    for (const a of parts.concat(central, [end])) { out.set(a, p); p += a.length; }
    return out;
  }

  // ---------------------------------------------------------------- pictures (the letterhead logo)
  function imageSize(b, type) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (type === 'png') return b.length > 24 && v.getUint32(0) === 0x89504E47 ? { w: v.getUint32(16), h: v.getUint32(20) } : null;
    if (type === 'gif') return b.length > 10 && b[0] === 0x47 ? { w: v.getUint16(6, true), h: v.getUint16(8, true) } : null;
    if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
    let i = 2; // JPEG: walk the segments to the first start-of-frame
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const mk = b[i + 1];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { w: v.getUint16(i + 7), h: v.getUint16(i + 5) };
      if (mk === 0xFF) { i++; continue; }
      if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
    return null;
  }
  /** A logo stored as a data URL -> bytes and size. Word and Excel take PNG, JPEG and GIF; anything else is left out. */
  function imageOf(dataUrl) {
    const m = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return null;
    let bytes;
    try {
      const bin = atob(m[2]);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) { return null; }
    const size = imageSize(bytes, m[1]);
    if (!size || !(size.w > 0) || !(size.h > 0)) return null;
    return { type: m[1], ext: m[1] === 'jpeg' ? 'jpg' : m[1], bytes, w: size.w, h: size.h };
  }
  /** Size on paper in EMU (36000 per mm), fitted into a box given in millimetres. */
  function fitEmu(img, maxWmm, maxHmm) {
    const k = Math.min((maxWmm * 36000) / (img.w * 9525), (maxHmm * 36000) / (img.h * 9525), 1.5);
    return { cx: Math.round(img.w * 9525 * k), cy: Math.round(img.h * 9525 * k) };
  }

  // ---------------------------------------------------------------- formulas
  // A small evaluator for the formulas written below. The value stored in the workbook next to each formula comes
  // from it, so a viewer that does not recalculate (a phone preview, a mail client) shows what Excel will show.
  const colNum = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; };
  const colName = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
  const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?)|"((?:[^"]|"")*)"|(\$?[A-Z]{1,3}\$?\d+)|([A-Z][A-Z0-9.]*)(?=\()|(<=|>=|<>|[-+*/&=<>(),:]))/y;

  function parseFormula(src) {
    const text = String(src).replace(/^=/, '').trim(), toks = [];
    for (let i = 0; i < text.length;) {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(text);
      if (!m) throw new Error('formula: cannot read "' + text.slice(i, i + 16) + '"');
      i = TOKEN.lastIndex;
      if (m[1] != null) toks.push({ t: 'n', v: Number(m[1]) });
      else if (m[2] != null) toks.push({ t: 's', v: m[2].replace(/""/g, '"') });
      else if (m[3] != null) toks.push({ t: 'r', v: m[3].replace(/\$/g, '') });
      else if (m[4] != null) toks.push({ t: 'f', v: m[4] });
      else toks.push({ t: 'o', v: m[5] });
    }
    let i = 0;
    const eat = (v) => (toks[i] && toks[i].t === 'o' && toks[i].v === v ? toks[i++] : null);
    const need = (v) => { if (!eat(v)) throw new Error('formula: expected ' + v + ' in ' + text); };
    const binary = (next, ops) => () => {
      let a = next();
      for (;;) {
        const k = toks[i];
        if (!k || k.t !== 'o' || ops.indexOf(k.v) < 0) return a;
        i++;
        a = ['bin', k.v, a, next()];
      }
    };
    function primary() {
      const k = toks[i++];
      if (!k) throw new Error('formula: ends too early: ' + text);
      if (k.t === 'n' || k.t === 's') return [k.t, k.v];
      if (k.t === 'r') {
        if (!eat(':')) return ['ref', k.v];
        const b = toks[i++];
        if (!b || b.t !== 'r') throw new Error('formula: bad range in ' + text);
        return ['range', k.v, b.v];
      }
      if (k.t === 'f') {
        const args = [];
        need('(');
        if (!eat(')')) { do args.push(expr()); while (eat(',')); need(')'); }
        return ['call', k.v, args];
      }
      if (k.v === '(') { const e = expr(); need(')'); return e; }
      throw new Error('formula: unexpected ' + k.v + ' in ' + text);
    }
    const unary = () => (eat('-') ? ['neg', unary()] : eat('+') ? unary() : primary());
    const compare = binary(binary(binary(binary(unary, ['*', '/']), ['+', '-']), ['&']), ['=', '<>', '<', '>', '<=', '>=']);
    function expr() { return compare(); }
    const tree = expr();
    if (i < toks.length) throw new Error('formula: unexpected text after the end: ' + text);
    return tree;
  }

  const isArr = Array.isArray;
  const toNum = (v) => {
    if (typeof v === 'number') return v;
    if (v == null) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    throw new Error('#VALUE!');
  };
  const general = (n) => String(Number(n.toPrecision(15)));
  const toText = (v) => (v == null ? '' : typeof v === 'number' ? general(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
  const truthy = (v) => (typeof v === 'boolean' ? v : toNum(v) !== 0);
  const order = (a, b) => {
    if (typeof a === 'string' || typeof b === 'string') { const x = toText(a).toLowerCase(), y = toText(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    const x = toNum(a), y = toNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const OPS = {
    '+': (a, b) => toNum(a) + toNum(b), '-': (a, b) => toNum(a) - toNum(b), '*': (a, b) => toNum(a) * toNum(b),
    '/': (a, b) => { const d = toNum(b); if (d === 0) throw new Error('#DIV/0!'); return toNum(a) / d; },
    '&': (a, b) => toText(a) + toText(b),
    '=': (a, b) => order(a, b) === 0, '<>': (a, b) => order(a, b) !== 0, '<': (a, b) => order(a, b) < 0,
    '>': (a, b) => order(a, b) > 0, '<=': (a, b) => order(a, b) <= 0, '>=': (a, b) => order(a, b) >= 0,
  };
  const each2 = (a, b, fn) => (isArr(a) ? a.map((x, k) => fn(x, isArr(b) ? b[k] : b)) : isArr(b) ? b.map((y) => fn(a, y)) : fn(a, b));
  /** The numbers among the arguments: text and blanks inside ranges are skipped, as spreadsheets do. */
  const numbers = (args) => {
    const out = [];
    for (const a of args) {
      if (isArr(a)) { for (const x of a) if (typeof x === 'number') out.push(x); } else out.push(toNum(a));
    }
    return out;
  };
  /** ROUND as a spreadsheet does it: halves away from zero, on the number as it is displayed (15 digits). */
  const roundXL = (x, d) => { const m = Math.pow(10, d), y = Number((Math.abs(x) * m).toPrecision(15)); return ((x < 0 ? -1 : 1) * Math.floor(y + 0.5)) / m; };

  function runFormula(node, get) {
    switch (node[0]) {
      case 'n': case 's': return node[1];
      case 'ref': return get(node[1]);
      case 'range': {
        const a = /^([A-Z]+)(\d+)$/.exec(node[1]), b = /^([A-Z]+)(\d+)$/.exec(node[2]), out = [];
        const c0 = Math.min(colNum(a[1]), colNum(b[1])), c1 = Math.max(colNum(a[1]), colNum(b[1]));
        const r0 = Math.min(+a[2], +b[2]), r1 = Math.max(+a[2], +b[2]);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(get(colName(c) + r));
        return out;
      }
      case 'neg': { const v = runFormula(node[1], get); return isArr(v) ? v.map((x) => -toNum(x)) : -toNum(v); }
      case 'bin': return each2(runFormula(node[2], get), runFormula(node[3], get), OPS[node[1]]);
      default: {
        const name = node[1], args = node[2];
        if (name === 'IF') { // only the chosen branch is worked out
          if (truthy(runFormula(args[0], get))) return runFormula(args[1], get);
          return args.length > 2 ? runFormula(args[2], get) : false;
        }
        const v = args.map((a) => runFormula(a, get));
        switch (name) {
          case 'SUM': return numbers(v).reduce((s, x) => s + x, 0);
          case 'MIN': { const n = numbers(v); return n.length ? n.reduce((m, x) => (x < m ? x : m)) : 0; }
          case 'MAX': { const n = numbers(v); return n.length ? n.reduce((m, x) => (x > m ? x : m)) : 0; }
          case 'COUNT': return numbers(v).length;
          case 'ABS': return Math.abs(toNum(v[0]));
          case 'ROUND': return roundXL(toNum(v[0]), toNum(v[1]));
          case 'AND': return v.every(truthy);
          case 'OR': return v.some(truthy);
          case 'SUMPRODUCT': {
            const first = v.filter(isArr)[0], n = first ? first.length : 1;
            let sum = 0;
            for (let k = 0; k < n; k++) {
              let p = 1;
              for (const a of v) { const x = isArr(a) ? a[k] : a; p *= typeof x === 'number' ? x : 0; }
              sum += p;
            }
            return sum;
          }
          default: throw new Error('formula: unknown function ' + name);
        }
      }
    }
  }

  /** Work out every formula of a sheet model in place: cells[ref].v becomes the value of cells[ref].f. */
  function evaluate(cells) {
    const done = {}, busy = {};
    const value = (ref) => {
      const c = cells[ref];
      if (!c) return null;
      if (c.f == null) return c.v == null ? null : c.v;
      if (done[ref]) return c.v;
      if (busy[ref]) throw new Error('formula: circular reference at ' + ref);
      busy[ref] = true;
      let v;
      try { v = runFormula(parseFormula(c.f), value); } catch (e) { throw new Error(ref + ' ' + c.f + ': ' + e.message); }
      if (isArr(v)) v = v[0];
      c.v = v == null ? 0 : v;
      busy[ref] = false; done[ref] = true;
      return c.v;
    };
    for (const ref in cells) if (cells[ref].f != null) value(ref);
    return cells;
  }

  // ---------------------------------------------------------------- the time sheet as a sheet of cells
  const NIL = '0.000000001'; // a billionth of a day: below it the formulas treat laytime as used up
  const COLS = [13, 6, 7.5, 7.5, 12, 38, 12, 12, 12, 12, 12, 12, 18]; // widths of A..M, in characters
  const SHEET_CHARS = COLS.reduce((s, w) => s + w, 0);
  const dateSerial = (min) => Math.floor(min / DAY) + 25569; // days since 30 Dec 1899, the way spreadsheets count
  const dayPart = (min) => (min - E.startOfDay(min)) / DAY;
  const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const fixed = (ref) => ref.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
  const wideChar = (ch) => /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿＀-￯]/.test(ch);
  /** How many lines a text takes in a cell that many characters wide (CJK glyphs take two). */
  function linesOf(text, chars) {
    let n = 0;
    for (const ln of String(text).split('\n')) {
      let w = 0;
      for (const ch of ln) w += wideChar(ch) ? 2 : 1;
      n += Math.max(1, Math.ceil(w / chars));
    }
    return n;
  }
  function splitDays(from, to) {
    const out = [];
    for (let a = from; a < to - E.EPS;) { const b = Math.min(to, E.startOfDay(a) + DAY); out.push({ from: a, to: b }); a = b; }
    return out;
  }
  /** What a period is, in words — without saying whether it fell on laytime or on demurrage: that is a formula. */
  function periodRemark(pd, lang) {
    const t = (k, v) => I.t(lang, k, v);
    const used = pd.reasons.some((r) => r.code === 'worked_counts');
    const bits = pd.reasons.map((r) => {
      switch (r.code) {
        case 'weekend': return t('s.row.weekendBare');
        case 'holiday': return r.name ? t('s.row.holidayNamedBare', { name: r.name }) : t('s.row.holidayBare');
        case 'worked_counts': return t('s.row.worked_counts');
        case 'worked_ignored': return t('s.row.worked_ignored');
        case 'event': return (r.desc || '').trim() || (r.type && r.type !== 'custom' ? t('et.' + r.type) : t('s.row.unnamedEvent'));
        default: return '';
      }
    }).filter(Boolean).join(used ? ', ' : '; ');
    return pd.notice ? t('x.notice') + (bits ? ' (' + bits + ')' : '') : bits;
  }
  /**
   * Excepted periods of the calendar from the day of completion on: they decide "all time saved".
   * Listed far enough for the laytime allowed to be doubled, or raised by a week, in the sheet.
   */
  function calendarAfter(cal, completed, allowed) {
    const from = E.startOfDay(completed);
    const horizon = E.projectExpiry(cal, completed, Math.max(allowed * 2, allowed + 7 * DAY));
    return E.mergeWindows(E.calendarWindows(cal, from, horizon)).filter((w) => w.to >= completed)
      .map((w) => ({ from: Math.max(w.from, from), to: w.to }));
  }

  /**
   * The workbook as plain data: cells with values, formulas and style names.
   * `refs` names the cells that matter (rates, laytime allowed, totals) so that tests and callers can find them.
   * @param {object} opts { pro, brand:{company,details,logo}, siteUrl, today:'YYYY-MM-DD' }
   */
  function xlsxModel(calc, result, lang, opts) {
    opts = opts || {};
    if (!result || !result.ok) throw new Error('export: the calculation is not complete');
    const t = (k, v) => I.t(lang, k, v);
    const tt = result.totals, meta = calc.meta || {}, cur = calc.currency || '';
    const per = E.periods(calc);
    if (!per) throw new Error('export: the calculation is not complete');
    const pooled = tt.mode === 'reversible', ats = tt.basis === 'ATS';
    const brand = opts.pro ? (opts.brand || {}) : {};
    const logo = opts.pro ? imageOf(brand.logo) : null;

    const cells = {}, merges = [], heights = {};
    let row = 0;
    const put = (col, cell) => { cells[col + row] = cell; return col + row; };
    const text = (col, v, s) => put(col, { v: String(v == null ? '' : v), s: s || 'text' });
    const num = (col, v, s) => put(col, { v, s });
    const fx = (col, f, s) => put(col, { f, s }); // f may be a function: it is called once every address is known
    const across = (style, value, size) => { // one text over the whole width, wrapped
      text('A', value, style);
      merges.push('A' + row + ':M' + row);
      heights[row] = linesOf(value, SHEET_CHARS * 0.95) * (size || 14.5) + 3;
    };
    const day = (col, min, s) => num(col, dateSerial(min), s);
    const refs = { ports: [], total: {} };

    // ---- letterhead (Pro), title, fixture
    if ((brand.company || '').trim() || logo) {
      row++;
      if ((brand.company || '').trim()) text(logo ? 'E' : 'A', brand.company.trim(), 'brand');
      heights[row] = logo ? 38 : 20;
      if ((brand.details || '').trim()) { row++; text(logo ? 'E' : 'A', brand.details.trim().replace(/\s*\n\s*/g, ', '), 'muted'); }
      row++;
    }
    row++; text('A', t('st.title'), 'title'); heights[row] = 24;
    row++; text('A', (meta.voyage ? t('st.ref') + ': ' + meta.voyage + ' · ' : '') + t('st.dateOf') + ': ' + V.fmtDate(E.parseDT(opts.today || ''), lang), 'muted');
    row++; across('hint', t('x.hint'), 12.5);
    row++;
    const cpDate = meta.cpDate ? V.fmtDate(E.parseDT(meta.cpDate), lang) : '';
    const cp = meta.cpForm && cpDate ? t('st.cpDated', { form: meta.cpForm, date: cpDate }) : (meta.cpForm || cpDate);
    for (const kv of [[t('f.vessel'), meta.vessel], [t('st.cp'), cp], [t('f.owners'), meta.owners], [t('f.charterers'), meta.charterers], [t('f.cargo'), meta.cargo]]) {
      if (!kv[1]) continue;
      row++; text('A', kv[0], 'label'); text('C', kv[1], 'strong');
    }
    row++;
    row++; across('wrap', t('s.terms') + ': ' + V.termsText(calc, result, lang));

    // ---- rates
    row++;
    row++; text('A', t('t.demRate'), 'label'); refs.demRate = num('G', tt.demRate, 'inMoney'); text('H', cur);
    if (tt.despatchMode !== 'none') {
      row++; text('A', t('t.desRate'), 'label');
      refs.desRate = tt.despatchMode === 'half' ? fx('G', '=' + refs.demRate + '/2', 'money') : num('G', tt.desRate, 'inMoney');
      text('H', cur);
    }
    row++; text('A', t('t.commission'), 'label'); refs.commission = num('G', tt.commissionPct / 100, 'inPct2');

    // ---- ports
    const allowedOf = (i) => (pooled ? fixed(refs.total.allowed) : fixed(refs.ports[i].allowed));
    result.ports.forEach((pr, i) => {
      const p = calc.ports[i] || {}, a = p.allowed || {}, R = { idx: i };
      refs.ports.push(R);
      const AL = () => allowedOf(i);
      row++;
      row++; text('A', V.portTitle(pr, lang), 'h2'); heights[row] = 20;
      row++; across('wrap', V.portTermsText(p, lang));
      if (a.type === 'rate') {
        const q = E.num(a.quantity), r = E.num(a.rate);
        row++; text('A', t('a.quantity'), 'label'); R.quantity = num('G', q, q % 1 ? 'inQty3' : 'inQty');
        row++; text('A', t('a.rate') + ' ' + t('a.per') + ' ' + t(a.rateUnit === 'hour' ? 'a.perHour' : 'a.perDay'), 'label'); R.rate = num('G', r, r % 1 ? 'inQty3' : 'inQty');
        row++; text('A', t('r.allowed') + ', ' + t('r.days'), 'label');
        R.allowed = fx('G', '=' + R.quantity + '/' + R.rate + (a.rateUnit === 'hour' ? '/24' : ''), 'days');
      } else {
        row++; text('A', t('r.allowed') + ', ' + t('r.days'), 'label'); R.allowed = num('G', pr.allowedMin / DAY, 'inDays');
      }
      fx('H', '=' + R.allowed, 'durP');

      // facts of the call: dated lines above the table (what was calculated is in the table itself)
      const facts = [];
      const fact = (time, label, k) => { if (time != null) facts.push({ t: time, label, k }); };
      fact(pr.norRaw, t('s.fact.nor'), 0);
      if (pr.norAdjusted) fact(pr.norEff, t('s.fact.norEff'), 0);
      fact(pr.commenced, t('s.fact.commenced'), 1);
      fact(per[i].start, t(pr.sooner ? 's.fact.startSooner' : 's.fact.start'), 2);
      for (const n of pr.notes || []) fact(n.from, n.desc || t('et.note'), 3);
      fact(pr.end, t('s.fact.completed'), 5);
      facts.map((f, k) => ({ f, k })).sort((x, y) => x.f.t - y.f.t || x.f.k - y.f.k || x.k - y.k).forEach((x) => {
        row++; day('A', x.f.t, 'date'); fx('B', '=A' + row, 'day'); num('C', dayPart(x.f.t), 'time'); text('F', x.f.label);
      });

      // the table
      row++;
      const h = row;
      R.header = h;
      ['s.date', 's.day', 's.from', 's.to', 'x.period', 's.remarks', 'x.pctLay', 'x.pctDem', 'x.layCounted', 'r.timeOnDem', 's.total', 's.balance', 'r.expired']
        .forEach((k, c) => text(colName(c + 1), t(k), 'th'));
      heights[h] = 40;
      // The sums below start from an empty row under the heading, not from the first period: a row inserted at
      // the very top of the table is then still counted, and no formula has to add up the heading's text.
      row++;
      const top = row;
      heights[top] = 4;
      let carry = '';
      if (pooled && i > 0) { // reversible laytime: what earlier ports used is carried into this one
        row++; text('F', t('x.before'), 'remark');
        const before = fx('K', '=' + refs.ports[i - 1].used, 'dur'), at = row;
        fx('L', () => '=' + AL() + '-K' + at, 'dur');
        carry = fixed(before) + '+';
      }
      R.first = row + 1;
      for (const pd of per[i].periods) {
        const remark = periodRemark(pd, lang);
        for (const part of splitDays(pd.from, pd.to)) {
          row++;
          const r = row, sp = 'SUMPRODUCT(E$' + top + ':E' + r + ',G$' + top + ':G' + r + ')';
          day('A', part.from, 'inDate'); fx('B', '=A' + r, 'dayC');
          num('C', dayPart(part.from), 'inTime'); num('D', (part.to - E.startOfDay(part.from)) / DAY, 'inTime');
          fx('E', '=D' + r + '-C' + r, 'dur');
          if (remark) {
            text('F', remark, 'remark');
            const n = linesOf(remark, COLS[5]);
            if (n > 1) heights[r] = n * 14.5 + 3;
          } else fx('F', '=IF(L' + r + '+I' + r + '>' + NIL + ',' + quote(t('s.row.counts')) + ',' + quote(t('s.row.demurrage')) + ')', 'remark');
          num('G', pd.fL, (pd.fL * 100) % 1 ? 'inPct2' : 'inPct'); num('H', pd.fD, (pd.fD * 100) % 1 ? 'inPct2' : 'inPct');
          // laytime used so far is the lesser of the laytime allowed and of all the time that counts up to this row;
          // what this row adds to it is laytime, and the rest of the row, at the demurrage percentage, is demurrage
          fx('I', () => '=K' + r + '-MIN(' + AL() + ',' + carry + sp + '-E' + r + '*G' + r + ')', 'dur');
          fx('J', '=MAX(0,(E' + r + '-IF(G' + r + '>0,I' + r + '/G' + r + ',IF(L' + r + '+I' + r + '>' + NIL + ',E' + r + ',0)))*H' + r + ')', 'dur');
          fx('K', () => '=MIN(' + AL() + ',' + carry + sp + ')', 'dur');
          fx('L', () => '=' + AL() + '-K' + r, 'dur');
          fx('M', '=IF(AND(L' + r + '+I' + r + '>' + NIL + ',L' + r + '<=' + NIL + '),A' + r + '+C' + r + '+I' + r + '/G' + r + ',"")', 'dt');
        }
      }
      R.last = row;
      row++; // an empty row closes the table: a row inserted above it still falls inside the ranges below
      const z = row;
      heights[z] = 6;
      row++;
      const T = row;
      R.totals = T;
      text('F', t('s.portSummary'), 'totalLabel');
      'ABCDEGH'.split('').forEach((c) => put(c, { v: null, s: 'totalLabel' }));
      R.counted = fx('I', '=SUM(I$' + top + ':I$' + z + ')', 'durB');
      R.dem = fx('J', '=SUM(J$' + top + ':J$' + z + ')', 'durB');
      R.used = fx('K', () => '=MIN(' + AL() + ',' + carry + 'SUMPRODUCT(E$' + top + ':E$' + z + ',G$' + top + ':G$' + z + '))', 'durB');
      R.left = fx('L', () => '=' + AL() + '-K' + T, 'durB');
      R.expiry = fx('M', '=IF(COUNT(M$' + top + ':M$' + z + ')=0,"—",MAX(M$' + top + ':M$' + z + '))', 'dtB');
      R.saved = R.left;

      // all time saved: working time saved plus the excepted periods the laytime would have run through
      if (ats && (!pooled || i === result.ports.length - 1)) {
        const cal = E.resolveCalendar(p.calendar);
        const wins = calendarAfter(cal, pr.end, pooled ? tt.allowedMin : pr.allowedMin);
        if (wins.length) {
          row++;
          row++; text('A', t('x.ats.title'), 'strong'); text('L', t('s.fact.completed'), 'cur');
          const done = fx('M', '=SUMPRODUCT(MAX(A$' + top + ':A$' + z + '+D$' + top + ':D$' + z + '))', 'dt');
          R.completed = done;
          row++;
          const ah = row;
          [['A', 's.date'], ['B', 's.day'], ['C', 's.from'], ['D', 's.to'], ['E', 'x.period'], ['F', 's.remarks'], ['K', 'x.ats.before'], ['L', 'x.ats.added']]
            .forEach((x) => text(x[0], t(x[1]), 'th'));
          heights[ah] = 40;
          row++;
          const atop = row;
          heights[atop] = 4;
          for (const w of wins) {
            for (const part of splitDays(w.from, w.to)) {
              row++;
              const r = row, start = 'A' + r + '+C' + r;
              day('A', part.from, 'inDate'); fx('B', '=A' + r, 'dayC');
              num('C', dayPart(part.from), 'inTime'); num('D', (part.to - E.startOfDay(part.from)) / DAY, 'inTime');
              fx('E', '=D' + r + '-C' + r, 'dur'); text('F', t('s.row.weekendBare'), 'remark');
              fx('K', '=MAX(0,MAX(0,' + start + '-' + fixed(done) + ')-SUM(L$' + atop + ':L' + (r - 1) + '))', 'dur');
              fx('L', '=IF(' + fixed(R.left) + '>K' + r + '+' + NIL + ',MAX(0,A' + r + '+D' + r + '-MAX(' + start + ',' + fixed(done) + ')),0)', 'dur');
            }
          }
          const end = row;
          row++; text('F', t('r.timeSaved.ATS'), 'totalLabel');
          R.saved = fx('L', '=' + R.left + '+SUM(L$' + atop + ':L' + end + ')', 'durB');
          row++; text('F', t('s.fact.wouldExpire'), 'totalLabel');
          fx('M', '=IF(' + R.left + '>' + NIL + ',' + done + '+' + R.saved + ',"—")', 'dtB');
        }
      }
    });

    // ---- summary
    const P = refs.ports, last = P[P.length - 1];
    const sum = (k) => P.map((x) => x[k]).join('+');
    const gross = sum('dem'), saved = pooled ? last.saved : sum('saved');
    const line = (label, f, key) => {
      row++; text('A', label, 'label');
      refs.total[key] = fx('I', f, 'durP'); fx('J', '=' + refs.total[key], 'days'); text('K', t('r.days'));
    };
    row++;
    row++; text('A', t('st.summary'), 'h2'); heights[row] = 20;
    line(t('st.totalAllowed'), '=' + sum('allowed'), 'allowed');
    line(t('st.totalUsed'), '=' + sum('counted'), 'used');
    // The two times money is charged on are taken to a millionth of a minute, exactly as the calculator does, so that
    // the dust arithmetic leaves behind cannot decide which way an exact half cent is rounded.
    const snap = (f) => '=ROUND((' + f + ')*1440,6)/1440';
    line(t('r.timeOnDem'), snap(tt.mode === 'average' ? 'MAX(0,' + gross + '-(' + saved + '))' : gross), 'dem');
    line(t('r.timeSaved.' + tt.basis), snap(tt.mode === 'average' ? 'MAX(0,' + saved + '-(' + gross + '))' : saved), 'des');

    const D = refs.total.dem, S = refs.total.des, RATE = fixed(refs.demRate), PCT = fixed(refs.commission);
    const d = D + '*' + RATE, s = refs.desRate ? S + '*' + fixed(refs.desRate) : '0';
    const worded = (key, name, cell) => { // 'Demurrage at {rate} per day' with the rate taken from its cell
      const bits = t(key, { [name]: '\u0001' }).split('\u0001');
      return '=' + quote(bits[0] + (name === 'rate' ? cur + ' ' : '')) + '&' + cell + (bits[1] ? '&' + quote(bits[1]) : '');
    };
    row++; fx('A', worded('r.demAt', 'rate', RATE), 'label'); text('L', cur, 'cur');
    refs.total.demurrage = fx('M', '=ROUND(' + d + ',2)', 'money');
    row++; fx('A', worded('r.commission', 'pct', PCT + '*100'), 'label'); text('L', cur, 'cur');
    refs.total.commission = fx('M', '=-ROUND(' + d + '*' + PCT + ',2)', 'money');
    if (refs.desRate) {
      row++; fx('A', worded('r.desAt', 'rate', fixed(refs.desRate)), 'label'); text('L', cur, 'cur');
      refs.total.despatch = fx('M', '=-ROUND(' + s + ',2)', 'money');
    }
    const net = d + '-' + d + '*' + PCT + '-' + s, oc = (k) => quote(t('r.outcome.' + k));
    row++;
    refs.total.outcome = fx('A', '=IF(AND(' + d + '>0.004,' + s + '>0.004),IF(' + net + '>=0,' + oc('net_demurrage') + ',' + oc('net_despatch') + '),' +
      'IF(' + d + '>0.004,' + oc('demurrage') + ',IF(' + s + '>0.004,' + oc('despatch') + ',' +
      'IF(' + D + '>' + NIL + ',' + oc('demurrage') + ',IF(' + S + '>' + NIL + ',' + oc('despatch') + ',' + oc('even') + ')))))', 'totalText');
    'BCDEFGHIJK'.split('').forEach((c) => put(c, { v: null, s: 'totalText' }));
    text('L', cur, 'curB');
    refs.total.amount = fx('M', '=ABS(ROUND(' + net + ',2))', 'moneyB');
    heights[row] = 20;

    // ---- remarks, signatures, footer
    if ((meta.remarks || '').trim()) { row++; row++; across('wrap', meta.remarks.trim()); }
    row += 4;
    text('A', t('st.signOwners'), 'sign'); 'BCDE'.split('').forEach((c) => put(c, { v: null, s: 'sign' }));
    text('H', t('st.signCharterers'), 'sign'); 'IJKL'.split('').forEach((c) => put(c, { v: null, s: 'sign' }));
    row += 2;
    text('A', t('st.eoe'), 'muted');
    const site = (opts.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!opts.pro) text('M', t('st.freeFooter') + (site ? ' · ' + site : ''), 'mutedR');

    for (const ref in cells) if (typeof cells[ref].f === 'function') cells[ref].f = cells[ref].f();
    const name = t('sec.sheet').replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
    return { name, lang, cells, merges, heights, cols: COLS, rows: row, refs, logo };
  }

  // ---------------------------------------------------------------- xlsx
  const LCID = { en: '409', ru: '419', kk: '43F', uk: '422', tr: '41F', el: '408', zh: '804' };
  const YELLOW = 'FFF6CC', GREY = 'E9EDF2', LINE = 'C5CAD1';
  function xlsxStyleDefs(lang) {
    const loc = '[$-' + (LCID[lang] || LCID.en) + ']';
    const date = loc + I.format(lang).date.replace(/YYYY|MMM|MM|DD|[^A-Za-z]/g, (k) => ({ YYYY: 'yyyy', MMM: 'mmm', MM: 'mm', DD: 'dd' }[k] || '\\' + k));
    const dow = loc + 'ddd', time = '[hh]:mm', dur = '[h]:mm', money = '#,##0.00';
    const box = { border: 'all' }, edit = { border: 'all', fill: YELLOW };
    return {
      text: {},
      label: { color: '4A5560' },
      strong: { bold: 1 },
      wrap: { wrap: 1, valign: 'top' },
      hint: { italic: 1, color: '4A5560', size: 9, wrap: 1, valign: 'top' },
      title: { bold: 1, size: 15 },
      h2: { bold: 1, size: 12 },
      brand: { bold: 1, size: 13, valign: 'center' },
      muted: { color: '6B7682', size: 9 },
      mutedR: { color: '6B7682', size: 9, align: 'right' },
      th: Object.assign({ bold: 1, size: 9, fill: GREY, wrap: 1, align: 'center', valign: 'center' }, box),
      remark: Object.assign({ wrap: 1, valign: 'top' }, box),
      date: { fmt: date, align: 'left' },
      day: { fmt: dow },
      time: { fmt: time },
      inDate: Object.assign({ fmt: date, align: 'left', valign: 'top' }, edit),
      dayC: Object.assign({ fmt: dow, valign: 'top' }, box),
      inTime: Object.assign({ fmt: time, valign: 'top' }, edit),
      inPct: Object.assign({ fmt: '0%', valign: 'top' }, edit),
      inPct2: Object.assign({ fmt: '0.00%', valign: 'top' }, edit),
      dur: Object.assign({ fmt: dur, valign: 'top' }, box),
      durP: { fmt: dur },
      durB: Object.assign({ fmt: dur, bold: 1 }, box),
      dt: Object.assign({ fmt: date + '\\ hh:mm', align: 'left', valign: 'top' }, box),
      dtB: Object.assign({ fmt: date + '\\ hh:mm', align: 'left', bold: 1 }, box),
      totalLabel: Object.assign({ bold: 1, align: 'right' }, box),
      inMoney: Object.assign({ fmt: money }, edit),
      inQty: Object.assign({ fmt: '#,##0' }, edit),
      inQty3: Object.assign({ fmt: '#,##0.000' }, edit),
      inDays: Object.assign({ fmt: '0.00000' }, edit),
      days: { fmt: '0.00000' },
      money: { fmt: money },
      moneyB: { fmt: money, bold: 1, size: 12, border: 'top' },
      totalText: { bold: 1, size: 12, border: 'top' },
      cur: { align: 'right', color: '4A5560' },
      curB: { align: 'right', bold: 1, size: 12, border: 'top' },
      sign: { size: 9, border: 'top' },
    };
  }
  function xlsxStylesXML(defs) {
    const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], fmts = [], xfs = [], index = {};
    const once = (list, xml) => { let k = list.indexOf(xml); if (k < 0) { list.push(xml); k = list.length - 1; } return k; };
    const side = (name, on) => (on ? '<' + name + ' style="thin"><color rgb="FF' + LINE + '"/></' + name + '>' : '<' + name + '/>');
    const font = (d) => '<font>' + (d.bold ? '<b/>' : '') + (d.italic ? '<i/>' : '') + '<sz val="' + (d.size || 10) + '"/><color rgb="FF' + (d.color || '1B2430') + '"/><name val="Calibri"/><family val="2"/></font>';
    once(fonts, font({}));
    for (const name of Object.keys(defs)) {
      const d = defs[name];
      const fontId = once(fonts, font(d));
      const fillId = d.fill ? once(fills, '<fill><patternFill patternType="solid"><fgColor rgb="FF' + d.fill + '"/><bgColor indexed="64"/></patternFill></fill>') : 0;
      const all = d.border === 'all', top = all || d.border === 'top';
      const borderId = d.border ? once(borders, '<border>' + side('left', all) + side('right', all) + side('top', top) + side('bottom', all) + '<diagonal/></border>') : 0;
      const fmtId = d.fmt ? 164 + once(fmts, d.fmt) : 0;
      const align = d.align || d.valign || d.wrap
        ? '<alignment' + (d.align ? ' horizontal="' + d.align + '"' : '') + (d.valign ? ' vertical="' + d.valign + '"' : '') + (d.wrap ? ' wrapText="1"' : '') + '/>' : '';
      const xf = '<xf numFmtId="' + fmtId + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"' +
        (fmtId ? ' applyNumberFormat="1"' : '') + ' applyFont="1"' + (fillId ? ' applyFill="1"' : '') + (borderId ? ' applyBorder="1"' : '') +
        (align ? ' applyAlignment="1">' + align + '</xf>' : '/>');
      index[name] = once(xfs, xf);
    }
    const xml = XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.map((f, k) => '<numFmt numFmtId="' + (164 + k) + '" formatCode="' + xe(f) + '"/>').join('') + '</numFmts>' : '') +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts><fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    return { xml, index };
  }
  const numText = (v) => (typeof v === 'number' && isFinite(v) ? String(v) : '0');

  /**
   * The time sheet as an .xlsx file.
   * @param {object} opts as for xlsxModel, plus noCache:true to leave the stored values out (then only a program that
   *                      recalculates shows numbers — used to check the formulas against a real spreadsheet)
   * @returns {Uint8Array}
   */
  function xlsx(calc, result, lang, opts) {
    opts = opts || {};
    const model = xlsxModel(calc, result, lang, opts);
    evaluate(model.cells);
    const styles = xlsxStylesXML(xlsxStyleDefs(lang)), strings = [], seen = new Map();
    const shared = (s) => { if (!seen.has(s)) { seen.set(s, strings.length); strings.push(s); } return seen.get(s); };
    const byRow = {};
    for (const ref in model.cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      (byRow[m[2]] = byRow[m[2]] || []).push({ c: colNum(m[1]), ref });
    }
    for (const r in model.heights) byRow[r] = byRow[r] || [];
    let data = '';
    for (const r of Object.keys(byRow).map(Number).sort((a, b) => a - b)) {
      data += '<row r="' + r + '"' + (model.heights[r] ? ' ht="' + model.heights[r] + '" customHeight="1"' : '') + '>';
      for (const x of byRow[r].sort((a, b) => a.c - b.c)) {
        const c = model.cells[x.ref], st = styles.index[c.s || 'text'], sa = st ? ' s="' + st + '"' : '';
        if (c.f != null) {
          const f = '<f>' + xe(String(c.f).replace(/^=/, '')) + '</f>';
          if (typeof c.v === 'string') data += '<c r="' + x.ref + '"' + sa + ' t="str">' + f + (opts.noCache ? '' : '<v>' + xe(c.v) + '</v>') + '</c>';
          else data += '<c r="' + x.ref + '"' + sa + '>' + f + (opts.noCache ? '' : '<v>' + numText(typeof c.v === 'boolean' ? +c.v : c.v) + '</v>') + '</c>';
        } else if (typeof c.v === 'string') data += '<c r="' + x.ref + '"' + sa + ' t="s"><v>' + shared(c.v) + '</v></c>';
        else if (typeof c.v === 'number') data += '<c r="' + x.ref + '"' + sa + '><v>' + numText(c.v) + '</v></c>';
        else data += '<c r="' + x.ref + '"' + sa + '/>';
      }
      data += '</row>';
    }
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const sheet = XML + '<worksheet ' + NS + '><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:M' + model.rows + '"/>' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + model.cols.map((w, k) => '<col min="' + (k + 1) + '" max="' + (k + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' +
      '<sheetData>' + data + '</sheetData>' +
      (model.merges.length ? '<mergeCells count="' + model.merges.length + '">' + model.merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '') +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      (model.logo ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG = 'http://schemas.openxmlformats.org/package/2006';
    const rels = (list) => XML + '<Relationships xmlns="' + PKG + '/relationships">' +
      list.map((x, k) => '<Relationship Id="rId' + (k + 1) + '" Type="' + x[0] + '" Target="' + x[1] + '"/>').join('') + '</Relationships>';
    const title = [calc.meta && calc.meta.vessel, calc.name].filter(Boolean).join(' — ') || I.t(lang, 'st.title');
    const files = [
      { name: '[Content_Types].xml', data: XML + '<Types xmlns="' + PKG + '/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        (model.logo ? '<Default Extension="' + model.logo.ext + '" ContentType="image/' + model.logo.type + '"/>' : '') +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        (model.logo ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
      { name: '_rels/.rels', data: rels([[REL + '/officeDocument', 'xl/workbook.xml'], [PKG + '/relationships/metadata/core-properties', 'docProps/core.xml']]) },
      { name: 'docProps/core.xml', data: coreXML(title, opts.today) },
      { name: 'xl/workbook.xml', data: XML + '<workbook ' + NS + '><bookViews><workbookView/></bookViews><sheets><sheet name="' + xe(model.name) + '" sheetId="1" r:id="rId1"/></sheets>' +
        '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: rels([[REL + '/worksheet', 'worksheets/sheet1.xml'], [REL + '/styles', 'styles.xml'], [REL + '/sharedStrings', 'sharedStrings.xml']]) },
      { name: 'xl/styles.xml', data: styles.xml },
      { name: 'xl/sharedStrings.xml', data: XML + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + strings.length + '" uniqueCount="' + strings.length + '">' +
        strings.map((s) => '<si><t xml:space="preserve">' + xe(s) + '</t></si>').join('') + '</sst>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ];
    if (model.logo) {
      const e = fitEmu(model.logo, 60, 12);
      const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
      files.push(
        { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: rels([[REL + '/drawing', '../drawings/drawing1.xml']]) },
        { name: 'xl/drawings/drawing1.xml', data: XML + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="' + A + '">' +
          '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>12700</xdr:rowOff></xdr:from>' +
          '<xdr:ext cx="' + e.cx + '" cy="' + e.cy + '"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
          '<xdr:blipFill><a:blip xmlns:r="' + REL + '" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
          '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + e.cx + '" cy="' + e.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
          '<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>' },
        { name: 'xl/drawings/_rels/drawing1.xml.rels', data: rels([[REL + '/image', '../media/image1.' + model.logo.ext]]) },
        { name: 'xl/media/image1.' + model.logo.ext, data: model.logo.bytes }
      );
    }
    return zip(files, opts.today);
  }

  function coreXML(title, day) {
    const stamp = (/^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : new Date().toISOString().slice(0, 10)) + 'T00:00:00Z';
    return XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + xe(title) + '</dc:title><dc:creator>Stalia</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:modified></cp:coreProperties>';
  }

  // ---------------------------------------------------------------- docx
  const W_LANG = { en: 'en-US', ru: 'ru-RU', kk: 'kk-KZ', uk: 'uk-UA', tr: 'tr-TR', el: 'el-GR', zh: 'zh-CN' };
  const PAGE_W = 9864; // text width of an A4 page with 18 mm margins, in twentieths of a point
  const ROW_FILL = { exc: 'F1F3F5', part: 'FFF8E1', dem: 'FCEBE9', dempart: 'FCEBE9', demexc: 'F1F3F5' };

  function wRun(text, o) {
    o = o || {};
    const pr = (o.b ? '<w:b/><w:bCs/>' : '') + (o.i ? '<w:i/><w:iCs/>' : '') + (o.color ? '<w:color w:val="' + o.color + '"/>' : '') +
      (o.sz ? '<w:sz w:val="' + o.sz + '"/><w:szCs w:val="' + o.sz + '"/>' : '');
    return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') +
      String(text == null ? '' : text).split('\n').map((s) => '<w:t xml:space="preserve">' + xe(s) + '</w:t>').join('<w:br/>') + '</w:r>';
  }
  function wPara(runs, o) {
    o = o || {};
    const pr = (o.keep ? '<w:keepNext/>' : '') + (o.tab ? '<w:tabs><w:tab w:val="right" w:pos="' + o.tab + '"/></w:tabs>' : '') +
      (o.before != null || o.after != null ? '<w:spacing' + (o.before != null ? ' w:before="' + o.before + '"' : '') + (o.after != null ? ' w:after="' + o.after + '"' : '') + '/>' : '') +
      (o.align ? '<w:jc w:val="' + o.align + '"/>' : '');
    return '<w:p>' + (pr ? '<w:pPr>' + pr + '</w:pPr>' : '') + (isArr(runs) ? runs.join('') : runs) + '</w:p>';
  }
  const wEdge = (side, color) => '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="' + (color || 'BFC5CC') + '"/>';
  function wCell(content, o) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + o.w + '" w:type="dxa"/>' + (o.edges ? '<w:tcBorders>' + o.edges + '</w:tcBorders>' : '') +
      (o.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + o.fill + '"/>' : '') + (o.valign ? '<w:vAlign w:val="' + o.valign + '"/>' : '') + '</w:tcPr>' + content + '</w:tc>';
  }
  const wRow = (cellsXml, header) => '<w:tr><w:trPr><w:cantSplit/>' + (header ? '<w:tblHeader/>' : '') + '</w:trPr>' + cellsXml.join('') + '</w:tr>';
  function wTable(widths, rows, lines) {
    const sides = lines === 'all' ? ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] : lines === 'rows' ? ['top', 'bottom', 'insideH'] : [];
    return '<w:tbl><w:tblPr><w:tblW w:w="' + widths.reduce((s, w) => s + w, 0) + '" w:type="dxa"/>' +
      (sides.length ? '<w:tblBorders>' + sides.map((x) => wEdge(x)).join('') + '</w:tblBorders>' : '') + '<w:tblLayout w:type="fixed"/>' +
      '<w:tblCellMar><w:top w:w="28" w:type="dxa"/><w:left w:w="70" w:type="dxa"/><w:bottom w:w="28" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
      '<w:tblGrid>' + widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>' + rows.join('') + '</w:tbl>';
  }
  const wGap = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>'; // keeps two tables apart

  /**
   * The laytime statement as a .docx file: the same content as the printed statement, as plain text and tables
   * that the other side can correct.
   * @param {object} opts { pro, brand:{company,details,logo}, siteUrl, today:'YYYY-MM-DD' }
   * @returns {Uint8Array}
   */
  function docx(calc, result, lang, opts) {
    opts = opts || {};
    if (!result || !result.ok) throw new Error('export: the calculation is not complete');
    const t = (k, v) => I.t(lang, k, v);
    const tt = result.totals, meta = calc.meta || {}, cur = calc.currency || '', oc = V.outcomeOf(result);
    const brand = opts.pro ? (opts.brand || {}) : {};
    const logo = opts.pro ? imageOf(brand.logo) : null;
    const small = 18, tiny = 16;
    const body = [];

    // letterhead and title
    let left = '';
    if (logo) {
      const e = fitEmu(logo, 50, 14);
      left += wPara('<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + e.cx + '" cy="' + e.cy + '"/><wp:docPr id="1" name="Logo"/>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Logo"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + e.cx + '" cy="' + e.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>', { after: 40 });
    }
    if ((brand.company || '').trim()) left += wPara(wRun(brand.company.trim(), { b: 1, sz: 24 }), { after: 20 });
    if ((brand.details || '').trim()) left += wPara(wRun(brand.details.trim(), { sz: small, color: '4A5560' }), { after: 0 });
    const right = wPara(wRun(t('st.title'), { b: 1, sz: 32 }), { align: 'right', after: 20 }) +
      wPara(wRun((meta.voyage ? t('st.ref') + ': ' + meta.voyage + ' · ' : '') + t('st.dateOf') + ': ' + V.fmtDate(E.parseDT(opts.today || ''), lang), { sz: small, color: '4A5560' }), { align: 'right', after: 0 });
    body.push(wTable([5200, 4664], [wRow([wCell(left || wPara(''), { w: 5200, valign: 'bottom' }), wCell(right, { w: 4664, valign: 'bottom' })])], ''));
    body.push(wPara('', { after: 60 }));

    // fixture
    const cpDate = meta.cpDate ? V.fmtDate(E.parseDT(meta.cpDate), lang) : '';
    const cp = meta.cpForm && cpDate ? t('st.cpDated', { form: meta.cpForm, date: cpDate }) : (meta.cpForm || cpDate);
    const fix = [[t('f.vessel'), meta.vessel], [t('st.cp'), cp], [t('f.owners'), meta.owners], [t('f.charterers'), meta.charterers], [t('f.cargo'), meta.cargo]].filter((x) => x[1]);
    if (fix.length) {
      body.push(wTable([2100, 7764], fix.map((x) => wRow([
        wCell(wPara(wRun(x[0], { sz: small, color: '4A5560' }), { after: 0 }), { w: 2100 }), wCell(wPara(wRun(x[1], { b: 1 }), { after: 0 }), { w: 7764 })])), 'rows'));
    }
    body.push(wPara([wRun(t('s.terms') + ': ', { b: 1, sz: small }), wRun(V.termsText(calc, result, lang), { sz: small })], { before: 120 }));

    // ports
    const TS = [1100, 520, 600, 600, 2344, 640, 1320, 1320, 1420];
    const head = ['s.date', 's.day', 's.from', 's.to', 's.remarks', 's.pct', 's.counted', 's.total', 's.balance'];
    result.ports.forEach((pr, i) => {
      const p = calc.ports[i] || {};
      body.push(wPara(wRun(V.portTitle(pr, lang), { b: 1, sz: 24 }), { before: 240, after: 60, keep: 1 }));
      const showAllowed = tt.mode !== 'reversible' || result.ports.length === 1 || pr.allowedMin > 0;
      body.push(wPara([wRun(V.portTermsText(p, lang) + (showAllowed ? ' ' : ''), { sz: small })]
        .concat(showAllowed ? [wRun(t('r.allowed') + ': ' + V.fmtDur(pr.allowedMin, lang), { b: 1, sz: small })] : []), { after: 80 }));
      const facts = V.portFacts(pr, lang);
      if (facts.length) {
        body.push(wTable([2100, 7764], facts.map((f) => wRow([
          wCell(wPara(wRun(V.fmtDT(f.t, lang), { sz: small }), { after: 0 }), { w: 2100 }),
          wCell(wPara(wRun(f.label, { sz: small, b: f.kind === 'expiry' ? 1 : 0 }), { after: 0 }), { w: 7764 })])), ''));
        body.push(wGap);
      }
      const rows = [wRow(head.map((k, c) => wCell(wPara(wRun(t(k), { b: 1, sz: tiny }), { after: 0, align: c >= 2 && c !== 4 ? 'right' : '' }), { w: TS[c], fill: 'E9EDF2', valign: 'center' })), true)];
      for (const r of V.sheetRows(pr, lang)) {
        const fill = ROW_FILL[r.state] || '';
        const vals = [r.first ? r.date : '', r.first ? r.dow : '', r.from, r.to, r.remarks, r.pct, r.counted, r.total, r.balance];
        rows.push(wRow(vals.map((v, c) => wCell(wPara(wRun(v, { sz: tiny }), { after: 0, align: c >= 2 && c !== 4 ? 'right' : '' }), { w: TS[c], fill }))));
      }
      body.push(wTable(TS, rows, 'all'));
      const sums = [];
      if (tt.mode !== 'reversible') sums.push([t('r.allowed'), V.fmtDur(pr.allowedMin, lang)]);
      sums.push([t('r.used'), V.fmtDur(pr.usedMin, lang)]);
      if (pr.notCountedMin > 0) sums.push([t('r.notCounted'), V.fmtDur(pr.notCountedMin, lang)]);
      if (pr.demMin > 0) sums.push([t('r.timeOnDem'), V.fmtDur(pr.demMin, lang)]);
      const sv = tt.basis === 'ATS' ? pr.savedAllMin : pr.savedMin;
      if (sv > 0) sums.push([t('r.timeSaved.' + tt.basis), V.fmtDur(sv, lang)]);
      body.push(wPara(sums.map((x, k) => wRun((k ? '   ·   ' : '') + x[0] + ': ', { sz: small, color: '4A5560' }) + wRun(x[1], { sz: small, b: 1 })), { before: 100 }));
    });

    // summary
    const days = (min) => V.fmtDur(min, lang) + '  (' + V.fmtDays(min, lang) + ' ' + t('r.days') + ')';
    const lines = [[t('st.totalAllowed'), days(tt.allowedMin)], [t('st.totalUsed'), days(tt.usedMin)]];
    if (tt.demMin > 0) lines.push([t('r.timeOnDem'), days(tt.demMin)]);
    if (tt.desMin > 0) lines.push([t('r.timeSaved.' + tt.basis), days(tt.desMin)]);
    if (tt.demurrage > 0) lines.push([t('r.demAt', { rate: V.fmtRate(tt.demRate, cur, lang) }), V.fmtMoney(tt.demurrage, cur, lang)]);
    if (tt.commission > 0) lines.push([t('r.commission', { pct: V.fmtNumber(tt.commissionPct, lang, tt.commissionPct % 1 ? 2 : 0) }), '− ' + V.fmtMoney(tt.commission, cur, lang)]);
    if (tt.despatch > 0) lines.push([t('r.desAt', { rate: V.fmtRate(tt.desRate, cur, lang) }), (tt.demurrage > 0 ? '− ' : '') + V.fmtMoney(tt.despatch, cur, lang)]);
    lines.push([t('r.outcome.' + tt.outcome), V.fmtMoney(oc.amount, cur, lang), true]);
    body.push(wPara(wRun(t('st.summary'), { b: 1, sz: 24 }), { before: 280, after: 60, keep: 1 }));
    body.push(wTable([6100, 3764], lines.map((x) => wRow([
      wCell(wPara(wRun(x[0], { b: x[2] ? 1 : 0, sz: x[2] ? 22 : 20 }), { after: 0 }), { w: 6100, fill: x[2] ? 'E9EDF2' : '' }),
      wCell(wPara(wRun(x[1], { b: x[2] ? 1 : 0, sz: x[2] ? 22 : 20 }), { after: 0, align: 'right' }), { w: 3764, fill: x[2] ? 'E9EDF2' : '' })])), 'rows'));

    if ((meta.remarks || '').trim()) body.push(wPara(wRun(meta.remarks.trim()), { before: 200 }));

    // signatures
    const sign = (label) => wCell(wPara(wRun(label, { sz: small, color: '4A5560' }), { after: 0 }), { w: 4300, edges: wEdge('top', '1B2430') });
    body.push(wPara('', { before: 600, after: 0 }));
    body.push(wTable([4300, 1264, 4300], [wRow([sign(t('st.signOwners')), wCell(wPara('', { after: 0 }), { w: 1264 }), sign(t('st.signCharterers'))])], ''));
    body.push(wPara('', { after: 0 }));

    const site = (opts.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const footer = wPara([wRun(t('st.eoe'), { sz: tiny, color: '6B7682' })]
      .concat(opts.pro ? [] : ['<w:r><w:tab/></w:r>', wRun(t('st.freeFooter') + (site ? ' · ' + site : ''), { sz: tiny, color: '6B7682' })]), { tab: PAGE_W, after: 0 });

    const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG = 'http://schemas.openxmlformats.org/package/2006';
    const east = lang === 'zh' ? ' w:eastAsia="Microsoft YaHei"' : '';
    const title = [meta.vessel, calc.name].filter(Boolean).join(' — ') || t('st.title');
    const files = [
      { name: '[Content_Types].xml', data: XML + '<Types xmlns="' + PKG + '/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        (logo ? '<Default Extension="' + logo.ext + '" ContentType="image/' + logo.type + '"/>' : '') +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
      { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + PKG + '/relationships"><Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="' + PKG + '/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
      { name: 'docProps/core.xml', data: coreXML(title, opts.today) },
      { name: 'word/document.xml', data: XML + '<w:document ' + WNS + '><w:body>' + body.join('') +
        '<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1021" w:right="1021" w:bottom="1021" w:left="1021" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>' },
      { name: 'word/_rels/document.xml.rels', data: XML + '<Relationships xmlns="' + PKG + '/relationships"><Relationship Id="rId1" Type="' + REL + '/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="' + REL + '/footer" Target="footer1.xml"/>' + (logo ? '<Relationship Id="rId3" Type="' + REL + '/image" Target="media/image1.' + logo.ext + '"/>' : '') +
        '<Relationship Id="rId4" Type="' + REL + '/settings" Target="settings.xml"/></Relationships>' },
      { name: 'word/styles.xml', data: XML + '<w:styles ' + WNS + '><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"' + east + '/>' +
        '<w:color w:val="1B2430"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="' + (W_LANG[lang] || 'en-US') + '"' + (lang === 'zh' ? ' w:eastAsia="zh-CN"' : '') + '/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
        '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>' },
      { name: 'word/settings.xml', data: XML + '<w:settings ' + WNS + '><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>' },
      { name: 'word/footer1.xml', data: XML + '<w:ftr ' + WNS + '>' + footer + '</w:ftr>' },
    ];
    if (logo) files.push({ name: 'word/media/image1.' + logo.ext, data: logo.bytes });
    return zip(files, opts.today);
  }

  return { MIME, zip, crc32, imageOf, parseFormula, evaluate, xlsxModel, xlsx, docx };
});
