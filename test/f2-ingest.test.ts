// Ingest: guarda sin duplicar y clasifica (mensaje, propio, edición, borrado, ack, estado de sesión).
// Con kill_switch=1 el worker no contesta: se mira solo lo que hace el ingest con la base.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelError } from '../src/channel/types.ts';
import { claimInboundEvents, storeInboundEvent, createDraft, findMessage, getConversation, historyFor, insertOutbox, listAudit, listDrafts, listOutbox, markOutbox, getOutbox } from '../src/db.ts';
import { getState } from '../src/settings.ts';
import { T0 } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';

const CHAT = '5491155550000@c.us';
const quiet = () => makeHarness({ settings: { kill_switch: '1' } });

test('mensaje nuevo: crea la conversación en auto, guarda el mensaje con id m<rowid> y sube la versión', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola, quiero una cancha', { profileName: 'Pedro' });
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.mode, c.contextVersion, c.profileName, c.n, c.firstSeenUtc], ['auto', 1, 'Pedro', 1, T0]);
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => [m.id, m.author, m.text]), [['m1', 'customer', 'Hola, quiero una cancha']]);
  assert.deepEqual(h.notifier.alerts, []);
});

test('el mismo mensaje de WhatsApp por dos eventos distintos se guarda una sola vez y no sube la versión de nuevo', async () => {
  const h = quiet();
  const ev = h.customerEvent(CHAT, 'Hola', { id: 'false_X_1' });
  h.deliver(ev, 'evt_a');
  h.deliver(ev, 'evt_b');
  h.deliver(ev, 'evt_a'); // reintento HTTP: ni se guarda
  await h.clock.advance(0);
  assert.equal(historyFor(h.db, CHAT).length, 1);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, 1);
});

test('primera vez con historia anterior al arranque del bot: el chat arranca en humano', async () => {
  const h = quiet();
  h.channel.addHistory(CHAT, { providerMsgId: 'old1', fromMe: true, tsUtcMs: T0 - 3_600_000, text: 'te paso el presupuesto' });
  h.say(CHAT, 'Gracias, lo veo');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  assert.equal(c.mode, 'humano');
  assert.equal(historyFor(h.db, CHAT).length, 1); // el mensaje igual se guarda
  assert.ok(listAudit(h.db, 'takeover').some((a) => a.chatId === CHAT && /historia/.test(a.detail)));
  assert.equal(h.channel.messagesSinceCalls, 1);
  h.say(CHAT, 'otro mensaje'); // chat conocido: no se vuelve a mirar la historia
  await h.clock.advance(0);
  assert.equal(h.channel.messagesSinceCalls, 1);
});

test('primera vez sin historia anterior (solo lo de ahora, aunque WAHA lo tenga): arranca en auto', async () => {
  const h = quiet();
  h.channel.addHistory(CHAT, { providerMsgId: 'ya-despues', fromMe: false, tsUtcMs: T0 + 5_000, text: 'primer mensaje' });
  h.say(CHAT, 'primer mensaje');
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
});

test('si WAHA no responde la historia, el evento se reintenta con espera (no se pierde ni se asume nada); a los 5 fallos se guarda igual y el chat arranca en humano con aviso', async () => {
  const h = quiet();
  h.channel.messagesSinceError = new ChannelError('uncertain', 500, 'WAHA caído');
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT), undefined);
  h.channel.messagesSinceError = undefined; // WAHA vuelve
  await h.clock.advance(60_000);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(historyFor(h.db, CHAT).length, 1);

  const bad = quiet();
  bad.channel.messagesSinceError = new ChannelError('uncertain', 500, 'WAHA caído');
  bad.say('9@c.us', 'Hola');
  await bad.clock.advance(30 * 60_000);
  assert.equal(getConversation(bad.db, '9@c.us')!.mode, 'humano'); // no se pierde el mensaje: queda guardado y el chat con el equipo, por las dudas
  assert.equal(historyFor(bad.db, '9@c.us').length, 1);
  assert.ok(bad.notifier.alerts.some((a) => /historia/.test(a.text)));
  assert.equal(bad.channel.messagesSinceCalls, 5);
  assert.equal(claimInboundEvents(bad.db, bad.clock.now() + 9e9, 1000, 10).length, 0); // quedó hecho, no se reintenta más
});

