# WAHA 2026.9.2 (WEBJS): endpoints y webhooks que usa el bot

Leído el 7-oct-2026 del Swagger real de `devlikeapro/waha:latest-2026.9.2` (contenedor descartable en `127.0.0.1`, sin número vinculado, ya borrado). `GET /-json` con Basic auth del Swagger (`WHATSAPP_SWAGGER_USERNAME/PASSWORD`) devuelve el OpenAPI 3.1 (163 rutas). Lo que el Swagger no dice y se comprobó con la imagen corriendo o leyendo su código queda marcado **(comprobado)**. Lo que no se pudo comprobar sin un número vinculado queda marcado **SIN VERIFICAR**.

Todo va con header `X-Api-Key: <WAHA_API_KEY>`. El cuerpo es JSON. `session` es `default` salvo que se cambie.

## Sesión

| Qué | Endpoint | Notas |
|---|---|---|
| Crear y arrancar con webhooks | `POST /api/sessions` | Cuerpo abajo. Responde la sesión (`status: STARTING`) **(comprobado)**. |
| Estado | `GET /api/sessions/{session}` | `{ name, status, me, config, engine… }`. `status`: `STOPPED`, `STARTING`, `SCAN_QR_CODE`, `PASSKEY_REQUIRED`, `PASSKEY_CONFIRMATION_REQUIRED`, `WORKING`, `FAILED`. Sesión inexistente: 404 `{message:"Session not found"}` **(comprobado)**. |
| QR | `GET /api/{session}/auth/qr` | Lo usa la parte B. |
| Restricciones | `GET /api/sessions/{session}/timelock` (463) y `/capping` (475) | Lo usa la parte B. El error 463 sale como texto "server returned error 463" al enviar a un contacto nuevo. |

```json
POST /api/sessions
{
  "name": "default",
  "start": true,
  "config": {
    "ignore": { "status": true, "groups": true, "channels": true, "broadcast": true },
    "webhooks": [{
      "url": "http://bot:8080/waha",
      "events": ["message.any", "message.ack", "message.revoked", "message.edited", "session.status"],
      "hmac": { "key": "<WAHA_WEBHOOK_HMAC_SECRET>" },
      "retries": { "delaySeconds": 2, "attempts": 15, "policy": "exponential" }
    }]
  }
}
```

- Probado con esta forma exacta: la sesión pasó de `STARTING` a `SCAN_QR_CODE` y los dos `session.status` llegaron al receptor con HMAC válido **(comprobado)**.
- `webjs.tagsEventsOn` (default `false`): el Swagger dice "emite los eventos `tag:*` necesarios para `presence.update` y `message.ack`" y avisa que afecta rendimiento y estabilidad. **SIN VERIFICAR** si en WEBJS `message.ack` llega sin esa opción. El bot no depende del ack para confirmar un envío: usa el id que devuelve `sendText` y el eco `message.any`.
- Reintentos del webhook: ante cualquier respuesta que no sea 2xx WAHA reintenta (hasta `attempts`, default 15) **(comprobado en el código de la imagen)**. Por eso `/waha` responde 200 apenas guarda.

## Enviar

Con la sesión fuera de `WORKING`, todos devuelven **422** `{"error":"Session status is not as expected…","status":"SCAN_QR_CODE","expected":["WORKING"]}` **(comprobado)**. Sesión inexistente: 422 `{"error":"Session \"x\" does not exist"}`. Sin clave o clave mala: 401 `{message:"Unauthorized"}` **(comprobado)**.

| Qué | Endpoint | Cuerpo | Respuesta |
|---|---|---|---|
| Texto | `POST /api/sendText` | `{ session, chatId, text, linkPreview? }` (`reply_to`, `mentions`, `id` opcionales) | 201 `WAMessage`: `id` es el id del mensaje (`false_<chatId>_<ID>`) |
| Imagen | `POST /api/sendImage` | `{ session, chatId, caption?, file }`. `file` es **una de dos formas**: `{ mimetype, filename?, url }` o `{ mimetype, filename?, data }` con `data` en base64 | 201, objeto `WAMessage` **SIN VERIFICAR** (el Swagger la declara como `object`) |
| Visto | `POST /api/sendSeen` | `{ session, chatId, messageIds?: string[] }` | 201 |
| Escribiendo | `POST /api/startTyping` / `POST /api/stopTyping` | `{ session, chatId }` | 201 |

