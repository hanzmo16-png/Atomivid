/**
 * Podcast worker (GitHub Actions, .github/workflows/podcast-video.yml). Dispatched by the app with only the
 * episode id. Two jobs:
 *  - narration: background narration of a long script (same gated, resumable runGeneration as the web route);
 *  - video: narration first if needed, then the editor v3 engine renders the video (title cards per chapter over
 *    the mastered audio), verified by the editor itself, then stored in the private "videos" bucket.
 * Every step is fenced by the episode's run tokens; a failure leaves a clear message and keeps the audio and every
 * paid narration chunk. Logs carry stages and exit codes only (no script, title, URLs or credentials).
 * Usage: EPISODE_ID=<uuid> JOB_KIND=video|narration npx tsx scripts/podcast-video-worker.ts
 */
export {};

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const STORAGE_MAX_BYTES = 480 * 1024 * 1024; // under the project's demonstrated Storage ceiling (500 MiB accepted)

class PublicError extends Error {}

function run(cmd: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrBytes = 0;
    child.stderr.on("data", (d: Buffer) => { stderrBytes += d.length; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); log("STEP_EXIT", { cmd: path.basename(args[0] ?? cmd), sub: args[1] ?? null, code, stderrBytes }); resolve(code ?? -1); });
  });
}

async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = await findFile(p, name); if (hit) return hit; }
    else if (entry.name === name && path.basename(path.dirname(p)) === "salida") return p;
  }
  return null;
}

async function probeSeconds(p: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p]);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

