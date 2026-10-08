// Adaptador de WAHA (2026.9.2, WEBJS): traduce los webhooks a eventos propios y las operaciones del negocio a llamadas REST.
// Las formas salen de docs/waha-endpoints.md (Swagger real + un session.status real); lo marcado SIN VERIFICAR allá se prueba acá con entradas defensivas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChannelError } from '../src/channel/types.ts';
import { WahaChannel, normalizeTsMs } from '../src/channel/waha.ts';

const SEC = 1_791_417_457; // 7-oct-2026 en segundos
const MS = SEC * 1000;

const channel = new WahaChannel({ baseUrl: 'http://waha:3000', apiKey: 'k', session: 'default' });
const parse = (raw: unknown) => channel.parseEvent(raw);

const envelope = (event: string, payload: unknown, extra: Record<string, unknown> = {}) => ({ id: 'evt_01', timestamp: MS, event, session: 'default', me: null, payload, engine: 'WEBJS', ...extra });
const wamessage = (o: Record<string, unknown> = {}) => ({
  id: 'false_5491155550000@c.us_3EB0AAAA', timestamp: SEC, from: '5491155550000@c.us', to: '5491100000000@c.us', fromMe: false, body: 'Hola', hasMedia: false, ack: 1, _data: { type: 'chat', notifyName: 'Pedro' }, ...o,
});

// ---------- timestamps ----------
test('timestamps: menor que 1e12 son segundos, desde 1e12 son milisegundos; lo que no es número válido no es nada', () => {
  assert.equal(normalizeTsMs(SEC), MS);
  assert.equal(normalizeTsMs(MS), MS);
  assert.equal(normalizeTsMs(999_999_999_999), 999_999_999_999_000); // el borde: menor que 1e12 se toma como segundos
  assert.equal(normalizeTsMs(1_000_000_000_000), 1_000_000_000_000);
  for (const bad of [0, -5, NaN, Infinity, '1791417457', null, undefined, {}]) assert.equal(normalizeTsMs(bad), undefined, String(bad));
});

// ---------- message.any ----------
test('mensaje entrante @c.us: el chat es "from", la hora se normaliza y se guarda el nombre de perfil', () => {
  assert.deepEqual(parse(envelope('message.any', wamessage())), {
    kind: 'message', session: 'default', chatId: '5491155550000@c.us', providerMsgId: 'false_5491155550000@c.us_3EB0AAAA', tsUtcMs: MS, text: 'Hola', profileName: 'Pedro',
  });
});

test('mensaje entrante @lid: el chatId queda tal cual, sin reconstruir un teléfono', () => {
  const ev = parse(envelope('message.any', wamessage({ id: 'false_2468@lid_X1', from: '2468@lid' })));
  assert.equal(ev.kind, 'message');
  assert.equal((ev as { chatId: string }).chatId, '2468@lid');
});

test('la hora llega en segundos o en milisegundos y sale siempre en ms', () => {
  assert.equal((parse(envelope('message.any', wamessage({ timestamp: SEC }))) as { tsUtcMs: number }).tsUtcMs, MS);
  assert.equal((parse(envelope('message.any', wamessage({ timestamp: MS }))) as { tsUtcMs: number }).tsUtcMs, MS);
});

test('mensaje propio: el chat es "to" y se distingue lo que mandó el bot (api) de lo escrito en el celular (app)', () => {
  const own = (source?: string) => parse(envelope('message.any', wamessage({ id: 'true_5491155550000@c.us_B1', fromMe: true, from: '5491100000000@c.us', to: '5491155550000@c.us', source, body: 'Buenas tardes' })));
  assert.deepEqual(own('api'), { kind: 'own_message', session: 'default', chatId: '5491155550000@c.us', providerMsgId: 'true_5491155550000@c.us_B1', tsUtcMs: MS, text: 'Buenas tardes', source: 'api' });
  assert.equal((own('app') as { source: string }).source, 'app');
  assert.equal((own(undefined) as { source: string }).source, 'unknown');
  assert.equal((own('otro') as { source: string }).source, 'unknown');
});

