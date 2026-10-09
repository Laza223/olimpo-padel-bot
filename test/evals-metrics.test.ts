// Métricas y vara con números inventados (a mano): sin red ni modelos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, criticalFailures, judgeAverage, percentile } from '../evals/metrics.ts';
import type { RunMetrics } from '../evals/metrics.ts';
import { evaluateGate, evaluateGateRuns, LIMITS } from '../evals/gate.ts';
import { result, turnLog, verdict } from './evals-helpers.ts';

const attempt = (latencyMs: number, costUsd = 0.01, violations: { rule: string; detail: string }[] = []) => ({ latencyMs, costUsd, violations });
const bad = [{ rule: 'price', detail: 'monto no aprobado' }];

test('judgeAverage: promedio de los 6 criterios', () => {
  assert.equal(judgeAverage(verdict(4)), 4);
  assert.equal(judgeAverage(verdict(5, { scores: { tono: 1, una_pregunta: 3 } })), (5 + 5 + 5 + 1 + 3 + 5) / 6);
});

test('percentile por rango más cercano', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile([10, 20], 50), 10);
});

test('criticalFailures: error, controlador, críticos del juez y expectativas; nada más', () => {
  assert.deepEqual(criticalFailures(result()), []);
  const c = result({
    turns: [turnLog({ turn: 2, controllerViolations: [{ rule: 'price', detail: 'monto no aprobado: "USD 1"' }] })],
    judge: verdict(5, { critico: { mintio: true, presiono: true } }),
    expectFailures: ['derivacion: se esperaba regateo y no hubo ninguna'],
    error: 'boom',
  });
  assert.deepEqual(criticalFailures(c), [
    'error: boom',
    'oráculo (turno 2) price: monto no aprobado: "USD 1"',
    'juez: mintio',
    'juez: presiono',
    'espera derivacion: se esperaba regateo y no hubo ninguna',
  ]);
  // un juez que falló (sin veredicto) no es una falla crítica: lo marca la vara
  assert.deepEqual(criticalFailures(result({ judge: undefined, judgeError: 'timeout' })), []);
});

// Cuatro conversaciones con números que se cuentan a mano.
const conversations = () => [
  // c1: 2 turnos, uno con reintento; juez 5; bot USD 0,06
  result({
    scenarioId: 'c1',
    turns: [turnLog({ turn: 1, attempts: [attempt(1000)] }), turnLog({ turn: 2, attempts: [attempt(2000), attempt(3000)] })],
    judge: verdict(5),
    cost: { bot: 0.06, customer: 0.01, judge: 0.02 },
  }),
  // c2: 3 turnos; el 1.º reintenta y termina en mensaje seguro; juez 3 con un crítico (1 falla)
  result({
    scenarioId: 'c2',
    turns: [
      turnLog({ turn: 1, attempts: [attempt(4000, 0.01, bad), attempt(5000, 0.01, bad)], usedFallback: true }),
      turnLog({ turn: 2, attempts: [attempt(6000)] }),
      turnLog({ turn: 3, attempts: [attempt(7000)] }),
    ],
    judge: verdict(3, { critico: { mintio: true } }),
    cost: { bot: 0.04, customer: 0.005, judge: 0.03 },
  }),
  // c3: 1 turno; un globo que el controlador rechaza (1) y 2 expectativas incumplidas; juez 4
  result({
    scenarioId: 'c3',
    turns: [turnLog({ attempts: [attempt(8000)], controllerViolations: bad })],
    judge: verdict(4),
    expectFailures: ['derivacion: x', 'nunca_dice: y'],
    cost: { bot: 0.02, customer: 0, judge: 0.01 },
  }),
  // c4: la simulación se cortó con un error: sin turnos ni juez
  result({ scenarioId: 'c4', turns: [], judge: undefined, error: 'boom', cost: { bot: 0, customer: 0.001, judge: 0 } }),
];

