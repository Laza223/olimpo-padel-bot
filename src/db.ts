// Base SQLite (node:sqlite, sin dependencias): esquema, migración idempotente y funciones de acceso.
// Todo es síncrono: nunca se hace un `await` dentro de `tx()` (una sola conexión, no se puede intercalar otro trabajo).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Author, ChatMessage, ConversationMode, LeadCard } from './types.ts';
import { emptyCard } from './lead.ts';

// node:sqlite imprime un ExperimentalWarning al cargarse: se silencia solo ese aviso, el resto de los avisos pasa igual.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite/i.test(text)) return;
  return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
const sqlite = await import('node:sqlite');
process.emitWarning = emitWarning;

export type Db = DatabaseSync;

const SCHEMA_V1 = `
CREATE TABLE conversations (
  chat_id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','humano','pausado','cerrado')),
  context_version INTEGER NOT NULL DEFAULT 0,
  card_json TEXT NOT NULL,
  last_activity_utc INTEGER NOT NULL,
  first_seen_utc INTEGER NOT NULL,
  profile_name TEXT,
  bot_spent_usd REAL NOT NULL DEFAULT 0,
  answered_upto INTEGER NOT NULL DEFAULT 0, -- último mensaje del cliente que ya tiene respuesta mandada
  admitted_utc INTEGER                      -- cuándo entró al cupo de chats nuevos del día
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,     -- el modelo ve "m<id>"
  session TEXT NOT NULL,
  provider_msg_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('customer','bot','team','system')),
  text TEXT NOT NULL DEFAULT '',
  ts_utc INTEGER NOT NULL,
  media TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session, provider_msg_id)
);
CREATE INDEX messages_chat ON messages (chat_id, id);
CREATE TABLE inbound_events (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','hecho','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  received_utc INTEGER NOT NULL,
  last_error TEXT
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,         -- chat:versión:índice
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','image')),
  body TEXT NOT NULL,                       -- texto, o JSON {file, caption} si es imagen
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','en_proceso','aceptado','incierto','fallido','cancelado','vencido')),
  attempt INTEGER NOT NULL DEFAULT 0,
  expires_utc INTEGER NOT NULL,
  provider_msg_id TEXT,
  cause TEXT,
  context_version INTEGER NOT NULL,
  created_utc INTEGER NOT NULL,
  attempted_utc INTEGER,
  next_try_utc INTEGER,
  ack TEXT,
  answers_upto INTEGER NOT NULL DEFAULT 0   -- último mensaje del cliente que contesta esta respuesta
);
CREATE INDEX outbox_chat ON outbox (chat_id, id);
CREATE INDEX outbox_provider ON outbox (provider_msg_id);
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  bubbles_json TEXT NOT NULL,
  material_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','mandado','descartado','vencido')),
  tg_message_id INTEGER,
  created_utc INTEGER NOT NULL,
  answers_upto INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  ts_utc INTEGER NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  violations_json TEXT NOT NULL DEFAULT '[]',
  used_fallback INTEGER NOT NULL DEFAULT 0,
  error_kind TEXT
);
CREATE INDEX agent_runs_ts ON agent_runs (ts_utc);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  ts_utc INTEGER NOT NULL,
  chat_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('takeover','handoff','alert','error','command')),
  detail TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// Por qué quedó pausado un chat (y desde cuándo): el tope del día se levanta a las 00:00 de Argentina, el de la conversación no.
const SCHEMA_V2 = `
ALTER TABLE conversations ADD COLUMN pause_reason TEXT; -- 'budget' (gasto del día) | 'cap' (chats nuevos del día) | 'conv' (gasto de la conversación)
ALTER TABLE conversations ADD COLUMN paused_utc INTEGER;
`;

// Audios del cliente (F2b): dónde bajar el archivo, qué es y si ya se transcribió.
const SCHEMA_V3 = `
ALTER TABLE messages ADD COLUMN media_url TEXT;  -- solo el path de WAHA (/api/files/...), nunca un host
ALTER TABLE messages ADD COLUMN media_mime TEXT;
ALTER TABLE messages ADD COLUMN transcript_status TEXT CHECK (transcript_status IN ('pendiente','ok','ilegible')); -- NULL = no es un audio del cliente
`;

// Una entrada por versión del esquema: se corren las que faltan (PRAGMA user_version). Idempotente.
export const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

export function migrate(db: Db): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new sqlite.DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL');
  migrate(db);
  return db;
}

// BEGIN IMMEDIATE ... COMMIT. `fn` tiene que ser síncrona y no se anidan.
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const one = <T>(db: Db, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as unknown as T | undefined;
const all = <T>(db: Db, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as unknown as T[];
const run = (db: Db, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

// ---------- Conversaciones ----------
export interface Conversation {
  chatId: string;
  n: number; // número corto de la conversación (rowid): lo que ven las fichas en lugar del teléfono
  session: string;
  mode: ConversationMode;
  contextVersion: number;
  card: LeadCard;
  lastActivityUtc: number;
  firstSeenUtc: number;
  profileName: string | null;
  botSpentUsd: number;
  answeredUpto: number;
  admittedUtc: number | null;
  pauseReason: PauseReason | null; // solo mientras está pausado
  pausedUtc: number | null;
}

export type PauseReason = 'budget' | 'cap' | 'conv';

interface ConversationRow {
  rowid: number; chat_id: string; session: string; mode: ConversationMode; context_version: number; card_json: string;
  last_activity_utc: number; first_seen_utc: number; profile_name: string | null; bot_spent_usd: number; answered_upto: number; admitted_utc: number | null;
  pause_reason: PauseReason | null; paused_utc: number | null;
}
const toConversation = (r: ConversationRow): Conversation => ({
  chatId: r.chat_id, n: r.rowid, session: r.session, mode: r.mode, contextVersion: r.context_version, card: JSON.parse(r.card_json) as LeadCard,
  lastActivityUtc: r.last_activity_utc, firstSeenUtc: r.first_seen_utc, profileName: r.profile_name, botSpentUsd: r.bot_spent_usd,
  answeredUpto: r.answered_upto, admittedUtc: r.admitted_utc, pauseReason: r.pause_reason, pausedUtc: r.paused_utc,
});

export function getConversation(db: Db, chatId: string): Conversation | undefined {
  const r = one<ConversationRow>(db, 'SELECT rowid, * FROM conversations WHERE chat_id = ?', chatId);
  return r && toConversation(r);
}

// Cómo se nombra un chat en los avisos: el número corto de la conversación, nunca el teléfono.
export const chatLabel = (db: Db, chatId: string): string => {
  const r = one<{ rowid: number }>(db, 'SELECT rowid FROM conversations WHERE chat_id = ?', chatId);
  return r ? `#${r.rowid}` : '#?';
};

