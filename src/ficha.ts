// Ficha para el equipo (en F2 sale por Telegram): motivo, datos, qué falta y la charla reciente.
import { LEAD_FIELDS } from './types.ts';
import type { ChatMessage, HandoffDecision, HandoffReason, LeadCard, LeadField } from './types.ts';
import { DEDUCED, missingRequired } from './lead.ts';
import { argentinaClock } from './time.ts';

export const LABELS: Record<LeadField, string> = {
  nombre: 'Nombre', localidad: 'Localidad', provincia: 'Provincia', cantidad_canchas: 'Canchas', modelo: 'Modelo',
  platea: 'Platea', ubicacion: 'Ubicación', altura_libre_m: 'Altura libre (m)', plazo_deseado: 'Plazo deseado', forma_pago: 'Forma de pago',
  quien_decide: 'Quién decide', uso: 'Uso', pide_financiacion: 'Pide financiación', vidrio_12mm: 'Vidrio 12 mm',
  color_especial: 'Color especial',
};

export const REASONS: Record<HandoffReason, string> = {
  listo_para_presupuesto: 'Listo para presupuesto',
  cliente_grande: 'Cliente grande (3 o más canchas, o club)',
  pide_persona: 'Pide hablar con una persona',
  enojado: 'Cliente enojado',
  pregunta_por_empresa_anterior: 'Pregunta por la empresa anterior',
  pide_verificacion: 'Quiere comprobar quiénes somos (taller, obras, antigüedad)',
  factura_a: 'Pide factura A',
  regateo: 'Regatea el precio',
  fuera_de_politica: 'Pregunta algo fuera de lo definido',
  baja: 'Pidió que no le escribamos más',
  no_es_cliente: 'No es cliente',
  falla_del_bot: 'Falla del bot: el cliente no recibió respuesta real',
  audio_ilegible: 'Mandó un audio que no se pudo escuchar (ya se le había pedido que escriba)',
};

const AUTHOR = { customer: 'cliente', bot: 'olimpo', team: 'equipo', system: 'sistema' } as const;
const RECENT = 6; // últimos mensajes que se muestran
const MAX_LINE = 200;
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
const show = (s: string) => flat(s).replaceAll('_', ' '); // full_panoramica se lee mejor sin guion bajo

export function buildFicha(card: LeadCard, history: ChatMessage[], handoff: HandoffDecision): string {
  // Un dato deducido (la provincia a partir de la localidad) lleva de dónde salió: el equipo tiene que ver que el cliente no lo dijo.
  const rows = LEAD_FIELDS.filter((f) => card.fields[f]).map((f) => {
    const { value, evidenceMsgId } = card.fields[f]!;
    return `${LABELS[f]}  ${show(value)}${evidenceMsgId.startsWith(DEDUCED) ? ` (${flat(evidenceMsgId)})` : ''}`;
  });
  const missing = missingRequired(card).map((f) => LABELS[f].toLowerCase());
  const recent = history.slice(-RECENT).map((m) => {
    const text = flat(m.text);
    return `${AUTHOR[m.author]}  ${argentinaClock(m.tsUtcMs)}  ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}...` : text}`;
  });
  return [
    `${handoff.priority.toUpperCase()} · ${REASONS[handoff.reason]}${handoff.mode === 'stop' ? ' (el bot dejó de responder)' : ''}`,
    `Cliente ${card.temperature} · ${card.state.replaceAll('_', ' ')}`,
    '',
    ...(rows.length ? rows : ['Sin datos cargados']),
    `Falta  ${missing.length ? missing.join(', ') : 'nada'}`,
    ...(card.objections.length ? [`Objeciones  ${card.objections.join(', ').replaceAll('_', ' ')}`] : []),
    ...(card.teamNote ? [`Nota  ${show(card.teamNote)}`] : []),
    '',
    'Últimos mensajes',
    ...recent,
  ].join('\n');
}