test('computeMetrics con números a mano', () => {
  const m = computeMetrics(conversations());
  assert.equal(m.conversations, 4);
  assert.equal(m.turns, 6);
  assert.equal(m.attempts, 8);
  assert.equal(m.retriedTurns, 2);
  assert.equal(m.fallbackTurns, 1);
  assert.equal(m.retryRate, 2 / 6);
  assert.equal(m.fallbackRate, 1 / 6);
  assert.equal(m.criticalFailures, 5); // c2: 1 · c3: 1 + 2 · c4: 1
  assert.equal(m.failedConversations, 3);
  assert.equal(m.judged, 3);
  assert.equal(m.judgeAvg, (5 + 3 + 4) / 3);
  assert.equal(m.judgeMin, 3);
  assert.equal(m.p95LatencyMs, 8000); // 8 intentos: el 8.º de 1000..8000
  assert.ok(Math.abs(m.cost.bot - 0.12) < 1e-12);
  assert.ok(Math.abs(m.cost.customer - 0.016) < 1e-12);
  assert.ok(Math.abs(m.cost.judge - 0.06) < 1e-12);
  assert.ok(Math.abs(m.cost.total - 0.196) < 1e-12);
  assert.ok(Math.abs(m.perConversation.bot - 0.03) < 1e-12);
  assert.ok(Math.abs(m.perConversation.customer - 0.004) < 1e-12);
  assert.ok(Math.abs(m.perConversation.judge - 0.015) < 1e-12);
});

test('computeMetrics: tokens del bot, lectura de caché y pensamiento (el pensamiento solo cuenta donde se informó)', () => {
  const tok = (inputTokens: number, cachedTokens: number, outputTokens: number, thinkingTokens: number | null, cacheWriteTokens = 0, cacheWrite1hTokens = 0) =>
    ({ ...attempt(1000), inputTokens, cachedTokens, outputTokens, thinkingTokens, cacheWriteTokens, cacheWrite1hTokens });
  const m = computeMetrics([result({
    turns: [
      turnLog({ attempts: [tok(3000, 2000, 200, 100, 500, 500), tok(1000, 0, 100, null)] }),
      turnLog({ attempts: [tok(2000, 1000, 300, 300), attempt(1000)] }), // el último no trae tokens: cuenta como 0
    ],
  })]);
  assert.deepEqual(m.tokens, { input: 6000, cached: 3000, cacheWrite: 500, cacheWrite1h: 500, output: 600 });
  assert.equal(m.cacheReadRate, 0.5); // 3000 / 6000
  assert.equal(m.thinkingAvg, 200); // (100 + 300) / 2: el null no entra
  assert.equal(m.thinkingP95, 300);
  const none = computeMetrics([result({ turns: [turnLog({ attempts: [attempt(1000)] })] })]);
  assert.deepEqual([none.cacheReadRate, none.thinkingAvg, none.thinkingP95], [null, null, null]);
});

test('computeMetrics sin conversaciones no divide por cero', () => {
  const m = computeMetrics([]);
  assert.deepEqual([m.conversations, m.turns, m.retryRate, m.fallbackRate, m.judgeAvg, m.judgeMin, m.p95LatencyMs, m.perConversation.bot], [0, 0, 0, 0, null, null, null, 0]);
});

// ---------- La vara ----------
const base: RunMetrics = {
  conversations: 50, turns: 200, attempts: 210, retriedTurns: 10, fallbackTurns: 0, criticalFailures: 0, failedConversations: 0,
  retryRate: 0.05, fallbackRate: 0, judged: 50, judgeAvg: 4.5, judgeMin: 3.5, p95LatencyMs: 9000,
  cost: { bot: 5, customer: 1, judge: 2, total: 8 }, perConversation: { bot: 0.1, customer: 0.02, judge: 0.04 },
  tokens: { input: 630_000, cached: 420_000, cacheWrite: 21_000, cacheWrite1h: 21_000, output: 42_000 }, cacheReadRate: 2 / 3, thinkingAvg: 120, thinkingP95: 400,
};
const gate = (o: Partial<RunMetrics>) => evaluateGate({ ...base, ...o });
const failing = (o: Partial<RunMetrics>) => gate(o).rules.filter((r) => !r.pass).map((r) => r.id);

