// Audios con WAHA (F2b): la forma de `payload.media`, el path que se acepta (nunca el host del mensaje), la bajada con tope de tiempo y de 16 MB, y el camino completo hasta el turno.
// La forma real de `payload.media` en WEBJS está SIN VERIFICAR con un número real (docs/waha-endpoints.md): acá se prueba lo que dicen los docs de WAHA y entradas defensivas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelError, MediaUnreadableError } from '../src/channel/types.ts';
import { WahaChannel, safeMediaPath } from '../src/channel/waha.ts';
import { listAudit } from '../src/db.ts';
import { UNREADABLE_AUDIO_TEXT } from '../src/audio.ts';
import { ASK_FIRST } from './f2b-audio-helpers.ts';
import { makeHarness } from './f2-harness.ts';

const CHAT = '5491155550000@c.us';
const SEC = 1_791_417_457;
const MB = 1024 * 1024;
const PATH = `/api/files/false_${CHAT}_3EB0AAAA.oga`;

const channel = new WahaChannel({ baseUrl: 'http://waha:3000', apiKey: 'k', session: 'default' });
const envelope = (payload: unknown) => ({ id: 'evt_01', timestamp: SEC * 1000, event: 'message.any', session: 'default', me: null, payload, engine: 'WEBJS' });
const voice = (media: unknown, o: Record<string, unknown> = {}) => ({
  id: `false_${CHAT}_3EB0AAAA`, timestamp: SEC, from: CHAT, to: '5491100000000@c.us', fromMe: false, body: '', hasMedia: true, ack: 1, _data: { type: 'ptt', notifyName: 'Pedro' }, ...(media === undefined ? {} : { media }), ...o,
});
const parsed = (payload: unknown) => channel.parseEvent(envelope(payload)) as { kind: string; media?: string; mediaFile?: { path?: string; mime?: string; error?: boolean } };

// ---------- el path ----------
test('safeMediaPath: solo /api/files/… y se queda con el path (sin host, sin query); con ".." (también escapado), barras invertidas o fuera de /api/files/ se rechaza', () => {
  assert.equal(safeMediaPath(PATH), PATH);
  assert.equal(safeMediaPath(`http://localhost:3000${PATH}`), PATH); // el host público de WAHA no es el de la red interna: se ignora
  assert.equal(safeMediaPath(`http://evil.example${PATH}?x=1#y`), PATH); // el host del mensaje nunca se usa
  assert.equal(safeMediaPath(`//evil.example${PATH}`), PATH);
  for (const bad of [
    '/api/files/../sessions', '/api/files/../../x', 'http://waha:3000/api/files/..%2f..%2fx', '/api/files/%2e%2e/x', '/api/files/%2E%2E/x', '/api/files/a%2fb', '/api/files\\x',
    '/api/sessions/default', '/api/files', '/api/files/', '/api/filesX/a.oga', '/x/api/files/a.oga', 'http://waha:3000/', '', 'no es una url con /api/files/', null, undefined, 42, {}, `/api/files/${'a'.repeat(1100)}`,
  ]) assert.equal(safeMediaPath(bad), undefined, String(bad));
});

// ---------- el webhook ----------
test('message.any de un audio: trae el path, el tipo y nada del host; sin url, con error o sin media no hay path', () => {
  const ev = parsed(voice({ url: `http://localhost:3000${PATH}`, mimetype: 'audio/ogg; codecs=opus', filename: 'x.oga', error: null }));
  assert.deepEqual([ev.kind, ev.media], ['message', 'audio']);
  assert.deepEqual(ev.mediaFile, { path: PATH, mime: 'audio/ogg; codecs=opus' });
  assert.deepEqual(parsed(voice({ url: null, mimetype: null, filename: null, error: null })).mediaFile, {}); // WAHA no bajó el archivo
  assert.deepEqual(parsed(voice({ url: null, mimetype: 'audio/ogg', error: { message: 'timeout' } })).mediaFile, { mime: 'audio/ogg', error: true });
  assert.deepEqual(parsed(voice({ url: PATH, mimetype: 'audio/ogg', error: 'falló' })).mediaFile, { path: PATH, mime: 'audio/ogg', error: true });
  assert.deepEqual(parsed(voice(undefined)).mediaFile, {}); // hasMedia sin media
  assert.deepEqual(parsed(voice('basura')).mediaFile, {});
  assert.deepEqual(parsed(voice({ url: 'http://waha:3000/api/files/../sessions', mimetype: 'audio/ogg' })).mediaFile, { mime: 'audio/ogg' }); // path peligroso: no hay archivo
  assert.deepEqual(parsed(voice({ url: 'http://waha:3000/api/sessions/default', mimetype: 'audio/ogg' })).mediaFile, { mime: 'audio/ogg' });
  assert.equal(parsed(voice({ url: PATH, mimetype: 'audio/ogg' }, { _data: { type: 'audio' } })).media, 'audio'); // también el audio que no es nota de voz
});

