// CRM: "Hacer ahora" (qué hay que hacer y quién espera más), vencimiento de la promesa del presupuesto y la ficha en criollo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, createConversation, createDraft, insertMessage, insertOutbox, openDb, saveCard, setMode, setStage } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { chatDetail, chatList, dueLabel, historyText, promiseDueUtc, waitLabel } from '../src/crm/data.ts';
import { emptyCard } from '../src/lead.ts';
import { setSetting, setState } from '../src/settings.ts';
import { policy } from './f2-helpers.ts';

const H = 3_600_000;
const MIN = 60_000;
// Hora argentina (UTC-3) → UTC.
const ar = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h + 3, mi);
const NOW = ar(2026, 10, 9, 15); // viernes 9-oct-2026, 15:00 en Argentina
const CLOSING = policy.closingText;

let seq = 0;
function chat(db: Db, id: string, o: { mode?: 'auto' | 'humano' | 'pausado'; name?: string; at?: number } = {}) {
  createConversation(db, { chatId: id, session: 'default', mode: o.mode ?? 'auto', nowMs: o.at ?? NOW - 5 * H, profileName: o.name });
}
const say = (db: Db, chatId: string, author: 'customer' | 'bot' | 'team', text: string, ts: number, media?: string) =>
  insertMessage(db, { session: 'default', providerMsgId: `p${++seq}`, chatId, author, text, tsUtcMs: ts, media });
const answered = (db: Db, chatId: string, upto: number) => db.prepare('UPDATE conversations SET answered_upto = ? WHERE chat_id = ?').run(upto, chatId);
const names = (db: Db, filter: Parameters<typeof chatList>[3] = 'ahora') => chatList(db, NOW, CLOSING, filter).items.map((i) => `${i.name}:${i.need}`);

// ---------- tiempos ----------
test('espera en palabras', () => {
  assert.equal(waitLabel(NOW - 6 * MIN, NOW), '6 min');
  assert.equal(waitLabel(NOW - 3 * H - 12 * MIN, NOW), '3 h 12 min');
  assert.equal(waitLabel(NOW - 3 * H, NOW), '3 h');
  assert.equal(waitLabel(NOW - 52 * H, NOW), '2 d 4 h');
});

test('la promesa vence al terminar el día hábil siguiente (lunes a sábado; el domingo no cuenta)', () => {
  const end = (y: number, mo: number, d: number) => ar(y, mo, d, 24) - 1; // 23:59:59.999 hora argentina
  assert.equal(promiseDueUtc(ar(2026, 10, 7, 10)), end(2026, 10, 8)); // miércoles → jueves
  assert.equal(promiseDueUtc(ar(2026, 10, 9, 22)), end(2026, 10, 10)); // viernes a la noche → sábado
  assert.equal(promiseDueUtc(ar(2026, 10, 10, 9)), end(2026, 10, 12)); // sábado → lunes
  assert.equal(promiseDueUtc(ar(2026, 10, 11, 18)), end(2026, 10, 12)); // domingo → lunes
  assert.equal(promiseDueUtc(ar(2026, 10, 9, 1)), end(2026, 10, 10)); // viernes 01:00 en Argentina (en UTC ya son las 04:00 del mismo viernes)
});

test('vencimiento en palabras: hoy, mañana, el lunes, venció', () => {
  assert.deepEqual(dueLabel(ar(2026, 10, 9, 24) - 1, NOW), { text: 'vence hoy', late: false, today: true });
  assert.deepEqual(dueLabel(ar(2026, 10, 10, 24) - 1, NOW), { text: 'vence mañana', late: false, today: false });
  assert.equal(dueLabel(ar(2026, 10, 12, 24) - 1, NOW).text, 'vence el lunes');
  assert.deepEqual(dueLabel(NOW - 2 * H, NOW), { text: 'venció hace 2 h', late: true, today: false });
});

