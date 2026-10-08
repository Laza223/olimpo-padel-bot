// Telegram (parte B): solo el grupo autorizado, offset persistido, fichas con botones, borradores del modo sombra, comandos y límite de 4096.
// Todo con Telegram falso inyectado como fetch: sin red ni token real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConversation, getDraft, listAudit, listDrafts, listOutbox, bumpVersion, switchToHuman } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { createConsoleNotifier, createTelegram } from '../src/notify/telegram.ts';
import type { TelegramControls } from '../src/notify/telegram.ts';
import { getFlag, getNum, getState } from '../src/settings.ts';
import type { HandoffDecision } from '../src/types.ts';
import { FIRST_TEXT, policy } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import { FakeTelegram, TG_GROUP, TG_TOKEN } from './f2b-helpers.ts';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
// Deja correr todo el trabajo asíncrono listo (el bucle de long polling encadena varias promesas).
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
const READY: HandoffDecision = { reason: 'listo_para_presupuesto', priority: 'alta', mode: 'stop' };

function setup(o: { shadow?: boolean; qr?: TelegramControls['session']['qr']; status?: () => string; worker?: TelegramControls['worker'] } = {}) {
  const h = makeHarness({ shadow: o.shadow ?? true });
  const api = new FakeTelegram();
  const session = { current: o.status ?? (() => 'WORKING'), qr: o.qr ?? (async () => ({ data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), mimetype: 'image/png' })) };
  const mk = () => createTelegram({ db: h.db, clock: h.clock, token: TG_TOKEN, groupId: TG_GROUP, fetch: api.fetch, assets: policy.assets, controls: () => ({ worker: o.worker ?? h.worker, kickOutbox: () => h.outbox.kick(), session }) });
  const tg = mk();
  return { h, api, tg, mk };
}

// Una conversación del cliente con un borrador pendiente (modo sombra), ya avisado a Telegram.
async function withDraft(s: ReturnType<typeof setup>) {
  s.h.say(CHAT, 'Hola, quiero una cancha');
  await s.h.clock.advance(sec(10));
  const d = s.h.notifier.drafts[0];
  await s.tg.draft(d.chatId, d.draftId, d.bubbles, d.material);
  return d;
}
const lastButtons = (api: FakeTelegram): string[] =>
  (api.sent.at(-1)!.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat().map((b) => `${b.text}|${b.callback_data}`);

// ---------- el grupo autorizado ----------
test('un chat que no es el grupo se ignora: ni comando, ni botón, ni respuesta (pero el offset avanza)', async () => {
  const { h, api, tg } = setup();
  api.text('-999', '/apagar');
  api.press('-999', 'tomo:1');
  api.text(TG_GROUP, 'hola gente, esto es charla común'); // charla del grupo: no es un comando
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'kill_switch'), false);
  assert.deepEqual(api.calls.map((c) => c.method), ['getUpdates']);
  assert.equal(getState(h.db, 'telegram_offset'), '4');
});

test('el offset de getUpdates se guarda y el próximo arranque sigue desde ahí', async () => {
  const { h, api, tg, mk } = setup();
  api.text(TG_GROUP, '/estado');
  api.text(TG_GROUP, '/estado');
  await tg.pollOnce();
  assert.equal(getState(h.db, 'telegram_offset'), '3');
  const again = mk(); // reinicio del bot: misma base
  api.text(TG_GROUP, '/estado');
  await again.pollOnce();
  assert.equal(api.callsOf('getUpdates').at(-1)!.body.offset, 3);
  assert.equal(getState(h.db, 'telegram_offset'), '4');
  assert.equal(api.sent.length, 3); // cada /estado se contestó una sola vez
});

test('un update que rompe no frena a los demás ni se reprocesa', async () => {
  const { h, api, tg } = setup({ worker: { onCustomerMessage: () => undefined, rescan: () => { throw new Error('rescan roto'); } } });
  api.text(TG_GROUP, '/prender'); // el handler tira
  api.press(TG_GROUP, 'tomo:abc'); // botón con datos que no son nuestros
  api.push({ message: { message_id: 1, text: '/estado' } }); // sin chat
  api.text(TG_GROUP, '/estado');
  await tg.pollOnce();
  assert.equal(api.texts.filter((t) => /Estado del bot/.test(t)).length, 1);
  assert.equal(getState(h.db, 'telegram_offset'), '5');
  assert.ok(listAudit(h.db, 'error').some((a) => /rescan roto/.test(a.detail)));
});

