// Las pantallas del CRM, armadas en el servidor con la plantilla html`` (escapa todo lo que se interpola).
// Estilo en public/crm.css y comportamiento en public/crm.js: la CSP no deja style=, <style> ni handlers inline.
// Sin JavaScript todo anda igual: los formularios postean a /crm/accion y vuelven por 303.
import { LOST_REASONS, MOVABLE, STAGE_LABEL, STAGE_ORDER } from './data.ts';
import type { AppView, ChatDetail, ChatListItem, ChatMessageView, ListFilter, StageView } from './data.ts';
import { REASONS } from '../ficha.ts';
import { html, trusted } from './html.ts';
import type { Html } from './html.ts';
import type { Author } from '../types.ts';

// ---------- piezas chicas ----------
// Íconos propios: trazo de 1,75 sobre una grilla de 24, sin relleno. Los paths son literales de este archivo.
const ICON_PATHS = {
  volver: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  abajo: '<path d="M6 9l6 6 6-6"/>',
  buscar: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  foto: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  video: '<rect x="3.5" y="6" width="12" height="12" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  archivo: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
  afuera: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  aviso: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
} as const;
type IconName = keyof typeof ICON_PATHS;
const icon = (name: IconName): Html =>
  trusted(`<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`);

const usd = (n: number, maxDecimals = 2): string => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: maxDecimals });
const current = (on: boolean): Html | '' => (on ? trusted(' aria-current="page"') : '');

// /crm/?f=<filtro>&q=<búsqueda>&chat=<n>, igual que arma la URL el servidor (f se omite si es "ahora").
function crmUrl(filter: ListFilter, query: string, chat?: number): string {
  const p = new URLSearchParams();
  if (filter !== 'ahora') p.set('f', filter);
  if (query) p.set('q', query);
  if (chat) p.set('chat', String(chat));
  return `/crm/${p.size ? `?${p}` : ''}`;
}

// Un formulario de acción: vuelve a la misma pantalla (back) y manda los campos fijos (n, d) más el botón que se apretó (name="a").
function actionForm(v: AppView, hidden: Record<string, string | number>, buttons: Html[]): Html {
  return html`<form class="acciones" method="post" action="/crm/accion"><input type="hidden" name="back" value="${v.back}">${Object.entries(hidden).map(([k, x]) => html`<input type="hidden" name="${k}" value="${x}">`)}${buttons}</form>`;
}
// `confirma`: la pregunta antes de hacerlo (la muestra crm.js; sin JavaScript no hay pregunta).
const button = (action: string, label: string, kind: 'primary' | 'secondary' = 'secondary', confirma?: string): Html =>
  html`<button type="submit" name="a" value="${action}" class="btn btn-${kind}"${confirma ? html` data-confirma="${confirma}"` : ''}>${label}</button>`;

// ---------- documento ----------
function head(title: string): Html {
  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" type="image/png" href="/crm/static/icono.png">
<link rel="preload" href="/crm/static/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/crm/static/crm.css">
<script src="/crm/static/crm.js" defer></script>
</head>`;
}

function toast(flash: NonNullable<AppView['flash']>, back: string): Html {
  return html`<div class="toast${flash.ok ? '' : ' toast-mal'}" role="status">${icon(flash.ok ? 'ok' : 'aviso')}<p>${flash.text}</p><a class="toast-x" href="${back}">Cerrar</a></div>`;
}

export function appPage(v: AppView): Html {
  return html`<html lang="es">
${head('Olimpo Padel · CRM')}
<body>
<h1 class="sr">CRM de Olimpo Padel</h1>
<header id="estado" class="barra">${statusFragment(v)}</header>
<div class="paneles">
<nav id="lista" class="lista" aria-label="Chats">${listFragment(v)}</nav>
<main id="chat" class="chat">${chatFragment(v)}</main>
</div>
<div id="aviso" class="avisos" aria-live="polite">${v.flash ? toast(v.flash, v.back) : ''}</div>
</body>
</html>`;
}

// Pantallas sueltas (clave y CRM apagado): una tarjeta centrada con el logo.
function soloPage(title: string, body: Html): Html {
  return html`<html lang="es">
${head(`${title} · Olimpo Padel`)}
<body class="solo">
<main class="entrada">
<div class="entrada-marca"><img src="/crm/static/logo.png" alt="Olimpo Padel" width="150" height="43"></div>
<div class="entrada-cuerpo">${body}</div>
</main>
</body>
</html>`;
}

export function loginPage(o: { error?: string }): Html {
  return soloPage('Entrar', html`<h1>Entrar al CRM</h1>
<form class="clave" method="post" action="/crm/login">
<label for="clave">Clave</label>
<input id="clave" name="clave" type="password" autocomplete="current-password" required autofocus>
${o.error ? html`<p class="error" role="alert">${icon('aviso')}<span>${o.error}</span></p>` : ''}
<button type="submit" class="btn btn-primary">Entrar</button>
</form>`);
}

export function offPage(reason: string): Html {
  return soloPage('CRM apagado', html`<h1>El CRM está apagado</h1>
<p>${reason}</p>
<p class="suave">Cuando lo arregles, reiniciá el bot y recargá esta página.</p>`);
}

// ---------- franja de arriba ----------
function toggle(v: AppView, label: string, on: boolean, action: string, title: string): Html {
  return html`<form class="interruptor" method="post" action="/crm/accion"><input type="hidden" name="back" value="${v.back}"><button type="submit" name="a" value="${action}" class="sw" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${title}"><span class="sw-pista" aria-hidden="true"><span class="sw-bolita"></span></span><span class="sw-nombre">${label}</span><span class="sw-estado" aria-hidden="true">${on ? 'Prendido' : 'Apagado'}</span></button></form>`;
}

