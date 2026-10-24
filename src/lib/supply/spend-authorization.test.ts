/**
 * Travis Walton Ep. 2 — free tests (USD 0, mocked providers, no network). Every provider is a spy; global fetch
 * throws if anything tries to reach the network (so no image, avatar or real ElevenLabs call can happen).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { ReconciliationRequiredError } from "@/lib/production-intelligence/ledger";
import type { VoiceProvider } from "@/lib/providers/types";
import { narrateEpisode, NarrationCapError } from "@/lib/podcast/narrate";
import { podcastLedgerProject } from "@/lib/podcast/episode";
import { splitNarrationIntoSafeChunks, MAX_TTS_CHARS_PER_CALL } from "@/lib/video/long-form/timeline";
import { exportAudioOnly } from "@/lib/podcast/audio-export";
import { authorizedLedger, authorizationUsage, requiresAuthorization, resumeAuthorizationRefusal, SpendAuthorizationError, type SpendAuthorization } from "./spend-authorization";

const OWNER = "d2064950-0000-4000-8000-000000000000";
const EP = "2a000000-0000-4000-8000-0000000000e2";
const PROJECT = podcastLedgerProject(EP);
const RATE = 0.2; // production rate (pi_supply_policies.unit_cost_usd 0.0002/char; episode 2300cf1c: 7642 chars = USD 1.5285)
let realFetch: typeof fetch; let netCalls = 0;
before(() => {
  process.env.FFMPEG_BIN = ffmpegInstaller.path;
  process.env.PRICING_ELEVENLABS_USD_PER_1K_CHARS = String(RATE);
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { netCalls++; throw new Error("NETWORK_FORBIDDEN_IN_TEST"); }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

const tone = (seconds: number) => execFileSync(ffmpegInstaller.path, ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"]);
const TONE = tone(0.6);

/** ElevenLabs spy: same name as the real adapter (so the paid-call gate treats it as paid), never touches the network. */
function spyVoice(opts: { failOn?: (n: number) => Error | null } = {}) {
  const calls: string[] = [];
  const provider: VoiceProvider = { name: "elevenlabs", async synthesize(text: string) {
    calls.push(text);
    const e = opts.failOn?.(calls.length); if (e) throw e;
    return { audioBuffer: TONE, durationSeconds: 0.6, words: [{ text: "x", startSeconds: 0, endSeconds: 0.5 }], mimeType: "audio/mpeg", extension: "mp3" };
  } } as VoiceProvider;
  return { provider, calls };
}

// ~20 minutes of single-narrator script: 1200 s × 14 chars/s (measured on episode 2300cf1c: 7642 chars → 546 s).
const sentence = "Travis Walton desapareció en el bosque de Sitgreaves la noche del cinco de noviembre de mil novecientos setenta y cinco. ";
const SCRIPT_20MIN = sentence.repeat(Math.ceil(16_800 / sentence.length)).trim();
const episode = { id: EP, user_id: OWNER, script: SCRIPT_20MIN, language: "es" as const };

function setup(auth: SpendAuthorization | null, voice = spyVoice()) {
  const base = memoryLedgerStore();
  let current = auth;
  const ledger = authorizedLedger(base, { get: async (p) => (current && current.projectId === p ? current : null) }, (p) => (p === PROJECT ? OWNER : null));
  const results = memoryResultStore();
  const puts: { path: string; contentType: string; bytes: Buffer }[] = [];
  const deps = { ledger, results, voiceProvider: voice.provider, voiceIdentity: { voiceId: "voiceDavid01", modelId: "eleven_multilingual_v2", voiceSettingsJson: "{}" },
    putAudio: async (path: string, bytes: Buffer, contentType: string) => { puts.push({ path, contentType, bytes }); } };
  return { base, ledger, results, deps, puts, voice, setAuth: (a: SpendAuthorization | null) => { current = a; } };
}
const AUTH = (capUsd: number, status: "ACTIVE" | "CLOSED" = "ACTIVE"): SpendAuthorization => ({ projectId: PROJECT, ownerId: OWNER, capUsd, authorizationRef: "hans-walton-ep2", status });

