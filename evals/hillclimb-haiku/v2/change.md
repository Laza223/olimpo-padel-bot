# v2 — cuatro arreglos de clases de falla vistas en train (v1)

1. Dos puntos: regla explícita con el reemplazo ("tenemos dos modelos, la Full Panorámica y la Panorámica") y "buscá cada ':' del borrador". Era la causa del reintento y del mensaje seguro de medium.
2. Mail y otras vías: "si pide u ofrece otra vía (mail, llamada, dejar su mail), contestale en una frase: por ahora le llega por este chat y, si prefiere otra vía, lo ve el equipo".
3. Preguntas de sí o no que la política no responde ("¿hay plan de pago?"): "no lo podés confirmar vos y lo ve el equipo". Si insiste, reconocer que ya lo preguntó y contestar con otras palabras.
4. Duda de confianza (1.ª vez): no marcar off_knowledge y sumar que el detalle lo ve el equipo (intento que después se descartó, ver v3).
5. Cantidad dicha con palabras ("quiero poner una", "serían dos") cuenta como dicha: no se repregunta.

Resultado (train, high): críticas 3 · reintento 1,7 % · seguros 0 % · juez 4,52 (3,33) · p95 15,2 s · USD 0,1949.
Fallas: `persona-financiacion` (el cliente terminó pidiendo que lo llame una persona y nunca se le preguntó el nombre: derivación `pide_persona` en vez de `listo_para_presupuesto`), `tono-07` (de nuevo "no lo puedo confirmar, eso lo ve el equipo": marca off_knowledge) y `trampa-render-donde-esta` (el bot mandó solo fotos de fabricación y después dijo que "esa cancha" era una imagen del modelo: la jueza lo vio como mentira porque eran fotos reales).
