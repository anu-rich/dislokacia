const D = JSON.parse(document.getElementById('data').textContent);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtN = (v, d = 0) => v == null || isNaN(v) ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d });
const P = s => { if (!s) return null; const m = /^(\d{4})-(\d\d)-(\d\d)(?: (\d\d):(\d\d))?/.exec(s); return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null; };
const hrs = (a, b) => { const x = P(a), y = P(b); if (!x || !y) return null; const h = (y - x) / 36e5; return (h < 0 || h > 24 * 90) ? null : h; };
const MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const dmy = s => { const d = P(s); return d ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}${s.length > 10 ? ' ' + s.slice(11) : ''}` : '—'; };
const rows = (arr, cols) => arr.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
const TANK = rows(D.tank, D.tank_cols), BULK = rows(D.bulk, D.bulk_cols), BUNK = rows(D.bunk, D.bunk_cols);
const KM = new Set([...D.kmtf.tankers, ...D.kmtf.bulk, ...(D.kmtf.aframax || []), ...(D.kmtf.tugs || [])]);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.id !== 'p-' + (t === 'bunk' ? 'hist' : t));
  if (t === 'hist' || t === 'bunk') {
    if (t === 'bunk') { S.seg = 'bunk'; } else if (S.seg === 'bunk') { S.seg = 'tank'; document.querySelectorAll('#seg button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === 'tank')); }
    document.getElementById('seg-f').style.display = t === 'bunk' ? 'none' : '';
    document.getElementById('fleetsel').parentNode.style.display = t === 'bunk' ? 'none' : '';
    if (t === 'bunk') S.fleet = 'all';
    S.vessel = ''; S.shpr = ''; fillSelects(); renderHist();
  }
  document.getElementById('histnote').hidden = SI === SNAPS.length - 1 || !['now', 'ports', 'open', 'tugs', 'sup'].includes(t);
  if (t === 'oil' || t === 'cnt') renderVol();
  if (t === 'osv') renderOSV();
  if (t === 'wx' && !wxLoaded) renderWx();
  if (t === 'raw') renderRaw();
}));

/* ---------- SNAPSHOTS / DATE ---------- */
const SNAPS = D.snapshots || [];
let SI = SNAPS.length - 1;                   // индекс выбранного снимка
const CUR = () => SNAPS[SI];
let NOW = P(CUR().ts);
const isOpenPort = p => /abu dhabi|новоросс|европ|открытые|средиземн|чёрное|черное/i.test(p);
const KM_T = D.kmtf.tankers, KM_C = D.kmtf.containers || [], KM_B = D.kmtf.bulk.filter(v => !KM_C.includes(v)), KM_A = D.kmtf.aframax || [], KM_TUG = D.kmtf.tugs || [];
const isTug = n => /^tug\b|буксир/i.test(n) || KM_TUG.includes(n);

const stampEl = document.getElementById('stamp');
const since = s => { const d = P(s); if (!d || !NOW) return ''; const h = (NOW - d) / 36e5; if (h < 0) return 'ожид. ' + dmy(s); if (h < 48) return Math.round(h) + ' ч'; return Math.round(h / 24) + ' сут'; };
const SECN = { berth: 'у причала', roads: 'на рейде', approach: 'на подходе', departed: 'отход' };
const SECT = { roads: 'На рейде', approach: 'Подход', departed: 'Отошли за сутки', berth: 'У причала' };
const numS = s => parseFloat(String(s ?? '').replace(',', '.').replace(/[^\d.]/g, ''));

function flatItems(S) {
  return S.ports.flatMap(p => Object.entries(p.sec).flatMap(([k, v]) => v.filter(x => x.n).map(x => ({ ...x, sec: k, seg: p.g, port: p.p, open: p.g === 'o' || isOpenPort(p.p) }))));
}
function berthChip(it, seg) {
  if (!it.n) {
    if (it.closed) return `<div class="berth closed"><span class="n">Причал ${esc(it.b)}</span><span class="v">закрыт</span><span class="o">${esc(it.note || 'ремонт')}</span></div>`;
    return `<div class="berth free"><span class="n">Причал ${esc(it.b)}</span><span class="v">свободен</span></div>`;
  }
  const km = KM.has(it.n) ? ' <span class="pill k">КМТФ</span>' : '';
  const cargo = it.c || it.c2 || '';
  return `<div class="berth busy ${seg === 'b' ? 'bulk' : ''}"><span class="n">Причал ${esc(it.b || '?')}${it.h ? ' · ' + esc(it.h) : ''}</span><span class="v">${esc(it.n)}${km}</span><span class="o">${esc(it.o || it.z || '')}${it.t ? ' · ' + since(it.t) : ''}${cargo ? ' · ' + esc(cargo) + (/\d$/.test(cargo) ? ' т' : '') : ''}</span></div>`;
}
function listRow(it) {
  const km = KM.has(it.n) ? ' <span class="pill k">КМТФ</span>' : '';
  const meta = [it.i, it.h, it.z && it.z !== it.o ? it.z : '', it.o].filter(Boolean).join(' · ');
  const t = it.d ? 'отход ' + dmy(it.d) : (it.a ? (P(it.a) > NOW ? 'ETA ' + dmy(it.a) : 'на рейде ' + since(it.a)) : '');
  const cargo = [it.c, it.k].filter(Boolean).join(' · ') || (it.c2 ? it.c2 + (it.k2 ? ' · ' + it.k2 : '') : '');
  return `<div class="row"><span class="v">${esc(it.n)}${km}</span><span class="m">${esc(meta)}</span><span class="t">${esc(t)}</span><span class="cg">${esc(cargo)}</span></div>`;
}
function portCard(p) {
  const s = p.sec, ships = Object.values(s).flat().filter(x => x.n).length;
  const berthsAll = s.berth || [], numbered = berthsAll.filter(b => b.b || !b.n);
  const berthHtml = numbered.length && p.g !== 'o' ? `<div class="berths">${berthsAll.map(b => berthChip(b, p.g)).join('')}</div>` : '';
  const listSecs = p.g === 'o' || !numbered.length ? ['berth', 'roads', 'approach', 'departed'] : ['roads', 'approach', 'departed'];
  const lists = listSecs.filter(k => s[k]).map(k => `<div class="sec"><h3>${SECT[k]}</h3>${s[k].filter(x => x.n).length ? s[k].filter(x => x.n).map(listRow).join('') : '<div class="empty">—</div>'}</div>`).join('');
  const segName = { t: 'танкеры', b: 'сухогрузы и контейнеровозы', o: 'открытые моря' }[p.g];
  return `<article class="port"><header><h2>${esc(p.p.replace(/^порт[ы]?\s+/i, '').replace(/^п\.\s*/i, ''))}</h2><span class="seg">${isOpenPort(p.p) && p.g !== 'o' ? 'открытые моря' : segName}</span><span class="cnt">${ships} судов</span></header>${berthHtml}${lists}</article>`;
}
const kpiHtml = arr => arr.map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${esc(s)}</div></div>`).join('');
const uniq = a => new Set(a.map(x => x.n)).size;
const cl = (v, lim) => isNaN(v) ? '' : v <= lim[0] ? 'lvl-crit' : v <= lim[1] ? 'lvl-warn' : '';

