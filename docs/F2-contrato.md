# F2 — Contrato: WhatsApp (WAHA local), base, cola, Telegram y latido. Solo texto.

Escrito por el orquestador el 7-oct-2026. Manda sobre el detalle técnico del plan donde lo concreta. La guía `docs/guia-waha-local.md` manda sobre todo.

## Decisiones de diseño (cerradas)

- **Cero dependencias nuevas.**
  - Base: `node:sqlite` (`DatabaseSync`, viene con Node 24, probado: WAL + `ON CONFLICT DO NOTHING` andan). Sin better-sqlite3.
  - HTTP: `node:http`.
  - Telegram, WAHA y healthchecks: `fetch`.
  - El aviso "ExperimentalWarning" de SQLite se silencia solo para ese aviso.
- **Un solo proceso Node** (`src/main.ts`) dentro de Docker Compose, junto a WAHA:
  - imagen fija `devlikeapro/waha:latest-2026.9.2` (motor WEBJS);
  - WAHA llama al bot por la red interna: `http://bot:8080/waha`;
  - puertos publicados solo en `127.0.0.1`: dashboard de WAHA `3000` y `/health` del bot `8080`.
- **Modo sombra prendido por defecto** (`shadow_mode=1`): el bot manda los borradores al grupo de Telegram con [Mandar] [Descartar] [Lo tomo] y no le escribe al cliente. Se apaga con `/sombra off` (F3).
- **Cerebro falso** para probar sin gastar: con `BOT_LLM=fake`, un `LlmClient` determinista devuelve un turno que pasa el controlador:
  - si es el primer mensaje del bot, el primer mensaje aprobado con el saludo de la hora;
  - si no, "Dale, anotado. En qué zona serían las canchas?".
  Con `BOT_LLM=openai` (por defecto) se usa `OpenAiLlm`.
- **Errores pasajeros de OpenAI no son "falla del bot".** Hoy `runTurn` cuenta un error de red como intento fallido y termina mandando el mensaje seguro. Cambia así:
  - `runTurn` tira `TransientLlmError` (nuevo, en `src/brain.ts`) ante red, timeout, 5xx, 429 por límite y 429 sin saldo (`insufficient_quota`). Lleva `kind: 'network' | 'rate' | 'quota'`.
  - Solo `LlmOutputError` y las violaciones del controlador cuentan como intento.
  - El worker reintenta el turno con espera: 30 s, 2 min, 5 min, 15 min y después cada 15 min.
  - Avisos a Telegram:
    - `quota` avisa urgente en el primer caso ("OpenAI sin saldo: el bot no contesta hasta que se cargue");
    - si una conversación lleva más de 10 min esperando, se avisa una vez.
  - Nunca se manda el mensaje seguro por un error pasajero.
  - `evals/simulate.ts` registra ese error como `error` de la corrida, no como falla del bot.
- **Adjuntos en F2:**
  - un mensaje con adjunto y texto se procesa con el texto;
  - sin texto, no abre turno: avisa a Telegram ("mandó un audio/foto, F2b") y se guarda;
  - F2b los transcribe.
- **Material (fotos de `policy/assets.yaml`):** se manda como imagen por WAHA después de los globos, con la leyenda de `assets.yaml` si tiene.

## Archivos (quién los escribe)

**Parte A — tubería** (implementador A):

| Archivo | Qué hace |
|---|---|
| `src/db.ts` | Esquema, migración idempotente y funciones de acceso |
| `src/channel/types.ts` | Interfaz `Channel` y `InboundEvent` |
| `src/channel/waha.ts` | Adaptador contra el Swagger real de la versión fija |
| `src/channel/fake.ts` | Canal falso para pruebas |
| `src/http.ts` | `/waha` con HMAC y `/health` |
| `src/ingest.ts` | Guarda sin duplicar y clasifica |
| `src/worker.ts` | Ráfagas, filtros, turno, versión de contexto, aplicar ficha y derivaciones |
| `src/outbox.ts` | Un solo enviador, estados, incierto → reconciliar |
| `src/settings.ts` | Valores configurables con defaults |
| `src/fakeLlm.ts` | Cerebro falso |
| `test/f2-*.test.ts` | Pruebas de la parte A |

**Parte B — operación** (implementador B, después de A):