test('solo chats 1 a 1: grupos, estados, canales y difusiones se ignoran', () => {
  for (const from of ['120363000000@g.us', 'status@broadcast', '1203@newsletter', '5491100000000@broadcast', 'raro']) {
    assert.deepEqual(parse(envelope('message.any', wamessage({ from }))), { kind: 'ignored', reason: 'not_direct_chat' }, from);
  }
  assert.deepEqual(parse(envelope('message.any', wamessage({ fromMe: true, to: '120363000000@g.us' }))), { kind: 'ignored', reason: 'not_direct_chat' });
});

test('mensajes de sistema (notificaciones, protocolo, cifrado) se ignoran', () => {
  for (const type of ['e2e_notification', 'notification', 'notification_template', 'gp2', 'protocol', 'revoked', 'ciphertext', 'call_log', 'broadcast_notification']) {
    const ev = parse(envelope('message.any', wamessage({ body: '', _data: { type } })));
    assert.deepEqual(ev, { kind: 'ignored', reason: `system_${type}` }, type);
  }
});

test('adjuntos: el tipo sale de _data.type; con leyenda trae texto, sin leyenda texto vacío', () => {
  const media = (type: string, body = '') => parse(envelope('message.any', wamessage({ hasMedia: true, body, _data: { type } }))) as { media?: string; text: string };
  assert.deepEqual([media('ptt').media, media('ptt').text], ['audio', '']);
  assert.equal(media('audio').media, 'audio');
  assert.equal(media('image', 'mirá esto').media, 'image');
  assert.equal(media('image', 'mirá esto').text, 'mirá esto');
  assert.equal(media('video').media, 'video');
  assert.equal(media('document').media, 'document');
  assert.equal(media('sticker').media, 'sticker');
  assert.equal(media('algo_nuevo').media, 'other');
  const noMeta = parse(envelope('message.any', wamessage({ hasMedia: true, body: '', _data: undefined }))) as { media?: string };
  assert.equal(noMeta.media, 'other'); // sin _data no se sabe el tipo, pero hay adjunto
});

test('ubicación o contacto sin texto cuentan como adjunto "other" (no abren turno)', () => {
  for (const type of ['location', 'vcard', 'multi_vcard']) {
    const ev = parse(envelope('message.any', wamessage({ body: '', hasMedia: false, _data: { type } }))) as { kind: string; media?: string };
    assert.deepEqual([ev.kind, ev.media], ['message', 'other'], type);
  }
});

test('un mensaje de texto vacío o sin id ni hora no es nada', () => {
  assert.deepEqual(parse(envelope('message.any', wamessage({ body: '', _data: { type: 'chat' } }))), { kind: 'ignored', reason: 'empty' });
  assert.deepEqual(parse(envelope('message.any', wamessage({ id: undefined }))), { kind: 'ignored', reason: 'message_without_id' });
  assert.deepEqual(parse(envelope('message.any', wamessage({ timestamp: undefined }))), { kind: 'ignored', reason: 'message_without_timestamp' });
});

// ---------- ack / revoked / edited / session ----------
test('ack: -1 falló, 0 pendiente, 1 servidor, 2 dispositivo, 3 y 4 leído; sin número se usa ackName', () => {
  const ack = (payload: Record<string, unknown>) => parse(envelope('message.ack', { id: 'true_c@c.us_B', from: 'x', to: 'y', fromMe: true, ...payload }));
  assert.deepEqual(ack({ ack: -1 }), { kind: 'ack', providerMsgId: 'true_c@c.us_B', status: 'failed' });
  assert.equal((ack({ ack: 0 }) as { status: string }).status, 'pending');
  assert.equal((ack({ ack: 1 }) as { status: string }).status, 'sent');
  assert.equal((ack({ ack: 2 }) as { status: string }).status, 'delivered');
  assert.equal((ack({ ack: 3 }) as { status: string }).status, 'read');
  assert.equal((ack({ ack: 4 }) as { status: string }).status, 'read');
  assert.equal((ack({ ack: undefined, ackName: 'DEVICE' }) as { status: string }).status, 'delivered');
  assert.deepEqual(ack({ ack: 99 }), { kind: 'ignored', reason: 'ack_unknown' });
  assert.deepEqual(parse(envelope('message.ack', { ack: 1 })), { kind: 'ignored', reason: 'ack_without_id' });
});

