# v1 — primera variante del prompt para claude-* (`src/instructions-claude.ts`)

Qué cambia respecto del prompt de OpenAI (los hechos y reglas son los mismos; cambia cómo se ordenan y se explican):
- Datos de referencia arriba (`<politica>`, `<tono>`, `<material>`) y las instrucciones después, con etiquetas XML (`<rol>`, `<como_trabajar_cada_turno>`, `<preguntar_sin_presionar>`, `<contenido>`, `<formato>`, `<ficha>`, `<cierre>`, `<senales>`, `<ejemplos>`, `<salida>`).
- Un paso a paso por turno: anotar todo lo que pide el cliente, contestar cada punto antes de preguntar, ver si el turno es el último antes de pasar al equipo (sin preguntas), decidir si preguntar, revisar el borrador.
- Reglas con su porqué para las fallas que se repetían en Haiku y Sonnet: contestar cada pregunta (lo que la política no cubre = "lo ve el equipo"), no repreguntar ni presionar, modelos solo "Full Panorámica" y "Panorámica", nunca "incluidos" para instalación y flete, contacto de la política, respuesta literal sobre la empresa anterior, platea.
- 3 ejemplos de contraste inventados (no salen de los escenarios).

Resultados (train, 28 conversaciones, jueza Sonnet low):
| esfuerzo | críticas | reintento | seguros | juez prom. (mín) | p95 | costo corrida |
|---|---|---|---|---|---|---|
| high | 2 | 3,5 % | 0 % | 4,52 (4,00) | 16,2 s | USD 0,1963 |
| medium | 5 | 6,7 % | 1,7 % | 4,48 (3,50) | 11,1 s | USD 0,1853 |

Lectura de las fallas de train:
- high: `persona-habla-con-socio` (el cliente ofreció su mail y el bot contestó solo "por este mismo chat": la jueza lo vio como pregunta ignorada) y `tono-07` (el bot dijo "eso lo ve el equipo" sobre dónde ver una cancha: marcó off_knowledge, y el escenario espera ninguna derivación).
- medium: el bot usó dos puntos ("dos modelos: …") en los dos intentos de un turno y salió el mensaje seguro; `persona-financiacion` (la jueza vio sin responder la pregunta de sí o no "¿tienen plan de cuotas?"); y el mismo `tono-07`.
- Esfuerzo: high es mejor en calidad pero tiene el p95 en el borde del límite (15 s); medium cumple el p95 pero rompe más el controlador. Se sigue con high y se vigila el p95.
