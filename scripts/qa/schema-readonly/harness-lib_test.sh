#!/usr/bin/env bash
# Regression for harness-lib.sh (USD 0, no database): a harness that hits a missing or failing check can NEVER end with
# "0 FAIL" or exit 0, and expect_reject demands the real exit code, the exact FAIL count and a matching RESULT line.
set -uo pipefail
LIB="$(cd "$(dirname "$0")" && pwd)/harness-lib.sh"; W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
n=0; bad=0; ok(){ n=$((n+1)); echo "PASS $*"; }; ko(){ n=$((n+1)); bad=$((bad+1)); echo "FAIL $*"; }
# run_case NAME WANT(ok|fail) EXPECTED_GREP BODY: BODY runs inside a harness that sourced the library.
run_case(){ local name=$1 want=$2 grepx=$3 body=$4 d="$W/$1"; mkdir -p "$d"
  printf 'T=%q; H_NAME=t; . %q\n%s\nh_finish\n' "$d" "$LIB" "$body" > "$d/h.sh"
  local rc=0; bash "$d/h.sh" > "$d/out" 2>&1 || rc=$?; local last; last=$(grep '^RESULT t:' "$d/out" | tail -n 1)
  if [ "$want" = ok ]; then
    [ $rc = 0 ] && [ "$last" = "RESULT t: 0 FAIL" ] && { [ -z "$grepx" ] || grep -qE -- "$grepx" "$d/out"; } && ok "$name: exit 0, RESULT 0 FAIL" || { ko "$name: rc=$rc [$last]"; cat "$d/out"; }
  else
    [ $rc != 0 ] && [ -n "$last" ] && [ "$last" != "RESULT t: 0 FAIL" ] && grep -qE -- "$grepx" "$d/out" && ok "$name: exit $rc, [$last]" || { ko "$name: rc=$rc [$last] (must be non-zero, not 0 FAIL, and match /$grepx/)"; cat "$d/out"; }
  fi; }
# helpers used by the bodies: a fake verifier that prints what o2.sh/o3.sh print
F='fake(){ local rc=$1 res=$2; shift 2; for l in "$@"; do echo "$l"; done; echo "RESULT fake: $res FAIL"; return "$rc"; }'

