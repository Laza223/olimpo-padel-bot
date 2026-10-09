// Audios del cliente (F2b): se bajan, se convierten y se transcriben en el turno; el modelo ve "(audio) …".
// Canal, bajada, conversor y transcriptor falsos (sin red, sin ffmpeg, sin OpenAI). Las 12 pruebas del "Criterio de listo" llevan su número.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { DEFAULT_TRANSCRIBE_MODEL, FakeTranscriber, FAKE_TRANSCRIPT, OpenAiTranscriber, UNREADABLE_AUDIO_TEXT, createAudio, transcribeCostUsd } from '../src/audio.ts';
import { TransientLlmError, buildInstructions } from '../src/brain.ts';
import { ChannelError, MediaUnreadableError } from '../src/channel/types.ts';
import { buildFicha } from '../src/ficha.ts';
import { MIGRATIONS, botSaid, getConversation, historyFor, listAgentRuns, listAudit, listDrafts, listOutbox, migrate, setMode, spentSince, unansweredMessages } from '../src/db.ts';
import { FAKE_FOLLOWUP } from '../src/fakeLlm.ts';
import { emptyCard } from '../src/lead.ts';
import { supervise } from '../src/supervisor/index.ts';
import { approveDraft } from '../src/outbox.ts';
import { setSetting } from '../src/settings.ts';
import { FALLBACK_TEXT, OPT_OUT_TEXT } from '../src/turn.ts';
import { FIRST_TEXT, ScriptedLlm, policy, turnWith } from './f2-helpers.ts';
import { makeHarness } from './f2-harness.ts';
import type { Harness } from './f2-harness.ts';
import { ASK, ASK_FIRST, ScriptedAudio } from './f2b-audio-helpers.ts';
import { DatabaseSync } from 'node:sqlite';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const ok = () => turnWith([FIRST_TEXT]);
const msgRow = (h: Harness, id: number) => h.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as { text: string; transcript_status: string | null; media_url: string | null; media_mime: string | null; media: string | null };
const quiet = () => makeHarness({ settings: { kill_switch: '1' } });

// ---------- ingest ----------
test('un audio del cliente sin texto se guarda pendiente con el path y el tipo, sube la versión y ya no avisa "el bot todavía no lo lee"', async () => {
  const h = quiet();
  const { path } = h.sayAudio(CHAT);
  await h.clock.advance(0);
  const r = msgRow(h, 1);
  assert.deepEqual([r.text, r.transcript_status, r.media, r.media_url, r.media_mime], ['', 'pendiente', 'audio', path, 'audio/ogg; codecs=opus']);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, 1); // es contenido nuevo
  assert.deepEqual(h.notifier.alerts, []);
  assert.equal(h.channel.downloads.length, 0); // el ingest no baja nada
  assert.equal(unansweredMessages(h.db, CHAT).length, 1); // el pendiente cuenta como sin contestar...
  assert.deepEqual(historyFor(h.db, CHAT), []); // ...pero no se le muestra al modelo
});

test('un audio sin archivo (WAHA no lo bajó, o avisó un error) queda ilegible desde el principio', async () => {
  const h = quiet();
  h.sayAudio(CHAT, { file: null });
  h.sayAudio(CHAT, { file: { mime: 'audio/ogg', error: true } });
  await h.clock.advance(0);
  assert.deepEqual([1, 2].map((id) => [msgRow(h, id).text, msgRow(h, id).transcript_status]), [[UNREADABLE_AUDIO_TEXT, 'ilegible'], [UNREADABLE_AUDIO_TEXT, 'ilegible']]);
  assert.equal(listAudit(h.db, 'error').filter((a) => /audio ilegible: WAHA no mandó el archivo/.test(a.detail)).length, 2);
  assert.deepEqual(h.notifier.alerts, []);
});

test('un audio con texto (algo raro) se trata como un mensaje de texto: no se baja ni se transcribe', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola, mirá este audio', { media: 'audio', mediaFile: { path: '/api/files/x.oga', mime: 'audio/ogg' } });
  await h.clock.advance(sec(10));
  assert.equal(h.channel.downloads.length, 0);
  assert.equal(h.audio.transcribed, 0);
  assert.equal(h.texts().length, 1);
  assert.equal(msgRow(h, 1).transcript_status, null);
});

