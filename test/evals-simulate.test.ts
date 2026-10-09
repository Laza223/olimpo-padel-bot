// Una conversación de punta a punta con runTurn real y el LlmClient falso; cliente simulado y juez falsos. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd } from '../src/brain.ts';
import { loadPolicy } from '../src/policy.ts';
import { FALLBACK_TEXT, OPT_OUT_TEXT } from '../src/turn.ts';
import type { BrainConfig, LlmClient } from '../src/types.ts';
import { loadScenarios, selectScenarios } from '../evals/scenario.ts';
import type { Scenario } from '../evals/scenario.ts';
import { runScenario } from '../evals/simulate.ts';
import { criticalFailures } from '../evals/metrics.ts';
import { mapPool, parseEvalArgs, runEval } from '../evals/run.ts';
import { CallError } from '../evals/types.ts';
import { fakeLlm, modelTurn, withSignals } from './helpers.ts';
import { fakeCustomer, fakeJudge, verdict } from './evals-helpers.ts';

const policy = loadPolicy();
const scenarios = loadScenarios(undefined, policy.assets.map((a) => a.id));
const config: BrainConfig = { model: 'gpt-6-luna', effort: 'low' };
const byId = (id: string): Scenario => selectScenarios(scenarios, [id])[0];
const FAKE_COST = costUsd('gpt-6-luna', { inputTokens: 3000, cachedTokens: 2048, outputTokens: 200 }); // lo que cobra fakeLlm por intento

// ---------- Guion ----------
test('guion de punta a punta: "son los de Elite?" cumple todas las expectativas', async () => {
  const sc = byId('tono-19-son-los-de-elite');
  const llm = fakeLlm([modelTurn({ bubbles: ['Buenas tardes, no, somos Olimpo Padel, una empresa aparte.'] })]);
  const r = await runScenario(sc, 1, { llm, policy, config });
  assert.equal(r.endReason, 'bot_parado');
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(criticalFailures(r), []);
  assert.equal(r.turns.length, 1);
  assert.deepEqual(r.turns[0].customer, ['Ustedes no son los de Elite?']);
  assert.deepEqual(r.turns[0].handoffs, [{ reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }]);
  assert.equal(r.finalCard.state, 'derivado');
  assert.deepEqual(r.history.map((m) => m.author), ['customer', 'bot']);
  assert.equal(r.cost.bot, FAKE_COST);
  const a = r.turns[0].attempts[0]; // los tokens del intento quedan guardados (fakeLlm no informa pensamiento)
  assert.deepEqual([a.inputTokens, a.cachedTokens, a.cacheWriteTokens, a.cacheWrite1hTokens, a.outputTokens, a.thinkingTokens], [3000, 2048, 0, 0, 200, null]);
  assert.deepEqual([r.cost.customer, r.cost.judge], [0, 0]);
  assert.equal(r.judge, undefined);
  assert.match(llm.calls[0].input, /hora_argentina: 15:15/); // la hora del escenario, no la de la PC
  assert.match(llm.calls[0].input, /saludo_que_corresponde: Buenas tardes/);
});

test('guion: si el bot dice otra cosa, la expectativa incumplida es una falla crítica', async () => {
  const llm = fakeLlm([modelTurn({ bubbles: ['Buenas tardes, contame de dónde sos?'] })]);
  // (tono-01 y no tono-19: ahí el controlador ya rechaza la respuesta mala y el turno termina en el mensaje seguro)
  const r = await runScenario(byId('tono-01-info-cancha'), 1, { llm, policy, config });
  assert.equal(r.expectFailures.length, 1);
  assert.match(r.expectFailures[0], /^dice_todas: .*olimpo p/);
  assert.deepEqual(criticalFailures(r), [`espera ${r.expectFailures[0]}`]);
});

test('guion con ráfaga: los 4 mensajes abren un solo turno y la ficha toma los datos', async () => {
  const sc = byId('trampa-rafaga-datos');
  const llm = fakeLlm([
    modelTurn({
      bubbles: ['Buenas tardes, Pedro. Tenés platea de hormigón?'],
      lead_patch: [
        { field: 'nombre', value: 'Pedro', evidence_msg_id: 'm2' },
        { field: 'localidad', value: 'Pilar', evidence_msg_id: 'm3' },
        { field: 'provincia', value: 'Buenos Aires', evidence_msg_id: 'm3' },
        { field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm4' },
      ],
    }),
  ]);
  const r = await runScenario(sc, 1, { llm, policy, config });
  assert.deepEqual(r.expectFailures, []);
  assert.equal(r.endReason, 'guion_completo');
  assert.equal(r.turns.length, 1);
  assert.deepEqual(r.turns[0].customer, ['Hola', 'Soy Pedro', 'Estoy en Pilar, Buenos Aires', 'Quiero 2 canchas']);
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1, m2, m3, m4/);
  assert.match(llm.calls[0].input, /\[m4\]\[cliente 15:00\] Quiero 2 canchas/);
  assert.equal(r.finalCard.state, 'calificando');
});

