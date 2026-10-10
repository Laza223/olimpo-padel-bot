// Creador de presupuestos por HTTP: pantalla con su CSP, API (ids del servidor), vista previa, PDF y "Enviar por WhatsApp" a la cola del bot.
// Chromium falso (no hace falta tenerlo); el render real se prueba aparte y se saltea si no hay Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrm } from '../src/crm/server.ts';
import { createPdfRenderer, RenderError } from '../src/crm/quote-render.ts';
import { buildQuoteHTML } from '../src/crm/quote-pdf.ts';
import { quoteFromCard, withTotals } from '../src/crm/quote.ts';
import { createConversation, getConversation, getQuote, listAudit, listOutbox, markOutbox, openDb, saveCard, setStage } from '../src/db.ts';
import { createHttpServer } from '../src/http.ts';
import { setSetting, setState } from '../src/settings.ts';
import type { LeadCard } from '../src/types.ts';
import { FakeClock, FakeNotifier, policy } from './f2-helpers.ts';

const PASSWORD = 'clave-de-prueba-larga';
const CHAT = '5491155550000@c.us';
const FAKE_PDF = Buffer.from('%PDF-1.4 falso');

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; text: string }
function call(port: number, o: { method?: string; path: string; origin?: string; cookie?: string; body?: string | Buffer; type?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (o.origin !== undefined) headers.Origin = o.origin;
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.body !== undefined) {
      headers['Content-Type'] = o.type ?? 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(o.body));
    }
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const card = (f: Record<string, string>): LeadCard => ({
  fields: Object.fromEntries(Object.entries(f).map(([k, value]) => [k, { value, evidenceMsgId: 'm1' }])), objections: [], state: 'listo_para_presupuesto', temperature: 'tibio', teamNote: '', flags: { negotiatingCount: 0, offKnowledgeCount: 0 },
});

async function boot(o: { render?: (html: string) => Promise<Buffer> } = {}) {
  const db = openDb(':memory:');
  const clock = new FakeClock();
  const dir = mkdtempSync(join(tmpdir(), 'olimpo-presu-'));
  const calls = { kick: 0, rendered: [] as string[] };
  const controls = () => ({
    worker: { onCustomerMessage: () => undefined, rescan: () => undefined },
    kickOutbox: () => void calls.kick++,
    session: { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array(), mimetype: 'image/png' }) },
  });
  const renderPdf = o.render ?? (async (html: string) => (calls.rendered.push(html), FAKE_PDF));
  const crm = createCrm({
    db, clock, controls, notifier: new FakeNotifier(), assets: policy.assets, closingText: policy.closingText, password: PASSWORD, wahaSecrets: {},
    quotePrices: { fullPromo: 19900, fullLista: 21900, panoramica: 20900, platea: 8500 }, quoteHints: { instalacion: 'Referencia interna: USD 2.500 por cancha' }, quoteDir: dir, renderPdf,
  });
  const server = createHttpServer({ db, secret: 'secreto', clock, crm, health: () => ({ ok: true }) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const r = await call(port, { method: 'POST', path: '/crm/login', origin, body: `clave=${encodeURIComponent(PASSWORD)}`, type: 'application/x-www-form-urlencoded' });
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const conv = createConversation(db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: clock.now() });
  saveCard(db, CHAT, card({ nombre: 'Juan Prueba', localidad: 'Pilar', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'no_tiene' }));
  setStage(db, CHAT, 'a_presupuestar', clock.now());
  const post = (path: string, body: object | string, type?: string) => call(port, { method: 'POST', path, origin, cookie, body: typeof body === 'string' ? body : JSON.stringify(body), type });
  const get = (path: string) => call(port, { path, cookie });
  return { db, clock, dir, calls, port, origin, cookie, n: conv.n, post, get, close: () => new Promise<void>((resolve) => server.close(() => (rmSync(dir, { recursive: true, force: true }), resolve()))) };
}