test('borrado: usa el id completo de "before" y el chat; si falta, el id corto y el chat de "after"; sin chat se ignora', () => {
  const before = wamessage({ id: 'false_5491155550000@c.us_3EB0AAAA' });
  assert.deepEqual(parse(envelope('message.revoked', { revokedMessageId: '3EB0AAAA', before, after: wamessage({ id: 'false_5491155550000@c.us_NEW' }) })), {
    kind: 'revoke', session: 'default', chatId: '5491155550000@c.us', providerMsgId: 'false_5491155550000@c.us_3EB0AAAA',
  });
  assert.deepEqual(parse(envelope('message.revoked', { revokedMessageId: '3EB0AAAA', after: wamessage({ id: 'x' }) })), {
    kind: 'revoke', session: 'default', chatId: '5491155550000@c.us', providerMsgId: '3EB0AAAA',
  });
  assert.deepEqual(parse(envelope('message.revoked', { revokedMessageId: '3EB0AAAA' })), { kind: 'ignored', reason: 'revoked_without_chat' });
  assert.deepEqual(parse(envelope('message.revoked', { revokedMessageId: 'X', before: wamessage({ from: '1@g.us' }) })), { kind: 'ignored', reason: 'not_direct_chat' });
});

test('edición: el id del original (editedMessageId) y el texto nuevo', () => {
  assert.deepEqual(parse(envelope('message.edited', wamessage({ id: 'false_5491155550000@c.us_NEWID', editedMessageId: '3EB0AAAA', body: 'Hola, corrijo' }))), {
    kind: 'edit', session: 'default', chatId: '5491155550000@c.us', providerMsgId: '3EB0AAAA', text: 'Hola, corrijo',
  });
  // sin editedMessageId, el id del propio evento
  assert.equal((parse(envelope('message.edited', wamessage({ body: 'x' }))) as { providerMsgId: string }).providerMsgId, 'false_5491155550000@c.us_3EB0AAAA');
});

test('session.status: el estado de la sesión (forma real comprobada)', () => {
  const real = { id: 'evt_01m4cct6x0z8gm4j8gs3k2fb0p', timestamp: MS, event: 'session.status', session: 'default', me: null, payload: { name: 'default', status: 'SCAN_QR_CODE', statuses: [], data: null }, engine: 'WEBJS' };
  assert.deepEqual(parse(real), { kind: 'session_status', session: 'default', status: 'SCAN_QR_CODE' });
});

test('lo que no se entiende es "ignored" y nunca tira', () => {
  for (const raw of [null, undefined, 'hola', 42, [], {}, { event: 5 }, envelope('message.reaction', {}), envelope('group.v2.join', {}), envelope('message.any', null), envelope('message.any', 'x'), envelope('session.status', {})]) {
    const ev = parse(raw);
    assert.equal(ev.kind, 'ignored', JSON.stringify(raw));
  }
  assert.deepEqual(parse(envelope('presence.update', {})), { kind: 'ignored', reason: 'event_presence.update' });
});

// ---------- llamadas REST ----------
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
function fakeFetch(respond: (call: Call) => Response | Promise<Response> | never) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wahaWith = (respond: (c: Call) => Response | Promise<Response>) => {
  const f = fakeFetch(respond);
  return { ...f, ch: new WahaChannel({ baseUrl: 'http://waha:3000/', apiKey: 'secreta', session: 'default', fetch: f.fetchFn }) };
};

test('sendText: POST /api/sendText con la clave, la sesión y el chatId tal cual; devuelve el id del mensaje', async () => {
  const { ch, calls } = wahaWith(() => json({ id: 'true_2468@lid_ABC', timestamp: SEC }));
  assert.deepEqual(await ch.sendText('2468@lid', 'Buenas tardes'), { providerMsgId: 'true_2468@lid_ABC' });
  assert.equal(calls[0].url, 'http://waha:3000/api/sendText');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['X-Api-Key'], 'secreta');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { session: 'default', chatId: '2468@lid', text: 'Buenas tardes' });
});

