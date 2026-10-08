// Ayudas para las pruebas del banco de pruebas: resultados inventados, juez y cliente simulado falsos (sin red).
import { emptyCard } from '../src/lead.ts';
import { JUDGE_CRITICALS, JUDGE_SCORES } from '../evals/types.ts';
import type { ConversationResult, JudgeVerdict, TurnLog } from '../evals/types.ts';
import type { Judge, JudgeInput } from '../evals/judge.ts';
import type { CustomerSim } from '../evals/customer.ts';
import type { Persona } from '../evals/scenario.ts';
import type { ChatMessage } from '../src/types.ts';

export const verdict = (score = 5, o: { critico?: Partial<JudgeVerdict['critico']>; comentario?: string; scores?: Partial<Record<(typeof JUDGE_SCORES)[number], number>> } = {}): JudgeVerdict => ({
  ...(Object.fromEntries(JUDGE_SCORES.map((k) => [k, o.scores?.[k] ?? score])) as Record<(typeof JUDGE_SCORES)[number], number>),
  critico: { ...(Object.fromEntries(JUDGE_CRITICALS.map((k) => [k, false])) as JudgeVerdict['critico']), ...o.critico },
  comentario: o.comentario ?? 'Bien.',
});

export const turnLog = (o: Partial<TurnLog> = {}): TurnLog => ({
  turn: 1,
  customer: ['Hola'],
  bubbles: ['Buen día, te escribimos de Olimpo Padel.'],
  material: [],
  handoffs: [],
  attempts: [{ latencyMs: 1000, costUsd: 0.01, violations: [] }],
  rejected: [],
  usedFallback: false,
  stopBot: false,
  controllerViolations: [],
  ...o,
});

export const result = (o: Partial<ConversationResult> = {}): ConversationResult => ({
  scenarioId: 'escenario',
  run: 1,
  tipo: 'guion',
  tags: [],
  hora: '15:00',
  turns: [turnLog()],
  history: [],
  finalCard: emptyCard(),
  endReason: 'guion_completo',
  expectFailures: [],
  judge: verdict(5),
  cost: { bot: 0.01, customer: 0, judge: 0.02 },
  ...o,
});

// Juez falso: devuelve los veredictos en orden (o lanza si es un Error) y guarda lo que recibió.
export function fakeJudge(responses: (JudgeVerdict | Error)[] = [verdict(5)], costUsd = 0.02): Judge & { calls: JudgeInput[] } {
  const calls: JudgeInput[] = [];
  let i = 0;
  return {
    calls,
    async evaluate(input) {
      calls.push(input);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { verdict: r, costUsd };
    },
  };
}

// Cliente simulado falso: escribe las respuestas en orden (la última se repite) o lanza si es un Error.
export function fakeCustomer(replies: (string | Error)[], costUsd = 0.001): CustomerSim & { calls: { persona: Persona; history: ChatMessage[] }[] } {
  const calls: { persona: Persona; history: ChatMessage[] }[] = [];
  let i = 0;
  return {
    calls,
    async reply(req) {
      calls.push({ persona: req.persona, history: [...req.history] });
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { text: r, costUsd };
    },
  };
}
