import { test } from 'node:test';
import { parse } from 'yaml';
import assert from 'node:assert/strict';
import { runTurn, OPT_OUT_TEXT, FALLBACK_TEXT } from '../src/turn.ts';
import { buildInstructions, costUsd } from '../src/brain.ts';
import { loadPolicy } from '../src/policy.ts';
import { emptyCard } from '../src/lead.ts';
import { supervise } from '../src/supervisor/index.ts';
import { argentinaTimeToUtcMs } from '../src/time.ts';
import type { BrainConfig, ChatMessage, LeadCard, TurnInput } from '../src/types.ts';
import { cardWith, fakeLlm, GREETING_TEXT, field, modelTurn, MORNING_UTC, msg, withSignals } from './helpers.ts';

const policy = loadPolicy();
const config: BrainConfig = { model: 'gpt-6-luna', effort: 'low' };
const CLOSING = policy.closingText; // el cierre tiene que ser el texto aprobado, tal cual

// Turno con la hora fija en las 09:00 argentinas ("Buen día").
const input = (history: ChatMessage[], newIds: string[], card: LeadCard = emptyCard(), nowUtcMs = MORNING_UTC): TurnInput => ({
  conversationId: 'c1', history, newCustomerMessageIds: newIds, card, nowUtcMs,
});
const first = (text = 'Hola, info de la cancha') => input([msg('m1', 'customer', text)], ['m1']);
// Segundo turno: ya hubo un mensaje del bot.
const second = (text: string, card: LeadCard = emptyCard()) =>
  input([msg('m1', 'customer', 'Hola'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', text)], ['m3'], card);

test('turno normal: manda los globos, un solo intento, con costo', async () => {
  const llm = fakeLlm([modelTurn()]);
  const r = await runTurn(first(), { llm, policy, config });
  assert.deepEqual(r.bubbles, [GREETING_TEXT]);
  assert.equal(r.usedFallback, false);
  assert.equal(r.stopBot, false);
  assert.deepEqual(r.handoffs, []);
  assert.equal(r.attempts.length, 1);
  const a = r.attempts[0];
  assert.deepEqual([a.model, a.effort, a.latencyMs, a.inputTokens, a.cachedTokens, a.outputTokens], ['gpt-6-luna', 'low', 1200, 3000, 2048, 200]);
  assert.equal(a.costUsd, costUsd('gpt-6-luna', { inputTokens: 3000, cachedTokens: 2048, outputTokens: 200 }));
  assert.deepEqual(a.violations, []);
  assert.deepEqual(a.raw, modelTurn());
  assert.equal(llm.calls[0].model, 'gpt-6-luna');
  assert.equal(llm.calls[0].effort, 'low');
  assert.match(llm.calls[0].input, /mensajes_nuevos_del_cliente: m1/);
});

test('un modelo sin precio falla antes de llamar a la API', async () => {
  const llm = fakeLlm([modelTurn()]);
  await assert.rejects(runTurn(first(), { llm, policy, config: { model: 'gpt-9', effort: 'low' } }), /sin precio/);
  assert.equal(llm.calls.length, 0);
});

test('saludo solo en el primer turno', async () => {
  // primer mensaje sin saludo → reintento
  let r = await runTurn(first(), { llm: fakeLlm([modelTurn({ bubbles: ['Contame, de dónde sos?'] }), modelTurn()]), policy, config });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].violations[0].rule, 'greeting');
  assert.deepEqual(r.bubbles, [GREETING_TEXT]);
  // saludo equivocado para la hora (09:00 → "Buen día")
  r = await runTurn(first(), { llm: fakeLlm([modelTurn({ bubbles: ['Buenas noches, te escribimos de Olimpo Padel. De dónde sos?'] }), modelTurn()]), policy, config });
  assert.equal(r.attempts[0].violations[0].rule, 'greeting');
  // segundo turno con saludo → reintento; sin saludo → pasa
  for (const g of ['Buen día', 'Buenas tardes', 'buenas noches']) {
    const r2 = await runTurn(second('Pilar'), { llm: fakeLlm([modelTurn({ bubbles: [`${g}, anotado. En qué zona?`] }), modelTurn({ bubbles: ['Anotado. Cuántas canchas serían?'] })]), policy, config });
    assert.equal(r2.attempts[0].violations[0].rule, 'greeting', g);
    assert.equal(r2.attempts.length, 2);
  }
  const ok = await runTurn(second('Pilar'), { llm: fakeLlm([modelTurn({ bubbles: ['Anotado. Cuántas canchas serían?'] })]), policy, config });
  assert.equal(ok.attempts.length, 1);
});

test('el saludo sigue la hora argentina (23:00 → Buenas noches), no la de la PC', async () => {
  const noche = input([msg('m1', 'customer', 'Hola')], ['m1'], emptyCard(), argentinaTimeToUtcMs('23:00', MORNING_UTC));
  const ok = await runTurn(noche, { llm: fakeLlm([modelTurn({ bubbles: ['Buenas noches, te escribimos de Olimpo Padel. De dónde sos?'] })]), policy, config });
  assert.equal(ok.attempts.length, 1);
  const llm = fakeLlm([modelTurn(), modelTurn({ bubbles: ['Buenas noches, te escribimos de Olimpo Padel. De dónde sos?'] })]);
  const r = await runTurn(noche, { llm, policy, config });
  assert.equal(r.attempts[0].violations[0].rule, 'greeting');
  assert.match(llm.calls[0].input, /saludo_que_corresponde: Buenas noches/);
});

test('reintento con violación y después éxito', async () => {
  const mala = modelTurn({ bubbles: [`${GREETING_TEXT.split(',')[0]}, la cancha sale USD 17.000.`] });
  const llm = fakeLlm([mala, modelTurn()]);
  const r = await runTurn(first(), { llm, policy, config });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.usedFallback, false);
  assert.ok(r.attempts[0].violations.some((v) => v.rule === 'price'));
  assert.deepEqual(r.attempts[1].violations, []);
  assert.deepEqual(r.bubbles, [GREETING_TEXT]);
  assert.match(llm.calls[1].input, /<errores_del_intento_anterior>\n- price: /);
  assert.doesNotMatch(llm.calls[0].input, /errores_del_intento_anterior/);
  assert.equal(llm.calls[0].instructions, llm.calls[1].instructions);
});

