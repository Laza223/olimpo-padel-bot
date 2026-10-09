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

## Transcriptor local (whisper.cpp), 9-oct

El dueño no tiene saldo de OpenAI y aprobó instalar Whisper en la notebook hasta tenerlo. Esto manda sobre lo de arriba donde contradiga (transcripción, costo y avisos). Todo lo demás (descarga, conversión con ffmpeg, ilegibles, reintentos, topes) queda igual.

### Decisiones

- **Selección:** `BOT_TRANSCRIBER=local|openai`, por defecto `local`. Con `BOT_LLM=fake` sigue el transcriptor falso. Un valor raro corta el arranque ("BOT_TRANSCRIBER tiene que ser local u openai"), también con el falso, y antes de abrir la base. Con `openai` todo funciona como antes (`BOT_TRANSCRIBE_MODEL`, `OPENAI_API_KEY`). Con `local` no hace falta ninguna clave de OpenAI para los audios.
- **El server:** `whisper-server` de la imagen oficial `ghcr.io/ggml-org/whisper.cpp`.
  - Esa imagen no publica tags de versión (solo `main` y `main-<commit>`): se fija `main-d1be6fde11ac6e0407606b4e42fe72d34add8037`, el commit del release v1.9.5.
  - Trae `whisper-server`, `whisper-cli`, ffmpeg y curl. Pesa 1,69 GB en disco (505 MB de bajada).
  - Su entrypoint es `bash -c`: el compose lo reemplaza por `whisper-server` y pasa los argumentos sueltos.
- **Servicio `whisper` en `docker-compose.yml`:**
  - modelo `ggml-small.bin` montado de solo lectura desde `./whisper-models`;
  - `-l es`, `-t ${WHISPER_THREADS:-4}`, puerto 8080;
  - `restart: unless-stopped`;
  - healthcheck con `GET /health` (503 mientras carga el modelo, 200 listo);
  - **sin puertos publicados** (el servidor de whisper.cpp acepta `POST /load`, que cambia el modelo, y no tiene clave). El bot lo llama por `http://whisper:8080` (`WHISPER_URL`).
  - El bot no depende de él (`depends_on`): con `BOT_TRANSCRIBER=openai` no lo necesita, y si Whisper cae el bot sigue contestando.
- **El pedido (`LocalWhisperTranscriber` en `src/audio.ts`):**
  - `POST {WHISPER_URL}/inference`, multipart: `file` (el mp3 de `convertAudio`, tal cual: el server lo lee sin `--convert`), `temperature=0`, `temperature_inc=0`, `response_format=json`, `language=es` y `prompt`.
  - `temperature_inc=0` evita que whisper.cpp reintente con temperaturas más altas: mismo audio, mismo texto, y demora acotada.
  - El prompt es el vocabulario de siempre más "Pilar" y "Córdoba". Sin él, el modelo `small` escribía "pade el techada" y "galpón empilar".
  - Timeout de 120 s. Costo 0. En `agent_runs` queda el modelo `whisper-small`.
- **La respuesta:** `{"text": "..."}`. Si todo el texto son marcas de "no hay voz" (`[MÚSICA]`, `[BLANK_AUDIO]`, `(aplausos)`: es lo que escribe con silencio o ruido), se devuelve vacío, y el worker lo deja ilegible como cualquier transcripción vacía.
- **Errores:**
  - Conexión rechazada, timeout, 5xx, o un 200 que no es el JSON del server: `TransientLlmError('network')`. Entra en la lógica de siempre: reintentos con espera y, al 4.º fallo seguido del mismo audio, ilegible (causa `no_responde`).
  - Un 4xx: `MediaUnreadableError` con causa `rechazo` (el server no aceptó ese audio). Un 404 o 401 por tener mal `WHISPER_URL` cae acá también: todos los audios quedan ilegibles y el aviso dice "no aceptó el archivo".
  - Texto vacío: ilegible.
  - Ningún error copia el cuerpo de la respuesta (puede traer texto del cliente).
- **Avisos al equipo:** `Transcriber.local` marca al transcriptor de la notebook, y los avisos del worker dicen "el transcriptor local (Whisper)" en lugar de "OpenAI" (ilegibles por rechazo o por falla repetida, y el motivo de espera). Con OpenAI los textos son los de antes.
- **`pnpm whisper:model`** (`scripts/whisper-model.ts`): baja `ggml-small.bin` de `huggingface.co/ggerganov/whisper.cpp` a `whisper-models/` (en `.gitignore`) con `fetch`, mostrando el avance. Verifica tamaño y SHA-256 (el mismo que publica Hugging Face) y no baja nada si ya está completo.