// ---------- 1. el audio se transcribe y el turno ve "(audio) …" ----------
test('1. el audio se baja, se convierte, se transcribe y el turno lo ve como "(audio) …" con su id; el costo queda en agent_runs y en la conversación', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  const { path } = h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual(h.channel.downloads, [path]);
  assert.deepEqual([h.audio.converted, h.audio.transcribed], [1, 1]);
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].input, /\[m1\]\[cliente 14:00\] \(audio\) quiero una cancha en Pilar/);
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1\n/);
  const r = msgRow(h, 1);
  assert.deepEqual([r.text, r.transcript_status], ['(audio) quiero una cancha en Pilar', 'ok']);
  assert.equal(getConversation(h.db, CHAT)!.contextVersion, 1); // transcribir no sube la versión: es el mismo mensaje
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  const run = listAgentRuns(h.db)[0];
  assert.equal(run.errorKind, null);
  const row = h.db.prepare("SELECT model, cost_usd FROM agent_runs WHERE model = 'gpt-transcribe'").get() as { model: string; cost_usd: number };
  assert.equal(row.model, 'gpt-transcribe');
  assert.ok(Math.abs(row.cost_usd - (12 * 0.0045) / 60) < 1e-12); // 12 s a USD 0,0045 el minuto
  assert.ok(getConversation(h.db, CHAT)!.botSpentUsd >= row.cost_usd);
  assert.deepEqual(h.notifier.alerts, []);
});

test('1. el mp3 convertido es lo que llega al transcriptor, y el costo redondea la duración hacia arriba al segundo', async () => {
  const h = makeHarness();
  const got: number[][] = [];
  h.audio.transcriber.transcribe = async (mp3) => {
    got.push([...mp3]);
    return 'hola';
  };
  h.audio.seconds = 61.2;
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual(got, [[9, 9, 9]]);
  const row = h.db.prepare("SELECT cost_usd FROM agent_runs WHERE model = 'gpt-transcribe'").get() as { cost_usd: number };
  assert.ok(Math.abs(row.cost_usd - (62 * 0.0045) / 60) < 1e-12);
  assert.equal(transcribeCostUsd(h.audio.transcriber, 0.2), 0.0045 / 60); // hasta un instante cuesta el segundo entero
});

// ---------- 2. ráfaga de audio + texto ----------
test('2. una ráfaga de texto + audio + texto corre en un solo turno, con el audio transcripto en su lugar', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(1));
  h.sayAudio(CHAT);
  await h.clock.advance(sec(1));
  h.say(CHAT, 'Soy Pedro');
  await h.clock.advance(sec(10));
  assert.equal(llm.calls.length, 1);
  assert.equal(h.audio.transcribed, 1);
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1, m2, m3\n/);
  assert.match(llm.calls[0].input, /\[m1\].* Hola\n\[m2\].* \(audio\) quiero una cancha en Pilar\n\[m3\].* Soy Pedro/);
  assert.equal(h.texts().length, 1);
});

// ---------- 3. chat en humano, pausado, cerrado o con kill switch: 0 bajadas y 0 transcripciones ----------
test('3. chat en humano, pausado o cerrado: el audio se guarda pero hay 0 bajadas, 0 transcripciones y 0 llamadas; al volver al bot se lee', async () => {
  for (const mode of ['humano', 'pausado', 'cerrado'] as const) {
    const h = makeHarness();
    h.say(CHAT, 'Hola');
    await h.clock.advance(sec(10));
    const calls = h.llmCalls();
    setMode(h.db, CHAT, mode);
    h.sayAudio(CHAT);
    await h.clock.advance(min(5));
    assert.equal(h.channel.downloads.length, 0, mode);
    assert.equal(h.audio.transcribed, 0, mode);
    assert.equal(h.audio.converted, 0, mode);
    assert.equal(h.llmCalls(), calls, mode);
    assert.equal(h.texts().length, 1, mode);
    assert.equal(msgRow(h, 3).transcript_status, 'pendiente', mode); // m1 = Hola, m2 = la respuesta del bot, m3 = el audio
    setMode(h.db, CHAT, 'auto'); // /bot n: lo retoma
    h.worker.onCustomerMessage(CHAT);
    await h.clock.advance(sec(10));
    assert.equal(h.audio.transcribed, 1, mode);
    assert.equal(msgRow(h, 3).transcript_status, 'ok', mode);
  }
});

test('3. kill switch: el audio no se baja ni se transcribe; con /prender se lee y se contesta', async () => {
  const h = makeHarness({ settings: { kill_switch: '1' } });
  h.sayAudio(CHAT);
  await h.clock.advance(min(5));
  assert.deepEqual([h.channel.downloads.length, h.audio.converted, h.audio.transcribed, h.llmCalls(), h.channel.sendCalls], [0, 0, 0, 0, 0]);
  setSetting(h.db, 'kill_switch', '0');
  h.worker.rescan();
  await h.clock.advance(sec(10));
  assert.deepEqual([h.channel.downloads.length, h.audio.transcribed, h.llmCalls()], [1, 1, 1]);
  assert.equal(h.texts().length, 1);
});

test('3. el kill switch o la toma humana mientras se transcribe: no se baja el audio que sigue ni se llama al modelo', async () => {
  const h = makeHarness();
  let gate!: () => void;
  const blocked = new Promise<void>((resolve) => { gate = resolve; });
  h.audio.transcriber.transcribe = async () => {
    await blocked;
    return 'hola';
  };
  h.sayAudio(CHAT);
  h.sayAudio(CHAT);
  await h.clock.advance(sec(3)); // el primero está transcribiendo
  assert.equal(h.channel.downloads.length, 1);
  h.deliver(h.ownEvent(CHAT, 'te contesto yo')); // el equipo escribe desde el celular: toma humana
  await h.clock.advance(sec(1));
  gate();
  await h.clock.advance(sec(20));
  assert.equal(h.channel.downloads.length, 1); // el segundo audio ni se bajó
  assert.equal(h.llmCalls(), 0);
  assert.deepEqual(h.channel.sent, []);
});

