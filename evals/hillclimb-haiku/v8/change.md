# v8 — preguntas que juntan dos cosas, no prometer acciones que el bot no controla

1. Paso 1: si una misma pregunta junta dos cosas (ej. una medida y la platea), se contestan las dos.
2. Regla nueva 18: no prometer acciones que el bot no controla ("le aviso al equipo", "te llamamos", "te lo mandamos por mail", "reviso el envío"); "le paso tu consulta al equipo" solo cuando el chat pasa de verdad al equipo. Fotos que no llegaron: reenviar una vez más; si sigue igual, decir que se dejaron por el chat y seguir. La regla de inyección pasó a ser la 19.

Resultado (solo personas, medium, jueza Opus, 2 corridas):
- corrida 1: 0 críticas, reintento 5,5 %, p95 11,1 s · PASA.
- corrida 2: 2 críticas, reintento 0 %, p95 11,2 s:
  - `persona-particular-country`: el cliente simulado hizo preguntas extra y la ficha se completó en el turno 10 (la espera dice máximo 9). El bot respondió bien cada pedido; el juez no marcó críticos.
  - `persona-pregunta-si-es-bot`: el simulado nunca preguntó "¿sos un bot?" (4 turnos) y la espera exige haber dicho "asistente virtual". Falso positivo de la espera.
- Costo: USD 0,4703 (bot 0,1160 · cliente 0,0121 · juez 0,3421).

Confirmación completa con el prompt v8 (banco entero, 2 corridas, jueza Opus, medium): `evals/out/2026-10-09-1523-claude-haiku-5-5-medium/`
- corrida 1: 3 críticas · reintento 3,4 % · seguros 0 % · juez 4,65 (mín 3,67) · p95 11,3 s · bot USD 0,0018 por conversación · NO PASA
- corrida 2: 3 críticas · reintento 3,5 % · seguros 0 % · juez 4,63 (mín 3,67) · p95 11,4 s · bot USD 0,0017 · NO PASA
- Costo: USD 1,2544 (bot 0,1920 · cliente 0,0143 · juez 1,0482). La jueza no marcó ningún crítico en ninguna corrida: las 6 críticas son esperas del escenario.
- Fallas:
  - `persona-financiacion` c1: el bot escribió "sobre si son cuotas fijas eso no lo puedo confirmar yo" (repite la palabra del cliente; la espera `nunca_dice` la pesca). Falla del bot contra su regla 7.
  - `persona-particular-country` c1: el cliente pidió "las dos opciones" sin nombrar una; el bot no cargó modelo y la ficha quedó incompleta (el cliente se fue). Tensión de política (ver reporte).
  - `persona-cambia-de-idea` c2: el cliente simulado se despidió en el turno 3 con la ficha a medias.
  - `tono-09-casa-country` c2: el bot preguntó "localidad y provincia" en vez de "en qué country" (el caso 9 del TONO); falla del bot.
