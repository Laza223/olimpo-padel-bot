// Cola de salida con autor (V7): lo que manda el equipo desde el CRM (el PDF del presupuesto) sale aunque el chat sea del equipo,
// y ninguna regla pensada para las respuestas del bot (toma humana, mensaje nuevo, pausa, vencimiento, falla de otro globo) lo cancela o lo anota mal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sqlite from 'node:sqlite';
import { FakeChannel } from '../src/channel/fake.ts';
import { ChannelError } from '../src/channel/types.ts';
import {
  MIGRATIONS, bumpVersion, cancelChatOutbox, createConversation, getConversation, insertOutbox, listOutbox, markOutbox, migrate, openDb, outboxHasVersion,
  pauseConversation, switchToHuman,
} from '../src/db.ts';
import type { OutboxRow } from '../src/db.ts';
import { createOutbox, echoMatches, enqueueReply } from '../src/outbox.ts';
import { setSetting } from '../src/settings.ts';
import { FakeClock, FakeNotifier, T0, policy } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';

const CHAT = '5491155550000@c.us';
const H = 3_600_000;
const CAPTION = 'Te paso el presupuesto.';
const FILENAME = 'Presupuesto_Juan_Prueba.pdf';
const PDF = '/datos/presupuestos/q1.pdf';
// Lo que queda guardado en el chat (historyFor es lo que ve el modelo: no trae el tipo ni el id).
const saved = (db: ReturnType<typeof openDb>) =>
  (db.prepare('SELECT author, text, media, provider_msg_id FROM messages WHERE chat_id = ? ORDER BY id').all(CHAT) as { author: string; text: string; media: string | null; provider_msg_id: string }[]);

function teamFile(db: ReturnType<typeof openDb>, o: { nowMs: number; version: number; n?: number; chatId?: string; expiresUtc?: number }): void {
  insertOutbox(db, {
    logicalKey: `team:presupuesto:q1:${o.n ?? 1}`, chatId: o.chatId ?? CHAT, kind: 'file', author: 'team', body: JSON.stringify({ file: PDF, filename: FILENAME, caption: CAPTION }),
    expiresUtc: o.expiresUtc ?? o.nowMs + 24 * H, contextVersion: o.version, createdUtc: o.nowMs, answersUpto: 0,
  });
}

function setup() {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  setSetting(db, 'typing_max_ms', '1000');
  const channel = new FakeChannel(() => clock.now());
  const notifier = new FakeNotifier();
  const expired: string[] = [];
  const outbox = createOutbox({ db, channel, notifier, clock, random: () => 0.5, onExpired: (c) => expired.push(c) });
  createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: T0 });
  return { clock, db, channel, notifier, outbox, expired };
}

test('V7: la cola se rearma conservando ids, columnas y nulos; todo lo anterior queda del bot; admite archivo y rechaza otro autor', () => {
  const db = new sqlite.DatabaseSync(':memory:');
  for (let v = 0; v < 6; v++) db.exec(MIGRATIONS[v]);
  db.exec('PRAGMA user_version = 6');
  db.prepare("INSERT INTO outbox (id, logical_key, chat_id, kind, body, status, attempt, expires_utc, provider_msg_id, cause, context_version, created_utc, attempted_utc, next_try_utc, ack, answers_upto, typing_until_utc) VALUES (7, 'c:1:0', 'c', 'text', 'Hola', 'aceptado', 1, 100, 'true_x', NULL, 1, 50, 60, NULL, 'read', 3, 55)").run();
  db.prepare("INSERT INTO outbox (id, logical_key, chat_id, kind, body, status, expires_utc, context_version, created_utc) VALUES (9, 'c:1:1', 'c', 'image', '{\"file\":\"a.jpg\"}', 'pendiente', 100, 1, 50)").run();
  const before = db.prepare('SELECT * FROM outbox ORDER BY id').all().map((r) => ({ ...r }));
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  const after = db.prepare('SELECT * FROM outbox ORDER BY id').all().map((r) => ({ ...r })) as Record<string, unknown>[];
  assert.deepEqual(after.map(({ author, ...rest }) => rest), before);
  assert.deepEqual(after.map((r) => r.author), ['bot', 'bot']);
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ['outbox_chat', 'outbox_provider']);
  assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  db.prepare("INSERT INTO outbox (logical_key, chat_id, kind, author, body, expires_utc, context_version, created_utc) VALUES ('team:presupuesto:q:1', 'c', 'file', 'team', '{}', 1, 1, 1)").run();
  assert.throws(() => db.prepare("INSERT INTO outbox (logical_key, chat_id, kind, author, body, expires_utc, context_version, created_utc) VALUES ('x', 'c', 'text', 'otro', '', 1, 1, 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO outbox (logical_key, chat_id, kind, body, expires_utc, context_version, created_utc) VALUES ('y', 'c', 'video', '', 1, 1, 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO outbox (logical_key, chat_id, kind, body, expires_utc, context_version, created_utc) VALUES ('c:1:0', 'c', 'text', '', 1, 1, 1)").run(), /UNIQUE/); // la clave sigue siendo única
});

