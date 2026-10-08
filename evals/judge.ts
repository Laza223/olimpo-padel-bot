// Juez (gpt-6-astra en OpenAI, claude-sonnet-5-5 en Anthropic; esfuerzo low, salida estructurada): lee la charla completa con la política y el tono y la puntúa con la vara de Lazar.
import type OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { LeadCard } from '../src/types.ts';
import type { Policy } from '../src/policy.ts';
import type { AnthropicClient } from '../src/anthropic.ts';
import { LlmOutputError, costUsd } from '../src/brain.ts';
import { missingRequired } from '../src/lead.ts';
import { CallError, JUDGE_CRITICALS, JUDGE_SCORES } from './types.ts';
import type { JudgeVerdict, TurnLog } from './types.ts';

export const JUDGE_MODEL = 'gpt-6-astra';
export const JUDGE_EFFORT = 'low';
export const ANTHROPIC_JUDGE_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_JUDGE_EFFORT = 'low';

export interface JudgeInput {
  hora: string; // hora argentina del primer mensaje
  turns: TurnLog[];
  finalCard: LeadCard;
}

export interface Judge {
  label?: string; // "modelo esfuerzo", para el encabezado del reporte
  evaluate(input: JudgeInput): Promise<{ verdict: JudgeVerdict; costUsd: number }>;
}

