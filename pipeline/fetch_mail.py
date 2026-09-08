"""Забирает новые вложения «Дислокация судов» из рабочей почты (Exchange EWS, NTLM) в export/<год>/.
Настройки — в config.env (см. config.env.example). Печатает пути новых файлов, по одному в строке.
"""
import os, sys, re, datetime, pathlib
from exchangelib import Credentials, Configuration, Account, DELEGATE, NTLM, EWSDateTime, EWSTimeZone, FileAttachment
from exchangelib.protocol import BaseProtocol, NoVerifyHTTPAdapter

HERE = pathlib.Path(__file__).resolve().parent
def load_env(p):
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"'))
load_env(HERE / "config.env")

SERVER = os.environ.get("EWS_SERVER", "mail.kmg.kz")
EMAIL = os.environ["EWS_EMAIL"]
USER = os.environ.get("EWS_USER", EMAIL)
PASS = os.environ["EWS_PASS"]
EXPORT = pathlib.Path(os.environ.get("EXPORT_DIR", HERE / "export"))
STATE = HERE / "state" / "last_received.txt"
DAYS = int(os.environ.get("FETCH_DAYS", "3"))
if os.environ.get("EWS_NO_VERIFY", "0") == "1":
    BaseProtocol.HTTP_ADAPTER_CLS = NoVerifyHTTPAdapter

creds = Credentials(username=USER, password=PASS)
URL = os.environ.get("EWS_URL", "").strip()   # полный адрес EWS, если он не на EWS_SERVER (напр. https://autodiscover.kmtf.kmg.kz/EWS/Exchange.asmx)
if URL:
    config = Configuration(service_endpoint=URL, credentials=creds, auth_type=NTLM)
else:
    config = Configuration(server=SERVER, credentials=creds, auth_type=NTLM)
acc = Account(primary_smtp_address=EMAIL, config=config, autodiscover=False, access_type=DELEGATE)
tz = EWSTimeZone("Asia/Aqtau")

STATE.parent.mkdir(parents=True, exist_ok=True)
last = None
if STATE.exists():
    try: last = datetime.datetime.fromisoformat(STATE.read_text().strip())
    except Exception: last = None
since = datetime.datetime.now(tz) - datetime.timedelta(days=DAYS)
if last and last.tzinfo is None: last = last.replace(tzinfo=tz)
if last and last > since: since = last

def ews_dt(d):
    if d.tzinfo is None: d = d.replace(tzinfo=tz)
    d = datetime.datetime(d.year, d.month, d.day, d.hour, d.minute, d.second, tzinfo=d.tzinfo).astimezone(tz)
    return EWSDateTime.from_datetime(datetime.datetime(d.year, d.month, d.day, d.hour, d.minute, d.second, tzinfo=tz))

import unicodedata
def fold(x):  # OТКРЫТЫЕ MОРЯ с латинскими буквами -> сравнение по «похожести»
    t = (x or "").lower().replace("o", "о").replace("m", "м").replace("k", "к").replace("e", "е").replace("a", "а").replace("c", "с").replace("p", "р").replace("t", "т")
    return re.sub(r"[^а-яё]", "", t)
folders = [("inbox", acc.inbox)]
try: folders.append(("dislokacia", acc.inbox / "Dispetcher" / "Дислокация"))
except Exception: pass
try:
    for f in acc.inbox.children:
        if fold(f.name).startswith("открытыемор"): folders.append(("openseas", f)); break
except Exception as e: print("# папка открытых морей не найдена:", e, file=sys.stderr)

def kind_of(fn):
    n = fn.lower()
    if "crude oil" in n and n.endswith((".xlsx", ".xls", ".xlsm")): return "crude"
    if "own fleet" in n and n.endswith((".xlsx", ".xlsm")): return "openseas"
    if re.search(r"мр[\s-]*отч", n) and n.endswith((".pptx", ".pdf")): return "mr"
    if "дислокац" in n and n.endswith((".xlsx", ".xls", ".xlsm")): return "disl"
    return None

def state_path(key): return HERE / "state" / (f"last_received_{key}.txt" if key != "dislokacia" else "last_received.txt")
def read_state(key):
    p = state_path(key)
    if not p.exists(): return None
    try: return datetime.datetime.fromisoformat(p.read_text().strip())
    except Exception: return None

new_files = []
seen = set()
for key, folder in folders:
    last = read_state(key) if key != "inbox" else read_state("inbox")
    lookback = int(os.environ.get("FETCH_DAYS_OS", "45")) if key == "openseas" else DAYS
    since_k = datetime.datetime.now(tz) - datetime.timedelta(days=lookback)
    if last and last.tzinfo is None: last = last.replace(tzinfo=tz)
    if last and last > since_k: since_k = last
    newest = last
    q = folder.filter(datetime_received__gt=ews_dt(since_k)).only("subject", "datetime_received", "attachments", "id")
    for m in q.order_by("datetime_received"):
        if m.id in seen: continue
        seen.add(m.id)
        rt = m.datetime_received.astimezone(tz)
        for a in m.attachments:
            if not isinstance(a, FileAttachment): continue
            fn = a.name or ""
            k = kind_of(fn)
            if not k: continue
            if k == "disl" and "дислокац" not in (m.subject or "").lower(): continue
            safe = re.sub(r'[\\/:*?"<>|]', "_", fn)
            sub = rt.strftime("%Y") if k == "disl" else k
            dest = EXPORT / sub / (rt.strftime("%Y-%m-%d_%H%M") + "_" + safe)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists(): continue
            dest.write_bytes(a.content)
            new_files.append(dest)
        if newest is None or rt > newest: newest = rt
    if newest:
        state_path(key).parent.mkdir(parents=True, exist_ok=True)
        state_path(key).write_text(newest.isoformat())

for f in new_files: print(f)
print(f"# новых файлов: {len(new_files)}", file=sys.stderr)
