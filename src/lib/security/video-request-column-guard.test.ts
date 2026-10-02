/**
 * PI V2 Fase B3.1 (RB-06): migration 0031 pins which video_requests columns a client may write.
 * The behaviour is proven on a real Postgres by supabase/migrations/verify/09_video_request_column_guard_test.sql;
 * this unit test pins the migration text and its manifest registration so the guard cannot drift silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const FILE = "supabase/migrations/0031_video_request_column_guard.sql";
const sql = fs.readFileSync(FILE, "utf8");
const code = sql.replace(/--.*$/gm, "");
const PROTECTED = ["video_path", "created_at", "render_attempts", "long_form_production_plan", "long_form_confirmed_at"];

test("0031 revokes client INSERT/UPDATE on video_requests and re-grants every column except the five protected ones", () => {
  assert.match(code, /revoke insert, update on public\.video_requests from anon, authenticated;/);
  const excluded = /column_name not in \(([^)]*)\)/.exec(code);
  assert.ok(excluded, "exclusion list present");
  assert.deepEqual(excluded![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort(), [...PROTECTED].sort());
  assert.match(code, /grant insert \(%s\), update \(%s\) on public\.video_requests to anon, authenticated/);
});

test("0031 adds restrictive policies only: own user_id and status pending|script_ready; existing policies, service_role and triggers untouched", () => {
  for (const cmd of ["insert", "update"]) {
    const re = new RegExp(`create policy "Clients ${cmd} only their own pre-render rows"\\s+on public\\.video_requests\\s+as restrictive\\s+for ${cmd}\\s+to anon, authenticated`);
    assert.match(code, re, `${cmd} policy`);
  }
  assert.equal((code.match(/status in \('pending', 'script_ready'\)/g) ?? []).length, 2);
  assert.equal((code.match(/user_id = auth\.uid\(\)/g) ?? []).length, 3);
  assert.ok(!/service_role/.test(code), "service_role is not touched");
  assert.ok(!/create (or replace )?trigger|create (or replace )?function/i.test(code), "no trigger");
  assert.ok(!/Users can (insert|view) their own video requests/.test(code), "0001 policies are not rewritten");
  assert.ok(!/\b(delete|truncate|drop table|drop column|alter table)\b/i.test(code), "no data or schema change");
  // Only video_requests is touched.
  for (const m of code.matchAll(/\bon public\.(\w+)/g)) assert.equal(m[1], "video_requests");
});

test("0031 is registered in the manifest by exact hash and recorded as NOT applied in production", () => {
  const manifest = JSON.parse(fs.readFileSync("supabase/migration-manifest.json", "utf8")) as { migrations: { migrationName: string; sha256: string; knownProductionApplied: boolean }[] };
  const entries = manifest.migrations.filter((m) => m.migrationName.startsWith("0031"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].migrationName, "0031_video_request_column_guard.sql");
  assert.equal(entries[0].sha256, crypto.createHash("sha256").update(fs.readFileSync(FILE)).digest("hex"));
  assert.equal(entries[0].knownProductionApplied, false);
});

test("the app's own client inserts write none of the protected columns (so 0031 does not break them)", () => {
  for (const file of ["src/app/dashboard/new/actions.ts", "src/app/dashboard/long-form/new/actions.ts"]) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\("video_requests"\)\s*\.insert\(\{([\s\S]*?)\}\)/g)) {
      for (const col of PROTECTED) assert.ok(!new RegExp(`\\b${col}\\s*:`).test(m[1]), `${file} inserts ${col}`);
    }
  }
});
