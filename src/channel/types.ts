// El canal de WhatsApp visto desde el negocio: operaciones propias, no endpoints de WAHA (esos viven en channel/waha.ts).
export type MediaKind = 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'other';

export type InboundEvent =
  | { kind: 'message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; media?: MediaKind; profileName?: string }
  | { kind: 'own_message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; source: 'api' | 'app' | 'unknown' } // fromMe
  | { kind: 'edit'; session: string; chatId: string; providerMsgId: string; text: string }
  | { kind: 'revoke'; session: string; chatId: string; providerMsgId: string }
  | { kind: 'ack'; providerMsgId: string; status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' }
  | { kind: 'session_status'; session: string; status: string }
  | { kind: 'ignored'; reason: string }; // grupos, estados, canales, difusiones, sistema, historial

// uncertain: puede haberse mandado (timeout, 5xx) · restricted: 463/475 · transient: seguro que no salió, se puede reintentar · auth: clave o sesión
export type ChannelErrorType = 'uncertain' | 'restricted' | 'transient' | 'auth';

export class ChannelError extends Error {
  type: ChannelErrorType;
  code?: number;
  constructor(type: ChannelErrorType, code?: number, message?: string) {
    super(message ?? type);
    this.name = 'ChannelError';
    this.type = type;
    this.code = code;
  }
}

// El texto de un error de WAHA puede traer el chatId (teléfono): antes de que llegue a un aviso o a la auditoría se tapa el número.
export const redactChatIds = (text: string): string => text.replace(/\d{8,}@(c\.us|lid)/g, '***@$1');

export interface HistoryMessage {
  providerMsgId: string;
  fromMe: boolean;
  tsUtcMs: number;
  text: string;
}

export interface Channel {
  parseEvent(raw: unknown): InboundEvent; // nunca tira: lo que no entiende es 'ignored'
  sendText(chatId: string, text: string): Promise<{ providerMsgId: string }>;
  sendImage(chatId: string, filePath: string, caption?: string): Promise<{ providerMsgId: string }>;
  markSeen(chatId: string, providerMsgIds: string[]): Promise<void>; // si falla, no afecta la respuesta
  typing(chatId: string, on: boolean): Promise<void>; // ídem; siempre se apaga en un finally
  sessionStatus(): Promise<string>; // WORKING | SCAN_QR_CODE | STARTING | FAILED | STOPPED
  messagesSince(chatId: string, sinceUtcMs: number, limit: number): Promise<HistoryMessage[]>;
  chatsActiveSince(sinceUtcMs: number): Promise<string[]>; // para reconciliar al prender
}
