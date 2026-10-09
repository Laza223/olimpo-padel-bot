// Ficha del cliente: qué se acepta del modelo, qué falta, en qué estado está y qué tan caliente es.
import { LEAD_FIELDS, REQUIRED_FIELDS } from './types.ts';
import type { ChatMessage, LeadCard, LeadField, LeadState, ModelTurn, Temperature } from './types.ts';
import { extractNumbers, UNIT } from './supervisor/numbers.ts';

export interface RejectedPatch {
  field: string;
  value: string;
  evidenceMsgId: string;
  reason: string;
}

const ENUMS: Partial<Record<LeadField, readonly string[]>> = {
  modelo: ['full_panoramica', 'panoramica'], // sin "indefinido": si no sabe cuál quiere, el bot explica la diferencia y lo hace elegir
  platea: ['tiene', 'no_tiene', 'la_hace_cliente', 'quiere_que_la_hagamos'], // no_tiene: dijo que no tiene y todavía no confirmó que se la hagamos
  ubicacion: ['techada', 'aire_libre'],
  uso: ['club', 'inversion', 'particular', 'otro'],
  pide_financiacion: ['si'],
  vidrio_12mm: ['si'],
};
const MAX_VALUE_CHARS = 120;
const MAX_EVIDENCE_CHARS = 2000; // el texto citado se corta antes de cualquier regex (65.000 dígitos tardaban 10 s en DIMENSION)

export function emptyCard(): LeadCard {
  return { fields: {}, objections: [], state: 'nuevo', temperature: 'frio', teamNote: '', flags: { negotiatingCount: 0, offKnowledgeCount: 0 } };
}

// minúsculas y sin tildes, para comparar texto (valores de enumeración, saludos)
export const plain = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// Medidas ("20x10", "22 x 11") y el 1 de "una cancha": ni la medida ni "un galpón" son una cantidad de canchas.
const DIMENSION = /\d+(?:[.,]\d+)?\s*(?:x|×|por)\s*\d+(?:[.,]\d+)?/gi;
const ONE_COURT = /\b(?:1|un|una|uno)\b(?:\W+\w+){0,2}\W+cancha|cancha\w*(?:\W+\w+){0,2}\W+(?:1|un|una|uno)\b/;

// "una", "uno" o "1" sueltos (sin unidad de tiempo pegada): la respuesta corta a "cuántas canchas serían?".
function shortOne(t: string): boolean {
  if (extractNumbers(t).some((x) => x.value === 1 && !x.unit && !x.currency && !x.pesos)) return true;
  const p = plain(t);
  return [...p.matchAll(/\b(?:una|uno)\b/g)].some((m) => !UNIT.test(p.slice(m.index + m[0].length)));
}

// "dos" o "2": el número tiene que estar en el mensaje, fuera de una medida y sin unidad pegada ("en 2 meses" no es 2 canchas).
// El 1 ("un/una/uno") es artículo salvo pegado a "cancha", o suelto si el bot acababa de preguntar por las canchas.
function mentionsNumber(text: string, n: number, botAskedCourts = false): boolean {
  const t = text.replace(DIMENSION, ' ');
  if (n === 1) return ONE_COURT.test(plain(t)) || (botAskedCourts && shortOne(t));
  return extractNumbers(t).some((x) => x.value === n && !x.unit && !x.currency && !x.pesos);
}

