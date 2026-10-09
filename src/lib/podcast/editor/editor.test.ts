import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { outputFolder, parseCompleteManifest, parseVersionSegment, validEpisodeId, versionFolder } from "./contract";
import { checkDelivery, type EditorStorage } from "./verify";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

/** In-memory bucket: path → bytes + creation time. Streams in small chunks like a network body. */
function fakeStorage(objects: Record<string, { body: Uint8Array | string; at: string }>): EditorStorage & { streamed: string[] } {
  const enc = new TextEncoder();
  const get = (p: string) => { const o = objects[p]; if (!o) throw new Error("not found"); return typeof o.body === "string" ? enc.encode(o.body) : o.body; };
  const streamed: string[] = [];
  return {
    streamed,
    async list(folder) {
      return Object.entries(objects).filter(([p]) => p.slice(0, p.lastIndexOf("/")) === folder)
        .map(([p, o]) => ({ name: p.slice(p.lastIndexOf("/") + 1), bytes: get(p).byteLength, createdAt: o.at }));
    },
    async readText(path) { return new TextDecoder().decode(get(path)); },
    async stream(path) {
      streamed.push(path);
      const data = get(path);
      let i = 0;
      return new ReadableStream<Uint8Array>({ pull(c) { if (i >= data.length) return c.close(); c.enqueue(data.slice(i, i + 1000)); i += 1000; } });
    },
  };
}

const EP = "travis-walton", V = 2, OUT = outputFolder(EP, V);
const video = bytes(4500, 7), report = bytes(1200, 3);
function delivery(over: { manifest?: unknown; videoBody?: Uint8Array; markerAt?: string; extra?: Record<string, { body: Uint8Array | string; at: string }> } = {}) {
  const manifest = over.manifest ?? { episode_id: EP, version: V, salidas: [
    { archivo: "episodio.mp4", bytes: video.byteLength, sha256: sha(video) },
    { archivo: "informe.json", bytes: report.byteLength, sha256: sha(report) },
  ] };
  return fakeStorage({
    [`${OUT}/episodio.mp4`]: { body: over.videoBody ?? video, at: "2026-10-09T20:00:00Z" },
    [`${OUT}/informe.json`]: { body: report, at: "2026-10-09T20:00:01Z" },
    [`${OUT}/COMPLETO.json`]: { body: JSON.stringify(manifest), at: over.markerAt ?? "2026-10-09T20:00:05Z" },
    ...over.extra,
  });
}

test("paths mirror the approved Storage policy patterns", () => {
  assert.equal(versionFolder("ep-a", 1), "episodios/ep-a/v1");
  assert.equal(parseVersionSegment("v10"), 10);
  for (const bad of ["v0", "v01", "V1", "1", "v1/..", "v1234567890"]) assert.equal(parseVersionSegment(bad), null, bad);
  for (const bad of ["", "-ep", "ep a", "ep/a", "../x", "%65p", "a".repeat(82)]) assert.equal(validEpisodeId(bad), false, bad);
  assert.throws(() => versionFolder("../x", 1));
});

test("no COMPLETO.json → still in edition, never finished", async () => {
  const s = fakeStorage({ [`${OUT}/episodio.mp4`]: { body: video, at: "2026-10-09T20:00:00Z" } });
  assert.deepEqual(await checkDelivery(s, EP, V, { hashes: true }), { state: "sin_entrega" });
  assert.equal(s.streamed.length, 0);
});

test("complete delivery: sizes match → pending; every sha256 recomputed → finished", async () => {
  const s = delivery();
  assert.equal((await checkDelivery(s, EP, V, { hashes: false })).state, "pendiente_verificar");
  assert.equal(s.streamed.length, 0, "the cheap check downloads nothing");
  const done = await checkDelivery(s, EP, V, { hashes: true });
  assert.equal(done.state, "terminado");
  assert.equal(done.state === "terminado" && done.primary?.archivo, "episodio.mp4");
  assert.deepEqual(s.streamed.sort(), [`${OUT}/episodio.mp4`, `${OUT}/informe.json`]);
});

