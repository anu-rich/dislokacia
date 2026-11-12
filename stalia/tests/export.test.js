'use strict';
/* Editable exports: the Excel time sheet must calculate what the engine calculates — also after it is edited. */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/engine.js');
const M = require('../app/model.js');
const I = require('../app/i18n.js');
const V = require('../app/view.js');
const X = require('../app/export.js');
const { rng, randomFixture } = require('./helpers/random.js');
const { unzip, textOf } = require('./helpers/zip.js');

const DAY = 1440;
const OPTS = { today: '2026-11-12', siteUrl: 'https://stalia.example' };
const ex = (id, lang) => M.examples(lang || 'en').find((x) => x.id === id).calc;
const near = (a, b, tol, msg) => assert.ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
const serial = (min) => min / DAY + 25569;

/** Every tag opened is closed, in order: enough to catch a broken document without an XML library. */
function wellFormed(xml, name) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g;
  let m;
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  assert.ok(!/<(?![\/A-Za-z_])/.test(body), name + ': a stray "<"');
  while ((m = re.exec(body))) {
    if (m[1]) assert.equal(stack.pop(), m[2], name + ': closing tag out of order');
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], name + ': unclosed tags');
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body), name + ': a bare "&"');
}

test('zip: entries, sizes and checksums', () => {
  assert.equal(X.crc32(Buffer.from('123456789')), 0xCBF43926);
  const files = unzip(X.zip([{ name: 'a.txt', data: 'héllo' }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }, { name: 'empty', data: '' }], '2026-11-12'));
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/b.bin', 'empty']);
  assert.equal(textOf(files, 'a.txt'), 'héllo');
  assert.deepEqual(Array.from(files['dir/b.bin']), [0, 1, 2, 255]);
  assert.equal(files.empty.length, 0);
});

