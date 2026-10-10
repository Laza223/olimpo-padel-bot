// El bot completo en un solo proceso: arma todo, lo prende en orden y lo apaga con SIGTERM / SIGINT.
// Corre con `node src/main.ts` (dentro de Docker: 0.0.0.0:8080, WAHA lo llama por la red interna). Las pruebas lo arman con `createApp` y piezas falsas.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanupTempAudio, createAudio } from './audio.ts';
import type { AudioDeps } from './audio.ts';
import { configFromEnv, loadEnv } from './brain.ts';
import type { Channel } from './channel/types.ts';
import { WahaChannel } from './channel/waha.ts';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { audit, listUnnotifiedDrafts, openDb, recoverOutbox } from './db.ts';
import type { Db } from './db.ts';
import { FakeLlm } from './fakeLlm.ts';
import { createHeartbeat } from './heartbeat.ts';
import type { Controls } from './actions.ts';
import { createCrm } from './crm/server.ts';
import { createHttpServer } from './http.ts';
import { createIngest } from './ingest.ts';
import { createLlm } from './llm.ts';
import { safeNotify, sendAlert } from './notify/alert.ts';
import { createConsoleNotifier, createTelegram } from './notify/telegram.ts';
import type { Notifier } from './notify/types.ts';
import { createOutbox } from './outbox.ts';
import { loadPolicy } from './policy.ts';
import { createSession } from './session.ts';
import { ensureBotStart, getFlag, getNum } from './settings.ts';
import { createRecovery } from './startup.ts';
import type { LlmClient } from './types.ts';
import { createWorker } from './worker.ts';

const SHUTDOWN_STEP_MS = 8_000; // cuánto se espera a lo que está en vuelo al apagar (Docker da 15 s: stop_grace_period)
const DRAFT_RETRY_MS = 5 * 60_000; // un borrador que no llegó a Telegram se vuelve a avisar cada tanto
const ERROR_ALERT_EVERY_MS = 10 * 60_000; // el mismo error no avisa más de una vez cada 10 min
const DEFAULT_DB = fileURLToPath(new URL('../data/bot.sqlite', import.meta.url));

export interface AppOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  fetch?: typeof fetch; // Telegram, WAHA (sesión) y healthchecks; las pruebas lo reemplazan
  channel?: Channel;
  llm?: LlmClient;
  audio?: AudioDeps; // conversor y transcriptor de audios; las pruebas los reemplazan
  db?: Db; // si viene, quien lo pasó lo cierra
  dbPath?: string;
  port?: number;
  host?: string;
  log?: (line: string) => void;
  shutdownWaitMs?: number; // cuánto espera a lo que está en vuelo al apagar (por defecto 8 s)
}

export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): unknown;
}

export interface App {
  db: Db;
  llm: LlmClient;
  session: ReturnType<typeof createSession>;
  server: Server;
  start(): Promise<void>;
  port(): number;
  shutdown(reason?: string): Promise<void>;
  reportError(e: unknown, origin: string): void;
  installProcessHandlers(proc: ProcessLike): void;
}

// Variables de entorno (docs/operacion.md). Falta algo que el bot necesita → se dice cuál, sin mostrar ningún valor.
function readConfig(env: Record<string, string | undefined>) {
  const get = (k: string) => (env[k] ?? '').trim();
  const need = (k: string) => {
    if (!get(k)) throw new Error(`Falta ${k} (va en el .env)`);
    return get(k);
  };
  const cfg = {
    wahaKey: need('WAHA_API_KEY'),
    hmacSecret: need('WAHA_WEBHOOK_HMAC_SECRET'),
    wahaUrl: get('WAHA_URL') || 'http://waha:3000',
    webhookUrl: get('BOT_PUBLIC_WEBHOOK_URL') || 'http://bot:8080/waha',
    tgToken: get('TELEGRAM_BOT_TOKEN'),
    tgGroup: get('TELEGRAM_GROUP_ID'),
    hcUrl: get('HEALTHCHECKS_PING_URL'),
    llm: (get('BOT_LLM') || 'openai').toLowerCase(), // fake = cerebro de mentira; openai = el de verdad, y el proveedor lo decide BOT_MODEL (claude-… → Anthropic, el resto → OpenAI)
  };
  if (cfg.tgToken && !cfg.tgGroup) throw new Error('Falta TELEGRAM_GROUP_ID (va en el .env): sin el grupo, Telegram no sabe a quién avisarle');
  if (cfg.llm !== 'fake' && cfg.llm !== 'openai') throw new Error('BOT_LLM tiene que ser fake u openai');
  return cfg;
}

const within = async (p: Promise<unknown>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
};

