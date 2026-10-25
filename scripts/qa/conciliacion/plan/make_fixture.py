#!/usr/bin/env python3
"""Synthetic snapshot + evidence for plan.py: 32 RESERVED + 8 RECONCILIATION_REQUIRED + 1 SUBMITTED (internal).

Amounts follow the published per-provider aggregates of the 41 open operations (USD 13.8919); keys are pseudonyms of
synthetic names, so nothing here is a production identifier. Default output = the committed fixtures (fixed clock);
--taken-at lets the disposable-PostgreSQL check build a snapshot relative to the real clock.

  make_fixture.py OUT_DIR [--taken-at ISO]
"""
import datetime as dt
import decimal
import hashlib
import json
import os
import sys

FIXED_TAKEN_AT = "2026-10-25T00:00:00Z"
# (status, provider, method, reserved_usd) — same composition as the 41 real open operations, amounts split evenly.
ROWS = ([("RESERVED", "openai", "image", "0.2300")] * 27
        + [("RESERVED", "openai", "podcast_image", "0.1200"), ("RESERVED", "heygen", "podcast_video", "6.5800"),
           ("RESERVED", "anthropic", "script", "0.1499"), ("RESERVED", "anthropic", "script", "0.1498"),
           ("RESERVED", "elevenlabs", "narration", "0.0973")]
        + [("RECONCILIATION_REQUIRED", "anthropic", "script", a) for a in ("0.0467", "0.0466", "0.0466")]
        + [("RECONCILIATION_REQUIRED", "openai", "podcast_image", "0.4000")]
        + [("RECONCILIATION_REQUIRED", "openai", "visual_review", "0.0050")] * 3
        + [("RECONCILIATION_REQUIRED", "bfl", "image", "0.0300"), ("SUBMITTED", "internal", "capacity_check", "0.0000")])


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond:06d}Z"


def build(taken_at):
    taken = dt.datetime.strptime(taken_at.replace("Z", ""), "%Y-%m-%dT%H:%M:%S" + (".%f" if "." in taken_at else "")).replace(tzinfo=dt.timezone.utc)
    ops = []
    for i, (st, prov, meth, usd) in enumerate(ROWS):
        ops.append({"op": "k-" + hashlib.md5(f"synthetic-open-op-{i:02d}".encode()).hexdigest(), "status": st,
                    "updated_at": iso(taken - dt.timedelta(days=3 + i % 9, minutes=17 * i, microseconds=123457 * (i + 1) % 1000000)),
                    "provider": prov, "method": meth, "reserved_usd": usd, "committed_usd": None,
                    "has_provider_job": False, "has_result_ref": False, "supply_reconciled": False})
    by = {}
    for o in ops:
        c, r = by.get(o["status"], (0, decimal.Decimal(0)))
        by[o["status"]] = (c + 1, r + decimal.Decimal(o["reserved_usd"]))
    total = sum(decimal.Decimal(o["reserved_usd"]) for o in ops)
    snap = {"format": "atomivid.reconcile-snapshot/v1", "source": "synthetic-fixture", "taken_at": taken_at, "complete": True,
            "totals": {"count": len(ops), "reserved_usd": str(total), "by_status": {k: {"count": c, "reserved_usd": str(r)} for k, (c, r) in sorted(by.items())}},
            "operations": ops}
    rr = [o for o in ops if o["status"] == "RECONCILIATION_REQUIRED"]
    sub = [o for o in ops if o["status"] == "SUBMITTED"]
    items = [
        {"op": rr[0]["op"], "outcome": "charged", "evidence": "synthetic:anthropic-usage-export:row-01", "actual_usd": "0.0412"},
        {"op": rr[1]["op"], "outcome": "charged", "evidence": "synthetic:anthropic-usage-export:row-02", "actual_usd": "0.0466"},
        {"op": rr[2]["op"], "outcome": "not_charged", "evidence": "synthetic:anthropic-usage-export:no-row"},
        {"op": rr[3]["op"], "outcome": "not_charged", "evidence": "synthetic:openai-usage-export:no-image-in-window"},
        {"op": rr[4]["op"], "outcome": "assumed_charged", "evidence": "synthetic:openai-usage-not-itemized"},
        {"op": rr[5]["op"], "outcome": "assumed_charged", "evidence": "synthetic:openai-usage-not-itemized"},
        {"op": rr[6]["op"], "outcome": "assumed_charged", "evidence": "synthetic:openai-usage-not-itemized"},
        {"op": rr[7]["op"], "outcome": "charged", "evidence": "synthetic:bfl-credit-ledger:row-09", "actual_usd": "0.0300"},
        {"op": sub[0]["op"], "outcome": "not_charged", "evidence": "synthetic:internal-provider:no-external-call"},
    ]
    return snap, {"format": "atomivid.reconcile-evidence/v1", "items": items}


def main(argv):
    out = argv[0]
    taken = argv[argv.index("--taken-at") + 1] if "--taken-at" in argv else FIXED_TAKEN_AT
    snap, ev = build(taken)
    os.makedirs(out, exist_ok=True)
    for name, obj in (("synthetic-41.snapshot.json", snap), ("synthetic-41.evidence.json", ev)):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(json.dumps(obj, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
