import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonResponseSystem, parseDocumentaryResponse } from "./json-response";
import { DocumentaryScriptSchema, generateDocumentaryScript } from "./documentary-script";
import { EditorialReviewSchema } from "./editorial";
import { editorialFixture, passingReview } from "./editorial.test-fixtures";
import { documentaryFormError } from "./form-error";

const response = (data: unknown, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text: JSON.stringify(data) }] });

test("complete creative contract remains in prompt and locally enforced", () => {
  const script = editorialFixture();
  assert.deepEqual(parseDocumentaryResponse(DocumentaryScriptSchema, response(script)), script);
  const prompt = jsonResponseSystem("Write", DocumentaryScriptSchema);
  for (const field of ["creativeDirection", "storyPlan", "angles", "protectInEdit", "sourceIds", "minItems", "maxItems"])
    assert.ok(prompt.includes(field), field);
  const bad = structuredClone(script); bad.creativeDirection.angles.pop();
  assert.throws(() => parseDocumentaryResponse(DocumentaryScriptSchema, response(bad)), /formato editorial/);
  const wrong = structuredClone(script); wrong.beats[0].visuals = [];
  assert.throws(() => parseDocumentaryResponse(DocumentaryScriptSchema, response(wrong)), /formato editorial/);
  assert.throws(() => parseDocumentaryResponse(EditorialReviewSchema, response({ findings: [] })), /formato editorial/);
});

test("truncation, refusal and malformed/partial JSON never become approved scripts", () => {
  for (const reason of ["max_tokens", "refusal", "pause_turn", "tool_use"])
    assert.throws(() => parseDocumentaryResponse(z.object({ ok: z.boolean() }), response({ ok: true }, reason)), /consumo quedaron registrados/);
  for (const text of ['{"ok":true', 'Here is JSON: {"ok":true}', '{} {}'])
    assert.throws(() => parseDocumentaryResponse(z.object({ ok: z.boolean() }), { stop_reason: "end_turn", content: [{ type: "text", text }] }));
  assert.deepEqual(parseDocumentaryResponse(z.object({ ok: z.boolean() }), { stop_reason: "end_turn", content: [{ type: "text", text: '```json\n{"ok":true}\n```' }] }), { ok: true });
});

test("real SDK serialization uses no compiled grammar for writer AND critic; editorial review still runs", async () => {
  const oldKey = process.env.ANTHROPIC_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = "test-only-no-network";
  const script = editorialFixture();
  const requests: Record<string, any>[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.equal(body.output_config?.format, undefined);
    assert.equal(body.tools, undefined);
    assert.match(body.system, /OUTPUT CONTRACT/);
    const data = requests.length === 1 ? script : requests.length === 2 ? passingReview(script) : { visuals: script.beats[requests.length - 3].visuals };
    assert.ok(requests.length <= 7, "no hidden retries");
    return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: body.model,
      ...response(data), stop_sequence: null, usage: { input_tokens: 100, output_tokens: 200 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    let approved = false;
    const beats = await generateDocumentaryScript({ researchPack: { topic: "A legend examined", sources: [{ id: "s1", title: "Archive", kind: "primary", notes: "An allegation" }], openQuestions: [] }, mode: "curiosity_documentary", targetDurationSeconds: 180, onEditorialApproved: () => { approved = true; } });
    assert.equal(beats.length, 5); assert.equal(approved, true); assert.equal(requests.length, 7);
    const contract = JSON.parse(requests[0].system.split("All constraints apply.\n")[1]);
    const item = contract.properties.beats.items;
    const shape = item.$ref ? contract.$defs[item.$ref.split("/").at(-1)] : item;
    assert.equal(shape.properties.visuals, undefined);
    assert.match(requests[0].system, /creativeDirection/); assert.match(requests[1].system, /findings/);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; }
});

test("form error hides provider payload and preserves a diagnostic reference", () => {
  const message = documentaryFormError(new Error('400 {"error":"The compiled grammar is too large", "private":"secret"}'), "test123");
  assert.match(message, /test123/); assert.match(message, /Conservamos/);
  assert.ok(!message.includes("400") && !message.includes("secret"));
});

test("long editorial explanations retain full text without weakening story requirements", async () => {
  const { DocumentaryNarrativeSchema } = await import('./documentary-script');
  const script = editorialFixture();
  script.creativeDirection.selectionReason = 'r'.repeat(314);
  script.creativeDirection.cloneTest.whyThisStoryBreaks = 's'.repeat(421);
  const recovered = parseDocumentaryResponse(DocumentaryNarrativeSchema, response(script));
  assert.equal(recovered.creativeDirection.selectionReason, script.creativeDirection.selectionReason);
  assert.equal(recovered.creativeDirection.cloneTest.whyThisStoryBreaks, script.creativeDirection.cloneTest.whyThisStoryBreaks);
  assert.equal(recovered.beats[0].narration, script.beats[0].narration);
  for (const field of ['selectionReason', 'whyThisStoryBreaks']) {
    const bad = structuredClone(script);
    if (field === 'selectionReason') bad.creativeDirection.selectionReason = 'x'.repeat(1601);
    else bad.creativeDirection.cloneTest.whyThisStoryBreaks = 'x'.repeat(1601);
    assert.throws(() => parseDocumentaryResponse(DocumentaryNarrativeSchema, response(bad)), /formato editorial/);
  }
  const missing = structuredClone(script); missing.creativeDirection.angles.pop();
  assert.throws(() => parseDocumentaryResponse(DocumentaryNarrativeSchema, response(missing)), /formato editorial/);
});

test("writer contract stays byte-identical to deployed v1 so existing paid work is reused", async () => {
  const { DocumentaryNarrativePromptSchema } = await import('./documentary-script');
  const { createHash } = await import('node:crypto');
  const contract = JSON.stringify(z.toJSONSchema(DocumentaryNarrativePromptSchema, { reused: 'ref' }));
  assert.equal(createHash('sha256').update(contract).digest('hex'), '173ea300e6beb8700700c2d062ec33af69193aefd292d24aeec5fdd3be8e97c9');
});
