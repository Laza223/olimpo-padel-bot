// Aceptación de F2 parte B: las pruebas 7, 11 y 15 de docs/F2-contrato.md, con la app completa (main.ts) y el canal, el cerebro, Telegram y WAHA falsos. Sin red externa.
//  7. Al reiniciar no sale una ráfaga atrasada
// 11. FAILED, autenticación o 463/475 → avisan sin bucles
// 15. Lo que llegó durante una caída se recupera según reply_window_hours
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeChannel } from '../src/channel/fake.ts';
import { ChannelError } from '../src/channel/types.ts';
import { getConversation, listOutbox, openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { FakeLlm } from '../src/fakeLlm.ts';
import { ensureBotStart, setSetting, setState } from '../src/settings.ts';
import { FIRST_TEXT, FakeClock } from './f2-helpers.ts';
import { bootApp } from './f2b-app.ts';
import type { BootedApp } from './f2b-app.ts';

const CHAT = '5491155550000@c.us';
const c = (n: number) => `54911000000${String(n).padStart(2, '0')}@c.us`;
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;
const llmCalls = (a: BootedApp) => (a.app.llm as FakeLlm).calls;
const alerts = (a: BootedApp, re: RegExp) => a.tg.texts.filter((t) => re.test(t));
const SESSION_FAILED = /La sesión de WhatsApp falló \(FAILED\)/; // el aviso de la sesión (el de "más de 10 min esperando" es otro)

// Un bot que ya venía andando: base con arranque anterior (los chats nuevos no cuentan como "historia previa") y el último momento en que todo andaba.
function priorRun(clock: FakeClock, o: { downMs: number; shadow?: boolean }): Db {
  const db = openDb(':memory:');
  setSetting(db, 'shadow_mode', o.shadow ? '1' : '0');
  ensureBotStart(db, clock.now() - hour(72));
  setState(db, 'alive_utc', String(clock.now() - o.downMs));
  return db;
}
const history = (ch: FakeChannel, chat: string, text: string, tsUtcMs: number, id: string) => ch.addHistory(chat, { providerMsgId: id, fromMe: false, tsUtcMs, text });

// ---------- 7 ----------
test('7. Al reiniciar después de una noche apagado no sale una ráfaga atrasada: lo vencido no sale y solo se contesta lo reciente', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const db = openDb(':memory:');
  setSetting(db, 'shadow_mode', '0');
  // primera vida: tres clientes escriben y sus respuestas quedan esperando salir
  const first = await bootApp({ clock, channel, db });
  for (const n of [1, 2, 3]) await first.say(c(n), 'Hola, quiero una cancha');
  await clock.advance(sec(2) + sec(0.5));
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['pendiente', 'pendiente', 'pendiente']);
  assert.equal(channel.sendCalls, 0);
  await first.app.shutdown('se cerró la notebook');
  db.prepare("UPDATE outbox SET status = 'en_proceso' WHERE id = 3").run(); // y una se cortó a mitad de envío
  const t0 = clock.now();
  await clock.advance(hour(14)); // la notebook estuvo cerrada toda la noche
  // mientras tanto: el cliente 1 volvió a escribir y apareció uno nuevo (el 4)
  history(channel, c(1), 'Perdón, ¿están? Quiero techada', clock.now() - min(10), 'false_c1_late');
  history(channel, c(4), 'Hola, quiero una cancha', clock.now() - min(2), 'false_c4');

  const second = await bootApp({ clock, channel, db });
  await clock.advance(min(3));
  // se contestó una sola vez a lo reciente (1 y 4) y nada de lo viejo (2 y 3)
  assert.deepEqual(channel.sent.map((m) => m.chatId).sort(), [c(1), c(4)]);
  const NIGHT_TEXT = FIRST_TEXT.replace('Buenas tardes', 'Buenas noches'); // 14 h después son las 4 de la mañana: el saludo es el de la hora
  assert.deepEqual(second.texts(c(1)), [NIGHT_TEXT]);
  assert.deepEqual(second.texts(c(4)), [NIGHT_TEXT]);
  assert.equal(llmCalls(second), 2);
  // lo que había en la cola de la primera vida: cancelado, vencido o dado por no confirmado; nada se reenvió
  const old = listOutbox(db).filter((r) => r.createdUtc <= t0 + sec(10));
  assert.deepEqual(old.map((r) => [r.chatId === c(1) ? 1 : r.chatId === c(2) ? 2 : 3, r.status, r.cause]), [[1, 'cancelado', 'contexto_nuevo'], [2, 'vencido', 'vencido'], [3, 'fallido', 'no_confirmado']]);
  // un solo resumen con lo viejo, y el incierto a revisar a mano (nunca se reintenta a ciegas)
  const summary = alerts(second, /ya no se contestan solas/);
  assert.equal(summary.length, 1);
  assert.match(summary[0], /#2 \(hace 14 h\)/);
  assert.match(summary[0], /#3 \(hace 14 h\)/);
  assert.equal(alerts(second, /resultado incierto/).length, 1);
  assert.equal(getConversation(db, c(2))!.mode, 'auto'); // y si el cliente 2 escribe de nuevo, se lo atiende normal
  await second.app.shutdown();
});

test('7. Reinicio corto: el trabajo válido sale una sola vez, y el que quedó viejo porque el cliente escribió de nuevo no sale', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const db = openDb(':memory:');
  setSetting(db, 'shadow_mode', '0');
  const first = await bootApp({ clock, channel, db });
  await first.say(CHAT, 'Hola, quiero una cancha'); // A
  await first.say(c(5), 'Hola, quiero una cancha'); // E
  await clock.advance(sec(2) + sec(0.5));
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['pendiente', 'pendiente']);
  await first.app.shutdown('reinicio');
  await clock.advance(min(5));
  history(channel, CHAT, 'Ah, y la necesito techada', clock.now() - min(1), 'false_a_late'); // A escribió mientras el bot estaba apagado

  const second = await bootApp({ clock, channel, db });
  await clock.advance(min(3));
  assert.deepEqual(second.texts(c(5)), [FIRST_TEXT]); // E: su respuesta seguía siendo válida y salió una sola vez
  assert.deepEqual(second.texts(CHAT), [FIRST_TEXT]); // A: solo la respuesta nueva, la vieja se canceló
  assert.equal(llmCalls(second), 1); // el único turno nuevo es el de A; el de E ya estaba generado
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['cancelado', 'aceptado', 'aceptado']);
  assert.equal(channel.sendCalls, 2);
  await second.app.shutdown();
});

