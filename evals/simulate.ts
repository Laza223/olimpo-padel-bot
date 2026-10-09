// Una conversación simulada de punta a punta: guion (mensajes fijos) o persona (cliente simulado), con runTurn real
// como unidad bajo prueba, las expectativas del escenario y el juez. Todo en memoria, igual que la entrega F1.
import type { BrainConfig, ChatMessage, LlmClient } from '../src/types.ts';
import type { Policy } from '../src/policy.ts';
import type { RejectedPatch } from '../src/lead.ts';
import { emptyCard } from '../src/lead.ts';
import { argentinaTimeToUtcMs } from '../src/time.ts';
import { TransientLlmError } from '../src/brain.ts';
import { runTurn } from '../src/turn.ts';
import { CallError } from './types.ts';
import type { ConversationResult, EndReason, JudgeVerdict, TurnLog } from './types.ts';
import { splitBurst } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { parseCustomerReply } from './customer.ts';
import type { CustomerSim } from './customer.ts';
import type { Judge } from './judge.ts';
import { checkExpectations } from './expect.ts';
import { oracleViolations } from './oracle.ts';

// Fecha fija: lo único que importa es la hora argentina del escenario (saludo y reloj del historial).
export const BASE_UTC_MS = Date.UTC(2026, 9, 7, 12, 0);
const TURN_GAP_MS = 60_000;
const BOT_REPLY_MS = 5_000;

export interface SimDeps {
  llm: LlmClient;
  policy: Policy;
  config: BrainConfig;
  customer?: CustomerSim; // obligatorio para escenarios de persona
  judge?: Judge; // sin juez no hay veredicto (las pruebas unitarias lo omiten)
}

const message = (id: number, author: ChatMessage['author'], text: string, tsUtcMs: number): ChatMessage => ({ id: `m${id}`, author, text, tsUtcMs });

export async function runScenario(sc: Scenario, run: number, deps: SimDeps): Promise<ConversationResult> {
  const { llm, policy, config } = deps;
  const history: ChatMessage[] = [];
  const turns: TurnLog[] = [];
  const cost = { bot: 0, customer: 0, judge: 0 };
  let card = emptyCard();
  let endReason: EndReason = sc.tipo === 'guion' ? 'guion_completo' : 'max_turnos';
  let error: string | undefined;
  let nextId = 1;
  const start = argentinaTimeToUtcMs(sc.hora, BASE_UTC_MS);
  const maxTurns = sc.mensajes ? Math.min(sc.max_turnos, sc.mensajes.length) : sc.max_turnos;

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      const now = start + (turn - 1) * TURN_GAP_MS;
      let texts: string[];
      if (sc.mensajes) texts = splitBurst(sc.mensajes[turn - 1]);
      else {
        if (!deps.customer || !sc.persona) throw new Error(`el escenario ${sc.id} es de persona y falta el cliente simulado`);
        const r = await deps.customer.reply({ persona: sc.persona, history });
        cost.customer += r.costUsd;
        const parsed = parseCustomerReply(r.text);
        if (parsed.fin) {
          if (!turns.length) throw new Error('el cliente simulado cortó sin escribir el primer mensaje');
          endReason = 'fin_cliente';
          break;
        }
        if (!parsed.messages.length) throw new Error('el cliente simulado no escribió nada');
        texts = parsed.messages;
      }

      const ids = texts.map((t) => {
        history.push(message(nextId, 'customer', t, now));
        return `m${nextId++}`;
      });
      const rejected: RejectedPatch[] = [];
      const r = await runTurn(
        { conversationId: `${sc.id}#${run}`, history, newCustomerMessageIds: ids, card, nowUtcMs: now },
        { llm, policy, config, onRejected: (x) => rejected.push(...x) },
      );
      card = r.card;
      for (const b of r.bubbles) history.push(message(nextId++, 'bot', b, now + BOT_REPLY_MS));

      // Oráculo independiente sobre TODO globo enviado (también los textos fijos de baja y mensaje seguro): el controlador ya los filtró, esto no depende de él.
      const controllerViolations = oracleViolations(r.bubbles);

      cost.bot += r.attempts.reduce((sum, a) => sum + a.costUsd, 0);
      turns.push({
        turn,
        customer: texts,
        bubbles: r.bubbles,
        material: r.material,
        handoffs: r.handoffs,
        attempts: r.attempts.map((a) => ({
          latencyMs: a.latencyMs,
          costUsd: a.costUsd,
          inputTokens: a.inputTokens,
          cachedTokens: a.cachedTokens,
          cacheWriteTokens: a.cacheWriteTokens ?? 0,
          cacheWrite1hTokens: a.cacheWrite1hTokens ?? 0,
          outputTokens: a.outputTokens,
          thinkingTokens: a.thinkingTokens ?? null,
          violations: a.violations,
          ...(a.violations.length && a.raw ? { proposed: a.raw.bubbles } : {}),
        })),
        rejected,
        usedFallback: r.usedFallback,
        stopBot: r.stopBot,
        controllerViolations,
      });
      if (r.stopBot) {
        endReason = 'bot_parado';
        break;
      }
    }
  } catch (e) {
    // Un error pasajero del proveedor (red, límite, sin saldo) es un error de la corrida, no una falla del bot: no hay mensaje seguro ni falla_del_bot.
    error = e instanceof TransientLlmError ? `LLM pasajero (${e.kind}): ${e.message}` : e instanceof Error ? e.message : String(e);
    endReason = 'error';
    if (e instanceof CallError) cost.customer += e.costUsd;
  }

  let judge: JudgeVerdict | undefined;
  let judgeError: string | undefined;
  if (deps.judge && !error && turns.length) {
    try {
      const j = await deps.judge.evaluate({ hora: sc.hora, turns, finalCard: card });
      judge = j.verdict;
      cost.judge += j.costUsd;
    } catch (e) {
      judgeError = e instanceof Error ? e.message : String(e);
      if (e instanceof CallError) cost.judge += e.costUsd;
    }
  }

  return {
    scenarioId: sc.id,
    run,
    tipo: sc.tipo,
    tags: sc.tags,
    hora: sc.hora,
    turns,
    history,
    finalCard: card,
    endReason,
    error,
    expectFailures: error ? [] : checkExpectations(sc.espera, turns, card),
    judge,
    judgeError,
    cost,
  };
}