const DATA = {
  clienteNombre: 'Juan Prueba', titulo: 'PROYECTO 2 CANCHAS FULL PANORÁMICAS', clienteCodigoPais: '+54', clienteTelefono: '91155550000', clienteLocalidad: 'Pilar',
  productos: [{ id: 'a', modelo: 'Cancha Full Panorámica', cantidad: 2, precioUnitario: 19900, precioLista: 21900 }, { id: 'b', modelo: 'Servicio de Instalación', cantidad: 2, precioUnitario: 2500 }],
  items: [{ id: 'i1', descripcion: 'Césped 14 mm' }], condicionesPago: '70/30', plazoEntrega: '30 días', moneda: 'USD',
};

test('pantalla: con su CSP (fuentes de Google, nada inline); desde un chat viene precargada con la oferta; sin sesión no abre', async () => {
  const s = await boot();
  try {
    assert.equal((await call(s.port, { path: '/crm/presupuestos' })).status, 401);
    const r = await s.get(`/crm/presupuestos?chat=${s.n}`);
    assert.equal(r.status, 200);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self' https:\/\/fonts\.googleapis\.com;/);
    assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com;/);
    assert.ok(!csp.includes('unsafe-inline'));
    const boot = JSON.parse(/<script type="application\/json" id="boot">(.*?)<\/script>/s.exec(r.text)![1]);
    assert.equal(boot.abrir, null);
    assert.equal(boot.nuevo.chat.n, s.n);
    assert.deepEqual(boot.nuevo.data.productos.map((p: { modelo: string; precioUnitario: number; precioLista?: number }) => [p.modelo, p.precioUnitario, p.precioLista ?? null]), [
      ['Cancha Full Panorámica', 19900, 21900], ['Servicio de Instalación', 0, null], ['Servicio de Logística', 0, null],
    ]);
    assert.equal(boot.hints.instalacion, 'Referencia interna: USD 2.500 por cancha');
    assert.equal((await s.get('/crm/presupuestos?chat=999')).status, 404);
    assert.equal((await s.get('/crm/presupuestos?id=../../etc')).status, 404);
  } finally {
    await s.close();
  }
});

