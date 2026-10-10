/* ============================================================
   PDF — Generación y preview del presupuesto PDF
   ============================================================ */

const PDF = (() => {
  let _logoBase64 = '';

  async function init() {
    try {
      _logoBase64 = await window.electronAPI.getLogoBase64();
    } catch (err) {
      console.error('Error loading logo:', err);
    }
  }

  function formatNum(num) {
    return new Intl.NumberFormat('es-AR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(num);
  }

  // Build full HTML for the PDF
  function buildHTML(data, numero) {
    const fecha = new Date().toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const monedaSymbol = data.moneda === 'USD' ? 'USD' : 'ARS';

    // Products table
    const productosHTML = (data.productos || [])
      .filter(p => p.modelo)
      .map(p => {
        const nombre = p.modelo === 'Otro' ? (p.nombreCustom || 'Otro') : p.modelo;
        const subtotal = (p.cantidad || 0) * (p.precioUnitario || 0);
        
        if (data.esPrecioGlobal) {
          return `
            <tr>
              <td class="td-nombre">${escapeHtml(nombre)}</td>
              <td class="td-cant" style="text-align:right">${p.cantidad || 1}</td>
            </tr>`;
        }

        return `
          <tr>
            <td class="td-nombre">${escapeHtml(nombre)}</td>
            <td class="td-cant">${p.cantidad || 1}</td>
            <td class="td-precio">${monedaSymbol} $${formatNum(p.precioUnitario || 0)}</td>
            <td class="td-subtotal">${monedaSymbol} $${formatNum(subtotal)}</td>
          </tr>`;
      })
      .join('');

    // Specs
    const itemsHTML = (data.items || [])
      .filter(i => i.descripcion && i.descripcion.trim())
      .map(i => `<li>${escapeHtml(i.descripcion)}</li>`)
      .join('');

    // Notas
    const notasSection = data.notasAdicionales
      ? `
        <div class="section">
          <div class="section-title">NOTAS ADICIONALES</div>
          <div class="section-content notes">${escapeHtml(data.notasAdicionales).replace(/\n/g, '<br>')}</div>
        </div>
      `
      : '';

    // Plazo
    const plazoSection = data.plazoEntrega
      ? `
        <div class="section">
          <div class="section-title">PLAZO DE ENTREGA</div>
          <div class="section-content">${escapeHtml(data.plazoEntrega)}</div>
        </div>
      `
      : '';

    // Descuento
    const colspanValue = data.esPrecioGlobal ? '1' : '3';
    const descuentoRow = data.descuentoPct > 0
      ? `
        <tr class="totals-row descuento-row">
          <td colspan="${colspanValue}">Descuento (${data.descuentoPct}%)</td>
          <td class="td-subtotal descuento-value" style="text-align:right">-${monedaSymbol} $${formatNum(data.descuento || 0)}</td>
        </tr>
      `
      : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', Arial, sans-serif;
      font-size: 11pt;
      color: #1a1a2e;
      background: #ffffff;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    .page {
      width: 210mm;
      min-height: 297mm;
      padding: 0;
      position: relative;
    }

    /* === HEADER === */
    .header {
      background: linear-gradient(135deg, #0e1529 0%, #1B2A4A 60%, #1a3055 100%);
      color: #ffffff;
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      position: relative;
      overflow: hidden;
    }

    .header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #00A3FF, #2D5F8A, #00A3FF);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .header-logo {
      width: 72px;
      height: 72px;
      object-fit: contain;
      border-radius: 8px;
    }

    .header-company {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .company-name {
      font-size: 20pt;
      font-weight: 800;
      letter-spacing: 1px;
      color: #ffffff;
    }

    .company-detail {
      font-size: 8.5pt;
      color: rgba(255,255,255,0.7);
      font-weight: 400;
    }

    .header-right {
      text-align: right;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }

    .presupuesto-number {
      font-size: 13pt;
      font-weight: 700;
      color: #ffffff;
      background: rgba(255,255,255,0.12);
      padding: 6px 16px;
      border-radius: 6px;
      letter-spacing: 0.5px;
    }

    .presupuesto-date {
      font-size: 9pt;
      color: rgba(255,255,255,0.6);
      font-weight: 400;
    }

    /* === MAIN CONTENT === */
    .body-content {
      padding: 16px 40px;
    }

    /* === TITLE BAR === */
    .title-bar {
      text-align: center;
      margin-bottom: 16px;
      padding: 10px 24px;
      background: #f0f4f8;
      border-radius: 8px;
      border-left: 4px solid #00A3FF;
    }

    .title-bar h2 {
      font-size: 15pt;
      font-weight: 800;
      color: #1B2A4A;
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    /* === CLIENT INFO === */
    .client-info {
      display: flex;
      gap: 32px;
      margin-bottom: 16px;
      padding: 12px 24px;
      background: #fafbfc;
      border-radius: 8px;
      border: 1px solid #e8ecf1;
    }

    .client-field {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .client-label {
      font-size: 7.5pt;
      font-weight: 700;
      color: #6b7a8d;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .client-value {
      font-size: 11pt;
      font-weight: 600;
      color: #1a1a2e;
    }

    /* === PRODUCTS TABLE === */
    .products-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }

    .products-table thead th {
      font-size: 7.5pt;
      font-weight: 700;
      color: #ffffff;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 10px 14px;
      background: #1B2A4A;
      text-align: left;
    }

    .products-table thead th:first-child {
      border-radius: 6px 0 0 0;
    }

    .products-table thead th:last-child {
      border-radius: 0 6px 0 0;
      text-align: right;
    }

    .products-table thead th.th-cant,
    .products-table thead th.th-precio {
      text-align: center;
    }

    .products-table tbody td {
      padding: 12px 14px;
      border-bottom: 1px solid #eef0f4;
      font-size: 10.5pt;
    }

    .products-table tbody tr:last-child td {
      border-bottom: 2px solid #e0e4ea;
    }

    .td-nombre {
      font-weight: 600;
      color: #1a1a2e;
    }

    .td-cant {
      text-align: center;
      font-weight: 600;
      color: #4a5568;
    }

    .td-precio {
      text-align: center;
      color: #4a5568;
    }

    .td-subtotal {
      text-align: right;
      font-weight: 700;
      color: #1B2A4A;
    }

    /* Totals rows */
    .totals-row td {
      padding: 8px 14px;
      font-size: 10pt;
      border-bottom: none !important;
      color: #4a5568;
    }

    .totals-row td:first-child {
      text-align: right;
      font-weight: 500;
    }

    .totals-row.descuento-row td {
      color: #dc2626;
    }

    .descuento-value {
      color: #dc2626 !important;
      font-weight: 600 !important;
    }

    .totals-row.total-row td {
      padding-top: 12px;
      border-top: 2px solid #1B2A4A;
      font-weight: 800;
      font-size: 13pt;
      color: #1B2A4A;
    }

    /* === SECTIONS === */
    .section {
      margin-bottom: 12px;
    }

    .section-title {
      font-size: 8.5pt;
      font-weight: 700;
      color: #2D5F8A;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding-bottom: 8px;
      margin-bottom: 10px;
      border-bottom: 2px solid #e8ecf1;
      position: relative;
    }

    .section-title::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 0;
      width: 40px;
      height: 2px;
      background: #2D5F8A;
    }

    .section-content {
      font-size: 10.5pt;
      line-height: 1.7;
      color: #2d3748;
    }

    .section-content ul {
      list-style: none;
      padding: 0;
    }

    .section-content ul li {
      padding: 6px 0 6px 24px;
      position: relative;
      border-bottom: 1px solid #f0f2f5;
    }

    .section-content ul li:last-child {
      border-bottom: none;
    }

    .section-content ul li::before {
      content: '';
      position: absolute;
      left: 0;
      top: 13px;
      width: 8px;
      height: 8px;
      background: #2D5F8A;
      border-radius: 50%;
    }

    .notes {
      padding: 10px 14px;
      background: #fffbeb;
      border-radius: 8px;
      border-left: 3px solid #f59e0b;
      font-size: 10pt;
      color: #78350f;
      font-style: italic;
    }

    /* === FOOTER === */
    .footer {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid #e8ecf1;
      text-align: center;
    }

    .footer p {
      font-size: 8.5pt;
      color: #8896a6;
      line-height: 1.5;
    }

    .footer-brand {
      margin-top: 10px;
      font-size: 7.5pt;
      color: #b0bac5;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <div class="page">
    <!-- HEADER -->
    <div class="header">
      <div class="header-left">
        <img src="${_logoBase64}" class="header-logo" alt="Olimpo Padel">
        <div class="header-company">
          <div class="company-name">OLIMPO PADEL</div>
          <div class="company-detail">Buenos Aires, Argentina</div>
          <div class="company-detail">+54 9 2323 61-0592</div>
          <div class="company-detail">www.olimpopadel.com</div>
        </div>
      </div>
      <div class="header-right">
        <div class="presupuesto-date">Fecha: ${fecha}</div>
      </div>
    </div>

    <!-- BODY -->
    <div class="body-content">
      <!-- TITLE -->
      <div class="title-bar">
        <h2>${escapeHtml(data.titulo)}</h2>
      </div>

      <!-- CLIENT -->
      <div class="client-info">
        <div class="client-field" style="flex:1">
          <span class="client-label">Cliente</span>
          <span class="client-value">${escapeHtml(data.clienteNombre)}</span>
        </div>
        ${data.clienteLocalidad ? `
        <div class="client-field">
          <span class="client-label">Localidad</span>
          <span class="client-value">${escapeHtml(data.clienteLocalidad)}</span>
        </div>` : ''}
        ${data.clienteTelefono ? `
        <div class="client-field">
          <span class="client-label">Teléfono</span>
          <span class="client-value">${escapeHtml(data.clienteCodigoPais || '')} ${escapeHtml(data.clienteTelefono)}</span>
        </div>` : ''}
      </div>

      <!-- PRODUCTOS TABLE -->
      <table class="products-table">
        <thead>
          <tr>
            <th>Producto / Servicio</th>
            ${data.esPrecioGlobal 
              ? '<th style="text-align:right; border-radius: 0 6px 0 0;">Cant.</th>' 
              : '<th class="th-cant">Cant.</th><th class="th-precio">Precio Unit.</th><th style="text-align:right">Subtotal</th>'}
          </tr>
        </thead>
        <tbody>
          ${productosHTML}
          ${data.esPrecioGlobal ? '' : `
          <tr class="totals-row">
            <td colspan="3">Subtotal</td>
            <td class="td-subtotal">${monedaSymbol} $${formatNum(data.subtotal || data.precioTotal)}</td>
          </tr>`}
          ${descuentoRow}
          <tr class="totals-row total-row">
            <td colspan="${data.esPrecioGlobal ? '1' : '3'}">TOTAL</td>
            <td class="td-subtotal" style="text-align:right">${monedaSymbol} $${formatNum(data.precioTotal)}</td>
          </tr>
        </tbody>
      </table>

      <!-- ESPECIFICACIONES -->
      ${itemsHTML ? `
      <div class="section">
        <div class="section-title">ESPECIFICACIONES TÉCNICAS</div>
        <div class="section-content">
          <ul>${itemsHTML}</ul>
        </div>
      </div>
      ` : ''}

      <!-- CONDICIONES DE PAGO -->
      ${data.condicionesPago ? `
      <div class="section">
        <div class="section-title">CONDICIONES DE PAGO</div>
        <div class="section-content">${escapeHtml(data.condicionesPago).replace(/\n/g, '<br>')}</div>
      </div>
      ` : ''}

      <!-- PLAZO DE ENTREGA -->
      ${plazoSection}

      <!-- NOTAS -->
      ${notasSection}

      <!-- FOOTER -->
      <div class="footer">
        <p>Este presupuesto tiene una validez de <strong>15 días hábiles</strong> desde la fecha de emisión.</p>
        <p>Los precios pueden variar según la cotización vigente al momento de la aceptación.</p>
        <div class="footer-brand">OLIMPO PADEL ARGENTINA — Fabricación e instalación de canchas de pádel</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  // Show preview in modal
  function preview(data, numero) {
    const html = buildHTML(data, numero);
    const frame = document.getElementById('pdfPreviewFrame');
    frame.srcdoc = html;

    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('active');
  }

  // Close preview modal
  function closePreview() {
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.remove('active');

    setTimeout(() => {
      document.getElementById('pdfPreviewFrame').srcdoc = '';
    }, 300);
  }

  // Generate PDF file
  async function generar(data, numero, clienteNombre) {
    const html = buildHTML(data, numero);
    const nombreArchivo = `Presupuesto_${sanitizeFilename(clienteNombre)}`;

    try {
      const pdfPath = await window.electronAPI.generarPDF(html, nombreArchivo);
      return pdfPath;
    } catch (err) {
      console.error('Error generating PDF:', err);
      throw err;
    }
  }

  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s_-]/g, '').replace(/\s+/g, '_').substring(0, 50);
  }

  function escapeHtml(text) {
    if (!text) return '';
    if (typeof document !== 'undefined') {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    init,
    preview,
    closePreview,
    generar,
    buildHTML,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PDF;
}

