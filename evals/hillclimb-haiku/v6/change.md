# v6 — lista de control, contacto sin pasar el chat, reintento con indicación propia

1. Paso 5 como lista de control con los errores que más repiten (dos puntos, largo de 280, un solo "?", saludo, palabras prohibidas, números, contestar todo).
2. Pedir un contacto, o "con quién puedo hablar" de un tema que la política no cubre, no pasa el chat (se da el contacto o se dice que el equipo lo explica con el presupuesto); `asks_human` solo si pide que lo atienda, llame o contacte una persona.
3. Recomendación de modelo ya explicada: no repetir igual, decir en pocas palabras que depende de la vista más limpia o los postes.
4. `buildInput` (entrada variable) con la familia: tras un intento descartado, la indicación para Claude pide rehacer arreglando exactamente el error (dos puntos: ningún ":"; largo: acortar; preguntas: un solo "?"). La de OpenAI no cambia (prueba en `test/brain-claude.test.ts`).
5. Desde acá las corridas son del banco completo con jueza `claude-opus-5-5` (la de la confirmación final): con Sonnet la jueza marcaba `ignoro_pregunta` por cosas que Opus no marca.

Resultado (banco completo, medium, jueza Opus; antes, v5 con la misma jueza, 3 críticas):
| | críticas | reintento | seguros | juez prom. (mín) | p95 | costo corrida |
|---|---|---|---|---|---|---|
| v5 (referencia) | 3 | 6,7 % | 0 % | 4,65 (3,83) | 9,9 s | USD 0,6444 |
| v6 | 3 | 4,3 % | 0 % | 4,64 (3,50) | 11,7 s | USD 0,6329 |

Fallas de v6, todas de expectativas de persona (la jueza Opus no marcó ningún crítico):
- `persona-audios-desordenados`: el cliente simulado cortó ([FIN]) en el turno 2 con la ficha incompleta; el bot no había tomado "la panorámica creo que se llama" como modelo elegido.
- `persona-financiacion`: el cliente pidió "que me pasen a alguien del equipo" en el turno 4 (derivación correcta, `pide_persona`) y el escenario exige `listo_para_presupuesto`.
Violaciones del controlador: 5 en 115 turnos (2 dos puntos, 1 "mejor precio", 1 closing_early, 1 ai_disclosure).