// ---------- 4. sin saldo en la transcripción ----------
test('4. el 429 sin saldo en la transcripción reintenta con espera, avisa una vez (urgente, nombrando a OpenAI y la variable) y nunca manda el mensaje seguro', async () => {
  const quota = () => new TransientLlmError('quota', 'insufficient_quota');
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.audio.script = [quota(), quota(), quota(), 'quiero una cancha en Pilar'];
  h.sayAudio(CHAT);
  await h.clock.advance(min(10)); // 2 s, 32 s, 152 s y el 4.º (452 s) contesta
  const sinSaldo = h.notifier.alerts.filter((a) => /sin saldo/.test(a.text));
  assert.equal(sinSaldo.length, 1);
  assert.equal(sinSaldo[0].urgent, true);
  assert.match(sinSaldo[0].text, /^OpenAI sin saldo: el bot no contesta hasta que se cargue/);
  assert.match(sinSaldo[0].text, /OPENAI_API_KEY/);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.ok(!h.texts().includes(FALLBACK_TEXT));
  assert.equal(h.audio.transcribed, 4);
  assert.equal(msgRow(h, 1).transcript_status, 'ok');
  assert.deepEqual(listAgentRuns(h.db).filter((r) => r.errorKind).map((r) => r.errorKind), ['transient:quota', 'transient:quota', 'transient:quota']);
  assert.deepEqual(h.db.prepare("SELECT DISTINCT model FROM agent_runs WHERE error_kind IS NOT NULL").all().map((r) => ({ ...r })), [{ model: 'gpt-transcribe' }]);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(getConversation(h.db, CHAT)!.card.state, 'nuevo'); // un error pasajero no deriva
  assert.equal(h.notifier.alerts.filter((a) => /más de 10 minutos/.test(a.text)).length, 0);
});

test('avisos neutros: sin saldo y clave o modelo rechazados nombran al proveedor que falló y la variable que hay que revisar', async () => {
  const brain = (model: string, kind: 'quota' | 'config') => makeHarness({ config: { model, effort: 'low' }, llm: new ScriptedLlm(() => { throw new TransientLlmError(kind, 'x'); }) });
  const texts = async (h: Harness) => {
    h.say(CHAT, 'Hola');
    await h.clock.advance(min(3));
    return h.notifier.alerts.map((a) => a.text);
  };
  const a = await texts(brain('claude-haiku-5-5', 'quota'));
  assert.match(a[0], /^Anthropic sin saldo: el bot no contesta hasta que se cargue .*ANTHROPIC_API_KEY/);
  assert.ok(!a.some((t) => /OpenAI/.test(t)));
  const b = await texts(brain('claude-haiku-5-5', 'config'));
  assert.match(b[0], /^Anthropic rechazó la clave o el modelo \(revisá ANTHROPIC_API_KEY y BOT_MODEL en el \.env\)/);
  const c = await texts(brain('gpt-6.1-sol', 'config'));
  assert.match(c[0], /^OpenAI rechazó la clave o el modelo \(revisá OPENAI_API_KEY y BOT_MODEL en el \.env\)/);
  const d = await texts(brain('gpt-6.1-sol', 'quota'));
  assert.match(d[0], /^OpenAI sin saldo: .*OPENAI_API_KEY/);
  // La transcripción es siempre OpenAI, aunque el cerebro sea claude-*: sin OPENAI_API_KEY avisa eso, con la variable del modelo de transcripción.
  const h = makeHarness({ config: { model: 'claude-haiku-5-5', effort: 'low' }, llm: new ScriptedLlm(ok) });
  h.audio.script = [new TransientLlmError('config', 'Falta OPENAI_API_KEY')];
  h.sayAudio(CHAT);
  await h.clock.advance(min(3));
  assert.match(h.notifier.alerts[0].text, /^OpenAI rechazó la clave o el modelo \(revisá OPENAI_API_KEY y BOT_TRANSCRIBE_MODEL en el \.env\)/);
  assert.equal(h.notifier.alerts[0].urgent, true);
  assert.deepEqual(h.notifier.alerts.map((a) => a.urgent), [true, false]); // el urgente de la configuración y el de "un audio quedó sin leer" (no urgente)
  assert.equal(h.llmCalls(), 0);
});

