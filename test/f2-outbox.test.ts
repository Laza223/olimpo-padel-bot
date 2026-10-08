// Outbox: un solo enviador, estados, incierto → conciliar (nunca reintentar a ciegas), 463/475 sin bucle, vencidos sin mandar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FakeChannel } from '../src/channel/fake.ts';
import { ChannelError } from '../src/channel/types.ts';
import { bumpVersion, cancelChatOutbox, createConversation, createDraft, getConversation, getDraft, historyFor, insertMessage, listAudit, listOutbox, markOutbox, openDb, recoverOutbox } from '../src/db.ts';
import { approveDraft, createOutbox, enqueueReply } from '../src/outbox.ts';
import { setSetting } from '../src/settings.ts';
import { FakeClock, FakeNotifier, T0, policy } from './f2-helpers.ts';

const CHAT = '5491155550000@c.us';
const LONG = 'Este es un globo largo de más de cincuenta caracteres para que la espera de tipeo llegue al tope configurado.';

function setup(settings: Record<string, string> = {}) {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  setSetting(db, 'typing_ms', '1000');
  for (const [k, v] of Object.entries(settings)) setSetting(db, k, v);
  const channel = new FakeChannel(() => clock.now());
  const notifier = new FakeNotifier();
  const outbox = createOutbox({ db, channel, notifier, clock });
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: T0 });
  bumpVersion(db, CHAT, T0); // las respuestas de estas pruebas son de la versión 1: el chat está en la 1 (una versión vieja no sale)
  const enqueue = (bubbles: string[], o: { chatId?: string; version?: number; material?: string[]; answersUpto?: number } = {}) =>
    enqueueReply(db, { chatId: o.chatId ?? CHAT, version: o.version ?? 1, bubbles, material: o.material ?? [], assets: policy.assets, nowMs: clock.now(), answersUpto: o.answersUpto ?? 0 });
  return { clock, db, channel, notifier, outbox, enqueue };
}

test('enqueueReply: globos primero y después las imágenes (una por archivo), con clave chat:versión:índice y vencimiento', () => {
  const { db, clock, enqueue } = setup();
  assert.equal(enqueue(['Uno', 'Dos'], { material: ['fabricacion_panos', 'modelo_full_panoramica'] }), 5);
  const rows = listOutbox(db);
  assert.deepEqual(rows.map((r) => [r.logicalKey, r.kind]), [
    [`${CHAT}:1:0`, 'text'], [`${CHAT}:1:1`, 'text'], [`${CHAT}:1:2`, 'image'], [`${CHAT}:1:3`, 'image'], [`${CHAT}:1:4`, 'image'],
  ]);
  assert.ok(rows.every((r) => r.status === 'pendiente' && r.expiresUtc === clock.now() + 30 * 60_000));
  const img = (i: number) => JSON.parse(rows[i].body) as { file: string; caption?: string };
  assert.equal(img(2).file, fileURLToPath(new URL('../assets/fabricacion-panos-1.jpg', import.meta.url)));
  assert.equal(img(2).caption, 'Te paso unas fotos de cómo fabricamos.'); // leyenda de assets.yaml, en la primera foto de un material real
  assert.equal(img(3).caption, undefined);
  assert.equal(img(4).file, fileURLToPath(new URL('../assets/modelo-full-panoramica.jpg', import.meta.url)));
  assert.equal(img(4).caption, undefined); // los renders van sin leyenda (policy/assets.yaml)
});

test('enqueueReply: encolar dos veces la misma respuesta no duplica nada; un id de material desconocido se salta', () => {
  const { db, enqueue } = setup();
  assert.equal(enqueue(['Uno'], { material: ['no_existe'] }), 1);
  assert.equal(enqueue(['Uno otra vez']), 0);
  assert.equal(listOutbox(db).length, 1);
  assert.equal(enqueue(['Nueva'], { version: 2 }), 1);
});

test('un globo: escribiendo, espera, sale, queda aceptado con el id de WAHA, se guarda como mensaje del bot y marca lo contestado', async () => {
  const { db, clock, channel, outbox, enqueue } = setup();
  const m1 = insertMessage(db, { session: 'default', providerMsgId: 'c1', chatId: CHAT, author: 'customer', text: 'Hola', tsUtcMs: T0 });
  enqueue([LONG], { answersUpto: m1.id });
  outbox.kick();
  await clock.advance(999);
  assert.equal(channel.sent.length, 0); // todavía "escribiendo"
  assert.deepEqual(channel.typingLog, [{ chatId: CHAT, on: true }]);
  await clock.advance(1);
  assert.deepEqual(channel.sent.map((m) => [m.chatId, m.text]), [[CHAT, LONG]]);
  assert.deepEqual(channel.typingLog, [{ chatId: CHAT, on: true }, { chatId: CHAT, on: false }]);
  const row = listOutbox(db)[0];
  assert.deepEqual([row.status, row.providerMsgId, row.attempt], ['aceptado', channel.sent[0].providerMsgId, 1]);
  assert.deepEqual(historyFor(db, CHAT).map((m) => [m.author, m.text]), [['customer', 'Hola'], ['bot', LONG]]);
  assert.equal(getConversation(db, CHAT)!.answeredUpto, m1.id);
});

