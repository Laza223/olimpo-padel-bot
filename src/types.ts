// Contrato compartido entre el cerebro (src/) y el banco de pruebas (evals/). Cambiarlo = avisar a ambos lados.

// ---------- Conversación ----------
export type Author = 'customer' | 'bot' | 'team' | 'system';

export interface ChatMessage {
  id: string; // ej. "m7": se le muestra al modelo para que cite de dónde salió cada dato
  author: Author;
  text: string;
  tsUtcMs: number;
}

export type ConversationMode = 'auto' | 'humano' | 'pausado' | 'cerrado';

// ---------- Ficha del cliente ----------
export const LEAD_FIELDS = [
  'nombre',
  'localidad', // localidad o barrio/country
  'provincia',
  'cantidad_canchas', // número entero como texto: "2"
  'modelo', // full_panoramica | panoramica
  'platea', // tiene | no_tiene | la_hace_cliente | quiere_que_la_hagamos
  'ubicacion', // techada | aire_libre
  'altura_libre_m', // metros de altura libre, solo si va techada: "6" o "7.5" (opcional, no frena el presupuesto)
  'plazo_deseado',
  'forma_pago',
  'quien_decide',
  'uso', // club | inversion | particular | otro
  'pide_financiacion', // si
  'vidrio_12mm', // si
  'color_especial', // texto libre de lo que pidió
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

// Los que tienen que estar para pasar al equipo (policy/olimpo.yaml → presupuesto.datos_obligatorios).
export const REQUIRED_FIELDS: LeadField[] = ['nombre', 'localidad', 'provincia', 'cantidad_canchas', 'modelo', 'platea', 'ubicacion'];

export type LeadState = 'nuevo' | 'calificando' | 'listo_para_presupuesto' | 'derivado' | 'descartado' | 'baja' | 'no_es_cliente';
export type Temperature = 'caliente' | 'tibio' | 'frio';

export interface LeadCard {
  fields: Partial<Record<LeadField, { value: string; evidenceMsgId: string }>>;
  objections: Objection[];
  state: LeadState;
  temperature: Temperature;
  teamNote: string; // nota interna del modelo para el equipo (nunca se le manda al cliente)
  flags: { negotiatingCount: number; offKnowledgeCount: number };
  notified?: HandoffReason[]; // motivos ya avisados al equipo: un mismo aviso (flag) no se repite en la conversación
}

export const OBJECTIONS = ['precio', 'confianza', 'plazo', 'forma_pago', 'competencia', 'consultar_socio', 'pensarlo', 'otro'] as const;
export type Objection = (typeof OBJECTIONS)[number];

// ---------- Salida estructurada del modelo (un JSON por turno, esquema estricto) ----------
export interface ModelTurn {
  bubbles: string[]; // 1 o 2 mensajes para el cliente
  lead_patch: { field: LeadField; value: string; evidence_msg_id: string }[];
  signals: {
    asks_human: boolean;
    angry: boolean;
    negotiating: boolean; // pide descuento o regatea
    off_knowledge: boolean; // preguntó algo que no está en la política
    opt_out: boolean; // "no me escriban más"
    not_a_lead: boolean; // proveedor, familia, spam, alguien que no quiere una cancha
    asked_if_ai: boolean;
  };
  objections: Objection[];
  handoff_request: { reason: HandoffReason; priority: Priority } | null; // propuesta: decide el código
  team_note: string; // cómo conviene encararlo (interno)
  material: string[]; // ids de policy/assets.yaml
}

export type HandoffReason =
  | 'listo_para_presupuesto'
  | 'cliente_grande' // 3+ canchas o club
  | 'pide_persona'
  | 'enojado'
  | 'pregunta_por_empresa_anterior'
  | 'pide_verificacion' // duda por 2.ª vez de quiénes somos (taller, obras, antigüedad): lo atiende una persona
  | 'factura_a'
  | 'regateo'
  | 'fuera_de_politica'
  | 'baja'
  | 'no_es_cliente'
  | 'falla_del_bot'
  | 'audio_ilegible'; // un audio que no se pudo escuchar, por 2.ª vez en la conversación: la decide el código (el modelo no la pide)
export type Priority = 'alta' | 'normal' | 'baja';

// Qué hace el código con una derivación: "stop" = el bot deja de responder ese chat; "flag" = avisa y sigue.
export interface HandoffDecision {
  reason: HandoffReason;
  priority: Priority;
  mode: 'stop' | 'flag';
}

// ---------- Lo que necesita un turno ----------
export interface TurnInput {
  conversationId: string;
  history: ChatMessage[]; // todo lo anterior, incluido lo nuevo del cliente al final
  newCustomerMessageIds: string[]; // los mensajes del cliente que abren este turno (ráfaga agrupada)
  card: LeadCard;
  nowUtcMs: number; // reloj inyectable (las pruebas fijan la hora)
}

export interface TurnResult {
  bubbles: string[]; // lo que se manda (ya pasó el controlador, o es el mensaje seguro)
  material: string[]; // assets a mandar después de los globos
  card: LeadCard; // ficha actualizada
  handoffs: HandoffDecision[];
  stopBot: boolean; // true → el chat pasa a manos del equipo
  usedFallback: boolean;
  attempts: AttemptLog[]; // 1 o 2 (reintento)
}

export interface AttemptLog {
  model: string;
  effort: string;
  latencyMs: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number; // solo Anthropic: lo escrito en el caché (cuesta 1,25x con TTL de 5 min, 2x con 1 h)
  cacheWrite1hTokens?: number; // la parte de cacheWriteTokens escrita con TTL de 1 h
  outputTokens: number;
  thinkingTokens?: number | null; // la parte de outputTokens que fue pensamiento; null o ausente = no se informó
  costUsd: number;
  violations: { rule: string; detail: string }[];
  raw?: ModelTurn;
}

// ---------- El modelo, inyectable (real = OpenAI o Anthropic; pruebas = falso) ----------
export interface LlmClient {
  generateTurn(req: { instructions: string; input: string; model: string; effort: string }): Promise<{
    turn: ModelTurn;
    usage: { inputTokens: number; cachedTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheWrite1hTokens?: number; thinkingTokens?: number | null };
    latencyMs: number;
  }>;
}

export interface BrainConfig {
  model: string; // ej. "gpt-6.1-sol" | "gpt-6-luna" | "claude-haiku-5-5" (el prefijo "claude-" elige Anthropic)
  effort: string; // OpenAI: "low" | "medium" | "none" (none no existe en 6.1-sol). Anthropic: low | medium | high | xhigh | max
}
