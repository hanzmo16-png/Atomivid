/**
 * ATOMIVID PRECAMPAIGN V2 — VFX-002 SUBJECT-LOCKED COMPOSITING (local, USD 0, no provider call).
 *
 * HANS ORIGINAL PIXELS + SUBJECT MATTE + NYC PLATE + LOCAL COMPOSITE/RELIGHT (scripts/precampaign-teaser/vfx002.py).
 * - Subject: the persisted VFX source (exact 5.0 s window of the real OPENING take, approved polish).
 * - Plate raw material: the VFX-001 Luma output already paid and stored in the ledger result store
 *   (replayed with loadVfx, sha256-verified). Its generated person is matted out; it never reaches the
 *   composite. No Luma/Runway/Veo/Kling/OpenAI call, no API key in this stage.
 * - Matting model: Robust Video Matting mobilenetv3 ONNX (public release, sha256-pinned by the workflow).
 * Output: composite stored at videos/precampaign-teaser-v1/v2/vfx-002-composite.mp4 + QA files.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export {};

const sh = promisify(execFile);
const FF = process.env.FFMPEG_BIN ?? "ffmpeg";
const OUT = resolve("teaser-v2/vfx002");
const MODEL = resolve(process.env.VFX002_MODEL ?? "teaser-v2/rvm_mobilenetv3_fp32.onnx");
const VFX_PROJECT = "atomivid-vfx-001";
const SOURCE_DIR = "precampaign-teaser-v1/v2";
export const VFX002_COMPOSITE_PATH = `${SOURCE_DIR}/vfx-002-composite.mp4`;
const run = (bin: string, args: string[]) => sh(bin, args, { maxBuffer: 256 * 1024 * 1024 });
const ff = (args: string[]) => run(FF, ["-hide_banner", "-v", "error", "-y", ...args]);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function main() {
  await mkdir(OUT, { recursive: true });
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const { supabaseResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { loadVfx } = await import("../../src/lib/paid-calls/gated-vfx");
  const service = createServiceClient();
  const videos = service.storage.from("videos");

  // Subject source: the persisted exact window (same bytes VFX-001 was priced on).
  const { data: list } = await videos.list(SOURCE_DIR, { limit: 100 });
  const src = (list ?? []).find((e) => e.name.startsWith("vfx-001-source-"));
  if (!src) throw new Error("Origen VFX persistido no encontrado: STOP.");
  const { data: srcBlob, error: srcErr } = await videos.download(`${SOURCE_DIR}/${src.name}`);
  if (srcErr || !srcBlob) throw new Error("No se pudo leer el origen VFX.");
  const srcBytes = Buffer.from(await srcBlob.arrayBuffer());
  const srcFile = join(OUT, "vfx-002-source.mp4");
  await writeFile(srcFile, srcBytes);

  // Plate raw material: replay the committed VFX-001 result (never a provider call).
  const { data: rows } = await service.from("pi_paid_operations").select("project_id,provider,status,result_ref").eq("project_id", VFX_PROJECT);
  const row = (rows ?? []).find((r) => r.status === "COMMITTED" && r.provider === "luma" && r.result_ref);
  const asset = row ? await loadVfx(supabaseResultStore(service, "videos"), row.result_ref!) : null;
  if (!asset) throw new Error("Resultado VFX-001 persistido no disponible: STOP (no se vuelve a llamar a Luma).");
  await mkdir(resolve("teaser-v2/work"), { recursive: true });
  const lumaFile = resolve("teaser-v2/work/plate-material-luma.mp4");
  await writeFile(lumaFile, asset.buffer);

  const modelBytes = await readFile(MODEL);
  await run("python3", [resolve("scripts/precampaign-teaser/vfx002.py"), MODEL, srcFile, lumaFile, OUT]);
  const report = JSON.parse(await readFile(join(OUT, "vfx-002-report.json"), "utf8")) as Record<string, unknown>;
  const comp = await readFile(join(OUT, "vfx-002-composite.mp4"));

  // Contact sheet: source row vs composite row.
  const sel = "select='eq(n\\,0)+eq(n\\,24)+eq(n\\,36)+eq(n\\,48)+eq(n\\,75)+eq(n\\,110)+eq(n\\,149)'";
  await ff(["-i", srcFile, "-vf", `${sel},scale=270:480,tile=7x1`, "-frames:v", "1", "-vsync", "0", join(OUT, "cs-src.png")]);
  await ff(["-i", join(OUT, "vfx-002-composite.mp4"), "-vf", `${sel},scale=270:480,tile=7x1`, "-frames:v", "1", "-vsync", "0", join(OUT, "cs-comp.png")]);
  await ff(["-i", join(OUT, "cs-src.png"), "-i", join(OUT, "cs-comp.png"), "-filter_complex", "[0][1]vstack=2", "-q:v", "3", join(OUT, "vfx-002-contact-sheet.jpg")]);

  const lock = report.subjectLock as { maxAbsDiffInteriorVsGradedSource: number };
  if (lock.maxAbsDiffInteriorVsGradedSource > 3) throw new Error(`Subject lock roto (${lock.maxAbsDiffInteriorVsGradedSource}/255 en el interior): STOP, no se sube.`);
  const { error: upErr } = await videos.upload(VFX002_COMPOSITE_PATH, comp, { contentType: "video/mp4", upsert: true });
  if (upErr) throw new Error(`No se pudo guardar el composite: ${upErr.message}`);
  const result = {
    id: "ATOMIVID_VFX_002_SUBJECT_LOCKED_COMPOSITE",
    spendUsd: 0,
    providerCalls: 0,
    source: { path: `${SOURCE_DIR}/${src.name}`, sha256: sha256(srcBytes), bytes: srcBytes.byteLength },
    plateMaterial: { ledgerProject: VFX_PROJECT, resultRef: row!.result_ref, sha256: sha256(asset.buffer), note: "VFX-001 output reused as raw plate only (generated subject matted out)" },
    model: { file: MODEL.split("/").pop(), sha256: sha256(modelBytes) },
    composite: { path: VFX002_COMPOSITE_PATH, sha256: sha256(comp), bytes: comp.byteLength },
    report,
  };
  await writeFile(join(OUT, "vfx-002-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("VFX-002 detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
