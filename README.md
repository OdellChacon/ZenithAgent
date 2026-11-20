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
| Cerebro con IA: búsqueda en catálogo, cálculo de cajas, pase a asesor | Hecho |
| Envío de respuestas por WhatsApp respetando la ventana de 24 h | Hecho |
| Panel para asesores (tomar conversaciones derivadas) | Pendiente |
| Visión (identificar piezas por foto) y cotización en PDF | Pendiente (F1.5) |
| Plantillas de WhatsApp y seguimiento fuera de 24 h | Pendiente |

## Estructura

```
apps/
  gateway/        Recibe webhooks: firma, guarda una sola vez, encola, responde 200
  simulator/      Chat de prueba local que hace de cliente y de Meta
  worker/         Tres colas: entrada (contacto, conversación, mensaje), cerebro (turno del bot) y salida (envío)
config/tenants/   Perfil de cada negocio (datos que el bot conoce; lo que falta va en null)
packages/
  brain/          Prompt, herramientas del bot, validador de respuestas y bucle con Claude
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

### Simulador de chat (sin número real)

Una página con un teléfono que se ve como WhatsApp, Instagram o Messenger. Lo que escribes pasa por el sistema real (gateway, colas, worker, BD) y el simulador hace de Meta: recibe la respuesta del bot y manda los estados "entregado" y "leído".

```bash
# en .env: META_GRAPH_BASE_URL=http://localhost:4010
npm run dev:gateway
npm run dev:worker
npm run dev:sim     # abre http://localhost:4010
```

Por dentro el canal siempre es WhatsApp; Instagram y Messenger solo cambian la apariencia hasta que existan sus conectores.

### Proveedor de IA

`AI_PROVIDER=none` (por defecto) no llama a ninguna IA: cada mensaje recibe el respaldo y pasa a un asesor, para probar el resto del sistema sin costo. `AI_PROVIDER=anthropic` usa Claude, pero **la política de regiones de Anthropic no incluye a Venezuela** ([supported regions](https://www.anthropic.com/legal/supported-regions)), así que no sirve para atender a clientes allí. El proveedor definitivo está pendiente; el cambio se hace en `packages/brain/src/llm.ts` (`LlmClient`).

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
- El catálogo se lee de la API pública de la tienda (`/api/v1/store/*`). La tienda no publica precios: `price` queda vacío y el bot deriva los precios a un asesor.

## Cómo responde el bot

1. Llega un mensaje y se espera 4 s por si el cliente sigue escribiendo; si llega otro, solo responde el último turno.
2. Claude (`claude-opus-5-5`, esfuerzo `medium`, configurable) recibe el historial reciente, el perfil del negocio y tres herramientas: `buscar_productos`, `calcular_cajas` y `derivar_a_asesor`.
3. Los productos y las cajas salen de la BD y del código, nunca del modelo. Las herramientas no le muestran precios.
4. Antes de enviar, un validador bloquea cualquier respuesta con montos. Si el modelo falla, rechaza o se enreda, el cliente recibe un mensaje de respaldo y la conversación pasa a un asesor.
5. Al derivar, la conversación queda en modo `human`: el bot deja de responder y el pase queda en `handoffs`.
6. El envío revisa la ventana de 24 h; fuera de ella no manda texto libre (`blocked_window`).

Las peticiones a Claude usan el respaldo automático del servidor (`fallbacks: "default"`) si el modelo rechaza por un filtro de seguridad, y cachean el prompt de sistema y las herramientas.
