// Cliente simulado (gpt-6-luna en OpenAI, claude-haiku-5-5 en Anthropic): a partir de la persona y la charla escribe el próximo mensaje como un cliente rioplatense real.
import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { ChatMessage } from '../src/types.ts';
import type { AnthropicClient } from '../src/anthropic.ts';
import { LlmOutputError, costUsd } from '../src/brain.ts';
import { CallError } from './types.ts';
import { splitBurst } from './scenario.ts';
import type { Persona } from './scenario.ts';

export const CUSTOMER_MODEL = 'gpt-6-luna';
export const CUSTOMER_EFFORT = 'low';
export const ANTHROPIC_CUSTOMER_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_CUSTOMER_EFFORT = 'low';
export const END_MARK = '[FIN]';

export interface CustomerSim {
  label?: string; // "modelo esfuerzo", para el encabezado del reporte
  // history vacío = el primer mensaje del cliente.
  reply(req: { persona: Persona; history: ChatMessage[] }): Promise<{ text: string; costUsd: number }>;
}

export function buildCustomerInstructions(p: Persona): string {
  const known = Object.entries(p.datos_ocultos).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `Sos un cliente real de WhatsApp en Argentina. Le escribís a Olimpo Padel, una empresa que fabrica e instala canchas de pádel. Nunca decís que sos una simulación ni una IA.

TU PERFIL
${p.perfil}

LO QUE SABÉS DE TU PROYECTO
Lo soltás de a poco, cuando te lo preguntan o te sale natural. No inventes datos que contradigan esto; lo que no figura acá, no lo sabés o no te importa.
${known}

TU ESTILO
${p.estilo}

TU OBJETIVO
${p.objetivo}

CÓMO ESCRIBÍS
- Como un cliente rioplatense real por WhatsApp: mensajes cortos e informales, con voseo. Nada de lenguaje de empresa ni de asistente.
- A veces das varios datos juntos y a veces contestás solo lo que te preguntaron. No siempre colaborás: podés esquivar una pregunta, cambiar de tema o preguntar otra cosa.
- Respondé a lo que te dice la empresa. No repitas lo que ya dijiste.
- Si querés mandar varios mensajes seguidos, separalos con " || ".
- Escribí solo el texto del mensaje: sin comillas, sin aclaraciones, sin el nombre de quien habla.
- Si ya conseguiste tu objetivo o te cansaste, respondé exactamente ${END_MARK} y nada más. No lo uses en tu primer mensaje.`;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export function buildCustomerInput(history: ChatMessage[]): string {
  const talk = history.filter((m) => m.author === 'customer' || m.author === 'bot');
  if (!talk.length) return 'Todavía no escribiste nada. Escribí tu primer mensaje a la empresa.';
  const lines = talk.map((m) => `${m.author === 'customer' ? 'Vos' : 'Empresa'}: ${oneLine(m.text)}`);
  return `${lines.join('\n')}\n\nEscribí tu próximo mensaje (o ${END_MARK}).`;
}

// El cliente corta con [FIN]; si no, puede mandar una ráfaga separada con "||".
export function parseCustomerReply(text: string): { fin: boolean; messages: string[] } {
  const fin = text.includes(END_MARK);
  const messages = splitBurst(text.replaceAll(END_MARK, '')).map((m) => m.replace(/^["“]+|["”]+$/g, '').trim()).filter(Boolean);
  return { fin, messages };
}

export class OpenAiCustomer implements CustomerSim {
  label = `${CUSTOMER_MODEL} ${CUSTOMER_EFFORT}`;
  #client: OpenAI;

  constructor(client: OpenAI) {
    this.#client = client;
  }

  async reply({ persona, history }: { persona: Persona; history: ChatMessage[] }) {
    const res = await this.#client.responses.create({
      model: CUSTOMER_MODEL,
      instructions: buildCustomerInstructions(persona),
      input: buildCustomerInput(history),
      store: false,
      reasoning: { effort: CUSTOMER_EFFORT as ReasoningEffort },
    });
    const cost = costUsd(CUSTOMER_MODEL, {
      inputTokens: res.usage?.input_tokens ?? 0,
      cachedTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    });
    if (res.status === 'incomplete' || res.status === 'failed') throw new CallError(`el cliente simulado no terminó (${res.status})`, cost);
    const text = (res.output_text ?? '').trim();
    if (!text) throw new CallError('el cliente simulado devolvió una respuesta vacía', cost);
    return { text, costUsd: cost };
  }
}

// Mismo cliente simulado sobre Anthropic: texto libre (sin esquema). Una negativa o una respuesta cortada fallan con el costo ya gastado; red y límites suben como TransientLlmError.
export class AnthropicCustomer implements CustomerSim {
  label = `${ANTHROPIC_CUSTOMER_MODEL} ${ANTHROPIC_CUSTOMER_EFFORT}`;
  #api: AnthropicClient;

  constructor(api: AnthropicClient) {
    this.#api = api;
  }

  async reply({ persona, history }: { persona: Persona; history: ChatMessage[] }) {
    let r;
    try {
      r = await this.#api.complete({ model: ANTHROPIC_CUSTOMER_MODEL, system: buildCustomerInstructions(persona), input: buildCustomerInput(history), effort: ANTHROPIC_CUSTOMER_EFFORT });
    } catch (e) {
      if (e instanceof LlmOutputError) throw new CallError(`el cliente simulado no terminó (${e.message})`, costUsd(ANTHROPIC_CUSTOMER_MODEL, e.usage));
      throw e;
    }
    const cost = costUsd(ANTHROPIC_CUSTOMER_MODEL, r.usage);
    const text = r.text.trim();
    if (!text) throw new CallError('el cliente simulado devolvió una respuesta vacía', cost);
    return { text, costUsd: cost };
  }
}
