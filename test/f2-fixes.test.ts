// Ronda de arreglos de F2 (revisión adversaria): cada prueba reproduce un hallazgo (r1…r10 y los demás) y fija el comportamiento correcto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransientLlmError } from '../src/brain.ts';
import { FakeChannel } from '../src/channel/fake.ts';
import { WahaChannel } from '../src/channel/waha.ts';
import { ChannelError } from '../src/channel/types.ts';
import type { InboundEvent } from '../src/channel/types.ts';
import {
  bumpVersion, cancelChatOutbox, claimOutbox, createConversation, createDraft, getConversation, getOutbox, historyFor, insertMessage, insertOutbox, listAudit, listOutbox, markOutbox, openDb, requeueOutbox, setMode,
  listAgentRuns, listDrafts, pauseConversation, pendingInboundCount, unansweredMessages,
} from '../src/db.ts';
import { createOutbox } from '../src/outbox.ts';
import { createTelegram } from '../src/notify/telegram.ts';
import { getBotStart, setSetting, setState } from '../src/settings.ts';
import { createSession } from '../src/session.ts';
import { createRecovery } from '../src/startup.ts';
import { loadPolicy } from '../src/policy.ts';
import { runTurn } from '../src/turn.ts';
import { fakeLlm, modelTurn, msg, turnInput } from './helpers.ts';
import { FIRST_TEXT, FakeClock, FakeNotifier, T0, ScriptedLlm, deferred, policy, turnWith } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import { bootApp } from './f2b-app.ts';
import { FakeTelegram, TG_GROUP, TG_TOKEN } from './f2b-helpers.ts';

const CHAT = '5491155550000@c.us';
const GREETING = 'Buenas tardes, te escribimos de Olimpo Padel. Contame, de donde sos?';
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;

// Base con una conversación y una fila de salida pendiente de la versión 1.
function rowSetup() {
  const db = openDb(':memory:');
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: T0 });
  bumpVersion(db, CHAT, T0); // versión 1
  insertOutbox(db, { logicalKey: `${CHAT}:1:0`, chatId: CHAT, kind: 'text', body: 'Hola', expiresUtc: T0 + min(30), contextVersion: 1, createdUtc: T0, answersUpto: 0 });
  return { db, id: listOutbox(db)[0].id };
}

// ---------- 1 (r9): un globo en vuelo que vuelve a pendiente no sale con contexto viejo ----------
test('1. r9: globo en vuelo + info nueva + toma humana; el envío falla pasajero → no se reenvía (queda cancelado)', async () => {
  const gate = deferred();
  const llm = new ScriptedLlm(() => turnWith([GREETING]));
  const h = makeHarness({ llm });
  const real = h.channel.sendText.bind(h.channel);
  let first = true;
  h.channel.sendText = async (chatId: string, text: string) => {
    if (first) { first = false; h.channel.sendCalls++; await gate.promise; throw new ChannelError('transient', 422, 'sesion no WORKING'); }
    return real(chatId, text);
  };
  h.say(CHAT, 'Hola');
  await h.clock.advance(5000);
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['en_proceso']);
  h.say(CHAT, 'Ah, somos de Cordoba y la queremos techada');
  h.deliver(h.ownEvent(CHAT, 'Hola, soy Tomas, sigo yo'));
  await h.clock.advance(1000);
  gate.resolve();
  await h.clock.advance(min(5));
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['cancelado']);
  assert.deepEqual(h.channel.sent, []); // nada llegó al cliente
});

test('1. claimOutbox: una fila de una versión vieja se cancela (contexto_nuevo; humano si el chat ya es del equipo) y no se manda', () => {
  const a = rowSetup();
  bumpVersion(a.db, CHAT, T0); // el cliente escribió de nuevo
  assert.equal(claimOutbox(a.db, a.id, T0), false);
  assert.deepEqual([getOutbox(a.db, a.id)!.status, getOutbox(a.db, a.id)!.cause], ['cancelado', 'contexto_nuevo']);

  const b = rowSetup();
  bumpVersion(b.db, CHAT, T0);
  setMode(b.db, CHAT, 'humano');
  assert.equal(claimOutbox(b.db, b.id, T0), false);
  assert.deepEqual([getOutbox(b.db, b.id)!.status, getOutbox(b.db, b.id)!.cause], ['cancelado', 'humano']);

  const c = rowSetup(); // versión al día y el bot sigue: sale
  assert.equal(claimOutbox(c.db, c.id, T0), true);
  assert.equal(getOutbox(c.db, c.id)!.status, 'en_proceso');

  const d = rowSetup(); // chat pausado: no sale
  setMode(d.db, CHAT, 'pausado');
  assert.equal(claimOutbox(d.db, d.id, T0), false);
  assert.equal(getOutbox(d.db, d.id)!.status, 'cancelado');

  const e = rowSetup(); // el mensaje que cierra el chat (baja, mensaje seguro): el modo pasa a humano en el mismo turno, la versión no cambia, y tiene que salir
  setMode(e.db, CHAT, 'humano');
  assert.equal(claimOutbox(e.db, e.id, T0), true);
});

