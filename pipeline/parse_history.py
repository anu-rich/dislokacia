"""Собирает компактную историю снимков дислокации из множества файлов.
python3 parse_history.py <out.json> <файлы или папки...>
Если out.json уже есть — дополняет (ключ = timestamp снимка), файлы с тем же timestamp пропускаются.
"""
import sys, os, json, glob, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse_snapshot

KEYMAP = {"операция": "o", "позиция": "z", "shpr": "h", "терминал": "e", "порт": "i",
          "дата прихода на рейд": "a", "приход на рейд": "a", "дата постановки к причалу": "t", "постановка к причалу": "t",
          "пр.№": "b", "причал №": "b", "терминал причал №": "b", "дата и время отхода": "d",
          "количество груза": "c", "груз": "c", "кол-во груза": "c", "кол-во взятого груза": "c", "вид груза": "k", "осадка": "r", "дфэ": "f",
          "начало погрузки": "ls", "окончание погрузки": "le", "начало выгрузки": "us", "окончание выгрузки": "ue"}

def compact(snap):
    out = {"ts": snap["timestamp"], "f": snap["file"], "wx": snap.get("weather", ""), "ports": [], "sup": []}
    for seg, key in (("t", "tankers"), ("b", "bulk"), ("o", "open_seas")):
        for p in snap.get(key, []):
            port = {"p": p["port"], "g": seg, "sec": {}}
            for sec, items in p["sections"].items():
                lst = []
                for it in items:
                    if it.get("vessel") is None:
                        lst.append({"b": it.get("berth"), "free": bool(it.get("free")), "closed": bool(it.get("closed")), "note": it.get("note", "")}); continue
                    rec = {"n": it["vessel"]}
                    seen = set()
                    for k, v in it.items():
                        if k == "vessel": continue
                        kk = KEYMAP.get(k)
                        if not kk:
                            continue
                        if kk in seen:  # второй «вид груза» / «кол-во» (погрузка) -> суффикс 2
                            kk = kk + "2"
                        seen.add(kk); rec[kk] = v
                    lst.append(rec)
                port["sec"][sec] = lst
            out["ports"].append(port)
    for r in snap.get("tanker_supplies", []) + snap.get("bulk_supplies", []):
        ks = list(r.keys())
        def pick(rx):
            k = next((x for x in ks if re.search(rx, x, re.I)), None); return r.get(k) if k else None
        out["sup"].append({"n": r.get("Суда"), "fuel": pick(r"диз"), "hfo": pick(r"тяж"), "oil": pick(r"масло"), "water": pick(r"^вода"), "food": pick(r"колпит"), "bw": pick(r"бут")})
    return out

def main():
    outp = sys.argv[1]
    files = []
    for a in sys.argv[2:]:
        if os.path.isdir(a): files += glob.glob(os.path.join(a, "**", "*.xlsx"), recursive=True)
        else: files.append(a)
    files = sorted(set(files), key=os.path.basename)
    hist = {}
    if os.path.exists(outp):
        for s in json.load(open(outp, encoding="utf-8")): hist[s["ts"]] = s
    n0 = len(hist); bad = []
    for f in files:
        try:
            s = parse_snapshot.parse(f)
            if not s["timestamp"]: bad.append((f, "нет времени сводки")); continue
            c = compact(s)
            hist[c["ts"]] = c
        except Exception as e:
            bad.append((f, str(e)))
    lst = sorted(hist.values(), key=lambda s: s["ts"])
    json.dump(lst, open(outp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"снимков: {n0} -> {len(lst)}; файлов обработано {len(files)}, ошибок {len(bad)}; размер {os.path.getsize(outp)/1e6:.1f} МБ")
    for f, e in bad[:20]: print("  !", os.path.basename(f), e)

if __name__ == "__main__":
    main()