test('dos globos salen en orden, con una pausa entre uno y otro (typing_ms por globo, con tope)', async () => {
  const { clock, channel, outbox, enqueue } = setup();
  enqueue([LONG, `${LONG} Segundo.`]);
  outbox.kick();
  await clock.advance(1000);
  assert.equal(channel.sent.length, 1);
  await clock.advance(999);
  assert.equal(channel.sent.length, 1);
  await clock.advance(1);
  assert.equal(channel.sent.length, 2);
  assert.deepEqual(channel.sent.map((m) => m.text.endsWith('Segundo.')), [false, true]);
});

test('un globo corto no espera el tope entero (la espera sigue al largo del texto)', async () => {
  const { clock, channel, outbox, enqueue } = setup({ typing_ms: '2500' });
  enqueue(['Dale']);
  outbox.kick();
  await clock.advance(399);
  assert.equal(channel.sent.length, 0);
  await clock.advance(1);
  assert.equal(channel.sent.length, 1);
});

test('imágenes: salen después de los globos, sin "escribiendo", con la leyenda', async () => {
  const { clock, channel, outbox, enqueue, db } = setup();
  enqueue(['Te paso unas fotos'], { material: ['fabricacion_panos'] });
  outbox.kick();
  await clock.advance(5000);
  assert.deepEqual(channel.sent.map((m) => [m.kind, m.text]), [['text', 'Te paso unas fotos'], ['image', 'Te paso unas fotos de cómo fabricamos.'], ['image', '']]);
  assert.match(channel.sent[1].filePath!, /fabricacion-panos-1\.jpg$/);
  assert.equal(channel.typingLog.filter((t) => t.on).length, 1); // solo el globo de texto
  assert.ok(listOutbox(db).every((r) => r.status === 'aceptado'));
});

test('si falla "escribiendo", el envío sale igual', async () => {
  const { clock, channel, outbox, enqueue } = setup();
  channel.typing = async () => { throw new Error('WAHA no entiende startTyping'); };
  enqueue(['Hola']);
  outbox.kick();
  await clock.advance(5000);
  assert.equal(channel.sent.length, 1);
});

test('incierto (el envío salió pero se perdió la respuesta): no se reenvía; se concilia con el historial y queda aceptado', async () => {
  const { clock, channel, outbox, enqueue, db, notifier } = setup();
  channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: true });
  enqueue(['Uno', 'Dos']);
  outbox.kick();
  await clock.advance(1000);
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['incierto', 'pendiente']);
  await clock.advance(2500); // todavía no se concilió, y el globo 2 espera
  assert.equal(channel.sendCalls, 1);
  await clock.advance(60_000);
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['aceptado', 'aceptado']);
  assert.equal(listOutbox(db)[0].providerMsgId, channel.sent[0].providerMsgId); // el id lo sacó del historial
  assert.deepEqual(channel.sent.map((m) => m.text), ['Uno', 'Dos']); // cada globo, una sola vez
  assert.equal(channel.sendCalls, 2);
  assert.deepEqual(historyFor(db, CHAT).map((m) => m.text), ['Uno', 'Dos']);
  assert.equal(notifier.alerts.length, 0);
});

