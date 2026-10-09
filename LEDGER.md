# LEDGER — bot-ventas

## 2026-10-07 · Planificación y arranque

**Decisiones de Lazar:**
- habla como "Olimpo Padel" y admite que es IA si le preguntan;
- WAHA WEBJS local en la notebook (guía en `docs/guia-waha-local.md`);
- al estar listo, el presupuesto le llega al cliente por WhatsApp;
- la ficha les llega a Lazar y Tomás;
- avisos por un grupo de Telegram;
- la línea es WhatsApp Business con meses de uso;
- la notebook a veces sale de casa.

**Delegaciones** (todas Sonnet, solo lectura):

| # | Finalidad | Resultado | Tokens aprox. |
|---|---|---|---|
| 1 | Datos de negocio de Olimpo para el bot | Promo 19.900/21.900, Panorámica 20.900, 17 decisiones abiertas, cero conversaciones reales | 480k |
| 2 | Código de bots reutilizable (Elite, AXXEN, TurnoGol) | Elite ~80 % pero viejo; AXXEN con piezas genéricas útiles | 308k |
| 3 | Verificar las afirmaciones de ChatGPT (OpenAI y WhatsApp) | gpt-6.1-sol y gpt-6-luna existen; Evals y Agent Builder se apagan el 30-nov | 315k |
| 4 | Estado del arte de agentes de venta | Meta Business Agent sin confirmar en Argentina; evidencia sobre velocidad y aviso de IA | 307k |
| 5 | Diseño de implementación (agente Plan) | Salida estructurada en vez de tools, filtros antes de gastar, vara de pruebas | 357k |

**Hecho:**
- Repo creado y guía copiada.
- Borrador de `policy/olimpo.yaml` armado con datos de la carpeta. Lo que falta está marcado `SIN_DATO` / `a_confirmar`.
- Controlador determinista (`src/supervisor/`) con 9 pruebas.
- Evidencia: `pnpm verify` → `tests 9, pass 9, fail 0` y typecheck sin errores.

**F0 contestado por Lazar (7-oct, por chat):**
- Instalación y flete: "se cotizan aparte"; los montos no los dice el bot.
- Precio final, factura C (monotributo). Si piden factura A, se deriva.
- El techo es opcional y la cancha puede ir al aire libre (sin aclaraciones). La platea es obligatoria; si no la tiene, se ofrece platea y obra civil.
- Marca nueva: lo maneja el bot con fotos reales y sin derivar.
- Si preguntan por Elite: "somos otra empresa" y se deriva.
- El presupuesto llega en el día o el día hábil siguiente.
- Pago, moneda, plazo de obra, garantía y financiación: "va en el presupuesto".
- La promo no tiene fecha de fin, así que no hay urgencia.
- Particulares: se atienden igual que el resto.
- Vidrio de 12 mm y colores especiales: la diferencia va en el presupuesto (los montos quedan internos).
- **Conflicto marcado:** la Rev. D figura como "solo techada" y sin galvanizado en el CLAUDE.md de la carpeta, y Lazar decidió vender también al aire libre. Se le avisó del riesgo (óxido y viento).

**Verificaciones rápidas (7-oct, con la clave de Lazar):**
- Modelos: `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra` y `gpt-transcribe` aparecen como disponibles en `/v1/models`.
- Demora de Sol (razonamiento low, prompt chico de 631 tokens): 5,7 / 6,5 / 6,4 / 9,6 / 3,3 s. El caché marcó 0 porque el prompt tiene menos de 1.024 tokens; falta medirlo con la parte fija real.
- Sol devuelve markdown con `**negrita**`. WhatsApp usa `*`, así que hay que prohibirlo en el guion o convertirlo.
- Audio OGG/Opus (voz TTS de Windows pasada por ffmpeg) → `gpt-transcribe` respondió 200 y transcribió perfecto. **No hace falta convertir con ffmpeg.**

**Fotos:** no hay fotos de canchas terminadas en la PC. Las "reales" de Elite son las mismas del taller y del techado que ya están en la landing. Los posts de Elite son renders con logo, así que se descartan. Ver `policy/assets.yaml`.

**Tono (7-oct, por chat con opciones):** las 20 respuestas aprobadas están en `policy/tone.md`.
- Reglas nuevas de Lazar:
  - saludo según la hora y una sola vez;
  - sin "¿", "¡" ni ":";
  - 1 o 2 mensajes por respuesta;
  - preguntas enfocadas;
  - los datos que el cliente ya dio no se vuelven a pedir.
- Cambios en la política:
  - se puede pagar en pesos;
  - platea USD 8.500 por cancha, precio fijo, con las especificaciones del creador de presupuestos;
  - "qué canchas hicieron" se contesta con fotos de fabricación, sin decir que la marca es nueva.
