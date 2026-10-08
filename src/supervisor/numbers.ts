// Extrae números de un texto en español rioplatense: "19.900", "4,000", "USD 19.900", "u$s 2.500", "19,9 mil", "2k",
// "18 lucas", "dos", "veinticinco mil", "mil quinientos". Devuelve valores normalizados, con la moneda y la unidad
// (días, cuotas, %, fecha) a la que el número va pegado. Las posiciones son sobre el texto normalizado con `fold`.
import { fold } from './normalize.ts';

const UNITS: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const WORDS: Record<string, number> = {
  ...UNITS, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600,
  setecientos: 700, ochocientos: 800, novecientos: 900,
};
for (const w of ['doscientas', 'trescientas', 'cuatrocientas', 'quinientas', 'seiscientas', 'setecientas', 'ochocientas', 'novecientas']) {
  WORDS[w] = WORDS[w.replace(/as$/, 'os')];
}
for (const [w, n] of Object.entries(UNITS)) {
  WORDS[`veinti${w}`] = 20 + n;
  if (n >= 6) WORDS[`dieci${w}`] = 10 + n;
}

// Categoría de cada palabra y qué categoría puede seguirle dentro del mismo número ("dos mil quinientos", "treinta y cinco").
type Cat = 'h' | 't' | 'e' | 'u' | 'mil' | 'mill';
const cat = (w: string): Cat | undefined => {
  if (w === 'mil') return 'mil';
  if (w === 'millon' || w === 'millones') return 'mill';
  if (!Object.hasOwn(WORDS, w)) return undefined; // "constructor", "toString"… no son números
  const n = WORDS[w];
  return n >= 100 ? 'h' : n >= 30 ? 't' : n >= 10 ? 'e' : 'u';
};
const NEXT: Record<Cat, Cat[]> = { h: ['t', 'e', 'u', 'mil', 'mill'], t: ['mil', 'mill'], e: ['mil', 'mill'], u: ['mil', 'mill'], mil: ['h', 't', 'e', 'u'], mill: ['h', 't', 'e', 'u', 'mil'] };

// Lo que sigue al número: multiplicador (mil, k, lucas, palos), moneda y unidad (texto normalizado: sin tildes).
const MULT: Record<string, number> = { mil: 1e3, millon: 1e6, millones: 1e6, k: 1e3, luca: 1e3, lucas: 1e3, palo: 1e6, palos: 1e6 };
export const UNIT = /^ ?(dias?|semanas?|meses|mes|anos?|horas?|hs|hrs|minutos?|cuotas?|pagos?|quincenas?|%|por ?ciento)(?![a-z])/;

export interface FoundNumber {
  value: number;
  raw: string;
  currency: boolean; // dólares (USD, u$s, dólares) o un monto sin moneda (k, palos): tiene que ser un precio aprobado
  pesos: boolean; // pesos ($, pesos, lucas): nunca es un monto aprobado
  unit?: string; // "dias", "cuotas", "%", "fecha": el número va pegado a una unidad
  start: number;
  end: number; // incluye el sufijo y la unidad, si los tiene
}

function parseNumeral(raw: string): number {
  // "19.900" o "19.900,50" → miles con punto; "4,000" → miles con coma (inglés); "19,9" → decimal con coma; "19900" → entero.
  const s = raw.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  return Number(s.replace(',', '.'));
}

// Moneda del número que va de `start` a `end`: marcada antes ("USD 5", "$ 5") o después ("5 dólares", "5 pesos").
function currencyOf(t: string, start: number, end: number): 'usd' | 'ars' | undefined {
  const before = t.slice(Math.max(0, start - 8), start);
  const after = t.slice(end, end + 10);
  if (/(?:usd|u\$s|u\$d|us\$|u\$)[ :]*$/.test(before) || /^ ?(?:usd|u\$s|u\$d|dolares?)(?![a-z])/.test(after)) return 'usd';
  if (/\$ ?$/.test(before) || /^ ?(?:pesos?|ars|\$)(?![a-z])/.test(after)) return 'ars';
  return undefined;
}

// Arma el resultado de un número que va de `start` a `end` (sufijo incluido), con su moneda y su unidad.
function build(t: string, value: number, start: number, end: number, suffix?: string): FoundNumber {
  const cur = currencyOf(t, start, end);
  const unit = UNIT.exec(t.slice(end));
  const pesos = cur === 'ars' || suffix === 'luca' || suffix === 'lucas';
  const currency = cur === 'usd' || suffix === 'k' || suffix === 'palo' || suffix === 'palos';
  return { value, raw: t.slice(start, end + (unit?.[0].length ?? 0)), currency, pesos, unit: unit?.[1], start, end: end + (unit?.[0].length ?? 0) };
}

export function extractNumbers(text: string): FoundNumber[] {
  const t = fold(text);
  const out: FoundNumber[] = [];
  // Primero las fechas ("20/10") y los dígitos (con su sufijo); después las palabras.
  const re = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|(\d[\d.,]*\d|\d)(?: ?(mil|millon|millones|k|lucas?|palos?)(?![a-z]))?/g;
  for (const m of t.matchAll(re)) {
    if (m[1]) {
      out.push({ value: Number(m[1].split('/')[0]), raw: m[0], currency: false, pesos: false, unit: 'fecha', start: m.index, end: m.index + m[0].length });
      continue;
    }
    const value = Number((parseNumeral(m[2]) * (m[3] ? MULT[m[3]] : 1)).toFixed(4));
    out.push(build(t, value, m.index, m.index + m[0].length, m[3]));
  }
  const taken = out.map((n) => [n.start, n.end]);

  const tokens = [...t.matchAll(/[a-z]+/g)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < tokens.length; i++) {
    if (!cat(tokens[i].w)) continue;
    // Armar la corrida de palabras numéricas pegadas ("treinta y cinco", "dos mil quinientos").
    const run = [tokens[i]];
    let last = tokens[i];
    for (let j = i + 1; j < tokens.length && t.slice(last.end, tokens[j].start) === ' '; j++) {
      const prev = cat(last.w)!;
      const next = tokens[j];
      const after = tokens[j + 1];
      if (next.w === 'y' && prev === 't' && after && t.slice(next.end, after.start) === ' ' && cat(after.w) === 'u') {
        run.push(next, after);
        last = after;
        j++;
      } else if (cat(next.w) && NEXT[prev].includes(cat(next.w)!)) {
        run.push(next);
        last = next;
      } else break;
    }
    i += run.length - 1;
    const start = run[0].start;
    const numEnd = last.end;
    if (taken.some(([a, z]) => start < z && numEnd > a)) continue; // ya lo leyó la pasada de dígitos ("20 mil")
    let total = 0;
    let cur = 0;
    for (const tok of run) {
      const c = cat(tok.w);
      if (c === 'mil' || c === 'mill') {
        total += (cur || 1) * MULT[tok.w];
        cur = 0;
      } else if (c) cur += WORDS[tok.w];
    }
    const suffix = /^ ?(lucas?|palos?)(?![a-z])/.exec(t.slice(numEnd));
    const found = build(t, total + cur, start, numEnd + (suffix?.[0].length ?? 0), suffix?.[1]);
    // "un/una/uno" suelto es artículo ("una cancha") y "mil" suelto es muletilla ("mil gracias"): solo cuentan con unidad, moneda o sufijo.
    const lone = run.length === 1 && (cat(run[0].w) === 'mil' || WORDS[run[0].w] === 1);
    if (lone && !found.unit && !found.currency && !found.pesos) continue;
    out.push(found);
  }
  return out.sort((a, b) => a.start - b.start);
}
