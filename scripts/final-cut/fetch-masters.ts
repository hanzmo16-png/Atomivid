/**
 * READ-ONLY: downloads existing masters from the private "videos" bucket for a retrospective
 * Final Cut inspection, verifies their sha256, and writes a manifest. Nothing is uploaded,
 * modified or deleted; no provider is called. Runs where Supabase is reachable (Actions).
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OUT_DIR,
 *      DULCE_PATH (object path), DULCE_SHA256 (expected), OCEAN_PREFIX (folder to list).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export {};

async function main() {
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const sb = createServiceClient();
  const out = process.env.OUT_DIR ?? "masters";
  fs.mkdirSync(out, { recursive: true });
  const bucket = sb.storage.from("videos");
  const manifest: Record<string, unknown> = { fetchedAt: new Date().toISOString(), files: [] as unknown[] };

  const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const download = async (objectPath: string, local: string) => {
    const { data, error } = await bucket.download(objectPath);
    if (error || !data) throw new Error(`download ${objectPath}: ${error?.message ?? "unknown"}`);
    fs.writeFileSync(local, Buffer.from(await data.arrayBuffer()));
    const size = fs.statSync(local).size;
    if (!size) throw new Error(`${objectPath} downloaded with size 0`);
    return { objectPath, local, bytes: size, sha256: sha(local) };
  };

  // DULCE Part I master: exact path and expected hash.
  const dulcePath = process.env.DULCE_PATH ?? "dulce-part1/final/DULCE-Part-I-master.mp4";
  const dulce = await download(dulcePath, path.join(out, "dulce-part1-master.mp4"));
  const expected = process.env.DULCE_SHA256;
  const dulceOk = !expected || dulce.sha256 === expected;
  (manifest.files as unknown[]).push({ ...dulce, expectedSha256: expected ?? null, identityVerified: dulceOk });
  console.log(`[fetch-masters] DULCE ${dulce.objectPath} bytes=${dulce.bytes} sha256=${dulce.sha256} identityVerified=${dulceOk}`);
  if (!dulceOk) throw new Error("DULCE master sha256 does not match the expected hash; not inspecting an unverified file");

  // Ocean: the master path is not recorded in the repo. List the prefix (read-only) and pick a full-episode mp4.
  const prefix = process.env.OCEAN_PREFIX ?? "ocean-deep-001";
  const found: { path: string; bytes: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    const { data, error } = await bucket.list(dir, { limit: 1000 });
    if (error) { console.log(`[fetch-masters] list ${dir}: ${error.message}`); return; }
    for (const it of data ?? []) {
      const p = dir ? `${dir}/${it.name}` : it.name;
      if (it.id === null || it.metadata === null) await walk(p, depth + 1); // folder
      else if (/\.mp4$/i.test(it.name)) found.push({ path: p, bytes: Number((it.metadata as { size?: number })?.size ?? 0) });
    }
  };
  await walk(prefix, 0);
  found.sort((a, b) => b.bytes - a.bytes);
  console.log(`[fetch-masters] Ocean mp4 objects under ${prefix}: ${found.length}`);
  for (const f of found) console.log(`  ${f.bytes.toString().padStart(11)}  ${f.path}`);
  manifest.oceanListing = found;
  // A full-episode master is not a per-scene asset: exclude */assets/* and tiny files.
  const candidates = found.filter((f) => !/\/assets\//.test(f.path) && f.bytes > 20 * 1024 * 1024);
  if (candidates.length) {
    const pick = candidates[0];
    const ocean = await download(pick.path, path.join(out, "ocean-master.mp4"));
    (manifest.files as unknown[]).push({ ...ocean, expectedSha256: null, identityVerified: "no recorded hash to compare; identity = storage path + sha256 recorded now", candidates });
    console.log(`[fetch-masters] OCEAN ${ocean.objectPath} bytes=${ocean.bytes} sha256=${ocean.sha256}`);
  } else {
    manifest.oceanMaster = null;
    console.log("[fetch-masters] OCEAN: no full-episode mp4 found under the prefix (only scene assets or nothing); Ocean pixel retrospective cannot run");
  }
  fs.writeFileSync(path.join(out, "masters-manifest.json"), JSON.stringify(manifest, null, 1));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
