// Telegram (Bot API con fetch, sin dependencias): long polling, fichas con botones, borradores del modo sombra, comandos y avisos.
// Solo se atiende el grupo TELEGRAM_GROUP_ID: lo demás se ignora sin contestar. Todo va en texto plano (sin parse_mode): lo que escribe un cliente no puede inyectar formato.
// Cada chat se nombra por su número corto de conversación, nunca por el teléfono.
import type { Clock } from '../clock.ts';
import {
  audit, chatLabel, getConversation, getConversationByNumber, getDraft, historyFor, listConversations, outboxCounts, pendingInboundCount, setDraftStatus,
  setDraftTelegramMessage, setMode, spentSince, switchToHuman, unansweredMessages,
} from '../db.ts';
import type { Conversation, Db } from '../db.ts';
import { buildFicha } from '../ficha.ts';
import { approveDraft } from '../outbox.ts';
import type { Asset } from '../policy.ts';
import { SETTING_KEYS, getFlag, getNum, getState, isSettingKey, setSetting, setState } from '../settings.ts';
import { argentinaClock, argentinaTimeToUtcMs } from '../time.ts';
import { TERMINAL } from '../turn.ts';
import type { ChatMessage, HandoffDecision, LeadCard } from '../types.ts';
import type { AlertOpts, Notifier } from './types.ts';

const MAX_TEXT = 4096; // límite de Telegram por mensaje
const POLL_SECONDS = 25; // long polling
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]; // cuando Telegram no contesta
// La hora del primer arranque define qué chats son del equipo: no se toca desde el chat de Telegram (ni se ofrece en la lista de claves).
const SETTABLE = SETTING_KEYS.filter((k) => k !== 'bot_start_utc');
const AUTHOR: Record<ChatMessage['author'], string> = { customer: 'cliente', bot: 'olimpo', team: 'equipo', system: 'sistema' };
const MODE: Record<Conversation['mode'], string> = { auto: 'con el bot', humano: 'con el equipo', pausado: 'pausado', cerrado: 'cerrado' };

// ---------- texto ----------
// Caracteres de control y de dirección del texto (un cliente puede mandarlos): se sacan antes de mostrarlo.
// Los rangos van como números: ni un carácter de control ni uno de dirección escrito en el código.
const UNSAFE: [number, number][] = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x202a, 0x202e], [0x2066, 0x2069]];
const clean = (s: string): string => Array.from(s).filter((ch) => { const c = ch.codePointAt(0)!; return !UNSAFE.some(([from, to]) => c >= from && c <= to); }).join('');
const flat = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

