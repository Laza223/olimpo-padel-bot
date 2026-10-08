// main.ts (parte B): el armado de todo, el orden de arranque, /health, el apagado con SIGTERM, los errores sin tumbar el proceso y el cerebro falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FakeChannel } from '../src/channel/fake.ts';
import { ChannelError } from '../src/channel/types.ts';
import { createConversation, getConversation, insertMessage, insertOutbox, listAudit, listOutbox } from '../src/db.ts';
import { FakeLlm } from '../src/fakeLlm.ts';
import { createApp } from '../src/main.ts';
import { getFlag, getState, setState } from '../src/settings.ts';
import { FIRST_TEXT, FakeClock, SECRET } from './f2-helpers.ts';
import { HC_URL, bootApp } from './f2b-app.ts';
import type { BootedApp, BootOpts } from './f2b-app.ts';
import { FakeTelegram, TG_GROUP, TG_TOKEN, WAHA_KEY } from './f2b-helpers.ts';

const CHAT = '5491155550000@c.us';
const min = (n: number) => n * 60_000;
const sec = (n: number) => n * 1000;

async function withApp(o: BootOpts, f: (a: BootedApp) => Promise<void>): Promise<void> {
  const a = await bootApp(o);
  try {
    await f(a);
  } finally {
    await a.app.shutdown('fin de la prueba');
  }
}
const fakeProcess = () => Object.assign(new EventEmitter(), { exitCodes: [] as number[], exit(code?: number) { this.exitCodes.push(code ?? 0); } });

