# Cómo se maneja el bot (para Lazar)

El bot vive en tu notebook, adentro de Docker. Son tres piezas que se prenden juntas:

- **El bot**: lee lo que escribe el cliente, arma la respuesta y la manda.
- **WAHA**: es el que está conectado al WhatsApp. El bot le habla a WAHA.
- **Whisper**: escucha las notas de voz de los clientes y las pasa a texto, en tu notebook y gratis (ver el punto 9).

Todo lo que el bot quiere contarte (consultas listas para presupuesto, borradores, problemas) llega al **grupo de Telegram**. Ahí también lo controlás con botones y comandos.

Hoy arranca en **modo sombra**: el bot prepara la respuesta pero **no le escribe al cliente**. Te la deja en Telegram con un botón [Mandar]. Eso se apaga solo cuando vos lo decidas (ver el final).

## 1. La primera vez

### Qué tiene que estar listo

- Docker Desktop instalado y abierto (el ícono de la ballena, sin errores).
- Un celular con un **número de prueba** (no el de Olimpo todavía) con WhatsApp.
- La carpeta `OLIMPO PADEL\bot-ventas`. Todos los comandos de abajo se escriben en PowerShell parado en esa carpeta.
- El modelo de Whisper bajado (una sola vez, unos 465 MB): `pnpm whisper:model`. Sin él, los audios no se pueden escuchar (ver el punto 9).

### El archivo `.env`

Copiá `.env.example` como `.env` y completá estos valores. **El `.env` tiene claves: no se manda por mail, no se sube a git, no se saca captura.**

| Variable | Qué poner | De dónde sale |
|---|---|---|
| `OPENAI_API_KEY` | La clave de OpenAI | platform.openai.com, Settings, API keys. Sin saldo cargado el bot no contesta (te avisa por Telegram). Además de armar las respuestas, transcribe los audios **solo si pasás a `BOT_TRANSCRIBER=openai`** (ver el punto 9): por defecto los audios se escuchan con Whisper en tu notebook y esto no hace falta para eso. |
| `WAHA_API_KEY` | Una clave larga que inventás vos | Solo letras y números, sin símbolos. Es también la clave del panel de WAHA (usuario `admin`). |
| `WAHA_WEBHOOK_HMAC_SECRET` | Otra clave larga que inventás vos | Distinta de la anterior, también solo letras y números. Es el sello con el que WAHA firma lo que le manda al bot. |
| `TELEGRAM_BOT_TOKEN` | El token del bot de Telegram | En Telegram, hablale a **@BotFather**, mandá `/newbot` y seguí los pasos. Te da el token. |
| `TELEGRAM_GROUP_ID` | El número del grupo (empieza con `-`) | Mirá abajo. |
| `HEALTHCHECKS_PING_URL` | La dirección de latido (opcional) | healthchecks.io, mirá abajo. Si la dejás vacía, no hay latido. |
| `BOT_LLM` | `openai` para el cerebro de verdad, `fake` para probar sin gastar nada | `fake` contesta siempre lo mismo: sirve para ver que todo está conectado. Con `fake` los audios también se "transcriben" de mentira (siempre el mismo texto, gratis). |
| `BOT_MODEL` y `BOT_EFFORT` | El cerebro: `claude-sonnet-5-5` y `medium` | Es lo que pasó el banco de pruebas el 9-oct. Van los dos: sin `BOT_EFFORT` queda en `low`, y en `low` Sonnet no pasó. Con Sonnet hace falta `ANTHROPIC_API_KEY` con saldo (la Claude Platform). Sin estas dos líneas el bot usa Sol de OpenAI. |
| `BOT_TRANSCRIBER` | (opcional) Quién transcribe los audios: `local` u `openai` | Sin esto, `local`: Whisper en tu notebook, gratis. `openai` cuesta y necesita saldo (ver el punto 9). |
| `BOT_TRANSCRIBE_MODEL` | (opcional) El modelo de OpenAI que transcribe los audios | Solo con `BOT_TRANSCRIBER=openai`. Sin esto, `gpt-transcribe`. Va siempre a OpenAI, aunque `BOT_MODEL` sea de Claude. |
| `WHISPER_URL` y `WHISPER_THREADS` | (opcionales) Dónde está Whisper y cuántos hilos de CPU usa | Sin esto, `http://whisper:8080` y 4 hilos. No se tocan salvo que cambie la instalación. |
| `WAHA_URL` y `BOT_PUBLIC_WEBHOOK_URL` | No se tocan | Son los nombres de las dos piezas adentro de Docker. |

**Para generar una clave larga** (PowerShell): `-join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})`. Corrélo dos veces: una para `WAHA_API_KEY` y otra para `WAHA_WEBHOOK_HMAC_SECRET`.

**El grupo de Telegram:**