export function clip(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  const tail = '\n[recortado]';
  let cut = s.slice(0, max - tail.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // no partir un emoji a la mitad
  return cut + tail;
}
const plain = (s: string): string => clip(clean(s));

// "#3" o "#3 · Pedro". El nombre de perfil del cliente ayuda a encontrar el chat en el celular; si parece un teléfono no se muestra.
function label(conv: Conversation): string {
  const name = clean(conv.profileName ?? '').trim().slice(0, 40);
  return name && !/\d{6,}/.test(name) ? `#${conv.n} · ${name}` : `#${conv.n}`;
}

interface Button { text: string; callback_data: string }
const keyboard = (rows: [string, string][][]): { inline_keyboard: Button[][] } => ({ inline_keyboard: rows.map((r) => r.map(([text, callback_data]) => ({ text, callback_data }))) });

const rank = (d: HandoffDecision): number => (d.mode === 'stop' ? 0 : 3) + { alta: 0, normal: 1, baja: 2 }[d.priority];

// Una sola ficha por turno: la derivación que frena al bot (o la más urgente) arma la ficha y las demás van en una línea.
function fichaMessage(db: Db, chatId: string, card: LeadCard, decisions: HandoffDecision[]): { text: string; markup: ReturnType<typeof keyboard> } | undefined {
  const conv = getConversation(db, chatId);
  if (!conv || !decisions.length) return undefined;
  const [primary, ...others] = [...decisions].sort((a, b) => rank(a) - rank(b));
  const extra = others.map((d) => buildFicha(card, [], d).split('\n')[0]);
  const text = [`Chat ${label(conv)}`, buildFicha(card, historyFor(db, chatId, 6), primary), ...(extra.length ? ['', `Además: ${extra.join(' | ')}`] : [])].join('\n');
  return { text, markup: keyboard([[['Lo tomo', `tomo:${conv.n}`], ['Devolver al bot', `bot:${conv.n}`]], [['Presupuesto mandado', `presu:${conv.n}`]]]) };
}

function draftMessage(db: Db, assets: Asset[], chatId: string, draftId: number, bubbles: string[], material: string[]): { text: string; markup: ReturnType<typeof keyboard> } {
  const conv = getConversation(db, chatId);
  const said = unansweredMessages(db, chatId).slice(-3).map((m) => `> ${flat(m.text).slice(0, 300)}`);
  const photos = material.map((id) => `${id} (${assets.find((a) => a.id === id)?.archivos.length ?? '?'} fotos)`);
  const text = [
    `Borrador #${draftId} · chat ${conv ? label(conv) : '#?'} (modo sombra: todavía no se mandó nada)`,
    '',
    'El cliente dijo:',
    ...(said.length ? said : ['(sin mensajes nuevos)']),
    '',
    'El bot contestaría:',
    ...bubbles.map((b, i) => `${i + 1}) ${b}`),
    ...(photos.length ? ['', `Fotos: ${photos.join(', ')}`] : []),
  ].join('\n');
  return { text, markup: keyboard([[['Mandar', `mandar:${draftId}`], ['Descartar', `desc:${draftId}`]], [['Lo tomo', `dtomo:${draftId}`]]]) };
}

const takeoverText = (db: Db, chatId: string): string =>
  `Chat ${chatLabel(db, chatId)}: alguien del equipo escribió desde el celular o la Web. El bot dejó de contestar ese chat. Si querés que vuelva: /bot ${chatLabel(db, chatId).slice(1)}`;

// ---------- sin token: los mismos avisos por consola ----------
export function createConsoleNotifier(db: Db, log: (line: string) => void = (s) => console.log(s)): Notifier {
  return {
    alert: (text: string, opts?: AlertOpts) => log(`[aviso] ${opts?.urgent ? 'URGENTE: ' : ''}${plain(text)}`),
    handoff(chatId, card, decisions) {
      const m = fichaMessage(db, chatId, card, decisions);
      if (m) log(`[ficha] ${plain(m.text)}`);
    },
    draft: (chatId, draftId, bubbles, material) => log(`[borrador #${draftId}] chat ${chatLabel(db, chatId)}: ${plain(bubbles.join(' / '))}${material.length ? ` (+ fotos: ${material.join(', ')})` : ''}`),
    takeover: (chatId) => log(`[aviso] ${takeoverText(db, chatId)}`),
  };
}

// ---------- Telegram ----------
// Lo que hace falta del resto de la tubería. Se pasa como función porque Telegram se crea antes que el worker (el worker usa el notificador).
export interface TelegramControls {
  worker: { onCustomerMessage(chatId: string): void; rescan(): void };
  kickOutbox: () => void;
  session: { current(): string; qr(): Promise<{ data: Uint8Array; mimetype: string }> };
}

export interface TelegramOptions {
  db: Db;
  clock: Clock;
  token: string;
  groupId: string;
  assets: Asset[];
  assetsDir?: URL;
  controls: () => TelegramControls;
  fetch?: typeof fetch;
}

export interface Telegram extends Notifier {
  alert(text: string, opts?: AlertOpts): Promise<void>;
  handoff(chatId: string, card: LeadCard, decisions: HandoffDecision[]): Promise<void>;
  draft(chatId: string, draftId: number, bubbles: string[], material: string[]): Promise<void>;
  takeover(chatId: string): Promise<void>;
  start(): void; // arranca el long polling
  stop(): void; // lo corta (aborta el getUpdates en vuelo)
  pollOnce(): Promise<number>; // una vuelta de getUpdates: devuelve cuántos updates procesó
}

interface TgUser { first_name?: string; username?: string }
interface TgMessage { message_id: number; chat?: { id: number }; from?: TgUser; text?: string }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: { id: string; from?: TgUser; data?: string; message?: TgMessage } }
const num = (s?: string): number | undefined => {
  const m = /^#?(\d{1,9})$/.exec(s ?? '');
  return m ? Number(m[1]) : undefined;
};
const HELP = [
  'No entendí. Comandos:',
  '/estado: cómo está el bot',
  '/chat n: últimos mensajes del chat n',
  '/bot n: devolver el chat n al bot',
  '/humano n: el chat n lo atendés vos',
  '/apagar y /prender: cortar o retomar todo',
  '/sombra on|off: borradores para confirmar o respuestas directas',
  '/set clave valor: cambiar un ajuste',
  '/qr: QR para vincular WhatsApp',
].join('\n');

