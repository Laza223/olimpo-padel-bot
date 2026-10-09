// Worker: ráfagas por chat, filtros antes de gastar, el turno (runTurn) con versión de contexto, aplicar la ficha y las derivaciones.
// Un turno por chat a la vez; 4 llamadas a OpenAI en total. Un error pasajero de OpenAI se reintenta con espera y nunca manda el mensaje seguro.
// Los audios del cliente se transcriben acá, dentro del turno: heredan el kill switch, el modo, los topes de gasto, el semáforo y los reintentos.
import { LOCAL_WHISPER_NAME, UNREADABLE_AUDIO_TEXT, audioText, transcribeCostUsd } from './audio.ts';
import type { AudioDeps } from './audio.ts';
import { TransientLlmError } from './brain.ts';
import { MediaUnreadableError } from './channel/types.ts';
import type { Channel, UnreadableKind } from './channel/types.ts';
import type { Clock } from './clock.ts';
import {
  addSpend, advanceAnswered, audit, botSaid, chatLabel, countAdmittedSince, createDraft, draftHasVersion, getConversation, getMessage, historyFor, insertAgentRun, listConversations, listPausedForDay, markAdmitted,
  outboxHasVersion, pauseConversation, saveCard, setMode, setTranscript, spentSince, tx, unansweredMessages,
} from './db.ts';
import type { Conversation, Db, MessageRow, PauseReason } from './db.ts';
import { isClaudeModel } from './llm.ts';
import { safeNotify, sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { enqueueReply } from './outbox.ts';
import { openingText } from './policy.ts';
import type { Policy } from './policy.ts';
import { getFlag, getNum, getState, setState } from './settings.ts';
import { argentinaTimeToUtcMs } from './time.ts';
import { TERMINAL, runTurn } from './turn.ts';
import type { AttemptLog, BrainConfig, LlmClient, TurnInput, TurnResult } from './types.ts';

const RETRY_MS = [30_000, 120_000, 300_000, 900_000]; // 30 s, 2 min, 5 min, 15 min y después cada 15 min
const WAIT_ALERT_MS = 10 * 60_000; // una conversación esperando más que esto avisa una vez
const HISTORY_LIMIT = 30;
const MAX_CONCURRENT_LLM = 4;
const MAX_AUDIO_FAILURES = 3; // fallos pasajeros seguidos al transcribir un mismo audio que se reintentan; el 4.º lo da por ilegible
const UNREADABLE_ALERT_MS = 3_600_000; // aviso por audios ilegibles por causas del sistema: uno por hora, como mucho
// `who` es el transcriptor que falló (OpenAI o el local). `config` (clave o modelo mal puestos) solo lo da OpenAI.
const UNREADABLE_WHY: Record<UnreadableKind, (who: string) => string> = {
  ffmpeg: () => 'falló ffmpeg al convertirlo',
  rechazo: (who) => `${who} no aceptó el archivo`,
  config: () => 'la transcripción está mal configurada: clave o modelo de OpenAI',
  no_responde: (who) => `${who} falló varias veces seguidas al transcribirlo`,
};

export interface WorkerDeps {
  db: Db;
  channel: Channel;
  llm: LlmClient;
  policy: Policy;
  config: BrainConfig;
  audio: AudioDeps; // conversor y transcriptor de los audios del cliente
  notifier: Notifier;
  clock: Clock;
  kickOutbox: () => void; // hay respuestas nuevas para mandar
  assetsDir?: URL;
  maxConcurrentLlm?: number;
}

export interface Worker {
  onCustomerMessage(chatId: string): void; // arma (o estira) la ráfaga de ese chat
  rescan(): void; // al prender o con /prender: programa los chats con consultas sin contestar dentro de reply_window_hours
  idle(): Promise<void>; // espera los turnos en curso (las pruebas)
  stop(): void;
}

interface ChatState {
  timer?: unknown; // ráfaga armada
  burstFirstAt?: number;
  running: boolean;
  fired: boolean; // la ráfaga venció mientras corría un turno
  failures: number; // fallos seguidos de OpenAI o de la sesión: manda la espera del reintento
  retryTimer?: unknown;
  waitTimer?: unknown; // aviso de más de 10 min esperando
  waitAlerted: boolean; // y ya avisó en esta espera: una sola vez
  errorAlerted: boolean;
}

class Semaphore {
  #free: number;
  #queue: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async acquire(): Promise<() => void> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    return () => {
      const next = this.#queue.shift();
      if (next) next();
      else this.#free++;
    };
  }
}

