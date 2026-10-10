// Base y settings: esquema, migración idempotente, dedupe por clave única, ids "m<rowid>" y los valores por defecto del contrato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATIONS, advanceAnswered, bumpVersion, createDraft, getDraft, listAudit, switchToHuman, claimInboundEvents, createConversation, delayInboundEvent, editMessage, findMessage, finishInboundEvent, getConversation, getConversationByNumber,
  historyFor, insertAgentRun, insertMessage, insertOutbox, listOutbox, migrate, nextPendingOutbox, openDb, revokeMessage, saveCard, setMode, storeInboundEvent, tx, unansweredMessages,
} from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { SETTING_DEFAULTS, ensureBotStart, getBotStart, getFlag, getNum, getSetting, getState, isSettingKey, setSetting, setState } from '../src/settings.ts';

const NOW = Date.UTC(2026, 9, 7, 17, 0);
const msg = (providerMsgId: string, author: 'customer' | 'bot' | 'team', text: string, chatId = 'c1@c.us') => ({ session: 'default', providerMsgId, chatId, author, text, tsUtcMs: NOW });

test('esquema: las 8 tablas del contrato, y migrar de nuevo no rompe ni borra nada', () => {
  const db = openDb(':memory:');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  assert.deepEqual(tables, ['agent_runs', 'audit', 'conversations', 'drafts', 'inbound_events', 'messages', 'outbox', 'settings']);
  createConversation(db, { chatId: 'c1@c.us', session: 'default', mode: 'auto', nowMs: NOW });
  migrate(db);
  migrate(db);
  assert.ok(getConversation(db, 'c1@c.us'));
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
});

test('migración V4 sobre una base V3: agrega las columnas de tokens (NULL en lo viejo), conserva los datos y es idempotente', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.exec('PRAGMA user_version = 3');
  db.prepare("INSERT INTO agent_runs (chat_id, ts_utc, model, effort, policy_hash, input_tokens, cached_tokens, output_tokens, cost_usd) VALUES ('c1@c.us', 5, 'gpt-6.1-sol', 'low', 'h', 3000, 2048, 200, 0.004)").run();
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  const cols = db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name);
  assert.deepEqual(cols.slice(-3), ['cache_write_tokens', 'cache_write_1h_tokens', 'thinking_tokens']);
  assert.deepEqual({ ...db.prepare('SELECT input_tokens, cache_write_tokens, cache_write_1h_tokens, thinking_tokens FROM agent_runs').get() }, { input_tokens: 3000, cache_write_tokens: null, cache_write_1h_tokens: null, thinking_tokens: null });
  const run = { chatId: 'c1@c.us', tsUtc: 6, model: 'claude-sonnet-5-5', effort: 'low', policyHash: 'h', inputTokens: 4000, cachedTokens: 100, outputTokens: 300, costUsd: 0.01, latencyMs: 5, violations: [], usedFallback: false };
  insertAgentRun(db, { ...run, cacheWriteTokens: 3900, cacheWrite1hTokens: 3900, thinkingTokens: 120 });
  insertAgentRun(db, run); // sin dato: NULL, no 0
  assert.deepEqual(db.prepare('SELECT cache_write_tokens AS w, cache_write_1h_tokens AS w1, thinking_tokens AS t FROM agent_runs WHERE ts_utc > 5 ORDER BY id').all().map((r) => ({ ...r })), [{ w: 3900, w1: 3900, t: 120 }, { w: null, w1: null, t: null }]);
});

test('migración V5 sobre una base V4: agrega typing_until_utc (NULL en lo viejo), conserva el outbox y es idempotente', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
  db.exec('PRAGMA user_version = 4');
  db.prepare("INSERT INTO outbox (logical_key, chat_id, kind, body, expires_utc, context_version, created_utc, next_try_utc) VALUES ('c1@c.us:1:0', 'c1@c.us', 'text', 'Hola', 9, 1, 5, 7)").run();
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  assert.equal(db.prepare('PRAGMA table_info(outbox)').all().filter((c) => c.name === 'typing_until_utc').length, 1);
  assert.deepEqual(listOutbox(db).map((r) => [r.logicalKey, r.body, r.nextTryUtc, r.typingUntilUtc]), [['c1@c.us:1:0', 'Hola', 7, null]]); // lo viejo sigue igual y todavía no "escribió"
  assert.equal(listOutbox(db)[0].status, 'pendiente');
});

