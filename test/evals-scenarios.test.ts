import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileRegex, loadScenarios, parseScenario, selectScenarios, splitBurst } from '../evals/scenario.ts';
import type { Scenario } from '../evals/scenario.ts';
import { loadPolicy } from '../src/policy.ts';

const policy = loadPolicy();
const assetIds = policy.assets.map((a) => a.id);
const scenarios = loadScenarios(undefined, assetIds);
const byId = (id: string): Scenario => {
  const s = scenarios.find((x) => x.id === id);
  assert.ok(s, `falta el escenario ${id}`);
  return s;
};

// ---------- El banco que se entrega ----------
test('todos los archivos de evals/scenarios cargan y validan', () => {
  const files = readdirSync(new URL('../evals/scenarios/', import.meta.url)).filter((f) => f.endsWith('.yaml'));
  assert.equal(scenarios.length, files.length);
  assert.deepEqual(scenarios.map((s) => `${s.id}.yaml`), [...files].sort());
});

test('hay unos 40 escenarios de guion y 12 de persona', () => {
  assert.ok(scenarios.filter((s) => s.tipo === 'guion').length >= 40);
  assert.equal(scenarios.filter((s) => s.tipo === 'persona').length, 12);
});

test('un escenario de guion por cada uno de los 20 ejemplos de tone.md, con el mensaje del ejemplo', () => {
  const md = readFileSync(new URL('../policy/tone.md', import.meta.url), 'utf8');
  const examples = [...md.matchAll(/^\s*\d+\.\s+"(.+?)"[^\n]*\n\s*→/gm)].map((m) => m[1]);
  assert.equal(examples.length, 20);
  const tono = scenarios.filter((s) => s.id.startsWith('tono-'));
  assert.equal(tono.length, 20);
  tono.forEach((s, i) => {
    assert.ok(s.id.startsWith(`tono-${String(i + 1).padStart(2, '0')}-`), s.id);
    assert.equal(s.tipo, 'guion', s.id);
    const last = splitBurst(s.mensajes!.at(-1)!).at(-1)!;
    assert.ok(last.endsWith(examples[i]), `${s.id}: el último mensaje tiene que terminar con "${examples[i]}"`);
  });
});

test('están todas las trampas del contrato', () => {
  const required = [
    'trampa-ignora-instrucciones', 'trampa-cbu', 'trampa-instalacion-cordoba', 'trampa-regateo-18000', 'trampa-garantia-anos',
    'trampa-entrega-exacta', 'trampa-factura-a', 'trampa-elite-reclamo', 'trampa-proveedor-hierro', 'trampa-no-escribir-mas',
    'trampa-insultos', 'trampa-quiero-una-persona', 'trampa-rafaga-datos', 'trampa-anuncio-contacto', 'trampa-render-donde-esta',
    'trampa-quinta-uruguay', 'trampa-hora-23', 'trampa-segundo-turno-sin-saludo', 'trampa-galpon-6m',
  ];
  for (const id of required) assert.equal(byId(id).tipo, 'guion', id);
});

test('están las 12 personas del contrato', () => {
  const required = [
    'persona-inversor-galpon', 'persona-club-3-canchas', 'persona-particular-country', 'persona-regateador', 'persona-desconfiado',
    'persona-curioso-sin-datos', 'persona-apurado-todo-en-un-mensaje', 'persona-habla-con-socio', 'persona-financiacion',
    'persona-audios-desordenados', 'persona-cambia-de-idea', 'persona-pregunta-si-es-bot',
  ];
  for (const id of required) assert.equal(byId(id).tipo, 'persona', id);
});

test('expectativas clave del contrato', () => {
  assert.equal(byId('trampa-elite-reclamo').espera.derivacion, 'pregunta_por_empresa_anterior');
  assert.match(byId('tono-19-son-los-de-elite').espera.dice_todas!.join(' '), /empresa aparte/);
  assert.equal(byId('trampa-no-escribir-mas').espera.estado, 'baja');
  assert.equal(byId('trampa-proveedor-hierro').espera.estado, 'no_es_cliente');
  assert.equal(byId('trampa-proveedor-hierro').espera.sin_globos, true);
  assert.match(byId('trampa-hora-23').espera.primer_globo!, /buenas noches/);
  assert.equal(byId('trampa-hora-23').hora, '23:00');
  assert.deepEqual(byId('persona-club-3-canchas').espera.derivacion, ['cliente_grande', 'listo_para_presupuesto']);
  assert.equal(splitBurst(byId('trampa-rafaga-datos').mensajes![0]).length, 4);
  assert.equal(byId('persona-inversor-galpon').espera.derivacion_antes_del_turno, 8);
});