// El dato (nombre, localidad, provincia) tiene que estar escrito en el mensaje citado, como palabra entera.
function appearsIn(text: string, value: string): boolean {
  const v = plain(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${v}(?![\\p{L}\\p{N}])`, 'u').test(plain(text));
}
const MUST_APPEAR: LeadField[] = ['nombre', 'localidad', 'provincia'];

// Devuelve la ficha nueva (no muta la recibida) y la lista de lo rechazado, para el log.
export function applyPatch(card: LeadCard, patch: ModelTurn['lead_patch'], history: ChatMessage[]): { card: LeadCard; rejected: RejectedPatch[] } {
  const next = structuredClone(card);
  const rejected: RejectedPatch[] = [];
  for (const p of patch) {
    const no = (reason: string) => rejected.push({ field: p.field, value: p.value, evidenceMsgId: p.evidence_msg_id, reason });
    const source = history.find((m) => m.id === p.evidence_msg_id);
    if (!(LEAD_FIELDS as readonly string[]).includes(p.field)) { no('campo desconocido'); continue; }
    if (!source) { no('el mensaje de evidencia no existe'); continue; }
    if (source.author !== 'customer') { no('el mensaje de evidencia no es del cliente'); continue; }
    const evidence = source.text.slice(0, MAX_EVIDENCE_CHARS);
    let value = p.value.trim();
    if (!value) { no('valor vacío'); continue; }
    if (value.length > MAX_VALUE_CHARS) { no(`valor de más de ${MAX_VALUE_CHARS} caracteres`); continue; }
    const options = ENUMS[p.field];
    if (options) {
      value = plain(value);
      if (!options.includes(value)) { no(`valor fuera de la lista (${options.join(' | ')})`); continue; }
    }
    if (p.field === 'cantidad_canchas') {
      if (!/^[1-9]\d{0,2}$/.test(value)) { no('la cantidad tiene que ser un entero en dígitos'); continue; }
      // el último mensaje del bot anterior al citado: si preguntó por canchas, "1" o "una" solos son la respuesta
      const botBefore = history.slice(0, history.indexOf(source)).findLast((m) => m.author === 'bot');
      const botAskedCourts = !!botBefore && plain(botBefore.text).includes('cancha');
      if (!mentionsNumber(evidence, Number(value), botAskedCourts)) { no(`el mensaje citado no dice ${value}`); continue; }
    }
    if (p.field === 'altura_libre_m') {
      value = value.replace(',', '.');
      const h = Number(value);
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(value) || !(h > 0 && h <= 30)) { no('la altura tiene que ser un número en metros (por ejemplo 6 o 7.5)'); continue; }
      if (!mentionsNumber(evidence, h)) { no(`el mensaje citado no dice ${value}`); continue; }
    }
    if (MUST_APPEAR.includes(p.field) && !appearsIn(evidence, value)) { no('el dato no aparece en el mensaje citado'); continue; }
    next.fields[p.field] = { value, evidenceMsgId: p.evidence_msg_id };
  }
  return { card: next, rejected };
}

// El cliente nombra la financiación ("financiación", "financiar", "cuotas", "en partes", "plan de pago", "pagar de a poco"), texto normalizado.
// "financiero/a" no cuenta ("respaldo financiero"): es otra cosa.
const FINANCING = /\bfinancia\w*|\bcuotas?\b|\ben partes\b|\bplan(?:es)? de pago\b|\bpagar(?:l[aeo]s?)? de a poco\b/;

// La ficha sola no confía en que el modelo cargue pide_financiacion: si un mensaje NUEVO del cliente la nombra, el código la carga citando ese mensaje.
// Con el campo ya cargado (por el modelo o antes) no se toca. Devuelve el dato a agregar, o undefined.
export function financingFromCustomer(card: LeadCard, history: ChatMessage[], newMessageIds: string[]): LeadCard['fields']['pide_financiacion'] {
  if (card.fields.pide_financiacion) return undefined;
  const m = history.find((x) => x.author === 'customer' && newMessageIds.includes(x.id) && FINANCING.test(plain(x.text.slice(0, MAX_EVIDENCE_CHARS))));
  return m && { value: 'si', evidenceMsgId: m.id };
}

// platea no_tiene no alcanza: se le ofrece y falta que diga si se la hacemos o la hace él (Lazar, F0).
export function missingRequired(card: LeadCard): LeadField[] {
  return REQUIRED_FIELDS.filter((f) => !card.fields[f] || (f === 'platea' && card.fields.platea?.value === 'no_tiene'));
}

// derivado, descartado, baja y no_es_cliente los pone runTurn.
export function computeState(card: LeadCard): LeadState {
  if (Object.keys(card.fields).length === 0) return 'nuevo';
  return missingRequired(card).length === 0 ? 'listo_para_presupuesto' : 'calificando';
}

export function computeTemperature(card: LeadCard): Temperature {
  const have = REQUIRED_FIELDS.length - missingRequired(card).length;
  if (have === REQUIRED_FIELDS.length && card.fields.plazo_deseado && card.fields.quien_decide) return 'caliente';
  return have >= 4 ? 'tibio' : 'frio';
}
