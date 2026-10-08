// Servidor HTTP del bot: /waha (webhook de WAHA, con HMAC) y /health. Guarda el evento y responde 200 enseguida; el procesamiento va aparte (ingest).
// Idea reutilizada de AXXEN (hmac.ts): WAHA firma el CUERPO CRUDO con HMAC-SHA512 en hex, header X-Webhook-Hmac (comprobado, docs/waha-endpoints.md).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Clock } from './clock.ts';
import { storeInboundEvent } from './db.ts';
import type { Db } from './db.ts';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HMAC_HEADER = 'x-webhook-hmac';

export const signBody = (rawBody: string | Buffer, secret: string): string => createHmac('sha512', secret).update(rawBody).digest('hex');

// Comparación en tiempo constante. Una firma de otro largo o que no es hex no pasa (y no tira).
export function verifyHmac(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  const received = /^[0-9a-f]+$/i.test(signature.trim()) ? Buffer.from(signature.trim(), 'hex') : Buffer.alloc(0);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface WebhookDeps {
  db: Db;
  secret: string; // WAHA_WEBHOOK_HMAC_SECRET
  clock: Clock;
  onStored?: () => void; // hay un evento nuevo para procesar
}

export interface WebhookResponse {
  status: number;
  body: string;
}

const reply = (status: number, body: object): WebhookResponse => ({ status, body: JSON.stringify(body) });

// El id del evento de WAHA (ULID "evt_…") es la clave; si no viene, el hash del cuerpo.
const eventKeyOf = (parsed: Record<string, unknown>, raw: string | Buffer): string =>
  typeof parsed.id === 'string' && parsed.id ? parsed.id : `sha256:${createHash('sha256').update(raw).digest('hex')}`;

export function handleWebhook(deps: WebhookDeps, rawBody: string | Buffer, signature: string | undefined): WebhookResponse {
  if (!verifyHmac(rawBody, signature, deps.secret)) return reply(401, { error: 'unauthorized' }); // sin firma válida no se guarda nada
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reply(400, { error: 'invalid_json' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reply(400, { error: 'invalid_json' });
  try {
    if (storeInboundEvent(deps.db, eventKeyOf(parsed as Record<string, unknown>, rawBody), text, deps.clock.now())) deps.onStored?.();
  } catch {
    return reply(500, { error: 'storage' }); // WAHA reintenta: nunca un 200 sin haber guardado
  }
  return reply(200, { ok: true });
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return; // se sigue leyendo (y tirando) para que el cliente reciba el 413 y no un corte de conexión
      size += c.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(c);
        return;
      }
      tooLarge = true;
      chunks.length = 0;
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"error":"too_large"}');
    });
    req.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on('error', () => resolve(undefined));
  });
}

export interface HttpDeps extends WebhookDeps {
  health: () => Record<string, unknown>;
}

// Quien lo usa hace el listen (en Docker, 0.0.0.0:8080 adentro y 127.0.0.1 afuera).
export function createHttpServer(deps: HttpDeps): Server {
  if (!deps.secret) throw new Error('Falta WAHA_WEBHOOK_HMAC_SECRET: sin firma no se aceptan webhooks');
  const send = (res: ServerResponse, r: WebhookResponse) => void res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(r.body);
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      try {
        send(res, { status: 200, body: JSON.stringify(deps.health()) });
      } catch {
        send(res, reply(500, { ok: false }));
      }
      return;
    }
    if (path !== '/waha') return send(res, reply(404, { error: 'not_found' }));
    if (req.method !== 'POST') return send(res, reply(405, { error: 'method_not_allowed' }));
    void readBody(req, res).then((raw) => {
      if (!raw) return;
      const sig = req.headers[HMAC_HEADER];
      send(res, handleWebhook(deps, raw, typeof sig === 'string' ? sig : undefined));
    });
  });
}