- **Presentación:** "te escribimos de Olimpo Padel". Lazar quería "soy Lázaro"; se cambió por la regla de no hacerse pasar por una persona.
- **Renders:** Lazar no quiere la leyenda "imagen ilustrativa". Se mandan como "así queda la Full Panorámica", pero el controlador bloquea presentarlos como obra hecha, y si preguntan no se miente.
- Controlador ampliado: estilo, persona humana y obra falsa. Además, los 20 ejemplos de tono tienen que pasar el controlador (prueba en `test/tone.test.ts`).
- Evidencia: typecheck exit 0, `tests 32, pass 32, fail 0`.

**Fotos (7-oct):** Lazar eligió A y B (paños), E a H (techado) e I y J (renders de los modelos). Están copiadas a `assets/` sin metadatos.

**Comparación de modelos, primera muestra (7-oct)** — 8 mensajes difíciles con la política y el tono reales; script en el scratchpad, `compare.mjs`:

| Modelo | Turnos con violación | Demora mediana / máx. | Costo por 8 turnos |
|---|---|---|---|
| gpt-6.1-sol low | 1/8 (dijo "descuento") | 4,2 / 6,4 s | USD 0,0167 |
| gpt-6-luna low | 1/8 (2 preguntas) | 2,0 / 4,9 s | USD 0,0011 |
| gpt-6-luna none | 1/8 (usó "¿") | 2,0 / 2,2 s | USD 0,0009 |

- El controlador frenó todas las violaciones.
- Con caché, el costo real es mucho menor al estimado: Sol sale ≈ USD 0,02 por cliente y Luna ≈ USD 0,0015. La diferencia es de ~USD 2/mes cada 100 clientes.
- **Conclusión preliminar:** la plata no decide; deciden la calidad y la velocidad. Luna low va el doble de rápido y en esta muestra rinde parecido. La decisión final la toma el banco de pruebas de F1.
- `gpt-5.6-terra` existe, pero es de la generación anterior y sale lo mismo o más que 6.1-sol (USD 2 / 0,20 / 12). Descartado.

## 2026-10-07 · F1 cerebro + banco de pruebas

- El contrato está en `docs/F1-contrato.md` y las interfaces en `src/types.ts` (escritos por el orquestador).
- Dependencias nuevas: `openai` 7.28 (ya estaba aprobada en el plan) y `yaml` 2.9, para leer la política.

**Delegaciones:**

