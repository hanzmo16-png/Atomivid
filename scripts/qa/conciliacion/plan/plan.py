#!/usr/bin/env python3
"""Offline, fail-closed review plan for the OPEN paid operations (T-20261025-0112-chatgpt-03). USD 0.

Reads ONLY local files: a redacted snapshot (format atomivid.reconcile-snapshot/v1) and, optionally, a provider-evidence
file (atomivid.reconcile-evidence/v1). Never connects to a database or provider, never writes SQL. Output: a review
report (Markdown) and a plan TEMPLATE (JSON). The template is keyed by pseudonyms (k-<md5(real key)>), so its
per-decision `template_sha256` is the tool's canonical hash computed over the PSEUDONYM: it is NOT the hash the tool
pi_reconcile_open_operation (docs/ops/conciliacion) computes for a real operation, and the template is never
consumable by any apply step. The only way forward is `map`: in an authorized environment, a local list of the real
keys is checked (k-md5(real) must equal op, one-to-one, complete), every decision is re-hashed over the real key
(`decision_sha256`, byte-identical to the tool) and a NEW mapped plan with a new plan_sha256 is emitted, which still
needs its own A-3 review. Any change to an operation, precondition, outcome, evidence, amount or override invalidates
the decision and the plan.

  plan.py build      --snapshot S --out DIR [--evidence E] [--now ISO]   → DIR/plan.json (template) + DIR/review.md
  plan.py verify     --plan P --snapshot S [--evidence E] [--now ISO]    → recomputes; exit 0 only if byte-identical
  plan.py map        --plan P --snapshot S [--evidence E] --keys K --out DIR   → DIR/plan.mapped.json (outside the repo)
  plan.py verify-map --mapped M --plan P --snapshot S [--evidence E] --keys K  → recomputes the mapped plan

Exit codes: 0 plan READY (every operation has a complete decision), 3 plan NOT_READY (some operation is CANDIDATE /
MANUAL / BLOCKED: review report written, no decision may be applied), 1 invalid input (nothing written), 2 usage.
There is NO apply mode: --emit-sql / --apply are refused by design.
"""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import os
import re
import sys

SNAP_FORMAT = "atomivid.reconcile-snapshot/v1"
EVID_FORMAT = "atomivid.reconcile-evidence/v1"
PLAN_FORMAT = "atomivid.reconcile-plan-template/v2"
MAPPED_FORMAT = "atomivid.reconcile-plan-mapped/v1"
REAL_KEY = re.compile(r"[ -~]{1,200}")
OPEN = ("RESERVED", "SUBMITTED", "PROVIDER_JOB_RECORDED", "RECONCILIATION_REQUIRED")
FINAL = ("COMMITTED", "REFUNDED")
OUTCOMES = ("cancelled_before_submission", "not_charged", "charged", "assumed_charged", "manual")
INTERNAL_PROVIDERS = ("internal",)
MIN_AGE = dt.timedelta(hours=24)
# Minimal schema: exactly these fields, nothing else (no keys, UUIDs, prompts, paths or URLs can ride along).
OP_FIELDS = {"op", "status", "updated_at", "provider", "method", "reserved_usd", "committed_usd",
             "has_provider_job", "has_result_ref", "supply_reconciled"}
SNAP_FIELDS = {"format", "source", "taken_at", "complete", "totals", "operations"}
EV_FIELDS = {"op", "outcome", "evidence", "actual_usd", "allow_over_reserved"}
PSEUDONYM = re.compile(r"k-[0-9a-f]{32}")
TOKEN = re.compile(r"[a-z0-9_]{1,40}")
TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z")
USD = re.compile(r"\d{1,8}(\.\d{1,4})?")
# Evidence is a short provider reference, not a document: printable ASCII only, no URL, no e-mail, no UUID.
EVIDENCE_OK = re.compile(r"[ -~]{3,200}")
EVIDENCE_LEAK = re.compile(r"https?://|www\.|@|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|/home/|/Users/|sk-[A-Za-z0-9]", re.I)


class InvalidInput(Exception):
    pass


def bad(msg):
    raise InvalidInput(msg)


def parse_ts(s, what):
    if not isinstance(s, str) or not TS.fullmatch(s):
        bad(f"{what}: timestamp must be UTC ISO-8601 with Z ({s!r})")
    return dt.datetime.strptime(s[:-1] + ("" if "." in s else ".0"), "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=dt.timezone.utc)


def pg_ts(t):
    """to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') — the tool's canonical timestamp."""
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond:06d}Z"