test('1. cancelChatOutbox marca también lo que está en proceso: si después falla pasajero, el reintento se rechaza', () => {
  const { db, id } = rowSetup();
  assert.equal(claimOutbox(db, id, T0), true);
  cancelChatOutbox(db, CHAT, 'toma_humana'); // la versión no cambia: solo la marca lo frena
  assert.equal(getOutbox(db, id)!.status, 'en_proceso'); // el envío en vuelo todavía puede terminar bien
  assert.equal(requeueOutbox(db, id, 'sesion no WORKING', T0 + 5000), false);
  assert.deepEqual([getOutbox(db, id)!.status, getOutbox(db, id)!.cause], ['cancelado', 'toma_humana']);

  const ok = rowSetup(); // sin marca ni cambio de versión, el reintento pasajero vuelve a pendiente
  assert.equal(claimOutbox(ok.db, ok.id, T0), true);
  assert.equal(requeueOutbox(ok.db, ok.id, 'sesion no WORKING', T0 + 5000), true);
  assert.deepEqual([getOutbox(ok.db, ok.id)!.status, getOutbox(ok.db, ok.id)!.nextTryUtc], ['pendiente', T0 + 5000]);
});

// ---------- 2 (r1, r7): las respuestas no se pierden ----------
test('2. r1: el cliente edita su mensaje con la respuesta ya en cola → se cancela la vieja y se regenera con el texto editado', async () => {
  const h = makeHarness();
  h.deliver(h.customerEvent(CHAT, 'Hola quiero una cancha', { id: 'false_5491155550000@c.us_3EB0AAAA' }));
  await h.clock.advance(2100); // turno, respuesta en la cola, "escribiendo"
  assert.deepEqual(listOutbox(h.db).map((r) => [r.status, r.contextVersion]), [['pendiente', 1]]);
  h.deliver({ kind: 'edit', session: 'default', chatId: CHAT, providerMsgId: '3EB0AAAA', text: 'Hola quiero una cancha techada' });
  await h.clock.advance(min(10));
  assert.deepEqual(listOutbox(h.db).map((r) => [r.status, r.cause]), [['cancelado', 'contexto_nuevo'], ['aceptado', null]]);
  assert.equal(h.channel.sent.length, 1);
  assert.equal(h.llmCalls(), 2);
  assert.equal(unansweredMessages(h.db, CHAT).length, 0);
});

test('2. r1: borrar un mensaje con otro sin contestar regenera la respuesta; borrar el único no abre ningún turno', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola', { id: 'false_X_A' });
  await h.clock.advance(2100);
  h.say(CHAT, 'Hola de nuevo', { id: 'false_X_B' });
  await h.clock.advance(2100);
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['cancelado', 'pendiente']);
  h.deliver({ kind: 'revoke', session: 'default', chatId: CHAT, providerMsgId: 'false_X_B' });
  await h.clock.advance(min(10));
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['cancelado', 'cancelado', 'aceptado']);
  assert.equal(h.channel.sent.length, 1);

  const solo = makeHarness();
  solo.say(CHAT, 'Hola', { id: 'false_X_A' });
  await solo.clock.advance(2100);
  solo.deliver({ kind: 'revoke', session: 'default', chatId: CHAT, providerMsgId: 'false_X_A' });
  await solo.clock.advance(min(10));
  assert.deepEqual(listOutbox(solo.db).map((r) => r.status), ['cancelado']);
  assert.equal(solo.llmCalls(), 1); // nunca abre un turno solo: no queda nada sin contestar
  assert.equal(solo.channel.sent.length, 0);
});

test('2. r7: /apagar justo después del turno y /prender 31 min después → la respuesta vence con aviso y se regenera', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola quiero una cancha');
  await h.clock.advance(2100);
  setSetting(h.db, 'kill_switch', '1');
  await h.clock.advance(min(31));
  setSetting(h.db, 'kill_switch', '0');
  h.worker.rescan();
  await h.clock.advance(min(5));
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['vencido', 'aceptado']);
  assert.equal(h.channel.sent.length, 1);
  assert.equal(h.llmCalls(), 2);
  const avisos = h.notifier.alerts.filter((a) => /se venció una respuesta sin mandar en #1, la regenero/i.test(a.text));
  assert.equal(avisos.length, 1);
  assert.ok(listAudit(h.db, 'alert').some((a) => a.chatId === CHAT && /se venció una respuesta/i.test(a.detail)));
});

