// Pantallas del CRM (src/crm/views.ts): lo que escribe un cliente sale escapado, la CSP no se rompe (nada inline), los botones traen los campos que espera server.ts y todo está en criollo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botStatus, chatDetail, chatList } from '../src/crm/data.ts';
import type { AppView, ListFilter } from '../src/crm/data.ts';
import { appPage, chatFragment, listFragment, loginPage, offPage, statusFragment } from '../src/crm/views.ts';
import { audit, createConversation, createDraft, editMessage, insertMessage, openDb, revokeMessage, saveCard, setStage } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';
import { setSetting } from '../src/settings.ts';
import type { Author, LeadField } from '../src/types.ts';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 10, 15, 0); // sábado 10-oct, 12:00 en Argentina
const CLOSING = 'Te mandamos el presupuesto por acá en el día, o a más tardar el día hábil siguiente.';

function view(db: Db, o: { filter?: ListFilter; chat?: number; query?: string; flash?: AppView['flash']; session?: string } = {}): AppView {
  const filter = o.filter ?? 'ahora';
  const query = o.query ?? '';
  return {
    status: botStatus(db, NOW, o.session ?? 'WORKING'), filter, query, list: chatList(db, NOW, CLOSING, filter, query),
    chat: o.chat ? chatDetail(db, o.chat, NOW, CLOSING) ?? null : null, flash: o.flash ?? null, back: o.chat ? `/crm/?chat=${o.chat}` : '/crm/',
  };
}

interface Msg { who: Author; text: string; min: number; media?: string; pending?: boolean }
let seq = 0;
function addChat(db: Db, o: { chatId?: string; profile?: string; mode?: 'auto' | 'humano'; fields?: Partial<Record<LeadField, string>>; note?: string; msgs: Msg[] }): { n: number; chatId: string } {
  const chatId = o.chatId ?? `54911555500${String(++seq).padStart(2, '0')}@c.us`;
  const conv = createConversation(db, { chatId, session: 'default', mode: o.mode ?? 'auto', nowMs: NOW - 5 * MIN, profileName: o.profile });
  const card = emptyCard();
  for (const [f, value] of Object.entries(o.fields ?? {})) card.fields[f as LeadField] = { value, evidenceMsgId: 'm1' };
  card.teamNote = o.note ?? '';
  saveCard(db, chatId, card);
  o.msgs.forEach((m, i) => insertMessage(db, {
    session: 'default', providerMsgId: `t-${chatId}-${i}`, chatId, author: m.who, text: m.text, tsUtcMs: NOW - m.min * MIN,
    ...(m.media ? { media: m.media } : {}), ...(m.pending ? { transcriptStatus: 'pendiente' as const } : {}),
  }));
  return { n: conv.n, chatId };
}
const draft = (db: Db, chatId: string, bubbles: string[]): number => createDraft(db, { chatId, contextVersion: 0, bubbles, material: [], nowMs: NOW - 2 * MIN, answersUpto: 0 });
const textOf = (h: string): string => h.replace(/<[^>]*>/g, ' ');

// Una base con un poco de todo: borrador, A presupuestar con promesa, contacto sin número.
function rich(): { db: Db; draftChat: { n: number; chatId: string }; draftId: number; presuChat: { n: number; chatId: string }; lidChat: { n: number; chatId: string } } {
  const db = openDb(':memory:');
  const draftChat = addChat(db, { fields: { nombre: 'Pedro Ejemplo', localidad: 'Villa Aurelia' }, note: 'Quiere 2 canchas', msgs: [{ who: 'bot', text: 'Hola', min: 50 }, { who: 'customer', text: '¿Cuánto sale?', min: 40 }] });
  const draftId = draft(db, draftChat.chatId, ['Te lo confirmo enseguida.']);
  const presuChat = addChat(db, { mode: 'humano', fields: { nombre: 'Ana Ejemplo' }, msgs: [{ who: 'bot', text: `Listo. ${CLOSING}`, min: 26 * 60 }] });
  setStage(db, presuChat.chatId, 'a_presupuestar', NOW - 26 * 60 * MIN); // viernes 10:00: la promesa vence hoy
  audit(db, NOW - 26 * 60 * MIN, presuChat.chatId, 'handoff', 'listo_para_presupuesto (stop, prioridad alta)');
  const lidChat = addChat(db, { chatId: '280000000000001@lid', mode: 'humano', msgs: [{ who: 'customer', text: 'Hola', min: 90 }] });
  return { db, draftChat, draftId, presuChat, lidChat };
}

