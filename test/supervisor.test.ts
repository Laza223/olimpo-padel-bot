import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervise, type SupervisorPolicy } from '../src/supervisor/index.ts';
import { extractNumbers } from '../src/supervisor/numbers.ts';
import { loadPolicy } from '../src/policy.ts';

const policy: SupervisorPolicy = loadPolicy().supervisorPolicy; // la del YAML: así se prueban también las frases permitidas
const rules = (bubbles: string[], customer: string[] = [], askedIfAi = false) =>
  supervise({ bubbles, askedIfAi }, customer, policy).map((x) => x.rule);

test('lee números en formato argentino', () => {
  const v = (s: string) => extractNumbers(s).map((n) => n.value);
  assert.deepEqual(v('USD 19.900'), [19900]);
  assert.deepEqual(v('19900'), [19900]);
  assert.deepEqual(v('19,9 mil'), [19900]);
  assert.deepEqual(v('veinte mil'), [20000]);
  assert.deepEqual(v('una cancha'), []);
  assert.ok(extractNumbers('USD 19.900')[0].currency);
  assert.ok(extractNumbers('19.900 dólares')[0].currency);
});

test('respuesta correcta pasa', () => {
  assert.deepEqual(rules(['La Full Panorámica está en oferta a USD 19.900 (antes 21.900). Incluye estructura, vidrios templados, césped, red y 4 luces LED.', 'Instalación y flete se cotizan según la zona, de dónde sos?']), []);
  assert.deepEqual(rules(['Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos y de qué se trata tu proyecto?']), []);
  assert.deepEqual(rules(['La platea de hormigón está USD 8.500 por cancha, de 22 x 11 m con hormigón H-21 fibrilado.']), []);
});

test('estilo de Lazar: sin ¿ ¡, sin dos puntos, sin markdown', () => {
  assert.ok(rules(['¿De dónde sos?']).includes('style'));
  assert.ok(rules(['¡Hola!']).includes('style'));
  assert.ok(rules(['Incluye: estructura y vidrios.']).includes('style'));
  assert.ok(rules(['Está **USD 19.900**.']).includes('style'));
});

test('estilo (2.ª ronda): ~tachado~, bloques ``` y viñetas • también son markdown', () => {
  for (const t of ['Está ~barato~.', 'Mirá ```esto```.', '• Estructura y vidrios', 'Incluye • estructura • vidrios.']) {
    assert.ok(rules([t]).includes('style'), t);
  }
  assert.deepEqual(rules(['Te sirve la full_panoramica.']), []);
});

test('sin persona humana ni renders presentados como obra', () => {
  assert.ok(rules(['Buen día, soy Lázaro de Olimpo Padel.']).includes('persona'));
  assert.ok(rules(['Esta cancha la hicimos en Pilar.']).includes('fake_work'));
  assert.ok(rules(['Mirá nuestras obras.']).includes('fake_work'));
  assert.deepEqual(rules(['Así queda la Full Panorámica.']), []);
});

test('monto no aprobado se bloquea', () => {
  assert.ok(rules(['La instalación sale USD 2.500.']).includes('price'));
  assert.ok(rules(['Te queda en u$s 18.900.']).includes('price'));
});

test('número sin fuente se bloquea, salvo que lo haya dicho el cliente', () => {
  assert.ok(rules(['La tenés lista en 45 días.']).includes('number'));
  assert.deepEqual(rules(['Perfecto, 3 canchas entonces.'], ['quiero 3 canchas']), []);
  assert.deepEqual(rules(['Dale, tres canchas.'], ['serían 3']), []);
});

test('nunca nombra a la empresa anterior ni hace afirmaciones prohibidas', () => {
  assert.ok(rules(['Somos ex Elite.']).includes('identifier'));
  assert.ok(rules(['Está homologada.']).includes('claim'));
  assert.ok(rules(['Son 30-45 días hábiles.']).includes('claim'));
});

test('financiación y garantía solo si el cliente las nombró', () => {
  assert.ok(rules(['Tenemos financiación.']).includes('claim'));
  assert.ok(!rules(['La financiación va detallada en el presupuesto.'], ['¿tienen financiación?']).includes('claim'));
});

test('forma: globos, largo, una sola pregunta, voseo', () => {
  assert.ok(rules(['a', 'b', 'c']).includes('bubbles'));
  assert.ok(rules(['x'.repeat(281)]).includes('length'));
  assert.ok(rules(['¿Dónde es? ¿Cuántas canchas?']).includes('questions'));
  assert.ok(rules(['¿Qué tienes en mente?']).includes('voseo'));
});

test('IA: nunca niega, y confirma cuando le preguntan', () => {
  assert.ok(rules(['No soy un bot, soy del equipo.']).includes('ai_denial'));
  assert.ok(rules(['Somos Olimpo Padel, contame.'], ['sos un bot?'], true).includes('ai_disclosure'));
  assert.deepEqual(rules(['Sí, soy el asistente virtual de Olimpo. Si querés te paso con alguien del equipo.'], ['sos un bot?'], true), []);
});

test('sin descuentos, urgencia falsa ni caracteres invisibles', () => {
  assert.ok(rules(['Te hago un descuento.']).includes('discount'));
  assert.ok(rules(['Quedan pocos cupos.']).includes('urgency'));
  assert.ok(rules(['Hola​']).includes('disguise'));
});