async function main() {
  const episodeId = process.env.EPISODE_ID?.trim() ?? "";
  const kind = process.env.JOB_KIND === "narration" ? "narration" : "video";
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new Error("EPISODE_ID missing");
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { EPISODE_COLUMNS, runGeneration } = await import("../src/lib/podcast/server");
  const { isStalledVideo } = await import("../src/lib/podcast/episode");
  const { buildPodcastMontage, readySignal } = await import("../src/lib/podcast/video-montage");
  type Episode = import("../src/lib/podcast/episode").PodcastEpisode;
  const service = createServiceClient();
  const load = async () => (await service.from("podcast_episodes").select(EPISODE_COLUMNS).eq("id", episodeId).single()).data as Episode | null;
  let episode = await load();
  if (!episode) { log("SKIP", { reason: "episode not found" }); return; }

  if (kind === "narration") {
    if (episode.status === "ready") { log("SKIP", { reason: "already narrated" }); return; }
    const out = await runGeneration(service, episode);
    log("NARRATION", { ok: !("error" in out), status: "error" in out ? out.status : "ready" });
    return;
  }

  // Video: only the run the app queued (its token) may proceed; a newer request supersedes this one.
  const token = episode.video_run_token;
  if (!token || !(episode.video_status === "queued" || (episode.video_status === "running" && isStalledVideo(episode)))) { log("SKIP", { reason: "no queued video run" }); return; }
  const now = () => new Date().toISOString();
  const fenced = async (patch: Record<string, unknown>) => {
    const { data } = await service.from("podcast_episodes").update({ ...patch, updated_at: now() }).eq("id", episodeId).eq("video_run_token", token).select("id");
    return (data?.length ?? 0) === 1;
  };
  if (!(await fenced({ video_status: "running", video_stage: "Preparando", video_heartbeat_at: now() }))) { log("SKIP", { reason: "superseded" }); return; }
  const heartbeat = setInterval(() => { void fenced({ video_heartbeat_at: now() }).catch(() => undefined); }, 60_000);
  const stage = (s: string) => fenced({ video_stage: s, video_heartbeat_at: now() });
  try {
    if (episode.status !== "ready") {
      if (episode.source !== "tts") throw new PublicError("Sube y termina la grabación antes de producir el video.");
      await stage("Narrando");
      const out = await runGeneration(service, episode);
      if ("error" in out) throw new PublicError(out.error);
      episode = await load();
      if (!episode || episode.status !== "ready" || !episode.audio_path) throw new PublicError("La narración no quedó lista. Pulsa «Reintentar»: lo ya narrado no se vuelve a cobrar.");
    }
    await stage("Montando video");
    const work = path.join(os.tmpdir(), `podcast-${episodeId}-${episode.video_attempts ?? 1}`);
    const input = path.join(work, "entrada");
    await mkdir(path.join(input, "audio"), { recursive: true });
    const { data: audioBlob, error: audioError } = await service.storage.from("videos").download(episode.audio_path!);
    if (audioError || !audioBlob) throw new PublicError("No se pudo leer el audio del episodio. Pulsa «Reintentar».");
    const audioPath = path.join(input, "audio", "episode.m4a");
    await writeFile(audioPath, Buffer.from(await audioBlob.arrayBuffer()));
    const audioStat = await stat(audioPath);
    const audioSeconds = Number(episode.duration_seconds) || (await probeSeconds(audioPath));
    const montage = buildPodcastMontage({
      episodeId, version: Math.max(1, episode.video_attempts ?? 1), title: episode.title, durationSeconds: audioSeconds,
      audio: { path: "audio/episode.m4a", size: audioStat.size, sha256: await sha256File(audioPath) },
    });
    const manifest = path.join(input, "montaje.json");
    const manifestBytes = Buffer.from(JSON.stringify(montage, null, 2));
    await writeFile(manifest, manifestBytes);
    await writeFile(path.join(input, "LISTO.json"), JSON.stringify(readySignal(createHash("sha256").update(manifestBytes).digest("hex"), montage)));
    const editor = path.resolve("scripts/podcast-editor-v3/editor.py");
    if (await run("python3", [editor, "validate", manifest, "--archivos"], 120_000) !== 0) throw new PublicError("El montaje no pasó la validación del editor. Pulsa «Reintentar»; si se repite, revisa el audio del episodio.");
    const renderWork = path.join(work, "render");
    const renderCode = await run("python3", [editor, "run", manifest, "--work", renderWork, "--retries", "1"], 75 * 60_000);
    if (renderCode !== 0) throw new PublicError(`El montaje del video falló (código ${renderCode}). La narración está guardada; pulsa «Reintentar».`);
    const mp4 = await findFile(renderWork, "episodio.mp4");
    const report = await findFile(renderWork, "reporte.json");
    if (!mp4 || !report) throw new PublicError("El editor no entregó el video verificado. Pulsa «Reintentar».");
    // Same gate the editor's own publish applies: only a finished job whose verification passed is delivered.
    const rep = JSON.parse(await readFile(report, "utf8")) as { status?: unknown; verification?: { ok?: unknown } };
    log("EDITOR_REPORT", { status: rep.status ?? null, verificationOk: rep.verification?.ok ?? null });
    if (rep.status !== "done" || rep.verification?.ok !== true) throw new PublicError("El editor no verificó el video final. Pulsa «Reintentar».");
    const { size } = await stat(mp4);
    if (size > STORAGE_MAX_BYTES) throw new PublicError("El video supera el tamaño máximo de almacenamiento. Acorta el episodio o divídelo en partes.");
    const seconds = await probeSeconds(mp4);
    if (Math.abs(seconds - audioSeconds) > 2) throw new PublicError("La duración del video no coincide con la del audio. Pulsa «Reintentar».");
    await stage("Guardando");
    const objectPath = `${episode.user_id}/podcasts/${episodeId}/video/v${episode.video_attempts ?? 1}/episodio.mp4`;
    const sha256 = await sha256File(mp4);
    const { error: upErr } = await service.storage.from("videos").upload(objectPath, await readFile(mp4), { contentType: "video/mp4", upsert: true });
    if (upErr) throw new PublicError("No se pudo guardar el video. El montaje está hecho; pulsa «Reintentar».");
    const ok = await fenced({ video_status: "ready", video_stage: null, video_path: objectPath, video_bytes: size, video_sha256: sha256, video_duration_seconds: seconds, video_error: null });
    log("VIDEO", { ok, bytes: size, seconds: Math.round(seconds) });
  } catch (err) {
    const message = err instanceof PublicError ? err.message : "No se pudo producir el video. La narración y lo ya pagado se conservan; pulsa «Reintentar».";
    log("VIDEO_FAILED", { public: err instanceof PublicError, kind: err instanceof Error ? err.constructor.name : "unknown" });
    await fenced({ video_status: "failed", video_stage: null, video_error: message.slice(0, 500) });
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
  }
}

main().catch(() => { console.error("PODCAST_WORKER_FAILED"); process.exitCode = 1; });
