/**
 * Local, USD 0 end-to-end of the Reel WORKER through its PRODUCTIVE entrypoint (scripts/render-worker.ts →
 * worker-cli.ts → runRenderJob → generate-video → Director → Remotion → mastering → Storage), one scenario per
 * child process, against the in-memory test database served by fake-service-loader.mjs. The web side (Reel creation,
 * script, review, "Generar video final") is represented by the seeded `video_requests` row exactly as the render route
 * leaves it: status processing, render_attempts 1, director_requested per scenario, script_json approved.
 *
 * Scenarios (each asserts row state, Storage objects, reservations/RPCs and, for renders, the MP4 and director.json):
 *   positive      director requested + pilot account + worker switch ON  ⇒ MP4 + director.json, recipes applied, motion in frames
 *   divergence    director requested, worker allowlist does not include the owner ⇒ fail-closed BEFORE any reservation; no MP4
 *   classic       director not requested ⇒ classic montage, MP4 without director.json
 *   no-budget     supply reservation refused ⇒ safe wait (queued, supply_not_before), nothing rendered, nothing paid
 *   license       material licence NEEDS_REVIEW ⇒ Director refuses before reserving; no MP4, no classic fallback
 *   double        the completed request dispatched again (same attempt) ⇒ worker skips; objects untouched
 *   in-flight     a claim already taken (progress_stage=voice) ⇒ worker does not re-run the attempt
 *   isolation     the owner lookup fails (user missing) ⇒ no Director, no spend beyond what the row allows
 *   recovery      the row already moved to attempt 2 (web retry) ⇒ attempt 2 completes under attempt-2/ only
 *  T40 (provider unavailability and interruption inside the productive worker, fixtures only):
 *   voice-503     the voice provider answers 503 (pre-acceptance refusal) ⇒ failed with cause, action retry, nothing stored
 *   stale-after-fail  a late dispatch of that same attempt ⇒ ignored (row no longer processing)
 *   footage-503   the 3rd footage search answers 503 ⇒ failed with cause; only scene images of the attempt exist, never
 *                 final.mp4/director.json/voice; no classic fallback for a requested Director
 *   crash         the worker dies when it records the "render" stage ⇒ row stays processing/render, no completed, assets
 *                 uploaded so far remain, reservation still held
 *   crash-stale   a dispatch while that dead claim is still held ⇒ ignored, nothing written
 *   crash-recovery the web retry moved the row to attempt 2 ⇒ attempt 2 completes; every attempt-1 object is preserved
 *                 byte for byte
 *
 *  T42/T44 (measurable data under the Director, data cards, preflight before spend):
 *   data-card     a sentence with «90 por ciento» ⇒ a deterministic card instead of stock; static; «sin fuente verificada»
 *   preflight-block  «restos humanos» ⇒ stops before narration/reservation; script_ready with the sentence to change
 *   multi-claim   two claims in one scene ⇒ two cards on their own word-timed windows; «30 %» gone when «70 %» is said
 *   preflight-values two values in one clause ⇒ refused before spend, asks to split the figures
 *  T44 correction 1 (no window merge; a short claim keeps its own card):
 *   short-later   a later claim narrated in < 250 ms (FIXTURE_VOICE_WORD_SECONDS) keeps its own card and window
 *   short-first   a first claim narrated in < 250 ms keeps its own card and window
 *   preflight-short a claim with fewer than 3 words ⇒ refused before spend, asks to extend the sentence
 *
 *   npx tsx scripts/qa/director/worker-e2e-local.ts --out-dir=<dir> [--only=positive,classic] [--red]
 *   --red runs the T40 fault scenarios WITHOUT their fault injection: their assertions must then FAIL (the render
 *   completes), which proves the assertions discriminate; the follow-up scenarios are skipped in that mode.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = path.resolve(arg("out-dir") ?? path.join(os.tmpdir(), `atomivid-worker-e2e-${Date.now()}`));
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const ROOT = path.resolve(__dirname, "../../..");
const LOADER = path.join(ROOT, "scripts/qa/director/fake-service-loader.mjs");
const PRELOAD = path.join(ROOT, "scripts/qa/director/fake-service-preload.cjs");
const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", email_confirmed_at: "2026-10-01T00:00:00Z" };
const HEADLESS = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
fs.mkdirSync(OUT, { recursive: true });

type Check = { name: string; ok: boolean; detail?: unknown };
type Result = { scenario: string; status: "PASS" | "FAIL"; checks: Check[]; exit: number | null; stdout: string; stderr: string; ms: number; artifacts?: Record<string, unknown> };
const results: Result[] = [];
const sha256 = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function baseEnv(dumpDir: string, seedFile: string): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "NODE_OPTIONS", "PLAYWRIGHT_BROWSERS_PATH"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return { ...env,
    // Test database + loopback placeholder (the fake never connects); no real token.
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "local-fake-service-role-key-000000000000",
    ATOMIVID_FAKE_SEED: seedFile, ATOMIVID_FAKE_DUMP: dumpDir,
    // The productive entrypoint's local fixture mode (PR #130 worker-cli) + the supply guard kept ON.
    ATOMIVID_WORKER_LOCAL_FIXTURE: "1", SUPPLY_GUARD_ENFORCED: "true",
    SCRIPT_PROVIDER: "fixture", VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture",
    PREMIUM_CLIPS_ENABLED: "false", IMAGE_GENERATION_ENABLED: "false",
    CINEMATIC_DIRECTOR_RENDER_ENABLED: "1", CINEMATIC_DIRECTOR_PILOT_EMAILS: OWNER.email,
    REMOTION_BROWSER_EXECUTABLE: process.env.REMOTION_BROWSER_EXECUTABLE ?? (fs.existsSync(HEADLESS) ? HEADLESS : ""),
    REMOTION_CHROME_MODE: process.env.REMOTION_CHROME_MODE ?? "headless-shell",
  };
}

type Seed = { tables: Record<string, Record<string, unknown>[]>; objects?: Record<string, string> };
function seedFor(id: string, script: unknown, over: Record<string, unknown> = {}, owner: Record<string, unknown> | null = OWNER): Seed {
  return { tables: {
    video_requests: [{ id, user_id: OWNER.id, mode: "visual", status: "processing", render_attempts: 1, progress_stage: null, script_json: script,
      style: "documental, sobrio", topic: "Prueba local del worker con Director", language: "es", duration_seconds: 35, avatar_id: null, avatar_voice_id: null,
      avatar_provider_video_job_id: null, recorded_audio_path: null, avatar_narration_source: null, long_form_production_plan: null, long_form_confirmed_at: null,
      director_requested: true, video_path: null, error_message: null, supply_wait_started_at: null, supply_not_before: null, created_at: new Date().toISOString(), ...over }],
    auth_users: owner ? [owner] : [],
    pi_supply_policies: [], pi_paid_operations: [], pi_supply_job_reservations: [], generation_costs: [],
  } };
}

function runWorker(name: string, seed: Seed, envOver: Record<string, string | undefined>, requestId: string, attempt = 1) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  const seedFile = path.join(dir, "seed.json");
  fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
  const env: Record<string, string | undefined> = { ...baseEnv(path.join(dir, "dump"), seedFile), REQUEST_ID: requestId, RENDER_ATTEMPT: String(attempt) };
  for (const [k, v] of Object.entries(envOver)) { if (v === undefined) delete env[k]; else env[k] = v; }
  const t0 = Date.now();
  // The repo's ProcessEnv augmentation requires NODE_ENV; the worker process gets no NODE_ENV on purpose (non-production runtime).
  const r = spawnSync(process.execPath, ["--import", "tsx", "--require", PRELOAD, "--import", LOADER, "scripts/render-worker.ts"], { cwd: ROOT, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const stdout = String(r.stdout ?? ""), stderr = String(r.stderr ?? "");
  fs.writeFileSync(path.join(dir, "worker.stdout.log"), stdout);
  fs.writeFileSync(path.join(dir, "worker.stderr.log"), stderr);
  const dump = path.join(dir, "dump");
  const tables = fs.existsSync(path.join(dump, "tables.json")) ? JSON.parse(fs.readFileSync(path.join(dump, "tables.json"), "utf8")) as Record<string, Record<string, unknown>[]> : {};
  const rpc = fs.existsSync(path.join(dump, "rpc.json")) ? JSON.parse(fs.readFileSync(path.join(dump, "rpc.json"), "utf8")) as { name: string; result: unknown }[] : [];
  const objects = fs.existsSync(path.join(dump, "objects")) ? walk(path.join(dump, "objects")).map((f) => path.relative(path.join(dump, "objects"), f)) : [];
  return { dir, exit: r.status, stdout, stderr, ms, tables, rpc, objects, dump };
}
function walk(d: string): string[] { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }

/** Mean luma difference between two frames inside a shot, on the band 20–50 % of the height (outside captions/label). */
function frameDiff(mp4: string, t0: number, t1: number, work: string): number {
  const grab = (t: number, n: string) => { const f = path.join(work, n); execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", mp4, "-frames:v", "1", "-vf", "crop=iw:ih*0.3:0:ih*0.2,scale=96:-2,format=gray", "-f", "rawvideo", f]); return fs.readFileSync(f); };
  const a = grab(t0, "a.raw"), b = grab(t1, "b.raw"); let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}
function ffprobe(f: string) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f]).toString()) as { format: { duration: string }; streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[] };
  const v = j.streams.find((s) => s.codec_type === "video"), a = j.streams.find((s) => s.codec_type === "audio");
  return { durationSeconds: Number(j.format.duration), video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate } : null, audio: a ? { codec: a.codec_name } : null };
}

