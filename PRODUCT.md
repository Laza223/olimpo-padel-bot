# Product

<!-- impeccable:product-schema 1 -->

<!-- 10-oct-2026: armado desde el pedido del CRM de Lazar (docs/PROMPT-CRM.md), sus respuestas del mismo día y el PRODUCT.md de la landing. Lo que dice SIN DATO no se inventa. -->

## Platform

web

## Stack

Ya definido por el código: lo sirve el mismo proceso Node 24 + TypeScript del bot (`src/crm/`), HTML armado en el servidor y un JS chico sin framework. Sin dependencias nuevas, sin build, sin internet (la fuente se sirve desde el bot). Solo en `127.0.0.1`.

## Users

**Lazar**, socio de Olimpo Padel (fabrica e instala canchas de pádel). No es ingeniero. Lo usa en su notebook, varias veces por día, entre otras tareas: abre la pantalla, ve qué cliente le toca, actúa y se va. Llegan muchos clientes juntos por las promos (30 a la vez para presupuestar). **Tomás**, el otro socio, no usa el CRM: sigue por el grupo de Telegram, que ve lo mismo porque es la misma base.

## Product Purpose

Que ningún cliente que trajo el bot de WhatsApp quede colgado. El bot califica a quien escribe, completa la ficha y se lo pasa al equipo; el CRM ordena lo que queda para el equipo y contesta de un vistazo la pregunta de todos los días: **"¿qué tengo que hacer ahora y quién está esperando hace más tiempo?"**. También reemplaza a Telegram como panel: tomar un chat, devolverlo al bot, marcar el presupuesto mandado, aprobar o descartar los borradores del bot, apagarlo, modo sombra. Éxito: ningún cliente espera más de lo prometido ("el presupuesto en el día, o a más tardar el día hábil siguiente") sin que Lazar lo vea.

## Positioning

No es un CRM de ventas genérico: está pegado al bot. Sabe lo que el bot habló, por qué lo derivó, qué le prometió al cliente y cuándo vence la promesa, y actúa sobre el bot con las mismas reglas que Telegram (cola de salida, versiones, auditoría). Lo simple que resuelve lo importante: una sola lista ordenada por espera, no un tablero lleno de funciones.

## Operating Context

- Embudo: el bot califica → deriva ("A presupuestar") → Lazar arma y manda el presupuesto ("Presupuestados") → el cliente contesta y lo trabajan ("Seguimiento") → "Cliente" o "Perdido". "Descartado" = no era cliente o pidió la baja. "Con el bot" = todavía calificando. Nombres de Lazar (10-oct).
- Día hábil para la promesa: lunes a sábado. Feriados: SIN DATO.
- Modo sombra: el bot arma la respuesta y espera un [Mandar] humano antes de escribirle al cliente.
- Hoy Lazar contesta a los clientes desde el celular o WhatsApp Web. Mandar mensajes o el PDF desde el CRM llega más adelante.
- El presupuesto (más adelante): PDF en USD con renglones separados (cancha, platea, instalación, flete). Precio de venta e instalación: ver `policy/olimpo.yaml`; lo no aprobado es SIN DATO.

## Capabilities and Constraints

- Solo local (`127.0.0.1`), con clave en `.env`. Sin nube, sin cuentas, sin dependencias pagas.
- Una sola fuente de verdad: la base del bot. Nada de escrituras que salteen las reglas del bot.
- Pantalla en criollo: nunca códigos internos (`listo_para_presupuesto` → "a presupuestar"). Nunca un número inventado (precio, plazo, medida): sin dato, "SIN DATO".
- Telegram sigue igual; desde el CRM solo avisa al grupo cuando se apaga/prende el bot o la sombra.
- Seguimiento automático (que el bot le escriba al cliente después del presupuesto): todavía no; es una decisión aparte por el riesgo de bloqueo de WhatsApp.

## Brand Commitments

- Marca Olimpo Padel: navy `#0b2132`, celeste `#4095b6`, familia única Archivo (`../landing/DESIGN.md`, `../branding/`). Logo fijo.
- Voz: español rioplatense, directo, de socio que trabaja; sin exageraciones.
- Nunca mencionar a Elite Padel.

## Evidence on Hand

- Datos reales: las conversaciones, fichas y auditoría de `data/bot.sqlite` (privados: nunca en git, capturas ni ejemplos).
- Para diseñar y probar: clientes inventados en `pnpm crm:demo`, marcados como de ejemplo.
- Logos y fuente: `../landing/public/media/logo-white.png`, `../landing/public/fonts/archivo-var.woff2`.

## Product Principles

1. **Primero quien espera:** el orden lo da la espera del cliente, no la fecha de alta ni la etapa.
2. **Una acción por fila:** cada cliente muestra lo que hay que hacer con él, ahí mismo.
3. **Mismas reglas que Telegram:** cualquier botón del CRM hace exactamente lo que haría en Telegram.
4. **Nada inventado:** lo que no está aprobado o no se sabe, se dice que falta.

## Accessibility & Inclusion

Uso en notebook (principal) y celular (secundario). Contraste AA. Se entiende sin leer manual: etiquetas en palabras, no íconos solos.