test('mensaje propio que no es del bot (celular, Web): toma humana, se avisa una vez, se guarda como equipo', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  h.deliver(h.ownEvent(CHAT, 'Hola, soy Tomás, te contesto yo'));
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  assert.equal(c.mode, 'humano');
  assert.deepEqual(h.notifier.takeovers, [CHAT]);
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => m.author), ['customer', 'team']);
  assert.ok(listAudit(h.db, 'takeover').some((a) => a.chatId === CHAT));
  h.deliver(h.ownEvent(CHAT, 'ya te paso los números'));
  await h.clock.advance(0);
  assert.deepEqual(h.notifier.takeovers, [CHAT]); // ya estaba en humano: no se avisa otra vez
  assert.equal(historyFor(h.db, CHAT).length, 3);
});

test('toma humana: cancela lo pendiente de salida y los borradores del chat, aunque esté todo armado', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  const row = (k: string) => ({ logicalKey: k, chatId: CHAT, kind: 'text' as const, body: k, expiresUtc: T0 + 60_000, contextVersion: c.contextVersion, createdUtc: T0, answersUpto: 0 });
  insertOutbox(h.db, row('a:1:0'));
  insertOutbox(h.db, row('a:1:1'));
  insertOutbox(h.db, row('a:1:2'));
  markOutbox(h.db, 1, 'aceptado'); // el primero ya salió
  const d = createDraft(h.db, { chatId: CHAT, contextVersion: c.contextVersion, bubbles: ['x'], material: [], nowMs: T0, answersUpto: 0 });
  h.deliver(h.ownEvent(CHAT, 'lo tomo yo'));
  await h.clock.advance(0);
  assert.deepEqual(listOutbox(h.db).map((o) => [o.status, o.cause]), [['aceptado', null], ['cancelado', 'toma_humana'], ['cancelado', 'toma_humana']]);
  assert.equal(listDrafts(h.db, CHAT).find((x) => x.id === d)!.status, 'descartado');
});

test('mensaje propio en un chat que no existía: queda en humano sin avisar (el bot solo responde a quien escribe primero)', async () => {
  const h = quiet();
  h.deliver(h.ownEvent('777@c.us', 'Hola, te escribo yo'));
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, '777@c.us')!.mode, 'humano');
  assert.deepEqual(h.notifier.takeovers, []);
  assert.deepEqual(historyFor(h.db, '777@c.us').map((m) => m.author), ['team']);
});

test('eco del bot por id: el envío queda aceptado, no es toma humana y no se duplica el mensaje', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  insertOutbox(h.db, { logicalKey: 'k:1:0', chatId: CHAT, kind: 'text', body: 'Buenas tardes', expiresUtc: T0 + 60_000, contextVersion: c.contextVersion, createdUtc: T0, answersUpto: 0 });
  markOutbox(h.db, 1, 'en_proceso', { providerMsgId: 'true_X_1' });
  h.deliver(h.ownEvent(CHAT, 'Buenas tardes', { id: 'true_X_1', source: 'api' }));
  await h.clock.advance(0);
  assert.equal(getOutbox(h.db, 1)!.status, 'aceptado');
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(h.notifier.takeovers, []);
  assert.deepEqual(historyFor(h.db, CHAT).map((m) => m.author), ['customer', 'bot']);
  h.deliver(h.ownEvent(CHAT, 'Buenas tardes', { id: 'true_X_1', source: 'api' }), 'evt_otro'); // el mismo eco otra vez
  await h.clock.advance(0);
  assert.equal(historyFor(h.db, CHAT).length, 2);
});

test('eco que llega antes que el id de la respuesta (el envío sigue en proceso): se reconoce por el texto, sin falsa toma humana', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  insertOutbox(h.db, { logicalKey: 'k:1:0', chatId: CHAT, kind: 'text', body: 'Buenas tardes', expiresUtc: T0 + 60_000, contextVersion: c.contextVersion, createdUtc: T0, answersUpto: 0 });
  markOutbox(h.db, 1, 'en_proceso');
  h.deliver(h.ownEvent(CHAT, 'Buenas tardes', { id: 'true_X_9', source: 'api' }));
  await h.clock.advance(0);
  const row = getOutbox(h.db, 1)!;
  assert.deepEqual([row.status, row.providerMsgId], ['aceptado', 'true_X_9']);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(h.notifier.takeovers, []);
});