test('API: guardar (ids del servidor, totales del servidor, validación del creador), listar, duplicar, estado, borrar; ids raros no pasan', async () => {
  const s = await boot();
  try {
    const bad = await s.post('/crm/presupuestos/api/guardar', { data: { ...DATA, clienteNombre: '' } });
    assert.deepEqual([bad.status, JSON.parse(bad.text).error], [422, 'Ingresá el nombre del cliente']);
    const r = await s.post('/crm/presupuestos/api/guardar', { chat: s.n, data: { ...DATA, precioTotal: 1, subtotal: 1 } });
    assert.equal(r.status, 200);
    const p = JSON.parse(r.text).presupuesto;
    assert.match(p.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual([p.subtotal, p.precioTotal, p.estado, p.chat.n, p.chat.nombre, p.envio], [44800, 44800, 'borrador', s.n, 'Juan Prueba', null]);
    const upd = await s.post('/crm/presupuestos/api/guardar', { id: p.id, data: { ...DATA, titulo: 'OTRO' } });
    assert.equal(JSON.parse(upd.text).presupuesto.titulo, 'OTRO');
    assert.equal((await s.post('/crm/presupuestos/api/guardar', { id: '../../../.env', data: DATA })).status, 400);
    assert.equal((await s.post('/crm/presupuestos/api/guardar', { id: '00000000-0000-4000-8000-000000000000', data: DATA })).status, 404);
    const dup = JSON.parse((await s.post('/crm/presupuestos/api/duplicar', { id: p.id })).text).presupuesto;
    assert.notEqual(dup.id, p.id);
    assert.equal(dup.chat.n, s.n);
    assert.equal((await s.post('/crm/presupuestos/api/estado', { id: p.id, estado: 'raro' })).status, 400);
    assert.equal(JSON.parse((await s.post('/crm/presupuestos/api/estado', { id: p.id, estado: 'aceptado' })).text).presupuesto.estado, 'aceptado');
    const lista = JSON.parse((await s.get('/crm/presupuestos/api/lista')).text).presupuestos;
    assert.equal(lista.length, 2);
    assert.equal((await s.post('/crm/presupuestos/api/borrar', { id: dup.id })).status, 200);
    assert.equal((await s.post('/crm/presupuestos/api/borrar', { id: dup.id })).status, 404);
    assert.equal((await s.post('/crm/presupuestos/api/borrar', 'no es json')).status, 400);
    assert.equal(getConversation(s.db, CHAT)!.stage, 'a_presupuestar'); // guardar no toca la etapa
    // otro sitio no puede: el Origin manda también acá
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/presupuestos/api/borrar', origin: 'http://127.0.0.1:3000', cookie: s.cookie, body: JSON.stringify({ id: p.id }) })).status, 403);
    assert.ok(getQuote(s.db, p.id));
  } finally {
    await s.close();
  }
});

test('pedido de más de 256 KB: 413; el de una pantalla normal pasa', async () => {
  const s = await boot();
  try {
    assert.equal((await s.post('/crm/presupuestos/api/guardar', { data: { ...DATA, notasAdicionales: 'x'.repeat(300 * 1024) } })).status, 413);
    assert.equal((await s.post('/crm/presupuestos/api/guardar', { data: { ...DATA, notasAdicionales: 'x'.repeat(1000) } })).status, 200);
  } finally {
    await s.close();
  }
});

test('vista previa: la hoja del PDF con CSP propia (solo estilos, fuente y logo) y que solo se puede ver dentro del CRM', async () => {
  const s = await boot();
  try {
    const r = await s.post('/crm/presupuestos/vista', `data=${encodeURIComponent(JSON.stringify({ ...DATA, clienteNombre: '<script>alert(1)</script>' }))}`, 'application/x-www-form-urlencoded');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
    assert.ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !r.text.includes('<script>alert'));
    assert.match(r.text, /<span class="offer-tag">OFERTA<\/span>/);
    assert.match(r.text, /src="data:image\/png;base64,/);
  } finally {
    await s.close();
  }
});

test('exportar PDF: guarda, baja el PDF con el nombre del creador y queda "enviado"; si Chromium falla, lo dice y queda anotado', async () => {
  const s = await boot();
  try {
    const r = await s.post('/crm/presupuestos/pdf', { chat: s.n, data: DATA });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.headers['content-disposition'], `attachment; filename="Presupuesto_Juan_Prueba.pdf"; filename*=UTF-8''Presupuesto_Juan_Prueba.pdf`);
    assert.deepEqual(r.body, FAKE_PDF);
    const id = String(r.headers['x-presupuesto-id']);
    assert.equal(getQuote(s.db, id)!.estado, 'enviado');
    assert.equal(listOutbox(s.db).length, 0); // bajarlo no manda nada
    assert.equal(getConversation(s.db, CHAT)!.stage, 'a_presupuestar');
    const ñ = await s.post('/crm/presupuestos/pdf', { data: { ...DATA, clienteNombre: 'Ñandú Pérez' } });
    assert.match(String(ñ.headers['content-disposition']), /filename="Nandu_Perez\.pdf"|filename\*=UTF-8''Presupuesto_%C3%91and%C3%BA_P%C3%A9rez\.pdf/);
  } finally {
    await s.close();
  }
  const f = await boot({ render: async () => { throw new RenderError('Chromium falló: x'); } });
  try {
    const r = await f.post('/crm/presupuestos/pdf', { data: DATA });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [502, 'No se pudo armar el PDF. Probá de nuevo; si sigue, avisame.']);
    assert.ok(listAudit(f.db, 'error').some((a) => a.detail.includes('Chromium falló')));
  } finally {
    await f.close();
  }
});

