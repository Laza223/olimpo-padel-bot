// Cerebro falso (BOT_LLM=fake): probar la tubería sin gastar ni llamar a OpenAI. Devuelve un turno que pasa el controlador:
// el primer mensaje del bot es el primer mensaje aprobado con el saludo de la hora; después, una pregunta fija de zona.
import type { Policy } from './policy.ts';
import type { LlmClient, ModelTurn } from './types.ts';

export const FAKE_FOLLOWUP = 'Dale, anotado. En qué zona serían las canchas?';

export class FakeLlm implements LlmClient {
  calls = 0;
  #policy: Policy;

  constructor(policy: Policy) {
    this.#policy = policy;
  }

  async generateTurn(req: { instructions: string; input: string; model: string; effort: string }) {
    this.calls++;
    // El saludo y si es el primer mensaje del bot ya vienen calculados en el <contexto> del pedido.
    const greeting = /saludo_que_corresponde: (.+)/.exec(req.input)?.[1]?.trim() ?? 'Buen día';
    const first = /primer_mensaje_del_bot: sí/.test(req.input);
    const bubble = first ? this.#policy.greetingRules.primerMensaje.replace('{saludo}', greeting) : FAKE_FOLLOWUP;
    const turn: ModelTurn = {
      bubbles: [bubble],
      lead_patch: [],
      signals: { asks_human: false, angry: false, negotiating: false, off_knowledge: false, opt_out: false, not_a_lead: false, asked_if_ai: false },
      objections: [],
      handoff_request: null,
      team_note: '',
      material: [],
    };
    return { turn, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, latencyMs: 0 }; // sin tokens: no gasta presupuesto
  }
}
