// Un turno completo: llama al modelo, lo controla (supervise + chequeos de turno), reintenta una vez y,
// si vuelve a fallar, manda el mensaje seguro. La ficha y las derivaciones las decide el código.
import { AUDIO_PREFIX } from './audio.ts';
import type { AttemptLog, BrainConfig, HandoffDecision, LeadCard, LeadState, LlmClient, ModelTurn, TurnInput, TurnResult } from './types.ts';
import { HEIGHT_TOPIC, supervise } from './supervisor/index.ts';
import { customerMentionsElite, fold, words } from './supervisor/normalize.ts';
import type { Violation } from './supervisor/index.ts';
import type { Policy } from './policy.ts';
import { buildInput, buildInstructions, costUsd, isFirstBotMessage, LlmOutputError, TransientLlmError } from './brain.ts';
import { applyPatch, computeState, computeTemperature, financingFromCustomer, missingRequired, plain, withDeducedProvince } from './lead.ts';
import type { RejectedPatch } from './lead.ts';
import { decideHandoffs } from './handoff.ts';
import { greetingFor } from './time.ts';
import { promptFamily } from './llm.ts';

// Textos fijos: tienen que pasar el controlador (hay una prueba que lo verifica).
export const OPT_OUT_TEXT = 'Listo, no te escribimos más. Si más adelante lo necesitás, escribinos por acá.';
export const FALLBACK_TEXT = 'Gracias por escribirnos, ya le paso tu consulta al equipo.'; // policy: si_el_bot_falla.texto (lo verifica una prueba)

export interface TurnDeps {
  llm: LlmClient;
  policy: Policy;
  config: BrainConfig;
  onRejected?: (rejected: RejectedPatch[]) => void; // datos del modelo que applyPatch descartó (para el log)
}

const MAX_ATTEMPTS = 2; // el intento y un reintento
const MAX_MATERIAL = 2; // assets por turno (assets.yaml: "Máximo 2 por mensaje")

// Con la ficha en alguno de estos estados el chat ya no es del bot: ni modelo, ni globos, ni avisos.
export const TERMINAL: LeadState[] = ['baja', 'no_es_cliente', 'derivado', 'descartado'];
// Respaldo de la señal opt_out del modelo: el cliente pide que no le escriban más (texto normalizado, sin tildes).
// Solo frases inequívocas: lo dudoso ("no me manden presupuesto hasta…", "no me llamen, prefiero por acá") lo decide la señal del modelo.
// "No me manden más fotos" o "dejen de mandarme tantas fotos" piden menos de algo, no la baja: por eso el objeto corta la frase.
const PARTIAL = String.raw`(?! (?:tantas?|tantos|fotos|videos?|audios?|mails?|correos?|presupuestos?|precios?|cotizaciones?|llamadas?|publicidad|promos?|ofertas?|esos|esas))`;
const OPT_OUT = new RegExp(
  String.raw`no me (escriban|escribas|molesten|molestes|contacten|contactes)\b|no me (manden|mandes|envien|envies) (mas|nada)\b${PARTIAL}|\bdej(a|en|es) de (escribir|mandar|enviar|molestar)(?:me|nos)?\b${PARTIAL}|\bborr(a|en|es|e)\w* (mi|el) (numero|contacto)|\b(dame|denme|darme|me doy) de baja\b|^\s*baja\W*$`,
  'm',
);
// Veto: si el texto condiciona o redirige ("pero sigo interesado", "mejor por acá", "hasta que hable con mi socio", "a la noche no"),
// la regex no fuerza la baja y decide la señal del modelo. Lo mismo con horarios ("de noche", "los fines de semana", "antes de las 9") y
// pausas ("por ahora", "todavía", "cuando decida", "yo les aviso"): piden otra cosa que la baja. Un mensaje largo tampoco: hay contexto que la regex no lee.
const OPT_OUT_VETO = /\b(?:pero|sigo|hasta|por aca|mejor|solo|por (?:mail|telefono)|a la (?:noche|manana|tarde)|llam\w*|por ahora|todavia|de noche|antes de|despues de|fines? de semana|cuando|yo (?:les|te) aviso|aviso yo)\b/;
const OPT_OUT_MAX_CHARS = 80;