// ---------- Ronda de fixes: número con unidad ----------
test('número con unidad de tiempo, cuotas, porcentaje o fecha se bloquea aunque el número sea "permitido"', () => {
  for (const t of [
    'La garantía es de 10 años.', 'Te la entregamos en 20 días.', '12 cuotas sin interés.', 'Se paga 20% de anticipo.',
    'Te bonifico un 10%.', '21% de IVA.', 'Te mandamos el presupuesto el 20/10.', 'Te mandamos el presupuesto en 2 semanas',
  ]) {
    assert.ok(rules([t], [t]).includes('number'), `no atrapó: ${t}`); // ni siquiera si el cliente dijo el número
  }
});

test('las frases con números de la política siguen pasando', () => {
  for (const t of [
    'Es una cancha de 20x10 con 4 luces LED.', 'Tiene 20 x 10 metros.', 'Tosca de 10 cm, encofrado de 22 x 11 m y hormigón H-21 fibrilado.',
    'Se puede hacer con vidrio de 12 mm.', 'La Panorámica lleva postes en las cuatro esquinas.',
  ]) {
    assert.deepEqual(rules([t]), [], t);
  }
  // pero el número de una frase aprobada no habilita el mismo número con otra unidad
  assert.ok(rules(['Es de 20x10 y tarda 10 días.']).includes('number'));
});

// ---------- Ronda de fixes: parser de números y monedas ----------
const vals = (s: string) => extractNumbers(s).map((n) => n.value);

test('parser: miles con coma (formato inglés), decimales y texto normalizado (NFKC)', () => {
  assert.deepEqual(vals('4,000'), [4000]);
  assert.deepEqual(vals('12,000'), [12000]);
  assert.deepEqual(vals('4,5'), [4.5]);
  assert.deepEqual(vals('19,9 mil'), [19900]);
  assert.deepEqual(vals('１９.９００'), [19900]); // dígitos de ancho completo
  assert.deepEqual(vals('２０％ de anticipo'), [20]);
  assert.equal(extractNumbers('２０％ de anticipo')[0].unit, '%');
});

test('parser: palabras (mil, cien, cientos, veinti, treinta y, mil quinientos, veinticinco mil)', () => {
  const cases: [string, number][] = [
    ['mil quinientos', 1500], ['veinticinco mil', 25000], ['dieciocho mil', 18000], ['dos mil quinientos', 2500], ['cien', 100],
    ['ciento veinte', 120], ['doscientos', 200], ['quinientos', 500], ['novecientos', 900], ['treinta y cinco', 35], ['veintiuno', 21],
    ['veintidós', 22], ['cuarenta', 40], ['sesenta y dos', 62], ['dieciséis', 16], ['mil dólares', 1000],
  ];
  for (const [text, value] of cases) assert.deepEqual(vals(text), [value], text);
  assert.deepEqual(vals('mil gracias'), []); // "mil" suelto sin moneda ni unidad no es un monto
});

test('parser: sufijos k, lucas y palos, y monedas ($ y pesos son pesos; USD, u$s, u$d y dólares son dólares)', () => {
  assert.deepEqual(vals('sale 2k'), [2000]);
  assert.deepEqual(vals('19,9k'), [19900]);
  assert.deepEqual(vals('18 lucas'), [18000]);
  assert.deepEqual(vals('2 palos'), [2000000]);
  const kind = (s: string) => { const n = extractNumbers(s)[0]; return n.pesos ? 'pesos' : n.currency ? 'usd' : 'sin moneda'; };
  assert.equal(kind('$19.900'), 'pesos');
  assert.equal(kind('$ 19.900'), 'pesos');
  assert.equal(kind('19.900 pesos'), 'pesos');
  assert.equal(kind('18 lucas'), 'pesos');
  assert.equal(kind('USD 19.900'), 'usd');
  assert.equal(kind('u$s 18.900'), 'usd');
  assert.equal(kind('u$d 5000'), 'usd');
  assert.equal(kind('19.900 dólares'), 'usd');
  assert.equal(kind('mil quinientos dólares'), 'usd');
  assert.equal(kind('sale 2k'), 'usd'); // k sin moneda se trata como dólares: tiene que ser un precio aprobado
  assert.equal(kind('19.900'), 'sin moneda');
});

test('montos: en pesos nunca; en dólares solo los aprobados; k, lucas y palos igual', () => {
  assert.ok(rules(['Son $19.900.']).includes('price')); // el valor es un precio aprobado, pero en pesos
  assert.ok(rules(['Son 19.900 pesos.']).includes('price'));
  assert.ok(rules(['Es mil quinientos dólares.']).includes('price'));
  assert.ok(rules(['sale 2k']).includes('price'));
  assert.ok(rules(['sale 18 lucas']).includes('price'));
  assert.deepEqual(rules(['La Full Panorámica está a USD 19.900, antes u$s 21.900.']), []);
});

test('el flete "4,000" no se confunde con un 4 que dijo el cliente', () => {
  assert.ok(rules(['El flete al interior sale 4,000 por cancha'], ['son 4 canchas']).includes('number'));
  assert.ok(rules(['El flete sale cuatro mil'], ['son 4 canchas']).includes('number'));
});

