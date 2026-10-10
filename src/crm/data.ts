// Lo que muestra el CRM, ya en criollo: la lista de chats (con "Hacer ahora": qué hay que hacer y quién espera más), el chat abierto y la franja del bot.
// Solo lee. Las consultas van agregadas (una por tipo de dato, no una por chat): la lista se arma en milisegundos aunque haya cientos de chats.
import type { DatabaseSync } from 'node:sqlite';
import { getConversationByNumber, listConversations, spentSince } from '../db.ts';
import type { Conversation, Db, Stage } from '../db.ts';
import { LABELS, REASONS } from '../ficha.ts';
import { DEDUCED, missingRequired } from '../lead.ts';
import { getFlag, getNum, getState } from '../settings.ts';
import { argentinaClock, argentinaTimeToUtcMs } from '../time.ts';
import { TERMINAL } from '../turn.ts';
import { LEAD_FIELDS } from '../types.ts';
import type { Author, HandoffReason, LeadField, Objection, Temperature } from '../types.ts';

const STUCK_MS = 10 * 60_000; // un chat del bot con el cliente esperando más que esto, sin borrador ni respuesta en camino, pasa a "Te escribió"
const AR_OFFSET_MS = 3 * 3_600_000; // Argentina es UTC-3 todo el año
const DAY_MS = 86_400_000;
const PREVIEW_CHARS = 140;
const CHAT_MESSAGES = 300; // los últimos mensajes que se muestran en el chat abierto
const CHAT_HISTORY = 40; // las últimas acciones del historial
const OLD_CONTACT = 'chat con historia anterior al arranque del bot'; // marca de ingest.ts / startup.ts

// ---------- textos ----------
// Dónde está el cliente, visto por Lazar. Las etapas son las de la base; las otras tres no se guardan, se deducen.
export type StageView = Stage | 'con_el_bot' | 'con_el_equipo' | 'otros';
export const STAGE_LABEL: Record<StageView, string> = {
  con_el_bot: 'Con el bot', a_presupuestar: 'A presupuestar', presupuestado: 'Presupuestados', seguimiento: 'Seguimiento',
  cliente: 'Cliente', perdido: 'Perdido', descartado: 'Descartado', con_el_equipo: 'Con el equipo', otros: 'Otros chats',
};
// Orden de los filtros de la lista.
export const STAGE_ORDER: StageView[] = ['con_el_bot', 'a_presupuestar', 'presupuestado', 'seguimiento', 'cliente', 'perdido', 'descartado', 'con_el_equipo', 'otros'];
// Etapas que se pueden elegir a mano en "Mover a…".
export const MOVABLE: Stage[] = ['a_presupuestar', 'presupuestado', 'seguimiento', 'cliente', 'perdido', 'descartado'];
export const LOST_REASONS = ['Precio', 'Eligió a otro', 'No contestó más', 'Lo dejó para más adelante', 'Otro'] as const;

export type Need = 'borrador' | 'te_escribio' | 'a_presupuestar';
export const NEED_LABEL: Record<Need, string> = { borrador: 'El bot quiere contestar', te_escribio: 'Te escribió', a_presupuestar: 'A presupuestar' };

const VALUE_LABEL: Partial<Record<LeadField, Record<string, string>>> = {
  modelo: { full_panoramica: 'Full Panorámica', panoramica: 'Panorámica' },
  platea: { tiene: 'Ya la tiene', no_tiene: 'No tiene (falta saber si la hacemos)', la_hace_cliente: 'La hace el cliente', quiere_que_la_hagamos: 'Quiere que la hagamos' },
  ubicacion: { techada: 'Techada', aire_libre: 'Al aire libre' },
  uso: { club: 'Club', inversion: 'Inversión', particular: 'Particular', otro: 'Otro' },
  pide_financiacion: { si: 'Sí' },
  vidrio_12mm: { si: 'Sí' },
};
const OBJECTION_LABEL: Record<Objection, string> = {
  precio: 'Precio', confianza: 'Confianza', plazo: 'Plazo', forma_pago: 'Forma de pago', competencia: 'Competencia', consultar_socio: 'Lo consulta con un socio', pensarlo: 'Lo quiere pensar', otro: 'Otra',
};
const TEMPERATURE_LABEL: Record<Temperature, string> = { caliente: 'Caliente', tibio: 'Tibio', frio: 'Frío' };
const MODE_LABEL: Record<Conversation['mode'], string> = { auto: 'Lo atiende el bot', humano: 'Lo atiende el equipo', pausado: 'Pausado', cerrado: 'Cerrado' };
const PAUSE_LABEL: Record<NonNullable<Conversation['pauseReason']>, string> = {
  budget: 'se llegó al gasto del día; vuelve al bot a las 00:00', cap: 'se llegó al tope de chats nuevos del día; vuelve al bot a las 00:00', conv: 'se llegó al gasto máximo de esta conversación',
};
const MEDIA_LABEL: Record<string, string> = { audio: 'Audio', image: 'Foto', video: 'Video', document: 'Documento', sticker: 'Sticker', other: 'Adjunto' };
const fieldValue = (f: LeadField, v: string): string => VALUE_LABEL[f]?.[v] ?? v.replaceAll('_', ' ');