1. Creá un grupo con Tomás y sumá al bot que creaste.
2. Mandá cualquier mensaje en el grupo.
3. **Antes de prender el bot**, abrí en el navegador `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` (poné tu token en lugar de `<TU_TOKEN>`). Buscá `"chat":{"id":-100...`: ese número negativo, completo y con el signo, es el `TELEGRAM_GROUP_ID`.
4. Si ya prendiste el bot, ese enlace da error porque el bot ya está leyendo los mensajes: apagalo (`docker compose stop`), mirá el número y volvé a prender.
5. **Ojo:** si después cambiás algo del grupo (hacer admin al bot, activar el historial, etc.), Telegram puede convertirlo en "supergrupo" y **le cambia el número** (pasa a empezar con `-100`). Ahí el bot deja de avisar y no contesta `/qr`. El error queda en el registro como "group chat was upgraded to a supergroup chat". Hay que poner el número nuevo en `TELEGRAM_GROUP_ID` y correr `docker compose up -d --force-recreate bot`.

**El latido (healthchecks.io):** creá un check nuevo con período de 1 minuto y tolerancia de 5 minutos, y poné que te avise por mail o por Telegram. Copiá la "ping URL" en `HEALTHCHECKS_PING_URL`. Si la notebook se apaga o el WhatsApp se cae, el bot deja de latir y healthchecks te avisa solo. Es la única alarma que funciona aunque la notebook esté apagada.

### Prenderlo

```powershell
docker compose up -d --build
```

La primera vez tarda unos minutos (baja e instala todo: ffmpeg, que convierte los audios, y la imagen de Whisper, unos 505 MB). Después:

- `docker compose ps` tiene que mostrar los tres (`waha`, `whisper` y `bot`) en `Up`, y `whisper` con `healthy`.
- Abrí `http://127.0.0.1:8080/health`: tiene que mostrar `"ok":true`.
- En el grupo de Telegram tiene que aparecer **"Bot prendido…"** y enseguida el aviso de que **WhatsApp necesita vincular el número (QR)**.

### Vincular el número de prueba (el QR)

Hay dos formas, las dos sirven:

- **Desde Telegram:** escribí `/qr` en el grupo. El bot manda la imagen del QR.
- **Desde el panel de WAHA:** abrí `http://127.0.0.1:3000`. Te pide usuario `admin` y la clave que pusiste en `WAHA_API_KEY`. Entrá a la sesión `default` y ahí está el QR.

En el celular de prueba: WhatsApp, Ajustes, **Dispositivos vinculados**, **Vincular un dispositivo**, y escaneás el QR. El QR dura poco: si vence, pedí otro con `/qr`.

Cuando vincula, `/estado` en Telegram tiene que decir **WhatsApp: WORKING**.

### Probar que anda

1. Desde **otro celular**, escribile al número de prueba: "Hola, quiero una cancha".
2. A los pocos segundos tiene que aparecer en Telegram un **Borrador** con lo que el bot contestaría.
3. Tocá **[Mandar]**: el mensaje le llega al otro celular.

Con `BOT_LLM=fake` la respuesta va a ser siempre la misma, y está bien: lo que se prueba es la conexión.

## 2. Día a día

| Quiero | Hago |
|---|---|
| Que el bot deje de contestar y de mandar, pero que siga prendido | `/apagar` en Telegram. Para volver, `/prender`. |
| Apagar todo (bot, WAHA y Whisper) | `docker compose stop` |
| Volver a prender todo | `docker compose up -d` |
| Reiniciar | `docker compose restart` |
| Ver qué está haciendo el bot | `docker compose logs -f bot` (se corta con Ctrl+C) |
| Ver cómo está todo | `/estado` en Telegram |
| Ver si Whisper anda | `docker compose ps`: `whisper` tiene que decir `healthy`. Si no, `docker compose logs whisper` (ver el punto 9). |
| Saber por qué el bot no prende | `docker compose logs bot`: si falta algo del `.env`, dice cuál (por ejemplo "Falta WAHA_API_KEY"). |

Los contenedores se reinician solos si Docker se reinicia. Para que el bot arranque con la notebook: en Docker Desktop, Settings, General, tildá **Start Docker Desktop when you sign in**. Y en Windows, en la configuración de energía, poné que **enchufada nunca se suspenda** (los nombres exactos cambian según la versión).

## 3. Telegram: qué hace cada botón y cada comando

**`n` es el número corto de la conversación** (el `#3` que aparece en cada ficha). Nunca el teléfono.

### Botones de la ficha (cuando el bot te pasa un cliente)

| Botón | Qué hace |
|---|---|
| **Lo tomo** | El chat pasa a vos. El bot deja de contestarle y se cancela lo que tenía pendiente. |
| **Devolver al bot** | El bot vuelve a atender ese chat (y el chat sale de su etapa del CRM). Si el cliente dejó algo sin contestar, lo retoma enseguida. |
| **Presupuesto mandado** | Anota la hora en que mandaste el presupuesto y pasa el chat a **Presupuestados** en el CRM. Tocarlo dos veces no cambia la hora; si el chat había vuelto a A presupuestar o al bot, cuenta como presupuesto nuevo. Si el chat todavía estaba con el bot, lo toma el equipo. |

