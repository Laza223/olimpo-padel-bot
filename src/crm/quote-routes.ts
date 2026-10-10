// El creador de presupuestos dentro del CRM: la pantalla, su API (lo que en Electron era historial.json) y el PDF (bajarlo o mandarlo por WhatsApp).
// Corre detrás de las mismas barreras del CRM (Host, clave, Origin): server.ts solo llama acá con la sesión ya validada.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { QUOTE_CAPTION, sendQuote } from '../actions.ts';
import type { ActionContext } from '../actions.ts';
import { QUOTE_STATES, audit, deleteQuote, getConversation, getConversationByNumber, getQuote, insertQuote, latestQuoteOfChat, listQuotes, markQuoteSent, quoteSendRows, setQuoteState, updateQuoteData } from '../db.ts';
import type { Conversation, QuoteRow, QuoteState } from '../db.ts';
import { getFlag } from '../settings.ts';
import { argentinaClock } from '../time.ts';
import { quoteSendStatus } from './data.ts';
import type { QuoteSendStatus } from './data.ts';
import type { Html } from './html.ts';
import { forPdf, normalizeQuote, quoteFromCard, validateQuote, MODELOS, CODIGOS_PAIS, SPECS_CANCHA, SPECS_PLATEA, CONDICIONES_DEFAULT, PLAZO_DEFAULT } from './quote.ts';
import type { QuoteData, QuoteHints, QuotePrices } from './quote.ts';
import { buildQuoteHTML, quoteDate, quoteFilename } from './quote-pdf.ts';
import type { RenderPdf } from './quote-render.ts';
import { quotePage } from './quote-views.ts';

const MAX_QUOTE_BODY = 256 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // los ids los pone el servidor (randomUUID): nada más entra a una ruta de archivo
const UNSENT_PDF_TTL_MS = 7 * 86_400_000;
const WHO = 'CRM';
const LOGO_FILE = new URL('./public/logo-creador.png', import.meta.url);

// Un presupuesto como lo ve la pantalla: lo del creador (QuoteData) + id, estado, fechas, chat y envío.
export interface QuoteRecord extends QuoteData {
  id: string;
  estado: QuoteState;
  fechaCreacion: string; // ISO, como el creador
  fechaModificacion: string;
  chat: { n: number; nombre: string } | null;
  envio: QuoteSendStatus | null;
}
// Lo que la pantalla recibe al abrir (bloque <script type="application/json">). Los textos por defecto salen de quote.ts: el JS no tiene copia propia.
export interface QuoteBoot {
  modelos: readonly string[];
  codigosPais: readonly string[];
  specsCancha: string[];
  specsPlatea: string[];
  condiciones: string;
  plazo: string;
  hints: QuoteHints;
  abrir: QuoteRecord | null; // presupuesto guardado para abrir
  nuevo: { data: QuoteData; chat: { n: number; nombre: string } } | null; // precargado desde la ficha, todavía sin guardar
}

export interface QuoteDeps {
  ctx: ActionContext;
  render: RenderPdf;
  prices?: QuotePrices;
  hints?: QuoteHints;
  dir: string; // donde quedan los PDF que se mandan (data/presupuestos)
}
type Send = (res: ServerResponse, status: number, body: string | Buffer, type?: string, extra?: Record<string, string>) => void;

// CSP de la pantalla: la del CRM + las fuentes de Google que usa la hoja del creador. Del PDF en la vista previa: solo sus estilos, la fuente y el logo.
export const QUOTE_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export const QUOTE_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

const nameOf = (c: Conversation): string => c.card.fields.nombre?.value.trim() || c.profileName?.trim() || `Chat #${c.n}`;

