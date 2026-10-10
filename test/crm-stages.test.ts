// Etapas del CRM (V6) y acciones compartidas (src/actions.ts): las mismas que usa Telegram, con las mismas reglas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { giveBack, moveStage, quoteSent, setBotSwitch, setShadow } from '../src/actions.ts';
import type { ActionContext } from '../src/actions.ts';
import { MIGRATIONS, createConversation, enterStage, getConversation, listAudit, migrate, pauseConversation, saveCard, setStage } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { createTelegram } from '../src/notify/telegram.ts';
import { getFlag, getState } from '../src/settings.ts';
import { FIRST_TEXT, policy, turnWith } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import { FakeTelegram, TG_GROUP, TG_TOKEN } from './f2b-helpers.ts';
import { ScriptedLlm } from './f2-helpers.ts';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const HUMAN = turnWith(['Buenas tardes, ya le aviso al equipo para que te contacte por acá.']);
HUMAN.signals = { ...HUMAN.signals, asks_human: true };

function setup(o: { shadow?: boolean; llm?: ScriptedLlm } = {}) {
  const h = makeHarness({ shadow: o.shadow ?? false, ...(o.llm ? { llm: o.llm } : {}) });
  const rescans: number[] = [];
  const controls = () => ({
    worker: { onCustomerMessage: (id: string) => h.worker.onCustomerMessage(id), rescan: () => { rescans.push(1); h.worker.rescan(); } },
    kickOutbox: () => h.outbox.kick(),
    session: { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array(), mimetype: 'image/png' }) },
  });
  const ctx: ActionContext = { db: h.db, clock: h.clock, controls, assets: policy.assets };
  const api = new FakeTelegram();
  const tg = createTelegram({ db: h.db, clock: h.clock, token: TG_TOKEN, groupId: TG_GROUP, fetch: api.fetch, assets: policy.assets, controls });
  return { h, ctx, api, tg, rescans };
}
const conv = (h: ReturnType<typeof makeHarness>, chatId = CHAT) => getConversation(h.db, chatId)!;

// ---------- migración V6 ----------
test('V6 sobre una base V5: rellena presupuestados y derivados, deja con el bot lo demás, y es idempotente', () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
  db.exec('PRAGMA user_version = 5');
  const add = (chat: string, mode: string) => db.prepare("INSERT INTO conversations (chat_id, session, mode, card_json, last_activity_utc, first_seen_utc) VALUES (?, 'default', ?, '{}', 1, 1)").run(chat, mode);
  const handoff = (chat: string, ts: number, detail: string) => db.prepare("INSERT INTO audit (ts_utc, chat_id, kind, detail) VALUES (?, ?, 'handoff', ?)").run(ts, chat, detail);
  add('presu@c.us', 'humano');
  db.prepare("INSERT INTO settings (key, value) VALUES ('state.quote_sent_utc.presu@c.us', '500')").run();
  handoff('presu@c.us', 100, 'listo_para_presupuesto (stop, prioridad alta)');
  add('listo@c.us', 'humano');
  handoff('listo@c.us', 200, 'cliente_grande (flag, prioridad alta)');
  handoff('listo@c.us', 300, 'listo_para_presupuesto (stop, prioridad normal)');
  handoff('listo@c.us', 350, 'factura_a (flag, prioridad normal)'); // un aviso posterior no cambia la hora de la derivación
  add('baja@c.us', 'humano');
  handoff('baja@c.us', 400, 'baja (stop, prioridad baja)');
  add('audio@c.us', 'humano');
  handoff('audio@c.us', 450, 'audio_ilegible (stop, prioridad normal)'); // deriva sin tocar la ficha: por eso el relleno mira la auditoría
  add('devuelto@c.us', 'auto');
  handoff('devuelto@c.us', 600, 'pide_persona (stop, prioridad normal)'); // después lo devolvieron al bot: queda sin etapa
  add('solo-aviso@c.us', 'humano');
  handoff('solo-aviso@c.us', 700, 'regateo (flag, prioridad normal)');
  add('nuevo@c.us', 'auto');
  add('presu-auto@c.us', 'auto'); // presupuestado y después devuelto al bot (antes de V6 era común): sin etapa, tener etapa = ser del equipo
  db.prepare("INSERT INTO settings (key, value) VALUES ('state.quote_sent_utc.presu-auto@c.us', '800')").run();
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  const rows = Object.fromEntries((db.prepare('SELECT chat_id, stage, stage_since_utc FROM conversations').all() as { chat_id: string; stage: string | null; stage_since_utc: number | null }[])
    .map((r) => [r.chat_id, [r.stage, r.stage_since_utc]]));
  assert.deepEqual(rows, {
    'presu@c.us': ['presupuestado', 500],
    'listo@c.us': ['a_presupuestar', 300],
    'baja@c.us': ['descartado', 400],
    'audio@c.us': ['a_presupuestar', 450],
    'devuelto@c.us': [null, null],
    'solo-aviso@c.us': [null, null],
    'nuevo@c.us': [null, null],
    'presu-auto@c.us': [null, null],
  });
  assert.throws(() => db.prepare("UPDATE conversations SET stage = 'raro'").run(), /CHECK/);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'audit_chat'").get()); // historial del CRM sin recorrer toda la auditoría
});

