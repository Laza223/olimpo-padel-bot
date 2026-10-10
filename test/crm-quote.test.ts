// El presupuesto del CRM: el PDF es el del creador (comparado contra una copia de su pdf.js), la oferta, los totales del servidor y la precarga desde la ficha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildQuoteHTML, isOffer, quoteDate, quoteFilename } from '../src/crm/quote-pdf.ts';
import { CONDICIONES_DEFAULT, PLAZO_DEFAULT, SPECS_CANCHA, SPECS_PLATEA, emptyQuote, forPdf, normalizeQuote, phoneOf, quoteFromCard, validateQuote, withTotals } from '../src/crm/quote.ts';
import type { QuoteData } from '../src/crm/quote.ts';
import type { LeadCard } from '../src/types.ts';

const LOGO = 'data:image/png;base64,AAAA';
const FECHA = '10/10/2026';
const PAGE = '    @page { size: A4; margin: 0; }\n\n';
let seq = 0;
const newId = () => `id${++seq}`;

// El buildHTML original del creador, con la fecha y el logo fijos (corre sin DOM: usa su escapeHtml de respaldo).
async function original(data: unknown): Promise<string> {
  class FixedDate {
    toLocaleDateString() {
      return FECHA;
    }
  }
  const ctx = { window: { electronAPI: { getLogoBase64: async () => LOGO } }, module: { exports: {} as { init(): Promise<void>; buildHTML(d: unknown): string } }, console, Intl, Date: FixedDate };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('./fixtures/creador-pdf.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), ctx); // un clon con CRLF no cambia la plantilla
  await ctx.module.exports.init();
  return ctx.module.exports.buildHTML(data);
}
const port = (data: QuoteData) => buildQuoteHTML(data, { logo: LOGO, fecha: FECHA });

function base(): QuoteData {
  return withTotals({
    ...emptyQuote(newId),
    clienteNombre: 'Juan Prueba', clienteLocalidad: 'Pilar, Buenos Aires', clienteTelefono: '11 5555 0000', titulo: 'PROYECTO 2 CANCHAS FULL PANORÁMICAS',
    productos: [
      { id: 'a', modelo: 'Cancha Full Panorámica', nombreCustom: '', cantidad: 2, precioUnitario: 19900 },
      { id: 'b', modelo: 'Servicio de Instalación', nombreCustom: '', cantidad: 2, precioUnitario: 2500.5 },
    ],
  });
}

test('PDF idéntico al del creador (salvo la hoja A4) en casos variados: precio global, descuento, notas, "Otro", sin teléfono, caracteres raros', async () => {
  const casos: QuoteData[] = [
    base(),
    withTotals({ ...base(), esPrecioGlobal: true, precioGlobalManual: 50000 }),
    withTotals({ ...base(), descuentoPct: 7.5 }),
    withTotals({ ...base(), esPrecioGlobal: true, precioGlobalManual: 1000, descuentoPct: 10, moneda: 'ARS' }),
    { ...base(), notasAdicionales: 'Línea 1\nLínea 2 con <b>"comillas" & \'apóstrofo\'</b>', clienteTelefono: '', clienteLocalidad: '' },
    withTotals({ ...base(), clienteNombre: `O'Brien "El <Pibe>" & Cía`, productos: [{ id: 'c', modelo: 'Otro', nombreCustom: 'Cerramiento <lateral> & "extra"', cantidad: 3, precioUnitario: 1234.56 }] }),
    withTotals({ ...base(), items: [], condicionesPago: '', plazoEntrega: '' }),
    withTotals({ ...base(), condicionesPago: CONDICIONES_DEFAULT, plazoEntrega: PLAZO_DEFAULT, items: SPECS_PLATEA.map((descripcion) => ({ id: newId(), descripcion })) }),
  ];
  for (const [i, q] of casos.entries()) {
    const mine = port(forPdf(q));
    assert.ok(mine.includes(PAGE), `caso ${i}: falta la hoja A4`);
    assert.equal(mine.replace(PAGE, ''), await original(forPdf(q)), `caso ${i}`);
  }
});

test('oferta: franja debajo del título y precio de lista tachado; con precio global, solo "OFERTA FULL PANORÁMICA"', () => {
  const q = withTotals({ ...base(), productos: [{ id: 'a', modelo: 'Cancha Full Panorámica', nombreCustom: '', cantidad: 2, precioUnitario: 19900, precioLista: 21900 }] });
  const h = port(q);
  assert.match(h, /<span class="offer-tag">OFERTA<\/span><span class="offer-text"><strong>FULL PANORÁMICA<\/strong> a precio de oferta: USD \$19\.900 por cancha · precio de lista USD \$21\.900<\/span>/);
  assert.match(h, /<td class="td-precio"><span class="precio-lista">USD \$21\.900<\/span>USD \$19\.900<\/td>/);
  assert.ok(h.indexOf('offer-line">') > h.indexOf('<h2>') && h.indexOf('offer-line">') < h.indexOf('<!-- CLIENT -->')); // dentro de la barra del título
  assert.match(h, /\.offer-tag \{[^}]*background: #dc2626/);
  const g = port(withTotals({ ...q, esPrecioGlobal: true, precioGlobalManual: 39800 }));
  assert.match(g, /<span class="offer-text"><strong>FULL PANORÁMICA<\/strong><\/span>/);
  assert.ok(!g.includes('precio-lista">') && !g.includes('19.900'));
  // sin oferta (lista no mayor que el precio): ni franja ni estilos
  const sin = port(withTotals({ ...q, productos: [{ ...q.productos[0], precioLista: 19900 }] }));
  assert.ok(!sin.includes('offer-line') && !sin.includes('precio-lista'));
  assert.equal(isOffer({ id: 'x', modelo: '', nombreCustom: '', cantidad: 1, precioUnitario: 1, precioLista: 9 }, false), false); // un renglón sin elegir no cuenta
});

test('totales del servidor como el creador; lo que manda el navegador no se cree', () => {
  const q = normalizeQuote({
    clienteNombre: '  Ana  ', titulo: 'X', moneda: 'EUR', clienteCodigoPais: '+999', descuentoPct: 250, precioTotal: 1, subtotal: 1,
    productos: [{ id: '../../etc', modelo: 'Cancha Full Panorámica', cantidad: '2', precioUnitario: '19900', precioLista: -5 }, { modelo: 'Inventado', precioUnitario: 1 }, 'basura', { modelo: 'Otro', nombreCustom: 'Extra', cantidad: 0, precioUnitario: 'NaN' }],
    items: [{ descripcion: 'a' }, { descripcion: '   ' }],
  }, newId);
  assert.equal(q.clienteNombre, 'Ana');
  assert.equal(q.moneda, 'USD');
  assert.equal(q.clienteCodigoPais, '+54');
  assert.equal(q.descuentoPct, 100);
  assert.deepEqual(q.productos.map((p) => [p.modelo, p.cantidad, p.precioUnitario, p.precioLista]), [['Cancha Full Panorámica', 2, 19900, undefined], ['', 1, 1, undefined], ['Otro', 1, 0, undefined]]);
  assert.ok(q.productos.every((p) => /^[\w-]+$/.test(p.id)));
  assert.deepEqual([q.subtotal, q.descuento, q.precioTotal], [39800, 39800, 0]);
  assert.deepEqual(forPdf(q).items.map((i) => i.descripcion), ['a']);
  assert.deepEqual(forPdf(q).productos.map((p) => p.modelo), ['Cancha Full Panorámica', 'Otro']);
  const g = normalizeQuote({ esPrecioGlobal: true, precioGlobalManual: 1000, descuentoPct: 10, productos: [{ modelo: 'Cancha Panorámica' }] }, newId);
  assert.deepEqual([g.subtotal, g.descuento, g.precioTotal], [1000, 100, 900]);
  assert.deepEqual(normalizeQuote(null, newId).productos, []);
});

test('validación con los mismos textos que el creador', () => {
  const ok = base();
  assert.equal(validateQuote(ok), undefined);
  assert.equal(validateQuote({ ...ok, clienteNombre: ' ' }), 'Ingresá el nombre del cliente');
  assert.equal(validateQuote({ ...ok, titulo: '' }), 'Ingresá el título del presupuesto');
  assert.equal(validateQuote({ ...ok, productos: [{ ...ok.productos[0], modelo: '' }] }), 'Agregá al menos un producto o servicio');
  assert.equal(validateQuote({ ...ok, productos: [...ok.productos, { id: 'z', modelo: 'Servicio de Logística', nombreCustom: '', cantidad: 1, precioUnitario: 0 }] }), 'Completá el precio de todos los productos');
  assert.equal(validateQuote({ ...ok, esPrecioGlobal: true, productos: [{ ...ok.productos[0], precioUnitario: 0 }] }), undefined); // con precio global no pide precio por renglón
});

const card = (f: Record<string, string>): LeadCard => ({
  fields: Object.fromEntries(Object.entries(f).map(([k, value]) => [k, { value, evidenceMsgId: 'm1' }])), objections: [], state: 'listo_para_presupuesto', temperature: 'tibio', teamNote: '', flags: { negotiatingCount: 0, offKnowledgeCount: 0 },
});
const PRICES = { fullPromo: 19900, fullLista: 21900, panoramica: 20900, platea: 8500 };

test('precarga: cliente, teléfono, localidad, título, canchas con la oferta, platea si la hacemos e instalación y logística SIN precio', () => {
  const q = quoteFromCard(card({ nombre: 'Juan', localidad: 'Pilar', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'quiere_que_la_hagamos', vidrio_12mm: 'si', color_especial: 'negro' }), '5491155550000@c.us', PRICES, newId);
  assert.deepEqual([q.clienteNombre, q.clienteCodigoPais, q.clienteTelefono, q.clienteLocalidad, q.titulo], ['Juan', '+54', '91155550000', 'Pilar, Buenos Aires', 'PROYECTO 2 CANCHAS FULL PANORÁMICAS']);
  assert.deepEqual(q.productos.map((p) => [p.modelo, p.nombreCustom, p.cantidad, p.precioUnitario, p.precioLista]), [
    ['Cancha Full Panorámica', '', 2, 19900, 21900],
    ['Platea de Hormigón', '', 2, 8500, undefined],
    ['Servicio de Instalación', '', 2, 0, undefined],
    ['Servicio de Logística', '', 1, 0, undefined],
    ['Otro', 'Diferencia por vidrio templado de 12 mm', 2, 0, undefined],
    ['Otro', 'Color especial: negro', 1, 0, undefined],
  ]);
  assert.deepEqual(q.items.map((i) => i.descripcion), [...SPECS_CANCHA, ...SPECS_PLATEA]);
  assert.equal(q.condicionesPago, CONDICIONES_DEFAULT);
  assert.match(CONDICIONES_DEFAULT, /70% al inicio.*30% restante/);
  assert.ok(SPECS_CANCHA.includes('Césped 14 mm MULTIFILAMENTO + arena Sílice') && SPECS_CANCHA.includes('Estructura de malla de 3,2 mm 50 x 50'));
  assert.equal(validateQuote(q), 'Completá el precio de todos los productos'); // nunca sale con un precio inventado
  // una cancha panorámica, sin platea, sin teléfono (@lid), localidad = provincia
  const p = quoteFromCard(card({ nombre: 'Ana', localidad: 'Córdoba', provincia: 'córdoba', cantidad_canchas: '1', modelo: 'panoramica', platea: 'tiene' }), '123456789012@lid', PRICES, newId);
  assert.deepEqual([p.clienteTelefono, p.clienteLocalidad, p.titulo], ['', 'Córdoba', 'PROYECTO 1 CANCHA PANORÁMICA']);
  assert.deepEqual(p.productos.map((x) => [x.modelo, x.precioUnitario]), [['Cancha Panorámica', 20900], ['Servicio de Instalación', 0], ['Servicio de Logística', 0]]);
  assert.deepEqual(p.items.map((i) => i.descripcion), SPECS_CANCHA);
  // ficha vacía y sin precios: nada inventado
  const v = quoteFromCard(undefined, '5491155550000@c.us', undefined, newId);
  assert.deepEqual([v.clienteNombre, v.titulo, v.productos[0].modelo, v.productos[0].cantidad], ['', 'PROYECTO 1 CANCHA DE PÁDEL', '', 1]);
});

test('teléfono por código de país (el más largo primero); nombre del archivo y fecha como el creador', () => {
  assert.deepEqual(phoneOf('59899123456@c.us'), { codigo: '+598', numero: '99123456' });
  assert.deepEqual(phoneOf('5511987654321@c.us'), { codigo: '+55', numero: '11987654321' });
  assert.deepEqual(phoneOf('4915112345678@c.us'), { codigo: '+54', numero: '4915112345678' });
  assert.equal(quoteFilename('Juan Pérez / Club "Norte"'), 'Presupuesto_Juan_Pérez_Club_Norte.pdf');
  assert.equal(quoteFilename('***'), 'Presupuesto_cliente.pdf');
  assert.equal(quoteDate(Date.UTC(2026, 9, 11, 2, 0)), '10/10/2026'); // 23 h del 10 en Argentina, aunque en UTC ya sea el 11
});
