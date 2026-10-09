// Worker: ráfagas, filtros antes de gastar, turno con versión de contexto, errores pasajeros con espera, modo sombra, ficha y derivaciones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmOutputError, TransientLlmError } from '../src/brain.ts';
import { ChannelError } from '../src/channel/types.ts';
import { addSpend, getConversation, listAgentRuns, listAudit, listDrafts, listOutbox, saveCard, setMode } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { setSetting } from '../src/settings.ts';
import { FALLBACK_TEXT, OPT_OUT_TEXT } from '../src/turn.ts';
import { FIRST_TEXT, ScriptedLlm, T0, deferred, policy, turnWith } from './f2-helpers.ts';
import type { Harness } from './f2-harness.ts';
import { makeHarness } from './f2-harness.ts';
import { FAKE_FOLLOWUP } from '../src/fakeLlm.ts';

const CHAT = '5491155550000@c.us';
const sec = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;
const ok = () => turnWith([FIRST_TEXT]);

// ---------- ráfagas ----------
test('ráfaga: el turno corre 2 s después del último mensaje del cliente', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(1));
  h.say(CHAT, 'Soy Pedro');
  await h.clock.advance(sec(0.9));
  h.say(CHAT, 'Quiero una cancha');
  await h.clock.advance(sec(1.999));
  assert.equal(h.llmCalls(), 0);
  await h.clock.advance(1);
  assert.equal(h.llmCalls(), 1);
});

test('ráfaga: los 3 mensajes entran en un solo turno con sus ids', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(1));
  h.say(CHAT, 'Soy Pedro');
  await h.clock.advance(sec(1));
  h.say(CHAT, 'Quiero una cancha');
  await h.clock.advance(sec(5));
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1, m2, m3/);
  assert.match(llm.calls[0].input, /\[m3\]\[cliente 14:00\] Quiero una cancha/);
});

test('ráfaga: a los 8 s del primer mensaje corre el turno aunque el cliente siga escribiendo', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm });
  for (let i = 0; i < 6; i++) {
    h.say(CHAT, `mensaje ${i}`);
    if (i < 5) await h.clock.advance(sec(1.5));
  } // mensajes en 0, 1.5, 3, 4.5, 6 y 7.5 s
  assert.equal(llm.calls.length, 0);
  await h.clock.advance(sec(0.5)); // 8 s desde el primero
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1, m2, m3, m4, m5, m6\n/);
  await h.clock.advance(sec(1));
  for (let i = 6; i < 9; i++) {
    h.say(CHAT, `mensaje ${i}`);
    await h.clock.advance(sec(1.5));
  }
  await h.clock.advance(sec(10));
  assert.equal(llm.calls.length, 2); // la segunda ráfaga, aparte
});

test('concurrencia: un turno por chat a la vez y como mucho 4 llamadas a OpenAI en total', async () => {
  const gate = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const llm = new ScriptedLlm(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate.promise;
    inFlight--;
    return ok();
  });
  const h = makeHarness({ llm });
  for (let i = 0; i < 7; i++) h.say(`54911000000${i}@c.us`, 'Hola');
  await h.clock.advance(sec(3));
  assert.equal(llm.calls.length, 4); // los otros 3 esperan lugar
  assert.equal(maxInFlight, 4);
  gate.resolve();
  await h.clock.advance(sec(60));
  assert.equal(llm.calls.length, 7);
  assert.equal(maxInFlight, 4);
});

// ---------- filtros antes de gastar ----------
const silent = async (h: Harness, chat = CHAT) => {
  h.say(chat, 'Hola, quiero una cancha');
  await h.clock.advance(min(5));
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.channel.sendCalls, 0);
};

test('filtro: kill switch → cero llamadas a OpenAI y no se manda nada', async () => {
  await silent(makeHarness({ settings: { kill_switch: '1' } }));
});