// ---------- Validación ----------
const guion = (over: Record<string, unknown> = {}) => ({
  id: 'prueba', tags: ['x'], hora: '15:00', tipo: 'guion', mensajes: ['Hola'], espera: { derivacion: 'ninguna' }, ...over,
});
const persona = (over: Record<string, unknown> = {}) => ({
  id: 'prueba', hora: '15:00', tipo: 'persona',
  persona: { perfil: 'p', datos_ocultos: { nombre: 'Pedro', cantidad_canchas: 2 }, estilo: 'e', objetivo: 'o' },
  espera: { estado: 'derivado' }, ...over,
});
const errorsOf = (raw: unknown, file = 'prueba.yaml', assets = assetIds) => parseScenario(raw, file, assets).errors.join(' | ');

test('un guion y una persona mínimos validan, con defaults', () => {
  const g = parseScenario(guion({ mensajes: ['a', 'b || c'] }), 'prueba.yaml').scenario!;
  assert.equal(g.max_turnos, 2);
  const p = parseScenario(persona(), 'prueba.yaml').scenario!;
  assert.equal(p.max_turnos, 10);
  assert.deepEqual(p.persona!.datos_ocultos, { nombre: 'Pedro', cantidad_canchas: '2' }); // los números pasan a texto
  assert.deepEqual(p.tags, []);
});

test('rechaza claves desconocidas, ids malos y archivos que no son objetos', () => {
  assert.match(errorsOf(guion({ colgado: 1 })), /clave desconocida "colgado"/);
  assert.match(errorsOf(guion({ espera: { derivacion: 'ninguna', nunca_dise: ['x'] } })), /espera: clave desconocida "nunca_dise"/);
  assert.match(errorsOf(guion({ id: 'Mal Id' })), /id obligatorio/);
  assert.match(errorsOf(guion({ id: 'otro' })), /tiene que coincidir con el nombre del archivo/);
  assert.match(errorsOf('texto'), /objeto YAML/);
  assert.match(errorsOf(null), /objeto YAML/);
});

test('rechaza hora, tipo y mensajes inválidos', () => {
  assert.match(errorsOf(guion({ hora: '25:00' })), /hora inválida/);
  assert.match(errorsOf(guion({ hora: undefined })), /hora obligatoria/);
  assert.match(errorsOf(guion({ tipo: 'otro' })), /tipo tiene que ser guion o persona/);
  assert.match(errorsOf(guion({ mensajes: undefined })), /mensajes/);
  assert.match(errorsOf(guion({ mensajes: [] })), /mensajes/);
  assert.match(errorsOf(guion({ mensajes: ['  '] })), /mensajes/);
  assert.match(errorsOf(guion({ mensajes: [' || '] })), /mensajes/);
  assert.match(errorsOf(guion({ persona: persona().persona })), /un guion no lleva persona/);
  assert.match(errorsOf(persona({ mensajes: ['hola'] })), /una persona no lleva mensajes/);
  assert.match(errorsOf(guion({ max_turnos: 1, mensajes: ['a', 'b'] })), /max_turnos es menor/);
  assert.match(errorsOf(guion({ max_turnos: 0 })), /max_turnos/);
});

test('rechaza personas incompletas', () => {
  assert.match(errorsOf(persona({ persona: undefined })), /persona obligatoria/);
  assert.match(errorsOf(persona({ persona: { perfil: 'p', datos_ocultos: {}, estilo: 'e', objetivo: 'o' } })), /datos_ocultos/);
  assert.match(errorsOf(persona({ persona: { perfil: 'p', datos_ocultos: { a: 'b' }, objetivo: 'o' } })), /persona\.estilo obligatorio/);
  assert.match(errorsOf(persona({ persona: { perfil: 'p', datos_ocultos: { a: 'b' }, estilo: 'e', objetivo: 'o', extra: 1 } })), /clave desconocida "extra"/);
});

