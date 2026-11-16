/**
 * Adenda T-2116: v4 Turbo preferido, varias voces por participante y episodios en español o inglés. Todo con la voz de
 * prueba local (espeak-ng) y ffmpeg real; ninguna llamada a ElevenLabs (USD 0).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyInput, DEFAULT_TTS_MODEL, newProject, parseStored, VOICE_PRESETS, voicesFor, defaultSecondVoice, type Language, type TtsModelId } from "./model";
import { memoryStore } from "./store";
import { createProject, requestGeneration, saveProject, view } from "./service";
import { fixtureVoice, parseVoiceMap, segmentKey, settingsFor, voiceAvailability, type VoiceAvailability } from "./voice";
import { renderProject } from "./render";

const A = "11111111-1111-4111-8111-111111111111";
const MUSIC = path.join(tmpdir(), "audio-studio-test-music");
let n = 900;
const ids = () => `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, "0")}`;
const NOW = "2026-11-16T23:00:00.000Z";

test("catálogo: al menos dos voces por idioma y género; perfiles en inglés sin nombres propios inventados", () => {
  for (const l of ["es", "en"] as Language[]) {
    const pool = voicesFor(l);
    assert.ok(pool.length >= 4, `${l}: ${pool.length}`);
    assert.ok(pool.filter((v) => v.gender === "masculina").length >= 2 && pool.filter((v) => v.gender === "femenina").length >= 2);
  }
  for (const v of voicesFor("en")) assert.match(v.label, /^(Masculina|Femenina) [a-záéíóú]+ \(inglés\)$/);
  assert.equal(new Set(VOICE_PRESETS.map((v) => v.id)).size, VOICE_PRESETS.length);
});

test("idioma del proyecto: es/en, voces del mismo idioma, sin sustitución silenciosa; se conserva al guardar y releer", async () => {
  const p = newProject({ id: ids(), ownerId: A, now: NOW, language: "en" });
  assert.equal(p.language, "en");
  assert.equal(p.voices[0], voicesFor("en")[0].id);
  assert.equal(p.ttsModel, DEFAULT_TTS_MODEL);
  assert.equal(voicesFor("en").some((v) => v.id === defaultSecondVoice(p.voices[0])), true, "la segunda voz por defecto es del mismo idioma");
  // Cambiar el idioma sin elegir voces del nuevo idioma: error explícito (nunca se reemplaza la voz en silencio).
  assert.throws(() => applyInput(p, { language: "es" }, NOW), /no es del idioma del episodio/);
  assert.throws(() => applyInput(p, { voices: ["es-latam-m-profesional"] }, NOW), /no es del idioma del episodio/);
  assert.throws(() => applyInput(p, { language: "fr" as Language }, NOW), /Idioma no admitido/);
  const es = applyInput(p, { language: "es", voices: ["es-latam-f-profesional"] }, NOW);
  assert.equal(es.language, "es");
  // Diálogo: cada participante elige su voz, distinta, del idioma.
  const duo = applyInput(p, { voiceCount: 2, voices: ["en-us-f-energica", "en-us-m-calida"] }, NOW);
  assert.deepEqual(duo.voices, ["en-us-f-energica", "en-us-m-calida"]);
  assert.throws(() => applyInput(p, { voiceCount: 2, voices: ["en-us-m-calida", "en-us-m-calida"] }, NOW), /distintas/);
  // Releer: se conserva idioma y voces; un archivo sin idioma se lee como español.
  const back = parseStored(JSON.parse(JSON.stringify(duo)), A)!;
  assert.equal(back.language, "en"); assert.deepEqual(back.voices, duo.voices);
  const legacy = { ...JSON.parse(JSON.stringify(newProject({ id: ids(), ownerId: A, now: NOW }))) }; delete legacy.language; delete legacy.ttsModel;
  const lp = parseStored(legacy, A)!;
  assert.equal(lp.language, "es"); assert.equal(lp.ttsModel, "eleven_multilingual_v2", "proyecto antiguo: v2 (no cambia de modelo al leerse)");
  // API de creación: idioma inválido → 400; válido → proyecto en inglés.
  const store = memoryStore();
  assert.equal((await createProject({ store }, A, { title: "X", language: "de" })).status, 400);
  const c = await createProject({ store }, A, { title: "Hello", language: "en", voiceCount: 2 });
  assert.equal(c.status, 201);
  const cv = c.body as ReturnType<typeof view>;
  assert.equal(cv.language, "en"); assert.ok(cv.voices.every((v) => voicesFor("en").some((x) => x.id === v)));
  // Guardar con revisión: cambia idioma y voces juntos; el contenido cambiado invalida la autorización (vuelve a borrador).
  const s = await saveProject({ store }, A, cv.id, { revision: cv.revision, language: "es", voices: ["es-latam-m-calida", "es-latam-f-energica"] });
  assert.equal(s.status, 200); assert.equal((s.body as ReturnType<typeof view>).language, "es");
});

test("caché: la clave separa proveedor, modelo, idioma, voz, texto y ajustes", () => {
  const base = segmentKey("elevenlabs", "eleven_v4_turbo", "voz", "hola", settingsFor("eleven_v4_turbo"), "es");
  const variants = [
    segmentKey("fixture-espeak", "eleven_v4_turbo", "voz", "hola", settingsFor("eleven_v4_turbo"), "es"),
    segmentKey("elevenlabs", "eleven_multilingual_v2", "voz", "hola", settingsFor("eleven_v4_turbo"), "es"),
    segmentKey("elevenlabs", "eleven_v4_turbo", "voz", "hola", settingsFor("eleven_v4_turbo"), "en"),
    segmentKey("elevenlabs", "eleven_v4_turbo", "otra", "hola", settingsFor("eleven_v4_turbo"), "es"),
    segmentKey("elevenlabs", "eleven_v4_turbo", "voz", "hola.", settingsFor("eleven_v4_turbo"), "es"),
    segmentKey("elevenlabs", "eleven_v4_turbo", "voz", "hola", settingsFor("eleven_multilingual_v2"), "es"),
  ];
  assert.equal(new Set([base, ...variants]).size, 7);
});

/** Proyecto corto en cola con autorización (sin música para que sea rápido). */
async function queued(store: ReturnType<typeof memoryStore>, language: Language, voices: string[], script: string, model: TtsModelId = "eleven_v4_turbo") {
  const id = ids(), now = new Date().toISOString();
  const p = applyInput(newProject({ id, ownerId: A, now, title: `Prueba ${language}`, language }), { voiceCount: voices.length as 1 | 2, voices, targetMinutes: 5, script, ttsModel: model, music: { mode: "sin_musica", mood: "reflexiva", volume: 18, ducking: true, intro: false, outro: false } }, now);
  await store.create(p);
  await store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", heartbeatAt: now, error: null, authorization: { usd: 1, revision: p.revision, at: now, spentBefore: 0, model } } });
  return id;
}