test('guion con reintento: suma el costo de los dos intentos y guarda lo que el modelo había propuesto', async () => {
  const sc = byId('trampa-hora-23');
  const llm = fakeLlm([
    modelTurn({ bubbles: ['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?'] }), // a las 23:00 no corresponde
    modelTurn({ bubbles: ['Buenas noches, te escribimos de Olimpo Padel. Contame, de dónde sos?'] }),
  ]);
  const r = await runScenario(sc, 2, { llm, policy, config });
  assert.deepEqual(r.expectFailures, []);
  assert.equal(r.run, 2);
  assert.equal(r.turns[0].attempts.length, 2);
  assert.equal(r.turns[0].attempts[0].violations[0].rule, 'greeting');
  assert.deepEqual(r.turns[0].attempts[0].proposed, ['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?']);
  assert.equal(r.turns[0].attempts[1].proposed, undefined);
  assert.equal(r.cost.bot, FAKE_COST * 2);
  assert.match(llm.calls[0].input, /hora_argentina: 23:00/);
});

test('guion con dos fallas: mensaje seguro, falla_del_bot y expectativas incumplidas', async () => {
  const r = await runScenario(byId('tono-02-precio'), 1, { llm: fakeLlm([new Error('caído')]), policy, config });
  assert.equal(r.turns[0].usedFallback, true);
  assert.deepEqual(r.turns[0].bubbles, [FALLBACK_TEXT]);
  assert.deepEqual(r.turns[0].controllerViolations, []); // el texto fijo lo cubre una prueba unitaria
  assert.equal(r.endReason, 'bot_parado');
  assert.ok(r.expectFailures.some((f) => f.startsWith('primer_globo')));
  assert.ok(r.expectFailures.some((f) => f.startsWith('derivacion: se esperaba ninguna y hubo falla_del_bot')));
});

test('guion: un proveedor no recibe nada y la ficha queda en no_es_cliente', async () => {
  const llm = fakeLlm([withSignals({ not_a_lead: true }, { bubbles: [] })]);
  const r = await runScenario(byId('trampa-proveedor-hierro'), 1, { llm, policy, config });
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(r.turns[0].bubbles, []);
  assert.equal(r.finalCard.state, 'no_es_cliente');
  assert.deepEqual(r.history.map((m) => m.author), ['customer']);
});

test('guion: la baja manda el texto fijo y corta la charla', async () => {
  const llm = fakeLlm([
    modelTurn({ bubbles: ['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?'] }),
    withSignals({ opt_out: true }, { bubbles: [] }),
  ]);
  const r = await runScenario(byId('trampa-no-escribir-mas'), 1, { llm, policy, config });
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(r.turns.map((t) => t.bubbles), [['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?'], [OPT_OUT_TEXT]]);
  assert.equal(r.endReason, 'bot_parado');
  assert.equal(r.finalCard.state, 'baja');
});

// ---------- Persona ----------
const closing = 'Te mandamos el presupuesto por acá en el día, o a más tardar el día hábil siguiente.';
const completePatch = [
  { field: 'nombre', value: 'Pedro', evidence_msg_id: 'm1' },
  { field: 'localidad', value: 'Escobar', evidence_msg_id: 'm1' },
  { field: 'provincia', value: 'Buenos Aires', evidence_msg_id: 'm1' },
  { field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm1' },
  { field: 'modelo', value: 'full_panoramica', evidence_msg_id: 'm1' },
  { field: 'platea', value: 'tiene', evidence_msg_id: 'm1' },
  { field: 'ubicacion', value: 'techada', evidence_msg_id: 'm1' },
] as const;

test('persona que llega a listo: el bot queda parado, no se vuelve a llamar al cliente y el juez ve la charla', async () => {
  const sc = byId('persona-inversor-galpon');
  const customer = fakeCustomer(['Hola, soy Pedro de Escobar, Buenos Aires, 2 canchas full panoramica, tengo platea y es techada']);
  const judge = fakeJudge([verdict(5)], 0.02);
  const llm = fakeLlm([modelTurn({ bubbles: ['Buenas tardes, ya le paso tus datos al equipo para armar el presupuesto.', closing], lead_patch: [...completePatch] })]);
  const r = await runScenario(sc, 1, { llm, policy, config, customer, judge });
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(criticalFailures(r), []);
  assert.equal(r.endReason, 'bot_parado');
  assert.equal(customer.calls.length, 1);
  assert.deepEqual(customer.calls[0].history, []); // el primer mensaje sale de la persona sola
  assert.equal(customer.calls[0].persona, sc.persona);
  assert.equal(r.finalCard.state, 'derivado');
  assert.deepEqual(r.turns[0].handoffs, [{ reason: 'listo_para_presupuesto', priority: 'normal', mode: 'stop' }]);
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].hora, '15:00');
  assert.equal(judge.calls[0].turns, r.turns);
  assert.equal(judge.calls[0].finalCard, r.finalCard);
  assert.deepEqual(r.judge, verdict(5));
  // cada costo va aparte
  assert.equal(r.cost.bot, FAKE_COST);
  assert.equal(r.cost.customer, 0.001);
  assert.equal(r.cost.judge, 0.02);
});