test('formulas: the evaluator follows spreadsheet rules', () => {
  const cells = {
    A1: { v: 2 }, A2: { v: 3.5 }, A3: { v: 'text' }, A4: { v: null }, B1: { v: 10 }, B2: { v: 20 }, B3: { v: 30 }, B4: { v: 40 },
    C1: { f: '=A1+A2*2' }, C2: { f: '=(A1+A2)*2' }, C3: { f: '=SUM(A1:A4)' }, C4: { f: '=SUMPRODUCT(A1:A4,B1:B4)' },
    C5: { f: '=IF(A1>1,"yes","no")' }, C6: { f: '=IF(A1=0,1/0,MAX(A1:A4))' }, C7: { f: '=MIN(5,A1:A2,-1)' }, C8: { f: '=ROUND(2.675,2)' },
    C9: { f: '=ROUND(-2.5,0)' }, C10: { f: '="Rate "&A2*100&"%"' }, C11: { f: '=COUNT(A1:A4)' }, C12: { f: '=-A1+ABS(-4)' },
    C13: { f: '=IF(AND(A1>=2,A2<=3.5,A1<>A2),C1,0)' }, C14: { f: '=SUMPRODUCT(MAX(A1:A2+B1:B2))' }, C15: { f: '=$A$1*A$2/$B1' },
    C16: { f: '=IF(COUNT(A3:A4)=0,"—",MAX(A3:A4))' }, C17: { f: '="a ""quoted"" word"' }, C18: { f: '=1e-3+0.000000001' }, C19: { f: '=C1+C2' },
  };
  X.evaluate(cells);
  const v = (r) => cells[r].v;
  assert.equal(v('C1'), 9); assert.equal(v('C2'), 11); assert.equal(v('C3'), 5.5);
  assert.equal(v('C4'), 2 * 10 + 3.5 * 20); // text and blanks count as zero
  assert.equal(v('C5'), 'yes'); assert.equal(v('C6'), 3.5); // the branch not taken is never worked out
  assert.equal(v('C7'), -1); assert.equal(v('C8'), 2.68); assert.equal(v('C9'), -3);
  assert.equal(v('C10'), 'Rate 350%'); assert.equal(v('C11'), 2); assert.equal(v('C12'), 2);
  assert.equal(v('C13'), 9); assert.equal(v('C14'), 23.5); assert.equal(v('C15'), 0.7);
  assert.equal(v('C16'), '—'); assert.equal(v('C17'), 'a "quoted" word'); assert.equal(v('C18'), 0.001000001); assert.equal(v('C19'), 20);
  assert.throws(() => X.evaluate({ A1: { f: '=A2' }, A2: { f: '=A1' } }), /circular/);
  assert.throws(() => X.evaluate({ A1: { f: '=NOPE(1)' } }), /unknown function/);
  assert.throws(() => X.evaluate({ A1: { v: 'x' }, A2: { f: '=A1*2' } }), /#VALUE!/);
  assert.throws(() => X.evaluate({ A1: { f: '=1+' } }), /ends too early/);
});

/** The sheet, worked out by its own formulas, against the engine. */
function agree(model, calc, label) {
  const r = E.compute(calc);
  assert.ok(r.ok, label + ': fixture does not compute ' + JSON.stringify(r.errors));
  X.evaluate(model.cells);
  const v = (ref) => model.cells[ref].v, T = model.refs.total, tt = r.totals;
  near(v(T.allowed) * DAY, tt.allowedMin, 1e-5, label + ' allowed');
  near(v(T.used) * DAY, tt.usedMin, 1e-5, label + ' used');
  near(v(T.dem) * DAY, tt.demMin, 1e-5, label + ' time on demurrage');
  near(v(T.des) * DAY, tt.desMin, 1e-5, label + ' time saved');
  r.ports.forEach((pr, i) => {
    const P = model.refs.ports[i];
    near(v(P.counted) * DAY, pr.usedMin, 1e-5, `${label} port ${i} used`);
    near(v(P.dem) * DAY, pr.demMin, 1e-5, `${label} port ${i} demurrage`);
    const saved = tt.basis === 'ATS' ? pr.savedAllMin : pr.savedMin;
    if (tt.mode !== 'reversible' || i === r.ports.length - 1) near(v(P.saved) * DAY, saved, 1e-5, `${label} port ${i} saved`);
    if (typeof v(P.expiry) === 'number') near(v(P.expiry), serial(pr.expiry), 1e-8, `${label} port ${i} expiry`);
    else assert.ok(pr.expiry == null || pr.expiry === pr.start, `${label} port ${i}: the sheet shows no expiry, the engine ${pr.expiry}`);
  });
  near(v(T.demurrage), tt.demurrage, 0.006, label + ' demurrage');
  near(-v(T.commission), tt.commission, 0.006, label + ' commission');
  if (T.despatch) near(-v(T.despatch), tt.despatch, 0.006, label + ' despatch');
  else assert.equal(tt.despatch, 0, label + ' no despatch line');
  near(v(T.amount), Math.abs(tt.net), 0.006, label + ' amount');
  if (Math.abs(tt.net) > 0.02) assert.equal(v(T.outcome), I.t(model.lang, 'r.outcome.' + tt.outcome), label + ' outcome');
  return r;
}

test('xlsx: the three examples calculate to the engine’s figures, in every language', () => {
  for (const lang of I.LANGS) {
    for (const e of M.examples(lang)) {
      const model = X.xlsxModel(e.calc, E.compute(e.calc), lang, OPTS);
      agree(model, e.calc, lang + ' ' + e.id);
    }
  }
  const calc = ex('bulk'), model = X.xlsxModel(calc, E.compute(calc), 'en', OPTS);
  X.evaluate(model.cells);
  assert.equal(model.cells[model.refs.total.amount].v, 23841.93);
  assert.equal(model.cells[model.refs.total.outcome].v, 'Demurrage due to Owners');
  assert.equal(model.cells[model.cells[model.refs.total.demurrage] ? 'A' + model.refs.total.demurrage.slice(1) : ''].v, 'Demurrage at USD 14500 per day');
});

/** Terms the base generator does not vary: notice time before laytime, rates, despatch, laytime by cargo rate. */
function enrich(fx, rand, tight) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  fx.currency = 'USD'; fx.meta = { vessel: 'MV TEST' };
  if (tight) { // a short pooled allowance: the vessel reaches the later ports already on demurrage
    fx.laytimeMode = 'reversible';
    fx.ports.forEach((p) => { p.allowed.minutes = Math.floor(rand() * DAY); });
  }
  fx.despatchMode = pick(['half', 'half', 'custom', 'none']);
  if (fx.despatchMode === 'custom') fx.despatchRate = pick([3000, 4500.5, 8000]);
  fx.commissionPct = pick([0, 0, 1.25, 2.5, 3.75]);
  if (rand() < 0.4) fx.demurrageAtNextPort = 'laytimeStart';
  fx.ports.forEach((p) => {
    if (rand() < 0.5) { // NOR some hours before laytime starts: at a later reversible port that time may count
      const hours = pick([6, 12, 24, 30]);
      p.nor = { rule: 'turn', tendered: E.fmtDT(E.parseDT(p.nor.manualStart) - hours * 60), turnHours: hours, unlessSoonerCommenced: false };
    }
    if (rand() < 0.3) { // 5 MT a minute: the allowance stays a whole number of minutes
      const hour = rand() < 0.5;
      p.allowed = { type: 'rate', quantity: p.allowed.minutes * 5, rate: hour ? 300 : 7200, rateUnit: hour ? 'hour' : 'day' };
    }
  });
  return fx;
}