test('2. lo vencido de un chat que ya es del equipo avisa "revisalo vos" y no se regenera; un aviso por chat aunque venzan varios globos', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  const mk = (chatId: string, key: string) => insertOutbox(h.db, { logicalKey: key, chatId, kind: 'text', body: 'x', expiresUtc: T0 - 1, contextVersion: 0, createdUtc: T0 - min(40), answersUpto: 0 });
  createConversation(h.db, { chatId: 'h@c.us', session: 'default', mode: 'humano', nowMs: T0 });
  createConversation(h.db, { chatId: 'a@c.us', session: 'default', mode: 'auto', nowMs: T0 });
  mk('h@c.us', 'h:0:0'); mk('h@c.us', 'h:0:1'); mk('a@c.us', 'a:0:0'); mk('a@c.us', 'a:0:1');
  setSetting(h.db, 'kill_switch', '0');
  h.outbox.kick();
  await h.clock.advance(1000);
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['vencido', 'vencido', 'vencido', 'vencido']);
  const texts = h.notifier.alerts.map((a) => a.text);
  assert.equal(texts.filter((t) => /en #1.*revisalo vos/i.test(t)).length, 1); // el chat del equipo
  assert.equal(texts.filter((t) => /en #2.*la regenero/i.test(t)).length, 1); // el chat del bot
  assert.equal(texts.length, 2);
});

// ---------- 3 (r2): un eco temprano seguido de un timeout no es "no confirmado" ----------
test('3. r2: el eco llega antes de la respuesta HTTP y la respuesta se pierde (timeout) → queda aceptado, sin aviso, y el resto sale', async () => {
  const llm = new ScriptedLlm(() => turnWith(['Buenas tardes, te escribimos de Olimpo Padel.', 'Contame de donde sos?']));
  const h = makeHarness({ llm });
  h.channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: true });
  h.channel.onSent((m) => { h.deliver(h.channel.echoOf(m, 'api')); });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(20));
  assert.deepEqual(listOutbox(h.db).map((r) => [r.status, r.cause]), [['aceptado', null], ['aceptado', null]]);
  assert.deepEqual(h.channel.sent.map((m) => m.text), ['Buenas tardes, te escribimos de Olimpo Padel.', 'Contame de donde sos?']);
  assert.equal(h.channel.sendCalls, 2);
  assert.deepEqual(h.notifier.alerts, []);
});

test('3. conciliar ignora el id que ya es de la misma fila (no lo confunde con "de otra respuesta")', async () => {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  const channel = new FakeChannel(() => clock.now());
  const notifier = new FakeNotifier();
  const outbox = createOutbox({ db, channel, notifier, clock });
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: T0 });
  bumpVersion(db, CHAT, T0);
  insertOutbox(db, { logicalKey: `${CHAT}:1:0`, chatId: CHAT, kind: 'text', body: 'Uno', expiresUtc: T0 + min(30), contextVersion: 1, createdUtc: T0, answersUpto: 0 });
  // La fila ya tiene el id de WAHA (llegó por el eco) pero quedó incierta; el mensaje ya está guardado y figura en el historial.
  markOutbox(db, 1, 'incierto', { providerMsgId: 'true_x', nextTryUtc: T0 });
  insertMessage(db, { session: 'default', providerMsgId: 'true_x', chatId: CHAT, author: 'bot', text: 'Uno', tsUtcMs: T0 });
  channel.addHistory(CHAT, { providerMsgId: 'true_x', fromMe: true, tsUtcMs: T0 + 1000, text: 'Uno' });
  outbox.kick();
  await clock.advance(1000);
  assert.deepEqual([getOutbox(db, 1)!.status, getOutbox(db, 1)!.cause], ['aceptado', null]);
  assert.deepEqual(notifier.alerts, []);
});

// ---------- 4 (r3): un mensaje propio por la API que no está en la cola no es toma humana ----------
test('4. r3: eco del bot (source api) con el texto cambiado y antes de la respuesta HTTP → no hay toma humana: solo auditoría y aviso', async () => {
  const llm = new ScriptedLlm(() => turnWith(['Buenas tardes, te escribimos de Olimpo Padel.', 'Contame de donde sos?']));
  const h = makeHarness({ llm });
  h.channel.onSent((m) => { h.deliver({ ...(h.channel.echoOf(m, 'api') as Extract<InboundEvent, { kind: 'own_message' }>), text: `${m.text} ` }); }); // WhatsApp normalizó el texto
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(1));
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(h.notifier.takeovers, []);
  assert.deepEqual(listAudit(h.db, 'takeover'), []);
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['aceptado', 'aceptado']); // sigue mandando: el chat no pasó a humano
  assert.ok(h.notifier.alerts.some((a) => /por la API/.test(a.text) && /#1/.test(a.text)));
  assert.ok(listAudit(h.db, 'alert').some((a) => a.chatId === CHAT && /por la API/.test(a.detail)));
});

test('4. un mensaje propio por la API de un chat que no conocemos tampoco crea la conversación; uno del celular (app) sí es toma humana', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  h.deliver(h.ownEvent('X@c.us', 'mandado por otro programa', { source: 'api' }));
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, 'X@c.us'), undefined);
  assert.equal(h.notifier.alerts.length, 1);
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  h.deliver(h.ownEvent(CHAT, 'te contesto yo', { source: 'app' }));
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(h.notifier.takeovers, [CHAT]);
});

// ---------- 5 (r4): se revalida todo justo antes de llamar al modelo ----------
test('5. r4: el 5.º chat espera un lugar de OpenAI; mientras espera el equipo lo toma y se apaga el bot → no se le llama al modelo', async () => {
  const gate = deferred();
  const llm = new ScriptedLlm(async () => { await gate.promise; return turnWith([FIRST_TEXT]); });
  const h = makeHarness({ llm });
  for (let i = 0; i < 5; i++) h.say(`54911000000${i}@c.us`, 'Hola');
  await h.clock.advance(3000);
  assert.equal(llm.calls.length, 4); // los 4 lugares ocupados, el 5.º espera
  h.deliver(h.ownEvent('549110000004@c.us', 'te contesto yo'));
  setSetting(h.db, 'kill_switch', '1');
  await h.clock.advance(1000);
  gate.resolve();
  await h.clock.advance(min(1));
  assert.equal(llm.calls.length, 4); // al soltarse el lugar se vio que ya no correspondía: cero gasto
  assert.equal(getConversation(h.db, '549110000004@c.us')!.mode, 'humano');
  assert.deepEqual(listAgentRuns(h.db, '549110000004@c.us'), []);
  assert.deepEqual(h.channel.sent, []); // con el bot apagado a mitad de camino, tampoco sale lo de los 4 que ya estaban pensando
});