async function main() {
  // The approved script, exactly as the web stores it (fixture generator: deterministic, no provider).
  process.env.SCRIPT_PROVIDER = "fixture";
  const { generateScriptForRequest } = await import("../../../src/lib/video/generate-script");
  const { script } = await generateScriptForRequest({ topic: "Prueba local del worker con Director", style: "documental, sobrio", durationSeconds: 35 });
  const want = (s: string) => ONLY.length === 0 || ONLY.includes(s);
  const row = (r: ReturnType<typeof runWorker>, id: string) => (r.tables.video_requests ?? []).find((x) => x.id === id) ?? {};
  const reservations = (r: ReturnType<typeof runWorker>) => r.tables.pi_supply_job_reservations ?? [];
  const finish = (scenario: string, r: ReturnType<typeof runWorker>, checks: Check[], artifacts?: Record<string, unknown>) => {
    const status = checks.every((c) => c.ok) ? "PASS" : "FAIL";
    results.push({ scenario, status, checks, exit: r.exit, stdout: r.stdout.slice(-400), stderr: r.stderr.slice(-800), ms: r.ms, artifacts });
    console.log(`${status.padEnd(5)} ${scenario.padEnd(11)} exit=${r.exit} ${Math.round(r.ms / 1000)}s  ${checks.filter((c) => !c.ok).map((c) => `✗ ${c.name}`).join("; ")}`);
  };

  let positiveObjects: Record<string, string> = {};
  const idPos = randomUUID();
  if (want("positive")) {
    const r = runWorker("positive", seedFor(idPos, script), {}, idPos);
    const v = row(r, idPos);
    const mp4 = path.join(r.dump, "objects", `videos/${idPos}/attempt-1/final.mp4`), dj = path.join(r.dump, "objects", `videos/${idPos}/attempt-1/director.json`);
    const checks: Check[] = [
      { name: "worker exit 0", ok: r.exit === 0, detail: r.stderr.slice(-300) },
      { name: "row completed with video_path of this attempt", ok: v.status === "completed" && v.video_path === `${idPos}/attempt-1/final.mp4`, detail: { status: v.status, video_path: v.video_path, error: v.error_message } },
      { name: "final.mp4 and director.json stored next to each other (same attempt)", ok: fs.existsSync(mp4) && fs.existsSync(dj), detail: r.objects },
      { name: "claim + reservation RPCs went through the supply guard", ok: r.rpc.some((x) => x.name === "pi_claim_render_supply") && r.rpc.some((x) => x.name === "pi_reserve_job_supply"), detail: r.rpc.map((x) => x.name) },
      { name: "traceability + simulated cost: one generation_costs row for this request with a numeric estimate, reservation released, no paid operation", ok: (r.tables.generation_costs ?? []).filter((c) => c.request_id === idPos && typeof c.estimated_cost_usd === "number").length === 1 && reservations(r).every((x) => x.status === "released") && (r.tables.pi_paid_operations ?? []).length === 0,
        detail: { costs: (r.tables.generation_costs ?? []).map((c) => ({ request_id: c.request_id, estimated_cost_usd: c.estimated_cost_usd, voice_provider: c.voice_provider, footage_provider: c.footage_provider, render_ms: c.render_ms, storage_bytes: c.storage_bytes })), reservations: reservations(r), paid: (r.tables.pi_paid_operations ?? []).length } },
    ];
    let artifacts: Record<string, unknown> = {};
    if (fs.existsSync(mp4) && fs.existsSync(dj)) {
      const ev = ffprobe(mp4);
      const d = JSON.parse(fs.readFileSync(dj, "utf8")) as { ok: boolean; applied?: { shotId: string; recipeId: string | null; planned: { movement: string }; applied: { motion: string; transitionIn: string; transitionOut: string; startSeconds: number; endSeconds: number } }[]; plan?: { shots?: unknown[] } };
      checks.push({ name: "MP4 H264/AAC 1080x1920 ≥ 25 s", ok: ev.video?.codec === "h264" && ev.audio?.codec === "aac" && ev.video.width === 1080 && ev.video.height === 1920 && ev.durationSeconds >= 25, detail: ev });
      checks.push({ name: "director.json ok=true with applied shots = plan shots", ok: d.ok === true && (d.applied?.length ?? 0) > 0 && d.applied?.length === d.plan?.shots?.length, detail: { ok: d.ok, applied: d.applied?.length, planned: d.plan?.shots?.length } });
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
      const rows = (d.applied ?? []).map((a) => {
        const len = a.applied.endSeconds - a.applied.startSeconds, m = Math.min(0.6, len / 4);
        const diff = len > 1 ? frameDiff(mp4, a.applied.startSeconds + m, a.applied.endSeconds - m, work) : null;
        const moves = a.applied.motion === "push_in" || a.applied.motion === "pan";
        const verdict = diff === null ? "SKIP" : moves ? (diff >= 0.5 ? "PASS_MOVES" : "FAIL_STATIC") : a.applied.motion === "static" ? (diff <= 0.2 ? "PASS_STATIC" : "FAIL_MOVES_ON_STATIC") : "PASS_OTHER";
        return { shot: a.shotId, recipe: a.recipeId, planned: a.planned.movement, applied: a.applied.motion, in: a.applied.transitionIn, out: a.applied.transitionOut, lumaDiff: diff === null ? null : Math.round(diff * 100) / 100, verdict };
      });
      checks.push({ name: "recipes are observable in the frames (push_in/pan move; static does not)", ok: rows.length > 0 && rows.every((x) => !x.verdict.startsWith("FAIL")) && rows.some((x) => x.verdict === "PASS_MOVES"), detail: rows });
      checks.push({ name: "applied recipes match the plan's shot movements (no silent downgrade of a move on a still)", ok: (d.applied ?? []).every((a) => !(a.planned.movement === "push_in_still" || a.planned.movement === "pan") || a.applied.motion !== "static"), detail: (d.applied ?? []).map((a) => [a.planned.movement, a.applied.motion]) });
      artifacts = { mp4: { path: mp4, sha256: sha256(mp4), bytes: fs.statSync(mp4).size, ...ev }, directorJson: { path: dj, sha256: sha256(dj) }, shots: rows };
      positiveObjects = Object.fromEntries(r.objects.map((o) => [o, sha256(path.join(r.dump, "objects", o))]));
      fs.copyFileSync(mp4, path.join(OUT, "positive-director.mp4"));
      fs.copyFileSync(dj, path.join(OUT, "positive-director.json"));
    }
    finish("positive", r, checks, artifacts);
  }

  if (want("divergence")) {
    const id = randomUUID();
    const r = runWorker("divergence", seedFor(id, script), { CINEMATIC_DIRECTOR_PILOT_EMAILS: "someone-else@local.test" }, id);
    const v = row(r, id);
    finish("divergence", r, [
      { name: "worker exit 1 (fail-closed)", ok: r.exit === 1 },
      { name: "row failed with an actionable Director message, no video", ok: v.status === "failed" && !v.video_path && /Director/i.test(String(v.error_message ?? "")), detail: { status: v.status, error: v.error_message } },
      { name: "nothing reserved and nothing rendered or stored", ok: reservations(r).length === 0 && !r.rpc.some((x) => x.name === "pi_reserve_job_supply") && r.objects.length === 0, detail: { rpc: r.rpc.map((x) => x.name), objects: r.objects } },
      { name: "no classic montage substituted silently", ok: !r.objects.some((o) => o.endsWith("final.mp4")) },
    ]);
  }

  if (want("classic")) {
    const id = randomUUID();
    const r = runWorker("classic", seedFor(id, script, { director_requested: false }), {}, id);
    const v = row(r, id);
    const mp4 = path.join(r.dump, "objects", `videos/${id}/attempt-1/final.mp4`);
    finish("classic", r, [
      { name: "worker exit 0", ok: r.exit === 0, detail: r.stderr.slice(-300) },
      { name: "row completed with video", ok: v.status === "completed" && !!v.video_path, detail: { status: v.status, error: v.error_message } },
      { name: "MP4 present, no director.json (classic montage)", ok: fs.existsSync(mp4) && !r.objects.some((o) => o.endsWith("director.json")), detail: r.objects },
    ], fs.existsSync(mp4) ? { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) } } : undefined);
  }

  if (want("no-budget")) {
    const id = randomUUID();
    const r = runWorker("no-budget", seedFor(id, script), { ATOMIVID_FAKE_SUPPLY_REFUSE: "insufficient balance" }, id);
    const v = row(r, id);
    finish("no-budget", r, [
      { name: "refused reservation → safe wait (processing/queued with supply_not_before), not a failure and not a render", ok: v.status === "processing" && v.progress_stage === "queued" && !!v.supply_not_before && !v.video_path, detail: { status: v.status, stage: v.progress_stage, not_before: v.supply_not_before } },
      { name: "nothing rendered or stored; no paid operation", ok: r.objects.length === 0 && (r.tables.pi_paid_operations ?? []).length === 0, detail: r.objects },
    ]);
  }

  if (want("license")) {
    const id = randomUUID();
    const r = runWorker("license", seedFor(id, script), { FIXTURE_FOOTAGE_LICENSE: "NEEDS_REVIEW" }, id);
    const v = row(r, id);
    finish("license", r, [
      { name: "worker exit 1", ok: r.exit === 1 },
      { name: "row failed before reserving: licence pending message, no reservation, no objects", ok: v.status === "failed" && reservations(r).length === 0 && r.objects.length === 0 && /licencia|Director/i.test(String(v.error_message ?? "")), detail: { status: v.status, error: v.error_message, rpc: r.rpc.map((x) => x.name) } },
    ]);
  }

  if (want("double") && want("positive")) {
    // The same request, already completed by the positive run, dispatched again for the same attempt.
    const seed = seedFor(idPos, script, { status: "completed", video_path: `${idPos}/attempt-1/final.mp4`, progress_stage: null });
    const r = runWorker("double", seed, {}, idPos);
    const v = row(r, idPos);
    finish("double", r, [
      { name: "worker skips (exit 0) a request that is no longer processing", ok: r.exit === 0 && v.status === "completed" },
      { name: "no new objects, no RPC, no reservation", ok: r.objects.length === 0 && r.rpc.length === 0 && reservations(r).length === 0, detail: { rpc: r.rpc.map((x) => x.name), objects: r.objects } },
      { name: "positive artifacts unchanged (hashes recorded)", ok: Object.keys(positiveObjects).length > 0, detail: Object.keys(positiveObjects) },
    ]);
  }

  if (want("in-flight")) {
    const id = randomUUID();
    const r = runWorker("in-flight", seedFor(id, script, { progress_stage: "voice" }), {}, id);
    const v = row(r, id);
    finish("in-flight", r, [
      { name: "an attempt already claimed is not re-run: no reservation, no objects, row untouched", ok: r.exit === 0 && v.status === "processing" && v.progress_stage === "voice" && r.objects.length === 0 && !r.rpc.some((x) => x.name === "pi_reserve_job_supply"), detail: { exit: r.exit, status: v.status, stage: v.progress_stage, rpc: r.rpc.map((x) => x.name) } },
    ]);
  }

  if (want("recovery")) {
    // Attempt 1 was interrupted (worker lost mid-render: row left with its error, no video). The web retry already moved
    // the row to attempt 2 / queued (as the render route does); the worker must complete attempt 2 without reusing or
    // mixing attempt-1 artifacts, and the stale attempt-1 dispatch (in-flight scenario) is ignored.
    const id = randomUUID();
    const seed = seedFor(id, script, { render_attempts: 2, progress_stage: "queued", error_message: "Intento 1 interrumpido (worker perdido)", video_path: null });
    const r = runWorker("recovery", seed, {}, id, 2);
    const v = row(r, id);
    const mp4 = path.join(r.dump, "objects", `videos/${id}/attempt-2/final.mp4`), dj = path.join(r.dump, "objects", `videos/${id}/attempt-2/director.json`);
    finish("recovery", r, [
      { name: "worker exit 0 on attempt 2", ok: r.exit === 0, detail: r.stderr.slice(-300) },
      { name: "row completed pointing at attempt-2, previous error cleared", ok: v.status === "completed" && v.video_path === `${id}/attempt-2/final.mp4` && !v.error_message, detail: { status: v.status, video_path: v.video_path, error: v.error_message } },
      { name: "all objects live under attempt-2 (nothing written to attempt-1); MP4 + director.json present", ok: r.objects.length > 0 && r.objects.every((o) => o.includes("/attempt-2/")) && fs.existsSync(mp4) && fs.existsSync(dj), detail: r.objects },
      { name: "claim and reservation carry attempt 2", ok: r.rpc.filter((x) => x.name === "pi_claim_render_supply" || x.name === "pi_reserve_job_supply").every((x) => (x as { args?: { p_attempt?: unknown } }).args?.p_attempt === 2) && r.rpc.some((x) => x.name === "pi_claim_render_supply"), detail: r.rpc.map((x) => [x.name, (x as { args?: { p_attempt?: unknown } }).args?.p_attempt]) },
    ], fs.existsSync(mp4) ? { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) } } : undefined);
  }

  if (want("isolation")) {
    const id = randomUUID();
    const r = runWorker("isolation", seedFor(id, script, {}, null), {}, id);
    const v = row(r, id);
    finish("isolation", r, [
      { name: "owner lookup fails ⇒ Director never applied (requested ⇒ fail-closed), no director.json", ok: !r.objects.some((o) => o.endsWith("director.json")) && v.status !== "completed", detail: { exit: r.exit, status: v.status, error: v.error_message, objects: r.objects } },
    ]);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // T40: provider 503 inside the worker, interruption, late dispatch and recovery. `--red` removes the fault injection.
  const RED = process.argv.includes("--red");
  const fault = (env: Record<string, string>) => (RED ? {} : env);
  const objectsOf = (r: ReturnType<typeof runWorker>) => Object.fromEntries(r.objects.map((o) => [o, fs.readFileSync(path.join(r.dump, "objects", o)).toString("base64")]));
  const hashesOf = (r: ReturnType<typeof runWorker>) => Object.fromEntries(r.objects.map((o) => [o, sha256(path.join(r.dump, "objects", o))]));
  // failure-action.ts: only "support" is tagged ([[action:support]]); an untagged stored failure means action = retry.
  const failedWithRetry = (v: Record<string, unknown>) => v.status === "failed" && !v.video_path && v.progress_stage === null && !/^\[\[action:support\]\]/.test(String(v.error_message ?? "")) && /\(Código: [0-9a-f]{8}\)/.test(String(v.error_message ?? ""));

  if (want("voice-503")) {
    const id = randomUUID();
    const r = runWorker("voice-503", seedFor(id, script), fault({ FIXTURE_VOICE_FAIL: "503" }), id);
    const v = row(r, id);
    finish("voice-503", r, [
      { name: "worker exit 1: a 503 from the voice provider fails the attempt (never a silent success)", ok: r.exit === 1, detail: r.stderr.slice(-300) },
      { name: "row failed with the provider status (503) in the cause, a diagnostic code and action=retry; stage cleared; no video_path", ok: failedWithRetry(v) && /503/.test(String(v.error_message)), detail: { status: v.status, stage: v.progress_stage, error: v.error_message } },
      { name: "the refusal happened before acceptance: capacity reservation released, nothing paid, nothing stored", ok: reservations(r).length === 1 && reservations(r)[0].status === "released" && (r.tables.pi_paid_operations ?? []).length === 0 && r.objects.length === 0, detail: { reservations: reservations(r), objects: r.objects } },
    ]);
    if (!RED) {
      // The same attempt dispatched again after the failure (a late or duplicated dispatch).
      const r2 = runWorker("stale-after-fail", { tables: r.tables }, {}, id);
      finish("stale-after-fail", r2, [
        { name: "a late dispatch of the failed attempt is ignored: exit 0, no RPC, no reservation, no objects, row still failed", ok: r2.exit === 0 && r2.rpc.length === 0 && r2.objects.length === 0 && row(r2, id).status === "failed" && reservations(r2).every((x) => x.status === "released"), detail: { exit: r2.exit, rpc: r2.rpc.map((x) => x.name), status: row(r2, id).status } },
      ]);
    }
  }

  if (want("footage-503")) {
    const id = randomUUID();
    const r = runWorker("footage-503", seedFor(id, script), fault({ FIXTURE_FOOTAGE_FAIL: "503@3" }), id);
    const v = row(r, id);
    finish("footage-503", r, [
      { name: "worker exit 1: a 503 from the footage provider (3rd search) fails the attempt", ok: r.exit === 1, detail: r.stderr.slice(-300) },
      { name: "row failed with the provider status (503) in the cause and action=retry; never completed; no video_path", ok: failedWithRetry(v) && /503/.test(String(v.error_message)), detail: { status: v.status, error: v.error_message } },
      { name: "no 'completed' with incomplete output and no classic fallback for the requested Director: whatever was stored are scene images only (no final.mp4, director.json or voice)", ok: r.objects.every((o) => /\/attempt-1\/scene-\d+-\d+\.svg$/.test(o)) && !r.objects.some((o) => /final\.mp4|director\.json|voice\.wav|music\.wav/.test(o)), detail: r.objects },
      { name: "capacity reservation released, nothing paid", ok: reservations(r).length === 1 && reservations(r)[0].status === "released" && (r.tables.pi_paid_operations ?? []).length === 0, detail: reservations(r) },
    ]);
  }

  if (want("crash")) {
    const id = randomUUID();
    const r = runWorker("crash", seedFor(id, script), fault({ ATOMIVID_FAKE_CRASH_ON_STAGE: "render" }), id);
    const v = row(r, id);
    finish("crash", r, [
      { name: "worker lost at the render stage (exit 137): row stays processing/render, never completed, no video_path", ok: r.exit === 137 && v.status === "processing" && v.progress_stage === "render" && !v.video_path, detail: { exit: r.exit, status: v.status, stage: v.progress_stage } },
      // generate-video.ts writes director.json (the plan→composition record) BEFORE the render stage, so it may exist for
      // an attempt that never produced final.mp4; the video page only reads it for the attempt named by video_path.
      { name: "assets uploaded before the crash exist under attempt-1 (voice, scenes, music, director.json); no final.mp4 (nothing presentable as a result)", ok: r.objects.some((o) => o.endsWith("/attempt-1/voice.wav")) && r.objects.some((o) => /scene-\d+-\d+\.svg$/.test(o)) && !r.objects.some((o) => o.endsWith("final.mp4")), detail: r.objects },
      { name: "the dead attempt still holds its capacity reservation (nobody released it)", ok: reservations(r).length === 1 && reservations(r)[0].status === "reserved", detail: reservations(r) },
    ]);
    if (!RED) {
      const before = hashesOf(r);
      // A dispatch of the same attempt while the dead claim is still held.
      const r2 = runWorker("crash-stale", { tables: r.tables, objects: objectsOf(r) }, {}, id);
      const v2 = row(r2, id);
      finish("crash-stale", r2, [
        { name: "dispatch while the crashed claim is held: exit 0, no RPC, no new objects, row unchanged (processing/render)", ok: r2.exit === 0 && r2.rpc.length === 0 && v2.status === "processing" && v2.progress_stage === "render" && JSON.stringify(hashesOf(r2)) === JSON.stringify(before), detail: { exit: r2.exit, rpc: r2.rpc.map((x) => x.name), status: v2.status, stage: v2.progress_stage } },
      ]);
      // The web retry (render route) moves the row to attempt 2 / queued; attempt-1 objects stay in Storage.
      const tables = JSON.parse(JSON.stringify(r.tables)) as Record<string, Record<string, unknown>[]>;
      Object.assign(tables.video_requests.find((x) => x.id === id)!, { render_attempts: 2, progress_stage: "queued", error_message: "Intento 1 interrumpido (worker perdido)", supply_wait_started_at: null, supply_not_before: null });
      const r3 = runWorker("crash-recovery", { tables, objects: objectsOf(r) }, {}, id, 2);
      const v3 = row(r3, id);
      const after = hashesOf(r3);
      const mp4 = path.join(r3.dump, "objects", `videos/${id}/attempt-2/final.mp4`), dj = path.join(r3.dump, "objects", `videos/${id}/attempt-2/director.json`);
      finish("crash-recovery", r3, [
        { name: "attempt 2 completes (exit 0) with video_path under attempt-2 and the previous error cleared", ok: r3.exit === 0 && v3.status === "completed" && v3.video_path === `${id}/attempt-2/final.mp4` && !v3.error_message, detail: { exit: r3.exit, status: v3.status, video_path: v3.video_path, error: v3.error_message, stderr: r3.stderr.slice(-200) } },
        { name: "every attempt-1 object is preserved byte for byte (same sha256) and nothing new was written under attempt-1", ok: Object.keys(before).length > 0 && Object.entries(before).every(([k, h]) => after[k] === h) && Object.keys(after).filter((k) => k.includes("/attempt-1/")).length === Object.keys(before).length, detail: { attempt1: Object.keys(before).length, preserved: Object.entries(before).filter(([k, h]) => after[k] === h).length } },
        { name: "attempt-2 has final.mp4 + director.json; claim and reservation carry attempt 2; attempt-1 reservation untouched", ok: fs.existsSync(mp4) && fs.existsSync(dj) && r3.rpc.filter((x) => x.name === "pi_claim_render_supply" || x.name === "pi_reserve_job_supply").every((x) => (x as { args?: { p_attempt?: unknown } }).args?.p_attempt === 2) && reservations(r3).some((x) => x.attempt === 1 && x.status === "reserved") && reservations(r3).some((x) => x.attempt === 2 && x.status === "released"), detail: { rpc: r3.rpc.map((x) => [x.name, (x as { args?: { p_attempt?: unknown } }).args?.p_attempt]), reservations: reservations(r3) } },
      ], fs.existsSync(mp4) ? { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) } } : undefined);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // T42: a measurable sentence under the Director renders a deterministic data card; a sentence the Director cannot
  // honour stops BEFORE narration or any reservation and reopens the script.
  if (want("data-card")) {
    const figured = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 0 ? { ...s, text: `${s.text} El 90 por ciento lo olvida en una semana.` } : s) };
    const id = randomUUID();
    const r = runWorker("data-card", seedFor(id, figured), {}, id);
    const v = row(r, id);
    const mp4 = path.join(r.dump, "objects", `videos/${id}/attempt-1/final.mp4`), dj = path.join(r.dump, "objects", `videos/${id}/attempt-1/director.json`);
    const checks: Check[] = [
      { name: "worker exit 0, row completed", ok: r.exit === 0 && v.status === "completed" && v.video_path === `${id}/attempt-1/final.mp4`, detail: { exit: r.exit, status: v.status, error: v.error_message, stderr: r.stderr.slice(-300) } },
      { name: "the figure scene is a data card object (card-0-0.svg), no stock image was fetched for it; MP4 + director.json present", ok: r.objects.some((o) => o.endsWith("/attempt-1/card-0-0.svg")) && !r.objects.some((o) => /\/attempt-1\/scene-0-\d+\.svg$/.test(o)) && fs.existsSync(mp4) && fs.existsSync(dj), detail: r.objects },
    ];
    let artifacts: Record<string, unknown> = {};
    if (fs.existsSync(dj) && fs.existsSync(mp4)) {
      const d = JSON.parse(fs.readFileSync(dj, "utf8")) as { ok: boolean; applied?: { shotId: string; recipeId: string | null; applied: { motion: string; startSeconds: number; endSeconds: number } }[]; plan?: { shots?: { segmentId: string; asset: { provenance?: string; label: string | null } }[] } };
      const cardShots = (d.applied ?? []).filter((a) => a.recipeId === "reel-data-card");
      const cardPlan = (d.plan?.shots ?? []).filter((s) => s.segmentId.startsWith("scene-0"));
      checks.push({ name: "director.json ok=true; scene-0 shots use reel-data-card with provenance data_graphic and no «ilustrativa» label", ok: d.ok === true && cardShots.length >= 1 && cardPlan.length >= 1 && cardPlan.every((s) => s.asset.provenance === "data_graphic" && s.asset.label === null), detail: { ok: d.ok, cardShots: cardShots.map((a) => a.shotId), plan: cardPlan.map((s) => s.asset) } });
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "frames-card-"));
      const card = cardShots[0];
      const svg = fs.readFileSync(path.join(r.dump, "objects", `videos/${id}/attempt-1/card-0-0.svg`), "utf8");
      const diff = card && card.applied.endSeconds - card.applied.startSeconds > 1 ? frameDiff(mp4, card.applied.startSeconds + 0.3, card.applied.endSeconds - 0.3, work) : null;
      checks.push({ name: "the card shows the figure as written (90 %), says it is an unverified script datum, and stays static in the frames (Δluma ≤ 0.2)", ok: /90 %/.test(svg) && /sin fuente verificada/.test(svg) && diff !== null && diff <= 0.2 && card.applied.motion === "static", detail: { lumaDiff: diff, motion: card?.applied.motion, figureInSvg: /90 %/.test(svg) } });
      artifacts = { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) }, cardSvg: { sha256: sha256(path.join(r.dump, "objects", `videos/${id}/attempt-1/card-0-0.svg`)) }, cardShots: cardShots.map((a) => ({ shot: a.shotId, motion: a.applied.motion, start: a.applied.startSeconds, end: a.applied.endSeconds })) };
      fs.copyFileSync(mp4, path.join(OUT, "data-card.mp4"));
      fs.copyFileSync(path.join(r.dump, "objects", `videos/${id}/attempt-1/card-0-0.svg`), path.join(OUT, "data-card-0.svg"));
    }
    finish("data-card", r, checks, artifacts);
  }

  // T44 (finding A of the PR #137 review): two claims in ONE scene ⇒ two cards, each on the narration window of its
  // claim (word timestamps of the voice); while «70 %» is said the «30 %» card is no longer on screen. Verified in
  // director.json (segments, shots, props) AND in the MP4 frames (the two windows show different cards; each is static).
  if (want("multi-claim")) {
    const two = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 0 ? { ...s, text: "En 2019, el 30 % recordó la historia; en 2020, el 70 % recordó el dato." } : s) };
    const id = randomUUID();
    const r = runWorker("multi-claim", seedFor(id, two), {}, id);
    const v = row(r, id);
    const obj = (n: string) => path.join(r.dump, "objects", `videos/${id}/attempt-1/${n}`);
    const mp4 = obj("final.mp4"), dj = obj("director.json");
    const checks: Check[] = [
      { name: "worker exit 0, row completed; two card objects for scene 0 and no stock image for it", ok: r.exit === 0 && v.status === "completed" && fs.existsSync(obj("card-0-0.svg")) && fs.existsSync(obj("card-0-1.svg")) && !r.objects.some((o) => /\/attempt-1\/scene-0-\d+\.svg$/.test(o)) && fs.existsSync(mp4) && fs.existsSync(dj), detail: { exit: r.exit, status: v.status, error: v.error_message, objects: r.objects, stderr: r.stderr.slice(-300) } },
    ];
    let artifacts: Record<string, unknown> = {};
    if (fs.existsSync(dj) && fs.existsSync(mp4) && fs.existsSync(obj("card-0-1.svg"))) {
      const svg0 = fs.readFileSync(obj("card-0-0.svg"), "utf8"), svg1 = fs.readFileSync(obj("card-0-1.svg"), "utf8");
      checks.push({ name: "card 1 shows «2019 · 30 %» and never «70 %»; card 2 shows «2020 · 70 %» and never «30 %»; both say «sin fuente verificada»", ok: /2019 · 30 %/.test(svg0) && !/70 %/.test(svg0) && /2020 · 70 %/.test(svg1) && !/30 %/.test(svg1) && /sin fuente verificada/.test(svg0) && /sin fuente verificada/.test(svg1), detail: { hero0: (svg0.match(/font-weight="700"[^>]*>([^<]*)</) ?? [])[1], hero1: (svg1.match(/font-weight="700"[^>]*>([^<]*)</) ?? [])[1] } });
      type DJ = { ok: boolean; input?: { segments: { id: string; start: number; end: number; text: string }[]; inventory: { id: string; content?: { visualIntent?: string } }[] }; plan?: { shots: { id: string; segmentId: string; recipeId: string | null; asset: { assetId?: string; provenance?: string } }[] }; applied?: { shotId: string; applied: { motion: string; startSeconds: number; endSeconds: number } }[]; props?: { scenes: { mediaUrl: string; startSeconds: number; endSeconds: number }[] } };
      const d = JSON.parse(fs.readFileSync(dj, "utf8")) as DJ;
      const segs = (d.input?.segments ?? []).filter((s) => s.id.startsWith("scene-0"));
      const s1 = segs.find((s) => s.id === "scene-0#1"), s2 = segs.find((s) => s.id === "scene-0#2");
      const intentOf = (segId: string) => (d.plan?.shots ?? []).filter((s) => s.segmentId === segId).map((s) => d.input?.inventory.find((a) => a.id === s.asset.assetId)?.content?.visualIntent ?? "");
      checks.push({ name: "director.json: scene 0 is two Director segments (scene-0#1 «…30 %…», scene-0#2 «…70 %…») on the voice's word clock, each dressed only by its own card", ok: d.ok === true && !!s1 && !!s2 && s1.end === s2.start && /30 %/.test(s1.text) && /70 %/.test(s2.text) && intentOf("scene-0#1").length >= 1 && intentOf("scene-0#1").every((i) => /30 %/.test(i) && !/70 %/.test(i)) && intentOf("scene-0#2").length >= 1 && intentOf("scene-0#2").every((i) => /70 %/.test(i) && !/30 %/.test(i)) && (d.plan?.shots ?? []).filter((s) => s.segmentId.startsWith("scene-0")).every((s) => s.recipeId === "reel-data-card" && s.asset.provenance === "data_graphic"), detail: { segs, intents: { s1: intentOf("scene-0#1"), s2: intentOf("scene-0#2") } } });
      if (s1 && s2) {
        const t70 = s2.start + Math.min(0.5, (s2.end - s2.start) / 3);
        const active = (d.props?.scenes ?? []).find((sc) => sc.startSeconds <= t70 && t70 < sc.endSeconds);
        checks.push({ name: "the render props show card-0-1.svg (70 %) at the moment «70 %» starts, never card-0-0.svg", ok: !!active && /card-0-1\.svg/.test(active.mediaUrl), detail: { t70, active } });
        const work = fs.mkdtempSync(path.join(os.tmpdir(), "frames-claims-"));
        const within1 = frameDiff(mp4, s1.start + 0.3, s1.end - 0.3, work), within2 = frameDiff(mp4, s2.start + 0.3, s2.end - 0.3, work), across = frameDiff(mp4, s1.end - 0.3, s2.start + 0.3, work);
        checks.push({ name: "MP4 frames: each card window is static (Δluma ≤ 0.2) and the picture changes exactly at the claim boundary (Δluma across > 0.5)", ok: within1 <= 0.2 && within2 <= 0.2 && across > 0.5, detail: { within1, within2, across, boundary: s1.end } });
        artifacts = { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) }, cards: { card0: sha256(obj("card-0-0.svg")), card1: sha256(obj("card-0-1.svg")) }, segments: segs, frames: { within1, within2, across } };
        fs.copyFileSync(mp4, path.join(OUT, "multi-claim.mp4"));
        fs.copyFileSync(obj("card-0-0.svg"), path.join(OUT, "multi-claim-card-0.svg"));
        fs.copyFileSync(obj("card-0-1.svg"), path.join(OUT, "multi-claim-card-1.svg"));
      }
    }
    finish("multi-claim", r, checks, artifacts);
  }

  // T44 correction 1: a claim narrated in under 250 ms (real fixture word timestamps, FIXTURE_VOICE_WORD_SECONDS) keeps
  // its own card for exactly its window; no neighbour is stretched over it. Checked in director.json, the render props
  // and the MP4 frames, for a short LATER claim and a short FIRST claim.
  const SHORT_CASES: { name: string; text: string; shortTokens: [number, number]; shortCard: number; figures: string[] }[] = [
    { name: "short-later", text: "En 2019, el 30 % recordó la historia; el 70 % también; en 2021, el 50 % recordó el dato.", shortTokens: [8, 11], shortCard: 1, figures: ["2019 · 30 %", "70 %", "2021 · 50 %"] },
    { name: "short-first", text: "El 70 % también; en 2019, el 30 % recordó la historia.", shortTokens: [0, 3], shortCard: 0, figures: ["70 %", "2019 · 30 %"] },
  ];
  for (const sc of SHORT_CASES) {
    if (!want(sc.name)) continue;
    const scripted = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 0 ? { ...s, text: sc.text } : s) };
    const id = randomUUID();
    // Scene 0 is the first narrated scene, so its token indexes are global word indexes of the narration.
    const r = runWorker(sc.name, seedFor(id, scripted), { FIXTURE_VOICE_WORD_SECONDS: `${sc.shortTokens[0]}-${sc.shortTokens[1]}:0.05` }, id);
    const v = row(r, id);
    const obj = (n: string) => path.join(r.dump, "objects", `videos/${id}/attempt-1/${n}`);
    const mp4 = obj("final.mp4"), dj = obj("director.json");
    const n = sc.figures.length;
    const checks: Check[] = [
      { name: `worker exit 0, row completed; ${n} card objects for scene 0 and no stock image for it`, ok: r.exit === 0 && v.status === "completed" && sc.figures.every((_, k) => fs.existsSync(obj(`card-0-${k}.svg`))) && !fs.existsSync(obj(`card-0-${n}.svg`)) && !r.objects.some((o) => /\/attempt-1\/scene-0-\d+\.svg$/.test(o)) && fs.existsSync(mp4) && fs.existsSync(dj), detail: { exit: r.exit, status: v.status, error: v.error_message, objects: r.objects, stderr: r.stderr.slice(-300) } },
    ];
    let artifacts: Record<string, unknown> = {};
    if (fs.existsSync(dj) && fs.existsSync(mp4) && sc.figures.every((_, k) => fs.existsSync(obj(`card-0-${k}.svg`)))) {
      const svgs = sc.figures.map((_, k) => fs.readFileSync(obj(`card-0-${k}.svg`), "utf8"));
      const heroOf = (svg: string) => (svg.match(/font-weight="700"[^>]*>([^<]*)</) ?? [])[1] ?? "";
      checks.push({ name: `each card carries only its own figures (${sc.figures.join(" | ")})`, ok: svgs.every((svg, k) => heroOf(svg) === sc.figures[k] && sc.figures.every((f, j) => j === k || !svg.includes(f.split(" · ").pop()!))), detail: svgs.map(heroOf) });
      type DJ = { ok: boolean; input?: { segments: { id: string; start: number; end: number; text: string }[]; inventory: { id: string; content?: { visualIntent?: string } }[] }; plan?: { shots: { id: string; segmentId: string; recipeId: string | null; asset: { assetId?: string } }[] }; props?: { scenes: { mediaUrl: string; startSeconds: number; endSeconds: number }[] } };
      const d = JSON.parse(fs.readFileSync(dj, "utf8")) as DJ;
      const segs = (d.input?.segments ?? []).filter((s) => s.id.startsWith("scene-0")).sort((a, b) => a.start - b.start);
      const shortSeg = segs[sc.shortCard];
      const shortLen = shortSeg ? shortSeg.end - shortSeg.start : NaN;
      const intentsOf = (segId: string) => (d.plan?.shots ?? []).filter((s) => s.segmentId === segId).map((s) => d.input?.inventory.find((a) => a.id === s.asset.assetId)?.content?.visualIntent ?? "");
      checks.push({ name: `director.json: ${n} Director segments for scene 0 on the voice's word clock; the short claim keeps its own segment (< 0.25 s) dressed only by its own card`, ok: d.ok === true && segs.length === n && shortLen > 0 && shortLen < 0.25 && segs.every((s, k) => intentsOf(s.id).length >= 1 && intentsOf(s.id).every((i) => i.includes(sc.figures[k]) && sc.figures.every((f, j) => j === k || !i.includes(f)))) && segs.every((s, k) => k === 0 || Math.abs(s.start - segs[k - 1].end) < 1e-6), detail: { segs: segs.map((s) => ({ id: s.id, start: s.start, end: s.end, intents: intentsOf(s.id) })), shortLen } });
      if (shortSeg && shortLen > 0) {
        const probes = segs.map((s, k) => ({ k, t: k === sc.shortCard ? (s.start + s.end) / 2 : s.start + Math.min(0.3, (s.end - s.start) / 2) }));
        const active = probes.map((p) => ({ ...p, scene: (d.props?.scenes ?? []).find((x) => x.startSeconds <= p.t && p.t < x.endSeconds) }));
        checks.push({ name: "render props: at the middle of the short claim its own card is on screen, and at every probe the active card is the claim's own", ok: active.every((a) => !!a.scene && new RegExp(`card-0-${a.k}\\.svg`).test(a.scene.mediaUrl)), detail: active });
        const work = fs.mkdtempSync(path.join(os.tmpdir(), "frames-short-"));
        const midShort = (shortSeg.start + shortSeg.end) / 2;
        const neighbours = segs.filter((_, k) => k !== sc.shortCard).map((s) => s.start + Math.min(0.3, (s.end - s.start) / 2));
        const across = neighbours.map((t) => frameDiff(mp4, midShort, t, work));
        const within = segs.filter((_, k) => k !== sc.shortCard).map((s) => frameDiff(mp4, s.start + 0.1, s.end - 0.1, work));
        checks.push({ name: "MP4 frames: the frame at the middle of the short window differs from every neighbouring card (Δluma > 0.5); each long window is static (Δluma ≤ 0.2)", ok: across.every((x) => x > 0.5) && within.every((x) => x <= 0.2), detail: { midShort, across, within } });
        artifacts = { mp4: { sha256: sha256(mp4), ...ffprobe(mp4) }, cards: svgs.map((_, k) => sha256(obj(`card-0-${k}.svg`))), segments: segs, frames: { across, within } };
        fs.copyFileSync(mp4, path.join(OUT, `${sc.name}.mp4`));
      }
    }
    finish(sc.name, r, checks, artifacts);
  }

  if (want("preflight-short")) {
    const short = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 0 ? { ...s, text: "70 %. En 2019, el 30 % recordó la historia." } : s) };
    const id = randomUUID();
    const r = runWorker("preflight-short", seedFor(id, short), {}, id);
    const v = row(r, id);
    finish("preflight-short", r, [
      { name: "a claim too short for its card: the worker stops BEFORE narration or reservation (no pi_reserve_job_supply, no objects, nothing paid)", ok: !r.rpc.some((x) => x.name === "pi_reserve_job_supply") && r.objects.length === 0 && (r.tables.pi_paid_operations ?? []).length === 0 && reservations(r).length === 0, detail: { rpc: r.rpc.map((x) => x.name), objects: r.objects } },
      { name: "the request reopens the script (script_ready) asking to extend the claim, in plain words", ok: v.status === "script_ready" && /escena 1/.test(String(v.error_message)) && /demasiado corta/.test(String(v.error_message)) && !/\[configuración interna\]/.test(String(v.error_message)), detail: { exit: r.exit, status: v.status, error: v.error_message } },
    ]);
  }

  if (want("preflight-values")) {
    const packed = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 0 ? { ...s, text: "El 30 % recordó la historia y el 70 % recordó el dato." } : s) };
    const id = randomUUID();
    const r = runWorker("preflight-values", seedFor(id, packed), {}, id);
    const v = row(r, id);
    finish("preflight-values", r, [
      { name: "two values in one clause: the worker stops BEFORE narration or reservation (no pi_reserve_job_supply, no objects, nothing paid)", ok: !r.rpc.some((x) => x.name === "pi_reserve_job_supply") && r.objects.length === 0 && (r.tables.pi_paid_operations ?? []).length === 0 && reservations(r).length === 0, detail: { rpc: r.rpc.map((x) => x.name), objects: r.objects } },
      { name: "the request reopens the script (script_ready) asking to split the figures, in plain words", ok: v.status === "script_ready" && /escena 1/.test(String(v.error_message)) && /reparte las cifras/.test(String(v.error_message)) && !/\[configuración interna\]/.test(String(v.error_message)), detail: { exit: r.exit, status: v.status, error: v.error_message } },
    ]);
  }

  if (want("preflight-block")) {
    const remains = { ...script, segments: script.segments.map((s: { text: string }, i: number) => i === 1 ? { ...s, text: "Encontraron restos humanos bajo el templo y nadie lo contó." } : s) };
    const id = randomUUID();
    const r = runWorker("preflight-block", seedFor(id, remains), {}, id);
    const v = row(r, id);
    finish("preflight-block", r, [
      { name: "the worker stops BEFORE narration or reservation: no pi_reserve_job_supply, no objects, no paid operation", ok: !r.rpc.some((x) => x.name === "pi_reserve_job_supply") && r.objects.length === 0 && (r.tables.pi_paid_operations ?? []).length === 0 && reservations(r).length === 0, detail: { rpc: r.rpc.map((x) => x.name), objects: r.objects } },
      { name: "the request reopens the script (script_ready) with the scene and the sentence to change, in plain words", ok: v.status === "script_ready" && /escena 2/.test(String(v.error_message)) && /restos humanos/.test(String(v.error_message)) && /antes de generar voz/.test(String(v.error_message)) && !/\[configuración interna\]/.test(String(v.error_message)), detail: { exit: r.exit, status: v.status, error: v.error_message } },
    ]);
  }

  const summary = { PASS: results.filter((r) => r.status === "PASS").length, FAIL: results.filter((r) => r.status === "FAIL").length };
  const report = { generatedAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim(), entrypoint: "scripts/render-worker.ts (child process, local fixture mode, supply guard enforced, in-memory test database)", summary, results };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  const md = [`# Worker E2E local (entrypoint productivo) — ${report.commit}`, "", `Resultado: **${summary.PASS} PASS · ${summary.FAIL} FAIL**`, "", "| Escenario | Estado | Exit | Tiempo | Comprobaciones |", "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.scenario} | ${r.status} | ${r.exit} | ${Math.round(r.ms / 1000)} s | ${r.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join("<br>")} |`)].join("\n");
  fs.writeFileSync(path.join(OUT, "report.md"), md + "\n");
  console.log(`\n[worker-e2e] ${summary.PASS} PASS · ${summary.FAIL} FAIL — ${path.join(OUT, "report.md")}`);
  process.exitCode = summary.FAIL > 0 ? 1 : 0;
}

main().catch((e) => { console.error("[worker-e2e] fallo:", e); process.exit(2); });