test('filtro: chat en humano, pausado o cerrado → cero llamadas', async () => {
  for (const mode of ['humano', 'pausado', 'cerrado'] as const) {
    const h = makeHarness();
    h.say(CHAT, 'Hola'); // crea el chat en auto: se contesta
    await h.clock.advance(sec(10));
    const calls = h.llmCalls();
    setMode(h.db, CHAT, mode);
    h.say(CHAT, 'otra cosa');
    await h.clock.advance(min(5));
    assert.equal(h.llmCalls(), calls, mode);
    assert.equal(h.texts().length, 1, mode);
  }
});

test('filtro: ficha en estado terminal (baja, no es cliente, derivado, descartado) → cero llamadas', async () => {
  for (const state of ['baja', 'no_es_cliente', 'derivado', 'descartado'] as const) {
    const h = makeHarness({ settings: { kill_switch: '1' } });
    h.say(CHAT, 'Hola');
    await h.clock.advance(sec(5));
    saveCard(h.db, CHAT, { ...emptyCard(), state });
    setSetting(h.db, 'kill_switch', '0');
    h.say(CHAT, 'Hola de nuevo');
    await h.clock.advance(min(5));
    assert.equal(h.llmCalls(), 0, state);
    assert.equal(h.channel.sendCalls, 0, state);
  }
});

test('filtro: sesión de WhatsApp que no está WORKING → no se llama a OpenAI; cuando vuelve, se contesta una sola vez (sin mensaje seguro)', async () => {
  const h = makeHarness();
  h.channel.status = 'SCAN_QR_CODE';
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(3));
  assert.equal(h.llmCalls(), 0);
  h.channel.status = 'WORKING';
  await h.clock.advance(min(20));
  assert.equal(h.llmCalls(), 1);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  const err = makeHarness(); // y si ni siquiera se puede preguntar el estado, es lo mismo
  err.channel.sessionError = new ChannelError('uncertain', 500, 'WAHA caído');
  err.say(CHAT, 'Hola');
  await err.clock.advance(min(3));
  assert.equal(err.llmCalls(), 0);
});

test('filtro: presupuesto del día agotado → el chat queda pausado, con aviso (una vez por día), y no se llama a OpenAI', async () => {
  const llm = new ScriptedLlm(ok);
  const h = makeHarness({ llm, settings: { daily_budget_usd: '0.003' } });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10)); // el primer turno gasta USD 0,0041
  assert.equal(llm.calls.length, 1);
  h.say('5491100000001@c.us', 'Hola');
  h.say('5491100000002@c.us', 'Hola');
  await h.clock.advance(min(5));
  assert.equal(llm.calls.length, 1);
  assert.equal(getConversation(h.db, '5491100000001@c.us')!.mode, 'pausado');
  assert.equal(getConversation(h.db, '5491100000002@c.us')!.mode, 'pausado');
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.equal(h.notifier.alerts.filter((a) => /tope de gasto del día/.test(a.text)).length, 1);
});