test('xlsx: 400 random voyages — as exported, and after the allowance, the rates and a completion time are edited in the sheet', () => {
  const rand = rng(20261113);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  let notice = 0, ats = 0, expired = 0;
  for (let n = 0; n < 400; n++) {
    const calc = enrich(randomFixture(rand), rand, n % 4 === 0);
    const first = E.compute(calc);
    assert.ok(first.ok, `#${n} invalid`);
    const model = X.xlsxModel(calc, first, 'en', OPTS), cells = model.cells;
    const r0 = agree(model, calc, `#${n}`);
    if (r0.totals.basis === 'ATS' && r0.totals.savedATSMin > r0.totals.savedWTSMin + 1) ats++;
    if (r0.ports.some((p) => p.arrivedOnDemurrage && p.norRaw != null && p.start === p.norRaw)) notice++;
    if (r0.ports.some((p) => p.expiry != null)) expired++;

    // 1. laytime allowed (or the cargo quantity it is derived from) changes at every port — by up to a week in all
    calc.ports.forEach((p, i) => {
      const minutes = int(0, Math.round(first.ports[i].allowedMin) + Math.floor((7 * DAY) / calc.ports.length)), P = model.refs.ports[i];
      if (p.allowed.type === 'rate') { p.allowed.quantity = minutes * 5; cells[P.quantity].v = minutes * 5; }
      else { p.allowed = { type: 'fixed', minutes }; cells[P.allowed].v = minutes / DAY; }
    });
    agree(model, calc, `#${n} allowance edited`);

    // 2. rates and commission
    calc.demurrageRate = int(5000, 40000) + 0.5; cells[model.refs.demRate].v = calc.demurrageRate;
    calc.commissionPct = int(0, 5); cells[model.refs.commission].v = calc.commissionPct / 100;
    if (calc.despatchMode === 'custom') { calc.despatchRate = int(1000, 9000); cells[model.refs.desRate].v = calc.despatchRate; }
    agree(model, calc, `#${n} rates edited`);

    // 3. operations completed earlier: the last period of one port is shortened
    const k = int(0, calc.ports.length - 1), P = model.refs.ports[k], row = P.last;
    const length = Math.round((cells['D' + row].v - cells['C' + row].v) * DAY);
    if (length >= 2) {
      const cut = int(1, length - 1);
      cells['D' + row].v -= cut / DAY;
      calc.ports[k].completed = E.fmtDT(E.parseDT(calc.ports[k].completed) - cut);
      agree(model, calc, `#${n} completion edited`);
    }
  }
  // the fixtures really exercise what is hard: notice time counted on demurrage, all time saved over excepted periods
  assert.ok(notice >= 10, 'arrived on demurrage, counted from NOR: ' + notice);
  assert.ok(ats >= 20, 'all time saved longer than working time saved: ' + ats);
  assert.ok(expired >= 150, 'laytime expired: ' + expired);
});