test('una falla de red al bajar el audio (WAHA) no lo deja ilegible: avisa una vez, reintenta con espera y al volver se lee', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  const { path } = h.sayAudio(CHAT, { bytes: new ChannelError('transient', undefined, 'no pude bajar el audio de WAHA (estado 503)') });
  await h.clock.advance(min(3)); // fallos a los 2 s y 32 s
  assert.ok(h.channel.downloads.length >= 2);
  assert.equal(h.notifier.alerts.filter((a) => /no pude bajar el audio de WAHA/.test(a.text)).length, 1);
  assert.equal(msgRow(h, 1).transcript_status, 'pendiente');
  assert.deepEqual(h.texts(), []);
  h.channel.files.set(path, new Uint8Array([1, 2, 3]));
  await h.clock.advance(min(10));
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.equal(msgRow(h, 1).transcript_status, 'ok');
});

test('ffmpeg que falta (error de la instalación, no del audio): avisa, reintenta y no manda nada ni deja el audio ilegible', async () => {
  const h = makeHarness();
  h.audio.convertError = new Error('ffmpeg no está instalado en el sistema (o no se puede ejecutar)');
  h.sayAudio(CHAT);
  await h.clock.advance(min(5));
  assert.equal(h.notifier.alerts.filter((a) => /ffmpeg no está instalado/.test(a.text)).length, 1);
  assert.equal(msgRow(h, 1).transcript_status, 'pendiente');
  assert.equal(h.channel.sendCalls, 0);
  assert.equal(h.audio.transcribed, 0);
});

// ---------- 5. ilegible la primera vez ----------
const unreadable: [string, (h: Harness) => void, { downloads: number; transcribed: number }][] = [
  ['el archivo ya venció en WAHA (404)', (h) => void h.sayAudio(CHAT, { bytes: null }), { downloads: 1, transcribed: 0 }],
  ['WAHA no mandó la url', (h) => void h.sayAudio(CHAT, { file: null }), { downloads: 0, transcribed: 0 }],
  ['WAHA avisó un error al bajarlo', (h) => void h.sayAudio(CHAT, { file: { mime: 'audio/ogg', error: true } }), { downloads: 0, transcribed: 0 }],
  ['el tipo no es audio', (h) => void h.sayAudio(CHAT, { file: { path: '/api/files/x.mp4', mime: 'video/mp4' } }), { downloads: 0, transcribed: 0 }],
  ['ffmpeg no lo puede convertir', (h) => { h.audio.convertError = new MediaUnreadableError('ffmpeg no pudo leer el audio'); h.sayAudio(CHAT); }, { downloads: 1, transcribed: 0 }],
  ['dura más que max_audio_seconds', (h) => { h.audio.seconds = 601; h.sayAudio(CHAT); }, { downloads: 1, transcribed: 0 }],
  ['la transcripción sale vacía', (h) => { h.audio.script = ['   ']; h.sayAudio(CHAT); }, { downloads: 1, transcribed: 1 }],
  ['OpenAI no acepta el audio', (h) => { h.audio.script = [new MediaUnreadableError('OpenAI no aceptó el audio (400)')]; h.sayAudio(CHAT); }, { downloads: 1, transcribed: 1 }],
];
for (const [why, setup, expected] of unreadable) {
  test(`5. ilegible la primera vez (${why}): sale el texto aprobado (con el saludo, es el primer mensaje del bot) sin llamar al modelo y el audio queda como contestado`, async () => {
    const h = makeHarness();
    setup(h);
    await h.clock.advance(sec(10));
    assert.deepEqual(h.texts(), [ASK_FIRST]);
    assert.equal(h.llmCalls(), 0);
    assert.deepEqual([h.channel.downloads.length, h.audio.transcribed], [expected.downloads, expected.transcribed]);
    const r = msgRow(h, 1);
    assert.deepEqual([r.text, r.transcript_status], [UNREADABLE_AUDIO_TEXT, 'ilegible']);
    const c = getConversation(h.db, CHAT)!;
    assert.deepEqual([botSaid(h.db, CHAT, ASK), c.mode, c.answeredUpto], [true, 'auto', 1]); // el pedido salió (hay un mensaje del bot con el texto); sigue con el bot; el audio quedó contestado al salir
    assert.deepEqual(h.channel.seen.map((s) => s.chatId), [CHAT]);
    assert.equal(h.notifier.handoffs.length, 0);
    assert.ok(listAudit(h.db, 'error').some((a) => /^audio ilegible/.test(a.detail)));
    assert.ok(!h.notifier.alerts.some((a) => /FFMPEG|ffmpeg|F2b/.test(a.text)));
  });
}

test('5. el texto fijo es el de la política, sin llamar al modelo y pasa el controlador (sin signos de apertura)', () => {
  assert.equal(ASK, 'Perdón, no pude escuchar bien el audio. Me lo escribís por acá?');
  assert.deepEqual(supervise({ bubbles: [ASK], askedIfAi: false }, [], policy.supervisorPolicy), []);
  // Con el saludo y la presentación de la hora delante (primer mensaje del bot) también pasa, a cualquier hora.
  for (const greeting of ['Buen día', 'Buenas tardes', 'Buenas noches']) {
    assert.deepEqual(supervise({ bubbles: [`${greeting}, te escribimos de Olimpo Padel. ${ASK}`], askedIfAi: false }, [], policy.supervisorPolicy), [], greeting);
  }
});

