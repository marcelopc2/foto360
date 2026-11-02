#!/usr/bin/env bash
# Publica lo que está en GitHub (rama main) en el servidor, sin sudo. Se corre desde el PC:
#   git push && bash deploy/actualizar.sh
set -euo pipefail
ssh 178.105.54.12 'cd /var/www/visor360 && git pull -q --ff-only && set -a && . ./.env && set +a   && venv/bin/pip install -q -r requirements.txt   && venv/bin/python manage.py migrate --noinput   && venv/bin/python manage.py collectstatic --noinput -v0   && kill -HUP $(systemctl show -p MainPID --value visor360) && echo "visor360 actualizado"'