def parse_usd(s, what, allow_null=False):
    if s is None and allow_null:
        return None
    if not isinstance(s, str) or not USD.fullmatch(s):
        bad(f"{what}: amount must be a non-negative decimal string with at most 4 decimals ({s!r})")
    return decimal.Decimal(s)


def usd4(d):
    return None if d is None else str(d.quantize(decimal.Decimal("0.0001")))


def jsonb_text(v):
    """PostgreSQL jsonb::text of an array of strings / null / booleans (", " separators, same string escaping)."""
    return json.dumps(v, ensure_ascii=False, separators=(", ", ": "))


def decision_sha256(decision_id, key, status, updated_at, outcome, evidence, actual_usd, allow_over):
    """Byte-identical to the tool: sha256(jsonb_build_array(id, key, status, ts, outcome, evidence,
    (actual::numeric(12,4))::text, coalesce(allow, false))::text)."""
    arr = [decision_id, key, status, updated_at, outcome, evidence, usd4(actual_usd), bool(allow_over)]
    return hashlib.sha256(jsonb_text(arr).encode("utf-8")).hexdigest()


def canonical(obj):
    return json.dumps(obj, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f, parse_float=lambda x: bad(f"{what}: numbers must be strings ({x})"),
                             object_pairs_hook=lambda pairs: dict_no_dup(pairs, what))
    except (OSError, ValueError) as e:
        bad(f"{what}: unreadable JSON ({e.__class__.__name__})")


def dict_no_dup(pairs, what):
    d = {}
    for k, v in pairs:
        if k in d:
            bad(f"{what}: duplicate field {k!r}")
        d[k] = v
    return d


def check_snapshot(s):
    if not isinstance(s, dict) or set(s) != SNAP_FIELDS:
        bad(f"snapshot: fields must be exactly {sorted(SNAP_FIELDS)}")
    if s["format"] != SNAP_FORMAT:
        bad(f"snapshot: format must be {SNAP_FORMAT}")
    if s["source"] not in ("synthetic-fixture", "redacted-readonly"):
        bad("snapshot: source must be synthetic-fixture or redacted-readonly")
    if s["complete"] is not True:
        bad("snapshot: partial snapshot (complete must be true)")
    taken = parse_ts(s["taken_at"], "snapshot.taken_at")
    ops = s["operations"]
    if not isinstance(ops, list) or not ops:
        bad("snapshot: operations must be a non-empty list")
    seen = set()
    for i, o in enumerate(ops):
        w = f"operations[{i}]"
        if not isinstance(o, dict) or set(o) != OP_FIELDS:
            bad(f"{w}: fields must be exactly {sorted(OP_FIELDS)}")
        if not isinstance(o["op"], str) or not PSEUDONYM.fullmatch(o["op"]):
            bad(f"{w}: op must be a redacted pseudonym k-<32 hex> (never a real key)")
        if o["op"] in seen:
            bad(f"{w}: duplicate operation {o['op'][:10]}…")
        seen.add(o["op"])
        if o["status"] in FINAL:
            bad(f"{w}: final status {o['status']} in an open-operations snapshot")
        if o["status"] not in OPEN:
            bad(f"{w}: unknown status {o['status']!r}")
        for f in ("provider", "method"):
            if not isinstance(o[f], str) or not TOKEN.fullmatch(o[f]):
                bad(f"{w}: {f} must be a short lowercase token")
        for f in ("has_provider_job", "has_result_ref", "supply_reconciled"):
            if not isinstance(o[f], bool):
                bad(f"{w}: {f} must be a boolean")
        if o["supply_reconciled"]:
            bad(f"{w}: an open operation cannot be supply_reconciled")
        parse_usd(o["reserved_usd"], f"{w}.reserved_usd")
        if o["committed_usd"] is not None:
            bad(f"{w}: an open operation has no committed amount")
        if parse_ts(o["updated_at"], f"{w}.updated_at") > taken:
            bad(f"{w}: updated_at after the snapshot was taken")
    t = s["totals"]
    if not isinstance(t, dict) or set(t) != {"count", "reserved_usd", "by_status"}:
        bad("snapshot.totals: fields must be exactly count, reserved_usd, by_status")
    if t["count"] != len(ops) or parse_usd(t["reserved_usd"], "totals.reserved_usd") != sum(decimal.Decimal(o["reserved_usd"]) for o in ops):
        bad("snapshot.totals: count or reserved_usd does not add up (partial or edited snapshot)")
    by = {}
    for o in ops:
        c, r = by.get(o["status"], (0, decimal.Decimal(0)))
        by[o["status"]] = (c + 1, r + decimal.Decimal(o["reserved_usd"]))
    declared = t["by_status"]
    if not isinstance(declared, dict) or set(declared) != set(by) or any(
            not isinstance(v, dict) or set(v) != {"count", "reserved_usd"} or v["count"] != by[k][0]
            or parse_usd(v["reserved_usd"], f"totals.by_status.{k}") != by[k][1] for k, v in declared.items()):
        bad("snapshot.totals.by_status: per-status totals do not add up")
    return taken


