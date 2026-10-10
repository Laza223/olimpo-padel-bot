# Mensaje para la sesión del CRM

Copiar todo lo que está debajo de la línea y pegarlo como primer mensaje de una sesión nueva de Claude Code, abierta en `C:\Users\Lazar\Documents\OLIMPO PADEL`.

---

Quiero que armes el **CRM de Olimpo Padel**: una app local (localhost) para manejar los clientes que trae el bot de ventas de WhatsApp. Antes de escribir código, entrá en modo plan, leé lo que te indico y haceme las preguntas de negocio que no puedas resolver vos.

## Quién soy y cómo trabajamos

- Soy Lazar, socio de Olimpo Padel junto con Tomás. Fabricamos e instalamos canchas de pádel. **No soy ingeniero**: yo decido negocio, costo y gusto; lo técnico lo cerrás vos y me traés una recomendación.
- Si algo es una decisión mía (precio, condiciones, qué le dice el bot al cliente, marca), usá el formato **REQUIERE INPUT** con preguntas numeradas. No lo resuelvas en silencio.
- Hablame en español rioplatense, directo y sin palabras técnicas. Código e identificadores en inglés.
- **Nunca inventes un número** (precio, plazo, medida). Si no hay dato, poné "SIN DATO" o preguntame.

## Leé primero, en este orden

1. `CLAUDE.md` (carpeta raíz) y `bot-ventas/CLAUDE.md`. Mandan sobre todo lo demás.
2. `docs/00-contexto-negocio.md` y `docs/03-estado-y-pendientes.md`: qué vendemos y dónde estamos.
3. `bot-ventas/docs/operacion.md`: cómo funciona y se opera el bot hoy, incluidos Telegram y el modo sombra.
4. `bot-ventas/LEDGER.md` (al menos las últimas secciones): decisiones recientes y su porqué.
5. `bot-ventas/src/`, en este orden:
   - `types.ts` (ficha, estados, motivos de derivación);
   - `db.ts` (tablas);
   - `notify/telegram.ts` (todas las acciones que hago hoy desde Telegram);
   - `worker.ts`, `turn.ts`, `handoff.ts`, `lead.ts`.
6. `landing/DESIGN.md` y `landing/PRODUCT.md`: la marca (navy `#0b2132`, celeste `#4095b6`, Archivo) y el contexto de producto, armados con impeccable.
7. `herramientas/creador-presupuesto-OS/` (README y `src/`): el generador de presupuestos en PDF que ya existe (Electron).
8. `costos/` y `bot-ventas/policy/olimpo.yaml`: precios y lo que el bot tiene aprobado decir.

## Qué existe hoy

**El bot** (`bot-ventas/`, Node 24 + TypeScript sin build, SQLite en `bot-ventas/data/`, todo en Docker Compose en mi notebook):

- **Canal:** WAHA conectado a WhatsApp.
- **Cerebro:** Claude Sonnet 5.5, con un controlador en código que bloquea lo que no está aprobado.
- **Qué hace:** atiende a quien escribe, contesta y completa una **ficha**:
  - datos obligatorios: nombre, localidad, provincia, cantidad de canchas, modelo (Full Panorámica o Panorámica) y platea;
  - opcionales: ubicación techada/aire libre, altura, plazo, forma de pago, quién decide, uso, financiación, etc.
- **Cuando la ficha se completa:**
  - le dice al cliente "Te mandamos el presupuesto por acá en el día, o a más tardar el día hábil siguiente.";
  - deja de contestar (estado `derivado`);
  - avisa al grupo de Telegram.
- **Estados de la ficha:** `nuevo`, `calificando`, `listo_para_presupuesto`, `derivado`, `descartado`, `baja`, `no_es_cliente`.
- **Modos del chat:** `auto`, `humano`, `pausado`, `cerrado`.
- **Motivos de derivación:** `listo_para_presupuesto`, `cliente_grande`, `pide_persona`, `enojado`, `regateo`, `pide_verificacion`, `factura_a`, `fuera_de_politica`, etc. Unos frenan al bot (stop) y otros solo avisan (flag).
- **Tablas:**
  - `conversations`: ficha en `card_json`, modo, costo, actividad;
  - `messages`: autor `customer`, `bot`, `team` o `system`; con media;
  - `outbox`: cola de salida, con idempotencia y conciliación; ya tiene una migración V5;
  - `drafts`: borradores del modo sombra;
  - `agent_runs`: costo por turno;
  - `audit`, `settings`, y estado clave/valor (por ejemplo `quote_sent_utc.<chatId>`).

**Telegram** es hoy mi único panel.

- **Por cada chat derivado llega una ficha:**
  - encabezado: `Chat #2 · nombre`, el modo (NORMAL) y el estado ("Listo para presupuesto, el bot dejó de responder"), si es tibio o caliente;
  - los datos, la nota interna y los últimos mensajes.
- **Botones de la ficha:** [Lo tomo] [Devolver al bot] [Presupuesto mandado].
- **En modo sombra, cada borrador trae:** [Mandar] [Descartar] [Lo tomo].
- **Comandos:** `/estado`, `/chat N`, `/bot N`, `/humano N`, `/apagar`, `/prender`, `/sombra on|off`, `/set`, `/qr`.
- **[Presupuesto mandado]** hoy solo anota la hora. Estaba pensado para que una fase futura (F4, sin hacer) arme recordatorios los días 1, 3, 7, 14 y 21.

