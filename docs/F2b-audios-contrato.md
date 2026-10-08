# F2b — Contrato: audios del cliente

Escrito por el orquestador el 8-oct-2026. Concreta la línea "Audios" del plan (gpt-transcribe + ffmpeg) y el punto 5 del detalle técnico. La guía `docs/guia-waha-local.md` manda sobre todo. Fotos, videos y documentos siguen como en F2: se guardan y se avisa al equipo.

## Datos verificados (8-oct)

- **WAHA (docs oficiales, "Receive messages" y "Configuration"):**
  - El webhook `message` trae `hasMedia` y `payload.media = { url, mimetype, filename, error }`.
  - `url` es `null` si WAHA no bajó el archivo, y `error` viene cargado si falló la bajada.
  - El archivo se baja con `GET /api/files/...` y header `X-Api-Key`.
  - WAHA borra los archivos a los `WHATSAPP_FILES_LIFETIME` segundos (default 180).
  - `WAHA_EVENTS_DOWNLOAD_MEDIA_MIMETYPES` y `WAHA_API_DOWNLOAD_MEDIA_MIMETYPES` filtran qué se baja; por defecto se baja todo.
  - **SIN VERIFICAR con un número real** la forma exacta en WEBJS: marcarlo así en `docs/waha-endpoints.md`.
- **OpenAI:**
  - El SDK 7.28 tiene `audio.transcriptions.create` con el modelo `'gpt-transcribe'`.
  - Precio del plan, verificado el 7-oct: USD 0,0045 por minuto. Según el plan, gpt-transcribe no lista OGG; el SDK dice que el formato depende del modelo. Por eso **siempre se convierte con ffmpeg**.
  - **SIN PROBAR contra la API real:** no hay saldo de OpenAI. Es la verificación 1 del plan y queda pendiente.

## Decisiones (cerradas)

- **Dónde se transcribe:** en el worker, dentro del turno. No se hace en el ingest. Así hereda gratis:
  - kill switch, modo `auto`, estados terminales y topes de gasto. Un chat pausado o en humano hace **0 llamadas**;
  - el semáforo de 4 llamadas;
  - el reintento con espera de `TransientLlmError` (red, límite, sin saldo, clave). **Nunca** sale el mensaje seguro por un error pasajero. (Ronda 8-oct: la transcripción de un audio que no se puede hacer ya no traba el chat, ver abajo.)
- **Cuándo se baja el archivo:** también en el worker, justo antes de transcribir. Para que el archivo siga vivo durante las esperas y los reintentos, en `docker-compose.yml` (servicio WAHA):
  - `WHATSAPP_FILES_LIFETIME: "86400"` (un día; `reply_window_hours` es 12);
  - `WAHA_EVENTS_DOWNLOAD_MEDIA_MIMETYPES: audio` y `WAHA_API_DOWNLOAD_MEDIA_MIMETYPES: audio`. Solo se bajan audios: ni fotos ni videos llenan el disco.
- **Seguridad de la bajada (SSRF):**
  - Del `media.url` se toma solo el *pathname*. Tiene que empezar con `/api/files/` y no tener `..`.
  - Se pide a la `WAHA_URL` configurada, con `X-Api-Key`.
  - Timeout de 30 s; se corta si pasa de 16 MB (contando bytes mientras baja).
  - `mimetype` tiene que empezar con `audio/`.
  - Nunca se baja un host que venga en el payload.
- **Conversión:**
  - `ffmpeg` con `execFile` (sin shell), entrada y salida en `os.tmpdir()` con nombre al azar, timeout de 60 s. Los temporales se borran en `finally`.
  - Salida: mp3 mono, 16 kHz, 32 kbps.
  - La duración se mide con `ffprobe`. Más de `max_audio_seconds` (setting nuevo, default `600`, cambiable con `/set`) → ilegible.
  - En el Dockerfile: `apt-get install -y --no-install-recommends ffmpeg` y limpiar las listas de apt.
