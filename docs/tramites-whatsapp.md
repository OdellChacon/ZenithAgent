# Trámites para poner WhatsApp en producción

Lista de lo que falta fuera del código para que el bot atienda a clientes reales de Inversiones
Mora Mora por WhatsApp, Messenger e Instagram. Revisada el 24/11/2026 con la documentación de Meta
de esa fecha; ampliada el 27/11/2026 con Messenger, Instagram y el vencimiento del token, y el
28/11/2026 con el cambio de quién es Tech Provider (ver "Quién es el dueño de la app").

Marcas: **[confirmado]** lo dice la documentación de Meta o Google que revisamos; **[por confirmar]**
es lo que hay que verificar al hacer el trámite.

## Quién es el dueño de la app

GrupoZenith todavía no está registrada ante ningún ente del gobierno, así que no puede pasar la
verificación de negocio de Meta, que pide documentos legales de la empresa. Por eso **la app de
Meta y la verificación son de Inversiones Mora Mora**: se creó un portafolio comercial de Mora
Mora aparte y en él la app. Mora Mora queda como **Tech Provider** de sí misma y GrupoZenith
trabaja la app como desarrolladora (con rol en la app, sin ser dueña).

Qué implica:

- La verificación, la revisión de la app y la cuenta de pago las hace o las aprueba alguien de
  Mora Mora con acceso de administrador a ese portafolio. GrupoZenith prepara todo y acompaña.
- Las credenciales de la app (`META_APP_ID`, `META_APP_SECRET`) son de Mora Mora; van solo en su
  servidor.
- Para coexistencia (el número sigue en la app WhatsApp Business del teléfono) hace falta ser Tech
  Provider o Solution Partner **[confirmado]**: sin la verificación de Mora Mora no hay
  coexistencia. **Plan B** si la verificación no sale: registrar los números como desarrollador
  directo, sin coexistencia (el número deja de usarse en la app del teléfono y se atiende solo
  desde el panel).
- Cuando GrupoZenith esté registrada y quiera atender a otros negocios, necesitará su propio
  portafolio verificado y su propia app como Tech Provider; esta app queda para Mora Mora.

## Orden recomendado

1. Esperar la confirmación de la verificación de Mora Mora antes de avanzar como Tech Provider
   (A1). Es lo que más tarda y no depende de nosotros.
2. En paralelo, montar el servidor (B) y pedirle a Mora Mora sus datos (C2, C5–C7, C9): con el
   dominio arriba ya se pueden configurar los webhooks y el registro insertado (A2–A3).
3. Con la verificación lista: revisión de la app (A4) y publicarla (A5).
4. Mora Mora conecta sus números desde el panel (C3–C4).
5. Prueba final con un número real (D).

## A. Mora Mora en Meta (Tech Provider)

