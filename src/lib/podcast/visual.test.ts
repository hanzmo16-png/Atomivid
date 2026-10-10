import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import type { VoiceProvider, WordTiming } from "@/lib/providers/types";
import type { FootageCandidateRaw } from "@/lib/ai/footage";
import { anchorOf, evenScenes, topicOf, MIN_CLIP_SPEED, pickClip, sceneLengths, sceneQueries, scenesFromWords, wordsJson } from "./visual-plan";
import { buildSceneShots, SHOT_MARGIN_SECONDS } from "./visual-assets";
import { buildPodcastMontage, type MontageScene } from "./video-montage";
import { narrateEpisode, storedNarrationWords } from "./narrate";

const hasPython = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const AUDIO = { path: "audio/episode.m4a", size: 100, sha256: "a".repeat(64) };

/** ~2.5 words per second, a sentence every 9 words. */
function speech(seconds: number): WordTiming[] {
  const vocab = ["ovni", "desierto", "Arizona", "bosque", "leñadores", "camioneta", "policía", "luces", "noche", "testigos"];
  const out: WordTiming[] = [];
  for (let i = 0, t = 0; t + 0.4 < seconds; i++, t += 0.4) out.push({ text: vocab[i % vocab.length] + (i % 9 === 8 ? "." : ""), startSeconds: t, endSeconds: t + 0.35 });
  return out;
}

test("plan visual: escenas contiguas que siguen la narración y cubren todo el audio", () => {
  for (const seconds of [34.7, 1800]) {
    const lengths = sceneLengths(seconds);
    const scenes = scenesFromWords(speech(seconds), seconds, "Travesía", lengths);
    assert.equal(scenes[0].start, 0);
    assert.equal(scenes[scenes.length - 1].end, seconds);
    scenes.forEach((s, i) => {
      if (i) assert.equal(s.start, scenes[i - 1].end, "contiguous");
      assert.ok(s.end - s.start <= lengths.max + lengths.min, `scene ${i} ${s.end - s.start}s`);
      assert.ok(s.query.length > 0);
    });
    if (seconds === 1800) assert.ok(scenes.length >= 80 && scenes.length <= 180, `${scenes.length} scenes`);
  }
  const even = evenScenes(95, "Mi episodio", "Uno. Dos. Tres. Cuatro.", 12);
  assert.equal(even[even.length - 1].end, 95);
  assert.deepEqual(sceneQueries({ text: "el desierto de Arizona y el desierto", query: "x" }, "Luces"), ["desierto arizona", "desierto", "luces"]);
});

test("coherencia: cada búsqueda va anclada al tema del episodio; el título es el último recurso", () => {
  const script = "Los ovnis sobre el desierto. Hubo testigos de ovnis en Arizona. Los encuentros con ovnis del primer tipo. " +
    "¿Qué significan realmente los encuentros de la tercera, la cuarta? Acompáñame a descubrir sus diferencias, sus contradicciones.";
  assert.equal(anchorOf(script), "ovnis");
  const scenes = evenScenes(40, "Misterios del universo", script, 10);
  const last = scenes[scenes.length - 1];
  assert.match(last.text, /contradicciones/);
  assert.deepEqual(last.queries, ["encuentros ovnis", "ovnis", "misterios universo"]);
  assert.ok(scenes.every((s) => s.queries?.every((q, i, a) => i === a.length - 1 || q.includes("ovnis"))), "every stock search stays on the subject");
  assert.equal(topicOf("ovni ovni", "Ovni").get("ovni"), 5, "title words weigh extra in the ranking");
  assert.equal(anchorOf("Una sola frase sin repeticiones."), null, "no recurrent subject → scene terms");
});

test("subtítulos: palabras ordenadas, sin solaparse y dentro del audio", () => {
  const w = wordsJson([{ text: "Hola", startSeconds: 0, endSeconds: 0.5 }, { text: " ", startSeconds: 0.5, endSeconds: 0.6 }, { text: "mundo", startSeconds: 0.4, endSeconds: 9.9 }, { text: "fuera", startSeconds: 9.95, endSeconds: 10.4 }], 10);
  assert.deepEqual(w.words.map((x) => x.text), ["Hola", "mundo"]);
  assert.equal(w.words[1].start, 0.5);
  assert.ok(w.words[1].end <= 9.85);
});

