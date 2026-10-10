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
// Dicha para negarla no cuenta: "no necesito financiación", "sin cuotas", "ya tengo financiación propia", "pago al contado" (revisión del 9-oct).
const NO_FINANCING = /\b(?:no|sin|ni)\b(?: \w+){0,3} (?:financia\w*|cuotas?)\b|\bfinanciacion propia\b|\b(?:al|de) contado\b|\bpago contado\b/;

// La ficha sola no confía en que el modelo cargue pide_financiacion: si un mensaje NUEVO del cliente la nombra, el código la carga citando ese mensaje.
// Con el campo ya cargado (por el modelo o antes) no se toca. Devuelve el dato a agregar, o undefined.
export function financingFromCustomer(card: LeadCard, history: ChatMessage[], newMessageIds: string[]): LeadCard['fields']['pide_financiacion'] {
  if (card.fields.pide_financiacion) return undefined;
  const m = history.find((x) => x.author === 'customer' && newMessageIds.includes(x.id) && FINANCING.test(plain(x.text.slice(0, MAX_EVIDENCE_CHARS))) && !NO_FINANCING.test(plain(x.text.slice(0, MAX_EVIDENCE_CHARS))));
  return m && { value: 'si', evidenceMsgId: m.id };
}

// Provincia deducida de la localidad (Lazar, 9-oct): solo las localidades que no se repiten en otra provincia, y solo si la localidad coincide EXACTO.
// Quedan afuera a propósito San Martín, San Miguel, San Fernando, Merlo, Ituzaingó, Avellaneda, Pilar, Santa Rosa y Rawson: se siguen preguntando.
// También San Isidro, Malvinas Argentinas, Almirante Brown y Luján, que tienen homónimos en otras provincias (revisión del 9-oct; lo repetido se pregunta, regla de Lazar).
// Córdoba, Mendoza, Salta, Santa Fe, San Juan, San Luis, Formosa, Corrientes, La Rioja y Santiago del Estero no van: ahí la provincia aparece literal y ya la toma el mecanismo de siempre.
const PROVINCE_PLACES: Record<string, string> = {
  CABA: 'CABA, Capital Federal, Ciudad de Buenos Aires',
  'Buenos Aires': 'Berazategui, Esteban Echeverría, Ezeiza, Florencio Varela, Hurlingham, José C. Paz, La Matanza, Lanús, Lomas de Zamora, Moreno, Morón, Quilmes, Tigre, Tres de Febrero, Vicente López, Escobar, Berisso, Ensenada, Cañuelas, Marcos Paz, General Rodríguez, Campana, Zárate, Exaltación de la Cruz, Nordelta, La Plata',
  'Entre Ríos': 'Paraná', Neuquén: 'Neuquén', 'Río Negro': 'Viedma', 'Santa Cruz': 'Río Gallegos', 'Tierra del Fuego': 'Ushuaia', Jujuy: 'San Salvador de Jujuy',
  Tucumán: 'San Miguel de Tucumán', Catamarca: 'San Fernando del Valle de Catamarca', Chaco: 'Resistencia', Misiones: 'Posadas',
};
// Los lugares de la lista, como se escriben: el prompt de Claude los nombra para que el modelo no pregunte esa provincia.
export const DEDUCIBLE_PLACES = Object.values(PROVINCE_PLACES).flatMap((places) => places.split(', '));
const PROVINCE_OF = new Map(Object.entries(PROVINCE_PLACES).flatMap(([province, places]) => places.split(', ').map((p): [string, string] => [squash(p), province])));
function squash(s: string): string { return plain(s).replace(/\./g, '').replace(/\s+/g, ' ').trim(); } // minúsculas, sin tildes ni puntos ("José C. Paz"), sin espacios de más

