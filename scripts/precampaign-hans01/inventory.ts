/**
 * hans-01 correction 3 (chatgpt-25): private inventory of existing photos, compared with the approved one.
 * Classification per candidate: EXACTA (same sha256), MISMA_IMAGEN_PROBABLE (perceptual distances inside the
 * calibrated re-encode/resize band), DISTINTA, NO_LEÍBLE. The report is redacted: no image, no signed URL, no full
 * private path, no owner id — only a short id derived from the path, a logical owner label, dims, a truncated hash
 * and distances. Reading is free (storage list/download); nothing is written.
 */
import { createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hamming, photoFingerprint } from "./fingerprint";

const sh = promisify(execFile);

export const APPROVED_TARGET = {
  sha256: "d00818a82ded6325b00128e818eb771fe9e4763230cafc75315a5606d18ad3cc",
  dhash: "496562313848484b",
  ahash: "e0bffffc88000000",
};
/** Calibrated on the approved photo: re-encode 0 bits, resize to 700 px ≈4 bits, chat re-compression 3/0 bits. */
export const SAME_IMAGE_MAX_BITS = 6;
const IMAGE = /\.(jpe?g|png|webp)$/i;

export type Candidate = { path: string; owner: "cuenta_voz" | "cuenta_avatar"; source: string };
export type Classified = {
  id: string; owner: Candidate["owner"]; source: string; result: "EXACTA" | "MISMA_IMAGEN_PROBABLE" | "DISTINTA" | "NO_LEÍBLE";
  width?: number; height?: number; bytes?: number; sha256Prefix?: string; dhashBits?: number; ahashBits?: number;
};

export const redactId = (path: string) => "c_" + createHash("sha256").update(path).digest("hex").slice(0, 8);

export function classify(sha: string, dhash: string, ahash: string, target = APPROVED_TARGET): Classified["result"] {
  if (sha === target.sha256) return "EXACTA";
  return hamming(dhash, target.dhash) <= SAME_IMAGE_MAX_BITS && hamming(ahash, target.ahash) <= SAME_IMAGE_MAX_BITS ? "MISMA_IMAGEN_PROBABLE" : "DISTINTA";
}

export async function classifyBytes(c: Candidate, bytes: Buffer | null, target = APPROVED_TARGET): Promise<Classified> {
  const base = { id: redactId(c.path), owner: c.owner, source: c.source };
  if (!bytes?.length) return { ...base, result: "NO_LEÍBLE" };
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  try {
    const file = join(dir, "img");
    await writeFile(file, bytes);
    const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [width, height] = stdout.trim().split(",").map(Number);
    const fp = await photoFingerprint(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    return { ...base, result: classify(sha, fp.dhash, fp.ahash, target), width, height, bytes: bytes.length, sha256Prefix: sha.slice(0, 8),
      dhashBits: hamming(fp.dhash, target.dhash), ahashBits: hamming(fp.ahash, target.ahash) };
  } catch {
    return { ...base, result: "NO_LEÍBLE" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Minimal storage port (Supabase storage satisfies it) so the walk is testable without a network. */
export type StoragePort = {
  list(prefix: string): Promise<{ name: string; isFolder: boolean }[]>;
  download(path: string): Promise<Buffer | null>;
};

/** Bounded recursive walk of the owners' prefixes in one bucket (images only, depth ≤ 4, ≤ 200 objects). */
export async function collectCandidates(store: StoragePort, roots: { prefix: string; owner: Candidate["owner"] }[], extra: Candidate[] = [], limit = 200): Promise<Candidate[]> {
  const out = new Map<string, Candidate>(extra.map(c => [c.path, c]));
  const walk = async (prefix: string, owner: Candidate["owner"], depth: number) => {
    if (depth > 4 || out.size >= limit) return;
    for (const e of await store.list(prefix)) {
      const p = `${prefix}/${e.name}`;
      if (e.isFolder) await walk(p, owner, depth + 1);
      else if (IMAGE.test(e.name) && !out.has(p) && out.size < limit) out.set(p, { path: p, owner, source: "storage" });
    }
  };
  for (const r of roots) await walk(r.prefix, r.owner, 0);
  return [...out.values()];
}

export async function inventory(store: StoragePort, candidates: Candidate[], target = APPROVED_TARGET) {
  const rows: Classified[] = [];
  for (const c of candidates) rows.push(await classifyBytes(c, await store.download(c.path).catch(() => null), target));
  const best = rows.find(r => r.result === "EXACTA") ?? rows.find(r => r.result === "MISMA_IMAGEN_PROBABLE") ?? null;
  return { scanned: rows.length, rows, match: best ? { id: best.id, result: best.result } : null };
}