// ---------- comandos ----------
test('/apagar corta todo: el próximo mensaje del cliente no llama a OpenAI; /prender lo retoma', async () => {
  const { h, api, tg } = setup();
  api.text(TG_GROUP, '/apagar');
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'kill_switch'), true);
  assert.match(api.texts.at(-1)!, /apagado/i);
  h.say(CHAT, 'Hola, quiero una cancha');
  await h.clock.advance(min(5));
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.notifier.drafts.length, 0);
  assert.equal(h.channel.sendCalls, 0);
  api.text(TG_GROUP, '/prender');
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'kill_switch'), false);
  await h.clock.advance(min(1)); // el rescan programa la consulta que quedó esperando
  assert.equal(h.llmCalls(), 1);
  assert.equal(h.notifier.drafts.length, 1);
  assert.deepEqual(listAudit(h.db, 'command').map((a) => a.detail.split(' ')[0]), ['/apagar', '/prender']);
});

test('/sombra on|off cambia shadow_mode y sin argumento muestra el estado', async () => {
  const { h, api, tg } = setup({ shadow: true });
  api.text(TG_GROUP, '/sombra off');
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'shadow_mode'), false);
  assert.match(api.texts.at(-1)!, /le escribe directo/);
  api.text(TG_GROUP, '/sombra on');
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'shadow_mode'), true);
  api.text(TG_GROUP, '/sombra');
  api.text(TG_GROUP, '/sombra quizas');
  await tg.pollOnce();
  assert.equal(getFlag(h.db, 'shadow_mode'), true);
  assert.match(api.texts.at(-2)!, /Modo sombra: prendido/);
  assert.match(api.texts.at(-1)!, /on o \/sombra off/);
});

test('/estado: sesión, cola, gasto del día y chats en auto', async () => {
  const { h, api, tg } = setup({ shadow: false, status: () => 'SCAN_QR_CODE' });
  h.say(CHAT, 'Hola');
  h.say('5491166660000@c.us', 'Hola');
  await h.clock.advance(sec(2.5)); // las dos respuestas quedan pendientes de envío
  api.text(TG_GROUP, '/estado');
  await tg.pollOnce();
  const t = api.texts.at(-1)!;
  assert.match(t, /WhatsApp: SCAN_QR_CODE/);
  assert.match(t, /Cola de salida:.*pendiente/);
  assert.match(t, /Gasto de hoy: USD 0\.00 de 2/);
  assert.match(t, /Chats: 2 con el bot/);
  assert.match(t, /Bot: prendido/);
});

