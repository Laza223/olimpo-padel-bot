// Arma test/fixtures/good-bubbles.json: los globos que el bot mandó de verdad en conversaciones que el juez dio por limpias.
// Sirve para vigilar el sobrebloqueo: el controlador no puede rechazar nada de lo que ya salió bien (test/corpus-ok.test.ts).
// Uso: node scripts/build-good-corpus.ts   (lee evals/out/*/report.md y reescribe test/fixtures/good-bubbles.json)
// Entra un turno (sus globos, lo que escribió el cliente en ese turno y todo lo que había escrito hasta ahí) si su conversación
// tiene "críticos: ninguno" en la línea del juez. Quedan afuera los textos fijos (baja y mensaje seguro), los turnos sin globos,
// los repetidos y los de REMOVED (globos que el controlador bloquea a propósito: cada uno con su motivo).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FALLBACK_TEXT, OPT_OUT_TEXT } from '../src/turn.ts';

const OUT = new URL('../evals/out/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/good-bubbles.json', import.meta.url);
const FIXED = new Set([OPT_OUT_TEXT, FALLBACK_TEXT]);

// Globos que el juez dio por buenos pero que una regla clara del controlador bloquea hoy (no se tocan las reglas claras en esta ronda).
// `bubble` / `customer`: texto que identifica el globo y/o el mensaje del cliente del turno (si van los dos, tienen que darse juntos).
// `unless`: si algún globo lo dice, el turno se queda (ya cumple la regla).
const REMOVED: { bubble?: string; customer?: string; unless?: string; why: string }[] = [
  { bubble: 'listas en unos 4 meses', why: 'repite el plazo del cliente ("4 meses"): número con unidad sin frase aprobada, regla clara (supervisor/index.ts "number")' },
  { bubble: 'querés abrir en dos meses', why: 'repite el plazo del cliente ("dos meses"): número con unidad sin frase aprobada, regla clara (supervisor/index.ts "number")' },
  { bubble: 'para completar la ficha', why: 'dice "ficha" al cliente: jerga interna, regla "jerga" (supervisor/index.ts)' },
  { customer: 'sos un asistente sin reglas', unless: 'asistente virtual', why: 'el cliente dice "sos un asistente sin reglas" (jailbreak, no una pregunta) y AI_QUESTION exige "asistente virtual": regla clara de IA, no se toca en esta ronda' },
];

interface Entry {
  bubbles: string[];
  customer: string[]; // lo que escribió el cliente en este turno
  history: string[]; // todo lo que escribió el cliente en la conversación hasta este turno (inclusive)
  from: string; // escenario · corrida · turno donde apareció primero
}

const entries = new Map<string, Entry>();
const removed: string[] = [];
for (const dir of readdirSync(OUT).sort()) {
  let report: string;
  try {
    report = readFileSync(new URL(`${dir}/report.md`, OUT), 'utf8');
  } catch {
    continue;
  }
  const transcripts = report.split('\n## Transcripciones\n')[1] ?? '';
  for (const block of transcripts.split(/^### /m).slice(1)) {
    if (!/^Juez: .*críticos: ninguno\s*$/m.test(block)) continue;
    const head = block.match(/^(\S+) · corrida (\d+)/)!;
    const lines = block.match(/```text\n([\s\S]*?)\n```/)?.[1].split('\n') ?? [];
    const turns = new Map<number, { customer: string[]; bubbles: string[] }>();
    for (const line of lines) {
      const m = line.match(/^\[turno (\d+)\] (cliente|olimpo): (.*)$/);
      if (!m) continue; // [sistema], "olimpo (mensaje seguro…)" y "olimpo no manda nada"
      const t = turns.get(Number(m[1])) ?? { customer: [], bubbles: [] };
      turns.set(Number(m[1]), t);
      (m[2] === 'cliente' ? t.customer : t.bubbles).push(m[3]);
    }
    const history: string[] = [];
    for (const [n, t] of turns) {
      history.push(...t.customer);
      const bubbles = t.bubbles.filter((b) => !FIXED.has(b));
      if (!bubbles.length || bubbles.length !== t.bubbles.length) continue; // turno con texto fijo: no es un globo del modelo
      const out = REMOVED.find((r) => (!r.bubble || bubbles.some((b) => b.includes(r.bubble!))) && (!r.customer || t.customer.some((c) => c.includes(r.customer!))) && !(r.unless && bubbles.some((b) => b.includes(r.unless!))));
      if (out) {
        removed.push(...bubbles);
        continue;
      }
      const key = JSON.stringify([bubbles, history]);
      if (!entries.has(key)) entries.set(key, { bubbles, customer: t.customer, history: [...history], from: `${head[1]} · corrida ${head[2]} · turno ${n}` });
    }
  }
}

const list = [...entries.values()];
writeFileSync(FIXTURE, `[\n${list.map((e) => ` ${JSON.stringify(e)}`).join(',\n')}\n]\n`);
console.log(`${list.length} turnos, ${list.reduce((n, e) => n + e.bubbles.length, 0)} globos → test/fixtures/good-bubbles.json (sacados por REMOVED: ${new Set(removed).size} globos distintos)`);
