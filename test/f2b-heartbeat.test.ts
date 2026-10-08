// Latido a healthchecks.io (parte B): cada 60 s, y solo si la sesión está WORKING y la base responde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAudit, openDb } from '../src/db.ts';
import { createHeartbeat } from '../src/heartbeat.ts';
import { FakeClock } from './f2-helpers.ts';

const URL_PING = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555';
const min = (n: number) => n * 60_000;

function setup(o: { url?: string; working?: () => boolean; respond?: () => Response | Promise<Response> } = {}) {
  const clock = new FakeClock();
  const db = openDb(':memory:');
  const pings: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    pings.push(String(input));
    return o.respond ? o.respond() : new Response('OK');
  };
  const state = { working: true };
  const hb = createHeartbeat({ db, clock, url: o.url ?? URL_PING, isWorking: o.working ?? (() => state.working), fetch: fetchFn });
  return { clock, db, pings, hb, state };
}

test('con la sesión WORKING y la base andando, hace el ping', async () => {
  const { hb, pings } = setup();
  assert.equal(await hb.tick(), true);
  assert.deepEqual(pings, [URL_PING]);
});

test('si la sesión no está WORKING no hay ping, y vuelve apenas lo está', async () => {
  const { hb, pings, state } = setup();
  for (const s of ['SCAN_QR_CODE', 'FAILED', 'STOPPED', 'STARTING', 'UNREACHABLE']) {
    state.working = false;
    assert.equal(await hb.tick(), false, s);
  }
  assert.deepEqual(pings, []);
  state.working = true;
  assert.equal(await hb.tick(), true);
});

test('si la base no responde no hay ping', async () => {
  const { hb, pings, db } = setup();
  db.close();
  assert.equal(await hb.tick(), false);
  assert.deepEqual(pings, []);
});

test('sin HEALTHCHECKS_PING_URL no hace nada: ni ping ni temporizador', async () => {
  const { hb, pings, clock } = setup({ url: '' });
  assert.equal(await hb.tick(), false);
  hb.start();
  assert.equal(clock.pending, 0);
  await clock.advance(min(10));
  assert.deepEqual(pings, []);
});

test('el bucle late cada 60 s, se frena si la sesión se cae y con stop()', async () => {
  const { hb, pings, clock, state } = setup();
  hb.start();
  await clock.advance(min(5));
  assert.equal(pings.length, 6); // al arrancar y después cada minuto
  state.working = false;
  await clock.advance(min(5));
  assert.equal(pings.length, 6); // sin sesión no late: healthchecks avisa que el bot dejó de andar
  state.working = true;
  await clock.advance(min(1));
  assert.equal(pings.length, 7);
  hb.stop();
  await clock.advance(min(5));
  assert.equal(pings.length, 7);
});

test('si healthchecks no contesta no se rompe nada: se anota una vez (sin la URL) y sigue', async () => {
  let fail = true;
  const { hb, clock, db } = setup({ respond: () => { if (fail) throw new TypeError('fetch failed'); return new Response('OK'); } });
  hb.start();
  await clock.advance(min(4));
  assert.equal(await hb.tick(), false);
  const errors = listAudit(db, 'error');
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].detail.includes('hc-ping.com'));
  fail = false;
  assert.equal(await hb.tick(), true);
  fail = true;
  await hb.tick();
  assert.equal(listAudit(db, 'error').length, 2); // volvió y se cayó de nuevo: otra anotación
  hb.stop();
});

test('una respuesta 5xx de healthchecks cuenta como falla', async () => {
  const { hb } = setup({ respond: () => new Response('boom', { status: 502 }) });
  assert.equal(await hb.tick(), false);
});