// ---------- Ronda de fixes: el bot no repite montos del cliente ----------
test('un número de 1000 o más nunca pasa solo porque lo escribió el cliente (contraoferta, precio de la competencia)', () => {
  const dale = rules(['Dale, quedamos en 18.000'], ['me hacés 18.000?']);
  assert.ok(dale.includes('number'));
  assert.ok(dale.includes('discount'));
  assert.ok(rules(['dieciocho mil y cerramos'], ['dieciocho mil o me voy']).includes('number'));
  assert.ok(rules(['Vi que el otro está a 17.500, nosotros no.'], ['el otro está 17.500']).includes('number'));
  // los chicos sí se pueden repetir si el cliente los dijo y no van con unidad
  assert.deepEqual(rules(['Perfecto, 3 canchas entonces.'], ['quiero 3 canchas']), []);
  assert.ok(rules(['Anotado, 5 canchas.'], ['la quiero en 5 meses']).includes('number')); // el 5 del cliente era de meses (del 1 al 4, un número suelto pasa solo)
});

test('descuentos: quedamos en, te la hago a, cerramos en, bonific, rebaj, descuento, mejor precio, precio especial', () => {
  for (const t of [
    'Quedamos en USD 19.000.', 'Te la hago a 18 mil.', 'Cerramos en 18.500.', 'Te bonifico el flete.', 'Te hacemos una rebaja.', // 3.ª ronda: quedamos/dejo/hago/cerramos solo con un monto
    'Hay un descuento.', 'Te doy el mejor precio.', 'Es un precio especial.', 'Te la dejo en $ 19.000.', 'Te lo dejo en dieciocho mil.',
  ]) {
    assert.ok(rules([t]).includes('discount'), t);
  }
  assert.ok(!rules(['Quedamos en contacto, cualquier cosa escribinos.']).includes('discount'));
});

test('concesiones (2.ª ronda): regalar, gratis, sin cargo, sin costo, por nuestra cuenta, mejorar el precio, descuentito', () => {
  for (const t of [
    'Te regalo la instalación', 'La instalación va sin cargo', 'El flete corre por nuestra cuenta', 'Podemos mejorar el precio',
    'El flete es gratis.', 'Va sin costo.', 'Podemos mejorar el valor.', 'Te hago un descuentito.', 'Te regalamos el flete.',
  ]) {
    assert.ok(rules([t]).includes('discount'), t);
  }
  assert.ok(!rules(['La instalación y el flete se cotizan aparte porque dependen de la zona.']).includes('discount'));
});

// ---------- Ronda de fixes: "Elite" disfrazada ----------
test('la empresa anterior se detecta aunque venga con tilde, mayúsculas, separadores, caracteres invisibles o letras cirílicas', () => {
  for (const t of [
    'Somos ex Élite Padel.', 'Somos ELITE.', 'Somos E.L.I.T.E.', 'Somos é l i t e.', 'Somos El\u200Bite.', 'Somos Eli\u00ADte.',
    'Somos \u0415l\u0456te.', 'Somos ＥＬＩＴＥ.', 'Somos Elite-Padel.',
  ]) {
    assert.ok(rules([t]).includes('identifier'), JSON.stringify(t));
  }
  assert.deepEqual(rules(['Tenemos excelente atención y un satélite para la señal.']), []); // no es la empresa anterior
  assert.deepEqual(rules(['Eso va en el ítem del presupuesto.']), []); // "el ítem" tampoco
  assert.ok(rules(['Elite me quedó debiendo.']).includes('identifier'));
});

test('Elite (2.ª ronda): letras griegas, ı, ł, versalitas y separadores con guion bajo o cualquier no-letra; "el ítem" sigue sin contar', () => {
  for (const t of [
    'Somos Εlιτε.', // Ε l ι τ ε (griegas)
    'Somos ΕlΙΤΕ.', // Ε l Ι Τ Ε (mayúsculas griegas)
    'Somos Elıte.', 'Somos Ełite.', 'Somos ᴇʟɪᴛᴇ.', // ı, ł, versalitas ᴇʟɪᴛᴇ
    'Somos e_l_i_t_e.', 'Somos e-l-i-t-e.', 'Somos E.L.I.T.E.', 'Somos e__l__i__t__e.',
  ]) {
    assert.ok(rules([t]).includes('identifier'), JSON.stringify(t));
  }
  for (const t of ['Eso va en el ítem del presupuesto.', 'Es el item y listo.', 'Tenemos excelente atención.']) assert.ok(!rules([t]).includes('identifier'), t);
});

// ---------- Ronda de fixes: falsos positivos de identificadores ----------
test('Mariano, Luján y Las Acacias se pueden decir si el cliente los escribió; Elite, Axxen y los números de la empresa anterior, nunca', () => {
  for (const [bubble, customer] of [['Hola Mariano, en qué zona sería?', 'Soy Mariano'], ['Perfecto, en Luján.', 'tengo un terreno en Luján'], ['Anotado, Las Acacias.', 'es en el country Las Acacias']]) {
    assert.ok(!rules([bubble], [customer]).includes('identifier'), bubble);
    assert.ok(rules([bubble], ['hola']).includes('identifier'), `sin que lo diga el cliente: ${bubble}`);
  }
  for (const t of ['Somos Elite.', 'Hablá con Axxen.', 'Escribí al 346737.', 'Es el 209035.']) {
    assert.ok(rules([t], [t]).includes('identifier'), `aunque el cliente lo diga: ${t}`);
  }
});