- **Imagen desde archivo local:** se lee el archivo y se manda como `{ mimetype: "image/jpeg", filename, data: <base64> }`. La otra forma (`url`) pide que WAHA pueda alcanzar esa URL: no se usa.
- `messageIds` de `sendSeen` son ids completos de WAHA (`false_<chatId>_<ID>`), los mismos que se guardan como `provider_msg_id`.
- 463 y 475 salen como error del envío con ese número en el texto del mensaje de error **SIN VERIFICAR** (no se puede provocar sin una cuenta). El adaptador lo toma como restricción solo si el error es claramente ese código: estado HTTP 463/475, el texto `server returned error 463|475` o un campo `code`/`statusCode` con ese número en el JSON. Un `475` suelto en un stack o en el HTML de un proxy no cuenta.

## Leer

| Qué | Endpoint |
|---|---|
| Mensajes de un chat | `GET /api/{session}/chats/{chatId}/messages?limit=N&sortOrder=desc&filter.timestamp.gte=<s>&filter.fromMe=true\|false` |
| Chats | `GET /api/{session}/chats?limit=N&sortBy=conversationTimestamp&sortOrder=desc` |
| Chats con último mensaje | `GET /api/{session}/chats/overview?limit=N` → `[{ id, name, picture, lastMessage, _chat }]` |

- Mensajes: devuelve un arreglo de `WAMessage` (mismo formato que el webhook). `limit` es obligatorio (default 10). `filter.timestamp.gte/lte` son "inclusivos"; el Swagger no dice la unidad: **SIN VERIFICAR**, se manda en segundos (como el `timestamp` de `WAMessage`) y además el adaptador vuelve a filtrar por su propia hora normalizada. `merge=true` por defecto mezcla `@lid` y `@c.us` del mismo contacto: el adaptador manda `merge=false` para trabajar con el `chatId` tal cual.
- Chats: el Swagger no declara la forma de la respuesta. **SIN VERIFICAR**: el adaptador usa `GET /chats/overview` y lee `id` y `lastMessage.timestamp`, y si algo no tiene la forma esperada lo descarta (la reconciliación al prender es de la parte B).
- Con sesión no `WORKING`, estos también devuelven 422 **(comprobado)**.

## Audios del cliente (F2b)

El bot baja el audio de WAHA, lo convierte con ffmpeg y lo transcribe con OpenAI (`gpt-transcribe`). Lo que sigue sale de los docs de WAHA ("Receive messages", "Configuration") y del código de la imagen fija `devlikeapro/waha:latest-2026.9.2` (leído el 8-oct-2026 con el contenedor descartable, sin número vinculado). Lo que solo se vería con un número real queda marcado **SIN VERIFICAR**.

- **`payload.media`** de un `message.any` con adjunto: `{ url, mimetype, filename, error? }`. El código de la imagen (`MediaManager`) arma `{ url: null, filename, mimetype }` y, si algo falla, le suma `error` (el objeto del error). `url` queda en `null` si WAHA no bajó el archivo: porque el tipo no entra en el filtro de abajo, o porque la bajada falló. **(comprobado en el código de la imagen)** La forma exacta que llega en WEBJS con un audio real **SIN VERIFICAR**: el bot toma `media.url`, `media.mimetype` y si `media.error` es verdadero, y lo que falte lo trata como audio ilegible.
- **La `url`** es `<WAHA_BASE_URL>/api/files/<id del mensaje>.<extensión>`, por ejemplo `http://localhost:3000/api/files/false_<chatId>_<ID>.oga` **(comprobado: ejemplo del Swagger y `MediaLocalStorage`)**. `WAHA_BASE_URL` sin definir arma el host con el nombre del contenedor, que no es la `WAHA_URL` del bot (`http://waha:3000`).
  - **Por eso el bot ignora el host del mensaje.** De la `url` toma solo el *pathname*, que tiene que empezar con `/api/files/` y no tener `..` (tampoco escapado ni con barra invertida). Lo guarda así en la base (`messages.media_url`) y pide el archivo a la `WAHA_URL` configurada. Un host ajeno en el mensaje no se contacta nunca.
  - Un path que no es de `/api/files/` o con `..` se trata como si WAHA no hubiera mandado archivo: audio ilegible, sin pedir nada.