test("selector de clips: duración suficiente, sin repetir el anterior, prefiere no usados", () => {
  const c = (id: string, d: number) => ({ sourceId: id, durationSeconds: d });
  assert.deepEqual(pickClip([c("a", 20), c("b", 30)], 15, ["a"], new Set()), { clip: c("b", 30), speed: 1 });
  assert.equal(pickClip([c("a", 20), c("b", 30)], 15, [], new Set(["a"]))?.clip.sourceId, "b");
  assert.equal(pickClip([c("a", 12)], 15, [], new Set())?.speed, 0.8);
  assert.equal(pickClip([c("a", 15 * MIN_CLIP_SPEED - 0.1)], 15, [], new Set()), null);
  assert.equal(pickClip([c("a", 20)], 15, ["a"], new Set()), null);
});

test("recursos: clip → foto animada → nada; nunca el mismo clip seguido; búsquedas en caché", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "shots-"));
  const scenes = scenesFromWords(speech(60), 60, "Luces en el cielo", sceneLengths(60));
  const searches: string[] = [];
  const video = (id: string, d = 40): FootageCandidateRaw => ({ url: `https://v/${id}`, sourceId: id, durationSeconds: d, photographer: "Ana" });
  let renderFails = 1;
  const shots = await buildSceneShots(scenes, "Luces en el cielo", dir, {
    // Only one long clip for every query: it can never be used twice in a row.
    searchVideos: async (q) => { searches.push(`v:${q}`); return [video("only")]; },
    searchPhotos: async (q) => { searches.push(`p:${q}`); return [{ url: "https://p/1", sourceId: "photo-1", photographer: "Luis" }]; },
    download: async (_url, dest) => writeFileSync(dest, "x"),
    renderClip: async (_s, dest, seconds, speed) => { if (renderFails-- > 0) throw new Error("bad clip"); assert.ok(speed >= MIN_CLIP_SPEED && seconds > 0); writeFileSync(dest, "clip"); },
    renderPhoto: async (_s, dest) => writeFileSync(dest, "photo"),
  });
  assert.equal(shots.length, scenes.length);
  shots.forEach((s, i) => { if (i && s && shots[i - 1]) assert.notEqual(s.sourceId, shots[i - 1]!.sourceId); });
  assert.ok(shots.some((s) => s?.kind === "video") && shots.some((s) => s?.kind === "photo"));
  assert.equal(new Set(searches).size, searches.length, "each query searched once");
  assert.equal(shots[1]?.seconds, Number((scenes[1].end - scenes[1].start + SHOT_MARGIN_SECONDS).toFixed(3)));
  const none = await buildSceneShots(scenes.slice(0, 2), "t", dir, { searchVideos: async () => { throw new Error("429"); }, searchPhotos: async () => [], download: async () => undefined, renderClip: async () => undefined, renderPhoto: async () => undefined });
  assert.deepEqual(none, [null, null]);
});

test("montaje por escenas: movimiento en cada escena, duración exacta, subtítulos, título y créditos", () => {
  const shot = (n: number, seconds = 20) => ({ path: `medios/escena-${n}.mp4`, size: 10, sha256: String(n).repeat(64).slice(0, 64), seconds, credit: `Autor ${n} / Pexels`, pageUrl: `https://pexels.com/${n}` });
  const scenes: MontageScene[] = [
    { start: 0, end: 12.31, shot: shot(1) }, { start: 12.31, end: 25, shot: shot(2) }, { start: 25, end: 37.5, shot: null },
    { start: 37.5, end: 50, shot: shot(3) }, { start: 50, end: 61.02, shot: null },
  ];
  type Seg = { type: string; duration: number; source?: string };
  type SceneMontage = { timeline: Seg[]; files: { id: string; role: string }[]; subtitles?: unknown; title_card: { text: string }; sources_credits: { sources: unknown[] }; audio: unknown };
  const m = buildPodcastMontage({ episodeId: "e1", version: 3, title: "Luces", durationSeconds: 61.02, audio: AUDIO, scenes, subtitles: { path: "subtitulos.json", size: 5, sha256: "c".repeat(64) } }) as unknown as SceneMontage;
  assert.equal(m.timeline.length, 5);
  assert.ok(m.timeline.every((s) => s.type === "animation"), "no dark cards when an earlier shot can cover the scene");
  assert.equal(m.timeline[2].source, "escena-1", "missing scene borrows a non-adjacent earlier shot");
  const total = m.timeline.reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(total - 61.02) < 0.04, `total ${total}`);
  m.timeline.forEach((s) => assert.equal(Math.round(s.duration * 25), Number((s.duration * 25).toFixed(6)), "frame aligned"));
  assert.deepEqual(m.subtitles, { source: "subtitulos", format: "words_json", mode: "burn", group_max_words: 7 });
  assert.equal(m.files.find((f) => f.id === "subtitulos")?.role, "subtitles_words");
  assert.equal(m.title_card.text, "Luces");
  assert.equal(m.sources_credits.sources.length, 3);
  assert.deepEqual(m.audio, { modo: "mezcla_final", source: "mezcla", timeline: "extender_ultimo" });
  // Nothing covers the scene (all earlier shots too short or adjacent) → that one scene only is a card.
  const lone = buildPodcastMontage({ episodeId: "e1", version: 1, title: "T", durationSeconds: 30, audio: AUDIO, scenes: [{ start: 0, end: 10, shot: shot(1, 10.5) }, { start: 10, end: 30, shot: null }] });
  assert.deepEqual(lone.timeline.map((s) => s.type), ["animation", "card"]);
  // No shots at all → the previous chapter cards (no stock available).
  assert.ok(buildPodcastMontage({ episodeId: "e1", version: 1, title: "T", durationSeconds: 30, audio: AUDIO, scenes: [{ start: 0, end: 30, shot: null }] }).timeline.every((s) => s.type === "card"));
});