test('incierto que no aparece en el historial: queda fallido con aviso para revisar a mano, sin reintento y sin mandar el resto', async () => {
  const { clock, channel, outbox, enqueue, db, notifier } = setup();
  channel.failNextSend(new ChannelError('uncertain', 500, 'WAHA 500'), { delivered: false });
  enqueue(['Uno', 'Dos']);
  outbox.kick();
  await clock.advance(10 * 60_000);
  assert.deepEqual(listOutbox(db).map((r) => [r.status, r.cause]), [['fallido', 'no_confirmado'], ['cancelado', 'anterior_fallo']]);
  assert.equal(channel.sendCalls, 1); // nunca se reintentó
  assert.equal(channel.sent.length, 0);
  assert.equal(notifier.alerts.length, 1);
  assert.deepEqual(notifier.alerts[0].urgent, true);
  assert.match(notifier.alerts[0].text, /#1.*a mano/);
  assert.doesNotMatch(notifier.alerts[0].text, /5491155550000/);
});

test('conciliar no confunde un mensaje igual que ya es de otra respuesta (dos "Dale" seguidos)', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ typing_ms: '0' });
  enqueue(['Dale'], { version: 1 });
  outbox.kick();
  await clock.advance(1000);
  assert.equal(listOutbox(db)[0].status, 'aceptado');
  channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: false });
  bumpVersion(db, CHAT, T0); // el cliente escribió otra vez: el chat pasa a la versión 2
  enqueue(['Dale'], { version: 2 });
  outbox.kick();
  await clock.advance(60_000);
  const rows = listOutbox(db);
  assert.deepEqual(rows.map((r) => r.status), ['aceptado', 'fallido']); // el "Dale" del historial es el primero, no el segundo
  assert.equal(channel.sendCalls, 2);
});

test('si WAHA no deja mirar el historial, el incierto sigue incierto y se reintenta la conciliación; pasados 10 minutos, fallido con aviso', async () => {
  const { clock, channel, outbox, enqueue, db, notifier } = setup();
  channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: true });
  channel.messagesSinceError = new ChannelError('uncertain', 500, 'WAHA caído');
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(5 * 60_000);
  assert.equal(listOutbox(db)[0].status, 'incierto');
  assert.equal(notifier.alerts.length, 0);
  assert.ok(channel.messagesSinceCalls >= 5);
  await clock.advance(6 * 60_000);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].cause], ['fallido', 'no_confirmado']);
  assert.equal(notifier.alerts.length, 1);
  assert.equal(channel.sendCalls, 1);
});

test('si WAHA vuelve a tiempo, la conciliación encuentra el mensaje y queda aceptado', async () => {
  const { clock, channel, outbox, enqueue, db } = setup();
  channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: true });
  channel.messagesSinceError = new ChannelError('uncertain', 500, 'WAHA caído');
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(2 * 60_000);
  channel.messagesSinceError = undefined;
  await clock.advance(60_000);
  assert.equal(listOutbox(db)[0].status, 'aceptado');
  assert.equal(channel.sendCalls, 1);
});

test('463 y 475: fallido con causa restricted y aviso, sin bucle de reintentos y sin mandar el resto', async () => {
  for (const code of [463, 475]) {
    const { clock, channel, outbox, enqueue, db, notifier } = setup();
    channel.failNextSend(new ChannelError('restricted', code, `server returned error ${code}`));
    enqueue(['Uno', 'Dos']);
    outbox.kick();
    await clock.advance(3_600_000);
    assert.deepEqual(listOutbox(db).map((r) => [r.status, r.cause]), [['fallido', 'restricted'], ['cancelado', 'anterior_fallo']], String(code));
    assert.equal(channel.sendCalls, 1, String(code));
    assert.equal(notifier.alerts.length, 1, String(code));
    assert.match(notifier.alerts[0].text, new RegExp(String(code)));
    assert.equal(notifier.alerts[0].urgent, true);
  }
});

test('autenticación: fallido con causa auth y aviso urgente, sin reintentar', async () => {
  const { clock, channel, outbox, enqueue, db, notifier } = setup();
  channel.failNextSend(new ChannelError('auth', 401, 'Unauthorized'));
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(3_600_000);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].cause], ['fallido', 'auth']);
  assert.equal(channel.sendCalls, 1);
  assert.equal(notifier.alerts[0].urgent, true);
});

test('error transitorio (seguro que no salió): se reintenta con espera y a la 3.ª queda fallido con aviso', async () => {
  const { clock, channel, outbox, enqueue, db, notifier } = setup({ typing_ms: '0' });
  for (let i = 0; i < 3; i++) channel.failNextSend(new ChannelError('transient', 422, 'sesión no está WORKING'));
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(1000);
  assert.deepEqual([listOutbox(db)[0].status, channel.sendCalls], ['pendiente', 1]);
  await clock.advance(3999);
  assert.equal(channel.sendCalls, 1); // espera de 5 s desde el primer fallo
  await clock.advance(1);
  assert.equal(channel.sendCalls, 2);
  await clock.advance(29_999);
  assert.equal(channel.sendCalls, 2); // y 30 s desde el segundo
  await clock.advance(1);
  assert.equal(channel.sendCalls, 3);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].cause], ['fallido', 'transient']);
  assert.equal(notifier.alerts.length, 1);
  await clock.advance(3_600_000);
  assert.equal(channel.sendCalls, 3);
});