### Botones del borrador (modo sombra)

| Botón | Qué hace |
|---|---|
| **Mandar** | Manda la respuesta al cliente. Si el cliente escribió de nuevo mientras tanto, dice **vencido** y no manda nada: mirá el borrador nuevo. |
| **Descartar** | No se manda y no se vuelve a proponer para ese mensaje del cliente. |
| **Lo tomo** | Igual que en la ficha: el chat pasa a vos y el borrador se descarta. |

### Comandos

| Comando | Qué hace |
|---|---|
| `/estado` | Cómo está WhatsApp, la cola de mensajes, lo gastado hoy y cuántos chats atiende el bot. |
| `/chat n` | Los últimos mensajes del chat `n`. |
| `/bot n` | Devuelve el chat `n` al bot. |
| `/humano n` | El chat `n` pasa a vos. |
| `/apagar` y `/prender` | Corta o retoma todo el bot. |
| `/sombra on` y `/sombra off` | Prende o apaga el modo sombra (ver el final). |
| `/set clave valor` | Cambia un ajuste (ver la tabla de abajo). Con una clave que no existe, te lista las que sí. |
| `/qr` | Manda el QR para vincular WhatsApp. |

El bot solo hace caso a lo que se escribe en **tu grupo**. Si alguien le escribe desde otro lado, no contesta ni avisa.

Si escribís un comando en el grupo y el bot no responde, en @BotFather: `/mybots`, tu bot, Bot Settings, Group Privacy, **Turn off**.

### Ajustes (`/set clave valor`)

| Clave | Por defecto | Qué es |
|---|---|---|
| `kill_switch` | 0 | 1 = apagado (lo mismo que `/apagar`). |
| `shadow_mode` | 1 | 1 = modo sombra (lo mismo que `/sombra`). |
| `daily_budget_usd` | 2 | Tope de gasto por día en dólares. Al llegar, los chats se pausan y te avisa. |
| `conv_budget_usd` | 0.25 | Tope de gasto por conversación. |
| `max_new_chats_per_day` | 30 | Cuántos chats nuevos atiende por día. |
| `reply_window_hours` | 12 | Al prender, el bot solo contesta consultas más nuevas que esto. |
| `burst_quiet_ms` y `burst_max_ms` | 2000 y 8000 | Cuánto espera para juntar mensajes seguidos del cliente antes de contestar. |
| `outbox_expiry_min` | 30 | Una respuesta que no salió en este tiempo se tira y no se manda. |
| `typing_ms_per_char` y `typing_max_ms` | 60 y 12000 | Cuánto aparece "escribiendo…" por globo: 60 ms por letra, con un mínimo de 1,5 s y un tope de 12 s, y entre 0,8 y 1,2 veces al azar. Mientras un chat "escribe", el bot atiende a los demás. |
| `read_ms_per_char` y `read_max_ms` | 40 y 15000 | Cuánto tarda en "leer" lo que escribió el cliente antes de empezar a contestar: 40 ms por letra, tope de 15 s, también con azar. Se cuenta desde su último mensaje: si el bot ya tardó más armando la respuesta, no espera de más. |
| `max_audio_seconds` | 600 | Un audio más largo que esto (en segundos) no se transcribe: el bot lo trata como un audio que no pudo escuchar (ver el punto 9). No acepta menos de 10: con un tope más bajo casi cualquier audio quedaría ilegible. |
| `bot_start_utc` | (la primera vez que arrancó) | **No lo toques.** Es lo que le dice al bot qué chats ya existían antes de él. |

El tope diario de USD 2 es un número conservador que puse yo: lo definís vos.

## 3 bis. El CRM (la pantalla de los clientes)

Es una página que sirve el mismo bot: **http://127.0.0.1:8080/crm** (solo desde tu notebook). Se ve como WhatsApp Web: los chats a la izquierda, la conversación en el medio y la ficha con los botones a la derecha. Hace lo mismo que Telegram, con las mismas reglas: lo que hacés en uno se ve en el otro.

**La primera vez:** poné una clave en el `.env` (`CRM_PASSWORD=`, 12 caracteres o más, distinta de `WAHA_API_KEY`) y reiniciá el bot con `docker compose up -d --build`. Sin clave, la página dice que el CRM está apagado.

**La lista de la izquierda:**
- **Hacer ahora** (la que abre siempre): solo los clientes que te piden algo, el que espera hace más arriba, con su reloj de espera.
  - *El bot quiere contestar*: un borrador del modo sombra esperando [Mandar].
  - *Te escribió*: un cliente que ya está con ustedes (o que el bot no está atendiendo) mandó algo y nadie le contestó. Hoy esto **no** avisa por Telegram: miralo acá. Un *Perdido* que vuelve a escribir aparece; un *Descartado*, no (se ve en su etapa).
  - *A presupuestar*: el bot te lo pasó. Si le prometió el presupuesto, muestra cuándo vence la promesa ("en el día, o a más tardar el día hábil siguiente"; día hábil = lunes a sábado; los feriados no se descuentan). En rojo, si ya venció.