test('persona que corta con [FIN]: el cliente manda ráfagas y ve los globos del bot', async () => {
  const sc = byId('persona-inversor-galpon');
  const customer = fakeCustomer(['Hola, soy Pedro, de Escobar', 'dos canchas, la full panoramica || techada y tengo platea', '[FIN]']);
  const judge = fakeJudge([verdict(4)]);
  const llm = fakeLlm([
    modelTurn({ bubbles: ['Buenas tardes, te escribimos de Olimpo Padel. Cuántas canchas serían?'] }),
    modelTurn({ bubbles: ['Perfecto, anotado. Y cuándo querrías abrir?'] }),
  ]);
  const r = await runScenario(sc, 1, { llm, policy, config, customer, judge });
  assert.equal(r.endReason, 'fin_cliente');
  assert.equal(r.turns.length, 2);
  assert.deepEqual(r.turns[1].customer, ['dos canchas, la full panoramica', 'techada y tengo platea']);
  assert.match(llm.calls[1].input, /mensajes_nuevos_del_cliente: m3, m4/);
  assert.deepEqual(customer.calls.map((c) => c.history.map((m) => m.id)), [[], ['m1', 'm2'], ['m1', 'm2', 'm3', 'm4', 'm5']]);
  assert.equal(r.cost.customer, 0.003); // 3 llamadas, la última la que dijo [FIN]
  assert.equal(judge.calls.length, 1);
  assert.ok(r.expectFailures.some((f) => f.startsWith('derivacion: se esperaba listo_para_presupuesto')), 'nunca llegó a listo: tiene que quedar marcado');
});

test('persona que llega al tope de turnos', async () => {
  const sc: Scenario = { ...byId('persona-regateador'), max_turnos: 2 };
  const customer = fakeCustomer(['quiero 1 cancha, cuánto sale', 'me hacés descuento?']);
  const llm = fakeLlm([
    modelTurn({ bubbles: ['Buen día, la Full Panorámica está en oferta. En qué zona sería?'] }),
    modelTurn({ bubbles: ['Dale, contame en qué zona sería?'] }),
  ]);
  const r = await runScenario(sc, 1, { llm, policy, config, customer, judge: fakeJudge() });
  assert.equal(r.endReason, 'max_turnos');
  assert.equal(r.turns.length, 2);
  assert.equal(customer.calls.length, 2);
});

test('errores del cliente simulado cortan la conversación sin gastar el juez ni inventar fallas de expectativa', async () => {
  const sc = byId('persona-inversor-galpon');
  const judge = fakeJudge();
  const cases: [string, (string | Error)[], RegExp, number][] = [
    ['falla de red con costo', [new CallError('se cayó', 0.5)], /^se cayó$/, 0.5],
    ['falla en el 2.º mensaje', ['Hola', new Error('boom')], /^boom$/, 0.001],
    ['corta antes de escribir', ['[FIN]'], /cortó sin escribir el primer mensaje/, 0.001],
    ['respuesta sin mensajes', [' || '], /no escribió nada/, 0.001],
  ];
  for (const [name, replies, re, customerCost] of cases) {
    const r = await runScenario(sc, 1, { llm: fakeLlm([modelTurn({ bubbles: ['Buenas tardes, te escribimos de Olimpo Padel. De dónde sos?'] })]), policy, config, customer: fakeCustomer(replies), judge });
    assert.equal(r.endReason, 'error', name);
    assert.match(r.error!, re, name);
    assert.deepEqual(r.expectFailures, [], name);
    assert.deepEqual(criticalFailures(r), [`error: ${r.error}`], name);
    assert.ok(Math.abs(r.cost.customer - customerCost) < 1e-12, name);
  }
  assert.equal(judge.calls.length, 0);
  const sin = await runScenario(sc, 1, { llm: fakeLlm([modelTurn()]), policy, config });
  assert.match(sin.error!, /falta el cliente simulado/);
});