- **Bajada:** `GET <WAHA_URL><pathname>` con `X-Api-Key`, sin seguir redirecciones (la clave no sale a otro host), timeout de 30 s y corte a los 16 MB contados mientras baja. 404 o 410 (WAHA ya lo borró) y cualquier otro 4xx salvo 401, 403, 408 y 429: audio ilegible. 401 o 403: error de clave (avisa y reintenta). Red, 5xx, 408 y 429: pasajero (avisa y reintenta con espera). El `mimetype` del mensaje tiene que empezar con `audio/`; si no, ilegible sin bajar nada.
- **Qué baja WAHA y por cuánto tiempo** (variables del servicio `waha` en `docker-compose.yml`):

| Variable | Valor | Para qué |
|---|---|---|
| `WAHA_EVENTS_DOWNLOAD_MEDIA_MIMETYPES` | `audio` | Qué adjuntos baja antes de mandar el webhook. Filtra por prefijo del `mimetype` (`mimetype.startsWith(...)`) **(comprobado)**: `audio` entra `audio/ogg; codecs=opus`. Fotos, videos y documentos llegan con `url: null`. |
| `WAHA_API_DOWNLOAD_MEDIA_MIMETYPES` | `audio` | Lo mismo para las respuestas de la API (por ejemplo la historia de un chat al reconciliar). |
| `WHATSAPP_FILES_LIFETIME` | `86400` | Segundos que WAHA guarda los archivos (default 180 **(comprobado)**). Un día, para que el archivo siga ahí mientras el bot espera o reintenta (`reply_window_hours` es 12). Los archivos viven en `/tmp/whatsapp-files` del contenedor, sin volumen: si WAHA se recrea, se pierden y esos audios quedan ilegibles. |

- **Historia:** `GET /api/{session}/chats/{chatId}/messages` devuelve los mismos `WAMessage`; con el filtro de arriba, un audio de la historia trae su `media.url`. Al prender, el bot lo recupera como pendiente si trae url y como ilegible si no. **SIN VERIFICAR** que WEBJS devuelva `media` en esa lista.

## Webhooks

Cada POST trae:

- Headers **(comprobado en vivo y en el código de la imagen)**:
  - `X-Webhook-Hmac`: HMAC-SHA512 en hex del **cuerpo crudo**, con la clave configurada en `hmac.key`.
  - `X-Webhook-Hmac-Algorithm: sha512`.
  - `X-Webhook-Request-Id`: id de la petición (no es el del evento).
  - `X-Webhook-Timestamp`: ms.
  - Sin `hmac.key` configurada, no manda ninguno de los dos primeros.
- Cuerpo (el sobre):

```json
{
  "id": "evt_01m4cct6x0z8gm4j8gs3k2fb0p",
  "timestamp": 1791417457569,
  "event": "session.status",
  "session": "default",
  "me": null,
  "payload": { "name": "default", "status": "STARTING", "statuses": [{ "status": "STARTING", "timestamp": 1791417457568 }], "data": null },
  "engine": "WEBJS",
  "environment": { "version": "2026.9.2", "engine": "WEBJS", "tier": "CORE", "browser": "/usr/bin/chromium", "platform": "linux/x64", "worker": { "id": null } }
}
```

Ese `session.status` es real **(comprobado)**. `id` es un ULID del evento (`evt_…`): sirve de `event_key`. `timestamp` del sobre está en **ms**. Dentro de `payload` (un `WAMessage`) el `timestamp` está en **segundos**: de ahí la regla "menor que 1e12 son segundos".

### `message.any` (todo mensaje, también los propios)

`payload` es un `WAMessage` (forma según el Swagger; los valores de `_data` no se pudieron ver sin número):

| Campo | Qué es |
|---|---|
| `id` | `false_<chatId>_<ID>` (entrante) o `true_<chatId>_<ID>` (propio). Es el id que se guarda. |
| `timestamp` | segundos |
| `from` | en un entrante, el chat del cliente; en un propio, la cuenta (el Swagger: "el chat… excepto si lo mandó el usuario actual") |
| `to` | en un propio, el chat al que se mandó; en un entrante, la cuenta |
| `fromMe` | `true` si lo escribió la cuenta |
| `source` | `api` (lo mandó el bot por WAHA) o `app` (celular, Web). Solo en `fromMe: true` |
| `body` | texto. Vacío en medios sin texto |
| `hasMedia` | hay adjunto |
| `media` | `{ url, mimetype, filename, error? }`; ver "Audios del cliente (F2b)" |
| `ack`, `ackName` | -1 a 4 |
| `_data` | objeto crudo del motor. **SIN VERIFICAR** su forma: del código de AXXEN y de whatsapp-web.js, `_data.type` es `chat`, `image`, `ptt`/`audio`, `video`, `document`, `sticker`, `location`, `vcard`, `multi_vcard` o tipos de sistema (`e2e_notification`, `notification`, `notification_template`, `gp2`, `protocol`, `revoked`, `ciphertext`, `call_log`, `broadcast_notification`), y `_data.notifyName` es el nombre de perfil |

