// Ronda de arreglos de F2b (8-oct): "ya se pidió texto" medido sobre lo que le llegó al cliente, un audio que no se puede transcribir no traba el chat,
// avisos por audios ilegibles por causas del sistema, avisos de configuración aparte, topes por audio, baja por audio, saludo del pedido de texto y limpieza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, utimesSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { OpenAiTranscriber, UNREADABLE_AUDIO_TEXT, cleanupTempAudio } from '../src/audio.ts';
import { TransientLlmError } from '../src/brain.ts';
import { ChannelError, MediaUnreadableError } from '../src/channel/types.ts';
import { botSaid, getConversation, insertMessage, listAgentRuns, listAudit, listOutbox, openDb, setTranscript, unansweredMessages } from '../src/db.ts';
import { FAKE_FOLLOWUP } from '../src/fakeLlm.ts';
import { emptyCard } from '../src/lead.ts';
import { createTelegram } from '../src/notify/telegram.ts';
import { approveDraft } from '../src/outbox.ts';
import { openingText } from '../src/policy.ts';
import { getNum, setSetting } from '../src/settings.ts';
import { argentinaTimeToUtcMs } from '../src/time.ts';
import { OPT_OUT_TEXT, runTurn } from '../src/turn.ts';
import { supervise } from '../src/supervisor/index.ts';
import { FIRST_TEXT, ScriptedLlm, T0, policy, turnWith } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import type { Harness } from './f2-harness.ts';
import { ASK, ASK_FIRST } from './f2b-audio-helpers.ts';
import { bootApp } from './f2b-app.ts';
import { FakeTelegram, TG_GROUP, TG_TOKEN } from './f2b-helpers.ts';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const hour = (n: number) => n * 3_600_000;
const ok = () => turnWith([FIRST_TEXT]);
// Un modelo que obedece el contexto: saluda solo si "primer_mensaje_del_bot: sí" (para las pruebas donde contesta más de una vez).
const smart = () => new ScriptedLlm((_n, input) => turnWith([/primer_mensaje_del_bot: sí/.test(input) ? FIRST_TEXT : FAKE_FOLLOWUP]));
const config = () => new TransientLlmError('config', 'model_not_found');
const network = () => new TransientLlmError('network', 'Connection error.');
const msgStatus = (h: Harness, id: number) => (h.db.prepare('SELECT transcript_status AS s FROM messages WHERE id = ?').get(id) as { s: string | null }).s;
// Los avisos de "un audio quedó sin leer": no urgentes, sin la palabra "rechazó la clave".
const unreadableAlerts = (h: Harness) => h.notifier.alerts.filter((a) => /quedó sin leer/.test(a.text));
const configAlerts = (h: Harness) => h.notifier.alerts.filter((a) => /rechazó la clave o el modelo/.test(a.text));

// ---------- H1: "ya se pidió texto" = un mensaje del bot con el texto aprobado ----------
test('H1. el pedido de texto se cancela por un texto nuevo antes de salir: el cliente nunca lo leyó, el chat no deriva y contesta el modelo', async () => {
  const h = makeHarness({ shadow: false });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(2100); // el turno encola el pedido; el enviador está "escribiendo"
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['pendiente']);
  h.say(CHAT, 'Perdón, quiero una cancha techada 20x10 en Pilar'); // el cliente escribe al toque: el pedido queda viejo
  await h.clock.advance(sec(15));
  assert.ok(!h.texts().includes(ASK_FIRST) && !h.texts().includes(ASK), 'el pedido nunca salió');
  assert.equal(botSaid(h.db, CHAT, ASK), false);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(h.notifier.handoffs.length, 0);
  assert.equal(h.llmCalls(), 1); // se contestó el texto
});

test('H1. si el pedido de texto no se pudo mandar (falla de envío), el siguiente audio ilegible lo vuelve a pedir en vez de derivar', async () => {
  const h = makeHarness();
  h.channel.failNextSend(new ChannelError('restricted', 463, 'WhatsApp restringió el envío'));
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(15));
  assert.deepEqual(h.texts(), []);
  assert.deepEqual(listOutbox(h.db).map((r) => r.status), ['fallido']);
  assert.equal(botSaid(h.db, CHAT, ASK), false);
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(15));
  assert.deepEqual(h.texts(), [ASK_FIRST]); // sale el pedido (nadie lo había leído)
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(h.notifier.handoffs.length, 0);
});

