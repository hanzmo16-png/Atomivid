#!/usr/bin/env python3
"""Stage-aware pre-operation gate for the integration plan O1 → O8 (pure: reads a facts JSON, prints PASS/FAIL).

`next` names the operation about to run; the expected production state is the one left by every earlier operation:
  O1  conciliation A  → O2 migration 120000 → O3 migration 130000 → O4 merge #201 → O5 merge #199 → O7 merge #207
  → O8 migration 140000 → DONE (state after O8).
Fails closed: any divergence, missing fact or unknown stage is a FAIL. Exit 1 when anything failed.
Usage: gate.py facts.json   (facts are collected read-only by cierre.sh; see gate_test.py for the schema)
"""
import json
import sys

ORDER = ["O1", "O2", "O3", "O4", "O5", "O7", "O8", "DONE"]
FROZEN = {
    "base": "762714e2ff3d19a62d2c705b7487ff9a364677e7",
    "201": "9944360b5a32130d46811ea9d57f569b1e9031f5",
    "199": "49594f1e989d1c6f8c21bae4e650075ea4532ed4",
    "207": "d8b203d665e62602cec5cb72620f03b5630edd12",
}
MOVED = {"O2": "20261024120000_resume_authorization_ref_match.sql", "O3": "20261024130000_spend_authorization_baseline_fix.sql",
         "O8": "20261024140000_podcast_v3_studio.sql"}


def done(stage: str, op: str) -> bool:
    """True when `op` already ran before the operation `stage` is about to start."""
    return ORDER.index(stage) > ORDER.index(op)


def evaluate(f: dict) -> list:
    out = []
    ok = lambda cond, msg: out.append(("PASS" if cond else "FAIL") + " GATE[" + str(f.get("next")) + "] " + msg)
    stage = f.get("next")
    if stage not in ORDER:
        return ["FAIL GATE unknown stage " + repr(stage)]
    req = ["markers", "studio", "registry_names", "regen_A_names", "committed_A_names", "base", "trees", "heads", "inflight", "sha_ok"]
    missing = [k for k in req if k not in f]
    if missing:
        return ["FAIL GATE[" + stage + "] missing facts: " + ",".join(missing)]
    m = f["markers"]
    ok(m.get("000000") is True, "20261024000000 applied in production (marker t)")
    for op, key in (("O2", "120000"), ("O3", "130000"), ("O8", "140000")):
        want = done(stage, op)
        ok(m.get(key) is want, f"marker 20261024{key} = {'t' if want else 'f'} (got {m.get(key)})")
    s = f["studio"]
    if done(stage, "O8"):
        ok(s.get("present") is True and s.get("rows") == 0, f"studio tables present and empty after O8 (present={s.get('present')}, rows={s.get('rows')})")
    else:
        ok(s.get("present") is False, f"studio tables absent before O8 (present={s.get('present')})")
    ok(f["sha_ok"] is True, "every committed ops SQL matches its SHA256SUMS")
    reg = set(f["registry_names"])
    committed_a = sorted(f["committed_A_names"])
    if not done(stage, "O1"):
        ok(sorted(f["regen_A_names"]) == committed_a and len(committed_a) == 18, f"conciliation A regenerated today == committed file ({len(f['regen_A_names'])}/{len(committed_a)} names)")
        ok(not (reg & set(committed_a)), "none of A's names is registered yet (A's precondition holds)")
        ok(f.get("regen_A_identical") is True, "conciliation A regenerated today is byte-identical to the committed file (sha256 577cd97b…)")
    else:
        ok(set(committed_a) <= reg, f"O1 done: all {len(committed_a)} names of A registered in _migrations_applied")
        ok(f["regen_A_names"] == [], f"O1 done: nothing left to register (regenerated A has {len(f['regen_A_names'])} names)")
    for op, name in MOVED.items():
        want = done(stage, op)
        ok((name in reg) is want, f"{name} {'registered' if want else 'not registered'} in _migrations_applied")
    b, t = f["base"], f["trees"]
    expected_tree = t.get("207") if done(stage, "O7") else t.get("199") if done(stage, "O5") else t.get("201") if done(stage, "O4") else t.get("base")
    ok(b.get("tree") is not None and b.get("tree") == expected_tree, f"production branch tree == the expected integrated tree ({str(b.get('tree'))[:12]} vs {str(expected_tree)[:12]})")
    if not done(stage, "O4"):
        ok(b.get("head") == FROZEN["base"], f"production branch head unchanged ({str(b.get('head'))[:12]})")
    else:
        last = "207" if done(stage, "O7") else "199" if done(stage, "O5") else "201"
        parents = b.get("parents") or []
        ok(len(parents) == 2 and parents[1] == FROZEN[last], f"last integration is a merge commit of #{last} @ {FROZEN[last][:7]} (parents {[p[:7] for p in parents]})")
    h = f["heads"]
    for pr, op in (("201", "O4"), ("199", "O5"), ("207", "O7")):
        if not done(stage, op):
            ok(h.get(pr) == FROZEN[pr], f"#{pr} head still frozen at {FROZEN[pr][:7]} (got {str(h.get(pr))[:7]})")
    i = f["inflight"]
    if stage in ("O4", "O5", "O7"):
        ok(i.get("due") == 0 and i.get("busy") == 0 and i.get("documentary") == 0,
           f"no in-flight work before a merge (podcast due={i.get('due')} busy={i.get('busy')}, documentary={i.get('documentary')})")
    return out


if __name__ == "__main__":
    lines = evaluate(json.load(open(sys.argv[1], encoding="utf-8")))
    print("\n".join(lines))
    sys.exit(1 if any(x.startswith("FAIL") for x in lines) else 0)
