import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { reviewMaterial, matchesReviewBytes } from "./review-media-validation";
const bytes = Buffer.from("approved material");
const sha256 = createHash("sha256").update(bytes).digest("hex");
test("review locator remains inside the owned project", () => {
  assert.ok(reviewMaterial({ assetPath: "job/final-review/nyc.mp4", sha256 }, "job"));
  for (const assetPath of ["other/paid/a.png", "job/../other/a.png", "job/a\\b.png", "job/paid/a.json"]) {
    assert.equal(reviewMaterial({ assetPath, sha256 }, "job"), null);
  }
});
test("metadata cannot substitute a stale or missing file for the approved bytes", () => {
  const material = { assetPath: "job/paid/a.png", sha256 };
  assert.equal(matchesReviewBytes(material, bytes), true);
  assert.equal(matchesReviewBytes(material, Buffer.from("new version")), false);
  assert.equal(matchesReviewBytes(material, null), false);
});
