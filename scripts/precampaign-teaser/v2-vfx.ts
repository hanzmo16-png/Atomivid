/**
 * ATOMIVID PRECAMPAIGN V2 — VFX-001 (Hans → cinematic New York at night), ONE attempt at most.
 *
 * 1. Builds the exact 5.0 s source from the OPENING take (window chosen after the free analysis):
 *    9:16 1080x1920, 30 fps, approved warm polish, no audio. Persisted once in Storage so its sha256 —
 *    the economic identity — never changes between runs.
 * 2. VFX_001_SPEND_PLAN (pure). The owner's authorization applies ONLY if the plan is exactly
 *    Luma Agents API / ray-3.2 / video_edit / 720p / 9:16 / SDR / 5.0 s with expected cost ≤ 1.08 and
 *    a per-operation maximum ≤ 1.08. Otherwise STOP before any paid call.
 * 3. One generation through gatedVfxTransform (paid-call gate + ledger + idempotency + persistence).
 *    A committed result is reused for free; any other existing VFX-001 row (refused, uncertain…)
 *    means a first attempt already happened → STOP, never a second automatic attempt.
 * 4. Source vs output comparison (frames + side-by-side video) and automatic checks; the visual
 *    identity QA is human/agent review of these files.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export {};

const sh = promisify(execFile);
const FF = process.env.FFMPEG_BIN ?? "ffmpeg";
const FP = process.env.FFPROBE_BIN ?? "ffprobe";
const OUT = resolve("teaser-v2/vfx");
const PROJECT = "atomivid-vfx-001";
const SOURCE_DIR = "precampaign-teaser-v1/v2";
const MAX_THIS_RUN_USD = 1.08;
const run = (bin: string, args: string[]) => sh(bin, args, { maxBuffer: 256 * 1024 * 1024 });
const ff = (args: string[]) => run(FF, ["-hide_banner", "-v", "error", "-y", ...args]);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Args = { openingPath: string; vfxStart: number; cropX?: number; execute?: boolean };

async function probe(file: string) {
  const { stdout } = await run(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string; side_data_list?: { rotation?: number }[] }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const rot = Math.abs(Number(v?.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0));
  const swap = rot === 90 || rot === 270;
  const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return { width: (swap ? v?.height : v?.width) ?? 0, height: (swap ? v?.width : v?.height) ?? 0, fps: d ? n / d : 0, duration: Number(j.format?.duration ?? 0), frames: Number(v?.nb_frames ?? 0) };
}

async function main() {
  const args = JSON.parse(process.env.TEASER_V2_ARGS || "{}") as Args;
  if (!args.openingPath || !Number.isFinite(args.vfxStart)) throw new Error("Faltan openingPath/vfxStart en TEASER_V2_ARGS.");
  await mkdir(OUT, { recursive: true });
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const { RETOUCH_GRAPH } = await import("./v2-look");
  const service = createServiceClient();
  const videos = service.storage.from("videos");

  // ---------- 1. Exact 5.0 s source, persisted once ----------
  const tag = `${args.openingPath.split("/").pop()}-${args.vfxStart.toFixed(3)}-${(args.cropX ?? 0.5).toFixed(3)}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const srcPath = `${SOURCE_DIR}/vfx-001-source-${tag}.mp4`;
  const local = join(OUT, "vfx-001-source.mp4");
  let bytes: Buffer;
  const existing = await videos.download(srcPath);
  if (existing.data) {
    bytes = Buffer.from(await existing.data.arrayBuffer());
  } else {
    const dl = await videos.download(args.openingPath);
    if (!dl.data) throw new Error(`No se pudo leer ${args.openingPath}`);
    const original = join(OUT, "opening-original.mp4");
    await writeFile(original, Buffer.from(await dl.data.arrayBuffer()));
    const p = await probe(original);
    const portrait = p.height > p.width;
    const cx = Math.min(1, Math.max(0, args.cropX ?? 0.5));
    // Landscape takes are cropped to 9:16 around the subject; portrait takes are only scaled.
    const frame = portrait ? "scale=1080:1920:flags=lanczos" : `crop=ih*9/16:ih:(iw-ih*9/16)*${cx.toFixed(3)}:0,scale=1080:1920:flags=lanczos`;
    await ff(["-ss", args.vfxStart.toFixed(3), "-i", original, "-t", "5.000", "-filter_complex", `[0:v]${frame},fps=30,setsar=1[src];${RETOUCH_GRAPH("src", "v")}`, "-map", "[v]", "-an",
      "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", local]);
    bytes = await readFile(local);
    const { error } = await videos.upload(srcPath, bytes, { contentType: "video/mp4", upsert: false });
    if (error) throw new Error(`No se pudo guardar el origen VFX: ${error.message}`);
  }
  await writeFile(local, bytes);
  const m = await probe(local);
  const source = { sha256: sha256(bytes), sizeBytes: bytes.byteLength, mimeType: "video/mp4", durationSeconds: Math.round(m.duration * 1000) / 1000, width: m.width, height: m.height, fps: m.fps };

  // ---------- 2. Spend plan + authorization check ----------
  const { buildVfxSpendPlan, VFX_001 } = await import("../../src/lib/video/vfx/vfx-001");
  const plan = buildVfxSpendPlan(source);
  const exact = plan.provider === "luma" && plan.model === "ray-3.2" && plan.requestType === "video_edit" && plan.request.resolution === "720p" && plan.request.aspectRatio === "9:16" && plan.request.dynamicRange === "sdr" && Math.abs(source.durationSeconds - 5) <= 0.05;
  const authorized = exact && plan.blockers.length === 0 && plan.estimatedCostUsd !== null && plan.estimatedCostUsd <= MAX_THIS_RUN_USD;
  const { data: rows } = await service.from("pi_paid_operations").select("idempotency_key,status,reserved_usd,committed_usd,updated_at").eq("project_id", PROJECT);
  const ledger = rows ?? [];
  const spendPlan = { ...plan, thisRun: { maxAttempts: 1, maxCostUsd: MAX_THIS_RUN_USD, otherPaidProviders: "none" }, source: { ...plan.source, storagePath: srcPath, window: { openingPath: args.openingPath, startSeconds: args.vfxStart, endSeconds: args.vfxStart + 5 } }, existingLedgerRows: ledger, authorizedByOwnerOrder: authorized };
  await writeFile(join(OUT, "vfx-001-spend-plan.json"), JSON.stringify(spendPlan, null, 2) + "\n");
  console.log(JSON.stringify({ VFX_001_SPEND_PLAN: spendPlan }, null, 2));
  if (!authorized) throw new Error("VFX_001_SPEND_PLAN fuera de la autorización (operación exacta / ≤ USD 1.08): STOP antes de gastar.");
  if (!args.execute) {
    console.log("VFX_001_PLAN_ONLY: execute=false, ninguna llamada pagada.");
    return;
  }

  // ---------- 3. One generation through the gate ----------
  const { gatedVfxTransform, vfxCallSpec } = await import("../../src/lib/paid-calls/gated-vfx");
  const { paidCallKey } = await import("../../src/lib/paid-calls/gate");
  const { supabaseLedgerStore } = await import("../../src/lib/paid-calls/supabase-ledger-store");
  const { supabaseResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { lumaVfxProvider } = await import("../../src/lib/providers/vfx/luma");
  const { data: signed } = await videos.createSignedUrl(srcPath, 3600);
  if (!signed?.signedUrl) throw new Error("No se pudo firmar el origen VFX.");
  const request = {
    source: { ...source, url: signed.signedUrl },
    range: { startSeconds: args.vfxStart, endSeconds: args.vfxStart + source.durationSeconds },
    prompt: VFX_001.prompt,
    negativePrompt: VFX_001.negativePrompt,
    aspectRatio: "9:16" as const,
    resolution: "720p" as const,
    dynamicRange: "sdr" as const,
    preserveSubject: true,
    strength: VFX_001.strength,
    controls: VFX_001.controls,
    style: VFX_001.style,
    maxCostUsd: MAX_THIS_RUN_USD,
  };
  const ourKey = paidCallKey(vfxCallSpec(PROJECT, lumaVfxProvider, request, 0));
  const foreign = ledger.filter((r) => r.idempotency_key !== ourKey);
  if (foreign.length) throw new Error(`Ya existe otro intento VFX-001 en el ledger (${foreign.map((r) => r.status).join(", ")}): no hay segundo intento automático.`);
  const committedUsd = ledger.reduce((a, r) => a + Number(r.committed_usd ?? 0), 0);
  const result = await gatedVfxTransform(
    { ledger: supabaseLedgerStore(service), results: supabaseResultStore(service, "videos"), requestId: PROJECT, provider: lumaVfxProvider, budget: { hardCapUsd: VFX_001.hardCapUsd, committedUsd, reservedUsd: 0 } },
    request,
  );
  const outFile = join(OUT, "vfx-001-output.mp4");
  await writeFile(outFile, result.buffer);

  // ---------- 4. Comparison + automatic checks ----------
  const o = await probe(outFile);
  for (const t of [0.4, 1.5, 2.5, 3.5, 4.6]) {
    await ff(["-ss", t.toFixed(2), "-i", local, "-ss", Math.min(t, o.duration - 0.05).toFixed(2), "-i", outFile, "-frames:v", "1", "-filter_complex", "[0:v]scale=540:960,setsar=1[a];[1:v]scale=540:960,setsar=1[b];[a][b]hstack=2", join(OUT, `vfx-001-compare-${t.toFixed(1)}.jpg`)]);
  }
  await ff(["-i", local, "-i", outFile, "-filter_complex", "[0:v]scale=540:960,setsar=1,fps=30[a];[1:v]scale=540:960,setsar=1,fps=30[b];[a][b]hstack=2", "-c:v", "libx264", "-crf", "22", "-pix_fmt", "yuv420p", "-t", "5", join(OUT, "vfx-001-source-vs-output.mp4")]);
  const flick = (await run(FF, ["-hide_banner", "-i", outFile, "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YDIF", "-f", "null", "-"]).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }))).stderr;
  const ydif = [...flick.matchAll(/YDIF=([\d.]+)/g)].map((x) => Number(x[1]));
  const report = {
    costUsd: result.costUsd, reused: result.reused, ledgerKey: result.key,
    output: { width: o.width, height: o.height, fps: o.fps, durationSeconds: o.duration, bytes: result.buffer.byteLength },
    checks: { durationMatchesSource: Math.abs(o.duration - source.durationSeconds) < 0.15, portrait916: Math.abs(o.width / o.height - 9 / 16) < 0.02, maxFrameDiff: Math.max(...ydif, 0), meanFrameDiff: ydif.length ? ydif.reduce((a, b) => a + b, 0) / ydif.length : 0 },
  };
  await writeFile(join(OUT, "vfx-001-result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ VFX_001_RESULT: report }, null, 2));
}

main().catch((err) => {
  console.error("VFX-001 detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