// Cierra el turno con la ficha al día: temperatura y motivos ya avisados.
function finish(before: LeadCard, card: LeadCard, handoffs: HandoffDecision[]): LeadCard {
  card.temperature = computeTemperature(card);
  card.notified = [...new Set([...(before.notified ?? []), ...handoffs.map((h) => h.reason)])];
  return card;
}

// La ficha que resulta del turno propuesto, antes de las derivaciones, el estado y la temperatura. Pura: no toca `input`.
// La usan el chequeo del turno (para saber qué pasaría) y runTurn (para armar la ficha real).
export function nextCard(input: TurnInput, turn: ModelTurn, policy: Policy): { card: LeadCard; rejected: RejectedPatch[] } {
  const { card: before, history } = input;
  const s = turn.signals;
  const closing = s.opt_out || s.not_a_lead; // baja o no es cliente: no se toma ningún dato ni contador de este turno
  const { card: patched, rejected } = closing ? { card: structuredClone(before), rejected: [] } : applyPatch(before, turn.lead_patch, history);
  const card: LeadCard = {
    ...patched,
    objections: closing ? patched.objections : [...new Set([...patched.objections, ...turn.objections])],
    teamNote: turn.team_note.trim() || patched.teamNote,
    flags: {
      negotiatingCount: patched.flags.negotiatingCount + (!closing && s.negotiating ? 1 : 0),
      offKnowledgeCount: patched.flags.offKnowledgeCount + (!closing && s.off_knowledge ? 1 : 0),
    },
  };
  const financing = closing ? undefined : financingFromCustomer(card, history, input.newCustomerMessageIds);
  if (financing) card.fields.pide_financiacion = financing;
  if (!closing) withDeducedProvince(card);
  // Techada con menos del mínimo: queda anotado para el equipo (sin derivar).
  const alt = Number(card.fields.altura_libre_m?.value);
  if (card.fields.ubicacion?.value === 'techada' && alt > 0 && alt < policy.minHeightM && !/altura libre/i.test(card.teamNote)) {
    card.teamNote = `${card.teamNote} Altura libre ${alt} m (mínimo ${policy.minHeightM}): revisar si entra antes del presupuesto.`.trim();
  }
  return { card, rejected };
}