test('lo que escribe el cliente sale escapado: mensaje, nombre de perfil, ficha, nota del bot y borrador', () => {
  const db = openDb(':memory:');
  const evil = addChat(db, {
    profile: '"><img onerror=alert(1) src=x>', fields: { localidad: '<svg onload=alert(2)>' }, note: '<iframe src=x></iframe>',
    msgs: [{ who: 'customer', text: '<script>alert(1)</script>', min: 30 }],
  });
  draft(db, evil.chatId, ['<script>alert(3)</script>']);
  const h = appPage(view(db, { chat: evil.n, filter: 'todos' })).value;
  assert.ok(!h.includes('<script>alert'), 'el <script> del cliente llegó crudo');
  assert.ok(!h.includes('<img onerror'));
  assert.ok(!h.includes('<svg onload'));
  assert.ok(!h.includes('<iframe'));
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'el mensaje tiene que verse como texto');
  assert.ok(h.includes('&quot;&gt;&lt;img onerror'), 'el nombre de perfil tiene que verse como texto');
  assert.equal(h.match(/<script/g)?.length, 1, 'el único <script> es el archivo de la propia página');
});

test('base vacía: renderiza sin chat abierto y tiene #estado, #lista y #chat con los mismos fragmentos', () => {
  const db = openDb(':memory:');
  const v = view(db);
  const h = appPage(v).value;
  assert.ok(h.startsWith('<html lang="es">'));
  for (const id of ['estado', 'lista', 'chat']) assert.ok(h.includes(`id="${id}"`), `falta #${id}`);
  assert.ok(h.includes(statusFragment(v).value) && h.includes(listFragment(v).value) && h.includes(chatFragment(v).value));
  const text = textOf(h);
  assert.match(text, /Nada para hacer ahora: el bot está atendiendo\./);
  assert.match(text, /Elegí un chat de la izquierda/);
  assert.match(text, /Gasto de hoy\s+USD 0,00\s+de 2,00/);
  assert.ok(h.includes('href="/crm/static/crm.css"') && h.includes('src="/crm/static/crm.js" defer') && h.includes('href="/crm/static/icono.png"') && h.includes('src="/crm/static/logo.png"'));
});

test('ninguna pantalla lleva style=, <style>, handlers on…= ni links que no sean del CRM o de WhatsApp (la CSP los rompería)', () => {
  const { db, draftChat, presuChat } = rich();
  const pages = [
    appPage(view(db, { chat: draftChat.n })).value,
    appPage(view(db, { chat: presuChat.n, filter: 'a_presupuestar', query: 'Ana', flash: { text: 'No salió', ok: false } })).value,
    appPage(view(db)).value,
    loginPage({ error: 'Clave incorrecta.' }).value,
    offPage('Falta CRM_PASSWORD en el .env.').value,
  ];
  for (const h of pages) {
    assert.doesNotMatch(h, /<[^>]*\sstyle\s*=/i);
    assert.doesNotMatch(h, /<[^>]*\son[a-z]+\s*=/i);
    assert.doesNotMatch(h, /<style/i);
    assert.doesNotMatch(h, /javascript:/i);
    for (const [, href] of h.matchAll(/href="([^"]*)"/g)) {
      assert.ok(href.startsWith('/crm/') || /^https:\/\/wa\.me\/\d+$/.test(href), `link raro: ${href}`);
    }
  }
});