test('archivo: modo WAL y busy_timeout de 5000', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-db-'));
  try {
    const db = openDb(join(dir, 'data', 'bot.sqlite'));
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    db.close();
    const again = openDb(join(dir, 'data', 'bot.sqlite')); // reabrir un archivo ya migrado
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: los defaults del contrato, validación y claves desconocidas', () => {
  const db = openDb(':memory:');
  assert.deepEqual(
    { ...SETTING_DEFAULTS },
    {
      kill_switch: '0', shadow_mode: '1', burst_quiet_ms: '2000', burst_max_ms: '8000', reply_window_hours: '12', daily_budget_usd: '2', conv_budget_usd: '0.25',
      max_new_chats_per_day: '30', bot_start_utc: '', outbox_expiry_min: '30', typing_ms_per_char: '60', typing_max_ms: '12000', read_ms_per_char: '40', read_max_ms: '15000', max_audio_seconds: '600',
    },
  );
  assert.equal(getFlag(db, 'shadow_mode'), true);
  assert.equal(getFlag(db, 'kill_switch'), false);
  assert.equal(getNum(db, 'daily_budget_usd'), 2);
  setSetting(db, 'daily_budget_usd', '5.5');
  assert.equal(getNum(db, 'daily_budget_usd'), 5.5);
  setSetting(db, 'shadow_mode', '0');
  assert.equal(getFlag(db, 'shadow_mode'), false);
  assert.throws(() => setSetting(db, 'no_existe', '1'), /clave desconocida/);
  assert.throws(() => setSetting(db, 'kill_switch', 'si'), /0 o 1/);
  assert.throws(() => setSetting(db, 'burst_quiet_ms', '-5'), /número/);
  assert.throws(() => setSetting(db, 'burst_quiet_ms', 'abc'), /número/);
  assert.equal(isSettingKey('typing_max_ms'), true);
  assert.equal(isSettingKey('read_ms_per_char'), true);
  assert.equal(isSettingKey('state.session_status'), false);
  db.prepare("UPDATE settings SET value = 'basura' WHERE key = 'burst_quiet_ms'").run(); // un valor roto por SQL cae al default
  assert.equal(getNum(db, 'burst_quiet_ms'), 2000);
});

test('bot_start_utc se fija una sola vez (primer arranque)', () => {
  const db = openDb(':memory:');
  assert.equal(getBotStart(db), undefined);
  assert.equal(ensureBotStart(db, NOW), NOW);
  assert.equal(ensureBotStart(db, NOW + 999), NOW); // el segundo arranque no lo mueve
  assert.equal(getBotStart(db), NOW);
});

test('estado interno (session.status): vive en la misma tabla pero no se mezcla con los settings', () => {
  const db = openDb(':memory:');
  assert.equal(getState(db, 'session_status'), undefined);
  setState(db, 'session_status', 'WORKING');
  assert.equal(getState(db, 'session_status'), 'WORKING');
  assert.throws(() => setSetting(db, 'state.session_status', 'x'), /clave desconocida/);
});

test('eventos entrantes: la clave única evita guardar dos veces; el lock se recupera y se puede demorar', () => {
  const db = openDb(':memory:');
  assert.equal(storeInboundEvent(db, 'evt_1', '{"a":1}', NOW), true);
  assert.equal(storeInboundEvent(db, 'evt_1', '{"a":1}', NOW + 5), false);
  assert.equal(storeInboundEvent(db, 'evt_2', '{"a":2}', NOW), true);
  const first = claimInboundEvents(db, NOW, 120_000, 10);
  assert.deepEqual(first.map((e) => [e.eventKey, e.attempts]), [['evt_1', 1], ['evt_2', 1]]);
  assert.deepEqual(claimInboundEvents(db, NOW + 1000, 120_000, 10), []); // todavía bloqueados
  const again = claimInboundEvents(db, NOW + 121_000, 120_000, 10); // el lock venció (el proceso murió): se recuperan
  assert.deepEqual(again.map((e) => [e.eventKey, e.attempts]), [['evt_1', 2], ['evt_2', 2]]);
  finishInboundEvent(db, again[0].id, 'hecho');
  delayInboundEvent(db, again[1].id, NOW + 500_000, 'boom');
  assert.deepEqual(claimInboundEvents(db, NOW + 200_000, 120_000, 10), []);
  assert.equal(claimInboundEvents(db, NOW + 500_000, 120_000, 10).length, 1);
});

