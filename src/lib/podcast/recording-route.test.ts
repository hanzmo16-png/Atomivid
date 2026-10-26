import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind } from "typescript";
import { isRecordingPathFor, recordingUploadPath, RECORDING_MAX_BYTES, RECORDING_MIME } from "./recording";
import { podcastAudioPath } from "./episode";

// Execute the actual POST route. Only external boundaries are substituted. Any unexpected import
// or network access fails; fake query filters are evaluated against mutable shared state at select().
const routePath = path.join(__dirname, "../../app/api/podcast/[id]/recording/route.ts");
const code = transpileModule(readFileSync(routePath, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
const owner = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const uploadPath = recordingUploadPath(owner, id);
type Fault = "claim" | "ready" | "failed" | "download" | "upload" | "cleanup" | "master" | "buffer";
type Row = Record<string, unknown>;
function fixture(options: { error?: Fault; throws?: Fault; zero?: Fault; missing?: boolean; denied?: boolean; rowOwner?: string } = {}) {
  const oldPath = podcastAudioPath({ id, user_id: owner });
  const row: Row = { id, user_id: options.rowOwner ?? owner, source: "upload", status: "ready", audio_path: oldPath, run_token: null };
  const objects = new Map([[oldPath, "previous-audio"], [uploadPath, "staged-source"]]);
  const events: string[] = [];
  const calls = { master: 0, download: 0, upload: 0, writes: 0 };
  let pause: (() => Promise<void>) | undefined;
  let serial = 0;
  const fault = (step: Fault) => { if (options.throws === step) throw new Error("PRIVATE_FAILURE"); return options.error === step; };
  const service = {
    from: () => {
      let patch: Row;
      const filters: Array<(r: Row) => boolean> = [];
      const query = {
        update: (p: Row) => { patch = p; return query; },
        eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return query; },
        in: (k: string, v: unknown[]) => { filters.push(r => v.includes(r[k])); return query; },
        select: async () => {
          const step = patch.status === "generating" ? "claim" : patch.status as "ready" | "failed";
          events.push(step); calls.writes++;
          if (fault(step)) return { error: { message: "PRIVATE_FAILURE" }, data: null };
          if (options.zero === step || !filters.every(f => f(row))) return { error: null, data: [] };
          Object.assign(row, patch);
          return { error: null, data: [{ id }] };
        },
      };
      return query;
    },
    storage: { from: () => ({
      download: async () => {
        calls.download++;
        if (fault("download")) return { data: null, error: { message: "PRIVATE_FAILURE" } };
        return { data: options.missing ? null : { arrayBuffer: async () => { fault("buffer"); return Buffer.from("source"); } } };
      },
      upload: async (p: string, bytes: Buffer, config: { upsert: boolean }) => {
        calls.upload++; events.push("upload");
        if (fault("upload")) return { error: { message: "PRIVATE_FAILURE" } };
        if (!config.upsert && objects.has(p)) return { error: { message: "exists" } };
        objects.set(p, bytes.toString()); return { error: null };
      },
      remove: async (paths: string[]) => {
        events.push("cleanup");
        if (fault("cleanup")) return { error: { message: "PRIVATE_FAILURE" } };
        paths.forEach(p => objects.delete(p)); return { error: null };
      },
      createSignedUploadUrl: async (p: string) => ({ data: { path: p, token: "fixture" }, error: null }),
    }) },
  };
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "node:crypto": { randomUUID: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}` },
    "@/lib/supabase/service": { createServiceClient: () => service },
    "@/lib/podcast/auth": { podcastUser: async () => options.denied ? { error: "No autorizado", status: 401 } : { id: owner } },
    "@/lib/podcast/server": { loadOwnedEpisode: async (_s: unknown, u: string, e: string) => row.user_id === u && row.id === e ? { ...row } : null, ensureBundledFfmpeg: () => {} },
    "@/lib/podcast/episode": { podcastAudioPath },
    "@/lib/podcast/recording": {
      isRecordingPathFor, recordingUploadPath, RECORDING_MAX_BYTES, RECORDING_MIME,
      masterRecording: async () => { calls.master++; await pause?.(); fault("master"); return { bytes: Buffer.from(`new-${serial}`), durationSeconds: 3, sha256: "fixture-sha", loudness: {} }; },
    },
    "@/lib/video/avatar/measure-narration": { measureNarrationSeconds: () => { throw new Error("real media decoding forbidden in route test"); } },
  };
  const exports: { POST?: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
  runInNewContext(code, { exports, Buffer, require: (name: string) => { assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name]; } });
  return { row, objects, oldPath, events, calls, setPause: (p: () => Promise<void>) => { pause = p; },
    post: (body: unknown = { action: "finalize", path: uploadPath }) => exports.POST!(new Request("https://fixture.invalid", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }),
  };
}

for (const step of ["claim", "ready", "failed"] as const) for (const mode of ["error", "zero"] as const) {
  test(`recording POST: ${step} ${mode} cannot confirm ready or delete source`, async () => {
    const f = fixture({ [mode]: step, missing: step === "failed" });
    const r = await f.post();
    assert.equal(r.status, step === "claim" && mode === "zero" ? 409 : 500);
    assert.ok(f.objects.has(uploadPath));
    assert.equal(f.objects.get(f.oldPath), "previous-audio", "unconfirmed replacement must not corrupt the prior audio");
    assert.doesNotMatch(await r.text(), /PRIVATE_FAILURE/);
    if (step === "claim") assert.equal(f.calls.download, 0);
  });
}
for (const step of ["claim", "ready", "failed", "download", "upload", "master", "buffer"] as const) {
  test(`recording POST: rejected ${step} returns safe JSON and preserves source`, async () => {
    const f = fixture({ throws: step, missing: step === "failed" });
    const r = await f.post();
    assert.ok(r.status >= 400);
    assert.ok((await r.json()).error);
    assert.ok(f.objects.has(uploadPath));
    assert.equal(f.objects.get(f.oldPath), "previous-audio");
  });
}
for (const mode of ["error", "throws"] as const) test(`recording POST: cleanup ${mode} cannot invalidate durable success`, async () => {
  const f = fixture({ [mode]: "cleanup" });
  assert.equal((await f.post()).status, 200);
  assert.equal(f.row.status, "ready");
  assert.ok(f.objects.has(uploadPath));
});
test("recording POST: success commits unique audio before cleanup", async () => {
  const f = fixture();
  assert.equal((await f.post()).status, 200);
  assert.equal(f.row.status, "ready");
  assert.equal(f.row.run_token, null);
  assert.notEqual(f.row.audio_path, f.oldPath);
  assert.equal(f.objects.get(f.oldPath), "previous-audio");
  assert.ok(f.objects.has(f.row.audio_path as string));
  assert.ok(!f.objects.has(uploadPath));
  assert.ok(f.events.indexOf("ready") < f.events.indexOf("cleanup"));
});
test("recording POST: two simultaneous finalizations have one winning claim", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.setPause(() => wait);
  const a = f.post(), b = f.post();
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.calls.master, 1);
  assert.equal(f.calls.upload, 1);
});
for (const failure of [false, true]) for (const changed of ["run_token", "user_id", "status"]) {
  test(`recording POST: stale ${failure ? "failure" : "success"} cannot overwrite changed ${changed}`, async () => {
    const f = fixture({ throws: failure ? "master" : undefined });
    f.setPause(async () => { f.row[changed] = changed === "status" ? "ready" : "new-owner-or-run"; });
    assert.equal((await f.post()).status, 500);
    assert.equal(f.row[changed], changed === "status" ? "ready" : "new-owner-or-run");
    assert.equal(f.objects.get(f.oldPath), "previous-audio");
    assert.ok(f.objects.has(uploadPath));
  });
}
for (const options of [{ denied: true }, { rowOwner: "other" }]) test("recording POST: auth/ownership blocks all writes", async () => {
  const f = fixture(options);
  assert.equal((await f.post()).status, options.denied ? 401 : 404);
  assert.equal(f.calls.writes, 0);
  assert.equal(f.calls.download, 0);
});
test("recording POST: malformed body and foreign path cannot claim or download", async () => {
  for (const body of [null, [], "wrong", { action: "finalize", path: "other/uploads/file" }]) {
    const f = fixture();
    assert.equal((await f.post(body)).status, 400);
    assert.equal(f.calls.writes, 0);
  }
});
