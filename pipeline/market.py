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

# ---- 3b. Волго-Каспийский канал: проходная осадка (АМП Астрахань, 2 раза в сутки) ----
def vkk():
    out = M.setdefault("vkk", {"history": {}})
    try:
        pg = fetch("https://ampastra.ru/slujba_kapitana_morskogo_porta_astrahan/109-registratsiya_sudov/109-promeryi.html", timeout=40).decode("utf-8", "ignore")
        txt = re.sub(r"<[^>]+>", " ", pg); txt = re.sub(r"\s+", " ", txt)
        md = re.search(r"(\d{2}\.\d{2}\.\d{4})\D{0,40}?(\d{2}[:.]\d{2})", txt)
        # строки вида «54,6-55,05 км ... 4,8 ... 4,5»
        rows = re.findall(r"(\d{1,3}[,.]\d{1,2}\s*[-–]\s*\d{1,3}[,.]\d{1,2})\s*км[^\d]{0,40}(\d[,.]\d{1,2})[^\d]{0,40}(\d[,.]\d{1,2})", txt)
        secs = [{"km": r[0].replace(" ", ""), "depth": float(r[1].replace(",", ".")), "draft": float(r[2].replace(",", "."))} for r in rows][:12]
        drafts = [x["draft"] for x in secs]
        if not drafts:
            m2 = re.findall(r"проходн\w*\s+осадк\w*[^\d]{0,60}(\d[,.]\d{1,2})", txt, re.I)
            drafts = [float(x.replace(",", ".")) for x in m2]
        if drafts:
            d = min(drafts); when = md.group(1) if md else today.strftime("%d.%m.%Y")
            out["latest"] = {"date": when, "draft": d, "sections": secs, "src": "Служба капитана морского порта Астрахань (ampastra.ru)"}
            out["history"][today.isoformat()] = d
            for k in list(out["history"]):
                if k < (today - datetime.timedelta(days=400)).isoformat(): del out["history"][k]
        else: errors["vkk"] = "осадка не найдена на странице"
    except Exception as e: errors["vkk"] = str(e)[:120]

# ---- 3b. Махачкала: проходная осадка (служба капитана порта, ampastra.ru; таблица обновляется 2 раза в день) ----
MONTHS_RU = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6, "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}
def makhachkala():
    out = M.setdefault("makh", {"history": {}})
    try:
        pg = fetch("https://ampastra.ru/slujba_kapitana_morskogo_porta_mahachkala/110-navigatsionnaya_obstanovka.html", timeout=40).decode("utf-8", "ignore")
        txt = re.sub(r"<[^>]+>", " ", pg); txt = re.sub(r"\s+", " ", txt)
        when = None
        md = re.search(r"на\s+(\d{1,2})[.:](\d{2})\s+(\d{1,2})\s+([А-Яа-я]+)\s+(\d{4})", txt, re.I)
        if md:
            mon = next((v for k, v in MONTHS_RU.items() if md.group(4).lower().startswith(k)), None)
            if mon: when = f"{int(md.group(3)):02d}.{mon:02d}.{md.group(5)} {md.group(1)}:{md.group(2)}"
        if not when:
            md = re.search(r"(\d{2}\.\d{2}\.\d{4})", txt); when = md.group(1) if md else today.strftime("%d.%m.%Y")
        res = {}
        for name, key in (("нефтян", "oil"), ("сухогруз", "dry")):
            m = re.search(r"канал\w*\s+" + name + r"\w*\s+гаван\w*((?:[^\d-]{0,30}-?\d+[,.]?\d*){3,8})", txt, re.I)
            if m:
                nums = [float(x.replace(",", ".")) for x in re.findall(r"-?\d+[,.]?\d*", m.group(1))]
                pos = [x for x in nums if 2 <= x <= 9]
                if len(pos) >= 3: res[key] = {"min_depth": pos[0], "depth": pos[-2], "draft": pos[-1]}
                elif pos: res[key] = {"draft": pos[-1]}
        if not res:
            m2 = re.findall(r"проходн\w*\s+осадк\w*[^\d]{0,60}(\d[,.]\d{1,2})", txt, re.I)
            if m2: res["oil"] = {"draft": float(m2[0].replace(",", "."))}
        if res:
            out["latest"] = {"date": when, "oil": res.get("oil"), "dry": res.get("dry"), "src": "Служба капитана морского порта Махачкала (ampastra.ru)"}
            out["history"][today.isoformat()] = {k: v["draft"] for k, v in res.items()}
            for k in list(out["history"]):
                if k < (today - datetime.timedelta(days=400)).isoformat(): del out["history"][k]
        else: errors["makh"] = "осадка не найдена на странице"
    except Exception as e: errors["makh"] = str(e)[:120]

