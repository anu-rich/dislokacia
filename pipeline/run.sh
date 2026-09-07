#!/usr/bin/env bash
# Один цикл: почта -> новые файлы -> пересборка -> git push. Запускается по cron каждые 3 минуты.
set -u
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"          # корень репозитория (там index.html)
LOG="$PWD/state/run.log"
mkdir -p state export
exec >>"$LOG" 2>&1
# Окна прихода сводок по Актау: 08:00–10:00, 14:00–16:00, 17:30–19:30. Вне окон почту не трогаем (кроме запуска с --force).
if [ "${1:-}" != "--force" ]; then
  HM=$(TZ=Asia/Aqtau date +%H%M)
  if ! { [ "$HM" -ge 0800 ] && [ "$HM" -lt 1000 ] || [ "$HM" -ge 1400 ] && [ "$HM" -lt 1600 ] || [ "$HM" -ge 1730 ] && [ "$HM" -lt 1930 ]; }; then exit 0; fi
fi
echo "=== $(date '+%F %T') start"
# не запускать второй экземпляр параллельно
exec 9>state/lock; flock -n 9 || { echo "уже работает"; exit 0; }
source .venv/bin/activate
# подтягиваем правки пайплайна из репозитория (если есть)
git -C "$ROOT" pull -q --rebase --autostash origin main 2>/dev/null || true

NEW=$(python fetch_mail.py 2>>"$LOG" | grep -v '^#' || true)
FORCE=0
# погода раз в 3 часа (или если файла нет)
if [ ! -f weather.json ] || [ -n "$(find weather.json -mmin +180)" ]; then
  python weather.py && FORCE=1
fi
if [ -z "$NEW" ] && [ "$FORCE" = "0" ]; then echo "новых сводок нет"; exit 0; fi

if [ -z "$NEW" ]; then
  # только погода: пересобираем по последнему файлу
  NEW=$(ls -1 export/*/*.xlsx 2>/dev/null | sort | tail -1)
  [ -z "$NEW" ] && { echo "нет файлов export"; exit 0; }
fi
echo "файлы:"; echo "$NEW"
# update.py принимает список файлов; данные лежат в pipeline/data
mapfile -t FILES <<<"$NEW"
WEATHER_JSON="$PWD/weather.json" python update.py "${FILES[@]}" || { echo "update.py упал"; exit 1; }

# обёртка в полный документ для GitHub Pages
{ printf '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
  cat dislokacia.html
  printf '</body></html>'; } > "$ROOT/index.html"

cd "$ROOT"
git add index.html pipeline/data/*.csv pipeline/data/snapshots.json
if git diff --cached --quiet; then echo "изменений нет"; exit 0; fi
git commit -q -m "update dashboard $(date -u '+%F %H:%M') UTC" && git push -q origin main && echo "опубликовано"
