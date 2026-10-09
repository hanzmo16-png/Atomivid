import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normaliseObjectKey, outputFolder, parseCompleteManifest, parseVersionSegment, validEpisodeId, versionFolder } from "./contract";
import { checkDelivery, type EditorStorage } from "./verify";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);

/** In-memory bucket: full key → bytes + creation time. Streams in small chunks like a network body. */
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

// Synthetic delivery in the editor v3 COMPLETO.json shape as reported by Codex (built here, NOT editor-generated;
// the editor-generated case is the integration test at the end of this file).
const EP = "travis-walton", V = 2, BASE = versionFolder(EP, V), OUT = outputFolder(EP, V);
const video = bytes(4500, 7), sample = bytes(1800, 5), report = bytes(1200, 3);
const objs = [
  { key: "salida/episodio.mp4", size: video.byteLength, sha256: sha(video) },
  { key: `${BASE}/salida/muestras/m01.jpg`, size: sample.byteLength, sha256: sha(sample) }, // full bucket key form
  { key: "estado/reporte-abc123def456.json", size: report.byteLength, sha256: sha(report) },
];
const v3 = (over: Record<string, unknown> = {}) => ({
  episode_id: EP, assembly_version: V, editor_version: "0.3.0", job_key: "abc123def4567890", manifest_sha256: "b".repeat(64),
  objetos: objs, verificacion: "completa", publicado_en: "2026-10-09T20:00:05Z", estado: "completo", ...over,
});
function delivery(over: { manifest?: unknown; videoBody?: Uint8Array; markerAt?: string; extra?: Record<string, { body: Uint8Array | string; at: string }> } = {}) {
  return fakeStorage({
    [`${OUT}/episodio.mp4`]: { body: over.videoBody ?? video, at: "2026-10-09T20:00:00Z" },
    [`${OUT}/muestras/m01.jpg`]: { body: sample, at: "2026-10-09T20:00:01Z" },
    [`${BASE}/estado/reporte-abc123def456.json`]: { body: report, at: "2026-10-09T20:00:02Z" },
    [`${OUT}/COMPLETO.json`]: { body: JSON.stringify(over.manifest ?? v3()), at: over.markerAt ?? "2026-10-09T20:00:05Z" },
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

test("object keys: only salida/, salida/muestras/ and estado/reporte-*.json of THIS episode/version", () => {
  const ok = ["salida/episodio.mp4", "salida/muestras/m01.jpg", "estado/reporte-abc.json", `${BASE}/salida/x.mp4`];
  for (const k of ok) assert.ok(normaliseObjectKey(k, EP, V), k);
  assert.equal(normaliseObjectKey(`${BASE}/salida/x.mp4`, EP, V), "salida/x.mp4");
  const bad = [
    "entrada/montaje.json", "estado/otro.json", "salida/sub/x.mp4", "salida/muestras/a/b.jpg", "salida/COMPLETO.json",
    "episodios/otro/v2/salida/x.mp4", "episodios/travis-walton/v1/salida/x.mp4", "episodios/travis-walton/v20/salida/x.mp4",
    "salida/../entrada/x", "salida/./x.mp4", "salida//x.mp4", "/salida/x.mp4", "salida/x/..", "SALIDA/x.mp4",
    "salida/..x.mp4", "salida/.oculto", "salida/a b.mp4", "salida/%2e%2e", "", 5, null,
  ];
  for (const k of bad) assert.equal(normaliseObjectKey(k, EP, V), null, String(k));
});

test("no COMPLETO.json → still in edition, never finished", async () => {
  const s = fakeStorage({ [`${OUT}/episodio.mp4`]: { body: video, at: "2026-10-09T20:00:00Z" } });
  assert.deepEqual(await checkDelivery(s, EP, V, { hashes: true }), { state: "sin_entrega" });
  assert.equal(s.streamed.length, 0);
});

test("complete v3 delivery: sizes match → pending; every object's sha256 recomputed → finished", async () => {
  const s = delivery();
  assert.equal((await checkDelivery(s, EP, V, { hashes: false })).state, "pendiente_verificar");
  assert.equal(s.streamed.length, 0, "the cheap check downloads nothing");
  const done = await checkDelivery(s, EP, V, { hashes: true });
  assert.equal(done.state, "terminado");
  assert.equal(done.state === "terminado" && done.primary?.key, "salida/episodio.mp4");
  assert.deepEqual(s.streamed.sort(), [`${BASE}/estado/reporte-abc123def456.json`, `${OUT}/episodio.mp4`, `${OUT}/muestras/m01.jpg`].sort(), "samples and report are verified too");
});

test("same size but different content → hash mismatch, not finished", async () => {
  const tampered = video.slice(); tampered[100] ^= 0xff;
  assert.deepEqual(await checkDelivery(delivery({ videoBody: tampered }), EP, V, { hashes: true }), { state: "entrega_invalida", reason: "sha256 distinto en salida/episodio.mp4" });
});

test("missing object, wrong size, or object written after COMPLETO.json → invalid", async () => {
  const missing = delivery({ manifest: v3({ objetos: [...objs, { key: "salida/muestras/m02.jpg", size: 10, sha256: "a".repeat(64) }] }) });
  assert.match(JSON.stringify(await checkDelivery(missing, EP, V)), /falta el objeto salida\/muestras\/m02.jpg/);
  const wrongSize = delivery({ manifest: v3({ objetos: [{ ...objs[0], size: video.byteLength + 1 }] }) });
  assert.match(JSON.stringify(await checkDelivery(wrongSize, EP, V)), /tamaño distinto/);
  assert.match(JSON.stringify(await checkDelivery(delivery({ markerAt: "2026-10-09T19:59:00Z" }), EP, V)), /después de COMPLETO.json/);
});

test("v3 header must match: estado, episode, assembly_version and required fields; duplicates and foreign keys rejected", () => {
  const exp = { episodeId: EP, version: V };
  const parse = (m: unknown) => parseCompleteManifest(JSON.stringify(m), exp).ok;
  assert.equal(parse(v3()), true);
  assert.equal(parse(v3({ verificacion: "sidecar" })), true);
  assert.equal(parseCompleteManifest("{", exp).ok, false);
  for (const over of [
    { estado: "parcial" }, { estado: undefined }, { episode_id: "otro" }, { assembly_version: 1 }, { assembly_version: "2" },
    { editor_version: "" }, { job_key: undefined }, { manifest_sha256: "ABC" }, { publicado_en: "ayer" }, { verificacion: null },
    { verificacion: { ok: true } }, { verificacion: [] }, { verificacion: "no-verificado" },
    { objetos: [] }, { objetos: [objs[0], objs[0]] }, { objetos: [objs[0], { ...objs[0], key: `${BASE}/salida/episodio.mp4` }] },
    { objetos: [{ ...objs[0], key: "../../ep-b/v1/salida/x.mp4" }] }, { objetos: [{ ...objs[0], key: "entrada/montaje.json" }] },
    { objetos: [{ ...objs[0], sha256: "A".repeat(64) }] }, { objetos: [{ ...objs[0], size: 0 }] }, { objetos: [{ ...objs[0], size: "10" }] },
  ]) assert.equal(parse(v3(over)), false, JSON.stringify(over));
  // The old assumed shape (version + salidas[archivo,bytes]) is no longer accepted.
  assert.equal(parse({ episode_id: EP, version: V, salidas: [{ archivo: "a.mp4", bytes: 1, sha256: "a".repeat(64) }] }), false);
});

test("a stream longer than declared is rejected", async () => {
  const lying = delivery();
  const big = bytes(9000, 7);
  const swapped: EditorStorage = { list: (f) => lying.list(f), readText: (p) => lying.readText(p), stream: async () => new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }) };
  assert.equal((await checkDelivery(swapped, EP, V, { hashes: true })).state, "entrega_invalida");
});

test("deadline reached while hashing → stays pending, never finished", async () => {
  assert.equal((await checkDelivery(delivery(), EP, V, { hashes: true, deadline: Date.now() - 1 })).state, "pendiente_verificar");
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

/**
 * Integration with the REAL editor v3 output. Fixture = the version folder an editor v3 run published
 * (synthetic media only), copied verbatim: fixtures/editor-v3/episodios/<ep>/v<n>/{salida,estado}/… including
 * the editor-generated salida/COMPLETO.json. Skipped (reported as skipped, not passed) until it is committed.
 */
const FIXTURE = "src/lib/podcast/editor/fixtures/editor-v3";
test("editor v3 generated delivery verifies end to end", async () => {
  assert.ok(existsSync(FIXTURE), "the committed editor-generated fixture is required");
  const files: Record<string, { body: Uint8Array; at: string }> = {};
  const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else files[relative(FIXTURE, p)] = { body: readFileSync(p), at: "" }; } };
  walk(FIXTURE);
  const markerKey = Object.keys(files).find((k) => k.endsWith("/salida/COMPLETO.json"));
  assert.ok(markerKey, "fixture contains salida/COMPLETO.json");
  const [, ep, vSeg] = markerKey.split("/");
  const version = parseVersionSegment(vSeg)!;
  // Order as published: every object first, the marker last.
  for (const k of Object.keys(files)) files[k].at = k === markerKey ? "2026-01-01T00:00:10Z" : "2026-01-01T00:00:00Z";
  const parsed = parseCompleteManifest(new TextDecoder().decode(files[markerKey].body), { episodeId: ep, version });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  const result = await checkDelivery(fakeStorage(files), ep, version, { hashes: true });
  assert.equal(result.state, "terminado", JSON.stringify(result));
  assert.equal(result.state === "terminado" && result.primary?.key, "salida/episodio.mp4", "show video first even when editor lists MP3 first");
});