test('5. en modo sombra el texto va como borrador a Telegram y no se le escribe al cliente', async () => {
  const h = makeHarness({ shadow: true });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.deepEqual(h.notifier.drafts.map((d) => d.bubbles), [[ASK_FIRST]]);
  assert.deepEqual(h.channel.sent, []);
  assert.deepEqual(listDrafts(h.db, CHAT).map((d) => d.status), ['pendiente']);
  assert.deepEqual(h.channel.seen, []); // en modo sombra no se marca visto
  assert.equal(h.llmCalls(), 0);
  assert.equal(botSaid(h.db, CHAT, ASK), false); // un borrador no es un pedido: al cliente no le llegó nada
});

test('5. ilegible y con texto en la misma ráfaga: corre el turno normal y el modelo ve "(audio que no se pudo escuchar)"; no sale el pedido de texto', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola, soy Pedro');
  await h.clock.advance(sec(1));
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].input, /\[m2\].* \(audio que no se pudo escuchar\)/);
  assert.deepEqual(h.texts(), [FIRST_TEXT]); // contesta el modelo, no el texto fijo
  assert.equal(botSaid(h.db, CHAT, ASK), false); // al cliente no se le pidió texto: el modelo contestó otra cosa
});

test('5. un reintento del turno (error pasajero del modelo) no cuenta como "segunda vez": no deriva y contesta el modelo', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n === 1) throw new TransientLlmError('network', 'timeout');
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10)); // el 1.er intento falla
  assert.equal(h.notifier.handoffs.length, 0);
  await h.clock.advance(min(2)); // el reintento contesta
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.equal(h.notifier.handoffs.length, 0); // no se tomó como "segunda vez"
});

// ---------- 6. ilegible la segunda vez ----------
test('6. ilegible la segunda vez: derivación audio_ilegible, prioridad normal, modo stop; el chat pasa al equipo con aviso y no se manda nada', async () => {
  const h = makeHarness();
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  h.sayAudio(CHAT, { bytes: null }); // otro audio que tampoco se puede escuchar
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [ASK_FIRST]); // no hay una 2.ª respuesta
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.notifier.handoffs.length, 1);
  assert.deepEqual(h.notifier.handoffs[0].decisions, [{ reason: 'audio_ilegible', priority: 'normal', mode: 'stop' }]);
  const c = getConversation(h.db, CHAT)!;
  assert.equal(c.mode, 'humano');
  assert.equal(c.answeredUpto, 3);
  assert.ok(listAudit(h.db, 'handoff').some((a) => a.chatId === CHAT && /audio_ilegible \(stop, prioridad normal\)/.test(a.detail)));
  // el equipo lo ve con la ficha y puede devolverlo al bot
  const ficha = buildFicha(h.notifier.handoffs[0].card, historyFor(h.db, CHAT), h.notifier.handoffs[0].decisions[0]);
  assert.match(ficha, /NORMAL · Mandó un audio que no se pudo escuchar.*\(el bot dejó de responder\)/);
});

test('6. en modo sombra, con el pedido de texto ya aprobado y mandado, la derivación también pasa el chat al equipo con aviso (no hay borrador)', async () => {
  const h = makeHarness({ shadow: true });
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  assert.equal(approveDraft(h.db, h.notifier.drafts[0].draftId, policy.assets, h.clock.now()), 'enviado'); // [Mandar]: recién ahí el cliente lo recibe
  h.outbox.kick();
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  h.sayAudio(CHAT, { file: null });
  await h.clock.advance(sec(10));
  assert.equal(h.notifier.drafts.length, 1); // solo el del pedido de texto
  assert.deepEqual(h.notifier.handoffs.map((x) => x.decisions[0].reason), ['audio_ilegible']);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
});

test('6. si el cliente escribe el texto después del pedido, el chat sigue con el bot', async () => {
  const h = makeHarness();
  h.sayAudio(CHAT, { bytes: null });
  await h.clock.advance(sec(10));
  h.say(CHAT, 'Quiero una cancha en Pilar');
  await h.clock.advance(sec(10));
  assert.equal(h.llmCalls(), 1);
  assert.equal(h.notifier.handoffs.length, 0);
  assert.deepEqual(h.texts(), [ASK_FIRST, FAKE_FOLLOWUP]); // el modelo ya no saluda: el pedido de texto fue el primer mensaje, con saludo
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
});

// ---------- 7. audio borrado antes de transcribir ----------
test('7. un audio borrado antes de que corra el turno no se baja ni se transcribe, y no abre turno', async () => {
  const h = makeHarness();
  const { id } = h.sayAudio(CHAT);
  await h.clock.advance(sec(1));
  h.deliver({ kind: 'revoke', session: 'default', chatId: CHAT, providerMsgId: id });
  await h.clock.advance(min(5));
  assert.deepEqual([h.channel.downloads.length, h.audio.converted, h.audio.transcribed, h.llmCalls(), h.channel.sendCalls], [0, 0, 0, 0, 0]);
  assert.equal(msgRow(h, 1).transcript_status, 'pendiente'); // quedó como estaba: borrado y sin leer
  assert.deepEqual(unansweredMessages(h.db, CHAT), []);
});

