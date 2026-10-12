/** Synthetic images only (ffmpeg testsrc); no network, no storage, no Hans media. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { photoFingerprint } from "./fingerprint";
import { collectCandidates, inventory, redactId, type StoragePort } from "./inventory";

const sh = promisify(execFile);
async function synth(dir: string, name: string, src: string, extra: string[] = []) {
  const f = join(dir, name);
  await sh("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", "1", ...extra, f]);
  return readFile(f);
}

test("inventory classifies EXACTA / MISMA_IMAGEN_PROBABLE / DISTINTA / NO_LEÍBLE and redacts paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "invt-"));
  const original = await synth(dir, "a.jpg", "testsrc2=size=432x768:rate=1", ["-q:v", "2"]);
  const fA = join(dir, "a.jpg");
  const fp = await photoFingerprint(fA);
  const target = { sha256: createHash("sha256").update(original).digest("hex"), dhash: fp.dhash, ahash: fp.ahash };
  await sh("ffmpeg", ["-v", "error", "-y", "-i", fA, "-vf", "scale=360:-2", "-q:v", "8", join(dir, "b.jpg")]);
  const reencoded = await readFile(join(dir, "b.jpg"));
  const different = await synth(dir, "c.jpg", "mandelbrot=size=432x768:rate=1");
  const files: Record<string, Buffer> = { "u1/avatars/a.jpg": original, "u1/prep/x/b.jpg": reencoded, "u2/c.jpg": different, "u2/broken.png": Buffer.from("not an image") };
  const store: StoragePort = {
    async list(prefix) {
      const names = new Map<string, boolean>();
      for (const p of Object.keys(files)) if (p.startsWith(prefix + "/")) { const rest = p.slice(prefix.length + 1); const [head, ...tail] = rest.split("/"); names.set(head, tail.length > 0); }
      return [...names].map(([name, isFolder]) => ({ name, isFolder }));
    },
    async download(p) { return files[p] ?? null; },
  };
  const cands = await collectCandidates(store, [{ prefix: "u1", owner: "cuenta_avatar" }, { prefix: "u2", owner: "cuenta_voz" }]);
  assert.equal(cands.length, 4);
  const inv = await inventory(store, cands, target);
  const by = Object.fromEntries(inv.rows.map(r => [r.id, r]));
  assert.equal(by[redactId("u1/avatars/a.jpg")].result, "EXACTA");
  assert.equal(by[redactId("u1/prep/x/b.jpg")].result, "MISMA_IMAGEN_PROBABLE");
  assert.equal(by[redactId("u2/c.jpg")].result, "DISTINTA");
  assert.equal(by[redactId("u2/broken.png")].result, "NO_LEÍBLE");
  assert.deepEqual(inv.match, { id: redactId("u1/avatars/a.jpg"), result: "EXACTA" });
  // Redaction: nothing in the report contains a path segment or an owner id.
  const text = JSON.stringify(inv);
  for (const s of ["u1/", "u2/", "avatars", "prep", ".jpg", ".png"]) assert.ok(!text.includes(s), s);
});
