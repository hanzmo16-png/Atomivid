import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import type { VoiceProvider } from "@/lib/providers/types";
import { measureLoudness, LOUDNESS_TARGET } from "@/lib/video/audio-master";
import { estimatePodcast, normalizeScript, podcastAudioPath, validateScript, PODCAST_MAX_CHARS } from "./episode";
import { narrateEpisode } from "./narrate";
import { parseVoices } from "./voices";

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("guion: normalización, límites y estimación = caracteres exactos enviados a la voz", () => {
  assert.equal(normalizeScript("  Hola\r\n\r\n\r\n\r\nmundo  \t\n"), "Hola\n\nmundo");
  assert.match(validateScript("corto")!, /al menos 20/);
  assert.match(validateScript("x".repeat(PODCAST_MAX_CHARS + 1))!, /no puede superar/);
  assert.equal(validateScript("Una frase suficientemente larga."), null);
  const text = Array.from({ length: 700 }, (_, i) => `Esta es la oración número ${i} del episodio.`).join(" ");
  const e = estimatePodcast(text);
  assert.equal(e.characters <= text.length && e.characters >= text.length - e.chunks, true);
  assert.ok(e.chunks >= 4);
  assert.equal(e.usd, Math.ceil(e.characters / 1000 * e.usdPer1kChars * 10000) / 10000);
});

test("voces: solo las de la cuenta, con id válido y vista previa https", () => {
  const v = parseVoices({ voices: [
    { voice_id: "uYlzyj2kIZo3HfBB21vF", name: "Mateo", category: "professional", labels: { language: "es", accent: "argentine", gender: "male" }, preview_url: "https://storage.googleapis.com/x.mp3" },
    { voice_id: "bad id", name: "X" }, { name: "Sin id" }, { voice_id: "abcdefgh12", name: "Ana", preview_url: "http://insecure" },
  ] });
  assert.deepEqual(v.map((x) => [x.name, x.previewUrl !== null]), [["Ana", false], ["Mateo", true]]);
  assert.deepEqual(parseVoices(null), []);
});

test("narración: pasa por el registro de pagos; repetir no vuelve a cobrar; master a -16 LUFS", { skip: !hasFfmpeg }, async () => {
  let calls = 0;
  // Stand-in with a paid provider name so the real gate runs (the fixture name bypasses it). Tone, not speech.
  const provider: VoiceProvider = { name: "elevenlabs", synthesize: async (t, l, s) => { calls++; return fixtureVoiceProvider.synthesize(t, l, s); } };
  const ledger = memoryLedgerStore(), results = memoryResultStore();
  const stored = new Map<string, Buffer>();
  const deps = { ledger, results, voiceProvider: provider, voiceIdentity: { voiceId: "abcdefgh12", modelId: "m", voiceSettingsJson: "{}" }, putAudio: async (p: string, b: Buffer) => { stored.set(p, b); } };
  // Few long words (> 9 000 chars → 2 chunks) keep the stand-in tone short and the test fast.
  const script = Array.from({ length: 220 }, (_, i) => `${"Electroencefalografistas".repeat(2)}${i}.`).join(" ");
  const ep = { id: "11111111-1111-1111-1111-111111111111", user_id: "u1", script, language: "es" as const };
  const first = await narrateEpisode(deps, ep);
  const chunks = first.chunks;
  assert.ok(chunks >= 2);
  assert.equal(calls, chunks);
  assert.equal(first.reusedChunks, 0);
  assert.ok(first.costUsd > 0);
  assert.equal([...ledger.ops.values()].filter((o) => o.status === "COMMITTED").length, chunks);
  const again = await narrateEpisode(deps, ep);
  assert.equal(calls, chunks, "no provider call on re-run");
  assert.deepEqual([again.reusedChunks, again.costUsd], [chunks, 0]);
  assert.ok(stored.has(podcastAudioPath(ep)));
  const dir = mkdtempSync(path.join(tmpdir(), "pod-")), f = path.join(dir, "e.m4a");
  writeFileSync(f, stored.get(podcastAudioPath(ep))!);
  const l = await measureLoudness(f);
  assert.ok(Math.abs(l.integratedLufs - LOUDNESS_TARGET.INTEGRATED_LUFS) <= 1, `LUFS ${l.integratedLufs}`);
  assert.ok(l.truePeakDbtp <= LOUDNESS_TARGET.TRUE_PEAK_DBTP, `TP ${l.truePeakDbtp}`);
});