test('sendImage: lee el archivo local y lo manda en base64 con tipo, nombre y leyenda', async () => {
  const path = new URL('../assets/fabricacion-panos-1.jpg', import.meta.url);
  const { ch, calls } = wahaWith(() => json({ id: 'true_c@c.us_IMG1' }));
  assert.deepEqual(await ch.sendImage('5491155550000@c.us', fileURLToPath(path), 'Te paso fotos'), { providerMsgId: 'true_c@c.us_IMG1' });
  assert.equal(calls[0].url, 'http://waha:3000/api/sendImage');
  const body = calls[0].body as { session: string; chatId: string; caption: string; file: { mimetype: string; filename: string; data: string } };
  assert.deepEqual([body.session, body.chatId, body.caption, body.file.mimetype, body.file.filename], ['default', '5491155550000@c.us', 'Te paso fotos', 'image/jpeg', 'fabricacion-panos-1.jpg']);
  assert.equal(body.file.data, readFileSync(path).toString('base64'));
});

test('sendImage sin leyenda no manda el campo; un archivo que no existe es transient (nunca va a salir)', async () => {
  const path = fileURLToPath(new URL('../assets/fabricacion-panos-1.jpg', import.meta.url));
  const { ch, calls } = wahaWith(() => json({ id: 'x' }));
  await ch.sendImage('c@c.us', path);
  assert.equal('caption' in (calls[0].body as object), false);
  await assert.rejects(ch.sendImage('c@c.us', '/no/existe.jpg'), (e: unknown) => e instanceof ChannelError && e.type === 'transient' && /archivo/.test(e.message));
});

test('markSeen y typing: sendSeen con los ids completos, startTyping y stopTyping', async () => {
  const { ch, calls } = wahaWith(() => json({}));
  await ch.markSeen('c@c.us', ['false_c@c.us_A', 'false_c@c.us_B']);
  await ch.typing('c@c.us', true);
  await ch.typing('c@c.us', false);
  assert.deepEqual(calls.map((c) => c.url.replace('http://waha:3000', '')), ['/api/sendSeen', '/api/startTyping', '/api/stopTyping']);
  assert.deepEqual(calls[0].body, { session: 'default', chatId: 'c@c.us', messageIds: ['false_c@c.us_A', 'false_c@c.us_B'] });
  assert.deepEqual(calls[1].body, { session: 'default', chatId: 'c@c.us' });
});

test('sessionStatus: lee el estado; una sesión que no existe es STOPPED; otros errores se propagan', async () => {
  const ok = wahaWith(() => json({ name: 'default', status: 'WORKING' }, 200));
  assert.equal(await ok.ch.sessionStatus(), 'WORKING');
  assert.equal(ok.calls[0].url, 'http://waha:3000/api/sessions/default');
  const missing = wahaWith(() => json({ message: 'Session not found', statusCode: 404 }, 404));
  assert.equal(await missing.ch.sessionStatus(), 'STOPPED');
  const down = wahaWith(() => json({ message: 'boom' }, 500));
  await assert.rejects(down.ch.sessionStatus(), ChannelError);
});

test('messagesSince: pide con límite, orden descendente, filtro en segundos y merge=false; devuelve ascendente y sin lo anterior al corte', async () => {
  const { ch, calls } = wahaWith(() =>
    json([
      { id: 'true_c@c.us_B', timestamp: SEC + 20, fromMe: true, body: 'respuesta' },
      { id: 'false_c@c.us_A', timestamp: SEC + 10, fromMe: false, body: 'consulta' },
      { id: 'false_c@c.us_OLD', timestamp: SEC - 500, fromMe: false, body: 'vieja' },
      { id: 'false_c@c.us_NOTS', fromMe: false, body: 'sin hora' },
    ], 200),
  );
  const got = await ch.messagesSince('c@c.us', MS, 30);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/api/default/chats/c%40c.us/messages');
  assert.deepEqual(Object.fromEntries(u.searchParams), { limit: '30', sortOrder: 'desc', 'filter.timestamp.gte': String(SEC), merge: 'false' });
  assert.deepEqual(got, [
    { providerMsgId: 'false_c@c.us_A', fromMe: false, tsUtcMs: (SEC + 10) * 1000, text: 'consulta' },
    { providerMsgId: 'true_c@c.us_B', fromMe: true, tsUtcMs: (SEC + 20) * 1000, text: 'respuesta' },
  ]);
});

test('messagesSince: si WAHA no devuelve un arreglo, es un error del canal (no una historia vacía)', async () => {
  const { ch } = wahaWith(() => json({ error: 'raro' }, 200));
  await assert.rejects(ch.messagesSince('c@c.us', 0, 10), (e: unknown) => e instanceof ChannelError && e.type === 'transient');
});

