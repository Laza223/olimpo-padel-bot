// Elige el proveedor del cerebro por el id del modelo: "claude-…" → Anthropic (ANTHROPIC_API_KEY); cualquier otro → OpenAI (OPENAI_API_KEY).
// La misma regla vale en src/main.ts (BOT_MODEL) y en evals/run.ts (--model).
import { OpenAiLlm } from './brain.ts';
import { AnthropicLlm } from './anthropic.ts';
import type { LlmClient } from './types.ts';

export const isClaudeModel = (model: string): boolean => model.startsWith('claude-');

// Con la clave vacía o ausente falla con "Falta …" (sin mostrar ningún valor). Nunca cae a process.env: la clave sale del `env` que se le pasa.
export function createLlm(model: string, env: Record<string, string | undefined> = process.env): LlmClient {
  const key = (name: string) => (env[name] ?? '').trim();
  return isClaudeModel(model) ? new AnthropicLlm({ apiKey: key('ANTHROPIC_API_KEY') }) : new OpenAiLlm({ apiKey: key('OPENAI_API_KEY') });
}