def check_evidence(e, ops_by_key):
    if not isinstance(e, dict) or set(e) != {"format", "items"} or e["format"] != EVID_FORMAT or not isinstance(e["items"], list):
        bad(f"evidence: must be {{format: {EVID_FORMAT}, items: [...]}}")
    out = {}
    for i, it in enumerate(e["items"]):
        w = f"evidence.items[{i}]"
        if not isinstance(it, dict) or not {"op", "outcome", "evidence"} <= set(it) <= EV_FIELDS:
            bad(f"{w}: fields must be op, outcome, evidence [, actual_usd, allow_over_reserved]")
        if it["op"] not in ops_by_key:
            bad(f"{w}: evidence for an operation that is not in the snapshot")
        if it["op"] in out:
            bad(f"{w}: two evidence items for the same operation")
        if it["outcome"] not in OUTCOMES:
            bad(f"{w}: unknown outcome {it['outcome']!r}")
        if not isinstance(it["evidence"], str) or not EVIDENCE_OK.fullmatch(it["evidence"]) or not it["evidence"].strip():
            bad(f"{w}: evidence must be a 3–200 char printable ASCII reference")
        if EVIDENCE_LEAK.search(it["evidence"]):
            bad(f"{w}: evidence looks like it carries a URL, e-mail, UUID, path or secret; use an opaque reference")
        if "allow_over_reserved" in it and not isinstance(it["allow_over_reserved"], bool):
            bad(f"{w}: allow_over_reserved must be a boolean")
        out[it["op"]] = it
    return out


def decide(o, ev, taken, now):
    """→ (state, outcome, evidence, actual_usd, allow_over, reasons). state: READY | CANDIDATE | MANUAL | BLOCKED."""
    reasons = []
    upd = parse_ts(o["updated_at"], "updated_at")
    reserved = decimal.Decimal(o["reserved_usd"])
    if taken - upd < MIN_AGE or (now is not None and now - upd < MIN_AGE):
        return "BLOCKED", None, None, None, False, ["touched less than 24 h ago: a live owner may still settle it"]
    st = o["status"]
    if st == "RESERVED":
        if o["has_provider_job"] or o["has_result_ref"]:
            return "MANUAL", "manual", None, None, False, ["RESERVED row carries provider data: never cancelled automatically"]
        if ev is not None and ev["outcome"] != "cancelled_before_submission":
            return "BLOCKED", None, None, None, False, [f"evidence proposes {ev['outcome']} for a RESERVED row; it never reached the provider"]
        if ev is not None and ev.get("actual_usd") not in (None, "0", "0.0000"):
            return "BLOCKED", None, None, None, False, ["a never-submitted operation has no cost"]
        evidence = ev["evidence"] if ev else "write-ahead: RESERVED, no provider job, no result"
        return "READY", "cancelled_before_submission", evidence, None, False, ["RESERVED without provider data (SUBMITTED is written before any HTTP request)"]
    # SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED left the process: provider evidence decides.
    if ev is None:
        if st == "SUBMITTED" and o["provider"] in INTERNAL_PROVIDERS:
            return "CANDIDATE", "not_charged", None, None, False, ["internal provider: candidate not_charged; needs an explicit evidence item to be READY"]
        return "MANUAL", "manual", None, None, False, ["left the process and there is no provider evidence: manual review or an explicit assumed_charged"]
    out = ev["outcome"]
    actual = parse_usd(ev["actual_usd"], "evidence.actual_usd", allow_null=True) if "actual_usd" in ev else None
    allow = bool(ev.get("allow_over_reserved", False))
    if out == "manual":
        return "MANUAL", "manual", None, None, False, ["evidence item marks it manual"]
    if out == "cancelled_before_submission":
        return "BLOCKED", None, None, None, False, [f"{st} left the process: cancelled_before_submission is only for RESERVED"]
    if out == "not_charged":
        if actual not in (None, decimal.Decimal(0)):
            return "BLOCKED", None, None, None, False, ["not_charged carries no amount"]
        return "READY", out, ev["evidence"], None, False, ["provider evidence: not charged → REFUNDED 0, supply_reconciled"]
    if out == "assumed_charged":
        if actual is not None:
            return "BLOCKED", None, None, None, False, ["assumed_charged books the reserved amount; do not pass one"]
        return "READY", out, ev["evidence"], None, False, [f"explicit assumed_charged: COMMITTED at the reserved {usd4(reserved)}"]
    # charged
    if actual is None:
        return "BLOCKED", None, None, None, False, ["charged needs the provider amount"]
    if actual > reserved and not allow:
        return "BLOCKED", None, None, None, False, [f"provider amount {usd4(actual)} exceeds the reservation {usd4(reserved)}; needs allow_over_reserved"]
    return "READY", out, ev["evidence"], actual, allow, [f"provider evidence: charged {usd4(actual)}" + (" (over the reservation, override given)" if actual > reserved else "")]