| # | Trámite | Detalle | Estado |
|---|---|---|---|
| A1 | Portafolio comercial de **Mora Mora** para la app y **verificación del negocio** | Portafolio creado aparte para la app. La verificación se pide desde business.facebook.com → Configuración → Centro de seguridad, con los documentos legales de Mora Mora (RIF, acta constitutiva: **[por confirmar cuáles acepta Meta para Venezuela]**), su sitio web y un teléfono o correo del dominio. Agregar a la gente de GrupoZenith al portafolio con el acceso mínimo que haga falta. | En curso: portafolio creado, esperando la confirmación |
| A2 | **App de Meta** tipo Business con los productos WhatsApp, Messenger e Instagram | Creada en el portafolio de Mora Mora; falta agregarle los productos y los webhooks, que necesitan el dominio con https (B1). En developers.facebook.com. Cada producto lleva su webhook con la URL https del gateway y el mismo token de verificación (`META_WEBHOOK_VERIFY_TOKEN`): WhatsApp en `/webhooks/meta/whatsapp` con los campos `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync` y `account_update` **[confirmado]**; Messenger en `/webhooks/meta/messenger` con `messages`, `message_echoes`, `message_edits`, `message_deliveries` y `messaging_postbacks`; Instagram en `/webhooks/meta/instagram` con `messages` **[confirmado]**. Meta valida cada URL con un GET a esa misma ruta, y el gateway lo responde. Anotar `META_APP_ID` y `META_APP_SECRET` en el servidor de Mora Mora. | En curso: app creada |
| A3 | **Facebook Login for Business**: configuración de registro insertado | Crear una configuración con la variante "WhatsApp Embedded Signup" y copiar su id en `META_ES_CONFIG_ID` **[confirmado]**. Elegir el token de integración de negocio que **no vence** (es el valor por defecto según Meta), no la plantilla de 60 días: con 60 días habría que volver a conectar cada número antes de esa fecha. Si igual se usa, el sistema guarda la fecha y avisa una semana antes. En la configuración de OAuth, activar el inicio de sesión con el SDK de JavaScript y agregar el dominio https del panel a los dominios permitidos y a las URI de redirección **[confirmado]**. | Pendiente |
| A4 | **Revisión de la app** (App Review) | Pedir acceso avanzado a `whatsapp_business_management` y `whatsapp_business_messaging` **[confirmado]**. Para Messenger e Instagram, los permisos de mensajería de páginas e Instagram (`pages_messaging`, `pages_manage_metadata`, `instagram_manage_messages` y los de lectura de la página) **[por confirmar la lista exacta al hacer la revisión]**, y probar que la etiqueta `HUMAN_AGENT` (respuestas de una persona entre 24 h y 7 días) esté habilitada para la app. Hay que grabar 2 videos (la conexión de un número con el botón del panel y el envío de un mensaje); para grabarlos sirve un número de prueba. Para publicar la app, Meta pide la URL de una política de privacidad y una forma de borrar los datos **[por confirmar el detalle]**: hay que redactarlas y publicarlas. | Pendiente |
| A5 | Pasar la app a **modo publicado** y que Mora Mora quede como Tech Provider | Después de A1 y A4. Meta no cobra por ser Tech Provider **[confirmado]**. | Pendiente |

## B. Servidor (InterServer)

| # | Trámite | Detalle | Estado |
|---|---|---|---|
| B1 | **Dominio o subdominio** para el panel y el webhook, con **https** | Meta exige https para el webhook y para el dominio del registro insertado **[confirmado]**. Como la app es de Mora Mora, lo natural es un subdominio de su dominio (el mismo que use para la verificación); decidirlo con ellos. El certificado lo saca solo Caddy (ver [despliegue.md](despliegue.md)). | Pendiente (el https ya está resuelto en el código) |
| B2 | **VPS** con Docker | Todo (Node.js, PostgreSQL, Redis, ffmpeg) va dentro de Docker con `docker-compose.prod.yml`; el servidor solo necesita Docker. Mora Mora paga su servidor en InterServer. Tamaño del plan: **[por confirmar]** (para empezar, 2 vCPU y 4 GB). Pasos en [despliegue.md](despliegue.md). | Pendiente (configuración lista) |
| B3 | **Copias de seguridad** de la base de datos y monitoreo | La copia diaria dentro del servidor y `/healthz` (base, Redis y worker) ya están. Falta decidir **dónde se guardan las copias fuera del servidor** y **qué servicio externo vigila `/healthz`** (ej. UptimeRobot). | Pendiente (falta elegir destino y monitor) |
| B4 | **Correo saliente (SMTP)** para los avisos a los asesores | Elegir el proveedor y crear la cuenta; configurar SPF y DKIM del dominio remitente; probar con el comando `mail-test` (ver [despliegue.md](despliegue.md), sección Correo). Sin esto, los avisos solo quedan en el log. | Pendiente (falta la cuenta de correo) |
| B5 | **Gemini de pago** | Con Google AI Pro vienen 10 USD al mes en créditos de Cloud, que sirven para la API de Gemini si se activa la facturación en AI Studio (programa de desarrolladores y prepago de 5 USD) **[confirmado]**. En la capa de pago, Google no usa los datos **[confirmado]**. Poner la clave del proyecto con facturación en `GEMINI_API_KEY`. | Pendiente |

