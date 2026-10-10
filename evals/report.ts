// Reporte de una evaluación: report.md (métricas, vara, cada transcripción) y summary.json, en evals/out/<fecha>-<modelo>-<esfuerzo>/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JUDGE_CRITICALS, JUDGE_SCORES } from './types.ts';
import type { ConversationResult } from './types.ts';
import { computeMetrics, criticalFailures, judgeAverage } from './metrics.ts';
import type { RunMetrics } from './metrics.ts';
import { evaluateGateRuns } from './gate.ts';
import type { GateResult } from './gate.ts';
import { renderCard, renderTranscript } from './judge.ts';

export interface EvalMeta {
  startedAt: Date;
  model: string;
  effort: string;
  runs: number;
  concurrency: number;
  policyHash: string;
  scenarioIds: string[];
  customer?: string; // "modelo esfuerzo" del cliente simulado y del juez (el bot es `model` y `effort`)
  judge?: string;
}

export interface EvalOutput extends EvalMeta {
  results: ConversationResult[]; // ordenadas por corrida y después por id
  perRun: { run: number; metrics: RunMetrics; gate: GateResult }[];
  overall: RunMetrics; // todas las corridas juntas
  pass: boolean; // cada corrida pasa cada regla
}

export function buildEvalOutput(meta: EvalMeta, results: ConversationResult[]): EvalOutput {
  const sorted = [...results].sort((a, b) => a.run - b.run || (a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0));
  const metrics = Array.from({ length: meta.runs }, (_, i) => computeMetrics(sorted.filter((r) => r.run === i + 1)));
  const gate = evaluateGateRuns(metrics);
  return {
    ...meta,
    results: sorted,
    perRun: metrics.map((m, i) => ({ run: i + 1, metrics: m, gate: gate.perRun[i] })),
    overall: computeMetrics(sorted),
    pass: gate.pass,
  };
}

// ---------- Formato ----------
const AR_STAMP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const dirName = (m: Pick<EvalMeta, 'startedAt' | 'model' | 'effort'>) => `${AR_STAMP.format(m.startedAt).replace(' ', '-').replace(':', '')}-${m.model}-${m.effort}`;

const usd = (x: number) => `USD ${x.toFixed(4)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const num = (x: number | null, d = 2) => (x === null ? '-' : x.toFixed(d));
const secs = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const perAttempt = (m: RunMetrics, tokens: number) => num(m.attempts ? tokens / m.attempts : null, 0); // promedio por intento del bot
const cacheRead = (m: RunMetrics) => (m.cacheReadRate === null ? '-' : pct(m.cacheReadRate));
const fence = (s: string) => s.replaceAll('```', "'''");
const cell = (s: string) => s.replaceAll('|', '/').replace(/\s*\n\s*/g, ' ');
const ok = (b: boolean) => (b ? 'PASA' : 'NO PASA');

function transcript(c: ConversationResult): string {
  const fails = criticalFailures(c);
  const out: string[] = [];
  out.push(`### ${c.scenarioId} · corrida ${c.run} · ${fails.length ? `FALLA (${fails.length} crítica${fails.length === 1 ? '' : 's'})` : 'OK'}`, '');
  const cost = `bot ${usd(c.cost.bot)} · cliente ${usd(c.cost.customer)} · juez ${usd(c.cost.judge)}`;
  out.push(`${c.tipo} · hora ${c.hora} · fin: ${c.endReason} · ${c.turns.length} turno(s) · ${cost}`, '');
  out.push('```text', fence(renderTranscript(c.turns)) || '(sin turnos)', '```', '');

  const tries = c.turns.flatMap((t) => t.attempts.map((a, i) => ({ t, a, i }))).filter((x) => x.a.violations.length);
  if (tries.length) {
    out.push('Violaciones del controlador (intentos descartados):');
    for (const { t, a, i } of tries) {
      out.push(`- turno ${t.turn}, intento ${i + 1} (${secs(a.latencyMs)}, ${usd(a.costUsd)})${a.proposed?.length ? `, el modelo había propuesto: ${a.proposed.map((b) => `"${cell(b)}"`).join(' | ')}` : ''}`);
      for (const v of a.violations) out.push(`  - ${v.rule}: ${cell(v.detail)}`);
    }
    out.push('');
  }
  const rejected = c.turns.flatMap((t) => t.rejected.map((r) => ({ t, r })));
  if (rejected.length) {
    out.push('Datos que la ficha rechazó:');
    for (const { t, r } of rejected) out.push(`- turno ${t.turn}: ${r.field} = ${cell(r.value)} (${r.evidenceMsgId}): ${r.reason}`);
    out.push('');
  }
  if (fails.length) out.push('Fallas críticas:', ...fails.map((f) => `- ${cell(f)}`), '');
  if (c.judge) {
    const scores = JUDGE_SCORES.map((k) => `${k} ${c.judge![k]}`).join(' · ');
    const crit = JUDGE_CRITICALS.filter((k) => c.judge!.critico[k]);
    out.push(`Juez: ${scores} · promedio ${judgeAverage(c.judge).toFixed(2)} · críticos: ${crit.join(', ') || 'ninguno'}`, `> ${cell(c.judge.comentario)}`, '');
  } else if (c.judgeError) out.push(`Juez sin veredicto: ${cell(c.judgeError)}`, '');
  out.push(`Ficha final: ${renderCard(c.finalCard)}`);
  if (c.finalCard.teamNote) out.push(`Nota para el equipo: ${cell(c.finalCard.teamNote)}`);
  return out.join('\n');
}

