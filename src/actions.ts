// Lo que el equipo le hace al bot: lo usan Telegram y el CRM, así los dos hacen exactamente lo mismo (cola de salida, versiones de contexto, auditoría).
// Cada acción devuelve un resultado; el texto lo arma cada pantalla (Telegram habla de comandos, el CRM de botones).
import type { Clock } from './clock.ts';
import { audit, getConversation, getDraft, getQuote, insertOutbox, markQuoteSent, quoteSendRows, setDraftStatus, setMode, setStage, switchToHuman, teamQuoteInFlight, tx } from './db.ts';
import type { Conversation, Db, DraftStatus, Stage } from './db.ts';
import { approveDraft } from './outbox.ts';
import type { Asset } from './policy.ts';
import { getState, setSetting, setState } from './settings.ts';
import { TERMINAL } from './turn.ts';

// Lo que hace falta del resto de la tubería. Es una función porque Telegram se crea antes que el worker (el worker usa el notificador).
export interface Controls {
  worker: { onCustomerMessage(chatId: string): void; rescan(): void };
  kickOutbox: () => void;
  session: { current(): string; qr(): Promise<{ data: Uint8Array; mimetype: string }> };
}

export interface ActionContext {
  db: Db;
  clock: Clock;
  controls: () => Controls;
  assets: Asset[];
  assetsDir?: URL;
}

// `who` dice quién fue (nombre de Telegram, o "CRM"); `via`, por dónde ("botón [Lo tomo]", "/humano").
// El chat pasa al equipo: cancela lo pendiente (salida y borradores), sube la versión y deja constancia. false si ya estaba en humano.
export const takeOver = (ctx: ActionContext, conv: Conversation, who: string, via: string): boolean =>
  switchToHuman(ctx.db, conv.chatId, ctx.clock.now(), `${via} (${who})`);

// El chat vuelve al bot y pierde la etapa (tener etapa = ser del equipo). Si el cliente dejó algo sin contestar, el turno se programa ya.
// 'ficha_cerrada': vuelve a auto, pero la ficha es terminal (derivado, baja…) y el bot no le escribe.
export function giveBack(ctx: ActionContext, conv: Conversation, who: string, via: string): 'ya_estaba' | 'devuelto' | 'ficha_cerrada' {
  if (conv.mode === 'auto') return 'ya_estaba';
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    setMode(ctx.db, conv.chatId, 'auto');
    setStage(ctx.db, conv.chatId, null, now);
    audit(ctx.db, now, conv.chatId, 'command', `${via} (${who}): vuelve al bot`);
  });
  ctx.controls().worker.onCustomerMessage(conv.chatId);
  return TERMINAL.includes(conv.card.state) ? 'ficha_cerrada' : 'devuelto';
}

// [Presupuesto mandado]: guarda la hora (los recordatorios futuros parten de ahí). El chat pasa a Presupuestados
// si estaba sin etapa o en A presupuestar (no lo hace retroceder desde Seguimiento, Cliente…), y queda en manos del equipo.
// Un segundo toque no pisa la hora; salvo que el chat haya vuelto a A presupuestar o al bot: ahí es un presupuesto nuevo.
export function quoteSent(ctx: ActionContext, conv: Conversation, who: string): { status: 'anotado' | 'ya_estaba'; atUtc: number } {
  return tx(ctx.db, () => quoteSentCore(ctx, conv, who, ctx.clock.now()));
}
// El cuerpo de quoteSent sin transacción propia (las de SQLite no se anidan): lo usa también sendQuote dentro de la suya.
function quoteSentCore(ctx: ActionContext, conv: Conversation, who: string, now: number): { status: 'anotado' | 'ya_estaba'; atUtc: number } {
  const key = `quote_sent_utc.${conv.chatId}`;
  const before = getState(ctx.db, key);
  if (before && conv.stage !== null && conv.stage !== 'a_presupuestar') return { status: 'ya_estaba', atUtc: Number(before) };
  setState(ctx.db, key, String(now));
  if (conv.mode !== 'humano') switchToHuman(ctx.db, conv.chatId, now, `presupuesto mandado (${who})`);
  if (conv.stage === null || conv.stage === 'a_presupuestar') setStage(ctx.db, conv.chatId, 'presupuestado', now);
  audit(ctx.db, now, conv.chatId, 'command', `presupuesto_mandado (${who})`);
  return { status: 'anotado', atUtc: now };
}

// Lo que dice el mensaje que lleva el PDF (decisión de Lazar, 10-oct). También es lo que reconoce el eco.
export const QUOTE_CAPTION = 'Te paso el presupuesto.';
const QUOTE_SEND_EXPIRY_MS = 24 * 3_600_000; // si en 24 h no salió (bot apagado, WhatsApp caído), vence y avisa: no sale un presupuesto viejo sin que nadie lo mire

