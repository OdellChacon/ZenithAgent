# Despliegue en producción

Guía para montar ZenithAgent en un servidor (VPS de InterServer u otro) con Docker. Todo corre
en una sola máquina: Caddy (https automático), gateway, worker, API con el panel, Postgres, Redis
y las copias diarias de la base.

Lo que dice **sin dato** depende de una decisión o de un dato que todavía no tenemos.

## 1. Requisitos

| Qué | Detalle |
|---|---|
| Servidor | Linux (Ubuntu 24.04 o Debian 12) con Docker y el plugin `docker compose`. Tamaño: **sin dato**; para empezar alcanza con 2 vCPU, 4 GB de RAM y 40 GB de disco (las fotos del catálogo, los catálogos en PDF y los archivos de los asesores se guardan en la base). |
| Puertos abiertos | 80 y 443 (Caddy). Nada más hacia afuera: Postgres y Redis no se publican. Acceso SSH solo con llave. |
| Dominio | Un subdominio con registro A a la IP del servidor, ej. `bot.<dominio>`. De quién es el dominio (Mora Mora o GrupoZenith): **sin dato**. |
| Correo saliente | Una cuenta SMTP para los avisos a los asesores (sección 6). |

## 2. Primera instalación

```bash
git clone https://github.com/OdellChacon/ZenithAgent.git /opt/zenithagent
cd /opt/zenithagent
cp .env.db.example .env.db
cp .env.production.example .env.production
nano .env.db                  # contraseñas de la base (solo letras y números: openssl rand -hex 32)
nano .env.production          # el resto; DATABASE_URL lleva la APP_DB_PASSWORD de .env.db
chmod 600 .env.db .env.production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Al arrancar, el servicio `migrate` aplica las migraciones y termina; gateway, worker y API
esperan a que salga bien. Caddy pide el certificado de Let's Encrypt la primera vez que alguien
entra al dominio (por eso el registro A tiene que estar listo antes).

Para no escribir el comando largo cada vez:

```bash
alias zc='docker compose -f docker-compose.prod.yml --env-file .env.production'
```

### Datos iniciales

```bash
# 1. El negocio (imprime su tenant-id)
sh deploy/admin.sh tenant-sync --config config/tenants/inversiones-mora-mora.json

# 2. El dueño y los asesores (cada uno imprime una contraseña temporal una sola vez)
sh deploy/admin.sh create-user --tenant-id <id> --email dueno@negocio.com --name "Nombre" --role owner
sh deploy/admin.sh create-user --tenant-id <id> --email asesor@negocio.com --name "Nombre"

# 3. El catálogo de la tienda
sh deploy/admin.sh sync-catalog --tenant-id <id>
```

Los comandos que necesitan el superusuario de la base (`tenant-sync`, `check-meta`,
`connect-meta`) reciben la contraseña de `.env.db` solo mientras corren; gateway, worker y API
nunca la tienen, para que una fuga en la app no dé acceso por encima del aislamiento por negocio.

`tenant-sync` se puede volver a correr cuando cambie `config/tenants/inversiones-mora-mora.json`
(formas de pago, horario…): actualiza lo que sabe el bot sin tocar chats ni contactos.

### Conectar los canales

1. En la app de Meta (trámites A2), configurar cada webhook con el mismo token de verificación
   que `META_WEBHOOK_VERIFY_TOKEN`:
   - WhatsApp: `https://<DOMAIN>/webhooks/meta/whatsapp`
   - Messenger: `https://<DOMAIN>/webhooks/meta/messenger`
   - Instagram: `https://<DOMAIN>/webhooks/meta/instagram`
2. WhatsApp: el dueño entra al panel → sección WhatsApp → **Conectar WhatsApp**.
3. Messenger e Instagram: con el token de la página,
   `META_PAGE_ACCESS_TOKEN=<token> sh deploy/admin.sh connect-meta --tenant inversiones-mora-mora --page-id <id> --instagram`
4. Revisión completa antes de probar con clientes: ver [prueba-numero-real.md](prueba-numero-real.md).

