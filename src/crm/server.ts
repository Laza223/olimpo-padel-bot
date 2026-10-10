// CRM local: lo sirve el mismo servidor del bot bajo /crm (docs/decisiones/2026-10-10-crm.md).
// Barreras, en orden: Host 127.0.0.1/localhost (DNS rebinding) → clave (CRM_PASSWORD, sesión en memoria) → en los POST, Origin igual al del pedido (CSRF).
// Las acciones pasan por src/actions.ts: las mismas que usa Telegram.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { discardDraft, giveBack, moveStage, quoteSent, sendDraft, setBotSwitch, setShadow, takeOver, takeOverFromDraft } from '../actions.ts';
import type { ActionContext, Controls } from '../actions.ts';
import type { Clock } from '../clock.ts';
import { STAGES, audit, getConversationByNumber } from '../db.ts';
import type { Db, Stage } from '../db.ts';
import { sendAlert } from '../notify/alert.ts';
import { getFlag } from '../settings.ts';
import type { Notifier } from '../notify/types.ts';
import type { Asset } from '../policy.ts';
import { argentinaClock } from '../time.ts';
import { botStatus, chatDetail, chatList, isListFilter, loadFacts } from './data.ts';
import type { AppView, ListFilter } from './data.ts';
import type { Html } from './html.ts';
import * as views from './views.ts';
import { createQuoteRoutes } from './quote-routes.ts';
import type { QuoteHints, QuotePrices } from './quote.ts';
import { createPdfRenderer } from './quote-render.ts';
import type { RenderPdf } from './quote-render.ts';

const SESSION_MS = 30 * 86_400_000;
const COOKIE = 'olimpo_crm';
const MAX_BODY = 16 * 1024;
const MIN_PASSWORD = 12;
const LOGIN_FREE_TRIES = 5; // después de 5 claves mal, un intento cada 30 s
const LOGIN_WAIT_MS = 30_000;
const LOGIN_FORGET_MS = 15 * 60_000; // las claves mal se olvidan a los 15 min sin errores
const WHO = 'CRM';

// Archivos fijos: nunca una ruta armada con lo que pide el navegador.
const PUBLIC = new URL('./public/', import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  'crm.css': { file: 'crm.css', type: 'text/css; charset=utf-8' },
  'crm.js': { file: 'crm.js', type: 'text/javascript; charset=utf-8' },
  'archivo.woff2': { file: 'archivo-var.woff2', type: 'font/woff2' },
  'logo.png': { file: 'logo-white.png', type: 'image/png' },
  'icono.png': { file: 'favicon-32.png', type: 'image/png' },
  'presupuesto.css': { file: 'presupuesto.css', type: 'text/css; charset=utf-8' },
  'presupuesto.js': { file: 'presupuesto.js', type: 'text/javascript; charset=utf-8' },
  'logo-creador.png': { file: 'logo-creador.png', type: 'image/png' },
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin', // con no-referrer Chrome manda "Origin: null" en los formularios y el chequeo de Origin los rechazaría
  'Cache-Control': 'no-store',
};

export interface CrmDeps {
  db: Db;
  clock: Clock;
  controls: () => Controls;
  notifier: Notifier;
  assets: Asset[];
  assetsDir?: URL;
  closingText: string; // la promesa del presupuesto (policy): marca desde cuándo corre el vencimiento
  password: string | undefined; // CRM_PASSWORD
  wahaSecrets?: Record<string, string | undefined>; // claves que conoce el contenedor de WAHA (WAHA_API_KEY, WAHA_WEBHOOK_HMAC_SECRET): CRM_PASSWORD no puede ser ninguna
  random?: (bytes: number) => Buffer; // pruebas
  // Creador de presupuestos (opcionales: sin esto el creador anda, pero sin precios precargados y sin poder armar el PDF).
  quotePrices?: QuotePrices;
  quoteHints?: QuoteHints;
  quoteDir?: string; // donde quedan los PDF que se mandan por WhatsApp (data/presupuestos)
  chromiumPath?: string; // CHROMIUM_PATH
  renderPdf?: RenderPdf; // pruebas: un Chromium falso
}

export interface Crm {
  // true si el pedido era del CRM (/crm o /crm/…) y ya se contestó.
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  disabledReason: string | undefined;
}