- Chat 1 a 1: el `chatId` termina en `@c.us` o `@lid`. Grupos `@g.us`, estados `status@broadcast`, canales `@newsletter` y difusiones `@broadcast` se ignoran.
- Un entrante (`fromMe: false`) trae el chat en `from`; uno propio (`fromMe: true`) trae el chat en `to`.

### `message.ack`

`payload`: `{ id, from, to, participant, fromMe, ack, ackName, _data }`. `ack`: `-1` error, `0` pendiente, `1` servidor, `2` dispositivo, `3` leído, `4` reproducido (el Swagger lista `ERROR|PENDING|SERVER|DEVICE|READ|PLAYED` en ese orden; la equivalencia es por el orden).

### `message.revoked`

`payload`: `{ revokedMessageId, after, before, _data }`. `revokedMessageId` en el ejemplo es **corto** (`A06CA7BB…`, sin el prefijo `false_<chat>_`); `before` es un `WAMessage` con el id completo del original y `after` el aviso de borrado. **SIN VERIFICAR** cuál de los dos viene completo con WEBJS: el adaptador usa `before.id` y, si falta, el id corto, y la base busca por id exacto o por sufijo `_<id>`.

### `message.edited`

`payload`: un `WAMessage` con el texto nuevo en `body` más `editedMessageId` ("id del mensaje original"; en el ejemplo, corto). `id` es el id de este mensaje. **SIN VERIFICAR** el formato real: mismo tratamiento que revoked (id exacto o por sufijo).

### `session.status`

`payload`: `{ name, status, statuses: [{status, timestamp}], data }`. Cuando la cuenta tiene una restricción 463 o un tope 475, viaja en `me.reachoutTimelock` / `me.messageCapping` del sobre (según el Swagger; **SIN VERIFICAR**).

## Parte B: lo que usa `src/session.ts`, comprobado el 8-oct-2026 con la imagen fija y sin número vinculado

- `GET /api/sessions/{session}` **(comprobado)**: devuelve también la `config`, **con la clave del HMAC en claro** (`config.webhooks[0].hmac.key`). Por eso el bot puede comparar la config y detectar un secreto rotado; y por eso ese JSON no se escribe en ningún log.
- `POST /api/sessions` con una sesión que ya existe: **422** `{"message":"Session 'default' already exists. Use PUT to update it."}` **(comprobado)**. El bot primero hace el GET y, si el POST choca igual (carrera entre dos arranques), vuelve a mirar y compara.
- `PUT /api/sessions/{session}` con `{ name, config }` **(comprobado)**: actualiza la config y la sesión reconecta con lo guardado (pasa por `STARTING`, sin pedir QR). El bot solo lo usa si la config difiere de la que quiere.
- `POST /api/sessions/{session}/start` **(comprobado)**: con la sesión ya arrancada devuelve la sesión en `STARTING`. El bot solo lo llama si el estado es `STOPPED`.
- `GET /api/{session}/auth/qr` **(comprobado)**: con la sesión en `SCAN_QR_CODE` devuelve el PNG (`Content-Type: image/png`); con `Accept: application/json` devuelve `{ mimetype, data }` en base64. El bot pide el PNG y lo manda a Telegram con `sendPhoto`.
- `GET /api/sessions/{session}/timelock` y `/capping`: **no se usan** (sin número vinculado la llamada no responde en tiempo razonable). Las restricciones 463/475 se ven por el error del envío, en `outbox.ts`.
- Seguridad **(comprobado)**: sin `X-Api-Key`, la API da 401. `GET /ping` es público (sirve para un healthcheck de Docker). `GET /health` de WAHA **pide la clave**. El panel (`/dashboard`) y el Swagger (`/`) piden usuario y clave: si no se configuran, WAHA genera unos al azar en cada arranque y los escribe en el log; `docker-compose.yml` los fija a `admin` + `WAHA_API_KEY`.
- Persistencia **(comprobado)**: la sesión y su base viven en `/app/.sessions` (`webjs/default` y `waha.sqlite3`); WAHA reinicia solo las sesiones guardadas al arrancar.