export function getConversationByNumber(db: Db, n: number): Conversation | undefined {
  const r = one<ConversationRow>(db, 'SELECT rowid, * FROM conversations WHERE rowid = ?', n);
  return r && toConversation(r);
}

export function listConversations(db: Db, mode?: ConversationMode): Conversation[] {
  const rows = mode ? all<ConversationRow>(db, 'SELECT rowid, * FROM conversations WHERE mode = ? ORDER BY rowid', mode) : all<ConversationRow>(db, 'SELECT rowid, * FROM conversations ORDER BY rowid');
  return rows.map(toConversation);
}

export function createConversation(db: Db, o: { chatId: string; session: string; mode: ConversationMode; nowMs: number; profileName?: string }): Conversation {
  run(db, 'INSERT INTO conversations (chat_id, session, mode, card_json, last_activity_utc, first_seen_utc, profile_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chat_id) DO NOTHING',
    o.chatId, o.session, o.mode, JSON.stringify(emptyCard()), o.nowMs, o.nowMs, o.profileName ?? null);
  return getConversation(db, o.chatId)!;
}

export const setMode = (db: Db, chatId: string, mode: ConversationMode): void => void run(db, 'UPDATE conversations SET mode = ?, pause_reason = NULL, paused_utc = NULL WHERE chat_id = ?', mode, chatId);
export const pauseConversation = (db: Db, chatId: string, reason: PauseReason, nowMs: number): void =>
  void run(db, "UPDATE conversations SET mode = 'pausado', pause_reason = ?, paused_utc = ? WHERE chat_id = ?", reason, nowMs, chatId);
// Chats pausados por un tope del día (gasto o chats nuevos) desde antes de `beforeMs`: a las 00:00 vuelven al bot.
export const listPausedForDay = (db: Db, beforeMs: number): Conversation[] =>
  all<ConversationRow>(db, "SELECT rowid, * FROM conversations WHERE mode = 'pausado' AND pause_reason IN ('budget','cap') AND paused_utc < ? ORDER BY rowid", beforeMs).map(toConversation);
