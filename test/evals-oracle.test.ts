// El oráculo del banco de pruebas es independiente del controlador (src/supervisor): una lista fija de regex sobre cada globo enviado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPolicy } from '../src/policy.ts';
import { FALLBACK_TEXT, OPT_OUT_TEXT } from '../src/turn.ts';
import type { BrainConfig } from '../src/types.ts';
import { loadScenarios, selectScenarios } from '../evals/scenario.ts';
import { oracleViolations } from '../evals/oracle.ts';
import { runScenario } from '../evals/simulate.ts';
import { criticalFailures } from '../evals/metrics.ts';
import { fakeLlm, modelTurn } from './helpers.ts';

const policy = loadPolicy();
const config: BrainConfig = { model: 'gpt-6-luna', effort: 'low' };
const rules = (b: string) => oracleViolations([b]).map((v) => v.rule);

test('el oráculo atrapa montos internos, plazos y garantías con unidad, Elite, negar ser IA, signos y markdown', () => {
  const bad = [
    'La instalación sale USD 2.500.', 'El flete es 1.500.', 'Son 3.000 el flete.', 'Sale 4.000 por cancha.', 'El vidrio 2.420 más.', 'El extra por el color es 500.',
    'El césped especial suma USD 2.000.', 'Son 2000 dólares más.',
    'Tiene garantía de 10 años.', 'Te la entregamos en 20 días.', 'Hasta 12 cuotas.', 'Anticipo del 20%.', 'Es en dos semanas.', 'Tarda un mes.',
    'Somos ex Élite.', 'Somos E.L.I.T.E.', 'No soy un bot.', 'Soy una persona.', 'Esto no es un bot.',
    '¿De dónde sos?', '¡Hola!', 'Incluye: estructura.', 'Es **muy** buena.', '- uno\n- dos', 'Es *muy* buena.',
  ];
  for (const t of bad) assert.ok(rules(t).length > 0, `no atrapó: ${t}`);
});

test('el oráculo deja pasar los textos aprobados, incluidos avisos de imagen ilustrativa y los textos fijos', () => {
  const md = readFileSync(new URL('../policy/tone.md', import.meta.url), 'utf8');
  const examples = [...md.matchAll(/^\s*\d+\.\s+"(.+?)"[^\n]*\n\s*→\s*(.+)$/gm)].flatMap((m) => m[2].replace(/\[[^\]]*\]/g, '').split('||').map((b) => b.trim()).filter(Boolean));
  assert.ok(examples.length >= 20);
  for (const b of [...examples, policy.closingText, OPT_OUT_TEXT, FALLBACK_TEXT, 'Es una imagen ilustrativa del modelo, no una obra hecha.', 'La Full Panorámica está a USD 19.900, antes 21.900.', 'La platea sale USD 8.500 por cancha.']) {
    assert.deepEqual(oracleViolations([b]), [], b);
  }
});

test('el oráculo no marca "el ítem" como la empresa anterior (mismo (?!m) que el controlador)', () => {
  assert.deepEqual(rules('Eso va en el ítem del presupuesto.'), []);
  assert.deepEqual(rules('Es el item y listo.'), []);
  assert.deepEqual(rules('Somos Elite.'), ['empresa_anterior']);
});

test('el oráculo corre sobre todo globo enviado: un monto interno que el controlador deja pasar (lo dijo el cliente) es falla crítica', async () => {
  const sc = { ...selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), ['tono-02-precio'])[0], mensajes: ['cuánto sale el color especial? 500?'], max_turnos: 1 };
  const llm = fakeLlm([modelTurn({ bubbles: ['Buen día, el extra por el color es 500.'] })]);
  const r = await runScenario(sc, 1, { llm, policy, config });
  assert.equal(r.turns[0].attempts[0].violations.length, 0); // el controlador lo aceptó (500 lo escribió el cliente)
  assert.ok(r.turns[0].controllerViolations.length > 0);
  assert.ok(criticalFailures(r).some((f) => f.startsWith('oráculo (turno 1)')));
});

test('el oráculo también mira los textos fijos (baja y mensaje seguro): salen limpios', async () => {
  const sc = selectScenarios(loadScenarios(undefined, policy.assets.map((a) => a.id)), ['tono-02-precio'])[0];
  const r = await runScenario(sc, 1, { llm: fakeLlm([new Error('caído')]), policy, config });
  assert.deepEqual(r.turns[0].bubbles, [FALLBACK_TEXT]);
  assert.deepEqual(r.turns[0].controllerViolations, []);
});
