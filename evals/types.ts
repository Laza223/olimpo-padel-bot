// Tipos del banco de pruebas: lo que sale de una conversación simulada y lo que miden las métricas, la vara y el reporte.
import type { ChatMessage, HandoffDecision, LeadCard } from '../src/types.ts';
import type { RejectedPatch } from '../src/lead.ts';

// ---------- Juez ----------
export const JUDGE_SCORES = ['flujo_venta', 'honestidad', 'objeciones', 'tono', 'una_pregunta', 'momento_derivar'] as const;
export type JudgeScoreKey = (typeof JUDGE_SCORES)[number];
export const JUDGE_CRITICALS = ['invento_dato', 'mintio', 'presiono', 'dijo_dato_interno', 'ignoro_pregunta'] as const;
export type JudgeCriticalKey = (typeof JUDGE_CRITICALS)[number];

export type JudgeVerdict = Record<JudgeScoreKey, number> & {
  critico: Record<JudgeCriticalKey, boolean>;
  comentario: string;
};

// Una llamada al cliente simulado o al juez que falló después de gastar tokens: el costo no se pierde.
export class CallError extends Error {
  costUsd: number;
  constructor(message: string, costUsd = 0) {
    super(message);
    this.name = 'CallError';
    this.costUsd = costUsd;
  }
}

// ---------- Conversación simulada ----------
export interface AttemptSummary {
  latencyMs: number;
  costUsd: number;
  // Tokens del bot en este intento (para medir el caché y el pensamiento). inputTokens incluye lo leído y lo escrito del caché; thinkingTokens null = el proveedor no lo informó.
  // Opcionales: simulate.ts siempre los llena; las métricas cuentan lo que falta como 0 (y el pensamiento como "sin dato").
  inputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number | null;
  violations: { rule: string; detail: string }[];
  proposed?: string[]; // lo que el modelo había propuesto, solo si el intento tuvo violaciones (para entender qué pasó)
}

export interface TurnLog {
  turn: number; // 1-based
  customer: string[]; // los mensajes del cliente que abren el turno (más de uno = ráfaga)
  bubbles: string[];
  material: string[];
  handoffs: HandoffDecision[];
  attempts: AttemptSummary[];
  rejected: RejectedPatch[]; // datos que applyPatch descartó
  usedFallback: boolean;
  stopBot: boolean;
  controllerViolations: { rule: string; detail: string }[]; // globos enviados que el oráculo independiente (evals/oracle.ts) rechaza: cada uno es una falla crítica
}

export type EndReason = 'bot_parado' | 'fin_cliente' | 'max_turnos' | 'guion_completo' | 'error';

export interface ConversationResult {
  scenarioId: string;
  run: number; // 1-based
  tipo: 'guion' | 'persona';
  tags: string[];
  hora: string;
  turns: TurnLog[];
  history: ChatMessage[];
  finalCard: LeadCard;
  endReason: EndReason;
  error?: string;
  expectFailures: string[];
  judge?: JudgeVerdict;
  judgeError?: string;
  cost: { bot: number; customer: number; judge: number }; // USD, cada uno aparte
}
