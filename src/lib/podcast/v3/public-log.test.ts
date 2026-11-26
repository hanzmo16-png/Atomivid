import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicStudioCompletion, publicStudioReadiness } from "../../../../scripts/podcast-3-0/public-log";
test("public readiness discards private balances, rates, credentials and upstream details", () => {
  for (const ready of [true,false]) {
    const privateRecord = { ready, free:123, demands:[{units:999}], rate:.123, detail:"private URL fixture", credential:"fixture-not-a-secret" };
    assert.equal(JSON.stringify(publicStudioReadiness(privateRecord)),JSON.stringify({ready}));
  }
});
test("public completion reveals only whether paid work was reused, never counts or money", () => {
  const privateRecord = { reusedOps: 7, spentUsd: 123, paidOps: 9, detail: "private fixture" };
  assert.deepEqual(publicStudioCompletion(privateRecord), { reused: true });
  assert.deepEqual(publicStudioCompletion({ reusedOps: 0 }), { reused: false });
});
test("native CLI public log sites do not serialize financial records or upstream error detail", () => {
  const source=readFileSync("scripts/podcast-3-0/studio-worker.ts","utf8");
  const logs=source.split("\n").filter(l=>l.includes("console.log"));
  for(const line of logs) assert.doesNotMatch(line,/spentUsd|paidOps|reusedOps|\.free|demands|JSON\.stringify\(rates|\.detail/);
  assert.match(source,/console\.log\("STUDIO_READY", JSON\.stringify\(publicStudioCompletion\(r\)\)\);/);
  const workflow=readFileSync(".github/workflows/podcast-video.yml","utf8");
  assert.match(workflow,/if \[\[ "\$JOB_KIND" == "studio" \]\]; then/);
  assert.match(workflow,/studio-private\.log" 2>&1/);
  assert.match(workflow,/studio_exit=\$\?/);
  assert.match(workflow,/exit "\$studio_exit"/);
});
