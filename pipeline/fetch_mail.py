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

folders = [acc.inbox]
try:
    folders.append(acc.inbox / "Dispetcher" / "Дислокация")
except Exception:
    pass

new_files = []; newest = last
seen = set()
for folder in folders:
    q = folder.filter(datetime_received__gt=ews_dt(since)).only("subject", "datetime_received", "attachments", "id")
    for m in q.order_by("datetime_received"):
        if m.id in seen: continue
        seen.add(m.id)
        subj = (m.subject or "")
        if "дислокац" not in subj.lower(): continue
        rt = m.datetime_received.astimezone(tz)
        for a in m.attachments:
            if not isinstance(a, FileAttachment): continue
            fn = a.name or ""
            if not re.search(r"\.(xlsx?|xlsm)$", fn, re.I): continue
            safe = re.sub(r'[\\/:*?"<>|]', "_", fn)
            dest = EXPORT / rt.strftime("%Y") / (rt.strftime("%Y-%m-%d_%H%M") + "_" + safe)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists(): continue
            dest.write_bytes(a.content)
            new_files.append(dest)
        if newest is None or rt > newest: newest = rt

if newest:
    STATE.write_text(newest.isoformat())
for f in new_files: print(f)
print(f"# новых файлов: {len(new_files)}", file=sys.stderr)
