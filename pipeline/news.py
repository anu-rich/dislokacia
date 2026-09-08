"""Мониторинг отраслевых новостей (Каспий, ТМТМ, порты Актау/Курык/Баку, КМТФ, АСКО) -> news.json.
Источники: Google News RSS по набору запросов (ru/en) + прямые RSS отраслевых сайтов с фильтром по ключевым словам.
Запуск: python news.py  (пишет news.json рядом; при ошибке сети сохраняет то, что удалось).
"""
import json, re, sys, os, html, datetime, email.utils, urllib.request, urllib.parse, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "news.json")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) dislokacia-news/1.0"}

QUERIES = [
    ("ru", "Каспий судоходство"), ("ru", "Транскаспийский маршрут ТМТМ"), ("ru", "Казмортрансфлот"), ("ru", "порт Актау"), ("ru", "порт Курык"),
    ("ru", "танкер Каспийское море нефть"), ("ru", "паром Каспий Баку Актау"), ("ru", "Средний коридор Казахстан контейнеры"), ("ru", "порт Алят Баку"),
    ("ru", "КазМунайГаз танкеры"), ("ru", "Казахстан экспорт нефти Баку Джейхан"), ("ru", "уровень Каспийского моря обмеление"),
    ("en", "Caspian shipping"), ("en", "Middle Corridor Trans-Caspian route"), ("en", "Aktau port"), ("en", "Kazmortransflot"), ("en", "ASCO Azerbaijan Caspian Shipping"),
    ("en", "Caspian tanker Kazakhstan oil Baku"), ("en", "Caspian Sea level shipping"),
    ("ru", "ставки фрахта танкеры афрамакс"), ("en", "Aframax freight rates Black Sea Mediterranean"), ("en", "tanker freight market weekly Aframax Suezmax"),
    ("ru", "ТМТМ объем перевозок тыс тонн TEU"), ("en", "Middle Corridor cargo volume TEU"), ("ru", "порт Актау грузооборот"), ("ru", "порт Курык грузооборот паром"),
    ("ru", "КТК отгрузка нефти Новороссийск"), ("en", "CPC Blend exports Novorossiysk"), ("ru", "Баку-Тбилиси-Джейхан прокачка нефти Казахстан"), ("en", "BTC pipeline Kazakh oil Ceyhan"),
    ("ru", "бункерное топливо цены порты"), ("en", "bunker prices VLSFO Istanbul Novorossiysk"),
]
FEEDS = [  # прямые RSS (фильтруются по ключевым словам)
    "https://portnews.ru/rss/", "https://morvesti.ru/rss/", "https://casp-geo.ru/feed/", "https://timesca.com/feed/", "https://astanatimes.com/feed/",
    "https://kapital.kz/rss", "https://www.inform.kz/rss/rus", "https://report.az/rss/", "https://www.trend.az/feeds/index.rss",
]
KEYS = ["фрахт", "freight", "aframax", "афрамакс", "suezmax", "суэцмакс", "ктк", "cpc", "джейхан", "ceyhan", "btc", "бтд", "бункер", "bunker", "vlsfo", "грузооборот", "teu",
        "каспи", "актау", "курык", "тмтм", "транскаспий", "средний коридор", "казмортрансфлот", "кмтф", "баку", "алят", "сангачал", "махачкала", "танкер", "паром", "аско", "asco",
        "caspian", "aktau", "kuryk", "middle corridor", "trans-caspian", "kazmortransflot", "kmtf", "baku", "alat", "tanker", "kazmunaygas", "казмунайгаз", "судоходств", "shipping", "бункеров", "туркменбаши", "turkmenbashi", "actau"]
STRONG = ["каспи", "актау", "курык", "тмтм", "транскаспий", "средний коридор", "казмортрансфлот", "кмтф", "caspian", "aktau", "kuryk", "middle corridor", "trans-caspian", "kazmortransflot", "kmtf", "алят", "alat", "аско", "asco"]

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()

def pdate(s):
    try: return email.utils.parsedate_to_datetime(s)
    except Exception:
        for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try: return datetime.datetime.strptime(s.strip()[:len(fmt) + 5], fmt)
            except Exception: pass
    return None

