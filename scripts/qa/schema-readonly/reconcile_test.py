#!/usr/bin/env python3
"""Offline test of reconcile.py (no database): 20261024000000 (#198 proposal, applied in production) is proposed for
registration only while it is unregistered. Regression of o1-ejecucion-unica run 40395208058: after O1 registered it,
reconcile.py still listed it, so the O2 gate saw «regenerated A has 1 names» although nothing was left to register."""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
P = "20261024000000_spend_authorizations.sql"
fails = 0


def run(prop_registered: bool, mig_registered: bool):
    with tempfile.TemporaryDirectory() as t:
        mig = os.path.join(t, "migrations"); os.makedirs(mig)
        open(os.path.join(mig, "20261005143935_provider_supply_controls.sql"), "w").write("select 1;\n")
        hist = os.path.join(t, "history.txt")
        with open(hist, "w") as h:
            h.write(f"HISTORY migration 20261005143935_provider_supply_controls.sql schema_migrations=no _migrations_applied={'yes' if mig_registered else 'no'} objects=2/2 APPLIED\n")
            h.write(f"HISTORY proposal {P} schema_migrations=no _migrations_applied={'yes' if prop_registered else 'no'} objects=3/3 APPLIED\n")
        cat = os.path.join(t, "catalog.txt")
        open(cat, "w").write("marker 20261024000000 submit refuses podcast without authorization | t\n")
        out = subprocess.run([sys.executable, "-I", os.path.join(HERE, "reconcile.py"), hist, cat, mig, os.path.join(t, "out")],
                             capture_output=True, text=True, check=True).stdout
        return sorted(l.split(" ", 2)[2] for l in out.splitlines() if l.startswith("RECONCILE A "))


def check(name, got, want):
    global fails
    ok = got == want
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": got {got}, want {want}"))
    fails += 0 if ok else 1


check("before O1: the migration and the applied proposal are both registered by A",
      run(prop_registered=False, mig_registered=False), sorted(["20261005143935_provider_supply_controls.sql", P]))
check("after O1: nothing left to register (the proposal is already in _migrations_applied)",
      run(prop_registered=True, mig_registered=True), [])
check("only the proposal still unregistered: A lists exactly it",
      run(prop_registered=False, mig_registered=True), [P])
print(f"RESULT reconcile_test: {fails} FAIL")
sys.exit(1 if fails else 0)
