// Métricas de una corrida (todas las conversaciones de una pasada por los escenarios).
import type { ConversationResult, JudgeVerdict } from './types.ts';
import { JUDGE_CRITICALS, JUDGE_SCORES } from './types.ts';

export interface RunMetrics {
  conversations: number;
  turns: number; // turnos del bot (una llamada a runTurn cada uno)
  attempts: number;
  retriedTurns: number; // turnos con más de un intento
  fallbackTurns: number; // turnos que terminaron en el mensaje seguro
  criticalFailures: number; // cantidad de fallas críticas (una conversación puede sumar varias)
  failedConversations: number; // conversaciones con al menos una falla crítica
  retryRate: number; // 0 a 1
  fallbackRate: number; // 0 a 1
  judged: number; // conversaciones con veredicto
  judgeAvg: number | null; // promedio de los promedios por conversación
  judgeMin: number | null; // la peor conversación (promedio de sus 6 criterios)
  p95LatencyMs: number | null; // por intento
  cost: { bot: number; customer: number; judge: number; total: number }; // USD en total
  perConversation: { bot: number; customer: number; judge: number }; // USD por conversación
}

// Promedio de los 6 criterios de una conversación.
export const judgeAverage = (v: JudgeVerdict): number => JUDGE_SCORES.reduce((sum, k) => sum + v[k], 0) / JUDGE_SCORES.length;

// Una falla crítica es: un globo enviado que no pasa el oráculo (evals/oracle.ts), un crítico del juez en true,
// una expectativa del escenario incumplida o una simulación que se cortó por un error.
export function criticalFailures(c: ConversationResult): string[] {
  const out: string[] = [];
  if (c.error) out.push(`error: ${c.error}`);
  for (const t of c.turns) for (const v of t.controllerViolations) out.push(`oráculo (turno ${t.turn}) ${v.rule}: ${v.detail}`);
  if (c.judge) for (const k of JUDGE_CRITICALS) if (c.judge.critico[k]) out.push(`juez: ${k}`);
  for (const f of c.expectFailures) out.push(`espera ${f}`);
  return out;
}

// Rango más cercano: el valor tal que el 95 % de las demoras es menor o igual.
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function computeMetrics(results: ConversationResult[]): RunMetrics {
  const n = results.length;
  const turns = results.flatMap((r) => r.turns);
  const attempts = turns.flatMap((t) => t.attempts);
  const retriedTurns = turns.filter((t) => t.attempts.length > 1).length;
  const fallbackTurns = turns.filter((t) => t.usedFallback).length;
  const failures = results.map((r) => criticalFailures(r).length);
  const averages = results.flatMap((r) => (r.judge ? [judgeAverage(r.judge)] : []));
  const total = (k: 'bot' | 'customer' | 'judge') => results.reduce((sum, r) => sum + r.cost[k], 0);
  const cost = { bot: total('bot'), customer: total('customer'), judge: total('judge'), total: 0 };
  cost.total = cost.bot + cost.customer + cost.judge;
  const per = (x: number) => (n ? x / n : 0);
  return {
    conversations: n,
    turns: turns.length,
    attempts: attempts.length,
    retriedTurns,
    fallbackTurns,
    criticalFailures: failures.reduce((a, b) => a + b, 0),
    failedConversations: failures.filter((f) => f > 0).length,
    retryRate: turns.length ? retriedTurns / turns.length : 0,
    fallbackRate: turns.length ? fallbackTurns / turns.length : 0,
    judged: averages.length,
    judgeAvg: averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null,
    judgeMin: averages.length ? Math.min(...averages) : null,
    p95LatencyMs: percentile(attempts.map((a) => a.latencyMs), 95),
    cost,
    perConversation: { bot: per(cost.bot), customer: per(cost.customer), judge: per(cost.judge) },
  };
}
