// CRM de Olimpo Padel: acciones sin recargar, refresco cada 15 s, cambio de chat sin recargar y atajo "/".
// Sin framework ni módulos: la CSP (script-src 'self') no deja nada inline. Sin este archivo la pantalla anda igual (formularios que postean y vuelven).
(() => {
  'use strict';
  document.documentElement.classList.add('js');

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const REFRESH_MS = 15000;
  const CONFIRMA = {
    apagar: '¿Apagar el bot? No va a contestar ni mandar nada hasta que lo prendas.',
    sombra_off: '¿Apagar el modo sombra? El bot va a escribirle directo a los clientes, sin que nadie lo apruebe antes.',
  };
  const svg = (paths) => `<svg class="ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const ICONOS = { ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'), mal: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>') };

  let version = 0; // sube cuando el usuario navega o hace algo: lo que venía en camino de antes ya no vale
  let enVuelo = 0; // acciones que están yendo al servidor
  let aviso = 0; // timer del aviso
  let listaScroll = 0; // scroll de la lista cuando se la veía (escondida o con otro alto, el navegador lo recorta)
  const ultimo = {}; // lo último que se puso en cada contenedor: si no cambió, no se toca la pantalla
  const elegidos = new Map(); // <details> del chat que el usuario abrió o cerró a mano (data-k → abierto)
  let eligioEn = 0; // cuándo eligió algo en un select del chat (etapa o motivo)
  const ELIGIENDO_MS = 120000; // pasado esto, si no tocó "Mover", la pantalla vuelve a refrescarse

  // ---------- aviso ----------
  const cerrarAviso = () => {
    clearTimeout(aviso);
    $('#aviso')?.replaceChildren();
  };
  function avisar(text, ok) {
    cerrarAviso();
    const t = document.createElement('div');
    t.className = ok ? 'toast' : 'toast toast-mal';
    t.setAttribute('role', 'status');
    t.insertAdjacentHTML('beforeend', ok ? ICONOS.ok : ICONOS.mal);
    const p = document.createElement('p');
    p.textContent = text;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-x';
    x.textContent = 'Cerrar';
    t.append(p, x);
    $('#aviso').append(t);
    aviso = setTimeout(cerrarAviso, ok ? 6000 : 10000);
  }

  // ---------- pantalla ----------
  async function traer(search) {
    const v = version;
    const p = new URLSearchParams(search);
    p.delete('msg');
    p.delete('ok');
    const r = await fetch('/crm/parcial' + (p.size ? '?' + p : ''), { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (r.status === 401) {
      location.assign('/crm/login');
      return null;
    }
    if (!r.ok) throw new Error('parcial ' + r.status);
    const d = await r.json();
    return v === version ? d : null;
  }

  // Cambia el contenido de los tres contenedores conservando el scroll (si el chat estaba abajo, sigue abajo) y lo que el usuario abrió.
  function aplicar(d) {
    const antes = $('.chat-open')?.dataset.n;
    const conv = $('.conversacion');
    const alFondo = !conv || conv.scrollHeight - conv.scrollTop - conv.clientHeight < 48;
    const convTop = conv?.scrollTop ?? 0;
    const panelTop = $('.panel-desk')?.scrollTop ?? 0;
    const vista = $('.filas')?.dataset.vista;
    const filaHref = document.activeElement?.closest?.('a.fila')?.getAttribute('href');

    for (const [clave, sel] of [['status', '#estado'], ['list', '#lista'], ['chat', '#chat']]) {
      if (ultimo[clave] === d[clave]) continue;
      $(sel).innerHTML = d[clave];
      ultimo[clave] = d[clave];
    }

    const mismo = $('.chat-open')?.dataset.n === antes;
    if (!mismo) elegidos.clear();
    for (const det of $$('#chat details[data-k]')) if (elegidos.has(det.dataset.k)) det.open = elegidos.get(det.dataset.k);
    const nuevaConv = $('.conversacion');
    if (nuevaConv) nuevaConv.scrollTop = mismo && !alFondo ? convTop : nuevaConv.scrollHeight;
    const nuevoPanel = $('.panel-desk');
    if (nuevoPanel) nuevoPanel.scrollTop = mismo ? panelTop : 0;
    const nuevasFilas = $('.filas');
    if (nuevasFilas) {
      if (nuevasFilas.dataset.vista !== vista) listaScroll = 0;
      nuevasFilas.scrollTop = listaScroll;
    }
    if (filaHref) $$('a.fila').find((a) => a.getAttribute('href') === filaHref)?.focus({ preventScroll: true });
  }

  async function refrescar() {
    try {
      const d = await traer(location.search);
      if (d) aplicar(d);
    } catch {
      // sin conexión o el bot reiniciándose: se reintenta en el próximo ciclo
    }
  }

  // Ir a otra URL del CRM sin recargar la página. Si algo falla, navega normal.
  async function ir(href) {
    const url = new URL(href, location.href);
    version++;
    try {
      const d = await traer(url.search);
      if (!d) return;
      history.pushState(null, '', url.pathname + url.search);
      aplicar(d);
    } catch {
      location.assign(url.href);
    }
  }

  // No le cambiamos la pantalla en la mano: ni con el foco en un campo, ni con un menú o un <details> abierto por el usuario.
  const ocupado = () => {
    const a = document.activeElement;
    if (a && a.matches('input, select, textarea, [contenteditable]')) return true;
    if (Date.now() - eligioEn < ELIGIENDO_MS && $$('#chat select').some((s) => s.value !== '')) return true; // eligió una etapa o un motivo y todavía no tocó "Mover"
    if ($('#lista details[open]')) return true;
    return $$('#chat details[open]').some((d) => elegidos.get(d.dataset.k) === true);
  };
  setInterval(() => {
    if (!document.hidden && !enVuelo && !ocupado()) refrescar();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !enVuelo && !ocupado()) refrescar();
  });
  window.addEventListener('popstate', () => {
    version++;
    refrescar();
  });

  // ---------- eventos ----------
  document.addEventListener('change', (e) => {
    if (e.target instanceof HTMLSelectElement && e.target.closest('#chat')) eligioEn = Date.now();
  });
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element && e.target.classList.contains('filas') && getComputedStyle(e.target).visibility !== 'hidden') listaScroll = e.target.scrollTop;
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const menu = $('#lista details.etapas[open]');
    if (menu && !menu.contains(t)) menu.open = false;
    if (t.closest('.toast-x')) {
      e.preventDefault();
      cerrarAviso();
      return;
    }
    const resumen = t.closest('#chat summary');
    if (resumen?.parentElement?.dataset.k) elegidos.set(resumen.parentElement.dataset.k, !resumen.parentElement.open); // el cambio ocurre después de este click
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = t.closest('#estado a.logo, #lista a.fila, #lista a.chip, #lista .menu a, #lista .lista-vacia a, #chat a.volver');
    if (link) {
      e.preventDefault();
      ir(link.getAttribute('href'));
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches('.buscar')) {
      e.preventDefault();
      const p = new URLSearchParams(new FormData(form));
      if (!p.get('q')) p.delete('q');
      await ir('/crm/' + (p.size ? '?' + p : ''));
      const i = $('#buscar');
      if (i) {
        i.focus();
        i.setSelectionRange(i.value.length, i.value.length);
      }
      return;
    }
    if (form.getAttribute('action') !== '/crm/accion') return;
    e.preventDefault();
    const boton = e.submitter;
    const confirmar = boton?.dataset.confirma ?? CONFIRMA[boton?.value ?? ''];
    if (confirmar && !confirm(confirmar)) return;
    if (form.dataset.enviando) return;
    form.dataset.enviando = '1';
    boton?.setAttribute('aria-busy', 'true');
    enVuelo++;
    try {
      const r = await fetch('/crm/accion', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form, boton ?? undefined)),
        credentials: 'same-origin',
      });
      if (r.status === 401) {
        location.assign('/crm/login');
        return;
      }
      let data = null;
      try {
        data = await r.json();
      } catch {
        // no vino JSON
      }
      if (data && typeof data.text === 'string') avisar(data.text, r.ok && data.ok === true);
      else avisar(r.status === 403 ? 'El CRM no aceptó el pedido. Recargá la página y probá de nuevo.' : 'No se pudo hacer. Probá de nuevo.', false);
      form.reset(); // si el panel no cambió (p. ej. "Ya estaba en esa etapa"), lo elegido no queda trabando el refresco
      eligioEn = 0;
      version++;
      const d = await traer(location.search);
      if (d) aplicar(d);
    } catch {
      avisar('No hay conexión con el CRM. Revisá que el bot esté prendido.', false);
    } finally {
      enVuelo--;
      delete form.dataset.enviando;
      boton?.removeAttribute('aria-busy');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const menu = $('#lista details.etapas[open]');
      if (menu) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
      return;
    }
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]')) return;
    const i = $('#buscar');
    if (i) {
      e.preventDefault();
      i.focus();
      i.select();
    }
  });

  // ---------- al cargar ----------
  const alFondoAlCargar = () => {
    const c = $('.conversacion');
    if (c) c.scrollTop = c.scrollHeight;
  };
  alFondoAlCargar();
  document.fonts?.ready.then(alFondoAlCargar); // la fuente cambia el alto de los globos

  // Sin JavaScript el resultado de la acción llega por la URL (?msg=…): se muestra y se saca de la dirección.
  const u = new URL(location.href);
  if (u.searchParams.has('msg') || u.searchParams.has('ok')) {
    u.searchParams.delete('msg');
    u.searchParams.delete('ok');
    history.replaceState(null, '', u.pathname + u.search);
    if ($('#aviso .toast')) aviso = setTimeout(cerrarAviso, 8000);
  }
})();