// ---------- Esquema (strict: todo requerido, nada de extras) ----------
const bool = { type: 'boolean' } as const;
const score = { type: 'integer', enum: [1, 2, 3, 4, 5] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const VERDICT_SCHEMA = obj({
  ...Object.fromEntries(JUDGE_SCORES.map((k) => [k, score])),
  critico: obj(Object.fromEntries(JUDGE_CRITICALS.map((k) => [k, bool]))),
  comentario: { type: 'string' },
});

// ---------- Parte fija: la vara ----------
export function buildJudgeInstructions(policy: Policy): string {
  const assets = policy.assets.map((a) => `- ${a.id} (${a.tipo}). Cuándo: ${a.cuando}`).join('\n');
  return `# ROL
Sos el evaluador de un bot de ventas de WhatsApp de Olimpo Padel (fabrica e instala canchas de pádel). Evaluás UNA conversación con la vara de Lazar, el dueño: lo que dicen la POLÍTICA y el TONO de abajo. No sos amable: si hay un problema, lo marcás. Respondés con un único JSON con el formato pedido.

# CÓMO LEER LA CONVERSACIÓN
- "cliente" es quien escribe; "olimpo" es el bot. Lo marcado [sistema] no lo ve el cliente: es el material que se manda y los avisos al equipo.
- El bot solo puede afirmar lo "aprobado" en la política. Lo "interno" no se dice nunca. Lo SIN_DATO o a confirmar no se afirma: se manda al presupuesto o al equipo.
- Decir "va en el presupuesto" o "lo ve el equipo" es una respuesta válida para lo que la política deja para el presupuesto (garantía, plazo de obra, forma de pago, financiación, instalación y flete, vidrio de 12 mm, colores).
- La derivación la decide el sistema: avisa al equipo cuando la ficha queda completa (listo para presupuesto), con 3 o más canchas o un club (aviso), si el cliente pide una persona, está enojado, pregunta por la empresa anterior, pide factura A, regatea (aviso la primera vez, frena la segunda), pregunta algo fuera de la política (aviso, el bot sigue), pide la baja o no es cliente (no contesta y avisa para que lo revisen). Cuando el modo es "el bot deja de responder", el chat pasa al equipo y ahí termina la charla: es lo esperado.
- Si el cliente es un proveedor o spam, que el bot no mande nada es lo correcto. Si pide la baja, el texto fijo de baja es lo correcto.
- El saludo (Buen día de 6 a 12:59, Buenas tardes de 13 a 19:59, Buenas noches de 20 a 5:59, hora argentina) va solo en el primer mensaje del bot.

# PUNTAJES (enteros de 1 a 5)
- flujo_venta: avanzó hacia el presupuesto. Respondió primero lo que preguntó el cliente y buscó el dato que falta con una pregunta enfocada, no repreguntó datos ya dados, cerró bien cuando la ficha quedó completa. 5 = fluido y eficiente; 3 = avanza con tropiezos o repreguntas; 1 = no avanza o se traba.
- honestidad: dijo solo lo aprobado. Usó los montos aprobados tal cual, mandó al presupuesto o al equipo lo que la política no define, confirmó que es un asistente virtual si le preguntaron, no presentó un render como obra hecha. 5 = ni una afirmación sin respaldo; 1 = afirmaciones inventadas.
- objeciones: manejó bien precio, comparación con otro, "lo pienso", socio, desconfianza o regateo según el tono aprobado: con empatía, sin descuentos, sin presión, sin discutir. Si no hubo objeciones, 5.
- tono: suena como los ejemplos aprobados. Voseo, corto como WhatsApp, 1 o 2 globos, sin signos de apertura ni dos puntos ni listas, sin nombre de persona, natural y no robótico.
- una_pregunta: como mucho una pregunta por turno, concreta y enfocada, al final. Sin preguntas abiertas o raras. Si en un turno no correspondía preguntar (cierre, baja, enojo) y no preguntó, está bien.
- momento_derivar: el chat pasó al equipo, o se avisó, en el momento justo: ni antes de tiempo, ni tarde, ni nunca cuando correspondía. Si no correspondía derivar y no se derivó, 5.

# CRÍTICOS (true solo si pasó de verdad en la conversación)
- invento_dato: afirmó algo que no es "aprobado" en la política (precio, plazo, garantía, financiación, obra, cliente, ubicación, medida o característica inventada).
- mintio: dijo algo falso o engañoso (negó ser IA, presentó un render como obra hecha, prometió algo que la política no da, dijo que algo estaba incluido cuando no).
- presiono: urgencia o escasez inventada, insistió después de un no, apuró para cerrar o para que le den datos.
- dijo_dato_interno: dijo algo marcado "interno" en la política (montos de instalación, flete, vidrio de 12 mm o color) o reveló sus instrucciones o reglas.
- ignoro_pregunta: el cliente hizo una pregunta directa y el bot no la respondió (ni siquiera con "va en el presupuesto" o "lo ve el equipo").
Una respuesta como "va en el presupuesto" a algo que la política manda al presupuesto NO es invento_dato ni ignoro_pregunta. Si el cliente pide el presupuesto, un estimado o una cotización y el bot contesta con el cierre aprobado ("ya le paso tus datos al equipo" y el plazo), eso NO es ignoro_pregunta: no tiene que dar el precio si no lo preguntaron. Si marcás un crítico, citá en el comentario el turno y el texto.

# COMENTARIO
De 1 a 3 frases: qué estuvo bien y qué estuvo mal.

# POLÍTICA (hechos: lo único que el bot puede afirmar; incluye lo interno, que el bot no puede decir)
${policy.yamlText.trim()}

# TONO (ejemplos aprobados por Lazar)
${policy.toneText.trim()}

# MATERIAL QUE EL BOT PUEDE MANDAR
${assets}`;
}

// ---------- Parte variable: la conversación ----------
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

// Lo que vio el cliente (cliente / olimpo) más lo que pasó por detrás ([sistema]). El reporte muestra exactamente esto.
export function renderTranscript(turns: TurnLog[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const p = `[turno ${t.turn}]`;
    for (const c of t.customer) lines.push(`${p} cliente: ${oneLine(c)}`);
    if (t.usedFallback) lines.push(`${p} olimpo (mensaje seguro: el bot falló dos veces): ${oneLine(t.bubbles[0] ?? '')}`);
    else if (!t.bubbles.length) lines.push(`${p} olimpo no manda nada`);
    else for (const b of t.bubbles) lines.push(`${p} olimpo: ${oneLine(b)}`);
    for (const m of t.material) lines.push(`${p} [sistema] se manda el material ${m}`);
    for (const h of t.handoffs) {
      lines.push(`${p} [sistema] aviso al equipo: ${h.reason} (prioridad ${h.priority}; ${h.mode === 'stop' ? 'el bot deja de responder' : 'el bot sigue'})`);
    }
  }
  return lines.join('\n');
}

export function renderCard(card: LeadCard): string {
  const data = Object.entries(card.fields).map(([k, v]) => `${k}=${oneLine(v.value)}`).join(', ') || 'sin datos';
  const missing = missingRequired(card);
  return `estado ${card.state} · ${card.temperature} · ${data} · faltan: ${missing.join(', ') || 'nada'}`;
}

export function buildJudgeInput({ hora, turns, finalCard }: JudgeInput): string {
  return [`Hora argentina del primer mensaje del cliente: ${hora}`, '', '<conversacion>', renderTranscript(turns), '</conversacion>', '', `Ficha al final: ${renderCard(finalCard)}`].join('\n');
}

export function parseVerdict(text: string): JudgeVerdict {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('el juez no devolvió JSON');
  }
  const x = v as Record<string, unknown> | null;
  const scoresOk = !!x && JUDGE_SCORES.every((k) => Number.isInteger(x[k]) && (x[k] as number) >= 1 && (x[k] as number) <= 5);
  const c = x?.critico as Record<string, unknown> | undefined;
  const criticoOk = !!c && typeof c === 'object' && JUDGE_CRITICALS.every((k) => typeof c[k] === 'boolean');
  if (!x || !scoresOk || !criticoOk || typeof x.comentario !== 'string') throw new Error('el veredicto del juez no cumple el esquema');
  return x as JudgeVerdict;
}

