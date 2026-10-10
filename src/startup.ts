// Reconciliación al prender (y cuando la sesión vuelve después de una caída): qué pasó mientras el bot no estaba mirando.
// Guarda lo que llegó (sin duplicar), respeta lo que escribió el equipo, contesta solo lo reciente (reply_window_hours) y nunca suelta una ráfaga atrasada:
// la salida (outbox) queda cerrada hasta que esto termina, y lo pendiente que quedó viejo se cancela o vence.
import { UNREADABLE_AUDIO_TEXT } from './audio.ts';
import type { Channel } from './channel/types.ts';
import type { Clock } from './clock.ts';
import {
  advanceAnswered, audit, bumpVersion, cancelChatOutbox, chatLabel, closePendingDrafts, createConversation, findMessage, getConversation, insertMessage, listConversations,
  listDrafts, markOutbox, outboxByProviderId, outboxEchoCandidates, setDraftStatus, switchToHuman, tx, unansweredMessages,
} from './db.ts';
import type { Db } from './db.ts';
import { sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { echoMatches, outboxMedia } from './outbox.ts';
import { ensureBotStart, getBotStart, getNum, getState, setState } from './settings.ts';

const SKEW_MS = 5 * 60_000; // margen entre el reloj de WhatsApp y el nuestro, y entre el último chequeo y el apagado real
const MAX_LOOKBACK_MS = 7 * 24 * 3_600_000; // tope de cuánto se mira hacia atrás (WAHA no guarda historia sin límite)
const GIVE_UP_MS = 10 * 60_000; // si en 10 min no se pudo reconciliar, se habilita la salida igual (lo vencido no sale)
const CHAT_LIMIT = 100; // mensajes por chat
const NEW_CHAT_LIMIT = 50; // y para un chat que no conocíamos (igual que el ingest)

export interface ReconcileReport {
  chats: number;
  scheduled: string[]; // chats con consultas recientes sin contestar: se programó su turno
  stale: string[]; // chats con consultas más viejas que reply_window_hours: van al resumen
  takeovers: string[]; // chats que pasaron a humano porque el equipo escribió
  mediaOnly: string[]; // chats donde el cliente mandó algo sin texto
  priorUnanswered: string[]; // chats nuevos que arrancan con el equipo y cuyo último mensaje es una consulta reciente del cliente
}

export interface RecoveryDeps {
  db: Db;
  channel: Pick<Channel, 'chatsActiveSince' | 'messagesSince'>;
  clock: Clock;
  notifier: Notifier;
  worker: { onCustomerMessage(chatId: string): void };
  onReady: () => void; // la salida ya se puede abrir (main: outbox.kick())
  session?: string;
}

export interface Recovery {
  reconcile(): Promise<ReconcileReport>; // una pasada; tira si WAHA falla con algún chat
  onObserve(status: string, previous: string | undefined): void; // lo llama session.ts en cada observación
  ready(): boolean;
  markAlive(): void; // el último momento en que todo andaba: de acá se mira hacia atrás al volver
}

const hoursAgo = (nowMs: number, ts: number): number => Math.max(0, Math.round((nowMs - ts) / 3_600_000));

export function createRecovery(deps: RecoveryDeps): Recovery {
  const { db, clock, channel } = deps;
  const session = deps.session ?? 'default';
  const bootAt = clock.now();
  let isReady = false;
  let reconciledOk = false;
  let running = false;
  let failing = false;
  let gaveUp = false;

  const alert = (text: string, urgent = false) => sendAlert(db, deps.notifier, clock, text, { urgent });

  // Cambió lo que el modelo tiene que ver: sube la versión y lo pendiente de la versión anterior (respuestas, borradores) ya es viejo.
  function staleTheContext(chatId: string): void {
    const version = bumpVersion(db, chatId, clock.now());
    cancelChatOutbox(db, chatId, 'contexto_nuevo', version);
    closePendingDrafts(db, chatId, 'vencido', version);
  }

  async function reconcileChat(chatId: string, since: number, report: ReconcileReport): Promise<void> {
    const now = clock.now();
    let conv = getConversation(db, chatId);
    const known = !!conv;
    // Un chat que no conocíamos se mira entero (como el ingest): así se sabe si ya había historia o si empezó el equipo.
    const msgs = await channel.messagesSince(chatId, known ? since : 0, known ? CHAT_LIMIT : NEW_CHAT_LIMIT);
    const sessionOf = conv?.session ?? session;
    const fresh = msgs.filter((m) => !findMessage(db, sessionOf, m.providerMsgId));
    if (!fresh.length) return;
    if (!conv) {
      const botStart = getBotStart(db) ?? ensureBotStart(db, now);
      const humano = msgs.some((m) => m.tsUtcMs < botStart) || msgs[0].fromMe; // el bot solo responde a quien escribe primero
      conv = createConversation(db, { chatId, session: sessionOf, mode: humano ? 'humano' : 'auto', nowMs: now });
      if (humano) audit(db, now, chatId, 'takeover', 'chat con historia anterior al arranque del bot o iniciado por el equipo: arranca en humano');
      const last = msgs[msgs.length - 1];
      if (humano && !last.fromMe && last.tsUtcMs >= now - getNum(db, 'reply_window_hours') * 3_600_000) report.priorUnanswered.push(chatId);
    }

    let customerText = 0;
    let customerMedia = 0;
    let teamWrote = false;
    tx(db, () => {
      for (const m of fresh) {
        if (m.fromMe) {
          // Un mensaje propio puede ser uno de la cola que quedó incierto al apagarse (se acepta, con su autor) o uno que escribió el equipo.
          const row = outboxByProviderId(db, m.providerMsgId) ?? outboxEchoCandidates(db, chatId, since).find((r) => echoMatches(r, m));
          if (row) {
            markOutbox(db, row.id, 'aceptado', { providerMsgId: m.providerMsgId });
            insertMessage(db, { session: sessionOf, providerMsgId: m.providerMsgId, chatId, author: row.author, text: m.text, tsUtcMs: m.tsUtcMs, media: outboxMedia(row) });
            advanceAnswered(db, chatId, row.answersUpto);
          } else {
            insertMessage(db, { session: sessionOf, providerMsgId: m.providerMsgId, chatId, author: 'team', text: m.text, tsUtcMs: m.tsUtcMs });
            teamWrote = true;
          }
          continue;
        }
        const hasText = m.text.trim() !== '';
        if (!hasText && m.media === 'audio') {
          // Un audio que se recupera de la historia de WAHA: con archivo para bajar entra pendiente (se transcribe en el turno); sin archivo, ilegible.
          const readable = !!m.mediaFile?.path && !m.mediaFile.error;
          insertMessage(db, {
            session: sessionOf, providerMsgId: m.providerMsgId, chatId, author: 'customer', text: readable ? '' : UNREADABLE_AUDIO_TEXT, tsUtcMs: m.tsUtcMs, media: 'audio',
            mediaUrl: m.mediaFile?.path, mediaMime: m.mediaFile?.mime, transcriptStatus: readable ? 'pendiente' : 'ilegible',
          });
          customerText++; // contenido nuevo para el modelo
          continue;
        }
        insertMessage(db, { session: sessionOf, providerMsgId: m.providerMsgId, chatId, author: 'customer', text: m.text, tsUtcMs: m.tsUtcMs, media: hasText ? undefined : (m.media ?? 'other') });
        if (hasText) customerText++;
        else customerMedia++;
      }
      if (customerText) staleTheContext(chatId);
    });
    if (customerMedia) report.mediaOnly.push(chatId);
    // Si el equipo escribió mientras tanto, el chat es suyo (aunque después el cliente haya vuelto a escribir): no se reanuda solo.
    if (teamWrote && switchToHuman(db, chatId, now, 'reconciliación: el equipo escribió mientras el bot estaba apagado')) report.takeovers.push(chatId);
  }

  async function reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { chats: 0, scheduled: [], stale: [], takeovers: [], mediaOnly: [], priorUnanswered: [] };
    const alive = Number(getState(db, 'alive_utc'));
    if (!Number.isFinite(alive) || alive <= 0) return report; // primer arranque de todos: no hay nada anterior que mirar
    const now = clock.now();
    const since = Math.max(alive - SKEW_MS, now - MAX_LOOKBACK_MS);
    const chats = await channel.chatsActiveSince(since);
    report.chats = chats.length;
    const failed: string[] = [];
    for (const chatId of chats) {
      try {
        await reconcileChat(chatId, since, report);
      } catch (e) {
        failed.push(chatId);
        audit(db, clock.now(), null, 'error', `reconciliación: no pude revisar un chat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Qué hacer con lo que quedó sin contestar en los chats del bot: lo reciente se contesta, lo viejo va al resumen.
    const windowH = getNum(db, 'reply_window_hours');
    const cutoff = clock.now() - windowH * 3_600_000;
    const stale: string[] = [];
    for (const c of listConversations(db, 'auto')) {
      const pending = unansweredMessages(db, c.chatId);
      if (!pending.length) continue;
      const newest = pending[pending.length - 1];
      if (newest.tsUtcMs >= cutoff) {
        deps.worker.onCustomerMessage(c.chatId);
        report.scheduled.push(c.chatId);
      } else {
        advanceAnswered(db, c.chatId, newest.id); // queda atendido: no se vuelve a listar
        report.stale.push(c.chatId);
        stale.push(`${chatLabel(db, c.chatId)} (hace ${hoursAgo(clock.now(), newest.tsUtcMs)} h)`);
      }
    }

    const lines: string[] = [];
    if (stale.length) lines.push(`- Consultas de hace más de ${windowH} h que ya no se contestan solas: ${stale.join(', ')}. Miralas vos.`);
    if (report.takeovers.length) lines.push(`- El equipo escribió mientras el bot estaba apagado: ${report.takeovers.map((c) => chatLabel(db, c)).join(', ')} pasó a humano.`);
    if (report.priorUnanswered.length) lines.push(`- Consulta previa sin contestar en ${report.priorUnanswered.map((c) => chatLabel(db, c)).join(', ')}: chats que ya tenían historia con el equipo y el último mensaje es del cliente. Contestalos vos.`);
    if (report.mediaOnly.length) lines.push(`- Mandaron algo sin texto (foto, video…) que el bot no lee: ${report.mediaOnly.map((c) => chatLabel(db, c)).join(', ')}.`);
    if (lines.length) await alert(['Revisé lo que pasó mientras el bot estaba apagado:', ...lines].join('\n'));

    if (failed.length) throw new Error(`no pude revisar ${failed.length} chat(s) de ${chats.length}`);
    return report;
  }

  // Los borradores del modo sombra que esperan hace más que la ventana ya no valen: se vencen antes de abrir la salida.
  function expireStaleDrafts(): void {
    const cutoff = clock.now() - getNum(db, 'reply_window_hours') * 3_600_000;
    for (const c of listConversations(db)) for (const d of listDrafts(db, c.chatId)) if (d.status === 'pendiente' && d.createdUtc < cutoff) setDraftStatus(db, d.id, 'vencido');
  }

  function open(): void {
    if (isReady) return;
    isReady = true;
    expireStaleDrafts();
    deps.onReady();
  }

  const markAlive = (): void => {
    if (reconciledOk) setState(db, 'alive_utc', String(clock.now())); // si falta reconciliar algo, el cursor se queda donde estaba
  };

  async function run(): Promise<void> {
    running = true;
    try {
      await reconcile();
      reconciledOk = true;
      failing = false;
      markAlive();
      open();
    } catch (e) {
      reconciledOk = false;
      const why = e instanceof Error ? e.message : String(e);
      if (!failing) {
        failing = true;
        audit(db, clock.now(), null, 'error', `reconciliación: ${why}`);
        await alert(`No pude revisar lo que llegó mientras el bot estaba apagado (${why.slice(0, 120)}). Reintento cada minuto; hasta entonces no se manda nada atrasado.`, true);
      }
      if (!isReady && !gaveUp && clock.now() - bootAt >= GIVE_UP_MS) {
        gaveUp = true;
        await alert('No pude revisar lo que llegó mientras el bot estaba apagado después de 10 minutos. Habilito los envíos igual (lo vencido no sale), pero mirá los chats a mano en el celular.', true);
        open();
      }
    } finally {
      running = false;
    }
  }

  return {
    reconcile,
    ready: () => isReady,
    markAlive,
    onObserve(status, previous) {
      if (status !== 'WORKING' || running) return;
      // Al prender (todavía sin reconciliar) y cada vez que la sesión vuelve después de una caída: se revisa lo que pasó mientras tanto.
      if (!reconciledOk || (previous !== undefined && previous !== 'WORKING')) void run();
      else markAlive();
    },
  };
}
