// Reconciliación al prender (parte B): qué pasó mientras el bot estaba apagado. Se recupera lo que llegó, se respeta lo que escribió el equipo,
// se contesta solo lo reciente (reply_window_hours) y nunca se suelta una ráfaga atrasada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelError } from '../src/channel/types.ts';
import { createConversation, getConversation, insertMessage, insertOutbox, listAudit, listDrafts, listOutbox, markOutbox, createDraft, saveCard, unansweredMessages } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { createRecovery } from '../src/startup.ts';
import { getState, setSetting, setState } from '../src/settings.ts';
import { makeHarness } from './f2-harness.ts';
import type { Harness } from './f2-harness.ts';

const CHAT = '5491155550000@c.us';
const OTHER = '5491166660000@c.us';
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;

// Un bot que ya venía andando hace días y que se apagó hace `downMs`.
function setup(downMs = min(30), o: { botStartAgoMs?: number } = {}) {
  const h = makeHarness({ botStartAgoMs: o.botStartAgoMs ?? hour(72) });
  const scheduled: string[] = [];
  let ready = 0;
  const recovery = createRecovery({
    db: h.db, channel: h.channel, clock: h.clock, notifier: h.notifier,
    worker: { onCustomerMessage: (c) => void scheduled.push(c) }, onReady: () => void ready++,
  });
  setState(h.db, 'alive_utc', String(h.clock.now() - downMs));
  return { h, recovery, scheduled, ready: () => ready };
}
const customer = (h: Harness, chat: string, text: string, agoMs: number, id = `false_${chat}_${text.length}${agoMs}`) =>
  h.channel.addHistory(chat, { providerMsgId: id, fromMe: false, tsUtcMs: h.clock.now() - agoMs, text });
const team = (h: Harness, chat: string, text: string, agoMs: number, id = `true_${chat}_T${text.length}${agoMs}`) =>
  h.channel.addHistory(chat, { providerMsgId: id, fromMe: true, tsUtcMs: h.clock.now() - agoMs, text });
const texts = (h: Harness, chat: string) => (h.db.prepare('SELECT author, text FROM messages WHERE chat_id = ? ORDER BY id').all(chat) as { author: string; text: string }[]).map((m) => `${m.author}:${m.text}`);

test('un cliente nuevo que escribió mientras el bot estaba apagado se guarda y se programa su turno', async () => {
  const { h, recovery, scheduled } = setup();
  customer(h, CHAT, 'Hola, quiero una cancha', min(10));
  customer(h, CHAT, 'Para un club', min(9));
  const r = await recovery.reconcile();
  assert.deepEqual(texts(h, CHAT), ['customer:Hola, quiero una cancha', 'customer:Para un club']);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(scheduled, [CHAT]);
  assert.deepEqual(r.scheduled, [CHAT]);
  assert.equal(h.notifier.alerts.length, 0); // nada raro que contar
});

test('es idempotente: reconciliar dos veces no duplica mensajes ni avisos', async () => {
  const { h, recovery } = setup();
  customer(h, CHAT, 'Hola', min(10));
  customer(h, OTHER, 'Hola, hace dos días escribí', hour(20));
  await recovery.reconcile();
  const alerts = h.notifier.alerts.length;
  const rows = texts(h, CHAT).length;
  await recovery.reconcile();
  assert.equal(texts(h, CHAT).length, rows);
  assert.equal(h.notifier.alerts.length, alerts);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?").get(CHAT)!.n, rows);
});

test('consultas más viejas que reply_window_hours no se contestan solas: un solo resumen con la lista', async () => {
  const { h, recovery, scheduled } = setup(hour(30));
  customer(h, CHAT, 'Hola, quiero una cancha', hour(20));
  customer(h, OTHER, 'Buenas, cuánto sale?', hour(15));
  customer(h, '5491177770000@c.us', 'Hola recién', min(20)); // esta sí es reciente
  const r = await recovery.reconcile();
  assert.deepEqual(scheduled, ['5491177770000@c.us']);
  assert.equal(r.stale.length, 2);
  const summaries = h.notifier.alerts.filter((a) => /ya no se contestan solas/.test(a.text));
  assert.equal(h.notifier.alerts.length, 1);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0].text, /#1 \(hace 20 h\)/);
  assert.match(summaries[0].text, /#2 \(hace 15 h\)/);
  assert.ok(!summaries[0].text.includes('#3'));
  assert.ok(!summaries[0].text.includes('5491')); // nunca el teléfono
  assert.equal(unansweredMessages(h.db, CHAT).length, 0); // quedaron atendidos: no se vuelven a listar
});

