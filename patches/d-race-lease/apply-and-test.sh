#!/bin/bash
# Aplica ledger-lease.patch en un worktree TEMPORAL (la rama no se toca), corre su test PG y el test D-RACE existente.
# Uso: HARNESS_PG_URL=... patches/d-race-lease/apply-and-test.sh   (exit ≠ 0 si algo falla)
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); WT=$(mktemp -d)/drace
git -C "$ROOT" worktree add -q --detach "$WT" HEAD
trap 'git -C "$ROOT" worktree remove --force "$WT"' EXIT
ln -s "$ROOT/node_modules" "$WT/node_modules"
git -C "$WT" apply "$ROOT/patches/d-race-lease/ledger-lease.patch"
cd "$WT"
node --import tsx --test patches/d-race-lease/ledger-lease.pg.test.ts
node --import tsx --test src/lib/paid-calls/*.test.ts src/lib/production-intelligence/*.test.ts
