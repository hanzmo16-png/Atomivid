/**
 * PI V2 Fase B3.2 (RB-06): migration 0032 revokes client writes on public.avatars and the one
 * legitimate insert runs with the service role. Behaviour is proven on a real Postgres by
 * supabase/migrations/verify/10_completed_row_and_avatar_guard_test.sql; this pins text and wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const FILE = "supabase/migrations/0032_avatar_write_guard.sql";
const code = fs.readFileSync(FILE, "utf8").replace(/--.*$/gm, "").trim();

test("0032 only revokes client INSERT/UPDATE on avatars: no policy, trigger, grant, service_role or data change", () => {
  assert.equal(code, "revoke insert, update on public.avatars from anon, authenticated;");
});

test("0032 is registered in the manifest by exact hash and recorded as NOT applied in production", () => {
  const manifest = JSON.parse(fs.readFileSync("supabase/migration-manifest.json", "utf8")) as { migrations: { migrationName: string; sha256: string; knownProductionApplied: boolean }[] };
  const entries = manifest.migrations.filter((m) => m.migrationName.startsWith("0032"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sha256, crypto.createHash("sha256").update(fs.readFileSync(FILE)).digest("hex"));
  assert.equal(entries[0].knownProductionApplied, false);
});

test("the app writes avatars only through the service role; the session client only reads them", () => {
  const actions = fs.readFileSync("src/app/dashboard/new/actions.ts", "utf8");
  assert.match(actions, /await service\s*\.from\("avatars"\)\s*\.insert\(\{/, "avatar insert uses the service client");
  assert.match(actions, /user_id: user\.id,\s*name: avatarName/, "user_id is the verified session user");
  assert.ok(!/supabase\s*\.from\("avatars"\)\s*\.(insert|update|upsert|delete)\(/.test(actions), "no session-client write to avatars");
});