test('filtro: presupuesto de la conversación agotado → pausada con aviso', async () => {
  const h = makeHarness({ settings: { conv_budget_usd: '0.25' } });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  addSpend(h.db, CHAT, 0.3);
  const calls = h.llmCalls();
  h.say(CHAT, 'Y otra cosa');
  await h.clock.advance(min(5));
  assert.equal(h.llmCalls(), calls);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'pausado');
  assert.ok(h.notifier.alerts.some((a) => /#1.*gasto por conversación/.test(a.text)));
});

test('filtro: tope de chats nuevos del día → el chat que se pasa queda pausado con aviso; los ya admitidos siguen', async () => {
  const h = makeHarness({ settings: { max_new_chats_per_day: '2' } });
  h.say('5491100000001@c.us', 'Hola');
  h.say('5491100000002@c.us', 'Hola');
  await h.clock.advance(sec(10));
  h.say('5491100000003@c.us', 'Hola');
  await h.clock.advance(sec(10));
  assert.equal(getConversation(h.db, '5491100000003@c.us')!.mode, 'pausado');
  assert.equal(h.llmCalls(), 2);
  assert.ok(h.notifier.alerts.some((a) => /tope de chats nuevos.*#3/.test(a.text)));
  h.say('5491100000001@c.us', 'Sigo yo'); // ya admitido hoy: sigue
  await h.clock.advance(sec(10));
  assert.equal(h.llmCalls(), 3);
  h.clock.t += 24 * 3_600_000; // al día siguiente se admite otro
  setMode(h.db, '5491100000003@c.us', 'auto');
  h.say('5491100000003@c.us', 'Hola otra vez');
  await h.clock.advance(sec(10));
  assert.equal(h.llmCalls(), 4);
});

// ---------- información nueva mientras el modelo piensa ----------
test('lo que el modelo contestó con contexto viejo no se manda: se descarta y se vuelve a pensar con todo', async () => {
  const gate = deferred();
  const llm = new ScriptedLlm(async (n) => {
    if (n === 1) {
      await gate.promise;
      return turnWith(['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?']); // respuesta vieja
    }
    return turnWith(['Buenas tardes, te escribimos de Olimpo Padel. De qué se trata tu proyecto?']);
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(3)); // el turno 1 está pensando
  assert.equal(llm.calls.length, 1);
  h.say(CHAT, 'Ah, te aviso que somos de Córdoba');
  await h.clock.advance(sec(1));
  gate.resolve(); // termina el turno viejo
  await h.clock.advance(sec(30));
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].input, /mensajes_nuevos_del_cliente: m1, m2/);
  assert.deepEqual(h.texts(), ['Buenas tardes, te escribimos de Olimpo Padel. De qué se trata tu proyecto?']); // solo la nueva
  assert.deepEqual(listAgentRuns(h.db).map((r) => r.errorKind), ['descartado', null]);
});

test('toma humana mientras el modelo piensa: el resultado se descarta, no se manda nada y no se vuelve a pensar', async () => {
  const gate = deferred();
  const llm = new ScriptedLlm(async () => {
    await gate.promise;
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(3));
  h.deliver(h.ownEvent(CHAT, 'Hola, te contesto yo'));
  await h.clock.advance(sec(1));
  gate.resolve();
  await h.clock.advance(min(5));
  assert.equal(llm.calls.length, 1);
  assert.equal(h.channel.sendCalls, 0);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.deepEqual(listOutbox(h.db), []);
});

test('kill switch mientras el modelo piensa: no se manda y no se vuelve a programar', async () => {
  const gate = deferred();
  const llm = new ScriptedLlm(async () => {
    await gate.promise;
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(3));
  setSetting(h.db, 'kill_switch', '1');
  gate.resolve();
  await h.clock.advance(min(5));
  assert.equal(h.channel.sendCalls, 0);
  assert.equal(llm.calls.length, 1);
});

test('el mismo contexto no se contesta dos veces: otro disparo sin mensajes nuevos no llama al modelo', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  assert.equal(h.llmCalls(), 1);
  h.worker.onCustomerMessage(CHAT);
  h.worker.onCustomerMessage(CHAT);
  await h.clock.advance(sec(10));
  assert.equal(h.llmCalls(), 1);
  assert.equal(h.texts().length, 1);
});

// ---------- errores pasajeros de OpenAI ----------
test('OpenAI caído: reintenta a los 30 s, 2 min, 5 min, 15 min y después cada 15 min; contesta una vez al volver; nunca el mensaje seguro', async () => {
  const times: number[] = [];
  const llm = new ScriptedLlm((n) => {
    times.push(h.clock.t - T0);
    if (n <= 6) throw new TransientLlmError('network', 'sin conexión');
    return ok();
  });
  const h: Harness = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(3 * 3_600_000);
  assert.deepEqual(times, [sec(2), sec(32), sec(152), sec(452), sec(1352), sec(2252), sec(3152)]);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  assert.ok(!h.texts().includes(FALLBACK_TEXT));
  assert.deepEqual(listAgentRuns(h.db).map((r) => r.errorKind), ['transient:network', 'transient:network', 'transient:network', 'transient:network', 'transient:network', 'transient:network', null]);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  assert.deepEqual(getConversation(h.db, CHAT)!.card.state, 'nuevo'); // un error pasajero no deriva ni toca la ficha
});

test('sin saldo en OpenAI: aviso urgente la primera vez (no en cada reintento); si se vuelve a quedar sin saldo después de contestar, avisa de nuevo', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n <= 3 || n === 5) throw new TransientLlmError('quota', 'insufficient_quota');
    return n === 4 ? ok() : turnWith([FAKE_FOLLOWUP]);
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(10)); // 3 fallos (2 s, 32 s, 152 s) y el 4.º contesta (452 s)
  const sinSaldo = () => h.notifier.alerts.filter((a) => /OpenAI sin saldo: el bot no contesta hasta que se cargue/.test(a.text));
  assert.equal(sinSaldo().length, 1);
  assert.equal(sinSaldo()[0].urgent, true);
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  h.say(CHAT, 'Gracias, ¿cuándo me pasan el presupuesto?');
  await h.clock.advance(min(5));
  assert.equal(sinSaldo().length, 2); // otra vez sin saldo: otro aviso
  assert.equal(h.texts().length, 2);
  assert.equal(h.notifier.alerts.filter((a) => /más de 10 minutos/.test(a.text)).length, 0);
});