test('error transitorio que se arregla: sale una sola vez', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ typing_ms: '0' });
  channel.failNextSend(new ChannelError('transient', undefined, 'sin conexión con WAHA (ECONNREFUSED)'));
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(10_000);
  assert.equal(channel.sent.length, 1);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].attempt], ['aceptado', 2]);
});

test('lo vencido no se manda: ni lo que espera, ni lo que ya venció cuando le toca', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ outbox_expiry_min: '0' });
  enqueue(['Viejo']);
  outbox.kick();
  await clock.advance(10_000);
  assert.equal(channel.sendCalls, 0);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].cause], ['vencido', 'vencido']);

  const late = setup({ typing_ms: '0' });
  late.channel.failNextSend(new ChannelError('transient', 422, 'x'));
  late.enqueue(['Se vence esperando']);
  late.outbox.kick();
  await late.clock.advance(1000);
  assert.equal(listOutbox(late.db)[0].status, 'pendiente'); // en espera de reintento (5 s)
  late.db.prepare('UPDATE outbox SET expires_utc = ?').run(late.clock.now() + 2000); // vence antes del reintento
  await late.clock.advance(60_000);
  assert.deepEqual([listOutbox(late.db)[0].status, late.channel.sendCalls], ['vencido', 1]);
});

test('lo que vence mientras el bot "escribe" no sale (se vuelve a chequear justo antes de mandar)', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ typing_ms: '2500' });
  enqueue([LONG]);
  outbox.kick();
  await clock.advance(500);
  db.prepare('UPDATE outbox SET expires_utc = ?').run(clock.now() + 1000); // vence antes de terminar de "escribir"
  await clock.advance(10_000);
  assert.equal(channel.sendCalls, 0);
  assert.deepEqual([listOutbox(db)[0].status, listOutbox(db)[0].cause], ['vencido', 'vencido']);
});

test('kill switch: no sale nada; al prenderlo de nuevo sale lo que todavía no venció', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ kill_switch: '1', typing_ms: '0' });
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(10_000);
  assert.equal(channel.sendCalls, 0);
  setSetting(db, 'kill_switch', '0');
  outbox.kick();
  await clock.advance(1000);
  assert.equal(channel.sent.length, 1);
});

test('lo que se cancela mientras el bot "escribe" no sale (toma humana a mitad del globo)', async () => {
  const { clock, channel, outbox, enqueue, db } = setup();
  enqueue([LONG, 'Segundo']);
  outbox.kick();
  await clock.advance(500); // escribiendo el primero
  cancelChatOutbox(db, CHAT, 'toma_humana');
  await clock.advance(10_000);
  assert.equal(channel.sendCalls, 0);
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['cancelado', 'cancelado']);
  assert.deepEqual(channel.typingLog.at(-1), { chatId: CHAT, on: false }); // "escribiendo" siempre se apaga
});

test('un solo enviador a la vez, y el orden entre chats es el de llegada; un chat esperando un reintento no frena a los otros', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ typing_ms: '0' });
  createConversation(db, { chatId: 'b@c.us', session: 'default', mode: 'auto', nowMs: T0 });
  bumpVersion(db, 'b@c.us', T0);
  let inFlight = 0;
  let maxInFlight = 0;
  const real = channel.sendText.bind(channel);
  channel.sendText = async (chatId, text) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await real(chatId, text); } finally { inFlight--; }
  };
  channel.failNextSend(new ChannelError('transient', 422, 'x')); // el primer envío (chat A) falla y espera
  enqueue(['A1', 'A2']);
  enqueue(['B1', 'B2'], { chatId: 'b@c.us' });
  outbox.kick();
  await clock.advance(1000);
  assert.deepEqual(channel.sent.map((m) => m.text), ['B1', 'B2']); // A espera su reintento y no frena a B
  await clock.advance(10_000);
  assert.deepEqual(channel.sent.map((m) => m.text), ['B1', 'B2', 'A1', 'A2']); // y el orden de A se respeta
  assert.equal(maxInFlight, 1);
});

test('stop() detiene el enviador (no quedan timers)', async () => {
  const { clock, outbox, enqueue, channel } = setup({ typing_ms: '0' });
  channel.failNextSend(new ChannelError('transient', 422, 'x'));
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(1000);
  assert.ok(clock.pending > 0); // el reintento
  outbox.stop();
  assert.equal(clock.pending, 0);
  await clock.advance(60_000);
  assert.equal(channel.sendCalls, 1);
});

