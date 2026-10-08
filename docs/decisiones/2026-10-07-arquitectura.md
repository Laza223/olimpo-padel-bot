# Decisión: arquitectura del bot (7-oct-2026)

**Contexto.** El stack default de los proyectos (Next + Postgres + Drizzle) no aplica. Lazar pidió todo local en su notebook, con WAHA no oficial, sin servidor contratado ni plataforma paga. El volumen es de un solo operador (decenas a cientos de consultas por mes).

**Decisión:**
- Un proceso Node 24 + TypeScript sin build.
- SQLite en modo WAL, con la cola en tablas.
- WAHA WEBJS con versión fija, en Docker Compose y red interna.
- OpenAI Responses API con una salida estructurada estricta por turno, en lugar de function calling.
- Telegram por long polling.
- healthchecks.io para el latido.

**Por qué:**
- Con un solo proceso no hace falta Postgres ni Redis.
- Con la salida estructurada, el código decide derivar, descartar o dar de baja, y eso se puede probar.
- Telegram y healthchecks avisan aunque WhatsApp o la notebook se caigan, sin abrir puertos.
- El Agents SDK está en 0.x, y Agent Builder y Evals de OpenAI se apagan el 30-nov-2026.

**Se revisa si:**
- aparece concurrencia real (→ Postgres);
- Chromium no entra en la notebook (→ motor GOWS);
- se bloquea el número o la notebook no da abasto (→ API oficial o una compu fija, a decidir por Lazar).