test("chunking: 20 min ≈ 16,800 chars → ceil(16,800/9,000) = 2 ElevenLabs calls (podcast 1.x single narrator)", () => {
  const chunks = splitNarrationIntoSafeChunks(SCRIPT_20MIN);
  assert.equal(MAX_TTS_CHARS_PER_CALL, 9000);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 9000));
  assert.ok(requiresAuthorization(PROJECT) && requiresAuthorization("documentary:u:p") && !requiresAuthorization("7e964d4a-0000"));
});

test("missing authorization: ZERO provider calls, nothing stored, refusal is terminal", async () => {
  const t = setup(null);
  await assert.rejects(narrateEpisode(t.deps, episode), (e: unknown) => e instanceof SpendAuthorizationError && e.reason === "authorization missing");
  assert.equal(t.voice.calls.length, 0); assert.equal(t.puts.length, 0); assert.equal(netCalls, 0);
  assert.ok([...t.base.ops.values()].every((o) => o.status !== "SUBMITTED" && o.status !== "COMMITTED"));
});

test("closed authorization or another owner's authorization: ZERO provider calls", async () => {
  for (const a of [AUTH(5, "CLOSED"), { ...AUTH(5), ownerId: "someone-else" }]) {
    const t = setup(a);
    await assert.rejects(narrateEpisode(t.deps, episode), SpendAuthorizationError);
    assert.equal(t.voice.calls.length, 0);
  }
});

test("budget exhaustion: USD 3.00 cannot pay 20 min at USD 0.20/1k chars; the DB-side check stops before the 2nd call", async () => {
  const t = setup(AUTH(3.0));
  await assert.rejects(narrateEpisode(t.deps, episode), (e: unknown) => e instanceof SpendAuthorizationError && e.reason === "authorization exceeded");
  assert.equal(t.voice.calls.length, 1, "first chunk paid, second refused before the provider");
  const u = authorizationUsage(AUTH(3.0), await t.base.listByProjects!([PROJECT]));
  assert.ok(u.committedUsd <= 3.0, `committed ${u.committedUsd}`);
});

test("app-side cap and DB-side authorization agree: NarrationCapError before the provider when capUsd is lower", async () => {
  const t = setup(AUTH(10));
  await assert.rejects(narrateEpisode({ ...t.deps, capUsd: 1.0 }, episode), NarrationCapError);
  assert.equal(t.voice.calls.length, 0);
});

test("interruption + recovery: stored chunk reused at USD 0, only the missing chunk is paid once (no duplicate charge)", async () => {
  const t = setup(AUTH(2.0)); // enough for one chunk only → run 1 is interrupted after chunk 1
  await assert.rejects(narrateEpisode(t.deps, episode), SpendAuthorizationError);
  assert.equal(t.voice.calls.length, 1);
  t.setAuth(AUTH(3.6)); // owner raises the stored authorization explicitly
  const out = await narrateEpisode(t.deps, episode);
  assert.equal(t.voice.calls.length, 2, "chunk 1 never re-synthesized");
  assert.equal(out.reusedChunks, 1); assert.equal(out.chunks, 2);
  const again = await narrateEpisode(t.deps, episode);
  assert.equal(t.voice.calls.length, 2, "a full re-run is free"); assert.equal(again.costUsd, 0);
  const ops = [...t.base.ops.values()];
  assert.equal(ops.filter((o) => o.status === "COMMITTED").length, 2);
  assert.ok(authorizationUsage(AUTH(3.6), ops).committedUsd <= 3.6);
});

