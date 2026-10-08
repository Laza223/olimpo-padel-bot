// Sesión de WAHA (parte B): crear y arrancar con el webhook sin duplicar, vigilar el estado cada 60 s y por eventos, avisar una vez por cambio, sin bucles de logout ni reconexión.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WahaChannel } from '../src/channel/waha.ts';
import { openDb } from '../src/db.ts';
import { createSession } from '../src/session.ts';
import { setState } from '../src/settings.ts';
import { FakeClock, FakeNotifier } from './f2-helpers.ts';
import { FakeWaha, WAHA_KEY } from './f2b-helpers.ts';

const WEBHOOK = 'http://bot:8080/waha';
const HMAC = 'secreto-hmac-de-prueba';
const min = (n: number) => n * 60_000;
const sec = (n: number) => n * 1000;

function setup(o: { apiKey?: string; hmac?: string; db?: ReturnType<typeof openDb>; clock?: FakeClock } = {}) {
  const clock = o.clock ?? new FakeClock();
  const db = o.db ?? openDb(':memory:');
  const waha = new FakeWaha();
  const notifier = new FakeNotifier();
  const channel = new WahaChannel({ baseUrl: 'http://waha:3000', apiKey: o.apiKey ?? WAHA_KEY, fetch: waha.fetch });
  const observed: [string, string | undefined][] = [];
  const mk = () => createSession({
    db, clock, notifier, channel, wahaUrl: 'http://waha:3000', apiKey: o.apiKey ?? WAHA_KEY, webhookUrl: WEBHOOK, hmacSecret: o.hmac ?? HMAC, fetch: waha.fetch,
    onObserve: (status, previous) => observed.push([status, previous]),
  });
  const session = mk();
  const setStatus = (status: string) => { waha.session!.status = status; };
  return { clock, db, waha, notifier, channel, session, observed, mk, setStatus };
}
const urgent = (n: FakeNotifier) => n.alerts.filter((a) => a.urgent);

test('ensure: crea la sesión y la arranca con el webhook completo (eventos, HMAC, reintentos)', async () => {
  const { waha, session } = setup();
  await session.ensure();
  const post = waha.callsTo('/api/sessions', 'POST');
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, {
    name: 'default',
    start: true,
    config: {
      ignore: { status: true, groups: true, channels: true, broadcast: true },
      webhooks: [{
        url: WEBHOOK,
        events: ['message.any', 'message.ack', 'message.revoked', 'message.edited', 'session.status'],
        hmac: { key: HMAC },
        retries: { delaySeconds: 2, attempts: 15, policy: 'exponential' },
      }],
    },
  });
  assert.ok(waha.calls.every((c) => c.key === WAHA_KEY)); // toda llamada lleva la clave
});

test('ensure es idempotente: con la sesión ya creada y bien configurada no crea, no actualiza y no reinicia', async () => {
  const { waha, session, mk } = setup();
  await session.ensure();
  await session.ensure();
  await mk().ensure(); // otro arranque del bot
  assert.equal(waha.callsTo('/api/sessions', 'POST').length, 1);
  assert.equal(waha.callsTo(/\/api\/sessions\/default$/, 'PUT').length, 0);
  assert.equal(waha.callsTo(/\/start$/).length, 0);
});

test('ensure: si la sesión está detenida la arranca una vez; si la config cambió (otro secreto) la actualiza con PUT', async () => {
  const a = setup();
  await a.session.ensure();
  a.setStatus('STOPPED');
  await a.session.ensure();
  assert.equal(a.waha.callsTo(/\/start$/, 'POST').length, 1);
  assert.equal(a.waha.callsTo('/api/sessions', 'POST').length, 1);
  // se rotó el secreto del HMAC: WAHA tiene la clave vieja
  const b = setup();
  await b.session.ensure();
  const rotated = createSession({ db: b.db, clock: b.clock, notifier: b.notifier, channel: b.channel, wahaUrl: 'http://waha:3000', apiKey: WAHA_KEY, webhookUrl: WEBHOOK, hmacSecret: 'otro-secreto', fetch: b.waha.fetch });
  await rotated.ensure();
  const put = b.waha.callsTo('/api/sessions/default', 'PUT');
  assert.equal(put.length, 1);
  assert.equal(put[0].body!.config.webhooks[0].hmac.key, 'otro-secreto');
  assert.equal(b.waha.callsTo('/api/sessions', 'POST').length, 1); // no se vuelve a crear
});

