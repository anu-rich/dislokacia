import pandas as pd, json, re, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ALIASES = {
    "Президент Г.Алиев": "Пр.Гейдар Алиев", "П.Г.Алиев": "Пр.Гейдар Алиев", "Президент Гейдар Алиев": "Пр.Гейдар Алиев", "Пр. Гейдар Алиев": "Пр.Гейдар Алиев",
    "Джалил Мамедгулузаде": "Д.Мамедгулузаде", "Д.Мамедгулузадэ": "Д.Мамедгулузаде", "Джалил Мамедгулузадэ": "Д.Мамедгулузаде",
    "GC  Barys": "GC Barys", "Пр.Алиев": "Пр.Гейдар Алиев", "Дж.Мамедгулузаде": "Д.Мамедгулузаде", "Баку - 357": "Баку-357", "ВФ Танкер -18": "ВФ Танкер-18", "ВФ Танкер -21": "ВФ Танкер-21", "буксир BUE ILI": "Буксир BUE ILI", "буксир BUE CHU": "Буксир BUE CHU", "буксир MERIC": "Буксир MERIC", "GC  Berkut": "GC Berkut", "Кангаласы": "Кангалассы", "MCV Barys": "GC Barys", "MCV Berkut": "GC Berkut", "MCV Sunkar": "GC Sunkar", "GC  Sunkar ": "GC Sunkar", "Кангалласы": "Кангалассы", "Шайр Вагиф": "Шаир Вагиф", "Шайр Сабир": "Шаир Сабир", "Махмуд Рагимов": "Махмут Рагимов",
    "Узер Гаджебейли": "Узейр Гаджибейли", "Узейр Гаджебейли": "Узейр Гаджибейли", "Узеир Гаджебейли": "Узейр Гаджибейли", "Бекет -Ата": "Бекет-Ата", "Бекет Ата": "Бекет-Ата", "Навис 3": "Навис-3", "Флестина 2": "Флестина-2",
    "Liwa": "Лива", "Taraz": "Тараз", "Kurush": "Куруш", "KURUSH": "Куруш", "JULFA": "Джульфа", "Abai": "Абай", "Naftalan": "Нафталан", "AZERBAIJAN": "Азербайджан", "Naryman Narymanov": "Нариман Нариманов",
    "Дж.Маммедгулузаде": "Д.Мамедгулузаде", "Дж. Маммадгуладзе": "Д.Мамедгулузаде", "Джабар Гашимов": "Джаббар Гашимов", "Джаббар Хашимов": "Джаббар Гашимов", "Дж.Гашимов": "Джаббар Гашимов", "Гехреман Халилбели": "Гахраман Халилбейли", "Хатай": "Ш.И.Хатай", "Актау": "ТК Актау",
    "Пр.Г.Алиев": "Пр.Гейдар Алиев", "Д.Мамедгулузде": "Д.Мамедгулузаде", "Г.Халелбейли": "Гахраман Халилбейли", "Г.Халилбейли": "Гахраман Халилбейли", "Каспиан Эксплорер": "Caspian Explorer", "GC  Sunkar": "GC Sunkar", "Тк Актау": "ТК Актау", "ТК АКТАУ": "ТК Актау", "Тк актау": "ТК Актау",
}
def canon(s):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return ALIASES.get(s, s)

def shpr_canon(s):
    s = re.sub(r"\s+", " ", str(s or "").upper()).strip()
    if not s or s == "NAN": return ""
    s = re.sub(r"\s*-\s*", "-", s).replace("ЕАО-M", "ЕАО-М").replace("BBENERGY", "BB ENERGY")
    return s

def dt(s):
    if s is None or (isinstance(s, float) and math.isnan(s)) or s == "": return None
    return s  # already "YYYY-MM-DD HH:MM"

def num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)): return None
    return round(float(v), 2)

t = pd.read_csv("data/tankers.csv")
t["vessel"] = t.vessel.map(canon); t["shpr"] = t.shpr.map(shpr_canon)
t = t[t.dep.notna()]
tank = [[r.vessel, r.shpr, str(r.terminal) if isinstance(r.terminal, str) else "", str(r.berth) if isinstance(r.berth, str) else "",
         dt(r.arr), dt(r.berth_at), dt(r.load_start), dt(r.load_end), num(r.draft), num(r.cargo), dt(r.dep)] for r in t.itertuples()]