test('enviar por WhatsApp: PDF en data/presupuestos, fila del equipo en la cola, chat a Presupuestados; doble clic no duplica; reenviar después sí', async () => {
  const s = await boot();
  try {
    const r = await s.post('/crm/presupuestos/enviar', { chat: s.n, data: DATA });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.text, 'Mandado: sale en unos segundos con "Te paso el presupuesto.". El chat pasó a Presupuestados.');
    assert.equal(body.presupuesto.envio.estado, 'en_cola');
    const rows = listOutbox(s.db);
    assert.deepEqual(rows.map((x) => [x.kind, x.author, x.status, x.logicalKey]), [['file', 'team', 'pendiente', `team:presupuesto:${body.presupuesto.id}:1`]]);
    const file = JSON.parse(rows[0].body) as { file: string; filename: string; caption: string };
    assert.deepEqual([file.filename, file.caption], ['Presupuesto_Juan_Prueba.pdf', 'Te paso el presupuesto.']);
    assert.ok(file.file.startsWith(s.dir) && existsSync(file.file));
    assert.equal(s.calls.kick, 1);
    const conv = getConversation(s.db, CHAT)!;
    assert.deepEqual([conv.mode, conv.stage], ['humano', 'presupuestado']);
    // doble clic: ya está en la cola
    const again = await s.post('/crm/presupuestos/enviar', { id: body.presupuesto.id, data: DATA });
    assert.deepEqual([again.status, JSON.parse(again.text).error], [409, 'Ya está en la cola: sale en cuanto pueda. No hace falta mandarlo de nuevo.']);
    assert.equal(listOutbox(s.db).length, 1);
    assert.equal(readdirSync(s.dir).length, 1);
    // salió; mandarlo de nuevo (corregido) es otra fila, y el chat sigue en Presupuestados
    markOutbox(s.db, rows[0].id, 'aceptado', { providerMsgId: 'true_x' });
    const status = JSON.parse((await s.get(`/crm/presupuestos?id=${body.presupuesto.id}`)).text.match(/id="boot">(.*?)<\/script>/s)![1]).abrir.envio;
    assert.equal(status.estado, 'salio');
    const re = await s.post('/crm/presupuestos/enviar', { id: body.presupuesto.id, data: { ...DATA, plazoEntrega: '20 días' } });
    assert.equal(JSON.parse(re.text).text, 'Mandado: sale en unos segundos con "Te paso el presupuesto.".');
    assert.deepEqual(listOutbox(s.db).map((x) => x.logicalKey.split(':').at(-1)), ['1', '2']);
    // con el bot apagado, lo dice
    markOutbox(s.db, listOutbox(s.db)[1].id, 'aceptado', { providerMsgId: 'true_y' });
    setSetting(s.db, 'kill_switch', '1');
    const off = await s.post('/crm/presupuestos/enviar', { id: body.presupuesto.id, data: DATA });
    assert.match(JSON.parse(off.text).text, /^En la cola: sale cuando prendas el bot/);
  } finally {
    await s.close();
  }
});

test('enviar: dos pedidos a la vez al mismo chat (dos pestañas) mandan uno solo, aunque el primero ya haya salido', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await boot({ render: async () => (await gate, FAKE_PDF) });
  try {
    const a = s.post('/crm/presupuestos/enviar', { chat: s.n, data: DATA });
    const b = s.post('/crm/presupuestos/enviar', { chat: s.n, data: { ...DATA, titulo: 'OTRA PESTAÑA' } });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    assert.match(JSON.parse((ra.status === 409 ? ra : rb).text).error, /Ya se está mandando un presupuesto a este chat/);
    assert.equal(listOutbox(s.db).length, 1);
    // un presupuesto distinto al mismo chat mientras el primero sigue en la cola: tampoco
    const otro = await s.post('/crm/presupuestos/enviar', { chat: s.n, data: DATA });
    assert.equal(otro.status, 409);
    assert.equal(listOutbox(s.db).length, 1);
  } finally {
    await s.close();
  }
});

test('enviar: a quien pidió la baja no se le manda; un chat ya presupuestado que volvió al bot pasa al equipo', async () => {
  const s = await boot();
  try {
    saveCard(s.db, CHAT, { ...card({ nombre: 'Juan' }), state: 'baja' });
    const r = await s.post('/crm/presupuestos/enviar', { chat: s.n, data: DATA });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, 'Este cliente pidió que no le escriban más: desde acá no se le manda nada.']);
    assert.equal(listOutbox(s.db).length, 0);
    saveCard(s.db, CHAT, card({ nombre: 'Juan' }));
    setStage(s.db, CHAT, 'seguimiento', s.clock.now());
    setState(s.db, 'quote_sent_utc.' + CHAT, '1'); // ya tenía un presupuesto anotado
    const ok = await s.post('/crm/presupuestos/enviar', { chat: s.n, data: DATA });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([getConversation(s.db, CHAT)!.mode, getConversation(s.db, CHAT)!.stage], ['humano', 'seguimiento']); // no retrocede de etapa, pero el bot deja de contestar
  } finally {
    await s.close();
  }
});

