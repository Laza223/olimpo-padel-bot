// CRM: barreras (Host, clave, Origin), sesión, acciones por HTTP y que /health y /waha no cambien. Servidor real en 127.0.0.1, puerto al azar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crmDisabledReason, createCrm } from '../src/crm/server.ts';
import { createConversation, createDraft, getConversation, getDraft, insertMessage, listAudit, openDb, setStage } from '../src/db.ts';
import { createHttpServer } from '../src/http.ts';
import { getFlag, getState, setSetting } from '../src/settings.ts';
import { FakeClock, FakeNotifier, policy } from './f2-helpers.ts';

const PASSWORD = 'clave-de-prueba-larga';
const CHAT = '5491155550000@c.us';

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function call(port: number, o: { method?: string; path: string; host?: string; origin?: string; cookie?: string; body?: string; accept?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}` };
    if (o.origin !== undefined) headers.Origin = o.origin;
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.accept) headers.Accept = o.accept;
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = String(Buffer.byteLength(o.body));
    }
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

async function boot(o: { password?: string; waha?: string } = {}) {
  const db = openDb(':memory:');
  const clock = new FakeClock();
  const notifier = new FakeNotifier();
  const calls = { rescan: 0, kick: 0, onCustomer: 0 };
  const controls = () => ({
    worker: { onCustomerMessage: () => void calls.onCustomer++, rescan: () => void calls.rescan++ },
    kickOutbox: () => void calls.kick++,
    session: { current: () => 'WORKING', qr: async () => ({ data: new Uint8Array(), mimetype: 'image/png' }) },
  });
  const crm = createCrm({ db, clock, controls, notifier, assets: policy.assets, closingText: policy.closingText, password: 'password' in o ? o.password : PASSWORD, wahaSecrets: { WAHA_API_KEY: o.waha ?? 'otra-clave-de-waha', WAHA_WEBHOOK_HMAC_SECRET: 'secreto' } });
  const server = createHttpServer({ db, secret: 'secreto', clock, crm, health: () => ({ ok: true }) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const login = async (): Promise<string> => {
    const r = await call(port, { method: 'POST', path: '/crm/login', origin, body: `clave=${encodeURIComponent(PASSWORD)}` });
    assert.equal(r.status, 303);
    return String(r.headers['set-cookie']).split(';')[0];
  };
  return { db, clock, notifier, calls, port, origin, login, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('sin clave, clave corta o igual a la de WAHA: el CRM no abre y dice por qué', async () => {
  assert.match(crmDisabledReason(undefined)!, /Falta CRM_PASSWORD/);
  assert.match(crmDisabledReason('corta')!, /12 caracteres/);
  assert.match(crmDisabledReason('misma-clave-123', { WAHA_API_KEY: 'misma-clave-123' })!, /WAHA_API_KEY/);
  assert.match(crmDisabledReason('misma-clave-123', { WAHA_API_KEY: 'otra', WAHA_WEBHOOK_HMAC_SECRET: 'misma-clave-123' })!, /WAHA_WEBHOOK_HMAC_SECRET/);
  assert.equal(crmDisabledReason(PASSWORD, { WAHA_API_KEY: 'otra', WAHA_WEBHOOK_HMAC_SECRET: undefined }), undefined);
  const s = await boot({ password: undefined });
  try {
    const r = await call(s.port, { path: '/crm/' });
    assert.equal(r.status, 503);
    assert.match(r.body, /CRM_PASSWORD/);
  } finally {
    await s.close();
  }
});

test('Host: solo 127.0.0.1 o localhost (cualquier puerto); otro nombre (WAHA por la red de Docker, DNS rebinding) no pasa', async () => {
  const s = await boot();
  try {
    assert.equal((await call(s.port, { path: '/crm/', host: 'bot:8080' })).status, 403);
    assert.equal((await call(s.port, { path: '/crm/', host: 'evil.example.com' })).status, 403);
    assert.equal((await call(s.port, { path: '/crm/', host: '127.0.0.1.evil.com:8080' })).status, 403);
    const ok = await call(s.port, { path: '/crm/', host: 'localhost:4567' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, '/crm/login');
  } finally {
    await s.close();
  }
});

test('login: sin Origin o con otro Origin (el panel de WAHA en :3000) se rechaza; clave mal 401; a los 5 errores espera 30 s; bien → cookie HttpOnly y SameSite=Strict', async () => {
  const s = await boot();
  try {
    const body = `clave=${encodeURIComponent(PASSWORD)}`;
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/login', body })).status, 403);
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/login', origin: 'http://127.0.0.1:3000', body })).status, 403);
    for (let i = 0; i < 5; i++) assert.equal((await call(s.port, { method: 'POST', path: '/crm/login', origin: s.origin, body: 'clave=mal' })).status, 401);
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/login', origin: s.origin, body })).status, 429); // ni la buena, mientras espera
    await s.clock.advance(31_000);
    const r = await call(s.port, { method: 'POST', path: '/crm/login', origin: s.origin, body });
    assert.equal(r.status, 303);
    const cookie = String(r.headers['set-cookie']);
    assert.match(cookie, /^olimpo_crm=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/crm; Max-Age=2592000$/);
  } finally {
    await s.close();
  }
});

test('login: las claves mal se olvidan a los 15 minutos (4 errores hoy y 1 mañana no traban la entrada)', async () => {
  const s = await boot();
  try {
    const bad = () => call(s.port, { method: 'POST', path: '/crm/login', origin: s.origin, body: 'clave=mal' });
    for (let i = 0; i < 4; i++) assert.equal((await bad()).status, 401);
    await s.clock.advance(16 * 60_000);
    assert.equal((await bad()).status, 401);
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/login', origin: s.origin, body: `clave=${encodeURIComponent(PASSWORD)}` })).status, 303);
  } finally {
    await s.close();
  }
});

test('sin sesión no se ve nada; con sesión, la pantalla sale con las cabeceras de seguridad; la sesión vence a los 30 días y "Salir" la corta', async () => {
  const s = await boot();
  try {
    assert.equal((await call(s.port, { path: '/crm/parcial' })).status, 401);
    assert.equal((await call(s.port, { path: '/crm/', cookie: 'olimpo_crm=' + 'a'.repeat(64) })).status, 303);
    const cookie = await s.login();
    const r = await call(s.port, { path: '/crm/', cookie });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-security-policy']), /script-src 'self'.*frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'same-origin'); // con no-referrer, Chrome manda "Origin: null" en los formularios y el login nunca pasaría
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const p = await call(s.port, { path: '/crm/parcial?f=todos', cookie });
    assert.deepEqual(Object.keys(JSON.parse(p.body)).sort(), ['chat', 'list', 'status']);
    assert.equal((await call(s.port, { method: 'POST', path: '/crm/salir', origin: s.origin, cookie })).status, 303);
    assert.equal((await call(s.port, { path: '/crm/', cookie })).status, 303);
    const again = await s.login();
    await s.clock.advance(31 * 86_400_000);
    assert.equal((await call(s.port, { path: '/crm/parcial', cookie: again })).status, 401);
  } finally {
    await s.close();
  }
});

test('acciones: apagar/prender y sombra (con aviso al grupo), Lo tomo, Presupuesto mandado, mover a Perdido; Origin ajeno no hace nada', async () => {
  const s = await boot();
  try {
    const cookie = await s.login();
    const post = (body: string, accept = 'application/json', origin = s.origin) => call(s.port, { method: 'POST', path: '/crm/accion', origin, cookie, body, accept });
    assert.equal((await post('a=apagar', 'application/json', 'http://127.0.0.1:3000')).status, 403);
    assert.equal(getFlag(s.db, 'kill_switch'), false);

    const off = await post('a=apagar');
    assert.deepEqual(JSON.parse(off.body), { ok: true, text: 'Bot apagado: no contesta ni manda nada.' });
    assert.equal(getFlag(s.db, 'kill_switch'), true);
    await post('a=prender');
    assert.equal(getFlag(s.db, 'kill_switch'), false);
    assert.equal(s.calls.rescan, 1);
    await post('a=sombra_off');
    assert.equal(getFlag(s.db, 'shadow_mode'), false);
    await s.clock.flush();
    assert.deepEqual(s.notifier.alerts.map((a) => a.text.split(':')[0].split(' desde')[0]), ['Bot apagado', 'Bot prendido', 'Modo sombra apagado']);
    assert.deepEqual(listAudit(s.db, 'command').map((a) => a.detail), ['apagar (CRM)', 'prender (CRM)', 'sombra off (CRM)']);

    createConversation(s.db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: s.clock.now() });
    assert.equal(JSON.parse((await post('a=tomo&n=1')).body).text, 'Lo tomaste: el bot no le contesta más.');
    assert.equal(getConversation(s.db, CHAT)!.mode, 'humano');
    setStage(s.db, CHAT, 'a_presupuestar', s.clock.now());
    await post('a=presu&n=1');
    assert.equal(getConversation(s.db, CHAT)!.stage, 'presupuestado');
    assert.equal(getState(s.db, `quote_sent_utc.${CHAT}`), String(s.clock.now()));
    const noReason = await post('a=etapa&n=1&stage=perdido'); // Perdido pide el motivo
    assert.equal(noReason.status, 409);
    assert.match(JSON.parse(noReason.body).text, /por qué se perdió/);
    assert.equal(getConversation(s.db, CHAT)!.stage, 'presupuestado');
    await post('a=etapa&n=1&stage=perdido&reason=Precio');
    assert.deepEqual([getConversation(s.db, CHAT)!.stage, getConversation(s.db, CHAT)!.lostReason], ['perdido', 'Precio']);
    await post('a=etapa&n=1&stage=descartado&reason=Otro');
    await post('a=etapa&n=1&stage=descartado'); // la misma etapa sin motivo no borra el que tenía
    assert.deepEqual([getConversation(s.db, CHAT)!.stage, getConversation(s.db, CHAT)!.lostReason], ['descartado', 'Otro']);
    const bad = await post('a=etapa&n=1&stage=inventada');
    assert.equal(bad.status, 409);
    assert.equal((await post('a=tomo&n=99')).status, 409);
  } finally {
    await s.close();
  }
});

test('borradores desde el CRM: Mandar entra a la cola y despierta al enviador; Descartar; uno vencido no sale', async () => {
  const s = await boot();
  try {
    const cookie = await s.login();
    const post = (body: string) => call(s.port, { method: 'POST', path: '/crm/accion', origin: s.origin, cookie, body, accept: 'application/json' });
    setSetting(s.db, 'shadow_mode', '1');
    createConversation(s.db, { chatId: CHAT, session: 'default', mode: 'auto', nowMs: s.clock.now() });
    const m = insertMessage(s.db, { session: 'default', providerMsgId: 'p1', chatId: CHAT, author: 'customer', text: 'hola', tsUtcMs: s.clock.now() });
    const d1 = createDraft(s.db, { chatId: CHAT, contextVersion: 0, bubbles: ['Buenas'], material: [], nowMs: s.clock.now(), answersUpto: m.id });
    assert.equal(JSON.parse((await post(`a=mandar&d=${d1}`)).body).ok, true);
    assert.equal(getDraft(s.db, d1)!.status, 'mandado');
    assert.equal(s.calls.kick, 1);
    assert.equal((await post(`a=mandar&d=${d1}`)).status, 409); // dos veces no duplica
    const d2 = createDraft(s.db, { chatId: CHAT, contextVersion: 0, bubbles: ['Otra'], material: [], nowMs: s.clock.now(), answersUpto: m.id });
    await post(`a=descartar&d=${d2}`);
    assert.equal(getDraft(s.db, d2)!.status, 'descartado');
  } finally {
    await s.close();
  }
});

test('sin JavaScript: la acción vuelve a la misma pantalla con el resultado, y nunca a una URL de afuera', async () => {
  const s = await boot();
  try {
    const cookie = await s.login();
    const post = (body: string) => call(s.port, { method: 'POST', path: '/crm/accion', origin: s.origin, cookie, body });
    const r = await post(`a=apagar&back=${encodeURIComponent('/crm/?f=todos&chat=3')}`);
    assert.equal(r.status, 303);
    const to = new URL(String(r.headers.location), 'http://x');
    assert.deepEqual([to.pathname, to.searchParams.get('f'), to.searchParams.get('chat'), to.searchParams.get('msg')], ['/crm/', 'todos', '3', 'Bot apagado: no contesta ni manda nada.']);
    for (const evil of ['https://evil.example.com/', '//evil.example.com/crm/', '/crm/../waha', '/crmx/']) {
      const e = await post(`a=prender&back=${encodeURIComponent(evil)}`);
      assert.match(String(e.headers.location), /^\/crm\/\?msg=/);
    }
    assert.equal((await post(`a=prender&back=${'x'.repeat(17 * 1024)}`)).status, 413); // cuerpo de más de 16 KB
  } finally {
    await s.close();
  }
});

test('archivos fijos sin sesión; cualquier otro nombre (o un intento de salir de la carpeta) es 404; /health y /waha siguen igual', async () => {
  const s = await boot();
  try {
    const css = await call(s.port, { path: '/crm/static/crm.css' });
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /text\/css/);
    for (const p of ['/crm/static/../../.env', '/crm/static/%2e%2e%2f%2e%2e%2f.env', '/crm/static/server.ts', '/crm/static/', '/crm/static/constructor', '/crm/static/__proto__', '/crm/static/toString', '/crm/static/hasOwnProperty']) {
      assert.equal((await call(s.port, { path: p })).status, 404, p);
    }
    assert.equal(listAudit(s.db).filter((a) => a.kind === 'error').length, 0); // un pedido sin clave nunca escribe en la base
    // Rutas que no son URL válidas ("//", "//x"): 404 de siempre, sin excepción ni socket colgado.
    for (const p of ['//', '///', '//crm/', '//?x', '/\\', '//otro/crm/', 'http://otro/crm/']) assert.equal((await call(s.port, { path: p })).status, 404, p);
    assert.equal((await call(s.port, { path: '/health' })).status, 200);
    assert.equal((await call(s.port, { path: '/otra-cosa' })).status, 404);
    assert.equal((await call(s.port, { method: 'POST', path: '/waha', body: '{}' })).status, 401); // sin firma, como siempre
    assert.equal((await call(s.port, { path: '/crmx' })).status, 404);
  } finally {
    await s.close();
  }
});
