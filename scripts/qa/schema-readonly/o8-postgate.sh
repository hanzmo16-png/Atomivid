#!/usr/bin/env bash
# Post-O8 gate verdict (pure, USD 0): o8-postgate.sh LOG RC — LOG is `GATE_ONLY=1 GATE_NEXT=O10 cierre.sh` output, RC its
# exit code. After O8 the next operation is O10 (merge #228). Its 14 database/repository checks must all pass. The 15th,
# "no in-flight work before a merge", belongs to O10: it is only reported here, since a busy podcast is not an O8 failure
# and must never trigger O8's contingency. Nothing else may fail, not even silently (cierre.sh RC / RESULT count).
set -uo pipefail
log=$1; g=$2; ok=1
cola=0; grep -q '^FAIL GATE\[O10\] no in-flight work' "$log" && cola=1
rest=$(grep -v 'no in-flight work before a merge' "$log")
n=$(printf '%s\n' "$rest" | grep -c '^PASS GATE\[O10\]'); t=$(grep -cE '^(PASS|FAIL) GATE\[O10\]' "$log")
{ [ "$g" -eq 0 ] && [ $cola = 0 ]; } || { [ $cola = 1 ] && grep -qx 'RESULT cierre: 1 FAIL' "$log"; } || { ok=0; echo "FAIL postgate: cierre.sh exit $g with failures other than in-flight work"; }
[ "$n" -eq 14 ] && [ "$t" -eq 15 ] || { ok=0; echo "FAIL postgate: GATE[O10] database/repository checks $n/14 (lines $t/15)"; }
! printf '%s\n' "$rest" | grep -q '^FAIL' || { ok=0; echo "FAIL postgate: $(printf '%s\n' "$rest" | grep '^FAIL' | head -3 | tr '\n' ';')"; }
grep -qx 'RESULT gate_test: 0 FAIL' "$log" || { ok=0; echo "FAIL postgate: gate_test not 0 FAIL"; }
[ $cola = 1 ] && echo "INFO hay trabajo en curso: O10 deberá esperar a que termine (no afecta a O8)"
[ $ok = 1 ] && echo "RESULT postgate: 0 FAIL" || echo "RESULT postgate: FAIL"
[ $ok = 1 ]
