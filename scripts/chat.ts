// Chat local: escribís como cliente y ves lo que mandaría el bot, el material, la ficha y las derivaciones.
// Uso: pnpm chat   (la clave sale de .env; el modelo de BOT_MODEL / BOT_EFFORT)
import { createInterface } from 'node:readline';
import { configFromEnv, costUsd, loadEnv, OpenAiLlm } from '../src/brain.ts';
import { buildFicha } from '../src/ficha.ts';
import { emptyCard, missingRequired } from '../src/lead.ts';
import { loadPolicy } from '../src/policy.ts';
import { argentinaClock, argentinaTimeToUtcMs, greetingFor } from '../src/time.ts';
import { runTurn } from '../src/turn.ts';
import type { Author, ChatMessage } from '../src/types.ts';

loadEnv();
const policy = loadPolicy();
let llm: OpenAiLlm;
try {
  llm = new OpenAiLlm();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

let config = configFromEnv();
let history: ChatMessage[] = [];
let card = emptyCard();
let stopped = false; // el bot ya no responde: lo toma el equipo
let nextId = 1;
let clockMs: number | null = null; // /hora fija la hora argentina
let burst: string[] = []; // líneas ">" acumuladas hasta la línea vacía

const STOPPED = '[el bot ya no responde este chat: lo toma el equipo]';
const now = () => clockMs ?? Date.now();
const say = (s = '') => console.log(s);

function add(author: Author, text: string): ChatMessage {
  const m: ChatMessage = { id: `m${nextId++}`, author, text, tsUtcMs: now() };
  history.push(m);
  return m;
}

async function send(texts: string[]) {
  const ids = texts.map((t) => add('customer', t).id);
  if (stopped) return say(STOPPED);
  const r = await runTurn(
    { conversationId: 'chat', history, newCustomerMessageIds: ids, card, nowUtcMs: now() },
    { llm, policy, config, onRejected: (rej) => rej.forEach((x) => say(`[dato rechazado] ${x.field} = ${x.value} (${x.evidenceMsgId}): ${x.reason}`)) },
  );
  card = r.card;
  for (const b of r.bubbles) {
    add('bot', b);
    say(`olimpo> ${b}`);
  }
  if (!r.bubbles.length) say('(el bot no manda nada)');
  for (const id of r.material) {
    const a = policy.assets.find((x) => x.id === id);
    say(`[material] ${id} (${a?.tipo}, ${a?.archivos.length} archivos)`);
  }
  const data = Object.entries(card.fields).map(([k, v]) => `${k}=${v.value}`).join(', ') || 'sin datos';
  say(`[ficha] ${card.state} · ${card.temperature} · ${data}`);
  for (const h of r.handoffs) {
    say(`[derivación] ${h.reason} · ${h.priority} · ${h.mode}`);
    say(buildFicha(card, history, h).replace(/^/gm, '    '));
  }
  r.attempts.forEach((a, i) => {
    const bad = a.violations.length ? `${a.violations.length} violación(es)` : 'sin violaciones';
    say(`[intento ${i + 1}] ${a.model} ${a.effort} · ${(a.latencyMs / 1000).toFixed(1)} s · USD ${a.costUsd.toFixed(5)} · ${a.inputTokens} entrada (${a.cachedTokens} en caché), ${a.outputTokens} salida · ${bad}`);
    a.violations.forEach((v) => say(`    - ${v.rule}: ${v.detail}`));
    if (a.violations.length && a.raw) say(`    el modelo había propuesto: ${a.raw.bubbles.map((b) => `"${b}"`).join(' | ') || '(sin globos)'}`);
  });
  if (r.usedFallback) say('[mensaje seguro: el bot falló dos veces]');
  if (r.stopBot) {
    stopped = true;
    say(STOPPED);
  }
}

function showCard() {
  say(`estado ${card.state} · ${card.temperature}`);
  for (const [k, v] of Object.entries(card.fields)) say(`  ${k} = ${v.value}  (${v.evidenceMsgId})`);
  say(`faltan: ${missingRequired(card).join(', ') || 'nada'}`);
  say(`objeciones: ${card.objections.join(', ') || 'ninguna'}`);
  say(`nota para el equipo: ${card.teamNote || '-'}`);
  say(`regateos ${card.flags.negotiatingCount} · fuera de política ${card.flags.offKnowledgeCount} · avisados: ${(card.notified ?? []).join(', ') || 'ninguno'}`);
}

async function command(line: string) {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/equipo':
      if (!arg) return say('uso: /equipo texto');
      add('team', arg);
      stopped = true;
      return say(STOPPED);
    case '/hora':
      clockMs = argentinaTimeToUtcMs(arg);
      return say(`hora fijada: ${argentinaClock(clockMs)} (${greetingFor(clockMs)})`);
    case '/ficha':
      return showCard();
    case '/reset':
      history = [];
      card = emptyCard();
      stopped = false;
      nextId = 1;
      burst = [];
      return say('conversación reiniciada');
    case '/modelo': {
      const [model, effort] = rest;
      if (!model || !effort) return say('uso: /modelo gpt-6-luna low');
      costUsd(model, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }); // avisa si no tiene precio
      config = { model, effort };
      return say(`modelo: ${model} ${effort}`);
    }
    default:
      return say('comandos: /equipo texto · /hora 22:30 · /ficha · /reset · /modelo gpt-6-luna low · ">" arma una ráfaga y la línea vacía la manda');
  }
}

async function flushBurst() {
  if (!burst.length) return;
  const texts = burst;
  burst = [];
  await send(texts);
}

async function handle(raw: string) {
  const line = raw.trim();
  try {
    if (line.startsWith('/')) await command(line);
    else if (line.startsWith('>')) burst.push(line.slice(1).trim());
    else if (!line) await flushBurst();
    else await send([line]);
  } catch (e) {
    say(`[error] ${(e as Error).message}`);
  }
}

say(`Chat con el bot de Olimpo. Modelo ${config.model} ${config.effort}. Escribí como cliente. ${argentinaClock(now())} hora argentina.`);
const tty = process.stdin.isTTY;
const prompt = () => tty && process.stdout.write(burst.length ? '...> ' : 'vos> ');
prompt();
for await (const raw of createInterface({ input: process.stdin })) {
  await handle(raw);
  prompt();
}
await flushBurst().catch((e) => say(`[error] ${(e as Error).message}`));
