import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { loadPolicy } from '../src/policy.ts';
import { LIST_PRICE_USD, PRICE_BY_PRODUCT } from '../src/supervisor/index.ts';
import { REQUIRED_FIELDS } from '../src/types.ts';

test('loadPolicy carga los 3 archivos y arma la política del controlador', () => {
  const p = loadPolicy();
  assert.deepEqual(p.supervisorPolicy.approvedPricesUsd, [19900, 21900, 20900, 8500]);
  assert.deepEqual(p.supervisorPolicy.allowedNumbers, []); // ningún número suelto: todo va con su frase aprobada
  assert.deepEqual(p.supervisorPolicy.allowedPhrases, ['20x10', '20 x 10', '22x11', '22 x 11', 'H-21', '4 luces', '10 cm', '12 mm', 'cuatro esquinas', '12mm', '22 por 11', '20 por 10', '20 metros de largo por 10 de ancho', '+54 9 2323 61-0592']);
  assert.equal(p.closingText, 'Te mandamos el presupuesto por acá en el día, o a más tardar el día hábil siguiente.');
  assert.deepEqual(p.required, REQUIRED_FIELDS);
  assert.deepEqual(p.assets.map((a) => a.id), ['fabricacion_panos', 'obra_techado', 'modelo_full_panoramica', 'modelo_panoramica']);
  assert.match(p.yamlText, /POLÍTICA COMERCIAL/);
  assert.match(p.toneText, /Tono de Olimpo Padel/);
  assert.deepEqual(p.greetingRules.greetings, ['Buen día', 'Buenas tardes', 'Buenas noches']);
});

test('los precios por producto del controlador coinciden con los del YAML (si cambia un precio, cambian las dos cosas)', () => {
  const y = parse(loadPolicy().yamlText);
  const usd = (id: string): number => y.precios.find((p: { id: string }) => p.id === id).usd;
  assert.deepEqual(PRICE_BY_PRODUCT.full, [usd('full_panoramica_promo'), usd('full_panoramica_lista')]);
  assert.deepEqual(PRICE_BY_PRODUCT.panoramica, [usd('panoramica')]);
  assert.deepEqual(PRICE_BY_PRODUCT.platea, [usd('platea_hormigon')]);
  assert.equal(LIST_PRICE_USD, usd('full_panoramica_lista'));
  assert.deepEqual(Object.values(PRICE_BY_PRODUCT).flat().sort(), [...loadPolicy().supervisorPolicy.approvedPricesUsd].sort());
});

test('la regla de "qué canchas hicieron" dice que la 2.ª duda pasa al equipo (Lazar 7-oct)', () => {
  const y = parse(loadPolicy().yamlText);
  assert.equal(
    y.marca_nueva.que_canchas_hicieron.regla,
    'La primera vez lo maneja el bot con fotos de fabricación, sin derivar y sin decir que la marca es nueva. Si vuelve a dudar (taller, obras, antigüedad), el chat pasa al equipo con prioridad alta (Lazar 7-oct). Nunca inventar obras, ubicaciones ni clientes.',
  );
});

test('el hash es un sha256 estable', () => {
  const a = loadPolicy();
  const b = loadPolicy();
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.hash, b.hash);
});

test('solo entran los precios aprobados', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-policy-'));
  try {
    const src = new URL('../policy/', import.meta.url);
    for (const f of ['tone.md', 'assets.yaml']) copyFileSync(new URL(f, src), join(dir, f));
    const yaml = readFileSync(new URL('olimpo.yaml', src), 'utf8').replace(
      'precios:\n',
      'precios:\n  - { id: en_estudio, modelo: X, usd: 12345, estado: a_confirmar }\n',
    );
    writeFileSync(join(dir, 'olimpo.yaml'), yaml);
    const p = loadPolicy(pathToFileURL(dir + '/'));
    assert.ok(!p.supervisorPolicy.approvedPricesUsd.includes(12345));
    assert.deepEqual(p.supervisorPolicy.approvedPricesUsd, [19900, 21900, 20900, 8500]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
