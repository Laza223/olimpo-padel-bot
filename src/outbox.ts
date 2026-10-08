// Salida: UN solo enviador con estados (pendiente → en_proceso → aceptado | incierto | fallido | cancelado | vencido).
// Regla de oro: un envío incierto (timeout o 5xx después de enviar) NUNCA se reintenta a ciegas: se concilia con el historial de WAHA.
import { fileURLToPath } from 'node:url';
import type { Asset } from './policy.ts';
import type { Channel, HistoryMessage } from './channel/types.ts';
import { ChannelError } from './channel/types.ts';
import { sleep } from './clock.ts';
import type { Clock } from './clock.ts';
import {
  advanceAnswered, audit, bumpVersion, chatLabel, claimOutbox, dueIncierto, expireOutbox, findMessage, getConversation, getDraft, getOutbox, insertMessage, insertOutbox, markOutbox,
  cancelChatOutbox, nextOutboxWake, nextPendingOutbox, outboxByProviderId, requeueOutbox, setDraftStatus, tx,
} from './db.ts';
import type { Db, OutboxRow } from './db.ts';
import { sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { getFlag, getNum } from './settings.ts';

const DEFAULT_ASSETS_DIR = new URL('../assets/', import.meta.url);
const RECONCILE_SETTLE_MS = 3_000; // espera antes de mirar el historial: WAHA puede estar terminando de mandarlo
const RECONCILE_RETRY_MS = 30_000; // si no se pudo mirar el historial
const RECONCILE_GIVE_UP_MS = 10 * 60_000; // y si en 10 min no se pudo confirmar: fallido, a revisar a mano
const RECONCILE_SKEW_MS = 60_000; // el reloj de WhatsApp y el nuestro no coinciden al segundo
const TRANSIENT_BACKOFF_MS = [5_000, 30_000]; // entre reintentos de un error que seguro no salió
const MAX_SEND_ATTEMPTS = 3;
const TYPING_MS_PER_CHAR = 50;
const TYPING_MIN_MS = 400;

// Encola una respuesta: los globos primero y después las imágenes del material (una por archivo). Devuelve cuántas filas nuevas entraron.
// La clave `chat:versión:índice` es única: encolar dos veces la misma respuesta no duplica nada.
export function enqueueReply(db: Db, o: { chatId: string; version: number; bubbles: string[]; material: string[]; assets: Asset[]; assetsDir?: URL; nowMs: number; answersUpto: number }): number {
  const expiresUtc = o.nowMs + getNum(db, 'outbox_expiry_min') * 60_000;
  let index = 0;
  let inserted = 0;
  const add = (kind: 'text' | 'image', body: string) => {
    if (insertOutbox(db, { logicalKey: `${o.chatId}:${o.version}:${index++}`, chatId: o.chatId, kind, body, expiresUtc, contextVersion: o.version, createdUtc: o.nowMs, answersUpto: o.answersUpto })) inserted++;
  };
  for (const b of o.bubbles) add('text', b);
  for (const id of o.material) {
    const asset = o.assets.find((a) => a.id === id);
    if (!asset) continue;
    // La leyenda de assets.yaml va en la primera foto de un material real; los renders van sin leyenda (policy/assets.yaml).
    asset.archivos.forEach((file, i) => add('image', JSON.stringify({ file: fileURLToPath(new URL(file, o.assetsDir ?? DEFAULT_ASSETS_DIR)), caption: i === 0 && asset.tipo === 'real' ? asset.texto : undefined })));
  }
  return inserted;
}

// [Mandar] de un borrador (modo sombra): si el contexto no cambió, entra al outbox con la clave del borrador y sale como cualquier respuesta.
// Si el cliente escribió de nuevo, el borrador quedó viejo y no se manda. Aprobar dos veces no duplica (el borrador ya no está pendiente).
export function approveDraft(db: Db, draftId: number, assets: Asset[], nowMs: number, assetsDir?: URL): 'enviado' | 'vencido' | 'no_pendiente' {
  return tx(db, () => {
    const d = getDraft(db, draftId);
    if (!d || d.status !== 'pendiente') return 'no_pendiente';
    if (getConversation(db, d.chatId)?.contextVersion !== d.contextVersion) {
      setDraftStatus(db, d.id, 'vencido');
      return 'vencido';
    }
    enqueueReply(db, { chatId: d.chatId, version: d.contextVersion, bubbles: d.bubbles, material: d.material, assets, assetsDir, nowMs, answersUpto: d.answersUpto });
    setDraftStatus(db, d.id, 'mandado');
    return 'enviado';
  });
}

export interface OutboxDeps {
  db: Db;
  channel: Channel;
  notifier: Notifier;
  clock: Clock;
  onExpired?: (chatId: string) => void; // se venció una respuesta sin mandar de un chat en `auto`: se vuelve a armar el turno
}

export interface Outbox {
  kick(): void; // hay algo nuevo (o se prendió de nuevo el bot): a mandar
  idle(): Promise<void>; // espera a que termine lo que está mandando ahora (las pruebas)
  stop(): void;
}

const imageOf = (row: OutboxRow): { file: string; caption?: string } => JSON.parse(row.body) as { file: string; caption?: string };
// El texto con el que se reconoce el mensaje en el historial de WAHA.
export const outboxText = (row: OutboxRow): string => (row.kind === 'text' ? row.body : (imageOf(row).caption ?? ''));

export function createOutbox(deps: OutboxDeps): Outbox {
  const { db, channel, notifier, clock } = deps;
  let running = false;
  let again = false;
  let current: Promise<void> | undefined;
  let wake: unknown;
  let stopped = false;

  const alert = (text: string, urgent = false): Promise<void> => sendAlert(db, notifier, clock, text, { urgent });
  const safe = async (p: Promise<unknown>): Promise<void> => void (await p.catch(() => undefined));

  // Lo que venció sin mandar no se pierde en silencio: queda en la auditoría y avisa una vez por chat. Si el chat sigue siendo del bot, sube la versión
  // (la clave de salida es única por versión) y se regenera; si no, lo ve el equipo.
  async function expire(): Promise<void> {
    for (const chatId of expireOutbox(db, clock.now())) {
      const label = chatLabel(db, chatId);
      if (getConversation(db, chatId)?.mode !== 'auto') {
        await sendAlert(db, notifier, clock, `Se venció una respuesta sin mandar en ${label} (el chat no está con el bot): revisalo vos.`, { chatId });
        continue;
      }
      bumpVersion(db, chatId, clock.now());
      await sendAlert(db, notifier, clock, `Se venció una respuesta sin mandar en ${label}, la regenero.`, { chatId });
      deps.onExpired?.(chatId);
    }
  }

  function fail(row: OutboxRow, cause: string): void {
    markOutbox(db, row.id, 'fallido', { cause });
    cancelChatOutbox(db, row.chatId, 'anterior_fallo'); // si un globo no salió, el resto de esa respuesta tampoco
    audit(db, clock.now(), row.chatId, 'error', `salida ${row.logicalKey} fallida: ${cause}`);
  }

  function accept(row: OutboxRow, providerMsgId: string): void {
    const nowMs = clock.now();
    tx(db, () => {
      markOutbox(db, row.id, 'aceptado', { providerMsgId });
      const conv = getConversation(db, row.chatId);
      insertMessage(db, { session: conv?.session ?? 'default', providerMsgId, chatId: row.chatId, author: 'bot', text: outboxText(row), tsUtcMs: nowMs, media: row.kind === 'image' ? 'image' : undefined });
      advanceAnswered(db, row.chatId, row.answersUpto); // recién cuando sale queda contestado lo que contesta
    });
  }

  // ¿El mensaje ya es de otra fila o ya lo tenemos? Entonces no puede ser el que buscamos. El id que ya es de esta misma fila no cuenta como "de otra".
  const attributed = (row: OutboxRow, m: HistoryMessage): boolean =>
    m.providerMsgId !== row.providerMsgId && (!!outboxByProviderId(db, m.providerMsgId) || !!findMessage(db, getConversation(db, row.chatId)?.session ?? 'default', m.providerMsgId));

  async function reconcile(row: OutboxRow): Promise<void> {
    const attemptedAt = row.attemptedUtc ?? row.createdUtc;
    let found: HistoryMessage | undefined;
    try {
      const msgs = await channel.messagesSince(row.chatId, attemptedAt - RECONCILE_SKEW_MS, 50);
      found = msgs.find((m) => m.fromMe && m.text === outboxText(row) && !attributed(row, m));
      if (getOutbox(db, row.id)?.status !== 'incierto') return; // mientras se miraba el historial llegó el eco: ya está resuelto
    } catch {
      if (getOutbox(db, row.id)?.status !== 'incierto') return;
      if (clock.now() - attemptedAt >= RECONCILE_GIVE_UP_MS) {
        fail(row, 'no_confirmado');
        await alert(`Chat ${chatLabel(db, row.chatId)}: no pude confirmar si salió un mensaje del bot (WAHA no deja ver el historial). Revisalo a mano en el celular antes de reenviar nada.`, true);
      } else {
        markOutbox(db, row.id, 'incierto', { nextTryUtc: clock.now() + RECONCILE_RETRY_MS });
      }
      return;
    }
    if (found) return accept(row, found.providerMsgId);
    fail(row, 'no_confirmado');
    await alert(`Chat ${chatLabel(db, row.chatId)}: un mensaje del bot quedó con resultado incierto y no aparece en el historial. Revisalo a mano en el celular: el bot no lo reintenta.`, true);
  }

  async function handleFailure(sent: OutboxRow, err: ChannelError): Promise<void> {
    if (getOutbox(db, sent.id)?.status !== 'en_proceso') return; // el eco llegó antes que el error y ya lo dio por aceptado: no se pisa
    const label = chatLabel(db, sent.chatId);
    switch (err.type) {
      case 'uncertain':
        // Puede haber salido: se espera un momento y se concilia con el historial; no se reenvía.
        markOutbox(db, sent.id, 'incierto', { cause: err.message.slice(0, 200), nextTryUtc: clock.now() + RECONCILE_SETTLE_MS });
        return;
      case 'restricted':
        fail(sent, 'restricted');
        await alert(`Chat ${label}: WhatsApp restringió el envío (error ${err.code ?? '463/475'}). El bot no insiste: revisá la cuenta antes de seguir.`, true);
        return;
      case 'auth':
        fail(sent, 'auth');
        await alert(`Chat ${label}: WAHA rechazó la clave o la sesión. El bot no puede mandar hasta que se arregle.`, true);
        return;
      case 'transient':
        if (sent.attempt >= MAX_SEND_ATTEMPTS) {
          fail(sent, 'transient');
          await alert(`Chat ${label}: no pude mandar el mensaje después de ${sent.attempt} intentos (${err.message.slice(0, 120)}). Revisalo a mano.`);
        } else {
          requeueOutbox(db, sent.id, err.message.slice(0, 200), clock.now() + TRANSIENT_BACKOFF_MS[Math.min(sent.attempt - 1, TRANSIENT_BACKOFF_MS.length - 1)]); // si quedó viejo, se cancela
        }
    }
  }

  async function sendRow(row: OutboxRow): Promise<void> {
    const isText = row.kind === 'text';
    if (isText) {
      await safe(channel.typing(row.chatId, true));
      await sleep(clock, Math.min(getNum(db, 'typing_ms'), Math.max(TYPING_MIN_MS, row.body.length * TYPING_MS_PER_CHAR))); // por globo, con tope
    }
    try {
      if (stopped || getFlag(db, 'kill_switch')) return;
      await expire();
      if (!claimOutbox(db, row.id, clock.now())) return; // se canceló o venció mientras "escribía"
      const claimed = getOutbox(db, row.id)!;
      try {
        const r = isText ? await channel.sendText(row.chatId, row.body) : await channel.sendImage(row.chatId, imageOf(row).file, imageOf(row).caption);
        accept(claimed, r.providerMsgId);
      } catch (e) {
        await handleFailure(claimed, e instanceof ChannelError ? e : new ChannelError('uncertain', undefined, e instanceof Error ? e.message : String(e)));
      }
    } finally {
      if (isText) await safe(channel.typing(row.chatId, false)); // siempre se apaga
    }
  }

  async function drain(): Promise<void> {
    for (;;) {
      if (stopped || getFlag(db, 'kill_switch')) return;
      await expire();
      for (const row of dueIncierto(db, clock.now())) await reconcile(row);
      const row = nextPendingOutbox(db, clock.now());
      if (!row) return;
      await sendRow(row);
    }
  }

  function armWake(): void {
    if (wake !== undefined) clock.clearTimeout(wake);
    wake = undefined;
    const at = nextOutboxWake(db);
    if (stopped || at === undefined || getFlag(db, 'kill_switch')) return; // apagado: nada que despertar (al prender, rescan() vuelve a darle kick)
    wake = clock.setTimeout(() => { wake = undefined; kick(); }, Math.max(0, at - clock.now()));
  }

  function kick(): void {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    current = drain()
      .catch((e: unknown) => audit(db, clock.now(), null, 'error', `salida: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = false;
        current = undefined;
        if (again) {
          again = false;
          kick();
        } else armWake();
      });
  }

  return {
    kick,
    async idle() {
      while (current) await current;
    },
    stop() {
      stopped = true;
      if (wake !== undefined) clock.clearTimeout(wake);
      wake = undefined;
    },
  };
}