test('7. Un borrador del modo sombra de la noche anterior ya no se puede mandar', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const db = openDb(':memory:');
  const first = await bootApp({ clock, channel, db, shadow: true });
  setSetting(db, 'shadow_mode', '1');
  await first.say(CHAT, 'Hola, quiero una cancha');
  await clock.advance(sec(10));
  assert.ok(first.tg.texts.some((t) => t.startsWith('Borrador #1')));
  await first.app.shutdown();
  await clock.advance(hour(13));
  const second = await bootApp({ clock, channel, db });
  second.tg.press('-1001234567890', 'mandar:1', { message_id: 100, text: 'Borrador #1' });
  await second.settle();
  await clock.advance(min(5));
  assert.equal(channel.sendCalls, 0);
  assert.equal(db.prepare('SELECT status FROM drafts WHERE id = 1').get()!.status, 'vencido');
  await second.app.shutdown();
});

// ---------- 11 ----------
test('11. Sesión FAILED: avisa una sola vez, no se llama al cerebro ni se manda nada, no hay logout ni reconexión, y al volver se contesta', async () => {
  const channel = new FakeChannel();
  channel.status = 'FAILED';
  const a = await bootApp({ channel });
  await a.say(CHAT, 'Hola, quiero una cancha');
  await a.clock.advance(min(10));
  assert.equal(alerts(a, SESSION_FAILED).length, 1);
  assert.equal(llmCalls(a), 0);
  assert.equal(channel.sendCalls, 0);
  assert.deepEqual(a.waha.disruptive, []); // ni logout, ni stop, ni restart, ni borrado
  assert.equal(a.waha.callsTo('/api/sessions', 'POST').length, 1);
  assert.equal(a.waha.callsTo(/\/auth\/qr$/).length, 0);
  assert.equal(a.pings.length, 0); // con la sesión caída no hay latido: healthchecks avisa
  channel.status = 'WORKING';
  await a.clock.advance(min(20)); // la consulta que quedó esperando se contesta cuando la sesión vuelve
  assert.deepEqual(a.texts(CHAT), [FIRST_TEXT]);
  assert.equal(alerts(a, SESSION_FAILED).length, 1);
  await a.app.shutdown();
});

test('11. Autenticación: la clave de WAHA rechazada avisa una vez; un envío rechazado por autenticación no se reintenta', async () => {
  const bad = new FakeChannel();
  bad.sessionError = new ChannelError('auth', 401, 'WAHA respondió 401');
  const a = await bootApp({ channel: bad });
  await a.clock.advance(min(10));
  assert.equal(alerts(a, /rechazó la clave/).length, 1);
  assert.deepEqual(a.waha.disruptive, []);
  await a.app.shutdown();

  const channel = new FakeChannel();
  channel.failNextSend(new ChannelError('auth', 401, 'WAHA respondió 401'));
  const b = await bootApp({ channel });
  await b.say(CHAT, 'Hola, quiero una cancha');
  await b.clock.advance(min(30));
  assert.equal(channel.sendCalls, 1); // sin bucle de reintentos
  assert.equal(alerts(b, /rechazó la clave o la sesión/).length, 1);
  assert.deepEqual(listOutbox(b.db).map((r) => [r.status, r.cause]), [['fallido', 'auth']]);
  await b.app.shutdown();
});