export const saveCard = (db: Db, chatId: string, card: LeadCard): void => void run(db, 'UPDATE conversations SET card_json = ? WHERE chat_id = ?', JSON.stringify(card), chatId);
export const addSpend = (db: Db, chatId: string, usd: number): void => void run(db, 'UPDATE conversations SET bot_spent_usd = bot_spent_usd + ? WHERE chat_id = ?', usd, chatId);
export const setProfileName = (db: Db, chatId: string, name: string): void => void run(db, 'UPDATE conversations SET profile_name = ? WHERE chat_id = ? AND profile_name IS NULL', name, chatId);
export const markAdmitted = (db: Db, chatId: string, nowMs: number): void => void run(db, 'UPDATE conversations SET admitted_utc = ? WHERE chat_id = ?', nowMs, chatId);
export const advanceAnswered = (db: Db, chatId: string, upto: number): void => void run(db, 'UPDATE conversations SET answered_upto = MAX(answered_upto, ?) WHERE chat_id = ?', upto, chatId);
export const countAdmittedSince = (db: Db, sinceMs: number): number => one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM conversations WHERE admitted_utc >= ?', sinceMs)!.n;

// Sube la versión del contexto (algo cambió que el modelo tiene que ver) y devuelve la nueva.
export function bumpVersion(db: Db, chatId: string, nowMs: number): number {
  run(db, 'UPDATE conversations SET context_version = context_version + 1, last_activity_utc = ? WHERE chat_id = ?', nowMs, chatId);
  return one<{ v: number }>(db, 'SELECT context_version AS v FROM conversations WHERE chat_id = ?', chatId)!.v;
}

// ---------- Mensajes ----------
export interface MessageRow {
  id: number;
  session: string;
  providerMsgId: string;
  chatId: string;
  author: Author;
  text: string;
  tsUtcMs: number;
  media: string | null;
  edited: boolean;
  revoked: boolean;
  mediaUrl: string | null; // audio del cliente: el path de WAHA donde bajarlo
  mediaMime: string | null;
  transcriptStatus: TranscriptStatus | null;
}
// Un audio del cliente nace 'pendiente' (se transcribe en el turno), y termina 'ok' (text = "(audio) …") o 'ilegible' (text = "(audio que no se pudo escuchar)").
export type TranscriptStatus = 'pendiente' | 'ok' | 'ilegible';
interface MessageDbRow {
  id: number; session: string; provider_msg_id: string; chat_id: string; author: Author; text: string; ts_utc: number; media: string | null; edited: number; revoked: number;
  media_url: string | null; media_mime: string | null; transcript_status: TranscriptStatus | null;
}
const toMessage = (r: MessageDbRow): MessageRow => ({
  id: r.id, session: r.session, providerMsgId: r.provider_msg_id, chatId: r.chat_id, author: r.author, text: r.text, tsUtcMs: r.ts_utc,
  media: r.media, edited: !!r.edited, revoked: !!r.revoked, mediaUrl: r.media_url, mediaMime: r.media_mime, transcriptStatus: r.transcript_status,
});

// Un NUL en el texto corta el valor al guardarlo en SQLite (se perdería el resto del mensaje): se saca antes de guardar.
const noNul = (text: string): string => text.replaceAll('\0', '');

// Un mismo (sesión, id del proveedor) se guarda una sola vez: el segundo intento devuelve inserted=false.
export function insertMessage(db: Db, m: {
  session: string; providerMsgId: string; chatId: string; author: Author; text: string; tsUtcMs: number; media?: string; mediaUrl?: string; mediaMime?: string; transcriptStatus?: TranscriptStatus;
}): { id: number; inserted: boolean } {
  const r = run(db, 'INSERT INTO messages (session, provider_msg_id, chat_id, author, text, ts_utc, media, media_url, media_mime, transcript_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session, provider_msg_id) DO NOTHING',
    m.session, m.providerMsgId, m.chatId, m.author, noNul(m.text), m.tsUtcMs, m.media ?? null, m.mediaUrl ?? null, m.mediaMime ?? null, m.transcriptStatus ?? null);
  if (r.changes > 0) return { id: Number(r.lastInsertRowid), inserted: true };
  return { id: findMessage(db, m.session, m.providerMsgId)!.id, inserted: false };
}

// Por id exacto o, si WAHA manda solo el tramo final del id (revoked/edited), por sufijo "_<id>".
export function findMessage(db: Db, session: string, providerMsgId: string): MessageRow | undefined {
  const exact = one<MessageDbRow>(db, 'SELECT * FROM messages WHERE session = ? AND provider_msg_id = ?', session, providerMsgId);
  if (exact) return toMessage(exact);
  if (!providerMsgId || providerMsgId.includes('_')) return undefined;
  const suffix = `_${providerMsgId}`;
  const r = one<MessageDbRow>(db, 'SELECT * FROM messages WHERE session = ? AND length(provider_msg_id) > ? AND substr(provider_msg_id, -?) = ? ORDER BY id DESC LIMIT 1', session, suffix.length, suffix.length, suffix);
  return r && toMessage(r);
}