- **Todos** y **Etapas**: como WhatsApp, lo último que se movió arriba.
- **Buscar** busca en todos los chats (no solo en el filtro abierto), sin importar tildes ni mayúsculas. Tocar un filtro borra la búsqueda.

**Las etapas:** Con el bot → A presupuestar → Presupuestados → Seguimiento → Cliente / Perdido. Además, *Descartado* (no era cliente o pidió la baja), *Con el equipo* (lo tomaron sin que el bot lo derivara) y *Otros chats* (contactos que ya existían antes del bot: no aparecen en "Hacer ahora"; si alguno es cliente, movelo a una etapa).
- El bot pone solo *A presupuestar* (o *Descartado*) cuando deriva. [Presupuesto mandado] pasa a *Presupuestados*. El resto lo movés vos con **Mover a…** (Perdido no se mueve sin el motivo).
- Tener etapa = el chat es del equipo y el bot no le contesta. **Devolver al bot** saca la etapa: si el chat tiene una, el CRM pregunta antes.

**Para contestarle a un cliente:** el botón **Abrir en WhatsApp** abre ese chat en el WhatsApp que tengas abierto en la notebook. Tiene que ser la línea del bot; si es otra, tu respuesta no queda registrada y el chat sigue en "Te escribió".

**Arriba:** prender/apagar el bot y el modo sombra (estos dos sí avisan al grupo de Telegram), el estado de WhatsApp y el gasto de hoy. **Salir** cierra la sesión; reiniciar el bot también.

### El presupuesto (el creador, adentro del CRM)

Es el mismo creador de presupuestos de siempre, con la misma pantalla y el mismo PDF, pero sin abrir otro programa.

- **Desde un chat:** en la ficha aparece **Armar presupuesto**, o **Ver presupuesto** si ya armaste uno para ese chat. Se abre precargado con lo que juntó el bot:
  - Cliente, teléfono y localidad.
  - El título ("PROYECTO 2 CANCHAS FULL PANORÁMICAS").
  - Las canchas con su precio. La Full Panorámica va **en oferta**: el PDF muestra la franja "OFERTA" y el precio de lista tachado.
  - La platea, si quiere que la hagamos.
  - **Instalación y Logística sin precio.** Al lado tenés la referencia interna; el número lo ponés vos.
  - Si pidió vidrio de 12 mm o un color especial, también aparecen sin precio.
  - Mientras haya un renglón sin precio, no deja exportar ni mandar. Completalo, o sacalo si no va.
- **Desde "Presupuestos"** (arriba): el creador sin chat, para armar uno a mano como antes. El historial está a la izquierda.
- **Ver PDF** muestra la hoja tal cual va a salir. **Exportar PDF** la baja a la compu.
- **Enviar por WhatsApp** (solo si el presupuesto es de un chat):
  - Pregunta antes de mandar.
  - Arma el PDF y lo manda por el mismo chat, con el texto "Te paso el presupuesto.".
  - El chat pasa a **Presupuestados**, igual que [Presupuesto mandado].
  - En el chat se ve como *Equipo · Documento*, y en la ficha dice si está **en la cola**, **salió** (con la hora) o **no salió**.
  - Con el bot apagado queda en la cola y sale cuando lo prendas. Si en 24 h no salió, se vence y te avisa: mandalo de nuevo.
  - Tocarlo dos veces no lo manda dos veces.
- Mandarlo de nuevo (por ejemplo, corregido) es otro envío. El chat no se mueve de la etapa en la que esté.
- Los PDF que se mandaron quedan en `data/presupuestos/`. Los que no salieron se borran solos a la semana.

## 4. Qué pasa si la notebook se duerme o se cierra

- **Mientras está dormida o apagada, el bot no contesta.** Los mensajes que llegan al número quedan en WhatsApp y se ven en el celular de siempre.
- **Cuando vuelve**, el bot primero **revisa qué pasó** antes de mandar nada:
  - guarda lo que llegó mientras no estaba;
  - **contesta solo las consultas de las últimas 12 horas** (el ajuste `reply_window_hours`). Si un cliente mandó varios mensajes, recibe **una sola respuesta**;
  - las consultas **más viejas** no se contestan solas: te llegan en **un aviso con la lista** (`#3 (hace 20 h)`…) para que las veas vos;
  - si vos o Tomás le escribieron a un cliente desde el celular mientras el bot no estaba, **ese chat queda en tus manos** y el bot no lo toca;
  - **no sale ninguna respuesta atrasada**: lo que estaba esperando para salir y ya venció (más de 30 minutos) se tira, y lo que el cliente superó con un mensaje nuevo se cancela.