// ---------- "Hacer ahora" ----------
test('una fila por chat, el que más espera arriba; prioridad: borrador > te escribió > a presupuestar', () => {
  const db = openDb(':memory:');
  // Ana: derivada hace 30 h (a presupuestar)
  chat(db, 'ana@c.us', { mode: 'humano', name: 'Ana' });
  setStage(db, 'ana@c.us', 'a_presupuestar', NOW - 30 * H);
  // Beto: derivado hace 40 h, pero además escribió hace 1 h y nadie contestó → "te escribió", espera desde hace 1 h
  chat(db, 'beto@c.us', { mode: 'humano', name: 'Beto' });
  setStage(db, 'beto@c.us', 'a_presupuestar', NOW - 40 * H);
  say(db, 'beto@c.us', 'customer', 'y? cuándo me mandan?', NOW - 1 * H);
  // Caro: borrador pendiente (modo sombra); escribió hace 10 min
  chat(db, 'caro@c.us', { name: 'Caro' });
  const m = say(db, 'caro@c.us', 'customer', 'hola', NOW - 10 * MIN);
  createDraft(db, { chatId: 'caro@c.us', contextVersion: 0, bubbles: ['Buenas tardes'], material: [], nowMs: NOW - 9 * MIN, answersUpto: m.id });
  // Dani: con el bot, contestado: nada que hacer
  chat(db, 'dani@c.us', { name: 'Dani' });
  const d = say(db, 'dani@c.us', 'customer', 'hola', NOW - 2 * H);
  say(db, 'dani@c.us', 'bot', 'Buenas tardes', NOW - 2 * H + MIN);
  answered(db, 'dani@c.us', d.id);
  assert.deepEqual(names(db), ['Ana:a_presupuestar', 'Beto:te_escribio', 'Caro:borrador']);
  const counts = chatList(db, NOW, CLOSING, 'ahora').counts;
  assert.deepEqual([counts.ahora, counts.todos, counts.a_presupuestar, counts.con_el_bot], [3, 4, 2, 2]);
});

test('"te escribió" cuenta fotos y audios sin texto, y se apaga cuando el equipo contesta', () => {
  const db = openDb(':memory:');
  chat(db, 'foto@c.us', { mode: 'humano', name: 'Foto' });
  say(db, 'foto@c.us', 'customer', '', NOW - 2 * H, 'image');
  chat(db, 'audio@c.us', { mode: 'humano', name: 'Audio' });
  say(db, 'audio@c.us', 'customer', '', NOW - 1 * H, 'audio');
  assert.deepEqual(names(db), ['Foto:te_escribio', 'Audio:te_escribio']);
  say(db, 'foto@c.us', 'team', 'Gracias, lo vemos', NOW - 30 * MIN);
  assert.deepEqual(names(db), ['Audio:te_escribio']);
  assert.equal(chatList(db, NOW, CLOSING, 'todos').items.find((i) => i.name === 'Audio')!.preview, 'Audio sin escuchar');
});

test('con el bot: el cliente que espera no es tarea de Lazar, salvo bot apagado o más de 10 minutos sin borrador ni respuesta en camino', () => {
  const db = openDb(':memory:');
  chat(db, 'nuevo@c.us', { name: 'Nuevo' });
  say(db, 'nuevo@c.us', 'customer', 'hola', NOW - 3 * MIN);
  chat(db, 'trabado@c.us', { name: 'Trabado' });
  say(db, 'trabado@c.us', 'customer', 'hola?', NOW - 25 * MIN); // borrador descartado, o algo trabado
  chat(db, 'saliendo@c.us', { name: 'Saliendo' });
  say(db, 'saliendo@c.us', 'customer', 'hola', NOW - 25 * MIN);
  insertOutbox(db, { logicalKey: 'saliendo@c.us:1:0', chatId: 'saliendo@c.us', kind: 'text', body: 'Buenas', expiresUtc: NOW + H, contextVersion: 1, createdUtc: NOW, answersUpto: 0 });
  assert.deepEqual(names(db), ['Trabado:te_escribio']);
  setSetting(db, 'kill_switch', '1');
  assert.deepEqual(names(db), ['Trabado:te_escribio', 'Saliendo:te_escribio', 'Nuevo:te_escribio']);
});

test('los contactos de antes del bot van a "Otros chats" y no a "Hacer ahora"; si se los pone en una etapa, vuelven', () => {
  const db = openDb(':memory:');
  chat(db, 'tia@c.us', { mode: 'humano', name: 'Tía' });
  audit(db, NOW - 10 * H, 'tia@c.us', 'takeover', 'chat con historia anterior al arranque del bot: arranca en humano');
  say(db, 'tia@c.us', 'customer', 'venís el domingo?', NOW - H);
  chat(db, 'dudoso@c.us', { mode: 'humano', name: 'Dudoso' });
  audit(db, NOW - 10 * H, 'dudoso@c.us', 'takeover', 'no pude mirar la historia del chat (WAHA no contestó): arranca en humano por las dudas');
  say(db, 'dudoso@c.us', 'customer', 'hola, precio?', NOW - H);
  assert.deepEqual(names(db), ['Dudoso:te_escribio']); // el que no se pudo revisar sí entra
  assert.deepEqual(chatList(db, NOW, CLOSING, 'otros').items.map((i) => i.name), ['Tía']);
  assert.equal(chatList(db, NOW, CLOSING, 'todos').items.some((i) => i.name === 'Tía'), false);
  setStage(db, 'tia@c.us', 'seguimiento', NOW);
  assert.deepEqual(names(db), ['Tía:te_escribio', 'Dudoso:te_escribio']);
});

