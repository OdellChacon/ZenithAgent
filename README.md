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
| Panel para asesores: bandeja, tomar, responder, devolver al bot | Hecho |
| Avisos al derivar: en vivo en el panel (sonido y notificación) y por correo | Hecho |
| Visión: el bot mira las fotos del cliente y busca lo más parecido del catálogo | Hecho |
| Cotización en PDF | Pendiente (F1.5) |
| Plantillas de WhatsApp y seguimiento fuera de 24 h | Pendiente |

## Estructura

```
apps/
  gateway/        Recibe webhooks: firma, guarda una sola vez, encola, responde 200
  simulator/      Chat de prueba local que hace de cliente y de Meta
  api/            API del panel de asesores (sesiones, bandeja, respuestas, eventos en vivo)
  panel/          Panel de asesores (React + Vite)
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
npm run catalog:describe -- --tenant-id <id>   # opcional: describe la foto de cada producto (necesita AI_PROVIDER)
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

Los íconos de clip, cámara o galería del teléfono mandan una foto como cliente (lo escrito en la caja va como pie de foto). La foto queda en el simulador y el worker la baja como lo haría de Meta.

Por dentro el canal siempre es WhatsApp; Instagram y Messenger solo cambian la apariencia hasta que existan sus conectores.

### Panel de asesores

```bash
npm run dev:api     # API en :3100
npm run dev:panel   # panel en http://localhost:5180
```

- Usuario de desarrollo: `DEV_PANEL_EMAIL` y `DEV_PANEL_PASSWORD` en `.env`, creado por `npm run db:seed-dev`.
- Otros usuarios: `npm run user:create -- --tenant-id <uuid> --email ana@negocio.com --name "Ana" [--role agent|admin|owner]` (imprime una contraseña temporal una sola vez).
- Cuando el bot deriva, el panel avisa en vivo (sonido, contador en la pestaña y notificación del sistema si se activan los avisos) y el worker manda un correo a los asesores con el resumen y el enlace. Sin `SMTP_HOST` el correo solo queda en el log.
- El asesor toma la conversación (el bot se calla), responde desde el panel mientras la ventana de 24 h esté abierta, y al terminar la devuelve al bot o la cierra.
- Seguridad: contraseñas con scrypt, sesiones con cookie `HttpOnly` + `SameSite=Strict` (solo el hash del token en la BD), cabecera `x-zenith-csrf` obligatoria en los cambios, límite de intentos de login por correo y por IP, y RLS por negocio en todos los datos.
- En producción, `npm run build:panel` y la API sirve el panel compilado.

### Proveedor de IA

| `AI_PROVIDER` | Qué hace |
|---|---|
| `none` (por defecto) | Sin IA: cada mensaje recibe el respaldo y pasa a un asesor. Sirve para probar el resto del sistema sin costo. |
| `gemini` | Google Gemini por su API compatible con OpenAI (`GEMINI_API_KEY`; modelo por defecto `gemini-3.1-flash-lite`, con `gemini-3.5-flash-lite` de respaldo si está saturado). Los modelos "flash" más grandes no respondieron a tiempo en la capa gratuita. Venezuela está en su lista de regiones. **En la capa gratuita Google puede usar y revisar lo enviado, y pide no mandar datos personales: solo para el simulador con datos ficticios.** |
| `openai-compatible` | Cualquier API con formato de OpenAI (Ollama, OpenRouter…): `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`. |
| `anthropic` | Claude. La [política de regiones de Anthropic](https://www.anthropic.com/legal/supported-regions) no incluye a Venezuela. |

El proveedor para clientes reales sigue pendiente. El adaptador está en `packages/brain/src/openai-compat.ts`.

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
- `catalog:describe` mira la foto de cada producto con el modelo de visión y guarda aspecto, colores, patrón y una frase (`products.look`). Así el bot encuentra piezas que la tienda no describe (ej. *Archi Cenizo*, que no tiene ni color) y las compara con la foto del cliente. Solo procesa productos nuevos o con foto cambiada; la sincronización no lo borra. Las fotos del catálogo son públicas.
- La tienda casi no describe sus productos (no dice si una cerámica es tipo madera o mármol). Al sincronizar con `--manufacturer-catalog` (o `CI_CATALOG_PATH`), cada cerámica se cruza con el catálogo de Cerámica Italia que importa ZenithVisualizer y gana aspecto, color, colección y tráfico. Los precios del fabricante no se copian.

## Cómo responde el bot

1. Llega un mensaje y se espera 4 s por si el cliente sigue escribiendo; si llega otro, solo responde el último turno.
2. El modelo (según `AI_PROVIDER`) recibe el historial reciente, el perfil del negocio y cuatro herramientas: `buscar_productos`, `calcular_cajas`, `enviar_fotos` y `derivar_a_asesor`.
   Las fotos de cada producto se guardan al sincronizar el catálogo (WebP pasa a JPEG, que es lo que acepta WhatsApp). Al enviarlas, cada foto se sube a WhatsApp una vez y su id se reutiliza 25 días; las fotos salen antes del texto.
   Si el cliente mandó fotos desde la última respuesta (máximo 3), el worker las baja de WhatsApp (`GET /{media_id}` y luego la url con el token; el token solo va a hosts de Meta o al simulador local), las achica a 1024 px en JPEG sin metadatos y se las pasa al modelo. El modelo describe aspecto, color y formato, busca lo más parecido y lo muestra con fotos, sin asegurar que es el mismo producto. Si una foto no baja, recibe una nota y le pide al cliente que la describa.
3. Los productos y las cajas salen de la BD y del código, nunca del modelo. Las herramientas no le muestran precios.
4. Antes de enviar, un validador bloquea cualquier respuesta con montos. Si el modelo falla, rechaza o se enreda, el cliente recibe un mensaje de respaldo y la conversación pasa a un asesor.
5. Al derivar, la conversación queda en modo `human`: el bot deja de responder y el pase queda en `handoffs`.
6. El envío revisa la ventana de 24 h; fuera de ella no manda texto libre (`blocked_window`).

Las peticiones a Claude usan el respaldo automático del servidor (`fallbacks: "default"`) si el modelo rechaza por un filtro de seguridad, y cachean el prompt de sistema y las herramientas.
