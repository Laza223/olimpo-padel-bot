import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCard, applyPatch, missingRequired, computeState, computeTemperature } from '../src/lead.ts';
import { REQUIRED_FIELDS } from '../src/types.ts';
import { cardWith, field, msg } from './helpers.ts';

const history = [
  msg('m1', 'customer', 'Hola, soy Pedro, quiero dos canchas en Pilar'),
  msg('m2', 'bot', 'Buen día, te escribimos de Olimpo Padel.'),
  msg('m3', 'team', 'Pedro, te llamo en un rato'),
  msg('m4', 'customer', 'serían 3 techadas'),
];

test('platea no_tiene no completa la ficha: falta que diga si se la hacemos o la hace él', () => {
  assert.deepEqual(missingRequired(cardWith([], { platea: field('no_tiene', 'm1') })), ['platea']);
  assert.deepEqual(missingRequired(cardWith([], { platea: field('quiere_que_la_hagamos', 'm1') })), []);
});

test('applyPatch acepta un dato con evidencia del cliente', () => {
  const { card, rejected } = applyPatch(emptyCard(), [{ field: 'nombre', value: 'Pedro', evidence_msg_id: 'm1' }], history);
  assert.deepEqual(card.fields.nombre, { value: 'Pedro', evidenceMsgId: 'm1' });
  assert.deepEqual(rejected, []);
});

test('applyPatch rechaza evidencia que no existe', () => {
  const { card, rejected } = applyPatch(emptyCard(), [{ field: 'nombre', value: 'Pedro', evidence_msg_id: 'm99' }], history);
  assert.equal(card.fields.nombre, undefined);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /no existe/);
});

test('applyPatch rechaza evidencia de un mensaje del bot o del equipo', () => {
  const { card, rejected } = applyPatch(
    emptyCard(),
    [
      { field: 'nombre', value: 'Olimpo', evidence_msg_id: 'm2' },
      { field: 'localidad', value: 'Pilar', evidence_msg_id: 'm3' },
    ],
    history,
  );
  assert.deepEqual(card.fields, {});
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /no es del cliente/);
});

test('cantidad_canchas: el número tiene que aparecer en el mensaje citado (dígitos o palabras)', () => {
  const patch = (value: string, id: string) => applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value, evidence_msg_id: id }], history);
  assert.equal(patch('2', 'm1').card.fields.cantidad_canchas?.value, '2'); // "dos canchas"
  assert.equal(patch('3', 'm4').card.fields.cantidad_canchas?.value, '3'); // "3 techadas"
  assert.equal(patch('3', 'm1').rejected.length, 1); // m1 dice dos, no tres
  assert.equal(patch('dos', 'm1').rejected.length, 1); // el valor va en dígitos
  assert.equal(patch('0', 'm1').rejected.length, 1);
  const una = [msg('m1', 'customer', 'quiero una cancha')];
  assert.equal(applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '1', evidence_msg_id: 'm1' }], una).card.fields.cantidad_canchas?.value, '1');
});

test('valores de enumeración inválidos se descartan; los válidos se normalizan', () => {
  const p = (f: string, v: string) => applyPatch(emptyCard(), [{ field: f as 'modelo', value: v, evidence_msg_id: 'm1' }], history);
  assert.equal(p('modelo', 'full_panoramica').card.fields.modelo?.value, 'full_panoramica');
  assert.equal(p('modelo', 'Panoramica').card.fields.modelo?.value, 'panoramica');
  assert.equal(p('modelo', 'la grande').rejected.length, 1);
  assert.equal(p('ubicacion', 'techada').card.fields.ubicacion?.value, 'techada');
  assert.equal(p('ubicacion', 'cubierta').rejected.length, 1);
  assert.equal(p('platea', 'tiene').card.fields.platea?.value, 'tiene');
  assert.equal(p('platea', 'no_tiene').card.fields.platea?.value, 'no_tiene'); // dijo que no tiene; todavía no confirmó que se la hagamos
  assert.equal(p('platea', 'no sé').rejected.length, 1);
  assert.equal(p('uso', 'club').card.fields.uso?.value, 'club');
  assert.equal(p('uso', 'hobby').rejected.length, 1);
  assert.equal(p('pide_financiacion', 'sí').card.fields.pide_financiacion?.value, 'si');
  assert.equal(p('vidrio_12mm', 'quizás').rejected.length, 1);
});

