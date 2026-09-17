import assert from "node:assert/strict";
import test from "node:test";
import { createWeeklyGrowthPlan, mondayFor } from "./plan";

test("creates 12 safe briefs across the three launch channels", () => {
  const plan = createWeeklyGrowthPlan("2026-09-21");
  assert.equal(plan.length, 12);
  assert.deepEqual(
    [...new Set(plan.map((brief) => brief.channel))].sort(),
    ["instagram_reels", "tiktok", "youtube_shorts"],
  );
});

test("rejects unsafe volume and produces deterministic plans", () => {
  assert.throws(() => createWeeklyGrowthPlan("2026-09-21", 100));
  assert.deepEqual(createWeeklyGrowthPlan("2026-09-21"), createWeeklyGrowthPlan("2026-09-21"));
});

test("resolves the Monday for the operating week", () => {
  assert.equal(mondayFor(new Date("2026-09-17T12:00:00Z")), "2026-09-14");
});