test('H1. en modo sombra el borrador sin aprobar no cuenta: el 2.º audio ilegible genera otro borrador; aprobado y mandado, el 3.º deriva', async () => {
  const h = makeHarness({ shadow: true });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.equal(h.notifier.drafts.length, 2); // el 1.º quedó viejo (versión nueva del contexto) y el cliente nunca leyó nada
  assert.equal(h.notifier.handoffs.length, 0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(approveDraft(h.db, h.notifier.drafts[1].draftId, policy.assets, h.clock.now()), 'enviado');
  h.outbox.kick();
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.equal(botSaid(h.db, CHAT, ASK), true); // ahora sí: el eco registró el mensaje del bot
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.deepEqual(h.notifier.handoffs.map((x) => x.decisions[0].reason), ['audio_ilegible']);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
});

test('H1. botSaid: con o sin texto, solo cuentan los mensajes del bot (no los del cliente) y de ese chat', () => {
  const db = openDb(':memory:');
  const add = (chatId: string, author: 'customer' | 'bot', text: string, n: number) => insertMessage(db, { session: 'default', providerMsgId: `p${n}`, chatId, author, text, tsUtcMs: n });
  add('a@c.us', 'customer', ASK, 1); // el cliente repite el texto: no es el bot
  assert.deepEqual([botSaid(db, 'a@c.us'), botSaid(db, 'a@c.us', ASK)], [false, false]);
  add('b@c.us', 'bot', `Buenas tardes, te escribimos de Olimpo Padel. ${ASK}`, 2); // otro chat
  assert.deepEqual([botSaid(db, 'a@c.us'), botSaid(db, 'a@c.us', ASK)], [false, false]);
  add('a@c.us', 'bot', `Buenas tardes, te escribimos de Olimpo Padel. ${ASK}`, 3); // contiene el texto, con el saludo delante
  assert.deepEqual([botSaid(db, 'a@c.us'), botSaid(db, 'a@c.us', ASK), botSaid(db, 'a@c.us', 'otra cosa')], [true, true, false]);
});

// ---------- H2: un audio que no se puede transcribir no traba el chat ----------
test('H2. error de configuración en la transcripción: audio + texto en la misma ráfaga, el texto se contesta en el primer turno y el audio queda ilegible', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  h.audio.script = [config()];
  h.sayAudio(CHAT);
  h.say(CHAT, 'Hola, soy Pedro de Pilar, quiero una cancha techada');
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].input, /\[m1\].* \(audio que no se pudo escuchar\)/);
  assert.equal(h.audio.transcribed, 1); // no se reintentó
  assert.equal(msgStatus(h, 1), 'ilegible');
  assert.equal(configAlerts(h).length, 1);
  assert.equal(configAlerts(h)[0].urgent, true);
  assert.match(configAlerts(h)[0].text, /^OpenAI rechazó la clave o el modelo \(revisá OPENAI_API_KEY y BOT_TRANSCRIBE_MODEL en el \.env\)/);
  assert.ok(listAudit(h.db, 'error').some((a) => /audio ilegible: la transcripción no está bien configurada/.test(a.detail)));
  assert.ok(!listAudit(h.db, 'error').some((a) => /model_not_found/.test(a.detail))); // el texto del error de OpenAI no va a la auditoría
});

test('H2. error de configuración con solo el audio: queda ilegible en el acto, sale el pedido de texto (sin reintentos) y hay 2 avisos, uno urgente y uno no', async () => {
  const h = makeHarness();
  h.audio.script = [config()];
  h.sayAudio(CHAT);
  await h.clock.advance(hour(1));
  assert.equal(h.audio.transcribed, 1);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.deepEqual(h.notifier.alerts.map((a) => a.urgent), [true, false]);
  assert.equal(unreadableAlerts(h).length, 1);
  assert.equal(h.notifier.alerts.filter((a) => /más de 10 minutos/.test(a.text)).length, 0); // no hay espera: no traba nada
  assert.ok(listAgentRuns(h.db).some((r) => r.errorKind === 'transient:config'));
});

