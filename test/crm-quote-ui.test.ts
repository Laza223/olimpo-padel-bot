// Pantalla del creador de presupuestos (quote-views.ts + presupuesto.js) y su enlace desde la ficha del chat (views.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { botStatus, chatDetail, chatList } from '../src/crm/data.ts';
import type { AppView } from '../src/crm/data.ts';
import type { QuoteBoot } from '../src/crm/quote-routes.ts';
import { CODIGOS_PAIS, CONDICIONES_DEFAULT, MODELOS, PLAZO_DEFAULT, SPECS_CANCHA, SPECS_PLATEA, emptyQuote } from '../src/crm/quote.ts';
import { quotePage } from '../src/crm/quote-views.ts';
import { appPage, statusFragment } from '../src/crm/views.ts';
import { createConversation, insertQuote, insertMessage, openDb, saveCard } from '../src/db.ts';
import { emptyCard } from '../src/lead.ts';

const NOW = Date.UTC(2026, 9, 10, 15, 0);

function boot(over: Partial<QuoteBoot> = {}): QuoteBoot {
  return {
    modelos: MODELOS, codigosPais: CODIGOS_PAIS, specsCancha: SPECS_CANCHA, specsPlatea: SPECS_PLATEA, condiciones: CONDICIONES_DEFAULT, plazo: PLAZO_DEFAULT,
    hints: { instalacion: 'referencia: USD 2.500 por cancha' }, abrir: null, nuevo: null, ...over,
  };
}

test('presupuesto.js se puede leer (un error de sintaxis apaga toda la pantalla sin que otro test lo vea)', () => {
  assert.doesNotThrow(() => new Script(readFileSync(new URL('../src/crm/public/presupuesto.js', import.meta.url), 'utf8'), { filename: 'presupuesto.js' }));
});

test('la pantalla no trae style=, handlers inline ni scripts inline (salvo el JSON del boot)', () => {
  const data = emptyQuote(() => 'x');
  const pages = [
    quotePage({ boot: boot(), chat: null }).value,
    quotePage({ boot: boot({ nuevo: { data, chat: { n: 7, nombre: 'Ana' } } }), chat: { n: 7, nombre: 'Ana' } }).value,
    quotePage({ boot: null, chat: null }).value,
  ];
  for (const h of pages) {
    assert.ok(!/\sstyle=/i.test(h), 'hay un style=');
    assert.ok(!/\son\w+=/i.test(h), 'hay un handler on*=');
    for (const m of h.matchAll(/<script\b([^>]*)>/g)) assert.ok(/\bsrc=|type="application\/json"/.test(m[1]), `script inline: ${m[0]}`);
    assert.ok(h.includes('href="/crm/static/presupuesto.css"') && h.includes('src="/crm/static/presupuesto.js" defer'));
  }
  assert.ok(pages[1].includes('href="/crm/?chat=7">← Volver al chat'));
  assert.ok(pages[0].includes('href="/crm/">← Volver al CRM'));
  assert.ok(pages[2].includes('Ese presupuesto o ese chat no existe') && pages[2].includes('href="/crm/presupuestos"') && !pages[2].includes('id="boot"'));
});

test('un </script> dentro de un dato del boot no cierra el bloque', () => {
  const data = { ...emptyQuote(() => 'x'), titulo: '</script><img src=x onerror=alert(1)>' };
  const h = quotePage({ boot: boot({ nuevo: { data, chat: { n: 1, nombre: '</script>' } } }), chat: null }).value;
  assert.ok(!h.includes('</script><img'), 'el </script> llegó crudo');
  const m = /<script type="application\/json" id="boot">(.*?)<\/script>/s.exec(h);
  assert.ok(m, 'no se encontró el bloque boot');
  assert.equal((JSON.parse(m[1]) as QuoteBoot).nuevo?.data.titulo, data.titulo, 'el dato tiene que volver igual al leer el JSON');
});

test('la ficha del chat ofrece "Armar presupuesto" sin presupuesto y "Ver presupuesto" con uno; la franja enlaza a Presupuestos', () => {
  const db = openDb(':memory:');
  const chatId = '5491155550001@c.us';
  const conv = createConversation(db, { chatId, session: 'default', mode: 'humano', nowMs: NOW - 60_000 });
  saveCard(db, chatId, emptyCard());
  insertMessage(db, { session: 'default', providerMsgId: 'm1', chatId, author: 'customer', text: 'Hola', tsUtcMs: NOW - 30_000 });
  const view = (): AppView => ({
    status: botStatus(db, NOW, 'WORKING'), filter: 'todos', query: '', list: chatList(db, NOW, '', 'todos', ''),
    chat: chatDetail(db, conv.n, NOW, '') ?? null, flash: null, back: `/crm/?chat=${conv.n}`,
  });
  const href = `href="/crm/presupuestos?chat=${conv.n}"`;

  const sin = appPage(view()).value;
  assert.ok(sin.includes('Armar presupuesto') && sin.includes(href) && !sin.includes('Ver presupuesto'));

  insertQuote(db, { id: '11111111-1111-4111-8111-111111111111', chatId, dataJson: JSON.stringify(emptyQuote(() => 'x')), nowMs: NOW });
  const con = appPage(view()).value;
  assert.ok(con.includes('Ver presupuesto') && con.includes(href) && !con.includes('Armar presupuesto'));
  assert.match(con, /Estado: Borrador/);

  assert.ok(statusFragment(view()).value.includes('href="/crm/presupuestos">Presupuestos</a>'));
  // crm.js intercepta solo estos enlaces: ni el de la franja ni los del panel están entre ellos.
  const js = readFileSync(new URL('../src/crm/public/crm.js', import.meta.url), 'utf8');
  const selector = /t\.closest\('(#estado a\.logo[^']*)'\)/.exec(js)?.[1] ?? '';
  assert.ok(selector && !/btn|presu/.test(selector), `el selector de crm.js capturaría los enlaces nuevos: ${selector}`);
});
