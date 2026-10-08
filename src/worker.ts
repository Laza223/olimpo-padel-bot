// Worker: ráfagas por chat, filtros antes de gastar, el turno (runTurn) con versión de contexto, aplicar la ficha y las derivaciones.
// Un turno por chat a la vez; 4 llamadas a OpenAI en total. Un error pasajero de OpenAI se reintenta con espera y nunca manda el mensaje seguro.
import { TransientLlmError } from './brain.ts';
import type { Channel } from './channel/types.ts';
import type { Clock } from './clock.ts';
import {
  addSpend, advanceAnswered, audit, chatLabel, countAdmittedSince, createDraft, draftHasVersion, getConversation, historyFor, insertAgentRun, listConversations, listPausedForDay, markAdmitted,
  outboxHasVersion, pauseConversation, saveCard, setMode, spentSince, tx, unansweredMessages,
} from './db.ts';
import type { Conversation, Db, PauseReason } from './db.ts';
import { safeNotify, sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { enqueueReply } from './outbox.ts';
import type { Policy } from './policy.ts';
import { getFlag, getNum, getState, setState } from './settings.ts';
import { argentinaTimeToUtcMs } from './time.ts';
import { TERMINAL, runTurn } from './turn.ts';
import type { AttemptLog, BrainConfig, LlmClient, TurnInput, TurnResult } from './types.ts';

const RETRY_MS = [30_000, 120_000, 300_000, 900_000]; // 30 s, 2 min, 5 min, 15 min y después cada 15 min
const WAIT_ALERT_MS = 10 * 60_000; // una conversación esperando más que esto avisa una vez
const HISTORY_LIMIT = 30;
const MAX_CONCURRENT_LLM = 4;

export interface WorkerDeps {
  db: Db;
  channel: Channel;
  llm: LlmClient;
  policy: Policy;
  config: BrainConfig;
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
  const { db, channel, llm, policy, config, notifier, clock } = deps;
  const states = new Map<string, ChatState>();
  const inflight = new Set<Promise<void>>();
  const llmSlots = new Semaphore(deps.maxConcurrentLlm ?? MAX_CONCURRENT_LLM);
  let quotaAlerted = false; // el aviso de "sin saldo" sale una vez por caída
  let configAlerted = false; // y el de "clave o modelo rechazados" también
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

  async function onFailure(chatId: string, s: ChatState, e: unknown): Promise<void> {
    const now = clock.now();
    const base = { chatId, tsUtc: now, model: config.model, effort: config.effort, policyHash: policy.hash, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, violations: [], usedFallback: false };
    if (e instanceof TransientLlmError) {
      recordRuns(chatId, e.attempts, false, 'descartado'); // intentos anteriores del turno (ya gastaron): al presupuesto
      insertAgentRun(db, { ...base, errorKind: `transient:${e.kind}` });
      if (e.kind === 'quota' && !quotaAlerted) {
        quotaAlerted = true;
        await alert('OpenAI sin saldo: el bot no contesta hasta que se cargue', { urgent: true, chatId });
      }
      if (e.kind === 'config' && !configAlerted) {
        configAlerted = true;
        await alert('OpenAI rechazó la clave o el modelo (revisá OPENAI_API_KEY y BOT_MODEL en el .env): el bot no contesta hasta que se arregle', { urgent: true, chatId });
      }
      scheduleRetry(chatId, s, e.kind === 'config' ? 'OpenAI rechazó la clave o el modelo' : 'OpenAI no responde');
      return;
    }
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
  async function attempt(chatId: string, s: ChatState): Promise<void> {
    const conv = getConversation(db, chatId);
    if (!conv || getFlag(db, 'kill_switch') || conv.mode !== 'auto' || TERMINAL.includes(conv.card.state)) return clearWait(s);
    const unanswered = unansweredMessages(db, chatId);
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

    const shadow = getFlag(db, 'shadow_mode');
    const version = conv.contextVersion;
    const answersUpto = Math.max(...unanswered.map((m) => m.id));
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

    quotaAlerted = false; // OpenAI contestó
    configAlerted = false;
    // Antes de mandar: si el contexto cambió o el chat ya no es del bot, el resultado es viejo y se descarta.
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

  function recordRuns(chatId: string, attempts: AttemptLog[], usedFallback: boolean, errorKind?: string): void {
    const now = clock.now();
    tx(db, () => {
      for (const a of attempts) {
        insertAgentRun(db, {
          chatId, tsUtc: now, model: a.model, effort: a.effort, policyHash: policy.hash, inputTokens: a.inputTokens, cachedTokens: a.cachedTokens, outputTokens: a.outputTokens,
          costUsd: a.costUsd, latencyMs: a.latencyMs, violations: a.violations, usedFallback, errorKind,
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