test('ensure: si la creación choca con una sesión que ya existe (carrera entre dos arranques), no falla ni la pisa', async () => {
  const { waha, session } = setup();
  await session.ensure();
  waha.ghost404 = 1; // el GET dice que no existe, el POST dice que sí
  await session.ensure();
  assert.equal(waha.callsTo('/api/sessions', 'POST').length, 2); // intentó crearla...
  assert.equal(waha.callsTo('/api/sessions/default', 'PUT').length, 0); // ...y al ver que ya estaba bien, la dejó como estaba
});

test('avisa una sola vez por cambio de estado (SCAN_QR_CODE, FAILED, STOPPED) aunque se consulte muchas veces', async () => {
  const { waha, notifier, session, setStatus } = setup();
  await session.check(); // crea y consulta: STARTING
  assert.equal(notifier.alerts.length, 0);
  setStatus('SCAN_QR_CODE');
  for (let i = 0; i < 5; i++) await session.check();
  assert.equal(urgent(notifier).length, 1);
  assert.match(notifier.alerts[0].text, /QR/);
  assert.match(notifier.alerts[0].text, /\/qr/);
  setStatus('WORKING');
  for (let i = 0; i < 3; i++) await session.check();
  assert.equal(notifier.alerts.length, 1); // volver a la normalidad no avisa
  setStatus('FAILED');
  for (let i = 0; i < 5; i++) await session.check();
  assert.equal(urgent(notifier).length, 2);
  assert.match(notifier.alerts[1].text, /FAILED/);
  setStatus('STOPPED');
  for (let i = 0; i < 5; i++) await session.check();
  assert.equal(urgent(notifier).length, 3);
  assert.match(notifier.alerts[2].text, /detenida/);
  setStatus('WORKING');
  await session.check();
  setStatus('SCAN_QR_CODE'); // otra vez: es otro cambio, avisa de nuevo
  await session.check();
  assert.equal(urgent(notifier).length, 4);
  // ni un logout, stop, restart ni borrado, y la sesión se creó una sola vez
  assert.deepEqual(waha.disruptive, []);
  assert.equal(waha.callsTo('/api/sessions', 'POST').length, 1);
  assert.equal(waha.callsTo(/\/start$/).length, 0);
  assert.equal(waha.callsTo(/\/auth\/qr$/).length, 0); // y no pide QR solo
});

test('los eventos session.status del webhook también avisan, sin duplicar con el chequeo periódico', async () => {
  const { db, clock, waha, notifier, session, setStatus } = setup();
  await session.check();
  setState(db, 'session_status', 'FAILED'); // lo que deja el ingest cuando llega el evento
  setState(db, 'session_status_utc', String(clock.now()));
  session.syncFromEvents();
  assert.equal(urgent(notifier).length, 1);
  session.syncFromEvents(); // el mismo evento otra vez
  assert.equal(urgent(notifier).length, 1);
  assert.equal(session.current(), 'FAILED');
  setStatus('FAILED'); // y el chequeo de los 60 s ve lo mismo
  await session.check();
  assert.equal(urgent(notifier).length, 1);
  assert.deepEqual(waha.disruptive, []);
});

test('un reinicio del bot con el mismo estado no vuelve a avisar; con otro estado, sí', async () => {
  const a = setup();
  await a.session.check();
  a.setStatus('SCAN_QR_CODE');
  await a.session.check();
  assert.equal(urgent(a.notifier).length, 1);
  const reboot = a.mk(); // mismo db: el bot se reinició y WAHA sigue pidiendo el QR
  await reboot.check();
  assert.equal(urgent(a.notifier).length, 1);
  a.setStatus('FAILED');
  await reboot.check();
  assert.equal(urgent(a.notifier).length, 2);
});

