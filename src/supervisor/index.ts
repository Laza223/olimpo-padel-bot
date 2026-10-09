// Controlador determinista: corre sobre cada respuesta del modelo, en vivo y en el banco de pruebas.
// Si devuelve violaciones, el turno se reintenta una vez con la lista; si vuelve a fallar, va un mensaje seguro.
import { extractNumbers } from './numbers.ts';
import type { FoundNumber } from './numbers.ts';
import { fold, mentionsElite } from './normalize.ts';

export interface SupervisorPolicy {
  approvedPricesUsd: number[]; // montos con USD/$ que se pueden escribir (estado "aprobado")
  allowedNumbers: number[]; // números sueltos (sin unidad) permitidos aunque el cliente no los haya dicho
  allowedPhrases: string[]; // frases aprobadas con números ("20x10", "4 luces"): pasan tal cual, aunque el número lleve unidad
}

export interface TurnDraft {
  bubbles: string[];
  askedIfAi: boolean; // señal del modelo: el cliente preguntó si es un bot
  newCustomerTexts?: string[]; // lo que escribió el cliente en este turno (ráfaga); sin esto vale el último mensaje
  renderShown?: boolean; // este turno manda un render (imagen del modelo, no una obra)
  heightOk?: boolean; // la ficha dice techada y la altura libre mínima de la política (7 m): recién ahí el bot puede decir que entra
  heightContext?: boolean; // la ficha dice techada o ya tiene altura/nota de altura: sin heightOk, se bloquean las afirmaciones explícitas de que entra
}

export interface Violation {
  rule: string;
  detail: string;
}

// Cada precio aprobado va con su producto (policy/olimpo.yaml → precios; una prueba en policy.test.ts los cruza con el YAML).
export const PRICE_BY_PRODUCT = { full: [19900, 21900], panoramica: [20900], platea: [8500] };
export const LIST_PRICE_USD = 21900; // lo que va después de "antes": el precio de lista de la Full Panorámica
type Product = keyof typeof PRICE_BY_PRODUCT;
// Cómo se nombra cada producto (texto normalizado): "Panorámica" sola es la Panorámica; "Full Panorámica" es la Full.
const PRODUCT_MENTION: Record<Product, RegExp> = { full: /\bfull\b/g, panoramica: /(?<!full )panoramic/g, platea: /\bplatea/g };

const MAX_BUBBLES = 2;
const MAX_CHARS = 280;
const HUGE_CHARS = 1000; // más que esto: solo se informa el largo

// Identificadores de la empresa anterior: nunca, ni aunque el cliente los diga (misma lista que landing/scripts/check.mjs).
// Se busca sobre el texto normalizado (sin tildes ni caracteres invisibles); "Elite" va con mentionsElite.
const IDENTIFIERS = /axxen|346737|209035/;
// Nombres que también pueden ser del cliente o de un lugar: solo si el cliente los escribió.
const IF_CUSTOMER_SAID = ['mariano', 'lujan', 'las acacias'];

// Afirmaciones prohibidas siempre (landing/scripts/check.mjs).
const CLAIMS: RegExp[] = [
  /certific/i, /homolog/i, /\bnormas?\b/i, /\bFIP\b/, /ensayad/i, /años de experiencia/i, /testimonio/i,
  /30\s*[–-]\s*45/, /d[ií]as h[aá]biles/i, /\b[23] años/i, /15 canchas/i, /resisten/i, /más de 15/i,
];

// El negocio no confirmó que el precio incluya la instalación ni el flete, y el IVA ya tiene su frase aprobada ("Es precio final, factura C"). Texto normalizado.
// "La instalación y el flete se cotizan aparte" y "no están incluidos / no incluye" son lo aprobado: el "no" y el "aparte" cortan la coincidencia.
// Las listas aprobadas de "qué incluye" (estructura, vidrios, césped, red, luces) no nombran instalación, flete ni IVA, así que pasan.
const NOT_NEGATED = String.raw`(?:(?!\bno\b|\baparte\b)[^.?!]){0,30}?`;
const INCLUIDO = new RegExp([
  String.raw`\btodo incluido\b`,
  String.raw`\b(?:instalacion|flete)\b${NOT_NEGATED}\bincluid[oa]s?\b`, // "instalación y flete incluidos"
  String.raw`(?<!\bno )(?<!\btampoco )\bincluy(?:e|en)\b${NOT_NEGATED}\b(?:instalacion|flete)\b`, // "incluye la instalación"
  String.raw`\biva incluido\b|\bincluy(?:e|en) (?:el )?iva\b|\bmas iva\b|\+ ?iva\b`,
].join('|'));

