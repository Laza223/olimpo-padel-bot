// Cliente simulado y juez con un cliente de OpenAI falso: el pedido que arman, el costo que anotan y cómo fallan. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';
import { costUsd } from '../src/brain.ts';
import { emptyCard } from '../src/lead.ts';
import { loadPolicy } from '../src/policy.ts';
import { buildCustomerInput, buildCustomerInstructions, CUSTOMER_MODEL, OpenAiCustomer, parseCustomerReply } from '../evals/customer.ts';
import { buildJudgeInput, buildJudgeInstructions, JUDGE_MODEL, OpenAiJudge, parseVerdict, renderCard, renderTranscript, VERDICT_SCHEMA } from '../evals/judge.ts';
import { CallError, JUDGE_CRITICALS, JUDGE_SCORES } from '../evals/types.ts';
import type { Persona } from '../evals/scenario.ts';
import { msg } from './helpers.ts';
import { turnLog, verdict } from './evals-helpers.ts';

const policy = loadPolicy();
type Body = Record<string, unknown>;
function fakeOpenAi(response: unknown) {
  const bodies: Body[] = [];
  const client = { responses: { create: async (body: Body) => (bodies.push(body), response) } } as unknown as OpenAI;
  return { client, bodies };
}
const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 400 }, output_tokens: 50 };

const persona: Persona = {
  perfil: 'Inversor de 45 años con galpón en Escobar',
  datos_ocultos: { nombre: 'Pedro', cantidad_canchas: '2' },
  estilo: 'mensajes cortos, sin signos',
  objetivo: 'conseguir el presupuesto',
};

// ---------- Cliente simulado ----------
test('instrucciones del cliente: persona, datos, estilo, objetivo y la marca de cierre', () => {
  const ins = buildCustomerInstructions(persona);
  for (const piece of [persona.perfil, '- nombre: Pedro', '- cantidad_canchas: 2', persona.estilo, persona.objetivo, '[FIN]', 'rioplatense']) assert.ok(ins.includes(piece), piece);
  assert.doesNotMatch(ins, /POLÍTICA|REGLAS DURAS/); // el cliente no sabe nada de las reglas del bot
});

test('entrada del cliente: primer mensaje, o la charla con "Vos" y "Empresa" (sin equipo ni sistema)', () => {
  assert.match(buildCustomerInput([]), /Escribí tu primer mensaje/);
  const history = [msg('m1', 'customer', 'Hola\ninfo'), msg('m2', 'bot', 'Buen día'), msg('m3', 'team', 'secreto'), msg('m4', 'system', 'interno')];
  const inp = buildCustomerInput(history);
  assert.match(inp, /^Vos: Hola info\nEmpresa: Buen día\n\n/);
  assert.doesNotMatch(inp, /secreto|interno/);
});

test('parseCustomerReply: [FIN], ráfagas y comillas', () => {
  assert.deepEqual(parseCustomerReply('[FIN]'), { fin: true, messages: [] });
  assert.deepEqual(parseCustomerReply('Dale, gracias [FIN]'), { fin: true, messages: ['Dale, gracias'] });
  assert.deepEqual(parseCustomerReply('hola || "quiero 2 canchas"'), { fin: false, messages: ['hola', 'quiero 2 canchas'] });
  assert.deepEqual(parseCustomerReply('  '), { fin: false, messages: [] });
});

test('OpenAiCustomer: pide a gpt-6-luna sin guardar nada y anota el costo con la tabla de precios', async () => {
  const { client, bodies } = fakeOpenAi({ status: 'completed', output_text: '  Hola, quiero 2 canchas  ', usage });
  const r = await new OpenAiCustomer(client).reply({ persona, history: [] });
  assert.equal(r.text, 'Hola, quiero 2 canchas');
  assert.equal(r.costUsd, costUsd('gpt-6-luna', { inputTokens: 1000, cachedTokens: 400, outputTokens: 50 }));
  const b = bodies[0] as Body & { reasoning: Body };
  assert.equal(b.model, CUSTOMER_MODEL);
  assert.equal(b.model, 'gpt-6-luna');
  assert.equal(b.store, false);
  assert.deepEqual(b.reasoning, { effort: 'low' });
  assert.equal(b.instructions, buildCustomerInstructions(persona));
  assert.match(String(b.input), /primer mensaje/);
  assert.equal(b.text, undefined); // texto libre, no JSON
});