export const getMessage = (db: Db, id: number): MessageRow | undefined => {
  const r = one<MessageDbRow>(db, 'SELECT * FROM messages WHERE id = ?', id);
  return r && toMessage(r);
};
export const editMessage = (db: Db, id: number, text: string): void => void run(db, 'UPDATE messages SET text = ?, edited = 1 WHERE id = ?', noNul(text), id);
export const revokeMessage = (db: Db, id: number): void => void run(db, 'UPDATE messages SET revoked = 1 WHERE id = ?', id);
// El audio ya se transcribió (o quedó ilegible): el texto pasa a ser el que ve el modelo. No sube la versión del contexto: es el mismo mensaje (ya la subió al llegar).
export const setTranscript = (db: Db, id: number, text: string, status: 'ok' | 'ilegible'): void =>
  void run(db, "UPDATE messages SET text = ?, transcript_status = ? WHERE id = ? AND transcript_status = 'pendiente'", noNul(text), status, id);

// ¿El bot ya le dijo algo al cliente (un mensaje suyo con texto, registrado al salir o por el eco)? Con `text`: ¿alguno de sus mensajes lo contiene?
export const botSaid = (db: Db, chatId: string, text?: string): boolean =>
  !!(text === undefined
    ? one(db, "SELECT 1 AS x FROM messages WHERE chat_id = ? AND author = 'bot' AND text <> '' LIMIT 1", chatId)
    : one(db, "SELECT 1 AS x FROM messages WHERE chat_id = ? AND author = 'bot' AND instr(text, ?) > 0 LIMIT 1", chatId, text));

// Lo que ve el modelo: los últimos `limit` mensajes con texto y sin borrar, en orden de llegada, con id "m<id>".
export function historyFor(db: Db, chatId: string, limit = 30): ChatMessage[] {
  const rows = all<MessageDbRow>(db, "SELECT * FROM messages WHERE chat_id = ? AND revoked = 0 AND text <> '' ORDER BY id DESC LIMIT ?", chatId, limit);
  return rows.reverse().map((r) => ({ id: `m${r.id}`, author: r.author, text: r.text, tsUtcMs: r.ts_utc }));
}

// Mensajes del cliente sin contestar: con texto (o un audio todavía sin transcribir), sin borrar y posteriores a lo último contestado (por el bot o por el equipo).
// Un audio pendiente no se le muestra al modelo (historyFor lo saltea: no tiene texto): el worker lo transcribe antes de armar el turno.
export function unansweredMessages(db: Db, chatId: string): MessageRow[] {
  return all<MessageDbRow>(db, `SELECT * FROM messages
    WHERE chat_id = ? AND author = 'customer' AND revoked = 0 AND (text <> '' OR transcript_status = 'pendiente')
      AND id > MAX((SELECT answered_upto FROM conversations WHERE chat_id = ?), COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = ? AND author = 'team'), 0))
    ORDER BY id`, chatId, chatId, chatId).map(toMessage);
}

// ---------- Eventos entrantes ----------
export interface InboundRow { id: number; eventKey: string; payload: string; attempts: number }

// true si es nuevo; false si ya estaba (reintento de WAHA).
export function storeInboundEvent(db: Db, eventKey: string, payload: string, nowMs: number): boolean {
  return run(db, 'INSERT INTO inbound_events (event_key, payload, received_utc) VALUES (?, ?, ?) ON CONFLICT (event_key) DO NOTHING', eventKey, payload, nowMs).changes > 0;
}

// Toma los eventos nuevos cuyo lock venció (o que nunca tuvieron) y les pone un lock: si el proceso muere, se recuperan solos.
export function claimInboundEvents(db: Db, nowMs: number, lockMs: number, limit: number): InboundRow[] {
  return tx(db, () => {
    const rows = all<{ id: number; event_key: string; payload: string; attempts: number }>(db,
      "SELECT id, event_key, payload, attempts FROM inbound_events WHERE status = 'nuevo' AND (locked_until IS NULL OR locked_until <= ?) ORDER BY id LIMIT ?", nowMs, limit);
    for (const r of rows) run(db, 'UPDATE inbound_events SET locked_until = ?, attempts = attempts + 1 WHERE id = ?', nowMs + lockMs, r.id);
    return rows.map((r) => ({ id: r.id, eventKey: r.event_key, payload: r.payload, attempts: r.attempts + 1 }));
  });
}
export const finishInboundEvent = (db: Db, id: number, status: 'hecho' | 'error', lastError?: string): void =>
  void run(db, 'UPDATE inbound_events SET status = ?, locked_until = NULL, last_error = ? WHERE id = ?', status, lastError ?? null, id);
