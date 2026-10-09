import { test } from "node:test";
import assert from "node:assert/strict";
import { persistScriptChange, ScriptPersistenceError } from "./script-persistence";

const original = { id: "r1", user_id: "u1", status: "script_ready", render_attempts: 0, script_json: { title: "Original" } };
function database(row: typeof original, fail = false) {
  const conditions: Array<[string, unknown]> = [];
  let patch: Record<string, unknown>;
  const q = {
    update: (value: Record<string, unknown>) => { patch = value; return q; },
    eq: (key: string, value: unknown) => { conditions.push([key, key === "script_json" ? JSON.parse(value as string) : value]); return q; },
    is: (key: string, value: unknown) => { conditions.push([key, value]); return q; },
    select: async () => {
      if (fail) return { error: { message: "private database error" }, data: null };
      const matches = conditions.every(([key, value]) => JSON.stringify(row[key as keyof typeof row]) === JSON.stringify(value));
      if (matches) Object.assign(row, patch);
      return { error: null, data: matches ? [{ id: row.id }] : [] };
    },
  };
  return { from: () => q } as unknown as Parameters<typeof persistScriptChange>[0];
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
