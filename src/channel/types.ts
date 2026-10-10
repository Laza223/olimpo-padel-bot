// El canal de WhatsApp visto desde el negocio: operaciones propias, no endpoints de WAHA (esos viven en channel/waha.ts).
export type MediaKind = 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'other';

// El archivo de un adjunto de audio. `path` ya lo validó el canal (solo se baja del propio WAHA, nunca de un host que venga en el mensaje); sin `path` no hay nada que bajar.
export interface MediaFile {
  path?: string;
  mime?: string;
  error?: boolean; // WAHA avisó que no pudo bajar el archivo
}

export type InboundEvent =
  | { kind: 'message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; media?: MediaKind; mediaFile?: MediaFile; profileName?: string }
  | { kind: 'own_message'; session: string; chatId: string; providerMsgId: string; tsUtcMs: number; text: string; source: 'api' | 'app' | 'unknown'; media?: MediaKind } // fromMe
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

// Un archivo que no se va a poder leer nunca (vencido en WAHA, demasiado grande, ruta no permitida): no se reintenta, el audio queda ilegible.
// Cualquier otro error al bajar (red, 5xx, clave) es pasajero y se reintenta con espera.
// `kind` marca lo que hace sospechar de la instalación o de OpenAI y no del audio (ffmpeg que falla, rechazo de OpenAI, transcripción mal configurada o que no responde): esos avisan al equipo.
export type UnreadableKind = 'ffmpeg' | 'rechazo' | 'config' | 'no_responde';
export class MediaUnreadableError extends Error {
  kind?: UnreadableKind;
  constructor(message: string, kind?: UnreadableKind) {
    super(message);
    this.name = 'MediaUnreadableError';
    this.kind = kind;
  }
}

// El texto de un error de WAHA puede traer el chatId (teléfono): antes de que llegue a un aviso o a la auditoría se tapa el número.
export const redactChatIds = (text: string): string => text.replace(/\d{8,}@(c\.us|lid)/g, '***@$1');

export interface HistoryMessage {
  providerMsgId: string;
  fromMe: boolean;
  tsUtcMs: number;
  text: string;
  media?: MediaKind; // el cliente mandó un adjunto (solo se mira en los mensajes entrantes sin texto)
  mediaFile?: MediaFile; // y, si es un audio, dónde bajarlo
}

export interface Channel {
  parseEvent(raw: unknown): InboundEvent; // nunca tira: lo que no entiende es 'ignored'
  sendText(chatId: string, text: string): Promise<{ providerMsgId: string }>;
  sendImage(chatId: string, filePath: string, caption?: string): Promise<{ providerMsgId: string }>;
  sendFile(chatId: string, filePath: string, opts: { filename: string; caption?: string }): Promise<{ providerMsgId: string }>; // un PDF que manda el equipo (el presupuesto)
  markSeen(chatId: string, providerMsgIds: string[]): Promise<void>; // si falla, no afecta la respuesta
  typing(chatId: string, on: boolean): Promise<void>; // ídem; siempre se apaga en un finally
  sessionStatus(): Promise<string>; // WORKING | SCAN_QR_CODE | STARTING | FAILED | STOPPED
  messagesSince(chatId: string, sinceUtcMs: number, limit: number): Promise<HistoryMessage[]>;
  chatsActiveSince(sinceUtcMs: number): Promise<string[]>; // para reconciliar al prender
  downloadMedia(path: string): Promise<Uint8Array>; // el archivo de un audio (el `path` de MediaFile); MediaUnreadableError si ya no se puede leer, cualquier otro error es pasajero
}
