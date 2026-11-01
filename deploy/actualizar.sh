#!/usr/bin/env bash
# Actualiza el código en el servidor sin sudo (después de instalar.sh). Se corre desde el PC:
#   bash deploy/actualizar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER=178.105.54.12
APP=/var/www/visor360

tar --exclude=venv --exclude=deploy --exclude=media --exclude=db.sqlite3 --exclude=staticfiles \
    --exclude=__pycache__ --exclude=.env -czf - . | ssh "$SERVER" "tar -xzf - -C $APP"
ssh "$SERVER" "cd $APP && set -a && . ./.env && set +a \
  && venv/bin/pip install -q -r requirements.txt \
  && venv/bin/python manage.py migrate --noinput \
  && venv/bin/python manage.py collectstatic --noinput -v0 \
  && kill -HUP \$(systemctl show -p MainPID --value visor360) && echo 'visor360 recargado'"