test('7. si borra el 2.º audio mientras se transcribe el 1.º, el 2.º no se transcribe', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  let gate!: () => void;
  const blocked = new Promise<void>((resolve) => { gate = resolve; });
  h.audio.transcriber.transcribe = async () => {
    await blocked;
    return 'hola';
  };
  h.sayAudio(CHAT);
  const second = h.sayAudio(CHAT);
  await h.clock.advance(sec(3)); // transcribiendo el 1.º
  h.deliver({ kind: 'revoke', session: 'default', chatId: CHAT, providerMsgId: second.id });
  await h.clock.advance(sec(1));
  gate();
  await h.clock.advance(sec(20));
  assert.equal(h.channel.downloads.length, 1);
  assert.deepEqual(h.texts(), [FIRST_TEXT]); // se contesta lo que queda
});

test('un audio pendiente más viejo que reply_window_hours no se baja ni se transcribe (consulta vencida): queda atendido sin gastar', async () => {
  const h = quiet();
  h.sayAudio(CHAT);
  await h.clock.advance(0);
  await h.clock.advance(13 * 3_600_000);
  setSetting(h.db, 'kill_switch', '0');
  h.worker.onCustomerMessage(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual([h.channel.downloads.length, h.audio.transcribed, h.llmCalls(), h.channel.sendCalls], [0, 0, 0, 0]);
  assert.ok(listAudit(h.db, 'error').some((a) => /consulta_vencida/.test(a.detail)));
  assert.deepEqual(unansweredMessages(h.db, CHAT), []); // quedó atendido: no se vuelve a listar
});

// ---------- 10. el costo cuenta para el tope del día ----------
test('10. la transcripción cuenta para el tope del día: al pasarse, el chat siguiente se pausa con aviso y no se baja su audio', async () => {
  const h = makeHarness({ settings: { daily_budget_usd: '0.001' } }); // cada audio de 12 s cuesta USD 0,0009
  h.sayAudio('5491100000001@c.us');
  await h.clock.advance(sec(10));
  h.sayAudio('5491100000002@c.us');
  await h.clock.advance(sec(10));
  assert.ok(Math.abs(spentSince(h.db, 0) - 0.0018) < 1e-12);
  const third = h.sayAudio('5491100000003@c.us');
  await h.clock.advance(sec(10));
  assert.equal(getConversation(h.db, '5491100000003@c.us')!.mode, 'pausado');
  assert.equal(getConversation(h.db, '5491100000003@c.us')!.pauseReason, 'budget');
  assert.ok(!h.channel.downloads.includes(third.path));
  assert.equal(h.audio.transcribed, 2);
  assert.equal(h.notifier.alerts.filter((a) => a.urgent && /tope de gasto del día/.test(a.text)).length, 1);
  assert.equal(h.texts('5491100000001@c.us').length, 1);
});

test('10. el tope de la conversación también cuenta el costo de los audios', async () => {
  const h = makeHarness({ settings: { conv_budget_usd: '0.001' } });
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.ok(Math.abs(getConversation(h.db, CHAT)!.botSpentUsd - 0.0018) < 1e-9);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'pausado');
  assert.equal(getConversation(h.db, CHAT)!.pauseReason, 'conv');
  assert.equal(h.audio.transcribed, 2);
});

// ---------- 11. "no me escribas más" por audio ----------
test('11. "no me escribas más" dicho por audio corta igual que por texto: texto de baja, ficha en baja, chat al equipo y sin llamar al modelo', async () => {
  const h = makeHarness();
  h.audio.script = ['No me escribas más, gracias.'];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual(h.texts(), [OPT_OUT_TEXT]);
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.card.state, c.mode], ['baja', 'humano']);
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.audio.transcribed, 1);
});

test('11. las demás reglas que leen el texto del cliente andan solas con el audio: Elite, factura A', async () => {
  const llm = new ScriptedLlm(() => turnWith(['Buenas tardes, te escribimos de Olimpo Padel.', 'No, somos Olimpo Padel, una empresa aparte.']));
  const h = makeHarness({ llm });
  h.audio.script = ['Hola, ¿ustedes son los de Elite Padel?'];
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.deepEqual(h.notifier.handoffs.map((x) => x.decisions.map((d) => d.reason)), [['pregunta_por_empresa_anterior']]);
});