test('el PDF del equipo sale aunque el chat sea del equipo y con la versión cambiada; queda en el chat como Equipo · Documento con la leyenda', async () => {
  const { db, clock, channel, outbox } = setup();
  switchToHuman(db, CHAT, T0, 'presupuesto desde el CRM');
  teamFile(db, { nowMs: clock.now(), version: getConversation(db, CHAT)!.contextVersion });
  bumpVersion(db, CHAT, clock.now()); // el cliente escribió después
  pauseConversation(db, CHAT, 'cap', clock.now());
  outbox.kick();
  await clock.advance(1);
  assert.deepEqual(channel.sent.map((m) => [m.kind, m.text, m.filePath, m.filename]), [['file', CAPTION, PDF, FILENAME]]);
  assert.deepEqual(channel.typingLog, []); // un archivo no "escribe"
  const row = listOutbox(db)[0];
  assert.deepEqual([row.status, row.author, row.providerMsgId], ['aceptado', 'team', channel.sent[0].providerMsgId]);
  assert.deepEqual(saved(db).map((m) => [m.author, m.text, m.media]), [['team', CAPTION, 'document']]);
});

test('ni la toma humana, ni un mensaje nuevo, ni una falla de un globo del bot cancelan el PDF del equipo (y al revés)', async () => {
  const { db, clock, channel, outbox } = setup();
  teamFile(db, { nowMs: clock.now(), version: 0 });
  enqueueReply(db, { chatId: CHAT, version: 0, bubbles: ['Hola'], material: [], assets: policy.assets, nowMs: clock.now(), answersUpto: 0 });
  assert.equal(cancelChatOutbox(db, CHAT, 'contexto_nuevo', 99), 1);
  switchToHuman(db, CHAT, clock.now(), 'Lo tomo');
  assert.deepEqual(listOutbox(db).map((r) => [r.author, r.status]), [['team', 'pendiente'], ['bot', 'cancelado']]);
  assert.equal(outboxHasVersion(db, CHAT, 0), false); // "Devolver al bot": el presupuesto no cuenta como respuesta del bot, el bot igual contesta
  outbox.kick();
  await clock.advance(1);
  assert.deepEqual(channel.sent.map((m) => m.kind), ['file']);
});

test('el PDF del equipo que falla no cancela la respuesta del bot que viene atrás', async () => {
  const { db, clock, channel, outbox } = setup();
  teamFile(db, { nowMs: clock.now(), version: 0 });
  enqueueReply(db, { chatId: CHAT, version: 0, bubbles: ['Hola'], material: [], assets: policy.assets, nowMs: clock.now(), answersUpto: 0 });
  channel.failNextSend(new ChannelError('restricted', 463));
  outbox.kick();
  await clock.advance(2_000);
  assert.deepEqual(listOutbox(db).map((r) => [r.author, r.status]), [['team', 'fallido'], ['bot', 'aceptado']]);
});

test('un globo del bot que falla no cancela el PDF del equipo que viene atrás', async () => {
  const { db, clock, channel, outbox, notifier } = setup();
  bumpVersion(db, CHAT, T0);
  enqueueReply(db, { chatId: CHAT, version: 1, bubbles: ['Hola'], material: [], assets: policy.assets, nowMs: clock.now(), answersUpto: 0 });
  teamFile(db, { nowMs: clock.now(), version: 1 });
  channel.failNextSend(new ChannelError('restricted', 463));
  outbox.kick();
  await clock.advance(2_000);
  assert.deepEqual(listOutbox(db).map((r) => [r.author, r.status]), [['bot', 'fallido'], ['team', 'aceptado']]);
  assert.ok(notifier.alerts.some((a) => /restringió/.test(a.text)));
});

