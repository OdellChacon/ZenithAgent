# ZenithAgent

Bot conversacional con IA, omnicanal (WhatsApp, Instagram, Facebook Messenger y TikTok en fase 2) y multi-tenant, desarrollado por GrupoZenith. Primer cliente: Inversiones Mora Mora.

La especificación técnica está en [`docs/spec-bot-omnicanal.md`](docs/spec-bot-omnicanal.md).

## Estado (F1 en curso)

| Pieza | Estado |
|---|---|
| Monorepo TypeScript, Postgres + Redis locales | Hecho |
| BD multi-tenant con RLS y credenciales cifradas | Hecho |
| Reglas de ventana de mensajería por canal | Hecho |
| Adaptador de WhatsApp (firma, lectura de webhooks, envío de texto) | Hecho |
| Gateway de webhooks con idempotencia y worker de entrada | Hecho |
| Sincronización del catálogo de la tienda de Mora Mora | Hecho |
| Cerebro (IA), envío de respuestas, pase a humano, panel | Pendiente |

## Estructura

```
apps/
  gateway/        Recibe webhooks: firma, guarda una sola vez, encola, responde 200
  worker/         Procesa eventos: contacto, conversación, mensaje, estados de envío
packages/
  core/           Tipos, reglas de ventana, cifrado de credenciales, colas
  db/             Pool con RLS por tenant, migraciones SQL, acceso a eventos
  channel-whatsapp/  Adaptador de WhatsApp Cloud API
  catalog/        Importa el catálogo (tienda de Mora Mora) a la tabla products
```

## Desarrollo local

Requisitos: Node 20.6+ y Docker.

```bash
cp .env.example .env          # completa contraseñas, secretos y la clave maestra
npm install
docker compose --env-file .env up -d
npm run db:migrate
npm run db:seed-dev           # tenant de Mora Mora + número de WhatsApp de prueba
npm run catalog:sync-imm -- --tenant-id <id que imprime el seed>
npm run dev:gateway           # en una terminal
npm run dev:worker            # en otra
```

Pruebas:

```bash
npm run typecheck
npm test          # unitarias
npm run test:all  # también las de integración (usan la BD local de .env)
```

## Decisiones de esta etapa

- La app se conecta con el rol `zenith_runtime`, que no es dueño de las tablas: las políticas RLS siempre le aplican. Las migraciones corren con el rol dueño.
- `webhook_events` no tiene tenant: el gateway guarda antes de saber a quién pertenece el evento. El tenant se resuelve en el worker con `resolve_channel_account`, que solo devuelve ids.
- Si Redis falla después de guardar un evento, el gateway responde 200 igual y el barrido del worker lo reencola.
- El catálogo se lee de la API pública de la tienda (`/api/v1/store/*`). La tienda no publica precios: `price` queda vacío y el bot tendrá que derivar los precios a un asesor.
