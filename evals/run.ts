// Corre el banco de pruebas: cada escenario N veces contra el bot real (runTurn), con cliente simulado y juez.
// Uso: pnpm eval -- --model gpt-6-luna --effort low --runs 3 [--only id,id] [--concurrency 4] [--eval-provider anthropic|openai] [--judge-model claude-opus-5-5]
// --judge-model cambia la jueza de Anthropic (por defecto claude-sonnet-5-5), por ejemplo para la confirmación final; solo con --eval-provider anthropic.
// El cerebro del bot sale del id del modelo (claude-… → Anthropic, el resto → OpenAI). El cliente simulado y el juez salen de --eval-provider:
// si no se pide, openai cuando hay OPENAI_API_KEY; si no, anthropic cuando hay ANTHROPIC_API_KEY (claude-haiku-5-5 de cliente, claude-sonnet-5-5 de juez).
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { ANTHROPIC_EFFORTS, AnthropicClient } from '../src/anthropic.ts';
import { configFromEnv, costUsd, loadEnv } from '../src/brain.ts';
import { createLlm, isClaudeModel } from '../src/llm.ts';
import { loadPolicy } from '../src/policy.ts';
import type { Policy } from '../src/policy.ts';
import type { LlmClient } from '../src/types.ts';
import { loadScenarios, selectScenarios } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { AnthropicCustomer, OpenAiCustomer } from './customer.ts';
import type { CustomerSim } from './customer.ts';
import { AnthropicJudge, OpenAiJudge } from './judge.ts';
import type { Judge } from './judge.ts';
import { runScenario } from './simulate.ts';
import { buildEvalOutput, consoleSummary, writeReport } from './report.ts';
import type { EvalOutput } from './report.ts';

export const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));
const DEFAULT_CONCURRENCY = 4;
const ANTHROPIC_CONCURRENCY = 2; // las cuentas nuevas de Anthropic tienen límites bajos
const CLIENT_TIMEOUT_MS = 60_000; // el juez razona más que el bot

export type EvalProvider = 'anthropic' | 'openai';
type Env = Record<string, string | undefined>;

export interface EvalOptions {
  model: string;
  effort: string;
  runs: number;
  concurrency: number;
  only?: string[];
  evalProvider?: EvalProvider; // solo si se pidió con --eval-provider; si no, se resuelve con resolveEvalProvider
  judgeModel?: string; // solo si se pidió con --judge-model (claude-*, con precio en PRICES)
}

export interface EvalDeps {
  llm: LlmClient;
  customer: CustomerSim;
  judge: Judge;
  policy: Policy;
}

// Ejecuta fn sobre cada elemento con a lo sumo `limit` en vuelo y devuelve los resultados en el orden de entrada.
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Quién hace de cliente simulado y de juez. Lo pedido manda; si no, OpenAI si hay OPENAI_API_KEY, y si no, Anthropic si hay ANTHROPIC_API_KEY.
// Sin ninguna de las dos queda openai: así sigue fallando con "Falta OPENAI_API_KEY", como antes de que existiera Anthropic.
export function resolveEvalProvider(explicit: string | undefined, env: Env = process.env): EvalProvider {
  if (explicit !== undefined) {
    if (explicit !== 'anthropic' && explicit !== 'openai') throw new Error(`--eval-provider tiene que ser anthropic u openai (recibí "${explicit}")`);
    return explicit;
  }
  const has = (k: string) => !!(env[k] ?? '').trim();
  return !has('OPENAI_API_KEY') && has('ANTHROPIC_API_KEY') ? 'anthropic' : 'openai';
}

export function makeRealDeps(policy: Policy, opts: { model: string; evalProvider?: EvalProvider; judgeModel?: string }, env: Env = process.env): EvalDeps {
  const llm = createLlm(opts.model, env); // el cerebro lo decide el id del modelo
  const key = (name: string) => (env[name] ?? '').trim();
  if (resolveEvalProvider(opts.evalProvider, env) === 'anthropic') {
    const api = new AnthropicClient({ apiKey: key('ANTHROPIC_API_KEY'), timeoutMs: CLIENT_TIMEOUT_MS });
    return { llm, customer: new AnthropicCustomer(api), judge: new AnthropicJudge(api, policy, opts.judgeModel), policy };
  }
  const apiKey = key('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY (va en .env)');
  const client = new OpenAI({ apiKey, timeout: CLIENT_TIMEOUT_MS, maxRetries: 2 });
  return { llm, customer: new OpenAiCustomer(client), judge: new OpenAiJudge(client, policy), policy };
}