function fleetRow(v, it, supMap) {
  const s = supMap[v] || {};
  const supCell = s.fuel != null && !isNaN(s.fuel) ? `<td class="${cl(s.fuel, [15, 30])}">${fmtN(s.fuel, 1)}</td><td class="${cl(s.water, [10, 20])}">${fmtN(s.water, 0)}</td><td class="${cl(s.food, [3, 7])}">${fmtN(s.food)}</td>` : '<td>—</td><td>—</td><td>—</td>';
  if (!it) return `<tr><td><b>${esc(v)}</b></td><td colspan="4" style="text-align:left;color:var(--ink-3)">нет в сводке</td>${supCell}</tr>`;
  const place = placeOf(it);
  const st = [it.sec === 'departed' ? 'отход' : (it.z && it.z !== it.o ? it.z : SECN[it.sec]), it.o].filter((x, i, arr) => x && arr.indexOf(x) === i).join(' · ');
  const t0 = it.sec === 'berth' ? (it.t || it.a) : it.a;
  const when = it.sec === 'departed' && it.d ? 'отошло ' + dmy(it.d) : (t0 ? (P(t0) > NOW ? 'ETA ' + dmy(t0) : 'с ' + dmy(t0) + ' (' + since(t0) + ')') : '');
  const cg = [it.c ? it.c + (/\d$/.test(it.c) ? ' т' : '') : '', it.k, it.c2 && !it.c ? it.c2 : '', it.k2 && !it.k ? it.k2 : '', it.h].filter(Boolean).join(' · ');
  const stCls = it.sec === 'berth' ? 'ok' : it.sec === 'departed' ? 'warn' : '';
  return `<tr><td><b>${esc(v)}</b></td><td style="text-align:left">${esc(place)}${it.b ? ', пр. ' + esc(it.b) : ''}${it.e ? ' (' + esc(it.e) + ')' : ''}</td><td style="text-align:left"><span class="st ${stCls}" style="${!stCls ? 'background:var(--s1-soft);color:var(--s1)' : ''}">${esc(st)}</span></td><td style="text-align:left;white-space:normal">${esc(when)}</td><td style="text-align:left;white-space:normal">${esc(cg)}</td>${supCell}</tr>`;
}
const FLEET_HEAD = ['Судно', 'Где', 'Статус', 'С какого времени', 'Груз · отправитель', 'Топливо, т', 'Вода, т', 'Колпит, дн'];
const fleetTable = rows => `<table><thead><tr>${FLEET_HEAD.map((h, i) => `<th${i >= 1 && i <= 4 ? ' style="text-align:left"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;

function renderNow() {
  const S = CUR(); NOW = P(S.ts);
  const d = NOW; stampEl.textContent = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${S.ts.slice(11)}`;
  document.getElementById('d-pick').value = S.ts.slice(0, 10);
  const isLast = SI === SNAPS.length - 1;
  const hn = document.getElementById('histnote'); hn.hidden = isLast;
  if (!isLast) hn.textContent = `Показана архивная сводка на ${stampEl.textContent}. Последняя сводка — ${SNAPS[SNAPS.length - 1].ts.slice(8, 10)}.${SNAPS[SNAPS.length - 1].ts.slice(5, 7)}.${SNAPS[SNAPS.length - 1].ts.slice(0, 4)} ${SNAPS[SNAPS.length - 1].ts.slice(11)} — кнопка «Последняя».`;
  document.getElementById('wx').innerHTML = S.wx ? `<b>Погода</b><span>${esc(S.wx.replace(/^Прогноз\s+погоды\s*/i, ''))}</span>` : '';
  const items = flatItems(S);
  const supMap = {}; S.sup.forEach(r => { if (r.n) supMap[r.n] = { fuel: numS(r.fuel), water: numS(r.water), food: numS(r.food), oil: numS(r.oil), bw: r.bw, hfo: numS(r.hfo) }; });
  const findIt = v => { const hits = items.filter(x => x.n === v); return hits.find(x => x.sec !== 'departed') || hits[0]; };
  // ---- fleet KPIs + table
  const KM_CASP = new Set([...KM_T, ...KM_C, ...KM_B]);
  const km = items.filter(x => KM_CASP.has(x.n));
  const kmAtBerth = km.filter(x => x.sec === 'berth' && !x.open), kmRoads = km.filter(x => (x.sec === 'roads' || x.sec === 'approach') && !x.open), kmDep = km.filter(x => x.sec === 'departed' && !x.open);
  document.getElementById('now-kpis').innerHTML = kpiHtml([
    ['Суда КМТФ на Каспии в сводке', uniq(km), `из ${KM_CASP.size}: ${KM_T.length} танкеров, ${KM_C.length} контейнеровоза, ${KM_B.length} сухогруза`],
    ['У причала (Каспий)', uniq(kmAtBerth), [...new Set(kmAtBerth.map(x => x.n))].join(', ') || '—'],
    ['На рейде / подход', uniq(kmRoads), [...new Set(kmRoads.map(x => x.n))].join(', ') || '—'],
    ['Отошли за сутки', uniq(kmDep), [...new Set(kmDep.map(x => x.n))].join(', ') || '—'],
  ]);
  const groups = [['Танкеры', KM_T], ['Контейнеровозы', KM_C], ['Сухогрузы', KM_B]];
  document.getElementById('fleet').innerHTML = fleetTable(groups.map(([g, vs]) => `<tr><td class="wx-day" colspan="8">${g}</td></tr>` + vs.map(v => fleetRow(v, findIt(v), supMap)).join('')).join(''));
  // ---- ports (Caspian)
  const casp = S.ports.filter(p => p.g !== 'o' && !isOpenPort(p.p));
  document.getElementById('ports').innerHTML = casp.map(portCard).join('');
  const allShips = items.filter(x => x.sec !== 'departed' && !x.open);
  const freeB = casp.flatMap(p => (p.sec.berth || []).filter(b => !b.n && b.free)).length, closedB = casp.flatMap(p => (p.sec.berth || []).filter(b => !b.n && b.closed)).length;
  const tDep24 = casp.filter(p => p.g === 't').flatMap(p => p.sec.departed || []).filter(x => x.n), bDep24 = casp.filter(p => p.g === 'b').flatMap(p => p.sec.departed || []).filter(x => x.n);
  const tons = tDep24.reduce((a, x) => a + (parseFloat(x.c) || 0), 0);
  document.getElementById('ports-kpis').innerHTML = kpiHtml([
    ['Судов в портах Каспия', uniq(allShips), `${uniq(allShips.filter(x => x.seg === 't'))} танкеров · ${uniq(allShips.filter(x => x.seg === 'b'))} сухогрузов и контейнеровозов, все перевозчики`],
    ['Свободных причалов', freeB, closedB ? `ещё ${closedB} закрыто на ремонт` : 'по всем портам сводки'],
    ['Отгружено танкерами за сутки', fmtN(tons) + ' т', [...new Set(tDep24.map(x => x.n))].join(', ') || 'судозаходов не было'],
    ['Отошло сухогрузов за сутки', uniq(bDep24), [...new Set(bDep24.map(x => x.n))].join(', ') || '—'],
  ]);
  // ---- open seas
  const openPorts = S.ports.filter(p => (p.g === 'o' || isOpenPort(p.p)) && !/abu dhabi/i.test(p.p));
  document.getElementById('open-ports').innerHTML = openPorts.length ? openPorts.map(portCard).join('') : '<div class="empty">В этой сводке нет раздела «Открытые моря».</div>';
  document.getElementById('open-fleet').innerHTML = fleetTable(KM_A.map(v => fleetRow(v, findIt(v), supMap)).join(''));
  // ---- tugs
  const tugItems = items.filter(x => isTug(x.n));
  document.getElementById('tugs-now').innerHTML = fleetTable(KM_TUG.map(v => fleetRow(v, findIt(v) || tugItems.find(x => x.n.toLowerCase().includes(v.toLowerCase().replace('tug ', ''))), supMap)).join(''));
  renderTugHistory();
  // ---- supplies
  const sup = (rowsArr, el) => {
    if (!rowsArr.length) { document.getElementById(el).innerHTML = '<div class="empty">В этой сводке таблицы запасов нет.</div>'; return; }
    const maxF = Math.max(...rowsArr.map(r => numS(r.fuel) || 0), 1), maxW = Math.max(...rowsArr.map(r => numS(r.water) || 0), 1);
    document.getElementById(el).innerHTML = `<table><thead><tr><th>Судно</th><th>Диз. топливо, т</th><th>Вода, т</th><th>Колпит, дн</th><th>Масло, л</th><th>Бут. вода</th></tr></thead><tbody>` +
      rowsArr.map(r => { const f = numS(r.fuel), w = numS(r.water), d = numS(r.food); return `<tr><td>${esc(r.n)}</td><td class="bar"><span style="width:${Math.max(4, 100 * f / maxF)}px"></span><i class="${cl(f, [15, 30])}">${fmtN(f, 1)}</i></td><td class="bar"><span style="width:${Math.max(4, 100 * w / maxW)}px;background:var(--s3)"></span><i class="${cl(w, [10, 20])}">${fmtN(w, 0)}</i></td><td class="${cl(d, [3, 7])}">${fmtN(d)}</td><td>${fmtN(numS(r.oil))}</td><td>${esc(r.bw ?? '—')}</td></tr>`; }).join('') + '</tbody></table>';
  };
  const supT = S.sup.filter(r => KM_T.includes(r.n) || (!KM_C.includes(r.n) && !KM_B.includes(r.n) && !S.sup.some(q => q === r && false) && /Актау|Астана|Алматы|Лива|Тараз/.test(r.n)));
  const supB = S.sup.filter(r => !supT.includes(r));
  sup(supT, 'sup-t'); sup(supB, 'sup-b');
  const allSup = S.sup;
  const low = (k, lim) => allSup.filter(r => { const v = numS(r[k]); return !isNaN(v) && v <= lim; }).map(r => r.n);
  const lf = low('fuel', 30), lw = low('water', 20), lp = low('food', 7);
  const totF = allSup.reduce((a, r) => a + (numS(r.fuel) || 0), 0);
  document.getElementById('sup-kpis').innerHTML = kpiHtml([
    ['Судов в таблице запасов', allSup.length, `${supT.length} танкеров · ${supB.length} контейнеровозов и сухогрузов`],
    ['Дизтоплива на борту, всего', fmtN(totF, 1) + ' т', 'по всем судам КМТФ в таблице'],
    ['Мало топлива (≤ 30 т)', lf.length, lf.join(', ') || 'нет'],
    ['Мало воды (≤ 20 т)', lw.length, lw.join(', ') || 'нет'],
    ['Колпит ≤ 7 дней', lp.length, lp.join(', ') || 'нет'],
  ]);
}
const dmyY = s => { const d = P(s); return d ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}` : '—'; };
const placeOf = it => { const i = it.i && !/^(причал|якорь|рейд|подход|отход|дрейф)/i.test(it.i) ? it.i : it.port; return i.replace(/^порт[ы]?\s+/i, '').replace(/^п\.\s*/i, ''); };
function renderTugHistory() {
  const out = [];
  KM_TUG.forEach(v => {
    const key = v.toLowerCase().replace('tug ', '');
    let prev = null, rows = [], lastOp = '';
    SNAPS.forEach(S => {
      const it = flatItems(S).find(x => x.n.toLowerCase().includes(key));
      if (!it) return;
      const place = placeOf(it);
      const op = it ? ([it.z, it.o].filter(Boolean).join(' · ') || lastOp) : '';
      if (it && op) lastOp = op;
      const state = place + ' | ' + op;
      if (state !== prev) { rows.push({ from: S.ts, place, op, berth: it ? it.b : '' }); prev = state; }
      else if (it && !rows[rows.length - 1].berth && it.b) rows[rows.length - 1].berth = it.b;
    });
    rows.forEach((r, i) => { r.to = i + 1 < rows.length ? rows[i + 1].from : null; });
    out.push([v, rows.reverse()]);
  });
  document.getElementById('tugs-hist').innerHTML = out.map(([v, rows]) => `<h3 style="margin:10px 0 4px">${esc(v)}</h3>` + tblFold(['С', 'По', 'Дней', 'Где', 'Статус', 'Причал'], rows.map(r => [dmyY(r.from), r.to ? dmyY(r.to) : 'по последнюю сводку', fmtN(((r.to ? P(r.to) : P(SNAPS[SNAPS.length - 1].ts)) - P(r.from)) / 864e5), r.place === 'нет в сводки' || r.place === 'нет в сводке' ? '<span style="color:var(--ink-3)">нет в сводке</span>' : esc(r.place), esc(r.op), esc(r.berth || '')]), 8)).join('');
}
/* ---------- date controls ---------- */
function gotoSnap(i) { SI = Math.max(0, Math.min(SNAPS.length - 1, i)); renderNow(); }
document.getElementById('d-prev').onclick = () => gotoSnap(SI - 1);
document.getElementById('d-next').onclick = () => gotoSnap(SI + 1);
document.getElementById('d-last').onclick = () => gotoSnap(SNAPS.length - 1);
const dp = document.getElementById('d-pick'); dp.min = SNAPS[0].ts.slice(0, 10); dp.max = SNAPS[SNAPS.length - 1].ts.slice(0, 10);
dp.onchange = () => { const v = dp.value; if (!v) return; let best = -1; SNAPS.forEach((s, i) => { if (s.ts.slice(0, 10) <= v) best = i; }); if (best < 0) best = 0; const same = SNAPS.findIndex(s => s.ts.slice(0, 10) === v); gotoSnap(same >= 0 ? SNAPS.map(s => s.ts.slice(0, 10)).lastIndexOf(v) : best); };

const SNAP = { timestamp: SNAPS[SNAPS.length - 1].ts, weather: SNAPS[SNAPS.length - 1].wx, file: SNAPS[SNAPS.length - 1].f };
/* ---------- WEATHER ---------- */
const WXD = D.weather; let wxPt = 0, wxLoaded = false;
const RUMB = ['С', 'ССВ', 'СВ', 'ВСВ', 'В', 'ВЮВ', 'ЮВ', 'ЮЮВ', 'Ю', 'ЮЮЗ', 'ЮЗ', 'ЗЮЗ', 'З', 'ЗСЗ', 'СЗ', 'ССЗ'];
const rumb = d => d == null ? '' : RUMB[Math.round(d / 22.5) % 16];
const arrow = d => d == null ? '' : `<span style="display:inline-block;transform:rotate(${(d + 180) % 360}deg)" title="${rumb(d)}">↑</span>`;
const windCls = v => v == null ? '' : v >= 15 ? 'crit' : v >= 10 ? 'warn' : 'ok';
const waveCls = v => v == null ? '' : v >= 2 ? 'crit' : v >= 1.25 ? 'warn' : 'ok';
const ROUTES = [['Актау → Алят / Баку', [0, 1, 2]], ['Актау → Махачкала', [0, 3, 4]]];
const wxT = s => { const d = P(s.replace('T', ' ')); return d; };
const hhmm = s => s.slice(11, 16), ddmm = s => s.slice(8, 10) + '.' + s.slice(5, 7);
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function windyUrl(p, ov = 'wind') { return `https://www.windy.com/?${ov},${p.lat},${p.lon},7`; }
function renderWx() {
  wxLoaded = true;
  document.getElementById('wx2').innerHTML = SNAP.weather ? `<b>Диспетчер</b><span>${esc(SNAP.weather.replace(/^Прогноз\s+погоды\s*/i, ''))}</span>` : '';
  if (!WXD || !WXD.points || !WXD.points.length) {
    document.getElementById('wx-routes').innerHTML = '';
    document.getElementById('wx-sub').textContent = 'Файл прогноза weather.json ещё не создан — запусти ОБНОВИТЬ_погоду.bat в папке Дислокация, при следующей сборке прогноз появится здесь.';
    document.getElementById('wx-pt').innerHTML = ROUTES.map(r => `<a href="https://www.windy.com/?wind,42.3,50.0,6" target="_blank" rel="noopener" style="padding:6px 12px">${r[0]} на Windy ↗</a>`).join('');
    return;
  }
  const pts = WXD.points, now = new Date();
  const idxFrom = p => { let i = p.time.findIndex(t => wxT(t) >= now); return i < 0 ? 0 : Math.max(0, i - 1); };
  // route summary
  const horizon = (p, h) => { const i0 = idxFrom(p); return { i0, i1: Math.min(p.time.length, i0 + Math.ceil(h / (WXD.step_hours || 3)) + 1) }; };
  const worst = (idxs, key, h) => { let best = null; idxs.forEach(k => { const p = pts[k]; const { i0, i1 } = horizon(p, h); for (let i = i0; i < i1; i++) { const v = p[key] && p[key][i]; if (v != null && (!best || v > best.v)) best = { v, p, t: p.time[i] }; } }); return best; };
  document.getElementById('wx-routes').innerHTML = ROUTES.map(([name, idxs]) => {
    const w24 = worst(idxs, 'wind', 24), g24 = worst(idxs, 'gust', 24), h24 = worst(idxs, 'wave', 24), w48 = worst(idxs, 'wind', 48), h48 = worst(idxs, 'wave', 48);
    const cls = [windCls(w24?.v), waveCls(h24?.v)].includes('crit') ? 'crit' : [windCls(w24?.v), waveCls(h24?.v)].includes('warn') ? 'warn' : 'ok';
    const lbl = { ok: 'спокойно', warn: 'внимание', crit: 'шторм' }[cls];
    return `<div class="kpi" style="grid-column:span 2"><div class="l">${name} · ближайшие 24 ч <span class="st ${cls}">${lbl}</span></div>
      <div class="v" style="font-size:22px">ветер до ${fmtN(w24?.v, 1)} м/с · порывы ${fmtN(g24?.v, 0)} · волна до ${fmtN(h24?.v, 1)} м</div>
      <div class="s">${w24 ? `макс. ветер: ${esc(w24.p.name)}, ${ddmm(w24.t)} ${hhmm(w24.t)}` : ''}${h24 ? ` · макс. волна: ${esc(h24.p.name)}, ${ddmm(h24.t)} ${hhmm(h24.t)}` : ''}<br>48 ч: ветер до ${fmtN(w48?.v, 1)} м/с, волна до ${fmtN(h48?.v, 1)} м</div></div>`;
  }).join('');
  // point selector
  const sel = document.getElementById('wx-pt');
  sel.innerHTML = pts.map((p, i) => `<button aria-pressed="${i === wxPt}" data-i="${i}">${esc(p.name)}</button>`).join('');
  sel.querySelectorAll('button').forEach(b => b.onclick = () => { wxPt = +b.dataset.i; renderWx(); });
  const p = pts[wxPt];
  document.getElementById('wx-open').href = windyUrl(p);
  const f = WXD.fetched ? new Date(WXD.fetched) : null;
  document.getElementById('wx-sub').textContent = `${p.name} (${p.lat}, ${p.lon}) · шаг ${WXD.step_hours || 3} ч, время местное Актау · прогноз получен ${f ? f.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}`;
  const g = chartBase(), C = COLS();
  const i0 = idxFrom(p), labels = p.time.slice(i0).map(t => (hhmm(t) === '00:00' ? DOW[wxT(t).getDay()] + ' ' + ddmm(t) + ' ' : '') + hhmm(t));
  legend('wxc1-leg', [['Ветер', C[0]], ['Порывы', C[1]]]);
  mk('wxc1', { type: 'line', data: { labels, datasets: [{ label: 'Ветер', data: p.wind.slice(i0), borderColor: C[0], backgroundColor: C[0] + '22', fill: true, borderWidth: 2, pointRadius: 2, tension: .3 }, { label: 'Порывы', data: p.gust.slice(i0), borderColor: C[1], backgroundColor: C[1], borderWidth: 2, borderDash: [4, 3], pointRadius: 0, tension: .3 }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} м/с` } } }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { grid: g.grid, border: { display: false }, beginAtZero: true, suggestedMax: 16 } } } });
  legend('wxc2-leg', [['Высота волны', C[2]]]);
  mk('wxc2', { type: 'line', data: { labels, datasets: [{ label: 'Волна', data: (p.wave || []).slice(i0), borderColor: C[2], backgroundColor: C[2] + '22', fill: true, borderWidth: 2, pointRadius: 2, tension: .3 }] },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `Волна: ${fmtN(c.parsed.y, 2)} м` } } }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { grid: g.grid, border: { display: false }, beginAtZero: true, suggestedMax: 3 } } } });
  // table
  let rows = '', lastDay = '';
  for (let i = i0; i < p.time.length; i++) {
    const t = p.time[i], day = t.slice(0, 10);
    if (day !== lastDay) { rows += `<tr><td class="wx-day" colspan="8">${DOW[wxT(t).getDay()]}, ${ddmm(t)}</td></tr>`; lastDay = day; }
    const w = p.wind[i], gu = p.gust[i], wv = p.wave ? p.wave[i] : null;
    rows += `<tr><td>${hhmm(t)}</td><td class="c-${windCls(w)}">${fmtN(w, 1)}</td><td class="c-${windCls(gu)}">${fmtN(gu, 0)}</td><td>${arrow(p.wdir[i])} ${rumb(p.wdir[i])}</td><td class="c-${waveCls(wv)}">${wv == null ? '—' : fmtN(wv, 1)}</td><td>${p.period ? fmtN(p.period[i], 0) + ' с · ' + rumb(p.wavedir[i]) : '—'}</td><td>${p.vis ? (p.vis[i] >= 20000 ? '> 20' : fmtN(p.vis[i] / 1000, 1)) : '—'}</td><td>${p.temp ? fmtN(p.temp[i], 0) + '°' : ''}${p.rain && p.rain[i] > 0 ? ' · ' + fmtN(p.rain[i], 1) + ' мм' : ''}</td></tr>`;
  }
  document.getElementById('wx-table').innerHTML = `<table><thead><tr><th>Время</th><th>Ветер, м/с</th><th>Порывы</th><th>Откуда</th><th>Волна, м</th><th>Период · откуда</th><th>Видимость, км</th><th>t° · осадки</th></tr></thead><tbody>${rows}</tbody></table>`;
  document.getElementById('wx-note').textContent = `Источник: ${WXD.source || 'Open-Meteo'}; направление — откуда дует / откуда идёт волна. Подсветка: ветер ≥ 10 м/с и волна ≥ 1,25 м — жёлтым, ветер ≥ 15 м/с и волна ≥ 2 м — красным. Прогноз модельный, для решений по выходу в рейс сверяйся со штормовым предупреждением диспетчера.`;
}


/* ---------- VOLUMES ---------- */
const ASCO = new Set(D.kmtf.asco || []);
const carrier = v => KM.has(v) ? 'КМТФ' : ASCO.has(v) ? 'АСКО' : 'Прочие';
const OWN = D.kmtf.owners || {};
const ownerOf = v => KM.has(v) ? 'КМТФ' : ASCO.has(v) ? 'АСКО' : (OWN[v] ? OWN[v].owner : 'не установлен');
const routeOf = s => { const x = (s || '').toUpperCase().replace(/\s+/g, ''); if (/[-]?Б$/.test(x) && x.length > 1) return 'Баку'; if (/[-]?М$/.test(x) && x.length > 1) return 'Махачкала'; return 'не указан'; };
const cntQty = s => { if (!s) return 0; const m = /(\d[\d\s]*)\s*шт/i.exec(s); if (m) return +m[1].replace(/\s/g, ''); return 0; };
const isCont = k => (k || '').startsWith('контейнер');
const volYears = [...new Set(TANK.map(r => r.dep.slice(0, 4)))].sort();
const vy = document.getElementById('vol-year'), vy2 = document.getElementById('vol-year2'); volYears.forEach(y => { vy.add(new Option(y, y)); vy2.add(new Option(y, y)); }); vy.value = vy2.value = volYears[volYears.length - 1]; vy.onchange = () => { vy2.value = vy.value; renderVol(); }; vy2.onchange = () => { vy.value = vy2.value; renderVol(); };
const CARR = ['КМТФ', 'АСКО', 'Прочие'];
function renderVol() {
  const Y = vy.value, g = chartBase(), C = COLS(), thisM = SNAP.timestamp.slice(0, 7), curYear = Y === thisM.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${Y}-${String(i + 1).padStart(2, '0')}`).filter(m => m <= thisM || !curYear);
  const T = TANK.filter(r => r.dep.startsWith(Y)).map(r => ({ ...r, m: r.dep.slice(0, 7), route: routeOf(r.shpr), car: carrier(r.vessel), t: r.cargo || 0 }));
  const sum = a => a.reduce((s, r) => s + r.t, 0);
  const by = (arr, m, f) => sum(arr.filter(r => (!m || r.m === m) && (!f || f(r))));
  const mLabel = m => MON[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
  const monthName = m => ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][+m.slice(5, 7) - 1];
  const kp = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:24px">${v}</div><div class="s">${s || ''}</div></div>`;
  const lastM = curYear ? thisM : months[months.length - 1];
  const mTot = by(T, lastM), yTot = sum(T);
  const oilKpi = (label, arr, m) => {
    const tot = by(arr, m), b = by(arr, m, r => r.route === 'Баку'), mk_ = by(arr, m, r => r.route === 'Махачкала'), unk = by(arr, m, r => r.route === 'не указан');
    const bk = by(arr, m, r => r.route === 'Баку' && r.car === 'КМТФ'), ba = by(arr, m, r => r.route === 'Баку' && r.car === 'АСКО'), bo = b - bk - ba;
    const mkk = by(arr, m, r => r.route === 'Махачкала' && r.car === 'КМТФ'), mko = mk_ - mkk;
    return kp(label + ' · всего', fmtN(tot / 1000, 1) + ' тыс. т', `${arr.filter(r => !m || r.m === m).length} судозаходов${unk ? ' · маршрут не указан: ' + fmtN(unk / 1000, 1) + ' тыс. т' : ''}`) +
      kp(label + ' · Баку', fmtN(b / 1000, 1) + ' тыс. т', `КМТФ ${fmtN(bk / 1000, 1)} · АСКО ${fmtN(ba / 1000, 1)}${bo > 0 ? ' · прочие ' + fmtN(bo / 1000, 1) : ''}`) +
      kp(label + ' · Махачкала', fmtN(mk_ / 1000, 1) + ' тыс. т', `КМТФ ${fmtN(mkk / 1000, 1)}${mko > 0 ? ' · прочие ' + fmtN(mko / 1000, 1) : ''}`);
  };
  document.getElementById('vol-oil-kpis').innerHTML = oilKpi((curYear ? 'Этот месяц (' + monthName(lastM) + ')' : monthName(lastM)), T, lastM) + oilKpi(Y + (curYear ? ' с начала года' : ' год'), T, null);
  // chart 1: monthly by route
  legend('volc1-leg', [['Баку', C[0]], ['Махачкала', C[1]], ['Не указан', css('--ink-3')]]);
  document.getElementById('volc1-sub').textContent = Y + ', тыс. тонн по месяцу отхода';
  mk('volc1', { type: 'bar', data: { labels: months.map(mLabel), datasets: [['Баку', C[0]], ['Махачкала', C[1]], ['не указан', css('--ink-3')]].map(([r, c]) => ({ label: r === 'не указан' ? 'Не указан' : r, data: months.map(m => by(T, m, x => x.route === r) / 1000), backgroundColor: c, borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} тыс. т` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
  legend('volc2-leg', CARR.map((c, i) => [c, [C[0], C[1], css('--ink-3')][i]]));
  document.getElementById('volc2-sub').textContent = Y + ', только маршрут на Баку/Сангачал';
  mk('volc2', { type: 'bar', data: { labels: months.map(mLabel), datasets: CARR.map((cr, i) => ({ label: cr, data: months.map(m => by(T, m, x => x.route === 'Баку' && x.car === cr) / 1000), backgroundColor: [C[0], C[1], css('--ink-3')][i], borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} тыс. т` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
  legend('volc5-leg', CARR.map((c, i) => [c, [C[0], C[1], css('--ink-3')][i]]));
  document.getElementById('volc5-sub').textContent = Y + ', только маршрут на Махачкалу';
  mk('volc5', { type: 'bar', data: { labels: months.map(mLabel), datasets: CARR.map((cr, i) => ({ label: cr, data: months.map(m => by(T, m, x => x.route === 'Махачкала' && x.car === cr) / 1000), backgroundColor: [C[0], C[1], css('--ink-3')][i], borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} тыс. т` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
  // table oil
  const cols = [['Всего', r => true], ['Баку всего', r => r.route === 'Баку'], ['Баку КМТФ', r => r.route === 'Баку' && r.car === 'КМТФ'], ['Баку АСКО', r => r.route === 'Баку' && r.car === 'АСКО'], ['Баку прочие', r => r.route === 'Баку' && r.car === 'Прочие'], ['Махачкала всего', r => r.route === 'Махачкала'], ['Махачкала КМТФ', r => r.route === 'Махачкала' && r.car === 'КМТФ'], ['Махачкала прочие', r => r.route === 'Махачкала' && r.car !== 'КМТФ'], ['Не указан', r => r.route === 'не указан'], ['Судозаходов', null]];
  const rowsT = months.map(m => [mLabel(m), ...cols.map(([n, f]) => f ? fmtN(by(T, m, f)) : fmtN(T.filter(r => r.m === m).length))]);
  rowsT.push([`<b>Итого ${Y}</b>`, ...cols.map(([n, f]) => `<b>${f ? fmtN(by(T, null, f)) : fmtN(T.length)}</b>`)]);
  document.getElementById('volt1-sub').textContent = `Тонны по месяцу отхода. Записи без указанного количества груза: ${T.filter(r => !r.cargo).length}.`;
  document.getElementById('volt1').innerHTML = tbl(['Месяц', ...cols.map(c => c[0])], rowsT);
  // containers
  const B = BULK.filter(r => r.dep.startsWith(Y) && (isCont(r.in_kind) || isCont(r.out_kind))).map(r => ({ ...r, m: r.dep.slice(0, 7), car: carrier(r.vessel), qin: isCont(r.in_kind) ? cntQty(r.in_qty_raw) : 0, qout: isCont(r.out_kind) ? cntQty(r.out_qty_raw) : 0, tin: r.in_teu || 0, tout: r.out_teu || 0 }));
  const bs = (m, f, k) => B.filter(r => (!m || r.m === m) && (!f || f(r))).reduce((s, r) => s + r[k], 0);
  const DIRS = [['Актау → Баку', 'qout'], ['Баку → Актау', 'qin']];
  const cKpi = (label, m) => CARR.map(cr => kp(`${label} · ${cr}`, fmtN(bs(m, r => r.car === cr, 'qin') + bs(m, r => r.car === cr, 'qout')) + ' шт', `Актау → Баку ${fmtN(bs(m, r => r.car === cr, 'qout'))} · Баку → Актау ${fmtN(bs(m, r => r.car === cr, 'qin'))} · ${B.filter(r => (!m || r.m === m) && r.car === cr).length} судозаходов${bs(m, r => r.car === cr, 'tin') + bs(m, r => r.car === cr, 'tout') ? ' · ДФЭ ' + fmtN(bs(m, r => r.car === cr, 'tin') + bs(m, r => r.car === cr, 'tout')) : ''}`)).join('');
  document.getElementById('vol-cnt-kpis').innerHTML = cKpi(curYear ? 'Этот месяц' : monthName(lastM), lastM) + cKpi(Y + (curYear ? ' с начала года' : ''), null);
  for (const [cid, key] of [['volc3', 'qout'], ['volc4', 'qin']]) {
    legend(cid + '-leg', CARR.map((c, i) => [c, [C[0], C[1], css('--ink-3')][i]]));
    mk(cid, { type: 'bar', data: { labels: months.map(mLabel), datasets: CARR.map((cr, i) => ({ label: cr, data: months.map(m => bs(m, r => r.car === cr, key)), backgroundColor: [C[0], C[1], css('--ink-3')][i], borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y)} шт` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
  }
  const rowsC = months.map(m => [mLabel(m), ...DIRS.flatMap(([dn, k]) => [...CARR.map(cr => fmtN(bs(m, r => r.car === cr, k))), `<b>${fmtN(bs(m, null, k))}</b>`]), `<b>${fmtN(bs(m, null, 'qin') + bs(m, null, 'qout'))}</b>`, fmtN(bs(m, r => r.car === 'КМТФ', 'tin') + bs(m, r => r.car === 'КМТФ', 'tout'))]);
  rowsC.push([`<b>Итого</b>`, ...DIRS.flatMap(([dn, k]) => [...CARR.map(cr => `<b>${fmtN(bs(null, r => r.car === cr, k))}</b>`), `<b>${fmtN(bs(null, null, k))}</b>`]), `<b>${fmtN(bs(null, null, 'qin') + bs(null, null, 'qout'))}</b>`, `<b>${fmtN(bs(null, r => r.car === 'КМТФ', 'tin') + bs(null, r => r.car === 'КМТФ', 'tout'))}</b>`]);
  document.getElementById('volt2').innerHTML = tbl(['Месяц', ...DIRS.flatMap(([dn]) => [...CARR.map(cr => `${dn}<br>${cr}`), `${dn}<br>всего`]), 'Всего, шт', 'КМТФ, ДФЭ'], rowsC);
  // other owners table
  const oth = {}; T.filter(r => r.car === 'Прочие').forEach(r => { const o = oth[r.vessel] = oth[r.vessel] || { n: 0, t: 0, b: 0, m: 0 }; o.n++; o.t += r.t; if (r.route === 'Баку') o.b += r.t; if (r.route === 'Махачкала') o.m += r.t; });
  document.getElementById('volt3-sub').textContent = `Танкеры в журнале ${Y}, не относящиеся ни к КМТФ, ни к АСКО. Владелец — по открытым источникам.`;
  document.getElementById('volt3').innerHTML = tbl(['Судно', 'Владелец', 'Справка', 'Судозаходов', 'Тонн', 'на Баку', 'на Махачкалу'], Object.entries(oth).sort((a, b) => b[1].t - a[1].t).map(([v, o]) => [esc(v), esc(ownerOf(v)), esc(OWN[v] ? OWN[v].note : ''), fmtN(o.n), fmtN(o.t), fmtN(o.b), fmtN(o.m)]));
  // gaps
  const allM = {}; TANK.forEach(r => { const m = r.dep.slice(0, 7); allM[m] = allM[m] || { t: 0, b: 0, tc: 0 }; allM[m].t++; if (!r.cargo) allM[m].tc++; }); BULK.forEach(r => { const m = r.dep.slice(0, 7); allM[m] = allM[m] || { t: 0, b: 0, tc: 0 }; allM[m].b++; });
  const ms = Object.keys(allM).sort(), first = ms[0], last = ms[ms.length - 1];
  const medT = med(ms.slice(0, -1).map(m => allM[m].t)), medB = med(ms.slice(0, -1).map(m => allM[m].b));
  const lowT = ms.slice(0, -1).filter(m => allM[m].t < medT * 0.6), lowB = ms.slice(0, -1).filter(m => allM[m].b < medB * 0.6);
  const missing = []; for (let y = +first.slice(0, 4); y <= +last.slice(0, 4); y++) for (let i = 1; i <= 12; i++) { const m = `${y}-${String(i).padStart(2, '0')}`; if (m >= first && m <= last && !allM[m]) missing.push(m); }
  const noRoute = TANK.filter(r => r.dep.startsWith(Y) && routeOf(r.shpr) === 'не указан').length, noCargo = TANK.filter(r => r.dep.startsWith(Y) && !r.cargo).length;
  const unkCar = [...new Set(TANK.filter(r => r.dep.startsWith(Y) && carrier(r.vessel) === 'Прочие' && r.cargo).map(r => r.vessel))];
  const ycov = {}; TANK.forEach(r => { const y = r.dep.slice(0, 4); ycov[y] = ycov[y] || new Set(); ycov[y].add(r.dep.slice(5, 7)); });
  document.getElementById('vol-gaps').innerHTML = `
    <p style="margin:0 0 8px"><b>Журнал рейсов</b> покрывает <b>${mLabel(first)} — ${last.slice(8, 10) ? '' : ''}${dmy(TANK[TANK.length - 1].dep)}</b> без пропущенных месяцев${missing.length ? ' — кроме: ' + missing.map(mLabel).join(', ') : ''}. Полные календарные годы: ${Object.entries(ycov).filter(([y, s]) => s.size === 12).map(x => x[0]).join(', ') || '—'}; ${Y} — ${ycov[Y] ? ycov[Y].size : 0} мес.</p>
    <p style="margin:0 0 8px"><b>Подозрительно мало записей</b> (меньше 60 % от медианы): танкеры — ${lowT.length ? lowT.map(m => `${mLabel(m)} (${allM[m].t})`).join(', ') : 'нет'}; сухогрузы — ${lowB.length ? lowB.map(m => `${mLabel(m)} (${allM[m].b})`).join(', ') : 'нет'}. Медиана: ${fmtN(medT)} судозаходов танкеров и ${fmtN(medB)} сухогрузов в месяц. Эти месяцы одинаковы во всех исходных файлах — вероятно, так и было, но стоит сверить с отчётностью.</p>
    <p style="margin:0 0 8px"><b>В ${Y}:</b> у ${noRoute} судозаходов танкеров не указан грузоотправитель (маршрут неизвестен); у ${noCargo} нет количества груза (в тоннах не учтены). Суда с грузом, не отнесённые ни к КМТФ, ни к АСКО (считаются «прочие»): ${unkCar.length ? unkCar.map(v => `${v} — ${ownerOf(v)}`).join('; ') : '—'}.</p>
    <p style="margin:0"><b>Сами файлы сводок</b> (снимки 3 раза в день) есть с сентября 2023; в почте нет периода май 2025 — март 2026. На объёмы это не влияет — они берутся из накопительных листов «Статистика», которые есть в каждом файле. ДФЭ по контейнерам диспетчер указывает только по судам КМТФ, по АСКО и прочим — только штуки.</p>`;
  const so = subOf('oil'), sc = subOf('cnt');
  const note = document.getElementById('oil-note');
  if (so === 'bl') renderOilBL(Y);
  else if (so === 'mr') { renderMR('oil', Y, { kpis: 'mr-oil-kpis', c1: 'mroc1', c2: 'mroc2', t1: 'mrot1', t2: 'mrot2' }); note.textContent = 'МР-отчёт для руководства: объёмы считаются по документам на оплату (бухгалтерский учёт), поэтому отличаются и от коносаментов, и от сводок диспетчера. Помесячные значения получены как разность накопительных отчётов.'; }
  else note.textContent = 'Тонны по дате отхода из Актау (сводки диспетчера); маршрут по индексу грузоотправителя (-Б Баку/Сангачал, -М Махачкала). Перевозчик — по судну: КМТФ, АСКО, прочие.';
  const cnote = document.querySelector('#p-cnt .filters .note');
  if (sc === 'mr') { renderMR('cnt', Y, { kpis: 'mr-cnt-kpis', c1: 'mrcc1', c2: 'mrcc2', t1: 'mrct1', t2: 'mrct2' }); cnote.textContent = 'МР-отчёт для руководства: TEU по документам на оплату (бухгалтерский учёт), по направлениям и судам. Помесячные значения — разность накопительных отчётов.'; }
  else cnote.textContent = 'Контейнеры — штуки по сводке диспетчера. Направление: Актау → Баку — погружено в Актау, Баку → Актау — выгружено в Актау (порт отправления/назначения в сводке не указывается, линия Актау–Баку). ДФЭ — где указаны (в основном по судам КМТФ). Перевозчик — по судну.';
}

/* ---------- HISTORY ---------- */

const S = { seg: 'tank', fleet: 'all', y0: null, y1: null, vessel: '', shpr: '', agg: 'avg' };
const cen = a => S.agg === 'avg' ? avg(a) : med(a); const MED = a => med(a), AVG = a => avg(a);          // центральная мера для часов: среднее / медиана
const CENL = () => S.agg === 'avg' ? 'среднее' : 'медиана';
const CENP = () => S.agg === 'avg' ? 'средние' : 'медианы';
const years = [...new Set([...TANK.map(r => r.dep.slice(0, 4)), ...BULK.map(r => r.dep.slice(0, 4))])].sort();
const y0 = document.getElementById('y0'), y1 = document.getElementById('y1');
years.forEach(y => { y0.add(new Option(y, y)); y1.add(new Option(y, y)); });
y0.value = years[years.length - 1]; y1.value = years[years.length - 1]; S.y0 = y0.value; S.y1 = y1.value;
y0.onchange = () => { S.y0 = y0.value; if (S.y1 < S.y0) { y1.value = S.y0; S.y1 = S.y0; } renderHist(); };
y1.onchange = () => { S.y1 = y1.value; if (S.y1 < S.y0) { y0.value = S.y1; S.y0 = S.y1; } renderHist(); };
document.getElementById('vsel').onchange = e => { S.vessel = e.target.value; renderHist(); };
document.getElementById('ssel').onchange = e => { S.shpr = e.target.value; renderHist(); };
for (const id of ['seg', 'fleetsel', 'aggsel']) document.getElementById(id).querySelectorAll('button').forEach(b => b.onclick = () => {
  document.getElementById(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); S[id === 'fleetsel' ? 'fleet' : id === 'aggsel' ? 'agg' : id] = b.dataset.v; if (id === 'seg') { S.vessel = ''; S.shpr = ''; } fillSelects(); renderHist();
});
function base() { return S.seg === 'tank' ? TANK : S.seg === 'bulk' ? BULK : BUNK; }
function dateOf(r) { return r.dep || r.b_start || r.arr; }
function fillSelects() {
  const vs = document.getElementById('vsel'); vs.innerHTML = '<option value="">Все суда</option>';
  const cnt = {}; base().forEach(r => cnt[r.vessel] = (cnt[r.vessel] || 0) + 1);
  Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => vs.add(new Option(`${v} (${n})`, v)));
  const sf = document.getElementById('shpr-f'); sf.style.display = S.seg === 'tank' ? '' : 'none';
  const ss = document.getElementById('ssel'); ss.innerHTML = '<option value="">Все</option>';
  if (S.seg === 'tank') { const c = {}; TANK.forEach(r => { if (r.shpr) c[r.shpr] = (c[r.shpr] || 0) + 1; }); Object.entries(c).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => ss.add(new Option(`${v} (${n})`, v))); }
}
fillSelects();
function filtered() {
  return base().filter(r => { const y = dateOf(r).slice(0, 4); return y >= S.y0 && y <= S.y1 && (S.fleet === 'all' || KM.has(r.vessel)) && (!S.vessel || r.vessel === S.vessel) && (!S.shpr || r.shpr === S.shpr); });
}
const charts = {};
// Подписи данных на всех графиках: значения сегментов (если сегмент достаточно высокий), итог над стопкой, значения у точек линий.
const dlFmt = v => v == null || isNaN(v) ? '' : fmtN(v, Math.abs(v) < 10 && v !== Math.round(v) ? 1 : 0);
const DATALABELS = {
  id: 'datalabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart, horiz = chart.options.indexAxis === 'y';
    ctx.save(); ctx.font = '600 10.5px "IBM Plex Sans",system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const inkTop = css('--ink'), inkIn = '#fff';
    const totals = {}; let stacked = false;
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di); if (meta.hidden || !chart.isDatasetVisible(di)) return;
      const isBar = meta.type === 'bar', st = isBar && chart.options.scales && chart.options.scales.y && chart.options.scales.y.stacked;
      if (st) stacked = true;
      meta.data.forEach((el, i) => {
        const v = ds.data[i]; if (v == null || isNaN(v) || v === 0) return;
        if (isBar) {
          if (st) { totals[i] = (totals[i] || 0) + v; }
          const p = el.getProps(['x', 'y', 'base', 'width', 'height'], true);
          if (horiz) { ctx.fillStyle = inkTop; ctx.textAlign = 'left'; ctx.fillText(dlFmt(v), Math.max(p.x, p.base) + 4, p.y); ctx.textAlign = 'center'; }
          else if (st) { const h = Math.abs(p.base - p.y); if (h >= 14 && p.width >= 22) { ctx.fillStyle = inkIn; ctx.fillText(dlFmt(v), p.x, (p.y + p.base) / 2); } }
          else { ctx.fillStyle = inkTop; ctx.fillText(dlFmt(v), p.x, p.y - 7); }
        } else { const p = el.getProps(['x', 'y'], true); ctx.fillStyle = ds.borderColor || inkTop; ctx.fillText(dlFmt(v), p.x, p.y - 9); }
      });
    });
    if (stacked && !horiz) {
      ctx.fillStyle = inkTop;
      Object.entries(totals).forEach(([i, t]) => {
        let top = null, x = null;
        chart.data.datasets.forEach((ds, di) => { const m = chart.getDatasetMeta(di); if (!chart.isDatasetVisible(di) || !m.data[i]) return; const p = m.data[i].getProps(['x', 'y'], true); if (ds.data[i]) { if (top == null || p.y < top) top = p.y; x = p.x; } });
        if (top != null) ctx.fillText(dlFmt(t), x, top - 7);
      });
    }
    ctx.restore();
  }
};
function mk(id, cfg) { if (charts[id]) charts[id].destroy(); const c = document.getElementById(id); cfg.plugins = [...(cfg.plugins || []), DATALABELS]; const ly = cfg.options && cfg.options.scales && cfg.options.scales.y; if (ly && !cfg.options.indexAxis) { ly.grace = ly.grace || '8%'; } charts[id] = new Chart(c, cfg); }
function chartBase() {
  Chart.defaults.font.family = '"IBM Plex Sans",system-ui,sans-serif'; Chart.defaults.font.size = 12; Chart.defaults.color = css('--ink-2');
  return { grid: { color: css('--line-2') }, border: { color: css('--line') } };
}
const ttf = (label, unit, d = 0) => ({ callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y ?? c.parsed.x, d)} ${unit}` } });
const avg = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const med = a => { const v = a.filter(x => x != null).sort((p, q) => p - q); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const monthKeys = (rs) => { const ks = [...new Set(rs.map(r => dateOf(r).slice(0, 7)))].sort(); return ks; };
const mlab = k => `${MON[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}`;
const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s || ''}</div></div>`;
const tbl = (head, body) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map((c, i) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const tblFold = (head, body, n = 20) => body.length <= n ? tbl(head, body) : `<div class="fold">${tbl(head, body.slice(0, n))}<div class="more">${tbl(head, body.slice(n))}</div><button class="morebtn" onclick="this.parentNode.classList.toggle('open');this.textContent=this.parentNode.classList.contains('open')?'Свернуть':'Показать все (${body.length})'">Показать все (${body.length})</button></div>`;
const legend = (el, items) => document.getElementById(el).innerHTML = items.map(([n, c]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('');
const COLS = () => [css('--s1'), css('--s2'), css('--s3'), css('--s4'), css('--s5')];


/* ---------- EXPLORER (показатель в разрезе) ---------- */
const EX = { m: null, d: 'm', a: null, c: 'bar' };
const EX_METRICS = {
  tank: [['n', 'Судозаходов, шт', 'sum'], ['cargo', 'Груз, т', 'sum'], ['draft', 'Осадка, м', 'avg'], ['hR', 'Ожидание на рейде, ч', 'med'], ['hB', 'У причала (постановка → отход), ч', 'med'], ['hL', 'Чистая погрузка, ч', 'med'], ['hT', 'Оборот в порту (рейд → отход), ч', 'med'], ['hW', 'Постановка → начало погрузки, ч', 'med'], ['hE', 'Окончание погрузки → отход, ч', 'med'], ['rate', 'Темп погрузки, т/ч', 'med']],
  bulk: [['n', 'Судозаходов, шт', 'sum'], ['in_teu', 'ДФЭ выгружено', 'sum'], ['out_teu', 'ДФЭ погружено', 'sum'], ['qin', 'Контейнеров выгружено, шт', 'sum'], ['qout', 'Контейнеров погружено, шт', 'sum'], ['hR', 'Ожидание на рейде, ч', 'med'], ['hB', 'У причала, ч', 'med'], ['hU', 'Выгрузка, ч', 'med'], ['hLd', 'Погрузка, ч', 'med'], ['hT', 'Оборот в порту, ч', 'med']],
  bunk: [['n', 'Бункеровок, шт', 'sum'], ['dt', 'Дизтопливо, т', 'sum'], ['tt', 'Тяжёлое топливо, т', 'sum'], ['h', 'Длительность бункеровки, ч', 'med'], ['hW', 'Ожидание до бункеровки, ч', 'med']],
};
const EX_DIMS = {
  tank: [['m', 'Месяц'], ['y', 'Год'], ['vessel', 'Судно'], ['car', 'Перевозчик'], ['shpr', 'Грузоотправитель'], ['route', 'Маршрут'], ['terminal', 'Терминал'], ['berth', 'Причал'], ['dow', 'День недели отхода'], ['q', 'Квартал']],
  bulk: [['m', 'Месяц'], ['y', 'Год'], ['vessel', 'Судно'], ['car', 'Перевозчик'], ['berth', 'Причал'], ['kind', 'Груз на выход'], ['kindin', 'Груз на вход'], ['dow', 'День недели отхода'], ['q', 'Квартал']],
  bunk: [['m', 'Месяц'], ['y', 'Год'], ['vessel', 'Судно'], ['port', 'Место'], ['car', 'Перевозчик'], ['q', 'Квартал']],
};
const DOWN = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function exEnrich(r) {
  const o = { ...r, n: 1 };
  if (S.seg === 'tank') { o.hR = hrs(r.arr, r.berth_at); o.hB = hrs(r.berth_at, r.dep); o.hL = hrs(r.load_start, r.load_end); o.hT = hrs(r.arr, r.dep); o.hW = hrs(r.berth_at, r.load_start); o.hE = hrs(r.load_end, r.dep); o.rate = o.hL && r.cargo ? r.cargo / o.hL : null; o.route = routeOf(r.shpr); o.car = carrier(r.vessel); o.shpr = r.shpr || '—'; o.terminal = r.terminal || '—'; }
  else if (S.seg === 'bulk') { o.hR = hrs(r.arr, r.berth_at); o.hB = hrs(r.berth_at, r.dep); o.hU = hrs(r.unload_start, r.unload_end); o.hLd = hrs(r.load_start, r.load_end); o.hT = hrs(r.arr, r.dep); o.qin = isCont(r.in_kind) ? cntQty(r.in_qty_raw) : 0; o.qout = isCont(r.out_kind) ? cntQty(r.out_qty_raw) : 0; o.car = carrier(r.vessel); o.kind = r.out_kind || '—'; o.kindin = r.in_kind || '—'; }
  else { o.h = hrs(r.b_start, r.b_end); o.hW = hrs(r.arr, r.b_start); o.car = carrier(r.vessel); }
  const d = dateOf(r); o.m = d.slice(0, 7); o.y = d.slice(0, 4); o.q = d.slice(0, 4) + ' Q' + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1); o.dow = DOWN[P(d).getDay()]; o.berth = r.berth || '—';
  return o;
}
function fillEx() {
  const ms = document.getElementById('ex-m'), ds = document.getElementById('ex-d');
  ms.innerHTML = EX_METRICS[S.seg].map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  ds.innerHTML = EX_DIMS[S.seg].map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  if (!EX_METRICS[S.seg].some(x => x[0] === EX.m)) { EX.m = EX_METRICS[S.seg][1][0]; EX.a = EX_METRICS[S.seg][1][2]; }
  if (!EX_DIMS[S.seg].some(x => x[0] === EX.d)) EX.d = 'm';
  ms.value = EX.m; ds.value = EX.d; document.getElementById('ex-a').value = EX.a;
}
document.getElementById('ex-m').onchange = e => { EX.m = e.target.value; EX.a = EX_METRICS[S.seg].find(x => x[0] === EX.m)[2]; document.getElementById('ex-a').value = EX.a; renderEx(); };
document.getElementById('ex-d').onchange = e => { EX.d = e.target.value; renderEx(); };
document.getElementById('ex-a').onchange = e => { EX.a = e.target.value; renderEx(); };
document.getElementById('ex-c').querySelectorAll('button').forEach(b => b.onclick = () => { document.getElementById('ex-c').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); EX.c = b.dataset.v; renderEx(); });
const AGG = { sum: v => v.reduce((a, x) => a + x, 0), avg, med, min: v => v.length ? Math.min(...v) : null, max: v => v.length ? Math.max(...v) : null, cnt: v => v.length };
const AGGN = { sum: 'сумма', avg: 'среднее', med: 'медиана', min: 'минимум', max: 'максимум', cnt: 'количество' };
function renderEx() {
  fillEx();
  const rs = filtered().map(exEnrich), g = chartBase(), C = COLS();
  const mName = EX_METRICS[S.seg].find(x => x[0] === EX.m)[1], dName = EX_DIMS[S.seg].find(x => x[0] === EX.d)[1];
  const groups = {};
  rs.forEach(r => { const k = r[EX.d] ?? '—'; (groups[k] = groups[k] || []).push(r[EX.m]); });
  const isTime = ['m', 'y', 'q'].includes(EX.d);
  const timeOrder = EX.d === 'm' ? [...new Set(rs.map(r => r.m))].sort() : null;
  let keys = Object.keys(groups);
  const val = k => { const v = groups[k].filter(x => x != null && !isNaN(x)); return v.length ? AGG[EX.a](v) : null; };
  if (isTime) keys.sort(); else if (EX.d === 'dow') keys.sort((a, b) => DOWN.indexOf(a) - DOWN.indexOf(b)); else keys.sort((a, b) => (val(b) ?? -1e18) - (val(a) ?? -1e18));
  if (EX.d === 'm' && timeOrder) keys = timeOrder;
  const labels = keys.map(k => EX.d === 'm' ? mlab(k) : k), data = keys.map(val);
  const shown = isTime || keys.length <= 30 ? keys : keys.slice(0, 30);
  const dec = EX.m === 'n' || /teu|qin|qout/.test(EX.m) || EX.a === 'cnt' ? 0 : 1;
  document.getElementById('ex-sub').textContent = `${mName} — ${AGGN[EX.a]} по «${dName}». ${per_()} · ${fmtN(rs.length)} записей${!isTime && keys.length > 30 ? ' · на графике первые 30 групп' : ''}.`;
  mk('exc', { type: EX.c, data: { labels: shown.map(k => EX.d === 'm' ? mlab(k) : k), datasets: [{ label: mName, data: shown.map(val), backgroundColor: EX.c === 'bar' ? shown.map(k => EX.d === 'vessel' || EX.d === 'car' ? (KM.has(k) || k === 'КМТФ' ? C[0] : k === 'АСКО' || ASCO.has(k) ? C[1] : css('--ink-3')) : C[0]) : C[0] + '22', borderColor: C[0], borderWidth: 2, borderRadius: 3, fill: EX.c === 'line', tension: .25, pointRadius: 2, barPercentage: .7 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${AGGN[EX.a]}: ${fmtN(c.parsed.y, dec)} · записей: ${groups[shown[c.dataIndex]].length}` } } }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxRotation: isTime ? 0 : 45, autoSkip: true } }, y: { grid: g.grid, border: { display: false }, beginAtZero: true } } } });
  document.getElementById('ex-t').innerHTML = tblFold([dName, 'Записей', 'Есть значение', 'Сумма', 'Среднее', 'Медиана', 'Мин', 'Макс'], keys.map(k => { const v = groups[k].filter(x => x != null && !isNaN(x)); return [EX.d === 'm' ? mlab(k) : esc(k), fmtN(groups[k].length), fmtN(v.length), fmtN(AGG.sum(v), dec), fmtN(avg(v), dec), fmtN(med(v), dec), fmtN(AGG.min(v), dec), fmtN(AGG.max(v), dec)]; }), 24);
}
function per_() { return `${S.y0 === S.y1 ? S.y0 : S.y0 + '–' + S.y1}${S.fleet === 'kmtf' ? ' · флот КМТФ' : ''}${S.vessel ? ' · ' + S.vessel : ''}${S.shpr ? ' · ' + S.shpr : ''}`; }

function renderHist() {
  renderEx();
  const g = chartBase(), rs = filtered(), C = COLS();
  const T = (id, t) => document.getElementById(id).textContent = t;
  const per = `${S.y0 === S.y1 ? S.y0 : S.y0 + '–' + S.y1}${S.fleet === 'kmtf' ? ' · флот КМТФ' : ''}${S.vessel ? ' · ' + S.vessel : ''}${S.shpr ? ' · ' + S.shpr : ''}`;
  const mk2 = monthKeys(rs);
  if (S.seg === 'tank') {
    rs.forEach(r => { r.hR = hrs(r.arr, r.berth_at); r.hB = hrs(r.berth_at, r.dep); r.hL = hrs(r.load_start, r.load_end); r.hT = hrs(r.arr, r.dep); });
    const tons = rs.reduce((a, r) => a + (r.cargo || 0), 0);
    document.getElementById('h-kpis').innerHTML = kpi('Судозаходов', fmtN(rs.length), per) + kpi('Отгружено', fmtN(tons / 1000, 1) + ' тыс. т', `в среднем ${fmtN(avg(rs.map(r => r.cargo)))} т на рейс`) +
      kpi('Ожидание на рейде', fmtN(cen(rs.map(r => r.hR)), 1) + ' ч', CENL() + ' · ' + (S.agg === 'avg' ? 'медиана ' + fmtN(MED(rs.map(r => r.hR)), 1) : 'среднее ' + fmtN(AVG(rs.map(r => r.hR)), 1)) + ' ч') + kpi('У причала', fmtN(cen(rs.map(r => r.hB)), 1) + ' ч', CENL() + ' от постановки до отхода') +
      kpi('Чистая погрузка', fmtN(cen(rs.map(r => r.hL)), 1) + ' ч', CENL()) + kpi('Оборот в порту', fmtN(cen(rs.map(r => r.hT)), 1) + ' ч', 'рейд → отход, ' + CENL());
    // c1: monthly tonnage stacked by shipper (top 3 + other)
    const sc = {}; rs.forEach(r => sc[r.shpr || '—'] = (sc[r.shpr || '—'] || 0) + (r.cargo || 0));
    const top = Object.entries(sc).sort((a, b) => b[1] - a[1]).map(x => x[0]); const keep = top.slice(0, 3); const names = [...keep, ...(top.length > 3 ? ['Прочие'] : [])];
    const ser = names.map(n => mk2.map(k => rs.filter(r => r.dep.startsWith(k) && ((keep.includes(r.shpr || '—') ? (r.shpr || '—') : 'Прочие') === n)).reduce((a, r) => a + (r.cargo || 0), 0) / 1000));
    T('c1-title', 'Отгрузка по месяцам, тыс. т'); T('c1-sub', 'По грузоотправителям (SHPR); столбцы — месяц отхода. ' + per);
    legend('c1-leg', names.map((n, i) => [n, C[i]]));
    mk('c1', { type: 'bar', data: { labels: mk2.map(mlab), datasets: names.map((n, i) => ({ label: n, data: ser[i], backgroundColor: C[i], borderColor: css('--surface'), borderWidth: { top: 0, bottom: 2, left: 0, right: 0 }, borderSkipped: false, barPercentage: .7, categoryPercentage: .9 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} тыс. т` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: true, grid: g.grid, border: { display: false }, ticks: { callback: v => fmtN(v) } } } } });
    // c2: per vessel tonnage horizontal
    const vv = {}; rs.forEach(r => { const o = vv[r.vessel] = vv[r.vessel] || { n: 0, t: 0, hR: [], hB: [], hL: [], hT: [], c: [] }; o.n++; o.t += r.cargo || 0; o.hR.push(r.hR); o.hB.push(r.hB); o.hL.push(r.hL); o.hT.push(r.hT); o.c.push(r.cargo); });
    const vlist = Object.entries(vv).sort((a, b) => b[1].t - a[1].t);
    const top12 = vlist.slice(0, 14);
    T('c2-title', 'Отгрузка по судам, тыс. т'); T('c2-sub', 'Топ-14 судов по объёму. Синим — флот КМТФ.');
    mk('c2', { type: 'bar', data: { labels: top12.map(x => x[0]), datasets: [{ label: 'тыс. т', data: top12.map(x => x[1].t / 1000), backgroundColor: top12.map(x => KM.has(x[0]) ? C[0] : css('--ink-3')), borderRadius: 3, barPercentage: .7 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: ttf('', 'тыс. т', 1) }, scales: { x: { grid: g.grid, border: { display: false } }, y: { grid: { display: false }, border: g.border } } } });
    // c3: monthly median hours: roads wait / at berth
    T('c3-title', 'Время в порту по месяцам, часы (' + CENL() + ')'); T('c3-sub', 'Ожидание на рейде до постановки и время у причала до отхода.');
    legend('c3-leg', [['На рейде', C[0]], ['У причала', C[1]], ['Погрузка', C[2]]]);
    const line = (lab, key, col) => ({ label: lab, data: mk2.map(k => cen(rs.filter(r => r.dep.startsWith(k)).map(r => r[key]))), borderColor: col, backgroundColor: col, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: .25, spanGaps: true });
    mk('c3', { type: 'line', data: { labels: mk2.map(mlab), datasets: [line('На рейде', 'hR', C[0]), line('У причала', 'hB', C[1]), line('Погрузка', 'hL', C[2])] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} ч` } } }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxRotation: 0 } }, y: { grid: g.grid, border: { display: false }, beginAtZero: true } } } });
    // t1
    T('t1-title', 'Сводная таблица по судам'); T('t1-sub', 'Часы — ' + CENP() + '. Оборот = от прихода на рейд до отхода.');
    document.getElementById('t1').innerHTML = tblFold(['Судно', 'Флот', 'Судозаходов', 'Всего, т', 'Ср. партия, т', 'Ср. осадка', 'Рейд, ч', 'У причала, ч', 'Погрузка, ч', 'Оборот, ч'],
      vlist.map(([v, o]) => [esc(v), KM.has(v) ? '<span class="pill k">КМТФ</span>' : '', fmtN(o.n), fmtN(o.t), fmtN(avg(o.c)), fmtN(avg(rs.filter(r => r.vessel === v).map(r => r.draft)), 1), fmtN(cen(o.hR), 1), fmtN(cen(o.hB), 1), fmtN(cen(o.hL), 1), fmtN(cen(o.hT), 1)]));
    // t2 shippers
    document.getElementById('c4-card').style.display = ''; T('c4-title', 'По грузоотправителям'); T('c4-sub', 'SHPR из сводки: -Б — Баку/Сангачал, -М — Махачкала.');
    const sh = {}; rs.forEach(r => { const o = sh[r.shpr || '—'] = sh[r.shpr || '—'] || { n: 0, t: 0, term: {} }; o.n++; o.t += r.cargo || 0; if (r.terminal) o.term[r.terminal] = (o.term[r.terminal] || 0) + 1; });
    document.getElementById('t2').innerHTML = tbl(['Отправитель', 'Судозаходов', 'Тонн', 'Доля', 'Терминал'], Object.entries(sh).sort((a, b) => b[1].t - a[1].t).map(([k, o]) => [esc(k), fmtN(o.n), fmtN(o.t), fmtN(100 * o.t / (tons || 1), 1) + ' %', esc(Object.entries(o.term).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(', '))]));
    // t3 years
    T('c5-title', 'По годам'); T('c5-sub', 'Итоги по годам в текущем фильтре (2026 — по ' + dmy(SNAP.timestamp) + ').');
    const yy = {}; rs.forEach(r => { const y = r.dep.slice(0, 4); const o = yy[y] = yy[y] || { n: 0, t: 0, hR: [], hB: [], hT: [], v: new Set() }; o.n++; o.t += r.cargo || 0; o.hR.push(r.hR); o.hB.push(r.hB); o.hT.push(r.hT); o.v.add(r.vessel); });
    document.getElementById('t3').innerHTML = tbl(['Год', 'Судозаходов', 'Тонн', 'Судов', 'Рейд, ч', 'У причала, ч', 'Оборот, ч'], Object.entries(yy).map(([y, o]) => [y, fmtN(o.n), fmtN(o.t), o.v.size, fmtN(cen(o.hR), 1), fmtN(cen(o.hB), 1), fmtN(cen(o.hT), 1)]));
  } else if (S.seg === 'bulk') {
    rs.forEach(r => { r.hR = hrs(r.arr, r.berth_at); r.hB = hrs(r.berth_at, r.dep); r.hT = hrs(r.arr, r.dep); r.teu = (r.in_teu || 0) + (r.out_teu || 0); });
    const teuIn = rs.reduce((a, r) => a + (r.in_teu || 0), 0), teuOut = rs.reduce((a, r) => a + (r.out_teu || 0), 0);
    const cont = rs.filter(r => r.in_kind.startsWith('контейнер') || r.out_kind.startsWith('контейнер')).length;
    document.getElementById('h-kpis').innerHTML = kpi('Судозаходов', fmtN(rs.length), per) + kpi('Контейнерных заходов', fmtN(cont), `${fmtN(100 * cont / (rs.length || 1))} % от всех`) + kpi('ДФЭ выгружено', fmtN(teuIn), 'в Актау') + kpi('ДФЭ погружено', fmtN(teuOut), 'из Актау') +
      kpi('Ожидание на рейде', fmtN(cen(rs.map(r => r.hR)), 1) + ' ч', CENL()) + kpi('У причала', fmtN(cen(rs.map(r => r.hB)), 1) + ' ч', CENL());
    T('c1-title', 'Заходы сухогрузов по месяцам'); T('c1-sub', 'Судозаходы по месяцам, по виду груза на выход. ' + per);
    const kinds = {}; rs.forEach(r => { const k = r.out_kind || r.in_kind || '—'; kinds[k] = (kinds[k] || 0) + 1; });
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(x => x[0]); const keep = top.slice(0, 4); const names = [...keep, ...(top.length > 4 ? ['Прочие'] : [])];
    const kk = r => { const k = r.out_kind || r.in_kind || '—'; return keep.includes(k) ? k : 'Прочие'; };
    legend('c1-leg', names.map((n, i) => [n, C[i]]));
    mk('c1', { type: 'bar', data: { labels: mk2.map(mlab), datasets: names.map((n, i) => ({ label: n, data: mk2.map(k => rs.filter(r => r.dep.startsWith(k) && kk(r) === n).length), backgroundColor: C[i], borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y}` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border, ticks: { maxRotation: 0 } }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
    const vv = {}; rs.forEach(r => { const o = vv[r.vessel] = vv[r.vessel] || { n: 0, teu: 0, ti: 0, to: 0, hR: [], hB: [], hT: [] }; o.n++; o.teu += r.teu; o.ti += r.in_teu || 0; o.to += r.out_teu || 0; o.hR.push(r.hR); o.hB.push(r.hB); o.hT.push(r.hT); });
    const vlist = Object.entries(vv).sort((a, b) => b[1].n - a[1].n); const top12 = vlist.slice(0, 14);
    T('c2-title', 'Заходы по судам'); T('c2-sub', 'Топ-14 судов по числу судозаходов. Оранжевым — флот КМТФ.');
    mk('c2', { type: 'bar', data: { labels: top12.map(x => x[0]), datasets: [{ label: 'судозаходов', data: top12.map(x => x[1].n), backgroundColor: top12.map(x => KM.has(x[0]) ? C[1] : css('--ink-3')), borderRadius: 3, barPercentage: .7 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: ttf('', '') }, scales: { x: { grid: g.grid, border: { display: false } }, y: { grid: { display: false }, border: g.border } } } });
    T('c3-title', 'ДФЭ по месяцам'); T('c3-sub', 'Контейнеры в двадцатифутовом эквиваленте: выгрузка и погрузка в Актау.');
    legend('c3-leg', [['Выгружено', C[0]], ['Погружено', C[1]]]);
    mk('c3', { type: 'bar', data: { labels: mk2.map(mlab), datasets: [['Выгружено', 'in_teu', C[0]], ['Погружено', 'out_teu', C[1]]].map(([l, k, c]) => ({ label: l, data: mk2.map(m => rs.filter(r => r.dep.startsWith(m)).reduce((a, r) => a + (r[k] || 0), 0)), backgroundColor: c, borderRadius: 2, barPercentage: .8 })) },
      options: { maintainAspectRatio: false, interaction: { mode: 'index' }, plugins: { legend: { display: false }, tooltip: ttf('', 'ДФЭ') }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxRotation: 0 } }, y: { grid: g.grid, border: { display: false } } } } });
    T('t1-title', 'Сводная таблица по судам'); T('t1-sub', 'Часы — ' + CENP() + '.');
    document.getElementById('t1').innerHTML = tblFold(['Судно', 'Флот', 'Судозаходов', 'ДФЭ выгр.', 'ДФЭ погр.', 'Рейд, ч', 'У причала, ч', 'Оборот, ч'], vlist.map(([v, o]) => [esc(v), KM.has(v) ? '<span class="pill b">КМТФ</span>' : '', fmtN(o.n), fmtN(o.ti), fmtN(o.to), fmtN(cen(o.hR), 1), fmtN(cen(o.hB), 1), fmtN(cen(o.hT), 1)]));
    document.getElementById('c4-card').style.display = ''; T('c4-title', 'По видам груза'); T('c4-sub', 'Груз на выход из Актау (по числу судозаходов).');
    const kk2 = {}; rs.forEach(r => { const k = r.out_kind || '—'; const o = kk2[k] = kk2[k] || { n: 0, q: 0 }; o.n++; o.q += r.out_qty || 0; });
    document.getElementById('t2').innerHTML = tbl(['Груз на выход', 'Судозаходов', 'Доля'], Object.entries(kk2).sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([k, o]) => [esc(k), fmtN(o.n), fmtN(100 * o.n / (rs.length || 1), 1) + ' %']));
    T('c5-title', 'По годам'); T('c5-sub', 'Итоги по годам в текущем фильтре.');
    const yy = {}; rs.forEach(r => { const y = r.dep.slice(0, 4); const o = yy[y] = yy[y] || { n: 0, ti: 0, to: 0, hB: [], v: new Set() }; o.n++; o.ti += r.in_teu || 0; o.to += r.out_teu || 0; o.hB.push(r.hB); o.v.add(r.vessel); });
    document.getElementById('t3').innerHTML = tbl(['Год', 'Судозаходов', 'Судов', 'ДФЭ выгр.', 'ДФЭ погр.', 'У причала, ч'], Object.entries(yy).map(([y, o]) => [y, fmtN(o.n), o.v.size, fmtN(o.ti), fmtN(o.to), fmtN(cen(o.hB), 1)]));
  } else {
    rs.forEach(r => { r.h = hrs(r.b_start, r.b_end); r.sts = r.port.startsWith('STS'); });
    const dt = rs.reduce((a, r) => a + (r.dt || 0), 0), tt = rs.reduce((a, r) => a + (r.tt || 0), 0);
    const ports = [...new Set(rs.map(r => r.port))].sort((a, b) => rs.filter(r => r.port === b).length - rs.filter(r => r.port === a).length);
    const pk = (p) => { const q = rs.filter(r => r.port === p); return kpi(p, fmtN(q.reduce((a, r) => a + (r.dt || 0), 0)) + ' т', `${q.length} бункеровок · ср. ${fmtN(avg(q.map(r => r.dt)), 1)} т · ${CENL()} ${fmtN(cen(q.map(r => r.h)), 1)} ч`); };
    const stsN = rs.filter(r => r.sts).length, stsT = rs.filter(r => r.sts).reduce((a, r) => a + (r.dt || 0), 0);
    document.getElementById('h-kpis').innerHTML = kpi('Бункеровок всего', fmtN(rs.length), per) + kpi('Дизтоплива всего', fmtN(dt) + ' т', `тяж. топлива ${fmtN(tt)} т · в среднем ${fmtN(avg(rs.map(r => r.dt)), 1)} т`) + kpi('От бункеровщика (порт/рейд)', fmtN(rs.length - stsN), `${fmtN(dt - stsT)} т Д/Т`) + kpi('Ship-to-ship (между судами КМТФ)', fmtN(stsN), `${fmtN(stsT)} т Д/Т · ${fmtN(100 * stsN / (rs.length || 1))} % бункеровок`) + ports.map(pk).join('');
    T('c1-title', 'Бункеровки по месяцам, т дизтоплива'); T('c1-sub', 'По месту бункеровки. Ship-to-ship — только передача топлива между судами КМТФ. ' + per);
    const PC = [C[0], C[1], C[2], C[3], C[4], css('--ink-3')];
    legend('c1-leg', ports.map((p, i) => [p, PC[i % PC.length]]));
    mk('c1', { type: 'bar', data: { labels: mk2.map(mlab), datasets: ports.map((p, i) => ({ label: p, data: mk2.map(k => rs.filter(r => dateOf(r).startsWith(k) && r.port === p).reduce((a, r) => a + (r.dt || 0), 0)), backgroundColor: PC[i % PC.length], borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y)} т` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border, ticks: { maxRotation: 0 } }, y: { stacked: true, grid: g.grid, border: { display: false } } } } });
    const vv = {}; rs.forEach(r => { const o = vv[r.vessel] = vv[r.vessel] || { n: 0, dt: 0, h: [], sts: 0 }; o.n++; o.dt += r.dt || 0; o.h.push(r.h); if (r.sts) o.sts++; });
    const vlist = Object.entries(vv).sort((a, b) => b[1].dt - a[1].dt); const top12 = vlist.slice(0, 14);
    T('c2-title', 'Дизтопливо по судам, т'); T('c2-sub', 'Топ-14.');
    mk('c2', { type: 'bar', data: { labels: top12.map(x => x[0]), datasets: [{ label: 'Д/Т', data: top12.map(x => x[1].dt), backgroundColor: top12.map(x => KM.has(x[0]) ? C[0] : css('--ink-3')), borderRadius: 3, barPercentage: .7 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: ttf('', 'т') }, scales: { x: { grid: g.grid, border: { display: false } }, y: { grid: { display: false }, border: g.border } } } });
    T('c3-title', 'Число бункеровок по месяцам'); T('c3-sub', 'От бункеровщика и ship-to-ship между судами КМТФ.'); legend('c3-leg', [['От бункеровщика', C[0]], ['Ship-to-ship', C[1]]]);
    mk('c3', { type: 'bar', data: { labels: mk2.map(mlab), datasets: [['От бункеровщика', false, C[0]], ['Ship-to-ship', true, C[1]]].map(([l, f, c]) => ({ label: l, data: mk2.map(k => rs.filter(r => dateOf(r).startsWith(k) && r.sts === f).length), backgroundColor: c, borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 })) },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y}` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border, ticks: { maxRotation: 0 } }, y: { stacked: true, grid: g.grid, border: { display: false }, beginAtZero: true } } } });
    T('t1-title', 'По судам'); T('t1-sub', 'STS — бункеровки с другого судна КМТФ.');
    document.getElementById('t1').innerHTML = tblFold(['Судно', 'Флот', 'Бункеровок', 'из них STS', 'Д/Т, т', 'Ср. приём, т', 'Длит., ч'], vlist.map(([v, o]) => [esc(v), KM.has(v) ? '<span class="pill k">КМТФ</span>' : '', fmtN(o.n), fmtN(o.sts), fmtN(o.dt), fmtN(o.dt / o.n, 1), fmtN(cen(o.h), 1)]));
    document.getElementById('c4-card').style.display = ''; T('c4-title', 'По местам бункеровки'); T('c4-sub', '146 район — рейд Баку, бункеровка бункеровщиком; STS — передача с судна КМТФ.');
    document.getElementById('t2').innerHTML = tbl(['Место', 'Бункеровок', 'Д/Т, т', 'Т/Т, т', 'Ср. приём, т', 'Длит., ч'], ports.map(p => { const q = rs.filter(r => r.port === p); return [esc(p), fmtN(q.length), fmtN(q.reduce((a, r) => a + (r.dt || 0), 0)), fmtN(q.reduce((a, r) => a + (r.tt || 0), 0)), fmtN(avg(q.map(r => r.dt)), 1), fmtN(cen(q.map(r => r.h)), 1)]; }));
    T('c5-title', 'По годам'); T('c5-sub', 'Д/Т в тоннах: всего, от бункеровщика, ship-to-ship.');
    const yy = {}; rs.forEach(r => { const y = dateOf(r).slice(0, 4); const o = yy[y] = yy[y] || { n: 0, dt: 0, sn: 0, sdt: 0 }; o.n++; o.dt += r.dt || 0; if (r.sts) { o.sn++; o.sdt += r.dt || 0; } });
    document.getElementById('t3').innerHTML = tbl(['Год', 'Бункеровок', 'Д/Т, т', 'От бункеровщика, т', 'STS, шт', 'STS, т'], Object.entries(yy).map(([y, o]) => [y, fmtN(o.n), fmtN(o.dt), fmtN(o.dt - o.sdt), fmtN(o.sn), fmtN(o.sdt)]));
  }
}

/* ---------- RAW ---------- */
const R = { seg: 'tank', fleet: 'all', y0: null, y1: null, vessel: '', shpr: '', sortKey: 'dep', sortDir: -1 };
const ry0 = document.getElementById('raw-y0'), ry1 = document.getElementById('raw-y1');
years.forEach(y => { ry0.add(new Option(y, y)); ry1.add(new Option(y, y)); });
ry0.value = ry1.value = years[years.length - 1]; R.y0 = R.y1 = ry0.value;
ry0.onchange = () => { R.y0 = ry0.value; if (R.y1 < R.y0) { ry1.value = R.y0; R.y1 = R.y0; } renderRaw(); };
ry1.onchange = () => { R.y1 = ry1.value; if (R.y1 < R.y0) { ry0.value = R.y1; R.y0 = R.y1; } renderRaw(); };
document.getElementById('raw-v').onchange = e => { R.vessel = e.target.value; renderRaw(); };
document.getElementById('raw-s').onchange = e => { R.shpr = e.target.value; renderRaw(); };
for (const [id, key] of [['raw-seg', 'seg'], ['raw-fleet', 'fleet']]) document.getElementById(id).querySelectorAll('button').forEach(b => b.onclick = () => {
  document.getElementById(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); R[key] = b.dataset.v;
  if (key === 'seg') { R.vessel = ''; R.shpr = ''; R.sortKey = R.seg === 'bunk' ? 'b_start' : 'dep'; R.sortDir = -1; fillRawSelects(); }
  renderRaw();
});
function rawBase() { return R.seg === 'tank' ? TANK : R.seg === 'bulk' ? BULK : BUNK; }
function fillRawSelects() {
  const vs = document.getElementById('raw-v'); vs.innerHTML = '<option value="">Все суда</option>';
  const cnt = {}; rawBase().forEach(r => cnt[r.vessel] = (cnt[r.vessel] || 0) + 1);
  Object.entries(cnt).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => vs.add(new Option(`${v} (${n})`, v)));
  document.getElementById('raw-shpr-f').style.display = R.seg === 'tank' ? '' : 'none';
  const ss = document.getElementById('raw-s'); ss.innerHTML = '<option value="">Все</option>';
  if (R.seg === 'tank') { const c = {}; TANK.forEach(r => { if (r.shpr) c[r.shpr] = (c[r.shpr] || 0) + 1; }); Object.entries(c).sort((a, b) => b[1] - a[1]).forEach(([v, n]) => ss.add(new Option(`${v} (${n})`, v))); }
}
fillRawSelects();
document.getElementById('q').oninput = renderRaw; document.getElementById('rawn').onchange = renderRaw;
const RAW_COLS = {
  tank: [['vessel', 'Судно'], ['shpr', 'SHPR'], ['terminal', 'Терминал'], ['berth', 'Причал'], ['arr', 'Приход на рейд'], ['berth_at', 'Постановка'], ['load_start', 'Начало погрузки'], ['load_end', 'Окончание'], ['draft', 'Осадка'], ['cargo', 'Груз, т'], ['dep', 'Отход'], ['hR', 'Рейд, ч'], ['hB', 'У причала, ч']],
  bulk: [['vessel', 'Судно'], ['berth', 'Причал'], ['arr', 'Приход'], ['berth_at', 'Постановка'], ['unload_start', 'Выгрузка с'], ['unload_end', 'по'], ['in_kind', 'Груз (вход)'], ['in_qty_raw', 'Кол-во'], ['in_teu', 'ДФЭ'], ['load_start', 'Погрузка с'], ['load_end', 'по'], ['out_kind', 'Груз (выход)'], ['out_qty_raw', 'Кол-во'], ['out_teu', 'ДФЭ'], ['dep', 'Отход'], ['hB', 'У причала, ч']],
  bunk: [['vessel', 'Судно'], ['port', 'Место'], ['arr', 'Приход'], ['b_start', 'Начало'], ['b_end', 'Окончание'], ['dt', 'Д/Т, т'], ['tt', 'Т/Т, т'], ['dep', 'Отход'], ['h', 'Длит., ч']],
};
const NUMK = new Set(['draft', 'cargo', 'in_teu', 'out_teu', 'dt', 'tt', 'hR', 'hB', 'h', 'in_qty', 'out_qty']);
const fmtCell = (k, v) => { if (v == null || v === '') return ''; if (/^(arr|berth_at|load_start|load_end|unload_start|unload_end|dep|b_start|b_end)$/.test(k)) return dmyY(v) + ' ' + String(v).slice(11); if (k === 'draft') return fmtN(v, 2); if (k === 'hR' || k === 'hB' || k === 'h') return fmtN(v, 1); if (NUMK.has(k)) return fmtN(v, k === 'dt' || k === 'tt' ? 1 : 0); return esc(v); };
function renderRaw() {
  const q = document.getElementById('q').value.trim().toLowerCase(), n = document.getElementById('rawn').value;
  let rs = rawBase().filter(r => { const y = dateOf(r).slice(0, 4); return y >= R.y0 && y <= R.y1 && (R.fleet === 'all' || (R.fleet === 'kmtf' ? KM.has(r.vessel) : ASCO.has(r.vessel))) && (!R.vessel || r.vessel === R.vessel) && (!R.shpr || r.shpr === R.shpr); });
  rs = rs.map(r => ({ ...r, hR: hrs(r.arr, r.berth_at), hB: hrs(r.berth_at, r.dep), h: hrs(r.b_start, r.b_end) }));
  if (q) rs = rs.filter(r => Object.values(r).some(v => typeof v === 'string' && v.toLowerCase().includes(q)));
  const k = R.sortKey, d = R.sortDir;
  rs.sort((a, b) => { let x = a[k], y = b[k]; const nx = x == null || x === '', ny = y == null || y === ''; if (nx && ny) return 0; if (nx) return 1; if (ny) return -1; if (NUMK.has(k)) { x = +x; y = +y; } else if (k === 'berth') { const px = parseFloat(x), py = parseFloat(y); if (!isNaN(px) && !isNaN(py)) { x = px; y = py; } } return (x < y ? -1 : x > y ? 1 : 0) * d; });
  const total = rs.length; if (n !== 'все') rs = rs.slice(0, +n);
  document.getElementById('raw-note').textContent = `${fmtN(total)} записей в фильтре, показано ${rs.length}.`;
  const cols = RAW_COLS[R.seg];
  const head = cols.map(([key, name]) => `<th class="sortable${key === k ? ' sorted' : ''}" data-k="${key}">${name}${key === k ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  document.getElementById('raw').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${rs.map(r => `<tr>${cols.map(([key]) => `<td${key === 'vessel' ? ' style="text-align:left"' : ''}>${fmtCell(key, r[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('#raw th.sortable').forEach(th => th.onclick = () => { const kk = th.dataset.k; if (R.sortKey === kk) R.sortDir = -R.sortDir; else { R.sortKey = kk; R.sortDir = NUMK.has(kk) || /dep|arr|start|end|at$/.test(kk) ? -1 : 1; } renderRaw(); });
}

document.getElementById('src').innerHTML = `Источник: файлы «Дислокация судов» диспетчерской службы КМТФ (${esc(SNAP.file)}); история рейсов собрана из листов «Статистика по танкерам», «Статистика сухогрузов» и «Статистика бункеровки» — ${fmtN(TANK.length)} судозаходов танкеров, ${fmtN(BULK.length)} судозаходов сухогрузов, ${fmtN(BUNK.length)} бункеровок с ${TANK[0].dep.slice(0, 7)} по ${TANK[TANK.length - 1].dep.slice(0, 10)}. Статистика включает все суда, заходившие в Актау, не только флот КМТФ — переключатель «Только КМТФ» ограничивает выборку судами из таблицы судовых запасов. Часы у причала считаются от постановки до отхода; записи с пропусками дат в средних не участвуют.`;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.getElementById('p-hist').hidden) renderHist(); });
renderNow();