export const delayInboundEvent = (db: Db, id: number, untilMs: number, lastError: string): void =>
  void run(db, "UPDATE inbound_events SET locked_until = ?, last_error = ? WHERE id = ? AND status = 'nuevo'", untilMs, lastError, id);
// Cuándo conviene volver a mirar los eventos pendientes (el lock más cercano), o undefined si no hay.
export const nextInboundWake = (db: Db): number | undefined =>
  one<{ t: number | null }>(db, "SELECT MIN(COALESCE(locked_until, 0)) AS t FROM inbound_events WHERE status = 'nuevo'")?.t ?? undefined;
export const pendingInboundCount = (db: Db): number => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM inbound_events WHERE status = 'nuevo'")!.n;

// ---------- Salida (outbox) ----------
export type OutboxStatus = 'pendiente' | 'en_proceso' | 'aceptado' | 'incierto' | 'fallido' | 'cancelado' | 'vencido';
export interface OutboxRow {
  id: number;
  logicalKey: string;
  chatId: string;
  kind: 'text' | 'image';
  body: string;
  status: OutboxStatus;
  attempt: number;
  expiresUtc: number;
  providerMsgId: string | null;
  cause: string | null;
  contextVersion: number;
  createdUtc: number;
  attemptedUtc: number | null;
  nextTryUtc: number | null;
  ack: string | null;
  answersUpto: number;
}
interface OutboxDbRow {
  id: number; logical_key: string; chat_id: string; kind: 'text' | 'image'; body: string; status: OutboxStatus; attempt: number; expires_utc: number;
  provider_msg_id: string | null; cause: string | null; context_version: number; created_utc: number; attempted_utc: number | null; next_try_utc: number | null;
  ack: string | null; answers_upto: number;
}
const toOutbox = (r: OutboxDbRow): OutboxRow => ({
  id: r.id, logicalKey: r.logical_key, chatId: r.chat_id, kind: r.kind, body: r.body, status: r.status, attempt: r.attempt, expiresUtc: r.expires_utc,
  providerMsgId: r.provider_msg_id, cause: r.cause, contextVersion: r.context_version, createdUtc: r.created_utc, attemptedUtc: r.attempted_utc,
  nextTryUtc: r.next_try_utc, ack: r.ack, answersUpto: r.answers_upto,
});

// La clave lógica es única: encolar dos veces la misma respuesta no duplica nada (devuelve false).
export function insertOutbox(db: Db, o: { logicalKey: string; chatId: string; kind: 'text' | 'image'; body: string; expiresUtc: number; contextVersion: number; createdUtc: number; answersUpto: number }): boolean {
  return run(db, 'INSERT INTO outbox (logical_key, chat_id, kind, body, expires_utc, context_version, created_utc, answers_upto) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (logical_key) DO NOTHING',
    o.logicalKey, o.chatId, o.kind, o.body, o.expiresUtc, o.contextVersion, o.createdUtc, o.answersUpto).changes > 0;
}
export const getOutbox = (db: Db, id: number): OutboxRow | undefined => {
  const r = one<OutboxDbRow>(db, 'SELECT * FROM outbox WHERE id = ?', id);
  return r && toOutbox(r);
};
export const listOutbox = (db: Db, chatId?: string): OutboxRow[] =>
  (chatId ? all<OutboxDbRow>(db, 'SELECT * FROM outbox WHERE chat_id = ? ORDER BY id', chatId) : all<OutboxDbRow>(db, 'SELECT * FROM outbox ORDER BY id')).map(toOutbox);
export const outboxByProviderId = (db: Db, providerMsgId: string): OutboxRow | undefined => {
  const r = one<OutboxDbRow>(db, 'SELECT * FROM outbox WHERE provider_msg_id = ?', providerMsgId);
  return r && toOutbox(r);
};
// ¿Ya hay una respuesta para esta versión del contexto? Evita volver a gastar en lo mismo. Lo cancelado o vencido no cuenta: ese contexto sigue sin respuesta.
export const outboxHasVersion = (db: Db, chatId: string, version: number): boolean =>
  !!one(db, "SELECT 1 AS x FROM outbox WHERE chat_id = ? AND context_version = ? AND status NOT IN ('cancelado','vencido') LIMIT 1", chatId, version);