test('5. mientras se espera el estado de la sesión llega un mensaje nuevo del equipo → no se llama al modelo ni queda nada para mandar', async () => {
  const gate = deferred();
  const h = makeHarness();
  h.channel.sessionStatus = async () => { await gate.promise; return 'WORKING'; };
  h.say(CHAT, 'Hola');
  await h.clock.advance(3000);
  h.deliver(h.ownEvent(CHAT, 'Hola, soy Tomas'));
  await h.clock.advance(1000);
  gate.resolve();
  await h.clock.advance(min(1));
  assert.equal(h.llmCalls(), 0);
  assert.deepEqual(listOutbox(h.db), []);
  assert.deepEqual(h.channel.sent, []);
});

// ---------- 6 (r8): un aviso colgado no frena la tubería ----------
const hang = () => new Promise(() => {}) as unknown as void;
// ¿La promesa termina? (tiempo real corto: el reloj falso no mueve este temporizador)
const settles = (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))]);

test('6. r8: Telegram colgado en un aviso de adjunto → el ingest sigue a los 5 s y procesa la toma humana de otro chat', async () => {
  const h = makeHarness();
  h.notifier.alert = hang;
  h.say('A@c.us', 'Hola');
  await h.clock.advance(10_000);
  h.say('B@c.us', '', { media: 'image' }); // el aviso del adjunto se cuelga (un audio ya no avisa: se transcribe)
  await h.clock.advance(1000);
  h.say('C@c.us', 'Hola');
  await h.clock.advance(0);
  h.deliver(h.ownEvent('A@c.us', 'te contesto yo'));
  await h.clock.advance(60_000);
  assert.equal(pendingInboundCount(h.db), 0);
  assert.equal(getConversation(h.db, 'A@c.us')!.mode, 'humano');
  assert.ok(getConversation(h.db, 'C@c.us'));
  assert.ok(listAudit(h.db, 'error').some((a) => /no pude mandar el aviso: .*5 s/.test(a.detail)));
});

test('6. el aviso de toma humana, el borrador y la derivación colgados tampoco frenan al ingest ni al worker', async () => {
  const h = makeHarness({ shadow: true });
  h.notifier.takeover = hang;
  h.notifier.draft = hang;
  h.say(CHAT, 'Hola');
  await h.clock.advance(2100); // el turno termina y el borrador se cuelga
  assert.equal(await settles(h.worker.idle()), false); // todavía esperando a Telegram...
  await h.clock.advance(5000);
  assert.equal(await settles(h.worker.idle()), true); // ...a los 5 s deja de esperar
  h.deliver(h.ownEvent(CHAT, 'te contesto yo'));
  await h.clock.advance(1000);
  assert.equal(await settles(h.ingest.idle()), false);
  await h.clock.advance(5000);
  assert.equal(await settles(h.ingest.idle()), true);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.equal(listAudit(h.db, 'error').filter((a) => /5 s/.test(a.detail)).length, 2);
});

// ---------- 7 (r6): 463/475 solo cuando el error es claramente ese código ----------
test('7. r6: un "475" o "463" suelto en un stack, un 502 de nginx o un tiempo de espera NO es restricted', async () => {
  const mk = (status: number, body: string) => new WahaChannel({ baseUrl: 'http://x', apiKey: 'k', fetch: (async () => new Response(body, { status })) as typeof fetch });
  const cases: [number, string, string][] = [
    [500, '{"statusCode":500,"message":"Evaluation failed: Error at Object.sendMessage (puppeteer:475:12)"}', 'uncertain'],
    [500, '{"message":"timeout of 463ms exceeded"}', 'uncertain'],
    [422, '{"error":"chatId 5491155550000@c.us not found"}', 'transient'],
    [502, '<html>502 Bad Gateway nginx/1.2.475</html>', 'uncertain'],
    [500, '{"message":"fallo","code":1475}', 'uncertain'],
  ];
  for (const [status, body, type] of cases) {
    await assert.rejects(mk(status, body).sendText('a@c.us', 'hola'), (e: unknown) => {
      assert.ok(e instanceof ChannelError);
      assert.equal(e.type, type, body);
      return true;
    });
  }
  await assert.rejects(mk(500, '{"statusCode":463,"message":"x"}').sendText('a@c.us', 'hola'), (e: unknown) => e instanceof ChannelError && e.type === 'restricted' && e.code === 463);
});

// ---------- 8: el mensaje no se pierde si la historia no se pudo mirar ----------
test('8. tras 5 fallos de la historia el mensaje se guarda, el chat arranca en humano (modo seguro) y hay un aviso con el número; no se llama al modelo', async () => {
  const h = makeHarness();
  h.channel.messagesSinceError = new ChannelError('uncertain', 500, 'WAHA caído');
  h.say(CHAT, 'Hola, quiero una cancha');
  await h.clock.advance(min(30));
  const c = getConversation(h.db, CHAT)!;
  assert.equal(c.mode, 'humano');
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => [m.author, m.text]), [['customer', 'Hola, quiero una cancha']]);
  assert.equal(h.channel.messagesSinceCalls, 5);
  assert.equal(pendingInboundCount(h.db), 0);
  assert.equal(h.notifier.alerts.filter((a) => /historia/.test(a.text) && /#1/.test(a.text)).length, 1);
  assert.ok(listAudit(h.db, 'takeover').some((a) => a.chatId === CHAT && /historia/.test(a.detail)));
  assert.equal(h.llmCalls(), 0);
  assert.deepEqual(h.channel.sent, []);
});

