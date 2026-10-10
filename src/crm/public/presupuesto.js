// Creador de presupuestos del CRM: port de form.js, historial.js, app.js y storage.js del creador (Electron).
// Habla con el servidor por fetch (/crm/presupuestos/...); los textos por defecto salen del bloque #boot, no de acá.
// Nada de innerHTML con datos del usuario: todo se arma con createElement y textContent.
(() => {
  'use strict';

  const bootEl = document.getElementById('boot');
  if (!bootEl) return;
  const boot = JSON.parse(bootEl.textContent);
  const BASE = '/crm/presupuestos';
  const SVG_ATTRS = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"';
  const ICONS = {
    success: `<svg ${SVG_ATTRS}><polyline points="20 6 9 17 4 12"/></svg>`,
    error: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    duplicar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eliminar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };
  const ESTADOS = [['borrador', 'Borrador'], ['enviado', 'Enviado'], ['aceptado', 'Aceptado'], ['rechazado', 'Rechazado']];
  const HINT_BY_MODEL = { 'Servicio de Instalación': 'instalacion', 'Servicio de Logística': 'logistica' };

  const $ = (id) => document.getElementById(id);

  function h(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function formatNumber(num) {
    return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(num);
  }

  function formatDate(isoString) {
    return new Date(isoString).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function formatPrecio(precio, moneda) {
    if (!precio) return '';
    return `${moneda === 'USD' ? 'USD' : 'ARS'} $${formatNumber(precio)}`;
  }

  // ============================================================
  // STORAGE — la API del CRM en lugar de historial.json
  // ============================================================
  const Storage = (() => {
    let _historial = [];

    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }

    // Manda el pedido; si la sesión venció vuelve al login. Devuelve la Response (sin mirar el status).
    async function request(path, body) {
      const res = await fetch(BASE + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401) {
        location.assign('/crm/login');
        throw new Error('Tu sesión venció. Entrá de nuevo.');
      }
      return res;
    }

    // JSON de la respuesta; si no fue ok, tira Error con el texto del servidor (y el cuerpo en err.body).
    async function api(path, body) {
      const res = await request(path, body);
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = new Error((json && json.error) || 'Algo salió mal. Probá de nuevo.');
        err.body = json;
        throw err;
      }
      return json;
    }

    function guardarLocal(p) {
      const i = _historial.findIndex((x) => x.id === p.id);
      if (i === -1) _historial.push(p);
      else _historial[i] = p;
      return p;
    }

    async function cargar() {
      try {
        _historial = (await api('/api/lista')).presupuestos;
      } catch (err) {
        console.error('Error cargando el historial:', err);
        App.toast('No se pudo cargar el historial: ' + err.message, 'error');
      }
      return _historial;
    }

    // Los más nuevos primero, como el creador.
    function getAll() {
      return [..._historial].sort((a, b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion));
    }

    function getById(id) {
      return _historial.find((p) => p.id === id);
    }

    async function guardar(id, chat, data) {
      const body = id ? { id, data } : { chat, data };
      return guardarLocal((await api('/api/guardar', body)).presupuesto);
    }

    async function cambiarEstado(id, estado) {
      return guardarLocal((await api('/api/estado', { id, estado })).presupuesto);
    }

    async function duplicar(id) {
      return guardarLocal((await api('/api/duplicar', { id })).presupuesto);
    }

    async function eliminar(id) {
      await api('/api/borrar', { id });
      _historial = _historial.filter((p) => p.id !== id);
    }

    function buscar(query) {
      if (!query || !query.trim()) return getAll();
      const q = query.toLowerCase().trim();
      return getAll().filter((p) =>
        (p.clienteNombre && p.clienteNombre.toLowerCase().includes(q)) ||
        (p.titulo && p.titulo.toLowerCase().includes(q)),
      );
    }

    return { request, api, cargar, getAll, getById, guardarLocal, guardar, cambiarEstado, duplicar, eliminar, buscar, uuid };
  })();

  // ============================================================
  // FORM
  // ============================================================
  const Form = (() => {
    let _editingId = null;
    let _chat = null; // { n, nombre } si el presupuesto es de un chat
    let _envio = null; // { estado, texto } del último envío por WhatsApp
    let _items = [];
    let _productos = [];
    const _ofertaOn = new Set(); // renglones con "Oferta" marcada (aunque todavía no tengan precio de lista)
    const els = {};

    function init() {
      for (const id of [
        'presupuestoForm', 'formTitle', 'clienteNombre', 'clienteCodigoPais', 'clienteTelefono', 'clienteLocalidad', 'titulo',
        'itemsList', 'productsList', 'condicionesPago', 'moneda', 'notasAdicionales', 'plazoEntrega', 'btnAgregarItem',
        'btnSpecsCancha', 'btnSpecsPlatea', 'btnLimpiarSpecs', 'btnAgregarProducto', 'subtotalDisplay', 'totalDisplay',
        'descuentoCheck', 'descuentoWrap', 'descuentoPct', 'descuentoLine', 'descuentoDisplay', 'descuentoPctDisplay',
        'precioGlobalCheck', 'precioGlobalWrap', 'precioGlobalManual', 'pthPrecio', 'pthSub', 'btnEnviarWA', 'envioEstado',
      ]) els[id] = $(id);

      els.btnAgregarItem.addEventListener('click', () => agregarItem());
      els.btnSpecsCancha.addEventListener('click', () => agregarSpecs(boot.specsCancha, 'Cancha'));
      els.btnSpecsPlatea.addEventListener('click', () => agregarSpecs(boot.specsPlatea, 'Platea'));
      els.btnLimpiarSpecs.addEventListener('click', () => limpiarSpecs());
      els.btnAgregarProducto.addEventListener('click', () => agregarProducto());
      els.moneda.addEventListener('change', () => recalcularTotal());

      els.descuentoCheck.addEventListener('change', () => {
        const show = els.descuentoCheck.checked;
        els.descuentoWrap.hidden = !show;
        els.descuentoLine.hidden = !show;
        if (!show) els.descuentoPct.value = 0;
        recalcularTotal();
      });
      els.descuentoPct.addEventListener('input', () => recalcularTotal());

      els.precioGlobalCheck.addEventListener('change', () => {
        aplicarGlobal(els.precioGlobalCheck.checked);
        renderProductos();
        recalcularTotal();
      });
      els.precioGlobalManual.addEventListener('input', () => recalcularTotal());
    }

    function aplicarGlobal(show) {
      els.precioGlobalWrap.hidden = !show;
      els.pthPrecio.hidden = show;
      els.pthSub.hidden = show;
    }

    // ===== PRODUCTOS =====

    function agregarProducto(data = null) {
      const prod = data || { id: Storage.uuid(), modelo: '', nombreCustom: '', cantidad: 1, precioUnitario: 0 };
      if (!prod.id) prod.id = Storage.uuid();
      _productos.push(prod);
      renderProductos();
    }

    function removerProducto(id) {
      const prodToRemove = _productos.find((p) => p.id === id);
      _productos = _productos.filter((p) => p.id !== id);
      _ofertaOn.delete(id);
      renderProductos();
      recalcularTotal();

      if (prodToRemove && prodToRemove.modelo === 'Platea de Hormigón') {
        const stillHasPlatea = _productos.some((p) => p.modelo === 'Platea de Hormigón');
        if (!stillHasPlatea) {
          const hasCancha = _productos.some((p) => isCancha(p.modelo));
          if (isOnlySpecs(_items, boot.specsPlatea)) {
            _items = [];
            if (hasCancha || _productos.length === 0) boot.specsCancha.forEach((spec) => _items.push({ id: Storage.uuid(), descripcion: spec }));
            renderItems();
          }
        }
      }
    }

    // Ayuda de precio (solo texto, nunca se precarga en el campo).
    function actualizarAyuda(row, prod) {
      const hint = row.querySelector('.product-hint');
      const key = HINT_BY_MODEL[prod.modelo];
      const text = (key && boot.hints && boot.hints[key]) || '';
      hint.textContent = text;
      hint.hidden = !text;
    }

    function crearRenglon(prod, globalMode) {
      const row = h('div', 'product-row');
      row.dataset.id = prod.id;

      const main = h('div', 'product-row-main');

      const select = h('select', 'form-select product-select');
      select.dataset.field = 'modelo';
      select.dataset.id = prod.id;
      const vacio = h('option', '', 'Seleccionar...');
      vacio.value = '';
      select.appendChild(vacio);
      boot.modelos.forEach((m) => {
        const o = h('option', '', m);
        o.value = m;
        if (prod.modelo === m) o.selected = true;
        select.appendChild(o);
      });
      main.appendChild(select);

      const custom = h('input', `form-input product-custom${prod.modelo === 'Otro' ? '' : ' hidden'}`);
      custom.type = 'text';
      custom.dataset.field = 'nombreCustom';
      custom.dataset.id = prod.id;
      custom.value = prod.nombreCustom || '';
      custom.placeholder = 'Nombre del servicio...';
      main.appendChild(custom);

      const cant = h('input', 'form-input product-cant');
      cant.type = 'number';
      cant.dataset.field = 'cantidad';
      cant.dataset.id = prod.id;
      cant.value = prod.cantidad || 1;
      cant.min = '1';
      cant.step = '1';
      main.appendChild(cant);

      const precio = h('input', 'form-input product-precio');
      precio.type = 'number';
      precio.dataset.field = 'precioUnitario';
      precio.dataset.id = prod.id;
      precio.value = prod.precioUnitario || '';
      precio.min = '0';
      precio.step = 'any';
      precio.placeholder = '0';
      precio.hidden = globalMode;
      main.appendChild(precio);

      const sub = h('span', 'product-subtotal', `$${formatNumber((prod.cantidad || 0) * (prod.precioUnitario || 0))}`);
      sub.dataset.subtotalId = prod.id;
      sub.hidden = globalMode;
      main.appendChild(sub);

      const remove = h('button', 'btn-remove-item', '✕');
      remove.type = 'button';
      remove.title = 'Eliminar';
      remove.dataset.removeProdId = prod.id;
      main.appendChild(remove);
      row.appendChild(main);

      // Oferta (precio de lista) y ayuda de precio, debajo del renglón.
      const extra = h('div', 'product-row-extra');
      extra.hidden = globalMode;
      const ofertaOn = _ofertaOn.has(prod.id) || prod.precioLista > 0;
      if (ofertaOn) _ofertaOn.add(prod.id);
      const check = h('label', 'oferta-check');
      const checkbox = h('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'product-oferta';
      checkbox.dataset.id = prod.id;
      checkbox.checked = ofertaOn;
      check.append(checkbox, document.createTextNode('Oferta'));
      const lista = h('label', 'oferta-lista');
      lista.hidden = !ofertaOn;
      const listaInput = h('input', 'form-input product-lista');
      listaInput.type = 'number';
      listaInput.dataset.field = 'precioLista';
      listaInput.dataset.id = prod.id;
      listaInput.value = prod.precioLista || '';
      listaInput.min = '0';
      listaInput.step = 'any';
      listaInput.placeholder = '0';
      lista.append(document.createTextNode('Precio de lista'), listaInput);
      const hint = h('p', 'product-hint');
      hint.hidden = true;
      extra.append(check, lista, hint);
      row.appendChild(extra);
      actualizarAyuda(row, prod);

      return row;
    }

    function renderProductos() {
      els.productsList.textContent = '';
      const globalMode = els.precioGlobalCheck.checked;
      _productos.forEach((prod) => els.productsList.appendChild(crearRenglon(prod, globalMode)));

      els.productsList.querySelectorAll('[data-field]').forEach((input) => {
        input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', (e) => {
          const { id, field } = e.target.dataset;
          const prod = _productos.find((p) => p.id === id);
          if (!prod) return;
          const row = e.target.closest('.product-row');

          if (field === 'modelo') {
            const anteriorModelo = prod.modelo;
            prod.modelo = e.target.value;
            const customInput = row.querySelector('.product-custom');
            if (e.target.value === 'Otro') {
              customInput.classList.remove('hidden');
              customInput.focus();
            } else {
              customInput.classList.add('hidden');
              prod.nombreCustom = '';
            }
            actualizarAyuda(row, prod);
            handleModeloChangeSpecs(anteriorModelo, e.target.value);
          } else if (field === 'nombreCustom') {
            prod.nombreCustom = e.target.value;
          } else if (field === 'cantidad') {
            prod.cantidad = parseInt(e.target.value) || 1;
          } else if (field === 'precioUnitario') {
            prod.precioUnitario = parseFloat(e.target.value) || 0;
          } else if (field === 'precioLista') {
            prod.precioLista = parseFloat(e.target.value) || 0;
          }

          updateProductoSubtotal(id);
          recalcularTotal();
        });
      });

      els.productsList.querySelectorAll('.product-oferta').forEach((box) => {
        box.addEventListener('change', () => {
          const prod = _productos.find((p) => p.id === box.dataset.id);
          if (!prod) return;
          const lista = box.closest('.product-row').querySelector('.oferta-lista');
          lista.hidden = !box.checked;
          if (box.checked) {
            _ofertaOn.add(prod.id);
            lista.querySelector('input').focus();
          } else {
            _ofertaOn.delete(prod.id);
            delete prod.precioLista;
            lista.querySelector('input').value = '';
          }
        });
      });

      els.productsList.querySelectorAll('[data-remove-prod-id]').forEach((btn) => {
        btn.addEventListener('click', () => removerProducto(btn.dataset.removeProdId));
      });
    }

    function updateProductoSubtotal(id) {
      const prod = _productos.find((p) => p.id === id);
      if (!prod) return;
      const el = els.productsList.querySelector(`[data-subtotal-id="${id}"]`);
      if (el) el.textContent = `$${formatNumber((prod.cantidad || 0) * (prod.precioUnitario || 0))}`;
    }

    function recalcularTotal() {
      const subtotal = els.precioGlobalCheck.checked
        ? parseFloat(els.precioGlobalManual.value) || 0
        : _productos.reduce((sum, p) => sum + (p.cantidad || 0) * (p.precioUnitario || 0), 0);

      const descPct = els.descuentoCheck.checked ? (parseFloat(els.descuentoPct.value) || 0) : 0;
      const descuento = subtotal * descPct / 100;
      const total = subtotal - descuento;
      const moneda = els.moneda.value === 'USD' ? 'USD' : 'ARS';

      els.subtotalDisplay.textContent = `${moneda} $${formatNumber(subtotal)}`;
      els.descuentoPctDisplay.textContent = descPct;
      els.descuentoDisplay.textContent = `-$${formatNumber(descuento)}`;
      els.totalDisplay.textContent = `${moneda} $${formatNumber(total)}`;
    }

    // ===== ESPECIFICACIONES =====

    function isCancha(modelo) {
      if (!modelo) return false;
      const m = modelo.toLowerCase();
      return m.includes('cancha') || m.includes('panorámica') || m.includes('panoramica') || m.includes('single') || m.includes('doble');
    }

    function isOnlySpecs(items, specs) {
      if (!items || items.length !== specs.length) return false;
      return items.every((it, idx) => it.descripcion.trim().toLowerCase() === specs[idx].trim().toLowerCase());
    }

    function cargarSpecs(specs) {
      _items = specs.map((spec) => ({ id: Storage.uuid(), descripcion: spec }));
      renderItems();
    }

    function handleModeloChangeSpecs(anteriorModelo, nuevoModelo) {
      if (nuevoModelo === anteriorModelo) return;

      const hasCancha = _productos.some((p) => isCancha(p.modelo));
      const hasPlatea = _productos.some((p) => p.modelo === 'Platea de Hormigón');

      if (nuevoModelo === 'Platea de Hormigón') {
        if (!hasCancha && (isOnlySpecs(_items, boot.specsCancha) || _items.length === 0)) {
          cargarSpecs(boot.specsPlatea);
          App.toast('Especificaciones de Platea de Hormigón cargadas', 'info');
        } else {
          agregarSpecs(boot.specsPlatea, 'Platea', false);
        }
      } else if (isCancha(nuevoModelo)) {
        if (!hasPlatea && (isOnlySpecs(_items, boot.specsPlatea) || _items.length === 0)) {
          cargarSpecs(boot.specsCancha);
          App.toast('Especificaciones de Cancha cargadas', 'info');
        } else if (hasPlatea) {
          agregarSpecs(boot.specsCancha, 'Cancha', false);
        }
      } else if (anteriorModelo === 'Platea de Hormigón') {
        if (!hasPlatea && isOnlySpecs(_items, boot.specsPlatea)) {
          _items = [];
          if (hasCancha || _productos.length === 0) boot.specsCancha.forEach((spec) => _items.push({ id: Storage.uuid(), descripcion: spec }));
          renderItems();
        }
      }
    }

    function agregarSpecs(specs, nombre, notificar = true) {
      let agregados = 0;
      specs.forEach((spec) => {
        const existe = _items.some((i) => i.descripcion.trim().toLowerCase() === spec.trim().toLowerCase());
        if (!existe) {
          _items.push({ id: Storage.uuid(), descripcion: spec });
          agregados++;
        }
      });
      if (agregados > 0) {
        renderItems();
        if (notificar) App.toast(`Especificaciones de ${nombre} agregadas`, 'info');
      } else if (notificar) {
        App.toast(`Las especificaciones de ${nombre} ya están incluidas`, 'info');
      }
    }

    function limpiarSpecs() {
      _items = [];
      renderItems();
      App.toast('Especificaciones vaciadas', 'info');
    }

    function agregarItem(valor = '') {
      const id = Storage.uuid();
      _items.push({ id, descripcion: valor });
      renderItems();
      if (valor === '') {
        setTimeout(() => {
          const input = els.itemsList.querySelector(`[data-item-id="${id}"]`);
          if (input) input.focus();
        }, 50);
      }
    }

    function removerItem(id) {
      _items = _items.filter((item) => item.id !== id);
      renderItems();
    }

    function renderItems() {
      els.itemsList.textContent = '';

      _items.forEach((item, index) => {
        const row = h('div', 'item-row');
        const input = h('input', 'item-input');
        input.type = 'text';
        input.dataset.itemId = item.id;
        input.value = item.descripcion;
        input.placeholder = 'Ej: Vidrios templados 10mm';
        const remove = h('button', 'btn-remove-item', '✕');
        remove.type = 'button';
        remove.title = 'Eliminar ítem';
        remove.dataset.removeId = item.id;
        row.append(h('span', 'item-number', String(index + 1)), input, remove);
        els.itemsList.appendChild(row);

        input.addEventListener('input', (e) => {
          const it = _items.find((i) => i.id === e.target.dataset.itemId);
          if (it) it.descripcion = e.target.value;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            agregarItem('');
          }
        });
        remove.addEventListener('click', () => {
          if (_items.length > 1) removerItem(item.id);
        });
      });
    }

    // ===== CARGAR / NUEVO =====

    function scrollArriba() {
      document.querySelector('.form-wrapper').scrollTo({ top: 0, behavior: 'smooth' });
    }

    function setEnvio(envio) {
      _envio = envio || null;
      els.envioEstado.textContent = _envio ? _envio.texto : '';
      els.envioEstado.hidden = !_envio;
    }

    function actualizarBotonWA() {
      els.btnEnviarWA.hidden = !_chat;
    }

    // Llena el formulario con un presupuesto (guardado o precargado). `p.id` ausente = todavía sin guardar.
    function volcar(p) {
      els.clienteNombre.value = p.clienteNombre || '';
      els.clienteCodigoPais.value = p.clienteCodigoPais || '+54';
      els.clienteTelefono.value = p.clienteTelefono || '';
      els.clienteLocalidad.value = p.clienteLocalidad || '';
      els.titulo.value = p.titulo || '';
      els.condicionesPago.value = p.condicionesPago || '';
      els.moneda.value = p.moneda || 'USD';
      els.notasAdicionales.value = p.notasAdicionales || '';
      els.plazoEntrega.value = p.plazoEntrega || boot.plazo;

      _items = (p.items || []).map((item) => ({ ...item }));
      if (_items.length === 0) boot.specsCancha.forEach((spec) => _items.push({ id: Storage.uuid(), descripcion: spec }));
      renderItems();

      _productos = (p.productos || []).map((x) => ({ ...x }));
      _ofertaOn.clear();

      const desc = p.descuentoPct || 0;
      els.descuentoCheck.checked = desc > 0;
      els.descuentoPct.value = desc;
      els.descuentoWrap.hidden = !(desc > 0);
      els.descuentoLine.hidden = !(desc > 0);

      const isGlobal = p.esPrecioGlobal || false;
      els.precioGlobalCheck.checked = isGlobal;
      els.precioGlobalManual.value = p.precioGlobalManual || 0;
      aplicarGlobal(isGlobal);

      renderProductos();
      recalcularTotal();
    }

    function cargar(presupuesto) {
      _editingId = presupuesto.id;
      _chat = presupuesto.chat || null;
      els.formTitle.textContent = 'Editar Presupuesto';
      volcar(presupuesto);
      setEnvio(presupuesto.envio);
      actualizarBotonWA();
      scrollArriba();
    }

    // Precargado desde la ficha de un chat: todavía no está guardado; al guardar se manda `chat`.
    function cargarNuevoDeChat(data, chat) {
      _editingId = null;
      _chat = chat;
      els.formTitle.textContent = 'Nuevo Presupuesto';
      volcar(data);
      setEnvio(null);
      actualizarBotonWA();
    }

    function nuevo() {
      _editingId = null;
      _chat = null;
      els.formTitle.textContent = 'Nuevo Presupuesto';
      els.clienteNombre.value = '';
      els.clienteCodigoPais.value = '+54';
      els.clienteTelefono.value = '';
      els.clienteLocalidad.value = '';
      els.titulo.value = '';
      els.condicionesPago.value = boot.condiciones;
      els.moneda.value = 'USD';
      els.notasAdicionales.value = '';
      els.plazoEntrega.value = boot.plazo;

      cargarSpecs(boot.specsCancha);

      _productos = [];
      _ofertaOn.clear();
      agregarProducto();

      els.descuentoCheck.checked = false;
      els.descuentoPct.value = 0;
      els.descuentoWrap.hidden = true;
      els.descuentoLine.hidden = true;

      els.precioGlobalCheck.checked = false;
      els.precioGlobalManual.value = 0;
      aplicarGlobal(false);

      renderProductos();
      recalcularTotal();
      setEnvio(null);
      actualizarBotonWA();

      els.clienteNombre.focus();
      scrollArriba();
    }

    // Después de guardar / exportar / enviar: el formulario sigue siendo ese presupuesto (id, chat y envío del servidor).
    function adoptar(p) {
      _editingId = p.id;
      _chat = p.chat || _chat;
      els.formTitle.textContent = 'Editar Presupuesto';
      setEnvio(p.envio);
      actualizarBotonWA();
    }

    // ===== VALIDACIÓN =====

    function validar() {
      if (!els.clienteNombre.value.trim()) {
        els.clienteNombre.focus();
        App.toast('Ingresá el nombre del cliente', 'error');
        return false;
      }
      if (!els.titulo.value.trim()) {
        els.titulo.focus();
        App.toast('Ingresá el título del presupuesto', 'error');
        return false;
      }

      const productosValidos = _productos.filter((p) => p.modelo && p.modelo !== '');
      if (productosValidos.length === 0) {
        App.toast('Agregá al menos un producto o servicio', 'error');
        return false;
      }

      if (!els.precioGlobalCheck.checked) {
        const sinPrecio = productosValidos.filter((p) => !p.precioUnitario || p.precioUnitario <= 0);
        if (sinPrecio.length > 0) {
          App.toast('Completá el precio de todos los productos', 'error');
          return false;
        }
      }

      return true;
    }

    // ===== GET DATA =====

    function getData() {
      els.itemsList.querySelectorAll('.item-input').forEach((input) => {
        const item = _items.find((i) => i.id === input.dataset.itemId);
        if (item) item.descripcion = input.value;
      });

      els.productsList.querySelectorAll('[data-field]').forEach((input) => {
        const prod = _productos.find((p) => p.id === input.dataset.id);
        if (!prod) return;
        const field = input.dataset.field;
        if (field === 'modelo') prod.modelo = input.value;
        else if (field === 'nombreCustom') prod.nombreCustom = input.value;
        else if (field === 'cantidad') prod.cantidad = parseInt(input.value) || 1;
        else if (field === 'precioUnitario') prod.precioUnitario = parseFloat(input.value) || 0;
        else if (field === 'precioLista') prod.precioLista = parseFloat(input.value) || 0;
      });

      // Sin "Oferta" marcada, o sin precio de lista, el renglón va sin precioLista.
      const productosValidos = _productos
        .filter((p) => p.modelo && p.modelo !== '')
        .map((p) => {
          const copia = { ...p };
          if (!_ofertaOn.has(p.id) || !(copia.precioLista > 0)) delete copia.precioLista;
          return copia;
        });
      const globalMode = els.precioGlobalCheck.checked;

      const subtotal = globalMode
        ? parseFloat(els.precioGlobalManual.value) || 0
        : productosValidos.reduce((sum, p) => sum + (p.cantidad || 0) * (p.precioUnitario || 0), 0);

      const descPct = els.descuentoCheck.checked ? (parseFloat(els.descuentoPct.value) || 0) : 0;
      const descuento = subtotal * descPct / 100;

      return {
        clienteNombre: els.clienteNombre.value.trim(),
        clienteCodigoPais: els.clienteCodigoPais.value,
        clienteTelefono: els.clienteTelefono.value.trim(),
        clienteLocalidad: els.clienteLocalidad.value.trim(),
        titulo: els.titulo.value.trim(),
        productos: productosValidos,
        items: _items.filter((i) => i.descripcion.trim() !== ''),
        condicionesPago: els.condicionesPago.value.trim(),
        plazoEntrega: els.plazoEntrega.value.trim(),
        esPrecioGlobal: globalMode,
        precioGlobalManual: parseFloat(els.precioGlobalManual.value) || 0,
        precioTotal: subtotal - descuento,
        subtotal,
        descuentoPct: descPct,
        descuento,
        moneda: els.moneda.value,
        notasAdicionales: els.notasAdicionales.value.trim(),
      };
    }

    // ===== GUARDAR =====

    async function guardar() {
      if (!validar()) return null;
      const presupuesto = await Storage.guardar(_editingId, _chat && _chat.n, getData());
      adoptar(presupuesto);
      return presupuesto;
    }

    return {
      init, cargar, cargarNuevoDeChat, nuevo, adoptar, validar, getData, guardar,
      getEditingId: () => _editingId,
      getChat: () => _chat,
    };
  })();

  // ============================================================
  // HISTORIAL
  // ============================================================
  const Historial = (() => {
    let _activeId = null;
    const els = {};

    function init() {
      els.list = $('historialList');
      els.count = $('historialCount');
      els.search = $('searchInput');
      els.emptyState = $('emptyState');
      els.search.addEventListener('input', () => render());
    }

    function item(p) {
      const el = h('div', `historial-item${_activeId === p.id ? ' active' : ''}`);
      el.dataset.id = p.id;

      const actions = h('div', 'historial-item-actions');
      const dup = h('button', 'btn-icon');
      dup.type = 'button';
      dup.title = 'Duplicar';
      dup.innerHTML = ICONS.duplicar; // ícono fijo de este archivo
      const del = h('button', 'btn-icon danger');
      del.type = 'button';
      del.title = 'Eliminar';
      del.innerHTML = ICONS.eliminar; // ícono fijo de este archivo
      actions.append(dup, del);

      const header = h('div', 'historial-item-header');
      header.appendChild(h('span', 'historial-item-fecha', formatDate(p.fechaCreacion)));

      const footer = h('div', 'historial-item-footer');
      const select = h('select', `status-select badge badge-${p.estado}`);
      ESTADOS.forEach(([valor, label]) => {
        const o = h('option', '', label);
        o.value = valor;
        select.appendChild(o);
      });
      select.value = p.estado;
      footer.append(h('span', 'historial-item-precio', formatPrecio(p.precioTotal, p.moneda)), select);

      el.append(actions, header, h('span', 'historial-item-cliente', p.clienteNombre || ''), h('span', 'historial-item-titulo', p.titulo || ''), footer);

      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-icon') || e.target.closest('.status-select')) return;
        seleccionar(p.id);
      });

      dup.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const copia = await Storage.duplicar(p.id);
          App.toast('Presupuesto duplicado', 'success');
          seleccionar(copia.id);
        } catch (err) {
          App.toast('Error al duplicar: ' + err.message, 'error');
        }
      });

      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('¿Querés eliminar este presupuesto?')) return;
        try {
          await Storage.eliminar(p.id);
          App.toast('Presupuesto eliminado', 'info');
          if (_activeId === p.id) {
            _activeId = null;
            Form.nuevo();
          }
          render();
        } catch (err) {
          App.toast('Error al eliminar: ' + err.message, 'error');
        }
      });

      select.addEventListener('click', (e) => e.stopPropagation());
      select.addEventListener('change', async (e) => {
        e.stopPropagation();
        const estado = select.value;
        try {
          await Storage.cambiarEstado(p.id, estado);
          select.className = `status-select badge badge-${estado}`;
          App.toast(`Estado cambiado a "${estado}"`, 'success');
        } catch (err) {
          App.toast('Error al cambiar el estado: ' + err.message, 'error');
          render();
        }
      });

      return el;
    }

    function render() {
      const presupuestos = Storage.buscar(els.search.value);
      els.count.textContent = presupuestos.length;
      els.list.textContent = '';

      if (presupuestos.length === 0) {
        els.list.appendChild(els.emptyState);
        els.emptyState.classList.remove('hidden');
        return;
      }

      els.emptyState.classList.add('hidden');
      presupuestos.forEach((p) => els.list.appendChild(item(p)));
    }

    function seleccionar(id) {
      _activeId = id;
      const presupuesto = Storage.getById(id);
      if (presupuesto) Form.cargar(presupuesto);
      render();
    }

    return { init, render, seleccionar, setActiveId: (id) => { _activeId = id; } };
  })();

  // ============================================================
  // PDF — vista previa (el servidor arma la hoja) y descarga
  // ============================================================
  const Pdf = (() => {
    // La vista previa: un formulario con target al iframe (sin srcdoc: la CSP de la página lo bloquea).
    function preview(data) {
      const f = document.createElement('form');
      f.method = 'post';
      f.action = `${BASE}/vista`;
      f.target = 'pdfPreviewFrame';
      f.hidden = true;
      const campo = document.createElement('input');
      campo.type = 'hidden';
      campo.name = 'data';
      campo.value = JSON.stringify(data);
      f.appendChild(campo);
      document.body.appendChild(f);
      f.submit();
      f.remove();
      $('modalOverlay').classList.add('active');
    }

    function closePreview() {
      $('modalOverlay').classList.remove('active');
      setTimeout(() => {
        if (!$('modalOverlay').classList.contains('active')) $('pdfPreviewFrame').src = 'about:blank';
      }, 300);
    }

    function nombreDe(res) {
      const cd = res.headers.get('Content-Disposition') || '';
      const utf = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (utf) {
        try {
          return decodeURIComponent(utf[1]);
        } catch {
          // cae al nombre simple
        }
      }
      const simple = /filename="([^"]+)"/i.exec(cd);
      return simple ? simple[1] : 'Presupuesto.pdf';
    }

    // Guarda en el servidor, arma el PDF y lo baja. Devuelve el id del presupuesto.
    async function generar(data) {
      const res = await Storage.request('/pdf', { id: Form.getEditingId() || undefined, chat: Form.getEditingId() ? undefined : (Form.getChat() && Form.getChat().n), data });
      if (!res.ok) {
        let msg = 'No se pudo armar el PDF. Probá de nuevo.';
        try {
          msg = (await res.json()).error || msg;
        } catch {
          // se queda con el texto de arriba
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreDe(res);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return res.headers.get('X-Presupuesto-Id');
    }

    return { preview, closePreview, generar };
  })();

  // ============================================================
  // APP
  // ============================================================
  const App = (() => {
    function toast(message, type = 'info') {
      const container = $('toastContainer');
      const toastEl = h('div', `toast toast-${type}`);
      const icon = h('span');
      icon.innerHTML = ICONS[type] || ICONS.info; // ícono fijo de este archivo
      toastEl.append(icon, h('span', '', message)); // el mensaje va como texto, nunca como HTML
      container.appendChild(toastEl);

      void toastEl.offsetWidth; // reflow para que corra la transición
      toastEl.classList.add('show');

      setTimeout(() => {
        toastEl.classList.remove('show');
        toastEl.classList.add('toast-out');
        setTimeout(() => toastEl.remove(), 350);
      }, 4000);
    }

    // Pasa lo que devolvió el servidor al historial y al formulario.
    function sincronizar(presupuesto) {
      Storage.guardarLocal(presupuesto);
      Form.adoptar(presupuesto);
      Historial.setActiveId(presupuesto.id);
      Historial.render();
    }

    async function generarPDF() {
      if (!Form.validar()) return;
      const btn = $('btnGenerarPDF');
      btn.disabled = true;
      try {
        const id = await Pdf.generar(Form.getData());
        await Storage.cargar();
        const p = id && Storage.getById(id);
        if (p) sincronizar(p);
        toast('PDF descargado exitosamente', 'success');
      } catch (err) {
        toast('Error al generar PDF: ' + err.message, 'error');
      }
      btn.disabled = false;
    }

    async function enviarWhatsApp() {
      const chat = Form.getChat();
      if (!chat || !Form.validar()) return;
      if (!confirm(`¿Mandarle el presupuesto a ${chat.nombre} por WhatsApp? Sale como mensaje del equipo y el chat pasa a Presupuestados.`)) return;
      const btn = $('btnEnviarWA');
      btn.disabled = true;
      try {
        const id = Form.getEditingId();
        const r = await Storage.api('/enviar', { id: id || undefined, chat: id ? undefined : chat.n, data: Form.getData() });
        sincronizar(r.presupuesto);
        toast(r.text, 'success');
      } catch (err) {
        if (err.body && err.body.presupuesto) sincronizar(err.body.presupuesto);
        toast(err.message, 'error');
      }
      btn.disabled = false;
    }

    function init() {
      Form.init();
      Historial.init();

      $('btnNuevo').addEventListener('click', () => {
        Historial.setActiveId(null);
        Historial.render();
        Form.nuevo();
      });

      $('btnGuardar').addEventListener('click', async () => {
        const btn = $('btnGuardar');
        btn.disabled = true;
        try {
          const presupuesto = await Form.guardar();
          if (presupuesto) {
            Historial.setActiveId(presupuesto.id);
            Historial.render();
            toast('Presupuesto guardado correctamente', 'success');
          }
        } catch (err) {
          toast('Error al guardar: ' + err.message, 'error');
        }
        btn.disabled = false;
      });

      $('btnPreview').addEventListener('click', () => {
        if (!Form.validar()) return;
        Pdf.preview(Form.getData());
      });

      $('btnGenerarPDF').addEventListener('click', () => generarPDF());
      $('btnEnviarWA').addEventListener('click', () => enviarWhatsApp());
      $('btnGenerarPDFModal').addEventListener('click', () => {
        Pdf.closePreview();
        generarPDF();
      });
      $('btnCloseModal').addEventListener('click', () => Pdf.closePreview());
      $('btnCloseModal2').addEventListener('click', () => Pdf.closePreview());
      $('modalOverlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) Pdf.closePreview();
      });

      // Ctrl+S guarda. Ctrl+P y Ctrl+N quedan para el navegador.
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 's') {
          e.preventDefault();
          $('btnGuardar').click();
        }
        if (e.key === 'Escape') Pdf.closePreview();
      });

      // Sidebar: colapsar / expandir
      const sidebar = $('sidebar');
      const btnExpand = $('btnExpandSidebar');
      $('btnCollapseSidebar').addEventListener('click', () => {
        sidebar.classList.add('collapsed');
        btnExpand.classList.add('visible');
        localStorage.setItem('sidebar-collapsed', 'true');
      });
      btnExpand.addEventListener('click', () => {
        sidebar.classList.remove('collapsed');
        btnExpand.classList.remove('visible');
        localStorage.setItem('sidebar-collapsed', 'false');
      });
      if (localStorage.getItem('sidebar-collapsed') === 'true') {
        sidebar.classList.add('collapsed');
        btnExpand.classList.add('visible');
      }

      // Historial: sección plegable
      const historialCollapsible = $('historialCollapsible');
      const historialChevron = document.querySelector('.historial-chevron');
      $('historialToggle').addEventListener('click', () => {
        const isHidden = historialCollapsible.classList.toggle('hidden-section');
        historialChevron.classList.toggle('rotated', isHidden);
        localStorage.setItem('historial-hidden', isHidden ? 'true' : 'false');
      });
      if (localStorage.getItem('historial-hidden') === 'true') {
        historialCollapsible.classList.add('hidden-section');
        historialChevron.classList.add('rotated');
      }

      // Qué abrir: un presupuesto guardado, uno precargado desde la ficha, o uno vacío.
      if (boot.abrir) {
        Form.cargar(boot.abrir);
        Historial.setActiveId(boot.abrir.id);
      } else if (boot.nuevo) {
        Form.cargarNuevoDeChat(boot.nuevo.data, boot.nuevo.chat);
      } else {
        Form.nuevo();
      }
      Storage.cargar().then(() => Historial.render());
    }

    return { toast, init };
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.init());
  else App.init();
})();
