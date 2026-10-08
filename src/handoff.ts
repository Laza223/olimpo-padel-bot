// Derivaciones: las decide el código a partir de la ficha y las señales; el modelo solo suma avisos.
import type { HandoffDecision, HandoffReason, LeadCard, ModelTurn, Priority } from './types.ts';
import { computeTemperature, missingRequired } from './lead.ts';
import { customerMentionsElite, fold } from './supervisor/normalize.ts';

export interface HandoffContext {
  before: LeadCard; // ficha al empezar el turno (con `notified`)
  after: LeadCard; // ficha ya actualizada: patch aplicado y contadores de regateo/fuera de política sumados
  turn: ModelTurn;
  customerText: string; // texto de los mensajes nuevos del cliente
}

// Lo único que el modelo puede pedir: avisos (flag). Todo lo demás lo decide el código por señal o ficha; un pedido
// del modelo de otro motivo se ignora, porque marcaría el motivo como ya avisado y taparía el stop real de un turno posterior.
const MODEL_CAN_FLAG: HandoffReason[] = ['cliente_grande', 'factura_a', 'fuera_de_politica'];
// Señales de desconfianza en el texto del cliente (normalizado, sin tildes): obras, taller, referencias, estafa, antigüedad, dirección.
// Con límite de palabra: "cobran" no es "obra", "confirmame" no es "confío", y "garantía" sola es una pregunta comercial, no desconfianza.
const TRUST_CUE = /\bobras?\b|\btaller\b|\breferencias?\b|\bestaf\w*|\bconfi(?:able|anza|ar|o)\b|\bcuanto hace que\b|\bhace cuanto\b|\bcuantos anos\b|\bantiguedad\b|\btrayectoria\b|\bexisten\b|\bson reales\b|\b(?:tienen|hay) local\b|\bconocerlos\b|\bvisitar\b|\bver (?:una|alguna|la) cancha\b|\bdireccion\b/;
// "factura A", "factura tipo A", "facturan en A". "factura a la empresa / un tercero / nuestro nombre" usa la "a" como preposición, no como letra.
const FACTURA_A = /\bfactura\s*(?:tipo\s*)?a\b(?!\s+(?:a\s+)?(?:la|el|los|las|un|una|nombre|mi|nuestr[ao]s?)\b)|\bfactur\w*\s+en\s+a\b(?!\s+(?:a\s+)?(?:la|el|los|las|un|una|nombre|mi|nuestr[ao]s?)\b)/i;
// Motivos que primero avisan y después frenan.
const ESCALATES: HandoffReason[] = ['regateo'];

export function decideHandoffs({ before, after, turn, customerText }: HandoffContext): HandoffDecision[] {
  const out: HandoffDecision[] = [];
  const done = new Set(before.notified ?? []);
  // Un motivo ya avisado no se repite, sea aviso o stop. Única excepción: el regateo, que sube de aviso (1.ª vez) a stop (2.ª).
  const add = (reason: HandoffReason, priority: Priority, mode: 'stop' | 'flag') => {
    if (done.has(reason) && !(mode === 'stop' && ESCALATES.includes(reason))) return;
    if (out.some((d) => d.reason === reason)) return;
    out.push({ reason, priority, mode });
  };
  const s = turn.signals;

  // Baja y no es cliente cierran la charla: ninguna otra derivación. No es cliente va con prioridad normal: el equipo lo revisa por si era real.
  if (s.opt_out) {
    add('baja', 'baja', 'stop');
    return out;
  }
  if (s.not_a_lead) {
    add('no_es_cliente', 'normal', 'stop');
    return out;
  }

  if (missingRequired(before).length > 0 && missingRequired(after).length === 0) {
    add('listo_para_presupuesto', computeTemperature(after) === 'caliente' ? 'alta' : 'normal', 'stop');
  }
  if (Number(after.fields.cantidad_canchas?.value) >= 3 || after.fields.uso?.value === 'club') add('cliente_grande', 'alta', 'flag');
  if (s.asks_human) add('pide_persona', 'normal', 'stop');
  if (s.angry) add('enojado', 'alta', 'stop');
  if (customerMentionsElite(customerText)) add('pregunta_por_empresa_anterior', 'normal', 'stop');
  // Duda de quiénes somos por 2.ª vez: la confianza la da mejor una persona (Lazar 7-oct). Además de la objeción (ya en la ficha y repetida en este
  // turno), el texto nuevo del cliente tiene que tener una señal de desconfianza: el modelo suele repetir "confianza" sin que el cliente la repita.
  if (before.objections.includes('confianza') && turn.objections.includes('confianza') && TRUST_CUE.test(fold(customerText))) add('pide_verificacion', 'alta', 'stop');
  if (FACTURA_A.test(customerText)) add('factura_a', 'normal', 'flag');
  if (s.negotiating) add('regateo', 'normal', after.flags.negotiatingCount >= 2 ? 'stop' : 'flag');
  if (s.off_knowledge) add('fuera_de_politica', 'normal', 'flag'); // solo aviso: frenar cortaba clientes buenos (financiación, otros países)

  const ask = turn.handoff_request;
  if (ask && MODEL_CAN_FLAG.includes(ask.reason)) add(ask.reason, ask.priority, 'flag');
  return out;
}