test('A presupuestar muestra el vencimiento solo si el bot le prometió el plazo', () => {
  const db = openDb(':memory:');
  chat(db, 'prometido@c.us', { mode: 'humano', name: 'Prometido' });
  say(db, 'prometido@c.us', 'bot', `Perfecto. ${CLOSING}`, NOW - 26 * H);
  setStage(db, 'prometido@c.us', 'a_presupuestar', NOW - 26 * H); // jueves 13:00 → vence el viernes (hoy)
  chat(db, 'pidio@c.us', { mode: 'humano', name: 'Pidió persona' });
  say(db, 'pidio@c.us', 'bot', 'Ya le aviso al equipo para que te contacte por acá.', NOW - 2 * H);
  setStage(db, 'pidio@c.us', 'a_presupuestar', NOW - 2 * H);
  const items = chatList(db, NOW, CLOSING, 'a_presupuestar').items;
  assert.deepEqual(items.find((i) => i.name === 'Prometido')!.due, { text: 'vence hoy', late: false, today: true });
  assert.equal(items.find((i) => i.name === 'Pidió persona')!.due, null);
});

test('buscador por nombre, lugar o número; "Todos" ordena por última actividad', () => {
  const db = openDb(':memory:');
  chat(db, 'a@c.us', { name: 'Martín', at: NOW - 5 * H });
  chat(db, 'b@c.us', { name: 'Club Sur', at: NOW - 1 * H });
  const card = emptyCard();
  card.fields.localidad = { value: 'Pilar', evidenceMsgId: 'm1' };
  saveCard(db, 'a@c.us', card);
  assert.deepEqual(chatList(db, NOW, CLOSING, 'todos').items.map((i) => i.name), ['Club Sur', 'Martín']);
  assert.deepEqual(chatList(db, NOW, CLOSING, 'todos', 'pilar').items.map((i) => i.name), ['Martín']);
  assert.deepEqual(chatList(db, NOW, CLOSING, 'todos', '#2').items.map((i) => i.name), ['Club Sur']);
  // Sin tildes ni mayúsculas, y en todos los chats aunque esté abierto "Hacer ahora" (Martín no tiene nada pendiente).
  assert.deepEqual(chatList(db, NOW, CLOSING, 'ahora', 'MARTIN').items.map((i) => i.name), ['Martín']);
  assert.deepEqual(chatList(db, NOW, CLOSING, 'ahora', 'pílar').items.map((i) => i.name), ['Martín']);
});

test('borrador descartado: el chat pasa a "Te escribió" enseguida (el bot no vuelve a proponer hasta que el cliente escriba)', () => {
  const db = openDb(':memory:');
  chat(db, 'desc@c.us', { name: 'Desc' });
  const m = say(db, 'desc@c.us', 'customer', 'hola', NOW - 2 * MIN);
  const id = createDraft(db, { chatId: 'desc@c.us', contextVersion: 0, bubbles: ['Hola'], material: [], nowMs: NOW - MIN, answersUpto: m.id });
  assert.deepEqual(names(db), ['Desc:borrador']);
  db.prepare("UPDATE drafts SET status = 'descartado' WHERE id = ?").run(id);
  assert.deepEqual(names(db), ['Desc:te_escribio']);
  // El cliente escribió después: el bot ya arma otra respuesta, no es tarea de Lazar (salvo que pasen 10 minutos).
  say(db, 'desc@c.us', 'customer', '¿y?', NOW - 30_000);
  assert.deepEqual(names(db), []);
});