- Si un mensaje quedó a mitad de envío cuando se apagó, el bot **no lo reenvía a ciegas**: mira el historial de WhatsApp. Si salió, lo da por mandado. Si no puede saberlo, te avisa para que lo revises en el celular.
- Si **la sesión de WhatsApp se cae** (no la notebook), el aviso te llega por Telegram **una vez**, y cuando vuelve se hace la misma revisión.
- **El celular sigue siendo el respaldo**: el bot es un "dispositivo vinculado", así que todo lo que pasa también lo ves en el WhatsApp del celular, y si contestás desde ahí el bot lo detecta y se corre de ese chat.

## 5. Copia de seguridad y restauración

Hay dos carpetas que importan, las dos adentro de `bot-ventas`:

- `data\`: la base del bot (conversaciones, cola, ajustes).
- `waha-sessions\`: la sesión de WhatsApp. Si se pierde, hay que escanear el QR de nuevo.

Más el archivo `.env` (guardalo aparte: tiene claves). Los backups van en la carpeta `backups\` (git la ignora). **Guardalos en un lugar privado.**

**Hacer una copia** (apagando antes, para que los archivos queden quietos):

```powershell
docker compose stop
$d = "backups\" + (Get-Date -Format "yyyy-MM-dd")
New-Item -ItemType Directory -Force $d | Out-Null
Copy-Item -Recurse data, waha-sessions, .env $d
docker compose up -d
```

**Restaurar** (cambiá la fecha por la copia que quieras):

```powershell
docker compose down
Remove-Item -Recurse -Force data, waha-sessions
Copy-Item -Recurse backups\2026-10-08\data, backups\2026-10-08\waha-sessions .
docker compose up -d
```

Si restaurás solo una de las dos carpetas:

- Solo `data` (sin la sesión): hay que volver a escanear el QR.
- Solo `waha-sessions` (sin la base): el bot arranca de cero y los chats que ya tenían historia entran como "en manos del equipo".

Conviene hacer una copia antes de cualquier cambio y una vez por semana.

## 6. Qué datos salen de la PC

| A dónde | Qué sale | Para qué |
|---|---|---|
| **OpenAI** | Los últimos 30 mensajes de la conversación (lo que dijo el cliente y lo que contestó el bot, con la hora), los datos que el bot fue anotando del cliente y la hora actual. **No** va el teléfono ni el nombre de perfil (si el cliente escribe su número en un mensaje, ese texto sí va). Solo con `BOT_TRANSCRIBER=openai`, además, **el audio de cada nota de voz del cliente** (ya convertido a mp3 en tu PC). Con Whisper local (lo normal) los audios no salen de la notebook. | Armar la respuesta y, con `openai`, transcribir los audios. El bot le pide a OpenAI que no guarde la conversación; igual rige la política de OpenAI. |
| **Telegram** | Las fichas (datos del cliente y sus últimos 6 mensajes), los borradores, los avisos y el nombre de perfil de WhatsApp. **Nunca el teléfono**: cada chat es un número corto. | Que vos y Tomás atiendan. Telegram guarda esos mensajes en sus servidores. |
| **healthchecks.io** | Solo el latido: un aviso vacío cada minuto. Ninguna conversación. | Saber si el bot dejó de andar. |
| **WhatsApp (Meta)** | Todo lo que se escribe, porque es el canal. | El canal. |
| **Internet al construir** | Al armar el contenedor se bajan paquetes. No sale información tuya. | Instalar. |

**Todo lo demás se queda en la notebook**: la base completa (`data\`), la sesión de WhatsApp y el `.env`. Hoy no hay un comando para borrar una conversación puntual: borrar la carpeta `data\` (con el bot apagado) borra todo.

## 7. Si llega un aviso de problema

| Aviso | Qué significa | Qué hacer |
|---|---|---|
| **WhatsApp necesita que vincules el número de nuevo (QR)** | Se perdió la vinculación. | `/qr` y escanear desde el celular. |
| **La sesión de WhatsApp falló (FAILED)** | WAHA tiene un problema. El bot **no** se reconecta solo. | `docker compose restart waha`. Si sigue, mirá `docker compose logs waha`. |
| **La sesión está detenida (STOPPED)** | Alguien la paró. | `docker compose restart waha`. |
| **No puedo hablar con WAHA hace más de 2 minutos** | WAHA o Docker no andan. | `docker compose ps` y `docker compose up -d`. |
| **WAHA rechazó la clave** | La `WAHA_API_KEY` del `.env` no coincide con la de WAHA. | Revisá el `.env` y `docker compose up -d` de nuevo. |
| **OpenAI sin saldo** (o **Anthropic sin saldo**) | No hay crédito en la cuenta de ese proveedor; el aviso dice cuál y qué variable del `.env` es (`OPENAI_API_KEY` o `ANTHROPIC_API_KEY`). También pasa si falla la transcripción de un audio con `BOT_TRANSCRIBER=openai`. El bot no contesta ni manda el mensaje de emergencia: reintenta solo y, cuando hay saldo, contesta. | Cargá saldo (conviene recarga automática con tope mensual). |
| **OpenAI (o Anthropic) rechazó la clave o el modelo** | La clave o el modelo del `.env` están mal. El aviso dice cuál proveedor y qué variables revisar (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `BOT_MODEL`, o `BOT_TRANSCRIBE_MODEL` si fue un audio con OpenAI). | Corregí el `.env` y `docker compose up -d` de nuevo. |
| **Se llegó al tope de gasto del día** (o **al tope de chats nuevos**) | Los chats se pausan y vuelven solos al bot a las 00:00 (hora de Argentina): las consultas de hace menos de `reply_window_hours` se contestan y las más viejas te llegan en un resumen. | Si querés seguir antes: `/set daily_budget_usd` con otro valor y `/bot n` para devolver los chats. |
| **WhatsApp restringió el envío (error 463/475)** | WhatsApp limita al número. El bot no insiste. | Revisá la cuenta desde el celular antes de seguir. Reiniciar no lo arregla. |
| **Un mensaje quedó con resultado incierto** | No se pudo confirmar si salió. | Mirá el chat en el celular. El bot **no lo reintenta**. |
| **El cliente mandó una foto, un video o un documento y el bot no lo lee** | El bot solo lee texto y audios. Lo otro se guarda. | Miralo vos desde el celular. |
| **Mandó un audio que no se pudo escuchar** (ficha con "el bot dejó de responder") | Es la **segunda vez** que un audio de ese cliente no se entiende; la primera **ya le llegó** el pedido de que lo escriba. El chat pasó a vos. | Escuchá el audio en el celular y contestale. Con **Devolver al bot** el bot sigue. Ver el punto 9. |
| **Un audio del cliente quedó sin leer** (aviso sin urgencia, como mucho uno por hora) | Un audio quedó ilegible por algo que no es del audio: ffmpeg falló, el transcriptor (**el transcriptor local (Whisper)** u OpenAI) no aceptó el archivo o falló varias veces seguidas, o con OpenAI la transcripción está mal configurada (clave o modelo). El aviso dice cuál. Si fue un solo audio, no es nada; si se repite, algo anda mal. | Mirá el audio en el celular. Si se repite: `docker compose exec bot ffmpeg -version` y `docker compose ps` (`whisper` tiene que decir `healthy`; si no, ver el punto 9). Con OpenAI: `BOT_TRANSCRIBE_MODEL` y `OPENAI_API_KEY` en el `.env`. |

## 8. Cómo apagar el modo sombra (solo cuando vos lo decidas)

El modo sombra es el freno de seguridad: mientras está prendido, **el bot nunca le escribe a un cliente por su cuenta**. Todo pasa por tu [Mandar].

Apagarlo es una decisión tuya. Antes conviene tener:

- probadas varias conversaciones completas con el número de prueba;
- saldo en OpenAI y el tope diario (`daily_budget_usd`) puesto como querés;
- a Tomás y a vos mirando el grupo de Telegram;
- una copia de seguridad hecha.

Para apagarlo escribí `/sombra off`: desde ese momento el bot le escribe directo a los clientes. Para volver al modo seguro, `/sombra on`. Los borradores que estaban esperando y siguen válidos se pueden mandar igual con [Mandar].

El bot **no** lo apaga solo y esta guía no lo apaga: lo hacés vos.

## 9. Audios del cliente

Cuando el cliente manda una nota de voz, el bot:

1. la baja de WAHA (WAHA baja solo los audios y los guarda un día: `WHATSAPP_FILES_LIFETIME` y las dos `..._DOWNLOAD_MEDIA_MIMETYPES` del servicio `waha` en `docker-compose.yml`);
2. la convierte con ffmpeg (viene instalado en la imagen del bot) a un mp3 chico;
3. la transcribe con Whisper en tu notebook (lo normal) o, si pasás a `BOT_TRANSCRIBER=openai`, con OpenAI (`gpt-transcribe`, o lo que pongas en `BOT_TRANSCRIBE_MODEL`);
4. le muestra al modelo `(audio) <lo que se entendió>`, y contesta como si la hubiera escuchado. Un audio y un texto seguidos se contestan con una sola respuesta.

Todo esto pasa dentro del turno: si el bot está apagado (`/apagar`), el chat está con vos o pausado, o se llegó al tope de gasto, **no se baja ni se transcribe nada**. El audio queda guardado y se lee cuando el chat vuelve al bot.

### Whisper en tu notebook (el transcriptor por defecto)

Los audios se escuchan **en tu notebook**, con Whisper (modelo `small`, en español), adentro del contenedor `whisper`. No cuesta nada, no necesita internet ni claves, y el audio no sale de la PC. El bot le habla por la red interna de Docker (`http://whisper:8080`): Whisper no tiene ningún puerto abierto hacia afuera.