# ---- 3c. Актау / Курык / Алят: официальной публикации проходной осадки в интернете нет — собираем упоминания из новостей (news.json) ----
def drafts_from_news():
    out = M.setdefault("draft_news", [])
    try:
        nj = os.path.join(HERE, "news.json")
        if not os.path.exists(nj): return
        items = json.load(open(nj, encoding="utf-8")).get("items", [])
        seen = {x["u"] for x in out}
        for it in items:
            t = it.get("t", ""); low = t.lower()
            if not re.search(r"осадк|глубин|дноуглуб", low): continue
            port = "Актау" if "актау" in low else "Курык" if "курык" in low else "Алят/Баку" if ("алят" in low or "баку" in low) else "Туркменбаши" if "туркменбаш" in low else None
            if not port or it["u"] in seen: continue
            m = re.search(r"(\d[,.]\d{1,2})\s*(?:м\b|метр)", low)
            out.append({"port": port, "d": it.get("d", "")[:10], "t": t, "u": it["u"], "draft": float(m.group(1).replace(",", ".")) if m else None})
            seen.add(it["u"])
        out.sort(key=lambda x: x["d"], reverse=True); del out[60:]
    except Exception as e: errors["draft_news"] = str(e)[:120]

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

REL = {}  # название -> чем оно для нас является
def _rel(n, txt):
    REL.setdefault(n, []); 
    if txt not in REL[n]: REL[n].append(txt)
def our_names():
    names = set()
    def rd(f):
        p = os.path.join(HERE, f)
        return list(csv.DictReader(open(p, encoding="utf-8"))) if os.path.exists(p) else []
    cr = rd("data/crude.csv")
    agg = {}
    for r in cr:
        v = r["vessel"].strip(); y = r["month"][:4]
        a = agg.setdefault(v, {"n": 0, "y0": y, "y1": y, "own": set()}); a["n"] += 1; a["y0"] = min(a["y0"], y); a["y1"] = max(a["y1"], y)
        if r.get("owner"): a["own"].add(r["owner"].strip())
    for v, a in agg.items():
        names.add(v); _rel(v, f"танкер в перевалке через Актау: {a['n']} партий {a['y0']}–{a['y1']}" + (f", судовладелец по файлу: {', '.join(sorted(a['own'])[:3])}" if a["own"] else ""))
    tk = {}
    for r in rd("data/tankers.csv"):
        v = r["vessel"].strip(); tk[v] = tk.get(v, 0) + 1
    for v, n in tk.items():
        names.add(v); _rel(v, f"танкер в сводках диспетчера Актау: {n} судозаходов")
    os_ = {}
    for r in rd("data/openseas.csv"):
        sh = r["ship"].strip(); ch = r["charterer"].strip(); y = r["year"]
        a = os_.setdefault(("ship", sh), {"n": 0, "y0": y, "y1": y, "fleet": r["fleet"], "ch": set()}); a["n"] += 1; a["y0"] = min(a["y0"], y); a["y1"] = max(a["y1"], y); a["ch"].add(ch)
        b = os_.setdefault(("ch", ch), {"n": 0, "y0": y, "y1": y}); b["n"] += 1; b["y0"] = min(b["y0"], y); b["y1"] = max(b["y1"], y)
    FL = {"Own fleet": "собственный флот КМТФ", "ADP fleet": "флот AD Ports (СП)", "3rd party": "сторонний танкер, зафрахтованный для наших грузов"}
    for (kind, n), a in os_.items():
        if not n: continue
        names.add(n)
        if kind == "ship": _rel(n, f"открытые моря: {FL.get(a['fleet'], a['fleet'])}, {a['n']} рейсов {a['y0']}–{a['y1']} (фрахтователи: {', '.join(sorted(a['ch'])[:3])})")
        else: _rel(n, f"фрахтователь по открытым морям: {a['n']} рейсов {a['y0']}–{a['y1']}")
    for c in COMPANIES: names.add(c); _rel(c, "контрагент/участник рынка Каспия (проверяем по названию)")
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
                matches.append({"list": list_name, "name": name, "type": typ, "program": prog[:120], "ours": ours[k], "rel": "; ".join(REL.get(ours[k], []))[:300]})
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

for step in (nbk, lambda: fred("DCOILBRENTEU", "brent"), lambda: fred("DCOILWTICO", "wti"), grealm, vkk, makhachkala, drafts_from_news, kazhydromet, bunker, sanctions):
    try: step()
    except Exception as e: errors[getattr(step, "__name__", "step")] = str(e)[:120]
M["errors"] = errors; M["fetched"] = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
json.dump(M, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
print(f"market: fx {len(M['fx'])} дн., oil {len(M['oil'])} дн., sea {list(M['sea'].keys())}, bunker {'да' if M.get('bunker', {}).get('latest') else 'нет'}, санкции: совпадений {len(M.get('sanctions', {}).get('matches', []))}; ошибки: {errors}", file=sys.stderr)