for (const code of [463, 475]) {
  test(`11. Restricción ${code}: un solo aviso, el bot no insiste, y el chequeo de sesión no repite el aviso`, async () => {
    const channel = new FakeChannel();
    channel.failNextSend(new ChannelError('restricted', code, `server returned error ${code}`));
    const a = await bootApp({ channel });
    await a.say(CHAT, 'Hola, quiero una cancha');
    await a.clock.advance(min(30)); // la sesión sigue en WORKING y se chequea cada 60 s
    assert.equal(channel.sendCalls, 1);
    assert.equal(alerts(a, new RegExp(`error ${code}`)).length, 1);
    assert.equal(a.tg.sent.filter((m) => /restring|FAILED|QR/i.test(String(m.text))).length, 1); // ni un aviso más por el mismo problema
    assert.deepEqual(listOutbox(a.db).map((r) => [r.status, r.cause]), [['fallido', 'restricted']]);
    assert.deepEqual(a.waha.disruptive, []);
    assert.equal(a.waha.callsTo('/api/sessions', 'POST').length, 1);
    await a.app.shutdown();
  });
}

// ---------- 15 ----------
test('15. Lo que llegó durante una caída se recupera según reply_window_hours: lo reciente se contesta una vez, lo viejo va a un resumen', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const db = priorRun(clock, { downMs: hour(20) });
  const now = clock.now();
  // X escribió dos veces hace minutos; Z hace 11 h (adentro de la ventana de 12 h); Y y W hace 15 y 13 h (afuera)
  history(channel, c(1), 'Hola, quiero una cancha', now - min(3), 'x1');
  history(channel, c(1), 'Para un club', now - min(2), 'x2');
  history(channel, c(2), 'Buenas, cuánto sale?', now - hour(15), 'y1');
  history(channel, c(3), 'Hola, info por favor', now - hour(11), 'z1');
  history(channel, c(4), 'Hola?', now - hour(13), 'w1');
  const a = await bootApp({ clock, channel, db });
  await clock.advance(min(3));
  assert.deepEqual(channel.sent.map((m) => m.chatId).sort(), [c(1), c(3)]); // una respuesta por chat reciente, aunque X escribió dos veces
  assert.equal(llmCalls(a), 2);
  const summary = alerts(a, /ya no se contestan solas/);
  assert.equal(summary.length, 1);
  assert.match(summary[0], /#2 \(hace 15 h\)/);
  assert.match(summary[0], /#4 \(hace 13 h\)/);
  assert.ok(!/#1|#3/.test(summary[0]));
  assert.ok(!summary[0].includes('5491')); // nunca el teléfono
  // WAHA reenvía el mismo mensaje por el webhook durante la recuperación: no se contesta dos veces
  await a.post(a.customerEvent(c(1), 'Para un club', { id: 'x2', tsUtcMs: now - min(2) }));
  await clock.advance(min(3));
  assert.equal(channel.sendCalls, 2);
  await a.app.shutdown();
});

test('15. Con reply_window_hours más corto la ventana se achica; el equipo que escribió durante la caída conserva el chat', async () => {
  const clock = new FakeClock();
  const channel = new FakeChannel(() => clock.now());
  const db = priorRun(clock, { downMs: hour(20) });
  setSetting(db, 'reply_window_hours', '2');
  const now = clock.now();
  history(channel, c(3), 'Hola, info por favor', now - hour(11), 'z1'); // ahora cae afuera de la ventana de 2 h
  history(channel, c(5), 'Hola, quiero una cancha', now - min(50), 'v1');
  channel.addHistory(c(5), { providerMsgId: 'true_v1', fromMe: true, tsUtcMs: now - min(40), text: 'Hola, soy Tomás, te escribo yo' }); // lo tomó el equipo
  history(channel, c(6), 'Hola, quiero una cancha', now - min(30), 'u1');
  const a = await bootApp({ clock, channel, db });
  await clock.advance(min(3));
  assert.deepEqual(channel.sent.map((m) => m.chatId), [c(6)]);
  assert.equal(getConversation(db, c(5))!.mode, 'humano');
  assert.match(alerts(a, /ya no se contestan solas/)[0], /más de 2 h/);
  assert.equal(llmCalls(a), 1);
  await a.app.shutdown();
});