test('H2. error de red persistente: se reintenta con espera y al 4.º intento el audio queda ilegible y el turno sigue (sin reintentar más)', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.audio.script = [network()];
  h.sayAudio(CHAT);
  h.say(CHAT, 'Hola, soy Pedro de Pilar, quiero una cancha techada');
  await h.clock.advance(min(6)); // intentos a los 2 s, 32 s y 152 s: fallan y se reintenta
  assert.equal(h.audio.transcribed, 3);
  assert.deepEqual(h.texts(), []);
  assert.equal(msgStatus(h, 1), 'pendiente');
  assert.equal(unreadableAlerts(h).length, 0);
  await h.clock.advance(min(2)); // el 4.º (452 s) también falla: se rinde
  assert.equal(h.audio.transcribed, 4);
  assert.equal(msgStatus(h, 1), 'ilegible');
  assert.deepEqual(h.texts(), [FIRST_TEXT]); // el texto se contesta
  assert.equal(unreadableAlerts(h).length, 1);
  assert.match(unreadableAlerts(h)[0].text, /OpenAI falló varias veces seguidas al transcribirlo/);
  assert.equal(unreadableAlerts(h)[0].urgent, false);
  await h.clock.advance(hour(2));
  assert.equal(h.audio.transcribed, 4); // no hay más intentos
});

test('H2. error pasajero persistente con el audio solo: al 4.º intento sale el pedido de texto, nunca el mensaje seguro', async () => {
  const h = makeHarness();
  h.audio.script = [network()];
  h.sayAudio(CHAT);
  await h.clock.advance(min(10));
  assert.equal(h.audio.transcribed, 4);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.equal(h.llmCalls(), 0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(h.notifier.handoffs.length, 0);
});

test('H2. el contador es por audio y se borra al resolverse: un audio que se transcribe a la 3.ª no queda ilegible, y el siguiente empieza de cero', async () => {
  const h = makeHarness({ llm: smart() });
  h.audio.script = [network(), network(), 'quiero una cancha en Pilar', network(), network(), 'otra cosa'];
  h.sayAudio(CHAT);
  await h.clock.advance(min(5));
  assert.equal(msgStatus(h, 1), 'ok');
  h.sayAudio(CHAT);
  await h.clock.advance(min(10));
  assert.equal(msgStatus(h, h.db.prepare("SELECT MAX(id) AS id FROM messages WHERE author = 'customer'").get()!.id as number), 'ok');
  assert.equal(unreadableAlerts(h).length, 0);
});

test('H2. si el cerebro también falla (mismo OpenAI sin saldo), el turno se reintenta como siempre: sin mensaje seguro y se contesta al volver', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n <= 2) throw new TransientLlmError('quota', 'insufficient_quota');
    return ok();
  });
  const h = makeHarness({ llm });
  h.audio.script = [new TransientLlmError('quota', 'insufficient_quota')];
  h.sayAudio(CHAT);
  h.say(CHAT, 'Hola, soy Pedro de Pilar, quiero una cancha techada');
  await h.clock.advance(hour(1));
  assert.equal(msgStatus(h, 1), 'ilegible'); // la transcripción se rindió...
  assert.deepEqual(h.texts(), [FIRST_TEXT]); // ...y el texto se contestó cuando el cerebro volvió
  assert.equal(llm.calls.length, 3);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(h.notifier.alerts.filter((a) => /sin saldo/.test(a.text) && a.urgent).length, 2); // una por el cerebro y otra por la transcripción: avisos separados
});