export function statusFragment(v: AppView): Html {
  const s = v.status;
  return html`<a class="logo" href="/crm/"><img src="/crm/static/logo.png" alt="Olimpo Padel" width="84" height="24"></a>
${toggle(v, 'Bot', s.botOn, s.botOn ? 'apagar' : 'prender', s.botOn ? 'Prendido: atiende a los clientes. Tocá para apagarlo.' : 'Apagado: no contesta ni manda nada. Tocá para prenderlo.')}
${toggle(v, 'Modo sombra', s.shadow, s.shadow ? 'sombra_off' : 'sombra_on', s.shadow ? 'Prendido: el bot arma borradores y no le escribe a nadie hasta que los mandes vos. Tocá para apagarlo.' : 'Apagado: el bot le escribe directo a los clientes. Tocá para prenderlo.')}
<a class="btn btn-barra" href="/crm/presupuestos">Presupuestos</a>
<p class="wa ${s.whatsappOk ? 'ok' : 'mal'}"><span class="punto" aria-hidden="true"></span>WhatsApp: ${s.whatsapp}</p>
<p class="gasto">Gasto de hoy <b>USD ${usd(s.spentTodayUsd)}</b> de ${usd(s.budgetUsd)}</p>
<form class="salir" method="post" action="/crm/salir"><button type="submit" class="btn btn-barra">Salir</button></form>`;
}

// ---------- lista de chats ----------
const PREVIEW_WHO: Partial<Record<Author, string>> = { bot: 'Bot: ', team: 'Equipo: ' };

// "3 h 12 min" se parte en dos renglones: lo grande arriba, el resto abajo.
function waitClock(label: string, late: boolean): Html {
  const [big, small] = label.split(/ (?=\d)/);
  return html`<span class="reloj${late ? ' tarde' : ''}"><span class="sr">Espera </span><span class="r1">${big}</span>${small ? html`<span class="r2">${small}</span>` : ''}</span>`;
}

function dueTag(due: NonNullable<ChatListItem['due']>): Html {
  return html`<span class="venc${due.late ? ' tarde' : due.today ? ' hoy' : ''}">${due.text}</span>`;
}

function row(v: AppView, i: ChatListItem): Html {
  const selected = v.chat?.item.n === i.n;
  return html`<li><a class="fila${selected ? ' sel' : ''}" href="${crmUrl(v.filter, v.query, i.n)}"${selected ? trusted(' aria-current="true"') : ''}>
<span class="riel">${i.waitLabel ? waitClock(i.waitLabel, !!i.due?.late) : ''}</span>
<span class="cuerpo">
<span class="l1"><span class="nombre">${i.name}</span>${i.place ? html`<span class="lugar">${i.place}</span>` : ''}${i.need ? '' : html`<time class="hora">${i.lastActivityLabel}</time>`}</span>
<span class="l2">${i.needLabel ? html`<span class="que">${i.needLabel}</span>` : ''}${i.needLabel === i.stageLabel ? '' : html`<span class="etapa">${i.stageLabel}</span>`}${i.due ? dueTag(i.due) : ''}</span>
<span class="l3">${i.previewAuthor ? (PREVIEW_WHO[i.previewAuthor] ?? '') : ''}${i.preview}</span>
</span></a></li>`;
}

