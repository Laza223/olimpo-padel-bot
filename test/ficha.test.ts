import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFicha } from '../src/ficha.ts';
import { computeTemperature } from '../src/lead.ts';
import { cardWith, field, msg } from './helpers.ts';

const history = [
  msg('m1', 'customer', 'Hola, soy Pedro de Pilar, quiero 2 canchas'),
  msg('m2', 'bot', 'Buen día, te escribimos de Olimpo Padel.'),
  msg('m3', 'customer', 'tengo platea y la quiero techada'),
];

test('ficha para el equipo: motivo, prioridad, datos, faltantes, nota y últimos mensajes', () => {
  const card = {
    ...cardWith(['platea'], { plazo_deseado: field('2 meses', 'm1'), quien_decide: field('él', 'm1') }),
    objections: ['precio' as const],
    teamNote: 'Viene comparando precios',
  };
  card.temperature = computeTemperature(card);
  const t = buildFicha(card, history, { reason: 'listo_para_presupuesto', priority: 'alta', mode: 'stop' });
  assert.match(t, /ALTA/);
  assert.match(t, /Listo para presupuesto/);
  assert.match(t, /Nombre\s*Pedro/);
  assert.match(t, /Canchas\s*2/);
  assert.match(t, /Modelo\s*full panoramica/);
  assert.match(t, /Falta\s*platea/);
  assert.match(t, /precio/);
  assert.match(t, /Viene comparando precios/);
  assert.match(t, /cliente\s+\d\d:\d\d\s+Hola, soy Pedro/);
  assert.match(t, /olimpo\s+\d\d:\d\d\s+Buen día/);
  assert.ok(t.length < 4000);
});

test('ficha con ficha vacía y mensajes largos no se rompe ni se pasa de largo', () => {
  const long = [msg('m1', 'customer', 'x'.repeat(5000))];
  const t = buildFicha({ ...cardWith(), fields: {} }, long, { reason: 'falla_del_bot', priority: 'alta', mode: 'stop' });
  assert.match(t, /Falla del bot/);
  assert.ok(t.length < 4000);
});