**Instalarlo (una sola vez):**

1. `pnpm whisper:model` baja el modelo (unos 465 MB) a la carpeta `whisper-models\`. Muestra el avance, verifica que el archivo esté completo y, si ya está, no hace nada. (Sin pnpm: `node scripts/whisper-model.ts`. Hace falta Node 24, el mismo de `pnpm verify`.)
2. `docker compose up -d`: la primera vez baja la imagen de Whisper (unos 505 MB).
3. `docker compose ps`: `whisper` tiene que decir `healthy` (tarda unos segundos en cargar el modelo).

La carpeta `whisper-models\` no va a git ni hace falta guardarla en las copias de seguridad: se vuelve a bajar con el mismo comando.

**Cuánto pesa en la notebook:**

| Qué | Cuánto |
|---|---|
| Disco | unos 2,2 GB: la imagen de Whisper (1,7 GB en Docker) y el modelo (465 MB). |
| RAM | unos 560 MB en reposo y unos 700 MB mientras transcribe (medido con `docker stats`). Sale del límite de memoria de Docker (hoy 5 GB, en `C:\Users\Lazar\.wslconfig`) y se suma a WAHA y el bot. |
| CPU | 4 hilos mientras transcribe (`WHISPER_THREADS` en el `.env` lo cambia). Atiende un audio a la vez: si llegan varios juntos, esperan en fila. |

**Cuánto tarda:** en esta notebook, con 4 hilos y otras cosas abiertas, un audio de 30 s tarda entre 10 y 15 s (con la notebook muy ocupada llegó a 20 s) y uno corto (unos 7 s), entre 4 y 8 s. Whisper trabaja de a tramos de 30 s: uno de más de un minuto tarda proporcionalmente más. Cuando el cliente manda un audio, la respuesta sale esos segundos después de lo normal.

**Si Whisper no anda** (aviso "un audio del cliente quedó sin leer (el transcriptor local (Whisper)...)", o los audios no se entienden):

1. `docker compose ps`: ¿`whisper` está `Up` y `healthy`? Si no aparece o se reinicia solo, `docker compose logs whisper`.
2. Si en los logs dice que no encuentra `ggml-small.bin`: falta el modelo. `pnpm whisper:model` y después `docker compose restart whisper`.
3. Si está `unhealthy` o recién prendió: esperá un minuto (carga el modelo al arrancar) y mirá de nuevo.
4. Si sigue mal: `docker compose restart whisper`.
5. Si Whisper está `healthy` pero **todos** los audios dicen "no aceptó el archivo": mirá que `WHISPER_URL` en el `.env` esté vacío o sea `http://whisper:8080`, y `docker compose up -d`.