function emptyList(v: AppView): Html {
  if (v.query) {
    return html`<p>No hay chats que coincidan con “${v.query}”.</p><p>Probá con el nombre o el lugar, o <a href="${crmUrl(v.filter, '')}">borrá la búsqueda</a>.</p>`;
  }
  if (v.filter === 'ahora') {
    return html`<p>Nada para hacer ahora: el bot está atendiendo.</p><p>Mirá <a href="${crmUrl('todos', '')}">todos los chats</a> si querés repasar alguno.</p>`;
  }
  return html`<p>${v.filter === 'todos' ? 'Todavía no hay chats.' : 'No hay chats en esta etapa.'}</p>`;
}

export function listFragment(v: AppView): Html {
  const { items, counts } = v.list;
  const open = v.chat?.item.n; // cambiar de filtro o buscar no cierra el chat abierto
  const searching = !!v.query; // la búsqueda es en todos los chats: ningún filtro marcado, y tocar uno la borra
  const on = (f: ListFilter) => !searching && v.filter === f;
  const inStage = v.filter !== 'ahora' && v.filter !== 'todos';
  return html`<div class="lista-cab">
<div class="chips">
<a class="chip${on('ahora') ? ' activo' : ''}" href="${crmUrl('ahora', '', open)}"${current(on('ahora'))}>Hacer ahora <b class="n">${counts.ahora}</b></a>
<a class="chip${on('todos') ? ' activo' : ''}" href="${crmUrl('todos', '', open)}"${current(on('todos'))}>Todos</a>
<details class="etapas">
<summary class="chip${inStage && !searching ? ' activo' : ''}"><span class="chip-t">${inStage && !searching ? STAGE_LABEL[v.filter as StageView] : 'Etapas'}</span>${icon('abajo')}</summary>
<ul class="menu" role="list">${STAGE_ORDER.map((s) => html`<li><a href="${crmUrl(s, '', open)}"${current(on(s))}><span>${STAGE_LABEL[s]}</span><b class="n">${counts[s]}</b></a></li>`)}</ul>
</details>
</div>
<form class="buscar" role="search" method="get" action="/crm/">${v.filter === 'ahora' ? '' : html`<input type="hidden" name="f" value="${v.filter}">`}${open ? html`<input type="hidden" name="chat" value="${open}">` : ''}<label class="sr" for="buscar">Buscar un chat</label>${icon('buscar')}<input id="buscar" name="q" type="search" value="${v.query}" placeholder="Buscar en todos los chats" title="Atajo: tecla /" autocomplete="off" maxlength="80"></form>
</div>
${items.length
    ? html`<ul class="filas" role="list" data-vista="${crmUrl(v.filter, v.query)}">${items.map((i) => row(v, i))}</ul>`
    : html`<div class="filas lista-vacia" data-vista="${crmUrl(v.filter, v.query)}">${emptyList(v)}</div>`}`;
}

// ---------- chat abierto ----------
const mediaIcon = (label: string): IconName => (label.startsWith('Foto') ? 'foto' : label.startsWith('Audio') ? 'mic' : label.startsWith('Video') ? 'video' : 'archivo');

function message(m: ChatMessageView, first: boolean): Html {
  if (m.author === 'system') return html`<p class="sis"><span>${m.text} <time>${m.timeLabel}</time></span></p>`;
  const side = m.author === 'customer' ? 'cliente' : m.author === 'bot' ? 'bot' : 'equipo';
  const meta = html`<span class="meta">${m.edited ? 'editado · ' : ''}<time>${m.timeLabel}</time></span>`;
  return html`<div class="msg msg-${side}${first ? ' primero' : ''}"><div class="globo">${side === 'cliente' ? '' : html`<span class="autor">${m.authorLabel}</span>`}${
    m.revoked
      ? html`<p class="texto borrado">Mensaje borrado${meta}</p>`
      : html`${m.media ? html`<span class="adj">${icon(mediaIcon(m.media))}${m.media}</span>` : ''}<p class="texto">${m.text}${meta}</p>`
  }</div></div>`;
}