### Spike (notebook de Lazar: Ryzen 7 5825U, 15,4 GB de RAM; Docker con 6 CPU y 5 GB; 4 hilos; enchufada)

La muestra son dos notas de voz en español hechas con la voz "Microsoft Sabina Desktop" (es-MX) de Windows, pasadas a OGG/Opus mono 16 kHz y de ahí al mp3 que deja `convertAudio`: una de 6,6 s y una de 29,1 s con palabras del negocio. Los tiempos son la parte de Whisper (el pedido HTTP completo). La notebook estaba ocupada con otras cosas (entre 4 % y 100 % de CPU en el host), así que hay dispersión: se ponen todas las corridas.

| | `ggml-small.bin` (487,6 MB) | `ggml-large-v3-turbo-q5_0.bin` (574,0 MB) |
|---|---|---|
| Carga del modelo al arrancar el server | 3,7 a 7,5 s | 11,1 s |
| Primer pedido después de arrancar (6,6 s) | 3,9 a 5,2 s | 33,7 s |
| Audio corto (6,6 s) | 4,4 a 7,7 s | 23,2 a 30,1 s |
| Audio de 29 s, sin prompt | 9,0 a 16,6 s | 24,8 a 30,9 s |
| Audio de 29 s, con prompt | 13,4 a 19,7 s (14,6 / 13,8 / 14,8 con 6 hilos; 12,5 s en la prueba real final) | 28,1 a 30,7 s |
| RAM del contenedor (`docker stats`) | 560 MiB en reposo, 630 a 690 durante, pico 695 | 613 MiB en reposo, 755 a 781 durante, pico 786 |
| Palabras del negocio, sin prompt | falla "pádel" (corto: "pade el Techada") y "en Pilar" ("empilar") | sin errores |
| Palabras del negocio, con prompt | sin errores | sin errores |

- **Elegido: `ggml-small.bin` con el prompt.** El turbo transcribe un poco mejor sin ayuda, pero tarda 25 a 31 s para 30 s de audio: no llega a los 15 s pedidos. `small` con el vocabulario no se equivoca en ninguna palabra del negocio y está en el borde de los 15 s: 13 a 15 s en las corridas con la notebook más libre y hasta 20 s con el host al 100 %. El cómputo puro (whisper-cli, sin carga del modelo): encode 3,5 a 4,2 s + decode 5,0 s ≈ 9 a 10 s.
- `small` escribe "20 x 10" donde el cliente dijo "20 por 10" (el turbo escribe "20 por 10"); para el modelo del bot es lo mismo. También cambia alguna palabra común ("Querías" por "Quería", "Quedó atento" por "Quedo atento"): no es del vocabulario del negocio y se entiende igual.
- Silencio o un tono: `[MÚSICA]` (con o sin prompt). No repite el prompt.

### Pruebas

- `test/f2b-whisper.test.ts`, con fetch falso: el pedido (URL, campos, prompt, timeout de 120 s), el mapeo de errores, el texto vacío y las marcas sin voz, la selección por env (`createAudio` y `createApp`) y los avisos del worker nombrando al transcriptor local.
- `test/f2b-whisper-e2e.test.ts`, **real y de punta a punta**: `test/fixtures/voz-cliente.ogg` (29 s, OGG/Opus) → `convertAudio` (ffmpeg real) → `LocalWhisperTranscriber` → texto con galpón, Pilar, pádel, techada, Full Panorámica, Panorámica, platea, aire libre, Córdoba y "20 por 10"; y un silencio que vuelve vacío. Se saltea si Whisper no está levantado o falta ffmpeg. Como el compose no publica puertos, para correrla se levanta una copia que sí publica uno, solo en 127.0.0.1: `docker compose run -d --rm --name whisper-e2e -p 127.0.0.1:18080:8080 whisper` (y después `docker rm -f whisper-e2e`). Otra dirección: `WHISPER_E2E_URL`.
- El test de `createAudio` de `f2b-audio.test.ts` ahora pide `BOT_TRANSCRIBER=openai` para probar OpenAI (el valor por defecto cambió).

### Pendiente

- Probar con una nota de voz real de WhatsApp (acento, ruido, audio largo): la muestra es voz sintética limpia. Mismo pendiente que con OpenAI.
- Si el audio es de más de un minuto o llegan varios juntos, el tiempo crece: Whisper atiende de a uno y procesa por tramos de 30 s.