// El próximo a mandar: el más viejo pendiente de cada chat, siempre que antes no haya otro en proceso o incierto (el orden de los globos se respeta).
export function nextPendingOutbox(db: Db, nowMs: number): OutboxRow | undefined {
  const r = one<OutboxDbRow>(db, `SELECT o.* FROM outbox o
    WHERE o.status = 'pendiente'
      AND o.id = (SELECT MIN(p.id) FROM outbox p WHERE p.chat_id = o.chat_id AND p.status IN ('pendiente','en_proceso','incierto'))
      AND (o.next_try_utc IS NULL OR o.next_try_utc <= ?)
    ORDER BY o.id LIMIT 1`, nowMs);
  return r && toOutbox(r);
}
// Por qué una fila de salida ya no vale: el cliente escribió de nuevo (versión vieja), el chat dejó de ser del bot o alguien la marcó al cancelar mientras iba en vuelo.
// Un chat en humano con la versión al día NO es viejo: es el mensaje que cierra el chat (baja, mensaje seguro), que se manda igual.
function outboxStaleCause(db: Db, id: number): string | undefined {
  const r = one<{ cause: string | null; ov: number; mode: ConversationMode | null; cv: number | null }>(db,
    'SELECT o.cause, o.context_version AS ov, c.mode, c.context_version AS cv FROM outbox o LEFT JOIN conversations c ON c.chat_id = o.chat_id WHERE o.id = ?', id);
  if (!r) return undefined;
  if (r.cause?.startsWith(CANCEL_MARK)) return r.cause.slice(CANCEL_MARK.length);
  if (r.mode === 'pausado' || r.mode === 'cerrado') return 'humano';
  if (r.cv !== null && r.cv !== r.ov) return r.mode === 'humano' ? 'humano' : 'contexto_nuevo';
  return undefined;
}
const CANCEL_MARK = 'cancelar:'; // lo que se cancela mientras va en vuelo queda marcado en `cause` hasta que termine el envío
const cancelStale = (db: Db, id: number, cause: string): void =>
  void run(db, "UPDATE outbox SET status = 'cancelado', cause = ?, next_try_utc = NULL WHERE id = ? AND status IN ('pendiente','en_proceso')", cause, id);
// Pasa a en_proceso solo si sigue valiendo; si quedó viejo, se cancela acá y no se manda.
export function claimOutbox(db: Db, id: number, nowMs: number): boolean {
  if (getOutbox(db, id)?.status !== 'pendiente') return false;
  const stale = outboxStaleCause(db, id);
  if (stale) return cancelStale(db, id, stale), false;
  return run(db, "UPDATE outbox SET status = 'en_proceso', attempt = attempt + 1, attempted_utc = ? WHERE id = ? AND status = 'pendiente'", nowMs, id).changes > 0;
}
// Un envío en vuelo falló pasajero: vuelve a pendiente solo si todavía vale. Devuelve false si quedó cancelado.
export function requeueOutbox(db: Db, id: number, cause: string, nextTryUtc: number): boolean {
  const stale = outboxStaleCause(db, id);
  if (stale) return cancelStale(db, id, stale), false;
  markOutbox(db, id, 'pendiente', { cause, nextTryUtc });
  return true;
}
export function markOutbox(db: Db, id: number, status: OutboxStatus, patch: { providerMsgId?: string; cause?: string; nextTryUtc?: number | null } = {}): void {
  run(db, 'UPDATE outbox SET status = ?, provider_msg_id = COALESCE(?, provider_msg_id), cause = COALESCE(?, cause), next_try_utc = ? WHERE id = ?',
    status, patch.providerMsgId ?? null, patch.cause ?? null, patch.nextTryUtc ?? null, id);
}
export const setOutboxAck =(db: Db, id: number, ack: string): void => void run(db, 'UPDATE outbox SET ack = ? WHERE id = ?', ack, id);
// Vence lo pendiente que pasó su hora y devuelve los chats afectados (para avisar y regenerar).
export function expireOutbox(db: Db, nowMs: number): string[] {
  const chats = all<{ chat_id: string }>(db, "SELECT DISTINCT chat_id FROM outbox WHERE status = 'pendiente' AND expires_utc <= ?", nowMs).map((r) => r.chat_id);
  if (chats.length) run(db, "UPDATE outbox SET status = 'vencido', cause = 'vencido' WHERE status = 'pendiente' AND expires_utc <= ?", nowMs);
  return chats;
}
// Lo pendiente del chat se cancela (toma humana, mensaje nuevo del cliente, falla de un globo anterior). `olderThanVersion`: solo lo de versiones anteriores.
// Lo que ya va en vuelo (en_proceso) no se puede frenar: queda marcado y, si el envío falla pasajero, no vuelve a la cola.
export function cancelChatOutbox(db: Db, chatId: string, cause: string, olderThanVersion?: number): number {
  const below = olderThanVersion ?? Number.MAX_SAFE_INTEGER;
  run(db, "UPDATE outbox SET cause = ? WHERE chat_id = ? AND status = 'en_proceso' AND context_version < ?", CANCEL_MARK + cause, chatId, below);
  return run(db, "UPDATE outbox SET status = 'cancelado', cause = ?, next_try_utc = NULL WHERE chat_id = ? AND status = 'pendiente' AND context_version < ?", cause, chatId, below).changes as number;
}
// Al prender: lo que estaba en_proceso cuando murió el proceso pudo haber salido o no. Pasa a incierto y se concilia con el historial: nunca se reenvía a ciegas.
export const recoverOutbox = (db: Db, nowMs: number): number =>
  run(db, "UPDATE outbox SET status = 'incierto', cause = 'reinicio', attempted_utc = COALESCE(attempted_utc, ?), next_try_utc = ? WHERE status = 'en_proceso'", nowMs, nowMs).changes as number;