// ---------- H3: aviso por audios ilegibles por causas del sistema ----------
test('H3. un rechazo de OpenAI (400/413/415/422) o una falla de ffmpeg avisa sin urgencia, con la causa en criollo, y como mucho una vez por hora en total', async () => {
  const h = makeHarness();
  h.audio.script = [new MediaUnreadableError('OpenAI no aceptó el audio (400)', 'rechazo')];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.equal(unreadableAlerts(h).length, 1);
  assert.equal(unreadableAlerts(h)[0].urgent, false);
  assert.match(unreadableAlerts(h)[0].text, /^Chat #1: un audio del cliente quedó sin leer \(OpenAI no aceptó el archivo\)\. Si se repite, hay que mirar los audios\.$/);

  const other = '5491100000002@c.us';
  h.audio.convertError = new MediaUnreadableError('ffmpeg no pudo leer el audio', 'ffmpeg');
  h.sayAudio(other);
  await h.clock.advance(min(30)); // pasan 30 min: todavía no toca otro aviso
  assert.equal(unreadableAlerts(h).length, 1);

  await h.clock.advance(min(31)); // ya pasó la hora desde el primero
  const third = '5491100000003@c.us';
  h.sayAudio(third);
  await h.clock.advance(sec(10));
  assert.equal(unreadableAlerts(h).length, 2);
  assert.match(unreadableAlerts(h)[1].text, /^Chat #3: .*\(falló ffmpeg al convertirlo\)/);
});

test('H3. sin aviso cuando el audio es el problema: vencido, sin url, demasiado largo, no es audio o transcripción vacía', async () => {
  const cases: [string, (h: Harness) => void][] = [
    ['vencido (404)', (h) => void h.sayAudio(CHAT, { bytes: null })],
    ['sin url', (h) => void h.sayAudio(CHAT, { file: null })],
    ['demasiado largo', (h) => { h.audio.seconds = 601; h.sayAudio(CHAT); }],
    ['no es audio', (h) => void h.sayAudio(CHAT, { file: { path: '/api/files/x.mp4', mime: 'video/mp4' } })],
    ['transcripción vacía', (h) => { h.audio.script = ['  ']; h.sayAudio(CHAT); }],
    ['más de 16 MB', (h) => { h.channel.files.set('/api/files/big.oga', new MediaUnreadableError('el archivo pasa de 16 MB')); h.sayAudio(CHAT, { file: { path: '/api/files/big.oga', mime: 'audio/ogg' } }); }],
  ];
  for (const [why, setup] of cases) {
    const h = makeHarness();
    setup(h);
    await h.clock.advance(sec(10));
    assert.deepEqual(h.texts(), [ASK_FIRST], why);
    assert.deepEqual(h.notifier.alerts, [], why);
  }
});

test('H3. las causas de sistema salen marcadas desde el transcriptor: el rechazo de OpenAI (400/413/415/422 por el archivo) es "rechazo"; un error de red no es un audio ilegible', async () => {
  const run = (status: number) => new OpenAiTranscriber({ client: { audio: { transcriptions: { create: async () => { throw OpenAI.APIError.generate(status, { error: { message: 'x', code: null, type: null } }, 'x', new Headers()); } } } } as unknown as OpenAI }).transcribe(new Uint8Array([1]));
  for (const status of [400, 413, 415, 422]) await assert.rejects(run(status), (e: unknown) => e instanceof MediaUnreadableError && e.kind === 'rechazo', String(status));
  await assert.rejects(run(500), (e: unknown) => e instanceof TransientLlmError && e.kind === 'network');
});

// ---------- H4: el aviso de configuración de la transcripción es aparte del del cerebro ----------
test('H4. un turno exitoso del cerebro no rearma el aviso de configuración de la transcripción: sale una sola vez por caída', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.audio.script = [config(), config(), config(), config(), config(), config(), config()];
  for (let i = 0; i < 4; i++) {
    h.sayAudio(`54911000000${i}0@c.us`); // cada audio falla por configuración
    await h.clock.advance(sec(10));
    h.say(`54911000001${i}0@c.us`, 'Hola'); // y entre uno y otro, el cerebro contesta bien
    await h.clock.advance(sec(10));
  }
  assert.equal(h.llmCalls(), 4);
  assert.equal(configAlerts(h).length, 1);
});

test('H4. una transcripción exitosa rearma el aviso de configuración: si vuelve a fallar, avisa de nuevo', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.audio.script = [config(), 'hola, quiero una cancha', config()];
  for (const n of [1, 2, 3]) {
    h.sayAudio(`5491100000${n}00@c.us`);
    await h.clock.advance(sec(10));
  }
  assert.equal(h.audio.transcribed, 3);
  assert.equal(configAlerts(h).length, 2); // la 1.ª y la 3.ª; la 2.ª transcribió bien
});

test('H4. los avisos del cerebro y de la transcripción son independientes: los dos salen, cada uno con su variable', async () => {
  const llm = new ScriptedLlm(() => { throw config(); });
  const h = makeHarness({ llm });
  h.audio.script = [config()];
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10)); // el cerebro rechaza la clave
  h.sayAudio('5491100000002@c.us');
  await h.clock.advance(sec(10)); // y también la transcripción
  const texts = configAlerts(h).map((a) => a.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /BOT_MODEL/);
  assert.match(texts[1], /BOT_TRANSCRIBE_MODEL/);
});