test('applyPatch rechaza campos desconocidos y valores vacíos o larguísimos; no muta la ficha original', () => {
  const original = cardWith(['nombre']);
  const copy = structuredClone(original);
  const { card, rejected } = applyPatch(
    original,
    [
      { field: 'color_favorito' as 'nombre', value: 'azul', evidence_msg_id: 'm1' },
      { field: 'nombre', value: '   ', evidence_msg_id: 'm1' },
      { field: 'forma_pago', value: 'x'.repeat(500), evidence_msg_id: 'm1' },
      { field: 'nombre', value: ' Pedro ', evidence_msg_id: 'm1' },
    ],
    history,
  );
  assert.equal(rejected.length, 3);
  assert.equal(card.fields.nombre?.value, 'Pedro');
  assert.deepEqual(original, copy);
});

test('un dato nuevo pisa al anterior (el cliente cambia de idea)', () => {
  const first = applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm1' }], history).card;
  const second = applyPatch(first, [{ field: 'cantidad_canchas', value: '3', evidence_msg_id: 'm4' }], history).card;
  assert.deepEqual(second.fields.cantidad_canchas, { value: '3', evidenceMsgId: 'm4' });
});

test('missingRequired y estado', () => {
  assert.deepEqual(missingRequired(emptyCard()), REQUIRED_FIELDS);
  assert.equal(computeState(emptyCard()), 'nuevo');
  const partial = cardWith(['modelo', 'platea']);
  assert.deepEqual(missingRequired(partial), ['modelo', 'platea']);
  assert.equal(computeState(partial), 'calificando');
  assert.equal(computeState(cardWith(['nombre', 'localidad', 'provincia', 'cantidad_canchas', 'modelo', 'platea'], { uso: field('club', 'm1') })), 'calificando');
  assert.equal(computeState(cardWith()), 'listo_para_presupuesto');
});

test('temperatura: caliente, tibio y frío', () => {
  assert.equal(computeTemperature(emptyCard()), 'frio');
  assert.equal(computeTemperature(cardWith(['modelo', 'platea', 'cantidad_canchas'])), 'frio'); // 3 de 6
  assert.equal(computeTemperature(cardWith(['platea', 'cantidad_canchas'])), 'tibio'); // 4 de 6
  assert.equal(computeTemperature(cardWith()), 'tibio'); // listo, pero sin plazo ni quién decide
  assert.equal(computeTemperature(cardWith([], { plazo_deseado: field('2 meses', 'm1') })), 'tibio');
  assert.equal(computeTemperature(cardWith([], { quien_decide: field('él', 'm1') })), 'tibio');
  assert.equal(computeTemperature(cardWith([], { plazo_deseado: field('2 meses', 'm1'), quien_decide: field('él', 'm1') })), 'caliente');
  // plazo y decisor sin estar listo no alcanza
  assert.equal(computeTemperature(cardWith(['nombre', 'platea', 'cantidad_canchas'], { plazo_deseado: field('2 meses', 'm1'), quien_decide: field('él', 'm1') })), 'frio');
});

// ---------- Ronda de fixes: el dato tiene que estar en el mensaje citado ----------
test('nombre, localidad y provincia tienen que aparecer en el mensaje citado (sin importar mayúsculas ni tildes)', () => {
  const h = [msg('m1', 'customer', 'Hola, soy Pedro Gómez, quiero dos canchas en Córdoba capital')];
  const p = (f: string, v: string) => applyPatch(emptyCard(), [{ field: f as 'nombre', value: v, evidence_msg_id: 'm1' }], h);
  assert.equal(p('nombre', 'pedro').card.fields.nombre?.value, 'pedro');
  assert.equal(p('nombre', 'Pedro Gomez').card.fields.nombre?.value, 'Pedro Gomez');
  assert.equal(p('localidad', 'cordoba').card.fields.localidad?.value, 'cordoba');
  assert.match(p('nombre', 'Carlos').rejected[0].reason, /no aparece/);
  assert.equal(p('provincia', 'Buenos Aires').rejected.length, 1); // la deduce el modelo, no la dijo el cliente
  assert.equal(p('localidad', 'Pilar').rejected.length, 1);
  assert.equal(p('nombre', 'Ped').rejected.length, 1); // es parte de una palabra
});

test('cantidad_canchas "1": solo con "una cancha", "1 cancha" o "uno" pegado a "cancha"', () => {
  const one = (text: string) => applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '1', evidence_msg_id: 'm1' }], [msg('m1', 'customer', text)]).card.fields.cantidad_canchas?.value;
  for (const ok of ['quiero una cancha', 'Quiero 1 cancha', 'una sola cancha', 'cancha: 1', 'quiero un cancha']) assert.equal(one(ok), '1', ok);
  for (const bad of ['tengo un galpón de 20x10 para la cancha', 'soy uno de los socios y quiero información sobre canchas', 'quiero canchas, soy de la zona 1', 'Hola']) assert.equal(one(bad), undefined, bad);
});

