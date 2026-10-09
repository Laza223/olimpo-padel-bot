// Split fijo train/test del banco para adaptar el prompt a Claude (hillclimb Haiku 5.5, 9-oct-2026).
// Estratificado por tags[0] (persona / tono / trampa) y sorteado con semilla fija, nunca por resultado. Se corrió una vez; el resultado queda en _state.json y no se cambia.
// Uso: node evals/hillclimb-haiku/split.ts
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';

const SEED = 20261009;
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const dir = new URL('../scenarios/', import.meta.url);
const ids = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => basename(f, '.yaml')).sort();
const strata: Record<string, string[]> = {};
for (const id of ids) (strata[id.split('-')[0]] ??= []).push(id);
const train: string[] = [];
const test: string[] = [];
for (const [, list] of Object.entries(strata).sort()) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const k = Math.ceil(a.length / 2);
  train.push(...a.slice(0, k));
  test.push(...a.slice(k));
}
console.log(JSON.stringify({ seed: SEED, train: train.sort(), test: test.sort() }, null, 1));
