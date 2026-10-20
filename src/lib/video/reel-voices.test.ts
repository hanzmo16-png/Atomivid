import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccountVoice } from "@/lib/podcast/voices";
import { reelVoiceChoices, validateReelVoiceSelection } from "./reel-voices";
import { intentFingerprint, requestIdForSubmission } from "./submission-key";

const v = (voiceId: string, language = "en", category = "premade"): AccountVoice => ({ voiceId, name: voiceId, language, category,
  previewUrl: `https://example.test/${voiceId}.mp3`, accent: null, gender: null });

test("Reel catalogue: three public voices, language first, duplicates/private clones/default excluded", () => {
  const all = [v("voiceEng01"), v("voiceEsp01", "es"), v("voiceEng02"), v("voiceEng03"),
    v("voiceEng01"), v("myPrivate1", "es", "cloned"), v("default001", "es"), v("invalid/id"),
    { ...v("noPreview1", "es"), previewUrl: null }];
  const choices = reelVoiceChoices(all, "es", "default001");
  assert.equal(choices.length, 3);
  assert.equal(choices[0].voiceId, "voiceEsp01");
  assert.equal(new Set(choices.map(c => c.voiceId)).size, 3);
  assert.ok(!JSON.stringify(choices).includes("myPrivate1"));
  assert.equal(all[0].voiceId, "voiceEng01", "does not reorder the shared catalogue");
  assert.equal(reelVoiceChoices(all, "en", "default001")[0].nativeLanguage, "en");
});

test("Explicit voices fail closed; legacy/default needs no catalogue or enabled flag", () => {
  const choices = reelVoiceChoices([v("voiceEng01")], "en", "default001");
  for (const raw of [null, undefined, ""]) assert.equal(validateReelVoiceSelection(raw, false, []), null);
  assert.equal(validateReelVoiceSelection("voiceEng01", true, choices), "voiceEng01");
  for (const raw of ["unknown01", "voice/id01", 123, {}, " voiceEng01 "]) assert.throws(() => validateReelVoiceSelection(raw, true, choices));
  assert.throws(() => validateReelVoiceSelection("voiceEng01", false, choices));
});

test("Default retains submission identity; selected voice changes intent; resend is stable; Avatar ignores Reel field", async () => {
  const form = new FormData();
  form.set("topic", "Hábitos"); form.set("mode", "visual"); form.set("language", "es");
  const legacy = await requestIdForSubmission("user-a", form);
  form.set("reel_voice_id", "");
  assert.equal((await requestIdForSubmission("user-a", form)).requestId, legacy.requestId);
  form.set("reel_voice_id", "voiceEsp01");
  const selected = await requestIdForSubmission("user-a", form);
  assert.notEqual(selected.requestId, legacy.requestId);
  assert.equal((await requestIdForSubmission("user-a", form)).requestId, selected.requestId);
  form.set("mode", " visual ");
  assert.equal((await requestIdForSubmission("user-a", form)).requestId, selected.requestId, "same normalization as the server action");
  assert.notEqual((await requestIdForSubmission("user-b", form)).requestId, selected.requestId);
  form.set("mode", "avatar");
  assert.equal("reel_voice_id" in await intentFingerprint(form), false);
});

test("Voice persists outside script edits and is passed only into the Reel branch", () => {
  const actions = readFileSync("src/app/dashboard/new/actions.ts", "utf8");
  assert.ok(actions.indexOf("await resolveReelVoiceSelection(") < actions.indexOf('.from("video_requests").insert('));
  assert.match(actions, /reel_voice_id: reelVoiceId/);
  const worker = readFileSync("src/lib/video/run-job.ts", "utf8");
  assert.match(worker, /director_requested, reel_voice_id"/);
  assert.match(worker, /generateVideoFromScript\(\{[\s\S]*voiceId: row\.reel_voice_id \?\? undefined/);
  for (const file of ["src/app/api/generate/[id]/script/route.ts", "src/app/api/generate/[id]/script/regenerate-scene/route.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /reel_voice_id\s*:/, "editing a script cannot change voice");
  }
  const pipeline = readFileSync("src/lib/video/generate-video.ts", "utf8");
  assert.match(pipeline, /reelNarration\(language, voiceId\)/);
  assert.match(pipeline, /gatedVoiceSynthesize\(\{ \.\.\.gate, voiceProvider,\s*voiceIdentity,/);
});