// Chequeos de turno que se suman a supervise().
function turnChecks(turn: ModelTurn, input: TurnInput, policy: Policy): Violation[] {
  const s = turn.signals;
  if (s.opt_out || s.not_a_lead) return []; // en esos casos no se manda nada de lo que escribió el modelo
  const { history, card, nowUtcMs } = input;
  const customerTexts = history.filter((m) => m.author === 'customer').map((m) => m.text);
  const newTexts = history.filter((m) => m.author === 'customer' && input.newCustomerMessageIds.includes(m.id)).map((m) => m.text);
  // Solo con la ficha en techada y la altura libre en el mínimo de la política el bot puede decir que entra.
  const after = nextCard(input, turn, policy).card;
  const heightOk = after.fields.ubicacion?.value === 'techada' && Number(after.fields.altura_libre_m?.value) >= policy.minHeightM;
  const renderShown = turn.material.some((id) => policy.assets.find((a) => a.id === id)?.tipo === 'render');
  // Techada, con altura cargada o con la altura en la nota del equipo: de la altura no se afirma nada sin los 7 m.
  const heightContext = after.fields.ubicacion?.value === 'techada' || !!after.fields.altura_libre_m || HEIGHT_TOPIC.test(fold(card.teamNote));
  const v = supervise({ bubbles: turn.bubbles, askedIfAi: s.asked_if_ai, newCustomerTexts: newTexts, renderShown, heightOk, heightContext }, customerTexts, policy.supervisorPolicy);

  const startsWith = (b: string, g: string) => plain(b).trim().startsWith(plain(g));
  if (isFirstBotMessage(history)) {
    const g = greetingFor(nowUtcMs);
    if (!turn.bubbles[0] || !startsWith(turn.bubbles[0], g)) v.push({ rule: 'greeting', detail: `es el primer mensaje: el primer globo tiene que empezar con "${g}"` });
  } else if (turn.bubbles.some((b) => policy.greetingRules.greetings.some((g) => startsWith(b, g)))) {
    v.push({ rule: 'greeting', detail: 'ya saludaste antes: ningún globo empieza con Buen día, Buenas tardes ni Buenas noches' });
  }

  const unknown = turn.material.filter((id) => !policy.assets.some((a) => a.id === id));
  if (unknown.length) v.push({ rule: 'material', detail: `ids que no existen en assets: ${unknown.join(', ')}` });

  // Si con este patch la ficha queda completa, algún globo tiene que decir el plazo aprobado del presupuesto, tal cual
  // (sin importar mayúsculas, tildes ni puntuación): una frase parecida o inventada no alcanza.
  const approved = words(policy.closingText);
  const saysClosing = turn.bubbles.some((b) => words(b).includes(approved));
  const completes = missingRequired(card).length > 0 && missingRequired(after).length === 0;
  if (completes && !saysClosing) {
    v.push({ rule: 'closing', detail: `la ficha quedó completa: un globo tiene que decir "${policy.closingText}" tal cual` });
  }
  // Preguntaron por la empresa anterior: algún globo dice la respuesta aprobada, tal cual (una respuesta distinta, por ejemplo "somos los mismos", se rechaza).
  const eliteAnswer = words(policy.eliteAnswerText);
  if (customerMentionsElite(newTexts.join('\n')) && !turn.bubbles.some((b) => words(b).includes(eliteAnswer))) {
    v.push({ rule: 'elite_answer', detail: `preguntaron por la empresa anterior: un globo tiene que decir "${policy.eliteAnswerText}" tal cual` });
  }
  // Al revés: con datos obligatorios todavía faltando, prometer el presupuesto no corresponde (no habría derivación).
  // Condicionado a los datos ("Apenas tengamos los datos que faltan…") sí: es la respuesta a "cuándo me llega?".
  const conditional = turn.bubbles.some((b) => words(b).includes(approved) && /\b(apenas|cuando|en cuanto|una vez que|ni bien)\b/.test(words(b)));
  if (saysClosing && !conditional && missingRequired(after).length > 0) {
    v.push({ rule: 'closing_early', detail: `todavía faltan datos obligatorios (${missingRequired(after).join(', ')}): no prometas el presupuesto, pedí el dato que falta` });
  }
  // Si con este turno el chat pasa al equipo, el cliente no tiene a quién contestarle: ninguna pregunta (los textos aprobados de cierre no llevan "?").
  const stops = decideHandoffs({ before: card, after, turn, customerText: newTexts.join('\n') }).some((h) => h.mode === 'stop');
  if (stops && turn.bubbles.some((b) => b.includes('?'))) {
    v.push({ rule: 'stop_question', detail: 'en el turno en que el chat pasa al equipo no se pregunta nada: contestá, avisá que le pasás la consulta al equipo y cerrá sin pregunta' });
  }
  return v;
}

// Haiku insiste con "te cuento la diferencia: la Full…" aunque el prompt lo prohíbe, y dos intentos así terminan en el mensaje seguro.
// Los dos puntos son una regla de estilo, no de seguridad comercial: en Claude se cambian por una coma antes del controlador. Sol no pasa por acá.
function withoutColons(turn: ModelTurn): ModelTurn {
  return { ...turn, bubbles: turn.bubbles.map((b) => b.replace(/\s*:(?!\/\/)\s*/g, ', ')) };
}

