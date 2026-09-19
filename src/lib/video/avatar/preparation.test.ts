import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateToneWav } from "@/lib/providers/wav";
import { prepareAvatarRequest, preparationId } from "./preparation";
import type { SupabaseClient } from "@supabase/supabase-js";
const photo = readFileSync("scripts/test-avatar-photo.jpg");
const audio = generateToneWav({ durationSeconds: 1, frequencyHz: 220, amplitude: .1 });
function fake(corrupt = false) {
  const files = new Map<string, Buffer>();
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const service = {
    storage: { from: () => ({
      upload: async (path: string, bytes: Buffer) => { if (!files.has(path)) files.set(path, bytes); return { error: null }; },
      download: async (path: string) => ({ data: new Blob([new Uint8Array(corrupt ? Buffer.from("corrupt") : files.get(path)!)]), error: null }),
    }) },
    from: (table: string) => {
      if (!tables.has(table)) tables.set(table, new Map());
      let id: string;
      const q = {
        upsert: async (row: Record<string, unknown>) => { if (!tables.get(table)!.has(String(row.id))) tables.get(table)!.set(String(row.id), row); return { error: null }; },
        select: () => q, eq: (key: string, value: string) => { if (key === "id") id = value; return q; },
        single: async () => ({ data: tables.get(table)!.get(id), error: null }),
      }; return q;
    },
  } as unknown as SupabaseClient;
  return { service, tables };
}
test("preparation verifies stored bytes and creates one associated non-running request", async () => {
  const { service, tables } = fake();
  const a = await prepareAvatarRequest(service, "owner", photo, "image/jpeg", audio);
  const b = await prepareAvatarRequest(service, "owner", photo, "image/jpeg", audio);
  assert.equal(a.requestId, b.requestId); assert.equal(a.seconds, 1);
  const rows = tables.get("video_requests")!;
  assert.equal(rows.size, 1);
  const row = rows.get(a.requestId)!;
  assert.equal(row.status, "script_ready"); assert.equal(row.avatar_id, a.requestId);
  assert.equal(row.recorded_audio_path, `owner/${a.requestId}/recording.wav`);
  assert.equal(row.avatar_generation_started_at, undefined);
  assert.equal(tables.get("avatars")!.get(a.requestId)!.provider, "heygen");
  assert.notEqual(a.requestId, preparationId("owner", photo, audio));
});
test("corrupt saved bytes and overlong audio cannot create a renderable request", async () => {
  const f = fake(true);
  await assert.rejects(() => prepareAvatarRequest(f.service, "owner", photo, "image/jpeg", audio));
  assert.equal(f.tables.size, 0);
  const long = generateToneWav({ durationSeconds: 46, frequencyHz: 220, amplitude: .1 });
  await assert.rejects(() => prepareAvatarRequest(fake().service, "owner", photo, "image/jpeg", long));
});
test("preparation identity is scoped to owner and exact original bytes", () => {
  assert.notEqual(preparationId("owner", photo, audio), preparationId("other", photo, audio));
  assert.notEqual(preparationId("owner", photo, audio), preparationId("owner", photo, Buffer.from("other")));
});