def build(snapshot_path, evidence_path, now_s):
    raw = read_bytes(snapshot_path)
    snap = load_json(snapshot_path, "snapshot")
    taken = check_snapshot(snap)
    now = parse_ts(now_s, "--now") if now_s else None
    if now is not None and now < taken:
        bad("--now is before the snapshot was taken")
    ops = {o["op"]: o for o in snap["operations"]}
    evraw = b""
    evid = {}
    if evidence_path:
        evraw = read_bytes(evidence_path)
        evid = check_evidence(load_json(evidence_path, "evidence"), ops)
    snap_sha = hashlib.sha256(raw).hexdigest()
    ev_sha = hashlib.sha256(evraw).hexdigest() if evidence_path else None
    decisions = []
    for key in sorted(ops):
        o = ops[key]
        state, outcome, evidence, actual, allow, reasons = decide(o, evid.get(key), taken, now)
        upd = pg_ts(parse_ts(o["updated_at"], "updated_at"))
        d = {"op": key, "expected_status": o["status"], "expected_updated_at": upd, "provider": o["provider"],
             "reserved_usd": usd4(decimal.Decimal(o["reserved_usd"])), "state": state, "outcome": outcome, "reasons": reasons}
        if state == "READY":
            did = "rp1-" + hashlib.sha256(f"{snap_sha}:{key}".encode()).hexdigest()[:24]
            # over the pseudonym: a template value, never the tool's hash for the real operation
            d.update(decision_id=did, evidence=evidence, actual_usd=usd4(actual), allow_over_reserved=allow,
                     template_sha256=decision_sha256(did, key, o["status"], upd, outcome, evidence, actual, allow))
        decisions.append(d)
    counts = {}
    for d in decisions:
        counts[d["state"]] = counts.get(d["state"], 0) + 1
    verdict = "READY" if counts.get("READY", 0) == len(decisions) else "NOT_READY"
    body = {"format": PLAN_FORMAT, "snapshot_sha256": snap_sha, "evidence_sha256": ev_sha, "snapshot_taken_at": snap["taken_at"],
            "checked_at": now_s, "verdict": verdict, "counts": dict(sorted(counts.items())), "decisions": decisions,
            "key_space": "pseudonym", "executable": False, "consumable_by_apply": False,
            "next_step": "map (authorized environment, real keys) -> mapped plan with new hashes -> A-3 review of the mapped plan",
            "apply_mode": "absent: this plan is a review artifact; no SQL is generated"}
    body["plan_sha256"] = hashlib.sha256(canonical(body).encode()).hexdigest()
    return snap, body