// ---------- tiempos ----------
// "6 min", "3 h 12 min", "2 d 4 h".
export function waitLabel(sinceUtc: number, nowUtc: number): string {
  const m = Math.max(0, Math.floor((nowUtc - sinceUtc) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const arDay = (utc: number): number => Math.floor((utc - AR_OFFSET_MS) / DAY_MS); // número de día en Argentina
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// La promesa al cliente: "en el día, o a más tardar el día hábil siguiente". Día hábil = lunes a sábado (Lazar, 10-oct); los feriados no se descuentan (SIN DATO).
// Vence al terminar el día hábil siguiente al de la derivación, hora argentina.
export function promiseDueUtc(sinceUtc: number): number {
  let day = arDay(sinceUtc) + 1;
  if (new Date(day * DAY_MS).getUTCDay() === 0) day++; // domingo no es hábil
  return (day + 1) * DAY_MS + AR_OFFSET_MS - 1;
}

// "vence hoy", "vence mañana", "vence el lunes", "venció hace 3 h".
export function dueLabel(dueUtc: number, nowUtc: number): { text: string; late: boolean; today: boolean } {
  if (nowUtc > dueUtc) return { text: `venció hace ${waitLabel(dueUtc, nowUtc)}`, late: true, today: false };
  const diff = arDay(dueUtc) - arDay(nowUtc);
  if (diff === 0) return { text: 'vence hoy', late: false, today: true };
  if (diff === 1) return { text: 'vence mañana', late: false, today: false };
  return { text: `vence el ${WEEKDAYS[new Date(arDay(dueUtc) * DAY_MS).getUTCDay()]}`, late: false, today: false };
}

// ---------- lista de chats ----------
export interface ChatListItem {
  n: number; // número corto del chat: va en la URL (?chat=n)
  name: string; // nombre de la ficha, o el del perfil de WhatsApp, o "Chat #n"
  place: string | null; // "Pilar, Buenos Aires"
  stage: StageView;
  stageLabel: string;
  need: Need | null; // qué hay que hacer ahora (null = nada)
  needLabel: string | null;
  waitingSinceUtc: number | null; // desde cuándo espera el cliente (solo si hay algo que hacer)
  waitLabel: string | null;
  due: { text: string; late: boolean; today: boolean } | null; // vencimiento de la promesa del presupuesto (solo A presupuestar con la promesa dicha)
  preview: string; // el último mensaje, en una línea
  previewAuthor: Author | null;
  lastActivityUtc: number;
  lastActivityLabel: string; // "14:03", "ayer", "lun 6/10"
  temperature: Temperature;
  temperatureLabel: string;
  facts: string; // "2 canchas · Full Panorámica · platea: quiere que la hagamos"
  missing: string[]; // datos obligatorios que faltan (en palabras)
}

export interface BotStatus {
  botOn: boolean;
  shadow: boolean;
  whatsapp: string; // estado de la sesión de WAHA, en palabras
  whatsappOk: boolean;
  spentTodayUsd: number;
  budgetUsd: number;
}

export interface ChatFacts {
  firstUnanswered: Map<string, number>; // chat → hora del primer mensaje del cliente sin contestar
  lastMessage: Map<string, { author: Author; text: string; media: string | null; revoked: boolean }>;
  pendingDraft: Map<string, { id: number; createdUtc: number }>;
  discardedDraft: Set<string>; // el último borrador del chat se descartó: el bot no vuelve a proponer hasta que el cliente escriba
  outboxBusy: Set<string>;
  oldContacts: Set<string>;
  promised: Set<string>;
}

const all = <T>(db: DatabaseSync, sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as T[];

// Lo que la lista y el chat abierto necesitan de todos los chats: se carga una vez por pedido y lo usan los dos.
export function loadFacts(db: Db, closingText: string): ChatFacts {
  // El último mensaje del equipo por chat, calculado una sola vez (no una subconsulta por mensaje: con chats largos eso tarda segundos).
  const firstUnanswered = new Map(all<{ chat_id: string; t: number }>(db, `
    SELECT m.chat_id, MIN(m.ts_utc) AS t FROM messages m JOIN conversations c ON c.chat_id = m.chat_id
    LEFT JOIN (SELECT chat_id, MAX(id) AS id FROM messages WHERE author = 'team' GROUP BY chat_id) tm ON tm.chat_id = m.chat_id
    WHERE m.author = 'customer' AND m.revoked = 0 AND m.id > MAX(c.answered_upto, COALESCE(tm.id, 0))
    GROUP BY m.chat_id`).map((r) => [r.chat_id, r.t]));
  const lastMessage = new Map(all<{ chat_id: string; author: Author; text: string; media: string | null; revoked: number }>(db, `
    SELECT m.chat_id, m.author, m.text, m.media, m.revoked FROM messages m
    JOIN (SELECT chat_id, MAX(id) AS id FROM messages WHERE author <> 'system' GROUP BY chat_id) x ON x.id = m.id`)
    .map((r) => [r.chat_id, { author: r.author, text: r.text, media: r.media, revoked: !!r.revoked }]));
  const pendingDraft = new Map(all<{ chat_id: string; id: number; created_utc: number }>(db, "SELECT chat_id, MAX(id) AS id, created_utc FROM drafts WHERE status = 'pendiente' GROUP BY chat_id")
    .map((r) => [r.chat_id, { id: r.id, createdUtc: r.created_utc }]));
  // Si el cliente escribió después del borrador descartado, el bot ya está armando otra respuesta: ahí no cuenta.
  const discardedDraft = new Set(all<{ chat_id: string }>(db, `
    SELECT d.chat_id FROM drafts d JOIN (SELECT chat_id, MAX(id) AS id FROM drafts GROUP BY chat_id) x ON x.id = d.id
    WHERE d.status = 'descartado' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = d.chat_id AND m.author = 'customer' AND m.id > d.answers_upto)`).map((r) => r.chat_id));
  const outboxBusy = new Set(all<{ chat_id: string }>(db, "SELECT DISTINCT chat_id FROM outbox WHERE status IN ('pendiente','en_proceso','incierto')").map((r) => r.chat_id));
  const oldContacts = new Set(all<{ chat_id: string }>(db, "SELECT DISTINCT chat_id FROM audit WHERE kind = 'takeover' AND chat_id IS NOT NULL AND substr(detail, 1, ?) = ?", OLD_CONTACT.length, OLD_CONTACT).map((r) => r.chat_id));
  const promised = new Set(all<{ chat_id: string }>(db, "SELECT DISTINCT chat_id FROM messages WHERE author = 'bot' AND instr(text, ?) > 0", closingText).map((r) => r.chat_id));
  return { firstUnanswered, lastMessage, pendingDraft, discardedDraft, outboxBusy, oldContacts, promised };
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); // "Córdoba" = "cordoba"
function previewOf(m: { text: string; media: string | null; revoked: boolean } | undefined): string {
  if (!m) return '';
  if (m.revoked) return 'Mensaje borrado';
  const text = oneLine(m.text);
  if (text) return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  return m.media ? (m.media === 'audio' ? 'Audio sin escuchar' : MEDIA_LABEL[m.media] ?? 'Adjunto') : '';
}

function activityLabel(utc: number, nowUtc: number): string {
  const d = arDay(nowUtc) - arDay(utc);
  if (d <= 0) return argentinaClock(utc);
  if (d === 1) return 'ayer';
  const date = new Date(utc - AR_OFFSET_MS);
  return `${WEEKDAYS[date.getUTCDay()].slice(0, 3)} ${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
}

export function stageOf(c: Conversation, oldContact: boolean): StageView {
  if (c.stage) return c.stage;
  if (oldContact) return 'otros';
  return c.mode === 'auto' && !TERMINAL.includes(c.card.state) ? 'con_el_bot' : 'con_el_equipo';
}

function nameOf(c: Conversation): string {
  const fromCard = c.card.fields.nombre?.value?.trim();
  if (fromCard) return fromCard;
  const profile = (c.profileName ?? '').trim();
  return profile && !/\d{6,}/.test(profile) ? profile : `Chat #${c.n}`;
}

function factsOf(c: Conversation): string {
  const f = c.card.fields;
  const parts: string[] = [];
  if (f.cantidad_canchas) parts.push(`${f.cantidad_canchas.value} ${f.cantidad_canchas.value === '1' ? 'cancha' : 'canchas'}`);
  if (f.modelo) parts.push(fieldValue('modelo', f.modelo.value));
  if (f.platea) parts.push(`platea: ${fieldValue('platea', f.platea.value).toLowerCase()}`);
  return parts.join(' · ');
}

function itemOf(c: Conversation, facts: ChatFacts, nowUtc: number, killSwitch: boolean): ChatListItem {
  const oldContact = facts.oldContacts.has(c.chatId);
  const stage = stageOf(c, oldContact);
  const unanswered = facts.firstUnanswered.get(c.chatId);
  const draft = facts.pendingDraft.get(c.chatId);
  const botOwns = !killSwitch && c.mode === 'auto' && !TERMINAL.includes(c.card.state);
  let need: Need | null = null;
  let since: number | null = null;
  if (draft) {
    need = 'borrador';
    since = unanswered ?? draft.createdUtc;
  } else if (unanswered !== undefined && stage !== 'otros' && (!botOwns || (!facts.outboxBusy.has(c.chatId) && (facts.discardedDraft.has(c.chatId) || nowUtc - unanswered > STUCK_MS)))) {
    need = 'te_escribio';
    since = unanswered;
  } else if (c.stage === 'a_presupuestar') {
    need = 'a_presupuestar';
    since = c.stageSinceUtc ?? c.lastActivityUtc;
  }
  const promisedDue = c.stage === 'a_presupuestar' && facts.promised.has(c.chatId) && c.stageSinceUtc !== null ? dueLabel(promiseDueUtc(c.stageSinceUtc), nowUtc) : null;
  const last = facts.lastMessage.get(c.chatId);
  const place = [c.card.fields.localidad?.value, c.card.fields.provincia?.value].filter(Boolean).join(', ') || null;
  return {
    n: c.n, name: nameOf(c), place, stage, stageLabel: STAGE_LABEL[stage],
    need, needLabel: need && NEED_LABEL[need], waitingSinceUtc: since, waitLabel: since === null ? null : waitLabel(since, nowUtc),
    due: promisedDue, preview: previewOf(last), previewAuthor: last?.author ?? null,
    lastActivityUtc: c.lastActivityUtc, lastActivityLabel: activityLabel(c.lastActivityUtc, nowUtc),
    temperature: c.card.temperature, temperatureLabel: TEMPERATURE_LABEL[c.card.temperature],
    facts: factsOf(c), missing: missingRequired(c.card).map((f) => LABELS[f]),
  };
}

export type ListFilter = 'ahora' | 'todos' | StageView;
export const isListFilter = (s: string): s is ListFilter => s === 'ahora' || s === 'todos' || (STAGE_ORDER as string[]).includes(s);

export interface ChatList {
  items: ChatListItem[];
  counts: Record<ListFilter, number>;
}

// "Hacer ahora": lo que pide una acción, el que más espera arriba. "Todos" y las etapas: lo último que se movió arriba, como WhatsApp.
export function chatList(db: Db, nowUtc: number, closingText: string, filter: ListFilter, query = '', facts = loadFacts(db, closingText)): ChatList {
  const killSwitch = getFlag(db, 'kill_switch');
  const items = listConversations(db).map((c) => itemOf(c, facts, nowUtc, killSwitch));
  const counts = Object.fromEntries([['ahora', 0], ['todos', 0], ...STAGE_ORDER.map((s) => [s, 0])]) as Record<ListFilter, number>;
  for (const i of items) {
    if (i.need) counts.ahora++;
    if (i.stage !== 'otros') counts.todos++;
    counts[i.stage]++;
  }
  // Buscar es como en WhatsApp: en todos los chats (no solo en el filtro que está abierto) y sin importar tildes ni mayúsculas.
  const q = fold(oneLine(query));
  const shown = q
    ? items.filter((i) => fold(`${i.name} ${i.place ?? ''} #${i.n}`).includes(q))
    : items.filter((i) => (filter === 'ahora' ? i.need !== null : filter === 'todos' ? i.stage !== 'otros' : i.stage === filter));
  shown.sort(filter === 'ahora' && !q ? (a, b) => a.waitingSinceUtc! - b.waitingSinceUtc! : (a, b) => b.lastActivityUtc - a.lastActivityUtc);
  return { items: shown, counts };
}

export function botStatus(db: Db, nowUtc: number, sessionStatus: string): BotStatus {
  const WA: Record<string, string> = { WORKING: 'conectado', SCAN_QR_CODE: 'hay que escanear el QR', STARTING: 'conectando', FAILED: 'con error', STOPPED: 'desconectado' };
  return {
    botOn: !getFlag(db, 'kill_switch'), shadow: getFlag(db, 'shadow_mode'),
    whatsapp: WA[sessionStatus] ?? sessionStatus.toLowerCase(), whatsappOk: sessionStatus === 'WORKING',
    spentTodayUsd: spentSince(db, argentinaTimeToUtcMs('00:00', nowUtc)), budgetUsd: getNum(db, 'daily_budget_usd'),
  };
}

// ---------- chat abierto ----------
export interface ChatMessageView {
  id: number;
  author: Author;
  authorLabel: string; // "Cliente", "Olimpo (bot)", "Equipo", "Aviso"
  text: string; // vacío si es solo un adjunto
  media: string | null; // "Audio", "Foto"… (en palabras)
  timeLabel: string; // "14:03"
  dayLabel: string; // "hoy", "ayer", "lun 6/10": la vista agrupa por día
  edited: boolean;
  revoked: boolean;
}

export interface ChatDetail {
  item: ChatListItem;
  phone: string | null; // solo si el chat es un número (los @lid no tienen)
  waLink: string | null; // https://wa.me/<número>
  modeLabel: string; // "Lo atiende el bot" / "Lo atiende el equipo" / "Pausado: …"
  botAnswers: boolean; // el chat es del bot (para ofrecer [Lo tomo] o [Devolver al bot])
  botOff: boolean; // el bot está apagado: no contesta ni manda nada
  canGiveBack: boolean;
  fields: { label: string; value: string; deduced: boolean }[]; // datos de la ficha, en el orden de siempre
  missing: string[];
  objections: string[];
  teamNote: string;
  handoffLabel: string | null; // por qué el bot lo pasó al equipo (la última derivación)
  quoteSentLabel: string | null; // "Presupuesto mandado el 6/10 a las 14:03"
  lostReason: string | null;
  messages: ChatMessageView[];
  olderHidden: number; // mensajes más viejos que no se muestran
  draft: { id: number; bubbles: string[]; material: string[]; createdLabel: string } | null;
  history: { timeLabel: string; text: string }[]; // acciones y avisos de este chat, lo último primero
  spentUsd: number;
}

const AUTHOR_LABEL: Record<Author, string> = { customer: 'Cliente', bot: 'Olimpo (bot)', team: 'Equipo', system: 'Aviso' };
const HANDOFF_RE = /^([a-z_]+) \((stop|flag), prioridad/;

function dateLabel(utc: number, nowUtc: number): string {
  const d = arDay(nowUtc) - arDay(utc);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  const date = new Date(utc - AR_OFFSET_MS);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
}

// "hoy", "ayer", "el lunes 6/10": para meter en una frase.
const dayPhrase = (utc: number, nowUtc: number): string => {
  const l = dateLabel(utc, nowUtc);
  return l === 'hoy' || l === 'ayer' ? l : `el ${l}`;
};

// Una fila de la auditoría del chat, en criollo. null = no se muestra (lo interno del bot no le sirve a Lazar).
const byWho = (who: string | undefined): string => (!who ? '' : who === 'CRM' ? ' (desde el CRM)' : ` (${who})`);
const stageWord = (s: string): string => STAGE_LABEL[s as Stage] ?? s;
export function historyText(kind: string, detail: string): string | null {
  const who = /\(([^()]+)\)(?:: vuelve al bot)?$/.exec(detail)?.[1];
  switch (kind) {
    case 'handoff': {
      const h = HANDOFF_RE.exec(detail);
      return h ? `${h[2] === 'stop' ? 'Pasó al equipo' : 'Aviso'}: ${REASONS[h[1] as HandoffReason] ?? h[1].replaceAll('_', ' ')}` : null;
    }
    case 'takeover':
      if (detail.startsWith('chat con historia anterior')) return 'Chat de antes del bot: lo atiende el equipo';
      if (detail.startsWith('no pude mirar la historia')) return 'No se pudo revisar la historia del chat: lo atiende el equipo por las dudas';
      if (detail.startsWith('escribió el equipo')) return 'El equipo escribió desde WhatsApp: el chat pasó al equipo';
      if (detail.startsWith('reconciliación')) return 'El equipo escribió con el bot apagado: el chat pasó al equipo';
      return `Pasó al equipo${byWho(who)}`;
    case 'command': {
      if (detail.startsWith('presupuesto_mandado')) return `Presupuesto mandado${byWho(who)}`;
      const e = /^etapa: (.+?) → ([a-z_]+)(?: \((.*)\))? \(([^()]+)\)$/s.exec(detail);
      if (e) return `Etapa: ${e[1] === 'sin etapa' ? 'sin etapa' : stageWord(e[1])} → ${stageWord(e[2])}${e[3] ? ` (${e[3]})` : ''}${byWho(e[4])}`;
      if (detail.endsWith(': vuelve al bot')) return `Volvió al bot${byWho(who)}`;
      if (detail.startsWith('vuelve al bot: terminó el día')) return 'Volvió al bot: empezó un día nuevo';
      if (/^borrador \d+ descartado/.test(detail)) return `Borrador descartado${byWho(who)}`;
      return null;
    }
    case 'alert': {
      if (detail.startsWith('chat pausado: ')) return `Pausado: ${detail.slice('chat pausado: '.length)}`;
      const media = /el cliente mandó (.+?) y el bot no lo lee/.exec(detail);
      if (media) return `Mandó ${media[1]}: el bot no lo lee, miralo vos`;
      if (detail.includes('WhatsApp informó que un mensaje del bot no se pudo entregar')) return 'WhatsApp no pudo entregar un mensaje del bot: revisalo en el celular';
      if (detail.includes('figuraba como no confirmado sí salió')) return 'El mensaje del bot que estaba sin confirmar sí salió';
      if (detail.includes('un audio del cliente quedó sin leer')) return 'Un audio del cliente quedó sin leer';
      if (detail.includes('salió un mensaje por la API que no está en la cola')) return 'Salió un mensaje que no armó el bot: revisalo en el celular';
      if (detail.startsWith('Consulta previa sin contestar')) return 'Chat de antes del bot con una consulta sin contestar';
      if (detail.includes('lleva más de 10 minutos esperando respuesta del bot')) return 'Esperó más de 10 minutos la respuesta del bot';
      return null; // los demás (saldo, tope del día…) son del bot entero, no de este chat; o ya los dice otra fila
    }
    case 'error':
      if (detail.startsWith('audio ilegible')) return 'Mandó un audio que no se pudo escuchar';
      if (detail.startsWith('consulta_vencida')) return 'El bot no contestó: el mensaje era muy viejo';
      if (detail.startsWith('salida ')) return detail.endsWith(': no_confirmado') ? 'Un mensaje del bot quedó sin confirmar: revisalo en el celular antes de reenviar' : 'No salió un mensaje del bot';
      if (detail.startsWith('turno: ')) return 'El bot tuvo un error y no contestó';
      return null;
  }
  return null;
}

export function chatDetail(db: Db, n: number, nowUtc: number, closingText: string, facts = loadFacts(db, closingText)): ChatDetail | undefined {
  const c = getConversationByNumber(db, n);
  if (!c) return undefined;
  const item = itemOf(c, facts, nowUtc, getFlag(db, 'kill_switch'));
  const phone = /^(\d{8,15})@c\.us$/.exec(c.chatId)?.[1] ?? null;

  const total = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(c.chatId) as { n: number }).n;
  const rows = all<{ id: number; author: Author; text: string; media: string | null; ts_utc: number; edited: number; revoked: number; transcript_status: string | null }>(db,
    'SELECT id, author, text, media, ts_utc, edited, revoked, transcript_status FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?', c.chatId, CHAT_MESSAGES).reverse();
  const messages: ChatMessageView[] = rows.map((r) => ({
    id: r.id, author: r.author, authorLabel: AUTHOR_LABEL[r.author], text: r.text,
    media: r.media ? (r.media === 'audio' && r.transcript_status === 'pendiente' ? 'Audio sin escuchar' : MEDIA_LABEL[r.media] ?? 'Adjunto') : null,
    timeLabel: argentinaClock(r.ts_utc), dayLabel: dateLabel(r.ts_utc, nowUtc), edited: !!r.edited, revoked: !!r.revoked,
  }));

  const d = facts.pendingDraft.get(c.chatId);
  const draftRow = d && (db.prepare('SELECT bubbles_json, material_json, created_utc FROM drafts WHERE id = ?').get(d.id) as { bubbles_json: string; material_json: string; created_utc: number });
  // Se piden de más porque algunas filas no se muestran.
  const history = all<{ ts_utc: number; kind: string; detail: string }>(db, "SELECT ts_utc, kind, detail FROM audit WHERE chat_id = ? AND kind IN ('handoff','takeover','command','alert','error') ORDER BY id DESC LIMIT ?", c.chatId, CHAT_HISTORY * 3)
    .flatMap((a) => {
      const text = historyText(a.kind, a.detail);
      return text ? [{ timeLabel: `${dateLabel(a.ts_utc, nowUtc)} ${argentinaClock(a.ts_utc)}`, text }] : [];
    }).slice(0, CHAT_HISTORY);
  // Por qué pasó al equipo: la última derivación con stop, aunque sea vieja.
  const lastStop = db.prepare("SELECT detail FROM audit WHERE chat_id = ? AND kind = 'handoff' AND detail LIKE '% (stop, %' ORDER BY id DESC LIMIT 1").get(c.chatId) as { detail: string } | undefined;
  const reason = lastStop && (HANDOFF_RE.exec(lastStop.detail)?.[1] as HandoffReason | undefined);
  const quoteSent = getState(db, `quote_sent_utc.${c.chatId}`);
  const botAnswers = c.mode === 'auto' && !TERMINAL.includes(c.card.state);
  const botOff = getFlag(db, 'kill_switch');

  return {
    item, phone, waLink: phone && `https://wa.me/${phone}`,
    modeLabel: c.mode === 'pausado' && c.pauseReason ? `Pausado: ${PAUSE_LABEL[c.pauseReason]}`
      : c.mode === 'auto' && !botAnswers ? 'Con el bot, pero el bot ya terminó con este cliente y no le escribe'
      : botAnswers && botOff ? 'Con el bot, pero el bot está apagado' : MODE_LABEL[c.mode],
    botAnswers, botOff, canGiveBack: c.mode !== 'auto',
    fields: LEAD_FIELDS.filter((f) => c.card.fields[f]).map((f) => ({ label: LABELS[f], value: fieldValue(f, c.card.fields[f]!.value), deduced: c.card.fields[f]!.evidenceMsgId.startsWith(DEDUCED) })),
    missing: item.missing, objections: c.card.objections.map((o) => OBJECTION_LABEL[o]), teamNote: c.card.teamNote,
    handoffLabel: reason ? REASONS[reason] ?? reason : null,
    quoteSentLabel: quoteSent ? `Presupuesto mandado ${dayPhrase(Number(quoteSent), nowUtc)} a las ${argentinaClock(Number(quoteSent))}` : null,
    lostReason: c.lostReason,
    messages, olderHidden: Math.max(0, total - rows.length),
    draft: draftRow ? { id: d!.id, bubbles: JSON.parse(draftRow.bubbles_json) as string[], material: JSON.parse(draftRow.material_json) as string[], createdLabel: argentinaClock(draftRow.created_utc) } : null,
    history,
    spentUsd: c.botSpentUsd,
  };
}

// ---------- lo que recibe la vista ----------
export interface AppView {
  status: BotStatus;
  filter: ListFilter;
  query: string;
  list: ChatList;
  chat: ChatDetail | null; // el chat abierto (?chat=n), o null
  flash: { text: string; ok: boolean } | null; // resultado de la última acción (sin JavaScript llega por la URL)
  back: string; // la URL actual (/crm/?f=…&q=…&chat=…): los formularios la mandan para volver al mismo lugar
}
