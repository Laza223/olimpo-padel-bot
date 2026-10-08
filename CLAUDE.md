# bot-ventas — CLAUDE.md

Bot vendedor de WhatsApp de Olimpo Padel. Atiende a quien escribe, califica y deja al cliente listo para que Lazar o Tomás le manden el presupuesto. Plan aprobado: `C:\Users\Lazar\.claude\plans\act-a-como-un-consultor-vivid-bachman.md`. Alcance técnico de Lazar: `docs/guia-waha-local.md` (manda sobre el plan donde contradiga).

**Precedencia:** el `CLAUDE.md` de `OLIMPO PADEL\` (carpeta padre) manda en todo lo de negocio. Lazar no es ingeniero: decide negocio y costo.

## Stack (decidido 7-oct-2026, ver `docs/decisiones/`)

Node 24 + TypeScript (se corre directo, sin build) · WAHA motor WEBJS con versión fija, en Docker Compose en la notebook de Lazar · SQLite WAL · OpenAI Responses API (`gpt-6.1-sol` conversa; `gpt-6-luna` auxiliares; `gpt-6-astra` solo juez offline) con una salida estructurada por turno · Telegram (long polling) para fichas y control · healthchecks.io para el latido.

## Reglas duras

- **El bot solo afirma lo que está `aprobado` en `policy/olimpo.yaml`.** Nunca inventar un número, plazo, garantía u obra. Lo `a_confirmar` / `SIN_DATO` lo decide Lazar.
- **Toda regla de seguridad comercial vive en código** (`src/supervisor/`), no solo en el prompt. El mismo controlador corre en vivo y en `evals/`.
- **La derivación la decide el código** a partir del estado de la ficha y las señales; el modelo solo propone.
- Habla como "Olimpo Padel", sin nombre de persona; si le preguntan si es un bot, lo confirma. Negarlo está bloqueado.
- Solo responde a quien escribe primero. Nada de envíos en frío, difusiones ni seguimientos en la v1.
- Desarrollo con número de prueba; la línea de Olimpo solo en F3.
- Secretos solo en `.env` (nunca en git, logs ni prompt). Claude no crea cuentas ni maneja claves: las pone Lazar.
- Hora: guardar en UTC, aplicar políticas en `America/Argentina/Buenos_Aires`.
- Cada delegación a subagentes (Sonnet, máx. 6) se anota en `LEDGER.md`.

## Comandos

```bash
pnpm verify      # juez: typecheck + tests. Tiene que dar verde antes de cerrar cualquier cambio.
pnpm test
```
