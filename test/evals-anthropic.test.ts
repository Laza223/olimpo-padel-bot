// Banco de pruebas sobre Anthropic: cliente simulado (Haiku 5.5) y juez (Sonnet 5.5) con fetch falso, elección del proveedor de las pruebas y encabezado del reporte. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient, AnthropicLlm, STAY_IN_RULES } from '../src/anthropic.ts';
import { OpenAiLlm, TransientLlmError, costUsd } from '../src/brain.ts';
import { emptyCard } from '../src/lead.ts';
import { loadPolicy } from '../src/policy.ts';
import { ANTHROPIC_CUSTOMER_EFFORT, ANTHROPIC_CUSTOMER_MODEL, AnthropicCustomer, buildCustomerInput, buildCustomerInstructions } from '../evals/customer.ts';
import { ANTHROPIC_JUDGE_EFFORT, ANTHROPIC_JUDGE_MODEL, AnthropicJudge, VERDICT_SCHEMA, buildJudgeInput, buildJudgeInstructions } from '../evals/judge.ts';
import { makeRealDeps, parseEvalArgs, resolveEvalProvider, runEval } from '../evals/run.ts';
import { renderReport, buildSummary } from '../evals/report.ts';
import { loadScenarios, selectScenarios } from '../evals/scenario.ts';
import { runScenario } from '../evals/simulate.ts';
import { FakeLlm } from '../src/fakeLlm.ts';
import type { Persona } from '../evals/scenario.ts';
import { CallError } from '../evals/types.ts';
import { KEY, errorBody, fakeFetch, message, textMessage } from './anthropic-helpers.ts';
import type { Step } from './anthropic-helpers.ts';
import { fakeCustomer, fakeJudge, turnLog, verdict } from './evals-helpers.ts';
import { fakeLlm, modelTurn } from './helpers.ts';

const policy = loadPolicy();
const persona: Persona = {
  perfil: 'Inversor de 45 años con galpón en Escobar',
  datos_ocultos: { nombre: 'Pedro', cantidad_canchas: '2' },
  estilo: 'mensajes cortos, sin signos',
  objetivo: 'conseguir el presupuesto',
};
const usage = { input_tokens: 40, cache_read_input_tokens: 400, cache_creation_input_tokens: 560, output_tokens: 50 };
const cost = (model: string) => costUsd(model, { inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 560, outputTokens: 50 });
const clientWith = (steps: Step | Step[]) => {
  const f = fakeFetch(steps);
  return { client: new AnthropicClient({ apiKey: KEY, fetch: f.fetch, timeoutMs: 60_000 }), ...f };
};

// ---------- Cliente simulado ----------
test('AnthropicCustomer: Haiku 5.5 con esfuerzo low, texto libre (sin esquema), el costo con la tabla y las escrituras de caché', async () => {
  const { client, sent } = clientWith({ body: textMessage('  Hola, quiero 2 canchas  ', usage) });
  const r = await new AnthropicCustomer(client).reply({ persona, history: [] });
  assert.equal(r.text, 'Hola, quiero 2 canchas');
  assert.equal(r.costUsd, cost('claude-haiku-5-5'));
  const b = sent[0].body;
  assert.equal(ANTHROPIC_CUSTOMER_MODEL, 'claude-haiku-5-5');
  assert.equal(ANTHROPIC_CUSTOMER_EFFORT, 'low');
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.deepEqual(b.output_config, { effort: 'low' }); // texto libre, no JSON
  assert.deepEqual(b.system, [{ type: 'text', text: buildCustomerInstructions(persona), cache_control: { type: 'ephemeral' } }]);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].role, 'user');
  assert.equal(b.messages[0].content, buildCustomerInput([]));
  assert.match(b.messages[0].content, /primer mensaje/);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.equal(b[k], undefined, k);
  assert.doesNotMatch(JSON.stringify(b.system), new RegExp(STAY_IN_RULES.slice(0, 40))); // el párrafo del bot no es del cliente simulado
});

test('AnthropicCustomer: respuesta vacía, negativa o cortada falla con CallError y el costo ya gastado', async () => {
  const c = cost('claude-haiku-5-5');
  const cases: [string, unknown, RegExp][] = [
    ['solo espacios', textMessage('   ', usage), /vacía/],
    ['sin texto', message({ content: [{ type: 'thinking', thinking: '', signature: 's' }], usage }), /no terminó.*vacía/],
    ['cortada', message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'ho' }], usage }), /no terminó.*max_tokens/],
    ['negativa', message({ stop_reason: 'refusal', content: [], usage }), /no terminó.*se negó/],
  ];
  for (const [name, body, re] of cases) {
    const { client } = clientWith({ body });
    await assert.rejects(new AnthropicCustomer(client).reply({ persona, history: [] }), (e: unknown) => {
      assert.ok(e instanceof CallError, name);
      assert.match((e as Error).message, re, name);
      assert.equal((e as CallError).costUsd, c, name);
      return true;
    });
  }
});

