// Incident 12045fcd (job e8048599, block 7): one unquoted key made a complete, paid visual plan unreadable. SIMULATED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonDocument, repairJsonSyntax } from "./response-normalizer";
import { readDocumentaryJson, DocumentaryResponseError } from "./json-response";
import { parseVisualPlan } from "./documentary-script";

const scene = (i: number) => `{"description":"Hun riders cross a frozen river ${i}","motion":true,"subject":"riders","action":"riding","place":"",era:"","beatClass":"PLACE","impact":2,"impactReason":"scale","excerptId":"rev:b6:w${i * 4}"}`;
const incident = `{"visuals":[${[0, 1, 2, 3, 4, 5, 6].map(scene).join(",")}]}`;   // exact defect shape: ,era:"",
const resp = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

test("12045fcd shape: an unquoted key is quoted and the 7-scene plan parses", () => {
  assert.throws(() => JSON.parse(incident));
  const plan = parseVisualPlan(resp(incident), { cinematic: true, referenceContract: true });
  assert.equal(plan.visuals.length, 7);
  assert.equal((plan.visuals[0] as { era?: string }).era, "");
});

test("only syntax is repaired: strings, values and literals are untouched", () => {
  const src = `{"a":"text with era: inside, and {braces}, and \\"quotes\\"",b:[true,false,null,1],c:{d:"x",},}`;
  const r = repairJsonSyntax(src);
  assert.deepEqual(JSON.parse(r.text), { a: "text with era: inside, and {braces}, and \"quotes\"", b: [true, false, null, 1], c: { d: "x" } });
  assert.deepEqual(r.rules, ["unquoted_key*3", "trailing_comma*2"]);
  assert.deepEqual(repairJsonSyntax('{"ok":1}').rules, [], "valid JSON is left exactly as is");
});

test("prose, partial documents and other invalid JSON keep failing", () => {
  for (const bad of ['Here is the plan: {"a":1}', '{"a":1} and more', '{"a":', "{'a':'single quotes'}", '{a:undefined}', '{"a":1}{"b":2}'])
    assert.throws(() => extractJsonDocument(bad), bad);
  assert.throws(() => readDocumentaryJson(resp('{"visuals":[{"description":"x",motion:tru}]}')), DocumentaryResponseError);
  assert.throws(() => readDocumentaryJson({ stop_reason: "max_tokens", content: [{ type: "text", text: incident }] }), DocumentaryResponseError, "truncation is never repaired");
});

test("the repair never changes a document that already parses (no behaviour change for valid answers)", () => {
  const valid = incident.replace(/,era:/g, ',"era":');
  assert.deepEqual(extractJsonDocument(valid), JSON.parse(valid));
});
