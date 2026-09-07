"""Разбор оперативного снимка из файла «Дислокация судов»: листы «Танкера», «Сухогрузы», «Открытые моря» и таблицы судовых запасов.
Устойчив к разной раскладке блоков: блок = столбцы от заголовка «Наименование судна» до следующего такого заголовка в той же строке.
"""
import openpyxl, datetime, re, json, sys

SECTION_WORDS = {"причал": "berth", "причалы": "berth", "рейд": "roads", "подход": "approach", "подход / рейд": "roads", "подход/рейд": "roads",
                 "подход / отход": "approach", "отход": "departed", "суда отошедшие за последние сутки": "departed", "отошедшие за сутки": "departed",
                 "рейд / подход": "roads"}
STOP = ("судовые запасы", "прогноз", "погод")
def section_of(low):
    if low in SECTION_WORDS: return SECTION_WORDS[low]
    if low.startswith("причал"): return "berth"
    if low.startswith("суда отошедшие") or low.startswith("отошедшие") or low.startswith("отход"): return "departed"
    if low.startswith("подход") and "рейд" in low: return "roads"
    if low.startswith("подход"): return "approach"
    if low.startswith("рейд"): return "roads"
    return None

def norm(s): return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()
def fmt(v):
    if isinstance(v, datetime.datetime): return v.strftime("%Y-%m-%d %H:%M")
    if isinstance(v, datetime.date): return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return norm(v)
def is_hdr(v): return isinstance(v, str) and re.match(r"^\s*[hн]аименование судна", v, re.I) is not None
def is_port(v):
    if not isinstance(v, str): return False
    s = v.strip().lower()
    if s.startswith("abu dhabi"): return True
    if re.match(r"^(порт|порты)\b", s) or re.match(r"^п\.\s*\S", s) or re.match(r"^п\s+\S", s): return True
    return re.search(r"\bпорт\b", s) is not None and len(s) < 40

def grid(ws):
    return [list(r) for r in ws.iter_rows(values_only=True)]

def parse_sheet(G):
    """returns list of {port, sections:{...}}"""
    nrows = len(G); ncols = max((len(r) for r in G), default=0)
    hdr_cells = [(r, c) for r in range(nrows) for c in range(len(G[r])) if is_hdr(G[r][c])]
    if not hdr_cells: return []
    rows_with_hdr = sorted(set(r for r, c in hdr_cells))
    blocks = []  # (r0, c0, c1)
    for r in rows_with_hdr:
        cs = sorted(c for rr, c in hdr_cells if rr == r)
        for i, c in enumerate(cs):
            lim = (cs[i + 1] - 1) if i + 1 < len(cs) else ncols - 1
            # ширина блока = до последней ячейки заголовка (допускаем разрыв до 2 пустых ячеек — объединённые ячейки)
            c1 = c; gap = 0
            for cc in range(c + 1, lim + 1):
                v = G[r][cc] if cc < len(G[r]) else None
                if is_port(v) or (v is not None and not isinstance(v, str) and norm(v)): break
                # столбец таблицы запасов ("Суда" рядом по вертикали) — не наш
                if any(cc < len(G[rr]) and isinstance(G[rr][cc], str) and norm(G[rr][cc]).lower() == "суда" for rr in range(max(0, r - 3), min(nrows, r + 2))): break
                if norm(v): c1 = cc; gap = 0
                else:
                    gap += 1
                    if gap > 2: break
            c1 = min(c1 + 1, lim)  # объединённая последняя ячейка
            blocks.append((r, c, c1))
    # end row of a block = next header row that overlaps its columns
    out = []
    for (r0, c0, c1) in blocks:
        r_end = nrows
        for (r, c, cc1) in blocks:
            if r > r0 and not (cc1 < c0 or c > c1): r_end = min(r_end, r)
        # port name: nearest cell above header within columns
        port = None
        for r in range(r0 - 1, max(-1, r0 - 9), -1):
            for c in range(max(0, c0 - 1), min(c1, len(G[r]) - 1) + 1):
                if is_port(G[r][c]): port = norm(G[r][c]); break
            if port: break
            if r < r0 - 1 and any(is_hdr(G[r][c]) for c in range(max(0, c0 - 1), min(c1, len(G[r]) - 1) + 1)): break
        if not port: port = "порт ?"
        hdr = [norm(G[r0][c]).lower() if c < len(G[r0]) else "" for c in range(c0, c1 + 1)]
        # sub-columns without header right after SHPR -> terminal
        for i, h in enumerate(hdr):
            if h == "shpr" and i + 1 < len(hdr) and not hdr[i + 1]: hdr[i + 1] = "терминал"
        sections = {}; section = None
        for r in range(r0 + 1, r_end):
            row = G[r]; cells = [row[c] if c < len(row) else None for c in range(c0, c1 + 1)]
            first = norm(cells[0]); low = first.lower()
            nonempty = [x for x in cells if norm(x)]
            if not nonempty: continue
            if any(w in low for w in STOP): break
            if is_port(cells[0]): break
            sec = section_of(low) if len(nonempty) <= 2 else None
            if sec:
                section = sec; sections.setdefault(section, []); continue
            if section is None: continue
            rec = {}
            for i, c in enumerate(cells):
                if hdr[i] and norm(c): rec[hdr[i]] = fmt(c)
            if not rec: continue
            name_key = next((k for k in rec if re.match(r"^[hн]аименование судна", k)), None)
            if not name_key:
                b = rec.get("пр.№") or rec.get("причал №")
                if b and section == "berth": sections[section].append({"vessel": None, "berth": b, "free": True})
                continue
            name = rec.pop(name_key)
            if name.lower().startswith("причал закрыт") or name.lower().startswith("закрыт"):
                sections[section].append({"vessel": None, "berth": rec.get("пр.№") or rec.get("причал №"), "closed": True, "note": rec.get("позиция", "") or rec.get("операция", "")})
                continue
            item = {"vessel": name}; item.update(rec)
            sections[section].append(item)
        out.append({"port": port, "sections": sections})
    return out

