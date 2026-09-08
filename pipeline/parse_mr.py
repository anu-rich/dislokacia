"""Извлечение производственных показателей из МР-отчётов (отчёт для руководства, накопительно с начала года).
python3 parse_mr.py <out.json> <pptx|pdf ...>
Результат: {"YYYY-MM": {"src": имя, "m": {ключ: {"fact": x, "plan": y, "plan_year": z, "prev": w}}}}
prev — факт за тот же период прошлого года (из колонки отчёта).
"""
import sys, os, re, json

MON = {"январь": 1, "февраль": 2, "март": 3, "апрель": 4, "май": 5, "июнь": 6, "июль": 7, "август": 8, "сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12,
       "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6, "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12}

def norm(s): return re.sub(r"\s+", " ", (s or "").replace("\n", " ")).strip().lower()
def num(s):
    if s is None: return None
    t = str(s).replace("\xa0", " ").replace(" ", "").replace(",", ".").strip()
    if t in ("", "-", "—", "None"): return None
    if t.endswith("%"): return None
    try: return float(t)
    except Exception: return None

def period_from_name(name):
    n = norm(name)
    m = re.search(r"за\s+([а-я]+)(?:\s*-\s*([а-я]+))?\s+(\d{4})", n)
    if not m: return None
    last = m.group(2) or m.group(1); y = int(m.group(3))
    if last not in MON: return None
    return f"{y}-{MON[last]:02d}"

def tables_pptx(path):
    from pptx import Presentation
    out = []
    for sl in Presentation(path).slides:
        for sh in sl.shapes:
            if sh.has_table:
                out.append([[c.text for c in r.cells] for r in sh.table.rows])
    return out

def tables_pdf(path):
    import pdfplumber
    out = []
    with pdfplumber.open(path) as p:
        for pg in p.pages[:16]:
            for t in pg.extract_tables():
                out.append([[("" if c is None else c) for c in r] for r in t])
    return out

# --- разбор таблиц -----------------------------------------------------------
def header_cols(rows):
    """Возвращает (индекс строки заголовка, col_fact, col_plan, col_plan_year, col_prev) по строке с «Факт»/«План»."""
    for i, r in enumerate(rows[:6]):
        cells = [norm(c) for c in r]
        if any(c.startswith("факт") for c in cells):
            facts = [j for j, c in enumerate(cells) if c.startswith("факт")]
            plans = [j for j, c in enumerate(cells) if c.startswith("план") or "план" in c]
            cf = facts[0]; cprev = facts[1] if len(facts) > 1 else None
            cp = max([j for j in plans if j < cf], default=None)
            # годовой план — «утв.план» в той же строке или предыдущей
            cpy = None
            for k in range(0, i + 1):
                for j, c in enumerate([norm(x) for x in rows[k]]):
                    if "утв" in c and "план" in c: cpy = j
            if cpy == cp: cpy = None
            return i, cf, cp, cpy, cprev
    return None

def walk(rows, hi, cf, cp, cpy, cprev, unit_col):
    """Список (label, unit, fact, plan, plan_year, prev) по порядку строк."""
    out = []
    for r in rows[hi + 1:]:
        lab = norm(r[0]) if r else ""
        if not lab or re.fullmatch(r"[\d=/\- ]+", lab): continue
        unit = norm(r[unit_col]) if unit_col is not None and unit_col < len(r) else ""
        g = lambda j: num(r[j]) if j is not None and j < len(r) else None
        out.append((lab, unit, g(cf), g(cp), g(cpy), g(cprev)))
    return out

SECTION_KEYS = [  # (regex по метке, ключ, контекст)
    (r"^транспортировка нефти", "oil_total"),
    (r"^по каспийском", "oil_casp"),
    (r"^по направлению актау\s*-\s*махачкала", "oil_makh"),
    (r"^по направлению актау\s*-\s*баку", "oil_baku"),
    (r"^по направлению баку\s*-\s*актау", "teu_ba"),
    (r"^другие направл", "oil_casp_other"),
    (r"^на открытые моря", "oil_open"),
    (r"^транспортировка внутри ч[её]рного", "oil_bs_in"),
    (r"^транспортировка за пределами", "oil_bs_out"),
    (r"^транспортировка контейнеров", "teu_total"),
    (r"^по направлению актау\s*-\s*иран", "teu_ai"),
    (r"^по направлению иран\s*-\s*актау", "teu_ia"),
    (r"^транспортировка автомашин", "cars_total"),
    (r"^транспортировка сухих грузов", "bulk_total"),
]
VESSELS = {"барыс": "barys", "сункар": "sunkar", "беркут": "berkut", "туркестан": "turkestan", "бекет-ата": "beket", "бекет ата": "beket", "alatau": "alatau", "altai": "altai", "алатау": "alatau", "алтай": "altai"}