test('chat con borrador: [Mandar], [Descartar] y [Lo tomo] con el id del borrador en el globo y en el panel, y vuelve a la misma pantalla', () => {
  const { db, draftChat, draftId } = rich();
  const h = chatFragment(view(db, { chat: draftChat.n })).value;
  const globo = /<div class="msg msg-borrador[\s\S]*?<\/form>/.exec(h)![0];
  const panel = h.slice(h.indexOf('<aside class="panel panel-desk"'));
  for (const [donde, parte] of [['el globo', globo], ['el panel', panel]]) {
    assert.ok(parte.includes(`name="d" value="${draftId}"`), `${donde}: falta el id del borrador`);
    assert.ok(parte.includes('name="a" value="mandar"') && parte.includes('name="a" value="descartar"'), `${donde}: faltan [Mandar] o [Descartar]`);
    assert.ok(parte.includes(`name="back" value="/crm/?chat=${draftChat.n}"`), `${donde}: no vuelve a la misma pantalla`);
  }
  assert.ok(globo.includes('name="a" value="dtomo"'), 'el globo tiene [Lo tomo] del borrador');
  assert.match(textOf(h), /Borrador del bot · todavía no salió/);
  assert.match(textOf(h), /Te lo confirmo enseguida\./);
  assert.ok(panel.includes(`name="n" value="${draftChat.n}"`) && panel.includes('name="a" value="tomo"'), 'el bot le contesta: se puede tomar el chat');
  assert.ok(!h.includes('name="a" value="presu"'));
});

test('chat A presupuestar: [Presupuesto mandado] con el número del chat, la promesa y [Devolver al bot]; sin botones de borrador', () => {
  const { db, presuChat } = rich();
  const v = view(db, { chat: presuChat.n });
  const panel = chatFragment(v).value;
  assert.ok(panel.includes('name="a" value="presu"') && panel.includes(`name="n" value="${presuChat.n}"`));
  assert.ok(panel.includes('name="a" value="bot"'), 'es del equipo: se puede devolver al bot');
  assert.ok(!panel.includes('name="a" value="mandar"') && !panel.includes('name="a" value="tomo"'));
  assert.match(textOf(panel), /Promesa al cliente:\s+vence hoy/);
  const row = listFragment(v).value;
  assert.ok(row.includes('class="venc hoy"'), 'la fila marca que vence hoy');
  assert.ok(row.includes(`href="/crm/?chat=${presuChat.n}"`) && row.includes('aria-current="true"'), 'la fila del chat abierto está marcada');
  // "Mover a…": etapas movibles con su nombre en criollo y los motivos
  assert.ok(panel.includes('name="a" value="etapa"') && panel.includes('<option value="perdido">Perdido</option>') && panel.includes('<option value="Eligió a otro">Eligió a otro</option>'));
});

test('criollo y sin teléfonos: nunca se ven códigos internos y el número solo aparece dentro del link de WhatsApp', () => {
  const { db, presuChat, draftChat } = rich();
  for (const chat of [presuChat, draftChat]) {
    const h = appPage(view(db, { chat: chat.n, filter: 'todos' })).value;
    const text = textOf(h);
    assert.doesNotMatch(text, /a_presupuestar|listo_para_presupuesto|presupuesto_mandado|con_el_bot|con_el_equipo|derivado/);
    assert.match(text, /Pasó al equipo: Listo para presupuesto|Pedro Ejemplo/);
    const phone = /^(\d+)@/.exec(chat.chatId)![1];
    assert.ok(h.includes(`href="https://wa.me/${phone}"`) && h.includes('rel="noopener noreferrer"') && h.includes('target="_blank"'));
    assert.equal(h.replaceAll(`https://wa.me/${phone}`, '').includes(phone), false, 'el teléfono apareció fuera del link');
    assert.ok(!h.includes('@c.us'));
  }
});