def parse_rss(xml_bytes, src_hint=""):
    items = []
    try: root = ET.fromstring(xml_bytes)
    except Exception: return items
    ns = {"atom": "http://www.w3.org/2005/Atom", "dc": "http://purl.org/dc/elements/1.1/"}
    for it in root.iter("item"):
        t = html.unescape((it.findtext("title") or "").strip()); link = (it.findtext("link") or "").strip()
        d = pdate(it.findtext("pubDate") or it.findtext("dc:date", namespaces=ns) or "")
        srcel = it.find("source"); src = (srcel.text if srcel is not None and srcel.text else "").strip()
        if src and t.endswith(" - " + src): t = t[:-(len(src) + 3)]
        elif not src and " - " in t: t, src = t.rsplit(" - ", 1)
        if not src: src = src_hint
        desc = re.sub(r"<[^>]+>", " ", html.unescape(it.findtext("description") or ""))
        items.append({"t": t, "u": link, "d": d, "s": src.strip(), "x": re.sub(r"\s+", " ", desc).strip()[:220]})
    for it in root.iter("{http://www.w3.org/2005/Atom}entry"):
        t = html.unescape((it.findtext("atom:title", namespaces=ns) or "").strip())
        le = it.find("atom:link", ns); link = le.get("href") if le is not None else ""
        d = pdate(it.findtext("atom:published", namespaces=ns) or it.findtext("atom:updated", namespaces=ns) or "")
        items.append({"t": t, "u": link, "d": d, "s": src_hint, "x": ""})
    return items

def relevant(it):
    txt = (it["t"] + " " + it["x"]).lower()
    return any(k in txt for k in KEYS)

def score(it):
    txt = (it["t"] + " " + it["x"]).lower()
    return sum(2 for k in STRONG if k in txt) + sum(1 for k in KEYS if k in txt)

def is_ru(t): return len(re.findall(r"[а-яА-ЯёЁ]", t)) >= max(3, len(t) // 4)
def translate(texts):
    """Заголовки на английском -> русский (Google Translate, публичный endpoint). При ошибке возвращает None."""
    out = []
    for t in texts:
        try:
            u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + urllib.parse.quote(t)
            r = json.loads(fetch(u, timeout=15).decode("utf-8", "ignore"))
            out.append("".join(seg[0] for seg in r[0] if seg and seg[0]))
        except Exception: out.append(None)
    return out

def host(u):
    try: return urllib.parse.urlparse(u).netloc.replace("www.", "")
    except Exception: return ""

def main():
    allit = []; ok = 0; fail = []
    for lang, q in QUERIES:
        url = "https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + ("&hl=ru&gl=KZ&ceid=KZ:ru" if lang == "ru" else "&hl=en-US&gl=US&ceid=US:en")
        try: allit += parse_rss(fetch(url)); ok += 1
        except Exception as e: fail.append(f"gnews:{q}: {e}")
    for f in FEEDS:
        try: allit += [it for it in parse_rss(fetch(f), host(f)) if relevant(it)]; ok += 1
        except Exception as e: fail.append(f"{host(f)}: {e}")
    now = datetime.datetime.now(datetime.timezone.utc)
    seen = {}; out = []
    for it in allit:
        if not it["t"] or not it["u"]: continue
        d = it["d"]
        if d is not None and d.tzinfo is None: d = d.replace(tzinfo=datetime.timezone.utc)
        if d is None or (now - d).days > 45: continue
        key = re.sub(r"[^a-zа-я0-9]", "", it["t"].lower())[:70]
        if key in seen: continue
        seen[key] = 1
        out.append({"t": it["t"], "u": it["u"], "d": d.strftime("%Y-%m-%d %H:%M"), "s": it["s"] or host(it["u"]), "sc": score(it)})
    out.sort(key=lambda x: x["d"], reverse=True)
    out = [o for o in out if o["sc"] >= 2][:140]
    # перевод не-русских заголовков (кэш из предыдущего news.json, чтобы не переводить повторно)
    cache = {}
    if os.path.exists(OUT):
        try:
            for it in json.load(open(OUT, encoding="utf-8")).get("items", []):
                if it.get("t_en"): cache[it["t_en"]] = it["t"]
        except Exception: pass
    todo = [o for o in out if not is_ru(o["t"])]
    need = [o for o in todo if o["t"] not in cache]
    tr = translate([o["t"] for o in need]) if need else []
    for o, t in zip(need, tr):
        if t: cache[o["t"]] = t
    kept = []
    for o in out:
        if not is_ru(o["t"]):
            if o["t"] in cache: o["t_en"] = o["t"]; o["t"] = cache[o["t"]]
            else: continue  # перевести не удалось — не показываем
        kept.append(o)
    out = kept[:120]
    prev = {}
    if os.path.exists(OUT):
        try: prev = json.load(open(OUT, encoding="utf-8"))
        except Exception: prev = {}
    if not out and prev.get("items"):  # сеть упала — оставляем старое
        print("news: ничего не получено, оставляю старый news.json", file=sys.stderr); return
    json.dump({"fetched": now.strftime("%Y-%m-%d %H:%M"), "sources_ok": ok, "errors": fail[:10], "items": out}, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"news: {len(out)} новостей, источников ок {ok}, ошибок {len(fail)}", file=sys.stderr)

if __name__ == "__main__": main()
