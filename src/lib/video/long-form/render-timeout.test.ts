import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { longFormRenderTimeout, longFormTimeoutMatches } from "./render-timeout";
import { longFormRenderCeilingUsd } from "./cost";
import { MAX_RENDER_ATTEMPTS } from "../limits";
import { getPricingConfig } from "../../billing/pricing";
test("short job quote covers all attempts and enforced job time; legacy duration stays conservative", () => {
  for (const [seconds, job, step] of [[180,45,30],[300,45,30],[301,90,75],[600,90,75],[601,180,165],[1200,180,165],[1201,330,300],[1800,330,300]]) {
    assert.deepEqual(longFormRenderTimeout(seconds), {jobMinutes:job,stepMinutes:step});
    assert.equal(longFormRenderCeilingUsd(seconds), MAX_RENDER_ATTEMPTS*job*getPricingConfig().renderUsdPerMinute);
    assert.equal(longFormTimeoutMatches(seconds,String(job)), true);
    assert.equal(longFormTimeoutMatches(seconds,String(job+1)), false);
  }
  for(const invalid of [undefined,null,NaN,Infinity,0,-1,1801]) assert.equal(longFormRenderTimeout(invalid).jobMinutes,330);
});
test("manual/default enlarged job cannot silently exceed a short production quote",()=>{
  assert.equal(longFormTimeoutMatches(180,'330'),false);
  assert.equal(longFormTimeoutMatches(180,undefined),false);
  const cli=readFileSync('src/lib/video/worker-cli.ts','utf8');
  assert.ok(cli.indexOf('LONG_FORM_QUOTE_RUNNER_TIMEOUT_MISMATCH')<cli.indexOf('await refresh()'));
  const yaml=readFileSync('.github/workflows/render.yml','utf8');
  for(const [job,step] of [[45,30],[90,75],[180,165],[330,300]]) assert.ok(yaml.includes(`${job}) echo 'step=${step}'`));
  assert.match(yaml,/timeout-minutes:.*longFormJobTimeoutMin/);
});