test('dos fallas → mensaje seguro, derivación falla_del_bot alta en stop, sin aplicar el patch', async () => {
  const mala = modelTurn({
    bubbles: ['Buen día, USD 17.000 y listo.'],
    lead_patch: [{ field: 'nombre', value: 'Pedro', evidence_msg_id: 'm1' }],
  });
  const r = await runTurn(first('Soy Pedro'), { llm: fakeLlm([mala, mala]), policy, config });
  assert.deepEqual(r.bubbles, [FALLBACK_TEXT]);
  assert.equal(r.usedFallback, true);
  assert.equal(r.attempts.length, 2);
  assert.ok(r.attempts.every((a) => a.violations.length > 0));
  assert.deepEqual(r.handoffs, [{ reason: 'falla_del_bot', priority: 'alta', mode: 'stop' }]);
  assert.equal(r.stopBot, true);
  assert.deepEqual(r.material, []);
  assert.equal(r.card.fields.nombre, undefined);
  assert.equal(r.card.state, 'derivado');
});

test('si el modelo falla (red, negativa, incompleto) cuenta como violación; con dos va el mensaje seguro', async () => {
  const r = await runTurn(first(), { llm: fakeLlm([new Error('timeout'), modelTurn()]), policy, config });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].violations[0].rule, 'llm');
  assert.match(r.attempts[0].violations[0].detail, /timeout/);
  assert.equal(r.attempts[0].costUsd, 0);
  assert.equal(r.usedFallback, false);
  const dead = await runTurn(first(), { llm: fakeLlm([new Error('caído')]), policy, config });
  assert.equal(dead.usedFallback, true);
  assert.deepEqual(dead.bubbles, [FALLBACK_TEXT]);
  assert.equal(dead.stopBot, true);
});

test('baja por la señal del modelo → texto fijo, sin material, ficha en baja', async () => {
  const turn = withSignals({ opt_out: true }, { bubbles: ['Dale, perdón por la molestia'], material: ['fabricacion_panos'] });
  const llm = fakeLlm([turn]);
  const r = await runTurn(second('ya no quiero saber nada, gracias'), { llm, policy, config }); // sin frase que el respaldo por texto reconozca
  assert.deepEqual(r.bubbles, [OPT_OUT_TEXT]);
  assert.equal(OPT_OUT_TEXT, 'Listo, no te escribimos más. Si más adelante lo necesitás, escribinos por acá.');
  assert.deepEqual(r.material, []);
  assert.equal(r.card.state, 'baja');
  assert.equal(r.stopBot, true);
  assert.deepEqual(r.handoffs, [{ reason: 'baja', priority: 'baja', mode: 'stop' }]);
  assert.equal(r.attempts.length, 1);
});

test('no es cliente → sin globos y ficha en no_es_cliente, sin reintentar por estar vacío', async () => {
  const llm = fakeLlm([withSignals({ not_a_lead: true }, { bubbles: [], material: ['modelo_panoramica'] })]);
  const r = await runTurn(first('Hola, les ofrezco hierro del 12 a buen precio'), { llm, policy, config });
  assert.deepEqual(r.bubbles, []);
  assert.deepEqual(r.material, []);
  assert.equal(r.card.state, 'no_es_cliente');
  assert.equal(r.stopBot, true);
  assert.deepEqual(r.handoffs, [{ reason: 'no_es_cliente', priority: 'normal', mode: 'stop' }]);
  assert.equal(r.attempts.length, 1);
  assert.equal(r.usedFallback, false);
});

