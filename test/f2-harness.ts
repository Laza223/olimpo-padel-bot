// Armado completo de la tubería para las pruebas de F2 parte A: canal falso + base en memoria + ingest + worker + outbox,
// con reloj y avisos falsos. Los eventos entran por el camino real: webhook firmado → base → ingest.
import { FakeChannel } from '../src/channel/fake.ts';
import { WahaChannel } from '../src/channel/waha.ts';
import type { InboundEvent, MediaFile, MediaKind } from '../src/channel/types.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { FakeLlm } from '../src/fakeLlm.ts';
import { handleWebhook, signBody } from '../src/http.ts';
import { createIngest } from '../src/ingest.ts';
import { createOutbox } from '../src/outbox.ts';
import { ensureBotStart, setSetting } from '../src/settings.ts';
import type { SettingKey } from '../src/settings.ts';
import type { BrainConfig, LlmClient } from '../src/types.ts';
import { createWorker } from '../src/worker.ts';
import { ScriptedAudio } from './f2b-audio-helpers.ts';
import { FakeClock, FakeNotifier, ScriptedLlm, SECRET, policy } from './f2-helpers.ts';

export interface HarnessOpts {
  shadow?: boolean; // por defecto apagado: las respuestas salen al cliente
  settings?: Partial<Record<SettingKey, string>>;
  llm?: LlmClient;
  config?: BrainConfig;
  audio?: ScriptedAudio; // por defecto uno nuevo (conversor y transcriptor falsos)
  botStartAgoMs?: number; // el bot "arrancó" hace tanto (para chats con historia anterior)
  random?: () => number; // el azar de las esperas de lectura y de "escribiendo"; por defecto fijo en 0,5 (vale justo 1) para que las pruebas sean exactas
}