// ---------- el tope de duración se cambia con /set ----------
test('max_audio_seconds: default 600, se cambia con setSetting (/set) y un audio más largo queda ilegible sin transcribirse', async () => {
  const h = makeHarness({ settings: { max_audio_seconds: '30' } });
  h.audio.seconds = 45;
  h.sayAudio(CHAT);
  await h.clock.advance(sec(10));
  assert.equal(h.audio.transcribed, 0);
  assert.deepEqual(h.texts(), [ASK_FIRST]);
  assert.ok(listAudit(h.db, 'error').some((a) => /dura 45 s y el tope es 30 s/.test(a.detail)));
  assert.throws(() => setSetting(h.db, 'max_audio_seconds', 'mucho'), /número/);
  const h2 = makeHarness(); // sin tocar: 600
  h2.audio.seconds = 600;
  h2.sayAudio(CHAT);
  await h2.clock.advance(sec(10));
  assert.equal(h2.audio.transcribed, 1);
});

// ---------- 12. migración V3 ----------
test('12. la migración V3 sobre una base V2 con datos conserva todo, agrega las columnas y es idempotente', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[0]);
  db.exec(MIGRATIONS[1]);
  db.exec('PRAGMA user_version = 2');
  db.prepare("INSERT INTO conversations (chat_id, session, mode, card_json, last_activity_utc, first_seen_utc, pause_reason, paused_utc) VALUES ('c1@c.us', 'default', 'pausado', '{}', 5, 4, 'budget', 6)").run();
  db.prepare("INSERT INTO messages (session, provider_msg_id, chat_id, author, text, ts_utc, media) VALUES ('default', 'false_c1_A', 'c1@c.us', 'customer', 'Hola', 10, NULL), ('default', 'false_c1_B', 'c1@c.us', 'customer', '', 11, 'audio')").run();
  migrate(db);
  migrate(db);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
  assert.deepEqual(db.prepare('SELECT chat_id, mode, pause_reason, paused_utc FROM conversations').all().map((r) => ({ ...r })), [{ chat_id: 'c1@c.us', mode: 'pausado', pause_reason: 'budget', paused_utc: 6 }]);
  assert.ok(!db.prepare('PRAGMA table_info(conversations)').all().some((c) => c.name === 'audio_text_asked')); // "ya se pidió texto" se mide con los mensajes del bot, no con una marca
  assert.deepEqual(db.prepare('SELECT text, media, media_url, media_mime, transcript_status FROM messages ORDER BY id').all().map((r) => ({ ...r })), [
    { text: 'Hola', media: null, media_url: null, media_mime: null, transcript_status: null },
    { text: '', media: 'audio', media_url: null, media_mime: null, transcript_status: null }, // un audio viejo no queda pendiente: nadie lo va a transcribir
  ]);
  assert.throws(() => db.prepare("UPDATE messages SET transcript_status = 'raro' WHERE id = 1").run(), /CHECK/);
  db.prepare("UPDATE messages SET transcript_status = 'pendiente', media_url = '/api/files/x.oga' WHERE id = 2").run(); // y las columnas nuevas andan
});

// ---------- política, prompt y ficha ----------
test('la política trae audio_ilegible.texto con su fuente, y el prompt tiene la línea del "(audio)"', () => {
  assert.match(policy.yamlText, /audio_ilegible:\n  texto: "Perdón, no pude escuchar bien el audio\. Me lo escribís por acá\?"/);
  assert.match(policy.yamlText, /fuente: "Lazar 8-oct"/);
  const instructions = buildInstructions(policy);
  assert.equal(instructions.match(/empieza con "\(audio\)"/g)?.length, 1);
  assert.match(instructions, /sin decir que se transcribió ni citarlo textual/);
  assert.match(instructions, /si algo no se entiende preguntá solo eso puntual/);
});

test('el modelo no puede pedir la derivación audio_ilegible: la decide el código', async () => {
  const { decideHandoffs } = await import('../src/handoff.ts');
  const turn = turnWith(['ok'], { handoff_request: { reason: 'audio_ilegible', priority: 'alta' } });
  assert.deepEqual(decideHandoffs({ before: emptyCard(), after: emptyCard(), turn, customerText: 'hola' }), []);
});

// ---------- el transcriptor de OpenAI ----------
const fakeClient = (create: (p: Record<string, unknown>) => Promise<unknown>) => ({ audio: { transcriptions: { create } } }) as unknown as OpenAI;
const apiError = (status: number, code: string | null) => OpenAI.APIError.generate(status, { error: { message: 'boom', code, type: code } }, 'boom', new Headers());