Mientras Whisper no anda, el bot no se traba: reintenta cada audio (a los 30 s, 2 min y 5 min) y, si sigue sin andar, le pide al cliente que lo escriba (el pedido de texto de más abajo) y te avisa en Telegram. El audio original queda en el WhatsApp del celular.

**Pasar a OpenAI cuando haya saldo** (transcribe mejor y no usa la notebook, pero cuesta):

1. En el `.env`: `BOT_TRANSCRIBER=openai`, con `OPENAI_API_KEY` y saldo en la cuenta (y si querés otro modelo, `BOT_TRANSCRIBE_MODEL`).
2. `docker compose up -d`: vuelve a crear el bot con el valor nuevo. Nada más cambia.
3. Whisper sigue prendido, sin hacer nada, y ocupa unos 560 MB de RAM. Para liberarla: `docker compose stop whisper` (el próximo `docker compose up -d` lo vuelve a prender).

Para volver a Whisper: sacá esa línea del `.env` (o poné `BOT_TRANSCRIBER=local`) y `docker compose up -d`.

**Cuánto cuesta (con OpenAI):** USD 0,0045 por minuto de audio, redondeando hacia arriba al segundo (un audio de 30 s sale menos de medio centavo). Cuenta para el tope de gasto del día y el de la conversación, y figura en `agent_runs` con el modelo `gpt-transcribe`. Con Whisper local el costo es 0 y figura con el modelo `whisper-small`.

**Si un audio no se puede escuchar:** venció en WAHA, WAHA no lo bajó, el formato no sirve, pesa más de 16 MB, dura más de `max_audio_seconds` o la transcripción salió vacía.

| Cuándo | Qué hace el bot |
|---|---|
| **La primera vez** en esa conversación (al cliente todavía no le llegó el pedido de texto), y no hay nada más que el audio | Le manda **sin llamar al modelo** el texto fijo "Perdón, no pude escuchar bien el audio. Me lo escribís por acá?". Si es el primer mensaje del bot en esa conversación, va con el saludo y la presentación de la hora delante ("Buenas tardes, te escribimos de Olimpo Padel. Perdón, no pude escuchar..."). En modo sombra va como borrador con [Mandar]. |
| **La primera vez**, pero el cliente escribió texto además | Contesta el texto como siempre; el audio queda como "(audio que no se pudo escuchar)" y el modelo, si hace falta, le pide que lo repita por escrito. |
| **La segunda vez** (ya salió un mensaje del bot con el pedido de texto) | El chat **pasa a vos** con un aviso en Telegram: "Mandó un audio que no se pudo escuchar (ya se le había pedido que escriba)", prioridad normal. No se le manda nada más. |

