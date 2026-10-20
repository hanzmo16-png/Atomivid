import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverPaidScript } from "./script-paid-recovery";
import { ScriptSchema } from "@/lib/ai/script";
import { scriptLengthReview } from "./script-length-review";
const id = "3131acdd-23d7-87b1-88ef-c4ff1bfdb7af";
const ref = `${id}/paid/op_0123456789abcdef.script.json`;
const script = { title: "Amanecer", segments: [{ text: "Las olas llegan a la orilla mientras el sol aparece.", visualQuery: "ocean sunrise" }] };
test("paid complete draft is recovered without a provider call and remains length-blocked", async () => {
  let reads = 0;
  const recovered = await recoverPaidScript(id, ref, async () => { reads++; return { stop_reason: "end_turn", parsed_output: script }; }, x => ScriptSchema.parse(x), "la playa");
  assert.deepEqual(recovered, script);
  assert.equal(reads, 1);
  assert.match(scriptLengthReview(recovered, 30)!, /10 palabras.*75 y 91/);
});
test("foreign, missing and path-traversal references are refused before storage access", async () => {
  for (const invalid of [null, `other/paid/op_ab.script.json`, `${id}/paid/../op_ab.script.json`, `${id}/paid/op_ab/../../file`]) {
    await assert.rejects(recoverPaidScript(id, invalid, async () => { assert.fail("must not read"); }, x => ScriptSchema.parse(x), "mar"), /INVALID_REFERENCE/);
  }
});
test("truncated or missing paid output cannot become a reviewable draft", async () => {
  for (const response of [{stop_reason:"max_tokens", parsed_output:script}, {stop_reason:"end_turn"}]) {
    await assert.rejects(recoverPaidScript(id, ref, async () => response, x => ScriptSchema.parse(x), "mar"), /INCOMPLETE/);
  }
});
test("corrupt stored result and storage failures do not fall back to paid generation", async () => {
  await assert.rejects(recoverPaidScript(id, ref, async () => { throw Error("offline"); }, x => ScriptSchema.parse(x), "mar"), /offline/);
  await assert.rejects(recoverPaidScript(id, ref, async () => ({stop_reason:"end_turn", parsed_output:{segments:[]}}), x => ScriptSchema.parse(x), "mar"));
});
test("recovery still refuses repeated narration", async () => {
  const bad = {...script, segments:[{...script.segments[0],text:"El sol sale lentamente. El sol sale lentamente."}]};
  await assert.rejects(recoverPaidScript(id, ref, async () => ({stop_reason:"end_turn",parsed_output:bad}), x => ScriptSchema.parse(x), "mar"), /excessive_repetition/);
});
test("length gate accepts only the existing 30-second window, including boundaries", () => {
  for (const n of [74,75,83,91,92]) {
    const draft = {...script,segments:[{...script.segments[0],text:Array.from({length:n},(_,i)=>`palabra${i}`).join(" ")}]};
    assert.equal(scriptLengthReview(draft,30) === null, n>=75&&n<=91);
  }
});
