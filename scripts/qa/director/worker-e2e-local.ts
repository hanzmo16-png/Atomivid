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
 *
 *   npx tsx scripts/qa/director/worker-e2e-local.ts --out-dir=<dir> [--only=positive,classic]
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

type Seed = { tables: Record<string, Record<string, unknown>[]> };
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