// Lo interno dicho al cliente: la ficha, lo "aprobado", la política, las instrucciones. Texto normalizado (sin tildes).
// "para completar" a secas no entra: "Para completar los datos, cómo te llamás?" es charla normal; "completar la ficha" ya lo frena "ficha".
const JERGA = /\bficha\b|\baprobad[oa]s?\b|\bpolitica\b|\bmis (?:instrucciones|reglas)\b|\bnecesito que (?:elijas|me digas|me pases)\b|\bsin eso no\b/;

// Temas que el bot solo puede nombrar si el cliente los mencionó antes (ej.: "¿hay financiación?").
const ECHO_ONLY: RegExp[] = [/garant/i, /financ/i, /rentab/i, /provincias/i];

const TUTEO = /(?<![\p{L}])(tienes|quieres|puedes|eres|cuéntame|dime|tú|tu proyecto es)(?![\p{L}])/iu; // \b no entiende las tildes
// Texto ya normalizado (sin tildes, en minúsculas). El cliente pregunta si es un bot, y el bot lo niega o lo confirma.
// "Mi socio es una persona muy prudente" no es una pregunta: "es" y "son" (3.ª persona) solo cuentan al empezar la frase o cerrando la pregunta;
// con "sos/eres/hablo con/me atiende/me responde/esto es" (2.ª persona o referencia al chat) alcanza el verbo.
const AI_KIND = String.raw`(?:un |una |algun |alguna )?(?:bots?|chatbots?|robots?|ia|inteligencia artificial|maquinas?|personas?|humanos?)`;
const AI_END = String.raw`(?= *(?:\?|$|,|real\b|de verdad\b|o ))`;
const AI_QUESTION = new RegExp(
  [
    String.raw`\b(?:sos|eres|hablo con|estoy hablando con|hablando con|me atiende|atiende|me responde|esto es) (?:${AI_KIND}|un asistente|una asistente)\b`,
    String.raw`\b(?:sos|eres) (?:de verdad |realmente )?real\b`,
    String.raw`\bson ${AI_KIND}${AI_END}`,
    String.raw`(?:^|[?!.,;\n] *)(?:che |hola )?es ${AI_KIND}${AI_END}`,
    String.raw`\bbot\?`,
  ].join('|'),
  'm',
);
const AI_DENIAL = /no (soy|es|somos) (un |una )?(bot|chatbot|robot|ia|inteligencia artificial|maquina|asistente virtual)|(?<!no )(soy|somos) (una |un )?(personas?|humanos?)|te atiende (una|un) (persona|humano)|(?<!\bno (?:soy|somos|es) de )carne y hueso|(?<!no )(?:estas hablando|hablas) con (?:una|un) (?:persona|humano)/;
const AI_WORD = /\b(bot|chatbot|robot|ia|inteligencia artificial|maquina)\b/;
const AI_DISCLOSURE = /asistente virtual/;
const FAKE_URGENCY = /[uú]ltim[oa]s? (unidades|cupos|lugares)|solo por hoy|se termina (hoy|ma[ñn]ana)|quedan pocos/i;
// "Quedamos en que te mandamos el presupuesto" o "te la hago a medida" son charla normal: "quedamos en / te la dejo en / te la hago a / cerramos en" solo cuentan con un monto detrás.
const AMOUNT = String.raw`(?:\$|usd|u\$s|u\$d|us\$|\d|(?:[a-z]+ )?mil\b)`;
const DISCOUNT = new RegExp(
  String.raw`descuento|rebaj|bonific|mejor precio|precio especial|(?:te (?:lo|la) dejo en|te (?:lo|la) hago a|quedamos en|cerramos en) ${AMOUNT}|regal|gratis|sin cargo|sin costo|por nuestra cuenta|mejorar el (?:precio|valor)|descuentito|de cortesia|no te cobramos|precio de amigo`,
);
// Plazos y garantías sin dígitos (texto normalizado, sin tildes): "mañana", "un par de días", "de por vida". Solo pasan dentro de una frase aprobada.
const TIME_PROMISE = /\b(?:manana|pasado manana|la semana que viene|la proxima semana|el mes que viene|par de (?:dias|semanas|meses)|medio ano|de por vida|vitalici\w*|garantia total|hoy mismo|esta semana|(?:en )?las proximas horas|en unos dias|en unas semanas|el (?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b/g;
const DISGUISE =/[​-‍⁠﻿]/;
// Estilo de Lazar (7-oct): solo signos de cierre, nada de dos puntos ni negritas de markdown.
const OPENING_MARKS = /[¿¡]/;
const COLON = /:(?!\/\/)/; // "https://..." no es un dos puntos de lista
const MARKDOWN = /\*\*|__|^#+\s|^\s*[-*]\s|•|```|~[^~\s][^~]*~|\*[^*\s][^*]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_])/mu; // incluye *negrita*, _cursiva_ y ~tachado~ de WhatsApp, bloques ``` y viñetas •
// Sin persona humana: el bot habla como "Olimpo Padel".
const HUMAN_PERSONA = /\bsoy l[aá]zaro\b|\bme llamo\b|\bsoy tom[aá]s\b/i;
// Un render es una imagen del modelo, nunca una obra hecha.
const FAKE_WORK = /(esta|esa|la de la foto)( cancha)? la (hicimos|instalamos)|obras? nuestras?|nuestras obras|canchas? que (hicimos|instalamos)|nuestro trabajo terminado|un cliente nuestro/i;
// Un cliente inventado en un lugar ("un cliente de Rosario"); el lugar va con mayúscula.
const FAKE_CLIENT = /\bclientes? (de|en) (?!Olimpo)[A-ZÁÉÍÓÚÑ]\p{L}+/u;
// Con un render en el turno, o si el cliente pregunta por la obra, el bot no habla de lo que "hicimos" (texto normalizado).
const WORK_VERBS = /\b(hicimos|instalamos|construimos|entregamos|armamos|terminamos|montamos)\b/;
const WORK_QUESTION = /\b(hicieron|instalaron|construyeron|donde esta|(es|son|fue) de ustedes|obras?)\b/;
const WORK_OK = /techados? que hicimos|instalamos (canchas )?en todo el pais|(armamos|entregamos) (el|tu|su|un|una) (presupuesto|cotizacion)/g; // textos aprobados y usos normales
// Obra hecha, siempre (con o sin render): "hicimos varias", "hay una igual", "nuestros clientes", "es nuestra", "trayectoria", "experiencia".
// En castellano solo "hicimos" es pasado sin ambigüedad: instalamos, armamos, montamos, construimos, terminamos y entregamos también son presente
// ("instalamos canchas en todo el país"), así que solo cuentan con una señal de pasado: "ya/recién", una cantidad de canchas o "el mes pasado / hace poco".
const AMBIGUOUS = 'instalamos|armamos|montamos|construimos|terminamos|entregamos';
const QUANTITY = String.raw`(?:un|una|unos|unas|varios|varias|muchos|muchas|algunos|algunas|\d+|dos|tres|cuatro|cinco)`;
const WORK_DONE = new RegExp(
  [
    String.raw`\bhicimos\b[^.?!\n]{0,40}?\b(?:canchas?|obras?|clubs?|clubes)\b`,
    String.raw`\bya hicimos\b|\bhicimos (?:varios|varias|muchos|muchas|algunos|algunas|unos|unas|\d+)\b`,
    String.raw`\b(?:ya|recien)\s+(?:${AMBIGUOUS})\b`,
    String.raw`\b(?:${AMBIGUOUS})\s+${QUANTITY}\s+(?:canchas?|obras?|clubs?|clubes)\b`,
    String.raw`\b(?:${AMBIGUOUS})\b[^.?!\n]{0,40}?\b(?:el (?:mes|ano) pasado|hace (?:poco|un|una|unos|unas))\b`,
    String.raw`\bcanchas? (?:funcionando|instaladas|hechas|terminadas) en\b`,
    String.raw`\bnuestros clientes\b|\b(?:un|una|otro|otra) cliente (?:de|en)\b`,
    String.raw`\b(?:hay|tenemos) una (?:igual|parecida|como esta)\b`,
    String.raw`\b(?:es|son) nuestr[ao]s?\b(?! (?:propia|fabricacion))|trayectoria|experiencia`,
  ].join('|'),
);

// "Sí, entra", "claro, alcanza", "entra perfecto": afirmar que la cancha entra, siempre. Solo la tilde ("sí") o la coma ("si,") hacen de afirmación:
// "para confirmarte si entra", "si entra o no" y "alcanza para el presupuesto" son condicionales o charla normal y pasan (texto sin normalizar).
const FITS = /(?<![\p{L}])(?:sí|claro|seguro|perfecto|si(?=,))(?![\p{L}])[,.!]?\s+(?:que\s+)?(?:con (?:esa altura|eso) )?(?:entra|entran|alcanza|alcanzan|cabe|caben|entraría|alcanzaría|cabría)(?![\p{L}])(?! (?:o no|para)\b)|(?<!no )(?<![\p{L}])(?:entra|entran|alcanza|alcanzan|cabe|caben)\s+(?:perfecto|bien|justo|sin problemas?|tranquil\w*|de sobra)(?![\p{L}])/iu;

// Con techada o hablando de la altura (texto normalizado): solo afirmaciones explícitas, nunca cualquier "entra/alcanza/cabe"
// ("con eso alcanza para el presupuesto", "cabe aclarar", "el techado entra en el presupuesto" son charla normal).
export const HEIGHT_TOPIC = /\b(altura|alto|galpon|techo|metros)\b/;
const FITS_HEIGHT = new RegExp(
  [
    String.raw`(?<!\bsi )\b(?:la cancha|te|les) (?:entra|entran|cabe|caben|entraria|cabria)\b(?! o no)`, // "la cancha entra" (pero no "para saber si la cancha entra")
    String.raw`\b(?:con|esa|esos?) (?:\d+(?:[.,]\d+)? ?m(?:etros?)?|altura|metros)\b(?:(?!\b(?:si|no|equipo|revis\w*|confirm\w*|evalu\w*)\b)[^.?!]){0,25}?\b(?:entra|entran|alcanza|alcanzaria|cabe|cabria|entraria|entrarian|sobra)\b`, // "con 6 m entra", "con esa altura alcanzaría"
    String.raw`\bva a entrar\b`,
  ].join('|'),
);

// "Tenemos dos modelos", "te paso 3 fotos": del 1 al 4, un número suelto (sin unidad ni moneda) es charla normal, no un dato.
const isSmallCount = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4;

// Tramos del texto (ya normalizado) cubiertos por una frase aprobada. La frase no puede ser parte de otra palabra.
function phraseSpans(f: string, phrases: string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const p of phrases.map(fold)) {
    for (let i = f.indexOf(p); i >= 0; i = f.indexOf(p, i + 1)) {
      const end = i + p.length;
      if (!/[a-z0-9]/.test(f[i - 1] ?? ' ') && !/[a-z0-9]/.test(f[end] ?? ' ')) spans.push([i, end]);
    }
  }
  return spans;
}

export function supervise(draft: TurnDraft, customerTexts: string[], policy: SupervisorPolicy): Violation[] {
  // Un globo gigante ya se rechaza por largo: no se le pasan las demás reglas (algunas releen el resto del texto en cada coincidencia: 65.000 caracteres tardaban 25 s).
  const huge = draft.bubbles.find((b) => b.length > HUGE_CHARS);
  if (huge) return [{ rule: 'length', detail: `globo de ${huge.length} caracteres (máx. ${MAX_CHARS})` }];
  const v: Violation[] = [];
  const text = draft.bubbles.join('\n');
  const customer = customerTexts.join('\n');

  if (draft.bubbles.length < 1 || draft.bubbles.length > MAX_BUBBLES) {
    v.push({ rule: 'bubbles', detail: `${draft.bubbles.length} globos (máx. ${MAX_BUBBLES})` });
  }
  for (const b of draft.bubbles) {
    if (b.length > MAX_CHARS) v.push({ rule: 'length', detail: `globo de ${b.length} caracteres (máx. ${MAX_CHARS})` });
    if (!b.trim()) v.push({ rule: 'empty', detail: 'globo vacío' });
  }
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions > 1) v.push({ rule: 'questions', detail: `${questions} preguntas (máx. 1)` });

  // Lo que el cliente dijo se puede repetir solo si es chico y no es un plazo ni un monto: los importes (contraofertas, precios de otros) nunca.
  const customerValues = new Set(extractNumbers(customer).filter((n) => n.value < 1000 && !n.unit && !n.currency && !n.pesos).map((n) => n.value));
  for (const b of draft.bubbles) {
    const spans = phraseSpans(fold(b), policy.allowedPhrases);
    const inPhrase = (n: FoundNumber) => spans.some(([a, z]) => n.start >= a && n.end <= z);
    for (const n of extractNumbers(b)) {
      if (n.pesos) {
        v.push({ rule: 'price', detail: `monto en pesos: "${n.raw}" (los precios aprobados son en dólares)` }); // ningún monto en pesos está aprobado
      } else if (n.currency) {
        if (!policy.approvedPricesUsd.includes(n.value)) v.push({ rule: 'price', detail: `monto no aprobado: "${n.raw}"` });
      } else if (n.unit) {
        // plazo, garantía, cuotas, porcentaje o fecha: solo si es una frase aprobada (aunque el cliente haya dicho el número)
        if (!inPhrase(n)) v.push({ rule: 'number', detail: `número con unidad sin respaldo en la política: "${n.raw}"` });
      } else if (!inPhrase(n) && !policy.allowedNumbers.includes(n.value) && !policy.approvedPricesUsd.includes(n.value) && !customerValues.has(n.value) && !isSmallCount(n.value)) {
        v.push({ rule: 'number', detail: `número sin fuente: "${n.raw}"` });
      }
    }
  }

  const f = fold(text);
  const fc = fold(customer);
  // El monto aprobado tiene que ir con su producto: por frase (el punto de los miles no la corta), cada monto con el producto que lo precede más cerca
  // (si ninguno lo precede, con el primero de la frase). Cuenta también el precio aprobado sin moneda ("La Panorámica sale 19.900").
  for (const sentence of f.split(/\.(?!\d)|[?!\n]+/)) {
    const mentions = (Object.keys(PRODUCT_MENTION) as Product[])
      .flatMap((p) => [...sentence.matchAll(PRODUCT_MENTION[p])].map((m) => ({ product: p, at: m.index })))
      .sort((a, b) => a.at - b.at);
    if (!mentions.length) continue;
    for (const n of extractNumbers(sentence)) {
      if (n.pesos || n.unit || !policy.approvedPricesUsd.includes(n.value)) continue;
      const { product } = mentions.findLast((m) => m.at < n.start) ?? mentions[0];
      const allowed = PRICE_BY_PRODUCT[product];
      if (!allowed.includes(n.value)) v.push({ rule: 'price_product', detail: `"${n.raw}" no es el precio de ${product} (${allowed.join(' o ')})` });
    }
  }
  // "antes" es el precio de lista: cualquier monto que lo siga de cerca tiene que ser ese.
  for (const m of f.matchAll(/\bantes\b/g)) {
    for (const n of extractNumbers(f.slice(m.index + m[0].length))) {
      if (n.start <= 15 && (n.currency || n.value >= 1000) && n.value !== LIST_PRICE_USD) {
        v.push({ rule: 'price_product', detail: `lo que va después de "antes" tiene que ser el precio de lista (USD ${LIST_PRICE_USD}), no "${n.raw}"` });
      }
    }
  }
  const word = (w: string, t: string) => new RegExp(`\\b${w}\\b`).test(t);
  const id = f.match(IDENTIFIERS)?.[0] ?? (mentionsElite(text) ? 'elite' : IF_CUSTOMER_SAID.find((w) => word(w, f) && !word(w, fc)));
  if (id) v.push({ rule: 'identifier', detail: `nombra a la empresa anterior: "${id}"` });
  for (const re of CLAIMS) {
    const m = text.match(re);
    if (m) v.push({ rule: 'claim', detail: `afirmación prohibida: "${m[0]}"` });
  }
  for (const re of ECHO_ONLY) {
    const m = text.match(re);
    if (m && !re.test(customer)) v.push({ rule: 'claim', detail: `tema que el cliente no mencionó: "${m[0]}"` });
  }
  const included = f.match(INCLUIDO)?.[0];
  if (included) v.push({ rule: 'incluido', detail: `afirma qué incluye el precio fuera de lo aprobado ("${included}"): la instalación y el flete se cotizan aparte según la ubicación, y del IVA solo se dice que es precio final y sale factura C` });
  const jerga = f.match(JERGA)?.[0];
  if (jerga) v.push({ rule: 'jerga', detail: `habla de lo interno con el cliente ("${jerga}"): nada de ficha, datos aprobados, política ni reglas; pedí el dato que falta y listo` });
  const tu = text.match(TUTEO);
  if (tu) v.push({ rule: 'voseo', detail: `tuteo: "${tu[0]}"` });
  // Le preguntaron si es un bot: la señal del modelo o el texto del cliente en este turno. "Para nada" solo es negar si hablan del bot.
  const newText = fold((draft.newCustomerTexts ?? customerTexts.slice(-1)).join('\n'));
  const asked = draft.askedIfAi || AI_QUESTION.test(newText);
  if (AI_DENIAL.test(f) || (/\bpara nada\b/.test(f) && (asked || AI_WORD.test(f)))) v.push({ rule: 'ai_denial', detail: 'niega ser IA' });
  if (asked && !AI_DISCLOSURE.test(f)) v.push({ rule: 'ai_disclosure', detail: 'le preguntaron si es un bot: tiene que decir que es el "asistente virtual" de Olimpo Padel' });
  const urg = text.match(FAKE_URGENCY);
  if (urg) v.push({ rule: 'urgency', detail: `urgencia no aprobada: "${urg[0]}"` });
  const disc = fold(text).match(DISCOUNT);
  if (disc) v.push({ rule: 'discount', detail: `ofrece descuento: "${disc[0]}"` });
  const covered = phraseSpans(f, policy.allowedPhrases);
  const promise = [...f.matchAll(TIME_PROMISE)].find((m) => !covered.some(([a, z]) => m.index >= a && m.index + m[0].length <= z));
  if (promise) v.push({ rule: 'promise', detail: `promesa de plazo o garantía sin respaldo en la política: "${promise[0]}"` });
  if (DISGUISE.test(text)) v.push({ rule: 'disguise', detail: 'caracteres invisibles' });
  if (OPENING_MARKS.test(text)) v.push({ rule: 'style', detail: 'signos de apertura ¿ ¡ (solo se usan los de cierre)' });
  if (COLON.test(text)) v.push({ rule: 'style', detail: 'dos puntos' });
  if (MARKDOWN.test(text)) v.push({ rule: 'style', detail: 'formato markdown (negritas o listas)' });
  const persona = text.match(HUMAN_PERSONA);
  if (persona) v.push({ rule: 'persona', detail: `se presenta como persona: "${persona[0]}"` });
  const heightTopic = draft.heightContext || HEIGHT_TOPIC.test(newText);
  const fits = draft.heightOk ? undefined : text.match(FITS)?.[0] ?? (heightTopic ? f.match(FITS_HEIGHT)?.[0] : undefined);
  if (fits) v.push({ rule: 'height', detail: `dice que entra ("${fits}") sin saber que la altura libre bajo techo alcanza el mínimo de la política: lo revisa el equipo en el presupuesto` });
  const guarded = draft.renderShown || WORK_QUESTION.test(newText);
  const fw = f.replace(WORK_OK, ' ');
  const work = text.match(FAKE_WORK)?.[0] ?? text.match(FAKE_CLIENT)?.[0] ?? fw.match(WORK_DONE)?.[0] ?? (guarded ? fw.match(WORK_VERBS)?.[0] : undefined);
  if (work) v.push({ rule: 'fake_work', detail: `presenta algo como obra hecha: "${work}"` });

  return v;
}