test('AnthropicCustomer: un error de red o de límite no es CallError: sube como TransientLlmError', async () => {
  const { client } = clientWith({ status: 429, body: errorBody('rate_limit_error') });
  await assert.rejects(new AnthropicCustomer(client).reply({ persona, history: [] }), (e: unknown) => e instanceof TransientLlmError && e.kind === 'rate');
});

// ---------- Juez ----------
const turns = [turnLog({ turn: 1, customer: ['Hola'], bubbles: ['Buen día, te escribimos de Olimpo Padel.'] })];
const input = { hora: '15:00', turns, finalCard: emptyCard() };

test('AnthropicJudge: Sonnet 5.5 con esfuerzo low, el mismo esquema estricto del veredicto en output_config.format, y el costo con la tabla', async () => {
  const v = verdict(5, { comentario: 'Todo bien.' });
  const { client, sent } = clientWith({ body: textMessage(JSON.stringify(v), usage) });
  const r = await new AnthropicJudge(client, policy).evaluate(input);
  assert.deepEqual(r.verdict, v);
  assert.equal(r.costUsd, cost('claude-sonnet-5-5'));
  const b = sent[0].body;
  assert.equal(ANTHROPIC_JUDGE_MODEL, 'claude-sonnet-5-5');
  assert.equal(ANTHROPIC_JUDGE_EFFORT, 'low');
  assert.equal(b.model, 'claude-sonnet-5-5');
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.deepEqual(b.output_config.format.schema, VERDICT_SCHEMA);
  assert.deepEqual(b.system, [{ type: 'text', text: buildJudgeInstructions(policy), cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(b.messages, [{ role: 'user', content: buildJudgeInput(input) }]);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.equal(b[k], undefined, k);
  assert.ok(!b.system[0].text.includes(STAY_IN_RULES), 'el párrafo del chatbot no es del juez');
});

test('AnthropicJudge: veredicto inválido, negativa o respuesta cortada lanzan CallError con el costo ya gastado', async () => {
  const c = cost('claude-sonnet-5-5');
  const cases: [string, unknown, RegExp][] = [
    ['no es JSON', textMessage('ok', usage), /no devolvió JSON/],
    ['fuera de esquema', textMessage(JSON.stringify({ tono: 5 }), usage), /esquema/],
    ['cortada', message({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 's' }], usage }), /no terminó.*max_tokens/],
    ['negativa', message({ stop_reason: 'refusal', content: [], usage }), /no terminó.*se negó/],
  ];
  for (const [name, body, re] of cases) {
    const { client } = clientWith({ body });
    await assert.rejects(new AnthropicJudge(client, policy).evaluate(input), (e: unknown) => {
      assert.ok(e instanceof CallError, name);
      assert.match((e as Error).message, re, name);
      assert.equal((e as CallError).costUsd, c, name);
      return true;
    });
  }
});

// ---------- Proveedor de las pruebas ----------
test('resolveEvalProvider: lo pedido gana; si no, openai con OPENAI_API_KEY; si falta, anthropic con ANTHROPIC_API_KEY; sin ninguna, openai (falla después con "Falta OPENAI_API_KEY")', () => {
  assert.equal(resolveEvalProvider(undefined, { OPENAI_API_KEY: 'o' }), 'openai');
  assert.equal(resolveEvalProvider(undefined, { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }), 'openai');
  assert.equal(resolveEvalProvider(undefined, { ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(resolveEvalProvider(undefined, { OPENAI_API_KEY: ' ', ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(resolveEvalProvider(undefined, {}), 'openai');
  assert.equal(resolveEvalProvider('anthropic', { OPENAI_API_KEY: 'o' }), 'anthropic');
  assert.equal(resolveEvalProvider('openai', { ANTHROPIC_API_KEY: 'a' }), 'openai');
  assert.throws(() => resolveEvalProvider('gemini', {}), /--eval-provider.*anthropic.*openai/);
});

test('parseEvalArgs: --eval-provider y concurrencia por defecto 2 si cualquier modelo es de Anthropic (el bot o las pruebas), 4 si no, y --concurrency manda', () => {
  const OPENAI = { OPENAI_API_KEY: 'o' };
  assert.deepEqual(parseEvalArgs(['--eval-provider', 'anthropic'], OPENAI), { model: 'gpt-6.1-sol', effort: 'low', runs: 1, concurrency: 2, only: undefined, evalProvider: 'anthropic' });
  assert.deepEqual(parseEvalArgs(['--model', 'claude-haiku-5-5', '--effort', 'medium'], OPENAI), { model: 'claude-haiku-5-5', effort: 'medium', runs: 1, concurrency: 2, only: undefined });
  assert.equal(parseEvalArgs([], OPENAI).concurrency, 4);
  assert.equal(parseEvalArgs([], { ANTHROPIC_API_KEY: 'a' }).concurrency, 2); // sin OpenAI las pruebas corren sobre Anthropic
  assert.equal(parseEvalArgs([], { BOT_MODEL: 'claude-haiku-5-5', OPENAI_API_KEY: 'o' }).model, 'claude-haiku-5-5');
  assert.equal(parseEvalArgs([], { BOT_MODEL: 'claude-haiku-5-5', OPENAI_API_KEY: 'o' }).concurrency, 2);
  assert.equal(parseEvalArgs(['--model', 'claude-haiku-5-5', '--concurrency', '5'], OPENAI).concurrency, 5);
  assert.equal(parseEvalArgs(['--eval-provider', 'openai'], { ANTHROPIC_API_KEY: 'a' }).concurrency, 4);
  assert.throws(() => parseEvalArgs(['--eval-provider', 'gemini'], OPENAI), /--eval-provider/);
  assert.throws(() => parseEvalArgs(['--model', 'claude-haiku-5-5', '--effort', 'none'], OPENAI), /--effort.*low, medium, high, xhigh, max/); // "none" es de OpenAI
  assert.throws(() => parseEvalArgs(['--model', 'claude-haiku-5-5'], { ...OPENAI, BOT_EFFORT: 'none' }), /--effort/);
});

test('makeRealDeps: el cerebro sale del id del modelo; el cliente y el juez, del proveedor de las pruebas', () => {
  const both = { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' };
  const a = makeRealDeps(policy, { model: 'claude-haiku-5-5' }, { ANTHROPIC_API_KEY: 'a' });
  assert.ok(a.llm instanceof AnthropicLlm);
  assert.deepEqual([a.customer.label, a.judge.label], ['claude-haiku-5-5 low', 'claude-sonnet-5-5 low']);
  const b = makeRealDeps(policy, { model: 'gpt-6.1-sol' }, { OPENAI_API_KEY: 'o' });
  assert.ok(b.llm instanceof OpenAiLlm);
  assert.deepEqual([b.customer.label, b.judge.label], ['gpt-6-luna low', 'gpt-6-astra low']);
  const c = makeRealDeps(policy, { model: 'gpt-6.1-sol', evalProvider: 'anthropic' }, both); // bot de OpenAI, pruebas en Anthropic
  assert.ok(c.llm instanceof OpenAiLlm);
  assert.deepEqual([c.customer.label, c.judge.label], ['claude-haiku-5-5 low', 'claude-sonnet-5-5 low']);
  const d = makeRealDeps(policy, { model: 'claude-haiku-5-5', evalProvider: 'openai' }, both); // bot de Anthropic, pruebas en OpenAI
  assert.ok(d.llm instanceof AnthropicLlm);
  assert.deepEqual([d.customer.label, d.judge.label], ['gpt-6-luna low', 'gpt-6-astra low']);
  assert.throws(() => makeRealDeps(policy, { model: 'gpt-6.1-sol' }, {}), /Falta OPENAI_API_KEY/);
  assert.throws(() => makeRealDeps(policy, { model: 'claude-haiku-5-5' }, {}), /Falta ANTHROPIC_API_KEY/);
  assert.throws(() => makeRealDeps(policy, { model: 'claude-haiku-5-5', evalProvider: 'openai' }, { ANTHROPIC_API_KEY: 'a' }), /Falta OPENAI_API_KEY/);
  assert.throws(() => makeRealDeps(policy, { model: 'gpt-6.1-sol', evalProvider: 'anthropic' }, { OPENAI_API_KEY: 'o' }), /Falta ANTHROPIC_API_KEY/);
});

// ---------- Reporte ----------
test('el reporte muestra los modelos del bot, del cliente y del juez en el encabezado y en summary.json', async () => {
  const scenarios = loadScenarios(undefined, policy.assets.map((a) => a.id));
  const chosen = selectScenarios(scenarios, ['tono-19-son-los-de-elite']);
  const llm = fakeLlm([modelTurn({ bubbles: ['Buenas tardes, no, somos Olimpo Padel, una empresa aparte.'] })]);
  const customer = Object.assign(fakeCustomer(['x']), { label: 'claude-haiku-5-5 low' });
  const judge = Object.assign(fakeJudge([verdict(5)]), { label: 'claude-sonnet-5-5 low' });
  const out = await runEval({ model: 'gpt-6-luna', effort: 'low', runs: 1, concurrency: 1 }, { llm, customer, judge, policy }, chosen);
  assert.equal(out.customer, 'claude-haiku-5-5 low');
  assert.equal(out.judge, 'claude-sonnet-5-5 low');
  assert.match(renderReport(out), /^# Banco de pruebas: gpt-6-luna \(low\)\n\n- Fecha: .*\n- Modelos: bot gpt-6-luna low · cliente claude-haiku-5-5 low · juez claude-sonnet-5-5 low\n/);
  const s = buildSummary(out);
  assert.equal(s.customer, 'claude-haiku-5-5 low');
  assert.equal(s.judge, 'claude-sonnet-5-5 low');
  // piezas falsas sin etiqueta: se muestra "-" y no se rompe
  const bare = await runEval({ model: 'gpt-6-luna', effort: 'low', runs: 1, concurrency: 1 }, { llm, customer: fakeCustomer(['x']), judge: fakeJudge([verdict(5)]), policy }, chosen);
  assert.match(renderReport(bare), /- Modelos: bot gpt-6-luna low · cliente - · juez -\n/);
});

// ---------- De punta a punta ----------
test('una conversación de persona completa sobre Anthropic (bot, cliente y juez) con fetch falso: cada llamada con su modelo y esfuerzo, y los costos con las escrituras de caché', async () => {
  const fake = new FakeLlm(policy);
  const calls: string[] = [];
  let customerCalls = 0;
  const botUsage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000, output_tokens: 120 };
  const sideUsage = { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 20 };
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const routed: typeof fetch = async (_url, init) => {
    const b = JSON.parse(String(init?.body));
    const effort = b.output_config.effort;
    if (b.model === 'claude-sonnet-5-5') {
      calls.push(`juez ${b.model} ${effort}`);
      return json(textMessage(JSON.stringify(verdict(5)), sideUsage));
    }
    if (b.output_config.format) {
      calls.push(`bot ${b.model} ${effort}`);
      const r = await fake.generateTurn({ instructions: b.system[0].text, input: b.messages[0].content, model: b.model, effort });
      return json(textMessage(JSON.stringify(r.turn), botUsage));
    }
    calls.push(`cliente ${b.model} ${effort}`);
    return json(textMessage(customerCalls++ === 0 ? 'Hola, quiero info' : '[FIN]', sideUsage));
  };
  const api = new AnthropicClient({ apiKey: KEY, fetch: routed });
  const sc = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), ['persona-curioso-sin-datos'])[0];
  const r = await runScenario(sc, 1, {
    llm: new AnthropicLlm({ apiKey: KEY, fetch: routed }),
    customer: new AnthropicCustomer(api),
    judge: new AnthropicJudge(api, policy),
    policy,
    config: { model: 'claude-haiku-5-5', effort: 'medium' },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.endReason, 'fin_cliente');
  assert.equal(r.turns.length, 1);
  assert.deepEqual(calls, ['cliente claude-haiku-5-5 low', 'bot claude-haiku-5-5 medium', 'cliente claude-haiku-5-5 low', 'juez claude-sonnet-5-5 low']);
  assert.equal(r.cost.bot, costUsd('claude-haiku-5-5', { inputTokens: 3100, cachedTokens: 0, cacheWriteTokens: 3000, outputTokens: 120 }));
  assert.equal(r.cost.customer, 2 * costUsd('claude-haiku-5-5', { inputTokens: 50, cachedTokens: 0, outputTokens: 20 }));
  assert.equal(r.cost.judge, costUsd('claude-sonnet-5-5', { inputTokens: 50, cachedTokens: 0, outputTokens: 20 }));
  assert.deepEqual(r.judge, verdict(5));
});

test('un error pasajero de Anthropic en una conversación es un error de la corrida ("LLM pasajero"), no una falla del bot', async () => {
  const f = fakeFetch({ status: 529, body: errorBody('overloaded_error') });
  const sc = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), ['tono-19-son-los-de-elite'])[0];
  const r = await runScenario(sc, 1, { llm: new AnthropicLlm({ apiKey: KEY, fetch: f.fetch }), policy, config: { model: 'claude-haiku-5-5', effort: 'low' } });
  assert.equal(r.endReason, 'error');
  assert.match(r.error!, /^LLM pasajero \(rate\): Anthropic 529 overloaded_error/);
  assert.equal(r.turns.length, 0);
});
