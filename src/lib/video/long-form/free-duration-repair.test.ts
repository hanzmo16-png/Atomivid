import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { memoryOutputDeps, type LongFormOutputState } from "./output-finalize";
import { sha256File, probeOutput } from "./output-media";
import { verifyUploadedRepair, FAILED_AFTER_UPLOAD_RUN_ID, type RepairDeps, inspectProbeDependency, probePinnedOutput, assertResumeInspection, FAILED_BEFORE_UPLOAD_RUN_ID, type BeforeUploadInspection, loadApprovedCachedCandidate, assertPrivateCandidateUrl, hash, stableJson, type CachedRepairValidation, assertPrivateCanonicalUrl, assertProof, createDurationRepair, applyDurationRepair, ORIGINAL_SHA256, ORIGINAL_BYTES, ROOT_DRIVE_RECEIPT_SHA256, REPAIR_REQUEST_ID, NATIVE_RUN_ID, type PreservationProof } from "./free-duration-repair";
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
      const prevPath = process.env.PATH, prevProbe = process.env.FFPROBE_BIN;
      try {
        process.env.PATH = "/tmp/no-system-ffprobe"; delete process.env.FFPROBE_BIN;
        const dependency = await inspectProbeDependency(source, probeOutput);
        assert.equal(dependency.defaultProbeError?.code, "ENOENT");
        assert.equal(dependency.defaultProbeError?.reason, "ffprobe_failed");
        assert.equal(dependency.pinned.videoCodec, "h264");
        assert.equal(dependency.pinned.audioCodec, "aac");
        assert.ok((await probePinnedOutput(source)).durationSeconds >= 2);
      } finally {
        if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
        if (prevProbe === undefined) delete process.env.FFPROBE_BIN; else process.env.FFPROBE_BIN = prevProbe;
      }
      const result = await createDurationRepair(source, candidate, 3);
      assert.equal(result.after.duration, 3);
      assert.ok(result.after.avEndDelta <= 0.1);
      assert.equal(result.originalHash, originalHash);
      const repeated = await createDurationRepair(source, path.join(dir, "repeated-candidate.mp4"), 3);
      assert.equal(repeated.candidateHash, result.candidateHash, "same-host repeat is stable; cross-host apply must use cached approved bytes");
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
  const deps: RepairDeps = { finalize: out.deps, canonicalHash: async () => canonical, snapshot: async () => structuredClone(finance),
    fileHash: async (f: string) => f === original ? ORIGINAL_SHA256 : "candidate", candidateQc: async () => {},
    createIntent: async () => { if (intent) throw new Error("intent exists"); intent = true; }, preserve: async () => { preserves++; } };
  return { dir, out, state, deps, input: { requestId: REPAIR_REQUEST_ID, original, candidate, state, candidateHash: "candidate", proofHash: "rootproof" }, finance, setCanonical: (v: string) => { canonical = v; }, preserved: () => preserves, intentCreated: () => intent };
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


test("candidate size ceiling is checked before any irreversible intent", async () => {
  const s = await seam(); try {
    await fs.truncate(s.input.candidate, ORIGINAL_BYTES + 1);
    await assert.rejects(applyDurationRepair(s.input, s.deps), /storage_cap_failed_BEFORE_INTENT/);
    assert.equal(s.intentCreated(), false);
    assert.equal(s.preserved(), 0);
    assert.equal(s.out.calls.upload, 0);
  } finally { await fs.rm(s.dir, { recursive: true, force: true }); }
});


test("private readback URL must target the exact Supabase host and canonical path", () => {
  const base = "https://example.supabase.co";
  const exact = `${base}/storage/v1/object/sign/videos/${REPAIR_REQUEST_ID}/output/final.mp4?token=offline-placeholder`;
  assert.doesNotThrow(() => assertPrivateCanonicalUrl(exact, base));
  for (const wrong of [exact.replace("example.supabase.co", "evil.example"), exact.replace("final.mp4", "other.mp4"), exact.replace("https:", "http:"), exact.replace("?token=offline-placeholder", ""), exact.replace("https://", "https://user:password@")]) assert.throws(() => assertPrivateCanonicalUrl(wrong, base));
});


