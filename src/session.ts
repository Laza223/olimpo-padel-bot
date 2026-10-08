// Sesión de WAHA: la crea y la arranca con el webhook (idempotente), vigila el estado cada 60 s y por los eventos session.status,
// y avisa UNA vez por cada cambio a un estado que pide atención. El bot nunca cierra sesión, reinicia ni pide un QR por su cuenta: solo avisa.
// Los errores 463/475 al enviar los maneja outbox.ts (con su propio aviso): acá no se miran, para no avisar dos veces lo mismo.
import { ChannelError, redactChatIds } from './channel/types.ts';
import type { Channel } from './channel/types.ts';
import type { Clock } from './clock.ts';
import { audit } from './db.ts';
import type { Db } from './db.ts';
import { sendAlert } from './notify/alert.ts';
import type { Notifier } from './notify/types.ts';
import { getState, setState } from './settings.ts';

const POLL_MS = 60_000;
const FAST_MS = 5_000; // mientras arranca (STARTING) o WAHA todavía no contesta
const FAST_TRIES = 24; // tope de chequeos rápidos seguidos (2 min): después, cada 60 s
const UNREACHABLE_AFTER_MS = 2 * 60_000; // WAHA reiniciando un rato no es una caída
const EVENTS = ['message.any', 'message.ack', 'message.revoked', 'message.edited', 'session.status'];

const PANEL = 'http://127.0.0.1:3000';
// Estados que piden atención y qué se le dice a Lazar. STARTING y WORKING no avisan.
const ALERTS: Record<string, string> = {
  SCAN_QR_CODE: `WhatsApp necesita que vincules el número de nuevo (QR). Mandá /qr acá, o abrí ${PANEL} (usuario admin, la clave de WAHA) y escaneá desde el celular: Ajustes > Dispositivos vinculados. Mientras tanto el bot no contesta.`,
  FAILED: 'La sesión de WhatsApp falló (FAILED). El bot no contesta. Probá reiniciar WAHA (docker compose restart waha); si sigue igual, mirá los logs. El bot no se reconecta ni cierra la sesión solo.',
  STOPPED: 'La sesión de WhatsApp está detenida (STOPPED). El bot no contesta hasta que se arranque de nuevo: docker compose restart waha, o fijate en el panel de WAHA.',
  PASSKEY_REQUIRED: `WhatsApp pide una confirmación extra (PASSKEY_REQUIRED). Mirá el panel de WAHA en ${PANEL} y seguí los pasos desde el celular.`,
  PASSKEY_CONFIRMATION_REQUIRED: `WhatsApp pide una confirmación extra (PASSKEY_CONFIRMATION_REQUIRED). Mirá el panel de WAHA en ${PANEL} y seguí los pasos desde el celular.`,
  UNREACHABLE: 'No puedo hablar con WAHA hace más de 2 minutos. El bot no contesta. Fijate que WAHA esté prendido (docker compose ps) y que Docker esté andando.',
  AUTH_ERROR: 'WAHA rechazó la clave (WAHA_API_KEY). El bot no puede hablar con WhatsApp hasta que la clave del .env y la de WAHA coincidan.',
};

export interface SessionOptions {
  db: Db;
  clock: Clock;
  notifier: Notifier;
  channel: Pick<Channel, 'sessionStatus'>;
  wahaUrl: string;
  apiKey: string;
  webhookUrl: string; // por la red interna de Docker: http://bot:8080/waha
  hmacSecret: string;
  session?: string;
  fetch?: typeof fetch;
  pollMs?: number;
  // En cada observación (chequeo o evento), con el estado nuevo y el anterior (undefined la primera vez). La reconciliación al prender se cuelga de acá.
  onObserve?: (status: string, previous: string | undefined) => void;
}

export interface SessionMonitor {
  ensure(): Promise<void>; // crea o actualiza la sesión con el webhook y la arranca si está detenida
  check(): Promise<void>; // un chequeo: asegura la sesión (si falta) y mira el estado
  syncFromEvents(): void; // toma el último session.status que dejó el ingest, si es nuevo
  current(): string; // WORKING, SCAN_QR_CODE… o UNKNOWN / UNREACHABLE / AUTH_ERROR
  qr(): Promise<{ data: Uint8Array; mimetype: string }>;
  start(): void;
  stop(): void;
}

interface WahaSession { status?: string; config?: { ignore?: Record<string, unknown>; webhooks?: { url?: string; events?: string[]; hmac?: { key?: string }; retries?: Record<string, unknown> }[] } }

// Lo que tiene que tener la sesión. La clave del HMAC viaja solo a WAHA y nunca se escribe en un aviso ni en la auditoría.
function desiredConfig(webhookUrl: string, secret: string) {
  return {
    ignore: { status: true, groups: true, channels: true, broadcast: true },
    webhooks: [{ url: webhookUrl, events: EVENTS, hmac: { key: secret }, retries: { delaySeconds: 2, attempts: 15, policy: 'exponential' } }],
  };
}

