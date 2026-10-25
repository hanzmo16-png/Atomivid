#!/usr/bin/env python3
"""Driver for pg_check.sh (disposable cluster only; PSQL is the psql command line built by the script)."""
import copy
import datetime as dt
import hashlib
import json
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
W = sys.argv[1]
PSQL = shlex.split(os.environ["PSQL"])
fails = 0


def check(ok, msg):
    global fails
    print(("PASS " if ok else "FAIL ") + msg)
    fails += 0 if ok else 1


def sql(q, args=()):
    """psql with -v variables (quoted by psql itself: :'v'), returns (rc, stdout+stderr)."""
    cmd = PSQL + ["-At"]
    for i, a in enumerate(args):
        cmd += ["-v", f"a{i}={'' if a is None else a}"]
    r = subprocess.run(cmd, input=q, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def lit(i, v):
    return "null" if v is None else f":'a{i}'"


def plan_cli(*args):
    r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "plan.py"), *args], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def read_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# Fresh synthetic snapshot relative to the real clock (the tool refuses rows touched < 24 h ago by clock_timestamp()).
taken = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(minutes=1)
fx = os.path.join(W, "fx")
subprocess.run([sys.executable, "-I", os.path.join(HERE, "make_fixture.py"), fx, "--taken-at", taken.strftime("%Y-%m-%dT%H:%M:%SZ")], check=True)
snap_p, ev_p = os.path.join(fx, "synthetic-41.snapshot.json"), os.path.join(fx, "synthetic-41.evidence.json")
snap = read_json(snap_p)
sys.path.insert(0, HERE)
import make_fixture  # noqa: E402
real = [make_fixture.real_key(i) for i in range(len(make_fixture.ROWS))]
key_of = {"k-" + hashlib.md5(k.encode()).hexdigest(): k for k in real}
keys_p = os.path.join(W, "keys.txt")
with open(keys_p, "w", encoding="utf-8") as f:
    f.write("".join(k + "\n" for k in real))
rc, out = plan_cli("build", "--snapshot", snap_p, "--evidence", ev_p, "--out", os.path.join(W, "a"))
check(rc == 0, f"template READY for the 41 synthetic operations ({out.strip()})")
template = read_json(os.path.join(W, "a", "plan.json"))
rc, out = plan_cli("map", "--plan", os.path.join(W, "a", "plan.json"), "--snapshot", snap_p, "--evidence", ev_p, "--keys", keys_p, "--out", os.path.join(W, "am"))
check(rc == 0, f"template mapped to the real keys ({out.strip()})")
plan = read_json(os.path.join(W, "am", "plan.mapped.json"))

# the ledger holds the REAL keys (synthetic stand-ins); the snapshot only ever saw k-md5(key)
for o in snap["operations"]:
    rc, out = sql("insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,updated_at)"
                  " values(:'a0','p-synthetic','s',:'a1','m',:'a2','initial',:'a3',:'a4',:'a5')",
                  (key_of[o["op"]], o["provider"], o["method"], o["reserved_usd"], o["status"], o["updated_at"]))
    if rc:
        check(False, f"insert synthetic row: {out[:200]}"); sys.exit(1)
rc, out = sql("select count(*)||'|'||sum(reserved_usd) from public.pi_paid_operations where status in ('RESERVED','SUBMITTED','PROVIDER_JOB_RECORDED','RECONCILIATION_REQUIRED')")
check(out == f"{snap['totals']['count']}|{snap['totals']['reserved_usd']}", f"disposable ledger matches the snapshot totals ({out})")
SPEND = "select coalesce(sum(public.pi_supply_spend(p, now() - interval '30 days')),0) from (select distinct provider p from public.pi_paid_operations) x"
_, spend0 = sql(SPEND)


def call(d, key=None):
    q = ("select public.pi_reconcile_open_operation(:'a0', :'a1', :'a2', :'a3'::timestamptz, :'a4', :'a5', "
         f"{lit(6, d['actual_usd'])}::numeric, :'a7'::boolean)")
    return sql(q, (d["decision_id"], key or d["key"], d["expected_status"], d["expected_updated_at"], d["outcome"], d["evidence"],
                   d["actual_usd"], "true" if d["allow_over_reserved"] else "false"))


# the pseudonymized template is not consumable: its op is not a ledger key
rc, out = call(template["decisions"][0], key=template["decisions"][0]["op"])
check(rc != 0 and "operation not found" in out, "a template decision (pseudonym as key) is refused by the tool: operation not found")
applied = same = 0
tmpl_hash = {d["op"]: d["template_sha256"] for d in template["decisions"]}
template_matches = 0
for d in plan["decisions"]:
    rc, out = call(d)
    if rc == 0:
        applied += 1
        h = json.loads(out.splitlines()[-1])["decisionSha256"]
        same += h == d["decision_sha256"]
        template_matches += h == tmpl_hash[d["op"]]
    else:
        print("  refused:", d["op"][:10], out.splitlines()[-1][:160])
