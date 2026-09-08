"""Внешние данные для дашборда -> market.json (раз в сутки, run.sh).
Курсы НБК (USD, RUB, EUR), Brent/WTI (FRED), уровень Каспия (DAHITI по ключу и/или USDA G-REALM),
ледовая обстановка (Казгидромет — последний обзор), бункерное топливо (Ship & Bunker, открытые средние),
санкционные списки (OFAC SDN, UK OFSI, ЕС) — проверка судов и компаний из наших данных.
Каждый блок независим: ошибка одного не ломает остальные, история накапливается в market.json.
"""
import json, os, re, sys, csv, io, datetime, html, urllib.request, urllib.parse, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "market.json")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) dislokacia-market/1.0"}
today = datetime.date.today()

def load_env(p):
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"'))
load_env(os.path.join(HERE, "config.env"))

def fetch(url, timeout=40, data=None, headers=None):
    h = dict(UA); h.update(headers or {})
    req = urllib.request.Request(url, headers=h, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()

M = {}
if os.path.exists(OUT):
    try: M = json.load(open(OUT, encoding="utf-8"))
    except Exception: M = {}
M.setdefault("fx", {}); M.setdefault("oil", {}); M.setdefault("sea", {}); M.setdefault("errors", {})
errors = {}

# ---- 1. курсы НБК ----
def nbk():
    fx = M["fx"]
    # добираем пропущенные дни за последние 400 дней (первый запуск) или последние 7 (обычно)
    days = 400 if len(fx) < 30 else 7
    for i in range(days, -1, -1):
        d = today - datetime.timedelta(days=i); key = d.isoformat()
        if key in fx and i > 1: continue
        try:
            x = fetch(f"https://nationalbank.kz/rss/get_rates.cfm?fdate={d.strftime('%d.%m.%Y')}", timeout=20)
            root = ET.fromstring(x); rec = {}
            for it in root.iter("item"):
                t = (it.findtext("title") or "").strip()
                if t in ("USD", "RUB", "EUR", "CNY"):
                    q = float(it.findtext("quant") or 1); rec[t] = round(float(it.findtext("description")) / q, 4)
            if rec: fx[key] = rec
        except Exception as e:
            if i <= 1: errors["nbk"] = str(e)[:120]
    # оставляем 3 года
    for k in list(fx):
        if k < (today - datetime.timedelta(days=1100)).isoformat(): del fx[k]

# ---- 2. нефть FRED ----
def fred(series, key):
    try:
        txt = fetch(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}", timeout=30).decode("utf-8", "ignore")
        n = 0
        for row in csv.reader(io.StringIO(txt)):
            if len(row) < 2 or not re.match(r"\d{4}-\d{2}-\d{2}", row[0]): continue
            if row[0] < (today - datetime.timedelta(days=1100)).isoformat(): continue
            try: v = float(row[1])
            except Exception: continue
            M["oil"].setdefault(row[0], {})[key] = v; n += 1
        if not n: errors["fred_" + key] = "нет данных"
    except Exception as e: errors["fred_" + key] = str(e)[:120]

# ---- 3. уровень Каспия ----
def dahiti():
    key = os.environ.get("DAHITI_API_KEY", "").strip()
    if not key: errors["dahiti"] = "нет DAHITI_API_KEY в config.env (регистрация бесплатная: dahiti.dgfi.tum.de)"; return
    try:
        body = json.dumps({"api_key": key, "dahiti_id": 39, "format": "json"}).encode()
        r = json.loads(fetch("https://dahiti.dgfi.tum.de/api/v2/download-water-level/", data=body, headers={"Content-Type": "application/json"}, timeout=60))
        pts = r.get("data") or []
        ser = {}
        for p in pts:
            d = str(p.get("date") or p.get("datetime") or "")[:10]; v = p.get("wse") or p.get("water_level")
            if d and v is not None: ser[d] = round(float(v), 3)
        if ser: M["sea"]["dahiti"] = {"unit": "м (абс. высота, EGM2008)", "src": "DAHITI (TUM), спутниковая альтиметрия", "series": ser}
        else: errors["dahiti"] = "пустой ответ: " + str(r)[:120]
    except Exception as e: errors["dahiti"] = str(e)[:160]

def grealm():
    try:
        page = fetch("https://ipad.fas.usda.gov/cropexplorer/global_reservoir/gr_regional_chart.aspx?regionid=stans&reservoir_name=Caspian", timeout=40).decode("utf-8", "ignore")
        m = re.search(r"lake(\d{6})\.10d", page)
        lake_id = m.group(1) if m else (M["sea"].get("grealm", {}).get("id") or "")
        if not lake_id: errors["grealm"] = "id озера не найден на странице"; return
        txt = fetch(f"https://ipad.fas.usda.gov/lakes/images/lake{lake_id}.10d.2.smooth.txt", timeout=40).decode("utf-8", "ignore")
        ser = {}; mean = None
        for line in txt.splitlines():
            mm = re.search(r"mean\s*=\s*(-?[\d.]+)\s*m", line)
            if mm: mean = float(mm.group(1))
            t = line.split()
            if len(t) >= 6 and re.fullmatch(r"\d{8}", t[2]) and t[5] not in ("999.99", "9999.99"):
                try: ser[f"{t[2][:4]}-{t[2][4:6]}-{t[2][6:]}"] = round(float(t[5]), 3)
                except Exception: pass
        if ser: M["sea"]["grealm"] = {"id": lake_id, "unit": "м (отклонение от среднего профиля)", "mean": mean, "src": "USDA G-REALM, спутниковая альтиметрия", "series": ser}
        else: errors["grealm"] = "нет точек"
    except Exception as e: errors["grealm"] = str(e)[:160]

def kazhydromet():
    out = M.setdefault("kazhydromet", {})
    try:
        page = fetch("https://www.kazhydromet.kz/ru/kaspiyskoe-more/obzor-ledovoy-obstanovki", timeout=40).decode("utf-8", "ignore")
        links = re.findall(r'href="([^"]*obzor[^"]*\.pdf)"', page)
        dated = []
        for l in links:
            m = re.search(r"za-(\d{2})_(\d{2})_(\d{4})", l)
            if m: dated.append((f"{m.group(3)}-{m.group(2)}-{m.group(1)}", l if l.startswith("http") else "https://www.kazhydromet.kz" + l))
        dated.sort(reverse=True)
        if dated: out["ice"] = {"date": dated[0][0], "url": dated[0][1], "n": len(dated)}
    except Exception as e: errors["kazhydromet_ice"] = str(e)[:120]
    try:
        page = fetch("https://www.kazhydromet.kz/ru/kaspiyskoe-more/prognoz-urovnya-kaspiyskogo-morya", timeout=40).decode("utf-8", "ignore")
        links = re.findall(r'href="([^"]*\.pdf)"', page)
        if links:
            l = links[0]; out["level_forecast"] = {"url": l if l.startswith("http") else "https://www.kazhydromet.kz" + l, "n": len(links)}
    except Exception as e: errors["kazhydromet_level"] = str(e)[:120]

# ---- 4. бункерное топливо (Ship & Bunker, открытые последние значения) ----
def bunker():
    out = M.setdefault("bunker", {"history": {}})
    pages = {"G20": "https://shipandbunker.com/prices/av/global/av-g20-global-20-ports-average", "Istanbul": "https://shipandbunker.com/prices/emea/medabs/tr-ist-istanbul", "Novorossiysk": "https://shipandbunker.com/prices/emea/medabs/ru-nvs-novorossiysk", "Piraeus": "https://shipandbunker.com/prices/emea/medabs/gr-pir-piraeus", "Fujairah": "https://shipandbunker.com/prices/emea/wafr/ae-fjr-fujairah"}
    got = {}
    for name, url in pages.items():
        try:
            pg = fetch(url, timeout=40).decode("utf-8", "ignore")
            txt = re.sub(r"<[^>]+>", " ", pg); txt = re.sub(r"\s+", " ", txt)
            rec = {}
            for fuel in ("VLSFO", "MGO", "IFO380"):
                m = re.search(fuel + r"\b.{0,160}?\$\s?([\d,]+\.\d{2})", txt)
                if m: rec[fuel] = float(m.group(1).replace(",", ""))
            if rec: got[name] = rec
        except Exception as e: errors["bunker_" + name] = str(e)[:100]
    if got:
        out["latest"] = {"date": today.isoformat(), "src": "Ship & Bunker (открытые последние значения, $/т)", "ports": got}
        out["history"][today.isoformat()] = got
        for k in list(out["history"]):
            if k < (today - datetime.timedelta(days=400)).isoformat(): del out["history"][k]

# ---- 5. санкции ----
TRANSLIT = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"}
def norm(s):
    s = (s or "").lower().strip()
    s = "".join(TRANSLIT.get(c, c) for c in s)
    return re.sub(r"[^a-z0-9]", "", s)
ALIAS = {"тк актау": ["tk aktau", "aktau"], "лива": ["liwa"], "тараз": ["taraz"], "куруш": ["kurush"], "джульфа": ["julfa", "dzhulfa"], "абай": ["abai", "abay"], "казахстан": ["kazakhstan"], "костанай": ["kostanay", "kostanai"], "караганда": ["karaganda"], "шуша": ["shusha"], "нафталан": ["naftalan"], "азербайджан": ["azerbaijan"], "д.мамедгулузаде": ["jalil mammadguluzadeh", "dzhalil mamedkulizade"], "джаббар гашимов": ["jabbar hashimov", "dzhabbar gashimov"], "пр.гейдар алиев": ["president heydar aliyev", "prezident geydar aliev"], "гахраман халилбейли": ["gahraman khalilbeyli"], "ходжаванд": ["khojavand", "khodzhavend"], "мелиана": ["meliana"], "виктория": ["viktoria", "victoria"]}
COMPANIES = ["Khazar Shipping", "Khazar Sea Shipping Lines", "Caspiy Shipping", "AB Fleet", "Mobilex", "Titan Oil", "Eurasian Trading", "KMG Trading", "Vector Energy", "Palmali", "Frakhtmortrans", "Фрахтмортранс", "BNT", "Caspian Integrated Maritime Solutions", "Azerbaijan Caspian Shipping", "ASCO", "Kazmortransflot", "Volga Shipping", "V.F. Tanker", "Volgotanker"]

def our_names():
    names = set()
    for f, col in (("data/crude.csv", "vessel"), ("data/tankers.csv", "vessel"), ("data/openseas.csv", "ship"), ("data/openseas.csv", "charterer")):
        p = os.path.join(HERE, f)
        if os.path.exists(p):
            for r in csv.DictReader(open(p, encoding="utf-8")):
                v = (r.get(col) or "").strip()
                if v: names.add(v)
    names.update(COMPANIES)
    out = {}
    for n in names:
        keys = {norm(n)}
        for k, al in ALIAS.items():
            if norm(k) == norm(n): keys.update(norm(a) for a in al)
        for k in keys:
            if len(k) >= 4: out[k] = n
    return out

def sanctions():
    S = M.setdefault("sanctions", {})
    ours = our_names()
    matches = []; lists = {}
    def check(list_name, rows):  # rows: iterable of (name, type, program)
        n = 0
        for name, typ, prog in rows:
            n += 1
            k = norm(name)
            if k in ours and len(k) >= 4:
                matches.append({"list": list_name, "name": name, "type": typ, "program": prog[:120], "ours": ours[k]})
        lists[list_name] = {"n": n, "date": today.isoformat()}
    try:
        txt = fetch("https://www.treasury.gov/ofac/downloads/sdn.csv", timeout=90).decode("utf-8", "ignore")
        rows = []
        for r in csv.reader(io.StringIO(txt)):
            if len(r) >= 4: rows.append((r[1], r[2], r[3]))
        check("OFAC SDN (США)", rows)
        alt = fetch("https://www.treasury.gov/ofac/downloads/alt.csv", timeout=90).decode("utf-8", "ignore")
        rows = [(r[3], "alias", "") for r in csv.reader(io.StringIO(alt)) if len(r) >= 4]
        check("OFAC SDN (США, псевдонимы)", rows)
    except Exception as e: errors["ofac"] = str(e)[:120]
    try:
        txt = fetch("https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv", timeout=90).decode("utf-8", "ignore")
        rd = csv.reader(io.StringIO(txt)); rows = []
        hdr = None
        for r in rd:
            if hdr is None:
                if any("Name 6" in c for c in r): hdr = r
                continue
            d = dict(zip(hdr, r))
            nm = " ".join(x for x in [d.get("Name 1", ""), d.get("Name 2", ""), d.get("Name 3", ""), d.get("Name 4", ""), d.get("Name 5", ""), d.get("Name 6", "")] if x).strip()
            rows.append((nm, d.get("Group Type", ""), d.get("Regime", "")))
        check("UK OFSI", rows)
    except Exception as e: errors["uk"] = str(e)[:120]
    try:
        txt = fetch("https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw", timeout=120).decode("utf-8", "ignore")
        rd = csv.reader(io.StringIO(txt), delimiter=";"); hdr = next(rd, None); rows = []
        if hdr:
            ci = {h: i for i, h in enumerate(hdr)}
            for r in rd:
                nm = r[ci["NameAlias_WholeName"]] if "NameAlias_WholeName" in ci and len(r) > ci["NameAlias_WholeName"] else ""
                typ = r[ci["Entity_SubjectType"]] if "Entity_SubjectType" in ci and len(r) > ci["Entity_SubjectType"] else ""
                prog = r[ci["Entity_Regulation_Programme"]] if "Entity_Regulation_Programme" in ci and len(r) > ci["Entity_Regulation_Programme"] else ""
                if nm: rows.append((nm, typ, prog))
        check("ЕС", rows)
    except Exception as e: errors["eu"] = str(e)[:120]
    S["checked"] = today.isoformat(); S["lists"] = lists; S["matches"] = matches; S["n_ours"] = len(set(ours.values()))

for step in (nbk, lambda: fred("DCOILBRENTEU", "brent"), lambda: fred("DCOILWTICO", "wti"), dahiti, grealm, kazhydromet, bunker, sanctions):
    try: step()
    except Exception as e: errors[getattr(step, "__name__", "step")] = str(e)[:120]
M["errors"] = errors; M["fetched"] = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
json.dump(M, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
print(f"market: fx {len(M['fx'])} дн., oil {len(M['oil'])} дн., sea {list(M['sea'].keys())}, bunker {'да' if M.get('bunker', {}).get('latest') else 'нет'}, санкции: совпадений {len(M.get('sanctions', {}).get('matches', []))}; ошибки: {errors}", file=sys.stderr)
