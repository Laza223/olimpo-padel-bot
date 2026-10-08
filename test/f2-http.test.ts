// Webhook /waha: HMAC con comparación constante, 401 sin guardar nada, 200 apenas se guarda, sin duplicar; y /health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { openDb, claimInboundEvents, pendingInboundCount } from '../src/db.ts';
import { createHttpServer, handleWebhook, signBody, verifyHmac } from '../src/http.ts';
import type { Clock } from '../src/clock.ts';

const NOW = Date.UTC(2026, 9, 7, 17, 0);
const clock: Clock = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => {} };
const SECRET = 'secreto-de-prueba';
const body = (o: object = {}) => JSON.stringify({ id: 'evt_01', event: 'message.any', session: 'default', payload: {}, ...o });

function setup() {
  const db = openDb(':memory:');
  let stored = 0;
  const deps = { db, secret: SECRET, clock, onStored: () => void stored++ };
  return { db, deps, stored: () => stored };
}

test('HMAC: la firma correcta pasa; cualquier otra cosa (mala, vacía, corta, larga, no hex) no, y nunca tira', () => {
  const raw = body();
  const good = signBody(raw, SECRET);
  assert.equal(good.length, 128); // sha512 en hex
  assert.equal(verifyHmac(raw, good, SECRET), true);
  assert.equal(verifyHmac(raw, good.toUpperCase(), SECRET), true); // el hex no distingue mayúsculas
  assert.equal(verifyHmac(Buffer.from(raw), good, SECRET), true);
  assert.equal(verifyHmac(raw, signBody(raw, 'otra-clave'), SECRET), false);
  assert.equal(verifyHmac(raw + ' ', good, SECRET), false);
  for (const bad of [undefined, '', 'zz', good.slice(0, 64), good + 'ab', 'x'.repeat(128), good.replace(/.$/, good.endsWith('0') ? '1' : '0')]) {
    assert.equal(verifyHmac(raw, bad, SECRET), false, String(bad));
  }
  assert.equal(verifyHmac(raw, good, ''), false); // sin clave configurada no se acepta nada
});

test('webhook con firma válida: guarda el evento, avisa y responde 200', () => {
  const { db, deps, stored } = setup();
  const raw = body();
  assert.deepEqual(handleWebhook(deps, raw, signBody(raw, SECRET)), { status: 200, body: '{"ok":true}' });
  assert.equal(stored(), 1);
  const [ev] = claimInboundEvents(db, NOW, 1000, 10);
  assert.equal(ev.eventKey, 'evt_01');
  assert.equal(ev.payload, raw); // el cuerpo crudo, tal cual
});

test('webhook duplicado (mismo id de evento): 200 pero un solo registro y un solo aviso', () => {
  const { db, deps, stored } = setup();
  const raw = body();
  const sig = signBody(raw, SECRET);
  assert.equal(handleWebhook(deps, raw, sig).status, 200);
  assert.equal(handleWebhook(deps, raw, sig).status, 200);
  assert.equal(pendingInboundCount(db), 1);
  assert.equal(stored(), 1);
});

test('sin firma o con firma falsa: 401 y no se guarda nada', () => {
  const { db, deps, stored } = setup();
  const raw = body();
  assert.equal(handleWebhook(deps, raw, undefined).status, 401);
  assert.equal(handleWebhook(deps, raw, 'abcd').status, 401);
  assert.equal(handleWebhook(deps, raw, signBody(raw, 'otra')).status, 401);
  assert.equal(handleWebhook(deps, body({ id: 'evt_02' }), signBody(raw, SECRET)).status, 401); // firma de otro cuerpo
  assert.equal(pendingInboundCount(db), 0);
  assert.equal(stored(), 0);
});

test('firma válida pero el cuerpo no es un objeto JSON: 400 y no se guarda', () => {
  const { db, deps } = setup();
  for (const raw of ['no es json', '[]', '"hola"', '42', 'null', '']) {
    assert.equal(handleWebhook(deps, raw, signBody(raw, SECRET)).status, 400, raw);
  }
  assert.equal(pendingInboundCount(db), 0);
});

test('sin id de evento, la clave es el hash del cuerpo: el mismo cuerpo no se repite y otro distinto sí entra', () => {
  const { db, deps } = setup();
  const a = JSON.stringify({ event: 'message.any', payload: { n: 1 } });
  const b = JSON.stringify({ event: 'message.any', payload: { n: 2 } });
  for (const raw of [a, a, b]) handleWebhook(deps, raw, signBody(raw, SECRET));
  const keys = claimInboundEvents(db, NOW, 1000, 10).map((e) => e.eventKey);
  assert.deepEqual(keys, [`sha256:${createHash('sha256').update(a).digest('hex')}`, `sha256:${createHash('sha256').update(b).digest('hex')}`]);
});

test('si la base falla, 500 (WAHA reintenta); nunca un 200 sin haber guardado', () => {
  const { db, deps, stored } = setup();
  db.exec('DROP TABLE inbound_events');
  const raw = body();
  assert.equal(handleWebhook(deps, raw, signBody(raw, SECRET)).status, 500);
  assert.equal(stored(), 0);
});

test('servidor real en 127.0.0.1: /waha con y sin firma, /health, métodos y rutas raras, cuerpo enorme', async () => {
  const { db, deps, stored } = setup();
  const server = createHttpServer({ ...deps, health: () => ({ ok: true, pending: pendingInboundCount(db) }) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const raw = body();
    const ok = await fetch(`${base}/waha`, { method: 'POST', headers: { 'X-Webhook-Hmac': signBody(raw, SECRET), 'X-Webhook-Hmac-Algorithm': 'sha512', 'Content-Type': 'application/json' }, body: raw });
    assert.equal(ok.status, 200);
    assert.equal(stored(), 1);
    const noSig = await fetch(`${base}/waha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body({ id: 'evt_x' }) });
    assert.equal(noSig.status, 401);
    assert.equal(pendingInboundCount(db), 1);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, pending: 1 });
    assert.equal((await fetch(`${base}/waha`)).status, 405);
    assert.equal((await fetch(`${base}/otra-cosa`)).status, 404);
    const big = 'x'.repeat(6 * 1024 * 1024);
    const huge = await fetch(`${base}/waha`, { method: 'POST', body: big });
    assert.equal(huge.status, 413);
    assert.equal(pendingInboundCount(db), 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('sin clave HMAC configurada el servidor no arranca (nunca se acepta un webhook sin firmar)', () => {
  const { deps } = setup();
  assert.throws(() => createHttpServer({ ...deps, secret: '', health: () => ({}) }), /WAHA_WEBHOOK_HMAC_SECRET/);
});