test('ficha completa sin cierre → reintento; con cierre → derivado, stop', async () => {
  const card = cardWith(['platea', 'ubicacion']);
  const history = [msg('m1', 'customer', 'Pedro, 2 canchas'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'tengo platea y la quiero techada')];
  const patch = [
    { field: 'platea' as const, value: 'tiene', evidence_msg_id: 'm3' },
    { field: 'ubicacion' as const, value: 'techada', evidence_msg_id: 'm3' },
  ];
  const sinCierre = modelTurn({ bubbles: ['Perfecto, ya le paso tus datos al equipo.'], lead_patch: patch });
  const conCierre = modelTurn({ bubbles: ['Perfecto, ya le paso tus datos al equipo.', CLOSING], lead_patch: patch });
  const llm = fakeLlm([sinCierre, conCierre]);
  const r = await runTurn(input(history, ['m3'], card), { llm, policy, config });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].violations[0].rule, 'closing');
  assert.match(llm.calls[1].input, /closing/);
  assert.deepEqual(r.bubbles, conCierre.bubbles);
  assert.equal(r.card.fields.platea?.value, 'tiene');
  assert.equal(r.card.state, 'derivado');
  assert.deepEqual(r.handoffs, [{ reason: 'listo_para_presupuesto', priority: 'normal', mode: 'stop' }]);
  assert.equal(r.stopBot, true);
  assert.deepEqual(r.card.notified, ['listo_para_presupuesto']);
});

test('el cierre exige el texto aprobado tal cual (sin importar mayúsculas, tildes ni puntuación)', async () => {
  const card = cardWith(['platea', 'ubicacion']);
  const history = [msg('m1', 'customer', 'Pedro, 2 canchas'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'tengo platea y la quiero techada')];
  const patch = [
    { field: 'platea' as const, value: 'tiene', evidence_msg_id: 'm3' },
    { field: 'ubicacion' as const, value: 'techada', evidence_msg_id: 'm3' },
  ];
  const attemptsWith = async (closing: string) => {
    const bien = modelTurn({ bubbles: ['Perfecto, ya le paso tus datos al equipo.', CLOSING], lead_patch: patch });
    const r = await runTurn(input(history, ['m3'], card), { llm: fakeLlm([modelTurn({ bubbles: ['Perfecto, ya le paso tus datos al equipo.', closing], lead_patch: patch }), bien]), policy, config });
    return r.attempts[0].violations.map((v) => v.rule);
  };
  for (const ok of [policy.closingText, policy.closingText.toUpperCase(), 'te mandamos el presupuesto por aca en el dia o a mas tardar el dia habil siguiente']) {
    assert.deepEqual(await attemptsWith(ok), [], ok);
  }
  // nombrar "presupuesto" y "día" ya no alcanza: una promesa inventada o una variante no aprobada se rechaza
  for (const bad of ['Te lo mandamos por acá en el día, o a más tardar el día hábil siguiente.', 'El presupuesto te llega en un día.', 'Pronto te escribimos.']) {
    assert.ok((await attemptsWith(bad)).includes('closing'), bad);
  }
});

test('cierre prometido sin la ficha completa → violación closing_early (sin derivación), aunque el cliente pida el presupuesto', async () => {
  const card: LeadCard = { ...emptyCard(), fields: { nombre: field('Pedro', 'm1'), localidad: field('Pilar', 'm1') } };
  const cierre = modelTurn({ bubbles: ['Perfecto, ya le paso tus datos al equipo.', CLOSING] });
  const bien = modelTurn({ bubbles: ['Dale, anotado. Cuántas canchas serían?'] });
  const r = await runTurn(second('dale mandame el presupuesto', card), { llm: fakeLlm([cierre, bien]), policy, config });
  assert.equal(r.attempts[0].violations[0].rule, 'closing_early');
  assert.deepEqual(r.bubbles, bien.bubbles);
  assert.deepEqual(r.handoffs, []);
  // el texto del cierre con otra puntuación o mayúsculas también cuenta
  const r2 = await runTurn(second('dale mandame el presupuesto', card), { llm: fakeLlm([modelTurn({ bubbles: [CLOSING.toUpperCase().replace(',', '')] }), bien]), policy, config });
  assert.equal(r2.attempts[0].violations[0].rule, 'closing_early');
  // condicionado a los datos que faltan sí se puede: es la respuesta a "cuándo me llega?" (eval 7-oct, juez: ignoró la pregunta)
  const condicional = modelTurn({ bubbles: [`Apenas tengamos los datos que faltan. ${CLOSING}`, 'Cuántas canchas serían?'] });
  const r3 = await runTurn(second('me lo mandan hoy?', card), { llm: fakeLlm([condicional]), policy, config });
  assert.deepEqual(r3.attempts[0].violations, []);
  assert.deepEqual(r3.handoffs, []);
});

test('el cierre no se exige mientras faltan datos', async () => {
  const card = cardWith(['platea', 'ubicacion']);
  const history = [msg('m1', 'customer', 'tengo platea'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'tengo platea')];
  const r = await runTurn(
    input(history, ['m3'], card),
    { llm: fakeLlm([modelTurn({ bubbles: ['Perfecto. Va a ser techada o al aire libre?'], lead_patch: [{ field: 'platea', value: 'tiene', evidence_msg_id: 'm3' }] })]), policy, config },
  );
  assert.equal(r.attempts.length, 1);
  assert.equal(r.card.state, 'calificando');
  assert.equal(r.stopBot, false);
});

test('material que no existe en assets → reintento; el válido se devuelve', async () => {
  const r = await runTurn(
    second('mandame fotos'),
    { llm: fakeLlm([modelTurn({ bubbles: ['Te paso fotos.'], material: ['foto_inventada'] }), modelTurn({ bubbles: ['Te paso unas fotos de cómo fabricamos.'], material: ['fabricacion_panos'] })]), policy, config },
  );
  assert.equal(r.attempts[0].violations[0].rule, 'material');
  assert.deepEqual(r.material, ['fabricacion_panos']);
});