**El generador de presupuestos** (`herramientas/creador-presupuesto-OS/`) es una app aparte que arma el PDF a mano. Su README dice que ya tiene la marca Olimpo, pero el `CLAUDE.md` raíz dice que tiene membrete y especificaciones de Elite, nuestro ex empleador. **Verificalo en el código.** Las especificaciones tienen que coincidir con el modelo vigente: Rev. D, en `fabricacion/rev-d/`.

## El problema

Con 30 clientes para presupuestar a la vez no tengo forma de llevar el control:
- no sé cuál quedó colgado, ni hace cuánto espera cada uno;
- no hay un orden;
- todo vive en mensajes de Telegram que se pierden entre sí.

## Lo que quiero

1. **Etapas del cliente**, por ejemplo "A presupuestar", "Presupuestados", "Seguimiento" y "Cliente" (ganado), más perdidos o descartados. Los nombres y las etapas finales los decido yo: proponémelos.
2. **Todo lo que hago desde Telegram, también desde el CRM:**
   - tomar un chat y devolverlo al bot;
   - marcar el presupuesto como mandado;
   - aprobar o descartar borradores;
   - apagar y prender el bot, y el modo sombra.
3. **El presupuesto pre-cargado con los datos de la ficha** (cliente, localidad, canchas, modelo, platea) y precios aprobados. Yo edito lo que haga falta, agrego y cambio, y lo mando. Ideal: mandarlo por el mismo chat de WhatsApp. Evaluá si conviene integrar el generador existente o rehacer solo la parte que sirve.
4. **La etapa también ordena al bot:** que sepa en qué etapa está cada cliente y cómo comportarse en cada una.
   - El **seguimiento** (que el bot le escriba al cliente después del presupuesto) **todavía no se hace**: recién arrancamos.
   - Dejá el modelo de datos listo para eso, sin construirlo.
   - Ojo: escribirle a alguien que no escribió primero hoy está prohibido por regla y aumenta el riesgo de baneo de WhatsApp. Cuando llegue, es una decisión aparte.
5. **Diseño con la skill `impeccable`.** Eficiente y funcional, sin ruido, pero interesante por lo potente. La mayoría de las veces, lo simple que resuelve algo importantísimo es lo más potente, no lo que más funciones tiene. Mi pregunta de todos los días es "¿qué tengo que hacer ahora y quién está esperando hace más tiempo?": la pantalla principal tiene que contestar eso de un vistazo.

## Restricciones duras

- **Solo local:** el servidor escucha en `127.0.0.1`, como el resto del stack. Sin deploy, sin cuentas en la nube y sin dependencias de pago.
- **Una sola fuente de verdad: la base del bot.** Las acciones del CRM tienen que pasar por las **mismas funciones** que usa Telegram (`switchToHuman`, `setMode` / `giveBack`, `quoteSent`, `approveDraft`, `setSetting`, `enqueueReply`…), nunca por un UPDATE directo que saltee sus reglas (cola de salida, versiones de contexto, auditoría). `giveBack` y `quoteSent` hoy son funciones internas de `notify/telegram.ts`: sacalas a un módulo compartido para que Telegram y el CRM llamen a lo mismo.
- **Mi recomendación técnica, a validar con la skill `decision-arquitectura`:** el CRM vive dentro de `bot-ventas`, servido por el mismo proceso Node (ya hay un servidor HTTP en `src/http.ts`, puerto 8080 publicado solo en 127.0.0.1). Así comparte la base y las funciones sin un segundo escritor de SQLite. Si proponés otra cosa, explicame por qué en criollo.
- **Secretos:** solo en `.env`, nunca en git, logs, prompts ni en el front. El repo de GitHub es público.
- **Precios:** el bot y el presupuesto usan solo lo aprobado en `policy/olimpo.yaml` o lo que yo escriba a mano. El precio de venta y si incluye la instalación siguen pendientes (ver `CLAUDE.md` raíz): no lo asumas.
- **Lenguaje de pantalla en criollo y sin códigos internos:** "a presupuestar", no `listo_para_presupuesto`.
- **No rompas el bot:**
  - `pnpm verify` (typecheck + ~830 tests) tiene que quedar en verde;
  - toda migración nueva va después de la V5;
  - tocar prompts, el controlador o la lógica de derivación es otro esfuerzo, que se consulta primero.

## Cómo quiero que lo encares

1. Cargá `protocolo-orquestacion` y `entrega-feature`. Usá subagentes Sonnet como máximo 6 a la vez, y anotá cada delegación en `bot-ventas/LEDGER.md`.
2. Investigá el código real antes de proponer, y verificá que existan las funciones que pensás reusar.
3. Planteame un plan con un **primer corte chico y usable** y lo que sigue después. Por ejemplo, el primer corte podría ser la bandeja con etapas, el tiempo de espera y las acciones de Telegram; el segundo, el presupuesto pre-cargado.
4. Hacé las preguntas de negocio con opciones, poniendo primero la que recomendás.
5. Para el diseño: corré `impeccable` con su contexto de producto (podés partir del `PRODUCT.md` de la landing) y mostrame la dirección antes de construir todo.
6. Cerrá cada corte con evidencia:
   - `pnpm verify` en verde;
   - la app corriendo de verdad, revisada con `sonnet-ux-verifier`;
   - una revisión adversarial del diff con contexto fresco;
   - commit y push.
