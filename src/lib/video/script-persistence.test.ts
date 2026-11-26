import { test } from "node:test";
import assert from "node:assert/strict";
import { persistScriptChange, ScriptPersistenceError } from "./script-persistence";

const original = { id: "r1", user_id: "u1", status: "script_ready", render_attempts: 0, script_json: { title: "Original" } };
function database(row: typeof original, fail = false, afterRead?: () => void, revision: unknown = "101") {
  let version = revision;
  const matches = (conditions: Array<[string, unknown]>) => conditions.every(([key, value]) =>
    key === "xmin" ? String(version) === value : assert.deepEqual(row[key as keyof typeof row], value) === undefined);
  const chain = (conditions: Array<[string, unknown]>) => ({
    eq(key: string, value: unknown) { conditions.push([key, value]); return this; },
  });
  return { from: () => ({
    select: () => {
      const conditions: Array<[string, unknown]> = [];
      return { ...chain(conditions), async maybeSingle() {
        if (fail) return { error: { message: "private database error" }, data: null };
        let ok = false; try { ok = matches(conditions); } catch { /* filter mismatch */ }
        const data = ok ? { id: row.id, script_json: structuredClone(row.script_json), xmin: version } : null;
        afterRead?.(); if (afterRead) version = "102";
        return { error: null, data };
      } };
    },
    update: (patch: Record<string, unknown>) => {
      const conditions: Array<[string, unknown]> = [];
      return { ...chain(conditions), async select() {
        if (fail) return { error: { message: "private database error" }, data: null };
        let ok = false; try { ok = matches(conditions); } catch { /* filter mismatch */ }
        assert.ok(!conditions.some(([key]) => key === "script_json"), "no full JSON in a URL filter");
        assert.ok(conditions.some(([key]) => key === "xmin"), "atomic row-version fence required");
        if (ok) { Object.assign(row, patch); version = "103"; }
        return { error: null, data: ok ? [{ id: row.id }] : [] };
      } };
    },
  }) } as unknown as Parameters<typeof persistScriptChange>[0];
}

test("a database failure cannot report the script saved", async () => {
  await assert.rejects(persistScriptChange(database({ ...original }, true), original, { script_json: { title: "New" } }),
    (e: unknown) => e instanceof ScriptPersistenceError && e.status === 500 && !e.message.includes("private"));
});

test("a render starting during an edit is never overwritten", async () => {
  const row = { ...original, status: "processing", render_attempts: 1 };
  await assert.rejects(persistScriptChange(database(row), original, { status: "script_ready" }),
    (e: unknown) => e instanceof ScriptPersistenceError && e.status === 409);
  assert.equal(row.status, "processing");
});

test("an older tab cannot overwrite a newer saved script", async () => {
  const row = { ...original, script_json: { title: "Other tab" } };
  await assert.rejects(persistScriptChange(database(row), original, { script_json: { title: "Stale" } }), ScriptPersistenceError);
  assert.equal(row.script_json.title, "Other tab");
});

test("an unchanged owned request saves the new script", async () => {
  const row = { ...original };
  await persistScriptChange(database(row), original, { script_json: { title: "Saved" } });
  assert.equal(row.script_json.title, "Saved");
});

test("a replaced owner is never writable", async () => {
  const row = { ...original, user_id: "u2" };
  await assert.rejects(persistScriptChange(database(row), original, { script_json: {} }), ScriptPersistenceError);
});

test("a real-sized documentary saves without a JSON equality URL", async () => {
  const row = { ...original, script_json: { title: "X".repeat(60_000) } };
  const expected = structuredClone(row);
  await persistScriptChange(database(row), expected, { script_json: { title: "Saved" } });
  assert.equal(row.script_json.title, "Saved");
});

test("a concurrent edit between snapshot and update wins; the stale writer is rejected", async () => {
  const row = { ...original };
  const db = database(row, false, () => { row.script_json = { title: "Concurrent winner" }; });
  await assert.rejects(persistScriptChange(db, original, { script_json: { title: "Stale" } }),
    (e: unknown) => e instanceof ScriptPersistenceError && e.status === 409);
  assert.equal(row.script_json.title, "Concurrent winner");
});

test("a render starting after the snapshot is also fenced", async () => {
  const row = { ...original };
  const db = database(row, false, () => { row.status = "processing"; row.render_attempts = 1; });
  await assert.rejects(persistScriptChange(db, original, { status: "script_ready" }), ScriptPersistenceError);
  assert.equal(row.status, "processing");
});

for (const revision of [undefined, null, "", "0", "bad", "4294967296"]) test(`unavailable/invalid row version blocks saving: ${String(revision)}`, async () => {
  const row = { ...original };
  await assert.rejects(persistScriptChange(database(row, false, undefined, revision === undefined ? "" : revision), original, { script_json: { title: "Unsafe" } }),
    (e: unknown) => e instanceof ScriptPersistenceError && e.status === 500);
  assert.equal(row.script_json.title, "Original");
});