test('/chat <n> muestra los últimos mensajes del número corto, nunca el teléfono', async () => {
  const { h, api, tg } = setup();
  h.say(CHAT, 'Hola, soy Pedro de Pilar');
  await h.clock.advance(sec(10));
  api.text(TG_GROUP, '/chat 1');
  api.text(TG_GROUP, '/chat #1');
  api.text(TG_GROUP, '/chat 99');
  api.text(TG_GROUP, '/chat');
  await tg.pollOnce();
  const [a, b, none, noArg] = api.texts;
  assert.match(a, /Chat #1/);
  assert.match(a, /cliente .*Hola, soy Pedro de Pilar/);
  assert.equal(b, a);
  assert.match(none, /No existe/);
  assert.match(noArg, /\/chat n/);
  assert.ok(!api.texts.some((t) => t.includes('5491155550000')));
});

test('/humano <n> pasa el chat al equipo y cancela lo pendiente; /bot <n> lo devuelve y programa el turno', async () => {
  const s = setup({ shadow: true });
  const { h, api, tg } = s;
  await withDraft(s);
  api.text(TG_GROUP, '/humano 1');
  await tg.pollOnce();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(listDrafts(h.db, CHAT).map((d) => d.status), ['descartado']);
  h.say(CHAT, 'Hola? Me contestan?'); // en humano no abre turno
  await h.clock.advance(min(1));
  assert.equal(h.llmCalls(), 1);
  api.text(TG_GROUP, '/bot 1');
  await tg.pollOnce();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  await h.clock.advance(min(1));
  assert.equal(h.llmCalls(), 2);
  assert.equal(h.notifier.drafts.length, 2);
  api.text(TG_GROUP, '/bot 42');
  api.text(TG_GROUP, '/humano');
  await tg.pollOnce();
  assert.match(api.texts.at(-2)!, /No existe/);
  assert.match(api.texts.at(-1)!, /\/humano n/);
});

test('/set cambia claves conocidas y rechaza las desconocidas o con valor inválido', async () => {
  const { h, api, tg } = setup();
  api.text(TG_GROUP, '/set daily_budget_usd 3.5');
  await tg.pollOnce();
  assert.equal(getNum(h.db, 'daily_budget_usd'), 3.5);
  assert.match(api.texts.at(-1)!, /daily_budget_usd = 3\.5/);
  api.text(TG_GROUP, '/set clave_inventada 1');
  api.text(TG_GROUP, '/set kill_switch quizas');
  api.text(TG_GROUP, '/set daily_budget_usd');
  api.text(TG_GROUP, '/set daily_budget_usd -4');
  await tg.pollOnce();
  assert.match(api.texts.at(-4)!, /clave_inventada.*no existe/);
  assert.match(api.texts.at(-4)!, /daily_budget_usd/); // lista las que sí
  assert.match(api.texts.at(-3)!, /0 o 1/);
  assert.match(api.texts.at(-2)!, /\/set clave valor/);
  assert.match(api.texts.at(-1)!, /número desde 0/);
  assert.equal(getFlag(h.db, 'kill_switch'), false);
  assert.equal(getNum(h.db, 'daily_budget_usd'), 3.5);
  // __proto__ y compañía no son claves
  api.text(TG_GROUP, '/set __proto__ 1');
  api.text(TG_GROUP, '/set constructor 1');
  await tg.pollOnce();
  assert.match(api.texts.at(-2)!, /no existe/);
  assert.match(api.texts.at(-1)!, /no existe/);
});

test('/qr manda la imagen de WAHA al grupo; si no hay QR, avisa por qué', async () => {
  const { api, tg } = setup();
  api.text(TG_GROUP, '/qr');
  await tg.pollOnce();
  const photo = api.callsOf('sendPhoto')[0];
  assert.equal(photo.body.chat_id, TG_GROUP);
  assert.equal((photo.body.photo as Blob).size, 7);
  assert.match(String(photo.body.caption), /Dispositivos vinculados/);
  const bad = setup({ qr: async () => { throw new Error('WAHA respondió 422: la sesión está en WORKING'); } });
  bad.api.text(TG_GROUP, '/qr');
  await bad.tg.pollOnce();
  assert.equal(bad.api.callsOf('sendPhoto').length, 0);
  assert.match(bad.api.texts.at(-1)!, /No pude traer el QR.*WORKING/);
});

test('un comando que no existe contesta con la lista; el token nunca aparece en lo que se manda', async () => {
  const { api, tg } = setup();
  api.text(TG_GROUP, '/hacer_magia');
  api.text(TG_GROUP, '/estado@OlimpoBot'); // con el @ del bot, como lo manda Telegram en grupos
  await tg.pollOnce();
  assert.match(api.texts[0], /No entendí[\s\S]*\/estado/);
  assert.match(api.texts[1], /Estado del bot/);
  assert.ok(!JSON.stringify(api.calls.map((c) => c.body)).includes(TG_TOKEN));
});

// ---------- fichas y botones ----------
test('ficha: sale con buildFicha, el número corto y los 3 botones; nunca el teléfono', async () => {
  const { h, api, tg } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  const card = { ...emptyCard(), state: 'listo_para_presupuesto' as const };
  await tg.handoff(CHAT, card, [READY]);
  const t = api.texts.at(-1)!;
  assert.match(t, /^Chat #1/);
  assert.match(t, /ALTA · Listo para presupuesto \(el bot dejó de responder\)/);
  assert.match(t, /Últimos mensajes/);
  assert.ok(!t.includes('5491155550000'));
  assert.deepEqual(lastButtons(api), ['Lo tomo|tomo:1', 'Devolver al bot|bot:1', 'Presupuesto mandado|presu:1']);
  assert.equal(api.sent.at(-1)!.chat_id, TG_GROUP);
  assert.equal(api.sent.at(-1)!.parse_mode, undefined); // texto plano: nada que inyectar
});

test('ficha con varias derivaciones: una sola ficha con la principal y las demás en una línea', async () => {
  const { h, api, tg } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  await tg.handoff(CHAT, emptyCard(), [{ reason: 'cliente_grande', priority: 'alta', mode: 'flag' }, READY]);
  assert.equal(api.sent.length, 1);
  assert.match(api.texts[0], /ALTA · Listo para presupuesto/); // la que frena al bot manda
  assert.match(api.texts[0], /Además: ALTA · Cliente grande/);
});

test('[Lo tomo] de la ficha: el chat pasa a humano y se cancela lo pendiente (salida y borradores)', async () => {
  const { h, api, tg } = setup({ shadow: false });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(2) + sec(0.5)); // el turno terminó y la respuesta espera salir
  assert.equal(listOutbox(h.db)[0].status, 'pendiente');
  api.press(TG_GROUP, 'tomo:1');
  await tg.pollOnce();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  await h.clock.advance(min(5));
  assert.equal(h.channel.sendCalls, 0);
  assert.deepEqual(listOutbox(h.db).map((r) => [r.status, r.cause]), [['cancelado', 'toma_humana']]);
  assert.equal(api.callsOf('answerCallbackQuery').length, 1);
  assert.match(api.texts.at(-1)!, /#1.*Lazar/);
  assert.ok(listAudit(h.db, 'takeover').some((a) => /Lo tomo/.test(a.detail)));
});

test('[Devolver al bot]: vuelve a auto y se programa el turno de lo que el cliente dejó sin contestar', async () => {
  const { h, api, tg } = setup({ shadow: true });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  h.deliver(h.ownEvent(CHAT, 'Hola, soy Tomás, sigo yo')); // lo toma el equipo desde el celular
  h.say(CHAT, 'Che, y cuánto sale?');
  await h.clock.advance(min(1));
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.equal(h.llmCalls(), 1);
  api.press(TG_GROUP, 'bot:1');
  await tg.pollOnce();
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  await h.clock.advance(sec(3));
  assert.equal(h.llmCalls(), 2);
});

test('[Presupuesto mandado] guarda la hora una sola vez (para los recordatorios de F4)', async () => {
  const { h, api, tg } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  const t1 = h.clock.now();
  api.press(TG_GROUP, 'presu:1');
  await tg.pollOnce();
  assert.equal(getState(h.db, `quote_sent_utc.${CHAT}`), String(t1));
  assert.ok(listAudit(h.db, 'command').some((a) => /presupuesto_mandado/.test(a.detail)));
  await h.clock.advance(min(10));
  api.press(TG_GROUP, 'presu:1');
  await tg.pollOnce();
  assert.equal(getState(h.db, `quote_sent_utc.${CHAT}`), String(t1)); // no pisa la primera hora
  assert.match(api.texts.at(-1)!, /ya estaba anotado/);
});

test('un botón de una conversación que no existe avisa y no rompe nada', async () => {
  const { h, api, tg } = setup();
  api.press(TG_GROUP, 'tomo:77');
  api.press(TG_GROUP, 'mandar:77');
  await tg.pollOnce();
  assert.equal(api.callsOf('answerCallbackQuery').length, 2);
  assert.match(String(api.callsOf('answerCallbackQuery')[0].body.text), /No existe/);
  assert.equal(listAudit(h.db, 'takeover').length, 0);
});

test('takeover: avisa que el equipo escribió y ofrece [Devolver al bot]', async () => {
  const { h, api, tg } = setup();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  await tg.takeover(CHAT);
  assert.match(api.texts.at(-1)!, /Chat #1: alguien del equipo escribió/);
  assert.deepEqual(lastButtons(api), ['Devolver al bot|bot:1']);
});

// ---------- borradores del modo sombra ----------
test('borrador: sale con lo que dijo el cliente, lo que contestaría el bot y [Mandar] [Descartar] [Lo tomo]', async () => {
  const s = setup();
  const d = await withDraft(s);
  const t = s.api.texts.at(-1)!;
  assert.match(t, /Borrador #1.*chat #1/);
  assert.match(t, /todavía no se mandó nada/);
  assert.match(t, /Hola, quiero una cancha/);
  assert.ok(t.includes(FIRST_TEXT));
  assert.deepEqual(lastButtons(s.api), [`Mandar|mandar:${d.draftId}`, `Descartar|desc:${d.draftId}`, `Lo tomo|dtomo:${d.draftId}`]);
  assert.equal(getDraft(s.h.db, d.draftId)!.tgMessageId, 100); // el id del mensaje queda guardado
});

test('[Mandar]: el borrador entra al outbox, sale al cliente y no se manda dos veces', async () => {
  const s = setup();
  const d = await withDraft(s);
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: s.api.texts.at(-1)! });
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: s.api.texts.at(-1)! }); // doble toque
  await s.tg.pollOnce();
  await s.h.clock.advance(min(1));
  assert.deepEqual(s.h.texts(), [FIRST_TEXT]);
  assert.equal(getDraft(s.h.db, d.draftId)!.status, 'mandado');
  assert.equal(listOutbox(s.h.db).length, 1);
  const edited = s.api.callsOf('editMessageText')[0].body;
  assert.match(String(edited.text), /Mandado por Lazar/);
  assert.deepEqual(edited.reply_markup, { inline_keyboard: [] }); // se sacan los botones
  assert.match(String(s.api.callsOf('answerCallbackQuery')[1].body.text), /ya estaba mandado/i);
});