test('arranque: crea la sesión de WAHA con el webhook de la red interna, abre /health y avisa que se prendió', async () => {
  await withApp({}, async (a) => {
    const post = a.waha.callsTo('/api/sessions', 'POST');
    assert.equal(post.length, 1);
    assert.equal(post[0].body!.config.webhooks[0].url, 'http://bot:8080/waha'); // BOT_PUBLIC_WEBHOOK_URL por defecto
    assert.equal(post[0].body!.config.webhooks[0].hmac.key, SECRET);
    const res = await fetch(`http://127.0.0.1:${a.app.port()}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.session, 'WORKING');
    assert.equal(body.ready, true);
    const raw = JSON.stringify(body);
    assert.ok(![SECRET, WAHA_KEY, TG_TOKEN, HC_URL].some((s) => raw.includes(s))); // /health no muestra secretos
    assert.match(a.tg.texts[0], /Bot prendido/);
    assert.match(a.tg.texts[0], /modo sombra: no/); // en la prueba arranca apagado; en producción el default es prendido
  });
});

test('/waha sin firma válida se rechaza y no guarda nada', async () => {
  await withApp({}, async (a) => {
    const res = await fetch(`http://127.0.0.1:${a.app.port()}/waha`, { method: 'POST', headers: { 'X-Webhook-Hmac': 'abcd' }, body: '{"id":"evt_x"}' });
    assert.equal(res.status, 401);
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM inbound_events').get()!.n, 0);
  });
});

test('la configuración se valida con mensajes claros y sin mostrar secretos', () => {
  const base = { WAHA_API_KEY: 'k', WAHA_WEBHOOK_HMAC_SECRET: 's', BOT_LLM: 'fake' };
  const mk = (env: Record<string, string>) => () => createApp({ env, port: 0 });
  assert.throws(mk({ ...base, WAHA_API_KEY: '' }), /Falta WAHA_API_KEY/);
  assert.throws(mk({ ...base, WAHA_WEBHOOK_HMAC_SECRET: '' }), /Falta WAHA_WEBHOOK_HMAC_SECRET/);
  assert.throws(mk({ ...base, TELEGRAM_BOT_TOKEN: 'tok-secreto-123' }), (e: Error) => /Falta TELEGRAM_GROUP_ID/.test(e.message) && !e.message.includes('tok-secreto-123'));
  assert.throws(mk({ ...base, BOT_LLM: 'gpt' }), /BOT_LLM tiene que ser fake u openai/);
  assert.throws(mk({ ...base, BOT_LLM: 'openai', OPENAI_API_KEY: '' }), /Falta OPENAI_API_KEY/);
});

test('BOT_LLM=fake usa el cerebro falso: el cliente escribe y el borrador llega a Telegram (modo sombra por defecto de producción)', async () => {
  await withApp({ shadow: true }, async (a) => {
    assert.ok(a.app.llm instanceof FakeLlm);
    await a.say(CHAT, 'Hola, quiero una cancha');
    await a.clock.advance(sec(10));
    const draft = a.tg.texts.find((t) => t.startsWith('Borrador #1'));
    assert.ok(draft, 'no llegó el borrador a Telegram');
    assert.ok(draft.includes(FIRST_TEXT));
    assert.equal(a.channel.sendCalls, 0); // en sombra no se le escribe al cliente
    assert.equal((a.app.llm as FakeLlm).calls, 1);
  });
});

test('/apagar por Telegram corta todo de punta a punta: el próximo mensaje no llama al cerebro; /prender lo retoma', async () => {
  await withApp({ shadow: true }, async (a) => {
    const llm = a.app.llm as FakeLlm;
    a.tg.text(TG_GROUP, '/apagar');
    await a.settle();
    assert.equal(getFlag(a.db, 'kill_switch'), true);
    await a.say(CHAT, 'Hola, quiero una cancha');
    await a.clock.advance(min(5));
    assert.equal(llm.calls, 0);
    assert.equal(a.tg.texts.filter((t) => t.startsWith('Borrador')).length, 0);
    a.tg.text(TG_GROUP, '/prender');
    await a.settle();
    await a.clock.advance(sec(10));
    assert.equal(llm.calls, 1);
    assert.equal(a.tg.texts.filter((t) => t.startsWith('Borrador')).length, 1);
  });
});

test('un session.status del webhook (FAILED) avisa por Telegram una sola vez', async () => {
  await withApp({}, async (a) => {
    assert.equal(await a.post({ kind: 'session_status', session: 'default', status: 'FAILED' }), 200);
    await a.settle();
    assert.equal(a.tg.texts.filter((t) => /FAILED/.test(t)).length, 1);
    await a.post({ kind: 'session_status', session: 'default', status: 'FAILED' });
    await a.settle();
    assert.equal(a.tg.texts.filter((t) => /FAILED/.test(t)).length, 1);
  });
});

test('latido: late cada 60 s solo con la sesión WORKING y no deja la URL en ningún registro', async () => {
  await withApp({}, async (a) => {
    await a.clock.advance(min(3));
    const working = a.pings.length;
    assert.ok(working >= 2, `pings ${working}`);
    a.channel.status = 'FAILED';
    await a.clock.advance(min(2)); // el chequeo de sesión ve FAILED
    const n = a.pings.length;
    await a.clock.advance(min(5));
    assert.equal(a.pings.length, n); // caída la sesión, no hay ping
    const everything = JSON.stringify([a.logs, listAudit(a.db), a.tg.texts]);
    assert.ok(!everything.includes('hc-ping.com'));
  });
});

test('sin token de Telegram los avisos van por consola, el QR se avisa una sola vez y no se llama a Telegram', async () => {
  const channel = new FakeChannel();
  channel.status = 'SCAN_QR_CODE';
  await withApp({ env: { TELEGRAM_BOT_TOKEN: '', TELEGRAM_GROUP_ID: '', HEALTHCHECKS_PING_URL: '' }, channel }, async (a) => {
    await a.clock.advance(min(5));
    assert.equal(a.logs.filter((l) => /^\[aviso\] URGENTE: .*QR/.test(l)).length, 1);
    assert.ok(a.logs.some((l) => /^\[aviso\] Bot prendido/.test(l)));
    assert.equal(a.tg.calls.length, 0);
    assert.equal(a.pings.length, 0); // sin URL de healthchecks no hay latido
    assert.ok(!a.logs.some((l) => l.includes(SECRET) || l.includes(WAHA_KEY)));
  });
});

test('arranque: lo que quedó en proceso se concilia con el historial, no se reenvía, y la salida espera a la reconciliación', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const a = await bootApp({ clock, channel, start: false });
  const { db } = a;
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: clock.now() - min(5) });
  insertMessage(db, { session: 'default', providerMsgId: 'false_c_1', chatId: CHAT, author: 'customer', text: 'Hola', tsUtcMs: clock.now() - min(5) });
  insertOutbox(db, { logicalKey: `${CHAT}:1:0`, chatId: CHAT, kind: 'text', body: 'Buenas tardes, te escribimos de Olimpo Padel.', expiresUtc: clock.now() + min(20), contextVersion: 1, createdUtc: clock.now() - min(4), answersUpto: 1 });
  db.prepare("UPDATE outbox SET status = 'en_proceso', attempted_utc = ? WHERE id = 1").run(clock.now() - min(4)); // el proceso murió a mitad del envío
  setState(db, 'alive_utc', String(clock.now() - min(4)));
  channel.addHistory(CHAT, { providerMsgId: 'true_x_1', fromMe: true, tsUtcMs: clock.now() - min(4), text: 'Buenas tardes, te escribimos de Olimpo Padel.' }); // sí había salido
  try {
    await a.app.start();
    await a.settle();
    assert.equal(channel.sendCalls, 0); // nunca a ciegas
    assert.equal(listOutbox(db)[0].status, 'aceptado');
    assert.equal(getConversation(db, CHAT)!.mode, 'auto');
  } finally {
    await a.app.shutdown();
  }
});