test('el controlador corre sobre los globos: si preguntan por la IA y no la confirma, reintenta', async () => {
  const r = await runTurn(
    second('sos un bot?'),
    { llm: fakeLlm([withSignals({ asked_if_ai: true }, { bubbles: ['Somos Olimpo Padel, contame.'] }), withSignals({ asked_if_ai: true }, { bubbles: ['Sí, soy el asistente virtual de Olimpo Padel. Si querés te paso con alguien del equipo.'] })]), policy, config },
  );
  assert.equal(r.attempts[0].violations[0].rule, 'ai_disclosure');
  assert.equal(r.attempts.length, 2);
});

test('el patch se aplica: evidencia falsa se rechaza y se avisa; estado y temperatura se recalculan', async () => {
  const rejected: unknown[] = [];
  const turn = modelTurn({
    bubbles: ['Perfecto Pedro. En qué zona serían?'],
    lead_patch: [
      { field: 'nombre', value: 'Pedro', evidence_msg_id: 'm3' },
      { field: 'localidad', value: 'Pilar', evidence_msg_id: 'm2' }, // m2 es del bot
      { field: 'cantidad_canchas', value: '5', evidence_msg_id: 'm3' }, // m3 no dice 5
    ],
    objections: ['precio', 'plazo'],
    team_note: 'Viene comparando precios',
  });
  const r = await runTurn(second('Soy Pedro, quiero 2 canchas'), { llm: fakeLlm([turn]), policy, config, onRejected: (x) => rejected.push(...x) });
  assert.deepEqual(r.card.fields, { nombre: { value: 'Pedro', evidenceMsgId: 'm3' } });
  assert.equal(rejected.length, 2);
  assert.equal(r.card.state, 'calificando');
  assert.equal(r.card.temperature, 'frio');
  assert.deepEqual(r.card.objections, ['precio', 'plazo']);
  assert.equal(r.card.teamNote, 'Viene comparando precios');
  // un segundo turno no duplica objeciones
  const r2 = await runTurn(second('ok', r.card), { llm: fakeLlm([modelTurn({ bubbles: ['Dale. En qué zona serían?'], objections: ['precio'] })]), policy, config });
  assert.deepEqual(r2.card.objections, ['precio', 'plazo']);
  assert.equal(r2.card.teamNote, 'Viene comparando precios'); // nota vacía no borra la anterior
});

test('"son los de Elite?": el bot contesta y se frena el chat', async () => {
  const r = await runTurn(second('Ustedes no son los de Elite?'), { llm: fakeLlm([modelTurn({ bubbles: ['No, somos Olimpo Padel, una empresa aparte.'] })]), policy, config });
  assert.deepEqual(r.bubbles, ['No, somos Olimpo Padel, una empresa aparte.']);
  assert.deepEqual(r.handoffs, [{ reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }]);
  assert.equal(r.stopBot, true);
  assert.equal(r.card.state, 'derivado');
});

test('"son los de Elite?": el bot tiene que decir el texto aprobado (si no, violación elite_answer); "club de élite" no lo exige', async () => {
  const ELITE_TEXT = parse(policy.yamlText).marca_nueva.son_los_de_elite.texto;
  assert.equal(policy.eliteAnswerText, ELITE_TEXT);
  assert.equal(ELITE_TEXT, 'No, somos Olimpo Padel, una empresa aparte.');
  const mala = modelTurn({ bubbles: ['Sí, somos los mismos de antes, ahora con otro nombre.'] });
  const buena = modelTurn({ bubbles: [ELITE_TEXT] });
  const r = await runTurn(second('Ustedes no son los de Elite?'), { llm: fakeLlm([mala, buena]), policy, config });
  assert.equal(r.attempts[0].violations[0].rule, 'elite_answer');
  assert.deepEqual(r.bubbles, [ELITE_TEXT]);
  assert.deepEqual(r.handoffs, [{ reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }]);
  // sin mayúsculas, tildes ni puntuación también vale, y en cualquiera de los dos globos
  const r2 = await runTurn(second('son los de e_l_i_t_e?'), { llm: fakeLlm([modelTurn({ bubbles: ['Dale, te cuento.', 'no somos olimpo padel una empresa aparte'] })]), policy, config });
  assert.equal(r2.attempts.length, 1);
  // "club de élite" es un adjetivo: el bot sigue normal, sin ese texto
  const club = await runTurn(second('queremos un club de élite'), { llm: fakeLlm([modelTurn({ bubbles: ['Excelente. En qué zona sería?'] })]), policy, config });
  assert.equal(club.attempts.length, 1);
  assert.deepEqual(club.handoffs, []);
});

