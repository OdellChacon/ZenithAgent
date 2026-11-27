#!/bin/sh
# Comandos de administración en el servidor, desde la carpeta del proyecto:
#
#   sh deploy/admin.sh tenant-sync --config config/tenants/inversiones-mora-mora.json
#   sh deploy/admin.sh create-user --tenant-id <id> --email ana@negocio.com --name "Ana" [--role admin]
#   sh deploy/admin.sh sync-catalog --tenant-id <id>
#   sh deploy/admin.sh mail-test --to asesor@negocio.com
#   sh deploy/admin.sh check-meta --url https://<dominio>
#   META_PAGE_ACCESS_TOKEN=<token> sh deploy/admin.sh connect-meta --tenant <slug> --page-id <id> --instagram
#
# Los que necesitan el rol dueño de la base (tenant-sync, check-meta, connect-meta) reciben la
# contraseña de .env.db solo durante esa ejecución: los servicios que quedan corriendo no la tienen.
set -eu

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"
CMD="${1:-}"
[ -n "$CMD" ] || { sed -n '2,10p' "$0"; exit 1; }
shift

# owner <servicio> <script> [argumentos…]
owner() {
  svc=$1
  script=$2
  shift 2
  POSTGRES_PASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env.db)
  [ -n "$POSTGRES_PASSWORD" ] || { echo "Falta POSTGRES_PASSWORD en .env.db" >&2; exit 1; }
  export POSTGRES_PASSWORD
  # -e NOMBRE sin valor: Docker lo toma del entorno de este script, no queda en la línea de comandos.
  exec $COMPOSE run --rm -e POSTGRES_PASSWORD ${EXTRA:-} "$svc" sh deploy/with-owner-db.sh node --import tsx "$script" "$@"
}

case "$CMD" in
  tenant-sync) owner api packages/db/src/cli/tenant-sync.ts "$@" ;;
  check-meta) owner api apps/api/src/cli/check-meta.ts "$@" ;;
  connect-meta)
    [ -n "${META_PAGE_ACCESS_TOKEN:-}" ] || { echo "Falta META_PAGE_ACCESS_TOKEN (token de la página)" >&2; exit 1; }
    export META_PAGE_ACCESS_TOKEN
    EXTRA="-e META_PAGE_ACCESS_TOKEN"
    owner api apps/api/src/cli/connect-meta.ts "$@" ;;
  create-user) exec $COMPOSE run --rm api node --import tsx apps/api/src/cli/create-user.ts "$@" ;;
  sync-catalog) exec $COMPOSE run --rm worker node --import tsx packages/catalog/src/cli/sync-imm.ts "$@" ;;
  mail-test) exec $COMPOSE run --rm worker node --import tsx apps/worker/src/cli/mail-test.ts "$@" ;;
  *) echo "Comando desconocido: $CMD" >&2; sed -n '2,10p' "$0"; exit 1 ;;
esac