// ---------- 9: los chats pausados por un tope del día vuelven solos a las 00:00 (Argentina) ----------
const A = '5491100000001@c.us';
const B = '5491100000002@c.us';
// Cada chat arranca con su primer mensaje: el saludo de la hora que corresponde (a las 00:00 es "Buenas noches").
const greetingLlm = () => new ScriptedLlm((_n, input) => turnWith([policy.greetingRules.primerMensaje.replace('{saludo}', /saludo_que_corresponde: (.+)/.exec(input)![1].trim())]));

test('9. tope de gasto del día: el chat queda pausado con su motivo; a las 00:00 vuelve al bot, se contesta (es reciente) y hay un resumen en Telegram', async () => {
  const h = makeHarness({ llm: greetingLlm(), settings: { daily_budget_usd: '0.003' } });
  h.say(A, 'Hola');
  await h.clock.advance(10_000); // el primer turno gasta USD 0,0041
  h.say(B, 'Hola');
  await h.clock.advance(min(5));
  assert.deepEqual([getConversation(h.db, B)!.mode, getConversation(h.db, B)!.pauseReason], ['pausado', 'budget']);
  assert.ok(h.notifier.alerts.some((a) => /tope de gasto del día/.test(a.text) && /00:00 \(hora de Argentina\)/.test(a.text) && /vuelven solos al bot/i.test(a.text)));
  assert.equal(h.llmCalls(), 1);
  await h.clock.advance(hour(11)); // pasa la medianoche
  const b = getConversation(h.db, B)!;
  assert.deepEqual([b.mode, b.pauseReason, b.pausedUtc], ['auto', null, null]);
  assert.equal(h.llmCalls(), 2);
  assert.equal(h.texts(B).length, 1);
  assert.equal(h.notifier.alerts.filter((a) => /medianoche/.test(a.text) && /volvieron al bot/.test(a.text) && /#2/.test(a.text)).length, 1);
});

test('9. tope de chats nuevos del día: vuelve a las 00:00 y entra al cupo del día nuevo', async () => {
  const h = makeHarness({ llm: greetingLlm(), settings: { max_new_chats_per_day: '1' } });
  h.say(A, 'Hola');
  await h.clock.advance(10_000);
  h.say(B, 'Hola');
  await h.clock.advance(min(5));
  assert.deepEqual([getConversation(h.db, B)!.mode, getConversation(h.db, B)!.pauseReason], ['pausado', 'cap']);
  assert.ok(h.notifier.alerts.some((a) => /tope de chats nuevos/.test(a.text) && /00:00 \(hora de Argentina\)/.test(a.text)));
  await h.clock.advance(hour(11));
  assert.equal(getConversation(h.db, B)!.mode, 'auto');
  assert.equal(h.texts(B).length, 1);
});

test('9. lo más viejo que reply_window_hours no se contesta: queda atendido y va en un solo resumen', async () => {
  const h = makeHarness({ llm: greetingLlm(), settings: { daily_budget_usd: '0.003', reply_window_hours: '5' } });
  h.say(A, 'Hola');
  await h.clock.advance(10_000);
  h.say(B, 'Hola');
  await h.clock.advance(min(5));
  await h.clock.advance(hour(11));
  assert.equal(getConversation(h.db, B)!.mode, 'auto');
  assert.equal(h.llmCalls(), 1); // no se contestó
  assert.equal(unansweredMessages(h.db, B).length, 0);
  assert.equal(h.notifier.alerts.filter((a) => /medianoche/.test(a.text)).length, 1);
  assert.match(h.notifier.alerts.find((a) => /medianoche/.test(a.text))!.text, /#2 \(hace 10 h\)/);
});

test('9. el tope de gasto de UNA conversación no se levanta a medianoche (volvería a pausarse): queda pausada con motivo "conv"', async () => {
  const h = makeHarness({ llm: greetingLlm(), settings: { conv_budget_usd: '0.003' } });
  h.say(A, 'Hola');
  await h.clock.advance(10_000);
  h.say(A, 'Una cosa más');
  await h.clock.advance(min(5));
  assert.deepEqual([getConversation(h.db, A)!.mode, getConversation(h.db, A)!.pauseReason], ['pausado', 'conv']);
  await h.clock.advance(hour(11));
  assert.equal(getConversation(h.db, A)!.mode, 'pausado');
  assert.equal(h.notifier.alerts.filter((a) => /medianoche/.test(a.text)).length, 0);
});

test('9. al prender (rescan) también vuelven los pausados de un día anterior; los de hoy siguen pausados', async () => {
  const h = makeHarness({ llm: greetingLlm(), settings: { kill_switch: '1' } });
  h.say(A, 'Hola');
  h.say(B, 'Hola');
  await h.clock.advance(0);
  pauseConversation(h.db, A, 'budget', T0 - hour(20)); // ayer
  pauseConversation(h.db, B, 'budget', T0 - hour(1)); // hoy (el día empezó hace 14 h)
  setSetting(h.db, 'kill_switch', '0');
  h.worker.rescan();
  await h.clock.advance(min(1));
  assert.equal(getConversation(h.db, A)!.mode, 'auto');
  assert.equal(h.texts(A).length, 1);
  assert.equal(getConversation(h.db, B)!.mode, 'pausado');
});

// ---------- 10 (r10): con el bot apagado el enviador no queda despertándose sin parar ----------
test('10. r10: con kill switch y un incierto ya vencido no se arma el despertador; al prender de nuevo se concilia', async () => {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  const channel = new FakeChannel(() => clock.now());
  const outbox = createOutbox({ db, channel, notifier: new FakeNotifier(), clock });
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: T0 });
  bumpVersion(db, CHAT, T0);
  insertOutbox(db, { logicalKey: `${CHAT}:1:0`, chatId: CHAT, kind: 'text', body: 'Uno', expiresUtc: T0 + min(30), contextVersion: 1, createdUtc: T0, answersUpto: 0 });
  markOutbox(db, 1, 'incierto', { nextTryUtc: T0 - 1000 });
  channel.addHistory(CHAT, { providerMsgId: 'true_x', fromMe: true, tsUtcMs: T0 + 500, text: 'Uno' });
  setSetting(db, 'kill_switch', '1');
  outbox.kick();
  await clock.flush();
  assert.equal(clock.pending, 0); // sin timer: no hay nada que despertar mientras está apagado
  assert.equal(getOutbox(db, 1)!.status, 'incierto');
  setSetting(db, 'kill_switch', '0'); // /prender → rescan → kickOutbox
  outbox.kick();
  await clock.advance(1000);
  assert.equal(getOutbox(db, 1)!.status, 'aceptado');
});

// ---------- 11: la base no pierde lo confirmado si se corta la luz ----------
test('11. la base abre con PRAGMA synchronous = FULL (2), no NORMAL (1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-sync-'));
  try {
    const db = openDb(join(dir, 'bot.sqlite'));
    assert.equal((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 12: clave o modelo de OpenAI mal puestos no son una falla del bot ----------
test('12. error de configuración de OpenAI: aviso urgente una sola vez, reintento con espera y nada al cliente (ni el mensaje seguro); al arreglarse contesta', async () => {
  const times: number[] = [];
  const llm = new ScriptedLlm((n) => {
    times.push(h.clock.t - T0);
    if (n <= 3) throw new TransientLlmError('config', 'Incorrect API key');
    return turnWith([FIRST_TEXT]);
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(10));
  assert.deepEqual(times, [2_000, 32_000, 152_000, 452_000]); // 2 s, +30 s, +2 min, +5 min
  const avisos = h.notifier.alerts.filter((a) => /clave o el modelo/.test(a.text));
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].urgent, true);
  assert.ok(!/Incorrect API key/.test(avisos[0].text)); // el texto del error puede traer pedazos de la clave: no va al aviso
  assert.deepEqual(h.texts(), [FIRST_TEXT]); // recién al arreglarse sale la respuesta, y nunca FALLBACK_TEXT
  assert.deepEqual(listAgentRuns(h.db).map((r) => r.errorKind), ['transient:config', 'transient:config', 'transient:config', null]);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
});

// ---------- 13: un chat con historia anterior sigue arrancando en humano, pero una consulta reciente sin contestar avisa ----------
test('13. chat con historia anterior al bot: arranca en humano y, si el último mensaje es del cliente y es reciente, avisa "consulta previa sin contestar en #n"', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  h.channel.addHistory(CHAT, { providerMsgId: 'old1', fromMe: true, tsUtcMs: T0 - hour(1), text: 'te paso el presupuesto' });
  h.say(CHAT, 'Gracias, lo veo y te cuento');
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  const avisos = h.notifier.alerts.filter((a) => /consulta previa sin contestar en #1/i.test(a.text));
  assert.equal(avisos.length, 1);
  assert.ok(!avisos[0].text.includes('5491')); // nunca el teléfono
  assert.equal(h.llmCalls(), 0);
  h.say(CHAT, 'otra cosa'); // chat ya conocido: no repite el aviso
  await h.clock.advance(0);
  assert.equal(h.notifier.alerts.filter((a) => /consulta previa/i.test(a.text)).length, 1);
});

test('13. sin aviso si el equipo ya contestó después, o si la consulta es más vieja que reply_window_hours', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  h.channel.addHistory(CHAT, { providerMsgId: 'old1', fromMe: true, tsUtcMs: T0 - hour(2), text: 'te paso el presupuesto' });
  h.channel.addHistory(CHAT, { providerMsgId: 'new1', fromMe: true, tsUtcMs: T0 + 5000, text: 'ya te contesté desde el celular' });
  h.say(CHAT, 'Gracias', { tsUtcMs: T0 });
  h.channel.addHistory('B@c.us', { providerMsgId: 'oldB', fromMe: true, tsUtcMs: T0 - hour(30), text: 'hola' });
  h.say('B@c.us', 'Hola, sigo con la duda', { tsUtcMs: T0 - hour(13) });
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.equal(getConversation(h.db, 'B@c.us')!.mode, 'humano');
  assert.equal(h.notifier.alerts.filter((a) => /consulta previa/i.test(a.text)).length, 0);
});

test('13. al prender: un chat nuevo con historia anterior y la última consulta del cliente reciente va al resumen como consulta previa sin contestar', async () => {
  const h = makeHarness({ botStartAgoMs: hour(72) });
  const recovery = createRecovery({ db: h.db, channel: h.channel, clock: h.clock, notifier: h.notifier, worker: { onCustomerMessage: () => {} }, onReady: () => {} });
  setState(h.db, 'alive_utc', String(h.clock.now() - min(30)));
  h.channel.addHistory(CHAT, { providerMsgId: 'o1', fromMe: true, tsUtcMs: h.clock.now() - hour(100), text: 'te mandé el presupuesto' });
  h.channel.addHistory(CHAT, { providerMsgId: 'c1', fromMe: false, tsUtcMs: h.clock.now() - min(10), text: 'lo vi, tengo una duda' });
  h.channel.addHistory('B@c.us', { providerMsgId: 'o2', fromMe: true, tsUtcMs: h.clock.now() - hour(100), text: 'hola' });
  h.channel.addHistory('B@c.us', { providerMsgId: 'o3', fromMe: true, tsUtcMs: h.clock.now() - min(10), text: 'ya te contesté' });
  const r = await recovery.reconcile();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(r.priorUnanswered, [CHAT]);
  const resumen = h.notifier.alerts.filter((a) => /consulta previa sin contestar en #1/i.test(a.text));
  assert.equal(resumen.length, 1);
  assert.ok(!/#2/.test(resumen[0].text));
});

// ---------- 14a (r5): el gasto de un intento anterior no se pierde si el siguiente tira un error pasajero ----------
test('14a. r5: intento 1 con violación (gasta) e intento 2 con error pasajero → runTurn lleva el intento 1 en el error y el worker lo registra y lo suma al presupuesto', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n === 1) return turnWith(['Buenas tardes: hola']); // viola el controlador (dos puntos)
    if (n === 2) throw new TransientLlmError('network', '503');
    return turnWith([FIRST_TEXT]);
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(20));
  assert.equal(llm.calls.length, 3);
  const un = 0.0041088; // lo que gasta cada llamada del guion
  assert.deepEqual(listAgentRuns(h.db).map((r) => [r.errorKind, r.costUsd > 0]), [['descartado', true], ['transient:network', false], [null, true]]);
  assert.ok(Math.abs(getConversation(h.db, CHAT)!.botSpentUsd - 2 * un) < 1e-9);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
});