// ---------- Ronda de fixes: IA ----------
test('IA: negaciones disfrazadas ("para nada", "no es un bot", "te atiende una persona", "somos personas", "soy humano")', () => {
  for (const t of [
    'Un bot? Para nada, somos el equipo', 'Esto no es un bot, te atiende el equipo', 'Te atiende una persona, tranqui.', 'Somos personas, no máquinas.',
    'Soy humano, contame.', 'No somos un bot.', 'Soy una persona real.',
  ]) {
    assert.ok(rules([t], ['sos un bot?']).includes('ai_denial'), t);
  }
  // sin el contexto de la pregunta, "para nada" y "no soy una persona" son normales
  assert.deepEqual(rules(['Para nada, es lo lógico.']), []);
  assert.deepEqual(rules(['No soy una persona, soy el asistente virtual de Olimpo Padel.'], ['sos una persona?']), []);
});

test('IA: si el cliente pregunta (aunque la señal del modelo diga que no), el bot tiene que decir "asistente virtual"', () => {
  for (const q of ['che, sos un bot?', 'eres un robot?', 'estoy hablando con una persona?', 'hablo con una IA?', 'es una persona real?', 'esto es un chatbot?', 'sos una máquina?']) {
    assert.ok(rules(['Somos Olimpo Padel, contame de dónde sos.'], [q], false).includes('ai_disclosure'), q);
  }
  assert.ok(rules(['Sí, soy un bot de Olimpo.'], ['sos un bot?'], false).includes('ai_disclosure')); // "bot" solo no alcanza
  assert.deepEqual(rules(['Sí, soy el asistente virtual de Olimpo Padel. Si querés te paso con alguien del equipo.'], ['sos un bot?'], false), []);
  // solo cuenta lo que el cliente escribió en este turno (ráfaga incluida), no una pregunta vieja
  assert.deepEqual(rules(['Anotado. En qué zona sería?'], ['sos un bot?', 'Pilar']), []);
  const burst = supervise({ bubbles: ['Anotado. En qué zona sería?'], askedIfAi: false, newCustomerTexts: ['sos un bot?', 'quiero 2 canchas'] }, ['sos un bot?', 'quiero 2 canchas'], policy);
  assert.ok(burst.some((x) => x.rule === 'ai_disclosure'));
  // "quiero hablar con una persona" no es preguntar si es un bot
  assert.deepEqual(rules(['Ya le aviso al equipo.'], ['quiero hablar con una persona']), []);
});

// ---------- Ronda de fixes: obra falsa ----------
test('obra falsa: "hicimos / instalamos / construimos / entregamos / armamos" y "cliente de <lugar>" si hay un render o el cliente pregunta por la obra', () => {
  const withRender = (bubble: string, customer = ['mandame fotos']) => supervise({ bubbles: [bubble], askedIfAi: false, renderShown: true }, customer, policy).map((x) => x.rule);
  for (const t of ['Sí, la hicimos nosotros en Escobar.', 'La instalamos el año pasado.', 'La construimos en Tigre.', 'La entregamos hace poco.', 'La armamos con un cliente.']) {
    assert.ok(withRender(t).includes('fake_work'), `render: ${t}`);
    assert.ok(rules([t], ['esa cancha de la foto la hicieron ustedes? dónde está?']).includes('fake_work'), `pregunta: ${t}`);
  }
  assert.ok(withRender('Es de un cliente de Rosario.').includes('fake_work'));
  assert.ok(rules(['Es de un cliente en Pilar.'], ['esa es de ustedes?']).includes('fake_work'));
  // sin render ni pregunta por la obra, "armamos el presupuesto" y compañía son normales
  assert.deepEqual(rules(['Si querés te armamos el presupuesto.']), []);
  // y con ellos también: textos aprobados
  assert.deepEqual(withRender('Instalamos en todo el país.'), []);
  assert.deepEqual(withRender('Es una imagen del modelo, no una obra hecha. Si querés te armamos el presupuesto.', ['esa la hicieron ustedes?']), []);
  assert.deepEqual(rules(['Te paso fotos de un techado que hicimos.'], ['tienen obras para ver?']), []);
});

test('obra falsa siempre: "una cancha que hicimos", "nuestro trabajo terminado", "cliente de <Lugar>"', () => {
  for (const t of ['Esta es una cancha que hicimos en Pilar.', 'Mirá una cancha que instalamos.', 'Te paso nuestro trabajo terminado.', 'Es la cancha de un cliente de Rosario.', 'Un cliente en Mendoza la tiene igual.']) {
    assert.ok(rules([t]).includes('fake_work'), t);
  }
});

// ---------- 2.ª ronda: obras y clientes inventados, siempre (sin render ni pregunta del cliente) ----------
test('obra falsa siempre: verbo de obra hecha cerca de cancha/obra/club, "hay una igual", "es nuestra", trayectoria y experiencia', () => {
  for (const t of [
    'Sí, ya hicimos varias canchas en zona norte', 'Hay una igual en un club de Mendoza', 'Sí, es nuestra, está en Pilar', 'Tenemos mucha experiencia en el rubro',
    'Construimos varias canchas para clubes.', 'Terminamos una obra en Pilar.', 'Montamos un club en Córdoba.', 'Entregamos muchas canchas.', 'Instalamos varias canchas en Tigre.',
    'Tenemos una parecida en Escobar.', 'Tenemos una como esta en Rosario.', 'Son nuestras, las hicimos en Tigre.', 'Tenemos trayectoria en el rubro.',
  ]) {
    assert.ok(rules([t]).includes('fake_work'), t);
  }
  for (const t of [
    'Instalamos en todo el país.', 'Si querés te armamos el presupuesto.', 'Te paso fotos de un techado que hicimos.', 'Fabricación propia.',
    'Es nuestra fabricación propia.', 'Armamos el presupuesto para tu club.', 'Esto lo hicimos así. Cuántas canchas querés?', 'Instalamos canchas en todo el país.',
  ]) {
    assert.deepEqual(rules([t]), [], t);
  }
});