def load_keys(path):
    """Real keys, one per line (local file in an authorized environment; never committed or uploaded)."""
    raw = read_bytes(path)
    try:
        lines = raw.decode("utf-8").split("\n")
    except UnicodeDecodeError:
        bad("keys: not UTF-8")
    if lines and lines[-1] == "":
        lines.pop()
    if not lines:
        bad("keys: empty")
    for i, k in enumerate(lines):
        if not REAL_KEY.fullmatch(k) or k != k.strip():
            bad(f"keys[{i}]: a key is a printable single-line value without surrounding blanks")
    if len(set(lines)) != len(lines):
        bad("keys: duplicate key")
    return raw, lines


def map_plan(template_path, snapshot_path, evidence_path, keys_path):
    old = load_json(template_path, "plan")
    _, tmpl = build(snapshot_path, evidence_path, old.get("checked_at") if isinstance(old, dict) else None)
    if not isinstance(old, dict) or canonical(old) != canonical(tmpl):
        bad("plan: the template does not match its snapshot/evidence (changed operation, evidence or plan)")
    raw, keys = load_keys(keys_path)
    by_op = {}
    for k in keys:
        op = "k-" + hashlib.md5(k.encode("utf-8")).hexdigest()
        if op in by_op:
            bad("keys: two keys map to the same pseudonym")
        by_op[op] = k
    ops = {d["op"] for d in tmpl["decisions"]}
    if set(by_op) - ops:
        bad(f"keys: {len(set(by_op) - ops)} key(s) whose k-md5 matches no operation of the plan")
    if ops - set(by_op):
        bad(f"keys: {len(ops - set(by_op))} operation(s) of the plan without a matching key (k-md5(key) must equal op)")
    decisions = []
    for d in tmpl["decisions"]:
        m = {k: v for k, v in d.items() if k != "template_sha256"}
        m["key"] = by_op[d["op"]]
        if d["state"] == "READY":
            m["decision_sha256"] = decision_sha256(d["decision_id"], m["key"], d["expected_status"], d["expected_updated_at"], d["outcome"],
                                                   d["evidence"], None if d["actual_usd"] is None else decimal.Decimal(d["actual_usd"]),
                                                   d["allow_over_reserved"])
            if m["decision_sha256"] == d["template_sha256"]:
                bad("internal: real-key hash equals the template hash")
        decisions.append(m)
    body = {"format": MAPPED_FORMAT, "template_plan_sha256": tmpl["plan_sha256"], "snapshot_sha256": tmpl["snapshot_sha256"],
            "evidence_sha256": tmpl["evidence_sha256"], "keys_sha256": hashlib.sha256(raw).hexdigest(), "key_space": "real",
            "contains_real_keys": True, "executable": False, "a3_review_required": True,
            "verdict": "PENDING_A3_REVIEW" if tmpl["verdict"] == "READY" else "NOT_READY", "counts": tmpl["counts"], "decisions": decisions,
            "apply_mode": "absent: a separate, explicitly authorized step must consume this plan after its own A-3 review"}
    body["plan_sha256"] = hashlib.sha256(canonical(body).encode()).hexdigest()
    return body


def outside_repo(out):
    """The mapped plan carries real keys: refuse to write it inside this repository."""
    root = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
    target = os.path.realpath(out)
    return not (target == root or target.startswith(root + os.sep))


def review_md(snap, plan):
    L = [f"# Plan de conciliación offline — revisión ({plan['verdict']})", "",
         "**Plantilla de revisión**: no ejecutable, no consumible por ningún apply, sin SQL. Claves redactadas (seudónimo `k-` + md5).", "",
         f"- snapshot: `{plan['snapshot_sha256']}` ({snap['source']}, tomado {snap['taken_at']})",
         f"- evidencia: `{plan['evidence_sha256'] or 'ninguna'}`",
         f"- plan_sha256: `{plan['plan_sha256']}`",
         f"- operaciones: {len(plan['decisions'])}; reservado total {snap['totals']['reserved_usd']} USD", "",
         "| Estado | Operaciones |", "|---|---|"]
    L += [f"| {k} | {v} |" for k, v in plan["counts"].items()]
    L += ["", "| Estado origen | Resultado propuesto | Estado decisión | Ops | Reservado USD |", "|---|---|---|---|---|"]
    agg = {}
    for d in plan["decisions"]:
        k = (d["expected_status"], d["outcome"] or "—", d["state"])
        c, r = agg.get(k, (0, decimal.Decimal(0)))
        agg[k] = (c + 1, r + decimal.Decimal(d["reserved_usd"]))
    L += [f"| {a} | {b} | {c} | {n} | {usd4(r)} |" for (a, b, c), (n, r) in sorted(agg.items())]
    L += ["", "## Operaciones no listas", ""]
    pend = [d for d in plan["decisions"] if d["state"] != "READY"]
    L += [f"- `{d['op'][:10]}…` {d['expected_status']} {d['provider']} {d['reserved_usd']}: {d['state']} — {'; '.join(d['reasons'])}" for d in pend] or ["- ninguna"]
    L += ["", "Cada decisión READY lleva `template_sha256`: la fórmula de `pi_reconcile_open_operation` calculada sobre el SEUDÓNIMO.",
          "No es el hash de la operación real. El único paso siguiente es `map` en un entorno autorizado (claves reales locales,",
          "k-md5(clave) = op uno a uno), que emite un plan mapeado con `decision_sha256` nuevos y un plan_sha256 nuevo, que a su",
          "vez requiere su propia revisión A-3. Aplicar algo requiere además autorización explícita, evidencia autorizada y CAS."]
    return "\n".join(L) + "\n"


