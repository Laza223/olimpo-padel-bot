// Ingest: toma los eventos guardados por /waha (con lock recuperable), guarda sin duplicar y clasifica por tipo.
// Nunca abre un turno por una edición, un borrado o un ack: solo un mensaje nuevo del cliente con texto o un audio.
import { UNREADABLE_AUDIO_TEXT } from './audio.ts';
import type { Channel, HistoryMessage, InboundEvent, MediaKind } from './channel/types.ts';
import type { Clock } from './clock.ts';
import {
  advanceAnswered, audit, bumpVersion, cancelChatOutbox, chatLabel, claimInboundEvents, closePendingDrafts, createConversation, delayInboundEvent, editMessage, findMessage,
  finishInboundEvent, getConversation, insertMessage, markOutbox, nextInboundWake, outboxByProviderId, outboxEchoCandidates, revokeMessage, setOutboxAck,
  setProfileName, switchToHuman, tx, unansweredMessages,
} from './db.ts';
import type { Db, OutboxRow } from './db.ts';
import { safeNotify, sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { outboxText } from './outbox.ts';
import { ensureBotStart, getBotStart, getNum, setState } from './settings.ts';

const LOCK_MS = 120_000; // si el proceso muere con un evento tomado, a los 2 min se recupera
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000];
const HISTORY_LIMIT = 50;
const LATE_ECHO_MS = 10 * 60_000; // un envío dado por "no confirmado" hace poco se corrige si el eco llega tarde

const MEDIA_LABEL: Record<MediaKind, string> = { audio: 'un audio', image: 'una imagen', video: 'un video', document: 'un documento', sticker: 'un sticker', other: 'un adjunto' };

export interface IngestDeps {
  db: Db;
  channel: Channel;
  clock: Clock;
  notifier: Notifier;
  onCustomerMessage: (chatId: string) => void; // un mensaje nuevo (con texto, o un audio) de un chat en `auto`: se programa el turno
  onOutboxChange?: () => void; // un eco o un ack cambió la salida (por ejemplo resolvió un incierto): que el enviador siga
}

export interface Ingest {
  processPending(): Promise<void>;
  kick(): void; // hay un evento nuevo guardado
  idle(): Promise<void>;
  stop(): void;
}

