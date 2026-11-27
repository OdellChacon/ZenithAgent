#!/bin/sh
# Ejecuta un comando con MIGRATION_DATABASE_URL (rol dueño de la base), armada con la contraseña
# de .env.db. Lo usan las migraciones y los comandos de administración:
#
#   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate \
#     sh deploy/with-owner-db.sh node --import tsx packages/db/src/cli/tenant-sync.ts --config config/tenants/<negocio>.json
set -eu
: "${POSTGRES_PASSWORD:?Falta POSTGRES_PASSWORD (archivo .env.db)}"
case "$POSTGRES_PASSWORD" in
  *[!A-Za-z0-9]*) echo "POSTGRES_PASSWORD solo puede tener letras y números (genérala con: openssl rand -hex 32)" >&2; exit 1 ;;
esac
export MIGRATION_DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/zenith"
exec "$@"