// ---------- 2.ª ronda: menos bloqueos de charla normal ----------
test('números chicos sueltos (1 a 4, "uno" a "cuatro") pasan sin unidad ni moneda; con unidad, moneda o más grandes se siguen bloqueando', () => {
  for (const t of ['Tenemos dos modelos.', 'Una o dos canchas?', 'Te paso 3 fotos.', 'Incluye 4 reflectores.', 'Tenemos tres opciones.', 'Son cuatro vidrios.', 'Tenemos 1 modelo más.']) {
    assert.deepEqual(rules([t]), [], t);
  }
  for (const t of ['Tenemos cinco modelos.', 'Te paso 7 fotos.', 'En 3 meses.', 'Son 2 cuotas.', 'En dos semanas.', 'Sale USD 3.', 'Te paso 3,5 fotos.']) {
    assert.ok(rules([t]).length > 0, t);
  }
});

test('frases con números aprobadas (2.ª ronda): "12mm", "22 por 11", "20 por 10" y el WhatsApp de contacto', () => {
  for (const t of ['Se puede hacer con vidrio de 12mm.', 'El encofrado es de 22 por 11.', 'La cancha es de 20 por 10.', 'Escribinos al +54 9 2323 61-0592.']) {
    assert.deepEqual(rules([t]), [], t);
  }
  assert.ok(rules(['Escribinos al +54 9 2323 61-0593.']).includes('number')); // otro número no pasa por parecerse
  assert.ok(rules(['Es de 20 por 12.']).includes('number'));
});

test('IA (2.ª ronda): "Mi socio es una persona muy prudente" no exige "asistente virtual"; "son humanos", "sos real", "sos un asistente" y "bot?" sí', () => {
  const needsDisclosure = (q: string) => rules(['Somos Olimpo Padel, contame de dónde sos.'], [q], false).includes('ai_disclosure');
  for (const q of [
    'Mi socio es una persona muy prudente', 'Mis socios son personas muy serias', 'Es una persona de confianza', 'quiero hablar con una persona', 'hablar con un humano del equipo',
  ]) {
    assert.ok(!needsDisclosure(q), q);
  }
  for (const q of [
    'son humanos?', 'ustedes son humanos', 'sos real?', 'sos un asistente?', 'bot?', 'che, bot?', 'es una persona real?', 'Es un bot?', 'me responde una persona?', 'sos un bot de ventas?',
    'eres una persona real o un robot?', 'estoy hablando con una persona?', 'esto es un chatbot?', 'me atiende un humano o una máquina?',
  ]) {
    assert.ok(needsDisclosure(q), q);
  }
});

test('IA (2.ª ronda): "carne y hueso", "estás hablando con una persona", "hablás con una persona" son negar ser IA; negarlo ("no soy de carne y hueso") no', () => {
  for (const t of ['Soy de carne y hueso.', 'Sí, estás hablando con una persona.', 'Hablás con una persona real.', 'Acá hablás con una persona.', 'Somos de carne y hueso.']) {
    assert.ok(rules([t], ['sos un bot?']).includes('ai_denial'), t);
  }
  for (const t of ['No soy de carne y hueso, soy el asistente virtual de Olimpo Padel.', 'No estás hablando con una persona, soy el asistente virtual de Olimpo Padel.', 'No hablás con una persona, soy el asistente virtual de Olimpo Padel.']) {
    assert.deepEqual(rules([t], ['sos un bot?']), [], t);
  }
});

test('precio ligado al producto: Full 19.900 o 21.900, Panorámica 20.900, platea 8.500; el "antes" siempre es 21.900', () => {
  for (const t of [
    'La Panorámica sale USD 19.900', 'La Full Panorámica sale USD 20.900', 'La platea sale USD 19.900', 'La Full Panorámica sale USD 8.500',
    'La Full Panorámica está en oferta a USD 21.900 (antes 19.900)', 'oferta a USD 21.900 (antes 19.900)', 'La Full Panorámica está a USD 19.900, antes USD 20.900.',
    'La Panorámica sale USD 21.900.', 'La platea de hormigón sale USD 20.900 por cancha.',
  ]) {
    assert.ok(rules([t]).includes('price_product'), t);
  }
  for (const t of [
    'La Full Panorámica 20x10 está en oferta a USD 19.900, antes USD 21.900.', 'La Panorámica 20x10 está en USD 20.900 por cancha.', 'La platea sale USD 8.500 por cancha, precio fijo.',
    'La Full Panorámica sale USD 21.900.', 'La Full Panorámica está en oferta a USD 19.900 (antes 21.900). Incluye estructura, vidrios templados, césped, red y 4 luces LED.',
    'Hoy cerramos antes de las 18 hs, de dónde sos?', // "antes" sin monto
  ]) {
    assert.ok(!rules([t]).includes('price_product'), t);
  }
  // sin producto en la frase solo rige la lista de montos aprobados (con dos productos, cada monto va con el que lo precede: ver la prueba de la 3.ª ronda)
  assert.ok(!rules(['Sale USD 19.900 por cancha.']).includes('price_product'));
  assert.ok(!rules(['La Full Panorámica sale USD 19.900 y la Panorámica sale USD 20.900.']).includes('price_product'));
  // el punto de los miles no corta la frase, y cada frase se mira por separado
  assert.ok(rules(['La platea sale USD 8.500. La Panorámica sale USD 19.900.']).includes('price_product'));
});

