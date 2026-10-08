// Canal falso para pruebas (sin red ni WhatsApp). Guarda lo que "manda" y tiene un historial propio para conciliar envíos inciertos.
// Los eventos entrantes se arman como `{ id, inbound: <InboundEvent> }`: parseEvent los devuelve tal cual.
import type { Channel, HistoryMessage, InboundEvent } from './types.ts';
import { ChannelError, MediaUnreadableError } from './types.ts';

export interface SentMessage {
  chatId: string;
  kind: 'text' | 'image';
  text: string; // el texto, o la leyenda de la imagen ('' si no tiene)
  filePath?: string;
  providerMsgId: string;
  tsUtcMs: number;
}

export class FakeChannel implements Channel {
  sent: SentMessage[] = []; // lo que WAHA efectivamente mandó
  sendCalls = 0; // llamadas a sendText/sendImage (incluidas las que fallaron)
  seen: { chatId: string; ids: string[] }[] = [];
  typingLog: { chatId: string; on: boolean }[] = [];
  status = 'WORKING';
  sessionError?: ChannelError;
  messagesSinceError?: ChannelError;
  messagesSinceCalls = 0;
  history = new Map<string, HistoryMessage[]>(); // lo que WAHA tiene guardado de cada chat
  files = new Map<string, Uint8Array | Error>(); // los archivos de WAHA por path; un Error es lo que tira la bajada de ese archivo; sin entrada: ya venció
  downloads: string[] = []; // paths que se pidieron bajar
  #now: () => number;
  #n = 0;
  #failures: { error: ChannelError; delivered: boolean }[] = [];
  #echoHook?: (m: SentMessage) => void;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  // La próxima llamada de envío falla. delivered=true: el mensaje igual salió (se perdió la respuesta, el caso incierto).
  failNextSend(error: ChannelError, opts: { delivered?: boolean } = {}): void {
    this.#failures.push({ error, delivered: opts.delivered ?? false });
  }
  // Se llama apenas WAHA "manda" algo, antes de devolver la respuesta: sirve para simular un eco que llega antes que el id.
  onSent(hook: (m: SentMessage) => void): void {
    this.#echoHook = hook;
  }
  addHistory(chatId: string, m: HistoryMessage): void {
    this.history.set(chatId, [...(this.history.get(chatId) ?? []), m]);
  }
  // El evento que WAHA mandaría como eco de un envío propio.
  echoOf(m: SentMessage, source: 'api' | 'app' | 'unknown' = 'api'): InboundEvent {
    return { kind: 'own_message', session: 'default', chatId: m.chatId, providerMsgId: m.providerMsgId, tsUtcMs: m.tsUtcMs, text: m.text, source };
  }

  parseEvent(raw: unknown): InboundEvent {
    const inbound = typeof raw === 'object' && raw !== null ? (raw as { inbound?: unknown }).inbound : undefined;
    return typeof inbound === 'object' && inbound !== null && typeof (inbound as { kind?: unknown }).kind === 'string' ? (inbound as InboundEvent) : { kind: 'ignored', reason: 'fake_unknown' };
  }

  async #send(chatId: string, kind: 'text' | 'image', text: string, filePath?: string): Promise<{ providerMsgId: string }> {
    await Promise.resolve();
    this.sendCalls++;
    const failure = this.#failures.shift();
    if (failure && !failure.delivered) throw failure.error;
    const m: SentMessage = { chatId, kind, text, filePath, providerMsgId: `true_${chatId}_FAKE${++this.#n}`, tsUtcMs: this.#now() };
    this.sent.push(m);
    this.addHistory(chatId, { providerMsgId: m.providerMsgId, fromMe: true, tsUtcMs: m.tsUtcMs, text });
    this.#echoHook?.(m);
    if (failure) throw failure.error;
    return { providerMsgId: m.providerMsgId };
  }

  sendText(chatId: string, text: string) {
    return this.#send(chatId, 'text', text);
  }
  sendImage(chatId: string, filePath: string, caption?: string) {
    return this.#send(chatId, 'image', caption ?? '', filePath);
  }
  async markSeen(chatId: string, providerMsgIds: string[]): Promise<void> {
    this.seen.push({ chatId, ids: providerMsgIds });
  }
  async typing(chatId: string, on: boolean): Promise<void> {
    this.typingLog.push({ chatId, on });
  }
  async sessionStatus(): Promise<string> {
    if (this.sessionError) throw this.sessionError;
    return this.status;
  }
  async messagesSince(chatId: string, sinceUtcMs: number, limit: number): Promise<HistoryMessage[]> {
    this.messagesSinceCalls++;
    if (this.messagesSinceError) throw this.messagesSinceError;
    return (this.history.get(chatId) ?? []).filter((m) => m.tsUtcMs >= sinceUtcMs).slice(-limit);
  }
  async chatsActiveSince(sinceUtcMs: number): Promise<string[]> {
    return [...this.history.entries()].filter(([, ms]) => ms.some((m) => m.tsUtcMs >= sinceUtcMs)).map(([chatId]) => chatId);
  }
  async downloadMedia(path: string): Promise<Uint8Array> {
    this.downloads.push(path);
    const f = this.files.get(path);
    if (f instanceof Error) throw f;
    if (!f) throw new MediaUnreadableError('el archivo ya no está en WAHA (venció)');
    return f;
  }
}
