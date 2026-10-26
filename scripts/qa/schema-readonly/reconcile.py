#!/usr/bin/env python3
"""Builds the EXACT, reversible registry reconciliation from the read-only history audit (local files only).

Inputs: history.txt (HISTORY lines printed by history.py against the production schema and both registries),
catalog.txt (markers), the migrations directory of the tree to be released, and an output directory.
Writes:
  A_register_migrations_applied.sql / .rollback.sql — public._migrations_applied (the registry the repo apply tool reads).
  B_register_schema_migrations.sql / .rollback.sql   — supabase_migrations.schema_migrations (only needed if the
                                                       Supabase CLI `db push` is ever used; optional).
A file is registered only when the production schema proves it is applied (all detectable objects present), or it has
no detectable objects and the OTHER registry already records it. Anything PARTIAL or NOT_APPLIED is listed as a blocker
and never registered. Each forward script refuses to run if any of its names is already present, so its rollback
(delete exactly those names) restores the previous registry state. Nothing here connects to a database.
"""
import os
import re
import sys

hist_path, catalog_path, mig_dir, out = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
catalog = open(catalog_path, encoding="utf-8").read()
rows = {}
for line in open(hist_path, encoding="utf-8"):
    m = re.match(r"HISTORY (migration|proposal) (\S+) schema_migrations=(yes|no) _migrations_applied=(yes|no) objects=(\d+)/(\d+) (\S+)", line.strip())
    if m:
        rows[(m.group(1), m.group(2))] = dict(sm=m.group(3) == "yes", ma=m.group(4) == "yes", have=int(m.group(5)), total=int(m.group(6)), status=m.group(7))

files = sorted(f for f in os.listdir(mig_dir) if f.endswith(".sql") and not f.endswith(".rollback.sql"))
a, b, blockers = [], [], []
for f in files:
    r = rows.get(("migration", f))
    if r is None:
        blockers.append(f"{f}: not in the history audit")
        continue
    proven = r["status"].startswith("APPLIED") or (r["status"] == "NO_DETECTABLE_OBJECTS" and (r["sm"] or r["ma"]))
    if not r["ma"]:
        (a if proven else blockers).append(f if proven else f"{f}: {r['status']} {r['have']}/{r['total']} — not registered (needs review)")
    if not r["sm"] and proven:
        b.append(f)
    if r["status"] == "PARTIAL":
        print(f"RECONCILE note {f}: PARTIAL {r['have']}/{r['total']} in production (already registered: _migrations_applied={'yes' if r['ma'] else 'no'})")
# 20261024000000 (#198) lives in supabase/proposals but is applied in production (function marker): register it too,
# so moving it into supabase/migrations later can never re-run it.
marker000 = re.search(r"^marker 20261024000000 submit refuses podcast without authorization \| t$", catalog, re.M) is not None
# Only while it is still unregistered: once registered (e.g. right after O1) it is not something left to register.
if marker000 and not rows.get(("proposal", "20261024000000_spend_authorizations.sql"), {}).get("ma", False):
    a.append("20261024000000_spend_authorizations.sql")


def quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def write(name: str, text: str) -> None:
    with open(os.path.join(out, name), "w", encoding="utf-8") as fh:
        fh.write(text)


arr_a = ",\n  ".join(quote(x) for x in a)
write("A_register_migrations_applied.sql", f"""-- OPS (not a migration). Registers in public._migrations_applied the {len(a)} files that production already has
-- (verified against the real schema by the read-only audit). Runs NO migration SQL. Refuses if any name is present.
begin;
do $$ begin
  if exists (select 1 from public._migrations_applied where name = any(array[
  {arr_a}]::text[])) then raise exception 'RECONCILE A: precondition failed — a name is already registered (registry changed since the audit)'; end if;
end $$;
insert into public._migrations_applied(name) select unnest(array[
  {arr_a}]::text[]);
do $$ begin
  if (select count(*) from public._migrations_applied where name = any(array[
  {arr_a}]::text[])) <> {len(a)} then raise exception 'RECONCILE A: postcondition failed'; end if;
end $$;
commit;
""")
write("A_register_migrations_applied.rollback.sql", f"""-- Rollback of A: removes exactly the {len(a)} names A inserted (A refuses to run if any was already there).
begin;
delete from public._migrations_applied where name = any(array[
  {arr_a}]::text[]);
commit;
""")
vals_b = ",\n  ".join(f"({quote(x.split('_', 1)[0])}, {quote(x[:-4].split('_', 1)[1])})" for x in b)
vers_b = ", ".join(quote(x.split("_", 1)[0]) for x in b)
write("B_register_schema_migrations.sql", f"""-- OPTIONAL OPS. Registers in supabase_migrations.schema_migrations (version, name) the {len(b)} repo files production
-- already has but that registry lacks. Only needed before ever using `supabase db push`. Refuses if any version exists.
begin;
do $$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = any(array[{vers_b}]::text[])) then
    raise exception 'RECONCILE B: precondition failed — a version is already registered'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values
  {vals_b};
commit;
""")
write("B_register_schema_migrations.rollback.sql", f"""begin;
delete from supabase_migrations.schema_migrations where version = any(array[{vers_b}]::text[]);
commit;
""")
for x in a:
    print(f"RECONCILE A {x}")
for x in b:
    print(f"RECONCILE B {x}")
for x in blockers:
    print(f"RECONCILE BLOCKER {x}")
print(f"RECONCILE_SUMMARY repo_migrations={len(files)} A_to_register={len(a)} B_to_register={len(b)} blockers={len(blockers)}")
