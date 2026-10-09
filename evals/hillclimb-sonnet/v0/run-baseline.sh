#!/bin/sh
# Línea de base F3: variante Claude actual (la de Haiku), Sonnet 5.5 medium, jueza Opus. Banco completo x2 + train x1.
cd "$(dirname "$0")/../../.."
node evals/hillclimb-haiku/run.ts --model claude-sonnet-5-5 --effort medium --eval-provider anthropic --judge-model claude-opus-5-5 --runs 2 > evals/hillclimb-sonnet/v0/run-full2.log 2>&1
node evals/hillclimb-haiku/run.ts --model claude-sonnet-5-5 --effort medium --eval-provider anthropic --judge-model claude-opus-5-5 --runs 1 --only "$(node evals/hillclimb-haiku/ids.ts train)" > evals/hillclimb-sonnet/v0/run-train1.log 2>&1
tail -4 evals/hillclimb-sonnet/v0/run-full2.log; tail -4 evals/hillclimb-sonnet/v0/run-train1.log