def extract(rows_list):
    m = {}
    def put(key, rec):
        if key in m: return
        lab, unit, fact, plan, py, prev = rec
        m[key] = {"fact": fact, "plan": plan, "plan_year": py, "prev": prev, "unit": unit}
    for rows in rows_list:
        if not rows or not rows[0]: continue
        head = norm(rows[0][0])
        h = header_cols(rows)
        if h is None: continue
        hi, cf, cp, cpy, cprev = h
        unit_col = 1 if any("ед" in norm(c) for c in rows[hi][:2] + (rows[hi - 1][:2] if hi else [])) else None
        # таблицы производственных показателей: первая колонка метка
        recs = walk(rows, hi, cf, cp, cpy, cprev, unit_col)
        if not recs: continue
        labs = [x[0] for x in recs]
        if not any(l.startswith("транспортировка") or l.startswith("объемы") for l in labs): continue
        ctx = None; sub = None; mode = None
        for rec in recs:
            lab, unit = rec[0], rec[1]
            hit = None
            for rx, key in SECTION_KEYS:
                if re.search(rx, lab):
                    hit = key; break
            if hit == "oil_total": mode = "oil"
            if hit == "teu_total": mode = "teu"
            if hit == "oil_baku" and mode == "teu": hit = "teu_ab"
            if hit == "teu_ba" and mode == "oil": hit = None
            if hit:
                if hit.startswith("teu_") or hit.startswith("oil_") or hit in ("cars_total", "bulk_total"):
                    if hit in ("oil_bs_in", "oil_bs_out"): sub = None
                    ctx = hit; put(hit, rec)
                continue
            # подстроки открытых морей
            if ctx in ("oil_bs_in", "oil_bs_out"):
                if lab.startswith("kmg trading"): sub = "kmgt"; put(ctx + "_kmgt", rec); continue
                if lab.startswith("сторонние"): sub = "3rd"; put(ctx + "_3rd", rec); continue
                if lab.startswith("собственным") and sub: put(f"{ctx}_{sub}_own", rec); continue
                if lab.startswith("зафрахтованным") and sub: put(f"{ctx}_{sub}_chart", rec); continue
            # суда под направлением контейнеров / сухих грузов
            for vn, vk in VESSELS.items():
                if lab.startswith(vn) and ctx:
                    put(f"{ctx}_{vk}", rec); break
        # слайд «Транспортировка нефти по Открытым морям»: ОБЪЕМЫ / по направлению внутри / за пределами + Alatau/Altai
        if any(l.startswith("объемы") for l in labs) and any(("alatau" in l or "алатау" in l) for l in labs):
            ctx = None; started = False
            for rec in recs:
                lab = rec[0]
                if lab.startswith("объемы"): started = True; put("os_total", rec); continue
                if not started: continue
                if lab.startswith("доходы") or lab.startswith("себестоим") or lab.startswith("расходы"): break
                if lab.startswith("по направлению вну"): ctx = "os_in"; put("os_in", rec); continue
                if lab.startswith("по направлению за"): ctx = "os_out"; put("os_out", rec); continue
                for vn, vk in VESSELS.items():
                    if lab.startswith(vn) and ctx: put(f"{ctx}_{vk}", rec); break
        # слайд «по Каспийскому морю»: ОБЪЕМЫ по направлениям (дублирует первую таблицу; берём если нет)
        if any(l.startswith("объемы") for l in labs) and not any(("alatau" in l or "алатау" in l) for l in labs):
            started = False
            for rec in recs:
                lab = rec[0]
                if lab.startswith("объемы"): started = True; put("oil_casp", rec); continue
                if not started: continue
                if lab.startswith("доходы"): break
                if "махачкала" in lab: put("oil_makh", rec)
                elif "баку" in lab: put("oil_baku", rec)
    return m

def main():
    outp = sys.argv[1]
    res = json.load(open(outp, encoding="utf-8")) if os.path.exists(outp) else {}
    for f in sys.argv[2:]:
        per = period_from_name(os.path.basename(f))
        if not per: print("пропуск (нет периода):", f, file=sys.stderr); continue
        try:
            rows_list = tables_pptx(f) if f.lower().endswith(".pptx") else tables_pdf(f)
        except Exception as e:
            print("ошибка", f, e, file=sys.stderr); continue
        m = extract(rows_list)
        if not m: print("нет показателей:", f, file=sys.stderr); continue
        # более поздний файл (по mtime) за тот же период заменяет
        mt = os.path.getmtime(f)
        if per in res and res[per].get("mtime", 0) > mt: continue
        res[per] = {"src": os.path.basename(f), "mtime": mt, "m": m}
        print(per, os.path.basename(f), len(m), file=sys.stderr)
    json.dump(res, open(outp, "w", encoding="utf-8"), ensure_ascii=False, indent=0)

if __name__ == "__main__": main()
