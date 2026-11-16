import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInput, draftOutline, estimate, newProject, parseStored, readinessIssues, scriptLines, VOICE_PRESETS } from "./model";
import { catalogFrom, studioCatalog } from "./catalog";
import { createProject, saveProject } from "./service";
import { memoryStore } from "./store";

const ownerId = "11111111-1111-4111-8111-111111111111";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = "2026-11-16T22:00:00.000Z";

test("English persists across create, edit and storage; old projects keep Spanish and v2", async () => {
  const store = memoryStore();
  const result = await createProject({ store, newId: () => id, now: () => now }, ownerId, { title: "A new beginning", language: "en", voiceCount: 2 });
  assert.equal(result.status, 201);
  const project = (await store.get(ownerId, id))!;
  assert.equal(project.language, "en");
  assert.equal(project.ttsModel, "eleven_v4_turbo");
  assert.deepEqual(project.voices, ["en-us-m-roger", "en-us-f-sarah"]);
  assert.equal(parseStored(project, ownerId)!.language, "en");
  const old = { ...newProject({ id, ownerId, now }), language: undefined, ttsModel: undefined };
  assert.equal(parseStored(old, ownerId)!.language, "es");
  assert.equal(parseStored(old, ownerId)!.ttsModel, "eleven_multilingual_v2");
  assert.equal((await saveProject({ store }, ownerId, id, { revision: project.revision, language: "de" })).status, 400);
});

test("language edit changes revision and readiness, English dialogue parses two speakers", () => {
  const base = { ...newProject({ id, ownerId, now }), status: "listo_para_autorizar" as const };
  const edited = applyInput(base, { language: "en" }, now);
  assert.equal(edited.status, "borrador");
  assert.equal(edited.revision, base.revision + 1);
  assert.ok(readinessIssues(edited, estimate(edited)).includes("Elige voces del idioma seleccionado."));
  assert.deepEqual(scriptLines("## Welcome\nVoice 1: Hello there.\nVoice 2: Good morning.", 2).map(l => [l.voice, l.text]), [[0, "Hello there."], [1, "Good morning."]]);
  assert.match(draftOutline("A new beginning", 5, 2, "en"), /Voice 2:/);
  assert.equal(VOICE_PRESETS.filter(v => v.language === "en").length, 4);
  assert.equal(VOICE_PRESETS.filter(v => v.language === "es").length, 4);
});

test("catalog excludes private clones, absent voices and untrained model options", () => {
  const map = { "es-latam-m-profesional": "Victor123", "es-latam-m-calida": "Mateo123", "en-us-f-sarah": "Private123", "en-us-m-roger": "Roger123" };
  const out = catalogFrom([
    { voice_id: "Victor123", name: "Víctor", category: "professional", fine_tuning: { state: { eleven_v4_turbo: "fine_tuned", eleven_multilingual_v2: "fine_tuning" } } },
    { voice_id: "Private123", name: "Private", category: "professional", is_owner: true, preview_url: "https://example.com/private.mp3" },
    { voice_id: "Roger123", name: "Roger", category: "premade", preview_url: "http://unsafe.example/audio.mp3" },
  ], map);
  assert.deepEqual(out.map(v => v.id), ["es-latam-m-profesional", "en-us-m-roger"]);
  assert.deepEqual(out[0].models, ["eleven_v4_turbo"]);
  assert.equal(out[1].previewUrl, null);
});

test("catalog consultation makes exactly one GET and never synthesizes", async () => {
  const calls: string[] = [];
  await studioCatalog({}, { ELEVENLABS_API_KEY: "test" }, async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.body, undefined);
    return Response.json({ voices: [] });
  });
  assert.deepEqual(calls, ["https://api.elevenlabs.io/v1/voices"]);
});
