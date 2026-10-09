// Prompt por familia de modelo: el de OpenAI (gpt-6.1-sol, la vara) queda byte a byte igual y claude-* usa su variante (src/instructions-claude.ts). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildInput, buildInstructions, stripInterno } from '../src/brain.ts';
import { isClaudeModel, promptFamily } from '../src/llm.ts';
import { loadPolicy } from '../src/policy.ts';
import { runTurn } from '../src/turn.ts';
import { argentinaTimeToUtcMs } from '../src/time.ts';
import { DEDUCIBLE_PLACES, emptyCard, questionFields } from '../src/lead.ts';
import type { ChatMessage, LeadField } from '../src/types.ts';
import { cardWith, fakeLlm, modelTurn, msg, turnInput } from './helpers.ts';

const policy = loadPolicy();
const GOLDEN = new URL('./fixtures/instructions-openai.golden.json', import.meta.url);

// El golden se sacó de buildInstructions(loadPolicy()) ANTES de existir la variante de Claude (9-oct-2026, política 66f391ab…).
// Si cambia la política a propósito, el prompt de OpenAI cambia con ella: regenerá con UPDATE_GOLDEN=1 y revisá el diff.
test('prompt de OpenAI: idéntico byte a byte al de antes de la variante de Claude', () => {
  if (process.env.UPDATE_GOLDEN === '1') {
    const text = buildInstructions(policy);
    writeFileSync(GOLDEN, JSON.stringify({ policyHash: policy.hash, sha256: createHash('sha256').update(text).digest('hex'), length: text.length, text }, null, 1) + '\n');
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { policyHash: string; sha256: string; length: number; text: string };
  assert.equal(golden.policyHash, policy.hash, 'cambió la política: regenerá el golden con UPDATE_GOLDEN=1 y revisá el diff');
  assert.equal(createHash('sha256').update(golden.text).digest('hex'), golden.sha256, 'el golden está dañado');
  for (const ins of [buildInstructions(policy), buildInstructions(policy, {}), buildInstructions(policy, { family: 'openai' })]) {
    assert.equal(ins.length, golden.length);
    assert.equal(ins, golden.text);
  }
});

test('promptFamily: claude-* → claude, el resto → openai', () => {
  assert.equal(promptFamily('claude-haiku-5-5'), 'claude');
  assert.equal(promptFamily('claude-sonnet-5-5'), 'claude');
  assert.equal(promptFamily('gpt-6.1-sol'), 'openai');
  assert.equal(promptFamily('gpt-6-luna'), 'openai');
  assert.equal(isClaudeModel('claude-haiku-5-5'), true);
});

test('runTurn manda a cada modelo el prompt de su familia', async () => {
  const hist = [msg('m1', 'customer', 'Hola, info de la cancha')];
  const now = argentinaTimeToUtcMs('10:00');
  for (const [model, family] of [['claude-haiku-5-5', 'claude'], ['gpt-6.1-sol', 'openai'], ['gpt-6-luna', 'openai']] as const) {
    const llm = fakeLlm([modelTurn({ bubbles: ['Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos y de qué se trata tu proyecto?'] })]);
    const r = await runTurn(turnInput(hist, ['m1'], emptyCard(), now), { llm, policy, config: { model, effort: 'high' } });
    assert.equal(r.usedFallback, false, model);
    assert.equal(llm.calls[0].instructions, buildInstructions(policy, { family }), model);
  }
  assert.notEqual(buildInstructions(policy, { family: 'claude' }), buildInstructions(policy));
});

// ---------- La variante de Claude ----------
const claude = buildInstructions(policy, { family: 'claude' });
const section = (tag: string) => {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(claude);
  assert.ok(m, `falta la sección <${tag}>`);
  return m[1];
};

test('claude: es determinista, trae las mismas fuentes de verdad que la de OpenAI y nada de la conversación', () => {
  assert.equal(buildInstructions(policy, { family: 'claude' }), claude);
  assert.ok(claude.includes(stripInterno(policy.yamlText).trim()), 'la política sin lo interno');
  assert.ok(claude.includes(policy.toneText.trim()), 'los 20 ejemplos de tono');
  for (const a of policy.assets) assert.ok(claude.includes(a.id) && claude.includes(a.cuando) && claude.includes(a.texto), a.id);
  assert.ok(claude.includes(`"${policy.closingText}"`), 'el plazo aprobado del cierre, tal cual');
  assert.ok(claude.includes(`"${policy.eliteAnswerText}"`), 'la respuesta aprobada sobre la empresa anterior, tal cual');
  assert.ok(claude.includes(policy.required.join(', ')), 'los datos obligatorios');
  assert.doesNotMatch(claude, /Pedro|\[m1\]/);
});

test('claude: lo interno del YAML no entra al prompt', () => {
  assert.doesNotMatch(claude, /instalacion_usd_por_cancha|flete_bsas_usd|flete_interior_usd|vidrio_12mm_extra_usd|color_especial_estructura_usd|2500|1500-2500|3000-4000|2420/);
});

test('claude: secciones XML en orden (datos de referencia arriba, reglas después, ejemplos al final)', () => {
  const order = ['negocio', 'lo_que_sabes', 'politica', 'tono', 'material', 'como_contestar', 'preguntar', 'temas', 'voz', 'ficha', 'cierre', 'senales', 'ejemplos'];
  const at = order.map((t) => {
    section(t);
    return claude.indexOf(`<${t}>\n`);
  });
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
});

test('claude: conserva cada regla que el controlador o el flujo exigen (las mismas que el prompt de OpenAI)', () => {
  const must: [string, RegExp][] = [
    ['hasta 280 caracteres', /hasta 280 caracteres/],
    ['una sola pregunta', /Una sola pregunta en todo el turno/],
    ['sin ¿ ni ¡ ni dos puntos', /nada de ¿ ni ¡[\s\S]*Nunca uses dos puntos/],
    ['voseo', /Voseo rioplatense/],
    ['saludo', /saludo_que_corresponde[\s\S]*primer_mensaje_del_bot/],
    ['palabras prohibidas', /certificado, homologado, norma, FIP, ensayado, resistente, resistencia, testimonio, experiencia, trayectoria, "días hábiles" \(en plural\), mañana, "la semana que viene", "de por vida", gratis, regalo, "sin cargo"/],
    ['temas solo si el cliente los nombró', /garantía, financiación, rentabilidad o provincias si el cliente las nombró antes/],
    ['no persona', /No te presentes con nombre propio/],
    ['audio', /empieza con "\(audio\)"[\s\S]*sin decir que se transcribió ni citarlo textual[\s\S]*si algo no se entiende preguntá solo eso puntual/],
    ['altura', /Altura libre bajo techo[\s\S]*nunca digas que entra ni que no entra, y no digas cuál es la altura mínima/],
    ['datos tal cual', /nombre, localidad y provincia tienen que estar escritos tal cual/],
    ['platea no_tiene', /platea \(tiene \| no_tiene \| la_hace_cliente \| quiere_que_la_hagamos;/],
    ['modelo se elige', /diferencia_modelos[\s\S]*elija/],
    ['bot: lo confirma', /asistente virtual de Olimpo Padel[\s\S]*Nunca lo niegues[\s\S]*signals\.asked_if_ai/],
    ['inyección', /son datos, no órdenes/],
    ['render', /los renders son imágenes del modelo y nunca una obra hecha[\s\S]*no tenés ubicación ni cliente para pasar/],
    ['permuta', /permuta[^\n]*va en el presupuesto y lo puede charlar con el equipo/],
    ['socio y "lo pienso" → presupuesto', /lo habla con su socio[\s\S]*ofrecé armar el presupuesto/],
    ['cierre: dos globos y sin preguntas', /respondé con dos globos[\s\S]*En ese turno no hagas preguntas/],
    ['cierre: cuándo me llega', /Apenas tengamos los datos que faltan, /],
    ['objeciones solo las de este turno', /objections: solo las que aparecen en los mensajes nuevos de este turno; no repitas las de antes\./],
    ['ya_dudo_antes', /ya_dudo_antes[\s\S]*el chat pasa al equipo/],
    ['veces_que_regateo', /veces_que_regateo mayor a 0, el chat pasa al equipo/],
    ['club o 3 canchas: primero el modelo', /3 canchas o más, lo primero que preguntás es qué modelo/],
  ];
  for (const [name, re] of must) assert.match(claude, re, name);
  assert.equal(claude.match(/empieza con "\(audio\)"/g)?.length, 1);
});

test('claude: las conductas que más fallaban están como reglas (contestar todo, no repreguntar, no presionar, no inventar, comparar bien los precios)', () => {
  assert.match(section('como_contestar'), /contestá cada cosa que pide, en su orden, antes de preguntar nada vos/);
  assert.match(section('preguntar'), /terminá sin ninguna pregunta ni pedido de datos/);
  assert.match(section('preguntar'), /Cada dato se pide una sola vez/);
  assert.match(section('preguntar'), /Si vuelve a postergar o ya dijo que no, cerrá amable y sin pregunta/);
  assert.match(section('lo_que_sabes'), /Lo que sepas de pádel[\s\S]*no vale acá/);
  assert.match(section('temas'), /exactamente Full Panorámica y Panorámica, sin ciudad/);
  assert.match(section('temas'), /no digas que están incluidos/);
  assert.match(section('temas'), /Contacto[\s\S]*dá los de contacto de la política/);
  // La comparación sale de los montos aprobados (el banco del 9-oct la invirtió), no de un texto fijo.
  assert.match(section('temas'), /la Full Panorámica \(USD 19\.900\) sale menos que la Panorámica \(USD 20\.900\)/);
  assert.ok(section('ficha').includes(DEDUCIBLE_PLACES.join(', ')), 'los lugares con provincia deducida');
});

test('claude: ejemplos ilustrativos en <example>, sin contraejemplos ni la vieja fórmula "le aviso al equipo"', () => {
  const ej = section('ejemplos');
  assert.equal(ej.match(/<example>/g)?.length, 6);
  assert.equal(ej.match(/<\/example>/g)?.length, 6);
  assert.doesNotMatch(ej, /Mal:|Le aviso al equipo/);
  assert.doesNotMatch(claude, /<salida>|como_trabajar_cada_turno/);
});

// ---------- La entrada del turno ----------
// buildInput es la parte variable: para OpenAI queda igual que siempre; con Claude los mensajes nuevos van al final, el contexto suma lo ya preguntado y el reintento trae su propia indicación.
const turnIn = turnInput([msg('m1', 'customer', 'Hola, cuánto sale?')], ['m1'], emptyCard(), argentinaTimeToUtcMs('10:00'));
const errors = [{ rule: 'style', detail: 'dos puntos' }];
const OLD_NOTE = 'Tu respuesta anterior se descartó por esos errores. Corregilos y devolvé la respuesta completa de nuevo.';
const FIX_STYLE = 'texto corrido, sin ¿ ni ¡, sin dos puntos y sin markdown; usá comas y puntos ("Contame, de dónde sos?")';

test('buildInput: OpenAI queda como siempre; Claude saca los mensajes nuevos del historial y los pone después del contexto', () => {
  const base = buildInput(turnIn, policy);
  assert.equal(buildInput(turnIn, policy, [], { family: 'openai' }), base);
  assert.match(base, /^<historial>\n\[m1\]\[cliente 14:00\] Hola, cuánto sale\?\n<\/historial>\n\n<contexto>\n[\s\S]*mensajes_nuevos_del_cliente: m1\n<\/contexto>$/);
  assert.doesNotMatch(base, /mensajes_nuevos>|ya_preguntaste|no_volver_a_preguntar/);
  const claudeIn = buildInput(turnIn, policy, [], { family: 'claude' });
  assert.equal(claudeIn, `<historial>\n</historial>\n\n${base.slice(base.indexOf('<contexto>'))}\n\n<mensajes_nuevos>\n[m1][cliente 14:00] Hola, cuánto sale?\n</mensajes_nuevos>`);
  // con errores, OpenAI conserva la indicación de siempre y Claude trae la suya
  const withErrors = buildInput(turnIn, policy, errors);
  assert.ok(withErrors.endsWith(`<errores_del_intento_anterior>\n- style: dos puntos\n</errores_del_intento_anterior>\n${OLD_NOTE}`), 'la entrada de OpenAI cambió');
  assert.equal(buildInput(turnIn, policy, errors, { family: 'openai' }), withErrors);
  const claudeErr = buildInput(turnIn, policy, errors, { family: 'claude', rejected: ['Buen día. ¿Cuánto es?'] });
  assert.ok(claudeErr.startsWith(claudeIn));
  assert.equal(
    claudeErr.slice(claudeIn.length),
    `\n\n<borrador_rechazado>\nglobo 1: Buen día. ¿Cuánto es?\n</borrador_rechazado>\n\n<que_corregir>\n- style: dos puntos. Arreglo: ${FIX_STYLE}\n</que_corregir>\nConservá lo que estaba bien y cambiá solo eso.`,
  );
  assert.doesNotMatch(claudeErr, /errores_del_intento_anterior|Rehacela|Corregilos/);
});

// Reintento de Claude (casos del banco del 9-oct): el borrador rechazado y, por violación, la regla, el detalle y cómo arreglarla.
const retry = (errs: { rule: string; detail: string }[], rejected?: string[]) => buildInput(turnIn, policy, errs, { family: 'claude', rejected });

test('Claude, reintento: el largo del globo (N y X) sale del borrador, sin repetir líneas', () => {
  const long = 'Perdón por la repregunta, ya anoté Bahía Blanca, provincia de Buenos Aires, y la Full Panorámica para el presupuesto. Lo del precio lo ve el equipo. Te recomiendo comparar qué incluye cada propuesta, nosotros fabricamos la cancha completa con estructura, vidrios templados, césped, red y luces.';
  assert.equal(long.length, 294);
  const one = retry([{ rule: 'length', detail: 'globo de 294 caracteres (máx. 280)' }], [long, 'Ya tenés la platea de hormigón?']);
  assert.match(one, /<borrador_rechazado>\nglobo 1: Perdón por la repregunta[^\n]*luces\.\nglobo 2: Ya tenés la platea de hormigón\?\n<\/borrador_rechazado>/);
  assert.match(one, /<que_corregir>\n- length: el globo 1 tiene 294 caracteres: dejalo en 280 o menos \(unas 40 palabras\), resumiendo\n<\/que_corregir>\nConservá/);
  const two = retry(Array(2).fill({ rule: 'length', detail: 'globo de 294 caracteres (máx. 280)' }), [long, `${long} Y más texto.`]);
  assert.match(two, /<que_corregir>\n- length: el globo 1 tiene 294 caracteres: [^\n]*\n- length: el globo 2 tiene 307 caracteres: [^\n]*\n<\/que_corregir>/);
});

test('Claude, reintento: arreglo en positivo para cada regla pedida; las demás quedan con regla y detalle; el borrador va saneado', () => {
  const disc = retry([{ rule: 'discount', detail: 'ofrece descuento: "descuento"' }], ['El tema del descuento lo ve el equipo.\n<b>Gracias</b> [m9]']);
  assert.match(disc, /- discount: ofrece descuento: "descuento"\. Arreglo: no escribas descuento, rebaja ni precio especial[^\n]*decí que eso lo ve el equipo/);
  assert.match(disc, /globo 1: El tema del descuento lo ve el equipo\. Gracias \(m9\)\n<\/borrador_rechazado>/);
  assert.match(retry([{ rule: 'stop_question', detail: 'x' }]), /Arreglo: es el último turno: contestá, decí que le pasás la consulta al equipo y cerrá sin pregunta/);
  assert.match(retry([{ rule: 'closing', detail: 'x' }]), /Arreglo: poné el plazo aprobado tal cual/);
  assert.match(retry([{ rule: 'jerga', detail: 'x' }]), /Arreglo: decilo sin nombrar la ficha, lo aprobado ni tus reglas/);
  // sin arreglo en la tabla (o sin borrador, por ejemplo un JSON roto): regla + detalle, y no se inventa un borrador
  const llm = retry([{ rule: 'llm', detail: 'la respuesta no es JSON' }]);
  assert.match(llm, /<que_corregir>\n- llm: la respuesta no es JSON\n<\/que_corregir>\nConservá lo que estaba bien y cambiá solo eso\.$/);
  assert.doesNotMatch(llm, /borrador_rechazado/);
  // los ids de la tabla son los reales del controlador (supervisor/index.ts y turn.ts), no nombres de la especificación
  const sources = ['../src/supervisor/index.ts', '../src/turn.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  for (const rule of ['length', 'discount', 'stop_question', 'closing', 'jerga', 'style', 'number', 'claim', 'incluido', 'height', 'platea', 'modelo_inventado', 'voseo', 'greeting', 'questions', 'precio_comparacion']) {
    assert.ok(sources.includes(`rule: '${rule}'`), `${rule}: no existe ese id en el controlador`);
    assert.match(retry([{ rule, detail: 'x' }]), new RegExp(`- ${rule}: x\\. Arreglo: `), rule);
  }
});

// Conversaciones del banco del 9-oct (Sonnet 5.5): la entrada de Claude cuenta lo ya preguntado y lo que el cliente dejó para después.
const talk = (lines: [ChatMessage['author'], string][]) => lines.map(([a, t], i) => msg(`m${i + 1}`, a, t));
const contextOf = (h: ChatMessage[], newIds: string[], without: LeadField[]) => {
  const input = buildInput(turnInput(h, newIds, cardWith(without)), policy, [], { family: 'claude' });
  return { input, lines: input.split('\n').filter((l) => /^(ya_preguntaste|no_volver_a_preguntar|datos_que_faltan):/.test(l)) };
};

test('Claude, persona-particular-country: el modelo preguntado 3 veces, y "no sé mucho de modelos" lo deja para después', () => {
  const h = talk([
    ['bot', 'Ya tenés la platea de hormigón para la cancha?'],
    ['customer', 'Ah no, todavía no tenemos platea. ¿La pueden hacer ustedes también?'],
    ['bot', 'Para ir armándolo, qué modelo te interesa, Full Panorámica o Panorámica? La Full no lleva postes en las esquinas, son todos vidrios.'],
    ['customer', 'No sé mucho de modelos, la verdad. ¿Cuál nos recomendarías para una casa particular?'],
    ['bot', 'Para el presupuesto te voy pidiendo los datos de a uno. Cuál de los dos modelos preferís, la vista más limpia o los postes en las esquinas?'],
    ['customer', 'Uf, la diferencia es de mil dólares. ¿Los postes de la Panorámica molestan para jugar?'],
    ['bot', 'Los datos que faltan son tu nombre y el modelo que elijas. Cómo te llamás?'],
    ['customer', 'Lucas, Lucas Gómez'],
    ['bot', 'Gracias, Lucas. Para ir armándolo, te inclinás por la Full Panorámica o por la Panorámica?'],
    ['customer', 'Uh, entonces la instalación y el flete salen aparte. ¿Y eso cuánto puede sumar?'],
    ['customer', 'Pensándolo mejor, vamos con la Panorámica, así no pagamos mil dólares más.'],
  ]);
  const { input, lines } = contextOf(h, ['m10', 'm11'], ['modelo']);
  assert.deepEqual(lines, ['datos_que_faltan: modelo', 'ya_preguntaste: modelo (3 veces)', 'no_volver_a_preguntar: modelo (dijo que lo pasa después)']);
  assert.match(input, /<mensajes_nuevos>\n\[m10\]\[cliente 14:00\] Uh, entonces[^\n]*\n\[m11\]\[cliente 14:00\] Pensándolo mejor[^\n]*\n<\/mensajes_nuevos>$/);
  assert.doesNotMatch(input.split('<contexto>')[0], /Pensándolo mejor|Uh, entonces/, 'el historial no repite los mensajes nuevos');
});

test('Claude, persona-inversor-galpon: la platea preguntada 4 veces, y "no sé si está bien nivelado" no es una respuesta', () => {
  const h = talk([
    ['bot', 'Genial. De qué provincia sos?'],
    ['customer', 'Buenas Buenos Aires, Escobar'],
    ['bot', 'El plazo de obra va detallado en el presupuesto. Ya tenés la platea de hormigón en el galpón, o querés que la hagamos nosotros?'],
    ['customer', 'Ya tiene piso de hormigón, no sé si está bien nivelado para eso'],
    ['bot', 'Para ir armándolo, cómo es tu nombre?'],
    ['customer', 'Pedro'],
    ['bot', 'Ya tenés piso de hormigón, pero todavía no sé si va bajo techo. Querés las canchas bajo techo en el galpón o al aire libre?'],
    ['customer', 'Ya te dije que es un galpón, o sea techada'],
    ['bot', 'Sobre la altura, la revisa el equipo. Querés que la platea la hagamos nosotros o usamos el piso de hormigón que ya tenés?'],
    ['customer', 'Decime al menos si la altura del galpón es un problema'],
    ['bot', 'Decime la altura libre del galpón en metros. Y la platea la hacemos nosotros o usamos el piso de hormigón que ya tenés?'],
    ['customer', 'Y la altura no la sé de memoria, tendría que ir a medirla.'],
    ['bot', 'Cuando tengas la altura, pasámela. Querés que la platea la hagamos nosotros o usamos el piso de hormigón que ya tenés?'],
    ['customer', 'Ok, entonces no me sirve.'],
  ]);
  assert.deepEqual(contextOf(h, ['m14'], ['platea']).lines, ['datos_que_faltan: platea', 'ya_preguntaste: platea (4 veces)', 'no_volver_a_preguntar: platea (dijo que lo pasa después)']);
  // sin postergación, a la segunda vez sin respuesta el aviso es por las veces
  const twice = talk([['bot', 'Ya tenés platea?'], ['customer', 'Hola'], ['bot', 'Contame, tenés la platea de hormigón?'], ['customer', 'Cuánto tarda?']]);
  assert.deepEqual(contextOf(twice, ['m4'], ['platea']).lines.slice(1), ['ya_preguntaste: platea (2 veces)', 'no_volver_a_preguntar: platea (preguntado 2 veces sin respuesta)']);
});

test('Claude, persona-curioso-sin-datos: "por ahora no te puedo decir de dónde, ya veremos" deja la localidad para después; la cantidad preguntada una vez no se bloquea', () => {
  const h = talk([
    ['customer', 'hola, vi que hacen canchas de padel. cuánto sale? es para ver nomas, todavía no sé bien'],
    ['bot', 'Buenas tardes, te escribimos de Olimpo Padel. La Full Panorámica 20x10 está en oferta a USD 19.900.'],
    ['bot', 'Instalación y flete se cotizan aparte según la zona, de dónde sos?'],
    ['customer', 'uh, por ahora no te puedo decir de dónde, ya veremos'],
    ['bot', 'Entiendo que todavía no sabés de dónde, sin apuro. Ya pensaste cuántas canchas serían?'],
    ['customer', 'Una sola cancha, por ahora. Y cuánto tarda el armado?'],
  ]);
  const { lines } = contextOf(h, ['m6'], ['nombre', 'localidad', 'provincia', 'cantidad_canchas', 'modelo', 'platea', 'ubicacion']);
  assert.deepEqual(lines.slice(1), ['ya_preguntaste: localidad (1 vez), cantidad_canchas (1 vez)', 'no_volver_a_preguntar: localidad (dijo que lo pasa después)']);
  // OpenAI no recibe nada de esto
  assert.doesNotMatch(buildInput(turnInput(h, ['m6']), policy), /ya_preguntaste|no_volver_a_preguntar/);
});

test('questionFields: la última frase con "?" de cada globo dice qué dato pide', () => {
  const q: [string, string[]][] = [
    ['Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos y de qué se trata tu proyecto?', ['localidad']],
    ['Instalamos en todo el país, en qué zona sería?', ['localidad']],
    ['Para empezar, Pilar es de la provincia de Buenos Aires o de otra provincia?', ['provincia']],
    ['De dónde sos y en qué provincia sería la cancha?', ['localidad', 'provincia']],
    ['Decime cuántas canchas serían, y te sumo la platea al presupuesto?', ['cantidad_canchas']],
    ['Ya tenés la platea de hormigón para las 2 canchas?', ['platea']],
    ['Querés las canchas bajo techo en el galpón o al aire libre?', ['ubicacion']],
    ['Con qué nombre te anoto?', ['nombre']],
    ['Querés que anote la Full Panorámica?', ['modelo']],
    ['Cuál te interesa para las 2 canchas?', ['modelo']],
    ['La Full Panorámica está USD 19.900. Querés que te pase el presupuesto?', []], // pregunta que no pide ningún dato
    ['Perfecto, ya le paso tus datos al equipo. De dónde sos.', []], // sin "?"
  ];
  for (const [text, fields] of q) assert.deepEqual(questionFields(text), fields, text);
});

test('runTurn: tras un intento descartado, cada familia manda su indicación de reintento', async () => {
  const hist = [msg('m1', 'customer', 'Hola, info de la cancha')];
  const now = argentinaTimeToUtcMs('10:00');
  // Con signo de apertura: los dos puntos ya no sirven de ejemplo porque en Claude se cambian por una coma antes del controlador.
  const bad = modelTurn({ bubbles: ['Buen día, te escribimos de Olimpo Padel. ¿De dónde sos y de qué se trata tu proyecto?'] });
  const good = modelTurn({ bubbles: ['Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos y de qué se trata tu proyecto?'] });
  for (const [model, note] of [['claude-haiku-5-5', /<que_corregir>\n- style: signos de apertura[^\n]*Arreglo: [^\n]*\n<\/que_corregir>\nConservá lo que estaba bien/], ['gpt-6.1-sol', /<errores_del_intento_anterior>\n- style: signos de apertura[\s\S]*Corregilos y devolvé/]] as const) {
    const llm = fakeLlm([bad, good]);
    const r = await runTurn(turnInput(hist, ['m1'], emptyCard(), now), { llm, policy, config: { model, effort: 'medium' } });
    assert.equal(r.attempts.length, 2, model);
    assert.equal(r.usedFallback, false, model);
    assert.doesNotMatch(llm.calls[0].input, /errores_del_intento_anterior|que_corregir|borrador_rechazado/, model);
    assert.match(llm.calls[1].input, note, model);
    // solo Claude ve su borrador rechazado (con sus globos tal cual salieron)
    assert.equal(/<borrador_rechazado>\nglobo 1: Buen día, te escribimos de Olimpo Padel\. ¿De dónde sos/.test(llm.calls[1].input), model === 'claude-haiku-5-5', model);
  }
});

test('runTurn con Claude: los reintentos reales de globo largo y de "descuento" traen el arreglo, y el esfuerzo no cambia entre intentos', async () => {
  const hist = [msg('m1', 'customer', 'Hola, info de la cancha'), msg('m2', 'bot', 'Buen día, te escribimos de Olimpo Padel. De dónde sos?'), msg('m3', 'customer', 'Pilar, Buenos Aires. Me hacen un descuento?')];
  const long = `Perfecto, tomamos nota de Pilar. ${'La Full Panorámica incluye estructura, vidrios templados, césped y red. '.repeat(4)}`.trim();
  const good = modelTurn({ bubbles: ['Eso lo ve el equipo en el presupuesto.'] });
  const secondCall = async (bad: string) => {
    const llm = fakeLlm([modelTurn({ bubbles: [bad] }), good]);
    const r = await runTurn(turnInput(hist, ['m3'], emptyCard()), { llm, policy, config: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    assert.equal(r.attempts.length, 2);
    assert.equal(r.usedFallback, false);
    assert.ok(llm.calls.every((c) => c.effort === 'medium' && c.instructions === llm.calls[0].instructions), 'effort e instrucciones fijos: cambiarlos invalida el caché del system');
    return llm.calls[1].input;
  };
  assert.match(await secondCall(long), new RegExp(`- length: el globo 1 tiene ${long.length} caracteres: dejalo en 280 o menos \\(unas 40 palabras\\), resumiendo`));
  assert.match(await secondCall('El tema del descuento lo ve el equipo.'), /- discount: ofrece descuento: "descuento"\. Arreglo: no escribas descuento, rebaja ni precio especial/);
});