// ---------- H5: los topes se revalidan antes de cada audio de la ráfaga ----------
test('H5. 8 audios de 600 s con conv_budget 0,05: se transcriben solo los que entran, el chat se pausa por el tope de la conversación y el resto queda pendiente', async () => {
  const h = makeHarness({ settings: { conv_budget_usd: '0.05' } });
  h.audio.seconds = 600; // USD 0,045 cada uno
  for (let i = 0; i < 8; i++) h.sayAudio(CHAT);
  await h.clock.advance(sec(15));
  assert.equal(h.audio.transcribed, 2);
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.mode, c.pauseReason], ['pausado', 'conv']);
  assert.equal(unansweredMessages(h.db, CHAT).filter((m) => m.transcriptStatus === 'pendiente').length, 6);
  assert.equal(h.notifier.alerts.filter((a) => /tope de gasto por conversación/.test(a.text)).length, 1);
  assert.equal(h.llmCalls(), 0);
  assert.deepEqual(h.texts(), []);
});

test('H5. el tope de gasto del día también corta en medio de la ráfaga: pausa con el aviso urgente de siempre, una vez', async () => {
  const h = makeHarness({ settings: { daily_budget_usd: '0.05' } });
  h.audio.seconds = 600;
  for (let i = 0; i < 5; i++) h.sayAudio(CHAT);
  await h.clock.advance(sec(15));
  assert.equal(h.audio.transcribed, 2);
  assert.deepEqual([getConversation(h.db, CHAT)!.mode, getConversation(h.db, CHAT)!.pauseReason], ['pausado', 'budget']);
  assert.equal(h.notifier.alerts.filter((a) => a.urgent && /tope de gasto del día/.test(a.text)).length, 1);
});

// ---------- H6: el prefijo "(audio) " no esconde la baja ----------
test('H6. "(audio) Baja." corta sin llamar al modelo, igual que "Baja" por texto; el prefijo tampoco cuenta para el tope de largo', async () => {
  const run = async (...texts: string[]) => {
    const llm = new ScriptedLlm(ok);
    const history = texts.map((text, i) => ({ id: `m${i + 1}`, author: 'customer' as const, text, tsUtcMs: T0 }));
    const r = await runTurn({ conversationId: 'c', history, newCustomerMessageIds: history.map((m) => m.id), card: emptyCard(), nowUtcMs: T0 }, { llm, policy, config: { model: 'gpt-6.1-sol', effort: 'low' } });
    return { calls: llm.calls.length, optOut: r.bubbles[0] === OPT_OUT_TEXT, state: r.card.state };
  };
  assert.deepEqual(await run('Baja'), { calls: 0, optOut: true, state: 'baja' });
  assert.deepEqual(await run('(audio) Baja.'), { calls: 0, optOut: true, state: 'baja' });
  const long = `no me escribas más${' gracias'.repeat(7)}`; // 74 caracteres: entra en el tope de 80 sin el prefijo y no con él
  assert.equal(long.length, 74);
  assert.deepEqual(await run(long), { calls: 0, optOut: true, state: 'baja' });
  assert.deepEqual(await run(`(audio) ${long}`), { calls: 0, optOut: true, state: 'baja' });
  // "baja" como adjetivo por audio sigue sin cortar (lo decide el modelo), y un mensaje largo por audio tampoco.
  assert.equal((await run('(audio) Es una cancha baja de precio, ¿no?')).optOut, false);
  assert.equal((await run(`(audio) ${'no me escribas más '.repeat(6)}`)).optOut, false);
});

test('H6. de punta a punta: un audio que dice "baja" corta el chat', async () => {
  const h = makeHarness();
  h.audio.script = ['Baja.'];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [OPT_OUT_TEXT]);
  assert.deepEqual([getConversation(h.db, CHAT)!.card.state, h.llmCalls()], ['baja', 0]);
});

// ---------- saludo: el pedido de texto como primer mensaje del bot ----------
test('saludo. si el pedido de texto es el primer mensaje del bot va con el saludo y la presentación de la hora, y pasa el controlador', async () => {
  const cases: [string, string][] = [['08:00', 'Buen día'], ['14:00', 'Buenas tardes'], ['21:00', 'Buenas noches']];
  for (const [hhmm, greeting] of cases) {
    const h = makeHarness();
    h.clock.t = argentinaTimeToUtcMs(hhmm, T0) + hour(24);
    h.sayAudio(CHAT, { bytes: null });
    await h.clock.advance(sec(10));
    const expected = `${greeting}, te escribimos de Olimpo Padel. ${ASK}`;
    assert.deepEqual(h.texts(), [expected], hhmm);
    assert.deepEqual(supervise({ bubbles: [expected], askedIfAi: false }, [], policy.supervisorPolicy), [], hhmm);
    assert.equal(h.llmCalls(), 0);
  }
});

