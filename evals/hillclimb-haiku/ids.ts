// Imprime los ids de train o test separados por coma, para --only. Uso: node evals/hillclimb-haiku/ids.ts train|test
import { readFileSync } from 'node:fs';
const split = JSON.parse(readFileSync(new URL('./split.json', import.meta.url), 'utf8')) as { train: string[]; test: string[] };
const which = process.argv[2];
if (which !== 'train' && which !== 'test') throw new Error('uso: ids.ts train|test');
console.log(split[which].join(','));
