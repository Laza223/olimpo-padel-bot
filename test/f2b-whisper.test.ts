// Transcriptor local (whisper.cpp en Docker): el pedido al server, el mapeo de errores, la selección por env y los avisos que nombran al transcriptor local.
// Con un fetch falso: sin red, sin Docker y sin modelo. La prueba real contra el contenedor está en f2b-whisper-e2e.test.ts.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTranscriber, LOCAL_WHISPER_NAME, LocalWhisperTranscriber, OpenAiTranscriber, createAudio, transcribeCostUsd } from '../src/audio.ts';
import { TransientLlmError } from '../src/brain.ts';
import { MediaUnreadableError } from '../src/channel/types.ts';
import { createApp } from '../src/main.ts';
import { FIRST_TEXT, ScriptedLlm, turnWith } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import { ASK_FIRST } from './f2b-audio-helpers.ts';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 7, 7, 7]);

// Un fetch falso que anota los pedidos y contesta lo que le digan (o tira).
function fakeFetch(reply: (url: string) => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = reply(String(input));
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { calls, fn };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const run = (r: Response | Error) => new LocalWhisperTranscriber({ url: 'http://whisper:8080', fetch: fakeFetch(() => r).fn }).transcribe(MP3);

// ---------- el pedido ----------
test('LocalWhisperTranscriber: POST multipart a /inference con el mp3, español, temperatura 0, JSON y el vocabulario del negocio como prompt', async () => {
  const f = fakeFetch(() => json({ text: ' Hola, quiero una cancha de pádel techada en Pilar.\n' }));
  const t = new LocalWhisperTranscriber({ fetch: f.fn });
  assert.equal(await t.transcribe(MP3), ' Hola, quiero una cancha de pádel techada en Pilar.\n'); // el worker hace el trim
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://whisper:8080/inference'); // WHISPER_URL por defecto
  assert.equal(f.calls[0].init.method, 'POST');
  const form = f.calls[0].init.body as FormData;
  assert.ok(form instanceof FormData);
  const file = form.get('file') as File;
  assert.deepEqual([file.name, file.type, file.size], ['audio.mp3', 'audio/mpeg', MP3.length]);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), MP3);
  assert.equal(form.get('temperature'), '0');
  assert.equal(form.get('temperature_inc'), '0'); // sin reintentos con temperatura mayor: el resultado es siempre el mismo y la demora acotada
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.get('language'), 'es');
  const prompt = String(form.get('prompt'));
  for (const w of ['Olimpo Padel', 'pádel', 'Full Panorámica', 'Panorámica', 'platea', 'galpón', 'techada', 'aire libre', 'Pilar', 'Córdoba']) assert.ok(prompt.includes(w), `falta ${w} en el prompt`);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test('LocalWhisperTranscriber: timeout de 120 s, costo 0 y la URL sin barra final', async () => {
  const timeout = mock.method(AbortSignal, 'timeout');
  try {
    const f = fakeFetch(() => json({ text: 'hola' }));
    const t = new LocalWhisperTranscriber({ url: 'http://127.0.0.1:18080/', fetch: f.fn });
    await t.transcribe(MP3);
    assert.deepEqual(timeout.mock.calls.map((c) => c.arguments[0]), [120_000]);
    assert.equal(f.calls[0].url, 'http://127.0.0.1:18080/inference');
  } finally {
    timeout.mock.restore();
  }
  const t = new LocalWhisperTranscriber();
  assert.equal(t.costPerMinuteUsd, 0);
  assert.equal(transcribeCostUsd(t, 600), 0);
  assert.equal(t.local, true);
  assert.equal(t.model, 'whisper-small');
});

