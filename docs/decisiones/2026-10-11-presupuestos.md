# Decisión: el creador de presupuestos dentro del CRM (10/11-oct-2026)

**Problema.** Lazar arma cada presupuesto en `herramientas/creador-presupuesto-OS` (Electron), copiando a mano lo que el bot ya juntó, y lo manda desde el celular. Pidió el mismo creador adentro del CRM: misma pantalla, mismo PDF, precargado desde la ficha y con un botón que lo manda por el mismo chat de WhatsApp. Agregó la oferta: que el PDF muestre la Full Panorámica con su precio de lista y de oferta.

**Precedente propio.** La decisión del CRM (`2026-10-10-crm.md`) fija el mismo proceso, las acciones compartidas en `src/actions.ts`, sin dependencias nuevas y HTML armado en el servidor. La cola de salida (`src/outbox.ts`) es el único camino para mandarle algo a un cliente. Tiene idempotencia por clave lógica y conciliación de envíos inciertos, y nunca reenvía a ciegas.

**Decisión.**
- **El PDF sale del mismo `buildHTML` del creador**, portado al pie de la letra a `src/crm/quote-pdf.ts`. El port lo genera un script, no se transcribe a mano.
  - `test/crm-quote.test.ts` lo compara byte a byte contra una copia del `pdf.js` original (`test/fixtures/creador-pdf.cjs`) en 8 casos. La única diferencia es `@page { size: A4; margin: 0 }`: Electron pasaba eso al imprimir.
  - La oferta es un agregado aparte: una franja debajo del título y el precio de lista tachado. Solo aparece si algún renglón tiene precio de lista mayor que su precio.
- **Chromium sin ventana en la imagen del bot** arma el PDF, como hacía el `printToPDF` de Electron. Lo aprobó Lazar el 10-oct.
  - Se corre por línea de comandos: una corrida por vez, tope de 30 s, carpeta temporal propia, y se verifica que el archivo empiece con `%PDF`.
  - Prueba del 10-oct con el Chrome de la notebook:
    - Con red, la línea de comandos espera la fuente de Google: la letra es Inter (fuentes Type3).
    - Sin red, cae a Arial.
    - En Docker se instala `fonts-inter`, así que sin Google igual sale Inter.
    - Sin `@page`, Chrome usa hoja Carta y el presupuesto se va a 2 hojas; con `@page`, 1 hoja A4.
  - No hizo falta CDP.
- **La cola de salida distingue autor (V7).** `outbox.author` puede ser `bot` o `team`, y `outbox.kind` suma `file`. La tabla se rearma, porque el CHECK no se cambia con ALTER. Todo lo anterior queda como `bot`. Una fila del equipo:
  - No la cancelan la toma humana, un mensaje nuevo del cliente, la pausa ni la falla de una fila del bot. A la inversa, una falla del equipo tampoco cancela lo del bot.
  - No cuenta como respuesta del bot (`outboxHasVersion`): tras "Devolver al bot", el bot igual contesta.
  - Vence a las 24 h y solo avisa ("No salió el presupuesto de #n"): nunca sube la versión ni regenera un turno.
  - Se concilia igual que las del bot: por id; si no, por contenido. Un documento se reconoce por su leyenda o por el nombre del archivo, y nunca por un mensaje escrito desde el celular (`source: app`) ni por un texto vacío.
  - Queda en el chat como Equipo · Documento.
- **`sendQuote` (`src/actions.ts`) hace todo en una transacción:**
  - Hace lo mismo que [Presupuesto mandado]: el chat pasa al equipo y a Presupuestados si no estaba más adelante.
  - Agrega la fila `file`/`team` con clave `team:presupuesto:<id>:<n>` y marca el presupuesto como enviado.
  - Si ya hay un envío de ese presupuesto en la cola, no duplica.
  - Para eso `quoteSent` se partió en un núcleo sin transacción, porque las de SQLite no se anidan.
- **Presupuestos en la base (V8, tabla `quotes`).** El historial del creador (`historial.json`) arranca de cero, por decisión de Lazar: los 2 viejos quedan en el creador. Los ids los pone el servidor (`randomUUID`) y toda ruta los valida. Los totales se recalculan en el servidor, nunca se toman del navegador.
- **Precios:**
  - Solo se precargan los `aprobado` de `policy/olimpo.yaml`: Full Panorámica 19.900 con lista 21.900, Panorámica 20.900, platea 8.500.
  - Instalación, logística, vidrio 12 mm y color especial entran como renglón **sin precio**. El creador no deja exportar ni mandar hasta que Lazar los complete o los saque.
  - Las referencias internas (instalación 2.500 por cancha, flete) se muestran solo como ayuda al lado del campo.
- **Textos del creador sin cambios, salvo lo que pidió Lazar el 10-oct:** pago 70/30 y césped 14 mm; la malla queda 3,2 mm. Mensaje que acompaña al PDF: "Te paso el presupuesto."

**Alternativas descartadas.**
- **Seguir con el creador en Electron y solo un botón "Lo mandé"**: no cumple el pedido (mandarlo por el mismo chat sin pasar por el celular) y sigue la copia a mano.
- **Rehacer la plantilla del PDF en el CRM:** Lazar pidió el PDF idéntico, y una plantilla nueva se separa del original con cada arreglo.
- **"Guardar como PDF" del navegador y mandarlo a mano:** cero dependencias, pero no se puede mandar solo por WhatsApp, y el resultado depende de la impresora y de los márgenes de cada navegador.
- **Una librería de PDF en Node (pdfkit, puppeteer):** dependencia nueva. Puppeteer además baja su propio Chromium. El Chromium del sistema por línea de comandos alcanza.
- **Mandar el PDF directo por la API de WAHA, fuera de la cola:** el eco llegaría como "salió por la API, no está en la cola"; sin idempotencia ni conciliación, y nada en la base del chat.

**Reversibilidad.**
- V7 se puede revertir rearmando la tabla sin `author` (los `file` del equipo quedarían afuera).
- V8 es una tabla nueva: se borra.
- El creador viejo queda como está.
- Chromium suma unos 300 MB a la imagen del bot.

**Seguridad.**
- La pantalla tiene su propia CSP: la del CRM más `fonts.googleapis.com` y `fonts.gstatic.com`, que usa la hoja del creador.
- La vista previa es un formulario que apunta a un iframe. El servidor devuelve la hoja con otra CSP: `default-src 'none'`, solo sus estilos, la fuente y el logo en `data:`, con `frame-ancestors 'self'`. No se usa `srcdoc`, porque heredaría la CSP de la página y bloquearía los estilos del PDF.
- Tope de 256 KB por pedido en estas rutas.
- El Chromium del PDF solo abre un HTML que arma el servidor, con todo dato escapado.

**Envío seguro (revisión adversarial del 10-oct).** Un "Enviar por WhatsApp" por chat a la vez (en memoria, un solo proceso), y ningún presupuesto entra a la cola si otro ya va en camino a ese chat: dos pestañas no lo mandan dos veces. A un chat con la ficha en "baja" no se le manda. El chat siempre queda con el equipo, también si ya estaba más adelante que Presupuestados y había vuelto al bot.

**Consecuencias aceptadas.**
- La letra depende de Google la primera vez, y si no responde, de la Inter instalada en la imagen. En la notebook, fuera de Docker y sin red, sale en Arial.
- `aceptado` y `rechazado` del creador no mueven las etapas del CRM.
- Un PDF que no salió (cancelado, vencido, fallido) se borra de `data/presupuestos/` a los 7 días; los que salieron quedan como registro.
