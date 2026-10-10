// Pantalla del creador de presupuestos: el index.html del creador (herramientas/creador-presupuesto-OS) como plantilla del servidor.
// Estilo en public/presupuesto.css y comportamiento en public/presupuesto.js: la CSP no deja style=, handlers ni scripts inline (salvo el bloque JSON del boot).
import { html, jsonForScript, trusted } from './html.ts';
import type { Html } from './html.ts';
import type { QuoteBoot } from './quote-routes.ts';

export interface QuotePageModel {
  boot: QuoteBoot | null; // null: el presupuesto o el chat pedido no existe
  chat: { n: number; nombre: string } | null; // presupuesto de un chat: se puede mandar por WhatsApp y volver al chat
}

const PAIS: Record<string, string> = { '+54': 'AR', '+56': 'CL', '+598': 'UY', '+595': 'PY', '+591': 'BO', '+55': 'BR', '+51': 'PE', '+1': 'EE.UU', '+34': 'ES' };

// Íconos del creador: literales de este archivo (nada de afuera entra acá).
const svg = (size: number, sw: string, body: string, cls = ''): Html =>
  trusted(`<svg${cls ? ` class="${cls}"` : ''} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round">${body}</svg>`);
const PLUS = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
const CHIP_PLUS = '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>';
const DOWNLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
const circle = (cls: string, body: string): Html => html`<div class="icon-circle ${cls}">${svg(20, '2', body)}</div>`;