- **Transcripción:**
  - `language: 'es'`.
  - `prompt` con vocabulario: Olimpo Padel, pádel, Full Panorámica, Panorámica, platea, galpón, techada, aire libre, césped, vidrio templado.
  - Modelo con `BOT_TRANSCRIBE_MODEL` (default `gpt-transcribe`). Va a OpenAI aunque el cerebro sea `claude-*`.
  - Errores: se mapean con el mismo clasificador de `src/brain.ts` a `TransientLlmError`.
  - Costo: USD 0,0045 por minuto, con la duración redondeada hacia arriba al segundo. Va a `agent_runs` (modelo `gpt-transcribe`) y a `addSpend`, así cuenta para los topes del día y de la conversación.
  - Con `BOT_LLM=fake`, un transcriptor falso determinista ("(prueba) quiero una cancha en Pilar"), para el humo sin saldo.
- **Lo que ve el modelo:** el texto del mensaje queda como `(audio) <transcripción>`.
  - Con eso andan solas las reglas que leen el texto del cliente: Elite, "no me escribas más", desconfianza, factura A y evidencia de la ficha.
  - En el prompt de `src/brain.ts` va una sola línea: "(audio)" es un audio del cliente pasado a texto automáticamente y puede tener errores. Se contesta como si se hubiera escuchado, sin decir que se transcribió ni citarlo literal. Si algo no se entiende, se pregunta eso puntual.
- **Audio ilegible:** sin url, con `media.error`, bajada vencida (404), formato o ffmpeg que falla, demasiado largo o transcripción vacía.
  - **Primera vez en la conversación** (al cliente todavía no le llegó el pedido de texto, ver abajo):
    - si todo lo pendiente son audios ilegibles, el worker manda **sin llamar al modelo** el texto aprobado `policy.audio_ilegible.texto`: "Perdón, no pude escuchar bien el audio. Me lo escribís por acá?". En modo sombra va como borrador;
    - si es el primer mensaje del bot en la conversación, va con el saludo y la presentación aprobados de la hora delante, en el mismo globo ("Buenas tardes, te escribimos de Olimpo Padel. Perdón, no pude…");
    - si hay texto además, corre el turno normal y el audio aparece como `(audio que no se pudo escuchar)`.
  - **Segunda vez** (ya salió un mensaje del bot con el texto aprobado): derivación `audio_ilegible`, prioridad normal y modo stop: el chat pasa al equipo con aviso.
  - Nunca se ignora en silencio.
- **Base (migración V3, idempotente):**
  - `messages`: `media_url TEXT` (solo el path), `media_mime TEXT` y `transcript_status TEXT` (`NULL | 'pendiente' | 'ok' | 'ilegible'`).
  - (Ronda 8-oct: la marca `conversations.audio_text_asked` se sacó de la migración; V3 no se había publicado.)
  - `unansweredMessages` e `historyFor` incluyen los audios del cliente pendientes. Un pendiente no se muestra al modelo: se transcribe antes.
  - Al transcribir, `text` pasa a `(audio) …` **sin** subir `context_version`: es el mismo mensaje.
- **Ingest:**
  - Un audio del cliente sin texto se guarda con `media_url`, `media_mime` y `transcript_status='pendiente'`, sube la versión de contexto (es contenido nuevo) y, si el chat está en `auto`, programa la ráfaga igual que un texto. Ya no avisa "el bot todavía no lo lee".
  - Las fotos, videos y demás siguen avisando como hoy.
  - Si borra el audio antes de que se transcriba, no se transcribe.
- **Reconciliación al prender:** si un audio se recupera de la historia de WAHA y trae url, entra como pendiente. Si no trae url, entra como ilegible.
- **Avisos neutros de proveedor:**
  - Los avisos de "sin saldo" y "clave o modelo rechazados" nombran al proveedor que falló: OpenAI para el cerebro `gpt-*` y la transcripción, Anthropic para `claude-*`. También nombran la variable que hay que revisar.
  - Así, Haiku con modo sombra puede servir de puente sin avisos engañosos.
- **Cero dependencias npm nuevas.** ffmpeg es del sistema y ya estaba en el plan aprobado.

## Criterio de listo

- `pnpm verify` verde.
- Pruebas nuevas, con canal, bajada, conversor y transcriptor falsos:
  1. el audio se transcribe y el turno ve `(audio) …`;
  2. una ráfaga de audio + texto corre en un solo turno;
  3. chat en humano, pausado o con kill switch: 0 bajadas y 0 transcripciones;
  4. el 429 sin saldo en la transcripción reintenta, avisa una vez y nunca manda el mensaje seguro;
  5. ilegible la primera vez: texto aprobado sin llamar al modelo, y en modo sombra como borrador;
  6. ilegible la segunda vez: derivación stop;
  7. audio borrado antes de transcribir: no se transcribe;
  8. path de `media.url` con otro host, `..` o fuera de `/api/files/`: se rechaza;
  9. más de 16 MB o mimetype que no es audio: ilegible;
  10. el costo cuenta para el tope del día;
  11. "no me escribas más" dicho por audio corta igual que por texto;
  12. migración V3 sobre una base V2 con datos.