test('cliente grande: avisa pero el bot sigue, y no repite el aviso', async () => {
  const history = [msg('m1', 'customer', 'Hola'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'tengo un club con 3 canchas')];
  const turn = modelTurn({ bubbles: ['Excelente. Qué modelo te interesa para las 3?'], lead_patch: [{ field: 'cantidad_canchas', value: '3', evidence_msg_id: 'm3' }] });
  const r = await runTurn(input(history, ['m3']), { llm: fakeLlm([turn]), policy, config });
  assert.deepEqual(r.handoffs, [{ reason: 'cliente_grande', priority: 'alta', mode: 'flag' }]);
  assert.equal(r.stopBot, false);
  const next = [...history, msg('m4', 'bot', 'Excelente. Qué modelo te interesa para las 3?'), msg('m5', 'customer', 'la Panorámica')];
  const r2 = await runTurn(input(next, ['m5'], r.card), { llm: fakeLlm([modelTurn({ bubbles: ['Dale. En qué zona serían?'] })]), policy, config });
  assert.deepEqual(r2.handoffs, []);
});

test('regateo: avisa la 1.ª vez y frena la 2.ª (cuenta en la ficha)', async () => {
  const t = withSignals({ negotiating: true }, { bubbles: ['Es entendible. En qué zona sería la cancha?'] });
  const r1 = await runTurn(second('me hacés 18.000?'), { llm: fakeLlm([t]), policy, config });
  assert.deepEqual(r1.handoffs, [{ reason: 'regateo', priority: 'normal', mode: 'flag' }]);
  assert.equal(r1.stopBot, false);
  assert.equal(r1.card.flags.negotiatingCount, 1);
  const r2 = await runTurn(second('dale 18.000 y cerramos', r1.card), { llm: fakeLlm([withSignals({ negotiating: true }, { bubbles: ['Eso lo ve el equipo con vos, ya les aviso.'] })]), policy, config });
  assert.deepEqual(r2.handoffs, [{ reason: 'regateo', priority: 'normal', mode: 'stop' }]);
  assert.equal(r2.stopBot, true);
  assert.equal(r2.card.flags.negotiatingCount, 2);
  assert.equal(r2.card.state, 'derivado');
});

test('un handoff_request de pide_persona del modelo no tapa el stop del turno siguiente cuando el cliente sí pide una persona', async () => {
  const t1 = modelTurn({ bubbles: ['Anotado. En qué zona sería?'], handoff_request: { reason: 'pide_persona', priority: 'normal' } });
  const r1 = await runTurn(second('hola'), { llm: fakeLlm([t1]), policy, config });
  assert.deepEqual(r1.handoffs, []);
  assert.equal(r1.stopBot, false);
  const t2 = withSignals({ asks_human: true }, { bubbles: ['Ya le aviso al equipo para que te escriba una persona.'] });
  const r2 = await runTurn(second('quiero hablar con una persona', r1.card), { llm: fakeLlm([t2]), policy, config });
  assert.deepEqual(r2.handoffs, [{ reason: 'pide_persona', priority: 'normal', mode: 'stop' }]);
  assert.equal(r2.stopBot, true);
});

test('la parte fija (instructions) es idéntica entre turnos y entre clientes distintos', async () => {
  const llm = fakeLlm([modelTurn(), modelTurn({ bubbles: ['Anotado. En qué zona sería?'] })]);
  const clienteA = first('Hola, soy Pedro de Pilar');
  const clienteB = { ...second('Hola, quiero 3 canchas', cardWith(['platea'])), conversationId: 'c2', nowUtcMs: argentinaTimeToUtcMs('23:30', MORNING_UTC) };
  await runTurn(clienteA, { llm, policy, config });
  await runTurn(clienteB, { llm, policy, config });
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].instructions, llm.calls[1].instructions);
  assert.notEqual(llm.calls[0].input, llm.calls[1].input);
  assert.equal(llm.calls[0].instructions, buildInstructions(policy));
});

test('los textos fijos (baja y mensaje seguro) pasan el controlador', () => {
  for (const t of [OPT_OUT_TEXT, FALLBACK_TEXT]) {
    assert.deepEqual(supervise({ bubbles: [t], askedIfAi: false }, [], policy.supervisorPolicy), [], t);
  }
});

test('un dato con la hora o el nombre del cliente no entra en la parte fija', async () => {
  const llm = fakeLlm([modelTurn()]);
  await runTurn(first('Soy Zacarías Pérez'), { llm, policy, config });
  assert.doesNotMatch(llm.calls[0].instructions, /Zacarías/);
  assert.match(llm.calls[0].input, /Zacarías/);
});

test('una ficha con datos previos no se vuelve a preguntar: va en el contexto', async () => {
  const llm = fakeLlm([modelTurn({ bubbles: ['Anotado. Cuántas canchas serían?'] })]);
  await runTurn(second('ok', { ...emptyCard(), fields: { nombre: field('Pedro', 'm1') } }), { llm, policy, config });
  assert.match(llm.calls[0].input, /nombre = Pedro/);
  assert.match(llm.calls[0].input, /datos_que_faltan: localidad, provincia/);
});

test('el cliente pregunta si es un bot y el modelo olvida la señal: el controlador igual exige "asistente virtual"', async () => {
  const r = await runTurn(
    second('che, sos un bot?'),
    { llm: fakeLlm([modelTurn({ bubbles: ['Somos Olimpo Padel, contame.'] }), modelTurn({ bubbles: ['Sí, soy el asistente virtual de Olimpo Padel. Si querés te paso con alguien del equipo.'] })]), policy, config },
  );
  assert.equal(r.attempts[0].violations[0].rule, 'ai_disclosure');
  assert.equal(r.attempts.length, 2);
});