test("same size but different content → hash mismatch, not finished", async () => {
  const tampered = video.slice(); tampered[100] ^= 0xff;
  const r = await checkDelivery(delivery({ videoBody: tampered }), EP, V, { hashes: true });
  assert.deepEqual(r, { state: "entrega_invalida", reason: "sha256 distinto en episodio.mp4" });
});

test("missing output, wrong size, or output written after COMPLETO.json → invalid", async () => {
  const missing = delivery({ manifest: { episode_id: EP, version: V, salidas: [{ archivo: "otro.mp4", bytes: 10, sha256: "a".repeat(64) }] } });
  assert.equal((await checkDelivery(missing, EP, V)).state, "entrega_invalida");
  const wrongSize = delivery({ manifest: { episode_id: EP, version: V, salidas: [{ archivo: "episodio.mp4", bytes: video.byteLength + 1, sha256: sha(video) }] } });
  assert.match(JSON.stringify(await checkDelivery(wrongSize, EP, V)), /tamaño distinto/);
  const early = delivery({ markerAt: "2026-10-09T19:59:00Z" });
  assert.match(JSON.stringify(await checkDelivery(early, EP, V)), /después de COMPLETO.json/);
});

test("COMPLETO.json for another episode/version, bad JSON, traversal or duplicates → invalid", () => {
  const ok = { archivo: "a.mp4", bytes: 1, sha256: "a".repeat(64) };
  const exp = { episodeId: EP, version: V };
  assert.equal(parseCompleteManifest("{", exp).ok, false);
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: "otro", version: V, salidas: [ok] }), exp).ok, false);
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: 1, salidas: [ok] }), exp).ok, false);
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: V, salidas: [] }), exp).ok, false);
  for (const archivo of ["../../ep-b/v1/salida/x.mp4", "sub/x.mp4", "..mp4", ".oculto", "COMPLETO.json", "x\u0000.mp4", ""]) {
    assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: V, salidas: [{ ...ok, archivo }] }), exp).ok, false, archivo);
  }
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: V, salidas: [ok, ok] }), exp).ok, false);
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: V, salidas: [{ ...ok, sha256: "ABC" }] }), exp).ok, false);
  assert.equal(parseCompleteManifest(JSON.stringify({ episode_id: EP, version: V, salidas: [{ ...ok, bytes: 0 }] }), exp).ok, false);
});

test("a stream longer than declared is rejected without reading it all", async () => {
  const big = bytes(9000, 7);
  const lying = delivery({ manifest: { episode_id: EP, version: V, salidas: [{ archivo: "episodio.mp4", bytes: video.byteLength, sha256: sha(video) }] } });
  // Same declared size in the listing, but the body served is longer (e.g. object replaced between list and read).
  const swapped: EditorStorage = { list: (f) => lying.list(f), readText: (p) => lying.readText(p), stream: async () => new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }) };
  assert.equal((await checkDelivery(swapped, EP, V, { hashes: true })).state, "entrega_invalida");
});

test("deadline reached while hashing → stays pending, never finished", async () => {
  const r = await checkDelivery(delivery(), EP, V, { hashes: true, deadline: Date.now() - 1 });
  assert.equal(r.state, "pendiente_verificar");
});

test("app reads the bucket with the owner's session, never the service role; routes are owner-gated", () => {
  const storage = readFileSync("src/lib/podcast/editor/storage.ts", "utf8");
  assert.doesNotMatch(storage, /createServiceClient|SERVICE_ROLE/);
  const route = readFileSync("src/app/api/podcast-editor/[episode]/[version]/verify/route.ts", "utf8");
  assert.match(route, /createClient\(\)/);
  assert.doesNotMatch(route, /createServiceClient/);
  assert.match(route, /canAccessLongFormBeta\(user\)/);
  assert.doesNotMatch(route, /console\.(log|info)\(.*(signedUrl|play|download)/);
  for (const page of ["src/app/dashboard/podcast/editor/page.tsx", "src/app/dashboard/podcast/editor/[episode]/[version]/page.tsx"]) {
    const src = readFileSync(page, "utf8");
    assert.match(src, /canAccessLongFormBeta\(user\)\) notFound\(\)/, page);
    assert.doesNotMatch(src, /createServiceClient/, page);
  }
});
