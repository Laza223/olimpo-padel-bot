// Adaptador de WAHA 2026.9.2 (motor WEBJS). Endpoints, cuerpos y formas de los webhooks: docs/waha-endpoints.md (Swagger real de la versión fija).
// Idea reutilizada de AXXEN (normalize.ts), sin zod: lo que no entiende es 'ignored', nunca tira.
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { ChannelError, redactChatIds } from './types.ts';
import type { Channel, HistoryMessage, InboundEvent, MediaKind } from './types.ts';

const ignored = (reason: string): InboundEvent => ({ kind: 'ignored', reason });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);

// WAHA mezcla segundos (WAMessage.timestamp) y milisegundos (el sobre del webhook): menor que 1e12 son segundos.
export function normalizeTsMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? Math.round(v * 1000) : v;
}

// Solo chats 1 a 1. El chatId se usa tal cual: nunca se reconstruye un teléfono desde un @lid.
const isDirectChat = (chatId: string): boolean => chatId.endsWith('@c.us') || chatId.endsWith('@lid');

// Tipos de whatsapp-web.js (`_data.type`) que no son mensajes del cliente. SIN VERIFICAR contra un número real (ver docs/waha-endpoints.md).
const SYSTEM_TYPES = new Set(['e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'revoked', 'ciphertext', 'call_log', 'broadcast_notification']);
const MEDIA_BY_TYPE: Record<string, MediaKind> = { image: 'image', ptt: 'audio', audio: 'audio', video: 'video', document: 'document', sticker: 'sticker' };

function mediaKind(type: string | undefined, hasMedia: boolean): MediaKind | undefined {
  if (type && MEDIA_BY_TYPE[type]) return MEDIA_BY_TYPE[type];
  if (hasMedia || type === 'location' || type === 'vcard' || type === 'multi_vcard') return 'other';
  return undefined;
}

// El texto de un mensaje. En una ubicación el body es una miniatura en base64, no texto: se ignora (llega como adjunto sin texto).
const bodyOf = (m: Record<string, unknown>): string => (isObj(m._data) && m._data.type === 'location' ? '' : typeof m.body === 'string' ? m.body : '');

const chatOf = (m: Record<string, unknown>): string | undefined => str(m.fromMe === true ? m.to : m.from);

function parseMessage(session: string, m: unknown): InboundEvent {
  if (!isObj(m)) return ignored('message_payload_invalid');
  const id = str(m.id);
  if (!id) return ignored('message_without_id');
  const fromMe = m.fromMe === true;
  const chatId = chatOf(m);
  if (!chatId) return ignored('message_without_chat');
  if (!isDirectChat(chatId)) return ignored('not_direct_chat');
  const data = isObj(m._data) ? m._data : {};
  const type = str(data.type);
  if (type && SYSTEM_TYPES.has(type)) return ignored(`system_${type}`);
  const tsUtcMs = normalizeTsMs(m.timestamp);
  if (tsUtcMs === undefined) return ignored('message_without_timestamp');
  const text = bodyOf(m);
  const media = mediaKind(type, m.hasMedia === true);
  if (!text.trim() && !media) return ignored('empty');
  if (fromMe) return { kind: 'own_message', session, chatId, providerMsgId: id, tsUtcMs, text, source: m.source === 'api' ? 'api' : m.source === 'app' ? 'app' : 'unknown' };
  const ev: Extract<InboundEvent, { kind: 'message' }> = { kind: 'message', session, chatId, providerMsgId: id, tsUtcMs, text };
  if (media) ev.media = media;
  const name = str(data.notifyName)?.trim();
  if (name) ev.profileName = name;
  return ev;
}

const ACK_BY_NUMBER: Record<number, Extract<InboundEvent, { kind: 'ack' }>['status']> = { [-1]: 'failed', 0: 'pending', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
const ACK_BY_NAME: Record<string, Extract<InboundEvent, { kind: 'ack' }>['status']> = { ERROR: 'failed', PENDING: 'pending', SERVER: 'sent', DEVICE: 'delivered', READ: 'read', PLAYED: 'read' };

function parseAck(p: unknown): InboundEvent {
  if (!isObj(p)) return ignored('ack_payload_invalid');
  const id = str(p.id);
  if (!id) return ignored('ack_without_id');
  const status = (typeof p.ack === 'number' ? ACK_BY_NUMBER[p.ack] : undefined) ?? (typeof p.ackName === 'string' ? ACK_BY_NAME[p.ackName] : undefined);
  return status ? { kind: 'ack', providerMsgId: id, status } : ignored('ack_unknown');
}

// revokedMessageId viene corto en el ejemplo del Swagger: se prefiere el id completo de "before"; la base busca también por sufijo.
function parseRevoked(session: string, p: unknown): InboundEvent {
  if (!isObj(p)) return ignored('revoked_payload_invalid');
  const src = isObj(p.before) ? p.before : isObj(p.after) ? p.after : undefined;
  const id = (isObj(p.before) ? str(p.before.id) : undefined) ?? str(p.revokedMessageId);
  if (!id) return ignored('revoked_without_id');
  const chatId = src && chatOf(src);
  if (!chatId) return ignored('revoked_without_chat');
  if (!isDirectChat(chatId)) return ignored('not_direct_chat');
  return { kind: 'revoke', session, chatId, providerMsgId: id };
}

function parseEdited(session: string, p: unknown): InboundEvent {
  if (!isObj(p)) return ignored('edited_payload_invalid');
  const id = str(p.editedMessageId) ?? str(p.id);
  if (!id) return ignored('edited_without_id');
  const chatId = chatOf(p);
  if (!chatId) return ignored('edited_without_chat');
  if (!isDirectChat(chatId)) return ignored('not_direct_chat');
  return { kind: 'edit', session, chatId, providerMsgId: id, text: typeof p.body === 'string' ? p.body : '' };
}

function parseWaha(raw: unknown): InboundEvent {
  if (!isObj(raw) || typeof raw.event !== 'string') return ignored('no_event');
  const session = str(raw.session) ?? 'default';
  switch (raw.event) {
    case 'message.any': return parseMessage(session, raw.payload);
    case 'message.ack': return parseAck(raw.payload);
    case 'message.revoked': return parseRevoked(session, raw.payload);
    case 'message.edited': return parseEdited(session, raw.payload);
    case 'session.status': {
      const status = isObj(raw.payload) ? str(raw.payload.status) : undefined;
      return status ? { kind: 'session_status', session, status } : ignored('session_status_invalid');
    }
    default: return ignored(`event_${raw.event}`);
  }
}

// ---------- Errores ----------
const NEVER_SENT = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']; // ni llegó a conectarse: seguro que no salió

function networkError(e: unknown): ChannelError {
  const name = isObj(e) ? e.name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') return new ChannelError('uncertain', undefined, 'timeout esperando a WAHA');
  const code = isObj(e) && isObj(e.cause) ? e.cause.code : undefined;
  if (typeof code === 'string' && NEVER_SENT.includes(code)) return new ChannelError('transient', undefined, `sin conexión con WAHA (${code})`);
  return new ChannelError('uncertain', undefined, redactChatIds(`error de red hablando con WAHA: ${e instanceof Error ? e.message : String(e)}`));
}

// 463 (reachout timelock) y 475 (tope de chats nuevos) de WhatsApp: solo si el error es claramente ese código: estado HTTP, "server returned error N" o un campo code.
// Un "475" suelto en un stack o en el HTML de un proxy no cuenta. SIN VERIFICAR el texto exacto contra una cuenta real.
function restrictedCode(status: number, body: string): number | undefined {
  const is = (n: unknown): n is 463 | 475 => n === 463 || n === 475;
  if (is(status)) return status;
  const text = /server returned error (463|475)\b/i.exec(body);
  if (text) return Number(text[1]);
  try {
    const json: unknown = JSON.parse(body);
    if (isObj(json)) for (const n of [json.code, json.statusCode]) if (is(n)) return n;
  } catch {
    /* no es JSON */
  }
  return undefined;
}

function httpError(status: number, body: string): ChannelError {
  const snippet = redactChatIds(body.replace(/\s+/g, ' ')).slice(0, 200); // primero se tapa el número y después se corta: un chatId partido a la mitad no escaparía
  const msg = `WAHA respondió ${status}: ${snippet}`;
  const restricted = restrictedCode(status, body);
  if (restricted) return new ChannelError('restricted', restricted, msg);
  if (status === 401 || status === 403) return new ChannelError('auth', status, msg);
  if (status >= 400 && status < 500) return new ChannelError('transient', status, msg); // 422 con la sesión fuera de WORKING, 429, 400…: no salió
  return new ChannelError('uncertain', status, msg); // 5xx: pudo haber salido
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export interface WahaOptions {
  baseUrl: string;
  apiKey: string;
  session?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WahaChannel implements Channel {
  #base: string;
  #key: string;
  #session: string;
  #fetch: typeof fetch;
  #timeoutMs: number;

  constructor(o: WahaOptions) {
    this.#base = o.baseUrl.replace(/\/+$/, '');
    this.#key = o.apiKey;
    this.#session = o.session ?? 'default';
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
  }

  parseEvent(raw: unknown): InboundEvent {
    try {
      return parseWaha(raw);
    } catch {
      return ignored('parse_error');
    }
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { 'X-Api-Key': this.#key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw httpError(res.status, text);
    try {
      return text.trim() ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  // WAHA aceptó el envío pero sin id: no se sabe cuál es, se concilia por texto con messagesSince (nunca se reintenta a ciegas).
  #idOf(r: unknown): { providerMsgId: string } {
    const id = isObj(r) ? str(r.id) : undefined;
    if (!id) throw new ChannelError('uncertain', undefined, 'WAHA aceptó el envío pero respondió sin id');
    return { providerMsgId: id };
  }

  async sendText(chatId: string, text: string) {
    return this.#idOf(await this.#request('POST', '/api/sendText', { session: this.#session, chatId, text }));
  }

  async sendImage(chatId: string, filePath: string, caption?: string) {
    const mimetype = MIME[extname(filePath).toLowerCase()];
    if (!mimetype) throw new ChannelError('transient', undefined, `tipo de archivo no soportado: ${basename(filePath)}`);
    let data: Buffer;
    try {
      data = await readFile(filePath);
    } catch {
      throw new ChannelError('transient', undefined, `no pude leer el archivo ${basename(filePath)}`);
    }
    const file = { mimetype, filename: basename(filePath), data: data.toString('base64') };
    return this.#idOf(await this.#request('POST', '/api/sendImage', { session: this.#session, chatId, file, ...(caption ? { caption } : {}) }));
  }

  async markSeen(chatId: string, providerMsgIds: string[]): Promise<void> {
    await this.#request('POST', '/api/sendSeen', { session: this.#session, chatId, messageIds: providerMsgIds }, 8_000);
  }

  async typing(chatId: string, on: boolean): Promise<void> {
    await this.#request('POST', on ? '/api/startTyping' : '/api/stopTyping', { session: this.#session, chatId }, 8_000);
  }

  async sessionStatus(): Promise<string> {
    try {
      const r = await this.#request('GET', `/api/sessions/${encodeURIComponent(this.#session)}`, undefined, 8_000);
      const status = isObj(r) ? str(r.status) : undefined;
      if (!status) throw new ChannelError('transient', undefined, 'WAHA no informó el estado de la sesión');
      return status;
    } catch (e) {
      if (e instanceof ChannelError && e.code === 404) return 'STOPPED'; // la sesión no existe todavía
      throw e;
    }
  }

  // Mensajes del chat desde `sinceUtcMs`, del más viejo al más nuevo. WAHA no documenta la unidad del filtro: se manda en segundos y se vuelve a filtrar acá.
  async messagesSince(chatId: string, sinceUtcMs: number, limit: number): Promise<HistoryMessage[]> {
    const q = new URLSearchParams({ limit: String(limit), sortOrder: 'desc', 'filter.timestamp.gte': String(Math.floor(sinceUtcMs / 1000)), merge: 'false' });
    const r = await this.#request('GET', `/api/${encodeURIComponent(this.#session)}/chats/${encodeURIComponent(chatId)}/messages?${q}`);
    if (!Array.isArray(r)) throw new ChannelError('transient', undefined, 'WAHA no devolvió una lista de mensajes');
    const out: HistoryMessage[] = [];
    for (const m of r) {
      if (!isObj(m)) continue;
      const id = str(m.id);
      const tsUtcMs = normalizeTsMs(m.timestamp);
      if (!id || tsUtcMs === undefined || tsUtcMs < sinceUtcMs) continue;
      out.push({ providerMsgId: id, fromMe: m.fromMe === true, tsUtcMs, text: bodyOf(m) });
    }
    return out.sort((a, b) => a.tsUtcMs - b.tsUtcMs);
  }

  // Forma de la respuesta SIN VERIFICAR (el Swagger no la declara): se lee `id` y `lastMessage.timestamp` y lo que no encaja se descarta.
  async chatsActiveSince(sinceUtcMs: number): Promise<string[]> {
    const r = await this.#request('GET', `/api/${encodeURIComponent(this.#session)}/chats/overview?limit=100&merge=false`);
    if (!Array.isArray(r)) throw new ChannelError('transient', undefined, 'WAHA no devolvió una lista de chats');
    const out: string[] = [];
    for (const c of r) {
      if (!isObj(c)) continue;
      const id = str(c.id);
      const last = isObj(c.lastMessage) ? normalizeTsMs(c.lastMessage.timestamp) : undefined;
      if (id && isDirectChat(id) && last !== undefined && last >= sinceUtcMs) out.push(id);
    }
    return out;
  }
}