test('con un render en el material, el bot no puede decir que la cancha la hicieron ellos', async () => {
  const mala = modelTurn({ bubbles: ['Te paso fotos. Sí, la hicimos nosotros en Escobar.'], material: ['modelo_full_panoramica'] });
  const buena = modelTurn({ bubbles: ['Así queda la Full Panorámica.'], material: ['modelo_full_panoramica'] });
  const r = await runTurn(second('mandame fotos'), { llm: fakeLlm([mala, buena]), policy, config });
  assert.ok(r.attempts[0].violations.some((x) => x.rule === 'fake_work'));
  assert.deepEqual(r.bubbles, buena.bubbles);
  // sin render, el mismo texto de un material real no se bloquea por este motivo
  const real = await runTurn(second('mandame fotos'), { llm: fakeLlm([modelTurn({ bubbles: ['Te paso fotos de un techado que hicimos.'], material: ['obra_techado'] })]), policy, config });
  assert.equal(real.attempts.length, 1);
});

// ---------- Ronda de fixes: estados terminales y baja ----------
test('ficha en baja, no_es_cliente, derivado o descartado: sin globos, sin llamar al modelo, sin derivaciones', async () => {
  for (const state of ['baja', 'no_es_cliente', 'derivado', 'descartado'] as const) {
    const llm = fakeLlm([modelTurn({ bubbles: ['Hola de nuevo, querés el presupuesto?'] })]);
    const card = { ...emptyCard(), state };
    const r = await runTurn(second('hola, sigo acá', card), { llm, policy, config });
    assert.equal(llm.calls.length, 0, state);
    assert.deepEqual(r.bubbles, [], state);
    assert.deepEqual(r.material, [], state);
    assert.deepEqual(r.handoffs, [], state);
    assert.equal(r.stopBot, true, state);
    assert.equal(r.card.state, state);
    assert.equal(r.attempts.length, 0);
  }
});

test('"No me escriban más" con la señal en false: igual es baja (texto fijo, sin llamar al modelo) y después el chat queda callado', async () => {
  const llm = fakeLlm([modelTurn({ bubbles: ['Dale, te paso el presupuesto?'] })]); // el modelo no marcó opt_out
  const r = await runTurn(second('No me escriban más'), { llm, policy, config });
  assert.deepEqual(r.bubbles, [OPT_OUT_TEXT]);
  assert.equal(r.card.state, 'baja');
  assert.equal(r.stopBot, true);
  assert.deepEqual(r.handoffs, [{ reason: 'baja', priority: 'baja', mode: 'stop' }]);
  assert.deepEqual(r.material, []);
  assert.equal(llm.calls.length, 0);
  const after = await runTurn(second('che, escribime igual', r.card), { llm, policy, config });
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(after.bubbles, []);
  assert.deepEqual(after.handoffs, []);
});

test('respaldo de baja por texto: variantes, y "baja" como adjetivo no corta la charla', async () => {
  for (const t of ['dejen de escribir', 'no me manden más', 'Borren mi número por favor', 'dame de baja', 'baja', 'no me escribas más']) {
    const r = await runTurn(second(t), { llm: fakeLlm([modelTurn({ bubbles: ['Anotado. En qué zona sería?'] })]), policy, config });
    assert.equal(r.card.state, 'baja', t);
  }
  // condiciones o pedidos que no son baja (eval 7-oct: "No me manden presupuesto hasta…" cortaba a un cliente que esperaba info)
  for (const t of [
    'el galpón tiene una altura baja', 'tengo un galpón de baja altura', 'No me manden presupuesto hasta tener esos datos concretos',
    'no me escriban hasta que tengan la dirección del taller', 'No me llamen, prefiero por acá',
  ]) {
    const r = await runTurn(second(t), { llm: fakeLlm([modelTurn({ bubbles: ['Anotado. En qué zona sería?'] })]), policy, config });
    assert.notEqual(r.card.state, 'baja', t);
  }
});

test('pide_verificacion de punta a punta: sin señal de desconfianza en el texto no frena (aunque el modelo repita "confianza"); con taller u obras, sí', async () => {
  const card: LeadCard = { ...emptyCard(), objections: ['confianza'] };
  const turn = modelTurn({ bubbles: ['Anotado. En qué zona sería?'], objections: ['precio', 'confianza'] });
  const r1 = await runTurn(second('ok y cuánto sale?', card), { llm: fakeLlm([turn]), policy, config });
  assert.deepEqual(r1.handoffs, []);
  assert.equal(r1.stopBot, false);
  const r2 = await runTurn(second('y dónde queda el taller? quiero ver una obra', card), { llm: fakeLlm([turn]), policy, config });
  assert.deepEqual(r2.handoffs, [{ reason: 'pide_verificacion', priority: 'alta', mode: 'stop' }]);
  assert.equal(r2.stopBot, true);
});