"Ya se le pidió" quiere decir que **el pedido le llegó de verdad**: si se canceló porque el cliente escribió enseguida, venció o falló el envío, o quedó como borrador sin mandar, no cuenta y el próximo audio ilegible vuelve a pedir el texto en vez de pasar el chat a vos. La marca no se reinicia: del segundo audio ilegible en adelante, el chat pasa a vos aunque el cliente haya escrito texto en el medio.

El bot **nunca ignora un audio en silencio**. El texto fijo está en `policy/olimpo.yaml` (`audio_ilegible.texto`) y está aprobado por Lazar (8-oct).

**Qué hacer si un audio no se entiende:**

1. Abrí el chat en el celular: el audio original está ahí. Escuchalo y contestá vos (si el chat ya está con vos, no hace falta nada más; si no, tocá **Lo tomo**).
2. Si pasa con muchos audios seguidos, mirá `docker compose ps` (`whisper` tiene que decir `healthy`), `docker compose logs waha` y `docker compose exec bot ffmpeg -version` (tiene que mostrar la versión). Si el contenedor de WAHA se recreó (`docker compose down` y de nuevo `up`), los archivos de antes ya no están: esos audios se tratan como ilegibles (con `restart` no se pierden).
3. Si el audio dura más que el tope pero querés que se lea, subí `/set max_audio_seconds 900` (en segundos).

**Si falla la transcripción (OpenAI o Whisper):** un audio que no se puede transcribir **no traba el chat** (tampoco los textos que lleguen en el medio).

- **Con OpenAI, clave o modelo mal puestos** (`OPENAI_API_KEY` o `BOT_TRANSCRIBE_MODEL`; un 401, 403, 404 o un 400 por un parámetro): reintentar no lo arregla, así que el audio queda ilegible **en el acto** y el turno sigue (si había texto, se contesta en ese mismo turno). El aviso urgente de configuración sale igual, una sola vez, y además el aviso sin urgencia de "audio sin leer".
- **Sin saldo, sin conexión o límite de pedidos (OpenAI), o Whisper que no responde** (apagado, arrancando, trabado o que contesta un error): se reintenta solo a los 30 s, 2 min y 5 min y se avisa una vez (con el nombre del proveedor y la variable a revisar, ver el punto 7). Si **el mismo audio** falla 3 veces seguidas con espera, en el cuarto intento se rinde: queda ilegible, el turno sigue y sale el aviso sin urgencia. (La cuenta es en memoria: si el bot se reinicia, vuelve a empezar.)
- Si el cerebro también falla (es la misma cuenta de OpenAI sin saldo), el turno se reintenta como siempre, con espera: nunca sale el mensaje de emergencia por esto.
- El aviso de configuración de la transcripción es **aparte** del del cerebro: que el cerebro conteste bien no rearma el de la transcripción, y una transcripción que anda sí lo rearma.

**Temporales:** la conversión usa archivos `olimpo-audio-*` en la carpeta temporal del sistema y los borra siempre. Si el bot murió justo en medio de una conversión, al volver a arrancar se borran los que tengan más de 10 minutos.

**Todavía sin probar con el servicio real:** un audio de WhatsApp de verdad contra Whisper (se probó de punta a punta con una nota de voz generada con la voz de Windows, no con la de un cliente, y los acentos y el ruido de la calle pueden hacerlo errar más), contra `gpt-transcribe` (falta saldo de OpenAI) y la forma exacta de `payload.media` que manda WEBJS (falta el número de prueba). Está anotado en `docs/waha-endpoints.md`.

## Ronda de arreglos 8-oct (audios)

Lo que cambió respecto de lo anterior de esta guía:

- **"Ya se le pidió texto" se mide sobre lo que le llegó al cliente:** hay un mensaje del bot con el texto aprobado. Ya no hay una marca en la conversación que se ponga al armar la respuesta.
- **Un audio que no se puede transcribir no traba el chat:** error de configuración, ilegible en el acto; error pasajero, 3 reintentos y al cuarto fallo seguido del mismo audio, ilegible.
- **Aviso sin urgencia** (como mucho uno por hora) cuando un audio queda ilegible por ffmpeg, rechazo de OpenAI, configuración o porque OpenAI no responde. No avisa si venció, no trae archivo, es muy largo o la transcripción salió vacía.
- **Avisos de configuración separados:** el del cerebro y el de la transcripción se rearman por separado.
- **Los topes se miran antes de cada audio** de una ráfaga: si se pasa el del día o el de la conversación, deja de transcribir y pausa el chat con el aviso de siempre.
- **"No me escribas más" dicho por audio corta** también cuando el audio es solo "baja" o llega justo al límite de largo.
- **El primer pedido de texto va con saludo** si es el primer mensaje del bot.
- `/set max_audio_seconds` no acepta menos de 10. Al arrancar se borran los temporales `olimpo-audio-*` de más de 10 minutos.