test('SIGTERM y SIGINT: "me apago" se avisa una sola vez, se frena todo, se cierra el puerto y la base queda usable', async () => {
  const a = await bootApp({});
  const proc = fakeProcess();
  a.app.installProcessHandlers(proc as never);
  const port = a.app.port();
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  await a.settle();
  await a.app.shutdown(); // y si alguien lo llama de nuevo, tampoco repite
  assert.equal(a.tg.texts.filter((t) => /Me apago/.test(t)).length, 1);
  assert.deepEqual(proc.exitCodes, [0]);
  assert.equal(a.clock.pending, 0); // no queda ningún temporizador
  const polls = a.tg.callsOf('getUpdates').length;
  a.tg.text(TG_GROUP, '/estado');
  await a.clock.advance(min(5));
  assert.equal(a.tg.callsOf('getUpdates').length, polls); // el long polling se cortó
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`)); // ya no acepta conexiones
  assert.equal((a.db.prepare('SELECT 1 AS x').get() as { x: number }).x, 1); // la base inyectada sigue abierta (la cierra quien la abrió)
  assert.ok(listAudit(a.db, 'alert').some((x) => /Me apago/.test(x.detail))); // y el aviso quedó en la auditoría
});

test('un error sin atrapar no tumba el proceso: queda en la auditoría y avisa (sin repetir el mismo aviso)', async () => {
  await withApp({}, async (a) => {
    const proc = fakeProcess();
    a.app.installProcessHandlers(proc as never);
    proc.emit('uncaughtException', new Error('algo se rompió'));
    proc.emit('uncaughtException', new Error('algo se rompió'));
    proc.emit('unhandledRejection', new Error('promesa rota'));
    await a.settle();
    assert.deepEqual(proc.exitCodes, []); // sin salir: nada de bucle de reinicios
    assert.equal(listAudit(a.db, 'error').filter((e) => /algo se rompió/.test(e.detail)).length, 2);
    assert.equal(a.tg.texts.filter((t) => /algo se rompió/.test(t)).length, 1);
    assert.equal(a.tg.texts.filter((t) => /promesa rota/.test(t)).length, 1);
    await a.clock.advance(min(11)); // pasado un rato, el mismo error vuelve a avisar
    proc.emit('uncaughtException', new Error('algo se rompió'));
    await a.settle();
    assert.equal(a.tg.texts.filter((t) => /algo se rompió/.test(t)).length, 2);
  });
});

test('un error pasajero de WAHA al chequear la sesión no rompe el arranque y se recupera solo', async () => {
  const channel = new FakeChannel();
  channel.sessionError = new ChannelError('transient', undefined, 'sin conexión con WAHA');
  await withApp({ channel }, async (a) => {
    await a.clock.advance(sec(30));
    assert.equal(a.app.session.current(), 'UNREACHABLE');
    channel.sessionError = undefined;
    await a.clock.advance(sec(10));
    assert.equal(a.app.session.current(), 'WORKING');
    assert.equal(getState(a.db, 'session_last'), 'WORKING');
  });
});

test('Telegram caído al arrancar no impide que el bot arranque ni que la tubería ande', async () => {
  const tg = new FakeTelegram();
  tg.failing = true;
  await withApp({ tg }, async (a) => {
    await a.say(CHAT, 'Hola');
    await a.clock.advance(min(1));
    assert.deepEqual(a.texts(), [FIRST_TEXT]); // se contestó igual
    assert.ok(listAudit(a.db, 'error').some((e) => /no pude mandar el aviso/.test(e.detail)));
  });
});
