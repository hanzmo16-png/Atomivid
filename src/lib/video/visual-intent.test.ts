import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsVisual, requireVisualIntents, VisualIntentSchema, type VisualIntent } from "./visual-intent";
import { createFootageSelectionState, selectFootageForScene, FootageSelectionError } from "./footage-select";
import type { FootageCandidate, FootageProvider } from "@/lib/providers/types";
import { assertReviewedVisualConfiguration } from "./reviewed-visual";

const verdict = { subjectPresent: true, allRequiredTraitsPresent: true, forbiddenSubstitutePresent: false, unrelatedTextOrWatermark: false, confidence: 0.95, reason: "Requested subject visible." };
const intent: VisualIntent = { source: "illustration", subject: "humanoid reptilian alien", mustShow: ["upright humanoid figure", "scaled skin"], mustNotShow: ["ordinary iguana"], imagePrompt: "A humanoid reptilian alien, upright with scaled skin." };

test("requires a bounded subject plan; incomplete legacy or malformed plans cannot silently use generic footage", () => {
  assert.throws(() => requireVisualIntents([{ text: "Un reptiliano", visualQuery: "reptile" }]), /plan visual/);
  assert.equal(VisualIntentSchema.safeParse({ ...intent, subject: "a" }).success, false);
  assert.equal(requireVisualIntents([{ text: "Un reptiliano", visualQuery: "reptilian humanoid alien", visualIntent: intent }])[0].subject, intent.subject);
});

test("voice-only owner grants and disabled illustration capacity stop before narration", () => {
  const segments = [{ text: "Un reptiliano", visualQuery: "reptilian humanoid alien", visualIntent: intent }];
  assert.throws(() => assertReviewedVisualConfiguration(segments, true), /presupuesto de prueba independiente/);
  const oldKey = process.env.OPENAI_API_KEY, oldFlag = process.env.OPENAI_IMAGE_GENERATION_ENABLED;
  try {
    process.env.OPENAI_API_KEY = "test"; process.env.OPENAI_IMAGE_GENERATION_ENABLED = "false";
    assert.throws(() => assertReviewedVisualConfiguration(segments, false), /no se sustituirán/);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldFlag === undefined) delete process.env.OPENAI_IMAGE_GENERATION_ENABLED; else process.env.OPENAI_IMAGE_GENERATION_ENABLED = oldFlag;
  }
});

test("rejects wrong subjects, missing distinguishing traits, forbidden substitutes and uncertainty, on every topic", () => {
  for (const reason of ["Iguana instead of humanoid alien", "Lamp instead of grey alien", "Generic bird instead of toucan", "Pizza instead of requested tacos", "Modern city instead of historical reconstruction"]) {
    assert.equal(acceptsVisual({ ...verdict, subjectPresent: false, reason }), false);
  }
  for (const bad of [{ allRequiredTraitsPresent: false }, { forbiddenSubstitutePresent: true }, { confidence: 0.79 }, { unrelatedTextOrWatermark: true }]) assert.equal(acceptsVisual({ ...verdict, ...bad }), false);
  assert.equal(acceptsVisual({ ...verdict, confidence: "high" }), false);
  assert.equal(acceptsVisual(verdict), true);
});

const candidate = (id: string, mediaType: "video" | "image" = "video"): FootageCandidate => ({ sourceId: id, url: `https://example.test/${id}`, mediaType, mimeType: mediaType === "video" ? "video/mp4" : "image/jpeg", extension: mediaType === "video" ? "mp4" : "jpg", width: 1080, height: 1920, durationSeconds: 10 });
test("technical quality cannot promote an unrelated clip; selects a verified image when all clips fail", async () => {
  const searches: string[] = [], checked: string[] = [];
  const provider: FootageProvider = { name: "test", fetchFootage: async () => { throw Error("unused"); }, downloadFootage: async () => Buffer.alloc(0),
    searchVideoCandidates: async q => { searches.push(q); return [candidate("iguana"), candidate("lamp")]; },
    searchImageCandidates: async () => [candidate("correct-alien", "image")] };
  const state = createFootageSelectionState();
  const outcome = await selectFootageForScene({ provider, concepts: ["humanoid reptilian alien portrait"], minimumDurationSeconds: 3, state,
    verifyCandidate: async c => { checked.push(c.sourceId); return c.sourceId === "correct-alien"; } });
  assert.equal(outcome.sourceId, "correct-alien");
  assert.deepEqual(checked, ["iguana", "lamp", "correct-alien"]);
  assert.deepEqual([...state.usedSourceIds], ["correct-alien"]);
  assert.ok(!searches.includes("humanoid reptilian"), "must not broaden the subject by truncating the search");
});

test("no-match and vision failures stop selection; rejected resources never pollute diversity state", async () => {
  const provider: FootageProvider = { name: "test", fetchFootage: async () => candidate("wrong"), downloadFootage: async () => Buffer.alloc(0), searchImageCandidates: async () => [candidate("wrong", "image")] };
  const state = createFootageSelectionState();
  await assert.rejects(selectFootageForScene({ provider, concepts: ["specific subject"], minimumDurationSeconds: 3, state, verifyCandidate: async () => false }), FootageSelectionError);
  assert.equal(state.usedSourceIds.size, 0);
  await assert.rejects(selectFootageForScene({ provider, concepts: ["specific subject"], minimumDurationSeconds: 3, state, verifyCandidate: async () => { throw Error("vision unavailable"); } }), /vision unavailable/);
});
