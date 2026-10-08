// Generación del reporte (report.md y summary.json), el resumen de consola y la comparación. Con resultados inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCard } from '../src/lead.ts';
import { buildEvalOutput, buildSummary, consoleSummary, dirName, renderReport, writeReport } from '../evals/report.ts';
import type { EvalMeta, EvalOutput } from '../evals/report.ts';
import { cheapestPassing, compareTable } from '../evals/compare.ts';
import type { ConversationResult } from '../evals/types.ts';
import { result, turnLog, verdict } from './evals-helpers.ts';

const meta = (o: Partial<EvalMeta> = {}): EvalMeta => ({
  startedAt: new Date('2026-10-07T16:37:00Z'), // 13:37 en Argentina
  model: 'gpt-6-luna', effort: 'low', runs: 2, concurrency: 4, policyHash: 'abc123', scenarioIds: ['a-escenario', 'b-escenario'], ...o,
});

const clean = (id: string, run: number): ConversationResult =>
  result({ scenarioId: id, run, turns: [turnLog({ customer: ['Hola'], bubbles: ['Buen día, te escribimos de Olimpo Padel.'] })], judge: verdict(5, { comentario: 'Impecable.' }) });

const dirty = (id: string, run: number): ConversationResult =>
  result({
    scenarioId: id,
    run,
    tipo: 'persona',
    hora: '23:00',
    endReason: 'bot_parado',
    turns: [
      turnLog({
        turn: 1,
        customer: ['Cuánto sale?'],
        bubbles: ['Buenas noches, la Full Panorámica está en oferta.'],
        attempts: [
          { latencyMs: 2500, costUsd: 0.003, violations: [{ rule: 'greeting', detail: 'es el primer mensaje' }], proposed: ['Buen día | sale USD 1.000'] },
          { latencyMs: 3500, costUsd: 0.004, violations: [] },
        ],
        rejected: [{ field: 'nombre', value: 'Pedro', evidenceMsgId: 'm2', reason: 'el mensaje de evidencia no es del cliente' }],
        handoffs: [{ reason: 'regateo', priority: 'normal', mode: 'flag' }],
        material: ['fabricacion_panos'],
      }),
    ],
    expectFailures: ['derivacion: se esperaba pregunta_por_empresa_anterior y hubo regateo'],
    judge: verdict(3, { critico: { invento_dato: true }, comentario: 'Inventó un precio en el turno 1.' }),
    finalCard: { ...emptyCard(), state: 'derivado', teamNote: 'Regatea\nmucho', fields: { nombre: { value: 'Pedro', evidenceMsgId: 'm1' } } },
    cost: { bot: 0.007, customer: 0.001, judge: 0.03 },
  });

const results = [dirty('b-escenario', 2), clean('b-escenario', 1), clean('a-escenario', 2), clean('a-escenario', 1)]; // desordenadas a propósito
const output = (): EvalOutput => buildEvalOutput(meta(), results);

test('buildEvalOutput ordena por corrida y por id, y calcula métricas y vara por corrida', () => {
  const o = output();
  assert.deepEqual(o.results.map((r) => `${r.run}:${r.scenarioId}`), ['1:a-escenario', '1:b-escenario', '2:a-escenario', '2:b-escenario']);
  assert.deepEqual(o.perRun.map((r) => [r.run, r.metrics.conversations, r.gate.pass]), [[1, 2, true], [2, 2, false]]);
  assert.equal(o.perRun[1].metrics.criticalFailures, 2); // un crítico del juez y una expectativa
  assert.equal(o.overall.conversations, 4);
  assert.equal(o.pass, false); // una corrida en rojo basta
  assert.deepEqual(buildEvalOutput(meta(), results.slice(1, 4).filter((r) => r.run === 1)).pass, false); // la corrida 2 quedó vacía: sin datos
});

