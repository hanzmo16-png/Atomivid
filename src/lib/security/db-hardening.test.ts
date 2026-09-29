/**
 * Database Security Hardening V1 — static guarantees of migration 0029 and its tooling.
 * The behavioural proof (grants, RLS, invoker view, triggers) lives in
 * supabase/migrations/verify/07_database_security_hardening_test.sql against a real Postgres;
 * this test pins what the SQL may and may not contain so a later edit cannot silently widen it.
 * No network, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const MIGRATION = "supabase/migrations/0029_database_security_hardening.sql";
const sql = fs.readFileSync(MIGRATION, "utf8");
const statements = sql
  .split("\n")
  .map((l) => l.split("--")[0].trim())
  .filter(Boolean)
  .join(" ")
  .split(";")
  .map((s) => s.trim().replace(/\s+/g, " ").toLowerCase())
  .filter(Boolean);

const HARDENED_FUNCTIONS = ["enforce_tts_monthly_limit", "enforce_user_voice_limits", "pi_reject_mutation", "pi_paid_operation_forward_only", "fc_append_only", "yt_snapshot_final"];
// Same pattern the migration runner uses to refuse destructive SQL (scripts/apply-supabase-migration.ts).
const DESTRUCTIVE = /\b(drop\s+table|drop\s+column|truncate|delete\s+from|update\s+public\.|alter\s+column\s+\w+\s+type|rename\s+(table|column))\b/i;

test("0029 never creates a permissive policy, a SECURITY DEFINER object, a grant, or destructive SQL", () => {
  const code = statements.join("; ");
  assert.ok(!/using\s*\(\s*true\s*\)/.test(code) && !/with\s+check\s*\(\s*true\s*\)/.test(code), "no USING (true) / WITH CHECK (true)");
  assert.ok(!/create\s+policy/.test(code), "no policy is created (service-role-only tables stay without policies)");
  assert.ok(!/security\s+definer/.test(code), "nothing becomes SECURITY DEFINER");
  assert.ok(!/\bgrant\b/.test(code), "no new grant");
  assert.ok(!/\bdrop\b/.test(code) && !/\bdelete\b/.test(code) && !/\btruncate\b/.test(code), "nothing dropped, deleted or truncated");
  for (const line of sql.split("\n")) assert.ok(!DESTRUCTIVE.test(line.split("--")[0]), `runner would refuse: ${line}`);
  assert.ok(!/create\s+or\s+replace\s+function/.test(code) && !/create\s+or\s+replace\s+view/.test(code), "no function body or view definition is rewritten");
});

test("0029 hardens exactly the three findings: invoker view without client access, registry RLS without policies, six pinned search_paths", () => {
  assert.ok(statements.includes("alter view public.yt_video_experiment set (security_invoker = true)"));
  assert.ok(statements.includes("revoke all on public.yt_video_experiment from anon, authenticated"));
  assert.ok(statements.includes("alter table public._migrations_applied enable row level security"));
  assert.ok(statements.includes("revoke all on public._migrations_applied from anon, authenticated"));
  assert.ok(statements.some((s) => s.startsWith("create table if not exists public._migrations_applied ( name text primary key, applied_at timestamptz not null default now() )")), "registry DDL matches the runner's");
  const pinned = statements.filter((s) => s.startsWith("alter function"));
  assert.deepEqual(pinned, HARDENED_FUNCTIONS.map((f) => `alter function public.${f}() set search_path = pg_catalog, public`));
  assert.equal(statements.length, 4 + 1 + pinned.length, "no other statement");
  assert.ok(!/service_role/.test(statements.join(" ")), "service_role privileges are never touched");
});

test("0029 is registered in the migration manifest by exact hash; production state is recorded as observed (applied by the operator after commit 8740c90)", () => {
  const manifest = JSON.parse(fs.readFileSync("supabase/migration-manifest.json", "utf8")) as { manifestVersion: number; migrations: { migrationName: string; sha256: string; knownProductionApplied: boolean }[] };
  const entry = manifest.migrations.find((m) => m.migrationName === "0029_database_security_hardening.sql");
  assert.ok(entry, "manifest entry");
  assert.equal(entry.sha256, crypto.createHash("sha256").update(fs.readFileSync(MIGRATION)).digest("hex"));
  assert.equal(entry.knownProductionApplied, true, "observed by read-only preflight run 36604539319");
  assert.ok(manifest.manifestVersion >= 5);
  assert.equal(manifest.migrations.filter((m) => m.migrationName.startsWith("0029")).length, 1);
});

test("verify test 07 covers anon, authenticated, service_role, owner/runner, triggers, idempotency and row counts", () => {
  const t = fs.readFileSync("supabase/migrations/verify/07_database_security_hardening_test.sql", "utf8");
  for (const s of ["set role anon", "set role authenticated", "set role service_role", "\\i supabase/migrations/0029_database_security_hardening.sql", "insert into public._migrations_applied (name) values ('9999_verify_probe.sql')", "sec_counts_before", "security_invoker", "search_path=pg_catalog, public", "set search_path = pg_catalog"]) assert.ok(t.includes(s), s);
  for (const f of HARDENED_FUNCTIONS) assert.ok(t.includes(`(${f})`), `trigger probe for ${f}`);
  assert.ok(fs.readFileSync("supabase/migrations/verify/README.md", "utf8").includes("07_database_security_hardening_test.sql"));
});

test("production preflight is read-only and never prints hosts or credentials", () => {
  const p = fs.readFileSync("scripts/db-security-preflight.ts", "utf8");
  assert.ok(p.includes('"begin transaction read only"') && p.includes('"rollback"'));
  assert.ok(!/password|connectionString|process\.env\.SUPABASE/i.test(p), "no credential or env access in the preflight itself");
  assert.ok(p.includes('replace(/postgres(ql)?:\\/\\/\\S+/g, "<connection>")'), "connection strings masked in errors");
  const wf = fs.readFileSync(".github/workflows/db-security-preflight.yml", "utf8");
  assert.ok(wf.includes("permissions:\n  contents: read"));
});