b = pd.read_csv("data/bulk.csv")
b["vessel"] = b.vessel.map(canon)
b = b[b.dep.notna()]
def kind(s):
    s = str(s or "").strip()
    if s in ("", "nan"): return ""
    if "контейнер" in s: return "контейнеры" if "авто" not in s else "контейнеры+авто"
    if "балласт" in s or "порожн" in s: return "балласт"
    if "ген" in s: return "ген.груз"
    if "ячмень" in s: return "ячмень"
    if "зерно" in s or "пшениц" in s: return "зерно"
    if "селитра" in s: return "селитра"
    if "пассажир" in s: return "пассажиры"
    return s
bulk = [[r.vessel, str(r.berth) if isinstance(r.berth, str) else "", dt(r.arr), dt(r.berth_at), dt(r.unload_start), dt(r.unload_end),
         kind(r.in_kind), num(r.in_qty), str(r.in_qty_raw) if isinstance(r.in_qty_raw, str) else "", num(r.in_teu),
         dt(r.load_start), dt(r.load_end), kind(r.out_kind), num(r.out_qty), str(r.out_qty_raw) if isinstance(r.out_qty_raw, str) else "", num(r.out_teu), dt(r.dep)] for r in b.itertuples()]

k = pd.read_csv("data/bunker.csv")
k["vessel"] = k.vessel.map(canon)
def bport(p):
    # STS — только передача топлива между судами КМТФ (с MCV/GC Barys и т.п.); бункеровка бункеровщиком на 146 районе = порт Баку
    p = re.sub(r"\s+", " ", str(p or "")).strip(); low = p.lower()
    if low in ("", "nan", "актау", "п.актау", "п. актау"): return "Актау"
    if low in ("баутино", "п.баутино", "баутино тс"): return "Баутино"  # ТС = бункеровка с автотранспорта
    if "146" in low: return "Баку (146 район)"
    if "barys" in low or "барыс" in low or "беркут" in low or "berkut" in low or "sunkar" in low or "сункар" in low or "мильн" in low or "м.зона" in low: return "STS с судна КМТФ (" + p + ")"
    return "Прочие порты и рейды (Астрахань, Турция, Египет, ОАЭ…)"
bunk = [[r.vessel, dt(r.arr), dt(r.b_start), dt(r.b_end), num(r.dt), num(r.tt), dt(r.dep), bport(r.port)] for r in k.itertuples()]

snap = json.load(open("data/snapshot.json", encoding="utf-8"))
import parse_history
snap_c = parse_history.compact(snap)
hist = []
if os.path.exists("data/snapshots.json"):
    hist = json.load(open("data/snapshots.json", encoding="utf-8"))
hist = [h for h in hist if h["ts"] != snap_c["ts"]] + [snap_c]
hist.sort(key=lambda h: h["ts"])
def canon_hist(h):
    for pt in h["ports"]:
        for lst in pt["sec"].values():
            for it in lst:
                if it.get("n"): it["n"] = canon(it["n"])
    for r in h["sup"]:
        if r.get("n"): r["n"] = canon(r["n"])
for h in hist: canon_hist(h)
for p in snap["tankers"] + snap["bulk"] + snap["open_seas"]:
    for sec in p["sections"].values():
        for it in sec:
            if it.get("vessel"): it["vessel"] = canon(it["vessel"])

import os
wx = None
for cand in [os.environ.get("WEATHER_JSON", ""), os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "weather.json"), "data/weather.json"]:
    if cand and os.path.exists(cand):
        try:
            wx = json.load(open(cand, encoding="utf-8"))
            for pt in wx.get("points", []):  # защита от задвоенных массивов
                t = pt.get("time") or []
                n = next((i for i in range(1, len(t)) if t[i] == t[0]), len(t))
                for k, v in list(pt.items()):
                    if isinstance(v, list) and len(v) > n: pt[k] = v[:n]
            break
        except Exception as e:
            print("weather.json не прочитан:", e)