test('la vara: los límites del contrato', () => {
  assert.deepEqual(LIMITS, { criticalFailures: 0, retryRate: 0.08, fallbackRate: 0.01, judgeAvg: 4.0, judgeMin: 3, p95LatencyMs: 15_000, botCostPerConversationUsd: 0.25 });
  assert.equal(gate({}).pass, true);
  assert.deepEqual(gate({}).rules.map((r) => r.id), ['criticas', 'reintento', 'seguros', 'juez_promedio', 'juez_minimo', 'p95', 'costo_bot']);
});

test('la vara: cada regla en su borde', () => {
  assert.deepEqual(failing({ criticalFailures: 1 }), ['criticas']);
  assert.deepEqual(failing({ retryRate: 0.08 }), []);
  assert.deepEqual(failing({ retryRate: 0.081 }), ['reintento']);
  assert.deepEqual(failing({ fallbackRate: 0.01 }), []);
  assert.deepEqual(failing({ fallbackRate: 0.011 }), ['seguros']);
  assert.deepEqual(failing({ judgeAvg: 4.0 }), []);
  assert.deepEqual(failing({ judgeAvg: 3.99 }), ['juez_promedio']);
  assert.deepEqual(failing({ judgeMin: 3 }), []);
  assert.deepEqual(failing({ judgeMin: 2.99 }), ['juez_minimo']);
  assert.deepEqual(failing({ p95LatencyMs: 15_000 }), []);
  assert.deepEqual(failing({ p95LatencyMs: 15_001 }), ['p95']);
  assert.deepEqual(failing({ perConversation: { bot: 0.25, customer: 0, judge: 0 } }), []);
  assert.deepEqual(failing({ perConversation: { bot: 0.2501, customer: 0, judge: 0 } }), ['costo_bot']);
});

test('la vara: el costo del cliente simulado y del juez no cuenta para el costo del bot', () => {
  assert.deepEqual(failing({ perConversation: { bot: 0.1, customer: 5, judge: 5 } }), []);
});

test('la vara: sin datos no se aprueba (juez incompleto, sin intentos, sin conversaciones)', () => {
  const incompleto = gate({ judged: 49 });
  assert.deepEqual(incompleto.rules.filter((r) => !r.pass).map((r) => r.id), ['juez_promedio', 'juez_minimo']);
  assert.match(incompleto.rules[3].value, /1 sin veredicto/);
  assert.deepEqual(failing({ judged: 0, judgeAvg: null, judgeMin: null }), ['juez_promedio', 'juez_minimo']);
  assert.deepEqual(failing({ p95LatencyMs: null }), ['p95']);
  assert.equal(gate({ ...computeMetrics([]) }).pass, false);
});

test('la vara: 2 reintentos en 25 turnos son exactamente 8 % y pasan; 3 no', () => {
  const turns = (retried: number) => Array.from({ length: 25 }, (_, i) => turnLog({ turn: i + 1, attempts: i < retried ? [attempt(1000), attempt(1000)] : [attempt(1000)] }));
  assert.equal(evaluateGate(computeMetrics([result({ turns: turns(2) })])).pass, true);
  const tres = evaluateGate(computeMetrics([result({ turns: turns(3) })]));
  assert.deepEqual(tres.rules.filter((r) => !r.pass).map((r) => r.id), ['reintento']);
});

test('la vara completa exige pasar en cada una de las N corridas', () => {
  const pass = evaluateGateRuns([base, base, base]);
  assert.equal(pass.pass, true);
  assert.equal(pass.perRun.length, 3);
  const one = evaluateGateRuns([base, { ...base, criticalFailures: 1 }, base]);
  assert.equal(one.pass, false);
  assert.deepEqual(one.perRun.map((g) => g.pass), [true, false, true]);
  assert.equal(evaluateGateRuns([]).pass, false);
});