export function createIngest(deps: IngestDeps): Ingest {
  const { db, channel, clock, notifier } = deps;
  let current: Promise<void> | undefined;
  let again = false;
  let retryTimer: unknown;
  let stopped = false;

  const alert = (text: string, opts: { urgent?: boolean; chatId?: string } = {}) => sendAlert(db, notifier, clock, text, opts);

  // ---------- mensaje del cliente ----------
  // `lastTry`: es el último intento del evento; si ni así se puede mirar la historia, el mensaje se guarda igual y el chat arranca en humano (modo seguro).
  async function onMessage(e: Extract<InboundEvent, { kind: 'message' }>, lastTry = false): Promise<void> {
    const now = clock.now();
    if (findMessage(db, e.session, e.providerMsgId)) return; // el mismo mensaje por otro evento: no suma nada
    const hasText = e.text.trim() !== '';
    if (!hasText && !e.media) return;
    const isAudio = !hasText && e.media === 'audio'; // un audio sin texto se transcribe en el turno (src/worker.ts)

    let conv = getConversation(db, e.chatId);
    let historyUnknown = false;
    let priorUnanswered = false; // chat del equipo con una consulta reciente del cliente que nadie contestó
    if (!conv) {
      // Primera vez que vemos este chat: si ya tenía historia anterior al arranque del bot, es un contacto del equipo y arranca en humano.
      // Si WAHA no deja mirar la historia, tira y el evento se reintenta: no se asume nada. En el último intento no se pierde el mensaje: se asume lo seguro (humano).
      const botStart = getBotStart(db) ?? ensureBotStart(db, now);
      let history: HistoryMessage[] = [];
      try {
        history = await channel.messagesSince(e.chatId, 0, HISTORY_LIMIT);
      } catch (err) {
        if (!lastTry) throw err;
        historyUnknown = true;
      }
      const hadHistory = history.some((m) => m.providerMsgId !== e.providerMsgId && m.tsUtcMs < botStart);
      conv = createConversation(db, { chatId: e.chatId, session: e.session, mode: hadHistory || historyUnknown ? 'humano' : 'auto', nowMs: now, profileName: e.profileName });
      if (hadHistory) audit(db, now, e.chatId, 'takeover', 'chat con historia anterior al arranque del bot: arranca en humano');
      priorUnanswered = hadHistory && e.tsUtcMs >= now - getNum(db, 'reply_window_hours') * 3_600_000 && !history.some((m) => m.fromMe && m.tsUtcMs >= e.tsUtcMs);
      if (historyUnknown) audit(db, now, e.chatId, 'takeover', 'no pude mirar la historia del chat (WAHA no contestó): arranca en humano por las dudas');
    }

    tx(db, () => {
      insertMessage(db, { session: e.session, providerMsgId: e.providerMsgId, chatId: e.chatId, author: 'customer', text: e.text, tsUtcMs: e.tsUtcMs, media: e.media, ...(isAudio ? audioFields(e) : {}) });
      if (e.profileName) setProfileName(db, e.chatId, e.profileName);
      if (hasText || isAudio) staleTheContext(e.chatId, now); // el audio es contenido nuevo para el modelo, aunque todavía no tenga texto
    });

    if (priorUnanswered) {
      await alert(`Consulta previa sin contestar en ${chatLabel(db, e.chatId)}: el chat ya tenía historia con el equipo (por eso el bot no contesta) y el último mensaje es del cliente. Contestalo vos o devolvelo al bot con /bot ${chatLabel(db, e.chatId).slice(1)}.`, { chatId: e.chatId });
    }
    if (historyUnknown) {
      await alert(`Chat ${chatLabel(db, e.chatId)}: no pude revisar la historia de un chat nuevo (WAHA no contestó en ${MAX_ATTEMPTS} intentos). Guardé el mensaje y dejé el chat con el equipo por las dudas: miralo y, si es un cliente nuevo, devolvelo al bot con /bot ${chatLabel(db, e.chatId).slice(1)}.`, { chatId: e.chatId });
    }
    if (!hasText && !isAudio) {
      // Una foto, un video o un documento sin texto no abre turno (el bot solo lee audios): queda guardado y se avisa.
      await alert(`Chat ${chatLabel(db, e.chatId)}: el cliente mandó ${MEDIA_LABEL[e.media!]} y el bot no lo lee (solo lee audios y texto). Mirá el chat.`, { chatId: e.chatId });
      return;
    }
    if (getConversation(db, e.chatId)!.mode === 'auto') deps.onCustomerMessage(e.chatId);
  }

  // Un audio con archivo para bajar queda pendiente (el worker lo transcribe); sin archivo (WAHA no lo bajó, o la ruta no sirve) queda ilegible desde el principio.
  function audioFields(e: Extract<InboundEvent, { kind: 'message' }>): { text: string; mediaUrl?: string; mediaMime?: string; transcriptStatus: 'pendiente' | 'ilegible' } {
    const f = e.mediaFile;
    const readable = !!f?.path && !f.error;
    if (!readable) audit(db, clock.now(), e.chatId, 'error', 'audio ilegible: WAHA no mandó el archivo (sin url o con error)');
    return { text: readable ? '' : UNREADABLE_AUDIO_TEXT, ...(f?.path ? { mediaUrl: f.path } : {}), ...(f?.mime ? { mediaMime: f.mime } : {}), transcriptStatus: readable ? 'pendiente' : 'ilegible' };
  }

  // Cambió lo que el modelo tiene que ver: sube la versión y lo pendiente de la versión anterior (respuestas, borradores) ya es viejo.
  function staleTheContext(chatId: string, nowMs: number): void {
    const version = bumpVersion(db, chatId, nowMs);
    cancelChatOutbox(db, chatId, 'contexto_nuevo', version);
    closePendingDrafts(db, chatId, 'vencido', version);
  }

  // ---------- mensaje propio: eco del bot o equipo ----------
  function echo(row: OutboxRow, e: Extract<InboundEvent, { kind: 'own_message' }>): boolean {
    const wasFailed = row.status === 'fallido';
    tx(db, () => {
      markOutbox(db, row.id, 'aceptado', { providerMsgId: e.providerMsgId });
      insertMessage(db, { session: e.session, providerMsgId: e.providerMsgId, chatId: e.chatId, author: 'bot', text: e.text, tsUtcMs: e.tsUtcMs, media: row.kind === 'image' ? 'image' : undefined });
      advanceAnswered(db, row.chatId, row.answersUpto);
    });
    return wasFailed;
  }

  async function onOwn(e: Extract<InboundEvent, { kind: 'own_message' }>): Promise<void> {
    const now = clock.now();
    // 1) Eco del bot por id; 2) por texto, si el id todavía no volvió (el eco llegó antes que la respuesta) o se perdió la respuesta.
    const row = outboxByProviderId(db, e.providerMsgId) ?? outboxEchoCandidates(db, e.chatId, now - LATE_ECHO_MS).find((r) => outboxText(r) === e.text);
    if (row) {
      if (echo(row, e)) await alert(`Chat ${chatLabel(db, e.chatId)}: el mensaje que figuraba como no confirmado sí salió (llegó el eco). No hace falta reenviarlo.`, { chatId: e.chatId });
      deps.onOutboxChange?.();
      return;
    }
    // 3) Salió por la API pero no está en la cola del bot (eco con el texto cambiado, otro programa con la misma sesión): no es el equipo, no hay toma humana.
    if (e.source === 'api') {
      await alert(`Chat ${chatLabel(db, e.chatId)}: salió un mensaje por la API que no está en la cola del bot (¿otro programa con la misma sesión, o WhatsApp cambió el texto?). No lo tomo como toma humana: revisalo en el celular.`, { chatId: e.chatId });
      return;
    }
    // 4) Lo escribió el equipo (celular, Web o app): toma humana.
    if (!getConversation(db, e.chatId)) createConversation(db, { chatId: e.chatId, session: e.session, mode: 'humano', nowMs: now }); // el bot solo responde a quien escribe primero
    const changed = tx(db, () => {
      insertMessage(db, { session: e.session, providerMsgId: e.providerMsgId, chatId: e.chatId, author: 'team', text: e.text, tsUtcMs: e.tsUtcMs });
      return switchToHuman(db, e.chatId, now, 'escribió el equipo desde el celular o la Web'); // cancela lo pendiente aunque el turno ya haya terminado
    });
    if (changed) await safeNotify(db, clock, e.chatId, () => notifier.takeover(e.chatId));
  }

  // ---------- edición, borrado, ack, sesión ----------
  // Editó o borró algo del cliente: la respuesta que había quedó vieja (se canceló), así que si todavía queda algo sin contestar el turno se vuelve a armar.
  // Nunca abre un turno solo: sin nada pendiente, no pasa nada.
  function rescheduleIfUnanswered(chatId: string): void {
    if (getConversation(db, chatId)?.mode === 'auto' && unansweredMessages(db, chatId).length) deps.onCustomerMessage(chatId);
  }

  function onEdit(e: Extract<InboundEvent, { kind: 'edit' }>): void {
    const m = findMessage(db, e.session, e.providerMsgId);
    if (!m) return;
    tx(db, () => {
      editMessage(db, m.id, e.text);
      if (m.author === 'customer') staleTheContext(m.chatId, clock.now());
    });
    if (m.author === 'customer') rescheduleIfUnanswered(m.chatId);
  }

  function onRevoke(e: Extract<InboundEvent, { kind: 'revoke' }>): void {
    const m = findMessage(db, e.session, e.providerMsgId);
    if (!m) return;
    tx(db, () => {
      revokeMessage(db, m.id);
      if (m.author === 'customer') staleTheContext(m.chatId, clock.now());
    });
    if (m.author === 'customer') rescheduleIfUnanswered(m.chatId);
  }

  async function onAck(e: Extract<InboundEvent, { kind: 'ack' }>): Promise<void> {
    const row = outboxByProviderId(db, e.providerMsgId);
    if (!row) return;
    if (e.status !== 'failed') return setOutboxAck(db, row.id, e.status);
    if (row.status !== 'aceptado' && row.status !== 'en_proceso' && row.status !== 'incierto') return;
    markOutbox(db, row.id, 'fallido', { cause: 'ack_failed' });
    cancelChatOutbox(db, row.chatId, 'anterior_fallo');
    await alert(`Chat ${chatLabel(db, row.chatId)}: WhatsApp informó que un mensaje del bot no se pudo entregar. Revisalo en el celular.`, { chatId: row.chatId });
  }

  async function handle(raw: string, lastTry: boolean): Promise<void> {
    const e = channel.parseEvent(JSON.parse(raw));
    switch (e.kind) {
      case 'message': return onMessage(e, lastTry);
      case 'own_message': return onOwn(e);
      case 'edit': return onEdit(e);
      case 'revoke': return onRevoke(e);
      case 'ack': return onAck(e);
      case 'session_status':
        setState(db, 'session_status', e.status); // la parte B (session.ts) lo usa
        setState(db, 'session_status_utc', String(clock.now()));
        return;
      case 'ignored': return;
    }
  }

  // ---------- cola de eventos ----------
  // De a uno: un evento que falla queda con espera y los demás siguen. Un evento de mensaje nuevo no se pierde: en el último intento se guarda igual (ver onMessage); cualquier otro que siga fallando queda en `error` con aviso.
  async function runBatch(): Promise<void> {
    for (;;) {
      const [ev] = claimInboundEvents(db, clock.now(), LOCK_MS, 1);
      if (!ev) return;
      try {
        await handle(ev.payload, ev.attempts >= MAX_ATTEMPTS);
        finishInboundEvent(db, ev.id, 'hecho');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (ev.attempts >= MAX_ATTEMPTS) {
          finishInboundEvent(db, ev.id, 'error', msg);
          audit(db, clock.now(), null, 'error', `evento ${ev.eventKey} sin procesar tras ${ev.attempts} intentos: ${msg}`);
          await alert(`No pude revisar la historia de un chat nuevo ni procesar un evento de WhatsApp (${msg.slice(0, 120)}). El mensaje quedó sin contestar: mirá WAHA.`);
        } else {
          delayInboundEvent(db, ev.id, clock.now() + RETRY_BACKOFF_MS[Math.min(ev.attempts - 1, RETRY_BACKOFF_MS.length - 1)], msg);
        }
      }
    }
  }

  function armRetry(): void {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
    retryTimer = undefined;
    const at = nextInboundWake(db);
    if (stopped || at === undefined) return;
    retryTimer = clock.setTimeout(() => { retryTimer = undefined; void processPending(); }, Math.max(0, at - clock.now()));
  }

  function processPending(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          await runBatch();
        } while (again);
      } catch (err) {
        audit(db, clock.now(), null, 'error', `ingest: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        current = undefined;
        armRetry();
      }
    })();
    return current;
  }

  return {
    processPending,
    kick() {
      void processPending();
    },
    async idle() {
      while (current) await current;
    },
    stop() {
      stopped = true;
      if (retryTimer !== undefined) clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    },
  };
}