export function createTelegram(o: TelegramOptions): Telegram {
  const { db, clock } = o;
  const fetchFn = o.fetch ?? fetch;
  const stopper = new AbortController();
  let stopped = false;
  let started = false;
  let wake: (() => void) | undefined;

  const scrub = (s: string): string => s.replaceAll(o.token, '***');
  async function call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${o.token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'Content-Type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (e) {
      if (signal?.aborted && stopped) throw e; // el stop() corta el long polling a propósito
      throw new Error(`Telegram ${method}: ${scrub(e instanceof Error ? e.message : String(e))}`);
    }
    const json = (await res.json().catch(() => undefined)) as { ok?: boolean; result?: T; description?: string } | undefined;
    if (!res.ok || !json?.ok) throw new Error(`Telegram ${method}: ${scrub(json?.description ?? `HTTP ${res.status}`)}`);
    return json.result as T;
  }

  const send = (text: string, extra: Record<string, unknown> = {}) =>
    call<{ message_id: number }>('sendMessage', { chat_id: o.groupId, text: plain(text), link_preview_options: { is_disabled: true }, ...extra });

  // ---------- Notifier ----------
  async function alert(text: string, opts?: AlertOpts): Promise<void> {
    await send(`${opts?.urgent ? 'URGENTE: ' : ''}${text}`, { disable_notification: !opts?.urgent });
  }
  async function handoff(chatId: string, card: LeadCard, decisions: HandoffDecision[]): Promise<void> {
    const m = fichaMessage(db, chatId, card, decisions);
    if (m) await send(m.text, { reply_markup: m.markup });
  }
  async function draft(chatId: string, draftId: number, bubbles: string[], material: string[]): Promise<void> {
    const m = draftMessage(db, o.assets, chatId, draftId, bubbles, material);
    const sent = await send(m.text, { reply_markup: m.markup });
    setDraftTelegramMessage(db, draftId, sent.message_id);
  }
  async function takeover(chatId: string): Promise<void> {
    const conv = getConversation(db, chatId);
    await send(takeoverText(db, chatId), conv ? { reply_markup: keyboard([[['Devolver al bot', `bot:${conv.n}`]]]) } : {});
  }

  // ---------- acciones sobre una conversación (las usan los botones y los comandos) ----------
  const takeOver = (conv: Conversation, who: string, via: string): string =>
    switchToHuman(db, conv.chatId, clock.now(), `${via} (${who})`) ? `#${conv.n}: lo tomó ${who}. El bot no le contesta más.` : `#${conv.n} ya estaba en manos del equipo.`;

  function giveBack(conv: Conversation, who: string, via: string): string {
    if (conv.mode === 'auto') return `#${conv.n} ya estaba con el bot.`;
    setMode(db, conv.chatId, 'auto');
    audit(db, clock.now(), conv.chatId, 'command', `${via} (${who}): vuelve al bot`);
    o.controls().worker.onCustomerMessage(conv.chatId); // si el cliente dejó algo sin contestar, el turno se programa ya
    return TERMINAL.includes(conv.card.state)
      ? `#${conv.n} vuelve a auto, pero la ficha está en "${conv.card.state.replaceAll('_', ' ')}": el bot no le escribe.`
      : `#${conv.n}: vuelve con el bot (${who}). Si el cliente dejó algo sin contestar, lo retoma enseguida.`;
  }

  function quoteSent(conv: Conversation, who: string): string {
    const key = `quote_sent_utc.${conv.chatId}`;
    const before = getState(db, key);
    if (before) return `#${conv.n}: el presupuesto ya estaba anotado (${argentinaClock(Number(before))}).`;
    setState(db, key, String(clock.now())); // F4 arma los recordatorios (días 1, 3, 7, 14 y 21) desde esta hora
    audit(db, clock.now(), conv.chatId, 'command', `presupuesto_mandado (${who})`);
    return `#${conv.n}: anotado, presupuesto mandado a las ${argentinaClock(clock.now())}.`;
  }

  // ---------- botones ----------
  async function onButton(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const m = /^(tomo|bot|presu|mandar|desc|dtomo):(\d{1,9})$/.exec(q.data ?? '');
    if (!m) return;
    const [, verb, rawId] = m;
    const id = Number(rawId);
    const who = clean(q.from?.first_name ?? q.from?.username ?? 'alguien').slice(0, 30);
    const toast = (text: string, popup = false) => call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: popup }).catch(() => undefined);
    // Cierra el mensaje del borrador: le agrega lo que pasó y le saca los botones.
    const finish = async (status: string) => {
      if (!q.message) return;
      await call('editMessageText', { chat_id: o.groupId, message_id: q.message.message_id, text: plain(`${q.message.text ?? ''}\n\n${status}`), reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true } }).catch(() => undefined);
    };

    if (verb === 'tomo' || verb === 'bot' || verb === 'presu') {
      const conv = getConversationByNumber(db, id);
      if (!conv) return void (await toast(`No existe la conversación #${id}.`));
      const reply = verb === 'tomo' ? takeOver(conv, who, 'botón [Lo tomo]') : verb === 'bot' ? giveBack(conv, who, 'botón [Devolver al bot]') : quoteSent(conv, who);
      await toast('Listo.');
      await send(reply);
      return;
    }

    const d = getDraft(db, id);
    if (!d) return void (await toast('No existe el borrador.'));
    if (verb === 'mandar') {
      const r = approveDraft(db, id, o.assets, clock.now(), o.assetsDir);
      if (r === 'enviado') {
        o.controls().kickOutbox();
        await finish(`Mandado por ${who}`);
        return void (await toast('Mandado: sale en unos segundos.'));
      }
      const status = getDraft(db, id)!.status;
      if (r === 'vencido' || status === 'vencido') {
        await finish('VENCIDO: el cliente escribió de nuevo, no se mandó. Mirá el borrador nuevo.');
        return void (await toast('Vencido: el cliente escribió de nuevo y el borrador ya no vale.', true));
      }
      return void (await toast(status === 'mandado' ? 'Ya estaba mandado.' : status === 'descartado' ? 'Ya estaba descartado.' : 'Ya no está pendiente.'));
    }
    if (verb === 'desc') {
      if (d.status !== 'pendiente') return void (await toast(`Ya no está pendiente (${d.status}).`));
      setDraftStatus(db, id, 'descartado');
      audit(db, clock.now(), d.chatId, 'command', `borrador ${id} descartado (${who})`);
      await finish(`Descartado por ${who}`);
      return void (await toast('Descartado.'));
    }
    // dtomo: [Lo tomo] del borrador
    const conv = getConversation(db, d.chatId);
    if (!conv) return void (await toast('No existe la conversación.'));
    takeOver(conv, who, 'botón [Lo tomo] del borrador');
    await finish(`Lo tomó ${who}: el borrador queda descartado y el bot no le contesta más.`);
    await toast('Listo: lo tomaste.');
  }

  // ---------- comandos ----------
  function estado(): string {
    const convs = listConversations(db);
    const count = (mode: Conversation['mode']) => convs.filter((c) => c.mode === mode).length;
    const queue = Object.entries(outboxCounts(db)).filter(([s]) => ['pendiente', 'en_proceso', 'incierto', 'fallido'].includes(s)).map(([s, n]) => `${n} ${s}`);
    const unprocessed = pendingInboundCount(db);
    return [
      'Estado del bot',
      getFlag(db, 'kill_switch') ? 'Bot: APAGADO (no contesta ni manda nada; /prender lo retoma)' : 'Bot: prendido',
      `Modo sombra: ${getFlag(db, 'shadow_mode') ? 'sí (los borradores esperan tu [Mandar])' : 'no (le escribe directo a los clientes)'}`,
      `WhatsApp: ${o.controls().session.current()}`,
      `Cola de salida: ${queue.join(', ') || 'vacía'}${unprocessed ? ` · ${unprocessed} eventos sin procesar` : ''}`,
      `Gasto de hoy: USD ${spentSince(db, argentinaTimeToUtcMs('00:00', clock.now())).toFixed(2)} de ${getNum(db, 'daily_budget_usd')}`,
      `Chats: ${count('auto')} con el bot, ${count('humano')} con el equipo, ${count('pausado')} pausados`,
    ].join('\n');
  }

  function chat(n: number | undefined): string {
    if (!n) return 'Uso: /chat n (el número que va en cada ficha).';
    const conv = getConversationByNumber(db, n);
    if (!conv) return `No existe la conversación #${n}.`;
    const lines = historyFor(db, conv.chatId, 10).map((m) => {
      const t = flat(m.text);
      return `${AUTHOR[m.author]}  ${argentinaClock(m.tsUtcMs)}  ${t.length > 300 ? `${t.slice(0, 300)}...` : t}`;
    });
    return [`Chat ${label(conv)} · ${MODE[conv.mode]} · ${conv.card.state.replaceAll('_', ' ')}`, ...(lines.length ? lines : ['(sin mensajes)'])].join('\n');
  }

  function withConversation(arg: string | undefined, usage: string, f: (c: Conversation) => string): string {
    const n = num(arg);
    if (!n) return usage;
    const conv = getConversationByNumber(db, n);
    return conv ? f(conv) : `No existe la conversación #${n}.`;
  }

  async function qr(): Promise<string | undefined> {
    try {
      const { data, mimetype } = await o.controls().session.qr();
      const form = new FormData();
      form.append('chat_id', o.groupId);
      form.append('caption', 'Escaneá este QR con el WhatsApp del número del bot: Ajustes > Dispositivos vinculados > Vincular un dispositivo. Dura poco: si vence, mandá /qr de nuevo.');
      form.append('photo', new Blob([data as BlobPart], { type: mimetype }), 'qr.png');
      await call('sendPhoto', form);
      return undefined;
    } catch (e) {
      return `No pude traer el QR: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function onCommand(m: TgMessage): Promise<void> {
    const [raw, ...args] = (m.text ?? '').trim().split(/\s+/);
    const cmd = raw.slice(1).split('@')[0].toLowerCase(); // en grupos Telegram manda /estado@NombreDelBot
    const who = clean(m.from?.first_name ?? m.from?.username ?? 'alguien').slice(0, 30);
    const known = ['estado', 'chat', 'bot', 'humano', 'apagar', 'prender', 'sombra', 'set', 'qr'];
    if (!known.includes(cmd)) return void (await send(HELP));
    audit(db, clock.now(), null, 'command', `/${cmd}${args.length ? ` ${args.join(' ').slice(0, 80)}` : ''} (${who})`);

    let reply: string | undefined;
    switch (cmd) {
      case 'estado': reply = estado(); break;
      case 'chat': reply = chat(num(args[0])); break;
      case 'bot': reply = withConversation(args[0], 'Uso: /bot n (el número que va en cada ficha).', (c) => giveBack(c, who, '/bot')); break;
      case 'humano': reply = withConversation(args[0], 'Uso: /humano n (el número que va en cada ficha).', (c) => takeOver(c, who, '/humano')); break;
      case 'apagar':
        setSetting(db, 'kill_switch', '1');
        reply = 'Bot apagado: no contesta ni manda nada hasta que mandes /prender.';
        break;
      case 'prender':
        setSetting(db, 'kill_switch', '0');
        o.controls().worker.rescan(); // retoma las consultas que quedaron esperando
        reply = 'Bot prendido.';
        break;
      case 'sombra': {
        const v = args[0]?.toLowerCase();
        if (v === 'on' || v === 'off') {
          setSetting(db, 'shadow_mode', v === 'on' ? '1' : '0');
          reply = v === 'on' ? 'Modo sombra prendido: los borradores te esperan acá con [Mandar] y el bot no le escribe a nadie.' : 'Modo sombra apagado: desde ahora el bot le escribe directo a los clientes.';
        } else reply = `Modo sombra: ${getFlag(db, 'shadow_mode') ? 'prendido' : 'apagado'}. Usá /sombra on o /sombra off.`;
        break;
      }
      case 'set': {
        const [key, ...rest] = args;
        const value = rest.join(' ');
        if (!key || value === '') reply = `Uso: /set clave valor. Claves: ${SETTABLE.join(', ')}`;
        else if (key === 'bot_start_utc') reply = `bot_start_utc no se cambia desde Telegram (define qué chats son del equipo). Claves: ${SETTABLE.join(', ')}`;
        else if (!isSettingKey(key)) reply = `La clave ${clean(key).slice(0, 40)} no existe. Claves: ${SETTABLE.join(', ')}`;
        else {
          try {
            setSetting(db, key, value);
            if (key === 'kill_switch' && value === '0') o.controls().worker.rescan();
            reply = `Listo: ${key} = ${value}`;
          } catch (e) {
            reply = e instanceof Error ? e.message : String(e);
          }
        }
        break;
      }
      case 'qr': reply = await qr(); break;
    }
    if (reply) await send(reply);
  }

  // ---------- long polling ----------
  const inGroup = (chat?: { id: number }): boolean => !!chat && String(chat.id) === o.groupId.trim();

  async function handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      if (inGroup(u.callback_query.message?.chat)) await onButton(u.callback_query);
      return;
    }
    const m = u.message;
    if (m && inGroup(m.chat) && m.text?.startsWith('/')) await onCommand(m); // lo demás es charla del grupo
  }

  async function pollOnce(): Promise<number> {
    const offset = Number(getState(db, 'telegram_offset') ?? '0');
    const updates = await call<TgUpdate[]>('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
      AbortSignal.any([stopper.signal, AbortSignal.timeout((POLL_SECONDS + 15) * 1000)]));
    for (const u of updates) {
      try {
        await handleUpdate(u);
      } catch (e) {
        audit(db, clock.now(), null, 'error', `telegram: no pude atender un mensaje del grupo: ${e instanceof Error ? e.message : String(e)}`);
      }
      setState(db, 'telegram_offset', String(u.update_id + 1)); // recién después de atenderlo: si el proceso muere, se reprocesa en vez de perderse
    }
    return updates.length;
  }

  async function loop(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      try {
        await pollOnce();
        failures = 0;
      } catch (e) {
        if (stopped) return;
        if (failures % 10 === 0) audit(db, clock.now(), null, 'error', `telegram: ${e instanceof Error ? e.message : String(e)}`); // la primera vez y cada tanto, sin llenar la auditoría
        const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
        await new Promise<void>((resolve) => {
          const t = clock.setTimeout(() => resolve(), wait);
          wake = () => { clock.clearTimeout(t); resolve(); };
        });
      }
    }
  }

  return {
    alert, handoff, draft, takeover, pollOnce,
    start() {
      if (started) return;
      started = true;
      void loop();
    },
    stop() {
      stopped = true;
      stopper.abort();
      wake?.();
    },
  };
}