test('OpenAiCustomer: respuesta vacía o incompleta falla con el costo ya gastado', async () => {
  for (const [name, response, re] of [
    ['vacía', { status: 'completed', output_text: '  ', usage }, /vacía/],
    ['incompleta', { status: 'incomplete', output_text: 'ho', usage }, /no terminó \(incomplete\)/],
    ['fallida', { status: 'failed', output_text: '', usage }, /no terminó \(failed\)/],
  ] as const) {
    const { client } = fakeOpenAi(response);
    await assert.rejects(new OpenAiCustomer(client).reply({ persona, history: [] }), (e: unknown) => {
      assert.ok(e instanceof CallError, name);
      assert.match((e as Error).message, re, name);
      assert.equal((e as CallError).costUsd, costUsd('gpt-6-luna', { inputTokens: 1000, cachedTokens: 400, outputTokens: 50 }), name);
      return true;
    });
  }
});

// ---------- Juez ----------
type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; enum?: unknown[] };
function checkStrict(s: Schema, path: string) {
  if (s.type === 'object') {
    assert.equal(s.additionalProperties, false, `${path}: additionalProperties`);
    assert.deepEqual([...(s.required ?? [])].sort(), Object.keys(s.properties ?? {}).sort(), `${path}: required = todas las propiedades`);
    for (const [k, v] of Object.entries(s.properties ?? {})) checkStrict(v, `${path}.${k}`);
  }
}

test('el esquema del veredicto es estricto y tiene los 6 puntajes, los 5 críticos y el comentario', () => {
  checkStrict(VERDICT_SCHEMA as Schema, 'veredicto');
  const props = (VERDICT_SCHEMA as Schema).properties!;
  assert.deepEqual(Object.keys(props).sort(), [...JUDGE_SCORES, 'critico', 'comentario'].sort());
  assert.deepEqual(JUDGE_SCORES, ['flujo_venta', 'honestidad', 'objeciones', 'tono', 'una_pregunta', 'momento_derivar']);
  assert.deepEqual(JUDGE_CRITICALS, ['invento_dato', 'mintio', 'presiono', 'dijo_dato_interno', 'ignoro_pregunta']);
  assert.deepEqual(Object.keys(props.critico.properties!), [...JUDGE_CRITICALS]);
  for (const k of JUDGE_SCORES) assert.deepEqual(props[k], { type: 'integer', enum: [1, 2, 3, 4, 5] }, k);
});

test('instrucciones del juez: la rúbrica, la política completa (con lo interno), el tono y los assets; sin nada de una conversación', () => {
  const ins = buildJudgeInstructions(policy);
  for (const piece of [...JUDGE_SCORES, ...JUDGE_CRITICALS, policy.yamlText.trim(), policy.toneText.trim(), 'instalacion_usd_por_cancha', ...policy.assets.map((a) => a.id)]) assert.ok(ins.includes(piece), piece);
  assert.equal(buildJudgeInstructions(policy), ins); // fija: el caché del prefijo sirve entre conversaciones
});

const turns = [
  turnLog({ turn: 1, customer: ['Hola', 'quiero info'], bubbles: ['Buen día, te escribimos de Olimpo Padel.', 'Contame, de dónde sos?'], material: ['fabricacion_panos'] }),
  turnLog({ turn: 2, customer: ['Ustedes no son los de Elite?'], bubbles: ['No, somos Olimpo Padel, una empresa aparte.'], handoffs: [{ reason: 'pregunta_por_empresa_anterior', priority: 'normal', mode: 'stop' }], stopBot: true }),
  turnLog({ turn: 3, customer: ['les vendo hierro'], bubbles: [] }),
  turnLog({ turn: 4, customer: ['hola'], bubbles: ['Gracias por escribirnos. En un rato te respondemos por acá.'], usedFallback: true, handoffs: [{ reason: 'falla_del_bot', priority: 'alta', mode: 'stop' }] }),
];

test('transcripción: lo que vio el cliente y lo que pasó por detrás', () => {
  assert.equal(
    renderTranscript(turns),
    [
      '[turno 1] cliente: Hola',
      '[turno 1] cliente: quiero info',
      '[turno 1] olimpo: Buen día, te escribimos de Olimpo Padel.',
      '[turno 1] olimpo: Contame, de dónde sos?',
      '[turno 1] [sistema] se manda el material fabricacion_panos',
      '[turno 2] cliente: Ustedes no son los de Elite?',
      '[turno 2] olimpo: No, somos Olimpo Padel, una empresa aparte.',
      '[turno 2] [sistema] aviso al equipo: pregunta_por_empresa_anterior (prioridad normal; el bot deja de responder)',
      '[turno 3] cliente: les vendo hierro',
      '[turno 3] olimpo no manda nada',
      '[turno 4] cliente: hola',
      '[turno 4] olimpo (mensaje seguro: el bot falló dos veces): Gracias por escribirnos. En un rato te respondemos por acá.',
      '[turno 4] [sistema] aviso al equipo: falla_del_bot (prioridad alta; el bot deja de responder)',
    ].join('\n'),
  );
  const card = { ...emptyCard(), state: 'calificando' as const, fields: { nombre: { value: 'Pedro', evidenceMsgId: 'm1' } } };
  assert.match(renderCard(card), /^estado calificando · frio · nombre=Pedro · faltan: localidad, provincia/);
  const inp = buildJudgeInput({ hora: '23:00', turns: turns.slice(0, 1), finalCard: card });
  assert.match(inp, /^Hora argentina del primer mensaje del cliente: 23:00\n\n<conversacion>\n\[turno 1\] cliente: Hola/);
  assert.match(inp, /<\/conversacion>\n\nFicha al final: estado calificando/);
});