test('14a. runTurn: el error pasajero del 2.º intento lleva el registro del 1.º', async () => {
  const llm = fakeLlm([modelTurn({ bubbles: ['Buen día, te escribimos de Olimpo Padel. De dónde sos?'] }), new TransientLlmError('network', 'timeout')]); // a las 14:00 corresponde "Buenas tardes"
  await assert.rejects(runTurn(turnInput([msg('m1', 'customer', 'Hola')], ['m1']), { llm, policy: loadPolicy(), config: { model: 'gpt-6-luna', effort: 'low' } }), (e: unknown) => {
    assert.ok(e instanceof TransientLlmError);
    assert.equal(e.attempts.length, 1);
    assert.ok(e.attempts[0].costUsd > 0 && e.attempts[0].violations.length > 0);
    return true;
  });
});

// ---------- 14b: el texto entrante no guarda caracteres NUL ----------
test('14b. los caracteres NUL del texto entrante (mensaje, edición) no se guardan', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  h.deliver(h.customerEvent(CHAT, 'Ho\u0000la, quie\u0000ro una cancha', { id: 'false_X_N1' }));
  await h.clock.advance(0);
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => m.text), ['Hola, quiero una cancha']);
  h.deliver({ kind: 'edit', session: 'default', chatId: CHAT, providerMsgId: 'false_X_N1', text: 'Hola\u0000 techada' });
  await h.clock.advance(0);
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => m.text), ['Hola techada']);
  assert.ok(!(h.db.prepare('SELECT group_concat(text) AS t FROM messages').get() as { t: string }).t.includes('\u0000'));
});

