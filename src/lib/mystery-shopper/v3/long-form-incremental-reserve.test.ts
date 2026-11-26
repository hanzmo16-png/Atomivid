import test from "node:test";
import assert from "node:assert/strict";
import { incrementalRenderReserve, verifiedReusableScript, verifiedExistingRenderFunding } from "../../../../scripts/mystery-shopper/long-form-incremental-reserve";
import { canReserve } from "./ledger";
test("a total quote does not charge the already settled script twice", () => {
  const amount = incrementalRenderReserve(1.96, .33, .33);
  assert.equal(amount, 1.63);
  const state = { reservations: [{ key: "script", module: "youtube" as const, jobId: "fixture", reservedUsd: .6, at: "fixture" }], settlements: [{ key: "script", spentUsd: .33, source: "fixture", at: "fixture" }] };
  assert.equal(canReserve(state, "youtube", amount!).ok, true);
  assert.equal(canReserve(state, "youtube", 1.96).ok, false);
  assert.equal(canReserve(state, "youtube", incrementalRenderReserve(2.01, .33, .33)!).ok, false);
});
test("unknown, inconsistent or negative prior spend never releases budget", () => {
  for (const args of [[1.96,null,.33],[1.96,.33,null],[1.96,.32,.33],[.2,.33,.33],[NaN,.33,.33],[1.96,-1,-1]] as const) assert.equal(incrementalRenderReserve(args[0], args[1], args[2]),null);
});
test("fractional cents round upward; another open reservation still blocks", () => {
  assert.equal(incrementalRenderReserve(1.961,.33,.33),1.64);
  assert.equal(canReserve({reservations:[{key:"other",module:"youtube",jobId:"fixture",reservedUsd:1,at:"fixture"}],settlements:[]},"youtube",1.63).ok,false);
});
test("resume requires an unambiguous settled YouTube script and never forgives a pending charge", () => {
  const key = "ms-fixture-yt-script";
  const r = { key, module:"youtube" as const, jobId:"fixture", reservedUsd:.6, at:"fixture" };
  const s = {key,spentUsd:.33,source:"fixture",at:"fixture"};
  assert.equal(verifiedReusableScript({reservations:[r],settlements:[s]},key),.33);
  assert.equal(verifiedReusableScript(null,key),null);
  assert.equal(verifiedReusableScript({reservations:[r],settlements:[]},key),null);
  assert.equal(verifiedReusableScript({reservations:[r,r],settlements:[s]},key),null);
  assert.equal(verifiedReusableScript({reservations:[r],settlements:[s,s]},key),null);
  assert.equal(verifiedReusableScript({reservations:[r],settlements:[{...s,spentUsd:1}]},key),null);
  assert.equal(verifiedReusableScript({reservations:[{...r,module:"reels"}],settlements:[s]},key),null);
});

test('same already-accounted render ceiling cannot be expanded, credited twice or substituted',()=>{const key='ms-fixture-yt-render',r={key,jobId:'ms-fixture',module:'youtube' as const,reservedUsd:1.67,at:'fixture'},s={key,spentUsd:1.67,at:'fixture',source:'fixture'},state={reservations:[r],settlements:[s]};assert.equal(verifiedExistingRenderFunding(state,key,1.67),true);for(const amount of [1.68,NaN,0,-1])assert.equal(verifiedExistingRenderFunding(state,key,amount),false);assert.equal(verifiedExistingRenderFunding({...state,settlements:[{...s,spentUsd:0}]},key,1),false);assert.equal(verifiedExistingRenderFunding({...state,reservations:[r,r]},key,1),false);assert.equal(verifiedExistingRenderFunding({...state,reservations:[{...r,jobId:'other'}]},key,1),false);});