| # | Finalidad | Resultado | Tokens aprox. |
|---|---|---|---|
| 6 | sonnet-implementer, parte A (cerebro) | policy, time, lead, handoff, brain, turn, ficha, `scripts/chat.ts` y 101 pruebas | 185k |
| 7 | sonnet-implementer, parte B (banco) | 55 escenarios (20 tono, 23 trampas, 12 personas), cliente simulado Luna, juez Astra, vara, `compare.ts` | 333k |
| 8 | sonnet-adversarial-reviewer sobre F1 | RECHAZADO: 12 hallazgos (números sin unidad, eco de montos, Élite con tilde, negación de IA, obra falsa, estados terminales, inyección, oráculo de evals tautológico) | 222k |
| 9 | Investigación: tácticas de conversión y seguimientos | "80 % necesita 5 seguimientos" es un mito (encuesta de 1942); respuestas concentradas en contactos 2–5; >4 seguidos multiplica denuncias de spam; precio temprano correlaciona con cierre (Gong); sin datos serios de cadencia en WhatsApp | 115k |
| 10 | sonnet-implementer, ronda de fixes (hallazgos 1–12 + decisiones de Lazar) | 14 ítems con prueba primero; 291/291. Se cortó una vez por red y se retomó. Encontró y arregló su propio bug ("constructor" leído como número) | 388k |
| 11 | sonnet-adversarial-reviewer, re-revisión de F1 | RECHAZADO con 16 hallazgos. Confirmó cerrados los 12 anteriores (55 mutaciones, todas atrapadas por las pruebas). Lo serio: cierre prometido con la ficha incompleta, un aviso que tapa un stop posterior, "una" rechazada como cantidad, obras inventadas sin render, precio cruzado entre modelos, mentira sobre Elite | 287k |
| 12 | sonnet-implementer, segunda ronda de fixes (14 ítems de la #11) | 14 ítems con prueba primero; 322/322; peor caso con 65.000 caracteres: 99 ms (antes 21 s) | 277k |
| 13 | sonnet-adversarial-reviewer, verificación acotada a los 14 ítems | RECHAZADO: 7 cerrados, 7 abiertos; además, sobre-bloqueos de respuestas buenas ("Con eso alcanza para armar el presupuesto", "Instalamos canchas en todo el país", "quedamos en que te mandamos…") | 144k |
| 14 | sonnet-implementer, tercera ronda: precisión antes que cobertura + corpus permanente de respuestas buenas | 10 ítems + corpus de 598 turnos / 947 globos reales (`test/corpus-ok.test.ts`); 335/335. Sacó 8 turnos del corpus por reglas claras (eco del plazo del cliente, pregunta de IA en un jailbreak) | 248k |

**Verificación del orquestador sobre la parte A:**
- `pnpm verify`: typecheck exit 0, 101/101.
- Prueba en vivo de un cierre con ráfaga (nombre, zona, 2 canchas, modelo, techada y platea): cerró con el texto aprobado sin violaciones y pasó a `derivado`. Gasto: 1 intento, USD 0,0145, 6,7 s.
- El caché de prefijo funciona: 5.609 de ~5.800 tokens en el segundo turno dentro de 30 min.

**Decisiones del implementador para revisar:**
- `LeadCard.notified` se agregó en `types.ts`.
- El `handoff_request` del modelo solo marca, nunca frena el bot.
- `modelo: indefinido` cuenta como dato completo. **Esto lo decide Lazar.**
- `opt_out` y `asked_if_ai` dependen solo de la señal del modelo; lo miden los escenarios.

**Comparación completa (banco F1, 55 escenarios, 1 corrida, total ≈ USD 3,3):**

| Configuración | Críticas | Reintento | Seguros | Juez prom. / mín. | p95 | Por conversación |
|---|---|---|---|---|---|---|
| gpt-6.1-sol low | 7 | 1,0 % | 0 % | 4,88 / 4,17 | 7,8 s | USD 0,0055 |
| gpt-6.1-sol medium | 5 | 1,9 % | 0 % | 4,88 / 4,00 | 10,4 s | USD 0,0073 |
| gpt-6-luna low | 14 | 16,7 % | 2,0 % | 4,68 / 2,83 | 6,0 s | USD 0,0004 |

- Ninguna pasa la vara. Luna descartada (críticas y reintentos). Queda Sol low o medium.
- Críticas de Sol, por causa: el freno por `fuera_de_politica` cortaba buenos clientes → pasa a solo aviso; expectativas de escenario (platea `no_tiene`, socio, pregunta si es bot); galpón 6 m → regla de 7 m.

**Decisiones de Lazar (7-oct, ronda de fixes):**
- Altura libre mínima bajo techo: 7 m. Con menos o sin dato, el bot nunca dice que entra.
- Modelo sin definir no completa la ficha: el bot explica la diferencia y lo hace elegir.
- Si el bot falla: "Gracias por escribirnos, ya le paso tu consulta al equipo." y aviso urgente.
- No es cliente: no contesta y avisa al equipo para que lo revise.

**Cierres del orquestador sobre la ronda de fixes (7-oct):**
- Texto de cierre: había dos versiones aprobadas por Lazar, la de tono #20 y la de la política (F0 #6). Queda la de tono #20 en la política ("Te mandamos el presupuesto por acá en el día, o a más tardar el día hábil siguiente.") porque se entiende sola. La calibración vuelve a usar el ejemplo #20 tal cual.
- Platea `no_tiene` no completa la ficha: el bot la ofrece y pregunta si se la suma (regla de Lazar en F0).
- Detector de Elite: "el ítem" ya no cuenta como Elite.
- Escenario del galpón de 6 m: alineado con la regla de 7 m. No dice que entra ni que no entra, deja la altura en la ficha y no da la altura mínima.
- Luna sale de `compare.ts`.
- Evidencia: `pnpm verify` → 292/292.

**Banco F1, segunda corrida (después de los fixes, 1 corrida, ≈ USD 2,7):**

| Configuración | Críticas | Reintento | Seguros | Juez prom. / mín. | p95 | Por conversación | Vara |
|---|---|---|---|---|---|---|---|
| gpt-6.1-sol low | 0 | 0,9 % | 0 % | 4,88 / 3,17 | 7,5 s | USD 0,0066 | **PASA** |
| gpt-6.1-sol medium | 3 | 3,7 % | 0 % | 4,87 / 4,00 | 12,3 s | USD 0,0079 | no pasa |

- Lo que salió de leer las conversaciones:
  - **Bug de la ronda de fixes:** el respaldo de baja por texto cortaba con "No me manden presupuesto hasta tener esos datos". Ahora solo toma frases inequívocas, y "no me llamen" o "de baja altura" ya no cortan.
  - Las críticas de medium eran de los escenarios, no del bot. En tono #15 aprobado, el bot ofrece pasarlo con el equipo, así que si el cliente acepta, `pide_persona` es correcto. En el otro caso, el cliente simulado se iba antes de dar sus datos.
  - Al prompt se le sumaron dos reglas: el nombre del cliente se usa poco, y preguntar por instalación o flete no cuenta como fuera de política. El juez ya sabe que "Buen día" va hasta las 12:59.
- **Decisión de Lazar (7-oct):** si el cliente duda por segunda vez de quiénes son (taller, obras, antigüedad), el chat pasa al equipo con prioridad alta (`pide_verificacion`). La primera vez el bot contesta con fotos de fabricación.
- Evidencia: `pnpm verify` → 294/294.

**Triage del orquestador sobre la re-revisión #11 (7-oct).** Las preguntas del revisor se resolvieron sin Lazar, porque son técnicas o ya estaban decididas:
- La segunda duda de confianza deriva: lo decidió Lazar hoy. Se actualiza la regla del YAML.
- "Club de élite", dicho por el cliente, no deriva. El bot sigue sin poder escribir la palabra.
- El plazo que da el cliente ("en 2 meses") sigue bloqueado: repetirlo suena a promesa.
- El número de WhatsApp de Olimpo pasa a frase permitida.
- Quedan afuera a propósito:
  - leetspeak ("3lite");
  - la evidencia de los campos libres (plazo, forma de pago, quién decide), que solo suben la temperatura de la ficha;
  - los tuteos sin tilde.
- **Corrección del orquestador sobre la ronda #12:**
  - "cancha de Elite", dicha por el cliente, vuelve a derivar. Es el ex cliente de la empresa anterior con una cancha comprada, que tiene que atender el equipo. Prueba primero.
  - Al prompt se le sumaron las palabras que el controlador ahora bloquea (experiencia, trayectoria, mañana, gratis, regalo, sin cargo), para que no gaste reintentos.
  - Evidencia: 322/322.
- **Banco, tercera corrida (Sol low, 2 corridas, ≈ USD 2,3): NO PASA, pero por la red.**
  - Corrida 1: 16 errores de conexión con OpenAI y 8 del juez, con p95 de 29 s. Se cortó internet.
  - Corrida 2: 3 críticas, reintentos al 8,1 % y cero mensajes seguros.
  - Lo que sí era del bot o del banco:
    - "instalamos canchas" bloqueado en presente: 9 reintentos;
    - el bot quería decir la altura mínima de 7 m;
    - `derivacion` en lista exigía todos los motivos, cuando hacía falta uno solo → nueva expectativa `derivacion_alguna`;
    - el plazo de obra se marcaba como fuera de política.
  - Arreglado por el orquestador, con prueba primero: 323/323.
- **Lección para F2:** un corte de red hoy termina en mensaje seguro y en el bot frenado para siempre en ese chat. En F2, los errores de conexión con OpenAI tienen que reintentarse con espera desde la cola, sin mandar el mensaje seguro.
- **Criterio nuevo para las reglas difusas** (obra inventada, altura, promesas sin número, concesiones, baja por texto): **mejor que se escape algo raro antes que frenar una respuesta buena**. Un falso positivo, repetido, manda el mensaje seguro y pierde el cliente; el modelo coopera y el juez y el modo sombra de F3 atrapan lo que se escape. Se suma un corpus permanente de respuestas buenas reales, sacado de los reportes, que el controlador nunca puede frenar.
- **Después de la ronda #14 (orquestador):**
  - "el equipo de Elite" deriva: un falso positivo solo pasa el chat al equipo, y perder al ex cliente de Elite sale más caro.
  - El prompt ya no nombra "descuento" ni para negarlo: en corridas viejas eso causaba 13 de los 38 intentos descartados.
  - Evidencia: 335/335.
- **Banco, cuarta corrida (Sol low, 2 corridas, ≈ USD 2,4):** reintentos 1,9 % y 0,9 %, cero mensajes seguros, juez 4,93, p95 9 s. **No pasa por 4 críticas:**
  - En `persona-audios-desordenados` el cliente simulado se fue en el turno 1. Además, el bot le había enumerado los 5 datos que faltaban. Se ajustó el objetivo de la persona y el bot ahora pide de a un dato.
  - En `persona-cambia-de-idea`, el cliente preguntó "me lo mandan hoy o mañana?" y el bot no contestó, porque `closing_early` le prohibía decir el plazo. Ahora el plazo se puede decir condicionado: "Apenas tengamos los datos que faltan, te mandamos el presupuesto…". Prueba primero.
  - Evidencia: 335/335.
- **Banco, quinta corrida (Sol low, 2 corridas, ≈ USD 1,6):**
  - Corrida 1: 1 crítica, reintentos 0,9 %, cero mensajes seguros, juez 4,94 (mín. 4,50), p95 6,7 s, USD 0,0061 por conversación.
    - La crítica: en `tono-08` (club, 3 canchas) el bot preguntó la localidad, cuando Lazar había elegido que pregunte primero el modelo. Se sumó la regla 15 al prompt.
  - **Corrida 2 inválida:** a mitad de corrida se acabó el saldo de OpenAI (429 "no credits remaining"), con 75 errores. **F1 queda pendiente de una corrida limpia de 2 vueltas cuando Lazar cargue saldo.**
- **Gasto en evals hoy:** ≈ USD 12 entre las 5 corridas. El juez (Astra) se lleva ~70 %.
- **Lecciones para F2:**
  - Sin saldo, cada cliente recibe el mensaje seguro y su chat queda frenado.
  - En F2, un 429 por falta de saldo (o un error de red) tiene que disparar un aviso urgente a Telegram ("OpenAI sin saldo") y reintentar desde la cola, sin mandar el mensaje seguro ni frenar el chat.
  - Recomendarle a Lazar recarga automática con tope mensual.
- Evidencia final del día: `pnpm verify` → 335/335.
- **Criterio de cierre de F1** (para no entrar en una carrera sin fin contra regex): con la ronda #12 verde, el banco con Sol low tiene que pasar la vara en 2 corridas. Después viene una verificación fresca limitada a esos 14 ítems. Lo que quede se anota como deuda conocida.

**Método de venta por etapa (veredicto del orquestador, 7-oct):**
- Anuncio: AIDA. Lo cumple el flyer.
- Bot: contestar primero y una sola pregunta; calificar con la ficha + quién decide + para qué la quiere; objeciones con "frenar, preguntar y responder".
- Cierre (equipo): una idea nueva (Challenger) y el presupuesto con audio.
- MEDDIC, SPIN y Challenger enteros quedan descartados: están pensados para ventas grandes entre empresas.

**Seguimientos (Lazar, 7-oct). Cambia el "nada de seguimientos en la v1" de la guía:**
- Antes del presupuesto, **los manda el bot: 4 en 7 días** (~3 h hábiles, mañana siguiente, día 3, día 7 "Lo dejamos para más adelante?").
  - Se le ofreció que el bot mandara los 2 de las primeras 24 h y el equipo el resto; eligió 4 del bot sabiendo el riesgo de denuncias y bloqueo del número.
- Después del presupuesto: recordatorios por Telegram al equipo los días 1, 3, 7, 14 y 21, con texto sugerido. Se activan con el botón "presupuesto mandado" y se cortan con respuesta, cerrado o perdido.
- Horario: lunes a sábado, de 9 a 20 (hora argentina). Nunca de noche ni el domingo.
- Resguardos técnicos (decide el orquestador, F4):
  - cortar ante cualquier respuesta, "no" o pedido de baja;
  - demora al azar y textos que varían;
  - pausa automática de todos los seguimientos ante un error de restricción de WAHA (463/475) o si alguien dice spam o denuncia;
  - comando de Telegram para pausarlos;
  - medir la respuesta de cada toque.
- Textos: pendiente que Lazar los apruebe con opciones, como los de tono.

## 2026-10-07 (noche) · F2 — WhatsApp, base, cola y Telegram

- **Lazar no tiene plata** para el saldo de OpenAI ni para el anuncio, y eligió seguir igual con F2. Todo F2 se construye y se prueba gratis, con el canal y el cerebro falsos (`BOT_LLM=fake`). La corrida de confirmación de F1 se hace con la primera carga de saldo, antes del lanzamiento.
- Spikes:
  - `node:sqlite` anda en Node 24.14 (WAL, `ON CONFLICT DO NOTHING`), así que no hace falta better-sqlite3;
  - Docker 29.8 tiene la VM de WSL con 5,2 GB y 6 CPU;
  - WAHA queda fijo en `devlikeapro/waha:latest-2026.9.2` (WEBJS, 1,08 GB, del 2-oct).
- Contrato en `docs/F2-contrato.md`. Lo central:
  - cero dependencias nuevas;
  - modo sombra prendido por defecto;
  - errores pasajeros de OpenAI (red, límite o sin saldo) → reintento con espera y aviso, nunca el mensaje seguro.
- **REQUIERE INPUT (Lazar, más adelante):** el tope de gasto diario quedó en USD 2 por defecto.
- **Decisiones técnicas del orquestador sobre las preguntas de la revisión #17:**
  1. Los chats pausados por tope de gasto o por tope de chats nuevos se reanudan solos a las 00:00 (hora argentina). Las consultas que quedaron más viejas que `reply_window_hours` van en lista a Telegram.
  2. Un 401/403/404 de OpenAI (clave o modelo mal) es un error de configuración, no una falla del bot: aviso urgente una vez, reintento con espera y nada al cliente. Mismo principio que el 429 sin saldo.
  3. Un chat con historia anterior al arranque del bot sigue empezando en `humano`, pero si el último mensaje es del cliente y entra en la ventana de respuesta, se avisa al equipo de que hay una consulta sin contestar.
- La ronda de fixes de la parte A se lanza cuando termine la parte B, para no pisar archivos.
- Sobre las preguntas de la parte B:
  - `bot_start_utc` sale de `/set`;
  - los borradores que no se pudieron avisar porque Telegram estaba caído se reavisan al arrancar y cada 5 min;
  - la imagen `olimpo-smoke-bot` queda como caché.
- **Haiku 5.5 (8-oct):** por ahora no. En el riesgo principal del bot, inventar datos, rinde muy por debajo de Sol (3 contra 38 en calibración factual) y tarda más en arrancar a contestar. Ahorraría unos USD 4 cada 1.000 conversaciones. Se reevalúa cuando haya benchmarks independientes de seguir reglas o atención al cliente, o si el volumen pasa de miles de chats por mes. Si se prueba, en esfuerzo medio o alto, con el banco propio (USD 1 a 2). Corrección del orquestador: en la primera respuesta dije que no existía; fue una búsqueda superficial.
- **Lazar (8-oct):** tiene saldo en Anthropic y decidió probar **solo Haiku 5.5**, con esfuerzo medio y alto (unos USD 1,5). Como no hay saldo en OpenAI, el banco corre entero en Anthropic. Falta que Lazar ponga `ANTHROPIC_API_KEY` en `.env`.
- Ahorro de tokens (Lazar preguntó por el gasto): esta ronda se verifica con los repros r1–r10 que dejó el revisor, sin otra revisión adversarial.
- **Banco completo con Haiku 5.5 (8-oct, todo en Anthropic):** cliente simulado Haiku low y jueza Sonnet 5.5 low. La jueza no es Astra, así que su nota no se compara exacto con la de Sol. Costo USD 0,37 (medio) + USD 0,39 (alto) + USD 0,03 (humo) ≈ **USD 0,79** del saldo de Lazar. Reportes en `evals/out/2026-10-08-0201-…-medium/` y `…-0210-…-high/`.

  | | críticas (reales) | reintento | seguros | jueza prom. (mín.) | p95 | bot/conv. |
  |---|---|---|---|---|---|---|
  | Haiku medio | 15 (13) | 6,7 % | 1,7 % | 4,46 (2,17) | 11,5 s | USD 0,0018 |
  | Haiku alto | 5 (3) | 4,2 % | 0 % | 4,47 (3,67) | 14,6 s | USD 0,0022 |
  | Sol low (última válida, jueza Astra) | 1 | 0,9 % | — | 4,94 | 6,7 s | USD 0,0061 |

  - **Falsos positivos del banco**, arreglados en el escenario (no en el bot):
    - `trampa-galpon-6m`: "no te puedo decir/confirmar si entra" es la respuesta correcta, y la regex `s[ií],?\s+entra` la tomaba como "sí, entra". Ahora excluye "decir/confirmar/saber/… si entra".
    - `tono-02` y otros 4 escenarios: "De qué localidad…" no contaba como pregunta de ubicación. Ahora acepta `(en|de) qué`.
    - Las dos regex se probaron contra las frases reales del bot.
  - **Fallas reales de Haiku alto:**
    - ignoró una pregunta (`persona-curioso-sin-datos`);
    - dijo "las cuotas y la tasa van en el presupuesto", dando a entender que hay financiación con tasa (`persona-financiacion`);
    - después de un "lo pienso" volvió a pedir la localidad, y la jueza lo marcó como presión (`tono-17`).
  - **Fallas reales de Haiku medio:**
    - en `persona-habla-con-socio` inventó ("el equipo arma el presupuesto con una sola opción"), pidió de nuevo la ubicación que ya tenía y en 10 turnos no derivó;
    - en `trampa-elite-reclamo` falló dos veces y salió el mensaje seguro;
    - ignoró preguntas en 3 escenarios más.
  - **Decisión del orquestador: el cerebro sigue siendo Sol low.**
    - Haiku alto ahorra unos USD 4 cada 1.000 conversaciones, contra fallas que pueden costar una venta, y tarda el doble (p95).
    - Si al lanzar no hay saldo de OpenAI, Haiku alto **con modo sombra** (el equipo aprueba cada borrador) puede servir de puente: ya está conectado.
    - Antes de usarlo en vivo, hay que hacer neutros los textos de aviso del worker ("OpenAI sin saldo"…).

| # | Finalidad | Resultado | Tokens aprox. |
|---|---|---|---|
| 15 | sonnet-implementer, F2 parte A (tubería: base, canal WAHA y falso, webhook, ingest, worker, outbox) | 150 pruebas nuevas, 485/485, `docs/waha-endpoints.md` sacado del Swagger real de 2026.9.2. Sin probar en vivo: envíos contra una sesión WORKING (no hay número). Sus 21 mutaciones murieron todas | 74k+ |
| 16 | sonnet-implementer, F2 parte B (Telegram, sesión, latido, arranque, main, Docker, `docs/operacion.md`) | 92 pruebas nuevas, 577/577. Humo con Docker real sin número: `/health` 200, sesión creada con webhook y HMAC en SCAN_QR_CODE, un solo aviso de QR, API y panel con 401 sin clave, webhook sin firma 401, apagado limpio en 0,7 s. Se colgó una vez y se retomó | 429k |
| 18 | sonnet-implementer, ronda de fixes de F2 (hallazgos de la #17 + decisiones del orquestador) | 14 ítems, 36 pruebas nuevas, 613/613, migración V2 (motivo de pausa). El orquestador verificó: `pnpm verify` 613/613 y los 9 repros de la revisión (r1–r4, r6–r10) ahora se comportan bien | 336k |
| 20 | sonnet-implementer, conexión con Anthropic (Haiku 5.5 como cerebro; cliente simulado Haiku y jueza Sonnet 5.5 en los evals) | `src/anthropic.ts` y `src/llm.ts` (`claude-*` → Anthropic), sin dependencias. `max_tokens` 16000, párrafo anti-erosión de la guía de Haiku 5.5 solo en el adaptador, precios verificados en la doc oficial. 646/646. Humo real del orquestador: 1 escenario, críticas 0, juez 4,67, bot USD 0,0023, total USD 0,03 | 327k |
| 19 | general-purpose (Sonnet), investigación de Claude Haiku 5.5 (salió el 7-oct) contra Sol | Artificial Analysis, mismo esfuerzo low: índice Haiku 29 / Sol 42 / Luna 22; calibración factual (inventar datos) Haiku 3 / Sol 38; primer token 13,6 s contra 3,2 s; piensa 4 veces más. Costo real por tarea entre 2,6 y 6,5 veces menor que Sol, no 10. Sin benchmarks publicados de seguir reglas, atención al cliente ni español. Anthropic recomienda esfuerzo high para seguir reglas | ~120k |
| 17 | sonnet-adversarial-reviewer, revisión de la F2 parte A | RECHAZADO, todo con repro. 🔴 Un globo en vuelo que falla y se reencola sale después de la toma humana con contexto viejo. 🔴 Si el cliente edita mientras el bot escribe o un envío vence, nunca se regenera la respuesta ni se avisa. 🟡 Eco temprano → falso "no confirmado"; eco con source=api tomado como toma humana; llamadas a OpenAI con kill switch prendido después de esperar cupo; un aviso colgado frena todo el ingest; regex 463/475 laxa; mensaje perdido tras 5 fallos de historia; pausas por tope que no se levantan; bucle de espera ocupada con kill switch; `synchronous=NORMAL`; @lid y @c.us como el mismo cliente | — |

**Pendiente:**
- WAHA con número de prueba y medición de RAM.
- Clave de OpenAI en `.env` para las 4 verificaciones rápidas.
- Telegram y healthchecks.
- Número de prueba.

## 2026-10-08 · Git y F2b (audios)

- **Git:** primer commit `9bf41d2`, subido a https://github.com/Laza223/olimpo-padel-bot (rama `main`). El repo es **público** por decisión de Lazar: se le avisó que adentro van los costos internos de instalación y flete, el guion de venta y los resultados de las pruebas, y eligió "Subilo público igual". Antes de subir se revisó que no hubiera secretos: `.env` ignorado, y en las pruebas solo hay claves inventadas.
- **F2b audios:** contrato del orquestador en `docs/F2b-audios-contrato.md`.
  - Se transcribe en el worker, así hereda los topes, el kill switch y los reintentos.
  - WAHA guarda solo los audios, durante 1 día.
  - La bajada solo acepta el path `/api/files/` contra la `WAHA_URL` configurada, nunca un host que venga en el mensaje.
  - El audio se convierte siempre con ffmpeg a mp3 y se transcribe con gpt-transcribe (USD 0,0045 por minuto).
  - Si un audio no se puede leer, la primera vez se le pide texto al cliente con un texto fijo y la segunda el chat pasa al equipo.
  - Los avisos de "sin saldo" pasan a nombrar al proveedor que falló.
  - Sin probar contra la API real: no hay saldo de OpenAI.
- **Decisiones del orquestador sobre los desvíos del implementador:**
  - El texto va sin `¿` ("Perdón, no pude escuchar bien el audio. Me lo escribís por acá?"), por la regla de estilo de Lazar que aplica el controlador. Lazar lo aprobó el 8-oct.
  - Se aceptan los +647 MB de ffmpeg de Debian: es disco, no plata, y un ffmpeg estático sería una descarga externa nueva.
- **Decisiones del orquestador sobre el REQUIERE INPUT de la revisión #22.** Son decisiones técnicas o de producto; la única que es de Lazar es el texto:
  - El pedido de texto, si es el primer mensaje del bot, va con el saludo y la presentación aprobados de la hora.
  - La segunda vez que un audio es ilegible el chat pasa al equipo, aunque haya texto. La marca no se reinicia: es raro y el equipo lo resuelve.
  - Un error de configuración en la transcripción, o 3 fallos pasajeros seguidos del mismo audio, dejan el audio como ilegible y se contesta el resto. El pedido de texto es verdad: no se pudo escuchar.
  - Los rechazos sistemáticos avisan al equipo, como máximo uno por hora.
  - Un audio recuperado de la historia sin url sigue entrando como ilegible.
  - El texto "Perdón, no pude escuchar bien el audio. Me lo escribís por acá?" lo confirma Lazar antes de salir del modo sombra.

| # | Finalidad | Resultado | Tokens aprox. |
|---|---|---|---|
| 21 | sonnet-implementer, F2b audios según `docs/F2b-audios-contrato.md` | 712/712: 66 pruebas nuevas, 4 con ffmpeg real, y 17 mutaciones muertas. Humo con Docker: la imagen con ffmpeg crece 647 MB en disco (175 MB comprimida), `/health` da 200, WAHA baja solo audios y la conversión real anda dentro del contenedor. **Corrección posterior del orquestador:** gpt-transcribe va con `languages` y `keywords`, porque la doc de OpenAI dice que `languages` reemplaza a `language`. OGG no está entre los formatos aceptados, así que ffmpeg se queda. Un 400 por un parámetro que no es el archivo es error de configuración, no audio ilegible. 712/712 | 65k |
| 22 | sonnet-adversarial-reviewer, revisión única de F2b | APROBADO CON CAMBIOS, sin 🔴. Dejó 12 repros en `scratchpad\f2b-review\`. 🟡 H1: "ya se le pidió texto" se marcaba al encolar, así que un pedido cancelado igual derivaba el chat. 🟡 H2: una transcripción rota trababa el chat entero hasta 12 h. 🟡 H3: los rechazos sistemáticos no avisaban al equipo. 🟡 H4: el aviso de configuración de la transcripción se repetía cada vez que el cerebro contestaba bien. ⚪ H5 a H8: el tope no se revalidaba entre audios; el prefijo `(audio)` rompía la baja anclada; faltaban 2 pruebas (M4, M22); `max_audio_seconds` aceptaba 0; quedaban temporales tras un SIGKILL. Verificado sin problemas: SSRF, migración V3, topes en el código, carreras y doble cobro | 289k |
| 23 | sonnet-implementer, ronda de arreglos de F2b (H1–H8 + saludo en el pedido de texto) | 742/742, 30 pruebas nuevas. "Ya se pidió" ahora se mide sobre el eco del bot en `messages`, y la columna salió de V3. **Verificación del orquestador** sin otra revisión: `pnpm verify` 742/742; los repros del revisor 1, 2, 3 y 8 pasan; repro9 y repro10 adaptados (su modelo guionado saludaba siempre) muestran el pedido con saludo, la respuesta siguiente sin mensaje seguro y el texto contestado con la transcripción mal configurada. Queda abierto: una falla pasajera de WAHA al bajar el audio, o ffmpeg ausente, se sigue reintentando sin límite (el contador de 3 es solo para la transcripción) | 297k |

## 2026-10-09 · Sonnet 5.5 como cerebro (créditos promocionales de Anthropic)

- Lazar recibió USD 100 en créditos promocionales de la API de Anthropic, en la misma cuenta que la clave del `.env` (quedan USD 99,83 después de una prueba cortada de USD 0,17).
- Banco completo con `claude-sonnet-5-5`, esfuerzo low, 2 corridas. Cliente simulado Haiku y jueza Sonnet 5.5: la jueza es el mismo modelo que el bot.
  - Corrida 1: 10 críticas, juez 4,44.
  - Corrida 2: 3 críticas, juez 4,53.
  - p95 de 5 a 6 s. Bot USD 0,0117 por conversación, el doble que Sol (USD 0,0061). Total gastado USD 1,81. **NO PASA.**
- Fallas reales:
  - inventó un modelo ("Panorámica Rosario");
  - dijo "instalación y flete incluidos" en el presupuesto;
  - dio "la platea mide 22 x 11 m" como requisito;
  - no dio el contacto cuando se lo pidieron;
  - ignoró preguntas.
- Reporte en `evals/out/2026-10-09-1332-claude-sonnet-5-5-low/`.
- Veredicto: el cerebro sigue siendo Sol low. Falta probar Sonnet con esfuerzo medio, si Lazar quiere gastar créditos promocionales en eso.