test('OpenAiTranscriber: manda el mp3 con modelo, español y vocabulario; el modelo por defecto es gpt-transcribe', async () => {
  const calls: Record<string, unknown>[] = [];
  const t = new OpenAiTranscriber({ client: fakeClient(async (p) => { calls.push(p); return { text: ' hola ' }; }) });
  assert.equal(t.model, 'gpt-transcribe');
  assert.equal(DEFAULT_TRANSCRIBE_MODEL, 'gpt-transcribe');
  assert.equal(await t.transcribe(new Uint8Array([1, 2, 3])), ' hola ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'gpt-transcribe');
  // gpt-transcribe: `languages` y `keywords` (la doc dice que `languages` reemplaza a `language` y que no se mandan los dos).
  assert.deepEqual(calls[0].languages, ['es']);
  assert.equal(calls[0].language, undefined);
  assert.equal(calls[0].prompt, undefined);
  const vocab = ['Olimpo Padel', 'pádel', 'Full Panorámica', 'Panorámica', 'platea', 'galpón', 'techada', 'aire libre', 'césped', 'vidrio templado'];
  assert.deepEqual(calls[0].keywords, vocab);
  for (const k of calls[0].keywords as string[]) assert.doesNotMatch(k, /[<>\r\n]/); // la API rechaza el pedido entero con esos caracteres
  const file = calls[0].file as File;
  assert.deepEqual([file.name, file.type, file.size], ['audio.mp3', 'audio/mpeg', 3]);

  // Un modelo anterior (BOT_TRANSCRIBE_MODEL=gpt-4o-transcribe) va con `language` y `prompt`.
  const old: Record<string, unknown>[] = [];
  await new OpenAiTranscriber({ model: 'gpt-4o-transcribe', client: fakeClient(async (p) => { old.push(p); return { text: 'x' }; }) }).transcribe(new Uint8Array([1]));
  assert.equal(old[0].language, 'es');
  assert.equal(old[0].languages, undefined);
  for (const w of vocab) assert.match(String(old[0].prompt), new RegExp(w));
});

test('OpenAiTranscriber: errores con el clasificador del cerebro (red, límite, sin saldo, clave) y un 400 es un audio ilegible', async () => {
  const run = (err: unknown) => new OpenAiTranscriber({ client: fakeClient(async () => { throw err; }) }).transcribe(new Uint8Array([1]));
  for (const [err, kind] of [
    [new OpenAI.APIConnectionError({ message: 'Connection error.' }), 'network'],
    [apiError(500, null), 'network'],
    [apiError(429, 'rate_limit_exceeded'), 'rate'],
    [apiError(429, 'insufficient_quota'), 'quota'],
    [apiError(401, 'invalid_api_key'), 'config'],
    [apiError(404, 'model_not_found'), 'config'],
  ] as const) {
    await assert.rejects(run(err), (e: unknown) => e instanceof TransientLlmError && e.kind === kind, kind);
  }
  await assert.rejects(run(apiError(400, 'invalid_value')), MediaUnreadableError);
  // 400 por el archivo: ilegible. 400 por otro parámetro: el pedido está mal armado, es configuración (aviso al equipo), no se le pide texto al cliente.
  const withParam = (param: string) => OpenAI.APIError.generate(400, { error: { message: 'bad', code: 'invalid_value', type: 'invalid_request_error', param } }, 'bad', new Headers());
  await assert.rejects(run(withParam('file')), MediaUnreadableError);
  await assert.rejects(run(withParam('languages')), (e: unknown) => e instanceof TransientLlmError && e.kind === 'config' && /BOT_TRANSCRIBE_MODEL/.test(e.message));
  await assert.rejects(run(new Error('rarísimo')), /rarísimo/);
});

test('OpenAiTranscriber: sin OPENAI_API_KEY el bot prende igual y el primer audio da un error de configuración que nombra la variable (nunca un valor)', async () => {
  const t = new OpenAiTranscriber({ apiKey: undefined });
  await assert.rejects(t.transcribe(new Uint8Array([1])), (e: unknown) => e instanceof TransientLlmError && e.kind === 'config' && /OPENAI_API_KEY/.test(e.message));
});

test('createAudio (BOT_TRANSCRIBER=openai): BOT_TRANSCRIBE_MODEL manda; con BOT_LLM=fake es un transcriptor falso gratis', async () => {
  const openai = { BOT_TRANSCRIBER: 'openai', OPENAI_API_KEY: 'k' }; // el valor por defecto es local (f2b-whisper.test.ts)
  assert.equal(createAudio(openai, false).transcriber.model, 'gpt-transcribe');
  assert.equal(createAudio({ ...openai, BOT_TRANSCRIBE_MODEL: 'gpt-4o-transcribe' }, false).transcriber.model, 'gpt-4o-transcribe');
  assert.equal(createAudio({ ...openai, BOT_TRANSCRIBE_MODEL: '  ' }, false).transcriber.model, 'gpt-transcribe');
  const fake = createAudio({}, true);
  assert.ok(fake.transcriber instanceof FakeTranscriber);
  assert.equal(await fake.transcriber.transcribe(), '(prueba) quiero una cancha en Pilar');
  assert.equal(FAKE_TRANSCRIPT, '(prueba) quiero una cancha en Pilar');
  assert.equal(transcribeCostUsd(fake.transcriber, 600), 0);
  assert.ok(Math.abs(transcribeCostUsd(new ScriptedAudio().transcriber, 60) - 0.0045) < 1e-12);
});

test('un audio y las colas: un chat esperando su audio no frena a otro (cada chat con su turno)', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.sayAudio('5491100000001@c.us');
  h.say('5491100000002@c.us', 'Hola');
  await h.clock.advance(sec(10));
  assert.equal(h.texts().length, 2);
  assert.equal(listOutbox(h.db).length, 2);
});