test('un error raro del canal (que no es ChannelError) se trata como incierto: nunca un reenvío a ciegas', async () => {
  const { clock, channel, outbox, enqueue, db } = setup({ typing_ms: '0' });
  channel.sendText = async () => { throw new Error('algo muy raro'); };
  enqueue(['Uno']);
  outbox.kick();
  await clock.advance(1000);
  assert.equal(listOutbox(db)[0].status, 'incierto');
  await clock.advance(11 * 60_000);
  assert.equal(listOutbox(db)[0].status, 'fallido');
  assert.ok(listAudit(db, 'error').length >= 1);
});

test('[Mandar] de un borrador: si el contexto no cambió va al outbox (con la clave del borrador) y sale una sola vez; si cambió, vencido; dos veces no duplica', async () => {
  const { db, clock, channel, outbox } = setup({ typing_ms: '0' });
  const m1 = insertMessage(db, { session: 'default', providerMsgId: 'c1', chatId: CHAT, author: 'customer', text: 'Hola', tsUtcMs: T0 });
  const v = bumpVersion(db, CHAT, T0);
  const draft = createDraft(db, { chatId: CHAT, contextVersion: v, bubbles: ['Uno', 'Dos'], material: ['modelo_panoramica'], nowMs: T0, answersUpto: m1.id });
  assert.equal(approveDraft(db, draft, policy.assets, clock.now()), 'enviado');
  assert.equal(approveDraft(db, draft, policy.assets, clock.now()), 'no_pendiente');
  assert.equal(getDraft(db, draft)!.status, 'mandado');
  assert.deepEqual(listOutbox(db).map((r) => [r.logicalKey, r.answersUpto]), [[`${CHAT}:${v}:0`, m1.id], [`${CHAT}:${v}:1`, m1.id], [`${CHAT}:${v}:2`, m1.id]]);
  outbox.kick();
  await clock.advance(5000);
  assert.deepEqual(channel.sent.map((m) => m.kind), ['text', 'text', 'image']);
  assert.equal(getConversation(db, CHAT)!.answeredUpto, m1.id);
  const stale = createDraft(db, { chatId: CHAT, contextVersion: v, bubbles: ['Viejo'], material: [], nowMs: T0, answersUpto: m1.id });
  bumpVersion(db, CHAT, T0 + 1); // el cliente escribió de nuevo
  assert.equal(approveDraft(db, stale, policy.assets, clock.now()), 'vencido');
  assert.equal(getDraft(db, stale)!.status, 'vencido');
  assert.equal(listOutbox(db).length, 3);
  assert.equal(approveDraft(db, 999, policy.assets, clock.now()), 'no_pendiente');
});

test('al prender, lo que estaba "en proceso" cuando murió el proceso se trata como incierto y se concilia: nunca se reenvía a ciegas', async () => {
  const { db, clock, channel, outbox, enqueue, notifier } = setup({ typing_ms: '0' });
  enqueue(['Uno', 'Dos']);
  markOutbox(db, 1, 'en_proceso'); // el proceso murió a mitad del envío
  db.prepare('UPDATE outbox SET attempted_utc = ? WHERE id = 1').run(clock.now());
  channel.addHistory(CHAT, { providerMsgId: 'true_x', fromMe: true, tsUtcMs: clock.now() + 1000, text: 'Uno' }); // sí había salido
  assert.equal(recoverOutbox(db, clock.now()), 1);
  assert.equal(recoverOutbox(db, clock.now()), 0);
  outbox.kick();
  await clock.advance(10_000);
  assert.deepEqual(listOutbox(db).map((r) => [r.status, r.providerMsgId]), [['aceptado', 'true_x'], ['aceptado', channel.sent[0].providerMsgId]]);
  assert.deepEqual(channel.sent.map((m) => m.text), ['Dos']); // el "Uno" no se reenvió
  assert.equal(notifier.alerts.length, 0);
});

test('al prender, un "en proceso" que no aparece en el historial queda fallido con aviso y no frena el resto para siempre', async () => {
  const { db, clock, channel, outbox, enqueue, notifier } = setup({ typing_ms: '0' });
  enqueue(['Uno', 'Dos']);
  markOutbox(db, 1, 'en_proceso');
  recoverOutbox(db, clock.now());
  outbox.kick();
  await clock.advance(10_000);
  assert.deepEqual(listOutbox(db).map((r) => [r.status, r.cause]), [['fallido', 'no_confirmado'], ['cancelado', 'anterior_fallo']]);
  assert.equal(channel.sendCalls, 0);
  assert.equal(notifier.alerts.length, 1);
});
