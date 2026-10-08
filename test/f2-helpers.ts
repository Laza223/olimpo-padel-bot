// Ayudas de las pruebas de la parte A de F2: reloj falso, avisos falsos y cerebro con guion (sin red, sin OpenAI y sin esperas reales).
// El armado completo de la tubería está en f2-harness.ts.
import type { Clock } from '../src/clock.ts';
import { loadPolicy } from '../src/policy.ts';
import type { Policy } from '../src/policy.ts';
import type { Notifier, AlertOpts } from '../src/notify/types.ts';
import type { HandoffDecision, LeadCard, LlmClient, ModelTurn } from '../src/types.ts';
import { modelTurn, NOON_UTC } from './helpers.ts';

export const T0 = NOON_UTC; // 14:00 hora argentina del 7-oct-2026: corresponde "Buenas tardes"
export const SECRET = 'secreto-de-prueba';

// ---------- reloj falso ----------
export class FakeClock implements Clock {
  t: number;
  #timers: { id: number; at: number; fn: () => void }[] = [];
  #seq = 0;

  constructor(start = T0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.#timers.length;
  }
  // Deja correr el trabajo asíncrono que ya está listo (todo es promesas y sqlite síncrono: no hay espera real).
  async flush(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  // Avanza la hora; los timers que vencen corren en orden, y entre uno y otro se deja correr el trabajo pendiente.
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
}

// ---------- avisos falsos ----------
export class FakeNotifier implements Notifier {
  alerts: { text: string; urgent: boolean }[] = [];
  handoffs: { chatId: string; card: LeadCard; decisions: HandoffDecision[] }[] = [];
  drafts: { chatId: string; draftId: number; bubbles: string[]; material: string[] }[] = [];
  takeovers: string[] = [];
  failing = false; // un Telegram caído no puede tumbar la tubería

  alert(text: string, opts?: AlertOpts): void {
    if (this.failing) throw new Error('telegram caído');
    this.alerts.push({ text, urgent: !!opts?.urgent });
  }
  handoff(chatId: string, card: LeadCard, decisions: HandoffDecision[]): void {
    if (this.failing) throw new Error('telegram caído');
    this.handoffs.push({ chatId, card, decisions });
  }
  draft(chatId: string, draftId: number, bubbles: string[], material: string[]): void {
    if (this.failing) throw new Error('telegram caído');
    this.drafts.push({ chatId, draftId, bubbles, material });
  }
  takeover(chatId: string): void {
    if (this.failing) throw new Error('telegram caído');
    this.takeovers.push(chatId);
  }
}

// ---------- cerebro con guion ----------
export class ScriptedLlm implements LlmClient {
  calls: { input: string; model: string }[] = [];
  #handler: (n: number, input: string) => ModelTurn | Promise<ModelTurn>;

  constructor(handler: (n: number, input: string) => ModelTurn | Promise<ModelTurn>) {
    this.#handler = handler;
  }
  async generateTurn(req: { instructions: string; input: string; model: string; effort: string }) {
    this.calls.push({ input: req.input, model: req.model });
    const turn = await this.#handler(this.calls.length, req.input);
    return { turn, usage: { inputTokens: 3000, cachedTokens: 2048, outputTokens: 200 }, latencyMs: 5 };
  }
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const policyOnce = loadPolicy();
export const policy: Policy = policyOnce;
// El primer mensaje aprobado a las 14:00 (el controlador exige empezar con "Buenas tardes" si es el primero).
export const FIRST_TEXT = policyOnce.greetingRules.primerMensaje.replace('{saludo}', 'Buenas tardes');
export const turnWith = (bubbles: string[], o: Partial<ModelTurn> = {}): ModelTurn => modelTurn({ bubbles, ...o });