test('setStage: repetir la misma etapa no reinicia la espera; cambiarla sí; el motivo solo queda en perdido o descartado; null la borra', () => {
  const { h } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: 1 });
  setStage(h.db, CHAT, 'a_presupuestar', 100);
  setStage(h.db, CHAT, 'a_presupuestar', 200);
  assert.equal(conv(h).stageSinceUtc, 100);
  setStage(h.db, CHAT, 'seguimiento', 300, 'no debería quedar');
  assert.deepEqual([conv(h).stage, conv(h).stageSinceUtc, conv(h).lostReason], ['seguimiento', 300, null]);
  setStage(h.db, CHAT, 'perdido', 400, 'precio');
  assert.deepEqual([conv(h).stage, conv(h).lostReason], ['perdido', 'precio']);
  setStage(h.db, CHAT, null, 500);
  assert.deepEqual([conv(h).stage, conv(h).stageSinceUtc, conv(h).lostReason], [null, null, null]);
});

// ---------- el worker al derivar ----------
test('al derivar con stop el chat entra a "A presupuestar" con la hora de la derivación', async () => {
  const llm = new ScriptedLlm(() => HUMAN);
  const { h } = setup({ llm });
  h.say(CHAT, 'quiero hablar con una persona');
  await h.clock.advance(sec(20));
  const c = conv(h);
  assert.ok(listAudit(h.db, 'handoff').some((a) => a.detail.startsWith('pide_persona (stop')));
  assert.equal(c.mode, 'humano');
  assert.equal(c.stage, 'a_presupuestar');
  assert.ok(c.stageSinceUtc! > 0 && c.stageSinceUtc! <= h.clock.now());
});

test('entrar a una etapa al derivar no pisa la que ya puso el equipo', () => {
  const { h } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: 1 });
  setStage(h.db, CHAT, 'seguimiento', 100);
  enterStage(h.db, CHAT, 'a_presupuestar', 200);
  assert.deepEqual([conv(h).stage, conv(h).stageSinceUtc], ['seguimiento', 100]);
});

test('un aviso que no frena (primer regateo) no le pone etapa: el chat sigue con el bot', async () => {
  const haggle = turnWith([FIRST_TEXT]);
  haggle.signals = { ...haggle.signals, negotiating: true };
  const { h } = setup({ llm: new ScriptedLlm(() => haggle) });
  h.say(CHAT, 'me hacés un descuento?');
  await h.clock.advance(sec(20));
  assert.ok(listAudit(h.db, 'handoff').some((a) => a.detail.startsWith('regateo (flag')));
  assert.deepEqual([conv(h).mode, conv(h).stage], ['auto', null]);
});

// ---------- acciones compartidas ----------
test('Devolver al bot (CRM o /bot de Telegram) borra la etapa y lo deja en auto', async () => {
  const { h, ctx, api, tg } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: h.clock.now() });
  setStage(h.db, CHAT, 'a_presupuestar', h.clock.now());
  assert.equal(giveBack(ctx, conv(h), 'CRM', 'CRM'), 'devuelto');
  assert.deepEqual([conv(h).mode, conv(h).stage], ['auto', null]);
  // Telegram, mismo efecto
  createConversation(h.db, { chatId: 'otro@c.us', session: 'default', mode: 'humano', nowMs: h.clock.now() });
  setStage(h.db, 'otro@c.us', 'presupuestado', h.clock.now());
  api.text(TG_GROUP, `/bot ${conv(h, 'otro@c.us').n}`);
  await tg.pollOnce();
  assert.deepEqual([conv(h, 'otro@c.us').mode, conv(h, 'otro@c.us').stage], ['auto', null]);
  assert.match(api.texts.at(-1)!, /vuelve con el bot/);
});