run_case clean ok 'PASS harness: no shell error' 'pass "nothing"'
run_case missing_command fail 'harness error: exit 127' 'access "after O3"; pass "later check"'
run_case missing_in_subshell fail 'shell errors on its own stderr' 'x=$(not_a_command_xyz 2>&1 >/dev/null; true); y=$(not_a_command_xyz); pass "x"'
run_case missing_in_chain fail 'harness error|shell errors' 'access "x" && pass "ok"'
run_case failed_check fail '^FAIL boom' 'fail "boom"'
run_case unbound fail 'RESULT t: ABORTED' 'echo "$NOT_DEFINED_VAR"; pass "x"'
run_case early_exit fail 'RESULT t: ABORTED' 'pass "a"; exit 0'
run_case bad_test fail 'shell errors on its own stderr' '[ "a" -gt 1 ] 2>&1; [ "a" -gt 1 ]; pass x'
run_case reject_exact ok 'PASS r: exit 1, rejected for exactly the expected 1' "$F"'
expect_reject r 1 1 "$T/o" "why A" -- fake 1 1 "FAIL O3[x] why A = 1 (expected 2)"'
run_case reject_exit0_with_fail fail 'FAIL r: exit 0 \(want 1\)' "$F"'
expect_reject r 1 1 "$T/o" "why A" -- fake 0 1 "FAIL O3[x] why A"'
run_case reject_wrong_rc fail 'FAIL r: exit 2 \(want 1\)' "$F"'
expect_reject r 1 1 "$T/o" "why A" -- fake 2 1 "FAIL O3[x] why A"'
run_case reject_extra_fail fail 'FAIL lines 2 \(want 1\)' "$F"'
expect_reject r 1 1 "$T/o" "why A" -- fake 1 2 "FAIL O3[x] why A" "FAIL O3[x] other"'
run_case reject_result_mismatch fail 'result \[RESULT fake: 0 FAIL\]' "$F"'
expect_reject r 1 1 "$T/o" "why A" -- fake 1 0 "FAIL O3[x] why A"'
run_case reject_no_result fail 'result \[none\]' 'nr(){ echo "FAIL O3[x] why A"; return 1; }
expect_reject r 1 1 "$T/o" "why A" -- nr'
run_case reject_missing_reason fail 'missing: \[why B\]' "$F"'
expect_reject r 1 1 "$T/o" "why B" -- fake 1 1 "FAIL O3[x] why A"'
run_case reject_want_zero fail 'want 0' "$F"'
expect_reject r 0 0 "$T/o" -- fake 0 0'
run_case reject_nonexistent_cmd fail 'exit 127 \(want 1\)' 'expect_reject r 1 1 "$T/o" "x" -- definitely_not_a_command_q'
run_case reject_no_separator fail 'without .-- CMD.' 'expect_reject r 1 1 "$T/o" "x"'
run_case ok_positive ok 'PASS p \(1 checks\)' "$F"'
expect_ok p "$T/o" -- fake 0 0 "PASS O3[x] fine"'
run_case ok_exit0_with_fail fail 'FAIL p: exit 0, FAIL lines 1' "$F"'
expect_ok p "$T/o" -- fake 0 0 "FAIL O3[x] hidden"'
run_case ok_nonzero fail 'FAIL p: exit 1' "$F"'
expect_ok p "$T/o" -- fake 1 0 "PASS O3[x] fine"'
# reproduction of the audited defect (run 40435901599, job 121964376806): the OLD framework, with a missing `access`,
# printed "command not found" and still ended "0 FAIL" with exit 0. The same body under the library fails.
old="$W/old.sh"; printf '%s\n' 'set -uo pipefail; fails=0; pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; fails=$((fails+1)); }' 'access "access after O3"' 'pass "x"' 'echo "RESULT old: $fails FAIL"; [ $fails = 0 ]' > "$old"
rc=0; bash "$old" > "$W/old.out" 2>&1 || rc=$?
grep -q 'command not found' "$W/old.out" && grep -q 'RESULT old: 0 FAIL' "$W/old.out" && [ $rc = 0 ] && ok "repro: the old framework hides the missing command (0 FAIL, exit 0) — the audited defect" || ko "repro did not reproduce (rc=$rc)"
# the rehearsal harnesses must use the library (no private pass/fail/rejects, finish through h_finish)
D=$(dirname "$LIB")
for h in o3-replica.sh o2-mutantes.sh o8-replica.sh; do
  f="$D/$h"; grep -q 'harness-lib.sh"' "$f" && grep -q '^h_finish$' "$f" && ! grep -qE '^(rejects|pass|fail)\(\)|; fail\(\)|^fails=0' "$f" && ! grep -qE '(^|[;&|] *)rejects ' "$f" && ! grep -q "trap .* EXIT" "$f" \
    && ok "$h sources harness-lib.sh, ends with h_finish, no private rejects/pass/fail or EXIT trap" || ko "$h does not use the harness library correctly"
  bash -n "$f" && ok "$h: bash -n" || ko "$h: syntax"
done
# every function the rehearsal calls at the start of a line is defined somewhere it can reach (catches `access` again)
for h in o3-replica.sh o8-replica.sh; do f="$D/$h"; miss=""
  # command words at line start, outside here-documents, excluding assignments (x=…)
  for w in $(awk '/<<\x27?(SQL|EOF)\x27?([^A-Za-z]|$)/{h=1;next} h&&/^(SQL|EOF)$/{h=0;next} !h' "$f" | grep -oE '^[a-z_][a-z0-9_]*([ ;(]|$)' | grep -oE '^[a-z_][a-z0-9_]*' | sort -u); do
    case $w in if|then|else|fi|for|do|done|while|case|esac|echo|printf|set|export|unset|local|trap|exit|return|bash|cat|grep|sed|head|tail|cmp|diff|sleep|kill|wait|mkdir|rm|cut|wc|mv|cp|node|npx|python3|true|false|shift) continue;; esac
    grep -qE "(^|[ ;])$w\(\)" "$f" "$LIB" || command -v "$w" >/dev/null 2>&1 || miss="$miss $w"; done
  [ -z "$miss" ] && ok "$h: every command at line start is a defined function or an installed command" || ko "$h: undefined at line start:$miss"
done
echo "RESULT harness-lib_test: $bad FAIL ($n cases)"
[ $bad = 0 ]
