#!/bin/sh
# Crea los roles de la app al iniciar el contenedor por primera vez (solo desarrollo local).
# - zenith_app: rol de grupo sin login; las migraciones le dan permisos.
# - zenith_runtime: rol con login que usan gateway y workers. No es dueño de las tablas,
#   así que las políticas RLS le aplican.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'EOSQL'
CREATE ROLE zenith_app NOLOGIN;
CREATE ROLE zenith_runtime LOGIN PASSWORD :'app_password' IN ROLE zenith_app;
EOSQL