test('[Presupuesto mandado] pasa a Presupuestados, toma el chat si estaba con el bot, guarda la hora una vez y no hace retroceder a Seguimiento', async () => {
  const { h, ctx, api, tg } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  assert.equal(conv(h).mode, 'auto');
  api.press(TG_GROUP, `presu:${conv(h).n}`);
  await tg.pollOnce();
  const c = conv(h);
  assert.deepEqual([c.mode, c.stage, c.stageSinceUtc], ['humano', 'presupuestado', h.clock.now()]);
  assert.equal(getState(h.db, `quote_sent_utc.${CHAT}`), String(h.clock.now()));
  assert.match(api.texts.at(-1)!, /anotado, presupuesto mandado/);
  // Otro chat ya en Seguimiento: anota la hora, pero no lo hace retroceder.
  createConversation(h.db, { chatId: 'seg@c.us', session: 'default', mode: 'humano', nowMs: h.clock.now() });
  setStage(h.db, 'seg@c.us', 'seguimiento', 1);
  assert.equal(quoteSent(ctx, conv(h, 'seg@c.us'), 'CRM').status, 'anotado');
  assert.equal(conv(h, 'seg@c.us').stage, 'seguimiento');
  await h.clock.advance(min(5));
  assert.equal(quoteSent(ctx, conv(h, 'seg@c.us'), 'CRM').status, 'ya_estaba');
  // Doble toque: la hora no cambia.
  const first = getState(h.db, `quote_sent_utc.${CHAT}`);
  assert.equal(quoteSent(ctx, conv(h), 'CRM').status, 'ya_estaba');
  assert.equal(getState(h.db, `quote_sent_utc.${CHAT}`), first);
});

test('[Presupuesto mandado] de nuevo después de volver a A presupuestar: es un presupuesto nuevo (hora nueva y pasa a Presupuestados)', async () => {
  const { h, ctx } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: h.clock.now() });
  setStage(h.db, CHAT, 'a_presupuestar', h.clock.now());
  assert.equal(quoteSent(ctx, conv(h), 'CRM').status, 'anotado');
  await h.clock.advance(min(60));
  moveStage(ctx, conv(h), 'a_presupuestar', 'CRM'); // el cliente pidió otro presupuesto
  const r = quoteSent(ctx, conv(h), 'CRM');
  assert.deepEqual([r.status, r.atUtc], ['anotado', h.clock.now()]);
  assert.deepEqual([conv(h).stage, conv(h).stageSinceUtc], ['presupuestado', h.clock.now()]);
  assert.equal(getState(h.db, `quote_sent_utc.${CHAT}`), String(h.clock.now()));
});

test('Devolver al bot un chat con la ficha cerrada: vuelve a auto, pero avisa que el bot no le escribe', () => {
  const { h, ctx } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: h.clock.now() });
  const card = emptyCard();
  card.state = 'derivado';
  saveCard(h.db, CHAT, card);
  assert.equal(giveBack(ctx, conv(h), 'CRM', 'CRM'), 'ficha_cerrada');
  assert.equal(conv(h).mode, 'auto');
});

test('mover de etapa un chat pausado lo pasa al equipo (la vuelta de las 00:00 no lo devuelve al bot) y queda en la auditoría', () => {
  const { h, ctx } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: h.clock.now() });
  pauseConversation(h.db, CHAT, 'budget', h.clock.now());
  const v = conv(h).contextVersion;
  assert.equal(moveStage(ctx, conv(h), 'perdido', 'CRM', '  precio '), 'movido');
  const c = conv(h);
  assert.deepEqual([c.mode, c.stage, c.lostReason, c.pauseReason], ['humano', 'perdido', 'precio', null]);
  assert.equal(c.contextVersion, v + 1); // switchToHuman: un turno en vuelo ya no vale
  assert.ok(listAudit(h.db, 'command').some((a) => a.detail === 'etapa: sin etapa → perdido (precio) (CRM)'));
  assert.equal(moveStage(ctx, conv(h), 'perdido', 'CRM', 'precio'), 'igual');
});

test('mover de etapa un chat que ya está en humano no cancela lo pendiente (puede ser el mensaje de cierre)', () => {
  const { h, ctx } = setup();
  createConversation(h.db, { chatId: CHAT, session: 'default', mode: 'humano', nowMs: h.clock.now() });
  const v = conv(h).contextVersion;
  moveStage(ctx, conv(h), 'seguimiento', 'CRM');
  assert.equal(conv(h).contextVersion, v);
  assert.equal(conv(h).stage, 'seguimiento');
});

test('apagar/prender y sombra: mismas reglas que Telegram (prender retoma lo que esperaba)', () => {
  const { h, ctx, rescans } = setup();
  setBotSwitch(ctx, false);
  assert.equal(getFlag(h.db, 'kill_switch'), true);
  assert.equal(rescans.length, 0);
  setBotSwitch(ctx, true);
  assert.equal(getFlag(h.db, 'kill_switch'), false);
  assert.equal(rescans.length, 1);
  setShadow(ctx, true);
  assert.equal(getFlag(h.db, 'shadow_mode'), true);
  setShadow(ctx, false);
  assert.equal(getFlag(h.db, 'shadow_mode'), false);
});