test('promesas de plazo o garantía sin dígitos ("mañana", "un par de días", "de por vida", "medio año") se bloquean salvo dentro de una frase aprobada', () => {
  for (const t of [
    'Te lo mando mañana mismo', 'en un par de días', 'la semana que viene', 'medio año', 'La garantía es de por vida',
    'Te escribimos pasado mañana.', 'Te lo paso la próxima semana.', 'Te contesto el mes que viene.', 'Es un par de semanas.', 'En un par de meses.',
    'Tiene garantía vitalicia.', 'Es una garantía total.', 'Te lo mando MAÑANA.',
  ]) {
    assert.ok(rules([t]).includes('promise'), t);
  }
  for (const t of ['Buen día', 'Buen día, te escribimos de Olimpo Padel. Contame, de dónde sos?', loadPolicy().closingText, 'Dale, tomate tu tiempo.', 'Tomate el día que necesites.']) {
    assert.ok(!rules([t]).includes('promise'), t);
  }
  // dentro de una frase aprobada de la política sí pasa
  const aprobada: SupervisorPolicy = { ...policy, allowedPhrases: [...policy.allowedPhrases, 'por la mañana'] };
  assert.ok(!supervise({ bubbles: ['Te escribimos por la mañana.'], askedIfAi: false }, [], aprobada).some((x) => x.rule === 'promise'));
});

// ---------- Ronda de fixes: negritas de WhatsApp y tuteo ----------
test('estilo: negritas *texto* y cursivas _texto_ de WhatsApp se bloquean; los ids con guion bajo no', () => {
  assert.ok(rules(['La Full Panorámica es *muy* buena.']).includes('style'));
  assert.ok(rules(['La Full Panorámica es _muy_ buena.']).includes('style'));
  assert.deepEqual(rules(['Te sirve la full_panoramica.']), []);
});

test('tuteo: "tú" se detecta aunque el límite de palabra de JavaScript no entienda la tilde', () => {
  assert.ok(rules(['Y tú qué querés?']).includes('voseo'));
  assert.ok(rules(['Dale, y tú.']).includes('voseo'));
  assert.ok(rules(['TÚ tenés platea?']).includes('voseo'));
  assert.deepEqual(rules(['Contame tu proyecto, de dónde sos?']), []);
});

// ---------- Ronda de fixes: altura libre ----------
test('altura: sin saber que hay 7 m o más bajo techo, el bot no afirma que "entra"', () => {
  for (const t of ['Sí, entra perfecto.', 'Sí, alcanza.', 'Claro, entra sin problema.', 'Entra perfecto en tu galpón.', 'Perfecto, cabe bien.']) { // 3.ª ronda: "Si, sirve." sale (no es una afirmación explícita de que entra)
    assert.ok(rules([t]).includes('height'), t);
    assert.deepEqual(supervise({ bubbles: [t], askedIfAi: false, heightOk: true }, [], policy).map((x) => x.rule), [], `con 7 m o más: ${t}`);
  }
  for (const t of ['Eso lo revisa el equipo en el presupuesto.', 'No sé si entra, lo ve el equipo.', 'Si entra o no lo confirma el equipo.', 'Si te sirve, armamos el presupuesto.', 'No entra perfecto, lo revisamos.']) {
    assert.ok(!rules([t]).includes('height'), t);
  }
});

test('altura (2.ª ronda): con techada o hablando de altura/galpón, las afirmaciones de que entra se bloquean si no hay 7 m confirmados', () => {
  // 3.ª ronda: "Sobra altura." y "Es suficiente." salen (ambiguas); el resto de las afirmaciones explícitas sigue
  const bad = ['Sí, con esa altura entra', 'Con 6 m entra', 'La cancha entra tranquilamente', 'Va a entrar sin problemas', 'Con esa altura alcanza.', 'Cabe justo.'];
  const customer = 'tengo un galpón de 6 m, entra?';
  const withCustomer = (b: string, heightOk = false) => supervise({ bubbles: [b], askedIfAi: false, newCustomerTexts: [customer], heightOk }, [customer], policy).map((x) => x.rule);
  const withCard = (b: string, heightOk = false) => supervise({ bubbles: [b], askedIfAi: false, heightContext: true, heightOk }, ['hola'], policy).map((x) => x.rule);
  for (const t of bad) {
    assert.ok(withCustomer(t).includes('height'), `por el texto del cliente: ${t}`);
    assert.ok(withCard(t).includes('height'), `por la ficha: ${t}`);
    assert.ok(!withCustomer(t, true).includes('height') && !withCard(t, true).includes('height'), `con 7 m confirmados: ${t}`);
  }
  assert.deepEqual(withCustomer('El equipo lo revisa en el presupuesto.'), []);
  assert.deepEqual(withCard('El equipo lo revisa en el presupuesto.'), []);
});