export function createQuoteRoutes(d: QuoteDeps) {
  const { db, clock } = d.ctx;
  const sending = new Set<string>(); // chats con un "Enviar por WhatsApp" armando el PDF
  let logo: string | undefined;
  const logoUrl = () => (logo ??= `data:image/png;base64,${readFileSync(LOGO_FILE).toString('base64')}`);
  const htmlOf = (q: QuoteData) => buildQuoteHTML(forPdf(q), { logo: logoUrl(), fecha: quoteDate(clock.now()) });

  const sendStatus = (quoteId: string) => quoteSendStatus(db, quoteId);

  function record(r: QuoteRow): QuoteRecord {
    const conv = r.chatId ? getConversation(db, r.chatId) : undefined;
    return {
      ...normalizeQuote(JSON.parse(r.dataJson), randomUUID),
      id: r.id, estado: r.estado, fechaCreacion: new Date(r.createdUtc).toISOString(), fechaModificacion: new Date(r.updatedUtc).toISOString(),
      chat: conv ? { n: conv.n, nombre: nameOf(conv) } : null, envio: sendStatus(r.id),
    };
  }

  // Guarda lo que manda la pantalla: si trae id, actualiza ese; si no, crea uno nuevo (con el chat, si vino de una ficha). Valida como el creador.
  function save(body: Record<string, unknown>): { ok: true; row: QuoteRow } | { ok: false; status: number; error: string } {
    const data = normalizeQuote(body.data, randomUUID);
    const problem = validateQuote(data);
    if (problem) return { ok: false, status: 422, error: problem };
    const now = clock.now();
    const json = JSON.stringify(data);
    if (body.id !== undefined && body.id !== null && body.id !== '') {
      if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return { ok: false, status: 400, error: 'Ese presupuesto no existe.' };
      if (!updateQuoteData(db, body.id, json, now)) return { ok: false, status: 404, error: 'Ese presupuesto ya no existe (¿lo borraron?).' };
      return { ok: true, row: getQuote(db, body.id)! };
    }
    const n = Number(body.chat);
    const conv = Number.isInteger(n) && n > 0 ? getConversationByNumber(db, n) : undefined;
    const id = randomUUID();
    insertQuote(db, { id, chatId: conv?.chatId ?? null, dataJson: json, nowMs: now });
    return { ok: true, row: getQuote(db, id)! };
  }

  // Los PDF que se armaron para mandar y no salieron (cancelados, vencidos, fallidos) se borran a los 7 días; los que salieron quedan como registro.
  function pruneUnsent(): void {
    let files: string[];
    try {
      files = readdirSync(d.dir);
    } catch {
      return;
    }
    const now = clock.now();
    for (const f of files) {
      const m = /^([0-9a-f-]{36})-(\d+)\.pdf$/.exec(f);
      if (!m) continue;
      const path = join(d.dir, f);
      try {
        if (now - statSync(path).mtimeMs < UNSENT_PDF_TTL_MS) continue;
        const row = quoteSendRows(db, m[1]).find((r) => r.logicalKey.endsWith(`:${m[2]}`));
        if (row && row.status !== 'cancelado' && row.status !== 'vencido' && row.status !== 'fallido') continue;
        unlinkSync(path);
      } catch {
        // otro proceso lo movió o borró: no importa
      }
    }
  }

  function readRaw(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_QUOTE_BODY) chunks.push(c);
      });
      req.on('end', () => resolve(size > MAX_QUOTE_BODY ? undefined : Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(undefined));
    });
  }
  const parseJson = (s: string): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(s);
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  function boot(url: URL): { boot: QuoteBoot; chat: { n: number; nombre: string } | null } | undefined {
    const base = { modelos: MODELOS, codigosPais: CODIGOS_PAIS, specsCancha: SPECS_CANCHA, specsPlatea: SPECS_PLATEA, condiciones: CONDICIONES_DEFAULT, plazo: PLAZO_DEFAULT, hints: d.hints ?? {} };
    const id = url.searchParams.get('id');
    if (id) {
      const r = ID_RE.test(id) ? getQuote(db, id) : undefined;
      if (!r) return undefined;
      const rec = record(r);
      return { boot: { ...base, abrir: rec, nuevo: null }, chat: rec.chat };
    }
    const n = Number(url.searchParams.get('chat'));
    if (url.searchParams.has('chat')) {
      const conv = Number.isInteger(n) && n > 0 ? getConversationByNumber(db, n) : undefined;
      if (!conv) return undefined;
      const chat = { n: conv.n, nombre: nameOf(conv) };
      const last = latestQuoteOfChat(db, conv.chatId);
      if (last) return { boot: { ...base, abrir: record(last), nuevo: null }, chat };
      return { boot: { ...base, abrir: null, nuevo: { data: quoteFromCard(conv.card, conv.chatId, d.prices, randomUUID), chat } }, chat };
    }
    return { boot: { ...base, abrir: null, nuevo: null }, chat: null };
  }

  // Devuelve true si la ruta era del creador (y ya contestó).
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, send: Send, page: (res: ServerResponse, status: number, h: Html, extra?: Record<string, string>) => void): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const json = (status: number, body: object) => send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
    if (path !== '/crm/presupuestos' && !path.startsWith('/crm/presupuestos/')) return false;

    if (method === 'GET' && path === '/crm/presupuestos') {
      const b = boot(url);
      if (!b) return page(res, 404, quotePage({ boot: null, chat: null }), { 'Content-Security-Policy': QUOTE_PAGE_CSP }), true;
      return page(res, 200, quotePage(b), { 'Content-Security-Policy': QUOTE_PAGE_CSP }), true;
    }
    if (method === 'GET' && path === '/crm/presupuestos/api/lista') return json(200, { presupuestos: listQuotes(db).map(record) }), true;

    if (method !== 'POST') return send(res, 404, 'No existe.', 'text/plain; charset=utf-8'), true;
    const raw = await readRaw(req);
    if (raw === undefined) return send(res, 413, 'Pedido demasiado grande.', 'text/plain; charset=utf-8'), true;

    // Vista previa: un formulario con target al iframe (campo `data` con el JSON). Devuelve la hoja del PDF con su propia CSP.
    if (path === '/crm/presupuestos/vista') {
      const data = normalizeQuote(parseJson(new URLSearchParams(raw).get('data') ?? '') ?? {}, randomUUID);
      send(res, 200, htmlOf(data), 'text/html; charset=utf-8', { 'Content-Security-Policy': QUOTE_PREVIEW_CSP, 'X-Frame-Options': 'SAMEORIGIN' });
      return true;
    }

    const body = parseJson(raw);
    if (!body) return json(400, { error: 'El pedido no se entendió. Recargá la página.' }), true;
    const byId = (): QuoteRow | undefined => (typeof body.id === 'string' && ID_RE.test(body.id) ? getQuote(db, body.id) : undefined);

    switch (path) {
      case '/crm/presupuestos/api/guardar': {
        const r = save(body);
        return r.ok ? json(200, { presupuesto: record(r.row) }) : json(r.status, { error: r.error }), true;
      }
      case '/crm/presupuestos/api/duplicar': {
        const q = byId();
        if (!q) return json(404, { error: 'Ese presupuesto ya no existe.' }), true;
        const data = normalizeQuote(JSON.parse(q.dataJson), randomUUID);
        data.items = data.items.map((i) => ({ ...i, id: randomUUID() })); // como el creador: los renglones de specs con id nuevo
        const id = randomUUID();
        insertQuote(db, { id, chatId: q.chatId, dataJson: JSON.stringify(data), nowMs: clock.now() });
        return json(200, { presupuesto: record(getQuote(db, id)!) }), true;
      }
      case '/crm/presupuestos/api/borrar': {
        const q = byId();
        if (!q) return json(404, { error: 'Ese presupuesto ya no existe.' }), true;
        deleteQuote(db, q.id);
        return json(200, { ok: true }), true;
      }
      case '/crm/presupuestos/api/estado': {
        const q = byId();
        if (!q) return json(404, { error: 'Ese presupuesto ya no existe.' }), true;
        if (!(QUOTE_STATES as readonly unknown[]).includes(body.estado)) return json(400, { error: 'Ese estado no existe.' }), true;
        setQuoteState(db, q.id, body.estado as QuoteState, clock.now());
        return json(200, { presupuesto: record(getQuote(db, q.id)!) }), true;
      }
      // Exportar PDF: guarda, arma el PDF y lo baja con el nombre del creador; el presupuesto queda "enviado" (como en el creador).
      case '/crm/presupuestos/pdf': {
        const r = save(body);
        if (!r.ok) return json(r.status, { error: r.error }), true;
        const data = normalizeQuote(JSON.parse(r.row.dataJson), randomUUID);
        let pdf: Buffer;
        try {
          pdf = await d.render(htmlOf(data));
        } catch (e) {
          audit(db, clock.now(), r.row.chatId, 'error', `presupuesto ${r.row.id}: ${e instanceof Error ? e.message : String(e)}`);
          return json(502, { error: 'No se pudo armar el PDF. Probá de nuevo; si sigue, avisame.', presupuesto: record(r.row) }), true;
        }
        markQuoteSent(db, r.row.id, clock.now());
        const name = quoteFilename(data.clienteNombre);
        const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '');
        send(res, 200, pdf, 'application/pdf', {
          'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'X-Presupuesto-Id': r.row.id,
        });
        return true;
      }
      // Enviar por WhatsApp: guarda, arma el PDF en data/presupuestos y lo pone en la cola del bot como mensaje del equipo (sendQuote).
      case '/crm/presupuestos/enviar': {
        const r = save(body);
        if (!r.ok) return json(r.status, { error: r.error }), true;
        if (!r.row.chatId || !getConversation(db, r.row.chatId)) return json(409, { error: 'Este presupuesto no es de un chat: bajalo en PDF y mandalo vos.', presupuesto: record(r.row) }), true;
        const chatId = r.row.chatId;
        if (getConversation(db, chatId)!.card.state === 'baja') return json(409, { error: 'Este cliente pidió que no le escriban más: desde acá no se le manda nada.', presupuesto: record(r.row) }), true;
        if (sendStatus(r.row.id)?.estado === 'en_cola') return json(409, { error: 'Ya está en la cola: sale en cuanto pueda. No hace falta mandarlo de nuevo.', presupuesto: record(r.row) }), true;
        // Mientras se arma el PDF (unos segundos) el envío anterior puede salir y dejar de estar "en la cola": dos pestañas o un reintento lo mandarían dos veces.
        // Un envío por chat a la vez (un solo proceso: alcanza con memoria).
        if (sending.has(chatId)) return json(409, { error: 'Ya se está mandando un presupuesto a este chat. Esperá unos segundos.', presupuesto: record(r.row) }), true;
        sending.add(chatId);
        try {
          const data = normalizeQuote(JSON.parse(r.row.dataJson), randomUUID);
          let pdf: Buffer;
          try {
            pdf = await d.render(htmlOf(data));
          } catch (e) {
            audit(db, clock.now(), chatId, 'error', `presupuesto ${r.row.id}: ${e instanceof Error ? e.message : String(e)}`);
            return json(502, { error: 'No se pudo armar el PDF. Probá de nuevo; si sigue, avisame.', presupuesto: record(r.row) }), true;
          }
          mkdirSync(d.dir, { recursive: true });
          pruneUnsent();
          const file = join(d.dir, `${r.row.id}-${quoteSendRows(db, r.row.id).length + 1}.pdf`);
          writeFileSync(file, pdf);
          const s = sendQuote(d.ctx, r.row.id, { path: file, filename: quoteFilename(data.clienteNombre) }, WHO);
          const rec = record(getQuote(db, r.row.id)!);
          if (s.status !== 'en_cola') {
            unlinkSync(file);
            return json(409, { error: s.status === 'ya_en_camino' ? 'Ya hay un presupuesto en la cola para este chat: sale en cuanto pueda.' : 'Este presupuesto no es de un chat.', presupuesto: rec }), true;
          }
          const off = getFlag(db, 'kill_switch');
          return json(200, {
            ok: true, presupuesto: rec,
            text: `${off ? 'En la cola: sale cuando prendas el bot' : 'Mandado: sale en unos segundos'} con "${QUOTE_CAPTION}". ${s.quote === 'anotado' ? 'El chat pasó a Presupuestados.' : ''}`.trim(),
          }), true;
        } finally {
          sending.delete(chatId);
        }
      }
    }
    return send(res, 404, 'No existe.', 'text/plain; charset=utf-8'), true;
  }

  return { handle, sendStatus, pruneUnsent };
}
