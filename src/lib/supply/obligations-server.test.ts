import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readObligationOverview } from "./obligations-server";

test("owner financial reads include the second page and fail closed on a partial query error", async () => {
  const keys = ["AVATAR_PREPARATION_OWNER_EMAIL", "LONG_FORM_ENABLED"];
  const old = keys.map(k => process.env[k]); keys.forEach(k => { delete process.env[k]; });
  const calls: number[] = [];
  const subscriptions = Array.from({ length: 501 }, (_, i) => ({ user_id: `u${i}`, status: "active", price_id: null }));
  let fail = false;
  const service = { from(table: string) {
    const query = {
      select() { return query; }, in() { return query; }, or() { return query; }, eq() { return query; }, order() { return query; },
      range(start: number, end: number) {
        if (table === "subscriptions") calls.push(start);
        return Promise.resolve({ data: table === "subscriptions" ? subscriptions.slice(start, end + 1) : [], error: fail && table === "video_requests" ? { message: "unavailable" } : null });
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  try {
    const result = await readObligationOverview(service, new Date("2026-10-05T00:00:00Z"));
    assert.equal(result.accounts, 501); assert.equal(result.remainingReels, 7515); assert.equal(result.reserveUsd, null);
    assert.deepEqual(calls, [0, 500]);
    fail = true;
    await assert.rejects(() => readObligationOverview(service), /FINANCE_OVERVIEW_UNAVAILABLE/);
  } finally { keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }); }
});
