/* ---------- ОБЪЁМЫ 2: коносаменты (Caspian Sea Crude Oil), МР-отчёты, открытые моря (KMTF UK) ---------- */
const CR = (D.crude || []).map(r => Object.fromEntries(D.crude_cols.map((c, i) => [c, r[i]])));
const CRG = D.crude_groups || {};
const crGroup = v => { for (const [g, vs] of Object.entries(CRG)) if (vs.includes(v)) return g; return ASCO.has(v) ? 'АСКО' : 'Прочие'; };
CR.forEach(r => { r.g = crGroup(r.vessel); r.y = r.m.slice(0, 4); r.prod = r.cargo && !r.cargo.startsWith('нефть'); });
const OSV = (D.openseas || []).map(r => Object.fromEntries(D.openseas_cols.map((c, i) => [c, r[i]])));
const MRM = (D.mr && D.mr.monthly) || [], MRC = (D.mr && D.mr.cum) || {};
const GROUPS = ['КМТФ', 'CIMS', 'АСКО', 'AB Fleet', 'Caspiy Shipping / Мобилекс', 'Прочие'];
const GCOL = () => { const C = COLS(); return { 'КМТФ': C[0], 'CIMS': C[2], 'АСКО': C[1], 'AB Fleet': C[3], 'Caspiy Shipping / Мобилекс': C[4], 'Прочие': css('--ink-3') }; };
const monthsOf = (Y, upto) => Array.from({ length: 12 }, (_, i) => `${Y}-${String(i + 1).padStart(2, '0')}`).filter(m => !upto || m <= upto);
const mName = m => ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][+m.slice(5, 7) - 1];
const kp2 = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:24px">${v}</div><div class="s">${s || ''}</div></div>`;
const stackOpts = (g, unit, d = 1) => ({ maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, d)} ${unit}` } } }, scales: { x: { stacked: true, grid: { display: false }, border: g.border }, y: { stacked: true, grid: g.grid, border: { display: false } } } });
const stackDs = (label, data, color) => ({ label, data, backgroundColor: color, borderColor: css('--surface'), borderWidth: { bottom: 2 }, borderSkipped: false, barPercentage: .7 });

// подвкладки
document.querySelectorAll('.subtabs').forEach(box => box.querySelectorAll('button').forEach(b => b.onclick = () => {
  box.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
  const sec = box.closest('section'); sec.querySelectorAll('[data-sub]').forEach(p => p.hidden = p.dataset.sub !== b.dataset.v);
  const id = sec.id.slice(2); if (id === 'oil' || id === 'cnt') renderVol(); else renderOSV();
}));
const subOf = id => { const b = document.querySelector(`#${id}-sub button[aria-pressed="true"]`); return b ? b.dataset.v : null; };

