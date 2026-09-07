# Дислокация флота — пайплайн на сервере

Что делает: каждые 3 минуты проверяет рабочую почту (EWS), забирает новые файлы «Дислокация судов»,
пересобирает дашборд (index.html в корне репозитория) и пушит в GitHub → страница обновляется через ~1 минуту.
Погода (Open-Meteo) обновляется раз в 3 часа.

Установка (Ubuntu/Debian, один раз):
    git clone https://github.com/anu-rich/dislokacia.git && cd dislokacia/pipeline
    bash install.sh          # создаст config.env
    nano config.env          # вписать пароль от почты
    bash install.sh          # проверит почту, поставит cron, напечатает ключ для GitHub
Затем на GitHub: репозиторий → Settings → Deploy keys → Add → вставить ключ, «Allow write access».

Проверка: bash run.sh && tail -30 state/run.log
Логи: pipeline/state/run.log. Файлы сводок: pipeline/export/<год>/ (в git не попадают).
