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
| Seguimiento automático: mensaje del bot en 24 h y plantilla aprobada después | Hecho (la plantilla falta aprobarla en Meta) |
| Contactos con etiquetas, notas y señales automáticas en el panel | Hecho |
| Asesores que contestan desde la app de WhatsApp Business (coexistencia): el bot se calla | Hecho (falta conectar números reales con Meta) |
| Historial de chats al conectar el número y avisos de desconexión de Meta | Hecho (falta conectar números reales con Meta) |

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

El simulador también conoce las plantillas "aprobadas" de `apps/simulator/templates.json` (en Meta se aprueban en el administrador de WhatsApp): las muestra con sus botones, y tocar un botón llega al negocio como respuesta de botón, igual que en WhatsApp.

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
- **Asesores desde el teléfono (coexistencia):** el número puede seguir en la app WhatsApp Business del negocio mientras el bot atiende. Cuando alguien de la tienda escribe desde la app o un dispositivo vinculado, Meta manda una copia (webhook `smb_message_echoes`): el mensaje queda en el historial como "Asesor · desde el teléfono", el bot se calla en ese chat y, si había un pase esperando, queda atendido. Si el asesor pasa `takeover.resumeBotAfterMinutes` (12 h por defecto; 0 = nunca) sin escribir, el bot retoma con el siguiente mensaje del cliente; los chats tomados desde el panel solo se devuelven a mano. Los mensajes de la app no abren ni extienden la ventana de 24 h. Las copias de ediciones y borrados se ignoran.
  - Meta no garantiza todas las copias: WhatsApp para Windows y WearOS no las generan. Por eso el panel sigue sirviendo para tomar o devolver un chat.
- **Historial al conectar:** al conectar un número que ya usaba la app, Meta manda una sola vez hasta 6 meses de chats (webhook `history`; hay que pedirlo en las primeras 24 h). Se guardan como mensajes del cliente y del asesor, antes de lo recibido en vivo, sin despertar al bot, sin abrir la ventana de 24 h y sin disparar seguimientos. Si el asesor escribió dentro del plazo de `takeover`, ese chat queda en sus manos. Las fotos llegan primero como aviso sin archivo y se completan con un segundo aviso. Si el negocio no comparte su historial, la cuenta queda marcada `declined`. Los chats de grupos y de clientes sin número no se importan.
- **Desconexiones:** Meta avisa por `account_update` (identifica la cuenta por su WABA, por eso cada número guarda `waba_id`; en desarrollo, `DEV_WHATSAPP_WABA_ID`). Si desconecta un número (por ejemplo, el teléfono principal pasó unos 14 días sin abrir WhatsApp Business), el panel muestra una franja roja con el motivo y se manda un correo a los asesores; al reconectar, la franja se quita sola. Para evitarlo, el negocio debe abrir la app en el teléfono al menos cada 13 días.
  - En el simulador, el campo "Asesor desde la app del negocio" manda esa copia.
- **Contactos** (`/contactos`): lista de clientes con búsqueda (nombre, teléfono o etiqueta) y filtro por etiqueta. Las etiquetas las pone el equipo (en la ficha o arriba de la conversación; se guardan en minúsculas, máximo 15). Además cada contacto muestra señales que salen de los datos, no de la IA: qué productos le mostró el bot, si pidió precio, si espera o tiene asesor, si recibió seguimiento y si pidió que no le escriban. En la ficha hay notas del equipo y la opción de no enviarle seguimientos.
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
2. El modelo (según `AI_PROVIDER`) recibe el historial reciente, el perfil del negocio y cinco herramientas: `buscar_productos`, `calcular_cajas`, `enviar_fotos`, `derivar_a_asesor` y `no_escribir_mas`.
   Las fotos de cada producto se guardan al sincronizar el catálogo (WebP pasa a JPEG, que es lo que acepta WhatsApp). Al enviarlas, cada foto se sube a WhatsApp una vez y su id se reutiliza 25 días; las fotos salen antes del texto.
   Si el cliente mandó fotos desde la última respuesta (máximo 3), el worker las baja de WhatsApp (`GET /{media_id}` y luego la url con el token; el token solo va a hosts de Meta o al simulador local), las achica a 1024 px en JPEG sin metadatos y se las pasa al modelo. El modelo describe aspecto, color y formato, busca lo más parecido y lo muestra con fotos, sin asegurar que es el mismo producto. Si una foto no baja, recibe una nota y le pide al cliente que la describa.
