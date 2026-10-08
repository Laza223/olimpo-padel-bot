// Los ejemplos de tono aprobados por Lazar tienen que pasar el controlador: si no, el guion y el control se contradicen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supervise } from '../src/supervisor/index.ts';
import { loadPolicy } from '../src/policy.ts';

const policy = loadPolicy().supervisorPolicy;

const md = readFileSync(new URL('../policy/tone.md', import.meta.url), 'utf8');
const examples = [...md.matchAll(/^\s*\d+\.\s+"(.+?)"[^\n]*\n\s*→\s*(.+)$/gm)].map((m) => ({
  customer: m[1],
  bubbles: m[2].replace(/\[[^\]]*\]/g, '').split('||').map((b) => b.trim()).filter(Boolean),
}));

test('hay 20 ejemplos de tono', () => assert.equal(examples.length, 20));

for (const [i, ex] of examples.entries()) {
  test(`ejemplo ${i + 1} pasa el controlador`, () => {
    const askedIfAi = /bot/i.test(ex.customer);
    assert.deepEqual(supervise({ bubbles: ex.bubbles, askedIfAi }, [ex.customer], policy), []);
  });
}