test('[Mandar] con el contexto cambiado: "vencido" y no sale nada', async () => {
  const s = setup();
  const d = await withDraft(s);
  s.h.say(CHAT, 'Ah, y la quiero techada'); // el cliente escribió de nuevo: el borrador quedó viejo
  await s.h.clock.advance(sec(1));
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  await s.h.clock.advance(min(1));
  assert.equal(s.h.channel.sendCalls, 0);
  assert.match(String(s.api.callsOf('answerCallbackQuery')[0].body.text), /vencido/i);
  assert.match(String(s.api.callsOf('editMessageText')[0].body.text), /VENCIDO/);
});

test('[Mandar] con un borrador pendiente pero otra versión del contexto: approveDraft lo vence', async () => {
  const s = setup();
  const d = await withDraft(s);
  bumpVersion(s.h.db, CHAT, s.h.clock.now()); // cambia la versión sin pasar por el ingest
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  assert.equal(getDraft(s.h.db, d.draftId)!.status, 'vencido');
  assert.equal(s.h.channel.sendCalls, 0);
  assert.match(String(s.api.callsOf('answerCallbackQuery')[0].body.text), /vencido/i);
});

test('[Descartar]: el borrador no se manda nunca', async () => {
  const s = setup();
  const d = await withDraft(s);
  s.api.press(TG_GROUP, `desc:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  await s.h.clock.advance(min(5));
  assert.equal(getDraft(s.h.db, d.draftId)!.status, 'descartado');
  assert.equal(s.h.channel.sendCalls, 0);
  assert.match(String(s.api.callsOf('editMessageText')[0].body.text), /Descartado por Lazar/);
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: 'Borrador #1' }); // Mandar después de Descartar
  await s.tg.pollOnce();
  assert.equal(s.h.channel.sendCalls, 0);
});

test('[Lo tomo] del borrador: humano, el borrador queda descartado y no sale nada', async () => {
  const s = setup();
  const d = await withDraft(s);
  s.api.press(TG_GROUP, `dtomo:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  assert.equal(getConversation(s.h.db, CHAT)!.mode, 'humano');
  assert.equal(getDraft(s.h.db, d.draftId)!.status, 'descartado');
  assert.match(String(s.api.callsOf('editMessageText')[0].body.text), /Lo tomó Lazar/);
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  await s.h.clock.advance(min(5));
  assert.equal(s.h.channel.sendCalls, 0);
});

test('[Mandar] de un chat que el equipo tomó después del borrador: no sale', async () => {
  const s = setup();
  const d = await withDraft(s);
  switchToHuman(s.h.db, CHAT, s.h.clock.now(), 'prueba');
  s.api.press(TG_GROUP, `mandar:${d.draftId}`, { message_id: 100, text: 'Borrador #1' });
  await s.tg.pollOnce();
  await s.h.clock.advance(min(5));
  assert.equal(s.h.channel.sendCalls, 0);
});

// ---------- avisos, límite y texto ----------
test('alert: los urgentes llevan prefijo y suenan; los comunes salen en silencio', async () => {
  const { api, tg } = setup();
  await tg.alert('OpenAI sin saldo', { urgent: true });
  await tg.alert('Adjunto sin leer');
  assert.deepEqual(api.texts, ['URGENTE: OpenAI sin saldo', 'Adjunto sin leer']);
  assert.equal(api.sent[0].disable_notification, false);
  assert.equal(api.sent[1].disable_notification, true);
  assert.deepEqual(api.sent[0].link_preview_options, { is_disabled: true });
});

test('límite de 4096: ni un aviso largo ni una ficha con mensajes enormes pasan de ese largo', async () => {
  const { h, api, tg } = setup();
  await tg.alert('x'.repeat(10_000), { urgent: true });
  assert.ok(api.texts[0].length <= 4096);
  assert.match(api.texts[0], /recortado/);
  assert.ok(api.texts[0].startsWith('URGENTE: xxx'));
  h.say(CHAT, 'y'.repeat(20_000));
  await h.clock.advance(sec(10));
  const card = { ...emptyCard(), teamNote: 'z'.repeat(30_000) };
  await tg.handoff(CHAT, card, [READY]);
  assert.ok(api.texts[1].length <= 4096);
  await tg.alert('😀'.repeat(3000)); // 2 unidades por emoji: se corta sin partir un par sustituto
  assert.ok(api.texts[2].length <= 4096);
  const body = api.texts[2].replace(/\n\[recortado\]$/, '');
  const last = body.charCodeAt(body.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff));
});