test('una conversación que lleva más de 10 minutos esperando avisa una sola vez', async () => {
  let up = false;
  const llm = new ScriptedLlm(() => {
    if (!up) throw new TransientLlmError('network', 'timeout');
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(9));
  assert.equal(h.notifier.alerts.length, 0);
  await h.clock.advance(min(2)); // 10 minutos desde el primer fallo
  const waits = () => h.notifier.alerts.filter((a) => /#1.*más de 10 minutos/.test(a.text));
  assert.equal(waits().length, 1);
  assert.doesNotMatch(waits()[0].text, /5491155550000/);
  await h.clock.advance(min(100));
  assert.equal(waits().length, 1);
  up = true;
  await h.clock.advance(min(20));
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
  // contestado: se limpia la espera y no queda ningún timer suelto de ese chat
  await h.clock.advance(min(60));
  assert.equal(waits().length, 1);
});

test('un mensaje nuevo mientras se espera el reintento no salta la espera; el reintento los toma a todos', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n === 1) throw new TransientLlmError('rate', '429');
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10)); // 1.er fallo a los 2 s
  h.say(CHAT, 'Hola, ¿están?');
  await h.clock.advance(sec(15)); // t = 25 s: todavía en la espera de 30 s
  assert.equal(llm.calls.length, 1);
  await h.clock.advance(sec(10)); // t = 35 s: el reintento (a los 32 s)
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].input, /mensajes_nuevos_del_cliente: m1, m2/);
});

test('una consulta más vieja que reply_window_hours ya no se contesta aunque se siga reintentando', async () => {
  const llm = new ScriptedLlm(() => {
    throw new TransientLlmError('network', 'caído');
  });
  const h = makeHarness({ llm, settings: { reply_window_hours: '1' } });
  h.say(CHAT, 'Hola');
  await h.clock.advance(5 * 3_600_000);
  assert.equal(llm.calls.length, 7); // hasta que el siguiente reintento cae pasada la hora
  assert.equal(h.channel.sendCalls, 0);
  assert.ok(listAudit(h.db, 'error').some((a) => /consulta_vencida/.test(a.detail)));
});

test('un error inesperado (no es de OpenAI ni del modelo) avisa una vez, reintenta con espera y nunca manda el mensaje seguro', async () => {
  const h = makeHarness({ config: { model: 'gpt-9', effort: 'low' } }); // modelo sin precio: runTurn tira antes de llamar
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(60));
  assert.equal(h.llmCalls(), 0);
  assert.equal(h.channel.sendCalls, 0);
  assert.equal(h.notifier.alerts.filter((a) => /sin precio/.test(a.text)).length, 1);
  assert.ok(listAudit(h.db, 'error').some((a) => /sin precio/.test(a.detail)));
});