// Compara solo lo que nos importa (WAHA puede agregar campos propios). WAHA devuelve la config con el HMAC, así que un cambio de clave se nota.
function normalize(c: WahaSession['config']): string {
  const ig = c?.ignore ?? {};
  return JSON.stringify({
    ignore: ['status', 'groups', 'channels', 'broadcast'].map((k) => !!ig[k]),
    webhooks: (c?.webhooks ?? []).map((w) => ({
      url: w.url, events: [...(w.events ?? [])].sort(), hmac: w.hmac?.key ?? null,
      retries: { delaySeconds: w.retries?.delaySeconds, attempts: w.retries?.attempts, policy: w.retries?.policy },
    })),
  });
}

export function createSession(o: SessionOptions): SessionMonitor {
  const { db, clock } = o;
  const name = o.session ?? 'default';
  const base = o.wahaUrl.replace(/\/+$/, '');
  const fetchFn = o.fetch ?? fetch;
  const config = desiredConfig(o.webhookUrl, o.hmacSecret);
  let ensured = false;
  let status = 'UNKNOWN';
  let unreachableSince: number | undefined;
  let lastEventUtc = Number(getState(db, 'session_status_utc') ?? 0); // un evento viejo de antes de arrancar no cuenta
  let fastTries = 0;
  let timer: unknown;
  let started = false;
  let stopped = false;

  async function http(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetchFn(`${base}${path}`, {
        method,
        headers: { 'X-Api-Key': o.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new ChannelError('transient', undefined, redactChatIds(`sin conexión con WAHA: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  // 2xx pasa; 401/403 es la clave; el resto es un error pasajero (se reintenta en el próximo chequeo).
  async function ok(res: Response): Promise<Response> {
    if (res.ok) return res;
    const text = redactChatIds((await res.text().catch(() => '')).replace(/\s+/g, ' ')).slice(0, 200);
    throw new ChannelError(res.status === 401 || res.status === 403 ? 'auth' : 'transient', res.status, `WAHA respondió ${res.status}: ${text}`);
  }

  async function getSession(): Promise<WahaSession | undefined> {
    const res = await http('GET', `/api/sessions/${name}`);
    if (res.status === 404) return undefined;
    return (await (await ok(res)).json()) as WahaSession;
  }

  const startSession = async (): Promise<void> => void (await ok(await http('POST', `/api/sessions/${name}/start`)));

  async function ensure(): Promise<void> {
    let current = await getSession();
    if (!current) {
      const res = await http('POST', '/api/sessions', { name, start: true, config });
      if (res.status !== 422) {
        await ok(res);
        ensured = true;
        return;
      }
      current = await getSession(); // 422: ya existe (otro arranque la creó entre medio): se compara y se sigue
      if (!current) await ok(res);
    }
    if (normalize(current!.config) !== normalize(config)) {
      // Cambió la URL, el secreto o los eventos: PUT actualiza la config y WAHA reconecta con la sesión guardada (sin QR).
      const updated = (await (await ok(await http('PUT', `/api/sessions/${name}`, { name, config }))).json().catch(() => ({}))) as WahaSession;
      if (updated.status === 'STOPPED') await startSession();
    } else if (current!.status === 'STOPPED') await startSession();
    ensured = true;
  }

  // Un estado que pide atención avisa solo si cambió respecto del último que se vio (también entre reinicios del bot).
  function transition(next: string): void {
    if (getState(db, 'session_last') === next) return;
    setState(db, 'session_last', next);
    const text = ALERTS[next];
    if (text) void sendAlert(db, o.notifier, clock, text, { urgent: true });
  }

  function observe(next: string, alertable = true): void {
    const previous = status === 'UNKNOWN' ? undefined : status;
    status = next;
    if (next === 'WORKING') fastTries = 0;
    if (alertable) transition(next);
    o.onObserve?.(next, previous);
  }

  function fail(e: unknown): void {
    if (e instanceof ChannelError && e.type === 'auth') {
      unreachableSince = undefined;
      return observe('AUTH_ERROR');
    }
    unreachableSince ??= clock.now();
    observe('UNREACHABLE', clock.now() - unreachableSince >= UNREACHABLE_AFTER_MS);
  }

  async function check(): Promise<void> {
    try {
      if (!ensured) await ensure();
      const s = await o.channel.sessionStatus();
      unreachableSince = undefined;
      observe(s);
    } catch (e) {
      fail(e);
    }
  }

  function schedule(): void {
    if (stopped) return;
    const fast = fastTries < FAST_TRIES && (!ensured || status === 'UNKNOWN' || status === 'STARTING' || status === 'UNREACHABLE');
    if (fast) fastTries++;
    timer = clock.setTimeout(() => void tick(), fast ? FAST_MS : (o.pollMs ?? POLL_MS));
  }

  async function tick(): Promise<void> {
    timer = undefined;
    try {
      await check();
    } catch (e) {
      audit(db, clock.now(), null, 'error', `sesión: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      schedule();
    }
  }

  return {
    ensure,
    check,
    current: () => status,
    syncFromEvents() {
      const at = Number(getState(db, 'session_status_utc') ?? 0);
      const event = getState(db, 'session_status');
      if (!event || at <= lastEventUtc) return;
      lastEventUtc = at;
      unreachableSince = undefined;
      observe(event);
    },
    async qr() {
      const res = await ok(await http('GET', `/api/${name}/auth/qr`));
      return { data: new Uint8Array(await res.arrayBuffer()), mimetype: res.headers.get('content-type')?.split(';')[0] ?? 'image/png' };
    },
    start() {
      if (started) return;
      started = true;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