test('mensajes: único por (sesión, id del proveedor); el id del modelo es m<rowid>; la historia salta lo borrado y lo vacío', () => {
  const db = openDb(':memory:');
  createConversation(db, { chatId: 'c1@c.us', session: 'default', mode: 'auto', nowMs: NOW });
  const a = insertMessage(db, msg('false_c1_A', 'customer', 'Hola'));
  const dup = insertMessage(db, msg('false_c1_A', 'customer', 'Hola otra vez'));
  assert.deepEqual([a.inserted, dup.inserted, dup.id], [true, false, a.id]);
  const b = insertMessage(db, msg('false_c1_B', 'customer', 'Quiero una cancha'));
  insertMessage(db, { ...msg('false_c1_C', 'customer', ''), media: 'audio' });
  const d = insertMessage(db, msg('false_c1_D', 'customer', 'borrado'));
  revokeMessage(db, d.id);
  insertMessage(db, msg('true_c1_E', 'bot', 'Buenas tardes'));
  assert.deepEqual(historyFor(db, 'c1@c.us').map((m) => [m.id, m.author, m.text]), [[`m${a.id}`, 'customer', 'Hola'], [`m${b.id}`, 'customer', 'Quiero una cancha'], ['m5', 'bot', 'Buenas tardes']]);
  assert.equal(historyFor(db, 'c1@c.us', 2).length, 2);
  assert.deepEqual(historyFor(db, 'otro@c.us'), []);
});

test('mensajes: editar cambia el texto; buscar por el tramo final del id (revoked/edited de WAHA)', () => {
  const db = openDb(':memory:');
  const a = insertMessage(db, msg('false_5491155550000@c.us_3EB0AAAA', 'customer', 'Hola'));
  assert.equal(findMessage(db, 'default', 'false_5491155550000@c.us_3EB0AAAA')?.id, a.id);
  assert.equal(findMessage(db, 'default', '3EB0AAAA')?.id, a.id);
  assert.equal(findMessage(db, 'default', 'B0AAAA'), undefined); // un sufijo parcial no es el id (tiene que empezar después de un "_")
  assert.equal(findMessage(db, 'otra-sesion', '3EB0AAAA'), undefined);
  editMessage(db, a.id, 'Hola, corrijo');
  assert.deepEqual([findMessage(db, 'default', '3EB0AAAA')?.text, findMessage(db, 'default', '3EB0AAAA')?.edited], ['Hola, corrijo', true]);
});

test('sin contestar: lo del cliente posterior a lo último contestado por el bot (answered_upto) o por el equipo', () => {
  const db = openDb(':memory:');
  createConversation(db, { chatId: 'c1@c.us', session: 'default', mode: 'auto', nowMs: NOW });
  const m1 = insertMessage(db, msg('p1', 'customer', 'uno'));
  const m2 = insertMessage(db, msg('p2', 'customer', 'dos'));
  assert.deepEqual(unansweredMessages(db, 'c1@c.us').map((m) => m.id), [m1.id, m2.id]);
  advanceAnswered(db, 'c1@c.us', m1.id);
  assert.deepEqual(unansweredMessages(db, 'c1@c.us').map((m) => m.id), [m2.id]);
  advanceAnswered(db, 'c1@c.us', 0); // nunca retrocede
  assert.equal(getConversation(db, 'c1@c.us')?.answeredUpto, m1.id);
  insertMessage(db, msg('p3', 'team', 'te contesto yo'));
  const m4 = insertMessage(db, msg('p4', 'customer', 'cuatro'));
  assert.deepEqual(unansweredMessages(db, 'c1@c.us').map((m) => m.id), [m4.id]);
});

