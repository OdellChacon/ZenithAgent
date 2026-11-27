#!/bin/sh
# Restaura una copia de la base. BORRA los datos actuales de la base "zenith".
#
#   sh deploy/restore.sh backups/zenith-20261127-0300.dump
#
# Se corre en el servidor, en la carpeta del proyecto. Detiene la app mientras restaura y la
# vuelve a levantar al final. Probarlo de vez en cuando en una máquina aparte es la única forma
# de saber que las copias sirven.
set -eu

FILE="${1:?Indica el archivo .dump a restaurar}"
[ -f "$FILE" ] || { echo "No existe $FILE"; exit 1; }
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

printf 'Esto reemplaza TODOS los datos actuales con %s. Escribe RESTAURAR para seguir: ' "$FILE"
read -r ok
[ "$ok" = "RESTAURAR" ] || { echo "Cancelado"; exit 1; }

$COMPOSE stop gateway worker api
$COMPOSE exec -T postgres pg_restore -U postgres -d zenith --clean --if-exists --no-owner --role=postgres < "$FILE"
$COMPOSE up -d gateway worker api
echo "Restaurado. Revisa /healthz en el dominio del bot."
