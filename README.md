# ZenithAgent

Bot conversacional con IA, omnicanal (WhatsApp, Instagram, Facebook Messenger y TikTok en fase 2) y multi-tenant, desarrollado por GrupoZenith. Primer cliente: Inversiones Mora Mora.

La especificación técnica está en [`docs/spec-bot-omnicanal.md`](docs/spec-bot-omnicanal.md). Los trámites que faltan para poner WhatsApp en producción están en [`docs/tramites-whatsapp.md`](docs/tramites-whatsapp.md). El despliegue en el servidor está en [`docs/despliegue.md`](docs/despliegue.md) y el guion de la primera prueba con un número real, en [`docs/prueba-numero-real.md`](docs/prueba-numero-real.md).

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
| Botón "Conectar WhatsApp" en el panel (Embedded Signup v5) | Hecho (falta la app de Meta: Tech Provider, `META_APP_ID`, `META_ES_CONFIG_ID`) |
| Horario de atención: el bot sabe si la tienda está abierta y, al derivar fuera de horario, dice cuándo responde el asesor | Hecho |
| Dirección con foto de la fachada | Hecho (falta la foto real del negocio) |
| "Leído" y "escribiendo…" en WhatsApp mientras el bot prepara la respuesta | Hecho |
| Nombres de la agenda del teléfono (contactos de la app WhatsApp Business) | Hecho (falta conectar números reales con Meta) |
| Notas de voz: se transcriben y el bot responde a lo que dijo el cliente | Hecho (el servidor necesita ffmpeg) |
| Ubicaciones y tarjetas de contacto del cliente | Hecho |
| El asesor manda fotos, videos y documentos desde el panel (se revisa el tipo real y lo que admite cada canal) | Hecho |
| Videos y documentos del cliente: el asesor los abre en el panel; el bot mira un cuadro del video y las imágenes mandadas como documento | Hecho (los PDF y Word el bot no los lee: ofrece que un asesor los revise) |
| Mensajes editados o borrados por el cliente o por el asesor desde la app | Hecho |
| Aviso si Meta rechaza el token de una cuenta o está por vencer: revisión diaria, franja en el panel y correo | Hecho |
| Catálogos de productos en el panel: el administrador los sube y los asesores los arrastran a un chat para mandarlos | Hecho |
| Despliegue con Docker: https automático (Caddy), copias diarias de la base, `/healthz` para el monitoreo y CI en GitHub | Hecho (falta el servidor, el dominio y elegir dónde guardar las copias fuera del servidor) |
| Messenger e Instagram: mensajes, fotos, audios, respuestas del bot y asesor hasta 7 días (etiqueta Human Agent) | Hecho (se conectan con `npm run channel:connect-meta`; falta la app de Meta con los permisos de páginas e Instagram) |

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
  channel-meta/   Adaptador de Messenger e Instagram (Send API de la página) y descarga de archivos de cualquier canal
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

Una página con un teléfono que se ve como WhatsApp, Instagram o Messenger. Lo que escribes pasa por el sistema real (gateway, colas, worker, BD) y el simulador hace de Meta: recibe la respuesta del bot y manda los estados "entregado" y "leído". Cada apariencia usa su canal de verdad: WhatsApp por la Cloud API e Instagram y Messenger por la Send API de la página, cada uno con su webhook.

Para Instagram y Messenger, conecta una vez la página simulada (con el simulador levantado):

```bash
META_PAGE_ACCESS_TOKEN=sim npm run channel:connect-meta -- --tenant inversiones-mora-mora --page-id 100000000000777 --instagram
```

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
- **Notas de voz:** WhatsApp las manda en ogg/opus y Gemini solo acepta wav o mp3, así que el worker las baja, las convierte a mp3 con ffmpeg (hasta 5 minutos) y las transcribe con el mismo proveedor de IA y sus modelos de respaldo. El texto queda guardado en el mensaje: lo ven el bot, el panel ("Nota de voz, transcrita") y los turnos siguientes. Si no se pudo transcribir (sin ffmpeg, error de Meta o del proveedor, audio que no se entiende), el bot le pide al cliente que la repita o la escriba. Con `AI_PROVIDER=anthropic` no se transcriben (Claude no recibe audio); con `openai-compatible`, solo si `AI_AUDIO=true`. `FFMPEG_PATH` cambia la ruta de ffmpeg.
- **Ubicaciones y tarjetas de contacto:** se guardan como mensajes del cliente con texto legible; en el panel la ubicación trae enlace a Google Maps. Al modelo solo le llegan el nombre y la dirección del lugar y los nombres de los contactos: ni coordenadas ni teléfonos de terceros.
- **Promesas de asesor:** si el bot le dice al cliente que un asesor lo atenderá ("le paso su caso", "un asesor le escribirá") pero no usó `derivar_a_asesor`, el sistema crea el pase igual para que nadie quede esperando.
- **Leído y escribiendo:** cuando el bot va a responder, marca el mensaje del cliente como leído y le muestra "escribiendo…" (Meta lo quita al llegar la respuesta o a los 25 s). Si Meta falla, el bot responde igual.
- **Agenda del teléfono:** con coexistencia, Meta manda los contactos guardados en la app (`smb_app_state_sync`) al conectar y cada vez que se agrega, edita o borra uno. El nombre de la agenda queda en el perfil del contacto (`agendaName`) y pasa a ser su nombre si no tenía o seguía con el de su perfil de WhatsApp; no pisa un nombre cambiado en el panel.
- **Horario:** `business.hours` es el texto que el bot le dice al cliente y `business.openingHours` el mismo horario por tramos (días 0 = domingo … 6 = sábado). Con los tramos, la nota interna de cada turno dice si la tienda está abierta y cuándo abre; si el bot deriva con la tienda cerrada, le dice al cliente cuándo le escribe el asesor ("mañana a partir de las 8:00 a. m."). El bot sigue atendiendo a cualquier hora. Los seguimientos usan `followups.sendHours`, que para Mora Mora coincide con el horario.
- **Dirección con foto de la fachada:** cuando preguntan dónde quedan, el bot usa `enviar_ubicacion` y manda la foto de la fachada con la dirección como pie de foto. Sin foto cargada, da la dirección en texto. La foto se carga (o reemplaza) con `npm run tenant:storefront -- --tenant-id <uuid> --photo ruta/fachada.jpg`; se guarda en `product_images` con `purpose = 'storefront'`.
- **Conectar WhatsApp (sección WhatsApp del panel):** el dueño o un administrador conecta un número con el registro insertado de Meta (Embedded Signup v5, con coexistencia activada por defecto). El navegador solo recibe un código; la API lo canjea por el token del negocio (vence a los 5 minutos), suscribe la app a los webhooks de la cuenta, registra el número con un PIN si es nuevo en la API (en coexistencia no hace falta) y, si el número sigue en la app, pide una sola vez los contactos y el historial. El token (y el PIN) se guardan cifrados. Un negocio no puede tomar un número conectado en otro (RLS). Necesita `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` (configuración "WhatsApp Embedded Signup" de Facebook Login for Business), `META_GRAPH_API_VERSION` y `ENCRYPTION_MASTER_KEY`; el panel debe servirse por https desde un dominio permitido en la app de Meta.
  - Con el simulador (`META_GRAPH_BASE_URL` en localhost) el botón conecta el número de prueba sin abrir Meta, y el simulador responde como Graph y manda dos chats ficticios de historial.