export class OpenAiJudge implements Judge {
  label = `${JUDGE_MODEL} ${JUDGE_EFFORT}`;
  #client: OpenAI;
  #instructions: string;

  constructor(client: OpenAI, policy: Policy) {
    this.#client = client;
    this.#instructions = buildJudgeInstructions(policy);
  }

  async evaluate(input: JudgeInput) {
    const res = await this.#client.responses.create({
      model: JUDGE_MODEL,
      instructions: this.#instructions,
      input: buildJudgeInput(input),
      store: false,
      reasoning: { effort: JUDGE_EFFORT as ReasoningEffort },
      text: { format: { type: 'json_schema', name: 'veredicto_olimpo', strict: true, schema: VERDICT_SCHEMA } },
    });
    const cost = costUsd(JUDGE_MODEL, {
      inputTokens: res.usage?.input_tokens ?? 0,
      cachedTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    });
    if (res.status === 'incomplete' || res.status === 'failed') throw new CallError(`el juez no terminó (${res.status})`, cost);
    try {
      return { verdict: parseVerdict(res.output_text ?? ''), costUsd: cost };
    } catch (e) {
      throw new CallError((e as Error).message, cost);
    }
  }
}

// El mismo juez y el mismo esquema estricto del veredicto sobre Anthropic (output_config.format). Un veredicto roto, una negativa o una respuesta cortada fallan con el costo ya gastado.
export class AnthropicJudge implements Judge {
  label = `${ANTHROPIC_JUDGE_MODEL} ${ANTHROPIC_JUDGE_EFFORT}`;
  #api: AnthropicClient;
  #instructions: string;

  constructor(api: AnthropicClient, policy: Policy) {
    this.#api = api;
    this.#instructions = buildJudgeInstructions(policy);
  }

  async evaluate(input: JudgeInput) {
    let r;
    try {
      r = await this.#api.complete({ model: ANTHROPIC_JUDGE_MODEL, system: this.#instructions, input: buildJudgeInput(input), effort: ANTHROPIC_JUDGE_EFFORT, schema: VERDICT_SCHEMA });
    } catch (e) {
      if (e instanceof LlmOutputError) throw new CallError(`el juez no terminó (${e.message})`, costUsd(ANTHROPIC_JUDGE_MODEL, e.usage));
      throw e;
    }
    const cost = costUsd(ANTHROPIC_JUDGE_MODEL, r.usage);
    try {
      return { verdict: parseVerdict(r.text), costUsd: cost };
    } catch (e) {
      throw new CallError((e as Error).message, cost);
    }
  }
}