test('respaldo de baja por texto (2.ª ronda): con condiciones o redirecciones ("pero sigo", "mejor por acá", "hasta que") no fuerza la baja; la señal del modelo decide', async () => {
  const run = (t: string, signals: Partial<ReturnType<typeof modelTurn>['signals']> = {}) =>
    runTurn(second(t), { llm: fakeLlm([withSignals(signals, { bubbles: ['Anotado. En qué zona sería?'] })]), policy, config });
  for (const t of [
    'no me contacten por teléfono, mejor por acá', 'no me escribas por mail, sólo por acá', 'no me escribas a la noche, a la mañana sí',
    'Dejen de mandarme tantas fotos pero sigo interesado', 'no me mandes nada hasta que hable con mi socio',
    'No me manden más fotos', 'Dejen de mandarme tantas fotos',
  ]) {
    const r = await run(t);
    assert.notEqual(r.card.state, 'baja', t);
    assert.equal(r.stopBot, false, t);
    // y si el modelo sí marca opt_out, la señal manda
    const s = await run(t, { opt_out: true });
    assert.equal(s.card.state, 'baja', `con la señal: ${t}`);
  }
  for (const t of ['No me escriban más', 'dejen de escribir', 'no me manden más', 'Borren mi número por favor', 'dame de baja', 'baja', 'no me escribas más', 'basta, no me escriban']) {
    assert.equal((await run(t)).card.state, 'baja', t);
  }
});

test('baja o no es cliente: no se aplica el lead_patch ni los contadores, y no sale ninguna otra derivación', async () => {
  const patch = [{ field: 'nombre' as const, value: 'Pedro', evidence_msg_id: 'm3' }, { field: 'cantidad_canchas' as const, value: '3', evidence_msg_id: 'm3' }];
  const rest = { negotiating: true, angry: true, asks_human: true, off_knowledge: true };
  const c1 = await runTurn(second('Soy Pedro, 3 canchas, pero ya no quiero saber nada'), { llm: fakeLlm([withSignals({ ...rest, opt_out: true }, { bubbles: [], lead_patch: patch })]), policy, config });
  assert.deepEqual(c1.handoffs, [{ reason: 'baja', priority: 'baja', mode: 'stop' }]);
  assert.deepEqual(c1.card.fields, {});
  assert.deepEqual(c1.card.flags, { negotiatingCount: 0, offKnowledgeCount: 0 });
  assert.equal(c1.card.state, 'baja');
  const c2 = await runTurn(second('Soy Pedro, 3 canchas, les ofrezco hierro'), { llm: fakeLlm([withSignals({ ...rest, not_a_lead: true }, { bubbles: [], lead_patch: patch })]), policy, config });
  assert.deepEqual(c2.handoffs, [{ reason: 'no_es_cliente', priority: 'normal', mode: 'stop' }]);
  assert.deepEqual(c2.card.fields, {});
  assert.deepEqual(c2.bubbles, []); // no_es_cliente sigue callado
  assert.equal(c2.card.state, 'no_es_cliente');
});

test('material: se sacan los repetidos y salen como mucho 2 por turno', async () => {
  const r = await runTurn(second('mandame fotos'), {
    llm: fakeLlm([modelTurn({ bubbles: ['Te paso unas fotos de cómo fabricamos.'], material: ['fabricacion_panos', 'fabricacion_panos', 'modelo_full_panoramica', 'modelo_panoramica'] })]),
    policy, config,
  });
  assert.deepEqual(r.material, ['fabricacion_panos', 'modelo_full_panoramica']);
  assert.equal(r.attempts.length, 1);
});

test('el mensaje seguro es el de la política (si_el_bot_falla.texto) y pasa el controlador', () => {
  const texto = parse(policy.yamlText).si_el_bot_falla.texto;
  assert.equal(texto, 'Gracias por escribirnos, ya le paso tu consulta al equipo.');
  assert.equal(FALLBACK_TEXT, texto);
  assert.deepEqual(supervise({ bubbles: [FALLBACK_TEXT], askedIfAi: false }, [], policy.supervisorPolicy), []);
});

test('altura: techada con menos de 7 m (o sin dato) el bot no dice que entra; la altura queda en la ficha y en la nota para el equipo', async () => {
  const history = [msg('m1', 'customer', 'Hola'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'La quiero techada, tengo un galpón de 6 m de alto, entra?')];
  const patch = [{ field: 'ubicacion' as const, value: 'techada', evidence_msg_id: 'm3' }, { field: 'altura_libre_m' as const, value: '6', evidence_msg_id: 'm3' }];
  const mala = modelTurn({ bubbles: ['Sí, entra perfecto.'], lead_patch: patch });
  const buena = modelTurn({ bubbles: ['Eso lo revisa el equipo en el presupuesto. Cuántas canchas serían?'], lead_patch: patch });
  const r = await runTurn(input(history, ['m3']), { llm: fakeLlm([mala, buena]), policy, config });
  assert.ok(r.attempts[0].violations.some((x) => x.rule === 'height'));
  assert.deepEqual(r.bubbles, buena.bubbles);
  assert.equal(r.card.fields.altura_libre_m?.value, '6');
  assert.match(r.card.teamNote, /altura libre 6 m/i);
  // sin dato de altura tampoco puede decir que entra
  const sinDato = await runTurn(second('entra una cancha en mi galpón?'), { llm: fakeLlm([modelTurn({ bubbles: ['Sí, entra.'] }), buena]), policy, config });
  assert.ok(sinDato.attempts[0].violations.some((x) => x.rule === 'height'));
  // con 7 m o más bajo techo, sí se puede
  const ok = [msg('m1', 'customer', 'Hola'), msg('m2', 'bot', GREETING_TEXT), msg('m3', 'customer', 'La quiero techada, el galpón tiene 8 m libres, entra?')];
  const patch8 = [{ field: 'ubicacion' as const, value: 'techada', evidence_msg_id: 'm3' }, { field: 'altura_libre_m' as const, value: '8', evidence_msg_id: 'm3' }];
  const alto = await runTurn(input(ok, ['m3']), { llm: fakeLlm([modelTurn({ bubbles: ['Sí, entra. Cuántas canchas serían?'], lead_patch: patch8 })]), policy, config });
  assert.equal(alto.attempts.length, 1);
  assert.doesNotMatch(alto.card.teamNote, /altura/i);
});