// ---------- errores ----------
test('LocalWhisperTranscriber: conexión rechazada, timeout y 5xx son errores pasajeros (network): entran en la lógica de 3 fallos', async () => {
  for (const r of [
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:8080'), { code: 'ECONNREFUSED' }) }),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    new Response('boom', { status: 500 }),
    json({ error: 'failed to process audio' }, 500),
    new Response('loading', { status: 503 }),
    new Response('', { status: 502 }),
  ]) {
    await assert.rejects(run(r), (e: unknown) => e instanceof TransientLlmError && e.kind === 'network', String(r));
  }
  // Un 200 que no es el JSON del server (otro servicio en esa dirección): tampoco es un audio ilegible.
  await assert.rejects(run(new Response('<html>hola</html>', { status: 200 })), (e: unknown) => e instanceof TransientLlmError && e.kind === 'network');
});

test('LocalWhisperTranscriber: un 4xx es un audio ilegible con causa "rechazo"', async () => {
  for (const status of [400, 404, 413, 415, 422]) {
    await assert.rejects(run(new Response('Invalid request', { status })), (e: unknown) => e instanceof MediaUnreadableError && e.kind === 'rechazo', String(status));
  }
});

test('LocalWhisperTranscriber: el mensaje de los errores no lleva el audio ni el texto de la respuesta', async () => {
  await assert.rejects(run(new Response('texto-secreto-del-cliente', { status: 500 })), (e: unknown) => e instanceof Error && !/texto-secreto/.test(e.message));
  await assert.rejects(run(new Response('texto-secreto-del-cliente', { status: 400 })), (e: unknown) => e instanceof Error && !/texto-secreto/.test(e.message));
});

test('LocalWhisperTranscriber: texto vacío (o solo marcas de "no hay voz") devuelve vacío: el worker lo deja ilegible', async () => {
  assert.equal((await run(json({ text: '  \n' }))).trim(), ''); // solo espacios: el worker hace el trim y lo deja ilegible
  for (const text of ['', '[MÚSICA]', ' [música]\n', '[BLANK_AUDIO]', ' (aplausos) ', '[Música] [Aplausos]']) {
    assert.equal(await run(json({ text })), '', JSON.stringify(text));
  }
  assert.equal(await run(json({})), ''); // sin campo text
  assert.equal(await run(json({ text: 'Hola [música] quiero una cancha' })), 'Hola [música] quiero una cancha'); // habla de verdad: no se toca
});

// ---------- selección por env ----------
test('createAudio: BOT_TRANSCRIBER es local por defecto (con WHISPER_URL) y openai si se pide; BOT_LLM=fake gana; un valor raro falla con mensaje claro', () => {
  const byDefault = createAudio({}, false).transcriber;
  assert.ok(byDefault instanceof LocalWhisperTranscriber);
  assert.equal((byDefault as LocalWhisperTranscriber).url, 'http://whisper:8080');
  assert.equal(byDefault.costPerMinuteUsd, 0);

  const local = createAudio({ BOT_TRANSCRIBER: ' Local ', WHISPER_URL: ' http://127.0.0.1:18080/ ', OPENAI_API_KEY: 'k' }, false).transcriber;
  assert.ok(local instanceof LocalWhisperTranscriber);
  assert.equal((local as LocalWhisperTranscriber).url, 'http://127.0.0.1:18080');
  assert.equal((createAudio({ BOT_TRANSCRIBER: '  ', WHISPER_URL: '' }, false).transcriber as LocalWhisperTranscriber).url, 'http://whisper:8080'); // vacío = por defecto

  const openai = createAudio({ BOT_TRANSCRIBER: 'openai', OPENAI_API_KEY: 'k' }, false).transcriber;
  assert.ok(openai instanceof OpenAiTranscriber);
  assert.equal(openai.model, 'gpt-transcribe');
  assert.equal(createAudio({ BOT_TRANSCRIBER: 'OpenAI', OPENAI_API_KEY: 'k', BOT_TRANSCRIBE_MODEL: 'gpt-4o-transcribe' }, false).transcriber.model, 'gpt-4o-transcribe');

  for (const mode of ['local', 'openai', undefined]) assert.ok(createAudio({ BOT_TRANSCRIBER: mode }, true).transcriber instanceof FakeTranscriber, String(mode));
  assert.throws(() => createAudio({ BOT_TRANSCRIBER: 'whisper' }, false), /BOT_TRANSCRIBER tiene que ser local u openai/);
  assert.throws(() => createAudio({ BOT_TRANSCRIBER: 'whisper' }, true), /BOT_TRANSCRIBER tiene que ser local u openai/); // también con el cerebro falso: un error de tipeo se ve enseguida
});