test('cantidad_canchas "1": respuesta corta a "cuántas canchas serían?" ("1", "una", "solo una", "somos 2 socios, queremos 1")', () => {
  const one = (text: string, botText = 'Cuántas canchas serían?') =>
    applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '1', evidence_msg_id: 'm2' }], [msg('m0', 'customer', 'hola'), msg('m1', 'bot', botText), msg('m2', 'customer', text)]).card.fields.cantidad_canchas?.value;
  for (const ok of ['1', 'una', 'uno', 'solo una', 'una sola', 'Una nomás', 'somos 2 socios, queremos 1']) assert.equal(one(ok), '1', ok);
  // si el último mensaje del bot no preguntó por canchas, "1" o "una" solos no alcanzan
  for (const t of ['1', 'una', 'solo una']) assert.equal(one(t, 'De dónde sos?'), undefined, t);
  // ni la medida, ni un número con unidad o con monto, aunque el bot haya preguntado por canchas
  for (const bad of ['20x10', '22 x 11', 'quiero 20 por 10', 'la quiero en 1 mes', 'una semana', 'son USD 1.500', 'hola']) assert.equal(one(bad), undefined, bad);
  // cuenta el último mensaje del bot ANTERIOR al citado
  const h = [msg('m1', 'bot', 'Cuántas canchas serían?'), msg('m2', 'customer', 'Pilar'), msg('m3', 'bot', 'Y cómo te llamás?'), msg('m4', 'customer', 'una')];
  assert.equal(applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '1', evidence_msg_id: 'm4' }], h).rejected.length, 1);
});

test('cantidad_canchas: el texto de la evidencia se corta a 2000 caracteres antes de los regex (65.000 dígitos no cuelgan el turno)', () => {
  const t0 = performance.now();
  const r = applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm1' }], [msg('m1', 'customer', '1'.repeat(65_000))]);
  assert.ok(performance.now() - t0 < 1000, `tardó ${Math.round(performance.now() - t0)} ms`);
  assert.equal(r.rejected.length, 1);
  // un dato que aparece pasado el límite no cuenta; uno dentro del límite sí
  const late = msg('m1', 'customer', `${'x '.repeat(1100)}quiero 2 canchas`);
  assert.equal(applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm1' }], [late]).rejected.length, 1);
  assert.equal(applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value: '2', evidence_msg_id: 'm1' }], [msg('m1', 'customer', `${'x '.repeat(100)}quiero 2 canchas`)]).rejected.length, 0);
});

test('cantidad_canchas: un número que solo está dentro de una medida ("20x10", "22 x 11") o pegado a una unidad no vale', () => {
  const n = (value: string, text: string) => applyPatch(emptyCard(), [{ field: 'cantidad_canchas', value, evidence_msg_id: 'm1' }], [msg('m1', 'customer', text)]).card.fields.cantidad_canchas?.value;
  assert.equal(n('10', 'quiero una cancha de 20x10'), undefined);
  assert.equal(n('11', 'encofrado de 22 x 11'), undefined);
  assert.equal(n('20', 'cancha de 20 x 10'), undefined);
  assert.equal(n('2', 'la quiero en 2 meses'), undefined);
  assert.equal(n('2', 'quiero 2 canchas de 20x10'), '2');
});

test('altura_libre_m: dígitos o decimal, con el número en el mensaje citado; la coma pasa a punto', () => {
  const h = (value: string, text: string) => applyPatch(emptyCard(), [{ field: 'altura_libre_m', value, evidence_msg_id: 'm1' }], [msg('m1', 'customer', text)]);
  assert.equal(h('6', 'tengo un galpón de 6 m de alto').card.fields.altura_libre_m?.value, '6');
  assert.equal(h('7,5', 'el galpón tiene 7,5 metros libres').card.fields.altura_libre_m?.value, '7.5');
  assert.equal(h('7.5', 'son 7,5 m').card.fields.altura_libre_m?.value, '7.5');
  assert.equal(h('8', 'tengo un galpón de 6 m de alto').rejected.length, 1); // el mensaje dice 6
  assert.equal(h('alto', 'tengo un galpón alto').rejected.length, 1);
  assert.equal(h('0', 'tengo 0 de alto').rejected.length, 1);
  assert.equal(h('60', 'galpón de 60 m').rejected.length, 1); // no es una altura creíble
  assert.equal(h('10', 'una cancha de 20x10').rejected.length, 1); // el 10 es de una medida
});

test('modelo "indefinido" ya no cuenta como dato: se descarta y el modelo sigue faltando', () => {
  const r = applyPatch(emptyCard(), [{ field: 'modelo', value: 'indefinido', evidence_msg_id: 'm1' }], history);
  assert.equal(r.card.fields.modelo, undefined);
  assert.equal(r.rejected.length, 1);
  assert.ok(missingRequired(cardWith(['modelo'])).includes('modelo'));
  assert.equal(computeState(cardWith(['modelo'])), 'calificando');
});
