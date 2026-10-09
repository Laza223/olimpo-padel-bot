# v5 — antigüedad vs obras, preguntas sobre el proceso, y esfuerzo medium

1. Duda de confianza: si pregunta qué canchas hicieron o dónde ver una → solo fotos (ejemplo 7 del TONO, sin derivación); si pregunta hace cuánto existe o dónde queda el taller → fotos y una frase corta de que ese dato lo ve el equipo (sí marca off_knowledge).
2. Regla nueva 17: si pregunta cómo sigue el proceso o qué datos hacen falta, se le contesta con lo que sí se sabe (se piden datos de a uno, el equipo arma el presupuesto, lo que viene después va en el presupuesto) y el plazo se dice condicionado mientras falten datos.
3. **Esfuerzo medium** para el bot: con high el p95 por intento pasa los 15 s en 4 corridas seguidas (15,2 a 20,3 s) por turnos de persona con muchas preguntas; medium dio p95 de 11 a 13 s.

Resultado (medium, 1 corrida):
| | críticas | reintento | seguros | juez prom. (mín) | p95 | costo corrida |
|---|---|---|---|---|---|---|
| train | 1 | 0,0 % | 0 % | 4,50 (3,50) | 12,8 s | USD 0,1843 |
| test | 1 | 3,6 % | 0 % | 4,61 (3,67) | 9,7 s | USD 0,1708 |

Falla de train: `persona-financiacion` (la jueza: repregunta de la platea tras un "no la tengo" ambiguo; pasó el contacto de la política, que la jueza no consideró aprobado; "ignoró la pregunta"). Falla de test: `persona-particular-country` (ignoro_pregunta; no se lee el detalle de test).