// ---------- salida inválida: mensaje seguro y derivación ----------
test('salida inválida dos veces: se manda el mensaje seguro una vez, el chat queda en humano y se avisa la falla del bot', async () => {
  const llm = new ScriptedLlm(() => {
    throw new LlmOutputError('el JSON no cumple el esquema', { inputTokens: 100, cachedTokens: 0, outputTokens: 10 }, 50);
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(min(5));
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(h.texts(), [FALLBACK_TEXT]);
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.mode, c.card.state], ['humano', 'derivado']);
  assert.deepEqual(h.notifier.handoffs.map((x) => x.decisions), [[{ reason: 'falla_del_bot', priority: 'alta', mode: 'stop' }]]);
  assert.deepEqual(listAgentRuns(h.db).map((r) => r.usedFallback), [true, true]);
  h.say(CHAT, '¿Hola?');
  await h.clock.advance(min(5));
  assert.equal(llm.calls.length, 2); // el chat ya es del equipo
});

// ---------- ficha y derivaciones ----------
test('derivación de tipo stop (pide una persona): se mandan los globos, la ficha queda guardada, el chat pasa a humano y se avisa con la ficha', async () => {
  const llm = new ScriptedLlm(() => turnWith(['Buenas tardes, ya le aviso al equipo para que te contacte por acá.'], { signals: { ...turnWith([]).signals, asks_human: true }, team_note: 'Quiere hablar con alguien' }));
  const h = makeHarness({ llm });
  h.say(CHAT, 'Quiero hablar con una persona');
  await h.clock.advance(sec(20));
  assert.deepEqual(h.texts(), ['Buenas tardes, ya le aviso al equipo para que te contacte por acá.']); // sale aunque el chat ya esté en humano
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.mode, c.card.state, c.card.teamNote], ['humano', 'derivado', 'Quiere hablar con alguien']);
  assert.equal(h.notifier.handoffs.length, 1);
  assert.deepEqual(h.notifier.handoffs[0].decisions, [{ reason: 'pide_persona', priority: 'normal', mode: 'stop' }]);
  assert.equal(h.notifier.handoffs[0].card.state, 'derivado');
  assert.ok(listAudit(h.db, 'handoff').some((a) => a.chatId === CHAT && /pide_persona/.test(a.detail)));
});

test('derivación de tipo aviso (flag): se avisa una vez y el bot sigue en auto', async () => {
  const llm = new ScriptedLlm((n) => turnWith([n === 1 ? FIRST_TEXT : FAKE_FOLLOWUP], { signals: { ...turnWith([]).signals, off_knowledge: true } }));
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola, ¿aceptan criptomonedas?');
  await h.clock.advance(sec(20));
  assert.equal(h.notifier.handoffs.length, 1);
  assert.deepEqual(h.notifier.handoffs[0].decisions, [{ reason: 'fuera_de_politica', priority: 'normal', mode: 'flag' }]);
  assert.equal(getConversation(h.db, CHAT)!.mode, 'auto');
  h.say(CHAT, '¿Y bitcoin?');
  await h.clock.advance(sec(20));
  assert.equal(llm.calls.length, 2);
  assert.equal(h.notifier.handoffs.length, 1); // el mismo aviso no se repite
  assert.equal(getConversation(h.db, CHAT)!.card.flags.offKnowledgeCount, 2);
});

test('baja: "no me escribas más" se contesta con el texto fijo, la ficha queda en baja y el chat en humano (sin llamar al modelo)', async () => {
  const h = makeHarness();
  h.say(CHAT, 'No me escribas más');
  await h.clock.advance(sec(20));
  assert.deepEqual(h.texts(), [OPT_OUT_TEXT]);
  const c = getConversation(h.db, CHAT)!;
  assert.deepEqual([c.card.state, c.mode], ['baja', 'humano']);
  assert.equal(h.llmCalls(), 0);
});

