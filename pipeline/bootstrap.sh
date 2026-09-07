#!/usr/bin/env bash
# Полная установка одной командой (запускать от root в консоли сервера):
#   curl -sL https://raw.githubusercontent.com/anu-rich/dislokacia/main/pipeline/bootstrap.sh | bash
set -e
export DEBIAN_FRONTEND=noninteractive
echo "== 1/6 пакеты"
apt-get update -qq >/dev/null && apt-get install -y -qq python3 python3-venv python3-pip git >/dev/null
echo "== 2/6 репозиторий"
cd /root
if [ -d dislokacia ]; then cd dislokacia && git pull -q origin main; else git clone -q https://github.com/anu-rich/dislokacia.git && cd dislokacia; fi
cd pipeline
echo "== 3/6 python-окружение (1-2 минуты)"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip -q install --upgrade pip >/dev/null
pip -q install exchangelib requests-ntlm openpyxl pandas >/dev/null
echo "== 4/6 настройки почты"
if [ ! -f config.env ] || grep -q 'ВПИШИ_ПАРОЛЬ' config.env; then
  cp config.env.example config.env
  echo
  echo ">>> Введи пароль от почты a.ichshanov@kmtf.kmg.kz (символы не показываются), затем Enter:"
  read -r -s PW < /dev/tty
  sed -i "s|^EWS_PASS=.*|EWS_PASS=$PW|" config.env
  unset PW
fi
chmod 600 config.env
echo "== 5/6 проверка почты"
if ! python fetch_mail.py; then
  echo "!!! Почта не ответила. Запусти ещё раз: curl -sL https://raw.githubusercontent.com/anu-rich/dislokacia/main/pipeline/bootstrap.sh | bash  — и введи пароль заново."
  rm -f config.env; exit 1
fi
echo "== 6/6 ключ для GitHub и расписание"
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "dislokacia-vps"
mkdir -p ~/.ssh; ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null
cd ..
git config user.name "dislokacia-bot"; git config user.email "dislokacia@localhost"
git remote set-url origin git@github.com:anu-rich/dislokacia.git
chmod +x pipeline/run.sh
( crontab -l 2>/dev/null | grep -v 'pipeline/run.sh'; echo "*/3 * * * * /root/dislokacia/pipeline/run.sh" ) | crontab -
echo
echo "================= ПУБЛИЧНЫЙ КЛЮЧ (добавить в GitHub -> Deploy keys, Allow write access) ================="
cat ~/.ssh/id_ed25519.pub
echo "FINGERPRINT: $(ssh-keygen -lf ~/.ssh/id_ed25519.pub | awk '{print $2}')"
echo "=========================================================================================================="
echo "Готово. После добавления ключа: bash /root/dislokacia/pipeline/run.sh --force; tail -5 /root/dislokacia/pipeline/state/run.log"