test('xlsx: a period is one row a day, with the formulas that split it between laytime and demurrage', () => {
  const calc = ex('bulk'), r = E.compute(calc), model = X.xlsxModel(calc, r, 'en', OPTS), cells = model.cells;
  X.evaluate(cells);
  const P = model.refs.ports[0];
  // header, then rows that continue from one another without a gap
  assert.equal(cells['A' + P.header].v, 'Date'); assert.equal(cells['G' + P.header].v, 'Counts as laytime'); assert.equal(cells['M' + P.header].v, 'Laytime expired');
  let at = null, counted = 0;
  for (let row = P.first; row <= P.last; row++) {
    const start = cells['A' + row].v + cells['C' + row].v, endAt = cells['A' + row].v + cells['D' + row].v;
    if (at != null) near(start, at, 1e-9, 'row ' + row + ' continues the one above');
    assert.ok(cells['D' + row].v <= 1 && cells['D' + row].v > cells['C' + row].v, 'row ' + row + ' stays within its day');
    assert.match(cells['I' + row].f, /^=K\d+-MIN\(/); assert.match(cells['K' + row].f, /^=MIN\(.*SUMPRODUCT\(E\$\d+:E\d+,G\$\d+:G\d+\)\)$/);
    counted += cells['I' + row].v;
    at = endAt;
  }
  near(at, serial(r.ports[0].end), 1e-9, 'the last row ends at completion');
  near(counted * DAY, r.ports[0].usedMin, 1e-6, 'rows add up to the laytime used');
  // exactly one row carries the moment laytime expired, and the port total repeats it
  const marks = [];
  for (let row = model.refs.ports[1].first; row <= model.refs.ports[1].last; row++) if (typeof cells['M' + row].v === 'number') marks.push(cells['M' + row].v);
  assert.equal(marks.length, 1);
  near(marks[0], serial(r.ports[1].expiry), 1e-8, 'expiry');
  near(cells[model.refs.ports[1].expiry].v, marks[0], 1e-12, 'expiry in the totals row');
  // plain periods word themselves: laytime counts until it is used up, then the vessel is on demurrage
  const words = [];
  for (let row = model.refs.ports[1].first; row <= model.refs.ports[1].last; row++) if (cells['F' + row].f) words.push(cells['F' + row].v);
  assert.ok(words.indexOf('Laytime counts') >= 0 && words.indexOf('On demurrage') > words.indexOf('Laytime counts'), words.join(' | '));
  // separate laytime: each port counts against its own allowance
  assert.match(cells['K' + P.first].f, /^=MIN\(\$G\$\d+,SUMPRODUCT/);
  assert.equal(cells['F' + (model.refs.ports[1].header + 2)].f.indexOf('=IF('), 0, 'no row carried over from the first port');
});

test('xlsx: reversible laytime — one pooled allowance, and the second port starts from what the first one used', () => {
  const calc = ex('tanker'), r = E.compute(calc), model = X.xlsxModel(calc, r, 'en', OPTS), cells = model.cells;
  X.evaluate(cells);
  assert.equal(r.totals.mode, 'reversible');
  const before = model.refs.ports[1].header + 2, pool = model.refs.total.allowed.replace(/([A-Z]+)(\d+)/, '$$$1$$$2');
  assert.equal(cells['F' + before].v, 'Laytime used at previous ports');
  assert.equal(cells['K' + before].f, '=' + model.refs.ports[0].used);
  near(cells['K' + before].v * DAY, r.ports[0].usedMin, 1e-6, 'carried over');
  const row = model.refs.ports[1].first;
  assert.ok(cells['K' + row].f.indexOf('=MIN(' + pool + ',$K$' + before + '+SUMPRODUCT(') === 0, cells['K' + row].f);
  assert.equal(cells[model.refs.total.allowed].f, '=' + model.refs.ports.map((p) => p.allowed).join('+'));
  near(cells[model.refs.total.allowed].v * DAY, 72 * 60, 1e-9, '72 hours in all');
});

test('xlsx: the file — parts, formulas with stored values, strings in the statement language', () => {
  const calc = ex('bulk', 'ru'), r = E.compute(calc);
  const files = unzip(X.xlsx(calc, r, 'ru', OPTS));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[name], name + ' is in the file');
    wellFormed(textOf(files, name), name);
  }
  const sheet = textOf(files, 'xl/worksheets/sheet1.xml'), strings = textOf(files, 'xl/sharedStrings.xml');
  assert.match(textOf(files, 'xl/workbook.xml'), /fullCalcOnLoad="1"/);
  assert.match(textOf(files, 'xl/workbook.xml'), /<sheet name="Таймшит"/);
  assert.ok((sheet.match(/<f>/g) || []).length > 150, 'formulas');
  assert.ok(!/<f>=/.test(sheet), 'formulas are stored without the leading "="');
  assert.match(sheet, /<f>ROUND\([A-Z]+\d+\*\$G\$\d+,2\)<\/f><v>24770\.83<\/v>/); // the stored value is what the formula gives
  assert.match(sheet, /t="str"><f>IF\(AND\(.*?<\/f><v>Демередж в пользу судовладельца<\/v>/);
  assert.match(sheet, /<f>SUMPRODUCT\(E\$\d+:E\d+,G\$\d+:G\d+\)|SUMPRODUCT\(E\$\d+:E\d+,G\$\d+:G\d+\)/);
  assert.match(strings, /Жёлтые ячейки/); assert.match(strings, /MV EXAMPLE TRADER/); assert.match(strings, /Подготовлено в Stalia \(бесплатная версия\) · stalia\.example/);
  assert.match(textOf(files, 'xl/styles.xml'), /formatCode="\[\$-419\]dd\\\.mm\\\.yyyy"/);
  assert.match(textOf(files, 'xl/styles.xml'), /formatCode="\[hh\]:mm"/);
  assert.ok(!files['xl/drawings/drawing1.xml']);
  // without stored values only the formulas remain — for checking them in a real spreadsheet
  const bare = textOf(unzip(X.xlsx(calc, r, 'ru', Object.assign({ noCache: true }, OPTS))), 'xl/worksheets/sheet1.xml');
  assert.ok(!/<\/f><v>/.test(bare));
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
test('letterhead is Pro: company, details and logo go into both files, the “free version” line goes away', () => {
  const calc = ex('bulk'), r = E.compute(calc);
  const brand = { company: 'Northwind Chartering & Co.', details: 'Quay 1, Port\n+1 555 0100', logo: PNG };
  const free = { x: unzip(X.xlsx(calc, r, 'en', Object.assign({ brand }, OPTS))), w: unzip(X.docx(calc, r, 'en', Object.assign({ brand }, OPTS))) };
  const pro = { x: unzip(X.xlsx(calc, r, 'en', Object.assign({ pro: true, brand }, OPTS))), w: unzip(X.docx(calc, r, 'en', Object.assign({ pro: true, brand }, OPTS))) };
  assert.match(textOf(free.x, 'xl/sharedStrings.xml'), /Prepared with Stalia \(free version\)/);
  assert.match(textOf(free.w, 'word/footer1.xml'), /Prepared with Stalia \(free version\) · stalia\.example/);
  assert.ok(!/Northwind/.test(textOf(free.x, 'xl/sharedStrings.xml')) && !/Northwind/.test(textOf(free.w, 'word/document.xml')));
  assert.ok(!free.x['xl/media/image1.png'] && !free.w['word/media/image1.png']);
  assert.ok(!/Prepared with Stalia/.test(textOf(pro.x, 'xl/sharedStrings.xml')) && !/Prepared with Stalia/.test(textOf(pro.w, 'word/footer1.xml')));
  assert.match(textOf(pro.x, 'xl/sharedStrings.xml'), /Northwind Chartering &amp; Co\./); assert.match(textOf(pro.x, 'xl/sharedStrings.xml'), /Quay 1, Port, \+1 555 0100/);
  assert.match(textOf(pro.w, 'word/document.xml'), /Northwind Chartering &amp; Co\./);
  assert.equal(pro.x['xl/media/image1.png'].length, pro.w['word/media/image1.png'].length);
  assert.match(textOf(pro.x, 'xl/worksheets/sheet1.xml'), /<drawing r:id="rId1"\/>/);
  assert.match(textOf(pro.w, 'word/document.xml'), /<a:blip r:embed="rId3"\/>/);
  for (const f of [pro.x, pro.w]) for (const name of Object.keys(f)) if (/\.(xml|rels)$/.test(name)) wellFormed(textOf(f, name), name);
  // a picture Word cannot show is left out rather than breaking the file
  assert.equal(X.imageOf('data:image/webp;base64,AAAA'), null); assert.equal(X.imageOf('data:image/png;base64,AAAA'), null);
  assert.deepEqual([X.imageOf(PNG).w, X.imageOf(PNG).h], [1, 1]);
});

test('docx: the statement as text and tables, in the statement language', () => {
  for (const lang of I.LANGS) {
    const calc = ex('bulk', lang), r = E.compute(calc), files = unzip(X.docx(calc, r, lang, OPTS));
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml', 'word/footer1.xml']) {
      assert.ok(files[name], name + ' is in the file');
      wellFormed(textOf(files, name), name);
    }
    const doc = textOf(files, 'word/document.xml');
    const plain = doc.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const t = (k, v) => I.t(lang, k, v);
    for (const s of [t('st.title'), calc.meta.vessel, calc.meta.owners, V.termsText(calc, r, lang), V.portTitle(r.ports[0], lang), V.portTitle(r.ports[1], lang),
      t('st.summary'), t('r.outcome.' + r.totals.outcome), V.fmtMoney(23841.93, 'USD', lang), t('st.signOwners'), t('st.signCharterers')]) {
      assert.ok(plain.indexOf(s) >= 0, lang + ': the document has “' + s + '”');
    }
    const rows = r.ports.reduce((n, pr) => n + V.sheetRows(pr, lang).length + 1, 0); // each port: a heading row and its periods
    assert.equal((doc.match(/<w:tr>/g) || []).length - (doc.match(/<w:tblHeader\/>/g) || []).length, rows - r.ports.length + countPlainRows(r, calc, lang), lang + ': rows');
    assert.match(textOf(files, 'word/styles.xml'), new RegExp('w:lang w:val="' + { en: 'en-US', ru: 'ru-RU', kk: 'kk-KZ', uk: 'uk-UA', tr: 'tr-TR', el: 'el-GR', zh: 'zh-CN' }[lang] + '"'));
  }
});
/** Rows of the document that are not time-sheet periods: letterhead, fixture, facts, summary, signatures. */
function countPlainRows(r, calc, lang) {
  const m = calc.meta, fixture = [m.vessel, m.cpForm || m.cpDate, m.owners, m.charterers, m.cargo].filter(Boolean).length;
  const facts = r.ports.reduce((n, pr) => n + V.portFacts(pr, lang).length, 0), tt = r.totals;
  const summary = 2 + (tt.demMin > 0) + (tt.desMin > 0) + (tt.demurrage > 0) + (tt.commission > 0) + (tt.despatch > 0) + 1;
  return 1 + fixture + facts + summary + 1;
}

test('exports refuse a calculation that is not complete', () => {
  const calc = M.blankCalc(), r = E.compute(calc);
  assert.equal(r.ok, false);
  assert.throws(() => X.xlsx(calc, r, 'en', OPTS), /not complete/);
  assert.throws(() => X.docx(calc, r, 'en', OPTS), /not complete/);
});

test('user text cannot break the files: markup, quotes and control characters', () => {
  const calc = ex('bulk');
  calc.meta.vessel = 'MV <A&B> "Q" \u0001\u0002'; calc.meta.remarks = 'line 1\nline 2 & <tag>';
  calc.ports[0].events[0].desc = '=1+1 "quoted" <b>';
  const r = E.compute(calc);
  const x = unzip(X.xlsx(calc, r, 'en', OPTS)), w = unzip(X.docx(calc, r, 'en', OPTS));
  for (const f of [x, w]) for (const name of Object.keys(f)) if (/\.(xml|rels)$/.test(name)) wellFormed(textOf(f, name), name);
  assert.match(textOf(x, 'xl/sharedStrings.xml'), /MV &lt;A&amp;B&gt; &quot;Q&quot; </);
  assert.match(textOf(w, 'word/document.xml'), /line 1<\/w:t><w:br\/><w:t xml:space="preserve">line 2 &amp; &lt;tag&gt;/);
  const model = X.xlsxModel(calc, r, 'en', OPTS);
  X.evaluate(model.cells);
  const texts = Object.keys(model.cells).filter((k) => /^F/.test(k)).map((k) => model.cells[k]);
  assert.ok(texts.some((c) => c.f == null && /^=1\+1 "quoted" <b>/.test(c.v)), 'a description that looks like a formula stays text');
});