test('un envío incierto se resuelve solo si llega el eco (aceptado); y uno ya dado por "no confirmado" se corrige si el eco llega tarde', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  const row = (k: string, body: string) => ({ logicalKey: k, chatId: CHAT, kind: 'text' as const, body, expiresUtc: T0 + 60_000, contextVersion: c.contextVersion, createdUtc: T0, answersUpto: 0 });
  insertOutbox(h.db, row('k:1:0', 'uno'));
  insertOutbox(h.db, row('k:1:1', 'dos'));
  markOutbox(h.db, 1, 'incierto', { cause: 'timeout' });
  markOutbox(h.db, 2, 'fallido', { cause: 'no_confirmado' });
  h.db.prepare('UPDATE outbox SET attempted_utc = ? WHERE id IN (1, 2)').run(T0);
  h.deliver(h.ownEvent(CHAT, 'uno', { id: 'true_a', source: 'api' }));
  h.deliver(h.ownEvent(CHAT, 'dos', { id: 'true_b', source: 'api' }));
  await h.clock.advance(0);
  assert.deepEqual([getOutbox(h.db, 1)!.status, getOutbox(h.db, 2)!.status], ['aceptado', 'aceptado']);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(h.notifier.takeovers, []);
});

test('un mensaje nuevo del cliente cancela lo pendiente de versiones anteriores (respuesta vieja) y vence los borradores', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const v1 = getConversation(h.db, CHAT)!.contextVersion;
  const row = (k: string) => ({ logicalKey: k, chatId: CHAT, kind: 'text' as const, body: k, expiresUtc: T0 + 60_000, contextVersion: v1, createdUtc: T0, answersUpto: 0 });
  insertOutbox(h.db, row('k:1:0'));
  createDraft(h.db, { chatId: CHAT, contextVersion: v1, bubbles: ['x'], material: [], nowMs: T0, answersUpto: 0 });
  h.say(CHAT, 'Ah, y además quiero techada');
  await h.clock.advance(0);
  assert.deepEqual(listOutbox(h.db).map((o) => [o.status, o.cause]), [['cancelado', 'contexto_nuevo']]);
  assert.equal(listDrafts(h.db, CHAT)[0].status, 'vencido');
});

test('edición y borrado: corrigen el mensaje y suben la versión, pero nunca abren un turno solos', async () => {
  const h = makeHarness(); // acá el worker está prendido
  const ev = h.customerEvent(CHAT, 'Quiero 2 canchas', { id: 'false_5491155550000@c.us_3EB0AAAA' });
  h.deliver(ev);
  await h.clock.advance(10_000);
  assert.equal(h.llmCalls(), 1);
  const v = getConversation(h.db, CHAT)!.contextVersion;
  h.deliver({ kind: 'edit', session: 'default', chatId: CHAT, providerMsgId: '3EB0AAAA', text: 'Quiero 3 canchas' }); // WAHA manda el tramo final del id
  await h.clock.advance(10_000);
  const edited = findMessage(h.db, 'default', 'false_5491155550000@c.us_3EB0AAAA')!;
  assert.deepEqual([edited.text, edited.edited], ['Quiero 3 canchas', true]);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, v + 1);
  h.deliver({ kind: 'revoke', session: 'default', chatId: CHAT, providerMsgId: 'false_5491155550000@c.us_3EB0AAAA' });
  await h.clock.advance(10_000);
  assert.equal(findMessage(h.db, 'default', 'false_5491155550000@c.us_3EB0AAAA')!.revoked, true);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, v + 2);
  assert.equal(h.llmCalls(), 1); // ni la edición ni el borrado llamaron al modelo
  h.deliver({ kind: 'edit', session: 'default', chatId: CHAT, providerMsgId: 'no-existe', text: 'x' }); // de un mensaje que no tenemos: se ignora
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, v + 2);
});