test('vencido: el PDF del equipo avisa "No salió el presupuesto" y nunca sube la versión ni regenera un turno', async () => {
  const { db, clock, outbox, notifier, expired } = setup();
  setSetting(db, 'kill_switch', '1'); // el bot apagado: el presupuesto queda en la cola
  teamFile(db, { nowMs: clock.now(), version: 0 });
  outbox.kick();
  await clock.advance(25 * H);
  setSetting(db, 'kill_switch', '0');
  outbox.kick();
  await clock.advance(1);
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['vencido']);
  assert.equal(getConversation(db, CHAT)!.contextVersion, 0);
  assert.deepEqual(expired, []);
  assert.ok(notifier.alerts.some((a) => a.text.startsWith('No salió el presupuesto de ')), JSON.stringify(notifier.alerts));
});

test('incierto: se concilia con el historial (por la leyenda o el nombre del archivo) y queda como del equipo', async () => {
  const { db, clock, channel, outbox } = setup();
  teamFile(db, { nowMs: clock.now(), version: 0 });
  channel.failNextSend(new ChannelError('uncertain', undefined, 'timeout'), { delivered: true });
  outbox.kick();
  await clock.advance(1);
  assert.equal(listOutbox(db)[0].status, 'incierto');
  await clock.advance(3_000);
  const row = listOutbox(db)[0];
  assert.deepEqual([row.status, row.providerMsgId], ['aceptado', channel.sent[0].providerMsgId]);
  assert.equal(channel.sendCalls, 1); // nunca se reenvía
  assert.deepEqual(saved(db).map((m) => [m.author, m.media]), [['team', 'document']]);
});

test('eco: el del PDF se reconoce (por id, leyenda o nombre); lo escrito desde el celular nunca se atribuye a la cola', async () => {
  const h = makeHarness();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: h.clock.now() });
  teamFile(h.db, { nowMs: h.clock.now(), version: 0 });
  markOutbox(h.db, listOutbox(h.db)[0].id, 'en_proceso'); // salió, pero WAHA todavía no devolvió el id
  // escrito desde el celular con el mismo texto: es del equipo, pero no es el eco de la cola
  h.deliver({ kind: 'own_message', session: 'default', chatId: CHAT, providerMsgId: 'true_app_1', tsUtcMs: h.clock.now(), text: CAPTION, source: 'app', media: 'document' });
  await h.clock.advance(1);
  assert.equal(listOutbox(h.db)[0].status, 'en_proceso');
  // el eco de la API, con el nombre del archivo como texto
  h.deliver({ kind: 'own_message', session: 'default', chatId: CHAT, providerMsgId: 'true_api_1', tsUtcMs: h.clock.now(), text: FILENAME, source: 'api', media: 'document' });
  await h.clock.advance(1);
  assert.deepEqual([listOutbox(h.db)[0].status, listOutbox(h.db)[0].providerMsgId], ['aceptado', 'true_api_1']);
  assert.deepEqual(saved(h.db).map((m) => [m.author, m.provider_msg_id, m.media]), [['team', 'true_app_1', null], ['team', 'true_api_1', 'document']]);
  h.stop();
});

test('echoMatches: texto vacío nunca reconoce; una imagen o un documento piden su tipo; "app" nunca', () => {
  const row = (kind: OutboxRow['kind'], body: string): OutboxRow => ({ kind, body, author: kind === 'file' ? 'team' : 'bot' }) as OutboxRow;
  assert.equal(echoMatches(row('text', 'Hola'), { text: 'Hola' }), true);
  assert.equal(echoMatches(row('text', 'Hola'), { text: 'Hola', source: 'app' }), false);
  assert.equal(echoMatches(row('text', ''), { text: '' }), false);
  const img = row('image', JSON.stringify({ file: 'a.jpg' }));
  assert.equal(echoMatches(img, { text: '', media: 'image' }), true);
  assert.equal(echoMatches(img, { text: '', media: 'document' }), false);
  const file = row('file', JSON.stringify({ file: PDF, filename: FILENAME, caption: CAPTION }));
  assert.equal(echoMatches(file, { text: CAPTION, media: 'document' }), true);
  assert.equal(echoMatches(file, { text: FILENAME }), true);
  assert.equal(echoMatches(file, { text: CAPTION, media: 'image' }), false);
  assert.equal(echoMatches(file, { text: 'otra cosa', media: 'document' }), false);
  const noCaption = row('file', JSON.stringify({ file: PDF, filename: FILENAME }));
  assert.equal(echoMatches(noCaption, { text: '', media: 'document' }), false);
});