check(applied == 41, f"the tool accepts every decision of the MAPPED plan ({applied}/41)")
check(same == 41 and template_matches == 0, f"tool hash == mapped decision_sha256 for {same}/41 and == template_sha256 for {template_matches}/41")
rc, out = sql("select count(*) from public.pi_reconciliation_log l join (select jsonb_array_elements(:'a0'::jsonb) d) p on l.decision_id = p.d->>'decision_id' and l.decision_sha256 = p.d->>'decision_sha256'",
              (json.dumps([{"decision_id": d["decision_id"], "decision_sha256": d["decision_sha256"]} for d in plan["decisions"]]),))
check(out == "41", f"pi_reconciliation_log stores exactly the plan's decision_sha256 for all 41 decisions ({out})")
rc, out = sql("select status||':'||count(*)||':'||coalesce(sum(committed_usd),0)||':'||bool_and(supply_reconciled) from public.pi_paid_operations group by status order by status")
exp_commit = sum(float(d["actual_usd"]) if d["outcome"] == "charged" else float(d["reserved_usd"]) for d in plan["decisions"] if d["outcome"] in ("charged", "assumed_charged"))
lines = dict(l.split(":", 1) for l in out.splitlines())
check(set(lines) == {"COMMITTED", "REFUNDED"} and lines["REFUNDED"].startswith("35:0.0000:true")
      and abs(float(lines["COMMITTED"].split(":")[1]) - exp_commit) < 1e-9 and lines["COMMITTED"].endswith(":false"),
      f"final states as planned: 35 REFUNDED supply_reconciled (32 cancelled + 3 not_charged), 6 COMMITTED {exp_commit:.4f} ({out.replace(chr(10), ' ')})")
_, spend1 = sql(SPEND)
# pi_supply_spend counts SUBMITTED/PJR/RR at their reservation (never RESERVED) and COMMITTED at greatest(reserved, committed)
open0 = sum(float(o["reserved_usd"]) for o in snap["operations"] if o["status"] != "RESERVED")
after1 = sum(max(float(d["reserved_usd"]), float(d["actual_usd"]) if d["outcome"] == "charged" else float(d["reserved_usd"]))
             for d in plan["decisions"] if d["outcome"] in ("charged", "assumed_charged"))
check(abs(float(spend0) - open0) < 1e-9 and abs(float(spend1) - after1) < 1e-9,
      f"pi_supply_spend exact: {spend0} before (uncertain rows) → {spend1} after (COMMITTED at greatest(reserved, committed); REFUNDED reconciled rows count 0)")

# replay of the same plan: every decision replays, nothing changes
_, before = sql("select md5(string_agg(t::text, ',' order by idempotency_key)) from public.pi_paid_operations t")
replayed = sum(1 for d in plan["decisions"] if (lambda r: r[0] == 0 and '"replayed": true' in r[1])(call(d)))
_, after = sql("select md5(string_agg(t::text, ',' order by idempotency_key)) from public.pi_paid_operations t")
check(replayed == 41 and before == after, f"replaying the same plan: {replayed}/41 replayed, ledger unchanged")

# a contradictory plan from the same snapshot (another operator): same decision_ids, different hashes → all refused
ev = read_json(ev_p)
for it in ev["items"]:
    if it["outcome"] == "charged":
        it["outcome"] = "assumed_charged"; it.pop("actual_usd")
with open(os.path.join(W, "ev2.json"), "w", encoding="utf-8") as f:
    json.dump(ev, f)
plan_cli("build", "--snapshot", snap_p, "--evidence", os.path.join(W, "ev2.json"), "--out", os.path.join(W, "b"))
plan_cli("map", "--plan", os.path.join(W, "b", "plan.json"), "--snapshot", snap_p, "--evidence", os.path.join(W, "ev2.json"), "--keys", keys_p, "--out", os.path.join(W, "bm"))
b = read_json(os.path.join(W, "bm", "plan.mapped.json"))
diff = [d for d, e in zip(b["decisions"], plan["decisions"]) if d["decision_sha256"] != e["decision_sha256"]]
ref = sum(1 for d in diff if (lambda r: r[0] != 0 and "different parameters" in r[1])(call(d)))
check(len(diff) == 3 and ref == 3, f"contradictory plan: {ref}/{len(diff)} changed decisions refused ('replayed with different parameters')")

# a plan built before a row changed is refused by the tool's CAS (status/updated_at), even with a fresh decision id
o = copy.deepcopy(snap["operations"][0])
stale_key = "synthetic-stale-cas-row"
sql("insert into public.pi_paid_operations(idempotency_key,project_id,shot_id,provider,model,method,attempt_kind,reserved_usd,status,updated_at)"
    " values(:'a0','p-synthetic','s','openai','m','image','initial',0.2300,'RESERVED',:'a1')", (stale_key, o["updated_at"]))
stale = dict(plan["decisions"][0], key=stale_key, decision_id="rp1-stale-cas-check-0000", expected_updated_at="2026-01-01T00:00:00.000000Z")
rc, out = call(stale)
check(rc != 0 and "changed since the plan" in out, "a stale expected_updated_at is refused by the tool's CAS")
_, st = sql("select status from public.pi_paid_operations where idempotency_key=:'a0'", (stale_key,))
check(st == "RESERVED", "the stale decision left the row untouched")
print(f"RESULT plan pg_check: {fails} FAIL")
sys.exit(1 if fails else 0)