3. Los productos y las cajas salen de la BD y del código, nunca del modelo. Las herramientas no le muestran precios.
4. Antes de enviar, un validador bloquea cualquier respuesta con montos. Si el modelo falla, rechaza o se enreda, el cliente recibe un mensaje de respaldo y la conversación pasa a un asesor.
5. Al derivar, la conversación queda en modo `human`: el bot deja de responder y el pase queda en `handoffs`.
6. El envío revisa la ventana de 24 h; fuera de ella no manda texto libre (`blocked_window`), solo plantillas aprobadas.
7. Si el cliente pide que no le escriban más, el bot usa `no_escribir_mas` y el contacto queda con `opt_out_followups`.
8. Antes de enviar, `polishReply` quita las muletillas que el prompt ya prohíbe pero el modelo a veces usa ("¡Excelente!", "Es un gusto saludarle", "¡Que tenga un excelente día!") y las frases que hablan del sistema ("el sistema calcula unas 17 cajas" pasa a "serían unas 17 cajas"). Aplica también a los seguimientos.
9. Para que se sienta como una persona del equipo:
   - **Mensajes cortos:** la respuesta se parte por párrafos en hasta 3 mensajes (`splitBubbles`), con una pausa de "escribiendo" entre uno y otro de 0,8 a 3,5 s según el largo (`pausesMs` en el envío). Un reintento no repite la espera.
   - **Hora y nombre:** el modelo recibe una nota interna con la hora de la tienda y el primer nombre del cliente (`conversationNote`). Así saluda acorde a la hora y usa el nombre de vez en cuando, sin inventarlo si no lo hay.
   - **Fotos anteriores:** además de las fotos nuevas, ve la última foto que el cliente mandó en los 12 mensajes anteriores. Así entiende "¿y algo como la pared del fondo?".
   - **Cómo habla:** el prompt trae ejemplos de "así no / así sí". No adula, no usa frases de catálogo, se adapta al largo y al saludo del cliente y termina con una sola pregunta concreta.

## Seguimiento automático

Cuando el cliente deja de responder, el worker (una pasada por minuto) lo retoma como lo haría un vendedor. Se configura por negocio en `settings.followups` (ver `config/tenants/inversiones-mora-mora.json`).

El bot responde a cualquier hora, 24/7. Los seguimientos, en cambio, solo salen en el horario del negocio (`sendHours`, hora local del negocio; por defecto lunes a sábado de 08:00 a 18:00):

1. **Paso 1, dentro de las 24 h:** la IA lee la conversación y escribe un mensaje corto que retoma lo que hablaron, o decide no escribir (`NO_SEGUIR`) si el cliente se despidió, ya compró, no le interesa o solo saludó. Pasa por el mismo validador de precios.
   - **Cuándo sale:** lo ideal es `firstAfterMinutes` (20 h) después de la última respuesta del bot, en el primer momento en horario.
   - **Si el cliente escribió de noche:** ese momento cae fuera de horario o después de que cierre la ventana, así que el mensaje se adelanta a las últimas horas del tramo en horario anterior. Ejemplo: escribió el jueves a las 23:00 y el seguimiento sale el viernes a las 16:00. Nunca sale antes de `minFirstAfterMinutes` (3 h) de silencio.
   - **Si no queda ningún momento en horario dentro de las 24 h** (por ejemplo, escribió el sábado de noche), no se gasta IA y sigue la plantilla.
2. **Paso 2, fuera de las 24 h** (`template.afterMinutes`, 48 h por defecto desde el último mensaje del cliente): la plantilla aprobada por Meta, con el nombre del cliente y botones. También en horario y sin gastar IA. Solo va si el paso 1 salió, o si no se pudo mandar por la ventana.

Nunca escribe:
- fuera de `sendHours`;
- a conversaciones que atiende un asesor;
- a quien pidió que no le escriban;
- a conversaciones de más de `maxAgeDays`;
- dos veces por el mismo silencio (tabla `followups`, una fila por paso).

Si el cliente responde, su mensaje abre un silencio nuevo. En el panel, estos mensajes salen como "Bot · seguimiento".

El horario real de Inversiones Mora Mora es **sin dato** (`business.hours` está vacío). Lunes a sábado de 8:00 a 18:00 es un supuesto que falta confirmar con el cliente. `sendHours` acepta varios tramos, por ejemplo sábado solo hasta las 13:00: `[{"days":[1,2,3,4,5],"from":"08:00","to":"18:00"},{"days":[6],"from":"08:00","to":"13:00"}]`.

**Antes de producción:** crear y aprobar en el administrador de WhatsApp la plantilla `seguimiento_consulta` (idioma `es`, un parámetro `{{1}}` = nombre, botones de respuesta rápida "Sí, quiero cotizar", "Tengo dudas" y "No, gracias") con el mismo texto que `preview`. Meta probablemente la clasifique como *marketing*, que tiene costo por envío y exige que el cliente haya aceptado recibir mensajes del negocio.

Las peticiones a Claude usan el respaldo automático del servidor (`fallbacks: "default"`) si el modelo rechaza por un filtro de seguridad, y cachean el prompt de sistema y las herramientas.