// ---------- 14c: el teléfono de un cliente no sale en los errores de WAHA (avisos y auditoría) ----------
test('14c. los errores de WAHA (HTTP, red y sesión) no llevan un chatId con el teléfono', async () => {
  const id = '5491155550000@c.us';
  const lid = '246813579024@lid';
  const waha = (respond: () => Response | never) => new WahaChannel({ baseUrl: 'http://x', apiKey: 'k', fetch: (async () => respond()) as typeof fetch });
  await assert.rejects(waha(() => new Response(`{"error":"chat ${id} no existe; también ${lid}"}`, { status: 500 })).sendText(id, 'hola'), (e: unknown) => {
    assert.ok(e instanceof ChannelError);
    assert.doesNotMatch(e.message, /\d{8,}/);
    assert.match(e.message, /@c\.us/); // se ve que había un chat, sin el número
    return true;
  });
  await assert.rejects(waha(() => { throw new TypeError(`fetch failed para ${id}`); }).sendText(id, 'hola'), (e: unknown) => e instanceof ChannelError && !/\d{8,}/.test(e.message));
  const session = createSession({
    db: openDb(':memory:'), clock: new FakeClock(), notifier: new FakeNotifier(), channel: { sessionStatus: async () => 'WORKING' }, wahaUrl: 'http://x', apiKey: 'k', webhookUrl: 'http://b/waha', hmacSecret: 's',
    fetch: (async () => new Response(`falló ${id}`, { status: 500 })) as typeof fetch,
  });
  await assert.rejects(session.qr(), (e: unknown) => e instanceof ChannelError && !/\d{8,}/.test(e.message));
});

