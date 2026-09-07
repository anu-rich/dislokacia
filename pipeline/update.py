"""Обновление дашборда «Дислокация флота».
Использование:  python3 update.py <файл_дислокации.xlsx> [ещё файлы...]
Работает из папки dashboard/: читает data/*.csv (история), добавляет статистику из переданных файлов,
берёт снимок из самого свежего файла, собирает dislokacia.html рядом.
"""
import sys, os, csv, datetime, glob, json, re
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.chdir(HERE)
os.makedirs("data", exist_ok=True)
import parse_stats, parse_snapshot

files = sorted(sys.argv[1:], key=lambda f: os.path.basename(f))
if not files:
    sys.exit("укажи хотя бы один xlsx файл дислокации")

def load_csv(path, dtcols, keycols=("dep","arr")):
    d = {}
    if not os.path.exists(path): return d
    for r in csv.DictReader(open(path, newline="")):
        for c in dtcols:
            r[c] = datetime.datetime.strptime(r[c], "%Y-%m-%d %H:%M") if r.get(c) else None
        for c in r:
            if c not in dtcols and r[c] == "": r[c] = None
        key = (r["vessel"], next(r[c] for c in keycols if r.get(c)).strftime("%Y-%m-%d %H:%M"))
        d[key] = r
    return d

tankers = load_csv("data/tankers.csv", ["arr", "berth_at", "load_start", "load_end", "dep"])
bulk = load_csv("data/bulk.csv", ["arr", "berth_at", "unload_start", "unload_end", "load_start", "load_end", "dep"])
bunker = load_csv("data/bunker.csv", ["arr", "b_start", "b_end", "dep"], ("b_start", "arr"))
n0 = (len(tankers), len(bulk), len(bunker))
for f in files:
    parse_stats.parse_file(f, tankers, bulk, bunker)
parse_stats.dump(tankers, "data/tankers.csv"); parse_stats.dump(bulk, "data/bulk.csv"); parse_stats.dump(bunker, "data/bunker.csv")
print("история: танкеры %d→%d, сухогрузы %d→%d, бункеровки %d→%d" % (n0[0], len(tankers), n0[1], len(bulk), n0[2], len(bunker)))

snap = parse_snapshot.parse(files[-1])
json.dump(snap, open("data/snapshot.json", "w"), ensure_ascii=False, default=str)
print("снимок:", snap["timestamp"], "из", os.path.basename(files[-1]))

# история снимков (для просмотра любой даты)
import parse_history
hist_path = "data/snapshots.json"
hist = {}
if os.path.exists(hist_path):
    for s in json.load(open(hist_path, encoding="utf-8")): hist[s["ts"]] = s
for f in files:
    try:
        sn = parse_snapshot.parse(f) if f != files[-1] else snap
        if sn["timestamp"]:
            c = parse_history.compact(sn); hist[c["ts"]] = c
    except Exception as e:
        print("снимок не добавлен:", os.path.basename(f), e)
json.dump(sorted(hist.values(), key=lambda s: s["ts"]), open(hist_path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("снимков в архиве:", len(hist))

import build_data  # пишет data/data.json
t = open("template.html", encoding="utf-8").read(); js = open("app.js", encoding="utf-8").read()
d = open("data/data.json", encoding="utf-8").read().replace("</script", "<\\/script")
open("dislokacia.html", "w", encoding="utf-8").write(t.replace("__DATA__", d).replace("__JS__", js))
print("собран dislokacia.html")
