import assert from "node:assert/strict";
import test from "node:test";
import { createWeeklyGrowthPlan, weeklyGrowthPlanSchema } from "./plan";

const BASE_CONFIG = {
  weekStartsOn: "2026-09-21",
  timezone: "America/Cancun",
  locale: "es" as const,
  approvalMode: "required" as const,
  postsPerWeek: 12,
  channels: ["tiktok", "instagram_reels", "youtube_shorts"] as Array<
    "tiktok" | "instagram_reels" | "youtube_shorts"
  >,
};

test("creates a valid 12-post review-first weekly plan", () => {
  const plan = createWeeklyGrowthPlan(BASE_CONFIG);

  assert.equal(plan.briefs.length, 12);
  assert.ok(plan.briefs.every((brief) => brief.status === "draft"));
  assert.ok(plan.briefs.every((brief) => brief.requiresApproval));
  assert.equal(weeklyGrowthPlanSchema.safeParse(plan).success, true);
});

test("distributes posts across all launch channels", () => {
  const plan = createWeeklyGrowthPlan(BASE_CONFIG);
  const channels = new Set(plan.briefs.map((brief) => brief.channel));

  assert.deepEqual(
    [...channels].sort(),
    ["instagram_reels", "tiktok", "youtube_shorts"],
  );
});

test("is deterministic so a plan can be audited and reproduced", () => {
  const first = createWeeklyGrowthPlan(BASE_CONFIG);
  const second = createWeeklyGrowthPlan(BASE_CONFIG);

  assert.deepEqual(first, second);
});

test("rejects unsafe posting volume", () => {
  assert.throws(() =>
    createWeeklyGrowthPlan({
      ...BASE_CONFIG,
      postsPerWeek: 100,
    }),
  );
});
