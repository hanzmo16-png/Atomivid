import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupSharedStock, placeStockClip, sharedStockPath } from "./stock-cache";

type Obj = { name: string; metadata: { size: number } };
function fakeStorage(objects: Record<string, number>, opts: { listError?: string; throws?: boolean } = {}) {
  const calls: { folder: string; search?: string }[] = [];
  const storage = { from: () => ({ list: async (folder: string, o?: { search?: string }) => {
    calls.push({ folder, search: o?.search });
    if (opts.throws) throw new Error("network down");
    if (opts.listError) return { data: null, error: { message: opts.listError } };
    const data: Obj[] = Object.entries(objects).filter(([p]) => p.startsWith(folder + "/") && p.includes(o?.search ?? ""))
      .map(([p, size]) => ({ name: p.slice(folder.length + 1), metadata: { size } }));
    return { data, error: null };
  } }) };
  return { supabase: { storage } as never, calls };
}
const VIDEO = { extension: "mp4", width: 1080, height: 1920 };

test("only stable Pexels ids with a known resolution get a shared path", () => {
  assert.equal(sharedStockPath("pexels-video-123", VIDEO), "stock/pexels-video-123-1080x1920.mp4");
  assert.equal(sharedStockPath("pexels-photo-9", { extension: "JPG", width: 1200, height: 1800 }), "stock/pexels-photo-9-1200x1800.jpg");
  assert.equal(sharedStockPath("fixture-3", VIDEO), null, "fixture ids are per-process counters, not content keys");
  assert.equal(sharedStockPath("pexels-video-first-https://x/y.mp4", VIDEO), null, "URL-derived fallback ids never qualify");
  assert.equal(sharedStockPath("pexels-video-123", { extension: "mp4" }), null, "unknown resolution = not the same quality");
  assert.equal(sharedStockPath("pexels-video-123", { extension: "mp4", width: 720, height: 0 }), null);
  assert.equal(sharedStockPath(undefined, VIDEO), null);
});

test("same id + same quality already stored → reused, no upload path for this request", async () => {
  const { supabase, calls } = fakeStorage({ "stock/pexels-video-123-1080x1920.mp4": 5_000_000 });
  const p = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-123", media: VIDEO, perRequestPath: "req/attempt-1/scene-0-0.mp4" });
  assert.deepEqual(p, { reuse: true, path: "stock/pexels-video-123-1080x1920.mp4" });
  assert.deepEqual(calls, [{ folder: "stock", search: "pexels-video-123-1080x1920.mp4" }]);
});

test("different quality of the same id is NOT reused", async () => {
  const { supabase } = fakeStorage({ "stock/pexels-video-123-720x1280.mp4": 3_000_000 });
  const p = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-123", media: VIDEO, perRequestPath: "r/scene.mp4" });
  assert.deepEqual(p, { reuse: false, path: "stock/pexels-video-123-1080x1920.mp4", shared: true, lookup: "missing" });
});

test("idempotent: first job uploads once to the shared path, the second job reuses it", async () => {
  const objects: Record<string, number> = {};
  const { supabase } = fakeStorage(objects);
  const first = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-7", media: VIDEO, perRequestPath: "a/s.mp4" });
  assert.equal(first.reuse, false);
  objects[first.path] = 1234; // what uploadToStorage would do
  const second = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-7", media: VIDEO, perRequestPath: "b/s.mp4" });
  assert.deepEqual(second, { reuse: true, path: first.path });
  const third = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-7", media: VIDEO, perRequestPath: "c/s.mp4" });
  assert.deepEqual(third, second);
});

test("lookup failure (error or exception) → upload exactly as before, to the per-request path", async () => {
  for (const opts of [{ listError: "boom" }, { throws: true }]) {
    const { supabase } = fakeStorage({}, opts);
    const p = await placeStockClip(supabase, "videos", { sourceId: "pexels-video-1", media: VIDEO, perRequestPath: "req/attempt-1/scene-2-0.mp4" });
    assert.deepEqual(p, { reuse: false, path: "req/attempt-1/scene-2-0.mp4", shared: false, lookup: "lookup_failed" });
  }
});

test("an empty (0-byte) shared object is treated as missing and gets re-uploaded; prefix matches are not hits", async () => {
  assert.deepEqual(await lookupSharedStock(fakeStorage({ "stock/pexels-video-5-1080x1920.mp4": 0 }).supabase, "videos", "stock/pexels-video-5-1080x1920.mp4"), { kind: "missing" });
  assert.deepEqual(await lookupSharedStock(fakeStorage({ "stock/pexels-video-55-1080x1920.mp4": 9 }).supabase, "videos", "stock/pexels-video-5-1080x1920.mp4"), { kind: "missing" });
});

test("ineligible clips (fixtures) keep today's per-request path without any lookup", async () => {
  const { supabase, calls } = fakeStorage({});
  const p = await placeStockClip(supabase, "videos", { sourceId: "fixture-4", media: { extension: "svg", width: 1080, height: 1920 }, perRequestPath: "r/attempt-1/scene-0-0.svg" });
  assert.deepEqual(p, { reuse: false, path: "r/attempt-1/scene-0-0.svg", shared: false, lookup: "not_eligible" });
  assert.equal(calls.length, 0);
});
