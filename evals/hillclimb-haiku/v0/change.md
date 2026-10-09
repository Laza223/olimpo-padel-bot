# v0 — baseline (sin cambios)

- Código: el del último commit más lo agregado para este trabajo (golden, split, `--judge-model`); el prompt que recibe Haiku es el de OpenAI, sin adaptar (la variante de Claude todavía no estaba conectada).
- Corrida: `node evals/run.ts -- --model claude-haiku-5-5 --effort high --eval-provider anthropic --runs 1 --concurrency 3`, banco completo (55), jueza Sonnet 5.5 low, cliente Haiku low.
- Reporte: `evals/out/2026-10-09-1412-claude-haiku-5-5-high/`.
- Política: hash 66f391ab… (la de hoy; los reportes viejos de Haiku son de la 2f587123…, con escenarios que después se corrigieron).

| | críticas | conversaciones con falla | reintento | seguros | juez prom. (mín) | p95 | bot/conv. | costo corrida |
|---|---|---|---|---|---|---|---|---|
| train (28) | 3 | 3 | | | 4,48 (3,50) | | | |
| test (27) | 5 | 2 | | | 4,46 (3,33) | | | |
| total (55) | 8 | 5 | 3,6 % | 0,9 % | 4,47 (3,33) | **16,2 s (no pasa)** | USD 0,0022 | USD 0,4084 |

Además de las críticas, el baseline no pasa el p95 (límite 15 s) y tiene 1 mensaje seguro (0,9 %, justo en el límite del 1 %).
