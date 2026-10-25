#!/usr/bin/env python3
"""Unit tests for plan.py (offline, USD 0): python3 -I scripts/qa/conciliacion/plan/plan_test.py"""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLAN = os.path.join(HERE, "plan.py")
FIX = os.path.join(HERE, "fixtures")
SNAP = os.path.join(FIX, "synthetic-41.snapshot.json")
EVID = os.path.join(FIX, "synthetic-41.evidence.json")
sys.path.insert(0, HERE)
import make_fixture  # noqa: E402
import plan as P  # noqa: E402


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def read_json(p):
    return json.loads(read(p))


def run(*args):
    r = subprocess.run([sys.executable, "-I", PLAN, *args], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.snap = read_json(SNAP)
        self.ev = read_json(EVID)

    def write(self, name, obj):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as f:
            f.write(obj if isinstance(obj, str) else json.dumps(obj))
        return p

    def build(self, snap=None, ev=None, now=None, out="o"):
        # unchanged inputs are passed as the committed files (same bytes → same snapshot/evidence sha256)
        args = ["build", "--snapshot", SNAP if snap is None else self.write("s.json", snap), "--out", os.path.join(self.tmp, out)]
        if ev is not None:
            args += ["--evidence", EVID if ev is self.ev else self.write("e.json", ev)]
        if now:
            args += ["--now", now]
        rc, txt = run(*args)
        plan = read_json(os.path.join(self.tmp, out, "plan.json")) if rc in (0, 3) else None
        return rc, txt, plan

    def op(self, status, i=0):
        return [o for o in self.snap["operations"] if o["status"] == status][i]

    def retotal(self, snap):
        ops = snap["operations"]
        import decimal
        by = {}
        for o in ops:
            c, r = by.get(o["status"], (0, decimal.Decimal(0)))
            by[o["status"]] = (c + 1, r + decimal.Decimal(o["reserved_usd"]))
        snap["totals"] = {"count": len(ops), "reserved_usd": str(sum(decimal.Decimal(o["reserved_usd"]) for o in ops)),
                          "by_status": {k: {"count": c, "reserved_usd": str(r)} for k, (c, r) in by.items()}}
        return snap

    def state_of(self, plan, key):
        return next(d for d in plan["decisions"] if d["op"] == key)


class Fixture(Base):
    def test_committed_fixture_is_reproducible_and_matches_the_real_composition(self):
        snap, ev = make_fixture.build(make_fixture.FIXED_TAKEN_AT)
        self.assertEqual(json.dumps(snap, indent=1) + "\n", read(SNAP))
        self.assertEqual(json.dumps(ev, indent=1) + "\n", read(EVID))
        t = snap["totals"]
        self.assertEqual((t["count"], t["reserved_usd"]), (41, "13.8919"))
        self.assertEqual({k: (v["count"], v["reserved_usd"]) for k, v in t["by_status"].items()},
                         {"RESERVED": (32, "13.3070"), "RECONCILIATION_REQUIRED": (8, "0.5849"), "SUBMITTED": (1, "0.0000")})


class Plans(Base):
    def test_default_without_evidence_is_not_ready_and_never_selects_silently(self):
        rc, _, plan = self.build()
        self.assertEqual(rc, 3)
        self.assertEqual(plan["verdict"], "NOT_READY")
        self.assertEqual(plan["counts"], {"CANDIDATE": 1, "MANUAL": 8, "READY": 32})
        for d in plan["decisions"]:
            if d["expected_status"] == "RESERVED":
                self.assertEqual((d["state"], d["outcome"]), ("READY", "cancelled_before_submission"))
            elif d["expected_status"] == "SUBMITTED":
                self.assertEqual((d["state"], d["outcome"]), ("CANDIDATE", "not_charged"))
                self.assertNotIn("decision_sha256", d)
            else:
                self.assertEqual((d["state"], d["outcome"]), ("MANUAL", "manual"))
                self.assertNotIn("decision_sha256", d)

    def test_with_complete_evidence_every_outcome_class_is_separated(self):
        rc, _, plan = self.build(ev=self.ev)
        self.assertEqual((rc, plan["verdict"]), (0, "READY"))
        got = {}
        for d in plan["decisions"]:
            got[d["outcome"]] = got.get(d["outcome"], 0) + 1
            self.assertRegex(d["decision_sha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(d["decision_id"], r"^rp1-[0-9a-f]{24}$")
        self.assertEqual(got, {"cancelled_before_submission": 32, "charged": 3, "not_charged": 3, "assumed_charged": 3})

    def test_replay_is_byte_identical_and_verify_accepts_it(self):
        self.build(ev=self.ev, out="a")
        self.build(ev=self.ev, out="b")
        for f in ("plan.json", "review.md"):
            self.assertEqual(read(os.path.join(self.tmp, "a", f)), read(os.path.join(self.tmp, "b", f)))
        rc, txt = run("verify", "--plan", os.path.join(self.tmp, "a", "plan.json"), "--snapshot", SNAP, "--evidence", EVID)
        self.assertEqual(rc, 0, txt)

    def test_hash_matches_the_tool_formula_and_every_field_changes_it(self):
        base = ("rp1-0123456789abcdef01234567", "k-" + "a" * 32, "RECONCILIATION_REQUIRED", "2026-10-20T01:02:03.000004Z",
                "charged", "synthetic:ref", P.decimal.Decimal("0.05"), False)
        h = P.decision_sha256(*base)
        # jsonb::text of the array the tool hashes (amount scaled to numeric(12,4))
        self.assertEqual(P.jsonb_text([base[0], base[1], base[2], base[3], base[4], base[5], "0.0500", False]),
                         '["rp1-0123456789abcdef01234567", "k-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "RECONCILIATION_REQUIRED", '
                         '"2026-10-20T01:02:03.000004Z", "charged", "synthetic:ref", "0.0500", false]')
        self.assertEqual(P.decision_sha256(*base[:6], P.decimal.Decimal("0.0500"), False), h, "0.05 and 0.0500 are the same amount")
        variants = [("rp1-x" + "0" * 23,), (None, "k-" + "b" * 32), (None, None, "SUBMITTED"), (None, None, None, "2026-10-20T01:02:03.000005Z"),
                    (None, None, None, None, "assumed_charged"), (None, None, None, None, None, "synthetic:ref2"),
                    (None, None, None, None, None, None, P.decimal.Decimal("0.0501")), (None, None, None, None, None, None, None, True)]
        for v in variants:
            args = [b if i >= len(v) or v[i] is None else v[i] for i, b in enumerate(base)]
            self.assertNotEqual(P.decision_sha256(*args), h, v)

    def test_a_changed_row_or_evidence_or_tampered_plan_invalidates_the_plan(self):
        self.build(ev=self.ev, out="a")
        p = os.path.join(self.tmp, "a", "plan.json")
        s2 = copy.deepcopy(self.snap)
        o = self.op("RESERVED", 3)
        next(x for x in s2["operations"] if x["op"] == o["op"])["updated_at"] = "2026-10-20T00:00:00.000001Z"
        rc, txt = run("verify", "--plan", p, "--snapshot", self.write("s2.json", s2), "--evidence", EVID)
        self.assertEqual(rc, 1, txt); self.assertIn("INVALID", txt)
        e2 = copy.deepcopy(self.ev); e2["items"][0]["evidence"] += "x"
        rc, txt = run("verify", "--plan", p, "--snapshot", SNAP, "--evidence", self.write("e2.json", e2))
        self.assertEqual(rc, 1, txt)
        t = read_json(p); d = next(x for x in t["decisions"] if x["outcome"] == "assumed_charged"); d["outcome"] = "not_charged"
        rc, txt = run("verify", "--plan", self.write("t.json", t), "--snapshot", SNAP, "--evidence", EVID)
        self.assertEqual(rc, 1, txt)

    def test_contradictory_concurrent_plans_share_decision_ids_but_not_hashes(self):
        """Two operators, same snapshot, contradictory evidence: the tool's replay rule (same decision_id, different
        hash → refused; one decision per operation) lets only the first one through."""
        _, _, a = self.build(ev=self.ev, out="a")
        e2 = copy.deepcopy(self.ev)
        it = next(i for i in e2["items"] if i["outcome"] == "charged"); it["outcome"] = "assumed_charged"; it.pop("actual_usd")
        _, _, b = self.build(ev=e2, out="b")
        da, db = self.state_of(a, it["op"]), self.state_of(b, it["op"])
        self.assertEqual(da["decision_id"], db["decision_id"])
        self.assertNotEqual(da["decision_sha256"], db["decision_sha256"])
        log, per_op = {}, {}

        def tool(d):
            if d["decision_id"] in log:
                return "replayed" if log[d["decision_id"]] == d["decision_sha256"] else "refused: different parameters"
            if d["op"] in per_op:
                return "refused: already reconciled"
            log[d["decision_id"]] = d["decision_sha256"]; per_op[d["op"]] = d["decision_id"]
            return "applied"
        self.assertEqual([tool(da), tool(db), tool(da)], ["applied", "refused: different parameters", "replayed"])
        self.assertNotEqual(a["plan_sha256"], b["plan_sha256"])


class FailClosed(Base):
    def invalid(self, snap=None, ev=None, needle=""):
        rc, txt, _ = self.build(snap=snap, ev=ev)
        self.assertEqual(rc, 1, txt)
        self.assertIn(needle, txt)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "o", "plan.json")), "nothing written on invalid input")

    def test_structural_errors_write_nothing(self):
        s = copy.deepcopy(self.snap); s["operations"].append(copy.deepcopy(s["operations"][0])); self.invalid(self.retotal(s), needle="duplicate operation")
        s = copy.deepcopy(self.snap); s["operations"][0]["status"] = "COMMITTED"; self.invalid(s, needle="final status")
        s = copy.deepcopy(self.snap); s["operations"][0]["status"] = "REFUNDED"; self.invalid(s, needle="final status")
        s = copy.deepcopy(self.snap); s["complete"] = False; self.invalid(s, needle="partial snapshot")
        s = copy.deepcopy(self.snap); s["operations"].pop(); self.invalid(s, needle="does not add up")
        s = copy.deepcopy(self.snap); s["operations"][0]["reserved_usd"] = "0.2400"; self.invalid(s, needle="does not add up")
        s = copy.deepcopy(self.snap); s["totals"]["by_status"]["RESERVED"]["count"] = 31; self.invalid(s, needle="per-status")
        s = copy.deepcopy(self.snap); s["operations"][0]["reserved_usd"] = "-0.2300"; self.invalid(s, needle="non-negative")
        s = copy.deepcopy(self.snap); s["operations"][0]["reserved_usd"] = "0.23001"; self.invalid(s, needle="at most 4 decimals")
        s = copy.deepcopy(self.snap); s["operations"][0]["op"] = "op_0b6c4c8e2f1a4b4f9f1e2d3c4b5a6978"; self.invalid(s, needle="pseudonym")
        s = copy.deepcopy(self.snap); s["operations"][0]["prompt"] = "x"; self.invalid(s, needle="fields must be exactly")
        s = copy.deepcopy(self.snap); s["operations"][0]["updated_at"] = "2026-10-20 00:00:00"; self.invalid(s, needle="UTC ISO-8601")
        s = copy.deepcopy(self.snap); s["operations"][0]["updated_at"] = "2026-10-26T00:00:00Z"; self.invalid(s, needle="after the snapshot")
        s = copy.deepcopy(self.snap); s["operations"][0]["supply_reconciled"] = True; self.invalid(s, needle="supply_reconciled")
        s = copy.deepcopy(self.snap); s["format"] = "v0"; self.invalid(s, needle="format")
        self.invalid(json.dumps(self.snap).replace('"reserved_usd": "0.2300"', '"reserved_usd": 0.23', 1), needle="numbers must be strings")
        self.invalid('{"format": "a", "format": "b"}', needle="duplicate field")

    def test_evidence_errors_write_nothing(self):
        e = copy.deepcopy(self.ev); e["items"][0]["op"] = "k-" + "f" * 32; self.invalid(ev=e, needle="not in the snapshot")
        e = copy.deepcopy(self.ev); e["items"].append(copy.deepcopy(e["items"][0])); self.invalid(ev=e, needle="same operation")
        e = copy.deepcopy(self.ev); e["items"][0]["evidence"] = "  "; self.invalid(ev=e, needle="printable")
        e = copy.deepcopy(self.ev); e["items"][0]["evidence"] = "see https://platform.example/usage"; self.invalid(ev=e, needle="URL")
        e = copy.deepcopy(self.ev); e["items"][0]["evidence"] = "job 0b6c4c8e-2f1a-4b4f-9f1e-2d3c4b5a6978"; self.invalid(ev=e, needle="UUID")
        e = copy.deepcopy(self.ev); e["items"][0]["outcome"] = "refund"; self.invalid(ev=e, needle="unknown outcome")
        e = copy.deepcopy(self.ev); e["items"][0]["actual_usd"] = "-1"; self.invalid(ev=e, needle="non-negative")

    def test_per_operation_refusals_block_the_plan(self):
        rr0, rr1 = self.op("RECONCILIATION_REQUIRED", 0), self.op("RECONCILIATION_REQUIRED", 1)
        res = self.op("RESERVED", 0)
        cases = [
            ({"op": rr0["op"], "outcome": "charged", "evidence": "synthetic:ref"}, rr0, "BLOCKED", "provider amount"),
            ({"op": rr0["op"], "outcome": "charged", "evidence": "synthetic:ref", "actual_usd": "0.0500"}, rr0, "BLOCKED", "exceeds the reservation"),
            ({"op": rr0["op"], "outcome": "assumed_charged", "evidence": "synthetic:ref", "actual_usd": "0.0400"}, rr0, "BLOCKED", "do not pass one"),
            ({"op": rr0["op"], "outcome": "not_charged", "evidence": "synthetic:ref", "actual_usd": "0.0400"}, rr0, "BLOCKED", "no amount"),
            ({"op": rr0["op"], "outcome": "cancelled_before_submission", "evidence": "synthetic:ref"}, rr0, "BLOCKED", "only for RESERVED"),
            ({"op": rr0["op"], "outcome": "manual", "evidence": "synthetic:ref"}, rr0, "MANUAL", "manual"),
            ({"op": res["op"], "outcome": "charged", "evidence": "synthetic:ref", "actual_usd": "0.2300"}, res, "BLOCKED", "never reached"),
            ({"op": res["op"], "outcome": "not_charged", "evidence": "synthetic:ref"}, res, "BLOCKED", "never reached"),
        ]
        for item, o, state, why in cases:
            e = {"format": self.ev["format"], "items": [item]}
            rc, txt, plan = self.build(ev=e)
            d = self.state_of(plan, o["op"])
            self.assertEqual((rc, d["state"]), (3, state), item)
            self.assertIn(why, " ".join(d["reasons"]), item)
            self.assertNotIn("decision_sha256", d)
        e = {"format": self.ev["format"], "items": [{"op": rr1["op"], "outcome": "charged", "evidence": "synthetic:ref", "actual_usd": "0.0500", "allow_over_reserved": True}]}
        _, _, plan = self.build(ev=e)
        d = self.state_of(plan, rr1["op"])
        self.assertEqual((d["state"], d["actual_usd"], d["allow_over_reserved"]), ("READY", "0.0500", True))

    def test_fresh_rows_and_provider_data_on_reserved(self):
        s = copy.deepcopy(self.snap)
        s["operations"][0]["updated_at"] = "2026-10-24T01:00:00.000000Z"  # 23 h before the snapshot
        s["operations"][1]["has_provider_job"] = True
        rc, _, plan = self.build(snap=s, ev=self.ev)
        self.assertEqual(rc, 3)
        self.assertEqual(self.state_of(plan, s["operations"][0]["op"])["state"], "BLOCKED")
        self.assertEqual(self.state_of(plan, s["operations"][1]["op"])["state"], "MANUAL")
        # --now later than the snapshot cannot rescue a row, and a row old at the snapshot is also checked against --now
        rc, _, plan = self.build(ev=self.ev, now="2026-10-25T06:00:00Z")
        self.assertEqual(rc, 0)
        rc, txt, _ = self.build(ev=self.ev, now="2026-10-24T00:00:00Z")
        self.assertEqual(rc, 1); self.assertIn("before the snapshot", txt)


class NoExecution(Base):
    def test_no_apply_mode_and_no_sql_in_any_output(self):
        for flag in ("--emit-sql", "--apply", "--sql", "--execute"):
            rc, txt = run("build", "--snapshot", SNAP, "--out", self.tmp, flag)
            self.assertEqual(rc, 2, flag); self.assertIn("no apply/SQL mode", txt)
        self.build(ev=self.ev)
        for f in ("plan.json", "review.md"):
            body = read(os.path.join(self.tmp, "o", f))
            self.assertIsNone(re.search(r"(?i)\b(update|insert|delete)\s+(into\s+)?public\.|\bselect\s+public\.|pi_reconcile_open_operation\s*\(|\bbegin;", body), f)
            for key in re.findall(r"k-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", body):
                self.assertTrue(key.startswith("k-"), "only redacted pseudonyms appear")


if __name__ == "__main__":
    unittest.main(verbosity=1)