// ---------- 14d: un mensaje de ubicación trae en `body` una miniatura en base64: se ignora ----------
test('14d. ubicación: el body (miniatura base64) no es texto; llega como adjunto sin texto, en el webhook y en el historial', async () => {
  const thumb = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/';
  const ch = new WahaChannel({ baseUrl: 'http://x', apiKey: 'k', fetch: (async () => new Response(JSON.stringify([
    { id: 'false_a@c.us_L1', timestamp: 1_791_417_457, fromMe: false, body: thumb, _data: { type: 'location' } },
    { id: 'false_a@c.us_T1', timestamp: 1_791_417_458, fromMe: false, body: 'hola', _data: { type: 'chat' } },
  ]), { status: 200 })) as typeof fetch });
  const ev = ch.parseEvent({ event: 'message.any', session: 'default', payload: { id: 'false_a@c.us_L1', timestamp: 1_791_417_457, from: 'a@c.us', to: 'b@c.us', fromMe: false, body: thumb, hasMedia: false, _data: { type: 'location' } } });
  assert.deepEqual(ev, { kind: 'message', session: 'default', chatId: 'a@c.us', providerMsgId: 'false_a@c.us_L1', tsUtcMs: 1_791_417_457_000, text: '', media: 'other' });
  assert.deepEqual((await ch.messagesSince('a@c.us', 0, 10)).map((m) => m.text), ['', 'hola']);
});

// ---------- 14e: bot_start_utc no se toca desde Telegram ----------
test('14e. /set no deja cambiar bot_start_utc (define qué chats son del equipo) ni lo ofrece en la lista de claves', async () => {
  const h = makeHarness();
  const api = new FakeTelegram();
  const tg = createTelegram({ db: h.db, clock: h.clock, token: TG_TOKEN, groupId: TG_GROUP, fetch: api.fetch, assets: policy.assets, controls: () => ({ worker: h.worker, kickOutbox: () => h.outbox.kick(), session: { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array(), mimetype: 'image/png' }) } }) });
  const before = getBotStart(h.db);
  api.text(TG_GROUP, '/set bot_start_utc 1');
  api.text(TG_GROUP, '/set');
  api.text(TG_GROUP, '/set clave_inventada 1');
  await tg.pollOnce();
  assert.equal(getBotStart(h.db), before);
  assert.match(api.texts.at(-3)!, /bot_start_utc.*no se cambia/);
  assert.ok(!/bot_start_utc, |, bot_start_utc|bot_start_utc$/.test(api.texts.at(-2)!.split('Claves:')[1]));
  assert.ok(!api.texts.at(-1)!.split('Claves:')[1].includes('bot_start_utc'));
  assert.ok(api.texts.at(-1)!.includes('daily_budget_usd'));
});

// ---------- 14f: un borrador que no llegó a Telegram se vuelve a avisar ----------
test('14f. Telegram caído cuando salió el borrador: a los 5 min se vuelve a avisar (una sola vez, con su botón) y queda el id del mensaje', async () => {
  const a = await bootApp({ shadow: true });
  a.tg.failing = true;
  await a.say(CHAT, 'Hola, quiero una cancha');
  await a.clock.advance(10_000); // el turno termina y el aviso del borrador falla
  assert.deepEqual(listDrafts(a.db, CHAT).map((d) => [d.status, d.tgMessageId]), [['pendiente', null]]);
  a.tg.failing = false;
  const intentos = a.tg.texts.length; // los intentos fallidos también quedan anotados en el Telegram falso
  const avisados = () => a.tg.texts.slice(intentos).filter((t) => t.startsWith('Borrador #1')).length;
  await a.clock.advance(min(5) + 1000);
  await a.settle();
  assert.equal(avisados(), 1);
  assert.notEqual(listDrafts(a.db, CHAT)[0].tgMessageId, null);
  await a.clock.advance(min(15)); // ya avisado: no se repite
  await a.settle();
  assert.equal(avisados(), 1);
});

test('14f. al prender también se avisan los borradores pendientes que no llegaron a Telegram (y los vencidos, no)', async () => {
  const a = await bootApp({ shadow: true, start: false });
  const t = a.clock.now();
  createConversation(a.db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: t });
  bumpVersion(a.db, CHAT, t);
  createDraft(a.db, { chatId: CHAT, contextVersion: 1, bubbles: ['Hola, de dónde sos?'], material: [], nowMs: t - min(30), answersUpto: 0 });
  createConversation(a.db, { chatId: 'viejo@c.us', session: 'default', mode: 'auto', nowMs: t });
  createDraft(a.db, { chatId: 'viejo@c.us', contextVersion: 0, bubbles: ['Muy viejo'], material: [], nowMs: t - hour(20), answersUpto: 0 }); // más viejo que reply_window_hours
  await a.app.start();
  await a.settle();
  assert.equal(a.tg.texts.filter((x) => x.startsWith('Borrador #1')).length, 1);
  assert.ok(!a.tg.texts.some((x) => x.includes('Muy viejo')));
});