export async function runEval(
  opts: EvalOptions,
  deps: EvalDeps,
  scenarios: Scenario[],
  log: (line: string) => void = () => {},
): Promise<EvalOutput> {
  costUsd(opts.model, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }); // falla ya si el modelo no tiene precio
  const startedAt = new Date();
  const jobs = Array.from({ length: opts.runs }, (_, i) => scenarios.map((sc) => ({ sc, run: i + 1 }))).flat();
  let done = 0;
  const results = await mapPool(jobs, opts.concurrency, async ({ sc, run }) => {
    const t0 = Date.now();
    const r = await runScenario(sc, run, { ...deps, config: { model: opts.model, effort: opts.effort } });
    log(`[${++done}/${jobs.length}] ${sc.id} corrida ${run} · ${r.endReason} · ${r.turns.length} turno(s) · ${((Date.now() - t0) / 1000).toFixed(1)} s${r.error ? ` · ERROR ${r.error}` : ''}`);
    return r;
  });
  return buildEvalOutput(
    { startedAt, model: opts.model, effort: opts.effort, customer: deps.customer.label, judge: deps.judge.label, runs: opts.runs, concurrency: opts.concurrency, policyHash: deps.policy.hash, scenarioIds: scenarios.map((s) => s.id) },
    results,
  );
}

export function parseCount(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} tiene que ser un entero desde 1 (recibí "${value}")`);
  return n;
}

export function parseEvalArgs(argv: string[], env: Env = process.env): EvalOptions {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'), // pnpm puede dejar pasar el "--" de "pnpm eval -- --model ..."
    options: { model: { type: 'string' }, effort: { type: 'string' }, runs: { type: 'string' }, only: { type: 'string' }, concurrency: { type: 'string' }, 'eval-provider': { type: 'string' }, 'judge-model': { type: 'string' } },
    strict: true,
  });
  const base = configFromEnv(env);
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const model = values.model ?? base.model;
  const effort = values.effort ?? base.effort;
  if (isClaudeModel(model) && !ANTHROPIC_EFFORTS.includes(effort)) throw new Error(`--effort con ${model} tiene que ser ${ANTHROPIC_EFFORTS.join(', ')} (recibí "${effort}")`);
  const evalProvider = resolveEvalProvider(values['eval-provider'], env);
  const judgeModel = values['judge-model'];
  if (judgeModel !== undefined) {
    if (!isClaudeModel(judgeModel)) throw new Error(`--judge-model tiene que ser un modelo claude-… (recibí "${judgeModel}")`);
    if (evalProvider !== 'anthropic') throw new Error('--judge-model solo vale con --eval-provider anthropic');
    costUsd(judgeModel, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }); // falla ya si la jueza no tiene precio
  }
  const anthropic = isClaudeModel(model) || evalProvider === 'anthropic'; // cualquier modelo de Anthropic en juego baja la concurrencia por defecto
  return {
    model,
    effort,
    runs: parseCount('runs', values.runs, 1),
    concurrency: parseCount('concurrency', values.concurrency, anthropic ? ANTHROPIC_CONCURRENCY : DEFAULT_CONCURRENCY),
    only: only?.length ? only : undefined,
    ...(values['eval-provider'] ? { evalProvider } : {}),
    ...(judgeModel ? { judgeModel } : {}),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadEnv();
  const opts = parseEvalArgs(argv);
  const policy = loadPolicy();
  const scenarios = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), opts.only);
  const deps = makeRealDeps(policy, opts);
  console.log(`Corriendo ${scenarios.length} escenario(s) x ${opts.runs} corrida(s): bot ${opts.model} ${opts.effort}, cliente ${deps.customer.label}, juez ${deps.judge.label} (concurrencia ${opts.concurrency})`);
  const out = await runEval(opts, deps, scenarios, console.log);
  const dir = writeReport(out, OUT_DIR);
  console.log(`\n${consoleSummary(out, dir)}`);
  process.exitCode = out.pass ? 0 : 1; // la vara en rojo corta una cadena de comandos
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