test('si el equipo escribió mientras el bot estaba apagado, el chat pasa a humano y no se contesta', async () => {
  const { h, recovery, scheduled } = setup();
  customer(h, CHAT, 'Hola, quiero una cancha', min(25));
  team(h, CHAT, 'Hola, soy Tomás, te escribo yo', min(20));
  const r = await recovery.reconcile();
  const conv = getConversation(h.db, CHAT)!;
  assert.equal(conv.mode, 'humano');
  assert.deepEqual(scheduled, []);
  assert.deepEqual(r.takeovers, [CHAT]);
  assert.deepEqual(texts(h, CHAT), ['customer:Hola, quiero una cancha', 'team:Hola, soy Tomás, te escribo yo']);
  assert.match(h.notifier.alerts[0].text, /equipo escribió mientras el bot estaba apagado: #1/);
  assert.ok(listAudit(h.db, 'takeover').length === 1);
});

test('el equipo escribió y después el cliente respondió: sigue humano (no se reanuda solo)', async () => {
  const { h, recovery, scheduled } = setup();
  customer(h, CHAT, 'Hola', min(25));
  team(h, CHAT, 'Hola, soy Tomás', min(20));
  customer(h, CHAT, 'Ah, hola Tomás, cuánto sale?', min(10));
  await recovery.reconcile();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(scheduled, []);
});

test('un mensaje del bot que quedó incierto al apagarse y sí salió se acepta: no es toma humana ni se reenvía', async () => {
  const { h, recovery, scheduled } = setup();
  const chat = CHAT;
  createConversation(h.db, { chatId: chat, session: 'default', mode: 'auto', nowMs: h.clock.now() - min(40) });
  insertMessage(h.db, { session: 'default', providerMsgId: 'false_c_1', chatId: chat, author: 'customer', text: 'Hola', tsUtcMs: h.clock.now() - min(40) });
  insertOutbox(h.db, { logicalKey: `${chat}:1:0`, chatId: chat, kind: 'text', body: 'Buenas tardes, te escribimos de Olimpo Padel.', expiresUtc: h.clock.now() + min(10), contextVersion: 1, createdUtc: h.clock.now() - min(35), answersUpto: 1 });
  markOutbox(h.db, 1, 'incierto', { cause: 'reinicio' });
  team(h, chat, 'Buenas tardes, te escribimos de Olimpo Padel.', min(34)); // en WAHA figura como enviado por la cuenta (fue el bot)
  const r = await recovery.reconcile();
  assert.equal(getConversation(h.db, chat)!.mode, 'auto');
  assert.deepEqual(r.takeovers, []);
  assert.equal(listOutbox(h.db)[0].status, 'aceptado');
  assert.equal(texts(h, chat).at(-1), 'bot:Buenas tardes, te escribimos de Olimpo Padel.');
  assert.deepEqual(scheduled, []); // el cliente ya tenía su respuesta
});

test('lo pendiente de una versión vieja se cancela cuando el cliente escribió de nuevo durante la caída', async () => {
  const { h, recovery } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(2500); // respuesta pendiente de salir
  const before = listOutbox(h.db)[0];
  assert.equal(before.status, 'pendiente');
  const conv = getConversation(h.db, CHAT)!;
  createDraft(h.db, { chatId: CHAT, contextVersion: conv.contextVersion, bubbles: ['x'], material: [], nowMs: h.clock.now(), answersUpto: 1 });
  customer(h, CHAT, 'Perdón, y la quiero techada', min(1)); // llegó mientras el bot no miraba
  await recovery.reconcile();
  assert.equal(listOutbox(h.db)[0].status, 'cancelado');
  assert.equal(listOutbox(h.db)[0].cause, 'contexto_nuevo');
  assert.deepEqual(listDrafts(h.db, CHAT).map((d) => d.status), ['vencido']);
});

test('un chat con historia anterior al arranque del bot, o que empezó el equipo, arranca en humano', async () => {
  const { h, recovery, scheduled } = setup(min(30), { botStartAgoMs: hour(2) });
  team(h, OTHER, 'Hola, te paso el presupuesto', hour(24)); // antes de que existiera el bot
  customer(h, OTHER, 'Gracias, lo veo', min(10));
  team(h, '5491177770000@c.us', 'Hola, soy Tomás', min(20)); // lo empezó el equipo
  customer(h, '5491177770000@c.us', 'Hola Tomás', min(10));
  await recovery.reconcile();
  assert.equal(getConversation(h.db, OTHER)!.mode, 'humano');
  assert.equal(getConversation(h.db, '5491177770000@c.us')!.mode, 'humano');
  assert.deepEqual(scheduled, []);
});

test('un mensaje sin texto (audio o foto) se guarda, no abre turno y se menciona en el resumen', async () => {
  const { h, recovery, scheduled } = setup();
  customer(h, CHAT, '', min(10), 'false_audio_1');
  await recovery.reconcile();
  assert.deepEqual(scheduled, []);
  assert.match(h.notifier.alerts[0].text, /sin texto.*#1/);
  assert.equal(h.db.prepare("SELECT media FROM messages WHERE chat_id = ?").get(CHAT)!.media, 'other');
});

test('mirar hacia atrás tiene tope de 7 días y el cursor sale del último momento en que todo andaba', async () => {
  const { h, recovery } = setup(hour(24 * 30));
  const seen: number[] = [];
  const real = h.channel.chatsActiveSince.bind(h.channel);
  h.channel.chatsActiveSince = async (since) => { seen.push(since); return real(since); };
  await recovery.reconcile();
  assert.equal(seen[0], h.clock.now() - 7 * 24 * 3_600_000);
  setState(h.db, 'alive_utc', String(h.clock.now() - min(60)));
  await recovery.reconcile();
  assert.equal(seen[1], h.clock.now() - min(65)); // 5 min de margen por los relojes
});

test('el primer arranque de todos (sin cursor) no reconcilia nada y deja el cursor puesto', async () => {
  const h = makeHarness();
  let ready = 0;
  const recovery = createRecovery({ db: h.db, channel: h.channel, clock: h.clock, notifier: h.notifier, worker: { onCustomerMessage: () => undefined }, onReady: () => void ready++ });
  h.channel.chatsActiveSince = async () => { throw new Error('no debería consultarse'); };
  const t = h.clock.now();
  recovery.onObserve('WORKING', undefined);
  await h.clock.advance(1);
  assert.equal(ready, 1);
  assert.equal(getState(h.db, 'alive_utc'), String(t));
});

test('la salida se habilita recién cuando la sesión está WORKING y la reconciliación terminó', async () => {
  const { h, recovery, ready } = setup();
  customer(h, CHAT, 'Hola', min(5));
  recovery.onObserve('STARTING', undefined);
  recovery.onObserve('SCAN_QR_CODE', 'STARTING');
  await h.clock.advance(min(3));
  assert.equal(ready(), 0);
  assert.equal(recovery.ready(), false);
  recovery.onObserve('WORKING', 'SCAN_QR_CODE');
  await h.clock.advance(1);
  assert.equal(ready(), 1);
  assert.equal(texts(h, CHAT).length, 1);
  recovery.onObserve('WORKING', 'WORKING'); // los chequeos siguientes no la repiten
  await h.clock.advance(1);
  assert.equal(ready(), 1);
});

test('mientras corre la reconciliación, un cambio de estado no la pisa ni la duplica', async () => {
  const { h, recovery, ready } = setup();
  customer(h, CHAT, 'Hola', min(5));
  recovery.onObserve('WORKING', undefined);
  recovery.onObserve('WORKING', undefined);
  recovery.onObserve('WORKING', 'WORKING');
  await h.clock.advance(1);
  assert.equal(ready(), 1);
  assert.equal(texts(h, CHAT).length, 1);
});

test('si WAHA falla al revisar un chat, los demás se procesan y se reintenta en el próximo chequeo; no se pierde el cursor', async () => {
  const { h, recovery, ready, scheduled } = setup();
  customer(h, CHAT, 'Hola', min(10));
  customer(h, OTHER, 'Buenas', min(9));
  const real = h.channel.messagesSince.bind(h.channel);
  let broken = true;
  h.channel.messagesSince = async (chat, since, limit) => {
    if (broken && chat === CHAT) throw new ChannelError('transient', 500, 'WAHA se cayó');
    return real(chat, since, limit);
  };
  const alive = getState(h.db, 'alive_utc');
  recovery.onObserve('WORKING', undefined);
  await h.clock.advance(1);
  assert.equal(ready(), 0); // sin terminar, la salida sigue cerrada
  assert.deepEqual(scheduled, [OTHER]);
  assert.equal(getState(h.db, 'alive_utc'), alive); // el cursor no avanza si falta revisar algo
  assert.equal(h.notifier.alerts.filter((a) => /No pude revisar/.test(a.text)).length, 1);
  broken = false;
  await h.clock.advance(min(1));
  recovery.onObserve('WORKING', 'WORKING');
  await h.clock.advance(1);
  assert.equal(ready(), 1);
  assert.deepEqual(texts(h, CHAT), ['customer:Hola']);
  assert.notEqual(getState(h.db, 'alive_utc'), alive);
});

test('si a los 10 minutos no se pudo reconciliar, avisa y habilita la salida igual (lo vencido igual no sale)', async () => {
  const { h, recovery, ready } = setup();
  customer(h, CHAT, 'Hola', min(5));
  h.channel.messagesSince = async () => { throw new ChannelError('transient', 500, 'WAHA se cayó'); };
  recovery.onObserve('WORKING', undefined);
  await h.clock.advance(1);
  assert.equal(ready(), 0);
  await h.clock.advance(min(11));
  recovery.onObserve('WORKING', 'WORKING');
  await h.clock.advance(1);
  assert.equal(ready(), 1);
  assert.equal(h.notifier.alerts.filter((a) => /No pude revisar/.test(a.text)).length, 2); // el primero y el de "sigo sin poder"
});

test('si la sesión se cae y vuelve con el bot andando, se reconcilia de nuevo desde el último momento bueno', async () => {
  const { h, recovery, scheduled } = setup();
  recovery.onObserve('WORKING', undefined);
  await h.clock.advance(1);
  const good = Number(getState(h.db, 'alive_utc'));
  recovery.onObserve('UNREACHABLE', 'WORKING');
  await h.clock.advance(min(20)); // WAHA caído 20 min: acá no se mueve el cursor
  customer(h, CHAT, 'Hola, ¿están?', min(10)); // llegó mientras WAHA estaba caído
  recovery.onObserve('WORKING', 'UNREACHABLE');
  await h.clock.advance(1);
  assert.equal(good <= Number(getState(h.db, 'alive_utc')), true);
  assert.deepEqual(scheduled, [CHAT]);
});

test('los borradores pendientes de más de reply_window_hours vencen al habilitar la salida', async () => {
  const { h, recovery } = setup();
  const conv = createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: h.clock.now() });
  saveCard(h.db, CHAT, emptyCard());
  const old = createDraft(h.db, { chatId: CHAT, contextVersion: conv.contextVersion, bubbles: ['viejo'], material: [], nowMs: h.clock.now() - hour(13), answersUpto: 0 });
  createConversation(h.db, { chatId: OTHER, session: 'default', mode: 'auto', nowMs: h.clock.now() });
  const fresh = createDraft(h.db, { chatId: OTHER, contextVersion: 0, bubbles: ['reciente'], material: [], nowMs: h.clock.now() - min(20), answersUpto: 0 });
  recovery.onObserve('WORKING', undefined);
  await h.clock.advance(1);
  assert.equal(listDrafts(h.db, CHAT).find((d) => d.id === old)!.status, 'vencido');
  assert.equal(listDrafts(h.db, OTHER).find((d) => d.id === fresh)!.status, 'pendiente');
});

test('con reply_window_hours cambiado por /set, el corte sigue al valor nuevo', async () => {
  const { h, recovery, scheduled } = setup(hour(5));
  setSetting(h.db, 'reply_window_hours', '2');
  customer(h, CHAT, 'Hola', hour(3));
  const r = await recovery.reconcile();
  assert.deepEqual(scheduled, []);
  assert.equal(r.stale.length, 1);
  assert.match(h.notifier.alerts[0].text, /más de 2 h/);
});
