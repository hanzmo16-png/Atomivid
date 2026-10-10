/**
 * Podcast worker (GitHub Actions, .github/workflows/podcast-video.yml). Dispatched by the app with only the
 * episode id. Two jobs:
 *  - narration: background narration of a long script (same gated, resumable runGeneration as the web route);
 *  - video: narration first if needed; then the visual plan (scenes that follow the narration), a licensed Pexels clip
 *    or animated photo per scene, subtitles from the word timings of the narration already paid (reuse-only, never
 *    a new voice call); the editor v3 engine renders it over the mastered audio and verifies it; stored in the
 *    private "videos" bucket with its credits.
 *  - scheduler (scheduled tick): claims productions whose one-shot scheduled start has come and produces them here.
 * Supervised pilot: before any paid call the per-production budget is re-checked and a production with an uncertain
 * paid call (no stored result) is blocked until reconciled; a delivery stores its technical checks and defects for
 * the owner's review (publication stays held); delivery and blocks send ONE notice per run (GitHub mention).
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
const STORAGE_MAX_BYTES = 900 * 1024 * 1024; // working ceiling under the project's 1 GB Storage limit (1000 MiB accepted)

class PublicError extends Error {}
/** A stop that needs the owner (budget, uncertain charge, provider balance): the run ends "blocked", not "failed". */
class BlockError extends PublicError { constructor(message: string, readonly notice: "blocked" | "budget" = "blocked") { super(message); } }

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
  const kind = process.env.JOB_KIND === "narration" ? "narration" : process.env.JOB_KIND === "scheduler" ? "scheduler" : "video";
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { EPISODE_COLUMNS } = await import("../src/lib/podcast/server");
  const pilot = await import("../src/lib/podcast/pilot-server");
  const service = createServiceClient();
  if (kind === "scheduler") {
    // One production per tick: each one may take long; the next tick picks the next one.
    const due = await pilot.dueScheduled(service, EPISODE_COLUMNS, new Date(), 1);
    log("SCHEDULER", { due: due.length });
    for (const ep of due) {
      const claim = await pilot.claimScheduled(service, ep);
      log("SCHEDULED_CLAIM", { claimed: claim.claimed, blocked: !claim.claimed && !!claim.blocked });
      if (claim.claimed) await produce(ep.id);
      else if (claim.blocked) {
        const notice = await pilot.recordNotice(service, ep, claim.blocked.kind, `scheduled-${ep.video_requested_at ?? ep.id}`, claim.blocked.message);
        if (notice) log("NOTICE", { kind: notice.kind, delivered: await pilot.deliverGithubNotice(service, notice) });
      }
    }
    return;
  }
  const episodeId = process.env.EPISODE_ID?.trim() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new Error("EPISODE_ID missing");
  if (kind === "narration") {
    const { runGeneration } = await import("../src/lib/podcast/server");
    const episode = (await service.from("podcast_episodes").select(EPISODE_COLUMNS).eq("id", episodeId).single()).data as import("../src/lib/podcast/episode").PodcastEpisode | null;
    if (!episode) { log("SKIP", { reason: "episode not found" }); return; }
    if (episode.status === "ready") { log("SKIP", { reason: "already narrated" }); return; }
    const out = await runGeneration(service, episode);
    log("NARRATION", { ok: !("error" in out), status: "error" in out ? out.status : "ready" });
    return;
  }
  await produce(episodeId);
}

