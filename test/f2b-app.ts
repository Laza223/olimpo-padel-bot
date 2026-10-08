// Arma la app completa (src/main.ts) para las pruebas de F2 parte B: canal falso, cerebro falso, Telegram y WAHA falsos como fetch, reloj falso y base en memoria.
// Los eventos entran por HTTP de verdad (127.0.0.1, puerto libre) con el HMAC real: se prueba también el cableado de /waha → ingest → worker.
import { FakeChannel } from '../src/channel/fake.ts';
import { afterEach } from 'node:test';
import type { AudioDeps } from '../src/audio.ts';
import type { InboundEvent, MediaFile, MediaKind } from '../src/channel/types.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { signBody } from '../src/http.ts';
import { createApp } from '../src/main.ts';
import { setSetting } from '../src/settings.ts';
import type { LlmClient } from '../src/types.ts';
import { FakeClock, SECRET } from './f2-helpers.ts';
import { FakeTelegram, FakeWaha, TG_GROUP, TG_TOKEN, WAHA_KEY } from './f2b-helpers.ts';

export const HC_URL = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';

export interface BootOpts {
  env?: Record<string, string | undefined>;
  shadow?: boolean; // por defecto apagado: las respuestas salen al cliente (en producción arranca prendido)
  llm?: LlmClient;
  audio?: AudioDeps; // sin esto, el de BOT_LLM (con "fake": ffmpeg real y transcriptor falso)
  db?: Db;
  clock?: FakeClock;
  channel?: FakeChannel;
  waha?: FakeWaha;
  tg?: FakeTelegram;
  settings?: Record<string, string>;
  start?: boolean; // false: se arma pero no se arranca (para sembrar la base antes)
}

let seq = 0;
// Toda app que se arma se apaga al terminar cada prueba, pase o falle: si no, el puerto y los temporizadores dejan el proceso colgado.
const live = new Set<{ shutdown(): Promise<void> }>();
afterEach(async () => {
  await Promise.all([...live].map((a) => a.shutdown()));
  live.clear();
});

export async function bootApp(o: BootOpts = {}) {
  const clock = o.clock ?? new FakeClock();
  const db = o.db ?? openDb(':memory:');
  if (!o.db) setSetting(db, 'shadow_mode', o.shadow ? '1' : '0');
  for (const [k, v] of Object.entries(o.settings ?? {})) setSetting(db, k, v);
  const channel = o.channel ?? new FakeChannel(() => clock.now());
  const waha = o.waha ?? new FakeWaha();
  const tg = o.tg ?? new FakeTelegram();
  const pings: string[] = [];
  const logs: string[] = [];
  const router: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.telegram.org/')) return tg.fetch(input, init);
    if (url.startsWith('https://hc-ping.com/')) {
      pings.push(url);
      return new Response('OK');
    }
    if (url.startsWith('http://waha:3000')) return waha.fetch(input, init);
    throw new Error(`url inesperada en la prueba: ${url}`);
  };
  const env = {
    WAHA_API_KEY: WAHA_KEY, WAHA_WEBHOOK_HMAC_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_GROUP_ID: TG_GROUP, HEALTHCHECKS_PING_URL: HC_URL, BOT_LLM: 'fake',
    ...o.env,
  };
  const app = createApp({ env, clock, fetch: router, channel, llm: o.llm, audio: o.audio, db, port: 0, host: '127.0.0.1', log: (l) => logs.push(l), shutdownWaitMs: 50 });
  live.add(app);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
  if (o.start !== false) {
    await app.start();
    await settle();
  }

  // Un evento por HTTP, firmado como lo hace WAHA.
  const post = async (event: InboundEvent, eventId = `evt_${++seq}`): Promise<number> => {
    const raw = JSON.stringify({ id: eventId, inbound: event });
    const res = await fetch(`http://127.0.0.1:${app.port()}/waha`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Hmac': signBody(raw, SECRET) }, body: raw });
    await res.arrayBuffer();
    return res.status;
  };
  const customerEvent = (chatId: string, text: string, x: { id?: string; media?: MediaKind; mediaFile?: MediaFile; tsUtcMs?: number } = {}): Extract<InboundEvent, { kind: 'message' }> => ({
    kind: 'message', session: 'default', chatId, providerMsgId: x.id ?? `false_${chatId}_M${++seq}`, tsUtcMs: x.tsUtcMs ?? clock.now(), text, ...(x.media ? { media: x.media } : {}), ...(x.mediaFile ? { mediaFile: x.mediaFile } : {}),
  });
  // El cliente escribe: WAHA también lo guarda en el historial del chat.
  const say = async (chatId: string, text: string, x: Parameters<typeof customerEvent>[2] = {}) => {
    const ev = customerEvent(chatId, text, x);
    channel.addHistory(chatId, { providerMsgId: ev.providerMsgId, fromMe: false, tsUtcMs: ev.tsUtcMs, text });
    return post(ev);
  };
  const texts = (chatId?: string) => channel.sent.filter((m) => m.kind === 'text' && (!chatId || m.chatId === chatId)).map((m) => m.text);
  return { app, clock, db, channel, waha, tg, pings, logs, post, say, customerEvent, texts, settle };
}
export type BootedApp = Awaited<ReturnType<typeof bootApp>>;
