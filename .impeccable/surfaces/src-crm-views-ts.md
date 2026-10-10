---
version: 1
slug: "src-crm-views-ts"
primary_target: "src/crm/views.ts"
related_targets: []
---

# CRM · pantalla principal (src/crm/views.ts)

Modo: Operate. Lo usa Lazar en su notebook, varias veces por día, entre otras tareas; a veces desde el celular.
Tarea: ver quién espera hace más, abrir el chat, leer, hacer la acción que corresponde (mandar borrador, presupuesto mandado, tomar, devolver, mover de etapa) y seguir.
Restricción de Lazar (10-oct): tiene que sentirse como WhatsApp Web (chats a la izquierda, conversación en el medio), adaptado a lo que hace el CRM. No romper esa costumbre.
Sin caja para escribir (el bot habla; Lazar contesta desde WhatsApp). Sin presupuesto todavía (corte 2).

## Direction contract

THESIS: WhatsApp Web del equipo de Olimpo, donde la lista de chats no se ordena por el último mensaje sino por quién espera hace más, con un reloj de espera en cada fila. Rechaza el CRM de categoría: tablero de tarjetas con números, kanban, tablas densas.

OWN-WORLD: navy #0b2132 como cromo de la app (franja de estado arriba y cabecera de la lista); superficies claras #f3f6f9 y blanco para lista y conversación; un único acento celeste (#4095b6, #7cc0dc para foco y selección); rojo #d42f38 con un solo significado: venció la promesa. Una sola familia, Archivo, con números tabulares en los relojes. Globos: cliente blanco a la izquierda, bot en tinte navy suave a la derecha, equipo en tinte celeste a la derecha; el borrador del bot es un globo "sin mandar" con borde punteado y sus botones.

STORY: Lazar abre, ve "Hacer ahora" con el que más espera arriba, entra, lee la charla, el panel de la derecha le dice qué juntó el bot y le da la acción; la hace y pasa al siguiente.

FIRST VIEWPORT (1440×900): franja navy de 44 px a todo el ancho (logo, interruptores Bot y Modo sombra, estado de WhatsApp, gasto de hoy, Salir). Columna izquierda de 360 px: pestañas Hacer ahora (n) / Todos / Etapas, buscador, filas de 72 px con el reloj de espera grande a la izquierda. Centro: cabecera del chat (nombre, lugar, etapa, Abrir en WhatsApp), conversación con separadores de día, y abajo una barra tranquila en lugar del teclado. Derecha 340 px: ficha, qué falta, nota del bot, etapa, acciones, historial.

FORM: three-pane messenger (WhatsApp Web), posición 1 de mi lista; pedido explícito del usuario, no tirada. Seed d8812a6a descartada por el pedido.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