test("matriz modelo × idioma × voz con fixture: monólogo y diálogo en español e inglés, dos voces distintas por idioma", async () => {
  const store = memoryStore();
  const calls: { model: TtsModelId; voiceId: string; text: string }[] = [];
  const voice = fixtureVoice({ calls });
  const cases = [
    { language: "es" as Language, voices: ["es-latam-m-profesional"], script: "## Uno\nHola, esta es una prueba en español." },
    { language: "es" as Language, voices: ["es-latam-f-profesional", "es-latam-m-calida"], script: "## Uno\nVoz 1: Hola, bienvenidos.\nVoz 2: Gracias por estar aquí." },
    { language: "en" as Language, voices: ["en-us-f-profesional"], script: "## One\nHello, this is an English test." },
    { language: "en" as Language, voices: ["en-us-m-profesional", "en-us-f-energica"], script: "## One\nVoice 1: Hello and welcome.\nVoice 2: Thanks for having me." },
  ];
  const results: { language: Language; voices: string; model: TtsModelId; secs: number; calls: string[] }[] = [];
  for (const c of cases) {
    const before = calls.length;
    const id = await queued(store, c.language, c.voices, c.script);
    assert.equal(await renderProject({ store, voice, musicDir: MUSIC }, A, id), "terminada", JSON.stringify((await store.get(A, id))!.generation.error));
    const done = (await store.get(A, id))!;
    const used = calls.slice(before).map((x) => x.voiceId);
    // Cada participante con su propia voz; ninguna voz de otro idioma.
    assert.deepEqual([...new Set(used)].sort(), c.voices.map((v) => `fixture-${v}`).sort());
    assert.equal(done.audio!.model, "eleven_v4_turbo");
    assert.ok(done.audio!.durationSeconds > 1);
    results.push({ language: c.language, voices: c.voices.join("+"), model: done.audio!.model, secs: done.audio!.durationSeconds, calls: used });
  }
  // Misma voz y mismo texto en otro modelo: no reutiliza la caché del modelo anterior.
  const before = calls.length;
  const id2 = await queued(store, "es", ["es-latam-m-profesional"], "## Uno\nHola, esta es una prueba en español.", "eleven_multilingual_v2");
  assert.equal(await renderProject({ store, voice, musicDir: MUSIC }, A, id2), "terminada");
  assert.equal(calls.length - before, 1);
  console.log("MATRIZ_IDIOMAS", JSON.stringify(results));
});

test("voz real parcial: solo perfiles con voz validada; los demás quedan «en preparación» y no se puede generar con ellos", async () => {
  assert.equal(parseVoiceMap(undefined), null);
  assert.equal(parseVoiceMap("inventado=AbCdEfGh12"), null, "perfil inexistente no cuenta");
  const map = parseVoiceMap("es-latam-m-profesional=TbvhqFC7AApJv7hnNvmY");
  assert.deepEqual(map, { "es-latam-m-profesional": "TbvhqFC7AApJv7hnNvmY" });
  const real = voiceAvailability({ AUDIO_STUDIO_PAID_TTS: "1", AUDIO_STUDIO_ELEVENLABS_VOICES: "es-latam-m-profesional=TbvhqFC7AApJv7hnNvmY" }) as Extract<VoiceAvailability, { ok: true }>;
  assert.equal(real.ok, true); assert.deepEqual(real.voice.realPresets, ["es-latam-m-profesional"]);
  const store = memoryStore(); const id = ids(), now = new Date().toISOString();
  const p = applyInput(newProject({ id, ownerId: A, now, title: "Real", language: "en" }), { targetMinutes: 5, script: "word ".repeat(760), budgetUsd: 5 }, now);
  await store.create(p);
  const v = view(p, {}, real);
  assert.ok(v.readiness.some((r) => /en preparación/.test(r)), JSON.stringify(v.readiness));
  const r = await requestGeneration({ store, env: {}, voice: real }, A, id, { revision: p.revision, confirmUsd: v.estimate.estimatedUsd });
  assert.equal(r.status, 422, "no se encola con una voz sin validar");
  assert.equal((await store.get(A, id))!.generation.status, "inactiva");
  // Sin interruptor de pago: la voz no está disponible y no hay llamadas.
  assert.equal(voiceAvailability({ AUDIO_STUDIO_ELEVENLABS_VOICES: "es-latam-m-profesional=TbvhqFC7AApJv7hnNvmY" }).ok, false);
});