export function createApp(o: AppOptions = {}): App {
  const env = o.env ?? process.env;
  const cfg = readConfig(env);
  const clock = o.clock ?? systemClock;
  const log = o.log ?? ((line: string) => console.log(line));
  const policy = loadPolicy();
  const brain = configFromEnv(env);
  const llm = o.llm ?? (cfg.llm === 'fake' ? new FakeLlm(policy) : createLlm(brain.model, env)); // antes de abrir la base: si falta la clave, no se toca nada
  const audio = o.audio ?? createAudio(env, cfg.llm === 'fake'); // también antes de abrir la base: un BOT_TRANSCRIBER inválido no toca nada
  const ownsDb = !o.db;
  const db = o.db ?? openDb(o.dbPath ?? DEFAULT_DB);
  const bootAt = clock.now();
  const channel = o.channel ?? new WahaChannel({ baseUrl: cfg.wahaUrl, apiKey: cfg.wahaKey, fetch: o.fetch });

  // La salida (outbox) queda cerrada hasta que la reconciliación al prender termina: así no sale nada atrasado (aceptación 7).
  let outboxOpen = false;
  const kickOutbox = () => {
    if (outboxOpen) outbox.kick();
  };

  // Lo que necesitan Telegram y el CRM del resto de la tubería. Es una función: Telegram se crea antes que el worker.
  const controls = (): Controls => ({ worker, kickOutbox, session: { current: () => session.current(), qr: () => session.qr() } });
  const telegram = cfg.tgToken
    ? createTelegram({ db, clock, token: cfg.tgToken, groupId: cfg.tgGroup, assets: policy.assets, fetch: o.fetch, controls })
    : undefined;
  const notifier: Notifier = telegram ?? createConsoleNotifier(db, log);
  const alert = (text: string, urgent = false) => sendAlert(db, notifier, clock, text, { urgent });

  const outbox = createOutbox({ db, channel, notifier, clock, onExpired: (chatId) => worker.onCustomerMessage(chatId) });
  const worker = createWorker({ db, channel, llm, policy, config: brain, audio, notifier, clock, kickOutbox });
  const ingest = createIngest({ db, channel, clock, notifier, onCustomerMessage: (chatId) => worker.onCustomerMessage(chatId), onOutboxChange: kickOutbox });
  const recovery = createRecovery({ db, channel, clock, notifier, worker, onReady: () => { outboxOpen = true; outbox.kick(); } });
  const session = createSession({
    db, clock, notifier, channel, wahaUrl: cfg.wahaUrl, apiKey: cfg.wahaKey, webhookUrl: cfg.webhookUrl, hmacSecret: cfg.hmacSecret, fetch: o.fetch,
    onObserve: (status, previous) => recovery.onObserve(status, previous),
  });
  const heartbeat = createHeartbeat({ db, clock, url: cfg.hcUrl, isWorking: () => session.current() === 'WORKING', fetch: o.fetch });
  const crm = createCrm({
    db, clock, controls, notifier, assets: policy.assets, closingText: policy.closingText, password: env.CRM_PASSWORD?.trim(), wahaSecrets: { WAHA_API_KEY: cfg.wahaKey, WAHA_WEBHOOK_HMAC_SECRET: cfg.hmacSecret },
    quotePrices: policy.quotePrices, quoteHints: policy.quoteHints, quoteDir: join(dirname(o.dbPath ?? DEFAULT_DB), 'presupuestos'), chromiumPath: env.CHROMIUM_PATH?.trim() || undefined,
  });
  if (crm.disabledReason) log(`[crm] apagado: ${crm.disabledReason}`);
  const server = createHttpServer({
    db, secret: cfg.hmacSecret, clock, crm,
    // Un evento nuevo: se procesa y, si era un session.status, la sesión lo toma enseguida (sin esperar al chequeo de los 60 s).
    onStored: () => void ingest.processPending().then(() => session.syncFromEvents()),
    health: () => ({
      ok: true, session: session.current(), ready: recovery.ready(), kill_switch: getFlag(db, 'kill_switch'), shadow_mode: getFlag(db, 'shadow_mode'),
      uptime_s: Math.round((clock.now() - bootAt) / 1000),
    }),
  });

  let started = false;
  let stopping: Promise<void> | undefined;
  let draftTimer: unknown;

  // Un borrador del modo sombra que no llegó a Telegram (estaba caído) se vuelve a avisar al prender y cada 5 min, mientras siga valiendo (reply_window_hours).
  async function retryDrafts(): Promise<void> {
    if (!telegram || stopping) return;
    for (const d of listUnnotifiedDrafts(db, clock.now() - getNum(db, 'reply_window_hours') * 3_600_000)) {
      await safeNotify(db, clock, d.chatId, () => telegram.draft(d.chatId, d.id, d.bubbles, d.material));
    }
  }
  function armDraftRetry(): void {
    if (!telegram || stopping) return;
    draftTimer = clock.setTimeout(() => void retryDrafts().finally(armDraftRetry), DRAFT_RETRY_MS);
  }
  const lastReported = new Map<string, number>();

  // Un error que nadie atrapó: queda en la auditoría y avisa (no más de una vez cada 10 min por error), pero el proceso sigue: sin bucle de reinicios.
  function reportError(e: unknown, origin: string): void {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      audit(db, clock.now(), null, 'error', `${origin}: ${msg}${e instanceof Error && e.stack ? `\n${e.stack.slice(0, 600)}` : ''}`);
      const key = `${origin}:${msg.slice(0, 100)}`;
      const last = lastReported.get(key);
      if (last !== undefined && clock.now() - last < ERROR_ALERT_EVERY_MS) return;
      lastReported.set(key, clock.now());
      void alert(`Error inesperado del bot (${origin}): ${msg.slice(0, 200)}. Sigue andando; si se repite, hay que mirarlo.`, true);
    } catch {
      log(`[error] ${origin}: ${msg}`); // la base ya no responde: por lo menos queda en la consola
    }
  }

  function shutdown(reason = 'apagado'): Promise<void> {
    stopping ??= (async () => {
      server.close(); // deja de aceptar conexiones nuevas
      server.closeIdleConnections();
      await within(alert(`Me apago (${reason}). Mientras esté apagado el bot no contesta; al volver reviso lo que llegó.`), 5_000); // antes de cortar Telegram
      session.stop();
      if (draftTimer !== undefined) clock.clearTimeout(draftTimer);
      heartbeat.stop();
      telegram?.stop();
      worker.stop();
      outbox.stop();
      ingest.stop();
      await within(Promise.all([ingest.idle(), worker.idle(), outbox.idle()]), o.shutdownWaitMs ?? SHUTDOWN_STEP_MS); // lo que está en vuelo termina; lo pendiente queda para el próximo arranque
      server.closeAllConnections();
      if (session.current() === 'WORKING') recovery.markAlive(); // de acá se mira hacia atrás al volver
      if (ownsDb) db.close();
    })();
    return stopping;
  }

  return {
    db, llm, session, server,
    async start() {
      if (started) return;
      started = true;
      const now = clock.now();
      ensureBotStart(db, now);
      void cleanupTempAudio(); // temporales de conversiones que quedaron a medias si el proceso murió (olimpo-audio-* de más de 10 min)
      recoverOutbox(db, now); // lo que estaba en proceso al morir el proceso pasa a incierto: se concilia, nunca se reenvía a ciegas
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port ?? 8080, o.host ?? '0.0.0.0', () => resolve());
      });
      telegram?.start();
      void retryDrafts();
      armDraftRetry();
      await ingest.processPending(); // eventos que WAHA mandó antes de caerse el bot y quedaron guardados
      worker.rescan(); // consultas sin contestar dentro de reply_window_hours (la salida sigue cerrada)
      kickOutbox();
      void alert(`Bot prendido (cerebro: ${cfg.llm === 'fake' ? 'fake' : brain.model}, modo sombra: ${getFlag(db, 'shadow_mode') ? 'sí' : 'no'}${getFlag(db, 'kill_switch') ? ', APAGADO con /apagar' : ''}). Reviso WhatsApp y lo que llegó mientras no estaba.`);
      session.start(); // crea o ajusta la sesión de WAHA, la vigila y, apenas está WORKING, reconcilia y abre la salida
      heartbeat.start();
    },
    port: () => (server.address() as AddressInfo).port,
    shutdown,
    reportError,
    installProcessHandlers(proc) {
      let exiting = false;
      const stop = (signal: string) => {
        if (exiting) return;
        exiting = true;
        void shutdown(signal).finally(() => proc.exit(0));
      };
      proc.on('SIGTERM', () => stop('SIGTERM'));
      proc.on('SIGINT', () => stop('SIGINT'));
      proc.on('uncaughtException', (e) => reportError(e, 'uncaughtException'));
      proc.on('unhandledRejection', (e) => reportError(e, 'unhandledRejection'));
    },
  };
}

if (import.meta.main) {
  loadEnv();
  try {
    const app = createApp();
    app.installProcessHandlers(process);
    await app.start();
    console.log('[bot] andando en el puerto 8080');
  } catch (e) {
    console.error(`[bot] no pude arrancar: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