| Archivo | Qué hace |
|---|---|
| `src/notify/telegram.ts` | Long polling, fichas, botones, comandos, avisos y borradores del modo sombra |
| `src/heartbeat.ts` | Latido a healthchecks |
| `src/session.ts` | Estado de WAHA, 463/475 y QR |
| `src/startup.ts` | Reconciliación al prender |
| `src/main.ts` | Arma todo y maneja el SIGTERM |
| `Dockerfile` y `docker-compose.yml` | Contenedores |
| `docs/operacion.md` | Vincular el QR, prender y apagar, copia de seguridad y restauración, comandos de Telegram, qué datos salen de la PC |
| `.env.example` | Variables de entorno |

**No se tocan:** `policy/`, `src/supervisor/`, `src/lead.ts`, `src/handoff.ts` y el prompt de `src/brain.ts`, salvo `TransientLlmError` y el cambio de `runTurn` descripto arriba.

## Canal

```ts
export type MediaKind = 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'other';
export type InboundEvent =
  | { kind: 'message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; media?: MediaKind; profileName?: string }
  | { kind: 'own_message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; source: 'api' | 'app' | 'unknown' } // fromMe
  | { kind: 'edit'; session: string; chatId: string; providerMsgId: string; text: string }
  | { kind: 'revoke'; session: string; chatId: string; providerMsgId: string }
  | { kind: 'ack'; providerMsgId: string; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' }
  | { kind: 'session_status'; session: string; status: string }
  | { kind: 'ignored'; reason: string }; // grupos, estados, canales, difusiones, sistema, historial

export class ChannelError extends Error {
  constructor(public type: 'uncertain' | 'restricted' | 'transient' | 'auth', public code?: number, message?: string) { super(message ?? type); }
}

export interface Channel {
  parseEvent(raw: unknown): InboundEvent; // nunca tira: lo que no entiende es 'ignored'
  sendText(chatId: string, text: string): Promise<{ providerMsgId: string }>;
  sendImage(chatId: string, filePath: string, caption?: string): Promise<{ providerMsgId: string }>;
  markSeen(chatId: string, providerMsgIds: string[]): Promise<void>; // si falla, no afecta la respuesta
  typing(chatId: string, on: boolean): Promise<void>; // ídem; siempre se apaga en un finally
  sessionStatus(): Promise<string>; // WORKING | SCAN_QR_CODE | STARTING | FAILED | STOPPED
  messagesSince(chatId: string, sinceUtcMs: number, limit: number): Promise<{ providerMsgId: string; fromMe: boolean; tsUtcMs: number; text: string }[]>;
  chatsActiveSince(sinceUtcMs: number): Promise<string[]>; // para reconciliar al prender
}
```

- **Solo chats 1 a 1** (`@c.us` y `@lid`). El `chatId` se guarda y se responde tal cual. Nunca se reconstruye un teléfono desde un `@lid`.
- **Timestamps:** WAHA mezcla segundos y milisegundos. Se normalizan a ms UTC con una regla explícita: si el valor es menor que 1e12, son segundos.
- **Swagger:** el implementador A levanta el contenedor fijo y lee el Swagger antes de escribir `waha.ts`: `GET /api-json` o el que corresponda, con `X-Api-Key`. Anota en `docs/waha-endpoints.md` los endpoints, los cuerpos y la forma de los webhooks que usa. Los nombres propios de arriba no son endpoints.
- **Webhook de la sesión:** eventos `message.any`, `message.ack`, `message.revoked`, `message.edited` y `session.status`, con HMAC (clave `WAHA_WEBHOOK_HMAC_SECRET`). Se reutiliza la idea de `AXXEN\axxen-crm\src\whatsapp\waha\hmac.ts` y `normalize.ts`, sin zod.

## Base (SQLite, archivo `data/bot.sqlite`, WAL, busy_timeout 5000)

