// Resume una o más corridas de evals/out/ separando train y test (split.json) sin abrir transcripciones.
// De train muestra cada falla crítica (es lo que se lee para decidir el próximo cambio); de test solo el id y la cantidad: el detalle de test no se mira mientras se itera.
// Uso: node evals/hillclimb-haiku/score.ts <evals/out/carpeta> [<evals/out/carpeta> ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const split = JSON.parse(readFileSync(new URL('./split.json', import.meta.url), 'utf8')) as { train: string[]; test: string[] };
interface Conv { scenarioId: string; run: number; turns: number; criticalFailures: string[]; judgeAverage: number | null; endReason: string; cost: { bot: number; customer: number; judge: number } }
const convs: Conv[] = [];
let total = 0;
for (const dir of process.argv.slice(2)) {
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  convs.push(...s.conversations);
  total += s.overall.cost.total;
  console.log(`${dir}: ${s.model} ${s.effort} · juez ${s.judge} · costos total USD ${s.overall.cost.total.toFixed(4)} (bot ${s.overall.cost.bot.toFixed(4)}, juez ${s.overall.cost.judge.toFixed(4)}) · p95 ${((s.overall.p95LatencyMs ?? 0) / 1000).toFixed(1)} s · reintento ${(s.overall.retryRate * 100).toFixed(1)} % · seguros ${(s.overall.fallbackRate * 100).toFixed(1)} %`);
}
for (const [name, ids] of [['train', split.train], ['test', split.test]] as const) {
  const rows = convs.filter((c) => ids.includes(c.scenarioId));
  const crit = rows.reduce((n, c) => n + c.criticalFailures.length, 0);
  const judged = rows.filter((c) => c.judgeAverage !== null);
  const avg = judged.length ? judged.reduce((n, c) => n + (c.judgeAverage as number), 0) / judged.length : NaN;
  const min = judged.length ? Math.min(...judged.map((c) => c.judgeAverage as number)) : NaN;
  console.log(`\n${name}: ${rows.length} conversaciones · críticas ${crit} (en ${rows.filter((c) => c.criticalFailures.length).length} conversaciones) · juez prom ${avg.toFixed(2)} mín ${min.toFixed(2)}`);
  for (const c of rows.filter((r) => r.criticalFailures.length)) {
    console.log(`  - ${c.scenarioId} (corrida ${c.run}): ${name === 'train' ? c.criticalFailures.map((f) => f.slice(0, 160)).join(' | ') : `${c.criticalFailures.length} crítica(s)`}`);
  }
}
console.log(`\ngasto de estas corridas: USD ${total.toFixed(4)}`);