// Filas sin id de WAHA todavía que podrían ser el eco de este texto: en proceso, inciertas o falladas por "no confirmado" hace poco.
export function outboxEchoCandidates(db: Db, chatId: string, sinceMs: number): OutboxRow[] {
  return all<OutboxDbRow>(db, `SELECT * FROM outbox WHERE chat_id = ? AND provider_msg_id IS NULL
    AND (status IN ('en_proceso','incierto') OR (status = 'fallido' AND cause = 'no_confirmado' AND attempted_utc >= ?)) ORDER BY id`, chatId, sinceMs).map(toOutbox);
}
export const dueIncierto = (db: Db, nowMs: number): OutboxRow[] =>
  all<OutboxDbRow>(db, "SELECT * FROM outbox WHERE status = 'incierto' AND (next_try_utc IS NULL OR next_try_utc <= ?) ORDER BY id", nowMs).map(toOutbox);
// Cuándo hay que volver a mirar la salida (reintento de un pendiente o conciliación de un incierto), o undefined.
export const nextOutboxWake = (db: Db): number | undefined =>
  one<{ t: number | null }>(db, "SELECT MIN(next_try_utc) AS t FROM outbox WHERE status IN ('pendiente','incierto') AND next_try_utc IS NOT NULL")?.t ?? undefined;
