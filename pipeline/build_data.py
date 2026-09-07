import pandas as pd, json, re, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ALIASES = {
    "Президент Г.Алиев": "Пр.Гейдар Алиев", "П.Г.Алиев": "Пр.Гейдар Алиев", "Президент Гейдар Алиев": "Пр.Гейдар Алиев", "Пр. Гейдар Алиев": "Пр.Гейдар Алиев",
    "Джалил Мамедгулузаде": "Д.Мамедгулузаде", "Д.Мамедгулузадэ": "Д.Мамедгулузаде", "Джалил Мамедгулузадэ": "Д.Мамедгулузаде",
    "GC  Barys": "GC Barys", "Пр.Алиев": "Пр.Гейдар Алиев", "Дж.Мамедгулузаде": "Д.Мамедгулузаде", "Баку - 357": "Баку-357", "ВФ Танкер -18": "ВФ Танкер-18", "ВФ Танкер -21": "ВФ Танкер-21", "буксир BUE ILI": "Буксир BUE ILI", "буксир BUE CHU": "Буксир BUE CHU", "буксир MERIC": "Буксир MERIC", "GC  Berkut": "GC Berkut", "Кангаласы": "Кангалассы", "MCV Barys": "GC Barys", "MCV Berkut": "GC Berkut", "MCV Sunkar": "GC Sunkar", "GC  Sunkar ": "GC Sunkar", "Кангалласы": "Кангалассы", "Шайр Вагиф": "Шаир Вагиф", "Шайр Сабир": "Шаир Сабир", "Махмуд Рагимов": "Махмут Рагимов",
    "Узер Гаджебейли": "Узейр Гаджибейли", "Узейр Гаджебейли": "Узейр Гаджибейли", "Узеир Гаджебейли": "Узейр Гаджибейли", "Бекет -Ата": "Бекет-Ата", "Бекет Ата": "Бекет-Ата", "Навис 3": "Навис-3", "Флестина 2": "Флестина-2",
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
    "Казахстан": {"owner": "Mobilex Energy Group", "note": "танкер 12,4 тыс. т, 2005 г.; причал №11 в Актау"},
    "Абай":      {"owner": "Mobilex Energy Group", "note": "танкер 12,8 тыс. т, 2005 г."},
    "Караганда": {"owner": "казахстанский судовладелец (не установлен)", "note": "RST27, 7,0 тыс. т, 2013 г., экс «ВФ Танкер-21», флаг РК с 01.2023"},
    "Костанай":  {"owner": "казахстанский судовладелец (не установлен)", "note": "RST27, 7,0 тыс. т, 2013 г., экс «ВФ Танкер-20», флаг РК с 02.2023"},
}
KMTF_EXTRA = {"aframax": ["Алтай", "Алатау"], "tugs": ["TUG Talas", "TUG Emba", "TUG Irgiz"], "containers": ["GC Barys", "GC Berkut", "GC Sunkar"]}
# суда АСКО (Азербайджанское Каспийское морское пароходство) — для разбивки объёмов по перевозчикам
ASCO = ["Пр.Гейдар Алиев", "Джульфа", "Джаббар Гашимов", "Д.Мамедгулузаде", "Шуша", "Гахраман Халилбейли", "Ходжаванд", "Азербайджан", "Баку", "Нариман Нариманов", "Лачин", "Нафталан", "Ш.И.Хатай", "Бабек", "Зенгезур", "Куруш", "Кяльбаджар", "Агдам", "Физули",
        "Расул Рза", "Натаван", "Гусейн Джавид", "Генерал Асланов", "Шаир Вагиф", "Шаир Сабир", "Махмут Рагимов", "Теймур Ахмедов", "Узейр Гаджибейли", "Гарадаг", "Гафур Мамедов", "Академик Зарифа Алиева", "Мерджан", "Проф. Азиз Алиев", "Профессор Азиз Алиев", "Ак.Хошбахт Юсифзаде", "Карабах", "Балакен", "Зарифа Алиева", "Маэстро Ниязи", "Ростов Великий"]

out = {"generated": __import__("datetime").date.today().isoformat(), "snapshot": snap, "weather": wx, "kmtf": {"tankers": kmtf_t, "bulk": kmtf_b, "aframax": KMTF_EXTRA["aframax"], "tugs": KMTF_EXTRA["tugs"], "asco": ASCO, "containers": KMTF_EXTRA["containers"], "owners": OWNERS}, "snapshots": hist,
       "tank_cols": ["vessel", "shpr", "terminal", "berth", "arr", "berth_at", "load_start", "load_end", "draft", "cargo", "dep"],
       "tank": tank,
       "bulk_cols": ["vessel", "berth", "arr", "berth_at", "unload_start", "unload_end", "in_kind", "in_qty", "in_qty_raw", "in_teu", "load_start", "load_end", "out_kind", "out_qty", "out_qty_raw", "out_teu", "dep"],
       "bulk": bulk,
       "bunk_cols": ["vessel", "arr", "b_start", "b_end", "dt", "tt", "dep", "port"], "bunk": bunk}
s = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
open("data/data.json", "w", encoding="utf-8").write(s)
print(len(s) / 1e6, "MB", len(tank), len(bulk), len(bunk), kmtf_t, kmtf_b)