export function renderReport(o: EvalOutput): string {
  const L: string[] = [];
  L.push(`# Banco de pruebas: ${o.model} (${o.effort})`, '');
  L.push(`- Fecha: ${o.startedAt.toISOString()}`);
  L.push(`- Modelos: bot ${o.model} ${o.effort} · cliente ${o.customer ?? '-'} · juez ${o.judge ?? '-'}`);
  L.push(`- Corridas: ${o.runs} · escenarios: ${o.scenarioIds.length} · conversaciones: ${o.overall.conversations} · concurrencia ${o.concurrency}`);
  L.push(`- Política (hash): ${o.policyHash}`);
  const failing = [...new Set(o.perRun.flatMap((r) => r.gate.rules.filter((x) => !x.pass).map((x) => x.label)))];
  L.push(`- Vara: **${ok(o.pass)}**${failing.length ? ` (fallan: ${failing.join(', ')})` : ''}`, '');

  L.push('## Métricas por corrida', '');
  L.push('| Corrida | Conversaciones | Turnos | Críticas | Reintento | Seguros | Juez promedio | Juez mínimo | p95 | Bot por conversación |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  const row = (label: string, m: RunMetrics) =>
    `| ${label} | ${m.conversations} | ${m.turns} | ${m.criticalFailures} | ${pct(m.retryRate)} | ${pct(m.fallbackRate)} | ${num(m.judgeAvg)} | ${num(m.judgeMin)} | ${secs(m.p95LatencyMs)} | ${usd(m.perConversation.bot)} |`;
  for (const r of o.perRun) L.push(row(String(r.run), r.metrics));
  if (o.runs > 1) L.push(row('Todas', o.overall));
  L.push('');

  L.push('## Vara', '');
  L.push(`| Regla | Límite | ${o.perRun.map((r) => `Corrida ${r.run}`).join(' | ')} |`);
  L.push(`|---|---|${o.perRun.map(() => '---').join('|')}|`);
  const rules = o.perRun[0]?.gate.rules ?? [];
  rules.forEach((rule, i) => L.push(`| ${rule.label} | ${rule.limit} | ${o.perRun.map((r) => `${ok(r.gate.rules[i].pass)} (${r.gate.rules[i].value})`).join(' | ')} |`));
  L.push(`| **Vara completa** | todas, en cada corrida | ${o.perRun.map((r) => `**${ok(r.gate.pass)}**`).join(' | ')} |`, '');

  L.push('## Costos', '');
  L.push('| | Total | Por conversación |', '|---|---|---|');
  const n = o.overall.conversations || 1;
  for (const [label, k] of [['Bot', 'bot'], ['Cliente simulado', 'customer'], ['Juez', 'judge']] as const) {
    L.push(`| ${label} | ${usd(o.overall.cost[k])} | ${usd(o.overall.cost[k] / n)} |`);
  }
  L.push(`| Total | ${usd(o.overall.cost.total)} | ${usd(o.overall.cost.total / n)} |`, '');

  L.push('## Tokens del bot por intento', '');
  L.push('Promedios por intento. Leído del caché = leído / entrada. Pensamiento: solo cuentan los intentos que lo informaron.', '');
  L.push('| Corrida | Entrada | Leído del caché | Escrito en el caché (de 1 h) | Salida | Pensamiento promedio | Pensamiento p95 |', '|---|---|---|---|---|---|---|');
  const tokRow = (label: string, m: RunMetrics) =>
    `| ${label} | ${perAttempt(m, m.tokens.input)} | ${cacheRead(m)} | ${perAttempt(m, m.tokens.cacheWrite)} (${perAttempt(m, m.tokens.cacheWrite1h)}) | ${perAttempt(m, m.tokens.output)} | ${num(m.thinkingAvg, 0)} | ${num(m.thinkingP95, 0)} |`;
  for (const r of o.perRun) L.push(tokRow(String(r.run), r.metrics));
  if (o.runs > 1) L.push(tokRow('Todas', o.overall));
  L.push('');

  L.push('## Conversaciones', '');
  L.push('| Escenario | Corrida | Tipo | Fin | Turnos | Reintentos | Críticas | Juez | Bot |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of o.results) {
    const retries = c.turns.filter((t) => t.attempts.length > 1).length;
    L.push(`| ${c.scenarioId} | ${c.run} | ${c.tipo} | ${c.endReason} | ${c.turns.length} | ${retries} | ${criticalFailures(c).length} | ${c.judge ? judgeAverage(c.judge).toFixed(2) : '-'} | ${usd(c.cost.bot)} |`);
  }
  L.push('', '## Transcripciones', '');
  for (const c of o.results) L.push(transcript(c), '');
  return `${L.join('\n').trimEnd()}\n`;
}

export function buildSummary(o: EvalOutput) {
  return {
    startedAt: o.startedAt.toISOString(),
    model: o.model,
    effort: o.effort,
    customer: o.customer ?? null,
    judge: o.judge ?? null,
    runs: o.runs,
    concurrency: o.concurrency,
    policyHash: o.policyHash,
    scenarios: o.scenarioIds,
    pass: o.pass,
    perRun: o.perRun.map((r) => ({ run: r.run, pass: r.gate.pass, metrics: r.metrics, rules: r.gate.rules })),
    overall: o.overall,
    conversations: o.results.map((c) => ({
      scenarioId: c.scenarioId,
      run: c.run,
      tipo: c.tipo,
      endReason: c.endReason,
      turns: c.turns.length,
      criticalFailures: criticalFailures(c),
      judgeAverage: c.judge ? judgeAverage(c.judge) : null,
      judgeError: c.judgeError ?? null,
      cost: c.cost,
    })),
  };
}

// Escribe report.md y summary.json y devuelve la carpeta.
export function writeReport(o: EvalOutput, baseDir: string): string {
  const dir = join(baseDir, dirName(o));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderReport(o));
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(buildSummary(o), null, 2)}\n`);
  return dir;
}

// Lo que se imprime en consola al terminar.
export function consoleSummary(o: EvalOutput, dir: string): string {
  const L = [`Banco de pruebas · ${o.model} ${o.effort} · ${o.runs} corrida(s) · ${o.overall.conversations} conversación(es) · ${o.overall.turns} turno(s)`];
  for (const r of o.perRun) {
    const m = r.metrics;
    L.push(`corrida ${r.run}: críticas ${m.criticalFailures} · reintento ${pct(m.retryRate)} · seguros ${pct(m.fallbackRate)} · un globo ${m.singleBubbleRate === null ? '—' : pct(m.singleBubbleRate)} · juez ${num(m.judgeAvg)} (mín ${num(m.judgeMin)}) · p95 ${secs(m.p95LatencyMs)} · bot ${usd(m.perConversation.bot)} por conversación · ${ok(r.gate.pass)}`);
    for (const rule of r.gate.rules.filter((x) => !x.pass)) L.push(`    NO PASA ${rule.label}: ${rule.value} (límite ${rule.limit})`);
  }
  const bad = o.results.filter((c) => criticalFailures(c).length);
  for (const c of bad) {
    L.push(`falla: ${c.scenarioId} (corrida ${c.run})`);
    for (const f of criticalFailures(c)) L.push(`    - ${f}`);
  }
  L.push(`vara: ${ok(o.pass)}`);
  const k = o.overall.cost;
  L.push(`costos: bot ${usd(k.bot)} · cliente simulado ${usd(k.customer)} · juez ${usd(k.judge)} · total ${usd(k.total)}`);
  const t = o.overall;
  L.push(`tokens del bot por intento: entrada ${perAttempt(t, t.tokens.input)} · leído del caché ${cacheRead(t)} · salida ${perAttempt(t, t.tokens.output)} · pensamiento ${num(t.thinkingAvg, 0)}`);
  L.push(`reporte: ${join(dir, 'report.md')}`);
  return L.join('\n');
}
