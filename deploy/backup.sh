#!/bin/sh
# Copia diaria de la base de datos (servicio "backup" de docker-compose.prod.yml).
#
# Cada día a las BACKUP_HOUR (hora local, TZ) deja /backups/zenith-AAAAMMDD-HHMM.dump con
# pg_dump en formato comprimido, verifica que se pueda leer y borra las de más de
# BACKUP_KEEP_DAYS días. Si una copia falla, lo deja en el log del contenedor y en
# /backups/ULTIMO_ERROR para que el monitoreo lo vea.
#
# Restaurar: ver deploy/restore.sh.
set -u

HOUR="${BACKUP_HOUR:-3}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
DIR=/backups

backup() {
  stamp=$(date +%Y%m%d-%H%M)
  tmp="$DIR/.zenith-$stamp.dump.tmp"
  out="$DIR/zenith-$stamp.dump"
  if pg_dump --format=custom --compress=6 --file="$tmp" && pg_restore --list "$tmp" > /dev/null; then
    mv "$tmp" "$out"
    rm -f "$DIR/ULTIMO_ERROR"
    date -Iseconds > "$DIR/ULTIMA_COPIA"
    echo "$(date -Iseconds) copia lista: $out ($(du -h "$out" | cut -f1))"
  else
    rm -f "$tmp"
    echo "$(date -Iseconds) FALLÓ la copia de la base" | tee "$DIR/ULTIMO_ERROR"
  fi
  find "$DIR" -name 'zenith-*.dump' -type f -mtime +"$KEEP" -print -delete
}

mkdir -p "$DIR"
# Una copia al arrancar si nunca se hizo ninguna, para no esperar al día siguiente.
ls "$DIR"/zenith-*.dump > /dev/null 2>&1 || backup

while true; do
  now=$(date +%s)
  next=$(date -d "today $HOUR:00" +%s 2>/dev/null || date -d "$HOUR:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  backup
done