test('solo el audio lleva archivo: una foto con media no lo trae (el bot no la baja), y un texto sigue igual que antes', () => {
  const image = parsed(voice({ url: '/api/files/x.jpg', mimetype: 'image/jpeg' }, { _data: { type: 'image' } }));
  assert.equal(image.media, 'image');
  assert.equal('mediaFile' in image, false);
  const text = parsed({ id: 'false_c@c.us_A', timestamp: SEC, from: CHAT, to: 'x', fromMe: false, body: 'Hola', hasMedia: false, _data: { type: 'chat' } });
  assert.equal('mediaFile' in text, false);
});

test('messagesSince: un audio de la historia trae su archivo (para la reconciliación al prender)', async () => {
  const f = fakeFetch(() => json([
    { id: 'false_c@c.us_A', timestamp: SEC + 10, fromMe: false, body: '', hasMedia: true, _data: { type: 'ptt' }, media: { url: `http://localhost:3000${PATH}`, mimetype: 'audio/ogg' } },
    { id: 'false_c@c.us_B', timestamp: SEC + 11, fromMe: false, body: '', hasMedia: true, _data: { type: 'ptt' }, media: null },
    { id: 'false_c@c.us_C', timestamp: SEC + 12, fromMe: false, body: 'hola', hasMedia: false, _data: { type: 'chat' } },
  ]));
  const got = await new WahaChannel({ baseUrl: 'http://waha:3000', apiKey: 'k', fetch: f.fetchFn }).messagesSince('c@c.us', 0, 30);
  assert.deepEqual(got.map((m) => [m.providerMsgId, m.media, m.mediaFile]), [
    ['false_c@c.us_A', 'audio', { path: PATH, mime: 'audio/ogg' }],
    ['false_c@c.us_B', 'audio', {}],
    ['false_c@c.us_C', undefined, undefined],
  ]);
});

// ---------- la bajada ----------
interface Call { url: string; headers: Record<string, string>; redirect?: string; hasSignal: boolean }
function fakeFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect, hasSignal: !!init?.signal };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchFn };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const download = (respond: (c: Call) => Response | Promise<Response>) => {
  const f = fakeFetch(respond);
  return { ...f, ch: new WahaChannel({ baseUrl: 'http://waha:3000/', apiKey: 'secreta', fetch: f.fetchFn }) };
};
// Un cuerpo que se entrega de a 1 MB y avisa si se cortó antes de terminar.
function streamOf(totalBytes: number, headers: Record<string, string> = {}) {
  const state = { sent: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent >= totalBytes) return controller.close();
      const n = Math.min(MB, totalBytes - state.sent);
      state.sent += n;
      controller.enqueue(new Uint8Array(n));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { status: 200, headers }) };
}