test('parser: palabras que son propiedades de Object ("constructor", "toString", "valueOf") no son números', () => {
  assert.deepEqual(vals('La platea la puede hacer tu constructor, o un toString y un valueOf hasOwnProperty __proto__'), []);
  assert.deepEqual(rules(['La platea la puede hacer tu constructor.']), []);
});

// ---------- Eval 7-oct (3.ª corrida): "instalamos" es presente y pasado; solo el pasado concreto es obra inventada ----------
test('"instalamos/armamos canchas" en presente pasa; una obra concreta en pasado no', () => {
  for (const t of ['Fabricamos e instalamos canchas de pádel en todo el país.', 'Instalamos canchas Full Panorámica y Panorámica.', 'Armamos canchas con vidrio templado de 12 mm.']) {
    assert.ok(!rules([t]).includes('fake_work'), t);
  }
  for (const t of ['Instalamos una cancha en Pilar el mes pasado.', 'Ya instalamos varias canchas en zona norte.', 'Hicimos canchas en Córdoba.', 'Terminamos una obra en Escobar.']) {
    assert.ok(rules([t]).includes('fake_work'), t);
  }
});

// ---------- 3.ª ronda: el controlador cuida a un modelo cooperativo; en lo difuso, precisión antes que cobertura ----------
test('altura (3.ª ronda): con techada o altura y sin 7 m, solo se bloquean afirmaciones explícitas de que entra', () => {
  const customer = 'tengo un galpón de 6 m de alto, entra una cancha?';
  const withCard = (b: string, heightOk = false) => supervise({ bubbles: [b], askedIfAi: false, heightContext: true, heightOk }, ['hola'], policy).map((x) => x.rule);
  const withCustomer = (b: string) => supervise({ bubbles: [b], askedIfAi: false, newCustomerTexts: [customer] }, [customer], policy).map((x) => x.rule);
  for (const t of [
    'Con eso alcanza para armar el presupuesto.', 'Con estos datos es suficiente para armar el presupuesto.', 'Cabe aclarar que la instalación se cotiza aparte.',
    'El techado entra en el presupuesto.', 'Si entra o no lo revisa el equipo en el presupuesto.',
    // corpus (trampa-galpon-6m): "si entra" condicional, sin tilde ni coma, no es afirmar que entra
    'Se puede instalar bajo techo, pero la altura de tu galpón la tiene que evaluar el equipo para confirmarte si entra.',
    'Para confirmar si entra con la altura de tu galpón, lo tiene que revisar el equipo.',
    'Con esa altura, el equipo te confirma si entra.', 'Para confirmarte si la cancha entra, lo revisa el equipo.', 'Con 6 m no entra.',
  ]) {
    assert.ok(!withCard(t).includes('height'), `ficha: ${t}`);
    assert.ok(!withCustomer(t).includes('height'), `cliente: ${t}`);
  }
  for (const t of ['Sí, con esa altura entra', 'Con 6 m entra', 'La cancha entra tranquilamente', 'Va a entrar sin problemas', 'Con esa altura alcanzaría.', 'Entra de sobra.']) {
    assert.ok(withCard(t).includes('height'), `ficha: ${t}`);
    assert.ok(withCustomer(t).includes('height'), `cliente: ${t}`);
    assert.ok(!withCard(t, true).includes('height'), `con 7 m confirmados: ${t}`);
  }
});

test('obra falsa (3.ª ronda): solo "hicimos" es pasado inequívoco; instalamos, armamos, montamos, construimos, terminamos y entregamos necesitan una señal de pasado', () => {
  for (const t of [
    'Instalamos canchas de pádel en todo el país.', 'Fabricamos e instalamos canchas Full Panorámica y Panorámica.', 'Armamos canchas a medida de tu espacio.',
    'Construimos la platea y todo tipo de obra civil.', 'Fabricación propia.', 'Te armamos el presupuesto.',
    // corpus y charla normal en presente
    'Construimos canchas de pádel.', 'Montamos la estructura en tu terreno.', 'Entregamos el presupuesto por acá.', 'Terminamos de armar tu ficha y te mandamos el presupuesto.',
    'Es nuestra fabricación propia.',
  ]) {
    assert.ok(!rules([t]).includes('fake_work'), t);
  }
  for (const t of [
    'Ya hicimos varias de estas.', 'Hicimos varias en Buenos Aires.', 'Tenemos canchas funcionando en Pilar.', 'Un cliente de rosario la tiene.', 'Nuestros clientes están muy conformes.',
    'Instalamos una cancha en Pilar el mes pasado.', 'Terminamos una obra en Escobar.',
    'Hicimos 3 en Córdoba.', 'Ya instalamos esas en Mendoza.', 'Recién armamos una igual.', 'Otro cliente en mendoza la pidió igual.', 'Hay una igual en Tigre.',
    'Tenemos canchas instaladas en Rosario.', 'Montamos dos canchas en Salta.', 'Entregamos unas canchas hace poco.',
  ]) {
    assert.ok(rules([t]).includes('fake_work'), t);
  }
});

