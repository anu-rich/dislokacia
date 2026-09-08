"""Разбор файлов «Caspian Sea Crude Oil» (перевалка нефти через порт Актау по коносаментам).
python3 parse_crude.py <out.csv> <xlsx...>
Каждый месячный лист -> строки: month, arr, vessel, shipper, charterer, cargo, tons, dep, bl, direction, owner, src.
Объём относится к месяцу ЛИСТА (по дате коносамента) — так учитываются переходящие рейсы.
"""
import sys, re, csv, datetime, os
import openpyxl

MONTHS = {"январь": 1, "февраль": 2, "март": 3, "апрель": 4, "май": 5, "июнь": 6, "июль": 7, "август": 8, "сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12,
          "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12}

def s(v): return "" if v is None else str(v).strip()
def dt(v):
    if isinstance(v, datetime.datetime): return v.strftime("%Y-%m-%d %H:%M")
    if isinstance(v, datetime.date): return v.strftime("%Y-%m-%d")
    return s(v)
def num(v):
    if isinstance(v, (int, float)): return float(v)
    t = s(v).replace(" ", "").replace(",", ".")
    try: return float(t)
    except Exception: return None

def find_header(rows):
    for i, r in enumerate(rows[:12]):
        cells = [s(c).lower() for c in r]
        if any("судно" in c for c in cells) and any("тонн" in c for c in cells):
            return i, cells
    return None, None

def parse_sheet(ws, year, month, src):
    rows = list(ws.iter_rows(values_only=True))
    hi, cells = find_header(rows)
    if hi is None: return []
    def col(*keys):
        for j, c in enumerate(cells):
            if any(k in c for k in keys): return j
        return None
    c_vessel = col("судно"); c_arr = col("дата прибытия", "келу"); c_ship = col("компания (отправ"); c_chart = col("перевозчик", "тасымалдаушы")
    c_cargo = col("род груза", "жүк"); c_tons = col("тонн"); c_dep = col("дата отхода", "шығу"); c_bl = col("коноса"); c_dir = col("направление", "бағыт"); c_own = col("судовладелец", "кеме иесі")
    if c_tons is None or c_vessel is None: return []
    t_end = c_dep if c_dep is not None else c_tons + 3
    out = []
    for r in rows[hi + 1:]:
        v = s(r[c_vessel]) if c_vessel < len(r) else ""
        if not v or v.upper().startswith("ИТОГО") or "итог" in v.lower(): continue
        if c_arr is not None and not isinstance(r[c_arr], (datetime.datetime, datetime.date)) and not s(r[c_arr]):
            # строки без даты прибытия и без тонн пропускаем
            pass
        tons = 0.0; has = False
        for j in range(c_tons, t_end):
            n = num(r[j]) if j < len(r) else None
            if n is not None: tons += n; has = True
        if not has or tons == 0: continue
        if v.lower() in ("исполнитель", "орындаушы"): continue
        out.append({"month": f"{year}-{month:02d}", "arr": dt(r[c_arr]) if c_arr is not None else "", "vessel": re.sub(r"\s+", " ", v),
                    "shipper": s(r[c_ship]) if c_ship is not None else "", "charterer": s(r[c_chart]) if c_chart is not None else "",
                    "cargo": s(r[c_cargo]) if c_cargo is not None else "", "tons": round(tons, 3),
                    "dep": dt(r[c_dep]) if c_dep is not None else "", "bl": s(r[c_bl]) if c_bl is not None else "",
                    "direction": s(r[c_dir]) if c_dir is not None else "", "owner": s(r[c_own]) if c_own is not None else "", "src": src})
    return out

def parse_file(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{2,4})", os.path.basename(path))
    year = int(m.group(3)) if m else None
    if year is not None and year < 100: year += 2000
    recs = []
    for name in wb.sheetnames:
        key = name.strip().lower()
        if key not in MONTHS: continue
        recs += parse_sheet(wb[name], year, MONTHS[key], os.path.basename(path))
    return recs

FIELDS = ["month", "arr", "vessel", "shipper", "charterer", "cargo", "tons", "dep", "bl", "direction", "owner", "src"]
def main():
    outp = sys.argv[1]; files = sys.argv[2:]
    old = {}
    if os.path.exists(outp):
        for r in csv.DictReader(open(outp, encoding="utf-8")): old.setdefault(r["month"][:4], []).append(r)
    new = {}
    for f in files:
        for r in parse_file(f): new.setdefault(r["month"][:4], []).append(r)
    # более свежий файл за год заменяет данные этого года целиком
    old.update(new)
    rows = [r for y in sorted(old) for r in old[y]]
    with open(outp, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS); w.writeheader(); w.writerows(rows)
    print(f"crude: {len(rows)} строк, годы {sorted(old)}", file=sys.stderr)

if __name__ == "__main__": main()