test('report.md: encabezado, métricas, vara con PASA / NO PASA por corrida, costos y tabla de conversaciones', () => {
  const md = renderReport(output());
  assert.match(md, /^# Banco de pruebas: gpt-6-luna \(low\)\n/);
  assert.match(md, /- Corridas: 2 · escenarios: 2 · conversaciones: 4 · concurrencia 4/);
  assert.match(md, /- Política \(hash\): abc123/);
  assert.match(md, /- Vara: \*\*NO PASA\*\* \(fallan: Fallas críticas, Turnos con reintento\)/);
  assert.match(md, /\| 1 \| 2 \| 2 \| 0 \| 0\.0 % \| 0\.0 % \| 5\.00 \| 5\.00 \| 1\.0 s \| USD 0\.0100 \|/);
  assert.match(md, /\| 2 \| 2 \| 2 \| 2 \| 50\.0 % \| 0\.0 % \| 4\.00 \| 3\.00 \| 3\.5 s \| USD 0\.0085 \|/); // reintento: 1 de 2 turnos
  assert.match(md, /\| Todas \| 4 \|/);
  assert.match(md, /\| Regla \| Límite \| Corrida 1 \| Corrida 2 \|/);
  assert.match(md, /\| Fallas críticas \| 0 \| PASA \(0\) \| NO PASA \(2\) \|/);
  assert.match(md, /\| Turnos con reintento \| ≤ 8\.0 % \| PASA \(0\.0 %\) \| NO PASA \(50\.0 %\) \|/);
  assert.match(md, /\| Juez, peor conversación \| ≥ 3 \| PASA \(5\.00\) \| PASA \(3\.00\) \|/);
  assert.match(md, /\| \*\*Vara completa\*\* \| todas, en cada corrida \| \*\*PASA\*\* \| \*\*NO PASA\*\* \|/);
  assert.match(md, /\| Bot \| USD 0\.0370 \| USD 0\.009[23] \|/);
  assert.match(md, /\| Cliente simulado \| USD 0\.0010 \| USD 0\.0003 \|/);
  assert.match(md, /\| Juez \| USD 0\.0900 \| USD 0\.0225 \|/);
  assert.match(md, /\| b-escenario \| 2 \| persona \| bot_parado \| 1 \| 1 \| 2 \| 3\.00 \|/);
});

test('report.md: cada transcripción con violaciones, datos rechazados, fallas, notas del juez y ficha final', () => {
  const md = renderReport(output());
  assert.match(md, /### a-escenario · corrida 1 · OK\n/);
  assert.match(md, /### b-escenario · corrida 2 · FALLA \(2 críticas\)\n/);
  const dirtyBlock = md.slice(md.indexOf('### b-escenario · corrida 2'));
  assert.match(dirtyBlock, /persona · hora 23:00 · fin: bot_parado · 1 turno\(s\) · bot USD 0\.0070 · cliente USD 0\.0010 · juez USD 0\.0300/);
  assert.match(dirtyBlock, /\[turno 1\] cliente: Cuánto sale\?\n\[turno 1\] olimpo: Buenas noches, la Full Panorámica está en oferta\.\n\[turno 1\] \[sistema\] se manda el material fabricacion_panos\n\[turno 1\] \[sistema\] aviso al equipo: regateo/);
  assert.match(dirtyBlock, /Violaciones del controlador \(intentos descartados\):\n- turno 1, intento 1 \(2\.5 s, USD 0\.0030\), el modelo había propuesto: "Buen día \/ sale USD 1\.000"\n {2}- greeting: es el primer mensaje/);
  assert.doesNotMatch(dirtyBlock, /intento 2 \(/); // el intento aceptado no es una violación
  assert.match(dirtyBlock, /Datos que la ficha rechazó:\n- turno 1: nombre = Pedro \(m2\): el mensaje de evidencia no es del cliente/);
  assert.match(dirtyBlock, /Fallas críticas:\n- juez: invento_dato\n- espera derivacion: se esperaba pregunta_por_empresa_anterior y hubo regateo/);
  assert.match(dirtyBlock, /Juez: flujo_venta 3 · honestidad 3 · objeciones 3 · tono 3 · una_pregunta 3 · momento_derivar 3 · promedio 3\.00 · críticos: invento_dato\n> Inventó un precio en el turno 1\./);
  assert.match(dirtyBlock, /Ficha final: estado derivado · frio · nombre=Pedro · faltan: localidad/);
  assert.match(dirtyBlock, /Nota para el equipo: Regatea mucho/);
  // una conversación limpia no trae secciones de falla
  const cleanBlock = md.slice(md.indexOf('### a-escenario · corrida 1'), md.indexOf('### a-escenario · corrida 2'));
  assert.doesNotMatch(cleanBlock, /Violaciones|Fallas críticas|rechazó/);
  assert.match(cleanBlock, /Juez: .* promedio 5\.00 · críticos: ninguno\n> Impecable\./);
});

test('report.md: juez sin veredicto y transcripciones con ``` no rompen el formato', () => {
  const r = result({ judge: undefined, judgeError: 'el juez no devolvió JSON', turns: [turnLog({ customer: ['mirá ```esto```'] })] });
  const md = renderReport(buildEvalOutput(meta({ runs: 1 }), [r]));
  assert.match(md, /Juez sin veredicto: el juez no devolvió JSON/);
  assert.match(md, /mirá '''esto'''/);
  assert.match(md, /\| Juez, promedio \| ≥ 4\.0 \| NO PASA \(sin datos \(1 sin veredicto\)\) \|/);
  assert.doesNotMatch(md, /\| Todas \|/); // con una sola corrida no hay fila de totales
});

test('el reporte es determinista: no depende del orden de entrada', () => {
  const a = renderReport(buildEvalOutput(meta(), results));
  const b = renderReport(buildEvalOutput(meta(), [...results].reverse()));
  assert.equal(a, b);
});

test('summary.json: pasa, vara por corrida y una fila por conversación', () => {
  const s = buildSummary(output());
  assert.equal(s.pass, false);
  assert.equal(s.startedAt, '2026-10-07T16:37:00.000Z');
  assert.deepEqual(s.scenarios, ['a-escenario', 'b-escenario']);
  assert.deepEqual(s.perRun.map((r) => r.pass), [true, false]);
  assert.equal(s.perRun[1].rules.find((r) => r.id === 'criticas')!.value, '2');
  assert.equal(s.conversations.length, 4);
  assert.deepEqual(s.conversations[3], {
    scenarioId: 'b-escenario', run: 2, tipo: 'persona', endReason: 'bot_parado', turns: 1,
    criticalFailures: ['juez: invento_dato', 'espera derivacion: se esperaba pregunta_por_empresa_anterior y hubo regateo'],
    judgeAverage: 3, judgeError: null, cost: { bot: 0.007, customer: 0.001, judge: 0.03 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s); // serializable sin pérdidas
});

test('dirName y writeReport: carpeta <fecha>-<modelo>-<esfuerzo> con report.md y summary.json', () => {
  assert.equal(dirName(meta()), '2026-10-07-1337-gpt-6-luna-low');
  assert.equal(dirName(meta({ model: 'gpt-6.1-sol', effort: 'medium' })), '2026-10-07-1337-gpt-6.1-sol-medium');
  const base = mkdtempSync(join(tmpdir(), 'olimpo-report-'));
  try {
    const dir = writeReport(output(), base);
    assert.equal(dir, join(base, '2026-10-07-1337-gpt-6-luna-low'));
    assert.equal(readFileSync(join(dir, 'report.md'), 'utf8'), renderReport(output()));
    assert.equal(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).pass, false);
    assert.ok(existsSync(join(dir, 'summary.json')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('evals/out no se sube a git', () => {
  assert.match(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^evals\/out\/$/m);
});

test('resumen de consola: corridas, reglas que fallan, conversaciones con fallas, costos y ruta del reporte', () => {
  const text = consoleSummary(output(), join('evals', 'out', 'X'));
  assert.match(text, /^Banco de pruebas · gpt-6-luna low · 2 corrida\(s\) · 4 conversación\(es\) · 4 turno\(s\)/);
  assert.match(text, /corrida 1: críticas 0 · reintento 0\.0 % · seguros 0\.0 % · juez 5\.00 \(mín 5\.00\) · p95 1\.0 s · bot USD 0\.0100 por conversación · PASA/);
  assert.match(text, /corrida 2: críticas 2 .* · NO PASA\n {4}NO PASA Fallas críticas: 2 \(límite 0\)\n {4}NO PASA Turnos con reintento: 50\.0 %/);
  assert.match(text, /falla: b-escenario \(corrida 2\)\n {4}- juez: invento_dato\n {4}- espera derivacion/);
  assert.match(text, /vara: NO PASA\ncostos: bot USD .* · cliente simulado USD 0\.0010 · juez USD .* · total USD /);
  assert.match(text, new RegExp(`reporte: ${join('evals', 'out', 'X', 'report.md').replaceAll('\\', '\\\\')}$`));
});

// ---------- compare ----------
test('compare: elige la configuración más barata entre las que pasan la vara', () => {
  const passing = (model: string, effort: string, botCost: number) =>
    buildEvalOutput(meta({ model, effort, runs: 1 }), [result({ turns: [turnLog()], cost: { bot: botCost, customer: 0, judge: 0.02 } })]);
  const sol = passing('gpt-6.1-sol', 'low', 0.08);
  const solMedium = passing('gpt-6.1-sol', 'medium', 0.12);
  const luna = passing('gpt-6-luna', 'low', 0.01);
  assert.equal(cheapestPassing([sol, solMedium, luna])!.model, 'gpt-6-luna');
  const lunaMala = buildEvalOutput(meta({ model: 'gpt-6-luna', effort: 'low', runs: 1 }), [result({ expectFailures: ['x'], cost: { bot: 0.01, customer: 0, judge: 0 } })]);
  assert.equal(lunaMala.pass, false);
  const best = cheapestPassing([sol, solMedium, lunaMala])!;
  assert.deepEqual([best.model, best.effort], ['gpt-6.1-sol', 'low']);
  assert.equal(cheapestPassing([lunaMala]), undefined);
  assert.equal(cheapestPassing([]), undefined);
  const table = compareTable([sol, lunaMala]);
  assert.match(table, /^configuración +críticas +reintento/);
  assert.match(table, /gpt-6\.1-sol low +0 +0\.0 % +0\.0 % +5\.00 +5\.00 +1\.0 s +USD 0\.0800 +USD [\d.]+ +PASA/);
  assert.match(table, /gpt-6-luna low +1 .* NO PASA$/m);
});