test('borrador descartado con una respuesta del bot en camino (lo devolvieron al bot): no es "Te escribió"', () => {
  const db = openDb(':memory:');
  chat(db, 'vuelta@c.us', { name: 'Vuelta' });
  const m = say(db, 'vuelta@c.us', 'customer', 'hola', NOW - 2 * MIN);
  const id = createDraft(db, { chatId: 'vuelta@c.us', contextVersion: 0, bubbles: ['Hola'], material: [], nowMs: NOW - MIN, answersUpto: m.id });
  db.prepare("UPDATE drafts SET status = 'descartado' WHERE id = ?").run(id);
  insertOutbox(db, { logicalKey: 'vuelta@c.us:1:0', chatId: 'vuelta@c.us', kind: 'text', body: 'Buenas', expiresUtc: NOW + H, contextVersion: 1, createdUtc: NOW, answersUpto: m.id });
  assert.deepEqual(names(db), []);
});

// ---------- chat abierto ----------
test('ficha en criollo, motivo de la derivación, borrador pendiente y link de WhatsApp solo para números', () => {
  const db = openDb(':memory:');
  chat(db, '5491155550000@c.us', { mode: 'humano', name: 'Pedro' });
  const card = emptyCard();
  card.fields.modelo = { value: 'full_panoramica', evidenceMsgId: 'm1' };
  card.fields.platea = { value: 'quiere_que_la_hagamos', evidenceMsgId: 'm1' };
  card.fields.localidad = { value: 'Pilar', evidenceMsgId: 'm1' };
  card.fields.provincia = { value: 'Buenos Aires', evidenceMsgId: 'deducida de Pilar' };
  saveCard(db, '5491155550000@c.us', card);
  audit(db, NOW - H, '5491155550000@c.us', 'handoff', 'pide_persona (stop, prioridad normal)');
  audit(db, NOW - H, '5491155550000@c.us', 'handoff', 'factura_a (flag, prioridad normal)');
  const m = say(db, '5491155550000@c.us', 'customer', 'hola', NOW - H);
  createDraft(db, { chatId: '5491155550000@c.us', contextVersion: 0, bubbles: ['Uno', 'Dos'], material: [], nowMs: NOW - H, answersUpto: m.id });
  setState(db, 'quote_sent_utc.5491155550000@c.us', String(NOW - 2 * H));
  const d = chatDetail(db, 1, NOW, CLOSING)!;
  assert.equal(d.waLink, 'https://wa.me/5491155550000');
  assert.equal(d.handoffLabel, 'Pide hablar con una persona'); // la última que frenó, no el aviso de después
  assert.deepEqual(d.fields.map((f) => `${f.label}: ${f.value}${f.deduced ? ' (deducida)' : ''}`), ['Localidad: Pilar', 'Provincia: Buenos Aires (deducida)', 'Modelo: Full Panorámica', 'Platea: Quiere que la hagamos']);
  assert.deepEqual(d.draft?.bubbles, ['Uno', 'Dos']);
  assert.match(d.quoteSentLabel!, /^Presupuesto mandado hoy a las 13:00$/);
  assert.ok(d.history.some((h) => h.text === 'Pasó al equipo: Pide hablar con una persona'));
  chat(db, '123456789012345@lid', { mode: 'humano' });
  assert.equal(chatDetail(db, 2, NOW, CLOSING)!.waLink, null);
  setMode(db, '123456789012345@lid', 'auto');
  assert.equal(chatDetail(db, 99, NOW, CLOSING), undefined);
});

