#!/usr/bin/env bash
# Установка на сервер (Ubuntu/Debian). Запускать из папки pipeline: bash install.sh
set -e
cd "$(dirname "$0")"
echo "== 1/5 пакеты"
sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-venv python3-pip git >/dev/null
echo "== 2/5 python-окружение"
python3 -m venv .venv
. .venv/bin/activate
pip -q install --upgrade pip
pip -q install exchangelib requests-ntlm openpyxl pandas
echo "== 3/5 настройки почты"
if [ ! -f config.env ]; then
  cp config.env.example config.env
  echo "!!! Открой pipeline/config.env и впиши логин и пароль от рабочей почты (nano config.env), затем запусти install.sh ещё раз."
  exit 0
fi
chmod 600 config.env
echo "== 4/5 проверка почты (берём письма за 3 дня)"
python fetch_mail.py || { echo "!!! Почта не отвечает. Проверь EWS_USER / EWS_PASS в config.env"; exit 1; }
echo "== 5/5 ключ для GitHub и расписание"
if [ ! -f ~/.ssh/id_ed25519 ]; then ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "dislokacia-vps" >/dev/null; fi
ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null
cd ..
git config user.name "dislokacia-bot"; git config user.email "dislokacia@localhost"
git remote set-url origin git@github.com:anu-rich/dislokacia.git
chmod +x pipeline/run.sh
# cron каждые 3 минуты; сам run.sh работает только в окна прихода сводок (08:00–10:00, 14:00–16:00, 17:30–19:30 по Актау)
RUN="$(pwd)/pipeline/run.sh"
( crontab -l 2>/dev/null | grep -v 'pipeline/run.sh'; echo "*/3 * * * * $RUN" ) | crontab -
echo
echo "ГОТОВО. Осталось одно: добавь этот ключ в GitHub -> репозиторий dislokacia -> Settings -> Deploy keys -> Add deploy key, галочка 'Allow write access':"
echo
cat ~/.ssh/id_ed25519.pub
echo
echo "После этого проверь: bash pipeline/run.sh --force && tail -20 pipeline/state/run.log"