## C. Inversiones Mora Mora

| # | Trámite | Detalle | Estado |
|---|---|---|---|
| C1 | **Portafolio donde viven sus números, la página y el Instagram** | Puede ser el mismo portafolio de A1 o el que Mora Mora ya usa; con al menos una persona de Mora Mora como administradora. La verificación que pide la coexistencia es la de A1 (Mora Mora como Tech Provider). | Pendiente |
| C2 | **Método de pago** en WhatsApp Manager | Tarjeta que pague en USD. Meta cobra los mensajes de la API, como las plantillas de seguimiento, al negocio. Sin método de pago el registro no queda completo **[confirmado]**. | Pendiente |
| C3 | **Teléfonos listos para coexistencia** | WhatsApp Business **versión 2.24.17 o superior** en cada teléfono **[confirmado]**. Confirmar cuál de los dos números usa WhatsApp Business: el 0276-3471346 es fijo **[por confirmar]**. | Pendiente |
| C4 | **Conectar cada número** desde el panel (sección WhatsApp) | Con el teléfono a mano. Aceptar compartir el historial: Meta permite pedirlo una sola vez y dentro de las 24 h siguientes a la conexión **[confirmado]**; el sistema lo pide solo. | Pendiente (después de A y B) |
| C5 | **Plantilla de seguimiento** `seguimiento_consulta` | Crearla en WhatsApp Manager con el texto que está en `config/tenants/inversiones-mora-mora.json` y enviarla a aprobación. La categoría (marketing o utilidad) define el costo **[por confirmar con Meta]**. | Pendiente |
| C6 | **Datos que faltan para el bot** | Hoy figuran sin dato: formas de pago, envíos e instalación, porcentaje de desperdicio para calcular cajas y si abren los domingos (supusimos que no). También faltan la **foto de la fachada** y, si quieren, el enlace de Google Maps. | Pendiente |
| C7 | **Asesores del panel** | Nombre y correo de cada asesor para crear su usuario y quién recibe los avisos por correo. | Pendiente |
| C9 | **Página de Facebook e Instagram profesional** | La cuenta de Instagram tiene que ser profesional (empresa) y estar vinculada a la página de Facebook de Mora Mora. Hasta tener un botón en el panel para Messenger e Instagram, se conecta con `npm run channel:connect-meta -- --tenant inversiones-mora-mora --page-id <id> --instagram` y el token de la página en `META_PAGE_ACCESS_TOKEN`. El token de página que no vence se obtiene desde un usuario del sistema del portafolio **[por confirmar el paso a paso]**. | Pendiente |
| C8 | **Reglas de uso de los teléfonos** | Abrir WhatsApp Business en cada teléfono **al menos cada 13 días**: a los 14 días sin abrir, Meta desconecta el número **[confirmado]**. No contestar desde WhatsApp para Windows: esas respuestas no le llegan al sistema y el bot no se calla **[confirmado]**. Con la coexistencia se pierden en la app algunas funciones: catálogo, etiquetas, respuestas rápidas, mensajes de bienvenida y ausencia, grupos y difusiones nuevas **[confirmado]**. | Pendiente (explicárselo al equipo) |

## D. Prueba final

| # | Trámite | Detalle | Estado |
|---|---|---|---|
| D1 | Conectar un número real y probar todo (guion en [prueba-numero-real.md](prueba-numero-real.md); antes, la revisión `check-meta`) | Mensajes, fotos, videos, documentos, notas de voz, ubicación, mensajes editados y borrados, pase a asesor, archivos que manda el asesor desde el panel, asesor que contesta desde el teléfono, historial, plantilla de seguimiento y aviso de desconexión. En Messenger e Instagram: mensajes, fotos, respuesta del asesor después de 24 h (Human Agent) y textos largos en Instagram (se parten en mensajes de 1000 bytes). | Pendiente |
| D2 | Revisar costos del primer mes | Mensajes de plantilla (Meta) e IA (Gemini). | Pendiente |