| Tabla | Claves y columnas mínimas |
|---|---|
| `conversations` | `chat_id` PK, `session`, `mode` (`auto`/`humano`/`pausado`/`cerrado`), `context_version` int, `card_json` (LeadCard), `last_activity_utc`, `first_seen_utc`, `profile_name`, `bot_spent_usd` |
| `messages` | `(session, provider_msg_id)` UNIQUE, `chat_id`, `author` (`customer`/`bot`/`team`/`system`), `text`, `ts_utc`, `media`, `edited`, `revoked`. El id que ve el modelo es `m<rowid>` |
| `inbound_events` | `event_key` UNIQUE (id del evento o hash del cuerpo), `payload`, `status` (`nuevo`/`hecho`/`error`), `attempts`, `locked_until` |
| `outbox` | `logical_key` UNIQUE (`chat:versión:índice`), `chat_id`, `kind` (`text`/`image`), `body`, `status` (`pendiente`/`en_proceso`/`aceptado`/`incierto`/`fallido`/`cancelado`/`vencido`), `attempt`, `expires_utc`, `provider_msg_id`, `cause`, `context_version` |
| `drafts` | Modo sombra: `id`, `chat_id`, `context_version`, `bubbles_json`, `material_json`, `status` (`pendiente`/`mandado`/`descartado`/`vencido`), `tg_message_id` |
| `agent_runs` | `chat_id`, `ts_utc`, `model`, `effort`, `policy_hash`, tokens, `cost_usd`, `latency_ms`, `violations_json`, `used_fallback`, `error_kind` |
| `audit` | `ts_utc`, `chat_id`, `kind` (`takeover`/`handoff`/`alert`/`error`/`command`), `detail`. Reemplaza `takeovers` y `errors` |
| `settings` | `key` PK, `value` |

## Settings (defaults; se cambian con `/set` en Telegram o por SQL)

| Clave | Default | Nota |
|---|---|---|
| `kill_switch` | 0 | |
| `shadow_mode` | 1 | |
| `burst_quiet_ms` | 2000 | |
| `burst_max_ms` | 8000 | |
| `reply_window_hours` | 12 | Al prender, se contestan solo las consultas más nuevas que esto |
| `daily_budget_usd` | 2 | **REQUIERE INPUT de Lazar:** es un default conservador |
| `conv_budget_usd` | 0.25 | |
| `max_new_chats_per_day` | 30 | |
| `bot_start_utc` | Se fija en el primer arranque | Los chats con historia anterior arrancan en `humano` |
| `outbox_expiry_min` | 30 | |
| `typing_ms_per_char` | 60 | "Escribiendo…" por letra de cada globo (piso 1,5 s), ±20 % al azar |
| `typing_max_ms` | 12000 | Tope del "escribiendo…" de un globo |
| `read_ms_per_char` | 40 | Lectura por letra de lo que escribió el cliente, ±20 % al azar |
| `read_max_ms` | 15000 | Tope de la lectura |

## Recepción → respuesta (parte A)

1. `/waha`:
   - Verifica el HMAC con comparación constante y valida que sea JSON.
   - `INSERT … ON CONFLICT DO NOTHING` en `inbound_events` y responde 200 enseguida.
   - Sin HMAC válido: 401 y no guarda nada.
2. El ingest procesa los eventos pendientes, con lock recuperable, y según `kind`:
   - `message` → guarda el mensaje y sube `context_version`.
     - Si es la primera vez del chat, mira la historia previa con `messagesSince`: si hay mensajes anteriores a `bot_start_utc`, el chat arranca en `humano`.
     - Programa el turno (ráfaga).
   - `own_message`:
     - si su id está en `outbox` → es el eco: el envío queda `aceptado`;
     - si no, lo escribió el equipo (celular, Web o app) → `mode=humano`, se cancela lo pendiente del chat (outbox y borradores), se avisa una vez y se guarda con autor `team`.
   - `edit` y `revoke` → corrigen el mensaje y suben `context_version`. Nunca abren un turno solos.
   - `ack` → actualiza el outbox.
   - `session_status` → `session.ts` (parte B; en A, solo se guarda).
3. **Ráfaga:** el turno corre 2 s después del último mensaje del cliente, o a los 8 s del primero, lo que llegue antes. Un turno por chat a la vez. Concurrencia global: 4 llamadas a OpenAI.
4. **Filtros antes de gastar** (cero llamadas a OpenAI si alguno corta):
   - `kill_switch`;
   - `mode` distinto de `auto`;
   - estado terminal de la ficha;
   - sesión distinta de WORKING;
   - presupuesto del día o de la conversación agotado: pausa el chat y avisa;
   - tope de chats nuevos del día: el chat queda `pausado` con aviso.
