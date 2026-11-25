import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicStudioReadiness } from "../../../../scripts/podcast-3-0/public-log";
test("public readiness discards private balances, rates, credentials and upstream details", () => {
  for (const ready of [true,false]) {
    const privateRecord = { ready, free:123, demands:[{units:999}], rate:.123, detail:"private URL fixture", credential:"fixture-not-a-secret" };
    assert.equal(JSON.stringify(publicStudioReadiness(privateRecord)),JSON.stringify({ready}));
  }
});
test("native CLI public log sites do not serialize financial records or upstream error detail", () => {
  const source=readFileSync("scripts/podcast-3-0/studio-worker.ts","utf8");
  const logs=source.split("\n").filter(l=>l.includes("console.log"));
  for(const line of logs) assert.doesNotMatch(line,/spentUsd|paidOps|reusedOps|\.free|demands|JSON\.stringify\(rates|\.detail/);
  assert.match(source,/console\.log\("STUDIO_READY"\);/);
});