kmtf_t = [canon(r["Суда"]) for r in snap["tanker_supplies"]]
kmtf_b = [canon(r["Суда"]) for r in snap["bulk_supplies"]]
# суда КМТФ вне таблиц запасов: афрамаксы в открытых морях и буксиры в бербоут-чартере
# Третьи судовладельцы (не КМТФ и не АСКО). Источники: mobilexkz.com; fleetphoto.ru / vesselfinder (RST27, экс «ВФ Танкер-20/21», под флаг РК с 2023).
OWNERS = {
    "Казахстан": {"owner": "Caspiy Shipping (до 2024 — Мобилекс)", "note": "танкер 12,4 тыс. т, 2005 г.; по файлам «Caspian Sea Crude Oil»: 2023 — Мобилекс, 2025–26 — Caspiy Shipping"},
    "Абай":      {"owner": "Caspiy Shipping (до 2024 — Мобилекс)", "note": "танкер 12,8 тыс. т, 2005 г.; по файлам «Caspian Sea Crude Oil»"},
    "Караганда": {"owner": "AB Fleet", "note": "RST27, 7,0 тыс. т, 2013 г., экс «ВФ Танкер-21», флаг РК с 01.2023; судовладелец по «Caspian Sea Crude Oil»"},
    "Костанай":  {"owner": "AB Fleet", "note": "RST27, 7,0 тыс. т, 2013 г., экс «ВФ Танкер-20», флаг РК с 02.2023; судовладелец по «Caspian Sea Crude Oil»"},
    "Куруш":     {"owner": "AB Fleet", "note": "по «Caspian Sea Crude Oil»"},
}
KMTF_EXTRA = {"aframax": ["Алтай", "Алатау"], "tugs": ["TUG Talas", "TUG Emba", "TUG Irgiz"], "containers": ["GC Barys", "GC Berkut", "GC Sunkar"]}
# суда АСКО (Азербайджанское Каспийское морское пароходство) — для разбивки объёмов по перевозчикам
ASCO = ["Пр.Гейдар Алиев", "Джульфа", "Джаббар Гашимов", "Д.Мамедгулузаде", "Шуша", "Гахраман Халилбейли", "Ходжаванд", "Азербайджан", "Баку", "Нариман Нариманов", "Лачин", "Нафталан", "Ш.И.Хатай", "Бабек", "Зенгезур", "Кяльбаджар", "Агдам", "Физули",
        "Расул Рза", "Натаван", "Гусейн Джавид", "Генерал Асланов", "Шаир Вагиф", "Шаир Сабир", "Махмут Рагимов", "Теймур Ахмедов", "Узейр Гаджибейли", "Гарадаг", "Гафур Мамедов", "Академик Зарифа Алиева", "Мерджан", "Проф. Азиз Алиев", "Профессор Азиз Алиев", "Ак.Хошбахт Юсифзаде", "Карабах", "Балакен", "Зарифа Алиева", "Маэстро Ниязи", "Ростов Великий"]


# ---- перевалка нефти по коносаментам (Caspian Sea Crude Oil) ----
crude = []
if os.path.exists("data/crude.csv"):
    c = pd.read_csv("data/crude.csv", dtype=str).fillna("")
    def rt(d):
        d = d.lower()
        if "махач" in d: return "Махачкала"
        if any(k in d for k in ("сангачал", "баку", "дюбенди")): return "Баку"
        return d.strip() or "не указан"
    def own(o):
        o = (o or "").strip(); u = o.upper()
        if u in ("КМТФ", "KMTF"): return "КМТФ"
        if u == "CIMS": return "CIMS"
        if u in ("ASCO", "АСКО"): return "АСКО"
        if u.startswith("AB FLEET"): return "AB Fleet"
        if "МОБИЛЕКС" in u or "MOBILEX" in u: return "Мобилекс"
        if "CASPIY" in u: return "Caspiy Shipping"
        if "СОКАР" in u or "SOCAR" in u: return "SOCAR"
        return o or "не указан"
    for r in c.itertuples():
        crude.append([r.month, canon(r.vessel), r.charterer, r.cargo.strip().lower(), float(r.tons or 0), (r.dep or "")[:10], (r.arr or "")[:10], rt(r.direction), own(r.owner), r.bl[:40]])
CRUDE_GROUPS = {"КМТФ": ["ТК Актау", "Астана", "Алматы"], "CIMS": ["Лива", "Тараз"], "AB Fleet": ["Костанай", "Караганда", "Куруш"], "Caspiy Shipping / Мобилекс": ["Казахстан", "Абай"]}
crude_cols = ["m", "vessel", "charterer", "cargo", "tons", "dep", "arr", "route", "owner", "bl"]

