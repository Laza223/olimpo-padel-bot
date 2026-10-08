// Ayudas para las pruebas del proveedor Anthropic: un fetch falso (guarda cada pedido) y respuestas con la forma de la Messages API.
import { modelTurn } from './helpers.ts';

export const KEY = 'sk-ant-test-SECRET1234567890';
export type Body = Record<string, any>;

export type Step = { status?: number; body?: unknown; raw?: string; error?: Error; headers?: Record<string, string> };
export type Sent = { url: string; method?: string; headers: Record<string, string>; body: Body; signal?: AbortSignal | null };

// Responde los pasos en orden (el último se repite); un paso con `error` hace que fetch falle como si no hubiera red.
export function fakeFetch(steps: Step | Step[]) {
  const list = Array.isArray(steps) ? steps : [steps];
  const sent: Sent[] = [];
  let i = 0;
  const fn: typeof fetch = async (input, init) => {
    const step = list[Math.min(i++, list.length - 1)];
    sent.push({ url: String(input), method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)), signal: init?.signal });
    if (step.error) throw step.error;
    return new Response(step.raw ?? JSON.stringify(step.body), { status: step.status ?? 200, headers: step.headers });
  };
  return { fetch: fn, sent };
}

export const usageOk = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 2960, output_tokens: 150 };

export const message = (o: { content?: unknown[]; stop_reason?: string; usage?: Record<string, unknown>; stop_details?: unknown } = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: o.content ?? [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: JSON.stringify(modelTurn()) }],
  stop_reason: o.stop_reason ?? 'end_turn',
  stop_details: o.stop_details ?? null,
  stop_sequence: null,
  usage: o.usage ?? usageOk,
});

export const textMessage = (text: string, usage: Record<string, unknown> = usageOk) => message({ content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }], usage });

export const errorBody = (type: string, text = 'mensaje', extra: Body = {}) => ({ type: 'error', error: { type, message: text, ...extra }, request_id: 'req_011ABC' });