test("cached approval binds exact bytes, root proof, original source, receipt and snapshot", async () => {
  const bytes = Buffer.from("exact offline approved candidate bytes");
  const candidateSha256 = hash(bytes), prefix = `${REPAIR_REQUEST_ID}/state/free-duration-repair-v1`;
  const receiptPath = `${prefix}/validation-123.json`;
  const receipt: CachedRepairValidation = { status: "VALIDATED_NOT_APPLIED", requestId: REPAIR_REQUEST_ID, proofSha256: "proof", originalSha256: ORIGINAL_SHA256,
    candidateSha256, candidatePath: `${prefix}/candidate-${candidateSha256}.mp4`, bytes: bytes.length, metrics: { duration: 180, audioDuration: 180, avEndDelta: 0, width: 1920, height: 1080, fps: "30/1" }, beforeSnapshotSha256: "snapshot", target: 180, runId: "123" };
  const raw = Buffer.from(stableJson(receipt));
  const input = { receiptPath, receiptSha256: hash(raw), approvedCandidateSha256: candidateSha256, proofSha256: "proof", beforeSnapshotSha256: "snapshot" };
  const objects = new Map([[receiptPath, raw], [receipt.candidatePath, bytes]]);
  const reads: string[] = [];
  const download = async (p: string) => { reads.push(p); const b = objects.get(p); if (!b) throw new Error("not found"); return b; };
  const approved = await loadApprovedCachedCandidate(input, download);
  assert.deepEqual(approved.bytes, bytes);
  assert.deepEqual(reads, [receiptPath, receipt.candidatePath], "apply consumes receipt and bytes only; no encoder or provider dependency");
  for (const bad of [{ ...input, receiptSha256: "0".repeat(64) }, { ...input, proofSha256: "other" }, { ...input, beforeSnapshotSha256: "changed" }]) await assert.rejects(loadApprovedCachedCandidate(bad, download));
  objects.set(receipt.candidatePath, Buffer.from("tampered"));
  await assert.rejects(loadApprovedCachedCandidate(input, download), /tampered/);
  objects.set(receipt.candidatePath, bytes);
  const altered = Buffer.from(stableJson({ ...receipt, originalSha256: "wrong" }));
  objects.set(receiptPath, altered);
  await assert.rejects(loadApprovedCachedCandidate({ ...input, receiptSha256: hash(altered) }, download), /binding/);
});