test('enviar: sin chat no se puede (se baja en PDF); con un precio vacío, tampoco', async () => {
  const s = await boot();
  try {
    const r = await s.post('/crm/presupuestos/enviar', { data: DATA });
    assert.deepEqual([r.status, JSON.parse(r.text).error], [409, 'Este presupuesto no es de un chat: bajalo en PDF y mandalo vos.']);
    const sinPrecio = await s.post('/crm/presupuestos/enviar', { chat: s.n, data: { ...DATA, productos: [...DATA.productos, { modelo: 'Servicio de Logística', cantidad: 1, precioUnitario: 0 }] } });
    assert.deepEqual([sinPrecio.status, JSON.parse(sinPrecio.text).error], [422, 'Completá el precio de todos los productos']);
    assert.equal(listOutbox(s.db).length, 0);
    assert.equal(s.calls.rendered.length, 0);
  } finally {
    await s.close();
  }
});

test('render real: Chromium de la notebook o del contenedor arma un PDF A4 (se saltea sin CHROMIUM_PATH)', { skip: !process.env.CHROMIUM_PATH && 'sin CHROMIUM_PATH' }, async () => {
  const render = createPdfRenderer({ chromiumPath: process.env.CHROMIUM_PATH });
  const pdf = await render('<!doctype html><html><head><style>@page { size: A4; margin: 0; }</style></head><body><h1>Prueba</h1></body></html>');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 59[45]\.\d* 841\.\d*\]/);
});

test('render real: el presupuesto precargado de 2 Full Panorámicas, con la oferta, instalación y logística, entra en 1 hoja A4 (se saltea sin CHROMIUM_PATH)', { skip: !process.env.CHROMIUM_PATH && 'sin CHROMIUM_PATH' }, async () => {
  let n = 0;
  const q = quoteFromCard(card({ nombre: 'Hernán Quiroga', localidad: 'Lomas del Sur', provincia: 'Buenos Aires', cantidad_canchas: '2', modelo: 'full_panoramica', platea: 'no_tiene' }), CHAT, { fullPromo: 19900, fullLista: 21900, panoramica: 20900, platea: 8500 }, () => `i${++n}`);
  q.productos[1].precioUnitario = 2500;
  q.productos[2].precioUnitario = 1500;
  const html = buildQuoteHTML(withTotals(q), { logo: `data:image/png;base64,${readFileSync(new URL('../src/crm/public/logo-creador.png', import.meta.url)).toString('base64')}`, fecha: '10/10/2026' });
  assert.ok(html.includes('offer-line'));
  const pdf = (await createPdfRenderer({ chromiumPath: process.env.CHROMIUM_PATH })(html)).toString('latin1');
  assert.equal((pdf.match(/\/Type\s*\/Page(?!s)/g) ?? []).length, 1); // una franja aparte empujaba el pie a una 2.ª hoja
});

test('render: sin CHROMIUM_PATH o con un Chromium que no deja PDF, error claro; de a uno por vez', async () => {
  await assert.rejects(createPdfRenderer({ chromiumPath: undefined })('<p>x</p>'), /Falta CHROMIUM_PATH/);
  await assert.rejects(createPdfRenderer({ chromiumPath: 'chromium', run: async () => undefined })('<p>x</p>'), /no dejó el PDF/);
  let running = 0;
  let max = 0;
  const { writeFile } = await import('node:fs/promises');
  const render = createPdfRenderer({
    chromiumPath: 'chromium',
    run: async (_cmd, args) => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(args.find((a) => a.startsWith('--print-to-pdf='))!.slice('--print-to-pdf='.length), '%PDF-1.4');
      running--;
    },
  });
  const out = await Promise.all([render('a'), render('b'), render('c')]);
  assert.equal(max, 1);
  assert.ok(out.every((b) => b.toString() === '%PDF-1.4'));
  await assert.rejects(createPdfRenderer({ chromiumPath: 'chromium', run: async (_c, args) => writeFile(args.find((a) => a.startsWith('--print-to-pdf='))!.slice(15), '<html>') })('x'), /no es un PDF/);
});