test('descuentos (3.ª ronda): "quedamos en", "te la dejo en", "te la hago a" y "cerramos en" solo con un monto; "de cortesía", "no te cobramos" y "precio de amigo" también', () => {
  for (const t of [
    'Entonces quedamos en que te mandamos el presupuesto por acá.', 'Te la dejo en el presupuesto.', 'Te la hago a medida.',
    'Quedamos en lo que dijiste.', 'Cerramos en eso.', 'Te la dejo en un buen valor.', 'Cerramos en el día.',
  ]) {
    assert.ok(!rules([t]).includes('discount'), t);
  }
  for (const t of [
    'Dale, quedamos en 18.000', 'Te la dejo en 19 mil', 'te la hago a USD 18.500', 'Cerramos en dieciocho mil.', 'Te la dejo en mil quinientos.', 'Quedamos en u$s 19.000.',
    'El flete va de cortesía.', 'No te cobramos la visita.', 'Es un precio de amigo.',
  ]) {
    assert.ok(rules([t]).includes('discount'), t);
  }
});

test('promesas sin dígitos (3.ª ronda): "hoy mismo", "esta semana", "las próximas horas", "en unos días", "en unas semanas" y "el lunes" se bloquean', () => {
  for (const t of [
    'Hoy mismo te lo mandamos.', 'En unos días te escribimos.', 'Esta semana lo tenés.', 'El lunes te escribimos.', 'En las próximas horas.', 'En unas semanas está.',
    'Te lo mando el viernes.', 'Te escribo las próximas horas.', 'El sábado lo tenés.', 'EL MARTES te aviso.',
  ]) {
    assert.ok(rules([t]).includes('promise'), t);
  }
  for (const t of [
    'Hoy te escribimos por acá.', 'Dale, se arma el presupuesto.', 'Los lunes no atendemos pedidos.', 'Dale, avisanos cuando puedas.', 'Te mandamos el presupuesto por acá en el día.',
  ]) {
    assert.ok(!rules([t]).includes('promise'), t);
  }
  // dentro de una frase aprobada sí pasa
  const aprobada: SupervisorPolicy = { ...policy, allowedPhrases: [...policy.allowedPhrases, 'esta semana'] };
  assert.ok(!supervise({ bubbles: ['Esta semana lo tenés.'], askedIfAi: false }, [], aprobada).some((x) => x.rule === 'promise'));
});

test('precio ligado al producto (3.ª ronda): cada monto va con el producto que lo precede más cerca, también con dos productos en la frase y sin moneda', () => {
  for (const t of [
    'La Full Panorámica está USD 19.900 y la Panorámica USD 21.900.', 'La Full sale USD 19.900 y la Panorámica USD 19.900.', 'La Panorámica sale 19.900.',
    'La Panorámica sale 19900.', 'La Panorámica sale 19,9 mil.', 'La platea sale 20.900 por cancha.', 'La Full Panorámica está USD 19.900 y la platea USD 19.900.',
  ]) {
    assert.ok(rules([t]).includes('price_product'), t);
  }
  for (const t of [
    'La Full Panorámica está en oferta a USD 19.900, antes USD 21.900, y la Panorámica a USD 20.900.',
    'La Full Panorámica está USD 19.900 y la platea USD 8.500.', 'La Panorámica sale 20.900.', 'La Full Panorámica 20x10 sale 19900.', 'La platea sale 8.500 por cancha.',
    'La Full Panorámica no lleva postes, la Panorámica sí. Sale USD 19.900.', // la frase siguiente no tiene producto: solo rige la lista
  ]) {
    assert.ok(!rules([t]).includes('price_product'), t);
  }
});

test('robustez (3.ª ronda): un globo de más de 1000 caracteres devuelve solo la violación de largo, enseguida', () => {
  const huge = 'antes 1 '.repeat(8125); // 65.000 caracteres: la regla de "antes" releía todo el resto del texto en cada repetición
  const t0 = performance.now();
  const v = supervise({ bubbles: [huge], askedIfAi: false }, [], policy);
  const ms = performance.now() - t0;
  assert.deepEqual(v.map((x) => x.rule), ['length']);
  assert.ok(ms < 200, `tardó ${ms.toFixed(0)} ms`);
  // el largo normal (hasta 1000) sigue pasando por todas las reglas
  const long = supervise({ bubbles: [`${'a'.repeat(500)} Somos Elite.`], askedIfAi: false }, [], policy).map((x) => x.rule);
  assert.deepEqual(long, ['length', 'identifier']);
  // un globo enorme y otro normal: solo el largo
  assert.deepEqual(supervise({ bubbles: ['x'.repeat(1001), 'Somos Elite.'], askedIfAi: false }, [], policy).map((x) => x.rule), ['length']);
});

test('estilo (3.ª ronda): "https://olimpopadel.com" no cuenta como dos puntos; la frase "20 metros de largo por 10 de ancho" está aprobada', () => {
  assert.ok(!rules(['Mirá la web en https://olimpopadel.com.']).includes('style'));
  assert.ok(!rules(['Escribinos por http://olimpopadel.com o por acá.']).includes('style'));
  assert.ok(rules(['Incluye: estructura y vidrios.']).includes('style'));
  assert.ok(rules(['Mirá https://olimpopadel.com, incluye: vidrios.']).includes('style')); // el otro sí
  assert.deepEqual(rules(['La cancha mide 20 metros de largo por 10 de ancho.']), []);
  assert.ok(rules(['La cancha mide 20 metros de largo por 12 de ancho.']).includes('number'));
});