def main(argv):
    if any(a in ("--emit-sql", "--apply", "--sql", "--execute") for a in argv):
        print("REFUSED: there is no apply/SQL mode; this tool only produces a review plan", file=sys.stderr)
        return 2
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--snapshot", required=True); b.add_argument("--evidence"); b.add_argument("--now"); b.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--plan", required=True); v.add_argument("--snapshot", required=True); v.add_argument("--evidence"); v.add_argument("--now")
    m = sub.add_parser("map")
    m.add_argument("--plan", required=True); m.add_argument("--snapshot", required=True); m.add_argument("--evidence"); m.add_argument("--keys", required=True); m.add_argument("--out", required=True)
    vm = sub.add_parser("verify-map")
    vm.add_argument("--mapped", required=True); vm.add_argument("--plan", required=True); vm.add_argument("--snapshot", required=True); vm.add_argument("--evidence"); vm.add_argument("--keys", required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "build":
            snap, plan = build(a.snapshot, a.evidence, a.now)
            os.makedirs(a.out, exist_ok=True)
            with open(os.path.join(a.out, "plan.json"), "w", encoding="utf-8") as f:
                f.write(json.dumps(plan, ensure_ascii=True, indent=1, sort_keys=True) + "\n")
            with open(os.path.join(a.out, "review.md"), "w", encoding="utf-8") as f:
                f.write(review_md(snap, plan))
            print(f"{plan['verdict']} {canonical(plan['counts'])} plan_sha256={plan['plan_sha256']}")
            return 0 if plan["verdict"] == "READY" else 3
        if a.cmd == "map":
            if not outside_repo(a.out):
                bad("--out is inside the repository; the mapped plan carries real keys and must stay outside it")
            mp = map_plan(a.plan, a.snapshot, a.evidence, a.keys)
            os.makedirs(a.out, exist_ok=True)
            with open(os.path.join(a.out, "plan.mapped.json"), "w", encoding="utf-8") as f:
                f.write(json.dumps(mp, ensure_ascii=True, indent=1, sort_keys=True) + "\n")
            print(f"{mp['verdict']} mapped plan_sha256={mp['plan_sha256']} (contains real keys: keep local, never commit or upload)")
            return 0 if mp["verdict"] == "PENDING_A3_REVIEW" else 3
        if a.cmd == "verify-map":
            old = load_json(a.mapped, "mapped plan")
            mp = map_plan(a.plan, a.snapshot, a.evidence, a.keys)
            same = isinstance(old, dict) and canonical(old) == canonical(mp)
            print(("VALID " if same else "INVALID mapped plan does not match template/keys ") + f"plan_sha256={mp['plan_sha256']}")
            return (0 if mp["verdict"] == "PENDING_A3_REVIEW" else 3) if same else 1
        old = load_json(a.plan, "plan")
        _, plan = build(a.snapshot, a.evidence, a.now if a.now else (old.get("checked_at") if isinstance(old, dict) else None))
        same = isinstance(old, dict) and canonical(old) == canonical(plan)
        print(("VALID " if same else "INVALID plan does not match the inputs (changed operation, evidence or plan) ") + f"plan_sha256={plan['plan_sha256']}")
        return (0 if plan["verdict"] == "READY" else 3) if same else 1
    except (InvalidInput, OSError) as e:
        print(f"INVALID INPUT: {e}; nothing written", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