test('parseVerdict: acepta un veredicto completo y rechaza JSON roto, puntajes fuera de rango o críticos que faltan', () => {
  const v = verdict(4, { critico: { mintio: true }, comentario: 'Mintió en el turno 2.' });
  assert.deepEqual(parseVerdict(JSON.stringify(v)), v);
  assert.throws(() => parseVerdict('hola'), /no devolvió JSON/);
  assert.throws(() => parseVerdict(JSON.stringify({ ...v, tono: 6 })), /esquema/);
  assert.throws(() => parseVerdict(JSON.stringify({ ...v, tono: 0 })), /esquema/);
  assert.throws(() => parseVerdict(JSON.stringify({ ...v, tono: 3.5 })), /esquema/);
  assert.throws(() => parseVerdict(JSON.stringify({ ...v, critico: { mintio: true } })), /esquema/);
  assert.throws(() => parseVerdict(JSON.stringify({ ...v, comentario: undefined })), /esquema/);
  assert.throws(() => parseVerdict('null'), /esquema/);
});

test('OpenAiJudge: pide a gpt-6-astra (low) con esquema estricto y anota el costo con la tabla de precios', async () => {
  const v = verdict(5, { comentario: 'Todo bien.' });
  const { client, bodies } = fakeOpenAi({ status: 'completed', output_text: JSON.stringify(v), usage });
  const input = { hora: '15:00', turns: turns.slice(0, 2), finalCard: emptyCard() };
  const r = await new OpenAiJudge(client, policy).evaluate(input);
  assert.deepEqual(r.verdict, v);
  assert.equal(r.costUsd, costUsd('gpt-6-astra', { inputTokens: 1000, cachedTokens: 400, outputTokens: 50 }));
  const b = bodies[0] as Body & { text: { format: Body }; reasoning: Body };
  assert.equal(b.model, JUDGE_MODEL);
  assert.equal(b.model, 'gpt-6-astra');
  assert.equal(b.store, false);
  assert.deepEqual(b.reasoning, { effort: 'low' });
  assert.equal(b.instructions, buildJudgeInstructions(policy));
  assert.equal(b.input, buildJudgeInput(input));
  assert.equal(b.text.format.type, 'json_schema');
  assert.equal(b.text.format.strict, true);
  assert.equal(b.text.format.schema, VERDICT_SCHEMA);
});

test('OpenAiJudge: veredicto inválido, respuesta incompleta o fallida lanzan CallError con el costo ya gastado', async () => {
  const cost = costUsd('gpt-6-astra', { inputTokens: 1000, cachedTokens: 400, outputTokens: 50 });
  for (const [name, response, re] of [
    ['no es JSON', { status: 'completed', output_text: 'ok', usage }, /no devolvió JSON/],
    ['fuera de esquema', { status: 'completed', output_text: JSON.stringify({ tono: 5 }), usage }, /esquema/],
    ['vacía', { status: 'completed', output_text: '', usage }, /no devolvió JSON/],
    ['incompleta', { status: 'incomplete', output_text: '{"fl', usage }, /no terminó \(incomplete\)/],
    ['fallida', { status: 'failed', output_text: '', usage }, /no terminó \(failed\)/],
  ] as const) {
    const { client } = fakeOpenAi(response);
    await assert.rejects(new OpenAiJudge(client, policy).evaluate({ hora: '15:00', turns, finalCard: emptyCard() }), (e: unknown) => {
      assert.ok(e instanceof CallError, name);
      assert.match((e as Error).message, re, name);
      assert.equal((e as CallError).costUsd, cost, name);
      return true;
    });
  }
});

test('juez: pedir un "estimado" o "presupuesto" y recibir el cierre aprobado no es ignorar la pregunta; los avisos de fuera de política no frenan', () => {
  const ins = buildJudgeInstructions(policy);
  assert.match(ins, /cierre aprobado[^\n]*NO es ignoro_pregunta/);
  assert.match(ins, /fuera de la política \(aviso, el bot sigue\)/);
});
