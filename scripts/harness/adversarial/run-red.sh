#!/usr/bin/env bash
# Control RED por mutación: ejecuta la MISMA suite con una versión mutada de ledger.ts en un worktree temporal.
#   MUT=baseline   → ledger.ts de a8a3955 (antes de la corrección D-RACE)
#   MUT=lease-repay → el perdedor/marcador devuelve la fila a RESERVED tras el tiempo (arrendamiento que autoriza repagar)
#   MUT=no-cas-check → la liquidación ignora el resultado del CAS
# Sale 0 sólo si la suite FALLA (el control detecta la regresión).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
MUT=${MUT:-baseline}
WT=$(mktemp -d)/wt
git -C "$ROOT" worktree add -q --detach "$WT" HEAD
trap 'git -C "$ROOT" worktree remove --force "$WT"' EXIT
cp -r "$ROOT/scripts/harness/adversarial" "$WT/scripts/harness/" ; ln -s "$ROOT/node_modules" "$WT/node_modules"
L="$WT/src/lib/production-intelligence/ledger.ts"
case "$MUT" in
  baseline) git -C "$ROOT" show a8a3955:src/lib/production-intelligence/ledger.ts > "$L.base"
            # conserva los exports nuevos que la suite importa, pero con el comportamiento antiguo del motor
            python3 - "$L" "$L.base" <<'PY'
import sys,re
new=open(sys.argv[1]).read(); base=open(sys.argv[2]).read()
start=new.index("export async function executePaidOperation"); end=new.index("/**\n * Explicit, auditable flag")
bs=base.index("export async function executePaidOperation")
open(sys.argv[1],"w").write(new[:start]+base[bs:]+"\n"+new[end:])
PY
            ;;
  lease-repay) python3 - "$L" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
s=s.replace('return store.update(key, "SUBMITTED", { status: "RECONCILIATION_REQUIRED", updatedAt: opts.now() });','return store.update(key, "SUBMITTED", { status: "RESERVED", updatedAt: opts.now() });')
s=s.replace('throw new SubmissionInFlightError(`${key}: a submission is in flight','if (Date.parse(now()) - Date.parse(cur.updatedAt) > 0) { await store.update(key, "SUBMITTED", { status: "RECONCILIATION_REQUIRED", updatedAt: now() }); }\n    throw new SubmissionInFlightError(`${key}: a submission is in flight')
open(p,"w").write(s)
PY
            ;;
  no-cas-check) python3 - "$L" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
s=s.replace('if (!await store.update(key, "SUBMITTED", recorded)) {','if (!await store.update(key, "SUBMITTED", recorded) && false) {')
open(p,"w").write(s)
PY
            ;;
esac
git -C "$WT" diff --stat
E2E_HOME=${E2E_HOME:-$ROOT/.e2e-local} "$WT/scripts/harness/adversarial/run.sh"
rc=$?
if [ $rc -ne 0 ]; then echo "RED OK ($MUT): la suite detectó la mutación (exit $rc)"; exit 0; else echo "RED FALLIDO ($MUT): la mutación pasó la suite"; exit 1; fi