function head(): Html {
  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Olimpo Padel — Generador de Presupuestos</title>
<link rel="icon" type="image/png" href="/crm/static/icono.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/crm/static/presupuesto.css">
<script src="/crm/static/presupuesto.js" defer></script>
</head>`;
}

function missing(): Html {
  return html`<html lang="es">
${head()}
<body>
<main class="nada">
<p>Ese presupuesto o ese chat no existe.</p>
<a href="/crm/presupuestos">Ir a Presupuestos</a>
</main>
</body>
</html>`;
}

export function quotePage(m: QuotePageModel): Html {
  const b = m.boot;
  if (!b) return missing();
  const back = m.chat ? html`<a class="volver-link" href="/crm/?chat=${m.chat.n}">← Volver al chat</a>` : html`<a class="volver-link" href="/crm/">← Volver al CRM</a>`;
  return html`<html lang="es">
${head()}
<body>
<script type="application/json" id="boot">${jsonForScript(b)}</script>

  <!-- ===== SIDEBAR ===== -->
  <aside class="sidebar" id="sidebar">
    <button class="sidebar-collapse-btn" id="btnCollapseSidebar" title="Colapsar sidebar">
      ${svg(18, '2.5', '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>')}
    </button>

    <div class="brand">
      <img src="/crm/static/logo-creador.png" alt="Olimpo Padel" class="brand-logo">
      <div class="brand-text">
        <h1>Presupuestos</h1>
        <span>Olimpo Padel Argentina</span>
      </div>
    </div>

    <button class="btn btn-huge btn-primary mb-6" id="btnNuevo">
      ${svg(24, '2.5', PLUS)}
      <span class="sidebar-label">Crear Nuevo Presupuesto</span>
    </button>

    <div class="sidebar-header" id="historialToggle">
      <div class="sidebar-header-left">
        ${svg(16, '2.5', '<polyline points="6 9 12 15 18 9"/>', 'historial-chevron')}
        <h2 class="sidebar-title">Historial Guardado</h2>
      </div>
      <span class="sidebar-badge" id="historialCount">0</span>
    </div>

    <div class="historial-collapsible" id="historialCollapsible">
      <div class="search-box">
        ${svg(18, '2', '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 'search-icon')}
        <input type="text" id="searchInput" class="search-input" placeholder="Buscar cliente o N°...">
      </div>

      <div class="historial-list" id="historialList">
        <div class="empty-state" id="emptyState">
          <div class="empty-icon-wrap">
            ${svg(32, '1.5', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>')}
          </div>
          <p>No hay presupuestos</p>
          <span>El historial está vacío.</span>
        </div>
      </div>
    </div>
  </aside>

  <button class="sidebar-expand-btn" id="btnExpandSidebar" title="Expandir sidebar">
    ${svg(20, '2.5', '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>')}
  </button>

  <!-- ===== MAIN CONTENT ===== -->
  <main class="content" id="content">
    <header class="content-top-bar">
      <div class="top-bar-left">
        ${back}
        <h2 id="formTitle" class="current-mode-title">Nuevo Presupuesto</h2>
        <span class="doc-number" id="formNumero" hidden>OP-202X-...</span>
      </div>
      <div class="top-bar-actions">
        <button type="button" class="btn btn-md btn-outline" id="btnPreview">
          ${svg(18, '2', '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>')}
          Ver PDF
        </button>
        <button type="button" class="btn btn-md btn-secondary" id="btnGuardar">
          ${svg(18, '2', '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>')}
          Guardar Borrador
        </button>
        <button type="button" class="btn btn-md btn-primary" id="btnGenerarPDF">
          ${svg(18, '2.5', DOWNLOAD)}
          Exportar y Listo
        </button>
        <button type="button" class="btn btn-md btn-whatsapp" id="btnEnviarWA" hidden>
          ${svg(18, '2', '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>')}
          Enviar por WhatsApp
        </button>
      </div>
      <p class="envio-estado" id="envioEstado" hidden></p>
    </header>

    <div class="form-wrapper">
      <form class="main-form" id="presupuestoForm" autocomplete="off">

        <!-- SECCIÓN 1: CLIENTE -->
        <div class="form-card">
          <div class="card-title">
            ${circle('text-blue', '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')}
            <h3>1. Datos del Cliente</h3>
          </div>
          <div class="grid-layout cols-2">
            <div class="input-block col-span-2">
              <label for="clienteNombre">Nombre o Club (Obligatorio) *</label>
              <input type="text" id="clienteNombre" class="input-big" placeholder="Ej: Club Deportivo Luján" required>
            </div>
            <div class="input-block">
              <label for="clienteTelefono">Teléfono / WhatsApp (Opcional)</label>
              <div class="input-group">
                <select id="clienteCodigoPais" class="select-addon">
                  ${b.codigosPais.map((c) => html`<option value="${c}">${c} (${PAIS[c] ?? ''})</option>`)}
                </select>
                <input type="text" id="clienteTelefono" placeholder="9 11 1234 5678">
              </div>
            </div>
            <div class="input-block">
              <label for="clienteLocalidad">Localidad (Opcional)</label>
              <input type="text" id="clienteLocalidad" placeholder="Ciudad, Provincia">
            </div>
          </div>
        </div>

        <!-- SECCIÓN 2: PROYECTO -->
        <div class="form-card">
          <div class="card-title">
            ${circle('text-purple', '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>')}
            <h3>2. Proyecto y Canchas</h3>
          </div>
          <div class="input-block">
            <label for="titulo">Título Principal que verá el cliente *</label>
            <input type="text" id="titulo" class="input-xl" placeholder="Ej: PROYECTO 2 CANCHAS FULL PANORÁMICAS" required>
            <p class="help-text">Se mostrará grande en el PDF para identificar el presupuesto.</p>
          </div>

          <div class="products-area mt-6">
            <label class="section-subtitle">¿Qué le vamos a cobrar?</label>
            <div class="products-table-header">
              <div class="pth-col pth-desc">Cancha o Servicio</div>
              <div class="pth-col pth-cant">Cant.</div>
              <div class="pth-col pth-precio" id="pthPrecio">Precio Unit.</div>
              <div class="pth-col pth-sub" id="pthSub">Total</div>
              <div class="pth-col pth-btn"></div>
            </div>
            <div class="products-list-wrapper" id="productsList"></div>

            <button type="button" class="btn btn-outline btn-block mt-3" id="btnAgregarProducto">
              ${svg(20, '2.5', PLUS)}
              Agregar otra cancha o servicio a cobrar
            </button>
          </div>

          <div class="totals-panel mt-6">
            <div class="tp-config">
              <div class="input-block mb-4">
                <label for="moneda">Moneda</label>
                <select id="moneda" class="select-big">
                  <option value="USD">Dólares (USD)</option>
                  <option value="ARS">Pesos (ARS)</option>
                </select>
              </div>

              <div class="discount-box discount-box-global mb-4">
                <label class="toggle-switch form-group-row">
                  <span class="toggle-label fw-bold">Presupuesto global estimado (ocultar unitarios)</span>
                  <input type="checkbox" id="precioGlobalCheck">
                  <span class="toggle-slider"></span>
                </label>
                <div class="discount-active-area mt-10" id="precioGlobalWrap" hidden>
                  <label for="precioGlobalManual">Monto total estimado:</label>
                  <input type="number" id="precioGlobalManual" class="input-big text-right font-mono" min="0" step="any" value="0" placeholder="Ej: 15000">
                </div>
              </div>

              <div class="discount-box">
                <label class="toggle-switch form-group-row">
                  <span class="toggle-label fw-bold">¿Hacer un descuento?</span>
                  <input type="checkbox" id="descuentoCheck">
                  <span class="toggle-slider"></span>
                </label>
                <div class="discount-active-area" id="descuentoWrap" hidden>
                  <label for="descuentoPct">Porcentaje de descuento:</label>
                  <div class="input-icon-right">
                    <input type="number" id="descuentoPct" class="input-big text-right font-mono" min="0" max="100" value="0">
                    <span class="icon-addon">%</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="tp-summary">
              <div class="summary-row text-muted">
                <span>Subtotal</span>
                <span id="subtotalDisplay" class="font-mono">$0</span>
              </div>
              <div class="summary-row text-red" id="descuentoLine" hidden>
                <span>Descuento (<span id="descuentoPctDisplay">0</span>%)</span>
                <span id="descuentoDisplay" class="font-mono">-$0</span>
              </div>
              <div class="summary-row grand-total mt-4">
                <span>PRECIO FINAL</span>
                <span id="totalDisplay" class="font-mono">$0</span>
              </div>
            </div>
          </div>
        </div>

        <!-- SECCIÓN 3: TEXTOS LEGALES Y LOGÍSTICA -->
        <div class="grid-layout cols-2">
          <div class="form-card col-span-2">
            <div class="card-title">
              ${circle('text-orange', '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>')}
              <h3>3. Especificaciones Técnicas a Incluir</h3>
            </div>
            <p class="help-text mb-4">Esta es la lista con el detalle de los materiales (vidrios, pasto, red) que el cliente verá en su presupuesto. Revisa que estén correctos.</p>

            <div class="specs-list" id="itemsList"></div>
            <div class="specs-actions-toolbar mt-3">
              <button type="button" class="btn btn-outline btn-add-spec" id="btnAgregarItem">
                ${svg(18, '2.5', PLUS)}
                Agregar detalle manual
              </button>
              <div class="specs-presets-group">
                <span class="specs-presets-label">Presets rápidos:</span>
                <button type="button" class="btn-chip" id="btnSpecsCancha" title="Agregar especificaciones de Cancha">
                  ${svg(14, '2', CHIP_PLUS)}
                  + Specs Cancha
                </button>
                <button type="button" class="btn-chip btn-chip-orange" id="btnSpecsPlatea" title="Agregar especificaciones de Platea de Hormigón">
                  ${svg(14, '2', CHIP_PLUS)}
                  + Specs Platea
                </button>
                <button type="button" class="btn-chip btn-chip-ghost" id="btnLimpiarSpecs" title="Vaciar especificaciones">
                  ${svg(14, '2', '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>')}
                  Limpiar
                </button>
              </div>
            </div>
          </div>

          <div class="form-card">
            <div class="card-title">
              ${circle('text-green', '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>')}
              <h3>Condiciones de Pago</h3>
            </div>
            <textarea id="condicionesPago" class="styled-textarea" rows="4">${b.condiciones}</textarea>
          </div>

          <div class="form-card">
            <div class="card-title">
              ${circle('text-yellow', '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')}
              <h3>Tiempo de Entrega / Notas</h3>
            </div>
            <div class="input-block mb-4">
              <label for="plazoEntrega">Plazo estimado</label>
              <input type="text" id="plazoEntrega" value="${b.plazo}">
            </div>
            <div class="input-block">
              <label for="notasAdicionales">Otras notas (Opcional)</label>
              <textarea id="notasAdicionales" class="styled-textarea" rows="2" placeholder="Escribe aquí si hay que aclarar viáticos, traslados, etc..."></textarea>
            </div>
          </div>
        </div>

        <div class="form-spacer"></div>
      </form>
    </div>
  </main>

  <!-- ===== MODAL PREVIEW ===== -->
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal-large" id="modalPreview">
      <div class="modal-header">
        <div class="modal-title-group">
          <h3 class="font-outfit font-bold title-xl">Revisión del PDF</h3>
          <span class="badge-blue">Vista Previa</span>
        </div>
        <button class="btn-icon" id="btnCloseModal">
          ${svg(24, '2.5', '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
        </button>
      </div>
      <div class="modal-body bg-gray">
        <iframe id="pdfPreviewFrame" name="pdfPreviewFrame" class="pdf-frame" title="Vista previa del PDF"></iframe>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline btn-lg" id="btnCloseModal2">Quiero seguir editando</button>
        <button class="btn btn-primary btn-lg" id="btnGenerarPDFModal">
          ${svg(20, '2.5', DOWNLOAD)}
          Todo perfecto, Exportar PDF
        </button>
      </div>
    </div>
  </div>

  <div class="toast-container" id="toastContainer"></div>
</body>
</html>`;
}