test('downloadMedia: GET a la WAHA_URL configurada con X-Api-Key, sin seguir redirecciones y con tope de tiempo; devuelve los bytes', async () => {
  const { ch, calls } = download(() => new Response(new Uint8Array([1, 2, 3, 4])));
  assert.deepEqual([...(await ch.downloadMedia(PATH))], [1, 2, 3, 4]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://waha:3000${PATH}`);
  assert.equal(calls[0].headers['X-Api-Key'], 'secreta');
  assert.equal(calls[0].redirect, 'error'); // la clave no puede salir a otro host por una redirección
  assert.equal(calls[0].hasSignal, true);
});

test('downloadMedia: si le llega una url completa (nunca debería: la base guarda solo el path), igual pide a la WAHA_URL y no al host ajeno', async () => {
  const { ch, calls } = download(() => new Response(new Uint8Array([7])));
  await ch.downloadMedia(`http://evil.example:9999${PATH}?token=1`);
  assert.deepEqual(calls.map((c) => c.url), [`http://waha:3000${PATH}`]);
});

test('downloadMedia: un path que no es de /api/files/ (o con "..") se rechaza sin pedir nada, aunque venga de la base', async () => {
  const { ch, calls } = download(() => new Response('x'));
  for (const bad of ['/api/sessions/default', '/api/files/../sessions', 'http://evil.example/', '/api/files/%2e%2e/x', '']) {
    await assert.rejects(ch.downloadMedia(bad), MediaUnreadableError, bad);
  }
  assert.deepEqual(calls, []);
});

test('downloadMedia: 404 o 410 (WAHA ya lo borró) y otros 4xx son un audio ilegible; la clave mala es auth; red, 5xx, 408 y 429 son pasajeros', async () => {
  const status = (s: number) => download(() => new Response('no', { status: s })).ch.downloadMedia(PATH);
  for (const s of [404, 410, 400, 422]) await assert.rejects(status(s), MediaUnreadableError, String(s));
  for (const s of [401, 403]) await assert.rejects(status(s), (e: unknown) => e instanceof ChannelError && e.type === 'auth' && e.code === s, String(s));
  for (const s of [500, 502, 503, 408, 429]) await assert.rejects(status(s), (e: unknown) => e instanceof ChannelError && e.type === 'transient', String(s));
  const network = download(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }).ch.downloadMedia(PATH);
  await assert.rejects(network, (e: unknown) => e instanceof ChannelError && e.type === 'transient');
  const timeout = download(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }).ch.downloadMedia(PATH);
  await assert.rejects(timeout, (e: unknown) => e instanceof ChannelError && e.type === 'transient' && /TimeoutError/.test(e.message));
});

test('downloadMedia: los errores no llevan el path (trae el teléfono del cliente) ni la clave', async () => {
  for (const respond of [() => new Response('no', { status: 503 }), () => new Response('no', { status: 401 }), () => { throw new TypeError('fetch failed'); }]) {
    await assert.rejects(download(respond).ch.downloadMedia(PATH), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.doesNotMatch(e.message, /5491155550000|false_|secreta|\.oga/);
      return true;
    });
  }
});

test('downloadMedia: más de 16 MB se corta mientras baja (sin content-length), y con content-length de más ni se lee; 16 MB justos pasan', async () => {
  const big = streamOf(40 * MB);
  await assert.rejects(download(() => big.response).ch.downloadMedia(PATH), (e: unknown) => e instanceof MediaUnreadableError && /16 MB/.test(e.message));
  assert.equal(big.state.cancelled, true);
  assert.ok(big.state.sent <= 20 * MB, `bajó ${big.state.sent / MB} MB antes de cortar`); // no bajó los 40 MB
  const declared = streamOf(40 * MB, { 'content-length': String(40 * MB) });
  await assert.rejects(download(() => declared.response).ch.downloadMedia(PATH), MediaUnreadableError);
  assert.equal(declared.state.sent <= MB, true); // ni empezó a leer
  const exact = streamOf(16 * MB);
  assert.equal((await download(() => exact.response).ch.downloadMedia(PATH)).length, 16 * MB);
  await assert.rejects(download(() => streamOf(16 * MB + 1).response).ch.downloadMedia(PATH), MediaUnreadableError);
});

// ---------- 8 y 9: del webhook al turno, con la bajada de verdad (fetch falso) ----------
function wahaHarness(respond: (c: Call) => Response | Promise<Response>) {
  const h = makeHarness();
  const f = download(respond);
  h.useWahaParser();
  h.channel.downloadMedia = (p) => f.ch.downloadMedia(p);
  const audioIn = (media: unknown) => {
    const m = h.wahaMessage({ from: CHAT, body: '', type: 'ptt' });
    Object.assign(m.payload, { hasMedia: true, media });
    return h.deliverRaw(m);
  };
  return { h, calls: f.calls, audioIn };
}
const ogg = () => new Response(new Uint8Array([1, 2, 3]));