## 3. Actualizar a una versión nueva

```bash
cd /opt/zenithagent
git pull
zc up -d --build        # migra la base y reinicia solo lo que cambió
zc ps                   # todos "running" / "healthy"
```

Antes de una actualización grande, una copia a mano: `zc exec backup sh -c 'pg_dump -Fc -f /backups/antes-$(date +%F).dump'`.

## 4. Copias de seguridad

- El servicio `backup` deja cada día (a las `BACKUP_HOUR`) una copia en `/opt/zenithagent/backups`
  y borra las de más de `BACKUP_KEEP_DAYS` días. Si una copia falla, aparece el archivo
  `backups/ULTIMO_ERROR`; la fecha de la última buena está en `backups/ULTIMA_COPIA`.
- **Sacar las copias del servidor** (si el disco se pierde, se pierden con él). Dónde guardarlas
  (Backblaze B2, Google Drive, otro servidor…) es **sin dato**: decidirlo con Mora Mora. Con el
  destino elegido, un cron en el servidor que suba la carpeta cada día, por ejemplo con rclone:
  `30 4 * * * rclone copy /opt/zenithagent/backups destino:zenith-backups --max-age 48h`.
- **Guardar fuera del servidor** también `.env.production` y `.env.db`, en especial `ENCRYPTION_MASTER_KEY`:
  sin ella, una copia de la base no sirve para recuperar los tokens de los canales.
- **Restaurar**: `sh deploy/restore.sh backups/zenith-AAAAMMDD-HHMM.dump`. Probarlo cada tanto
  en otra máquina; una copia que nunca se restauró no está probada.

## 5. Monitoreo

- `https://<DOMAIN>/healthz` responde 200 si la base, Redis y el worker están bien, y 503 si algo
  falla (dice qué). El worker deja una señal de vida en Redis cada 30 s: si se cae, `/healthz`
  falla a los 2 minutos.
- Hace falta un monitor **externo** que consulte `/healthz` cada 5 minutos y avise por correo o
  WhatsApp si falla (si el servidor entero se cae, nada de adentro puede avisar). Servicio:
  **sin dato** (UptimeRobot y Better Stack tienen plan gratis). Agregar también el chequeo de
  la copia: que `backups/ULTIMA_COPIA` no tenga más de 2 días.
- Docker reinicia solo cualquier servicio que se caiga (`restart: unless-stopped`) y revisa la
  salud de gateway y API. Los registros: `zc logs -f worker` (se rotan solos, 100 MB por servicio).
- Lo que ya avisa el propio sistema, en el panel y por correo: un número desconectado por Meta y
  un token rechazado o por vencer.

## 6. Correo de los avisos

El worker manda por SMTP los avisos de "cliente espera asesor", "WhatsApp desconectado" y
"acceso a Meta rechazado". Hace falta una cuenta de correo saliente:

- **Proveedor: sin dato.** Opciones habituales: la cuenta de correo del dominio del negocio
  (Google Workspace o Zoho, con una contraseña de aplicación) o un servicio transaccional
  (Brevo, Amazon SES, Resend). Para pocos avisos al día cualquiera sirve.
- Completar en `.env.production`: `SMTP_HOST`, `SMTP_PORT` (587 con `SMTP_SECURE=false`, o 465
  con `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM` (ej. `Avisos Mora Mora <avisos@dominio>`).
- Para que no caigan en spam, el dominio del remitente necesita SPF y DKIM configurados según
  las instrucciones del proveedor.
- Probar antes de confiar en los avisos:
  `sh deploy/admin.sh mail-test --to asesor@negocio.com`
  (en desarrollo: `npm run mail:test -- --to correo@...`).
- Quién recibe los avisos: los usuarios del panel con `notify_email` activo (por defecto, todos).

## 7. CI

`.github/workflows/ci.yml` corre en cada push a `main` y en cada pull request: tipos, todas las
pruebas con Postgres y Redis reales, compilación del panel y de la imagen Docker. No usa
secretos ni llama a Meta ni a la IA.