5. **Turno:**
   - Arma el `TurnInput` desde la base, con los últimos 30 mensajes e ids `m<rowid>`.
   - Corre `runTurn` con `markSeen` y `typing` alrededor, siempre con `finally`.
   - Guarda `agent_runs`.
6. **Antes de mandar:** si `context_version` cambió, o el modo ya no es `auto`, se descarta el resultado y se reprograma el turno. Nunca se manda una respuesta vieja.
7. **Salida:**
   - Con `shadow_mode`, va a `drafts` y a Telegram.
   - Si no, cada globo y cada imagen va al outbox con `logical_key` única.
   - Se aplica la ficha. Las derivaciones van a Telegram; las de tipo `stop` dejan el chat en `humano`.
8. **Outbox:**
   - Un solo enviador. Cada globo "escribe" (`typing_ms_per_char`, `typing_max_ms`) sin frenar a los otros chats: la fila guarda `typing_until_utc` y vuelve a estar lista cuando termina. La primera fila de una respuesta espera además la lectura (`read_ms_per_char`, `read_max_ms`).
   - Timeout o 5xx después de enviar → `incierto` → reconcilia con `messagesSince`, buscando el texto exacto en los mensajes `fromMe` posteriores al intento:
     - si lo encuentra, queda `aceptado`;
     - si no, queda `fallido` con aviso para revisión manual.
     - Nunca se reintenta a ciegas.
   - 463/475 → `fallido` con causa `restricted` y aviso, sin bucle.
   - Lo vencido (`expires_utc`) no se manda.

## Telegram (parte B)

- Solo se procesan updates del `TELEGRAM_GROUP_ID`. El resto se ignora.
- Fichas: usa `buildFicha` (`src/ficha.ts`), con los botones [Lo tomo] (→ `humano`), [Devolver al bot] (→ `auto`) y [Presupuesto mandado] (guarda la hora para los recordatorios de F4).
- Avisos: derivaciones de tipo aviso, sesión, presupuesto, OpenAI sin saldo, incierto, adjuntos y arranque o apagado.
- Comandos:
  - `/apagar` y `/prender` (`kill_switch`);
  - `/sombra on|off`;
  - `/estado`: sesión, cola, gasto del día y chats en `auto`;
  - `/chat <n>`: últimos mensajes;
  - `/bot <n>` y `/humano <n>`;
  - `/set <clave> <valor>`, solo para claves conocidas.
  - `<n>` es un número corto de conversación que muestra cada ficha. Nunca el teléfono.
- Borradores del modo sombra: [Mandar] → al outbox, solo si la `context_version` no cambió; si cambió, "vencido". [Descartar]. [Lo tomo].

## Aceptación

Pruebas automáticas con el canal falso y el LLM falso, sin red. Las 15 de la guía, numeradas como en el plan:

| # | Prueba | Parte |
|---|---|---|
| 1 | Webhook duplicado → una sola respuesta | A |
| 2 | Ráfaga → un solo turno | A |
| 3 | Mensaje propio, histórico o de grupo → no dispara venta | A |
| 4 | Información nueva mientras el modelo piensa → no se manda lo viejo | A |
| 5 | Toma humana → cancela lo pendiente aunque el turno ya haya terminado | A |
| 6 | El eco del bot no se toma como toma humana | A |
| 7 | Al reiniciar no sale una ráfaga atrasada | B |
| 8 | Timeout después de un posible envío → sin duplicado | A |
| 9 | "No me escribas más" → se respeta siempre | A |
| 10 | Chat @lid → se responde al mismo chatId | A |
| 11 | FAILED, autenticación o 463/475 → avisan sin bucles | B |
| 12 | OpenAI caído, salida inválida o tope de gasto → salida controlada | A |
| 13 | Inyección → sin efecto | A |
| 14 | Precio o pago sin fuente → no se confirma (ya cubierto por el controlador) | A |
| 15 | Lo que llegó durante una caída → se recupera según `reply_window_hours` | B |

Además:
- Carga: 60 chats simulados en 10 minutos con el canal y el LLM falsos se responden todos, uno por turno, sin duplicados.
- Prueba de humo real, cuando Lazar tenga el número de prueba: QR, mensaje desde otro celular, respuesta del cerebro falso en modo sombra a Telegram, [Mandar], y que llegue.

`pnpm verify` tiene que quedar verde en cada paso.
