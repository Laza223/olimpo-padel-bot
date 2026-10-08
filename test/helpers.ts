// Ayudas para las pruebas del cerebro: LlmClient falso (sin red) y armado de turnos/entradas.
import type { ChatMessage, LeadCard, LeadField, LlmClient, ModelTurn, TurnInput } from '../src/types.ts';
import { emptyCard } from '../src/lead.ts';

export const GREETING_TEXT = 'Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos y de qué se trata tu proyecto?';

export const modelTurn = (o: Partial<ModelTurn> = {}): ModelTurn => ({
  bubbles: [GREETING_TEXT],
  lead_patch: [],
  signals: { asks_human: false, angry: false, negotiating: false, off_knowledge: false, opt_out: false, not_a_lead: false, asked_if_ai: false },
  objections: [],
  handoff_request: null,
  team_note: '',
  material: [],
  ...o,
});

export const withSignals = (s: Partial<ModelTurn['signals']>, o: Partial<ModelTurn> = {}): ModelTurn =>
  modelTurn({ ...o, signals: { ...modelTurn().signals, ...s } });

export type FakeCall = { instructions: string; input: string; model: string; effort: string };

// Devuelve las respuestas en orden; si una es Error, la lanza. Guarda cada pedido en `calls`.
export function fakeLlm(responses: (ModelTurn | Error)[]): LlmClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let i = 0;
  return {
    calls,
    async generateTurn(req) {
      calls.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { turn: r, usage: { inputTokens: 3000, cachedTokens: 2048, outputTokens: 200 }, latencyMs: 1200 };
    },
  };
}

// 14:00 hora argentina del 7-oct-2026 (17:00 UTC) y 09:00 (12:00 UTC).
export const NOON_UTC = Date.UTC(2026, 9, 7, 17, 0);
export const MORNING_UTC = Date.UTC(2026, 9, 7, 12, 0);

export const msg = (id: string, author: ChatMessage['author'], text: string, tsUtcMs = NOON_UTC): ChatMessage => ({ id, author, text, tsUtcMs });

export function turnInput(history: ChatMessage[], newIds: string[], card: LeadCard = emptyCard(), nowUtcMs = NOON_UTC): TurnInput {
  return { conversationId: 'c1', history, newCustomerMessageIds: newIds, card, nowUtcMs };
}

export const field = (value: string, evidenceMsgId: string) => ({ value, evidenceMsgId });

// Ficha con los datos obligatorios menos los pedidos en `except`.
export function cardWith(except: LeadField[] = [], extra: LeadCard['fields'] = {}): LeadCard {
  const all: LeadCard['fields'] = {
    nombre: field('Pedro', 'm1'),
    localidad: field('Pilar', 'm1'),
    provincia: field('Buenos Aires', 'm1'),
    cantidad_canchas: field('2', 'm1'),
    modelo: field('full_panoramica', 'm1'),
    platea: field('tiene', 'm1'),
    ubicacion: field('techada', 'm1'),
    ...extra,
  };
  for (const f of except) delete all[f];
  return { ...emptyCard(), fields: all };
}
