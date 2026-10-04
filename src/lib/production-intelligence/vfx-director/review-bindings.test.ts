import { test } from "node:test";
import assert from "node:assert/strict";
import { currentReviewBinding } from "./review-bindings";
import type { Job } from "./jobs";
const h = "a".repeat(64), file = "b".repeat(64);
const job = { id: "job", ownerId: "owner", approvals: [], brief: { frames: 150 }, planHash: h, artifacts: { master: file }, plan: { environments: [] } } as unknown as Job;
const binding = { ownerId: "owner", stage: "master", planHash: h, artifactSha256: file, assetPath: `job/review/${file}.mp4`, sha256: file, startFrame: 0, endFrame: 150 };
test("master preview is pinned to exact owner, plan, file and complete interval", () => {
  assert.ok(currentReviewBinding(binding, job));
  for (const change of [{ ownerId: "other" }, { planHash: file }, { artifactSha256: h }, { sha256: h },
    { startFrame: 1 }, { endFrame: 149 }, { assetPath: "other/review/a.mp4" }, { assetPath: "job/review/../a.mp4" },
    { environmentId: "nyc" }, { stage: "motion" }]) assert.equal(currentReviewBinding({ ...binding, ...change }, job), null);
});
test("incomplete or unknown integration scope is rejected", () => {
  assert.equal(currentReviewBinding({ ...binding, stage: "integration" }, job), null);
  assert.equal(currentReviewBinding({ ...binding, stage: "integration", environmentId: "nyc" }, job), null);
  assert.equal(currentReviewBinding(null, job), null);
});
