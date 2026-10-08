// Compara configuraciones del bot sobre los mismos escenarios y las mismas corridas, y dice cuál pasa la vara al menor costo.
// Uso: pnpm eval:compare [-- --runs 3 --only id,id --concurrency 4]
import { parseArgs } from 'node:util';
import { loadEnv } from '../src/brain.ts';
import { loadPolicy } from '../src/policy.ts';
import { loadScenarios, selectScenarios } from './scenario.ts';
import { makeRealDeps, OUT_DIR, parseCount, runEval } from './run.ts';
import { writeReport } from './report.ts';
import type { EvalOutput } from './report.ts';

export const CONFIGS = [
  { model: 'gpt-6.1-sol', effort: 'low' },
  { model: 'gpt-6.1-sol', effort: 'medium' },
  // gpt-6-luna low quedó descartado en la corrida del 7-oct (14 críticas, 16,7 % de reintentos): ver LEDGER.
] as const;

// De las configuraciones que pasan la vara en cada corrida, la de menor costo del bot por conversación.
export function cheapestPassing(outs: EvalOutput[]): EvalOutput | undefined {
  return outs.filter((o) => o.pass).sort((a, b) => a.overall.perConversation.bot - b.overall.perConversation.bot)[0];
}

const usd = (x: number) => `USD ${x.toFixed(4)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const num = (x: number | null) => (x === null ? '-' : x.toFixed(2));

export function compareTable(outs: EvalOutput[]): string {
  const head = ['configuración', 'críticas', 'reintento', 'seguros', 'juez prom.', 'juez mín.', 'p95', 'bot/conv.', 'total', 'vara'];
  const rows = outs.map((o) => {
    const m = o.overall;
    return [
      `${o.model} ${o.effort}`, String(m.criticalFailures), pct(m.retryRate), pct(m.fallbackRate), num(m.judgeAvg), num(m.judgeMin),
      m.p95LatencyMs === null ? '-' : `${(m.p95LatencyMs / 1000).toFixed(1)} s`, usd(m.perConversation.bot), usd(m.cost.total), o.pass ? 'PASA' : 'NO PASA',
    ];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function main() {
  loadEnv();
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { runs: { type: 'string' }, only: { type: 'string' }, concurrency: { type: 'string' } },
    strict: true,
  });
  const runs = parseCount('runs', values.runs, 1);
  const concurrency = parseCount('concurrency', values.concurrency, 4);
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const policy = loadPolicy();
  const scenarios = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), only);

  const outs: EvalOutput[] = [];
  for (const cfg of CONFIGS) {
    console.log(`\n== ${cfg.model} ${cfg.effort}: ${scenarios.length} escenario(s) x ${runs} corrida(s) ==`);
    const out = await runEval({ ...cfg, runs, concurrency }, makeRealDeps(policy, { model: cfg.model }), scenarios, console.log);
    console.log(`reporte: ${writeReport(out, OUT_DIR)}`);
    outs.push(out);
  }
  console.log(`\n${compareTable(outs)}\n`);
  const best = cheapestPassing(outs);
  console.log(best ? `Pasa la vara al menor costo: ${best.model} ${best.effort} (bot ${usd(best.overall.perConversation.bot)} por conversación)` : 'Ninguna configuración pasa la vara.');
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
