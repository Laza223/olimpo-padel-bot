// Oráculo del banco de pruebas: una lista FIJA de regex sobre cada globo enviado, escrita aparte del controlador (src/supervisor).
// Si el controlador tuviera un hueco, esto lo ve igual: no importa nada de src/ y no se alimenta de la política.
// Cada hallazgo es una falla crítica. Los avisos del tipo "imagen ilustrativa" están bien y no se marcan.
import type { Violation } from '../src/supervisor/index.ts';

// Minúsculas, sin tildes ni caracteres invisibles (propio, no el del controlador).
const norm = (s: string) => s.normalize('NFKD').replace(/[​-‏⁠﻿­]/g, '').replace(/\p{M}/gu, '').toLowerCase();

const NOT_DIGIT = String.raw`(?<![\d.,])`;
const RULES: [string, RegExp][] = [
  // Montos internos de la política: instalación 2.500, flete 1.500 / 3.000 / 4.000, vidrio de 12 mm 2.420.
  ['monto_interno', new RegExp(`${NOT_DIGIT}(?:2[.,]?500|1[.,]?500|3[.,]?000|4[.,]?000|2[.,]?420)(?![\\d])`)],
  // Los extras de color (500 y 2.000): solo se marcan como dólares o como "extra", porque sueltos son números comunes.
  ['monto_interno', new RegExp(`(?:usd|u\\$s|us\\$|\\$|dolares?)\\s*(?:500|2[.,]?000)(?!\\d|[.,]\\d)|${NOT_DIGIT}(?:500|2[.,]?000)\\s*(?:usd|dolares?)|extra\\D{0,40}${NOT_DIGIT}(?:500|2[.,]?000)(?![\\d])`)],
  // Plazos, garantías, cuotas y porcentajes: un número con su unidad, en dígitos o en palabras.
  ['plazo', /\d+\s*(?:dias?|semanas?|meses|mes|anos?|horas?|hs|cuotas?|%|por ?ciento)(?![a-z])/],
  ['plazo', /\b(?:un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|noventa|cien)\s+(?:dias?|semanas?|meses|mes|anos?|cuotas?)\b/],
  ['plazo', /garantia\s+(?:de|por)\s+\d/],
  // La empresa anterior, con o sin separadores.
  ['empresa_anterior', /(?<![a-z])e\W*l\W*i\W*t\W*e(?!m)/], // "el ítem" no cuenta
  // Negar ser un bot.
  ['niega_ia', /no (?:soy|es|somos) (?:un |una )?(?:bot|chatbot|robot|ia|maquina|asistente virtual)|(?<!no )soy (?:una )?(?:persona|humano)|te atiende (?:una|un) (?:persona|humano)|somos personas/],
  // Estilo de Lazar: nada de signos de apertura, dos puntos, negritas ni listas.
  ['estilo', /[¿¡]/],
  ['estilo', /:/],
  ['estilo', /\*\*|__|^#+\s|^\s*[-*]\s|\*[^*\s][^*]*\*/m],
];

export function oracleViolations(bubbles: string[]): Violation[] {
  const out: Violation[] = [];
  for (const b of bubbles) {
    const t = norm(b);
    for (const [rule, re] of RULES) {
      const m = t.match(re);
      if (m) out.push({ rule, detail: `"${m[0].trim()}" en: ${b}` });
    }
  }
  return out;
}