export const DEDUCED = 'deducida de '; // en evidenceMsgId: no hay mensaje que citar, queda a la vista de dónde salió el dato
// Con localidad y sin provincia, la completa si la localidad está en la lista. Una deducción vieja se rehace (la localidad pudo cambiar); lo que dijo el cliente no se toca.
export function withDeducedProvince(card: LeadCard): void {
  if (card.fields.provincia && !card.fields.provincia.evidenceMsgId.startsWith(DEDUCED)) return;
  delete card.fields.provincia;
  const place = card.fields.localidad?.value;
  const province = place ? PROVINCE_OF.get(squash(place)) : undefined;
  if (province) card.fields.provincia = { value: province, evidenceMsgId: `${DEDUCED}${place}` };
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

// ---------- Qué datos ya se preguntaron (la entrada de Claude se lo muestra: no repreguntar) ----------
// Qué dato pide un globo del bot, por palabras clave sobre la última frase que termina en "?" (texto normalizado). Sin pistas claras no cuenta.
// Gana el primero de la lista: "Ya tenés la platea para las 2 canchas?" es de la platea, no de la cantidad.
const QUESTION_FIELDS: [LeadField, RegExp][] = [
  ['cantidad_canchas', /\bcuantas\b|\bcantidad de canchas\b/],
  ['nombre', /\bcomo te llam\w*|\btu nombre\b|\bcon que nombre\b|\bnombre y apellido\b|\bcon quien (?:tengo el gusto|hablo)\b/],
  ['platea', /\bplateas?\b|\bhormigon\b/],
  ['ubicacion', /\bbajo techo\b|\btechad[ao]s?\b|\baire libre\b|\bcielo abierto\b/],
  ['provincia', /\bprovincia\b/],
  ['localidad', /\bde donde\b|\b(?:que|tu) (?:zona|localidad|ciudad|barrio|country|partido)\b|\bdonde (?:seria|estaria|queres|iria|vivis|queda)\b/],
  ['modelo', /\bmodelos?\b|\bcual (?:te interesa|preferis|elegis|te gusta)\b|\b(?:full|panoramica)\b[^?]{0,30}\bo\b[^?]{0,20}\b(?:full|panoramica)\b|\b(?:te interesa|preferis|elegis|te inclinas|anote|anoto)\b[^?]{0,40}\b(?:full|panoramica)\b/],
];

export function questionFields(bubble: string): LeadField[] {
  const question = bubble.slice(0, MAX_EVIDENCE_CHARS).match(/[^.!?]*\?/g)?.at(-1);
  const hits = QUESTION_FIELDS.filter(([, re]) => question && re.test(plain(question))).map(([f]) => f);
  return hits.includes('provincia') && hits.includes('localidad') ? ['localidad', 'provincia'] : hits.slice(0, 1); // localidad y provincia se piden juntas
}

// El cliente deja un dato para después o dice que no lo sabe (texto normalizado). "no se" cuenta solo si cierra la frase o sigue "si, cual, cuanto…": "no se puede" no posterga nada.
const DEFER = /\bdespues te (?:lo )?paso\b|\b(?:te )?lo paso despues\b|\bmas adelante\b|\bno (?:lo )?se(?= *(?:$|[,.;!?]|todavia|aun|si\b|cual|cuant|cuando|como|donde|que\b|bien|muy))|\btodavia no (?:se|lo se|lo tengo|decidi)\b|\blo veo despues\b|\bya veremos\b|\bpor ahora no\b|\btendria que (?:ver|medir|averiguar)\b/;
// Dice que no lo quiere dar: no se le vuelve a pedir nunca ("si ya dijo que no, no insiste", tono #17 de Lazar).
const REFUSE = /\bprefiero no\b|\bno (?:te )?(?:lo )?quiero (?:dar|pasar|decir)\b|\bno (?:te )?lo voy a (?:dar|pasar|decir)\b/;

export interface AskedField {
  field: LeadField;
  times: number; // cuántas veces lo preguntó el bot
  deferred: boolean; // el cliente contestó una pregunta de este dato con una postergación ("no sé", "después te paso")
  refused: boolean; // el cliente dijo que no lo quiere dar
  since: number; // mensajes del cliente desde la última vez que el bot lo preguntó
}

// De los datos que faltan (en ese orden), los que el bot ya preguntó. Recorre todo el historial: los mensajes nuevos del cliente pueden ser la respuesta a la última pregunta.
export function askedFields(history: ChatMessage[], missing: LeadField[]): AskedField[] {
  const stats = new Map<LeadField, AskedField>();
  let current: LeadField[] = []; // lo que preguntó el último mensaje del bot: a eso responde lo que escriba el cliente
  for (const m of history) {
    if (m.author === 'bot') {
      current = questionFields(m.text);
      for (const field of current) {
        const prev = stats.get(field);
        stats.set(field, { field, times: (prev?.times ?? 0) + 1, deferred: prev?.deferred ?? false, refused: prev?.refused ?? false, since: 0 });
      }
    } else if (m.author === 'customer') {
      const text = plain(m.text.slice(0, MAX_EVIDENCE_CHARS));
      for (const a of stats.values()) a.since++;
      for (const field of current) {
        if (REFUSE.test(text)) stats.get(field)!.refused = true;
        else if (DEFER.test(text)) stats.get(field)!.deferred = true;
      }
    }
  }
  return missing.flatMap((f) => stats.get(f) ?? []);
}

// Cuándo se puede volver a pedir un dato que falta (Lazar, 9-oct): si el cliente lo postergó o no contestó 2 preguntas, queda en pausa; después de 2 mensajes
// más del cliente se puede pedir UNA vez más, con otras palabras; si tampoco, no se pide más. Si dijo que no lo quiere dar, nunca más.
export const RETRY_AFTER_CUSTOMER_MSGS = 3; // la respuesta a la pregunta + 2 mensajes más
export type AskStatus = 'ok' | 'paused' | 'retry_once' | 'never';
export function askStatus(a: AskedField): AskStatus {
  if (a.refused || (a.deferred && a.times >= 2) || a.times >= 3) return 'never';
  if (!a.deferred && a.times < 2) return 'ok';
  return a.since >= RETRY_AFTER_CUSTOMER_MSGS ? 'retry_once' : 'paused';
}
