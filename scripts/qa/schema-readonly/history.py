#!/usr/bin/env python3
"""READ-ONLY migration history audit (runs on the runner, on local files only).

Inputs: registered.txt (``version|name`` lines read from production's supabase_migrations.schema_migrations),
a migrations directory, a proposals directory and the schema-only pg_dump of production (public schema).
For every repo migration/proposal it lists the objects the file creates (tables, columns, functions, indexes,
policies, triggers, views) and checks each one in the production dump, so the verdict does not depend on how the
migration was registered. Prints one line per file and a summary; never connects to any database.
"""
import os
import re
import sys

reg_path, mig_dir, prop_dir, dump_path = sys.argv[1:5]
dump = open(dump_path, encoding="utf-8", errors="replace").read()
registered = []
for line in open(reg_path, encoding="utf-8"):
    line = line.strip()
    if not line or "|" not in line:
        continue
    v, n = (x.strip() for x in line.split("|", 1))
    registered.append((v, n))
reg_versions = {v for v, _ in registered}
reg_names = {n for _, n in registered if n}

ID = r'"?([A-Za-z_][A-Za-z0-9_]*)"?'
SCHEMA = r'(?:"?public"?\.)?'
tables = {m.group(1): m.group(2) for m in re.finditer(r"CREATE TABLE public\.(\w+) \((.*?)\n\);", dump, re.S)}
columns = {t: {ln.strip().split()[0].strip('"') for ln in body.split("\n") if ln.strip() and not ln.strip().upper().startswith(("CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"))} for t, body in tables.items()}
functions = set(re.findall(r"CREATE FUNCTION public\.(\w+)\(", dump))
indexes = set(re.findall(r"CREATE (?:UNIQUE )?INDEX (\w+) ON", dump))
policies = set(re.findall(r'CREATE POLICY "?([^"]+?)"? ON public\.', dump))
triggers = set(re.findall(r"CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER (\w+)", dump))
views = set(re.findall(r"CREATE (?:OR REPLACE )?(?:MATERIALIZED )?VIEW public\.(\w+)", dump))


def strip_comments(sql: str) -> str:
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"/\*.*?\*/", "", sql, flags=re.S)


def objects(sql: str):
    s = strip_comments(sql)
    out = []
    dropped = set(m.group(1).lower() for m in re.finditer(r"drop (?:table|function|view|index|trigger|policy)\s+(?:if exists\s+)?" + SCHEMA + ID, s, re.I))
    for m in re.finditer(r"create\s+table\s+(?:if\s+not\s+exists\s+)?" + SCHEMA + ID, s, re.I):
        out.append(("table", m.group(1), m.group(1) in tables))
    for m in re.finditer(r"alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?" + SCHEMA + ID + r"(.*?);", s, re.I | re.S):
        t = m.group(1)
        for c in re.finditer(r"add\s+column\s+(?:if\s+not\s+exists\s+)?" + ID, m.group(2), re.I):
            out.append(("column", f"{t}.{c.group(1)}", c.group(1) in columns.get(t, set())))
    for m in re.finditer(r"create\s+(?:or\s+replace\s+)?function\s+" + SCHEMA + ID, s, re.I):
        out.append(("function", m.group(1), m.group(1) in functions))
    for m in re.finditer(r"create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?" + ID, s, re.I):
        out.append(("index", m.group(1), m.group(1) in indexes))
    for m in re.finditer(r'create\s+policy\s+"([^"]+)"|create\s+policy\s+(\w+)', s, re.I):
        n = m.group(1) or m.group(2)
        out.append(("policy", n, n in policies))
    for m in re.finditer(r"create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+" + ID, s, re.I):
        out.append(("trigger", m.group(1), m.group(1) in triggers))
    for m in re.finditer(r"create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+" + SCHEMA + ID, s, re.I):
        out.append(("view", m.group(1), m.group(1) in views))
    # objects the same file drops later are expected to be absent
    seen, uniq = set(), []
    for kind, name, ok in out:
        if (kind, name) in seen or name.lower() in dropped:
            continue
        seen.add((kind, name))
        uniq.append((kind, name, ok))
    return uniq


def classify(path: str, registered_flag: bool):
    objs = objects(open(path, encoding="utf-8", errors="replace").read())
    have = sum(1 for o in objs if o[2])
    if not objs:
        status = "NO_DETECTABLE_OBJECTS"
    elif have == len(objs):
        status = "APPLIED" + ("" if registered_flag else "_UNREGISTERED")
    elif have == 0:
        status = "NOT_APPLIED" + ("_BUT_REGISTERED" if registered_flag else "")
    else:
        status = "PARTIAL"
    missing = [f"{k}:{n}" for k, n, ok in objs if not ok]
    return status, have, len(objs), missing


summary = {}
matched_registry = set()
for label, d in (("migration", mig_dir), ("proposal", prop_dir)):
    for f in sorted(os.listdir(d)):
        if not f.endswith(".sql") or f.endswith(".rollback.sql"):
            continue
        version, _, rest = f[:-4].partition("_")
        is_reg = version in reg_versions or rest in reg_names
        if version in reg_versions:
            matched_registry.add(version)
        for v, n in registered:
            if n and n == rest:
                matched_registry.add(v)
        status, have, total, missing = classify(os.path.join(d, f), is_reg)
        summary[(label, status)] = summary.get((label, status), 0) + 1
        extra = f" missing={','.join(missing[:6])}{'…' if len(missing) > 6 else ''}" if missing else ""
        print(f"HISTORY {label} {f} registered={'yes' if is_reg else 'no'} objects={have}/{total} {status}{extra}")
for v, n in registered:
    if v not in matched_registry:
        print(f"HISTORY registry-only {v} {n or '(sin nombre)'} — registered in production, no file with this version/name in the repo")
print("HISTORY_SUMMARY " + " ".join(f"{label}:{status}={n}" for (label, status), n in sorted(summary.items())))