export function crmDisabledReason(password: string | undefined, wahaSecrets: Record<string, string | undefined> = {}): string | undefined {
  if (!password) return 'Falta CRM_PASSWORD en el .env.';
  if (password.length < MIN_PASSWORD) return `CRM_PASSWORD tiene que tener ${MIN_PASSWORD} caracteres o más.`;
  const same = Object.entries(wahaSecrets).find(([, v]) => v && password === v);
  if (same) return `CRM_PASSWORD no puede ser igual a ${same[0]} (el contenedor de WAHA tiene esa clave).`;
  return undefined;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
const isLocalHost = (host: string | undefined): boolean => {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
};
const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
};
// Solo se vuelve a una URL del propio CRM: nada de redirigir afuera con lo que mande el formulario.
const safeBack = (s: string | null | undefined): string => (s && /^\/crm\/(?:\?[^\s\\]*)?$/.test(s) ? s : '/crm/');

export function createCrm(d: CrmDeps): Crm {
  const disabledReason = crmDisabledReason(d.password, d.wahaSecrets);
  const random = d.random ?? randomBytes;
  const sessions = new Map<string, number>(); // token → vence
  let failures = 0;
  let lastFailure = 0;
  let lockedUntil = 0;
  const ctx: ActionContext = { db: d.db, clock: d.clock, controls: d.controls, assets: d.assets, assetsDir: d.assetsDir };
  const quotes = createQuoteRoutes({
    ctx, render: d.renderPdf ?? createPdfRenderer({ chromiumPath: d.chromiumPath }), prices: d.quotePrices, hints: d.quoteHints, dir: d.quoteDir ?? 'data/presupuestos',
  });

  const send = (res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) =>
    void res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra }).end(body);
  const page = (res: ServerResponse, status: number, h: Html, extra: Record<string, string> = {}) => send(res, status, `<!doctype html>${h.value}`, 'text/html; charset=utf-8', extra);
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string> = {}) => send(res, 303, '', 'text/plain; charset=utf-8', { Location: to, ...extra });
  const json = (res: ServerResponse, status: number, body: object) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');

  function loggedIn(req: IncomingMessage): string | undefined {
    const token = cookieOf(req, COOKIE);
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined;
    const until = sessions.get(token);
    if (!until) return undefined;
    if (until < d.clock.now()) {
      sessions.delete(token);
      return undefined;
    }
    return token;
  }

  function readBody(req: IncomingMessage): Promise<URLSearchParams | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c);
      });
      req.on('end', () => resolve(size > MAX_BODY ? undefined : new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', () => resolve(undefined));
    });
  }

  function view(url: URL, flash: AppView['flash'] = null): AppView {
    const now = d.clock.now();
    const facts = loadFacts(d.db, d.closingText); // una sola pasada para la lista y el chat abierto
    const f = url.searchParams.get('f') ?? 'ahora';
    const filter: ListFilter = isListFilter(f) ? f : 'ahora';
    const query = (url.searchParams.get('q') ?? '').slice(0, 80);
    const n = Number(url.searchParams.get('chat'));
    const params = new URLSearchParams();
    if (filter !== 'ahora') params.set('f', filter);
    if (query) params.set('q', query);
    if (Number.isInteger(n) && n > 0) params.set('chat', String(n));
    const msg = url.searchParams.get('msg');
    return {
      status: botStatus(d.db, now, d.controls().session.current()),
      filter, query,
      list: chatList(d.db, now, d.closingText, filter, query, facts),
      chat: Number.isInteger(n) && n > 0 ? chatDetail(d.db, n, now, d.closingText, facts) ?? null : null,
      flash: flash ?? (msg ? { text: msg.slice(0, 200), ok: url.searchParams.get('ok') !== '0' } : null),
      back: `/crm/${params.size ? `?${params}` : ''}`,
    };
  }

  // Avisa al grupo de Telegram (decisión de Lazar: solo apagar/prender y la sombra). Nunca frena la respuesta.
  const tellGroup = (text: string) => void sendAlert(d.db, d.notifier, d.clock, text);

  // Una acción del CRM. Devuelve el texto para Lazar y si salió bien.
  function act(p: URLSearchParams): { ok: boolean; text: string } {
    const a = p.get('a') ?? '';
    const now = d.clock.now();
    const chat = () => {
      const n = Number(p.get('n'));
      return Number.isInteger(n) && n > 0 ? getConversationByNumber(d.db, n) : undefined;
    };
    const draftId = () => {
      const id = Number(p.get('d'));
      return Number.isInteger(id) && id > 0 ? id : 0;
    };
    switch (a) {
      case 'apagar':
      case 'prender': {
        setBotSwitch(ctx, a === 'prender');
        audit(d.db, now, null, 'command', `${a} (${WHO})`);
        tellGroup(a === 'apagar' ? 'Bot apagado desde el CRM: no contesta ni manda nada hasta que lo prendan.' : 'Bot prendido desde el CRM.');
        return { ok: true, text: a === 'apagar' ? 'Bot apagado: no contesta ni manda nada.' : 'Bot prendido.' };
      }
      case 'sombra_on':
      case 'sombra_off': {
        const on = a === 'sombra_on';
        setShadow(ctx, on);
        audit(d.db, now, null, 'command', `sombra ${on ? 'on' : 'off'} (${WHO})`);
        tellGroup(on ? 'Modo sombra prendido desde el CRM: los borradores esperan [Mandar] y el bot no le escribe a nadie.' : 'Modo sombra apagado desde el CRM: el bot le escribe directo a los clientes.');
        return { ok: true, text: on ? 'Modo sombra prendido: el bot arma borradores y no le escribe a nadie.' : 'Modo sombra apagado: el bot le escribe directo a los clientes.' };
      }
      case 'mandar': {
        const r = sendDraft(ctx, draftId());
        if (r === 'enviado') return { ok: true, text: getFlag(d.db, 'kill_switch') ? 'Listo para salir, pero el bot está apagado: sale cuando lo prendas.' : 'Mandado: sale en unos segundos.' };
        if (r === 'vencido') return { ok: false, text: 'No se mandó: el cliente escribió de nuevo y el bot está armando otra respuesta.' };
        return { ok: false, text: 'Ese borrador ya no está pendiente.' };
      }
      case 'descartar': {
        const r = discardDraft(ctx, draftId(), WHO);
        return r.status === 'descartado' ? { ok: true, text: 'Borrador descartado. El bot no vuelve a proponer hasta que el cliente escriba.' } : { ok: false, text: 'Ese borrador ya no está pendiente.' };
      }
      case 'dtomo':
        return takeOverFromDraft(ctx, draftId(), WHO, 'CRM [Lo tomo] del borrador') === 'tomado'
          ? { ok: true, text: 'Lo tomaste: el borrador queda descartado y el bot no le contesta más.' }
          : { ok: false, text: 'No existe ese chat.' };
    }
    const c = chat();
    if (!c) return { ok: false, text: 'No existe ese chat.' };
    switch (a) {
      case 'tomo':
        return takeOver(ctx, c, WHO, 'CRM [Lo tomo]') ? { ok: true, text: 'Lo tomaste: el bot no le contesta más.' } : { ok: true, text: 'Ya estaba con el equipo.' };
      case 'bot': {
        const r = giveBack(ctx, c, WHO, 'CRM [Devolver al bot]');
        if (r === 'ya_estaba') return { ok: true, text: 'Ya estaba con el bot.' };
        return r === 'ficha_cerrada'
          ? { ok: true, text: 'Volvió al bot, pero el bot ya terminó con este cliente (lo pasó al equipo o pidió la baja): no le va a escribir.' }
          : { ok: true, text: 'Volvió al bot. Si el cliente dejó algo sin contestar, lo retoma enseguida.' };
      }
      case 'presu': {
        const r = quoteSent(ctx, c, WHO);
        return r.status === 'ya_estaba'
          ? { ok: true, text: `El presupuesto ya estaba anotado (${argentinaClock(r.atUtc)}).` }
          : { ok: true, text: `Anotado: presupuesto mandado a las ${argentinaClock(r.atUtc)}.` };
      }
      case 'etapa': {
        const stage = p.get('stage') ?? '';
        if (!(STAGES as readonly string[]).includes(stage)) return { ok: false, text: 'Esa etapa no existe.' };
        const reason = (p.get('reason') ?? '').slice(0, 80);
        if (stage === 'perdido' && !reason.trim()) return { ok: false, text: 'Elegí por qué se perdió (el motivo, abajo de la etapa).' };
        return moveStage(ctx, c, stage as Stage, WHO, reason) === 'movido' ? { ok: true, text: 'Listo, cambió de etapa.' } : { ok: true, text: 'Ya estaba en esa etapa.' };
      }
    }
    return { ok: false, text: 'No entendí la acción.' };
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = await readBody(req);
    const now = d.clock.now();
    if (now < lockedUntil) return page(res, 429, views.loginPage({ error: 'Demasiados intentos. Esperá medio minuto y probá de nuevo.' }));
    const given = p?.get('clave') ?? '';
    if (!timingSafeEqual(digest(given), digest(d.password!))) {
      if (now - lastFailure > LOGIN_FORGET_MS) failures = 0;
      failures++;
      lastFailure = now;
      if (failures >= LOGIN_FREE_TRIES) lockedUntil = now + LOGIN_WAIT_MS;
      return page(res, 401, views.loginPage({ error: 'Clave incorrecta.' }));
    }
    failures = 0;
    const token = random(32).toString('hex');
    sessions.set(token, now + SESSION_MS);
    redirect(res, '/crm/', { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/crm; Max-Age=${SESSION_MS / 1000}` });
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path.startsWith('/crm/static/')) {
      const name = path.slice('/crm/static/'.length);
      const f = Object.hasOwn(STATIC, name) ? STATIC[name] : undefined; // hasOwn: "constructor" o "__proto__" no son archivos
      if (!f) return send(res, 404, 'No existe.', 'text/plain; charset=utf-8');
      return send(res, 200, readFileSync(new URL(f.file, PUBLIC)), f.type, { 'Cache-Control': 'no-cache' });
    }
    if (disabledReason) return page(res, 503, views.offPage(disabledReason));
    if (path === '/crm') return redirect(res, '/crm/');

    if (method === 'POST') {
      // CSRF: el pedido tiene que venir de esta misma página. SameSite no alcanza: no mira el puerto (el panel de WAHA en :3000 es "el mismo sitio").
      if (req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, 'Pedido de otro sitio.', 'text/plain; charset=utf-8');
      if (path === '/crm/login') return login(req, res);
    }
    if (path === '/crm/login' && method === 'GET') return loggedIn(req) ? redirect(res, '/crm/') : page(res, 200, views.loginPage({}));

    const token = loggedIn(req);
    if (!token) {
      if (method === 'GET' && path === '/crm/') return redirect(res, '/crm/login');
      return send(res, 401, 'Tenés que entrar con la clave.', 'text/plain; charset=utf-8');
    }

    if (await quotes.handle(req, res, url, send, page)) return;
    if (method === 'GET' && path === '/crm/') return page(res, 200, views.appPage(view(url)));
    if (method === 'GET' && path === '/crm/parcial') {
      const v = view(url);
      return json(res, 200, { status: views.statusFragment(v).value, list: views.listFragment(v).value, chat: views.chatFragment(v).value });
    }
    if (method === 'POST' && path === '/crm/salir') {
      sessions.delete(token);
      return redirect(res, '/crm/login', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/crm; Max-Age=0` });
    }
    if (method === 'POST' && path === '/crm/accion') {
      const p = await readBody(req);
      if (!p) return send(res, 413, 'Pedido demasiado grande.', 'text/plain; charset=utf-8');
      const r = act(p);
      if ((req.headers.accept ?? '').includes('application/json')) return json(res, r.ok ? 200 : 409, r);
      const back = new URL(safeBack(p.get('back')), 'http://crm.local');
      back.searchParams.set('msg', r.text);
      if (!r.ok) back.searchParams.set('ok', '0');
      return redirect(res, `${back.pathname}${back.search}`);
    }
    send(res, 404, 'No existe.', 'text/plain; charset=utf-8');
  }

  return {
    disabledReason,
    handle(req, res) {
      if (!(req.url ?? '').startsWith('/crm')) return false; // "//otro/crm/" o "http://x/crm/" no son del CRM, aunque URL los lea así
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://crm.local');
      } catch {
        return false; // "//" o "//x" no son rutas: el 404 de siempre (sin esto, la excepción escapaba fuera de todo catch)
      }
      if (url.pathname !== '/crm' && !url.pathname.startsWith('/crm/')) return false;
      if (!isLocalHost(req.headers.host)) {
        send(res, 403, 'El CRM solo se abre desde esta compu (127.0.0.1 o localhost).', 'text/plain; charset=utf-8');
        return true;
      }
      route(req, res, url).catch((e: unknown) => {
        audit(d.db, d.clock.now(), null, 'error', `crm: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) send(res, 500, 'Algo falló en el CRM. Quedó anotado.', 'text/plain; charset=utf-8');
        else res.end();
      });
      return true;
    },
  };
}