let seq = 0;
export function makeHarness(o: HarnessOpts = {}) {
  const clock = new FakeClock();
  const db: Db = openDb(':memory:');
  setSetting(db, 'shadow_mode', o.shadow ? '1' : '0');
  for (const [k, v] of Object.entries(o.settings ?? {})) setSetting(db, k, v);
  ensureBotStart(db, clock.now() - (o.botStartAgoMs ?? 0));
  const channel = new FakeChannel(() => clock.now());
  const notifier = new FakeNotifier();
  const llm = o.llm ?? new FakeLlm(policy);
  const audio = o.audio ?? new ScriptedAudio();
  const random = o.random ?? (() => 0.5);
  const outbox = createOutbox({ db, channel, notifier, clock, random, onExpired: (chatId) => worker.onCustomerMessage(chatId) });
  const worker = createWorker({ db, channel, llm, policy, config: o.config ?? { model: 'gpt-6.1-sol', effort: 'low' }, audio, notifier, clock, random, kickOutbox: () => outbox.kick() });
  const ingest = createIngest({ db, channel, clock, notifier, onCustomerMessage: (chatId) => worker.onCustomerMessage(chatId), onOutboxChange: () => outbox.kick() });
  const webhook = { db, secret: SECRET, clock, onStored: () => ingest.kick() };

  // Entrega un evento por el camino real: webhook firmado → base → ingest.
  const deliver = (event: InboundEvent, eventId = `evt_${++seq}`) => {
    const raw = JSON.stringify({ id: eventId, inbound: event });
    return handleWebhook(webhook, raw, signBody(raw, SECRET));
  };
  const customerEvent = (chatId: string, text: string, x: { id?: string; media?: MediaKind; mediaFile?: MediaFile; profileName?: string; tsUtcMs?: number } = {}): InboundEvent => ({
    kind: 'message', session: 'default', chatId, providerMsgId: x.id ?? `false_${chatId}_M${++seq}`, tsUtcMs: x.tsUtcMs ?? clock.now(), text,
    ...(x.media ? { media: x.media } : {}), ...(x.mediaFile ? { mediaFile: x.mediaFile } : {}), ...(x.profileName ? { profileName: x.profileName } : {}),
  });
  // El cliente escribe: WAHA también lo tiene en su historial del chat.
  const say = (chatId: string, text: string, x: Parameters<typeof customerEvent>[2] = {}) => {
    const ev = customerEvent(chatId, text, x) as Extract<InboundEvent, { kind: 'message' }>;
    channel.addHistory(chatId, { providerMsgId: ev.providerMsgId, fromMe: false, tsUtcMs: ev.tsUtcMs, text });
    return deliver(ev);
  };
  // Un audio del cliente: WAHA lo guardó en `path` (el canal falso lo "baja" de ahí). `file: null` = WAHA no mandó archivo; `bytes` = lo que hay en el path (un Error = lo que tira la bajada; null = ya venció).
  const sayAudio = (chatId: string, x: { id?: string; file?: MediaFile | null; bytes?: Uint8Array | Error | null; tsUtcMs?: number } = {}) => {
    const id = x.id ?? `false_${chatId}_A${++seq}`;
    const path = `/api/files/${id}.oga`;
    if (x.bytes !== null) channel.files.set(path, x.bytes ?? new Uint8Array([1, 2, 3]));
    const ev = customerEvent(chatId, '', { id, media: 'audio', ...(x.file === null ? {} : { mediaFile: x.file ?? { path, mime: 'audio/ogg; codecs=opus' } }), tsUtcMs: x.tsUtcMs }) as Extract<InboundEvent, { kind: 'message' }>;
    channel.addHistory(chatId, { providerMsgId: ev.providerMsgId, fromMe: false, tsUtcMs: ev.tsUtcMs, text: '' });
    return { path, id, res: deliver(ev) };
  };
  const ownEvent = (chatId: string, text: string, x: { id?: string; source?: 'api' | 'app' | 'unknown' } = {}): InboundEvent => ({
    kind: 'own_message', session: 'default', chatId, providerMsgId: x.id ?? `true_${chatId}_H${++seq}`, tsUtcMs: clock.now(), text, source: x.source ?? 'app',
  });
  // Eventos con la forma real de WAHA (docs/waha-endpoints.md): el canal falso usa el traductor de verdad.
  const waha = new WahaChannel({ baseUrl: 'http://waha:3000', apiKey: 'k' });
  const useWahaParser = () => { channel.parseEvent = (raw) => waha.parseEvent(raw); };
  const deliverRaw = (envelope: object) => {
    const raw = JSON.stringify(envelope);
    return handleWebhook(webhook, raw, signBody(raw, SECRET));
  };
  const wahaMessage = (x: { from?: string; to?: string; fromMe?: boolean; body: string; source?: string; id?: string; type?: string; timestampSec?: number }) => ({
    id: `evt_${++seq}`, timestamp: clock.now(), event: 'message.any', session: 'default', me: null, engine: 'WEBJS',
    payload: { id: x.id ?? `${x.fromMe ? 'true' : 'false'}_${x.fromMe ? x.to : x.from}_W${++seq}`, timestamp: x.timestampSec ?? Math.floor(clock.now() / 1000), from: x.from ?? '', to: x.to ?? '5491100000000@c.us', fromMe: !!x.fromMe, body: x.body, hasMedia: false, source: x.source, ack: 1, _data: { type: x.type ?? 'chat' } },
  });
  const texts = (chatId?: string) => channel.sent.filter((m) => m.kind === 'text' && (!chatId || m.chatId === chatId)).map((m) => m.text);
  const llmCalls = () => (llm instanceof FakeLlm ? llm.calls : llm instanceof ScriptedLlm ? llm.calls.length : -1);
  return { clock, db, channel, notifier, llm, audio, outbox, worker, ingest, deliver, deliverRaw, wahaMessage, useWahaParser, customerEvent, say, sayAudio, ownEvent, texts, llmCalls, stop: () => { worker.stop(); outbox.stop(); ingest.stop(); } };
}
export type Harness = ReturnType<typeof makeHarness>;