test('rechaza expectativas inválidas', () => {
  const e = (espera: unknown) => errorsOf(guion({ espera }));
  assert.match(e(undefined), /espera obligatoria/);
  assert.match(e({}), /espera obligatoria/);
  assert.match(e({ derivacion: 'inventada' }), /espera\.derivacion/);
  assert.match(e({ derivacion: ['ninguna'] }), /espera\.derivacion/);
  assert.match(e({ derivacion: 'regateo', derivacion_antes_del_turno: 5 }), /derivacion_antes_del_turno: entero entre 1 y 1/);
  assert.match(e({ derivacion_antes_del_turno: 1 }), /necesita una derivación esperada/);
  assert.match(e({ derivacion: 'ninguna', derivacion_antes_del_turno: 1 }), /necesita una derivación esperada/);
  assert.match(e({ estado: 'dormido' }), /espera\.estado/);
  assert.match(e({ ficha: { color: 'rojo' } }), /campo desconocido "color"/);
  assert.match(e({ ficha: {} }), /espera\.ficha/);
  assert.match(e({ nunca_dice: ['(sin cerrar'] }), /regex inválida/);
  assert.match(e({ dice_alguna: [] }), /espera\.dice_alguna/);
  assert.match(e({ dice_todas: [1] }), /espera\.dice_todas/);
  assert.match(e({ primer_globo: '[' }), /espera\.primer_globo/);
  assert.match(e({ sin_globos: false }), /sin_globos: solo true/);
  assert.match(e({ sin_globos: true, dice_alguna: ['x'] }), /contradice/);
  assert.match(e({ material: ['foto_inventada'] }), /ids que no existen en assets: foto_inventada/);
  assert.match(e({ desde_turno: 3, nunca_dice: ['x'] }), /desde_turno: entero entre 1 y 1/);
});

test('expectativas válidas se conservan tal cual', () => {
  const espera = {
    derivacion: ['cliente_grande', 'listo_para_presupuesto'], derivacion_antes_del_turno: 2, estado: 'derivado', ficha: { cantidad_canchas: 3 },
    nunca_dice: ['(?i)x'], dice_alguna: ['y'], dice_todas: ['z'], primer_globo: '^Buen', material: ['fabricacion_panos'], desde_turno: 2,
  };
  const s = parseScenario(guion({ mensajes: ['a', 'b'], espera }), 'prueba.yaml', assetIds).scenario!;
  assert.deepEqual(s.espera, { ...espera, ficha: { cantidad_canchas: '3' } });
});

test('compileRegex acepta el prefijo (?i) del contrato y trabaja por línea', () => {
  assert.ok(compileRegex('(?i)garant[ií]a de \\d').test('GARANTÍA de 5 años'));
  assert.ok(!compileRegex('garant[ií]a de \\d').test('GARANTÍA de 5 años'));
  assert.ok(compileRegex('^Buenas noches').test('Hola\nBuenas noches'));
  assert.throws(() => compileRegex('(sin cerrar'));
});

test('splitBurst separa la ráfaga y descarta vacíos', () => {
  assert.deepEqual(splitBurst('a || b||c'), ['a', 'b', 'c']);
  assert.deepEqual(splitBurst('sola'), ['sola']);
  assert.deepEqual(splitBurst(' || '), []);
});

// ---------- Carga desde disco ----------
const dirWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-evals-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { dir, url: pathToFileURL(`${dir}/`), clean: () => rmSync(dir, { recursive: true, force: true }) };
};
const ok = (id: string) => `id: ${id}\ntags: [x]\nhora: "15:00"\ntipo: guion\nmensajes: ["Hola"]\nespera: { derivacion: ninguna }\n`;

test('loadScenarios junta todos los errores, detecta ids repetidos y YAML roto', () => {
  const d = dirWith({ 'a.yaml': ok('a'), 'b.yaml': ok('a').replace('derivacion: ninguna', 'derivacion: nada'), 'c.yaml': 'id: [\n', 'notas.txt': 'no cuenta' });
  try {
    assert.throws(() => loadScenarios(d.url), (e: Error) => {
      assert.match(e.message, /b\.yaml: el id "a" tiene que coincidir/);
      assert.match(e.message, /b\.yaml: espera\.derivacion/);
      assert.match(e.message, /c\.yaml: YAML inválido/);
      return true;
    });
  } finally {
    d.clean();
  }
  const dup = dirWith({ 'a.yaml': ok('a'), 'a.yml': ok('a') });
  try {
    assert.throws(() => loadScenarios(dup.url), /id repetido "a"/);
  } finally {
    dup.clean();
  }
  const empty = dirWith({});
  try {
    assert.throws(() => loadScenarios(empty.url), /no hay escenarios/);
  } finally {
    empty.clean();
  }
});

test('loadScenarios carga ordenado por nombre', () => {
  const d = dirWith({ 'b.yaml': ok('b'), 'a.yaml': ok('a') });
  try {
    assert.deepEqual(loadScenarios(d.url).map((s) => s.id), ['a', 'b']);
  } finally {
    d.clean();
  }
});

test('selectScenarios filtra por id y falla con ids que no existen', () => {
  assert.equal(selectScenarios(scenarios).length, scenarios.length);
  assert.deepEqual(selectScenarios(scenarios, ['trampa-cbu', 'tono-02-precio']).map((s) => s.id), ['tono-02-precio', 'trampa-cbu']);
  assert.throws(() => selectScenarios(scenarios, ['tono-02-precio', 'no-existe']), /no existen: no-existe/);
});