/* ===== нефть по коносаментам ===== */
const BLF = { t1: null, t2: null, t3: null, yr: null };   // фильтры года у таблиц (по умолчанию — год вкладки)
const blYears = [...new Set(CR.map(r => r.y))].sort();
const ySel = (key, cur, extraAll) => `<select class="ysel" data-key="${key}" style="margin-left:8px">${(extraAll ? ['all'] : []).concat(blYears).map(y => `<option value="${y}"${y === cur ? ' selected' : ''}>${y === 'all' ? 'Все годы' : y}</option>`).join('')}</select>`;
function renderOilBL(Y) {
  if (BLF.yr !== Y) { BLF.t1 = BLF.t2 = BLF.t3 = Y; BLF.yr = Y; }
  const g = chartBase(), GC = GCOL();
  const T = CR.filter(r => r.y === Y);
  const thisM = SNAP.timestamp.slice(0, 7), curYear = Y === thisM.slice(0, 4);
  const maxM = T.length ? T.map(r => r.m).sort().pop() : `${Y}-01`;
  const months = monthsOf(Y, curYear ? (maxM > thisM ? maxM : thisM) : null);
  const lastM = months[months.length - 1];
  const sum = (arr, f) => arr.filter(f || (() => true)).reduce((a, r) => a + r.tons, 0);
  document.getElementById('oil-note').textContent = `Файлы «Caspian Sea Crude Oil» (Галимзянов/Хайдаров): каждый рейс относится к месяцу по дате коносамента, переходящие рейсы разбиты на части. Перевозчик — по судну: КМТФ (ТК Актау, Астана, Алматы), CIMS (Лива, Тараз — СП КМТФ и AD Ports), АСКО, AB Fleet (Костанай, Караганда, Куруш), Caspiy Shipping/Мобилекс (Казахстан, Абай). Данные ${Y}: по ${dmy(maxM + '-01').slice(3)}.${Y}.`;
  const blk = (label, f) => {
    const A = T.filter(f); const tot = sum(A), b = sum(A, r => r.route === 'Баку'), mk_ = sum(A, r => r.route === 'Махачкала'), prod = sum(A, r => r.prod);
    const gs = gr => sum(A, r => r.g === gr), gb = gr => sum(A, r => r.g === gr && r.route === 'Баку'), gm = gr => sum(A, r => r.g === gr && r.route === 'Махачкала');
    return kp2(label + ' · всего', fmtN(tot / 1000, 1) + ' тыс. т', `${A.length} коносаментных партий${prod ? ' · в т.ч. нефтепродукты ' + fmtN(prod / 1000, 1) : ''}`) +
      kp2(label + ' · Баку/Сангачал', fmtN(b / 1000, 1) + ' тыс. т', `КМТФ ${fmtN(gb('КМТФ') / 1000, 1)} · CIMS ${fmtN(gb('CIMS') / 1000, 1)} · АСКО ${fmtN(gb('АСКО') / 1000, 1)} · прочие ${fmtN((b - gb('КМТФ') - gb('CIMS') - gb('АСКО')) / 1000, 1)}`) +
      kp2(label + ' · Махачкала', fmtN(mk_ / 1000, 1) + ' тыс. т', `КМТФ ${fmtN(gm('КМТФ') / 1000, 1)} · CIMS ${fmtN(gm('CIMS') / 1000, 1)} · АСКО ${fmtN(gm('АСКО') / 1000, 1)} · AB Fleet ${fmtN(gm('AB Fleet') / 1000, 1)} · прочие ${fmtN((mk_ - gm('КМТФ') - gm('CIMS') - gm('АСКО') - gm('AB Fleet')) / 1000, 1)}`);
  };
  document.getElementById('bl-kpis').innerHTML = blk(curYear ? `Этот месяц (${mName(lastM)})` : mName(lastM), r => r.m === lastM) + blk(Y + (curYear ? ' с начала года' : ' год'), r => true);
  // c1 routes
  const routes = [...new Set(T.map(r => r.route))].sort((a, b) => sum(T, r => r.route === b) - sum(T, r => r.route === a));
  const RC = { 'Баку': COLS()[0], 'Махачкала': COLS()[1] };
  legend('blc1-leg', routes.map((r, i) => [r, RC[r] || COLS()[2 + i % 3]]));
  document.getElementById('blc1-sub').textContent = `${Y}, тыс. тонн по месяцу коносамента`;
  mk('blc1', { type: 'bar', data: { labels: months.map(mlab), datasets: routes.map((rt, i) => stackDs(rt, months.map(m => sum(T, r => r.m === m && r.route === rt) / 1000), RC[rt] || COLS()[2 + i % 3])) }, options: stackOpts(g, 'тыс. т') });
  // c4 compare with dispatcher
  const disp = m => TANK.filter(r => r.dep.startsWith(m)).reduce((a, r) => a + (r.cargo || 0), 0) / 1000;
  legend('blc4-leg', [['По коносаментам', COLS()[0]], ['Сводки диспетчера', css('--ink-3')]]);
  mk('blc4', { type: 'bar', data: { labels: months.map(mlab), datasets: [{ label: 'По коносаментам', data: months.map(m => sum(T, r => r.m === m) / 1000), backgroundColor: COLS()[0], borderRadius: 3, barPercentage: .8 }, { label: 'Сводки диспетчера', data: months.map(disp), backgroundColor: css('--ink-3'), borderRadius: 3, barPercentage: .8 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, 1)} тыс. т` } } }, scales: { x: { grid: { display: false }, border: g.border }, y: { grid: g.grid, border: { display: false } } } } });
  // c2/c3 by group
  for (const [cid, rt] of [['blc2', 'Баку'], ['blc3', 'Махачкала']]) {
    const gs = GROUPS.filter(gr => sum(T, r => r.route === rt && r.g === gr) > 0);
    legend(cid + '-leg', gs.map(gr => [gr, GC[gr]]));
    document.getElementById(cid + '-sub').textContent = `${Y}, маршрут ${rt === 'Баку' ? 'Актау → Баку/Сангачал' : 'Актау → Махачкала'}`;
    mk(cid, { type: 'bar', data: { labels: months.map(mlab), datasets: gs.map(gr => stackDs(gr, months.map(m => sum(T, r => r.m === m && r.route === rt && r.g === gr) / 1000), GC[gr])) }, options: stackOpts(g, 'тыс. т') });
  }
  // t1 monthly table (свой фильтр года)
  const Y1 = BLF.t1, T1 = Y1 === 'all' ? CR : CR.filter(r => r.y === Y1);
  const months1 = Y1 === 'all' ? [...new Set(T1.map(r => r.m))].sort() : (Y1 === Y ? months : monthsOf(Y1));
  const cols = [['Всего', r => true], ['Баку всего', r => r.route === 'Баку'], ['Баку КМТФ', r => r.route === 'Баку' && r.g === 'КМТФ'], ['Баку CIMS', r => r.route === 'Баку' && r.g === 'CIMS'], ['Баку АСКО', r => r.route === 'Баку' && r.g === 'АСКО'], ['Баку прочие', r => r.route === 'Баку' && !['КМТФ', 'CIMS', 'АСКО'].includes(r.g)],
    ['Махачкала всего', r => r.route === 'Махачкала'], ['Мах. КМТФ', r => r.route === 'Махачкала' && r.g === 'КМТФ'], ['Мах. CIMS', r => r.route === 'Махачкала' && r.g === 'CIMS'], ['Мах. АСКО', r => r.route === 'Махачкала' && r.g === 'АСКО'], ['Мах. AB Fleet', r => r.route === 'Махачкала' && r.g === 'AB Fleet'], ['Мах. прочие', r => r.route === 'Махачкала' && !['КМТФ', 'CIMS', 'АСКО', 'AB Fleet'].includes(r.g)], ['Нефтепродукты', r => r.prod]];
  const rowsT = [];
  const yrs1 = [...new Set(months1.map(m => m.slice(0, 4)))];
  for (const yy of yrs1) {
    const ms = months1.filter(m => m.startsWith(yy));
    ms.forEach(m => { const bl = sum(T1, r => r.m === m), dp = disp(m) * 1000; rowsT.push([mlab(m), ...cols.map(([n, f]) => fmtN(sum(T1, r => r.m === m && f(r)))), fmtN(dp), `${dp - bl >= 0 ? '+' : ''}${fmtN(dp - bl)}`]); });
    const Ty = T1.filter(r => r.y === yy), dpy = ms.reduce((a, m) => a + disp(m) * 1000, 0);
    rowsT.push([`<b>Итого ${yy}</b>`, ...cols.map(([n, f]) => `<b>${fmtN(sum(Ty, f))}</b>`), `<b>${fmtN(dpy)}</b>`, `<b>${fmtN(dpy - sum(Ty))}</b>`]);
  }
  document.getElementById('blt1-sub').innerHTML = 'Тонны по месяцу коносамента. Последние две колонки — итог месяца по сводкам диспетчера (дата отхода) и его отклонение от коносаментного учёта. Год:' + ySel('t1', Y1, true);
  document.getElementById('blt1').innerHTML = tbl(['Месяц', ...cols.map(c => c[0]), 'Диспетчер', 'Откл.'], rowsT);
  // t2 transitional voyages: same vessel+arr in two months, or dep month != B/L month
  const Y2 = BLF.t2, T2 = Y2 === 'all' ? CR : CR.filter(r => r.y === Y2);
  const key = r => r.vessel + '|' + r.arr;
  const cnt = {}; T2.forEach(r => { cnt[key(r)] = (cnt[key(r)] || new Set()).add(r.m); });
  const tr = T2.filter(r => (cnt[key(r)].size > 1) || (r.dep && r.dep.slice(0, 7) !== r.m)).sort((a, b) => (a.arr + a.vessel).localeCompare(b.arr + b.vessel));
  document.getElementById('blt2-sub').innerHTML = `Рейсы, объём которых разнесён на два месяца по датам коносаментов (одно судно, один приход — две партии), либо отход в другом месяце, чем коносамент. Диспетчер относит весь груз к дате отхода. Год:` + ySel('t2', Y2, true);
  document.getElementById('blt2').innerHTML = tr.length ? tblFold(['Судно', 'Перевозчик', 'Приход', 'Отход', 'Учтено в месяце', 'Тонн', 'Маршрут', 'Коносаменты'], tr.map(r => [esc(r.vessel), esc(r.g), r.arr ? dmy(r.arr) : '—', r.dep ? dmy(r.dep) : '—', `<b>${mlab(r.m)}</b>`, fmtN(r.tons), esc(r.route), esc(r.bl)]), 24) : '<p class="sub">Переходящих рейсов нет.</p>';
  // t3 vessels/owners
  const Y3 = BLF.t3, T3 = Y3 === 'all' ? CR : CR.filter(r => r.y === Y3);
  const vv = {}; T3.forEach(r => { const o = vv[r.vessel] = vv[r.vessel] || { g: r.g, own: new Set(), n: 0, t: 0, b: 0, m: 0 }; o.n++; o.t += r.tons; if (r.route === 'Баку') o.b += r.tons; if (r.route === 'Махачкала') o.m += r.tons; if (r.owner && r.owner !== 'не указан') o.own.add(r.owner); });
  document.getElementById('blt3-sub').innerHTML = `Все танкеры в файле перевалки. «Судовладелец по файлу» — как записано в графе «Судовладелец» (в 2023 там часто фрахтователь). Год:` + ySel('t3', Y3, true);
  document.getElementById('blt3').innerHTML = tblFold(['Судно', 'Перевозчик (группа)', 'Судовладелец по файлу', 'Партий', 'Тонн', 'на Баку', 'на Махачкалу'], Object.entries(vv).sort((a, b) => b[1].t - a[1].t).map(([v, o]) => [esc(v), esc(o.g), esc([...o.own].join(', ')), fmtN(o.n), fmtN(o.t), fmtN(o.b), fmtN(o.m)]), 30);
  document.querySelectorAll('#p-oil .ysel').forEach(sel => sel.onchange = () => { BLF[sel.dataset.key] = sel.value; renderOilBL(Y); });
}

/* ===== МР ===== */
const MRK = {
  oil: { main: [['oil_casp', 'Каспий всего'], ['oil_makh', 'Актау → Махачкала'], ['oil_baku', 'Актау → Баку']], extra: [['oil_total', 'Нефть всего (Каспий + открытые моря)'], ['oil_open', 'Открытые моря']], unit: 'тыс. т', chart: ['oil_makh', 'oil_baku'] },
  cnt: { main: [['teu_total', 'Всего'], ['teu_ab', 'Актау → Баку'], ['teu_ba', 'Баку → Актау'], ['teu_ai', 'Актау → Иран'], ['teu_ia', 'Иран → Актау']], extra: [['teu_ab_barys', 'А→Б Барыс'], ['teu_ab_sunkar', 'А→Б Сункар'], ['teu_ab_berkut', 'А→Б Беркут'], ['teu_ab_turkestan', 'А→Б Туркестан'], ['teu_ab_beket', 'А→Б Бекет-Ата'], ['teu_ba_barys', 'Б→А Барыс'], ['teu_ba_sunkar', 'Б→А Сункар'], ['teu_ba_berkut', 'Б→А Беркут'], ['teu_ba_turkestan', 'Б→А Туркестан'], ['teu_ba_beket', 'Б→А Бекет-Ата'], ['bulk_total', 'Сухие грузы, тыс. т']], unit: 'TEU', chart: ['teu_ab', 'teu_ba', 'teu_ai', 'teu_ia'] },
  os: { main: [['oil_open', 'Открытые моря всего'], ['oil_bs_in', 'внутри Чёрного моря'], ['oil_bs_out', 'за пределами Чёрного моря']], extra: [['oil_bs_in_kmgt_own', 'внутри ЧМ · KMG Trading · собств. флот'], ['oil_bs_in_kmgt_chart', 'внутри ЧМ · KMG Trading · зафрахт.'], ['oil_bs_in_3rd_own', 'внутри ЧМ · сторонние · собств.'], ['oil_bs_in_3rd_chart', 'внутри ЧМ · сторонние · зафрахт.'], ['oil_bs_out_kmgt_own', 'за ЧМ · KMG Trading · собств.'], ['oil_bs_out_kmgt_chart', 'за ЧМ · KMG Trading · зафрахт.'], ['oil_bs_out_3rd_own', 'за ЧМ · сторонние · собств.'], ['oil_bs_out_3rd_chart', 'за ЧМ · сторонние · зафрахт.'], ['os_total', 'Собств. флот (Altai+Alatau) всего'], ['os_in', 'Собств. флот · внутри ЧМ'], ['os_in_alatau', '· Alatau'], ['os_in_altai', '· Altai'], ['os_out', 'Собств. флот · за пределами ЧМ'], ['os_out_alatau', '· Alatau'], ['os_out_altai', '· Altai']], unit: 'тыс. т', chart: ['oil_bs_in', 'oil_bs_out'] },
};
function renderMR(kind, Y, ids) {
  const g = chartBase(), C = COLS(), K = MRK[kind];
  const rows = MRM.filter(r => r.m.startsWith(Y)); const cums = Object.keys(MRC).filter(p => p.startsWith(Y)).sort();
  const last = cums[cums.length - 1];
  const dec = K.unit === 'TEU' ? 0 : 0;
  const lab = r => r.span > 1 ? `${MON[+r.m.slice(5, 7) - r.span]}–${MON[+r.m.slice(5, 7) - 1]} ${Y.slice(2)} (${r.span} мес.)` : mlab(r.m);
  // kpis: latest cumulative report
  let k = '';
  if (last) {
    const F = MRC[last].fact, P = MRC[last].plan, PY = MRC[last].plan_year, PR = MRC[last].prev;
    const per = `январь–${['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][+last.slice(5, 7) - 1]} ${Y}`;
    k = K.main.map(([key, name]) => (F[key] == null || (!F[key] && !P[key])) ? '' : kp2(`${name} · ${per}`, fmtN(F[key], dec) + ' ' + K.unit, `${P[key] != null ? 'план ' + fmtN(P[key], dec) + ' (' + fmtN(100 * F[key] / (P[key] || 1)) + ' %)' : ''}${PR[key] != null ? ' · ' + (+Y - 1) + ': ' + fmtN(PR[key], dec) : ''}${PY[key] != null ? ' · план года ' + fmtN(PY[key], dec) : ''}`)).join('');
  }
  document.getElementById(ids.kpis).innerHTML = k || '<p class="sub">За этот год МР-отчётов нет.</p>';
  // chart 1: monthly derived
  const ch = K.chart.filter(key => rows.some(r => r.v[key] != null));
  legend(ids.c1 + '-leg', ch.map((key, i) => [K.main.concat(K.extra).find(x => x[0] === key)[1], C[i]]));
  document.getElementById(ids.c1 + '-sub').textContent = `${Y}: помесячные значения = разность накопительных отчётов. Диапазон в подписи — если между отчётами больше месяца.`;
  mk(ids.c1, { type: 'bar', data: { labels: rows.map(lab), datasets: ch.map((key, i) => stackDs(K.main.concat(K.extra).find(x => x[0] === key)[1], rows.map(r => r.v[key] ?? 0), C[i])) }, options: stackOpts(g, K.unit, dec) });
  // chart 2: cumulative fact vs plan (main[0]) — or per vessel for containers
  if (kind === 'cnt') {
    const vs = ['barys', 'sunkar', 'berkut', 'turkestan', 'beket'], vn = { barys: 'Барыс', sunkar: 'Сункар', berkut: 'Беркут', turkestan: 'Туркестан', beket: 'Бекет-Ата' };
    const F = last ? MRC[last].fact : {};
    legend(ids.c2 + '-leg', [['Актау → Баку', C[0]], ['Баку → Актау', C[1]]]);
    document.getElementById(ids.c2 + '-sub').textContent = last ? `Нарастающим итогом по отчёту за ${MRC[last].src.replace(/\.(pptx|pdf)$/i, '')}` : '';
    mk(ids.c2, { type: 'bar', data: { labels: vs.map(v => vn[v]), datasets: [stackDs('Актау → Баку', vs.map(v => F['teu_ab_' + v] ?? 0), C[0]), stackDs('Баку → Актау', vs.map(v => F['teu_ba_' + v] ?? 0), C[1])] }, options: stackOpts(g, 'TEU', 0) });
  } else {
    const key0 = kind === 'oil' ? 'oil_casp' : 'oil_open';
    legend(ids.c2 + '-leg', [['Факт', C[0]], ['План', css('--ink-3')]]);
    document.getElementById(ids.c2 + '-sub').textContent = `${K.main[0][1]} нарастающим итогом с начала года по каждому отчёту.`;
    mk(ids.c2, { type: 'line', data: { labels: cums.map(p => mlab(p)), datasets: [{ label: 'Факт', data: cums.map(p => MRC[p].fact[key0]), borderColor: C[0], backgroundColor: C[0], borderWidth: 2, pointRadius: 3, tension: .2 }, { label: 'План', data: cums.map(p => MRC[p].plan[key0]), borderColor: css('--ink-3'), backgroundColor: css('--ink-3'), borderWidth: 2, borderDash: [5, 4], pointRadius: 3, tension: .2 }] },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y)} ${K.unit}` } } }, scales: { x: { grid: { display: false }, border: g.border }, y: { grid: g.grid, border: { display: false }, beginAtZero: true } } } });
  }
  // t1 monthly
  const allk = K.main.concat(K.extra).filter(([key]) => rows.some(r => r.v[key] != null));
  document.getElementById(ids.t1 + '-sub').textContent = 'Разность между соседними накопительными отчётами; в скобках — план на тот же период (если есть в отчёте).';
  document.getElementById(ids.t1).innerHTML = rows.length ? tbl(['Период', ...allk.map(x => x[1])], rows.map(r => [lab(r), ...allk.map(([key]) => r.v[key] == null ? '—' : fmtN(r.v[key], dec) + (r.plan[key] != null ? ` <span class="sub">(${fmtN(r.plan[key], dec)})</span>` : ''))])) : '<p class="sub">Нет данных.</p>';
  // t2 cumulative
  document.getElementById(ids.t2 + '-sub').textContent = 'Как в отчёте: факт с начала года / план на период / % / факт за тот же период прошлого года.';
  document.getElementById(ids.t2).innerHTML = cums.length ? tbl(['Отчёт', ...allk.map(x => x[1])], cums.map(p => { const F = MRC[p].fact, P = MRC[p].plan, PR = MRC[p].prev; return [`<b>${mlab(p)}</b><br><span class="sub">${esc(MRC[p].src.replace(/\.(pptx|pdf)$/i, ''))}</span>`, ...allk.map(([key]) => F[key] == null ? '—' : `<b>${fmtN(F[key], dec)}</b>${P[key] != null ? ' / ' + fmtN(P[key], dec) + ' / ' + fmtN(100 * F[key] / (P[key] || 1)) + ' %' : ''}${PR[key] != null ? '<br><span class="sub">' + (+Y - 1) + ': ' + fmtN(PR[key], dec) + '</span>' : ''}`)]; })) : '<p class="sub">Нет данных.</p>';
}

/* ===== открытые моря: рейсы KMTF UK ===== */
const osYears = [...new Set(OSV.map(r => r.y))].sort();
const oy = document.getElementById('osv-year'); osYears.forEach(y => oy.add(new Option(y, y))); oy.value = osYears[osYears.length - 1] || ''; oy.onchange = renderOSV;
const mrYears = [...new Set(Object.keys(MRC).map(p => p.slice(0, 4)))];
mrYears.forEach(y => { if (![...vy.options].some(o => o.value === y)) { vy.add(new Option(y, y)); vy2.add(new Option(y, y)); } });
function renderOSV() {
  const Y = oy.value; const sub = subOf('osv');
  if (sub === 'mr') { renderMR('os', Y, { kpis: 'mr-os-kpis', c1: 'mrsc1', c2: 'mrsc2', t1: 'mrst1', t2: 'mrst2' }); document.getElementById('osv-note').textContent = 'МР-отчёт для руководства: объёмы по открытым морям считаются по документам на оплату (бухгалтерский учёт), поэтому отличаются от рейсового файла KMTF UK.'; renderMRos2(Y); return; }
  const g = chartBase(), C = COLS();
  const T = OSV.filter(r => r.y === +Y);
  const FL = ['Own fleet', 'ADP fleet', '3rd party'], FN = { 'Own fleet': 'Собственный флот (Altai, Alatau)', 'ADP fleet': 'Флот AD Ports', '3rd party': 'Сторонний флот' }, FC = { 'Own fleet': C[0], 'ADP fleet': C[2], '3rd party': css('--ink-3') };
  const nowY = new Date().getFullYear(), curYear = +Y === nowY;
  const maxMo = T.length ? Math.max(...T.map(r => r.mo)) : 1;
  const months = Array.from({ length: curYear ? maxMo : 12 }, (_, i) => i + 1);
  const sum = (arr, f) => arr.filter(f || (() => true)).reduce((a, r) => a + r.loaded, 0);
  document.getElementById('osv-note').textContent = `Файл «Own Fleet – analysed + Transportation summary» (Kazmortransflot UK, Ольга Васюра, еженедельно) на ${dmy(D.openseas_src)}.${D.openseas_src.slice(0, 4)}: все рейсы KMG Trading и сторонних фрахтователей собственным, AD Ports и сторонним флотом с 2012 г. Тонны — погружено по коносаменту; месяц — по дате коносамента. Ставки и выручка на дашборд не выводятся.`;
  const blk = (label, f, short) => { const A = T.filter(f); return kp2(label + ' · всего', fmtN(sum(A) / 1000, 1) + ' тыс. т', `${A.length} рейсов`) + FL.filter(fl => !short || fl === 'Own fleet').map(fl => kp2(`${label} · ${FN[fl]}`, fmtN(sum(A, r => r.fleet === fl) / 1000, 1) + ' тыс. т', `${A.filter(r => r.fleet === fl).length} рейсов${fl === 'Own fleet' ? ' · Altai ' + fmtN(sum(A, r => r.ship === 'Altai') / 1000, 1) + ' · Alatau ' + fmtN(sum(A, r => r.ship === 'Alatau') / 1000, 1) : ''}`)).join(''); };
  document.getElementById('osv-kpis').innerHTML = blk(curYear ? `Этот месяц (${['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][maxMo - 1]})` : 'Декабрь', r => r.mo === maxMo, true) + blk(Y + (curYear ? ' с начала года' : ' год'), r => true);
  const ml = m => `${MON[m - 1]} ${String(Y).slice(2)}`;
  legend('osc1-leg', FL.map(fl => [FN[fl], FC[fl]]));
  document.getElementById('osc1-sub').textContent = `${Y}, по флоту`;
  mk('osc1', { type: 'bar', data: { labels: months.map(ml), datasets: FL.map(fl => stackDs(FN[fl], months.map(m => sum(T, r => r.mo === m && r.fleet === fl) / 1000), FC[fl])) }, options: stackOpts(g, 'тыс. т') });
  const regs = [...new Set(T.map(r => r.region || '—'))].sort((a, b) => sum(T, r => (r.region || '—') === b) - sum(T, r => (r.region || '—') === a)).slice(0, 6);
  const RC = [C[0], C[1], C[2], C[3], C[4], css('--ink-3')];
  legend('osc2-leg', regs.map((r, i) => [r, RC[i]]));
  document.getElementById('osc2-sub').textContent = `${Y}, регион погрузки – регион выгрузки (топ-6)`;
  mk('osc2', { type: 'bar', data: { labels: months.map(ml), datasets: regs.map((rg, i) => stackDs(rg, months.map(m => sum(T, r => r.mo === m && (r.region || '—') === rg) / 1000), RC[i])) }, options: stackOpts(g, 'тыс. т') });
  legend('osc3-leg', [['Altai', C[0]], ['Alatau', C[1]]]);
  document.getElementById('osc3-sub').textContent = `${Y}, собственный флот`;
  mk('osc3', { type: 'bar', data: { labels: months.map(ml), datasets: [['Altai', C[0]], ['Alatau', C[1]]].map(([sh, c]) => stackDs(sh, months.map(m => sum(T, r => r.mo === m && r.ship === sh) / 1000), c)) }, options: stackOpts(g, 'тыс. т') });
  const ys = osYears.filter(y => y >= 2018);
  legend('osc4-leg', FL.map(fl => [FN[fl], FC[fl]]));
  document.getElementById('osc4-sub').textContent = 'Погружено за год, по флоту (текущий год — по ' + dmy(D.openseas_src) + ')';
  mk('osc4', { type: 'bar', data: { labels: ys.map(String), datasets: FL.map(fl => stackDs(FN[fl], ys.map(y => sum(OSV, r => r.y === y && r.fleet === fl) / 1e6), FC[fl])) }, options: stackOpts(g, 'млн т', 2) });
  // t1
  const rows1 = months.map(m => [ml(m), ...FL.map(fl => fmtN(sum(T, r => r.mo === m && r.fleet === fl))), fmtN(sum(T, r => r.mo === m)), fmtN(T.filter(r => r.mo === m).length), fmtN(sum(T, r => r.mo === m && r.ship === 'Altai')), fmtN(sum(T, r => r.mo === m && r.ship === 'Alatau'))]);
  rows1.push([`<b>Итого ${Y}</b>`, ...FL.map(fl => `<b>${fmtN(sum(T, r => r.fleet === fl))}</b>`), `<b>${fmtN(sum(T))}</b>`, `<b>${T.length}</b>`, `<b>${fmtN(sum(T, r => r.ship === 'Altai'))}</b>`, `<b>${fmtN(sum(T, r => r.ship === 'Alatau'))}</b>`]);
  document.getElementById('ost1-sub').textContent = 'Тонны по месяцу коносамента.';
  document.getElementById('ost1').innerHTML = tbl(['Месяц', ...FL.map(fl => FN[fl]), 'Всего, т', 'Рейсов', 'Altai, т', 'Alatau, т'], rows1);
  // t2 ships
  const vv = {}; T.forEach(r => { const o = vv[r.ship] = vv[r.ship] || { fl: r.fleet, n: 0, t: 0, ch: {}, rg: {} }; o.n++; o.t += r.loaded; o.ch[r.charterer] = (o.ch[r.charterer] || 0) + r.loaded; o.rg[r.region] = (o.rg[r.region] || 0) + r.loaded; });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join(', ');
  document.getElementById('ost2-sub').textContent = `${Y}: по судам (собственный флот — сверху).`;
  document.getElementById('ost2').innerHTML = tblFold(['Судно', 'Флот', 'Рейсов', 'Тонн', 'Ср. партия, т', 'Основные фрахтователи', 'Основные маршруты'], Object.entries(vv).sort((a, b) => (a[1].fl === 'Own fleet' ? 0 : 1) - (b[1].fl === 'Own fleet' ? 0 : 1) || b[1].t - a[1].t).map(([v, o]) => [esc(v), esc(FN[o.fl] || o.fl), fmtN(o.n), fmtN(o.t), fmtN(o.t / o.n), esc(top(o.ch)), esc(top(o.rg))]), 20);
  // t3 voyages
  document.getElementById('ost3-sub').textContent = `${Y}: все рейсы по дате коносамента. «Сдано на отчётную дату» — часть груза, сданная к дате файла (переходящие рейсы).`;
  document.getElementById('ost3').innerHTML = tblFold(['Коносамент', 'Судно', 'Флот', 'Фрахтователь', 'Погрузка', 'Выгрузка', 'Регион', 'Плечо', 'Погружено, т', 'Сдано на отч. дату, т'], T.slice().sort((a, b) => b.bl.localeCompare(a.bl)).map(r => [r.bl ? dmy(r.bl) : '—', esc(r.ship), esc(FN[r.fleet] || r.fleet), esc(r.charterer), esc(r.load_port), esc(r.disch_port), esc(r.region), esc(r.distance), fmtN(r.loaded), r.delivered != null ? fmtN(r.delivered) : '']), 25);
}
function renderMRos2(Y) {
  // второй график МР для открытых морей: собственный флот Altai/Alatau внутри/за пределами ЧМ (нарастающим итогом, последний отчёт)
  const g = chartBase(), C = COLS(); const cums = Object.keys(MRC).filter(p => p.startsWith(Y)).sort(); const last = cums[cums.length - 1]; if (!last) return;
  const F = MRC[last].fact;
  legend('mrsc2-leg', [['внутри Чёрного моря', C[0]], ['за пределами Чёрного моря', C[1]]]);
  document.getElementById('mrsc2-sub').textContent = `Нарастающим итогом по отчёту за ${MRC[last].src.replace(/\.(pptx|pdf)$/i, '')}`;
  mk('mrsc2', { type: 'bar', data: { labels: ['Altai', 'Alatau'], datasets: [stackDs('внутри Чёрного моря', [F.os_in_altai ?? 0, F.os_in_alatau ?? 0], C[0]), stackDs('за пределами Чёрного моря', [F.os_out_altai ?? 0, F.os_out_alatau ?? 0], C[1])] }, options: stackOpts(g, 'тыс. т', 0) });
}


/* ===== отраслевые новости (левый блок) ===== */
const NEWS = (D.news && D.news.items) || [];
const NEWS_CAT = { frt: ['фрахт', 'freight', 'aframax', 'афрамакс', 'suezmax', 'суэцмакс', 'ставк', 'rates', 'charter'], cpc: ['ктк', 'cpc', 'джейхан', 'ceyhan', 'btc', 'бтд', 'новороссийск', 'novorossiysk', 'caspian pipeline'], bnk: ['бункер', 'bunker', 'vlsfo', 'mgo'], tmtm: ['тмтм', 'транскаспий', 'средний коридор', 'middle corridor', 'trans-caspian', 'titr', 'грузооборот', 'teu', 'курык', 'kuryk', 'порт актау', 'aktau port', 'port of aktau'], casp: ['каспи', 'caspian'], tmtm: ['тмтм', 'транскаспий', 'средний коридор', 'middle corridor', 'trans-caspian', 'titr'], ports: ['порт', 'port', 'актау', 'курык', 'aktau', 'kuryk', 'алят', 'alat', 'баку', 'baku'], kmtf: ['казмортрансфлот', 'кмтф', 'kazmortransflot', 'kmtf', 'аско', 'asco', 'казмунайгаз', 'kazmunay'], oil: ['нефт', 'oil', 'танкер', 'tanker', 'джейхан', 'ceyhan', 'ктк', 'cpc'] };
let NF = 'all';
function renderNews() {
  const box = document.getElementById('news-l'); if (!box) return;
  const list = NEWS.filter(n => NF === 'all' || NEWS_CAT[NF].some(k => n.t.toLowerCase().includes(k)));
  document.getElementById('news-sub').textContent = D.news && D.news.fetched ? `Каспий · ТМТМ · порты · флот · обновлено ${dmy(D.news.fetched)} UTC` : 'Каспий · ТМТМ · порты · флот';
  if (!list.length) { box.innerHTML = `<div class="ni"><div class="m">${NEWS.length ? 'По этому фильтру новостей нет.' : 'Новости появятся после первого сбора на сервере.'}</div></div>`; return; }
  box.innerHTML = list.slice(0, 80).map(n => `<div class="ni"><a href="${esc(n.u)}" target="_blank" rel="noopener"${n.t_en ? ' title="' + esc(n.t_en) + '"' : ''}>${esc(n.t)}</a><div class="m">${dmy(n.d)} · ${esc(n.s)}${n.t_en ? ' · перевод' : ''}</div></div>`).join('');
}
document.querySelectorAll('#news-f button').forEach(b => b.onclick = () => { document.querySelectorAll('#news-f button').forEach(x => x.setAttribute('aria-pressed', x === b)); NF = b.dataset.v; renderNews(); });
renderNews();


/* ===== рынок и среда ===== */
const MK = D.market || {};
const lastOf = obj => { const ks = Object.keys(obj || {}).sort(); return ks.length ? [ks[ks.length - 1], obj[ks[ks.length - 1]]] : [null, null]; };
const prevOf = (obj, key) => { const ks = Object.keys(obj || {}).sort(); const i = ks.indexOf(key); for (let j = i - 1; j >= 0; j--) if (obj[ks[j]] != null) return obj[ks[j]]; return null; };
function seaSeries() {
  const s = MK.sea || {};
  if (s.dahiti && s.dahiti.series) return { ser: s.dahiti.series, unit: 'м, абс. высота (DAHITI)', src: s.dahiti.src, abs: true };
  if (s.grealm && s.grealm.series) return { ser: s.grealm.series, unit: 'м, отклонение от среднего (G-REALM)', src: s.grealm.src, abs: false };
  return null;
}
function renderIndicators() {
  const el = document.getElementById('news-ind'); if (!el) return;
  const items = [];
  const [fd, fx] = lastOf(MK.fx); if (fx) { const pv = prevOf(MK.fx, fd) || {}; const dlt = (k) => pv[k] != null ? `<small class="${fx[k] >= pv[k] ? 'up' : 'dn'}">${fx[k] >= pv[k] ? '▲' : '▼'}${fmtN(Math.abs(fx[k] - pv[k]), 2)}</small>` : ''; items.push(['USD/KZT', fmtN(fx.USD, 2) + dlt('USD')]); if (fx.RUB) items.push(['RUB/KZT', fmtN(fx.RUB, 2) + dlt('RUB')]); }
  const [od, oil] = lastOf(MK.oil); if (oil && oil.brent != null) { const pv = prevOf(MK.oil, od) || {}; items.push(['Brent, $', fmtN(oil.brent, 2) + (pv.brent != null ? `<small class="${oil.brent >= pv.brent ? 'up' : 'dn'}">${oil.brent >= pv.brent ? '▲' : '▼'}${fmtN(Math.abs(oil.brent - pv.brent), 2)}</small>` : '')]); }
  if (MK.vkk && MK.vkk.latest) items.push(['ВКК осадка', fmtN(MK.vkk.latest.draft, 2) + ` м<small>${esc(MK.vkk.latest.date.slice(0, 5))}</small>`]);
  const b = MK.bunker && MK.bunker.latest; if (b && b.ports && b.ports.G20) items.push(['VLSFO G20, $/т', fmtN(b.ports.G20.VLSFO || b.ports.G20.MGO)]);
  const sn = MK.sanctions; if (sn) items.push(['Санкции', (sn.matches || []).length ? `<span class="dn">${sn.matches.length} совп.</span>` : '<span class="up">чисто</span>']);
  el.innerHTML = items.map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');
  if (!items.length) el.hidden = true;
}
function newsList(id, cat, n = 30) {
  const box = document.getElementById(id); if (!box) return;
  const list = NEWS.filter(x => NEWS_CAT[cat].some(k => x.t.toLowerCase().includes(k))).slice(0, n);
  box.innerHTML = list.length ? list.map(x => `<div class="ni"><a href="${esc(x.u)}" target="_blank" rel="noopener"${x.t_en ? ' title="' + esc(x.t_en) + '"' : ''}>${esc(x.t)}</a><div class="m">${dmy(x.d)} · ${esc(x.s)}${x.t_en ? ' · перевод' : ''}</div></div>`).join('') : '<div class="ni"><div class="m">Пока пусто — наполнится после сбора новостей на сервере.</div></div>';
}
function renderMkt() {
  const g = chartBase(), C = COLS();
  document.getElementById('mkt-note').textContent = MK.fetched ? `Внешние данные обновляются на сервере раз в сутки; последний сбор ${dmy(MK.fetched)} UTC. Источники: Нацбанк РК, FRED (EIA), DAHITI/USDA G-REALM, Казгидромет, Ship & Bunker, OFAC/OFSI/ЕС.${Object.keys(MK.errors || {}).length ? ' Недоступно сейчас: ' + Object.keys(MK.errors).join(', ') + '.' : ''}` : 'Внешние данные появятся после первого сбора на сервере.';
  const [fd, fx] = lastOf(MK.fx), [od, oil] = lastOf(MK.oil), ss = seaSeries();
  let k = '';
  if (fx) k += kp2('USD/KZT · ' + dmy(fd), fmtN(fx.USD, 2), fx.EUR ? 'EUR ' + fmtN(fx.EUR, 2) + (fx.CNY ? ' · CNY ' + fmtN(fx.CNY, 2) : '') : '') + (fx.RUB ? kp2('RUB/KZT · ' + dmy(fd), fmtN(fx.RUB, 2), '') : '');
  if (oil) k += kp2('Brent · ' + dmy(od), oil.brent != null ? fmtN(oil.brent, 2) + ' $' : '—', oil.wti != null ? 'WTI ' + fmtN(oil.wti, 2) + ' $' : '');
  if (MK.vkk && MK.vkk.latest) k += kp2('ВКК проходная осадка · ' + MK.vkk.latest.date, fmtN(MK.vkk.latest.draft, 2) + ' м', 'Волго-Каспийский канал, АМП Астрахань');
  { const DR0 = D.drafts || {}; const a5 = DR0['Актау · танкеры пр.5']; if (a5) { const [m5, v5] = lastOf(a5); k += kp2('Актау, танкеры · ' + mlab(m5), fmtN(v5.max, 2) + ' м', `макс. фактическая осадка при отходе (пр.5, ${v5.n} судозаходов)`); } }
  const b = MK.bunker && MK.bunker.latest; if (b && b.ports && b.ports.G20) k += kp2('VLSFO, 20 портов · ' + dmy(b.date), fmtN(b.ports.G20.VLSFO) + ' $/т', 'MGO ' + fmtN(b.ports.G20.MGO) + (b.ports.G20.IFO380 ? ' · IFO380 ' + fmtN(b.ports.G20.IFO380) : ''));
  const sn = MK.sanctions; if (sn) k += kp2('Санкции · ' + dmy(sn.checked), (sn.matches || []).length ? `<span class="dn">${sn.matches.length} совпадений</span>` : '<span class="up">совпадений нет</span>', `проверено ${sn.n_ours || 0} названий по ${Object.keys(sn.lists || {}).length} спискам`);
  document.getElementById('mkt-kpis').innerHTML = k || '<p class="sub">Данных пока нет.</p>';
  const line = (label, data, col, dash) => ({ label, data, borderColor: col, backgroundColor: col, borderWidth: 2, pointRadius: 0, tension: .2, spanGaps: true, borderDash: dash || [] });
  const noLab = { plugins: [] };
  // fx
  const fks = Object.keys(MK.fx || {}).sort().slice(-400);
  legend('mkc1-leg', [['USD/KZT', C[0]], ['RUB/KZT ×100', C[1]]]);
  document.getElementById('mkc1-sub').textContent = fks.length ? `Официальные курсы НБК с ${dmy(fks[0])} по ${dmy(fks[fks.length - 1])}` : 'Нет данных';
  mkNoLabels('mkc1', { type: 'line', data: { labels: fks.map(d => d.slice(2)), datasets: [line('USD/KZT', fks.map(d => MK.fx[d].USD), C[0]), line('RUB/KZT ×100', fks.map(d => MK.fx[d].RUB != null ? MK.fx[d].RUB * 100 : null), C[1])] }, options: lineOpts(g, '') });
  const oks = Object.keys(MK.oil || {}).sort().slice(-400);
  legend('mkc2-leg', [['Brent', C[0]], ['WTI', C[1]]]);
  document.getElementById('mkc2-sub').textContent = oks.length ? `FRED/EIA, дневные цены спот, с ${dmy(oks[0])}` : 'Нет данных';
  mkNoLabels('mkc2', { type: 'line', data: { labels: oks.map(d => d.slice(2)), datasets: [line('Brent', oks.map(d => MK.oil[d].brent), C[0]), line('WTI', oks.map(d => MK.oil[d].wti), C[1])] }, options: lineOpts(g, '$') });
  // осадки по портам (из наших сводок)
  const DR = D.drafts || {};
  const drMonths = [...new Set(Object.values(DR).flatMap(o => Object.keys(o)))].sort();
  const last24 = drMonths.slice(-24);
  const drLine = (name, col, key = 'max') => Object.assign(line(name, last24.map(m => DR[name] && DR[name][m] ? DR[name][m][key] : null), col), { pointRadius: 2, spanGaps: true });
  const akt = Object.keys(DR).filter(k => k.startsWith('Актау') && Object.keys(DR[k]).length > 12);
  legend('mkc3-leg', akt.map((k, i) => [k.replace('Актау · ', ''), C[i % 5]]));
  document.getElementById('mkc3-sub').textContent = 'Максимальная осадка судна за месяц по нашим сводкам (танкеры — осадка при отходе по причалам КТО, сухогрузы/контейнеровозы — приход и отход). Показывает, с какой осадкой реально ходят.';
  mkNoLabels('mkc3', { type: 'line', data: { labels: last24.map(mlab), datasets: akt.map((k, i) => drLine(k, C[i % 5])) }, options: lineOpts(g, 'м', 2) });
  const oth = Object.keys(DR).filter(k => !k.startsWith('Актау') && Object.keys(DR[k]).length > 3);
  legend('mkc4-leg', oth.map((k, i) => [k, C[i % 5]]));
  document.getElementById('mkc4-sub').textContent = 'Максимальная осадка за месяц по судам в сводках (Сангачал — танкеры под погрузкой, Алят/Баку и Курык — контейнеровозы и сухогрузы).';
  mkNoLabels('mkc4', { type: 'line', data: { labels: last24.map(mlab), datasets: oth.map((k, i) => drLine(k, C[i % 5])) }, options: lineOpts(g, 'м', 2) });
  const vk = MK.vkk || {};
  document.getElementById('mk-vkk').innerHTML = vk.latest ? `<p class="sub" style="margin:6px 0">На <b>${esc(vk.latest.date)}</b>: проходная осадка <b>${fmtN(vk.latest.draft, 2)} м</b> (минимум по лимитирующим участкам${vk.latest.sections && vk.latest.sections.length ? ': ' + vk.latest.sections.map(x => `${x.km} км — глубина ${fmtN(x.depth, 2)}, осадка ${fmtN(x.draft, 2)}`).join('; ') : ''}). Источник: <a href="https://ampastra.ru/slujba_kapitana_morskogo_porta_astrahan/109-registratsiya_sudov/109-promeryi.html" target="_blank" rel="noopener">${esc(vk.latest.src)}</a>, публикуется в 08:00 и 20:00.</p>` : '<p class="sub" style="margin:6px 0">Данные АМП Астрахань появятся после сбора на сервере. <a href="https://ampastra.ru/slujba_kapitana_morskogo_porta_astrahan/109-registratsiya_sudov/109-promeryi.html" target="_blank" rel="noopener">Открыть источник</a>.</p>';
  const vks = Object.keys(vk.history || {}).sort();
  mkNoLabels('mkc5', { type: 'line', data: { labels: vks.map(d => d.slice(5)), datasets: [Object.assign(line('Проходная осадка ВКК', vks.map(d => vk.history[d]), C[0]), { pointRadius: 2, stepped: true })] }, options: lineOpts(g, 'м', 2) });
  // таблица осадок: последние 6 месяцев
  const l6 = drMonths.slice(-6);
  document.getElementById('mkt3-sub').textContent = 'Макс. / 90-й перцентиль / число наблюдений за месяц.';
  document.getElementById('mkt3').innerHTML = tbl(['Порт · тип', ...l6.map(mlab)], Object.keys(DR).filter(k => l6.some(m => DR[k][m])).map(k => [esc(k), ...l6.map(m => DR[k][m] ? `<b>${fmtN(DR[k][m].max, 2)}</b> / ${fmtN(DR[k][m].p90, 2)} <span class="sub">(${DR[k][m].n})</span>` : '—')]));
  // ice / kazhydromet
  const kh = MK.kazhydromet || {};
  document.getElementById('mk-ice').innerHTML = `<p class="sub" style="margin:6px 0">${kh.ice ? `Последний обзор ледовой обстановки (Северный Каспий): <b>${dmy(kh.ice.date)}.${kh.ice.date.slice(0, 4)}</b> — <a href="${esc(kh.ice.url)}" target="_blank" rel="noopener">открыть PDF</a> (всего обзоров на сайте: ${kh.ice.n}). Обзоры выходят в ледовый сезон (декабрь–март).` : 'Обзоры ледовой обстановки Казгидромета: ссылка появится после сбора данных.'}</p>
    <p class="sub" style="margin:6px 0">${kh.level_forecast ? `Прогноз уровня Каспийского моря (Казгидромет): <a href="${esc(kh.level_forecast.url)}" target="_blank" rel="noopener">последний PDF</a>.` : ''} Другие источники: <a href="https://www.kazhydromet.kz/ru/kaspiyskoe-more/obzor-ledovoy-obstanovki" target="_blank" rel="noopener">Казгидромет — лёд</a> · <a href="https://data.aari.ru/odata/_f0011_.php" target="_blank" rel="noopener">ААНИИ — ледовые карты</a> · <a href="https://meteoinfo.ru/current-sea-ice" target="_blank" rel="noopener">Гидрометцентр РФ — ледовый покров морей</a> · <a href="https://dahiti.dgfi.tum.de/en/39/" target="_blank" rel="noopener">DAHITI — уровень Каспия</a>.</p>`;
  if (ss) { const ks = Object.keys(ss.ser).sort().slice(-120); document.getElementById('mkc6-box').hidden = false; mkNoLabels('mkc6', { type: 'line', data: { labels: ks.map(x => x.slice(2, 7)), datasets: [Object.assign(line('Уровень Каспия, ' + ss.unit, ks.map(x => ss.ser[x]), C[1]), { pointRadius: 1 })] }, options: lineOpts(g, 'м', 2) }); } else document.getElementById('mkc6-box').hidden = true;
  // bunker
  if (b && b.ports) {
    const ports = Object.keys(b.ports);
    document.getElementById('mkt1-sub').textContent = `${b.src}. Дата: ${dmy(b.date)}. G20 — средняя по 20 крупнейшим портам мира.`;
    document.getElementById('mkt1').innerHTML = tbl(['Порт', 'VLSFO', 'MGO', 'IFO380'], ports.map(p => [p === 'G20' ? 'Средняя 20 портов' : p, fmtN(b.ports[p].VLSFO), fmtN(b.ports[p].MGO), fmtN(b.ports[p].IFO380)]));
  } else { document.getElementById('mkt1-sub').textContent = 'Нет данных (источник недоступен).'; document.getElementById('mkt1').innerHTML = ''; }
  // sanctions
  if (sn) {
    document.getElementById('mkt2-sub').textContent = `Сверка названий наших судов, судов-контрагентов по открытым морям, фрахтователей и компаний (Khazar, Caspiy Shipping, AB Fleet, ASCO, KMG Trading, Vector Energy и др.) со списками: ${Object.entries(sn.lists || {}).map(([n, v]) => `${n} (${fmtN(v.n)} записей)`).join(', ')}. Совпадение по имени — повод проверить IMO вручную, а не приговор.`;
    document.getElementById('mkt2').innerHTML = (sn.matches || []).length ? tbl(['Наше название', 'Какое отношение к нам', 'В списке как', 'Список', 'Тип', 'Программа'], sn.matches.map(m => [`<b>${esc(m.ours)}</b>`, esc(m.rel || ''), esc(m.name), esc(m.list), esc(m.type), esc(m.program)])) : '<p class="sub">Совпадений нет.</p>';
  } else { document.getElementById('mkt2-sub').textContent = 'Проверка появится после сбора данных на сервере.'; }
  newsList('mk-news-frt', 'frt'); newsList('mk-news-tmtm', 'tmtm'); newsList('mk-news-cpc', 'cpc'); newsList('mk-news-bnk', 'bnk');
}
function lineOpts(g, unit, d = 2) { return { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtN(c.parsed.y, d)} ${unit}` } } }, scales: { x: { grid: { display: false }, border: g.border, ticks: { maxTicksLimit: 12, maxRotation: 0 } }, y: { grid: g.grid, border: { display: false } } } }; }
function mkNoLabels(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart(document.getElementById(id), cfg); }
renderIndicators();