test('historial en criollo: las acciones con quién las hizo; los errores internos traducidos u ocultos; nunca el texto crudo', () => {
  assert.equal(historyText('handoff', 'pide_persona (stop, prioridad normal)'), 'Pasó al equipo: Pide hablar con una persona');
  assert.equal(historyText('takeover', 'CRM [Lo tomo] (CRM)'), 'Pasó al equipo (desde el CRM)');
  assert.equal(historyText('takeover', 'botón [Lo tomo] (Tomás)'), 'Pasó al equipo (Tomás)');
  assert.equal(historyText('takeover', 'escribió el equipo desde el celular o la Web'), 'El equipo escribió desde WhatsApp: el chat pasó al equipo');
  assert.equal(historyText('command', 'presupuesto_mandado (CRM)'), 'Presupuesto mandado (desde el CRM)');
  assert.equal(historyText('command', 'etapa: a_presupuestar → perdido (Precio) (CRM)'), 'Etapa: A presupuestar → Perdido (Precio) (desde el CRM)');
  assert.equal(historyText('command', 'etapa: sin etapa → seguimiento (Lazar)'), 'Etapa: sin etapa → Seguimiento (Lazar)');
  assert.equal(historyText('command', 'botón [Devolver al bot] (Tomás): vuelve al bot'), 'Volvió al bot (Tomás)');
  assert.equal(historyText('command', 'borrador 12 descartado (CRM)'), 'Borrador descartado (desde el CRM)');
  assert.equal(historyText('alert', 'chat pausado: tope de gasto del día'), 'Pausado: tope de gasto del día');
  assert.equal(historyText('error', 'turno: 429 You exceeded your current quota, please check your plan and billing details.'), 'El bot tuvo un error y no contestó');
  assert.equal(historyText('error', 'salida 5491155550001@c.us:3:0 fallida: wa_error 500'), 'No salió un mensaje del bot');
  assert.equal(historyText('error', 'salida 5491155550001@c.us:3:0 fallida: no_confirmado'), 'Un mensaje del bot quedó sin confirmar: revisalo en el celular antes de reenviar');
  assert.equal(historyText('alert', 'Chat #3 (Pedro): el cliente mandó una foto y el bot no lo lee (solo lee audios y texto). Mirá el chat.'), 'Mandó una foto: el bot no lo lee, miralo vos');
  assert.equal(historyText('alert', 'Chat #3: WhatsApp informó que un mensaje del bot no se pudo entregar. Revisalo en el celular.'), 'WhatsApp no pudo entregar un mensaje del bot: revisalo en el celular');
  assert.equal(historyText('alert', 'OpenAI sin saldo: el bot no contesta hasta que se cargue (es la cuenta de OPENAI_API_KEY)'), null);
  assert.equal(historyText('command', 'etapa: presupuestado → perdido (dos\nlíneas) (CRM)'), 'Etapa: Presupuestados → Perdido (dos\nlíneas) (desde el CRM)');
  assert.equal(historyText('error', 'consulta_vencida: el último mensaje sin contestar es de hace más de 12 h'), 'El bot no contestó: el mensaje era muy viejo');
  assert.equal(historyText('error', 'no pude mandar el aviso: Telegram no contestó en 5 s'), null);
  assert.equal(historyText('command', 'algo nuevo que todavía no tiene texto'), null);
});

test('el motivo de la derivación aparece aunque después haya muchas acciones en el chat', () => {
  const db = openDb(':memory:');
  chat(db, '5491155550000@c.us', { mode: 'humano', name: 'Pedro' });
  audit(db, NOW - 5 * H, '5491155550000@c.us', 'handoff', 'listo_para_presupuesto (stop, prioridad alta)');
  for (let i = 0; i < 60; i++) audit(db, NOW - H, '5491155550000@c.us', 'command', `borrador ${i} descartado (CRM)`);
  const d = chatDetail(db, 1, NOW, CLOSING)!;
  assert.equal(d.handoffLabel, 'Listo para presupuesto');
  assert.equal(d.history.length, 40);
});

test('"Hacer ahora" con chats largos sigue siendo rápido (el último mensaje del equipo se calcula una vez, no por mensaje)', () => {
  const db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO messages (session, provider_msg_id, chat_id, author, text, ts_utc) VALUES ('default', ?, ?, 'customer', 'hola', ?)");
  for (let c = 0; c < 200; c++) {
    const id = `54911555${String(c).padStart(5, '0')}@c.us`;
    chat(db, id, { mode: 'humano' });
    for (let m = 0; m < 200; m++) ins.run(`big-${c}-${m}`, id, NOW - H + m);
  }
  const t = performance.now();
  const list = chatList(db, NOW, CLOSING, 'ahora');
  const ms = performance.now() - t;
  assert.equal(list.items.length, 200);
  assert.ok(ms < 500, `tardó ${Math.round(ms)} ms`); // con la subconsulta por mensaje eran más de 1 s
});

test('si vuelve a escribir: Perdido aparece en "Hacer ahora" (es una oportunidad), Descartado no (Lazar, 10-oct)', () => {
  const db = openDb(':memory:');
  chat(db, 'perdido@c.us', { mode: 'humano', name: 'Perdido' });
  setStage(db, 'perdido@c.us', 'perdido', NOW - 5 * H, 'Precio');
  say(db, 'perdido@c.us', 'customer', 'al final lo quiero', NOW - H);
  chat(db, 'desc@c.us', { mode: 'humano', name: 'Descartado' });
  setStage(db, 'desc@c.us', 'descartado', NOW - 5 * H);
  say(db, 'desc@c.us', 'customer', 'oferta de cemento', NOW - 2 * H);
  assert.deepEqual(names(db), ['Perdido:te_escribio']);
  assert.deepEqual(names(db, 'descartado'), ['Descartado:null']); // se sigue viendo en su etapa
});