export const outboxCounts = (db: Db): Record<string, number> =>
  Object.fromEntries(all<{ status: string; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').map((r) => [r.status, r.n]));

// ---------- Borradores (modo sombra) ----------
export type DraftStatus = 'pendiente' | 'mandado' | 'descartado' | 'vencido';
export interface Draft { id: number; chatId: string; contextVersion: number; bubbles: string[]; material: string[]; status: DraftStatus; tgMessageId: number | null; createdUtc: number; answersUpto: number }
interface DraftDbRow { id: number; chat_id: string; context_version: number; bubbles_json: string; material_json: string; status: DraftStatus; tg_message_id: number | null; created_utc: number; answers_upto: number }
const toDraft = (r: DraftDbRow): Draft => ({
  id: r.id, chatId: r.chat_id, contextVersion: r.context_version, bubbles: JSON.parse(r.bubbles_json) as string[], material: JSON.parse(r.material_json) as string[],
  status: r.status, tgMessageId: r.tg_message_id, createdUtc: r.created_utc, answersUpto: r.answers_upto,
});

// Un borrador nuevo deja vencidos los pendientes anteriores del chat.
export function createDraft(db: Db, o: { chatId: string; contextVersion: number; bubbles: string[]; material: string[]; nowMs: number; answersUpto: number }): number {
  run(db, "UPDATE drafts SET status = 'vencido' WHERE chat_id = ? AND status = 'pendiente'", o.chatId);
  const r = run(db, 'INSERT INTO drafts (chat_id, context_version, bubbles_json, material_json, created_utc, answers_upto) VALUES (?, ?, ?, ?, ?, ?)',
    o.chatId, o.contextVersion, JSON.stringify(o.bubbles), JSON.stringify(o.material), o.nowMs, o.answersUpto);
  return Number(r.lastInsertRowid);
}
export const getDraft = (db: Db, id: number): Draft | undefined => {
  const r = one<DraftDbRow>(db, 'SELECT * FROM drafts WHERE id = ?', id);
  return r && toDraft(r);
};
export const listDrafts = (db: Db, chatId: string): Draft[] => all<DraftDbRow>(db, 'SELECT * FROM drafts WHERE chat_id = ? ORDER BY id', chatId).map(toDraft);
// Borradores que siguen pendientes pero nunca llegaron a Telegram (estaba caído) y todavía valen (creados desde `sinceMs`).
export const listUnnotifiedDrafts = (db: Db, sinceMs: number): Draft[] =>
  all<DraftDbRow>(db, "SELECT * FROM drafts WHERE status = 'pendiente' AND tg_message_id IS NULL AND created_utc >= ? ORDER BY id", sinceMs).map(toDraft);
export const draftHasVersion = (db: Db, chatId: string, version: number): boolean =>
  !!one(db, 'SELECT 1 AS x FROM drafts WHERE chat_id = ? AND context_version = ? LIMIT 1', chatId, version);
export const setDraftStatus = (db: Db, id: number, status: DraftStatus): void => void run(db, 'UPDATE drafts SET status = ? WHERE id = ?', status, id);
export const setDraftTelegramMessage = (db: Db, id: number, tgMessageId: number): void => void run(db, 'UPDATE drafts SET tg_message_id = ? WHERE id = ?', tgMessageId, id);
export const closePendingDrafts = (db: Db, chatId: string, status: 'descartado' | 'vencido', olderThanVersion?: number): number =>
  run(db, "UPDATE drafts SET status = ? WHERE chat_id = ? AND status = 'pendiente' AND context_version < ?", status, chatId, olderThanVersion ?? Number.MAX_SAFE_INTEGER).changes as number;

// Pasa el chat al equipo (el eco de un mensaje del celular, [Lo tomo], /humano): cancela lo pendiente (salida y borradores, aunque el turno ya haya terminado),
// sube la versión (un turno en vuelo ya no vale) y deja constancia. Devuelve true si el chat no estaba en humano.
export function switchToHuman(db: Db, chatId: string, nowMs: number, detail: string): boolean {
  cancelChatOutbox(db, chatId, 'toma_humana');
  closePendingDrafts(db, chatId, 'descartado');
  const conv = getConversation(db, chatId);
  if (!conv || conv.mode === 'humano') return false;
  setMode(db, chatId, 'humano');
  bumpVersion(db, chatId, nowMs);
  audit(db, nowMs, chatId, 'takeover', detail);
  return true;
}

// ---------- Corridas del modelo y auditoría ----------
export interface AgentRun {
  chatId: string; tsUtc: number; model: string; effort: string; policyHash: string; inputTokens: number; cachedTokens: number; outputTokens: number;
  costUsd: number; latencyMs: number; violations: { rule: string; detail: string }[]; usedFallback: boolean; errorKind?: string;
}
export function insertAgentRun(db: Db, r: AgentRun): void {
  run(db, 'INSERT INTO agent_runs (chat_id, ts_utc, model, effort, policy_hash, input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms, violations_json, used_fallback, error_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    r.chatId, r.tsUtc, r.model, r.effort, r.policyHash, r.inputTokens, r.cachedTokens, r.outputTokens, r.costUsd, r.latencyMs, JSON.stringify(r.violations), r.usedFallback ? 1 : 0, r.errorKind ?? null);
}
export const spentSince = (db: Db, sinceMs: number): number => one<{ s: number | null }>(db, 'SELECT SUM(cost_usd) AS s FROM agent_runs WHERE ts_utc >= ?', sinceMs)?.s ?? 0;
export const listAgentRuns = (db: Db, chatId?: string): { errorKind: string | null; costUsd: number; usedFallback: boolean }[] =>
  all<{ error_kind: string | null; cost_usd: number; used_fallback: number }>(db, `SELECT error_kind, cost_usd, used_fallback FROM agent_runs ${chatId ? 'WHERE chat_id = ?' : ''} ORDER BY id`, ...(chatId ? [chatId] : []))
    .map((r) => ({ errorKind: r.error_kind, costUsd: r.cost_usd, usedFallback: !!r.used_fallback }));

export type AuditKind = 'takeover' | 'handoff' | 'alert' | 'error' | 'command';
export const audit = (db: Db, nowMs: number, chatId: string | null, kind: AuditKind, detail: string): void =>
  void run(db, 'INSERT INTO audit (ts_utc, chat_id, kind, detail) VALUES (?, ?, ?, ?)', nowMs, chatId, kind, detail);
export const listAudit = (db: Db, kind?: AuditKind): { tsUtc: number; chatId: string | null; kind: AuditKind; detail: string }[] =>
  all<{ ts_utc: number; chat_id: string | null; kind: AuditKind; detail: string }>(db, `SELECT * FROM audit ${kind ? 'WHERE kind = ?' : ''} ORDER BY id`, ...(kind ? [kind] : []))
    .map((r) => ({ tsUtc: r.ts_utc, chatId: r.chat_id, kind: r.kind, detail: r.detail }));
export const auditExists = (db: Db, kind: AuditKind, detail: string, sinceMs: number): boolean =>
  !!one(db, 'SELECT 1 AS x FROM audit WHERE kind = ? AND detail = ? AND ts_utc >= ? LIMIT 1', kind, detail, sinceMs);