test('el texto del cliente se limpia: sin caracteres de control ni de dirección que den vuelta el texto', async () => {
  const { h, api, tg } = setup();
  const RLO = String.fromCharCode(0x202e); // invierte el sentido del texto
  const PDF = String.fromCharCode(0x202c);
  h.say(CHAT, `Hola${String.fromCharCode(1)} ${RLO}ataque${PDF}${String.fromCharCode(7)} normal`);
  await h.clock.advance(sec(10));
  await tg.handoff(CHAT, emptyCard(), [READY]);
  const t = api.texts[0];
  assert.match(t, /Hola ataque normal/);
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    assert.ok(!(c < 9 || c === 11 || c === 12 || (c >= 14 && c <= 31) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)), `quedó el carácter ${c}`);
  }
});

// ---------- falla y bucle ----------
test('Telegram caído: alert tira (quien avisa lo atrapa) y el error no lleva el token', async () => {
  const { api, tg } = setup();
  api.failing = true;
  await assert.rejects(() => Promise.resolve(tg.alert('hola')), (e: Error) => !e.message.includes(TG_TOKEN) && /Telegram sendMessage/.test(e.message));
  api.failing = false;
  assert.equal(api.badTokenSeen, false);
});

test('el bucle de long polling responde sin esperar, se frena con stop() y no queda colgado', async () => {
  const { h, api, tg } = setup();
  tg.start();
  api.text(TG_GROUP, '/estado');
  await settle();
  assert.equal(api.texts.filter((t) => /Estado del bot/.test(t)).length, 1);
  api.text(TG_GROUP, '/estado');
  await settle();
  assert.equal(api.texts.filter((t) => /Estado del bot/.test(t)).length, 2);
  tg.stop(); // aborta el getUpdates en vuelo
  const before = api.calls.length;
  api.text(TG_GROUP, '/estado');
  await h.clock.advance(min(5));
  assert.equal(api.calls.length, before);
});