export function createWorker(deps: WorkerDeps): Worker {
  const { db, channel, llm, policy, config, audio, notifier, clock } = deps;
  const states = new Map<string, ChatState>();
  const inflight = new Set<Promise<void>>();
  const llmSlots = new Semaphore(deps.maxConcurrentLlm ?? MAX_CONCURRENT_LLM);
  const alerted = new Set<string>(); // "sin saldo" y "clave o modelo rechazados" salen una vez por caída, por proveedor y por lado: el cerebro (quota:OpenAI) o la transcripción (config:OpenAI:audio)
  const audioFailures = new Map<number, number>(); // fallos pasajeros seguidos de la transcripción, por id de mensaje (en memoria: si el bot se reinicia, se vuelve a contar)
  let stopped = false;
  let dayTimer: unknown; // las 00:00 de Argentina: vuelven los chats pausados por un tope del día

  const state = (chatId: string): ChatState => {
    let s = states.get(chatId);
    if (!s) states.set(chatId, (s = { running: false, fired: false, failures: 0, errorAlerted: false, waitAlerted: false }));
    return s;
  };
  const alert = (text: string, opts: { urgent?: boolean; chatId?: string } = {}) => sendAlert(db, notifier, clock, text, opts);
  // Presencia y lectura nunca frenan ni tumban una respuesta.
  const safe = async (f: () => Promise<unknown>): Promise<void> => {
    try {
      await f();
    } catch {
      /* si falla, no afecta la respuesta */
    }
  };
  const notify = (chatId: string, f: () => void | Promise<void>): Promise<void> => safeNotify(db, clock, chatId, f);

  // ---------- ráfaga ----------
  function schedule(chatId: string): void {
    if (stopped) return;
    const s = state(chatId);
    if (s.retryTimer !== undefined) return; // esperando un reintento: no se salta la espera, el reintento toma todo lo pendiente
    const now = clock.now();
    s.burstFirstAt ??= now;
    const due = Math.min(now + getNum(db, 'burst_quiet_ms'), s.burstFirstAt + getNum(db, 'burst_max_ms'));
    if (s.timer !== undefined) clock.clearTimeout(s.timer);
    s.timer = clock.setTimeout(() => fire(chatId), Math.max(0, due - now));
  }

  function fire(chatId: string): void {
    if (stopped) return;
    const s = state(chatId);
    s.timer = undefined;
    s.burstFirstAt = undefined;
    if (s.running) {
      s.fired = true; // un turno por chat a la vez: al terminar se vuelve a mirar
      return;
    }
    const p = run(chatId, s);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }

  async function run(chatId: string, s: ChatState): Promise<void> {
    s.running = true;
    try {
      await attempt(chatId, s);
    } catch (e) {
      await onFailure(chatId, s, e);
    } finally {
      s.running = false;
      if (s.fired) {
        s.fired = false;
        if (s.retryTimer === undefined) fire(chatId);
      }
    }
  }

  function ensureScheduled(chatId: string, s: ChatState): void {
    if (s.timer === undefined && !s.fired && s.retryTimer === undefined) schedule(chatId);
  }

  // ---------- esperas y reintentos ----------
  function clearWait(s: ChatState): void {
    if (s.waitTimer !== undefined) clock.clearTimeout(s.waitTimer);
    s.waitTimer = undefined;
    s.failures = 0;
    s.errorAlerted = false;
    s.waitAlerted = false;
  }

  function scheduleRetry(chatId: string, s: ChatState, why: string): void {
    if (stopped) return;
    const delay = RETRY_MS[Math.min(s.failures, RETRY_MS.length - 1)];
    s.failures++;
    if (s.timer !== undefined) clock.clearTimeout(s.timer);
    s.timer = undefined;
    s.retryTimer = clock.setTimeout(() => {
      s.retryTimer = undefined;
      fire(chatId);
    }, delay);
    if (s.waitTimer === undefined && !s.waitAlerted) s.waitTimer = clock.setTimeout(() => {
      s.waitTimer = undefined;
      s.waitAlerted = true;
      void alert(`Chat ${chatLabel(db, chatId)} lleva más de 10 minutos esperando respuesta del bot (${why}). Se sigue reintentando.`, { chatId });
    }, WAIT_ALERT_MS);
  }

  // Quién falló, para nombrarlo en los avisos: la transcripción es el transcriptor local (Whisper) u OpenAI; el cerebro depende del modelo (claude-… es Anthropic).
  function provider(transcribing: boolean): { name: string; keyVar: string; modelVar: string } {
    if (transcribing) return audio.transcriber.local ? { name: LOCAL_WHISPER_NAME, keyVar: 'WHISPER_URL', modelVar: 'BOT_TRANSCRIBER' } : { name: 'OpenAI', keyVar: 'OPENAI_API_KEY', modelVar: 'BOT_TRANSCRIBE_MODEL' };
    return isClaudeModel(config.model) ? { name: 'Anthropic', keyVar: 'ANTHROPIC_API_KEY', modelVar: 'BOT_MODEL' } : { name: 'OpenAI', keyVar: 'OPENAI_API_KEY', modelVar: 'BOT_MODEL' };
  }
  // El cerebro y la transcripción avisan por separado (aunque sean el mismo proveedor): que conteste uno no rearma el aviso del otro.
  const alertKey = (kind: 'quota' | 'config', transcribing: boolean): string => `${kind}:${provider(transcribing).name}${transcribing ? ':audio' : ''}`;
  // Ese lado contestó: si vuelve a fallar, avisa de nuevo.
  const answered = (transcribing: boolean): void => void (alerted.delete(alertKey('quota', transcribing)), alerted.delete(alertKey('config', transcribing)));
  const runBase = (chatId: string) => ({ chatId, tsUtc: clock.now(), model: config.model, effort: config.effort, policyHash: policy.hash, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, violations: [], usedFallback: false });

  // Un error de OpenAI o Anthropic que no es falla del bot (red, límite, sin saldo, clave o modelo): queda en agent_runs y avisa una vez por caída (urgente si es sin saldo o configuración).
  async function noteTransient(chatId: string, e: TransientLlmError): Promise<void> {
    const who = provider(e.transcribing);
    recordRuns(chatId, e.attempts, false, 'descartado'); // intentos anteriores del turno (ya gastaron): al presupuesto
    insertAgentRun(db, { ...runBase(chatId), ...(e.transcribing ? { model: audio.transcriber.model, effort: 'n/a' } : {}), errorKind: `transient:${e.kind}` });
    if (e.kind === 'quota' && !alerted.has(alertKey('quota', e.transcribing))) {
      alerted.add(alertKey('quota', e.transcribing));
      await alert(`${who.name} sin saldo: el bot no contesta hasta que se cargue (es la cuenta de ${who.keyVar})`, { urgent: true, chatId });
    }
    if (e.kind === 'config' && !alerted.has(alertKey('config', e.transcribing))) {
      alerted.add(alertKey('config', e.transcribing));
      await alert(`${who.name} rechazó la clave o el modelo (revisá ${who.keyVar} y ${who.modelVar} en el .env): el bot no contesta hasta que se arregle`, { urgent: true, chatId });
    }
  }

  // Audios que quedan ilegibles por algo del sistema y no del audio (ffmpeg, rechazo del transcriptor, transcripción mal configurada o que no responde): aviso no urgente, uno por hora en total.
  async function alertUnreadable(chatId: string, kind: UnreadableKind): Promise<void> {
    const now = clock.now();
    if (now - Number(getState(db, 'audio_unreadable_alert_utc') ?? 0) < UNREADABLE_ALERT_MS) return;
    setState(db, 'audio_unreadable_alert_utc', String(now));
    await alert(`Chat ${chatLabel(db, chatId)}: un audio del cliente quedó sin leer (${UNREADABLE_WHY[kind](provider(true).name)}). Si se repite, hay que mirar los audios.`, { chatId });
  }

  async function onFailure(chatId: string, s: ChatState, e: unknown): Promise<void> {
    const now = clock.now();
    if (e instanceof TransientLlmError) {
      await noteTransient(chatId, e);
      const who = provider(e.transcribing);
      scheduleRetry(chatId, s, e.kind === 'config' ? `${who.name} rechazó la clave o el modelo` : `${who.name} no responde`);
      return;
    }
    const base = runBase(chatId);
    const msg = e instanceof Error ? e.message : String(e);
    audit(db, now, chatId, 'error', `turno: ${msg}`);
    insertAgentRun(db, { ...base, errorKind: 'error' });
    if (!s.errorAlerted) {
      s.errorAlerted = true;
      await alert(`Chat ${chatLabel(db, chatId)}: error inesperado al armar la respuesta (${msg.slice(0, 120)}). Se reintenta; si sigue, hay que mirarlo.`, { chatId });
    }
    scheduleRetry(chatId, s, 'error inesperado');
  }

  // ---------- filtros que cortan antes de gastar ----------
  function pause(conv: Conversation, reason: PauseReason, why: string): void {
    pauseConversation(db, conv.chatId, reason, clock.now());
    audit(db, clock.now(), conv.chatId, 'alert', `chat pausado: ${why}`);
    if (reason !== 'conv') armDayReset();
  }

  // Los topes del día se levantan solos a las 00:00 de Argentina (no hay horario de verano): un solo timer para todos los chats pausados.
  function armDayReset(): void {
    if (stopped) return;
    if (dayTimer !== undefined) clock.clearTimeout(dayTimer);
    const now = clock.now();
    dayTimer = clock.setTimeout(() => { dayTimer = undefined; void resumePaused(); }, argentinaTimeToUtcMs('00:00', now) + 24 * 3_600_000 - now);
  }

  // Vuelven al bot los chats pausados por el tope de gasto o de chats nuevos de un día anterior. Lo reciente (reply_window_hours) se contesta; lo más viejo va en un solo resumen.
  async function resumePaused(): Promise<void> {
    const now = clock.now();
    const windowH = getNum(db, 'reply_window_hours');
    const cutoff = now - windowH * 3_600_000;
    const resumed: string[] = [];
    const old: string[] = [];
    for (const c of listPausedForDay(db, argentinaTimeToUtcMs('00:00', now))) {
      setMode(db, c.chatId, 'auto');
      audit(db, now, c.chatId, 'command', `vuelve al bot: terminó el día del tope (${c.pauseReason})`);
      const pending = unansweredMessages(db, c.chatId);
      const newest = pending[pending.length - 1];
      if (!newest) resumed.push(chatLabel(db, c.chatId));
      else if (newest.tsUtcMs >= cutoff) {
        schedule(c.chatId);
        resumed.push(chatLabel(db, c.chatId));
      } else {
        advanceAnswered(db, c.chatId, newest.id); // queda atendido: no se vuelve a listar
        old.push(`${chatLabel(db, c.chatId)} (hace ${Math.max(0, Math.round((now - newest.tsUtcMs) / 3_600_000))} h)`);
      }
    }
    if (!resumed.length && !old.length) return;
    await alert([
      `Pasó la medianoche: volvieron al bot los chats que estaban pausados por el tope de gasto o de chats nuevos${resumed.length ? ` (${resumed.join(', ')})` : ''}. Las consultas de hace menos de ${windowH} h se contestan solas.`,
      ...(old.length ? [`Las de hace más de ${windowH} h no se contestan: ${old.join(', ')}. Miralas vos.`] : []),
    ].join('\n'));
  }

  // Presupuesto del día y de la conversación, y tope de chats nuevos del día. Devuelve false si cortó (el chat queda pausado, con aviso).
  async function withinLimits(conv: Conversation, now: number): Promise<boolean> {
    const dayStart = argentinaTimeToUtcMs('00:00', now);
    const label = chatLabel(db, conv.chatId);
    const spent = spentSince(db, dayStart);
    const comeBack = `Vuelven solos al bot a las 00:00 (hora de Argentina): se contestan las consultas de hace menos de ${getNum(db, 'reply_window_hours')} h y las más viejas te llegan en un resumen.`;
    if (spent >= getNum(db, 'daily_budget_usd')) {
      pause(conv, 'budget', 'tope de gasto del día');
      if (getState(db, 'daily_budget_alert_day') !== String(dayStart)) {
        setState(db, 'daily_budget_alert_day', String(dayStart));
        await alert(`Se llegó al tope de gasto del día (USD ${spent.toFixed(2)} de ${getNum(db, 'daily_budget_usd')}). Los chats quedan pausados. ${comeBack} Si subís el tope con /set daily_budget_usd, devolvelos con /bot n. Primero pausado: ${label}.`, { urgent: true, chatId: conv.chatId });
      }
      return false;
    }
    if (conv.botSpentUsd >= getNum(db, 'conv_budget_usd')) {
      pause(conv, 'conv', 'tope de gasto por conversación');
      await alert(`Chat ${label} llegó al tope de gasto por conversación (USD ${conv.botSpentUsd.toFixed(2)}). Quedó pausado: lo ves vos o lo devolvés al bot.`, { chatId: conv.chatId });
      return false;
    }
    if (conv.admittedUtc === null) {
      if (countAdmittedSince(db, dayStart) >= getNum(db, 'max_new_chats_per_day')) {
        pause(conv, 'cap', 'tope de chats nuevos del día');
        await alert(`Se llegó al tope de chats nuevos del día (${getNum(db, 'max_new_chats_per_day')}). El chat ${label} quedó pausado. ${comeBack}`, { chatId: conv.chatId });
        return false;
      }
      markAdmitted(db, conv.chatId, now);
    }
    return true;
  }

  // ---------- el turno ----------
  const botOwnsChat = (c: Conversation | undefined): c is Conversation => !!c && !getFlag(db, 'kill_switch') && c.mode === 'auto' && !TERMINAL.includes(c.card.state); // ¿sigue siendo del bot?

  async function attempt(chatId: string, s: ChatState): Promise<void> {
    let conv = getConversation(db, chatId);
    if (!botOwnsChat(conv)) return clearWait(s);
    let unanswered = unansweredMessages(db, chatId);
    if (!unanswered.length) return clearWait(s);
    const now = clock.now();
    const newest = unanswered[unanswered.length - 1];
    if (newest.tsUtcMs < now - getNum(db, 'reply_window_hours') * 3_600_000) {
      // Una respuesta vieja confunde más de lo que ayuda: se deja pasar y el equipo lo ve si el cliente vuelve a escribir.
      audit(db, now, chatId, 'error', `consulta_vencida: el último mensaje sin contestar es de hace más de ${getNum(db, 'reply_window_hours')} h`);
      advanceAnswered(db, chatId, newest.id);
      return clearWait(s);
    }
    if (outboxHasVersion(db, chatId, conv.contextVersion) || draftHasVersion(db, chatId, conv.contextVersion)) return clearWait(s); // este contexto ya tiene respuesta
    if (!(await withinLimits(conv, now))) return clearWait(s);

    let status: string;
    try {
      status = await channel.sessionStatus();
    } catch {
      status = 'SIN DATO';
    }
    if (status !== 'WORKING') return scheduleRetry(chatId, s, `WhatsApp no está conectado: ${status}`);

    // Los audios sin transcribir se leen recién acá, después de los filtros y los topes: un chat pausado, en humano o con el kill switch hace 0 bajadas y 0 transcripciones.
    if (unanswered.some((m) => m.transcriptStatus === 'pendiente')) {
      await readAudios(chatId, unanswered);
      conv = getConversation(db, chatId);
      if (!botOwnsChat(conv)) return clearWait(s); // cambió mientras tanto (toma humana, kill switch…)
      unanswered = unansweredMessages(db, chatId);
      if (!unanswered.length) return clearWait(s); // lo borró el cliente
      if (unanswered.some((m) => m.transcriptStatus === 'pendiente')) return; // llegó otro audio mientras tanto: su ráfaga ya está armada y los toma
    }

    const shadow = getFlag(db, 'shadow_mode');
    const version = conv.contextVersion;
    const answersUpto = Math.max(...unanswered.map((m) => m.id));

    // Audios que no se pudieron escuchar. Primera vez en la conversación (al cliente todavía no le llegó el pedido de texto): si no hay nada más, se manda el texto aprobado sin llamar al modelo,
    // con el saludo y la presentación de la hora delante si es el primer mensaje del bot; si hay texto además, corre el turno normal (el modelo ve "(audio que no se pudo escuchar)").
    // Segunda vez: el chat pasa al equipo. "Ya se pidió" se mide sobre lo que de verdad salió: un mensaje del bot con el texto aprobado (si el pedido se canceló o quedó en borrador, no cuenta).
    if (unanswered.some((m) => m.transcriptStatus === 'ilegible')) {
      const fixed = { material: [], card: conv.card, usedFallback: false, attempts: [] };
      if (botSaid(db, chatId, policy.audioIlegibleText)) {
        const handoffs: TurnResult['handoffs'] = [{ reason: 'audio_ilegible', priority: 'normal', mode: 'stop' }];
        return deliver(chatId, s, version, answersUpto, { ...fixed, bubbles: [], handoffs, stopBot: true }, shadow);
      }
      if (unanswered.every((m) => m.transcriptStatus === 'ilegible')) {
        if (!shadow) await safe(() => channel.markSeen(chatId, unanswered.map((m) => m.providerMsgId)));
        const opening = botSaid(db, chatId) ? undefined : openingText(policy, now);
        const bubbles = [opening ? `${opening} ${policy.audioIlegibleText}` : policy.audioIlegibleText]; // un solo globo: sale entero o no sale
        return deliver(chatId, s, version, answersUpto, { ...fixed, bubbles, handoffs: [], stopBot: false }, shadow);
      }
    }

    const history = historyFor(db, chatId, HISTORY_LIMIT);
    const shown = new Set(history.map((m) => m.id));
    const input: TurnInput = { conversationId: chatId, history, newCustomerMessageIds: unanswered.map((m) => `m${m.id}`).filter((id) => shown.has(id)), card: conv.card, nowUtcMs: now };

    // Esperar el estado de la sesión o un lugar de OpenAI puede llevar rato: antes de gastar se revalida que el turno siga valiendo.
    const stillValid = (): boolean => {
      const c = getConversation(db, chatId);
      return !!c && c.contextVersion === version && c.mode === 'auto' && !getFlag(db, 'kill_switch') && !TERMINAL.includes(c.card.state);
    };
    let result: TurnResult | undefined;
    const release = await llmSlots.acquire();
    try {
      // En modo sombra no se le muestra nada al cliente: ni visto ni "escribiendo".
      if (!shadow) {
        await safe(() => channel.markSeen(chatId, unanswered.map((m) => m.providerMsgId)));
        await safe(() => channel.typing(chatId, true));
      }
      try {
        if (stillValid()) result = await runTurn(input, { llm, policy, config });
      } finally {
        if (!shadow) await safe(() => channel.typing(chatId, false)); // siempre se apaga
      }
    } finally {
      release();
    }
    if (!result) {
      // Cambió algo mientras esperaba: no se llamó al modelo. Si el chat sigue siendo del bot, se vuelve a mirar (el mensaje nuevo ya programó su ráfaga).
      const fresh = getConversation(db, chatId);
      if (fresh && fresh.mode === 'auto' && !getFlag(db, 'kill_switch')) ensureScheduled(chatId, s);
      return clearWait(s);
    }

    answered(false); // el cerebro contestó
    await deliver(chatId, s, version, answersUpto, result, shadow);
  }

  // Antes de mandar: si el contexto cambió o el chat ya no es del bot, el resultado es viejo y se descarta.
  async function deliver(chatId: string, s: ChatState, version: number, answersUpto: number, result: TurnResult, shadow: boolean): Promise<void> {
    const fresh = getConversation(db, chatId);
    const stale = !fresh || fresh.contextVersion !== version || fresh.mode !== 'auto' || getFlag(db, 'kill_switch');
    recordRuns(chatId, result.attempts, result.usedFallback, stale ? 'descartado' : undefined);
    clearWait(s);
    if (stale) {
      if (fresh && fresh.mode === 'auto' && !getFlag(db, 'kill_switch')) ensureScheduled(chatId, s);
      return;
    }
    await apply(chatId, version, answersUpto, result, shadow);
  }

  // ---------- audios del cliente ----------
  // Baja, convierte y transcribe los audios pendientes, de a uno y con un lugar del semáforo (las llamadas a OpenAI son 4 en total).
  // Lo que no se puede leer queda ilegible; un error pasajero (OpenAI, WAHA) tira y el turno se reintenta con espera, sin mandar nunca el mensaje seguro
  // (salvo que la transcripción de ese audio falle 3 veces seguidas, o esté mal configurada: ahí queda ilegible y el turno sigue).
  async function readAudios(chatId: string, unanswered: MessageRow[]): Promise<void> {
    const release = await llmSlots.acquire();
    try {
      for (const m of unanswered) {
        if (m.transcriptStatus !== 'pendiente') continue;
        const conv = getConversation(db, chatId);
        if (!botOwnsChat(conv)) return; // cambió mientras esperaba el lugar o el audio anterior: no se gasta
        if (getMessage(db, m.id)?.revoked) continue; // lo borró antes de que se transcribiera: no se transcribe
        if (!(await withinLimits(conv, clock.now()))) return; // los audios de una ráfaga gastan: antes de cada uno se revalidan los topes (el chat queda pausado, con aviso)
        await readAudio(chatId, m);
      }
    } finally {
      release();
    }
  }

  async function readAudio(chatId: string, m: MessageRow): Promise<void> {
    const t0 = Date.now();
    try {
      if (!m.mediaUrl) throw new MediaUnreadableError('el audio no tiene archivo para bajar');
      if (!(m.mediaMime ?? '').startsWith('audio/')) throw new MediaUnreadableError('el archivo no es un audio');
      const { mp3, seconds } = await audio.convert(await channel.downloadMedia(m.mediaUrl));
      const max = getNum(db, 'max_audio_seconds');
      if (seconds > max) throw new MediaUnreadableError(`el audio dura ${Math.round(seconds)} s y el tope es ${max} s`);
      let transcript: string;
      try {
        transcript = (await audio.transcriber.transcribe(mp3)).trim();
      } catch (e) {
        if (e instanceof TransientLlmError) {
          e.transcribing = true; // el aviso nombra al proveedor de la transcripción, no al del cerebro
          if (e.kind === 'config') {
            // Clave o modelo mal puestos: reintentar no lo arregla y trabaría el chat (también sus textos). El audio queda ilegible ya y el turno sigue; el aviso urgente sale igual, una vez.
            await noteTransient(chatId, e);
            throw new MediaUnreadableError('la transcripción no está bien configurada (clave o modelo de OpenAI)', 'config');
          }
          const failures = (audioFailures.get(m.id) ?? 0) + 1;
          if (failures > MAX_AUDIO_FAILURES) {
            // El mismo audio ya falló 3 veces con espera entre una y otra: se deja de reintentar, para que no trabe el chat (sus textos también). Ilegible y el turno sigue.
            await noteTransient(chatId, e);
            throw new MediaUnreadableError(`la transcripción falló ${failures} veces seguidas`, 'no_responde');
          }
          audioFailures.set(m.id, failures);
        }
        throw e;
      }
      const costUsd = transcribeCostUsd(audio.transcriber, seconds);
      tx(db, () => {
        // Ya se pagó: cuenta para el tope del día y de la conversación, aunque la transcripción haya salido vacía.
        insertAgentRun(db, {
          chatId, tsUtc: clock.now(), model: audio.transcriber.model, effort: 'n/a', policyHash: policy.hash, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd,
          latencyMs: Date.now() - t0, violations: [], usedFallback: false,
        });
        addSpend(db, chatId, costUsd);
        if (transcript) setTranscript(db, m.id, audioText(transcript), 'ok');
        else {
          setTranscript(db, m.id, UNREADABLE_AUDIO_TEXT, 'ilegible');
          audit(db, clock.now(), chatId, 'error', 'audio ilegible: la transcripción salió vacía');
        }
      });
      audioFailures.delete(m.id);
      answered(true); // la transcripción contestó
    } catch (e) {
      if (!(e instanceof MediaUnreadableError)) throw e;
      audioFailures.delete(m.id);
      setTranscript(db, m.id, UNREADABLE_AUDIO_TEXT, 'ilegible');
      audit(db, clock.now(), chatId, 'error', `audio ilegible: ${e.message}`);
      if (e.kind) await alertUnreadable(chatId, e.kind);
    }
  }

  function recordRuns(chatId: string, attempts: AttemptLog[], usedFallback: boolean, errorKind?: string): void {
    const now = clock.now();
    tx(db, () => {
      for (const a of attempts) {
        insertAgentRun(db, {
          chatId, tsUtc: now, model: a.model, effort: a.effort, policyHash: policy.hash, inputTokens: a.inputTokens, cachedTokens: a.cachedTokens, outputTokens: a.outputTokens,
          costUsd: a.costUsd, latencyMs: a.latencyMs, violations: a.violations, usedFallback, errorKind,
          cacheWriteTokens: a.cacheWriteTokens, cacheWrite1hTokens: a.cacheWrite1hTokens, thinkingTokens: a.thinkingTokens,
        });
      }
      addSpend(db, chatId, attempts.reduce((sum, a) => sum + a.costUsd, 0));
    });
  }

  // Salida: con modo sombra va a borradores y a Telegram; si no, al outbox. Se aplica la ficha; las derivaciones van a Telegram y las de tipo stop dejan el chat en humano.
  async function apply(chatId: string, version: number, answersUpto: number, result: TurnResult, shadow: boolean): Promise<void> {
    const now = clock.now();
    let draftId: number | undefined;
    tx(db, () => {
      if (result.bubbles.length || result.material.length) {
        if (shadow) draftId = createDraft(db, { chatId, contextVersion: version, bubbles: result.bubbles, material: result.material, nowMs: now, answersUpto });
        else enqueueReply(db, { chatId, version, bubbles: result.bubbles, material: result.material, assets: policy.assets, assetsDir: deps.assetsDir, nowMs: now, answersUpto });
      } else advanceAnswered(db, chatId, answersUpto); // no hay nada que mandar (proveedor, baja sin texto): queda atendido igual
      saveCard(db, chatId, result.card);
      if (result.stopBot) setMode(db, chatId, 'humano');
      for (const d of result.handoffs) audit(db, now, chatId, 'handoff', `${d.reason} (${d.mode}, prioridad ${d.priority})`);
    });
    if (!shadow) deps.kickOutbox();
    if (draftId !== undefined) await notify(chatId, () => notifier.draft(chatId, draftId!, result.bubbles, result.material));
    if (result.handoffs.length) await notify(chatId, () => notifier.handoff(chatId, result.card, result.handoffs));
  }

  return {
    onCustomerMessage: schedule,
    rescan() {
      void resumePaused(); // los pausados de un día anterior vuelven (el bot estuvo apagado a las 00:00); sin awaits antes del resumen, ya quedaron en auto
      if (listPausedForDay(db, Number.MAX_SAFE_INTEGER).length) armDayReset(); // y los de hoy vuelven mañana
      const cutoff = clock.now() - getNum(db, 'reply_window_hours') * 3_600_000;
      for (const c of listConversations(db, 'auto')) {
        if (unansweredMessages(db, c.chatId).some((m) => m.tsUtcMs >= cutoff)) schedule(c.chatId);
      }
      deps.kickOutbox();
    },
    async idle() {
      while (inflight.size) await Promise.all([...inflight]);
    },
    stop() {
      stopped = true;
      for (const s of states.values()) {
        for (const t of [s.timer, s.retryTimer, s.waitTimer]) if (t !== undefined) clock.clearTimeout(t);
        s.timer = s.retryTimer = s.waitTimer = undefined;
      }
      if (dayTimer !== undefined) clock.clearTimeout(dayTimer);
      dayTimer = undefined;
    },
  };
}
