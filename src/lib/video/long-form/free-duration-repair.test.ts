import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { memoryOutputDeps, type LongFormOutputState } from "./output-finalize";
import { sha256File } from "./output-media";
import { assertProof, createDurationRepair, applyDurationRepair, ORIGINAL_SHA256, ORIGINAL_BYTES, ROOT_DRIVE_RECEIPT_SHA256, REPAIR_REQUEST_ID, NATIVE_RUN_ID, type PreservationProof } from "./free-duration-repair";
const run = promisify(execFile);
const proof = (): PreservationProof => ({ version: 1, requestId: REPAIR_REQUEST_ID, qaOwnerId: "11111111-1111-1111-1111-111111111111", rootOwnerLogin: "owner", originalSha256: ORIGINAL_SHA256, originalBytes: ORIGINAL_BYTES, nativeRunId: NATIVE_RUN_ID,
  drive: { rootReceiptSha256: ROOT_DRIVE_RECEIPT_SHA256, independentReadback: true, privateOwnerOnly: true, method: "GoogleDriveConnector", verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }, ledgerObjectPaths: ["private/ledger.json"] });
test("private root proof rejects missing readback, wrong actor/hash, and expiry", () => {
  assert.doesNotThrow(() => assertProof(proof(), "owner", "owner"));
  for (const mutate of [(p: PreservationProof) => { p.drive.rootReceiptSha256 = "0".repeat(64); }, (p: PreservationProof) => { p.originalSha256 = "wrong"; }, (p: PreservationProof) => { p.drive.expiresAt = "2000-01-01"; }, (p: PreservationProof) => { p.drive.independentReadback = false as true; }]) {
    const p = proof(); mutate(p); assert.throws(() => assertProof(p, "owner", "owner"));
  }
  assert.throws(() => assertProof(proof(), "owner", "other"));
});
for (const color of ["orange", "black"]) test(`real CPU ${color} source: bounded local repair and terminal visibility`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-free-repair-"));
  try {
    const source = path.join(dir, "source.mp4"), candidate = path.join(dir, "candidate.mp4");
    await run(ffmpeg.path, ["-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { timeout: 30_000 });
    const originalHash = await sha256File(source);
    if (color === "black") await assert.rejects(createDurationRepair(source, candidate, 3), /black|visible/i);
    else {
      const result = await createDurationRepair(source, candidate, 3);
      assert.equal(result.after.duration, 3);
      assert.ok(result.after.avEndDelta <= 0.1);
      assert.equal(result.originalHash, originalHash);
      await assert.rejects(createDurationRepair(source, path.join(dir, "too-long.mp4"), 5), /out_of_bounds/);
    }
    assert.equal(await sha256File(source), originalHash);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

async function seam() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-repair-seam-"));
  const original = path.join(dir, "original.mp4"), candidate = path.join(dir, "candidate.mp4");
  await fs.writeFile(original, "offline synthetic original seam"); await fs.writeFile(candidate, "offline synthetic candidate seam");
  const out = memoryOutputDeps({ durationSeconds: 180 });
  const state = { version: 1, requestId: REPAIR_REQUEST_ID, status: "UPLOADED", attempt: 1, costsRecorded: true, nativeBlackQc: "passed-v1", sha256: ORIGINAL_SHA256, financialReceipt: { committedUsd: 0.37 }, profile: "original-profile" } as unknown as LongFormOutputState;
  let canonical = ORIGINAL_SHA256, intent = false, preserves = 0;
  const finance = { request: { render_attempts: 1 }, pi: [{ committed_usd: 0.37 }], generationCosts: [{ total: 0.37 }], ledgerHash: "same" };
  const upload = out.deps.upload;
  out.deps.upload = async (p, f) => { const r = await upload(p, f); canonical = "candidate"; return r; };
  const deps = { finalize: out.deps, canonicalHash: async () => canonical, snapshot: async () => structuredClone(finance),
    fileHash: async (f: string) => f === original ? ORIGINAL_SHA256 : "candidate", candidateQc: async () => {},
    createIntent: async () => { if (intent) throw new Error("intent exists"); intent = true; }, preserve: async () => { preserves++; } };
  return { dir, out, state, deps, input: { requestId: REPAIR_REQUEST_ID, original, candidate, state, candidateHash: "candidate", proofHash: "rootproof" }, finance, setCanonical: (v: string) => { canonical = v; }, preserved: () => preserves };
}
test("one-shot seam preserves financial/unknown fields and costsRecorded; intent prevents repeat", async () => {
  const s = await seam(); try {
    await applyDurationRepair(s.input, s.deps);
    const written = s.out.states.get(REPAIR_REQUEST_ID) as unknown as Record<string, unknown>;
    assert.equal(written.costsRecorded, true); assert.equal(written.attempt, 1);
    assert.deepEqual(written.financialReceipt, { committedUsd: 0.37 });
    assert.equal(s.out.calls.upload, 1); assert.equal(s.preserved(), 1);
    s.setCanonical(ORIGINAL_SHA256);
    await assert.rejects(applyDurationRepair(s.input, s.deps), /intent exists/);
    assert.equal(s.out.calls.upload, 1);
  } finally { await fs.rm(s.dir, { recursive: true, force: true }); }
});
test("changed snapshot or canonical and ambiguous upload never retry or overwrite original state", async () => {
  for (const failure of ["snapshot", "canonical", "upload", "state"]) {
    const s = await seam(); try {
      let reads = 0;
      if (failure === "snapshot") s.deps.snapshot = async () => ({ ...s.finance, changed: ++reads > 1 } as typeof s.finance);
      if (failure === "canonical") s.setCanonical("unexpected");
      if (failure === "upload") s.out.deps.upload = async () => { throw new Error("ambiguous"); };
      if (failure === "state") s.out.deps.writeState = async () => { throw new Error("db down"); };
      await assert.rejects(applyDurationRepair(s.input, s.deps));
      assert.equal(s.out.calls.transcode, 0);
      assert.equal(s.out.states.size, 0, "no failed state overwrites the original uploaded record");
      assert.ok(s.out.calls.upload <= 1);
    } finally { await fs.rm(s.dir, { recursive: true, force: true }); }
  }
});