// ---------- modo sombra ----------
test('modo sombra: el resultado va a borradores y se avisa; no se escribe al cliente, no se marca visto ni "escribiendo"', async () => {
  const h = makeHarness({ shadow: true });
  h.say(CHAT, 'Hola', { id: 'false_X_1' });
  await h.clock.advance(sec(20));
  assert.equal(h.channel.sendCalls, 0);
  assert.deepEqual(h.channel.seen, []);
  assert.deepEqual(h.channel.typingLog, []);
  assert.deepEqual(listOutbox(h.db), []);
  const drafts = listDrafts(h.db, CHAT);
  assert.equal(drafts.length, 1);
  assert.deepEqual([drafts[0].bubbles, drafts[0].status, drafts[0].contextVersion], [[FIRST_TEXT], 'pendiente', 1]);
  assert.deepEqual(h.notifier.drafts, [{ chatId: CHAT, draftId: drafts[0].id, bubbles: [FIRST_TEXT], material: [] }]);
  assert.equal(getConversation(h.db, CHAT)!.botSpentUsd, 0); // el cerebro falso no gasta
});

test('modo sombra: un mensaje nuevo vence el borrador anterior y se genera otro; la ficha se aplica igual', async () => {
  const llm = new ScriptedLlm((n) => turnWith([FIRST_TEXT], { team_note: `nota ${n}` }));
  const h = makeHarness({ llm, shadow: true });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  h.say(CHAT, 'Una cosa más');
  await h.clock.advance(sec(20));
  assert.deepEqual(listDrafts(h.db, CHAT).map((d) => d.status), ['vencido', 'pendiente']);
  assert.equal(h.notifier.drafts.length, 2);
  assert.equal(getConversation(h.db, CHAT)!.card.teamNote, 'nota 2');
  assert.equal(h.channel.sendCalls, 0);
  assert.match(llm.calls[1].input, /mensajes_nuevos_del_cliente: m1, m2/); // en sombra nada se mandó: los dos siguen sin contestar
});

test('modo sombra: una derivación de tipo stop también avisa y deja el chat en humano', async () => {
  const llm = new ScriptedLlm(() => turnWith(['Buenas tardes, ya le aviso al equipo para que te contacte por acá.'], { signals: { ...turnWith([]).signals, asks_human: true } }));
  const h = makeHarness({ llm, shadow: true });
  h.say(CHAT, 'Quiero hablar con una persona');
  await h.clock.advance(sec(20));
  assert.equal(getConversation(h.db, CHAT)!.mode, 'humano');
  assert.equal(h.notifier.handoffs.length, 1);
  assert.equal(h.notifier.drafts.length, 1);
});