test('ack: sent/delivered/read se anotan en la salida; failed la deja fallida con aviso; de un id desconocido no pasa nada', async () => {
  const h = quiet();
  h.say(CHAT, 'Hola');
  await h.clock.advance(0);
  const c = getConversation(h.db, CHAT)!;
  const row = (k: string) => ({ logicalKey: k, chatId: CHAT, kind: 'text' as const, body: k, expiresUtc: T0 + 60_000, contextVersion: c.contextVersion, createdUtc: T0, answersUpto: 0 });
  insertOutbox(h.db, row('k:1:0'));
  insertOutbox(h.db, row('k:1:1'));
  markOutbox(h.db, 1, 'aceptado', { providerMsgId: 'true_a' });
  markOutbox(h.db, 2, 'aceptado', { providerMsgId: 'true_b' });
  h.deliver({ kind: 'ack', providerMsgId: 'true_a', status: 'delivered' });
  h.deliver({ kind: 'ack', providerMsgId: 'true_b', status: 'failed' });
  h.deliver({ kind: 'ack', providerMsgId: 'true_desconocido', status: 'read' });
  await h.clock.advance(0);
  assert.deepEqual([getOutbox(h.db, 1)!.status, getOutbox(h.db, 1)!.ack], ['aceptado', 'delivered']);
  assert.deepEqual([getOutbox(h.db, 2)!.status, getOutbox(h.db, 2)!.cause], ['fallido', 'ack_failed']);
  assert.equal(h.notifier.alerts.length, 1);
  assert.match(h.notifier.alerts[0].text, /#1/);
  assert.doesNotMatch(h.notifier.alerts[0].text, /5491155550000/); // nunca el teléfono
});

test('adjunto sin texto (foto, video…): se guarda, no abre turno y avisa que el bot no lo lee; con texto, se procesa con el texto', async () => {
  const h = makeHarness();
  h.say(CHAT, '', { media: 'image' });
  await h.clock.advance(10_000);
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.texts().length, 0);
  assert.equal(h.notifier.alerts.length, 1);
  assert.match(h.notifier.alerts[0].text, /#1.*imagen.*no lo lee/);
  assert.equal((h.db.prepare("SELECT media FROM messages WHERE chat_id = ?").get(CHAT) as { media: string }).media, 'image');
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, 0); // el adjunto sin texto no cambia lo que ve el modelo
  h.say(CHAT, 'Mirá esta foto del terreno', { media: 'image' }); // con leyenda: es un mensaje de texto más
  await h.clock.advance(10_000);
  assert.equal(h.llmCalls(), 1);
  assert.equal(h.notifier.alerts.length, 1);
  assert.equal(h.texts().length, 1);
});

test('session.status: solo se guarda (la parte B lo usa)', async () => {
  const h = quiet();
  h.deliver({ kind: 'session_status', session: 'default', status: 'SCAN_QR_CODE' });
  await h.clock.advance(0);
  assert.equal(getState(h.db, 'session_status'), 'SCAN_QR_CODE');
});

test('lo ignorado (grupos, estados, sistema) no crea nada, y el evento queda hecho', async () => {
  const h = quiet();
  h.deliver({ kind: 'ignored', reason: 'not_direct_chat' });
  await h.clock.advance(0);
  assert.equal(getConversation(h.db, CHAT), undefined);
  assert.equal(claimInboundEvents(h.db, T0 + 9e9, 1000, 10).length, 0);
});

test('mensaje de un chat en humano: se guarda y sube la versión, pero no programa turno', async () => {
  const h = makeHarness();
  h.deliver(h.ownEvent(CHAT, 'te escribo yo'));
  await h.clock.advance(0);
  h.say(CHAT, 'Hola, ahora sí');
  await h.clock.advance(10_000);
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.channel.sendCalls, 0);
  assert.equal(historyFor(h.db, CHAT).length, 2);
});

test('si el proceso murió con el evento tomado, el lock vence y el evento se procesa una sola vez', async () => {
  const h = quiet();
  storeInboundEvent(h.db, 'evt_lock', JSON.stringify({ id: 'evt_lock', inbound: h.customerEvent(CHAT, 'Hola', { id: 'false_X_1' }) }), h.clock.now());
  claimInboundEvents(h.db, h.clock.now(), 120_000, 10); // alguien lo tomó y murió sin terminar
  await h.ingest.processPending();
  assert.equal(getConversation(h.db, CHAT), undefined); // todavía bloqueado
  await h.clock.advance(121_000);
  await h.ingest.processPending();
  assert.equal(historyFor(h.db, CHAT).length, 1);
  await h.ingest.processPending();
  assert.equal(historyFor(h.db, CHAT).length, 1);
});

test('un Telegram caído no tumba el ingest: el aviso falla y el evento se procesa igual', async () => {
  const h = quiet();
  h.notifier.failing = true;
  h.say(CHAT, '', { media: 'video' });
  await h.clock.advance(0);
  assert.equal(h.notifier.alerts.length, 0);
  assert.ok(listAudit(h.db, 'error').some((a) => /aviso/.test(a.detail)));
  assert.equal(claimInboundEvents(h.db, T0 + 9e9, 1000, 10).length, 0); // quedó hecho, no en bucle
});

