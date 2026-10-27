#!/usr/bin/env python3
"""Tests for gate.py: the expected state of every stage passes, and each unexpected state fails closed. USD 0, offline."""
import copy
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate  # noqa: E402

A = [f"a{i:02d}.sql" for i in range(18)]
TREES = {"base": "T-base", "201": "T-201", "199": "T-199", "207": "T-207", "228": "T-228"}


def state(stage: str) -> dict:
    """The facts production should show right before `stage` runs."""
    d = lambda op: gate.done(stage, op)
    reg = ["0001_init.sql"] + (A if d("O1") else []) + [n for op, n in gate.MOVED.items() if d(op)]
    last = next((pr for pr, op in reversed(gate.MERGES) if d(op)), None)
    return {
        "next": stage,
        "markers": {"000000": True, "120000": d("O2"), "130000": d("O3"), "140000": d("O8")},
        "studio": {"present": d("O8"), "rows": 0 if d("O8") else None},
        "sha_ok": True,
        "registry_names": reg,
        "regen_A_names": [] if d("O1") else list(A),
        "regen_A_identical": not d("O1"),
        "committed_A_names": list(A),
        "base": {"head": gate.FROZEN["base"] if not last else "M-" + last, "tree": TREES[last or "base"],
                 "parents": [] if not last else ["P", gate.FROZEN[last]]},
        "trees": dict(TREES),
        "heads": {pr: gate.FROZEN[pr] for pr in ("201", "199", "207", "228")},
        "inflight": {"due": 0, "busy": 0, "documentary": 0},
    }


fails = 0


def check(name, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + name)
    fails += 0 if cond else 1


def failing(facts):
    return [x for x in gate.evaluate(facts) if x.startswith("FAIL")]


for st in gate.ORDER:
    check(f"stage {st}: the expected state passes every gate check", failing(state(st)) == [])

MUTATIONS = [
    ("O1", "120000 already applied outside the plan", lambda f: f["markers"].__setitem__("120000", True)),
    ("O1", "registry changed since the audit (regenerated A differs)", lambda f: f["regen_A_names"].pop()),
    ("O1", "a name of A already registered by someone else", lambda f: f["registry_names"].append(A[0])),
    ("O1", "a committed ops SQL file was altered (sha256)", lambda f: f.__setitem__("sha_ok", False)),
    ("O1", "regenerated A differs byte-wise from the committed file", lambda f: f.__setitem__("regen_A_identical", False)),
    ("O2", "O1 not really done (names of A missing)", lambda f: f.__setitem__("registry_names", ["0001_init.sql"])),
    ("O3", "O2 reported but marker 120000 still f", lambda f: f["markers"].__setitem__("120000", False)),
    ("O3", "120000 applied but not registered (tool bypassed)", lambda f: f["registry_names"].remove(gate.MOVED["O2"])),
    ("O4", "130000 missing before merging #201", lambda f: f["markers"].__setitem__("130000", False)),
    ("O4", "production branch moved (unexpected push)", lambda f: f["base"].__setitem__("head", "deadbeef")),
    ("O4", "#201 head changed after its CI", lambda f: f["heads"].__setitem__("201", "cafebabe")),
    ("O4", "in-flight podcast job at merge time", lambda f: f["inflight"].__setitem__("busy", 1)),
    ("O4", "documentary job queued at merge time", lambda f: f["inflight"].__setitem__("documentary", 2)),
    ("O5", "#201 merged by squash (no merge commit with #201 as parent)", lambda f: f["base"].__setitem__("parents", ["P"])),
    ("O5", "tree after O4 is not #201's tree", lambda f: f["base"].__setitem__("tree", "T-other")),
    ("O7", "#199 merged on top of something else (tree differs)", lambda f: f["base"].__setitem__("tree", "T-201")),
    ("O7", "#207 head changed after its CI", lambda f: f["heads"].__setitem__("207", "0badf00d")),
    ("O7", "scheduled podcast episode due at merge time", lambda f: f["inflight"].__setitem__("due", 1)),
    ("O8", "studio tables created before O8", lambda f: f["studio"].update(present=True, rows=0)),
    ("O8", "#207 merged with a squash", lambda f: f["base"].__setitem__("parents", ["P", "x"])),
    ("O10", "#228 head changed after its CI", lambda f: f["heads"].__setitem__("228", "feedface")),
    ("O10", "in-flight podcast job at merge time", lambda f: f["inflight"].__setitem__("busy", 1)),
    ("O10", "scheduled podcast episode due at merge time", lambda f: f["inflight"].__setitem__("due", 1)),
    ("O10", "documentary job queued at merge time", lambda f: f["inflight"].__setitem__("documentary", 1)),
    ("O10", "production tree is not #207's tree", lambda f: f["base"].__setitem__("tree", "T-199")),
    ("O10", "140000 rolled back before O10", lambda f: f["markers"].__setitem__("140000", False)),
    ("O10", "studio rows before the merge", lambda f: f["studio"].__setitem__("rows", 1)),
    ("DONE", "#228 merged by squash (no merge commit with #228 as parent)", lambda f: f["base"].__setitem__("parents", ["P"])),
    ("DONE", "#228 merged at another head", lambda f: f["base"].__setitem__("parents", ["P", "0acef99"])),
    ("DONE", "tree after O10 is not #228's tree", lambda f: f["base"].__setitem__("tree", "T-207")),
    ("DONE", "140000 marker still f after O8", lambda f: f["markers"].__setitem__("140000", False)),
    ("DONE", "studio ledger not empty right after O8", lambda f: f["studio"].__setitem__("rows", 3)),
    ("DONE", "140000 applied but not registered", lambda f: f["registry_names"].remove(gate.MOVED["O8"])),
    ("O2", "000000 marker lost", lambda f: f["markers"].__setitem__("000000", False)),
]
for st, name, mutate in MUTATIONS:
    f = copy.deepcopy(state(st))
    mutate(f)
    check(f"stage {st}: unexpected state fails closed — {name}", len(failing(f)) >= 1)

check("unknown stage fails", failing({"next": "O6"}) != [])
check("missing facts fail", failing({"next": "O1"}) != [])
check("in-flight work is not required to be 0 for a migration stage (O2)",
      failing({**state("O2"), "inflight": {"due": 1, "busy": 1, "documentary": 1}}) == [])
check("#228 head is not required to be frozen before O10 (O8: review fixes still possible)",
      failing({**state("O8"), "heads": {**state("O8")["heads"], "228": "newhead"}}) == [])
counts = {st: len(gate.evaluate(state(st))) for st in gate.ORDER}
check(f"check counts per stage {counts}", (counts["O3"], counts["O4"], counts["O8"], counts["O10"], counts["DONE"]) == (16, 17, 13, 15, 13))
print(f"RESULT gate_test: {fails} FAIL")
sys.exit(1 if fails else 0)