async function produce(episodeId: string) {
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { EPISODE_COLUMNS, runGeneration } = await import("../src/lib/podcast/server");
  const { isStalledVideo } = await import("../src/lib/podcast/episode");
  const { buildPodcastMontage, readySignal } = await import("../src/lib/podcast/video-montage");
  const { scenesFromWords, evenScenes, sceneLengths, wordsJson } = await import("../src/lib/podcast/visual-plan");
  const { buildSceneShots, downloadToFile, renderClipFfmpeg, renderPhotoFfmpeg } = await import("../src/lib/podcast/visual-assets");
  const { storedNarrationWords } = await import("../src/lib/podcast/narrate");
  const { supabaseResultStore } = await import("../src/lib/paid-calls/result-store");
  const { getVoiceIdentity } = await import("../src/lib/ai/voice");
  const { searchSceneVideos, searchScenePhotos, setFootageWaitBeat } = await import("../src/lib/ai/footage");
  const { budgetDecision, buildVideoChecks, UNCERTAIN_CHARGE_MESSAGE } = await import("../src/lib/podcast/pilot");
  const pilot = await import("../src/lib/podcast/pilot-server");
  type Episode = import("../src/lib/podcast/episode").PodcastEpisode;
  const service = createServiceClient();
  const load = async () => (await service.from("podcast_episodes").select(EPISODE_COLUMNS).eq("id", episodeId).single()).data as Episode | null;
  let episode = await load();
  if (!episode) { log("SKIP", { reason: "episode not found" }); return; }

  // Video: only the run the app queued (its token) may proceed; a newer request supersedes this one.
  const token = episode.video_run_token;
  if (!token || !(episode.video_status === "queued" || (episode.video_status === "running" && isStalledVideo(episode)))) { log("SKIP", { reason: "no queued video run" }); return; }
  const now = () => new Date().toISOString();
  const fenced = async (patch: Record<string, unknown>) => {
    const { data } = await service.from("podcast_episodes").update({ ...patch, updated_at: now() }).eq("id", episodeId).eq("video_run_token", token).select("id");
    return (data?.length ?? 0) === 1;
  };
  if (!(await fenced({ video_status: "running", video_stage: "Preparando", video_heartbeat_at: now() }))) { log("SKIP", { reason: "superseded" }); return; }
  // Lets the workflow's mark-failed step fence a cancelled/timed-out run by its own token.
  if (process.env.PODCAST_TOKEN_FILE) {
    await writeFile(process.env.PODCAST_TOKEN_FILE, token).catch(() => undefined);
    // A scheduled tick has no episode id in its event: hand it over too.
    await writeFile(`${process.env.PODCAST_TOKEN_FILE}.episode`, episodeId).catch(() => undefined);
  }
  const heartbeat = setInterval(() => { void fenced({ video_heartbeat_at: now() }).catch(() => undefined); }, 60_000);
  const stage = (s: string) => fenced({ video_stage: s, video_heartbeat_at: now() });
  const owner = episode;
  const notify = async (kind: "delivered" | "blocked" | "budget", detail?: string) => {
    try {
      const notice = await pilot.recordNotice(service, owner, kind, token, detail);
      if (notice) log("NOTICE", { kind, delivered: await pilot.deliverGithubNotice(service, notice) });
    } catch { log("NOTICE", { kind, delivered: false }); }
  };
  try {
    // Pilot preflight, before any paid call: an uncertain charge stops the run until reconciled; the remaining cost
    // must fit the owner's budget for this production (the admission inside the narration re-reads the balance).
    const spendBefore = await pilot.productionSpend(service, episodeId).catch(() => null);
    if (!spendBefore) throw new BlockError("No se pudo leer el registro de gastos; la producción se detuvo para no cobrar a ciegas. Pulsa «Reintentar» más tarde.");
    if (spendBefore.uncertain > 0) throw new BlockError(UNCERTAIN_CHARGE_MESSAGE);
    const budget = budgetDecision(episode, episode.budget_usd == null ? null : Number(episode.budget_usd));
    if (!budget.ok) throw new BlockError(budget.message, "budget");
    if (episode.status !== "ready") {
      if (episode.source !== "tts") throw new BlockError("Sube y termina la grabación antes de producir el video.");
      await stage("Narrando");
      const out = await runGeneration(service, episode);
      // 503 = provider balance or spend ceiling refused before any call: the owner must act, not retry blindly.
      if ("error" in out) throw out.status === 503 ? new BlockError(out.error) : new PublicError(out.error);
      episode = await load();
      if (!episode || episode.status !== "ready" || !episode.audio_path) throw new PublicError("La narración no quedó lista. Pulsa «Reintentar»: lo ya narrado no se vuelve a cobrar.");
    }
    await stage("Preparando audio");
    const work = path.join(os.tmpdir(), `podcast-${episodeId}-${episode.video_attempts ?? 1}`);
    const input = path.join(work, "entrada");
    await mkdir(path.join(input, "audio"), { recursive: true });
    const { data: audioBlob, error: audioError } = await service.storage.from("videos").download(episode.audio_path!);
    if (audioError || !audioBlob) throw new PublicError("No se pudo leer el audio del episodio. Pulsa «Reintentar».");
    const audioPath = path.join(input, "audio", "episode.m4a");
    await writeFile(audioPath, Buffer.from(await audioBlob.arrayBuffer()));
    const audioStat = await stat(audioPath);
    const audioSeconds = (await probeSeconds(audioPath)) || Number(episode.duration_seconds);
    const ep = episode;

    // Subtitles: word timings of the narration chunks already paid and stored (reuse-only; null → no subtitles).
    let words: Awaited<ReturnType<typeof storedNarrationWords>> = null;
    if (ep.source === "tts") {
      try {
        words = await storedNarrationWords({ results: supabaseResultStore(service, "videos"), voiceProvider: { name: "elevenlabs" }, voiceIdentity: getVoiceIdentity(ep.language, ep.voice_id ?? undefined) }, ep);
      } catch {
        words = null;
      }
    }
    log("NARRATION_WORDS", { available: !!words, count: words?.length ?? 0 });
    const scenes = words?.length ? scenesFromWords(words, audioSeconds, ep.title, sceneLengths(audioSeconds)) : evenScenes(audioSeconds, ep.title, ep.script, sceneLengths(audioSeconds).target);

    await stage(`Buscando imágenes (0/${scenes.length})`);
    const media = path.join(input, "medios");
    await mkdir(media, { recursive: true });
    const locale = ep.language === "en" ? "en-US" : "es-ES";
    // A Pexels rate-limit wait (up to an hour) keeps the run visibly alive instead of looking stalled.
    setFootageWaitBeat(() => stage("Esperando al banco de imágenes"));
    let shots: Awaited<ReturnType<typeof buildSceneShots>> = scenes.map(() => null);
    if (process.env.PEXELS_API_KEY?.trim()) {
      shots = await buildSceneShots(scenes, ep.title, media, {
        searchVideos: (q) => searchSceneVideos(q, 0, "landscape", locale),
        searchPhotos: (q) => searchScenePhotos(q, "landscape", locale),
        download: downloadToFile, renderClip: renderClipFfmpeg, renderPhoto: renderPhotoFfmpeg,
        onProgress: (done, total) => (done % 5 === 0 || done === total ? stage(`Buscando imágenes (${done}/${total})`) : undefined),
        log,
      });
    } else log("SHOTS", { skipped: "no stock key" });
    setFootageWaitBeat(null);

    let subtitles = null;
    if (words?.length) {
      const subsPath = path.join(input, "subtitulos.json");
      const bytes = Buffer.from(JSON.stringify(wordsJson(words, audioSeconds)));
      await writeFile(subsPath, bytes);
      subtitles = { path: "subtitulos.json", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    await stage("Montando video");
    const montage = buildPodcastMontage({
      episodeId, version: Math.max(1, ep.video_attempts ?? 1), title: ep.title, durationSeconds: audioSeconds,
      audio: { path: "audio/episode.m4a", size: audioStat.size, sha256: await sha256File(audioPath) },
      scenes: scenes.map((sc, i) => {
        const shot = shots[i];
        return { start: sc.start, end: sc.end, shot: shot ? { path: path.relative(input, shot.file), size: shot.size, sha256: shot.sha256, seconds: shot.seconds, credit: shot.credit, pageUrl: shot.pageUrl } : null };
      }),
      subtitles,
    });
    const manifest = path.join(input, "montaje.json");
    const manifestBytes = Buffer.from(JSON.stringify(montage, null, 2));
    await writeFile(manifest, manifestBytes);
    await writeFile(path.join(input, "LISTO.json"), JSON.stringify(readySignal(createHash("sha256").update(manifestBytes).digest("hex"), montage)));
    const editor = path.resolve("scripts/podcast-editor-v3/editor.py");
    if (await run("python3", [editor, "validate", manifest, "--archivos"], 120_000) !== 0) throw new PublicError("El montaje no pasó la validación del editor. Pulsa «Reintentar»; si se repite, revisa el audio del episodio.");
    const renderWork = path.join(work, "render");
    const renderCode = await run("python3", [editor, "run", manifest, "--work", renderWork, "--retries", "1"], 90 * 60_000);
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
    // Stock credits (Pexels licence) next to the video; best effort, never blocks the delivery.
    const credits = await findFile(renderWork, "creditos.json");
    if (credits) await service.storage.from("videos").upload(objectPath.replace(/episodio\.mp4$/, "creditos.json"), await readFile(credits), { contentType: "application/json", upsert: true }).catch(() => undefined);
    // Technical checks and detected defects for the owner's review (integrity only; never an approval).
    const repChecks = ((rep.verification as { checks?: { check?: string; ok?: boolean }[] } | undefined)?.checks ?? []).map((c) => ({ name: String(c.check ?? "?"), ok: c.ok === true }));
    const creditSources = credits ? ((JSON.parse(await readFile(credits, "utf8")) as { sources?: unknown[] }).sources?.length ?? 0) : 0;
    const cards = (montage.timeline as { type: string }[]).filter((t) => t.type === "card").length;
    const spend = await pilot.productionSpend(service, episodeId).catch(() => undefined);
    const checks = buildVideoChecks({
      editorOk: true, editorChecks: repChecks, videoSeconds: seconds, audioSeconds, bytes: size, maxBytes: STORAGE_MAX_BYTES, subtitles: !!subtitles,
      shots: { videos: shots.filter((x) => x?.kind === "video").length, photos: shots.filter((x) => x?.kind === "photo").length, cards, total: scenes.length },
      credits: creditSources, spend, budgetUsd: ep.budget_usd == null ? null : Number(ep.budget_usd),
    });
    const ok = await fenced({ video_status: "ready", video_stage: null, video_path: objectPath, video_bytes: size, video_sha256: sha256, video_duration_seconds: seconds, video_error: null, video_checks: checks, review_status: "pending", publish_status: "held" });
    log("VIDEO", { ok, bytes: size, seconds: Math.round(seconds), defects: checks.defects.length });
    if (ok) await notify("delivered");
  } catch (err) {
    const message = err instanceof PublicError ? err.message : "No se pudo producir el video. La narración y lo ya pagado se conservan; pulsa «Reintentar».";
    const blocked = err instanceof BlockError;
    log("VIDEO_FAILED", { public: err instanceof PublicError, blocked, kind: err instanceof Error ? err.constructor.name : "unknown" });
    if (await fenced({ video_status: blocked ? "blocked" : "failed", video_stage: null, video_error: message.slice(0, 500) })) await notify(blocked ? (err as BlockError).notice : "blocked", message);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
  }
}

main().catch(() => { console.error("PODCAST_WORKER_FAILED"); process.exitCode = 1; });