test("montaje por escenas: el editor v3 lo acepta (esquema + semántica)", { skip: !hasPython }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "montage-"));
  const shot = (n: number) => ({ path: `medios/escena-${n}.mp4`, size: 10, sha256: "d".repeat(64), seconds: 13, credit: `Autor ${n} / Pexels`, pageUrl: `https://pexels.com/${n}` });
  const m = buildPodcastMontage({ episodeId: "e1", version: 1, title: "Luces", durationSeconds: 36, audio: AUDIO,
    scenes: [{ start: 0, end: 12, shot: shot(1) }, { start: 12, end: 24, shot: null }, { start: 24, end: 36, shot: shot(2) }], subtitles: { path: "subtitulos.json", size: 5, sha256: "c".repeat(64) } });
  writeFileSync(path.join(dir, "montaje.json"), JSON.stringify(m));
  const out = execFileSync("python3", [path.resolve("scripts/podcast-editor-v3/editor.py"), "validate", path.join(dir, "montaje.json")], { encoding: "utf8" });
  assert.match(out, /VALID/);
});

test("subtítulos de una narración ya pagada: se reconstruyen sin llamar a la voz ni al registro", { skip: !hasFfmpeg }, async () => {
  let calls = 0;
  const provider: VoiceProvider = { name: "elevenlabs", synthesize: async (t, l, s) => { calls++; return fixtureVoiceProvider.synthesize(t, l, s); } };
  const ledger = memoryLedgerStore(), results = memoryResultStore();
  const voiceIdentity = { voiceId: "abcdefgh12", modelId: "m", voiceSettingsJson: "{}" };
  const script = Array.from({ length: 220 }, (_, i) => `${"Electroencefalografistas".repeat(2)}${i}.`).join(" ");
  const ep = { id: "22222222-2222-2222-2222-222222222222", user_id: "u1", script, language: "es" as const };
  assert.equal(await storedNarrationWords({ results, voiceProvider: provider, voiceIdentity }, ep), null, "nothing stored → no subtitles, no call");
  assert.equal(calls, 0);
  const first = await narrateEpisode({ ledger, results, voiceProvider: provider, voiceIdentity, putAudio: async () => undefined }, ep);
  const ops = ledger.ops.size;
  const words = await storedNarrationWords({ results, voiceProvider: provider, voiceIdentity }, ep);
  assert.equal(calls, first.chunks, "no extra provider call");
  assert.equal(ledger.ops.size, ops, "no ledger row");
  assert.ok(words && words.length > 0);
  for (let i = 1; i < words!.length; i++) assert.ok(words![i].startSeconds >= words![i - 1].startSeconds, "monotonic across chunks");
  assert.ok(words![words!.length - 1].endSeconds <= first.durationSeconds + 0.05);
  assert.equal(await storedNarrationWords({ results, voiceProvider: provider, voiceIdentity: { ...voiceIdentity, voiceId: "otherVoice1" } }, ep), null, "another voice is never reused");
});
