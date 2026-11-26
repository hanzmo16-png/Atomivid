import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_ID, SOURCE_OUTPUT_SHA, ANCHOR_ID, prepareTechnicalRerender, snapshotSha, verifiedReview } from "../../../../scripts/mystery-shopper/technical-long-form-rerender";
const newId = "12345678-1234-1234-1234-123456789abc";
const source = { id: SOURCE_ID, user_id: "qa", status: "completed", render_attempts: 3, mode: "long_form", duration_seconds: 180, language: "es", style: "Documental", aspect_ratio: "16:9", video_path: `${SOURCE_ID}/output/final.mp4`, script_json: {} };
const output = { status: "UPLOADED", sha256: SOURCE_OUTPUT_SHA };
test("operator rerender rejects any altered source, owner, native output or old identity", () => {
  for (const patch of [{ id: ANCHOR_ID }, { user_id: "other" }, { status: "failed" }, { render_attempts: 0 }, { mode: "visual" }, { duration_seconds: 179 }, { language: "en" }, { style: "Educativo" }, { aspect_ratio: "9:16" }, { video_path: "other.mp4" }])
    assert.throws(() => prepareTechnicalRerender({ ...source, ...patch }, output, "qa", "qa", newId), /scope/);
  assert.throws(() => prepareTechnicalRerender(source, output, "qa", "other", newId), /scope/);
  assert.throws(() => prepareTechnicalRerender(source, { ...output, sha256: "other" }, "qa", "qa", newId), /output/);
  for (const id of [SOURCE_ID, ANCHOR_ID, "bad"]) assert.throws(() => prepareTechnicalRerender(source, output, "qa", "qa", id), /identity/);
  assert.throws(() => prepareTechnicalRerender(source, output, "qa", "qa", newId), /approved frozen/);
});
test("snapshot binds all nested content independently of object key order", () => {
  assert.equal(snapshotSha({ z: [{ b: 2, a: 1 }], a: 0 }), snapshotSha({ a: 0, z: [{ a: 1, b: 2 }] }));
  assert.notEqual(snapshotSha({ narration: "approved" }), snapshotSha({ narration: "changed" }));
});
test("a guarded insert requires the complete exact private review and accepted hash", () => {
  const reviewed = { payload: { id: newId, script_json: { narration: "real source" } }, provenance: { sourceScriptSha256: "source" }, reviewSha256: "a".repeat(64), duration: { words: 487 } } as any;
  assert.doesNotThrow(() => verifiedReview(reviewed, structuredClone(reviewed), reviewed.reviewSha256));
  assert.throws(() => verifiedReview(reviewed, reviewed, "b".repeat(64)), /reviewed/);
  assert.throws(() => verifiedReview(reviewed, { ...reviewed, payload: { ...reviewed.payload, id: SOURCE_ID } }, reviewed.reviewSha256), /reviewed/);
  assert.throws(() => verifiedReview(reviewed, { ...reviewed, provenance: { sourceScriptSha256: "changed source" } }, reviewed.reviewSha256), /reviewed/);
});
