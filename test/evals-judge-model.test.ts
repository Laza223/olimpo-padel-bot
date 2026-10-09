// --judge-model: la jueza de Anthropic se puede cambiar (claude-opus-5-5 para la confirmación final) sin tocar la rúbrica ni el prompt del juez. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient } from '../src/anthropic.ts';
import { costUsd } from '../src/brain.ts';
import { emptyCard } from '../src/lead.ts';
import { loadPolicy } from '../src/policy.ts';
import { ANTHROPIC_JUDGE_MODEL, AnthropicJudge, buildJudgeInput, buildJudgeInstructions } from '../evals/judge.ts';
import { makeRealDeps, parseEvalArgs } from '../evals/run.ts';
import { KEY, fakeFetch, textMessage } from './anthropic-helpers.ts';
import { turnLog, verdict } from './evals-helpers.ts';

const policy = loadPolicy();
const BOTH = { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' };
const usage = { input_tokens: 40, cache_read_input_tokens: 400, cache_creation_input_tokens: 560, output_tokens: 50 };
const input = { hora: '15:00', turns: [turnLog()], finalCard: emptyCard() };

test('precios de claude-opus-5-5: entrada 4, cacheada 0,20, escritura de caché 5 y salida 20 por millón', () => {
  const M = 1_000_000;
  assert.equal(costUsd('claude-opus-5-5', { inputTokens: M, cachedTokens: 0, outputTokens: 0 }), 4);
  assert.equal(costUsd('claude-opus-5-5', { inputTokens: M, cachedTokens: M, outputTokens: 0 }), 0.2);
  assert.equal(costUsd('claude-opus-5-5', { inputTokens: M, cachedTokens: 0, cacheWriteTokens: M, outputTokens: 0 }), 5);
  assert.equal(costUsd('claude-opus-5-5', { inputTokens: 0, cachedTokens: 0, outputTokens: M }), 20);
});

test('parseEvalArgs: --judge-model solo con un modelo claude-… con precio y con las pruebas en Anthropic', () => {
  const ok = parseEvalArgs(['--model', 'claude-haiku-5-5', '--eval-provider', 'anthropic', '--judge-model', 'claude-opus-5-5'], BOTH);
  assert.equal(ok.judgeModel, 'claude-opus-5-5');
  assert.equal(ok.evalProvider, 'anthropic');
  assert.equal(parseEvalArgs(['--model', 'claude-haiku-5-5'], { ANTHROPIC_API_KEY: 'a' }).judgeModel, undefined); // sin pedirlo no aparece
  assert.equal(parseEvalArgs(['--judge-model', 'claude-opus-5-5'], { ANTHROPIC_API_KEY: 'a' }).judgeModel, 'claude-opus-5-5'); // sin OpenAI, las pruebas ya corren en Anthropic
  assert.throws(() => parseEvalArgs(['--eval-provider', 'anthropic', '--judge-model', 'gpt-6-astra'], BOTH), /--judge-model.*claude-/);
  assert.throws(() => parseEvalArgs(['--judge-model', 'claude-opus-5-5'], BOTH), /--judge-model solo vale con --eval-provider anthropic/);
  assert.throws(() => parseEvalArgs(['--eval-provider', 'anthropic', '--judge-model', 'claude-opus-9'], BOTH), /sin precio/);
});

test('makeRealDeps: la jueza es la pedida y, sin pedir nada, claude-sonnet-5-5', () => {
  const opus = makeRealDeps(policy, { model: 'claude-haiku-5-5', evalProvider: 'anthropic', judgeModel: 'claude-opus-5-5' }, BOTH);
  assert.equal(opus.judge.label, 'claude-opus-5-5 low');
  const sonnet = makeRealDeps(policy, { model: 'claude-haiku-5-5', evalProvider: 'anthropic' }, BOTH);
  assert.equal(sonnet.judge.label, `${ANTHROPIC_JUDGE_MODEL} low`);
});

test('AnthropicJudge con otro modelo: manda ese modelo con la misma rúbrica y esquema, y cobra con su fila de PRICES', async () => {
  const v = verdict(5);
  const f = fakeFetch({ body: textMessage(JSON.stringify(v), usage) });
  const api = new AnthropicClient({ apiKey: KEY, fetch: f.fetch });
  const r = await new AnthropicJudge(api, policy, 'claude-opus-5-5').evaluate(input);
  assert.deepEqual(r.verdict, v);
  assert.equal(r.costUsd, costUsd('claude-opus-5-5', { inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 560, outputTokens: 50 }));
  const b = f.sent[0].body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.output_config.effort, 'low');
  assert.deepEqual(b.system, [{ type: 'text', text: buildJudgeInstructions(policy), cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(b.messages, [{ role: 'user', content: buildJudgeInput(input) }]);
});