test('saludo. con el primer mensaje del cliente = audio ilegible, el turno siguiente del modelo no saluda ni cae al mensaje seguro', async () => {
  const llm = smart();
  const h = makeHarness({ llm });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  h.say(CHAT, 'Hola, soy Pedro de Pilar');
  await h.clock.advance(min(1));
  assert.deepEqual(h.texts(), [ASK_FIRST, FAKE_FOLLOWUP]);
  assert.match(llm.calls[0].input, /primer_mensaje_del_bot: no/);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(listAgentRuns(h.db).map((r) => r.usedFallback), [false]);
  assert.equal(h.notifier.handoffs.length, 0);
});

test('saludo. si el bot ya habló antes, el pedido de texto va solo (sin saludo repetido)', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [FIRST_TEXT, ASK]);
});

test('saludo. en modo sombra el borrador lleva el saludo; openingText no inventa nada si la política no tiene primer mensaje o no tiene una frase que cierre con punto', () => {
  assert.equal(openingText(policy, T0), 'Buenas tardes, te escribimos de Olimpo Padel.');
  const withMessage = (primerMensaje: string) => ({ ...policy, greetingRules: { ...policy.greetingRules, primerMensaje } });
  assert.equal(openingText(withMessage(''), T0), undefined);
  assert.equal(openingText(withMessage('{saludo}, escribinos'), T0), undefined);
  assert.equal(openingText(withMessage('{saludo}! Somos Olimpo. Contame'), T0), 'Buenas tardes! Somos Olimpo.');
});

test('saludo. modo sombra: el borrador del primer pedido ya lleva el saludo', async () => {
  const h = makeHarness({ shadow: true });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.deepEqual(h.notifier.drafts.map((d) => d.bubbles), [[ASK_FIRST]]);
});

// ---------- H7: pruebas que faltaban ----------
test('H7. llega un segundo audio mientras se transcribe el primero: el turno no sigue con uno sin leer, espera, transcribe los dos y contesta una sola vez con los dos', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  let gate!: () => void;
  const blocked = new Promise<void>((resolve) => { gate = resolve; });
  let n = 0;
  h.audio.transcriber.transcribe = async () => {
    n++;
    if (n === 1) await blocked; // el 1.º queda transcribiendo
    return n === 1 ? 'primer audio' : 'segundo audio';
  };
  h.sayAudio(CHAT);
  await h.clock.advance(sec(3)); // vence la ráfaga: el turno está transcribiendo el 1.º
  assert.equal(n, 1);
  h.sayAudio(CHAT); // llega otro mientras tanto: sube la versión y arma su propia ráfaga
  await h.clock.advance(sec(3)); // esa ráfaga vence con el turno todavía corriendo
  gate();
  await h.clock.advance(sec(20));
  assert.equal(n, 2); // el 2.º se transcribió
  assert.equal(llm.calls.length, 1); // un solo turno con el modelo...
  assert.match(llm.calls[0].input, /\[m1\].* \(audio\) primer audio\n\[m2\].* \(audio\) segundo audio/); // ...que ve los dos
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1, m2\n/);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.deepEqual([msgStatus(h, 1), msgStatus(h, 2)], ['ok', 'ok']);
  assert.equal(getConversation(h.db, CHAT)!.answeredUpto, 2);
});

