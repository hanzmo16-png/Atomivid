/**
 * Pista de subtítulos de Long Form, sobre el MP4 y el transcript que ya
 * están en el repo. No renderiza, no llama a proveedores y no modifica
 * el MP4 de origen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { asDownloadUrl } from "@/lib/storage/download-url";
import { transcodeToFit } from "./output-media";
import { canonicalSubtitlePath } from "./packaging";
import {
  LongFormSubtitleError,
  assertSubtitleTracks,
  attachLongFormSubtitles,
  elementarySha256,
  readSubtitleCues,
  subtitleTrackCount,
  validateSubtitleCues,
  type SubtitleCue,
} from "./subtitle-track";

const FIXTURE = path.join(process.cwd(), "docs/quality/directed-opening-v1/before.mp4");
const WITH_AUDIO = path.join(process.cwd(), "src/lib/providers/avatar/fixtures/simulated-avatar-video.mp4");
const MANIFEST = path.join(process.cwd(), "docs/quality/m2-panama-opening/sample-manifest.json");

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-500)))));
  });
}

async function durationSeconds(file: string): Promise<number> {
  const out = await new Promise<string>((resolve, reject) => {
    const proc = spawn(ffprobeInstaller.path, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.slice(-300)))));
  });
  return Number(out);
}

async function transcript(): Promise<{ startSeconds: number; endSeconds: number; text: string }[]> {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8")) as { scenes: { startSeconds: number; endSeconds: number; narration: string }[] };
  return manifest.scenes.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, text: s.narration }));
}

test("el MP4 de Long Form ya renderizado falla con tracks: 0 y el archivo no se modifica", async () => {
  const before = sha256(await readFile(FIXTURE));
  const tracks = await subtitleTrackCount(FIXTURE);
  assert.equal(tracks, 0);
  assert.throws(() => assertSubtitleTracks(tracks), (err: unknown) => err instanceof LongFormSubtitleError && err.message === "subtitle tracks: 0");
  assert.equal(sha256(await readFile(FIXTURE)), before);
});

test("el transcript existente se rechaza si un cue termina fuera de la duración, no tiene texto o no es monótono", async () => {
  const duration = await durationSeconds(FIXTURE);
  const cues = await transcript();
  assert.ok(cues.some((c) => c.endSeconds > duration), "el manifest de M2 sigue después de este MP4");
  assert.throws(() => validateSubtitleCues(cues, duration), (err: unknown) => err instanceof LongFormSubtitleError && /fuera de la duración/.test((err as Error).message));
  assert.throws(() => validateSubtitleCues([{ startSeconds: 0, endSeconds: 1, text: "  " }], duration), /sin texto/);
  assert.throws(
    () => validateSubtitleCues([{ startSeconds: 0, endSeconds: 2, text: "una" }, { startSeconds: 1, endSeconds: 3, text: "dos" }], duration),
    /no es monótono/,
  );
});

test("mux del transcript que cabe: texto, tiempos monótonos, fin dentro de la duración, playback y descarga del mismo archivo, video sin reencodificar", async () => {
  const original = await readFile(FIXTURE);
  const duration = await durationSeconds(FIXTURE);
  const cues: SubtitleCue[] = (await transcript()).filter((c) => c.text.trim() && c.endSeconds <= duration + 1e-3);
  assert.ok(cues.length >= 8, `se esperaban varios cues dentro de ${duration}s`);
  validateSubtitleCues(cues, duration);
  const videoBefore = await elementarySha256(FIXTURE, "v");
  const audioBefore = await elementarySha256(FIXTURE, "a");
  assert.equal(audioBefore, null, "este MP4 de Long Form no trae audio");
  const attached = await attachLongFormSubtitles({ videoPath: FIXTURE, captions: cues, durationSeconds: duration, language: "es" });
  try {
    assert.ok(attached.tracks >= 1);
    assert.doesNotThrow(() => assertSubtitleTracks(attached.tracks));
    const track = await readSubtitleCues(attached.videoPath);
    assert.equal(track.length, cues.length);
    let prevEnd = -Infinity;
    for (let i = 0; i < track.length; i++) {
      assert.ok(track[i].text.trim().length > 0);
      assert.equal(track[i].text.trim(), cues[i].text.trim());
      assert.ok(track[i].endSeconds > track[i].startSeconds);
      assert.ok(track[i].startSeconds + 1e-2 >= prevEnd, "tiempos monótonos");
      assert.ok(track[i].endSeconds <= duration + 1e-2, "el cue termina dentro de la duración");
      prevEnd = track[i].endSeconds;
    }
    const sidecar = await readFile(attached.sidecarPath, "utf8");
    assert.match(sidecar, /Imagina cavar una montaña/);
    assert.equal(path.basename(attached.sidecarPath), "subtitles.es.srt");
    assert.equal(canonicalSubtitlePath("req-1", "es"), "req-1/output/subtitles.es.srt");

    const playback = await readFile(attached.videoPath);
    const download = Buffer.from(playback);
    assert.equal(sha256(playback), sha256(download), "reproducción y descarga son el mismo objeto");
    const playUrl = "https://example.test/storage/v1/object/sign/videos/out/final.mp4?token=abc";
    const downloadUrl = asDownloadUrl(playUrl, "atomicvid-video.mp4");
    assert.equal(new URL(playUrl).pathname, new URL(downloadUrl).pathname, "la descarga no apunta a otro archivo");
    assert.equal(await elementarySha256(attached.videoPath, "v"), videoBefore, "el video no se reencodificó");
    assert.equal(await elementarySha256(attached.videoPath, "a"), audioBefore);
    assert.equal(sha256(await readFile(FIXTURE)), sha256(original), "el MP4 de origen no se modifica");
  } finally {
    await rm(attached.directory, { recursive: true, force: true });
  }
});

test("un MP4 existente con audio conserva video y audio al muxar el primer cue del transcript", async () => {
  const original = sha256(await readFile(WITH_AUDIO));
  const duration = await durationSeconds(WITH_AUDIO);
  const cue = (await transcript()).find((c) => c.endSeconds <= duration && c.text.trim());
  assert.ok(cue, "el transcript tiene un cue dentro de este MP4");
  const videoBefore = await elementarySha256(WITH_AUDIO, "v");
  const audioBefore = await elementarySha256(WITH_AUDIO, "a");
  assert.ok(videoBefore && audioBefore);
  const attached = await attachLongFormSubtitles({ videoPath: WITH_AUDIO, captions: [cue], durationSeconds: duration, language: "es" });
  try {
    assertSubtitleTracks(attached.tracks);
    const read = await readSubtitleCues(attached.videoPath);
    assert.equal(read[0].text.trim(), cue.text.trim());
    assert.ok(read[0].endSeconds <= duration + 1e-2);
    assert.equal(await elementarySha256(attached.videoPath, "v"), videoBefore);
    assert.equal(await elementarySha256(attached.videoPath, "a"), audioBefore);
    const playback = sha256(await readFile(attached.videoPath));
    const download = sha256(Buffer.from(await readFile(attached.videoPath)));
    assert.equal(playback, download);
    assert.equal(sha256(await readFile(WITH_AUDIO)), original);
  } finally {
    await rm(attached.directory, { recursive: true, force: true });
  }
});

test("el ajuste de tamaño no vuelve a dejar tracks: 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atomivid-subs-fit-"));
  const previous = process.env.FFMPEG_BIN;
  process.env.FFMPEG_BIN = ffmpegInstaller.path;
  try {
    const clip = path.join(dir, "clip.mp4");
    await run(ffmpegInstaller.path, ["-y", "-v", "error", "-i", FIXTURE, "-t", "2", "-c", "copy", clip]);
    const duration = await durationSeconds(clip);
    const cue: SubtitleCue = { startSeconds: 0.2, endSeconds: Math.min(1.2, duration - 0.05), text: "Imagina cavar una montaña con picos y palas," };
    assert.ok(cue.endSeconds > cue.startSeconds && cue.endSeconds <= duration);
    const attached = await attachLongFormSubtitles({ videoPath: clip, captions: [cue], durationSeconds: duration, language: "es" });
    const fitted = path.join(dir, "fit.mp4");
    await transcodeToFit({ sourcePath: attached.videoPath, outputPath: fitted, videoKbps: 500, audioKbps: 64 });
    const tracks = await subtitleTrackCount(fitted);
    assert.throws(() => assertSubtitleTracks(0), /tracks: 0/);
    assertSubtitleTracks(tracks);
    const read = await readSubtitleCues(fitted);
    assert.equal(read.length, 1);
    assert.equal(read[0].text.trim(), cue.text);
    assert.ok(read[0].endSeconds <= (await durationSeconds(fitted)) + 0.05);
    const playback = sha256(await readFile(fitted));
    const download = sha256(await readFile(fitted));
    assert.equal(playback, download);
    await rm(attached.directory, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_BIN;
    else process.env.FFMPEG_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