test('altura (2.ª ronda): techada con 6 m o sin dato, "con esa altura entra" y variantes se rechazan; con 8 m pasa', async () => {
  const techada: LeadCard = { ...emptyCard(), fields: { ubicacion: field('techada', 'm1') } };
  const buena = modelTurn({ bubbles: ['El equipo lo revisa en el presupuesto. Cuántas canchas serían?'] });
  for (const bubble of ['Sí, con esa altura entra', 'Con 6 m entra', 'La cancha entra tranquilamente', 'Va a entrar sin problemas']) {
    // la ficha ya dice techada, el cliente habla del galpón (altura 6 o sin dato)
    const r = await runTurn(second('tengo un galpón de 6 m, entra?', techada), { llm: fakeLlm([modelTurn({ bubbles: [bubble] }), buena]), policy, config });
    assert.ok(r.attempts[0].violations.some((x) => x.rule === 'height'), bubble);
    assert.deepEqual(r.bubbles, buena.bubbles);
    // techada y sin hablar de altura: igual, porque la ficha dice techada
    const r2 = await runTurn(second('y entra?', techada), { llm: fakeLlm([modelTurn({ bubbles: [bubble] }), buena]), policy, config });
    assert.ok(r2.attempts[0].violations.some((x) => x.rule === 'height'), `ficha techada: ${bubble}`);
  }
  // con la altura en 8 m (techada) puede decir que entra
  const alta: LeadCard = { ...techada, fields: { ...techada.fields, altura_libre_m: field('8', 'm1') } };
  const ok = await runTurn(second('entra?', alta), { llm: fakeLlm([modelTurn({ bubbles: ['Sí, entra tranquilamente. Cuántas canchas serían?'] })]), policy, config });
  assert.equal(ok.attempts.length, 1);
});

test('fuera de política: avisa una vez y el bot sigue; nunca lo frena (ni con financiación ni con preguntas de otros países)', async () => {
  const t = withSignals({ off_knowledge: true }, { bubbles: ['Eso va en el presupuesto y lo podés charlar con el equipo. En qué zona sería?'] });
  const r1 = await runTurn(second('tienen financiación?'), { llm: fakeLlm([t]), policy, config });
  assert.deepEqual(r1.handoffs, [{ reason: 'fuera_de_politica', priority: 'normal', mode: 'flag' }]);
  assert.equal(r1.stopBot, false);
  const r2 = await runTurn(second('y para Chile?', r1.card), { llm: fakeLlm([t]), policy, config });
  assert.deepEqual(r2.handoffs, []);
  assert.equal(r2.stopBot, false);
  assert.notEqual(r2.card.state, 'derivado');
});

test('respaldo de baja por texto (3.ª ronda): horarios, "por ahora", "todavía", "cuando", "yo les aviso" y mensajes largos no fuerzan la baja; la señal del modelo decide', async () => {
  const run = (t: string, signals: Partial<ReturnType<typeof modelTurn>['signals']> = {}) =>
    runTurn(second(t), { llm: fakeLlm([withSignals(signals, { bubbles: ['Anotado. En qué zona sería?'] })]), policy, config });
  const long = 'Hola, justo estoy en una reunión larga con los dueños del club y por eso les pido que no me escriban más';
  assert.ok(long.length > 80);
  for (const t of [
    'No me escriban los fines de semana', 'No me escriban de noche', 'No me escriban antes de las 9', 'No me manden nada por ahora, yo les aviso cuando decida',
    'no me manden nada todavía, lo hablo con mi socio', 'no me escriban después de las 20', 'No me escriban cuando estoy trabajando', 'aviso yo, no me manden nada', long,
  ]) {
    const r = await run(t);
    assert.notEqual(r.card.state, 'baja', t);
    assert.equal(r.stopBot, false, t);
    assert.equal((await run(t, { opt_out: true })).card.state, 'baja', `con la señal: ${t}`);
  }
  for (const t of ['No me escriban más', 'dejen de escribir', 'no me manden nada más, gracias', 'Borren mi número por favor', 'dame de baja', 'baja', 'no me molesten más']) {
    assert.equal((await run(t)).card.state, 'baja', t);
  }
});