def parse_supplies(G):
    rows = []; on = False; hdr = None; c0 = 0
    for r, row in enumerate(G):
        for c, v in enumerate(row):
            if isinstance(v, str) and "судовые запасы" in v.lower():
                on = True; c0 = c; hdr = None; break
        if not on: continue
        first = norm(row[c0]) if c0 < len(row) else ""
        if first.lower() == "суда":
            hdr = [norm(x) for x in row[c0:]]; continue
        if hdr:
            if first and any(norm(x) for x in row[c0 + 1:c0 + len(hdr)]):
                rows.append({hdr[i]: fmt(x) for i, x in enumerate(row[c0:c0 + len(hdr)]) if i < len(hdr) and hdr[i] and norm(x)})
            elif not first:
                on = False; hdr = None
    return rows

def sheet_ts(G):
    for row in G[:4]:
        for v in row:
            if isinstance(v, datetime.datetime): return v
    return None

def parse(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    res = {"file": path.replace("\\", "/").split("/")[-1]}
    names = {n.lower(): n for n in wb.sheetnames}
    def get(*cands):
        for c in cands:
            for k, n in names.items():
                if k.startswith(c): return wb[n]
        return None
    ws = get("танкер"); G = grid(ws) if ws else []
    ts = sheet_ts(G)
    res["timestamp"] = fmt(ts) if ts else None
    res["tankers"] = parse_sheet(G) if G else []
    res["tanker_supplies"] = parse_supplies(G) if G else []
    wx = ""
    for r, row in enumerate(G):
        for i, v in enumerate(row):
            if isinstance(v, str) and "прогноз" in v.lower() and "погод" in v.lower():
                body = " ".join(norm(x) for x in G[r + 1][i:i + 12] if norm(x)) if r + 1 < len(G) else ""
                wx = norm(v) + ": " + body
    res["weather"] = wx
    ws = get("сухогруз"); G = grid(ws) if ws else []
    res["bulk"] = parse_sheet(G) if G else []
    res["bulk_supplies"] = parse_supplies(G) if G else []
    ws = get("открытые моря")
    res["open_seas"] = parse_sheet(grid(ws)) if ws else []
    for p in res["open_seas"]:
        if p["port"] == "порт ?": p["port"] = "Открытые моря"
    # open seas берём и с листа танкеров, если там блок Abu Dhabi / Новороссийск
    return res

if __name__ == "__main__":
    r = parse(sys.argv[1])
    if len(sys.argv) > 2: json.dump(r, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    print(r["timestamp"])
    for k in ["tankers", "bulk", "open_seas"]:
        for p in r[k]: print("  ", k, p["port"], {s: len(v) for s, v in p["sections"].items()})
    print("  sup", len(r["tanker_supplies"]), len(r["bulk_supplies"]), "| wx:", r["weather"][:60])
