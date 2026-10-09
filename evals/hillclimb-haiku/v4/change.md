# v4 — precedencia de las reglas puntuales, modelo nombrado = elegido, "gracias" no es postergar

1. En el paso 2: "las reglas de <contenido> para un tema puntual mandan sobre estos pasos generales" (el paso general "contestá todo; lo que no está, lo ve el equipo" le ganaba a la regla de confianza).
2. Duda de confianza (1.ª vez): la respuesta es el material de fabricación con la frase aprobada y una frase que reconozca lo que quiere ver; nada de "no tengo ubicaciones" ni "lo ve el equipo" (insinúa que hay obras para mostrar).
3. Nombrar un modelo para el presupuesto ("con la Panorámica") es elegirlo: se carga y no se repregunta. Si pide los dos para comparar, se carga el que nombró primero y se anota en team_note que quiere los dos. **Decisión de proceso a confirmar por el dueño** (ver reporte).
4. "gracias" o "dale" que siguen la charla no son postergar: se sigue con el próximo dato. Postergar es "lo pienso", "lo hablo con mi socio", "después veo", "te aviso".

Resultado (train, high): críticas 2 · reintento 3,4 % · seguros 0 % · juez 4,49 (3,50) · p95 18,4 s · USD 0,1994.
Fallas: `persona-desconfiado` (la jueza vio sin responder "cuánto hace que existen" porque el bot mandó solo las fotos, como pide el punto 2) y `persona-habla-con-socio` (el cliente preguntó "qué datos necesitan de mi parte" y el bot no lo contestó).
El p95 pasó los 15 s en 8 de 59 intentos, todos de persona con muchas preguntas: con high no hay forma de cumplir el límite de 15 s (necesita ≤ 5 % de los intentos arriba).
