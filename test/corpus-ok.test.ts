// Contra el sobrebloqueo: todo lo que el bot ya mandó bien en el banco de pruebas (juez: "críticos: ninguno") tiene que seguir pasando el controlador.
// Un falso positivo cuesta un reintento, y dos seguidos mandan el mensaje seguro y frenan al bot: se pierde el cliente.
// El corpus sale de scripts/build-good-corpus.ts (test/fixtures/good-bubbles.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supervise } from '../src/supervisor/index.ts';
import { loadPolicy } from '../src/policy.ts';

interface Entry {
  bubbles: string[];
  customer: string[]; // lo que escribió el cliente en el turno
  history: string[]; // todo lo que escribió hasta ahí: es lo que el controlador ve en vivo como "lo que el cliente dijo"
  from: string;
}

const policy = loadPolicy().supervisorPolicy;
const corpus: Entry[] = JSON.parse(readFileSync(new URL('./fixtures/good-bubbles.json', import.meta.url), 'utf8'));

test('el corpus de globos buenos no está vacío', () => assert.ok(corpus.length >= 100, `solo ${corpus.length} turnos`));

test('ningún globo bueno del banco de pruebas es bloqueado por el controlador', () => {
  const failures = corpus.flatMap((e) => {
    const v = supervise({ bubbles: e.bubbles, askedIfAi: false, newCustomerTexts: e.customer }, e.history, policy);
    return v.length ? [`${e.from} | ${v.map((x) => `${x.rule}: ${x.detail}`).join(' ; ')} | ${e.bubbles.join(' || ')}`] : [];
  });
  assert.deepEqual(failures, [], `${failures.length} de ${corpus.length} turnos bloqueados`);
});
