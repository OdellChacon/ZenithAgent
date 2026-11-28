# Prueba con un número real

Guion para el trámite D1: la primera vez que el bot atiende por un número de WhatsApp real (y
por la página e Instagram de Mora Mora). El simulador cubre el sistema por dentro; esta prueba
cubre lo que solo Meta puede confirmar. Se hace con el servidor ya desplegado
([despliegue.md](despliegue.md)) y la app de Meta configurada (trámites A).

**Quiénes:** una persona de GrupoZenith en el panel y otra con un teléfono personal que hace de
cliente. **Duración:** unas 2 horas, más 24 h de espera para lo marcado con ⏱.

Antes de empezar, AI_PROVIDER con la capa de pago (B5): en la gratuita Google puede usar lo que
se le manda.

## 0. Revisión previa (5 minutos)

```bash
sh deploy/admin.sh check-meta --url https://<DOMAIN>
```

Tiene que terminar en "Todo en orden". Revisa `/healthz`, que Meta pueda validar los tres
webhooks, el token de cada cuenta y que la plantilla de seguimiento esté aprobada. No le manda
nada a ningún cliente.

## 1. WhatsApp

Anotar en cada paso ✓ o lo que pasó (captura del teléfono y del panel). Si algo falla, el
detalle está en `zc logs worker` y en el panel (mensaje con "No se envió").

| # | Prueba | Qué debe pasar |
|---|---|---|
| W1 | Conectar el número desde el panel (WhatsApp → Conectar) | Queda "Activo"; si estaba en la app WhatsApp Business, "También en la app del teléfono" y empieza a importar chats anteriores. |
| W2 | El cliente escribe "Hola, ¿tienen porcelanato tipo madera?" | El cliente ve "leído" y "escribiendo…", y recibe fotos del catálogo y la respuesta. |
| W3 | El cliente manda una foto de un piso | El bot comenta lo que ve y busca algo parecido. |
| W4 | El cliente manda una nota de voz | El bot responde a lo que dijo; en el panel se ve transcrita y se puede escuchar. |
| W5 | El cliente manda un video corto y un PDF | El bot comenta el video; del PDF ofrece un asesor. En el panel se abren los dos. |
| W6 | El cliente manda su ubicación | El panel la muestra con enlace al mapa. |
| W7 | El cliente edita un mensaje y borra otro | El panel muestra "editado" y "El cliente eliminó este mensaje". |
| W8 | El cliente pide precio | Pasa a asesor: sonido y aviso en el panel, y llega el correo. |
| W9 | El asesor toma la conversación y responde, manda una foto, un PDF y un catálogo arrastrado | Todo llega al teléfono; los documentos con su nombre. |
| W10 | El asesor devuelve al bot | El bot vuelve a responder el siguiente mensaje. |
| W10b | Con "El bot y los catálogos" activado en Catálogos, el cliente pide "¿tienen catálogo de grifería?" | Llega el catálogo que corresponde y después el texto. Si se vuelve a pedir, no lo repite. Con el interruptor apagado, el bot no manda archivos. |
| W11 | Desde la app WhatsApp Business del negocio, alguien responde a mano | El bot se calla en ese chat y el panel muestra el mensaje como "desde el teléfono". |
| W12 | ⏱ El cliente no responde | A las ~20 h el bot manda el seguimiento; pasadas 24 h sale la plantilla aprobada. |
| W13 | ⏱ Pasadas 24 h, el asesor intenta escribir | El panel ofrece solo plantillas; la plantilla llega. |
| W14 | Probar el aviso de desconexión: en Meta Business, quitar y volver a dar acceso a la app | Franja roja en el panel y correo; al volver a conectar, desaparece. |

## 2. Messenger e Instagram

| # | Prueba | Qué debe pasar |
|---|---|---|
| M1 | El cliente escribe a la página de Facebook | El bot responde con fotos y texto; el panel muestra el nombre del cliente. |
| M2 | El cliente escribe por Instagram y manda una foto | Igual que M1; el bot ve la foto. |
| M3 | En Instagram, una respuesta larga del bot | Llega partida en varios mensajes, sin cortes a mitad de palabra. |
| M4 | El asesor responde desde el panel con un catálogo | Llega el archivo y, aparte, el texto. |
| M5 | ⏱ Pasadas 24 h (menos de 7 días), el asesor responde | Llega (etiqueta Human Agent). El bot, en cambio, ya no escribe. |
| M6 | Alguien responde a mano desde la bandeja de Meta Business | El bot se calla en ese chat. |

## 3. Cierre

- Revisar en el panel que no queden mensajes con "No se envió" sin explicación.
- `zc logs worker --since 3h | grep -i error`: anotar cualquier error.
- Revisar el consumo del día en Meta (mensajes de plantilla) y en Google AI Studio (trámite D2).
- Pasar los hallazgos a una lista y corregirlos antes de abrir el número a todos los clientes.
