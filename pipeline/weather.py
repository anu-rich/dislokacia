"""Прогноз по точкам маршрутов (Open-Meteo) -> weather.json рядом со скриптом."""
import json, datetime, pathlib, sys, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
PTS = [("Актау", 43.65, 51.15), ("Актау–Баку, середина", 42.0, 50.4), ("Алят / Баку", 40.3, 50.1), ("Актау–Махачкала, середина", 43.3, 49.3), ("Махачкала", 42.98, 47.6)]
lat = ",".join(str(p[1]) for p in PTS); lon = ",".join(str(p[2]) for p in PTS)
def get(url):
    with urllib.request.urlopen(url, timeout=40) as r: return json.load(r)
def every3(a): return a[::3] if a else None
w = get(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility,precipitation,temperature_2m&wind_speed_unit=ms&forecast_days=4&timezone=Asia%2FAqtau")
try: m = get(f"https://marine-api.open-meteo.com/v1/marine?latitude={lat}&longitude={lon}&hourly=wave_height,wave_period,wave_direction&forecast_days=4&timezone=Asia%2FAqtau")
except Exception as e: print("marine:", e, file=sys.stderr); m = []
if isinstance(w, dict): w = [w]
if isinstance(m, dict): m = [m]
points = []
for i, (name, la, lo) in enumerate(PTS):
    h = w[i]["hourly"]; mh = m[i]["hourly"] if i < len(m) and m[i].get("hourly") else {}
    points.append({"name": name, "lat": la, "lon": lo, "time": every3(h["time"]), "wind": every3(h["wind_speed_10m"]), "gust": every3(h["wind_gusts_10m"]), "wdir": every3(h["wind_direction_10m"]),
                   "vis": every3(h["visibility"]), "rain": every3(h["precipitation"]), "temp": every3(h["temperature_2m"]),
                   "wave": every3(mh.get("wave_height")), "period": every3(mh.get("wave_period")), "wavedir": every3(mh.get("wave_direction"))})
doc = {"fetched": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "step_hours": 3, "source": "Open-Meteo (ECMWF/ICON), волны: Open-Meteo Marine", "points": points}
(HERE / "weather.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("weather.json:", len(points), "точек")
