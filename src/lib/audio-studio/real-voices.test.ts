import { test } from "node:test";
import assert from "node:assert/strict";
import { VOICE_PRESETS, applyInput, newProject, parseStored } from "./model";
import { parseVoiceMap, voiceAvailability } from "./voice";
import { catalogFrom } from "./catalog";

const LEGACY = "es-latam-m-profesional=TbvhqFC7AApJv7hnNvmY,es-latam-m-calida=uYlzyj2kIZo3HfBB21vF,es-latam-f-profesional=fuVibWsnIUtzBVjB2PCa,es-latam-f-energica=HVK9l6HNiSZ10VavUTsq";

test("existing production configuration resolves distinct real voices for both web and worker", () => {
  const env = { AUDIO_STUDIO_PAID_TTS: "1", AUDIO_STUDIO_ELEVENLABS_VOICES: LEGACY };
  const web = voiceAvailability(env), worker = voiceAvailability(env);
  assert.ok(web.ok && worker.ok);
  const map = parseVoiceMap(LEGACY)!;
  for (const p of VOICE_PRESETS.filter(p => p.providerVoiceId)) {
    assert.equal(map[p.id], p.providerVoiceId);
    assert.equal(web.voice.voiceIdFor(p.id), p.providerVoiceId);
    assert.equal(worker.voice.voiceIdFor(p.id), p.providerVoiceId);
  }
  const spanish = VOICE_PRESETS.filter(p => p.language === "es");
  assert.equal(new Set(spanish.map(p => map[p.id])).size, spanish.length);
  assert.equal(map["es-latam-m-profesional"], "TbvhqFC7AApJv7hnNvmY");
  assert.equal(parseVoiceMap(`${LEGACY},es-public-m-brian=Override123`)!["es-public-m-brian"], "Override123");
  assert.equal(parseVoiceMap(undefined), null);
  assert.equal(parseVoiceMap("es-public-m-brian=Override123"), null);
});

test("new voice selection survives save/read and catalog uses the Spanish provider preview", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111", now = "2026-11-21T00:00:00.000Z";
  const project = applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerId, now }),
    { voiceCount: 2, voices: ["es-public-m-brian", "es-public-f-alice"] }, now);
  assert.deepEqual(parseStored(project, ownerId)?.voices, project.voices);
  const map = parseVoiceMap(LEGACY)!;
  const out = catalogFrom([{ voice_id: map["es-public-m-brian"], name: "Brian", category: "premade",
    preview_url: "https://example.com/en.mp3", verified_languages: [{ language: "es", preview_url: "https://example.com/es.mp3" }] }], map);
  assert.equal(out.find(v => v.id === "es-public-m-brian")?.previewUrl, "https://example.com/es.mp3");
  assert.equal(out.some(v => v.id === "es-public-f-alice"), false, "absent provider voice is never offered");
  assert.deepEqual(catalogFrom([{ voice_id: map["es-public-m-brian"], name: "Private", category: "cloned" }], map), []);
});