test('8. del media.url se toma solo el path: un host ajeno se ignora y la bajada va a la WAHA_URL configurada con la clave', async () => {
  const { h, calls, audioIn } = wahaHarness(ogg);
  await audioIn({ url: 'http://evil.example:8080/api/files/a.oga', mimetype: 'audio/ogg; codecs=opus' });
  await h.clock.advance(10_000);
  assert.deepEqual(calls.map((c) => c.url), ['http://waha:3000/api/files/a.oga']); // nunca el host del mensaje
  assert.equal(calls[0].headers['X-Api-Key'], 'secreta');
  assert.equal(h.audio.transcribed, 1);
  assert.equal(h.texts().length, 1);
});

test('8. un path con "..", escapado o fuera de /api/files/ se rechaza: no se pide nada, el audio queda ilegible y se contesta el pedido de texto', async () => {
  for (const url of ['http://waha:3000/api/files/../sessions/default', '/api/files/%2e%2e/%2e%2e/x', 'http://waha:3000/api/sessions/default', 'http://waha:3000/', 'file:///etc/passwd']) {
    const { h, calls, audioIn } = wahaHarness(ogg);
    await audioIn({ url, mimetype: 'audio/ogg' });
    await h.clock.advance(10_000);
    assert.deepEqual(calls, [], url);
    assert.equal(h.audio.transcribed, 0, url);
    assert.deepEqual(h.texts(), [ASK_FIRST], url);
    assert.equal((h.db.prepare('SELECT text FROM messages WHERE id = 1').get() as { text: string }).text, UNREADABLE_AUDIO_TEXT, url);
    assert.ok(listAudit(h.db, 'error').some((a) => /WAHA no mandó el archivo/.test(a.detail)), url);
  }
});

test('9. más de 16 MB: el audio queda ilegible (se corta la bajada, no se convierte ni se transcribe) y se pide texto', async () => {
  const big = streamOf(30 * MB);
  const { h, audioIn } = wahaHarness(() => big.response);
  await audioIn({ url: `http://waha:3000${PATH}`, mimetype: 'audio/ogg' });
  await h.clock.advance(10_000);
  assert.equal(big.state.cancelled, true);
  assert.deepEqual([h.audio.converted, h.audio.transcribed], [0, 0]);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.ok(listAudit(h.db, 'error').some((a) => /audio ilegible: el archivo pasa de 16 MB/.test(a.detail)));
});

test('9. un mimetype que no es audio (video, documento, vacío): ilegible sin bajar nada', async () => {
  for (const mimetype of ['video/mp4', 'application/pdf', 'image/jpeg', undefined]) {
    const { h, calls, audioIn } = wahaHarness(ogg);
    await audioIn({ url: `http://waha:3000${PATH}`, ...(mimetype ? { mimetype } : {}) });
    await h.clock.advance(10_000);
    assert.deepEqual(calls, [], String(mimetype));
    assert.deepEqual(h.texts(), [ASK_FIRST], String(mimetype));
    assert.equal(h.audio.transcribed, 0, String(mimetype));
  }
});

test('el audio vencido en WAHA (404) llega como ilegible y la segunda vez deriva; todo por la bajada real', async () => {
  const { h, calls, audioIn } = wahaHarness(() => new Response('Not Found', { status: 404 }));
  await audioIn({ url: `http://waha:3000${PATH}`, mimetype: 'audio/ogg' });
  await h.clock.advance(10_000);
  assert.equal(calls.length, 1);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  const second = h.wahaMessage({ from: CHAT, body: '', type: 'ptt', id: `false_${CHAT}_SEGUNDO` });
  Object.assign(second.payload, { hasMedia: true, media: { url: `http://waha:3000/api/files/otro.oga`, mimetype: 'audio/ogg' } });
  h.deliverRaw(second);
  await h.clock.advance(10_000);
  assert.deepEqual(h.notifier.handoffs.map((x) => x.decisions[0].reason), ['audio_ilegible']);
  assert.equal(h.texts().length, 1);
});
