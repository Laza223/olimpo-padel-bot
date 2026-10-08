// La vara: tienen que cumplirse todas las reglas, en cada una de las N corridas.
import type { RunMetrics } from './metrics.ts';

export const LIMITS = {
  criticalFailures: 0,
  retryRate: 0.08, // turnos con reintento
  fallbackRate: 0.01, // mensajes seguros
  judgeAvg: 4.0,
  judgeMin: 3, // ninguna conversación por debajo
  p95LatencyMs: 15_000,
  botCostPerConversationUsd: 0.25,
} as const;

export interface GateRule {
  id: string;
  label: string;
  limit: string;
  value: string;
  pass: boolean;
}

export interface GateResult {
  pass: boolean;
  rules: GateRule[];
}

const EPS = 1e-9; // las tasas son cocientes: 2 de 25 tiene que valer exactamente 8 %
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const usd = (x: number) => `USD ${x.toFixed(4)}`;

export function evaluateGate(m: RunMetrics): GateResult {
  // Sin veredicto de alguna conversación no se puede afirmar que el juez aprueba.
  const judgeComplete = m.conversations > 0 && m.judged === m.conversations;
  const judgeNote = judgeComplete ? '' : ` (${m.conversations - m.judged} sin veredicto)`;
  const rules: GateRule[] = [
    { id: 'criticas', label: 'Fallas críticas', limit: `${LIMITS.criticalFailures}`, value: `${m.criticalFailures}`, pass: m.criticalFailures <= LIMITS.criticalFailures },
    { id: 'reintento', label: 'Turnos con reintento', limit: `≤ ${pct(LIMITS.retryRate)}`, value: pct(m.retryRate), pass: m.retryRate <= LIMITS.retryRate + EPS },
    { id: 'seguros', label: 'Mensajes seguros', limit: `≤ ${pct(LIMITS.fallbackRate)}`, value: pct(m.fallbackRate), pass: m.fallbackRate <= LIMITS.fallbackRate + EPS },
    {
      id: 'juez_promedio', label: 'Juez, promedio', limit: `≥ ${LIMITS.judgeAvg.toFixed(1)}`,
      value: m.judgeAvg === null ? `sin datos${judgeNote}` : `${m.judgeAvg.toFixed(2)}${judgeNote}`,
      pass: judgeComplete && m.judgeAvg !== null && m.judgeAvg >= LIMITS.judgeAvg - EPS,
    },
    {
      id: 'juez_minimo', label: 'Juez, peor conversación', limit: `≥ ${LIMITS.judgeMin}`,
      value: m.judgeMin === null ? `sin datos${judgeNote}` : `${m.judgeMin.toFixed(2)}${judgeNote}`,
      pass: judgeComplete && m.judgeMin !== null && m.judgeMin >= LIMITS.judgeMin - EPS,
    },
    {
      id: 'p95', label: 'Demora p95 por intento', limit: `≤ ${LIMITS.p95LatencyMs / 1000} s`,
      value: m.p95LatencyMs === null ? 'sin datos' : `${(m.p95LatencyMs / 1000).toFixed(1)} s`,
      pass: m.p95LatencyMs !== null && m.p95LatencyMs <= LIMITS.p95LatencyMs,
    },
    {
      id: 'costo_bot', label: 'Costo del bot por conversación', limit: `≤ ${usd(LIMITS.botCostPerConversationUsd)}`,
      value: usd(m.perConversation.bot), pass: m.conversations > 0 && m.perConversation.bot <= LIMITS.botCostPerConversationUsd + EPS,
    },
  ];
  return { pass: rules.every((r) => r.pass), rules };
}

// La vara de toda la evaluación: pasa solo si pasa cada una de las corridas.
export function evaluateGateRuns(runs: RunMetrics[]): { pass: boolean; perRun: GateResult[] } {
  const perRun = runs.map(evaluateGate);
  return { pass: perRun.length > 0 && perRun.every((g) => g.pass), perRun };
}
