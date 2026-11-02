#!/usr/bin/env bash
# Instalación inicial de visor360 en el servidor. Se corre UNA vez, con sudo:
#   curl -fsSL https://raw.githubusercontent.com/marcelopc2/foto360/main/deploy/instalar.sh -o /tmp/instalar.sh && sudo bash /tmp/instalar.sh foto360.duckdns.org
# Solo crea cosas nuevas (carpeta, servicio y sitio "visor360"); no toca zezen, calculadora ni soledad.
set -euo pipefail

DOMINIO="${1:?Uso: sudo bash instalar.sh <dominio>}"
USUARIO=marcelo
REPO=https://github.com/marcelopc2/foto360.git
APP=/var/www/visor360

[ "$(id -u)" = 0 ] || { echo "Correr con sudo"; exit 1; }
[ -e /etc/nginx/sites-available/visor360 ] && { echo "visor360 ya está instalado"; exit 1; }

echo "== Archivos"
mkdir -p "$APP"
chown "$USUARIO:$USUARIO" "$APP"
[ -d "$APP/.git" ] || sudo -u "$USUARIO" git clone -q "$REPO" "$APP"
sudo -u "$USUARIO" mkdir -p "$APP/media"

echo "== Entorno Python"
sudo -u "$USUARIO" bash -c "
  cd $APP
  python3 -m venv venv
  venv/bin/pip install -q -r requirements.txt
  if [ ! -f .env ]; then
    echo \"SECRET_KEY=\$(python3 -c 'import secrets;print(secrets.token_urlsafe(50))')\" > .env
    echo 'DEBUG=0' >> .env
    echo 'ALLOWED_HOSTS=$DOMINIO' >> .env
    chmod 600 .env
  fi
  set -a; . ./.env; set +a
  venv/bin/python manage.py migrate --noinput
  venv/bin/python manage.py collectstatic --noinput -v0
"

echo "== Servicio"
cat > /etc/systemd/system/visor360.service <<EOF
[Unit]
Description=Visor 360 (fotos familia) Gunicorn
After=network.target

[Service]
User=$USUARIO
Group=$USUARIO
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
RuntimeDirectory=visor360
ExecStart=$APP/venv/bin/gunicorn --workers 2 --timeout 180 \\
          --bind unix:/run/visor360/gunicorn.sock visor360.wsgi:application
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now visor360

echo "== Nginx"
cat > /etc/nginx/sites-available/visor360 <<EOF
server {
    listen 80;
    server_name $DOMINIO;

    client_max_body_size 100M;

    location = /favicon.ico { access_log off; log_not_found off; return 204; }

    location /static/ {
        alias $APP/staticfiles/;
        expires 7d;
    }

    location /media/ {
        alias $APP/media/;
        expires 30d;
        add_header X-Robots-Tag "noindex";
    }

    location / {
        include proxy_params;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        proxy_request_buffering on;
        proxy_pass http://unix:/run/visor360/gunicorn.sock;
    }
}
EOF
ln -s /etc/nginx/sites-available/visor360 /etc/nginx/sites-enabled/visor360
if ! nginx -t; then
    rm /etc/nginx/sites-enabled/visor360
    echo "nginx -t falló; se retiró visor360 y nginx quedó como estaba"; exit 1
fi
systemctl reload nginx

echo "== HTTPS"
certbot --nginx -d "$DOMINIO" --non-interactive --redirect

echo
echo "Listo: https://$DOMINIO"
echo "Crea tu usuario con:"
echo "  cd $APP && set -a && . ./.env && set +a && venv/bin/python manage.py createsuperuser"