test("apply script cannot encode: the only encoder call is inside returning validate branch", async () => {
  const source = await fs.readFile("scripts/repair-long-form-duration.ts", "utf8");
  const start = source.indexOf('if (mode === "validate")');
  const end = source.indexOf("const cached = await loadApprovedCachedCandidate", start);
  assert.ok(start > 0 && end > start);
  assert.equal((source.match(/await createDurationRepair\(/g) ?? []).length, 1);
  assert.match(source.slice(start, end), /await createDurationRepair/);
  assert.match(source.slice(start, end), /return;/);
  assert.doesNotMatch(source.slice(end), /createDurationRepair\(/);
});

test("candidate review URL is private and restricted to the exact cached SHA path", () => {
  const base = "https://example.supabase.co", sha = "a".repeat(64);
  const url = `${base}/storage/v1/object/sign/videos/${REPAIR_REQUEST_ID}/state/free-duration-repair-v1/candidate-${sha}.mp4?token=offline`;
  assert.doesNotThrow(() => assertPrivateCandidateUrl(url, base, sha));
  assert.throws(() => assertPrivateCandidateUrl(url.replace(sha, "b".repeat(64)), base, sha));
  assert.throws(() => assertPrivateCandidateUrl(url.replace("example.supabase.co", "evil.example"), base, sha));
});


test("resume requires exact inspected intent, unchanged original state/source/finances and confirmed dependency gap", () => {
  const intent = Buffer.from(stableJson({ originalSha256: ORIGINAL_SHA256, candidateSha256: "candidate", validationReceiptSha256: "validation", proofSha256: "proof", beforeSnapshotSha256: "snapshot", attempt: 1 }));
  const inspection: BeforeUploadInspection = { status: "INSPECTED_ORIGINAL_BEFORE_UPLOAD", failedRunId: FAILED_BEFORE_UPLOAD_RUN_ID, intentSha256: hash(intent), canonicalSha256: ORIGINAL_SHA256,
    originalStateSha256: "state", candidateSha256: "candidate", validationReceiptSha256: "validation", proofSha256: "proof", beforeSnapshotSha256: "snapshot", snapshotEqual: true, resultAbsent: true, dependencyGapConfirmed: true, originalMediaMatch: true };
  const raw = Buffer.from(stableJson(inspection));
  const input = { rawInspection: raw, expectedInspectionSha256: hash(raw), rawIntent: intent, expectedIntentSha256: hash(intent), canonicalSha256: ORIGINAL_SHA256,
    originalStateSha256: "state", candidateSha256: "candidate", validationReceiptSha256: "validation", proofSha256: "proof", beforeSnapshotSha256: "snapshot" };
  assert.doesNotThrow(() => assertResumeInspection(input));
  for (const changed of [{ canonicalSha256: "candidate" }, { originalStateSha256: "changed" }, { beforeSnapshotSha256: "changed" }, { expectedIntentSha256: "0".repeat(64) }, { expectedInspectionSha256: "0".repeat(64) }]) assert.throws(() => assertResumeInspection({ ...input, ...changed }));
  for (const changed of [{ dependencyGapConfirmed: false }, { originalMediaMatch: false }, { resultAbsent: false }, { failedRunId: 1 }]) {
    const altered = Buffer.from(stableJson({ ...inspection, ...changed }));
    assert.throws(() => assertResumeInspection({ ...input, rawInspection: altered, expectedInspectionSha256: hash(altered) }));
  }
  assert.deepEqual(intent, input.rawIntent, "inspection never deletes or rewrites the original intent");
});

test("explicit verified resume callback preserves existing intent/state and fences a second resume", async () => {
  const s = await seam(); try {
    const originalIntent = Buffer.from("immutable prior intent"), originalIntentHash = hash(originalIntent);
    let fenced = false;
    s.deps.createIntent = async () => { assert.equal(hash(originalIntent), originalIntentHash); if (fenced) throw new Error("resume fence exists"); fenced = true; };
    s.deps.preserve = async (_a, _b, state) => { assert.deepEqual(state, s.state); };
    await applyDurationRepair(s.input, s.deps);
    assert.equal(s.out.calls.upload, 1);
    assert.equal(hash(originalIntent), originalIntentHash);
    s.setCanonical(ORIGINAL_SHA256);
    await assert.rejects(applyDurationRepair(s.input, s.deps), /resume fence exists/);
    assert.equal(s.out.calls.upload, 1);
  } finally { await fs.rm(s.dir, { recursive: true, force: true }); }
});

test("ops adapter explicitly pins its finalizer probe and cannot delete old intent", async () => {
  const source = await fs.readFile("scripts/repair-long-form-duration.ts", "utf8");
  assert.match(source, /probe: probePinnedOutput/);
  assert.match(source, /resume-before-upload\.json/);
  assert.doesNotMatch(source, /\.(remove|delete)\(/);
});


function uploadedFixture() {
  const bytes = Buffer.from("offline already-uploaded exact approved candidate");
  const candidateSha256 = hash(bytes), proofSha256 = hash("proof"), validationReceiptSha256 = hash("validation"), snapshotSha256 = hash("unchanged financial snapshot");
  const originalState = { version: 1, requestId: REPAIR_REQUEST_ID, objectPath: `${REPAIR_REQUEST_ID}/output/final.mp4`, profile: "long_form_h264_v1", status: "UPLOADED", attempt: 1, costsRecorded: true, nativeBlackQc: "passed-v1", sha256: ORIGINAL_SHA256, financialReceipt: { committedUsd: 0.37 } } as unknown as LongFormOutputState;
  const rawOriginalState = Buffer.from(stableJson(originalState));
  const lineage = { originalSha256: ORIGINAL_SHA256, candidateSha256, proofSha256, beforeSnapshotSha256: snapshotSha256, nativeRunId: NATIVE_RUN_ID, attempt: 1, providerCalls: 0, candidateBytes: bytes.length };
  const rawIntent = Buffer.from(stableJson({ ...lineage, validationReceiptSha256 })), intentSha256 = hash(rawIntent);
  const inspection = { status: "INSPECTED_ORIGINAL_BEFORE_UPLOAD", failedRunId: FAILED_BEFORE_UPLOAD_RUN_ID, intentSha256, canonicalSha256: ORIGINAL_SHA256,
    originalStateSha256: hash(rawOriginalState), candidateSha256, validationReceiptSha256, proofSha256, beforeSnapshotSha256: snapshotSha256, snapshotEqual: true, resultAbsent: true, dependencyGapConfirmed: true, originalMediaMatch: true };
  const rawInspection = Buffer.from(stableJson(inspection)), inspectionSha256 = hash(rawInspection);
  const rawResumeFence = Buffer.from(stableJson({ failedRunId: FAILED_BEFORE_UPLOAD_RUN_ID, resumeRunId: String(FAILED_AFTER_UPLOAD_RUN_ID), originalIntentSha256: intentSha256,
    inspectionReceiptSha256: inspectionSha256, candidateSha256, validationReceiptSha256, proofSha256, beforeSnapshotSha256: snapshotSha256 }));
  const pinned = { bytes: bytes.length, durationSeconds: 180.032, width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac", totalKbps: 2400, videoKbps: 2300, audioKbps: 192 };
  const state = { ...originalState, sha256: candidateSha256, delivered: pinned, repairLineage: lineage };
  return { sdkBytes: bytes, httpsBytes: bytes, expectedBytes: bytes.length, candidateSha256, proofSha256, validationReceiptSha256, rawIntent, intentSha256,
    rawInspection, inspectionSha256, rawResumeFence, rawOriginalState, sdkState: state, httpsState: state, beforeSnapshotSha256: snapshotSha256, afterSnapshotSha256: snapshotSha256,
    pinned, media: { duration: 180, audioDuration: 180.032, avEndDelta: 0.032, width: 1920, height: 1080, fps: "30/1" } };
}
test("already uploaded candidate verifies with zero uploads, encodes or financial writes", () => {
  const effects = { uploads: 0, encodes: 0, financialWrites: 0 };
  const input = { ...uploadedFixture(), upload: () => { effects.uploads++; }, encode: () => { effects.encodes++; }, financialWrite: () => { effects.financialWrites++; } };
  const verified = verifyUploadedRepair(input);
  assert.equal(verified.status, "READONLY_VERIFIED_UPLOADED_CANDIDATE");
  assert.equal(verified.snapshotEqual, true);
  assert.deepEqual(effects, { uploads: 0, encodes: 0, financialWrites: 0 });
});
test("uploaded verification rejects stale SDK bytes, tampered state, financial drift and resume lineage", () => {
  assert.throws(() => verifyUploadedRepair({ ...uploadedFixture(), sdkBytes: Buffer.from("stale original") }), /ambiguous/);
  assert.throws(() => verifyUploadedRepair({ ...uploadedFixture(), afterSnapshotSha256: "changed" }), /financial/);
  for (const change of [{ costsRecorded: false }, { attempt: 2 }, { sha256: ORIGINAL_SHA256 }, { financialReceipt: { committedUsd: 9 } }]) {
    const f = uploadedFixture(), changed = { ...f.httpsState, ...change };
    assert.throws(() => verifyUploadedRepair({ ...f, sdkState: changed, httpsState: changed }));
  }
  const f = uploadedFixture();
  assert.throws(() => verifyUploadedRepair({ ...f, sdkState: JSON.parse(f.rawOriginalState.toString()) }), /state_readback_ambiguous/);
  assert.throws(() => verifyUploadedRepair({ ...f, rawResumeFence: Buffer.from(stableJson({ ...JSON.parse(f.rawResumeFence.toString()), candidateSha256: "wrong" })) }), /lineage/);
});
test("verify-uploaded script returns before C51 current-source gate and all mutation/encoder paths", async () => {
  const source = await fs.readFile("scripts/repair-long-form-duration.ts", "utf8");
  const start = source.indexOf('if (mode === "verify-uploaded") {');
  const end = source.indexOf("const originalBytes = await download(objectPath)", start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /verifyUploadedRepair/);
  assert.match(branch, /cacheNonce: randomUUID/);
  assert.match(branch, /Cache-Control/);
  assert.match(branch, /return;/);
  assert.doesNotMatch(branch, /applyDurationRepair\(|createDurationRepair\(|writeState\(|storage\.upload\(/);
});