test('chatsActiveSince: usa el resumen de chats, solo 1 a 1 y con último mensaje desde el corte', async () => {
  const { ch, calls } = wahaWith(() =>
    json([
      { id: 'a@c.us', lastMessage: { timestamp: SEC + 5 } },
      { id: 'b@lid', lastMessage: { timestamp: MS + 5000 } },
      { id: 'viejo@c.us', lastMessage: { timestamp: SEC - 9999 } },
      { id: '1203@g.us', lastMessage: { timestamp: SEC + 5 } },
      { id: 'sin-ultimo@c.us' },
    ], 200),
  );
  assert.deepEqual(await ch.chatsActiveSince(MS), ['a@c.us', 'b@lid']);
  assert.equal(new URL(calls[0].url).pathname, '/api/default/chats/overview');
});

// ---------- clasificación de errores ----------
const sendWith = (respond: (c: Call) => Response | Promise<Response>) => wahaWith(respond).ch.sendText('c@c.us', 'x');
const rejectsWith = (p: Promise<unknown>, type: string, code?: number) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ChannelError, String(e));
    assert.equal(e.type, type);
    if (code !== undefined) assert.equal(e.code, code);
    return true;
  });

test('errores al mandar: timeout y 5xx son inciertos (puede haber salido); sin conexión es transient', async () => {
  await rejectsWith(sendWith(() => { throw new DOMException('The operation timed out', 'TimeoutError'); }), 'uncertain');
  await rejectsWith(sendWith(() => { throw new DOMException('aborted', 'AbortError'); }), 'uncertain');
  await rejectsWith(sendWith(() => json({ message: 'Internal server error' }, 500)), 'uncertain', 500);
  await rejectsWith(sendWith(() => json({ message: 'Bad gateway' }, 502)), 'uncertain', 502);
  await rejectsWith(sendWith(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }), 'uncertain'); // se cortó en medio: no se sabe
  await rejectsWith(sendWith(() => { throw new TypeError('fetch failed'); }), 'uncertain'); // sin causa conocida: se asume lo peor
  await rejectsWith(sendWith(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }), 'transient');
  await rejectsWith(sendWith(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }), 'transient');
});

test('errores al mandar: 463 y 475 son restricted solo si el error es claramente ese código (estado HTTP, "server returned error N" o campo code), aunque el estado sea 500', async () => {
  await rejectsWith(sendWith(() => json({ statusCode: 500, message: 'server returned error 463' }, 500)), 'restricted', 463);
  await rejectsWith(sendWith(() => json({ error: 'Evaluation failed: Error: server returned error 475' }, 500)), 'restricted', 475);
  await rejectsWith(sendWith(() => json({ code: 475, error: 'Message capping reached' }, 422)), 'restricted', 475);
  await rejectsWith(sendWith(() => json({ message: 'x' }, 463)), 'restricted', 463);
  await rejectsWith(sendWith(() => json({ message: 'algo 4630 raro' }, 500)), 'uncertain'); // 4630 no es 463
});

test('errores al mandar: 401/403 es auth; sesión que no está WORKING (422) y 4xx comunes son transient', async () => {
  await rejectsWith(sendWith(() => json({ message: 'Unauthorized', statusCode: 401 }, 401)), 'auth', 401);
  await rejectsWith(sendWith(() => json({ message: 'Forbidden' }, 403)), 'auth', 403);
  await rejectsWith(sendWith(() => json({ error: 'Session status is not as expected. Try again later or restart the session', status: 'SCAN_QR_CODE', expected: ['WORKING'] }, 422)), 'transient', 422);
  await rejectsWith(sendWith(() => json({ message: 'Too many requests' }, 429)), 'transient', 429);
  await rejectsWith(sendWith(() => json({ message: 'bad' }, 400)), 'transient', 400);
});

test('un envío que WAHA aceptó pero respondió sin id es incierto: se concilia por texto, nunca se reintenta a ciegas', async () => {
  await rejectsWith(sendWith(() => json({}, 201)), 'uncertain');
  await rejectsWith(sendWith(() => new Response('', { status: 201 })), 'uncertain');
});
