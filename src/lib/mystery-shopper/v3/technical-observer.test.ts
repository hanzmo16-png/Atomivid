import test from "node:test";
import assert from "node:assert/strict";
import { nativeIdentityProved, canonicalOutputReady, canonicalContractObservation, diagnosticOutputReady } from "../../../../scripts/mystery-shopper/technical-observer-checks";
test("native exact job/request/checkout linkage cannot be replaced by another completed run", () => {
  const run = { path: ".github/workflows/render.yml", event: "repository_dispatch", head_sha: "sha" };
  const jobs = [{ name: "render" }], logs = ["2026-11-26 REQUEST_ID: new-request\nLONG_FORM_PROCESS_FINISHED: exit=0"];
  assert.equal(nativeIdentityProved(run, jobs, logs, "new-request", "sha"), true);
  assert.equal(nativeIdentityProved({ ...run, head_sha: "other" }, jobs, logs, "new-request", "sha"), false);
  assert.equal(nativeIdentityProved(run, jobs, logs, "old-request", "sha"), false);
  assert.equal(nativeIdentityProved({ ...run, event: "workflow_dispatch" }, jobs, logs, "new-request", "sha"), false);
});
test("missing or mismatched canonical contract returns a blocked observation with actual probe and no locator", () => {
  const missing = canonicalContractObservation({ id: "new" }, { unavailable: true }, NaN);
  assert.equal(missing.status, "CANONICAL_CONTRACT_BLOCKED");
  assert.equal(missing.failureCategory, "NATIVE_OUTPUT_JOURNAL_UNAVAILABLE");
  assert.equal(missing.canonicalProbe, null);
  const probe = { durationSeconds: 178.6, bytes: 1000 };
  const mismatch = canonicalContractObservation({ id: "new" }, { status: "UPLOADED", delivered: probe }, 1000);
  assert.equal(mismatch.status, "CANONICAL_CONTRACT_BLOCKED");
  assert.equal(mismatch.failureCategory, "CANONICAL_METADATA_OR_QC_REJECTED");
  assert.deepEqual(mismatch.canonicalProbe, probe);
  assert.equal(mismatch.nativeOutputStatus, "UPLOADED");
  assert.equal("signedUrl" in mismatch, false);
});
test("locator requires canonical native QC, full metrics and exact owner request path", () => {
  const row = { id: "new", status: "completed", mode: "long_form", duration_seconds: 180, render_attempts: 1, video_path: "new/output/final.mp4" };
  const output = { requestId: "new", objectPath: row.video_path, status: "UPLOADED", nativeBlackQc: "passed-v1", costsRecorded: true, sha256: "a".repeat(64), delivered: { bytes: 1000, durationSeconds: 180.02, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac" } };
  assert.equal(canonicalOutputReady(row, output, 1000), true);
  for (const changed of [{ ...output, nativeBlackQc: undefined }, { ...output, objectPath: "old/output/final.mp4" }, { ...output, costsRecorded: false }, { ...output, delivered: { ...output.delivered, durationSeconds: 150 } }, { ...output, delivered: { ...output.delivered, audioCodec: null } }]) assert.equal(canonicalOutputReady(row, changed, 1000), false);
  assert.equal(canonicalOutputReady({ ...row, render_attempts: 2 }, output, 1000), false);
  assert.equal(canonicalOutputReady(row, output, 1001), false);
  assert.equal(canonicalOutputReady(row, output, 120000001), false);
});
test("unapproved diagnostic access may bypass only duration; canonical acceptance remains blocked", () => {
  const row = { id: "new", status: "completed", mode: "long_form", duration_seconds: 180, render_attempts: 1, video_path: "new/output/final.mp4" };
  const output = { requestId: "new", objectPath: row.video_path, status: "UPLOADED", nativeBlackQc: "passed-v1", costsRecorded: true, sha256: "a".repeat(64), delivered: { bytes: 1000, durationSeconds: 178.6, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac" } };
  assert.equal(canonicalOutputReady(row, output, 1000), false);
  assert.equal(diagnosticOutputReady(row, output, 1000), true);
  assert.equal(canonicalContractObservation(row, output, 1000).status, "CANONICAL_CONTRACT_BLOCKED");
  for (const changed of [{ ...output, nativeBlackQc: undefined }, { ...output, status: "FAILED" }, { ...output, objectPath: "old/output/final.mp4" }, { ...output, sha256: "bad" }, { ...output, delivered: { ...output.delivered, bytes: 999 } }, { ...output, delivered: { ...output.delivered, durationSeconds: NaN } }, { ...output, delivered: { ...output.delivered, audioCodec: null } }, { ...output, delivered: { ...output.delivered, width: 1080 } }]) assert.equal(diagnosticOutputReady(row, changed, 1000), false);
  assert.equal(diagnosticOutputReady({ ...row, status: "processing" }, output, 1000), false);
  assert.equal(diagnosticOutputReady(row, output, 120000001), false);
});