// ---------- turno: lectura, escribiendo, registro ----------
test('fuera de sombra: marca visto lo que el cliente escribió y "escribiendo" mientras piensa; siempre se apaga, aunque OpenAI falle', async () => {
  const llm = new ScriptedLlm((n) => {
    if (n === 1) throw new TransientLlmError('network', 'x');
    return ok();
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola', { id: 'false_X_1' });
  h.say(CHAT, 'Quiero una cancha', { id: 'false_X_2' });
  await h.clock.advance(sec(3));
  assert.deepEqual(h.channel.seen, [{ chatId: CHAT, ids: ['false_X_1', 'false_X_2'] }]);
  assert.deepEqual(h.channel.typingLog, [{ chatId: CHAT, on: true }, { chatId: CHAT, on: false }]); // el turno falló: igual se apagó
});

test('si falla marcar visto o "escribiendo", el turno sigue y se contesta', async () => {
  const h = makeHarness();
  h.channel.markSeen = async () => { throw new Error('boom'); };
  h.channel.typing = async () => { throw new Error('boom'); };
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  assert.deepEqual(h.texts(), [FIRST_TEXT]);
});

test('queda registrado: una fila de agent_runs por intento con modelo, tokens, costo y hash de la política; el gasto suma a la conversación', async () => {
  const h = makeHarness({ llm: new ScriptedLlm(ok) });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  const row = h.db.prepare('SELECT * FROM agent_runs').get() as Record<string, number | string>;
  assert.deepEqual([row.chat_id, row.model, row.effort, row.input_tokens, row.cached_tokens, row.output_tokens, row.latency_ms, row.used_fallback, row.error_kind], [CHAT, 'gpt-6.1-sol', 'low', 3000, 2048, 200, 5, 0, null]);
  assert.equal(row.policy_hash, policy.hash);
  assert.ok(Math.abs((row.cost_usd as number) - 0.0041088) < 1e-9);
  assert.ok(Math.abs(getConversation(h.db, CHAT)!.botSpentUsd - 0.0041088) < 1e-9);
  assert.deepEqual([row.cache_write_tokens, row.cache_write_1h_tokens, row.thinking_tokens], [null, null, null]); // este cerebro no informa caché escrito ni pensamiento
});

test('queda registrado: lo escrito en el caché (total y de 1 h) y el pensamiento del intento van a agent_runs', async () => {
  const base = new ScriptedLlm(ok);
  const usage = { inputTokens: 4000, cachedTokens: 0, cacheWriteTokens: 3900, cacheWrite1hTokens: 3900, outputTokens: 300, thinkingTokens: 120 };
  const h = makeHarness({ llm: { generateTurn: async (req) => ({ ...(await base.generateTurn(req)), usage }) } });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  const row = h.db.prepare('SELECT * FROM agent_runs').get() as Record<string, number | string>;
  assert.deepEqual([row.input_tokens, row.cache_write_tokens, row.cache_write_1h_tokens, row.output_tokens, row.thinking_tokens], [4000, 3900, 3900, 300, 120]);
});

test('el cerebro falso pasa el controlador: el primer mensaje es el aprobado con el saludo de la hora; después, la pregunta fija', async () => {
  const h = makeHarness();
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(20));
  h.say(CHAT, 'Quiero una cancha');
  await h.clock.advance(sec(20));
  assert.deepEqual(h.texts(), [FIRST_TEXT, FAKE_FOLLOWUP]);
  assert.deepEqual(listAgentRuns(h.db).map((r) => [r.usedFallback, r.errorKind]), [[false, null], [false, null]]);
});

test('material: los globos y después las imágenes del turno', async () => {
  const llm = new ScriptedLlm(() => turnWith([FIRST_TEXT], { material: ['modelo_full_panoramica'] }));
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola, ¿cómo es la Full Panorámica?');
  await h.clock.advance(sec(20));
  assert.deepEqual(h.channel.sent.map((m) => m.kind), ['text', 'image']);
  assert.match(h.channel.sent[1].filePath!, /modelo-full-panoramica\.jpg$/);
});

// ---------- reinicio ----------
test('rescan: al prender de nuevo contesta las consultas sin contestar que entran en la ventana, y deja las viejas', async () => {
  const h = makeHarness({ settings: { kill_switch: '1', reply_window_hours: '12' } });
  h.say('5491100000001@c.us', 'Hola');
  h.say('5491100000002@c.us', 'Hola vieja', { tsUtcMs: h.clock.now() - 13 * 3_600_000 });
  await h.clock.advance(min(5));
  assert.equal(h.llmCalls(), 0);
  setSetting(h.db, 'kill_switch', '0');
  h.worker.rescan();
  await h.clock.advance(min(5));
  assert.equal(h.llmCalls(), 1);
  assert.deepEqual(h.texts('5491100000001@c.us'), [FIRST_TEXT]);
  assert.deepEqual(h.texts('5491100000002@c.us'), []);
});

test('stop() deja el worker sin timers', async () => {
  const llm = new ScriptedLlm(() => {
    throw new TransientLlmError('network', 'x');
  });
  const h = makeHarness({ llm });
  h.say(CHAT, 'Hola');
  await h.clock.advance(sec(10));
  assert.ok(h.clock.pending > 0);
  h.worker.stop();
  h.outbox.stop();
  h.ingest.stop();
  assert.equal(h.clock.pending, 0);
});