test('conversaciones: número corto, modo, ficha, versión; crear dos veces no pisa', () => {
  const db = openDb(':memory:');
  const c = createConversation(db, { chatId: '123@lid', session: 'default', mode: 'humano', nowMs: NOW, profileName: 'Pedro' });
  assert.deepEqual([c.n, c.mode, c.contextVersion, c.profileName, c.card], [1, 'humano', 0, 'Pedro', emptyCard()]);
  assert.equal(createConversation(db, { chatId: '123@lid', session: 'default', mode: 'auto', nowMs: NOW + 1 }).mode, 'humano');
  assert.equal(getConversationByNumber(db, 1)?.chatId, '123@lid');
  setMode(db, '123@lid', 'auto');
  assert.equal(bumpVersion(db, '123@lid', NOW + 10), 1);
  assert.equal(bumpVersion(db, '123@lid', NOW + 20), 2);
  saveCard(db, '123@lid', { ...emptyCard(), teamNote: 'ojo' });
  const after = getConversation(db, '123@lid')!;
  assert.deepEqual([after.mode, after.contextVersion, after.card.teamNote, after.lastActivityUtc], ['auto', 2, 'ojo', NOW + 20]);
  assert.throws(() => db.prepare("UPDATE conversations SET mode = 'raro'").run(), /CHECK/);
});

test('outbox: la clave lógica es única; el orden de los globos de un chat se respeta; tx revierte si falla', () => {
  const db = openDb(':memory:');
  const o = (key: string, chat = 'c1@c.us') => ({ logicalKey: key, chatId: chat, kind: 'text' as const, body: key, expiresUtc: NOW + 60_000, contextVersion: 1, createdUtc: NOW, answersUpto: 0 });
  assert.equal(insertOutbox(db, o('c1:1:0')), true);
  assert.equal(insertOutbox(db, o('c1:1:0')), false);
  assert.equal(insertOutbox(db, o('c1:1:1')), true);
  assert.equal(listOutbox(db).length, 2);
  assert.equal(nextPendingOutbox(db, NOW)?.logicalKey, 'c1:1:0');
  db.prepare("UPDATE outbox SET status = 'incierto' WHERE logical_key = 'c1:1:0'").run();
  assert.equal(nextPendingOutbox(db, NOW), undefined); // el globo 2 espera a que se resuelva el 1
  assert.throws(() => tx(db, () => { insertOutbox(db, o('c1:2:0')); throw new Error('boom'); }), /boom/);
  assert.equal(listOutbox(db).length, 2);
});

test('switchToHuman: cancela lo pendiente y los borradores, sube la versión, deja constancia y solo cuenta como cambio la primera vez', () => {
  const db = openDb(':memory:');
  createConversation(db, { chatId: 'c1@c.us', session: 'default', mode: 'auto', nowMs: NOW });
  const o = (k: string, st: string) => { insertOutbox(db, { logicalKey: k, chatId: 'c1@c.us', kind: 'text', body: k, expiresUtc: NOW + 1000, contextVersion: 0, createdUtc: NOW, answersUpto: 0 }); db.prepare('UPDATE outbox SET status = ? WHERE logical_key = ?').run(st, k); };
  o('a', 'aceptado');
  o('b', 'pendiente');
  const d = createDraft(db, { chatId: 'c1@c.us', contextVersion: 0, bubbles: ['x'], material: [], nowMs: NOW, answersUpto: 0 });
  assert.equal(switchToHuman(db, 'c1@c.us', NOW + 5, '[Lo tomo]'), true);
  assert.deepEqual(listOutbox(db).map((r) => r.status), ['aceptado', 'cancelado']);
  assert.equal(getDraft(db, d)!.status, 'descartado');
  const c = getConversation(db, 'c1@c.us')!;
  assert.deepEqual([c.mode, c.contextVersion], ['humano', 1]);
  assert.deepEqual(listAudit(db, 'takeover').map((a) => a.detail), ['[Lo tomo]']);
  assert.equal(switchToHuman(db, 'c1@c.us', NOW + 9, 'otra vez'), false);
  assert.equal(getConversation(db, 'c1@c.us')!.contextVersion, 1);
  assert.equal(switchToHuman(db, 'no-existe@c.us', NOW, 'x'), false);
});