test('si el juez falla no hay veredicto, pero el costo gastado se anota aparte', async () => {
  const llm = fakeLlm([modelTurn({ bubbles: ['Buenas tardes, te escribimos de Olimpo Padel. Contame, de dónde sos?'] })]);
  const r = await runScenario(byId('tono-01-info-cancha'), 1, { llm, policy, config, judge: fakeJudge([new CallError('juez roto', 0.07)]) });
  assert.equal(r.judge, undefined);
  assert.equal(r.judgeError, 'juez roto');
  assert.equal(r.cost.judge, 0.07);
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(criticalFailures(r), []); // lo marca la vara (juez incompleto), no es una falla crítica
});

// ---------- Orquestación ----------
test('mapPool: respeta el tope de concurrencia y devuelve en el orden de entrada', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapPool([30, 5, 20, 1, 10], 2, async (ms, i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ['0:30', '1:5', '2:20', '3:1', '4:10']);
  assert.equal(peak, 2);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test('parseEvalArgs: opciones, defaults del entorno y el "--" que deja pasar pnpm', () => {
  assert.deepEqual(
    parseEvalArgs(['--', '--model', 'gpt-6-luna', '--effort', 'low', '--runs', '3', '--only', 'a, b', '--concurrency', '2'], {}),
    { model: 'gpt-6-luna', effort: 'low', runs: 3, concurrency: 2, only: ['a', 'b'] },
  );
  assert.deepEqual(parseEvalArgs([], {}), { model: 'gpt-6.1-sol', effort: 'low', runs: 1, concurrency: 4, only: undefined });
  assert.deepEqual(parseEvalArgs(['--runs', '2'], { BOT_MODEL: 'gpt-6-luna', BOT_EFFORT: 'medium' }), { model: 'gpt-6-luna', effort: 'medium', runs: 2, concurrency: 4, only: undefined });
  assert.throws(() => parseEvalArgs(['--runs', '0'], {}), /--runs/);
  assert.throws(() => parseEvalArgs(['--concurrency', 'x'], {}), /--concurrency/);
  assert.throws(() => parseEvalArgs(['--foo'], {}), /foo/);
});

// Un bot falso que saluda según el contexto: responde bien tanto a las 15:15 como a las 23:00.
const greeter: LlmClient = {
  async generateTurn(req) {
    const g = /saludo_que_corresponde: (.+)/.exec(req.input)![1];
    return { turn: modelTurn({ bubbles: [`${g}, no, somos Olimpo Padel, una empresa aparte.`] }), usage: { inputTokens: 3000, cachedTokens: 2048, outputTokens: 200 }, latencyMs: 1200 };
  },
};

test('runEval: N corridas de los escenarios elegidos, ordenadas, con vara y registro de avance', async () => {
  const chosen = selectScenarios(scenarios, ['trampa-hora-23', 'tono-19-son-los-de-elite']);
  const log: string[] = [];
  const out = await runEval({ ...config, runs: 2, concurrency: 3 }, { llm: greeter, customer: fakeCustomer(['x']), judge: fakeJudge([verdict(5)]), policy }, chosen, (l) => log.push(l));
  assert.deepEqual(out.results.map((r) => `${r.run}:${r.scenarioId}`), ['1:tono-19-son-los-de-elite', '1:trampa-hora-23', '2:tono-19-son-los-de-elite', '2:trampa-hora-23']);
  assert.deepEqual(out.scenarioIds, ['tono-19-son-los-de-elite', 'trampa-hora-23']); // el orden del banco, no el del pedido
  assert.equal(out.perRun.length, 2);
  assert.deepEqual(out.perRun.map((r) => r.metrics.conversations), [2, 2]);
  assert.equal(out.overall.conversations, 4);
  assert.equal(out.policyHash, policy.hash);
  assert.equal(out.pass, true);
  assert.equal(log.length, 4);
  assert.match(log[0], /^\[1\/4\] /);
});

test('runEval: un modelo sin precio falla antes de llamar a nadie', async () => {
  const llm = fakeLlm([modelTurn()]);
  await assert.rejects(runEval({ model: 'gpt-9', effort: 'low', runs: 1, concurrency: 1 }, { llm, customer: fakeCustomer(['x']), judge: fakeJudge(), policy }, scenarios.slice(0, 1)), /sin precio/);
  assert.equal(llm.calls.length, 0);
});