test('contacto sin número: no hay botón de WhatsApp y la barra de abajo lo explica', () => {
  const { db, lidChat } = rich();
  const h = chatFragment(view(db, { chat: lidChat.n, filter: 'todos' })).value;
  assert.ok(!h.includes('wa.me'));
  assert.match(textOf(h), /no muestra el número/);
  assert.match(textOf(h), /Chat #\d+/);
});

test('conversación: mensaje borrado, editado, adjuntos, aviso del sistema y mensajes más viejos', () => {
  const db = openDb(':memory:');
  const c = addChat(db, {
    msgs: [
      { who: 'system', text: 'Chat de ejemplo', min: 400 },
      { who: 'customer', text: 'texto que después se borró', min: 300 },
      { who: 'customer', text: 'hola con error', min: 200 },
      { who: 'customer', text: '', min: 100, media: 'image' },
      { who: 'customer', text: '', min: 50, media: 'audio', pending: true },
      { who: 'team', text: 'Te escribo ahora', min: 20 },
    ],
  });
  const ids = (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  revokeMessage(db, ids[1]);
  editMessage(db, ids[2], 'hola corregido');
  const text = textOf(chatFragment(view(db, { chat: c.n, filter: 'todos' })).value);
  assert.match(text, /Mensaje borrado/);
  assert.doesNotMatch(text, /texto que después se borró/);
  assert.match(text, /hola corregido/);
  assert.match(text, /editado/);
  assert.match(text, /Foto/);
  assert.match(text, /Audio sin escuchar/);
  assert.match(text, /Chat de ejemplo/);
  assert.match(text, /Equipo\s+Te escribo ahora/);

  for (let i = 0; i < 305; i++) {
    insertMessage(db, { session: 'default', providerMsgId: `viejo-${i}`, chatId: c.chatId, author: 'customer', text: `m${i}`, tsUtcMs: NOW - 500 * MIN + i });
  }
  assert.match(textOf(chatFragment(view(db, { chat: c.n, filter: 'todos' })).value), /Hay 11 mensajes más viejos que no se muestran acá/);
});

test('franja de arriba: los interruptores mandan la acción contraria y el WhatsApp caído se dice con palabras', () => {
  const db = openDb(':memory:');
  let h = statusFragment(view(db)).value;
  assert.ok(h.includes('name="a" value="apagar"') && h.includes('name="a" value="sombra_off"'));
  assert.equal(h.match(/aria-checked="true"/g)?.length, 2);
  assert.ok(h.includes('class="wa ok"') && h.includes('WhatsApp: conectado'));
  setSetting(db, 'kill_switch', '1');
  setSetting(db, 'shadow_mode', '0');
  h = statusFragment(view(db, { session: 'SCAN_QR_CODE' })).value;
  assert.ok(h.includes('name="a" value="prender"') && h.includes('name="a" value="sombra_on"'));
  assert.equal(h.match(/aria-checked="false"/g)?.length, 2);
  assert.ok(h.includes('class="wa mal"') && h.includes('WhatsApp: hay que escanear el QR'));
  assert.ok(h.includes('<form class="salir" method="post" action="/crm/salir">'));
});

test('lista: enlaces con f, q y chat como los arma el servidor, buscador con f oculto y vacíos que enseñan', () => {
  const { db, draftChat } = rich();
  const ahora = listFragment(view(db)).value;
  assert.ok(ahora.includes(`href="/crm/?chat=${draftChat.n}"`), 'con "ahora" no va f');
  assert.ok(!ahora.includes('name="f"'));
  assert.ok(ahora.includes('aria-current="page"'));
  const todos = listFragment(view(db, { filter: 'todos', query: 'Pedro' })).value;
  assert.ok(todos.includes(`href="/crm/?f=todos&amp;q=Pedro&amp;chat=${draftChat.n}"`));
  assert.ok(todos.includes('<input type="hidden" name="f" value="todos">') && todos.includes('<form class="buscar" role="search" method="get" action="/crm/">'));
  // Buscando (en todos los chats): ningún filtro marcado, y tocar uno borra la búsqueda.
  assert.ok(todos.includes('href="/crm/?f=seguimiento"'), 'el menú de etapas borra la búsqueda');
  assert.ok(todos.includes('href="/crm/"') && !todos.includes('class="chip activo"') && !todos.includes('aria-current="page"'));
  assert.match(textOf(listFragment(view(db, { filter: 'seguimiento' })).value), /No hay chats en esta etapa\./);
  assert.match(textOf(listFragment(view(db, { query: 'zzz' })).value), /No hay chats que coincidan con “zzz”/);
});

test('pantalla de clave y CRM apagado: el error y el motivo se escapan y el formulario va a /crm/login', () => {
  const login = loginPage({ error: '<b>Clave incorrecta.</b>' }).value;
  assert.ok(login.includes('action="/crm/login"') && login.includes('name="clave"') && login.includes('type="password"') && login.includes('role="alert"'));
  assert.ok(login.includes('&lt;b&gt;Clave incorrecta.&lt;/b&gt;') && !login.includes('<b>Clave'));
  assert.ok(!loginPage({}).value.includes('role="alert"'));
  const off = offPage('Falta <CRM_PASSWORD> en el .env.').value;
  assert.ok(off.includes('Falta &lt;CRM_PASSWORD&gt; en el .env.') && off.startsWith('<html lang="es">'));
});

test('el aviso de la acción (sin JavaScript llega por la URL) sale con role="status" y un enlace para cerrarlo', () => {
  const { db } = rich();
  const h = appPage(view(db, { flash: { text: 'Mandado: sale en unos segundos.', ok: true } })).value;
  assert.ok(h.includes('role="status"') && h.includes('Mandado: sale en unos segundos.') && h.includes('<a class="toast-x" href="/crm/">Cerrar</a>'));
  assert.ok(appPage(view(db, { flash: { text: 'No se mandó', ok: false } })).value.includes('toast toast-mal'));
});

test('Devolver al bot pregunta antes si el chat pierde una etapa del equipo; el bot apagado se dice en el chat', () => {
  const db = openDb(':memory:');
  const a = addChat(db, { mode: 'humano', profile: 'Presu', msgs: [{ who: 'customer', text: 'hola', min: 30 }] });
  setStage(db, a.chatId, 'presupuestado', NOW - 10 * MIN);
  const h = chatFragment(view(db, { chat: a.n, filter: 'todos' })).value;
  assert.match(h, /value="bot" class="btn btn-secondary" data-confirma="¿Devolverlo al bot\? Sale de Presupuestados/);
  const b = addChat(db, { mode: 'humano', profile: 'APresu', msgs: [{ who: 'customer', text: 'hola', min: 30 }] });
  setStage(db, b.chatId, 'a_presupuestar', NOW - 10 * MIN);
  audit(db, NOW - 10 * MIN, b.chatId, 'handoff', 'pide_persona (stop, prioridad normal)');
  const hb = chatFragment(view(db, { chat: b.n })).value;
  assert.match(hb, /data-confirma="¿Devolverlo al bot\? Sale de A presupuestar/); // pierde el reloj de la promesa
  assert.match(hb, /Pasó al equipo: pide hablar con una persona\. Falta mandar el presupuesto\./);
  const e = addChat(db, { mode: 'humano', profile: 'SinEtapa', msgs: [{ who: 'customer', text: 'hola', min: 30 }] });
  assert.ok(!/value="bot"[^>]*data-confirma/.test(chatFragment(view(db, { chat: e.n })).value)); // sin etapa no hay nada que perder
  const c = addChat(db, { profile: 'ConBot', msgs: [{ who: 'customer', text: 'hola', min: 1 }] });
  assert.match(chatFragment(view(db, { chat: c.n })).value, /El bot contesta solo\./);
  setSetting(db, 'kill_switch', '1');
  const off = chatFragment(view(db, { chat: c.n })).value;
  assert.match(off, /El bot está apagado: no le contesta\./);
  assert.match(off, /Con el bot, pero el bot está apagado/);
});

test('con un chat abierto, los filtros y el buscador lo mantienen abierto (como WhatsApp)', () => {
  const db = openDb(':memory:');
  const a = addChat(db, { profile: 'Abierto', msgs: [{ who: 'customer', text: 'hola', min: 30 }] });
  const h = listFragment(view(db, { chat: a.n })).value;
  assert.ok(h.includes(`href="/crm/?f=todos&amp;chat=${a.n}"`), 'chip Todos');
  assert.ok(h.includes(`href="/crm/?f=cliente&amp;chat=${a.n}"`), 'menú de etapas');
  assert.ok(h.includes(`<input type="hidden" name="chat" value="${a.n}">`), 'buscador');
});

test('crm.js se puede leer (un error de sintaxis apaga todos los botones sin que ningún otro test lo vea)', async () => {
  const { readFileSync } = await import('node:fs');
  const { Script } = await import('node:vm');
  assert.doesNotThrow(() => new Script(readFileSync(new URL('../src/crm/public/crm.js', import.meta.url), 'utf8'), { filename: 'crm.js' }));
});