test("ambiguous provider failure (response lost) blocks the retry instead of paying twice", async () => {
  const voice = spyVoice({ failOn: (n) => (n === 2 ? new Error("fetch failed") : null) });
  const t = setup(AUTH(5), voice);
  await assert.rejects(narrateEpisode(t.deps, episode));
  const before = voice.calls.length;
  await assert.rejects(narrateEpisode(t.deps, episode), (e: unknown) => e instanceof ReconciliationRequiredError || e instanceof SpendAuthorizationError);
  assert.equal(voice.calls.length, before, "no second send of the uncertain chunk");
});

test("concurrency: two resumes racing on the same episode pay each chunk once and never pass the cap", async () => {
  const t = setup(AUTH(3.6));
  const [a, b] = await Promise.allSettled([narrateEpisode(t.deps, episode), narrateEpisode(t.deps, episode)]);
  assert.ok(a.status === "fulfilled" || b.status === "fulfilled", "at least one run completes");
  assert.equal(new Set(t.voice.calls).size, t.voice.calls.length, "no chunk synthesized twice");
  assert.ok(t.voice.calls.length <= 2);
  assert.ok(authorizationUsage(AUTH(3.6), [...t.base.ops.values()]).committedUsd <= 3.6);
});

test("concurrency: two different paid calls racing for the last remaining amount → exactly one admitted", async () => {
  const t = setup(AUTH(1.0));
  const mk = (n: string) => narrateEpisode(t.deps, { ...episode, script: `Bloque ${n}. ` + "palabra ".repeat(560) }); // ~4.5k chars ≈ USD 0.9 each
  const r = await Promise.allSettled([mk("A"), mk("B")]);
  assert.equal(t.voice.calls.length, 1);
  assert.equal(r.filter((x) => x.status === "rejected" && x.reason instanceof SpendAuthorizationError).length, 1);
});

test("audio-only: output is AAC/M4A with no video stream; MP3/WAV derive locally; zero image/avatar/network calls", async () => {
  const t = setup(AUTH(3.6));
  const out = await narrateEpisode(t.deps, episode);
  assert.equal(t.puts.length, 1); assert.equal(t.puts[0].contentType, "audio/mp4"); assert.match(out.audioPath, /\.m4a$/);
  const probe = (b: Buffer, ext: string) => {
    const f = `/tmp/walton-test.${ext}`; writeFileSync(f, b);
    return JSON.parse(execFileSync(ffprobeInstaller.path, ["-v", "error", "-show_streams", "-of", "json", f]).toString()).streams.map((s: { codec_type: string }) => s.codec_type);
  };
  assert.deepEqual(probe(t.puts[0].bytes, "m4a"), ["audio"]);
  for (const fmt of ["mp3", "wav"] as const) {
    const x = await exportAudioOnly(t.puts[0].bytes, fmt);
    assert.deepEqual(probe(x.bytes, fmt), ["audio"], fmt);
  }
  assert.equal(netCalls, 0, "no HTTP at all: no image, avatar or video provider was reached");
  assert.ok([...t.base.ops.values()].every((o) => o.provider === "elevenlabs" && o.method === "tts_with_timestamps"), "only TTS rows in the ledger");
});

test("resume preflight refuses without a stored, active, owner-matching, funded authorization", () => {
  assert.match(resumeAuthorizationRefusal(null, OWNER, null)!, /no stored/);
  assert.match(resumeAuthorizationRefusal(AUTH(1, "CLOSED"), OWNER, { pendingUsd: 0, remainingUsd: 1 })!, /closed/);
  assert.match(resumeAuthorizationRefusal(AUTH(1), "x", { pendingUsd: 0, remainingUsd: 1 })!, /another owner/);
  assert.match(resumeAuthorizationRefusal(AUTH(1), OWNER, { pendingUsd: 0.1, remainingUsd: 1 })!, /uncertain/);
  assert.match(resumeAuthorizationRefusal(AUTH(1), OWNER, { pendingUsd: 0, remainingUsd: 0 })!, /exhausted/);
  assert.equal(resumeAuthorizationRefusal(AUTH(1), OWNER, { pendingUsd: 0, remainingUsd: 1 }), null);
});
