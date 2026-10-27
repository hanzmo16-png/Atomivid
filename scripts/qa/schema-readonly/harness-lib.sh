# Shared discipline for the O2/O3 rehearsal harnesses (sourced, never run). Any unexpected harness error ends in a
# non-zero exit and a failed RESULT, never in "0 FAIL":
#   - a missing command / non-executable (exit 126/127) anywhere in the script counts as a FAIL (ERR trap, also in
#     functions: errtrace);
#   - every shell error the harness prints on its own stderr (command not found, unbound variable, syntax error, bad
#     test operand…) counts as a FAIL at the end, including those raised inside $(…) subshells;
#   - leaving the script before h_finish (set -u abort, early exit, signal) prints "RESULT <name>: ABORTED", exit ≠ 0.
# expect_reject runs the command itself and requires its REAL exit code, the exact number of FAIL lines, a matching
# "RESULT …: N FAIL" line and every expected reason; a command that exits 0 but prints FAIL is rejected.
# Usage: T=<tmp dir>; H_NAME=<name>; [H_CLEANUP='<shell code run on exit>']; . harness-lib.sh; …; h_finish
set -uo pipefail
set -E
: "${T:?harness-lib: T (temp dir) must be set}" "${H_NAME:?harness-lib: H_NAME must be set}"
fails=0; H_DONE=0; H_ERR="$T/harness-$H_NAME.stderr"; : > "$H_ERR"
pass(){ echo "PASS $*"; }
fail(){ echo "FAIL $*"; fails=$((fails+1)); }
exec 3>&2 2> >(tee -a "$H_ERR" >&3); H_TEE=$!
h_err(){ case $1 in 126|127) fail "harness error: exit $1 at line $2: $3";; esac; }
trap 'h_err $? $LINENO "$BASH_COMMAND"' ERR
h_exit(){ local rc=$?; trap - ERR; eval "${H_CLEANUP:-:}"
  if [ "$H_DONE" != 1 ]; then echo "FAIL harness aborted before h_finish (exit $rc)"; echo "RESULT $H_NAME: ABORTED"; [ "$rc" = 0 ] && rc=1; exit "$rc"; fi; }
trap h_exit EXIT

# expect_reject LABEL N WANT_RC OUT [REASON…] -- CMD [ARG…]
expect_reject(){ local label=$1 n=$2 want=$3 out=$4; shift 4; local -a why=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do why+=("$1"); shift; done
  if [ "${1:-}" != -- ] || [ $# -lt 2 ]; then fail "$label: expect_reject called without '-- CMD'"; return 0; fi; shift
  local rc=0; "$@" > "$out" 2>&1 || rc=$?
  local f c res miss="" r; f=$(grep '^FAIL' "$out" || true); c=$(grep -c '^FAIL' "$out" || true)
  res=$(grep -E '^RESULT .*: [0-9]+ FAIL$' "$out" | tail -n 1 || true)
  for r in "${why[@]}"; do printf '%s\n' "$f" | grep -qF -- "$r" || miss="$miss [$r]"; done
  if [ "$want" != 0 ] && [ "$rc" = "$want" ] && [ "$c" = "$n" ] && [ "${res##*: }" = "$n FAIL" ] && [ -z "$miss" ]; then
    pass "$label: exit $rc, rejected for exactly the expected $n reason(s)"
  else
    fail "$label: exit $rc (want $want), FAIL lines $c (want $n), result [${res:-none}], missing:${miss:- none}"; printf '%s\n' "$f" | head -n 8
  fi; return 0; }

# expect_ok LABEL OUT -- CMD [ARG…]: exit 0, no FAIL line and "RESULT …: 0 FAIL".
expect_ok(){ local label=$1 out=$2; shift 2
  if [ "${1:-}" != -- ] || [ $# -lt 2 ]; then fail "$label: expect_ok called without '-- CMD'"; return 0; fi; shift
  local rc=0; "$@" > "$out" 2>&1 || rc=$?
  local c res; c=$(grep -c '^FAIL' "$out" || true); res=$(grep -E '^RESULT .*: [0-9]+ FAIL$' "$out" | tail -n 1 || true)
  if [ "$rc" = 0 ] && [ "$c" = 0 ] && [ "${res##*: }" = "0 FAIL" ]; then pass "$label ($(grep -c '^PASS' "$out" || true) checks)"
  else fail "$label: exit $rc, FAIL lines $c, result [${res:-none}]"; grep '^FAIL' "$out" | head -n 8; fi; return 0; }

h_finish(){ trap - ERR; exec 2>&3; wait "$H_TEE" 2>/dev/null || true
  local bad; bad=$(grep -E '(\.sh: line [0-9]+: |command not found|unbound variable|syntax error|bad substitution|integer expression expected|unary operator expected|binary operator expected|too many arguments|ambiguous redirect)' "$H_ERR" || true)
  if [ -z "$bad" ]; then pass "harness: no shell error on its own stderr"; else fail "harness: shell errors on its own stderr"; printf '%s\n' "$bad" | head -n 8; fi
  H_DONE=1; echo "RESULT $H_NAME: $fails FAIL"; [ "$fails" = 0 ] && exit 0; exit 1; }
