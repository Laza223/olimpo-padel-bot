// Ayudas de las pruebas de F2 parte B: Telegram falso y WAHA falso, los dos como `fetch` inyectable (sin red, sin token real, sin número).
import { deferred } from './f2-helpers.ts';

export const TG_TOKEN = '123456:TOKEN-DE-PRUEBA';
export const TG_GROUP = '-1001234567890';
export const WAHA_KEY = 'clave-waha-de-prueba';

type Json = Record<string, any>;
const reply = (body: unknown, status = 200, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => new Response(typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body), { status, headers });

// ---------- Telegram falso (Bot API) ----------
export interface TgCall { method: string; body: Json; form?: FormData }

export class FakeTelegram {
  calls: TgCall[] = [];
  failing = false; // todas las llamadas fallan (Telegram caído)
  badTokenSeen = false;
  #queue: Json[] = [];
  #nextUpdate = 1;
  #nextMessage = 100;
  #wake = deferred<void>();

  // Mensajes que el bot mandó al grupo (sendMessage).
  get sent(): Json[] {
    return this.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  }
  get texts(): string[] {
    return this.sent.map((b) => String(b.text));
  }
  callsOf(method: string): TgCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  push(update: Json): number {
    const update_id = this.#nextUpdate++;
    this.#queue.push({ update_id, ...update });
    this.#wake.resolve();
    return update_id;
  }
  text(chatId: string, text: string, from = { id: 7, first_name: 'Lazar' }): number {
    return this.push({ message: { message_id: this.#nextMessage++, chat: { id: Number(chatId) }, from, text } });
  }
  press(chatId: string, data: string, message: { message_id: number; text: string } = { message_id: 55, text: 'mensaje original' }, from = { id: 7, first_name: 'Lazar' }): number {
    return this.push({ callback_query: { id: `cb${this.#nextUpdate}`, from, data, message: { ...message, chat: { id: Number(chatId) } } } });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m) return reply({ ok: false, description: `url inesperada ${url}` }, 404);
    if (m[1] !== TG_TOKEN) {
      this.badTokenSeen = true;
      return reply({ ok: false, description: 'Unauthorized' }, 401);
    }
    const method = m[2];
    const isForm = init?.body instanceof FormData;
    const body: Json = isForm ? {} : init?.body ? JSON.parse(String(init.body)) : {};
    if (isForm) for (const [k, v] of (init!.body as FormData).entries()) body[k] = typeof v === 'string' ? v : v;
    this.calls.push({ method, body, form: isForm ? (init!.body as FormData) : undefined });
    if (this.failing) throw new TypeError('fetch failed');
    if (method === 'getUpdates') return reply({ ok: true, result: await this.#getUpdates(Number(body.offset ?? 0), init?.signal ?? undefined) });
    if (method === 'sendMessage' || method === 'sendPhoto') return reply({ ok: true, result: { message_id: this.#nextMessage++, chat: { id: Number(body.chat_id) } } });
    return reply({ ok: true, result: true }); // answerCallbackQuery, editMessageText, editMessageReplyMarkup…
  };

  // Long polling: devuelve lo pendiente desde `offset`; si no hay nada, espera a que llegue algo o a que se aborte.
  async #getUpdates(offset: number, signal?: AbortSignal): Promise<Json[]> {
    for (;;) {
      this.#queue = this.#queue.filter((u) => u.update_id >= offset); // Telegram descarta lo confirmado por el offset
      if (this.#queue.length) return [...this.#queue];
      this.#wake = deferred<void>();
      const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      await Promise.race([this.#wake.promise, aborted]);
    }
  }
}

// ---------- WAHA falso (solo lo que usa session.ts y el adaptador) ----------
export interface WahaCall { method: string; path: string; body?: Json; key?: string | null }

export class FakeWaha {
  calls: WahaCall[] = [];
  session?: { name: string; status: string; config: Json };
  down = false; // WAHA caído: ECONNREFUSED
  qrOk = true;
  ghost404 = 0; // los próximos GET de la sesión dicen 404 aunque exista (carrera entre dos arranques)

  callsTo(path: RegExp | string, method?: string): WahaCall[] {
    return this.calls.filter((c) => (typeof path === 'string' ? c.path === path : path.test(c.path)) && (!method || c.method === method));
  }
  // Llamadas que serían un bucle de logout / reconexión / reinicio.
  get disruptive(): WahaCall[] {
    return this.calls.filter((c) => /\/(logout|stop|restart)$/.test(c.path) || (c.method === 'DELETE'));
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body: Json | undefined = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: u.pathname, body, key: headers.get('x-api-key') });
    if (headers.get('x-api-key') !== WAHA_KEY) return reply({ message: 'Unauthorized', statusCode: 401 }, 401);
    const p = u.pathname;
    if (method === 'GET' && p === '/api/sessions/default') {
      if (this.ghost404 > 0) {
        this.ghost404--;
        return reply({ message: 'Session not found' }, 404);
      }
      return this.session ? reply({ name: 'default', status: this.session.status, config: this.session.config }) : reply({ message: 'Session not found' }, 404);
    }
    if (method === 'POST' && p === '/api/sessions') {
      if (this.session) return reply({ message: "Session 'default' already exists. Use PUT to update it.", statusCode: 422 }, 422);
      this.session = { name: String(body!.name), status: 'STARTING', config: body!.config };
      return reply({ name: this.session.name, status: 'STARTING', config: body!.config }, 201);
    }
    if (method === 'PUT' && p === '/api/sessions/default') {
      this.session = { name: 'default', status: 'STARTING', config: body!.config };
      return reply({ name: 'default', status: 'STARTING', config: body!.config });
    }
    if (method === 'POST' && p === '/api/sessions/default/start') {
      if (this.session) this.session.status = 'STARTING';
      return reply({ name: 'default', status: 'STARTING' }, 201);
    }
    if (method === 'GET' && p === '/api/default/auth/qr') {
      if (!this.qrOk || this.session?.status !== 'SCAN_QR_CODE') return reply({ error: 'Session status is not as expected', status: this.session?.status, expected: ['SCAN_QR_CODE'] }, 422);
      return reply(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 200, { 'Content-Type': 'image/png' });
    }
    return reply({ message: `no existe ${method} ${p}` }, 404);
  };
}
