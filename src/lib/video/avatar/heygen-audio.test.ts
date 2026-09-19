import test from "node:test";
import assert from "node:assert/strict";
import { heygenAudio } from "./heygen-audio";
import { generateToneWav } from "@/lib/providers/wav";
import { measureNarrationSeconds } from "./measure-narration";
test("HeyGen WAV preparation preserves full recorded duration and rejects malformed input", async () => {
  const input=generateToneWav({durationSeconds:2.25,frequencyHz:220,amplitude:.1});
  const output=await heygenAudio(input);
  assert.equal(output.extension,"wav");assert.equal(await measureNarrationSeconds(output.audioBuffer),2.25);
  await assert.rejects(()=>heygenAudio(Buffer.from("not audio")));
});