# ---- МР-отчёты: накопительно с начала года -> помесячно ----
mr = {"cum": {}, "monthly": []}
if os.path.exists("data/mr.json"):
    raw = json.load(open("data/mr.json", encoding="utf-8"))
    periods = sorted(raw)
    cum = {p: {k: v.get("fact") for k, v in raw[p]["m"].items()} for p in periods}
    plan = {p: {k: v.get("plan") for k, v in raw[p]["m"].items()} for p in periods}
    plan_year = {p: {k: v.get("plan_year") for k, v in raw[p]["m"].items()} for p in periods}
    prev = {p: {k: v.get("prev") for k, v in raw[p]["m"].items()} for p in periods}
    mr["cum"] = {p: {"src": raw[p]["src"], "fact": cum[p], "plan": plan[p], "plan_year": plan_year[p], "prev": prev[p]} for p in periods}
    # помесячно: разность с предыдущим имеющимся периодом того же года; span — сколько месяцев покрывает
    for p in periods:
        y, m = p[:4], int(p[5:7])
        prior = [q for q in periods if q[:4] == y and q < p]
        base = prior[-1] if prior else None
        span = m - (int(base[5:7]) if base else 0)
        rec = {"m": p, "span": span, "v": {}, "plan": {}}
        for k, v in cum[p].items():
            if v is None: continue
            bv = cum[base].get(k) if base else 0
            if base and bv is None: continue
            rec["v"][k] = round(v - (bv or 0), 3)
            pv = plan[p].get(k); bp = plan[base].get(k) if base else 0
            if pv is not None and (bp is not None):
                rec["plan"][k] = round(pv - (bp or 0), 3)
        mr["monthly"].append(rec)

# ---- открытые моря: рейсы KMTF UK ----
openseas = []
if os.path.exists("data/openseas.csv"):
    o = pd.read_csv("data/openseas.csv", dtype=str).fillna("")
    def ch(x):
        u = re.sub(r"\s+", " ", x.strip()).upper()
        if u.startswith("KMG TRADING"): return "KMG Trading AG"
        return x.strip()
    def shipn(x):
        t = x.strip(); u = t.upper()
        if u == "ALTAI": return "Altai"
        if u == "ALATAU": return "Alatau"
        return t
    for r in o.itertuples():
        openseas.append([int(r.year), int(r.month), shipn(r.ship), r.fleet, float(r.loaded or 0), float(r.delivered) if r.delivered else None, r.bl, r.load_port, r.disch_port, r.region, r.distance, ch(r.charterer), r.type])
openseas_cols = ["y", "mo", "ship", "fleet", "loaded", "delivered", "bl", "load_port", "disch_port", "region", "distance", "charterer", "type"]
openseas_src = ""
try: openseas_src = o.src.iloc[0] if len(o) else ""
except Exception: pass

# ---- отраслевые новости (news.py на сервере) ----
news = {}
for cand in [os.environ.get("NEWS_JSON", ""), os.path.join(os.path.dirname(os.path.abspath(__file__)), "news.json"), "data/news.json"]:
    if cand and os.path.exists(cand):
        try: news = json.load(open(cand, encoding="utf-8")); break
        except Exception as e: print("news.json не прочитан:", e)

# ---- внешние данные (market.py на сервере) ----
market = {}
for cand in [os.environ.get("MARKET_JSON", ""), os.path.join(os.path.dirname(os.path.abspath(__file__)), "market.json"), "data/market.json"]:
    if cand and os.path.exists(cand):
        try: market = json.load(open(cand, encoding="utf-8")); break
        except Exception as e: print("market.json не прочитан:", e)
if market:
    import datetime as _dt
    cut = (_dt.date.today() - _dt.timedelta(days=750)).isoformat()
    market["fx"] = {k: v for k, v in market.get("fx", {}).items() if k >= cut}
    market["oil"] = {k: v for k, v in market.get("oil", {}).items() if k >= cut}

out = {"generated": __import__("datetime").date.today().isoformat(), "snapshot": snap, "weather": wx, "kmtf": {"tankers": kmtf_t, "bulk": kmtf_b, "aframax": KMTF_EXTRA["aframax"], "tugs": KMTF_EXTRA["tugs"], "asco": ASCO, "containers": KMTF_EXTRA["containers"], "owners": OWNERS}, "snapshots": hist,
       "crude": crude, "crude_cols": crude_cols, "crude_groups": CRUDE_GROUPS, "mr": mr, "openseas": openseas, "openseas_cols": openseas_cols, "openseas_src": openseas_src, "news": news, "market": market,
       "tank_cols": ["vessel", "shpr", "terminal", "berth", "arr", "berth_at", "load_start", "load_end", "draft", "cargo", "dep"],
       "tank": tank,
       "bulk_cols": ["vessel", "berth", "arr", "berth_at", "unload_start", "unload_end", "in_kind", "in_qty", "in_qty_raw", "in_teu", "load_start", "load_end", "out_kind", "out_qty", "out_qty_raw", "out_teu", "dep"],
       "bulk": bulk,
       "bunk_cols": ["vessel", "arr", "b_start", "b_end", "dt", "tt", "dep", "port"], "bunk": bunk}
s = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
open("data/data.json", "w", encoding="utf-8").write(s)
print(len(s) / 1e6, "MB", len(tank), len(bulk), len(bunk), kmtf_t, kmtf_b)