// Sonnet pega el cierre aprobado detrás de una coma y con su mayúscula ("...que faltan, Te mandamos el presupuesto..."). Es una errata, no una falla:
// se baja solo esa primera letra y solo del texto aprobado (bajar mayúsculas en general rompería los nombres propios). Sol no pasa por acá.
function withClosingAfterComma(turn: ModelTurn, closingText: string): ModelTurn {
  const lowered = closingText.charAt(0).toLowerCase() + closingText.slice(1);
  return { ...turn, bubbles: turn.bubbles.map((b) => b.replaceAll(`, ${closingText}`, () => `, ${lowered}`)) };
}

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const { llm, policy, config } = deps;
  costUsd(config.model, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }); // falla ya si el modelo no tiene precio
  const stopped = (card: LeadCard, bubbles: string[], handoffs: HandoffDecision[]): TurnResult =>
    ({ bubbles, material: [], card, handoffs, stopBot: true, usedFallback: false, attempts: [] });
  if (TERMINAL.includes(input.card.state)) return stopped(structuredClone(input.card), [], []);
  const newMessages = input.history.filter((m) => m.author === 'customer' && input.newCustomerMessageIds.includes(m.id)).map((m) => m.text);
  const newText = newMessages.join('\n');
  // El prefijo "(audio) " no es parte de lo que dijo el cliente: se saca antes de las regex y del tope de largo (si no, "^baja$" no corta por audio).
  const foldedNew = fold(newMessages.map((t) => (t.startsWith(AUDIO_PREFIX) ? t.slice(AUDIO_PREFIX.length) : t)).join('\n'));
  if (foldedNew.length <= OPT_OUT_MAX_CHARS && OPT_OUT.test(foldedNew) && !OPT_OUT_VETO.test(foldedNew)) {
    const handoffs: HandoffDecision[] = [{ reason: 'baja', priority: 'baja', mode: 'stop' }];
    return stopped(finish(input.card, { ...structuredClone(input.card), state: 'baja' }, handoffs), [OPT_OUT_TEXT], handoffs);
  }
  const family = promptFamily(config.model);
  const instructions = buildInstructions(policy, { family });
  const attempts: AttemptLog[] = [];
  let errors: Violation[] = [];
  let draft: string[] | undefined; // los globos del borrador descartado: el reintento de Claude los muestra
  let refused = false; // el modelo se negó: repetir el mismo pedido no cambia nada, va directo al mensaje seguro
  let accepted: ModelTurn | undefined;

  for (let i = 0; i < MAX_ATTEMPTS && !accepted && !refused; i++) {
    const log: AttemptLog = { model: config.model, effort: config.effort, latencyMs: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, violations: [] };
    const t0 = Date.now();
    try {
      const r = await llm.generateTurn({ instructions, input: buildInput(input, policy, errors, { family, rejected: draft }), model: config.model, effort: config.effort });
      Object.assign(log, { latencyMs: r.latencyMs, ...r.usage, raw: r.turn });
      log.costUsd = costUsd(config.model, r.usage);
      const turn = family === 'claude' ? withClosingAfterComma(withoutColons(r.turn), policy.closingText) : r.turn;
      log.violations = turnChecks(turn, input, policy);
      if (!log.violations.length) accepted = turn;
      else draft = turn.bubbles;
    } catch (e) {
      draft = undefined; // sin borrador: no hubo respuesta válida que mostrar
      // Red, timeout, 5xx, límite o sin saldo: no es falla del bot; se relanza y quien llama reintenta más tarde (sin intento ni mensaje seguro).
      if (e instanceof TransientLlmError) {
        e.attempts = attempts; // lo ya gastado en intentos anteriores de este turno no se pierde
        throw e;
      }
      // Refusal, incompleto o JSON inválido: cuenta como violación (reintento / mensaje seguro).
      if (e instanceof LlmOutputError) {
        Object.assign(log, { latencyMs: e.latencyMs, ...e.usage });
        log.costUsd = costUsd(config.model, e.usage);
        refused = e.kind === 'refusal';
      } else {
        log.latencyMs = Date.now() - t0;
      }
      log.violations = [{ rule: 'llm', detail: e instanceof Error ? e.message : String(e) }];
    }
    attempts.push(log);
    errors = log.violations;
  }

  const before = input.card;

  if (!accepted) {
    const handoffs: HandoffDecision[] = [{ reason: 'falla_del_bot', priority: 'alta', mode: 'stop' }];
    const card = finish(before, { ...structuredClone(before), state: 'derivado' }, handoffs);
    return { bubbles: [FALLBACK_TEXT], material: [], card, handoffs, stopBot: true, usedFallback: true, attempts };
  }

  const s = accepted.signals;
  const { card, rejected } = nextCard(input, accepted, policy);
  if (rejected.length) deps.onRejected?.(rejected);
  const handoffs = decideHandoffs({ before, after: card, turn: accepted, customerText: newText });
  const stopBot = handoffs.some((h) => h.mode === 'stop');
  card.state = s.opt_out ? 'baja' : s.not_a_lead ? 'no_es_cliente' : stopBot ? 'derivado' : computeState(card);

  const silent = s.not_a_lead && !s.opt_out; // proveedor, spam: no se contesta
  const bubbles = s.opt_out ? [OPT_OUT_TEXT] : silent ? [] : accepted.bubbles;
  const material = s.opt_out || silent ? [] : [...new Set(accepted.material)].slice(0, MAX_MATERIAL); // sin repetidos y como mucho 2 por turno
  return { bubbles, material, card: finish(before, card, handoffs), handoffs, stopBot, usedFallback: false, attempts };
}