test('createApp: un BOT_TRANSCRIBER inválido corta el arranque; con el valor por defecto no hace falta OPENAI_API_KEY para transcribir', async () => {
  const base = { WAHA_API_KEY: 'k', WAHA_WEBHOOK_HMAC_SECRET: 's', BOT_LLM: 'fake' };
  assert.throws(() => createApp({ env: { ...base, BOT_TRANSCRIBER: 'x' }, port: 0, dbPath: ':memory:' }), /BOT_TRANSCRIBER tiene que ser local u openai/);
  const app = createApp({ env: base, port: 0, dbPath: ':memory:' }); // sin BOT_TRANSCRIBER ni claves de OpenAI: arma bien
  await app.shutdown('fin de la prueba');
});

// ---------- avisos al equipo ----------
const network = () => new TransientLlmError('network', 'no pude hablar con el transcriptor local');
const unreadableAlerts = (h: ReturnType<typeof makeHarness>) => h.notifier.alerts.filter((a) => /quedó sin leer/.test(a.text));
const local = (h: ReturnType<typeof makeHarness>) => {
  h.audio.transcriber.local = true;
  h.audio.transcriber.model = 'whisper-small';
  h.audio.transcriber.costPerMinuteUsd = 0;
};

test('avisos: si el transcriptor local no responde, el aviso nombra al transcriptor local (Whisper) y no a OpenAI; el audio queda ilegible y el cliente recibe el pedido de texto', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(() => turnWith([FIRST_TEXT])) });
  local(h);
  h.audio.script = [network()];
  h.sayAudio(CHAT);
  await h.clock.advance(min(10));
  assert.equal(h.audio.transcribed, 4); // 3 fallos con espera y el 4.º lo da por ilegible
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.equal(unreadableAlerts(h).length, 1);
  assert.ok(unreadableAlerts(h)[0].text.includes(`(${LOCAL_WHISPER_NAME} falló varias veces seguidas al transcribirlo)`), unreadableAlerts(h)[0].text);
  assert.ok(h.notifier.alerts.every((a) => !/OpenAI|OPENAI_API_KEY|BOT_TRANSCRIBE_MODEL/.test(a.text)), JSON.stringify(h.notifier.alerts.map((a) => a.text)));
  const models = h.db.prepare("SELECT model FROM agent_runs WHERE error_kind = 'transient:network'").all() as { model: string }[];
  assert.ok(models.length > 0 && models.every((r) => r.model === 'whisper-small'), JSON.stringify(models)); // en agent_runs queda el modelo local
});

test('avisos: un 4xx del server local (rechazo) dice que el transcriptor local no aceptó el archivo', async () => {
  const h = makeHarness();
  local(h);
  h.audio.script = [new MediaUnreadableError('el transcriptor local no aceptó el audio (400)', 'rechazo')];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(30));
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.equal(unreadableAlerts(h).length, 1);
  assert.match(unreadableAlerts(h)[0].text, /el transcriptor local \(Whisper\) no aceptó el archivo/);
  assert.ok(!/OpenAI/.test(unreadableAlerts(h)[0].text));
});

test('avisos: con OpenAI (transcriptor sin la marca local) todo dice lo mismo que antes', async () => {
  const h = makeHarness();
  h.audio.script = [new MediaUnreadableError('OpenAI no aceptó el audio (400)', 'rechazo')];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(30));
  assert.match(unreadableAlerts(h)[0].text, /\(OpenAI no aceptó el archivo\)/);
});
