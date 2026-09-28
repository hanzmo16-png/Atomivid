import test from "node:test";
import assert from "node:assert/strict";
import { planMasterDelivery, deliveryRecord, isProgressiveMp4, masterUrlAcceptable, RETENTION } from "./policy";

const moovFirst = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from([0, 0, 0, 8]), Buffer.from("moov")]);
const mdatFirst = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from([0, 0, 0, 8]), Buffer.from("mdat")]);

test("masters are one progressive file when they fit the Pro limit; parts are legacy only", () => {
  assert.equal(planMasterDelivery(278_960_791, {}).mode, "single_file");
  assert.equal(planMasterDelivery(600 * 1024 * 1024, {}).mode, "parts_legacy");
  assert.equal(planMasterDelivery(60 * 1024 * 1024, { LONG_FORM_STORAGE_MAX_OBJECT_BYTES: String(50 * 1024 * 1024) }).mode, "parts_legacy");
  assert.equal(isProgressiveMp4(moovFirst), true);
  assert.equal(isProgressiveMp4(mdatFirst), false);
});

test("delivery records store paths and checksums, never signed URLs; masters are kept", () => {
  const base = { projectId: "p", assetType: "MASTER" as const, checksumSha256: "a".repeat(64), sizeBytes: 1, durationSeconds: 582.7, contentType: "video/mp4", progressive: true, createdAt: "2026-09-29" };
  assert.equal(deliveryRecord({ ...base, storagePath: "dulce-part1/final/DULCE-Part-I-master.mp4" }).retentionPolicy, "keep");
  assert.throws(() => deliveryRecord({ ...base, storagePath: "https://x/storage/v1/object/sign/a.mp4?token=eyJabc" }));
  assert.equal(RETENTION.MASTER.days, null);
});

test("anonymous master URL criteria (as verified for DULCE Part I)", () => {
  const ok = { rangeStatus: 206, contentType: "video/mp4", acceptRanges: "bytes", probeSeconds: 582.7, expectedSeconds: 582.7, progressive: true };
  assert.equal(masterUrlAcceptable(ok).ok, true);
  assert.equal(masterUrlAcceptable({ ...ok, contentType: "application/octet-stream" }).ok, false);
  assert.equal(masterUrlAcceptable({ ...ok, rangeStatus: 200 }).ok, false);
});