function conversation(v: AppView, c: ChatDetail): Html {
  let lastDay = '';
  let lastAuthor = '';
  const items = c.messages.map((m) => {
    const newDay = m.dayLabel !== lastDay;
    const first = newDay || m.author !== lastAuthor;
    lastDay = m.dayLabel;
    lastAuthor = m.author;
    return html`${newDay ? html`<div class="dia"><span>${m.dayLabel}</span></div>` : ''}${message(m, first)}`;
  });
  const d = c.draft;
  return html`<div class="conversacion" tabindex="0" aria-label="Conversación">
${c.olderHidden > 0 ? html`<p class="viejos">Hay ${c.olderHidden} ${c.olderHidden === 1 ? 'mensaje más viejo' : 'mensajes más viejos'} que no se muestran acá.</p>` : ''}
${items}
${d ? html`<div class="msg msg-borrador primero"><div class="globo"><span class="autor">Borrador del bot · todavía no salió</span>${d.bubbles.map((b) => html`<p class="texto">${b}</p>`)}${d.material.length ? html`<span class="adj">${icon('foto')}Va con ${d.material.length === 1 ? '1 archivo' : `${d.material.length} archivos`} del material</span>` : ''}<span class="meta">Armado a las <time>${d.createdLabel}</time></span>${actionForm(v, { d: d.id }, [button('mandar', 'Mandar', 'primary'), button('descartar', 'Descartar'), button('dtomo', 'Lo tomo')])}</div></div>` : ''}
</div>`;
}

const WA_TITLE = 'Abre el WhatsApp que esté abierto en esta compu';
function waButton(c: ChatDetail): Html | '' {
  return c.waLink ? html`<a class="btn btn-secondary" href="${c.waLink}" target="_blank" rel="noopener noreferrer" title="${WA_TITLE}" aria-label="Abrir en WhatsApp"><span class="solo-grande">Abrir en </span>WhatsApp${icon('afuera')}</a>` : '';
}

// Lo que se hace con el chat, en el panel (una copia para el escritorio y otra dentro del <details> del celular).
function actionBlock(v: AppView, c: ChatDetail): Html | '' {
  const it = c.item;
  const notes: Html[] = [];
  const forms: Html[] = [];
  if (c.draft) {
    notes.push(html`<p>El bot armó una respuesta y espera tu OK.</p>`);
    forms.push(actionForm(v, { d: c.draft.id }, [button('mandar', 'Mandar', 'primary'), button('descartar', 'Descartar')]));
  } else if (it.need === 'te_escribio') {
    notes.push(html`<p>Te escribió y no tiene respuesta. Contestale desde WhatsApp.</p>`);
  }
  if (it.stage === 'a_presupuestar') {
    // Si el bot lo pasó por otra cosa (pidió una persona, se enojó, un audio…), primero eso: el presupuesto puede no ser lo próximo.
    const why = c.handoffLabel && c.handoffLabel !== REASONS.listo_para_presupuesto ? html`Pasó al equipo: ${c.handoffLabel.toLowerCase()}. ` : '';
    notes.push(html`<p>${why}Falta mandar el presupuesto.${it.due ? html` Promesa al cliente: ${dueTag(it.due)}.` : ''}</p>`);
    forms.push(actionForm(v, { n: it.n }, [button('presu', 'Presupuesto mandado', 'primary')]));
  }
  const own: Html[] = [];
  if (c.botAnswers) own.push(button('tomo', 'Lo tomo'));
  // Devolver borra la etapa (y en A presupuestar, el reloj de la promesa): si tiene etapa se pregunta antes, un clic de más no lo devuelve al bot.
  const losesStage = (MOVABLE as string[]).includes(it.stage);
  if (c.canGiveBack) own.push(button('bot', 'Devolver al bot', 'secondary', losesStage ? `¿Devolverlo al bot? Sale de ${STAGE_LABEL[it.stage]} y el bot le vuelve a contestar.` : undefined));
  if (own.length) forms.push(actionForm(v, { n: it.n }, own));
  return notes.length || forms.length ? html`<section class="accion">${notes}${forms}</section>` : '';
}

const block = (title: string, body: Html): Html => html`<section class="bloque"><h3>${title}</h3>${body}</section>`;

// El presupuesto del chat: ver el último o armar uno. Navegación normal (crm.js no intercepta estos enlaces).
function quoteBlock(c: ChatDetail): Html {
  const href = `/crm/presupuestos?chat=${c.item.n}`;
  const q = c.quote;
  return block('Presupuesto', q
    ? html`<p>Estado: ${q.estado}</p>${q.envio ? html`<p class="suave">${q.envio.texto}</p>` : ''}<a class="btn btn-secondary btn-presu" href="${href}">Ver presupuesto</a>`
    : html`<a class="btn btn-secondary btn-presu" href="${href}">Armar presupuesto</a>`);
}

