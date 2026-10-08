# Cómo se maneja el bot (para Lazar)

El bot vive en tu notebook, adentro de Docker. Son dos piezas que se prenden juntas:

- **El bot**: lee lo que escribe el cliente, arma la respuesta y la manda.
- **WAHA**: es el que está conectado al WhatsApp. El bot le habla a WAHA.

Todo lo que el bot quiere contarte (consultas listas para presupuesto, borradores, problemas) llega al **grupo de Telegram**. Ahí también lo controlás con botones y comandos.

Hoy arranca en **modo sombra**: el bot prepara la respuesta pero **no le escribe al cliente**. Te la deja en Telegram con un botón [Mandar]. Eso se apaga solo cuando vos lo decidas (ver el final).

## 1. La primera vez

### Qué tiene que estar listo

- Docker Desktop instalado y abierto (el ícono de la ballena, sin errores).
- Un celular con un **número de prueba** (no el de Olimpo todavía) con WhatsApp.
- La carpeta `OLIMPO PADEL\bot-ventas`. Todos los comandos de abajo se escriben en PowerShell parado en esa carpeta.

### El archivo `.env`

Copiá `.env.example` como `.env` y completá estos valores. **El `.env` tiene claves: no se manda por mail, no se sube a git, no se saca captura.**

| Variable | Qué poner | De dónde sale |
|---|---|---|
| `OPENAI_API_KEY` | La clave de OpenAI | platform.openai.com, Settings, API keys. Sin saldo cargado el bot no contesta (te avisa por Telegram). |
| `WAHA_API_KEY` | Una clave larga que inventás vos | Solo letras y números, sin símbolos. Es también la clave del panel de WAHA (usuario `admin`). |
| `WAHA_WEBHOOK_HMAC_SECRET` | Otra clave larga que inventás vos | Distinta de la anterior, también solo letras y números. Es el sello con el que WAHA firma lo que le manda al bot. |
| `TELEGRAM_BOT_TOKEN` | El token del bot de Telegram | En Telegram, hablale a **@BotFather**, mandá `/newbot` y seguí los pasos. Te da el token. |
| `TELEGRAM_GROUP_ID` | El número del grupo (empieza con `-`) | Mirá abajo. |
| `HEALTHCHECKS_PING_URL` | La dirección de latido (opcional) | healthchecks.io, mirá abajo. Si la dejás vacía, no hay latido. |
| `BOT_LLM` | `openai` para el cerebro de verdad, `fake` para probar sin gastar nada | `fake` contesta siempre lo mismo: sirve para ver que todo está conectado. |
| `WAHA_URL` y `BOT_PUBLIC_WEBHOOK_URL` | No se tocan | Son los nombres de las dos piezas adentro de Docker. |

**Para generar una clave larga** (PowerShell): `-join ((48..57)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})`. Corrélo dos veces: una para `WAHA_API_KEY` y otra para `WAHA_WEBHOOK_HMAC_SECRET`.

**El grupo de Telegram:**

1. Creá un grupo con Tomás y sumá al bot que creaste.
2. Mandá cualquier mensaje en el grupo.
3. **Antes de prender el bot**, abrí en el navegador `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` (poné tu token en lugar de `<TU_TOKEN>`). Buscá `"chat":{"id":-100...`: ese número negativo, completo y con el signo, es el `TELEGRAM_GROUP_ID`.
4. Si ya prendiste el bot, ese enlace da error porque el bot ya está leyendo los mensajes: apagalo (`docker compose stop`), mirá el número y volvé a prender.

**El latido (healthchecks.io):** creá un check nuevo con período de 1 minuto y tolerancia de 5 minutos, y poné que te avise por mail o por Telegram. Copiá la "ping URL" en `HEALTHCHECKS_PING_URL`. Si la notebook se apaga o el WhatsApp se cae, el bot deja de latir y healthchecks te avisa solo. Es la única alarma que funciona aunque la notebook esté apagada.

### Prenderlo

```powershell
docker compose up -d --build
```

La primera vez tarda unos minutos (baja e instala todo). Después:

- `docker compose ps` tiene que mostrar los dos en `Up`.
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
| Apagar todo (bot y WAHA) | `docker compose stop` |
| Volver a prender todo | `docker compose up -d` |
| Reiniciar | `docker compose restart` |
| Ver qué está haciendo el bot | `docker compose logs -f bot` (se corta con Ctrl+C) |
| Ver cómo está todo | `/estado` en Telegram |
| Saber por qué el bot no prende | `docker compose logs bot`: si falta algo del `.env`, dice cuál (por ejemplo "Falta WAHA_API_KEY"). |

Los contenedores se reinician solos si Docker se reinicia. Para que el bot arranque con la notebook: en Docker Desktop, Settings, General, tildá **Start Docker Desktop when you sign in**. Y en Windows, en la configuración de energía, poné que **enchufada nunca se suspenda** (los nombres exactos cambian según la versión).

## 3. Telegram: qué hace cada botón y cada comando

**`n` es el número corto de la conversación** (el `#3` que aparece en cada ficha). Nunca el teléfono.

### Botones de la ficha (cuando el bot te pasa un cliente)

| Botón | Qué hace |
|---|---|
| **Lo tomo** | El chat pasa a vos. El bot deja de contestarle y se cancela lo que tenía pendiente. |
| **Devolver al bot** | El bot vuelve a atender ese chat. Si el cliente dejó algo sin contestar, lo retoma enseguida. |
| **Presupuesto mandado** | Anota la hora en que mandaste el presupuesto. Después se usa para los recordatorios (la hora se guarda una sola vez). |

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
| `typing_ms` | 2500 | Cuánto tiempo aparece "escribiendo…" por mensaje. |
| `bot_start_utc` | (la primera vez que arrancó) | **No lo toques.** Es lo que le dice al bot qué chats ya existían antes de él. |

El tope diario de USD 2 es un número conservador que puse yo: lo definís vos.

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
| **OpenAI** | Los últimos 30 mensajes de la conversación (lo que dijo el cliente y lo que contestó el bot, con la hora), los datos que el bot fue anotando del cliente y la hora actual. **No** va el teléfono ni el nombre de perfil (si el cliente escribe su número en un mensaje, ese texto sí va). | Armar la respuesta. El bot le pide a OpenAI que no guarde la conversación; igual rige la política de OpenAI. |
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
| **OpenAI sin saldo** | No hay crédito. El bot no contesta ni manda el mensaje de emergencia: reintenta solo. | Cargá saldo (conviene recarga automática con tope mensual). |
| **Se llegó al tope de gasto del día** (o **al tope de chats nuevos**) | Los chats se pausan y vuelven solos al bot a las 00:00 (hora de Argentina): las consultas de hace menos de `reply_window_hours` se contestan y las más viejas te llegan en un resumen. | Si querés seguir antes: `/set daily_budget_usd` con otro valor y `/bot n` para devolver los chats. |
| **WhatsApp restringió el envío (error 463/475)** | WhatsApp limita al número. El bot no insiste. | Revisá la cuenta desde el celular antes de seguir. Reiniciar no lo arregla. |
| **Un mensaje quedó con resultado incierto** | No se pudo confirmar si salió. | Mirá el chat en el celular. El bot **no lo reintenta**. |
| **El cliente mandó un audio/foto y el bot todavía no lo lee** | Todavía no lee adjuntos. | Miralo vos desde el celular. |

## 8. Cómo apagar el modo sombra (solo cuando vos lo decidas)

El modo sombra es el freno de seguridad: mientras está prendido, **el bot nunca le escribe a un cliente por su cuenta**. Todo pasa por tu [Mandar].

Apagarlo es una decisión tuya. Antes conviene tener:

- probadas varias conversaciones completas con el número de prueba;
- saldo en OpenAI y el tope diario (`daily_budget_usd`) puesto como querés;
- a Tomás y a vos mirando el grupo de Telegram;
- una copia de seguridad hecha.

Para apagarlo escribí `/sombra off`: desde ese momento el bot le escribe directo a los clientes. Para volver al modo seguro, `/sombra on`. Los borradores que estaban esperando y siguen válidos se pueden mandar igual con [Mandar].

El bot **no** lo apaga solo y esta guía no lo apaga: lo hacés vos.
