#!/usr/bin/env bash
# Regression for o8-postgate.sh (offline, USD 0) on real gate.py output for stage O10: clean and busy-podcast pass;
# busy + any other failure, a silent cierre.sh failure, a missing check or gate_test red all fail.
set -uo pipefail
D=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; bad=0
mk(){ python3 -I - "$D" "$1" <<'PY'
import sys, copy, types
d, case = sys.argv[1], sys.argv[2]; sys.path.insert(0, d); import gate
src = open(d + "/gate_test.py").read(); ns = {"__file__": d + "/gate_test.py"}; exec(src[:src.index("fails = 0")], ns)
f = copy.deepcopy(ns["state"]("O10"))
if case.startswith("busy"): f["inflight"]["busy"] = 1
if case == "busy_other": f["markers"]["140000"] = False
lines = gate.evaluate(f); n = sum(x.startswith("FAIL") for x in lines)
if case == "missing": lines = lines[:-2] + lines[-1:]
if case == "silent": n += 1
print("\n".join(lines)); print("RESULT gate_test: " + ("1" if case == "gtred" else "0") + " FAIL"); print(f"RESULT cierre: {n} FAIL")
sys.exit(1 if n else 0)
PY
}
for c in clean:0 busy:0 busy_other:1 silent:1 missing:1 gtred:1; do name=${c%:*}; want=${c#*:}
  g=0; mk "$name" > "$W/$name.log" || g=$?; rc=0; bash "$D/o8-postgate.sh" "$W/$name.log" "$g" > "$W/$name.out" || rc=$?
  [ $(( rc != 0 )) = "$want" ] && echo "PASS postgate $name: exit $rc" || { echo "FAIL postgate $name: exit $rc (want $([ "$want" = 1 ] && echo non-zero || echo 0))"; cat "$W/$name.out"; bad=$((bad+1)); }
done
echo "RESULT o8-postgate_test: $bad FAIL"; [ $bad = 0 ]