- Una prueba real con el ffmpeg del sistema (se saltea si no está en el PATH): genera un OGG/Opus con `lavfi`, lo convierte y mide la duración.
- Humo con Docker: la imagen se construye con ffmpeg, `ffmpeg -version` anda adentro y `/health` da 200.
- Pendiente para cuando haya saldo y número de prueba: un audio real de WhatsApp por gpt-transcribe (verificación 1 del plan) y la forma real de `payload.media` en WEBJS.

## Ronda de arreglos 8-oct

Una revisión adversarial encontró defectos; las decisiones las tomó el orquestador. Quedan así (esto manda sobre lo de arriba donde contradiga):

- **"Ya se pidió texto" = lo que le llegó al cliente.** Existe en `messages` un mensaje `author='bot'` (registrado al salir o por el eco) cuyo texto contiene `policy.audio_ilegible.texto`. Si el pedido se cancela (texto nuevo, vencimiento, falla de envío) o en modo sombra el borrador no se aprueba, no cuenta. Se sacó `setAudioAsked` y la columna `audio_text_asked`. La marca no se reinicia: la segunda vez que un audio es ilegible el chat pasa al equipo aunque haya texto, y un audio recuperado de la historia sin url sigue entrando como ilegible.
- **Un audio que no se puede transcribir no traba el chat.**
  - Error de configuración (401, 403, 404, 400 por un parámetro que no es el archivo, falta `OPENAI_API_KEY`): el audio queda ilegible en el acto (causa `config`) y el turno sigue. El aviso urgente sale igual, una vez.
  - Error pasajero (red, límite, sin saldo): se reintenta con espera como siempre. Contador en memoria por id de mensaje: al 4.º fallo seguido del mismo audio queda ilegible (causa `no_responde`) y el turno sigue; se contesta en ese 4.º intento. Un fallo que se resuelve borra el contador.
  - Si el cerebro también falla (mismo OpenAI sin saldo), el turno se reintenta como siempre.
- **Aviso no urgente a Telegram, como mucho uno por hora en total** (estado `audio_unreadable_alert_utc`), cuando un audio queda ilegible por rechazo de OpenAI (400/413/415/422), falla de ffmpeg, o las causas `config` y `no_responde`. Dice la causa en criollo y que hay que mirar los audios. No sale por vencido, sin url, demasiado largo, no es audio, más de 16 MB ni transcripción vacía.
- **El aviso de configuración de la transcripción es aparte del del cerebro:** claves distintas de "avisado una vez" (`config:OpenAI` y `config:OpenAI:audio`, lo mismo para `quota`). Un turno exitoso del cerebro no rearma el de la transcripción, y una transcripción exitosa lo rearma.
- **Los topes se revalidan antes de cada audio de la ráfaga** con el mismo `withinLimits` (gasto del día, de la conversación y chats nuevos). Si se pasa, se deja de transcribir y el chat se pausa con el aviso de siempre; los audios que quedan siguen pendientes.
- **El respaldo de baja de `src/turn.ts`** saca el prefijo `(audio) ` de cada mensaje antes de las regex y del tope de largo.
- **Saludo:** si el pedido de texto es el primer mensaje del bot, va con la primera frase del primer mensaje aprobado (`presentacion.primer_mensaje` hasta el primer punto, con el saludo de la hora). Si la política no tiene esa frase, va solo el texto. Pasa `supervise`. El turno siguiente del modelo ve `primer_mensaje_del_bot: no`.
- **`/set max_audio_seconds`** rechaza valores menores a 10.
- **Al arrancar** se borran los temporales `olimpo-audio-*` de `os.tmpdir()` con más de 10 minutos.
- **Pruebas nuevas:** `test/f2b-audio-fixes.test.ts` (un bloque por punto, incluidas las dos que faltaban: un segundo audio mientras se transcribe el primero, y `setTranscript` solo sobre pendientes).