// "Enviar por WhatsApp" del CRM: el PDF (ya armado en `pdf.path`) entra a la cola como mensaje del equipo y el chat queda como con [Presupuesto mandado]
// (pasa a Presupuestados si no estaba más adelante). El chat queda SIEMPRE con el equipo: el bot no sigue conversando después de un presupuesto mandado a mano.
// Todo en una transacción: o queda todo anotado, o nada. Mientras haya un presupuesto en camino a ese chat, otro no entra: 'ya_en_camino'.
export function sendQuote(ctx: ActionContext, quoteId: string, pdf: { path: string; filename: string }, who: string):
  { status: 'en_cola'; quote: 'anotado' | 'ya_estaba' } | { status: 'ya_en_camino' | 'sin_chat' | 'no_existe' } {
  const r = tx(ctx.db, () => {
    const q = getQuote(ctx.db, quoteId);
    if (!q) return { status: 'no_existe' as const };
    const conv = q.chatId ? getConversation(ctx.db, q.chatId) : undefined;
    if (!conv) return { status: 'sin_chat' as const };
    if (teamQuoteInFlight(ctx.db, conv.chatId)) return { status: 'ya_en_camino' as const };
    const rows = quoteSendRows(ctx.db, quoteId);
    const now = ctx.clock.now();
    const quote = quoteSentCore(ctx, conv, who, now).status;
    if (quote === 'ya_estaba') {
      if (conv.mode !== 'humano') switchToHuman(ctx.db, conv.chatId, now, `presupuesto mandado desde el CRM (${who})`);
      audit(ctx.db, now, conv.chatId, 'command', `presupuesto_mandado de nuevo (${who})`);
    }
    insertOutbox(ctx.db, {
      logicalKey: `team:presupuesto:${quoteId}:${rows.length + 1}`, chatId: conv.chatId, kind: 'file', author: 'team',
      body: JSON.stringify({ file: pdf.path, filename: pdf.filename, caption: QUOTE_CAPTION }),
      expiresUtc: now + QUOTE_SEND_EXPIRY_MS, contextVersion: getConversation(ctx.db, conv.chatId)!.contextVersion, createdUtc: now, answersUpto: 0,
    });
    markQuoteSent(ctx.db, quoteId, now);
    return { status: 'en_cola' as const, quote };
  });
  if (r.status === 'en_cola') ctx.controls().kickOutbox();
  return r;
}

// Mover de etapa a mano. Poner una etapa pasa el chat al equipo si no estaba en humano (también si estaba pausado: así la vuelta de las 00:00 no lo devuelve al bot).
// En humano no se llama a switchToHuman: cancelaría lo pendiente, y ahí puede haber un mensaje de cierre que sí tiene que salir.
export function moveStage(ctx: ActionContext, conv: Conversation, stage: Stage, who: string, lostReason?: string): 'movido' | 'igual' {
  const reason = stage === 'perdido' || stage === 'descartado' ? (lostReason?.trim() || undefined) : undefined;
  if (conv.stage === stage && (!reason || reason === conv.lostReason)) return 'igual'; // misma etapa sin motivo nuevo: no se borra el que tenía
  const now = ctx.clock.now();
  tx(ctx.db, () => {
    if (conv.mode !== 'humano') switchToHuman(ctx.db, conv.chatId, now, `pasó a una etapa del equipo (${who})`);
    setStage(ctx.db, conv.chatId, stage, now, reason);
    audit(ctx.db, now, conv.chatId, 'command', `etapa: ${conv.stage ?? 'sin etapa'} → ${stage}${reason ? ` (${reason})` : ''} (${who})`);
  });
  return 'movido';
}

// [Mandar] de un borrador del modo sombra: entra a la cola si el cliente no escribió de nuevo.
export function sendDraft(ctx: ActionContext, draftId: number): 'enviado' | 'vencido' | 'no_pendiente' {
  const r = approveDraft(ctx.db, draftId, ctx.assets, ctx.clock.now(), ctx.assetsDir);
  if (r === 'enviado') ctx.controls().kickOutbox();
  return r;
}

export function discardDraft(ctx: ActionContext, draftId: number, who: string): { status: 'descartado' } | { status: 'no_pendiente'; was: DraftStatus } | { status: 'no_existe' } {
  const d = getDraft(ctx.db, draftId);
  if (!d) return { status: 'no_existe' };
  if (d.status !== 'pendiente') return { status: 'no_pendiente', was: d.status };
  setDraftStatus(ctx.db, draftId, 'descartado');
  audit(ctx.db, ctx.clock.now(), d.chatId, 'command', `borrador ${draftId} descartado (${who})`);
  return { status: 'descartado' };
}

// [Lo tomo] de un borrador: el borrador queda descartado (switchToHuman cierra los pendientes) y el chat pasa al equipo.
export function takeOverFromDraft(ctx: ActionContext, draftId: number, who: string, via: string): 'tomado' | 'no_existe' {
  const d = getDraft(ctx.db, draftId);
  const conv = d && getConversation(ctx.db, d.chatId);
  if (!conv) return 'no_existe';
  takeOver(ctx, conv, who, via);
  return 'tomado';
}

// Apagar / prender todo y el modo sombra. No auditan: Telegram ya deja constancia del comando y el CRM de su botón.
export function setBotSwitch(ctx: ActionContext, on: boolean): void {
  setSetting(ctx.db, 'kill_switch', on ? '0' : '1');
  if (on) ctx.controls().worker.rescan(); // retoma las consultas que quedaron esperando
}
export const setShadow = (ctx: ActionContext, on: boolean): void => setSetting(ctx.db, 'shadow_mode', on ? '1' : '0');
