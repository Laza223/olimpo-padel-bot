// Errores pasajeros de OpenAI: no son "falla del bot". OpenAiLlm los clasifica, runTurn los deja pasar (no cuentan como intento)
// y el banco de pruebas los registra como error de la corrida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { LlmOutputError, OpenAiLlm, TransientLlmError } from '../src/brain.ts';
import { loadPolicy } from '../src/policy.ts';
import { runTurn } from '../src/turn.ts';
import type { BrainConfig } from '../src/types.ts';
import { loadScenarios, selectScenarios } from '../evals/scenario.ts';
import { runScenario } from '../evals/simulate.ts';
import { criticalFailures } from '../evals/metrics.ts';
import { fakeLlm, modelTurn, msg, turnInput } from './helpers.ts';

const policy = loadPolicy();
const config: BrainConfig = { model: 'gpt-6-luna', effort: 'low' };
const req = { instructions: 'INS', input: 'INP', model: 'gpt-6.1-sol', effort: 'low' };

const failingClient = (err: unknown) => ({ responses: { create: async () => { throw err; } } }) as unknown as OpenAI;
const apiError = (status: number, code: string | null, message = 'boom') =>
  OpenAI.APIError.generate(status, { error: { message, code, type: code } }, message, new Headers());

test('OpenAiLlm: red, timeout, 5xx y 429 por límite son TransientLlmError con su tipo', async () => {
  const cases: [string, unknown, 'network' | 'rate' | 'quota'][] = [
    ['red', new OpenAI.APIConnectionError({ message: 'Connection error.' }), 'network'],
    ['timeout', new OpenAI.APIConnectionTimeoutError(), 'network'],
    ['500', apiError(500, null), 'network'],
    ['503', apiError(503, null), 'network'],
    ['429 por límite', apiError(429, 'rate_limit_exceeded'), 'rate'],
    ['429 sin código', apiError(429, null), 'rate'],
    ['429 sin saldo', apiError(429, 'insufficient_quota', 'You exceeded your current quota'), 'quota'],
  ];
  for (const [name, err, kind] of cases) {
    await assert.rejects(new OpenAiLlm({ client: failingClient(err) }).generateTurn(req), (e: unknown) => {
      assert.ok(e instanceof TransientLlmError, name);
      assert.equal((e as TransientLlmError).kind, kind, name);
      return true;
    });
  }
});

test('OpenAiLlm: un 401, 403 o 404 (clave o modelo mal puestos) no es falla del bot: TransientLlmError de tipo config; un 400 sigue contando como intento fallido', async () => {
  for (const status of [401, 403, 404]) {
    await assert.rejects(new OpenAiLlm({ client: failingClient(apiError(status, 'x')) }).generateTurn(req), (e: unknown) => {
      assert.ok(e instanceof TransientLlmError, String(status));
      assert.equal((e as TransientLlmError).kind, 'config', String(status));
      return true;
    });
  }
  await assert.rejects(new OpenAiLlm({ client: failingClient(apiError(400, 'x')) }).generateTurn(req), (e: unknown) => {
    assert.ok(!(e instanceof TransientLlmError), '400');
    return true;
  });
});

test('runTurn: un error pasajero se relanza sin contar intento ni mandar el mensaje seguro', async () => {
  const llm = fakeLlm([new TransientLlmError('quota', 'sin saldo')]);
  await assert.rejects(runTurn(turnInput([msg('m1', 'customer', 'Hola')], ['m1']), { llm, policy, config }), (e: unknown) => {
    assert.ok(e instanceof TransientLlmError);
    assert.equal((e as TransientLlmError).kind, 'quota');
    return true;
  });
  assert.equal(llm.calls.length, 1); // no hubo reintento
});

test('runTurn: un error pasajero en el reintento también se relanza (el intento 1 fue una violación)', async () => {
  const wrong = modelTurn({ bubbles: ['Buen día, te escribimos de Olimpo Padel. De dónde sos?'] }); // a las 14:00 corresponde "Buenas tardes"
  const llm = fakeLlm([wrong, new TransientLlmError('network', 'timeout')]);
  await assert.rejects(runTurn(turnInput([msg('m1', 'customer', 'Hola')], ['m1']), { llm, policy, config }), TransientLlmError);
  assert.equal(llm.calls.length, 2);
});

test('runTurn: LlmOutputError y los errores de otro tipo siguen contando como intento (con dos, mensaje seguro)', async () => {
  const usage = { inputTokens: 10, cachedTokens: 0, outputTokens: 5 };
  const llm = fakeLlm([new LlmOutputError('el JSON no cumple el esquema', usage, 100), new Error('rarísimo')]);
  const r = await runTurn(turnInput([msg('m1', 'customer', 'Hola')], ['m1']), { llm, policy, config });
  assert.equal(r.usedFallback, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].violations[0].rule, 'llm');
});

test('runTurn: una negativa (refusal) no se reintenta y va directo al mensaje seguro', async () => {
  const usage = { inputTokens: 10, cachedTokens: 0, outputTokens: 5 };
  const llm = fakeLlm([new LlmOutputError('el modelo se negó (general_harms)', usage, 100, 'refusal'), modelTurn()]);
  const r = await runTurn(turnInput([msg('m1', 'customer', 'Hola')], ['m1']), { llm, policy, config });
  assert.equal(llm.calls.length, 1);
  assert.equal(r.usedFallback, true);
  assert.equal(r.attempts.length, 1);
  assert.deepEqual(r.handoffs.map((h) => h.reason), ['falla_del_bot']);
});

test('evals/simulate: un TransientLlmError corta la conversación como error de la corrida, no como falla del bot', async () => {
  const scenarios = loadScenarios(undefined, policy.assets.map((a) => a.id));
  const sc = selectScenarios(scenarios, ['tono-02-precio'])[0];
  const r = await runScenario(sc, 1, { llm: fakeLlm([new TransientLlmError('rate', 'límite de OpenAI')]), policy, config });
  assert.equal(r.endReason, 'error');
  assert.match(r.error!, /pasajero.*rate.*límite de OpenAI/);
  assert.equal(r.turns.length, 0); // ningún turno terminó: tampoco hay mensaje seguro ni falla_del_bot
  assert.deepEqual(r.expectFailures, []);
  assert.deepEqual(criticalFailures(r), [`error: ${r.error}`]);
  assert.ok(r.history.every((m) => m.author === 'customer'));
});