function panel(v: AppView, c: ChatDetail, where: 'd' | 'm'): Html {
  const it = c.item;
  const fields: [string, Html | string][] = c.fields.map((f) => [f.label, html`${f.value}${f.deduced ? html` <small class="deducida">deducida</small>` : ''}`]);
  if (fields.length) fields.unshift(['Temperatura', it.temperatureLabel]);
  return html`${actionBlock(v, c)}
<section class="bloque"><h3>Mover a…</h3>
<form class="mover" method="post" action="/crm/accion"><input type="hidden" name="back" value="${v.back}"><input type="hidden" name="n" value="${it.n}">
<select name="stage" required aria-label="Etapa"><option value="" selected disabled>Elegí la etapa</option>${MOVABLE.map((s) => html`<option value="${s}">${STAGE_LABEL[s]}${s === it.stage ? ' (actual)' : ''}</option>`)}</select>
<label class="motivo">Motivo, si se perdió o se descarta<select name="reason"><option value="">Sin motivo</option>${LOST_REASONS.map((r) => html`<option value="${r}">${r}</option>`)}</select></label>
<button type="submit" name="a" value="etapa" class="btn btn-secondary">Mover</button>
</form></section>
${quoteBlock(c)}
${c.handoffLabel ? block('Por qué pasó al equipo', html`<p>${c.handoffLabel}</p>`) : ''}
${c.quoteSentLabel ? html`<section class="bloque"><p>${c.quoteSentLabel}</p></section>` : ''}
${c.lostReason ? block(it.stage === 'descartado' ? 'Por qué se descartó' : 'Por qué se perdió', html`<p>${c.lostReason}</p>`) : ''}
${block('Ficha', html`<dl class="datos">${fields.map(([k, x]) => html`<dt>${k}</dt><dd>${x}</dd>`)}</dl>${c.fields.length ? '' : html`<p class="suave">Todavía no hay datos.</p>`}`)}
${c.missing.length ? block('Falta', html`<ul class="fichas" role="list">${c.missing.map((m) => html`<li>${m}</li>`)}</ul>`) : ''}
${c.objections.length ? block('Objeciones', html`<ul class="fichas" role="list">${c.objections.map((o) => html`<li>${o}</li>`)}</ul>`) : ''}
${c.teamNote ? block('Nota del bot', html`<p class="nota">${c.teamNote}</p>`) : ''}
${block('Gasto del bot', html`<p>USD ${usd(c.spentUsd, 4)} en este chat</p>`)}
<section class="bloque"><details class="hist" data-k="hist-${where}"><summary>Historial ${icon('abajo')}</summary>${
    c.history.length
      ? html`<ul role="list">${c.history.map((h) => html`<li><time>${h.timeLabel}</time><span>${h.text}</span></li>`)}</ul>`
      : html`<p class="suave">Todavía no hay nada anotado.</p>`
  }</details></section>`;
}

export function chatFragment(v: AppView): Html {
  const c = v.chat;
  if (!c) {
    return html`<div class="vacio"><div class="vacio-logo"><img src="/crm/static/logo.png" alt="" width="168" height="48"></div><p class="vacio-t">Elegí un chat de la izquierda</p><p class="vacio-s">Los que más esperan están arriba, en “Hacer ahora”.</p></div>`;
  }
  const it = c.item;
  const stageSaysIt = it.stage === 'con_el_bot' || it.stage === 'con_el_equipo'; // modeLabel ya lo dice
  const sub = [it.place, stageSaysIt ? null : it.stageLabel, c.modeLabel].filter(Boolean).join(' · ');
  const how = c.waLink ? 'Para escribirle vos, abrilo en WhatsApp.' : 'Este contacto no muestra el número: contestale desde el WhatsApp del celular.';
  return html`<section class="centro chat-open" data-n="${it.n}">
<header class="chat-cab">
<a class="volver" href="${crmUrl(v.filter, v.query)}" aria-label="Volver a la lista de chats">${icon('volver')}<span>Chats</span></a>
<div class="chat-quien"><h2>${it.name}</h2><p title="${sub}">${sub}</p></div>
${waButton(c)}
</header>
<details class="panel-movil" data-k="ficha-m"${it.need ? trusted(' open') : ''}><summary>Ficha y acciones ${icon('abajo')}</summary><div class="panel-cuerpo">${panel(v, c, 'm')}</div></details>
${conversation(v, c)}
<footer class="barra-abajo"><p>${c.botAnswers ? (c.botOff ? 'El bot está apagado: no le contesta.' : 'El bot contesta solo.') : 'El bot no está contestando este chat.'} ${how}</p>${waButton(c)}</footer>
</section>
<aside class="panel panel-desk" aria-label="Ficha y acciones">${panel(v, c, 'd')}</aside>`;
}
