// Corre el banco igual que evals/run.ts (mismas funciones, mismo reporte, misma vara) y además deja en latencies.json, dentro de la carpeta del reporte,
// la demora, el costo y las violaciones de cada intento del bot: el reporte solo trae el p95 y hace falta ver qué intentos lo empujan sobre los 15 s.
// Uso: node evals/hillclimb-haiku/run.ts --model claude-haiku-5-5 --effort high --eval-provider anthropic --runs 1 --only id,id   (mismos argumentos que evals/run.ts)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../../src/brain.ts';
import { loadPolicy } from '../../src/policy.ts';
import { OUT_DIR, makeRealDeps, parseEvalArgs, runEval } from '../run.ts';
import { loadScenarios, selectScenarios } from '../scenario.ts';
import { consoleSummary, writeReport } from '../report.ts';

loadEnv();
const opts = parseEvalArgs(process.argv.slice(2));
const policy = loadPolicy();
const scenarios = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), opts.only);
const deps = makeRealDeps(policy, opts);
console.log(`Corriendo ${scenarios.length} escenario(s) x ${opts.runs} corrida(s): bot ${opts.model} ${opts.effort}, cliente ${deps.customer.label}, juez ${deps.judge.label} (concurrencia ${opts.concurrency})`);
const out = await runEval(opts, deps, scenarios, console.log);
const dir = writeReport(out, OUT_DIR);
const attempts = out.results.flatMap((c) => c.turns.flatMap((t) => t.attempts.map((a, i) => ({ scenario: c.scenarioId, run: c.run, turn: t.turn, attempt: i + 1, ms: a.latencyMs, usd: a.costUsd, violations: a.violations.map((v) => v.rule) }))));
writeFileSync(join(dir, 'latencies.json'), `${JSON.stringify(attempts)}\n`);
const slow = [...attempts].sort((a, b) => b.ms - a.ms).slice(0, 8).map((a) => `${(a.ms / 1000).toFixed(1)} s ${a.scenario} t${a.turn}${a.violations.length ? ` (${a.violations.join(',')})` : ''}`);
console.log(`\n${consoleSummary(out, dir)}\nintentos más lentos: ${slow.join(' · ')}`);
process.exitCode = out.pass ? 0 : 1;
