# v3 — confianza, material y orden de las preguntas

1. Duda de confianza (1.ª vez): ya no se agrega "lo ve el equipo"; solo reconocer lo que quiere ver y mandar el material de fabricación.
2. Material: hay dos tipos (fotos de fabricación y renders). Si piden fotos sin más, fabricación y render de la Full Panorámica (ejemplo 16 del TONO). Si preguntan por "esa cancha", aclarar qué es cada cosa según las frases anteriores ("cómo fabricamos" = fabricación, "así queda" = render).
3. Orden por defecto de las preguntas: localidad y provincia juntas, cantidad de canchas, platea, modelo, techada o aire libre y nombre.

Resultado (train, high): críticas 9 (4 conversaciones) · reintento 1,6 % · seguros 0 % · juez 4,44 (2,67) · p95 20,3 s · USD 0,2140. **Peor que v2.**
Lo que se vio al leer train:
- `tono-07` siguió marcando off_knowledge ("No tengo ubicaciones de obras para pasarte, eso lo ve el equipo"): el paso general "contestá todo; lo que no está, lo ve el equipo" le ganaba a la regla puntual.
- `persona-habla-con-socio`: el cliente dijo "pasame el presupuesto con la Panorámica" (eso es elegir el modelo) y el bot siguió preguntando el modelo 5 veces.
- `persona-audios-desordenados`: tras un "gracias" el bot no pidió ningún dato (la regla "no pidas datos si el cliente cierra" tenía "gracias" en la lista) y el cliente se fue con la ficha incompleta.
- `persona-inversor-galpon`: la jueza marca `ignoro_pregunta` porque el bot no dijo la altura mínima de 7 m; el prompt y el controlador prohíben decirla (ver "falsos positivos" del reporte).
- El p95 subió por conversaciones de persona largas (10 turnos).