test('H7. setTranscript solo escribe si el estado es pendiente: un audio ya transcripto, ilegible o que no es audio no se pisa', () => {
  const db = openDb(':memory:');
  const add = (n: number, transcriptStatus?: 'pendiente' | 'ok' | 'ilegible') =>
    insertMessage(db, { session: 'default', providerMsgId: `p${n}`, chatId: CHAT, author: 'customer', text: transcriptStatus === 'pendiente' ? '' : `texto ${n}`, tsUtcMs: n, transcriptStatus }).id;
  const [pending, done, unreadable, plain] = [add(1, 'pendiente'), add(2, 'ok'), add(3, 'ilegible'), add(4)];
  for (const id of [pending, done, unreadable, plain]) setTranscript(db, id, '(audio) nuevo', 'ok');
  const rows = db.prepare('SELECT id, text, transcript_status AS s FROM messages ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: pending, text: '(audio) nuevo', s: 'ok' },
    { id: done, text: 'texto 2', s: 'ok' },
    { id: unreadable, text: 'texto 3', s: 'ilegible' },
    { id: plain, text: 'texto 4', s: null },
  ]);
  setTranscript(db, pending, UNREADABLE_AUDIO_TEXT, 'ilegible'); // ya no está pendiente: no cambia
  assert.deepEqual({ ...db.prepare('SELECT text, transcript_status AS s FROM messages WHERE id = ?').get(pending) }, { text: '(audio) nuevo', s: 'ok' });
});

// ---------- H8: max_audio_seconds y temporales ----------
test('H8. /set max_audio_seconds rechaza valores menores a 10 (por Telegram y por setSetting) y acepta 10 o más', async () => {
  const h = makeHarness();
  assert.throws(() => setSetting(h.db, 'max_audio_seconds', '9'), /max_audio_seconds tiene que ser 10 o más/);
  assert.throws(() => setSetting(h.db, 'max_audio_seconds', '0'), /10 o más/);
  assert.equal(getNum(h.db, 'max_audio_seconds'), 600);
  setSetting(h.db, 'max_audio_seconds', '10');
  assert.equal(getNum(h.db, 'max_audio_seconds'), 10);
  setSetting(h.db, 'max_audio_seconds', '900');
  assert.equal(getNum(h.db, 'max_audio_seconds'), 900);

  const api = new FakeTelegram();
  const session = { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array([1]), mimetype: 'image/png' }) };
  const tg = createTelegram({ db: h.db, clock: h.clock, token: TG_TOKEN, groupId: TG_GROUP, fetch: api.fetch, assets: policy.assets, controls: () => ({ worker: h.worker, kickOutbox: () => h.outbox.kick(), session }) });
  api.text(TG_GROUP, '/set max_audio_seconds 5');
  await tg.pollOnce();
  assert.match(api.texts.at(-1)!, /max_audio_seconds tiene que ser 10 o más/);
  assert.equal(getNum(h.db, 'max_audio_seconds'), 900);
  api.text(TG_GROUP, '/set max_audio_seconds 120');
  await tg.pollOnce();
  assert.match(api.texts.at(-1)!, /Listo: max_audio_seconds = 120/);
  assert.equal(getNum(h.db, 'max_audio_seconds'), 120);
});

test('H8. cleanupTempAudio borra los olimpo-audio-* de más de 10 minutos y deja los recientes y los que no son suyos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-test-clean-'));
  try {
    const touch = (name: string, ageMs: number) => {
      const f = join(dir, name);
      writeFileSync(f, 'x');
      const t = new Date(Date.now() - ageMs);
      utimesSync(f, t, t);
    };
    touch('olimpo-audio-vieja.in', min(11));
    touch('olimpo-audio-vieja.mp3', hour(5));
    touch('olimpo-audio-reciente.in', min(9));
    touch('olimpo-audio-ahora.mp3', 0);
    touch('otro-archivo-viejo.in', hour(5));
    assert.equal(await cleanupTempAudio(dir), 2);
    assert.deepEqual(readdirSync(dir).sort(), ['olimpo-audio-ahora.mp3', 'olimpo-audio-reciente.in', 'otro-archivo-viejo.in']);
    assert.equal(await cleanupTempAudio(join(dir, 'no-existe')), 0); // sin directorio: no tira
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H8. al arrancar la app se limpian los olimpo-audio-* viejos del directorio temporal del sistema', async () => {
  const old = join(tmpdir(), `olimpo-audio-${randomUUID()}.in`);
  const fresh = join(tmpdir(), `olimpo-audio-${randomUUID()}.mp3`);
  try {
    for (const f of [old, fresh]) writeFileSync(f, 'x');
    const t = new Date(Date.now() - min(11));
    utimesSync(old, t, t);
    await bootApp();
    for (let i = 0; i < 50 && existsSync(old); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
  } finally {
    rmSync(old, { force: true });
    rmSync(fresh, { force: true });
  }
});