test('WAHA caído: avisa recién a los 2 minutos y una sola vez; no hay aviso por volver', async () => {
  const { clock, waha, notifier, session, setStatus } = setup();
  await session.check();
  setStatus('WORKING');
  await session.check();
  waha.down = true;
  await session.check();
  await clock.advance(min(1));
  await session.check();
  assert.equal(notifier.alerts.length, 0); // WAHA reiniciando un rato no es una caída
  await clock.advance(min(1));
  for (let i = 0; i < 4; i++) await session.check();
  assert.equal(urgent(notifier).length, 1);
  assert.match(notifier.alerts[0].text, /No puedo hablar con WAHA/);
  assert.equal(session.current(), 'UNREACHABLE');
  waha.down = false;
  await session.check();
  assert.equal(session.current(), 'WORKING');
  assert.equal(notifier.alerts.length, 1);
  waha.down = true;
  await session.check();
  await clock.advance(min(2));
  await session.check();
  assert.equal(urgent(notifier).length, 2); // se cayó de nuevo: otro aviso
  assert.deepEqual(waha.disruptive, []);
});

test('clave de WAHA rechazada (401): avisa enseguida y una sola vez, sin insistir', async () => {
  const { waha, notifier, session } = setup({ apiKey: 'clave-equivocada' });
  for (let i = 0; i < 4; i++) await session.check();
  assert.equal(urgent(notifier).length, 1);
  assert.match(notifier.alerts[0].text, /rechazó la clave/);
  assert.equal(session.current(), 'AUTH_ERROR');
  assert.deepEqual(waha.disruptive, []);
});

test('el arranque reintenta hasta que WAHA responde, con chequeos de 5 s al principio y de 60 s después', async () => {
  const { clock, waha, notifier, session, setStatus } = setup();
  waha.down = true; // WAHA todavía levantando cuando arranca el bot
  session.start();
  await clock.advance(sec(12));
  assert.equal(waha.callsTo('/api/sessions', 'POST').length, 0);
  waha.down = false;
  await clock.advance(sec(5));
  assert.equal(waha.callsTo('/api/sessions', 'POST').length, 1); // se creó apenas volvió
  assert.equal(session.current(), 'STARTING');
  setStatus('SCAN_QR_CODE');
  await clock.advance(sec(5));
  assert.equal(urgent(notifier).length, 1);
  const gets = () => waha.callsTo('/api/sessions/default', 'GET').length;
  const before = gets();
  await clock.advance(min(3));
  assert.ok(gets() - before >= 2 && gets() - before <= 4, `chequeos en 3 min: ${gets() - before}`); // cada 60 s
  session.stop();
  const after = gets();
  await clock.advance(min(5));
  assert.equal(gets(), after);
});

test('onObserve recibe el estado nuevo y el anterior en cada observación (lo usa la reconciliación)', async () => {
  const { observed, session, setStatus } = setup();
  await session.check();
  setStatus('WORKING');
  await session.check();
  await session.check();
  assert.deepEqual(observed, [['STARTING', undefined], ['WORKING', 'STARTING'], ['WORKING', 'WORKING']]);
});

test('qr: devuelve la imagen cuando WAHA espera el escaneo; si no, explica por qué', async () => {
  const { session, setStatus, waha } = setup();
  await session.ensure();
  setStatus('SCAN_QR_CODE');
  const qr = await session.qr();
  assert.equal(qr.mimetype, 'image/png');
  assert.deepEqual([...qr.data], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  setStatus('WORKING');
  await assert.rejects(() => session.qr(), /422/);
  assert.equal(waha.callsTo(/\/auth\/qr$/).length, 2);
});

test('la clave del HMAC no aparece en los avisos ni en la auditoría', async () => {
  const { db, notifier, session, setStatus } = setup();
  await session.check();
  setStatus('FAILED');
  await session.check();
  const audit = db.prepare('SELECT detail FROM audit').all() as { detail: string }[];
  assert.ok(![...notifier.alerts.map((a) => a.text), ...audit.map((a) => a.detail)].some((t) => t.includes(HMAC) || t.includes(WAHA_KEY)));
});