test('si getUpdates falla, el bucle espera con retroceso y vuelve solo (sin martillar)', async () => {
  const { h, api, tg } = setup();
  api.failing = true;
  tg.start();
  await settle();
  const first = api.callsOf('getUpdates').length;
  await h.clock.advance(sec(4));
  assert.equal(api.callsOf('getUpdates').length, first); // todavía esperando
  api.failing = false;
  api.text(TG_GROUP, '/estado');
  await h.clock.advance(min(2));
  assert.equal(api.texts.filter((t) => /Estado del bot/.test(t)).length, 1);
  assert.ok(api.callsOf('getUpdates').length <= first + 3);
  tg.stop();
});

// ---------- sin token: avisos por consola ----------
test('sin TELEGRAM_BOT_TOKEN el aviso va por consola y no muestra teléfonos', async () => {
  const h = makeHarness({ shadow: true });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  const lines: string[] = [];
  const n = createConsoleNotifier(h.db, (s) => lines.push(s));
  await n.alert('WhatsApp pide el QR', { urgent: true });
  await n.alert('algo común');
  await n.handoff(CHAT, emptyCard(), [READY]);
  const d = h.notifier.drafts[0];
  await n.draft(d.chatId, d.draftId, d.bubbles, d.material);
  await n.takeover(CHAT);
  const all = lines.join('\n');
  assert.match(lines[0], /^\[aviso\] URGENTE: WhatsApp pide el QR$/);
  assert.match(lines[1], /^\[aviso\] algo común$/);
  assert.match(all, /\[ficha\] Chat #1/);
  assert.match(all, /\[borrador #1\] chat #1/);
  assert.match(all, /Chat #1: alguien del equipo escribió/);
  assert.ok(!all.includes('5491155550000'));
});
