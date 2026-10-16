/**
 * Recorrido YouTube / Long Form de ~600 s sobre el pipeline REAL de
 * producción (src/lib/video/long-form/produce.ts → generateLongFormVideoFromScript),
 * el mismo que ejecuta el worker de T-08. Igual que produce-pipeline.test.ts,
 * solo se sustituyen los proveedores (fixtures de mode.ts "simulation"), el
 * ledger/presupuesto/almacenamiento (en memoria) y la entrega final; el
 * render es el renderLongFormDoc real de Remotion.
 *
 * El perfil acelerado (480x270, x264 ultrafast) lo aplica la precarga
 * scripts/simulator/render-capture.cjs (SIM_RENDER_PROFILE=structural_lowres):
 * prueba ESTRUCTURAL de 600 s — no mide el rendimiento ni la calidad a 1080p.
 *
 * Uso (lo lanza el simulador bajo /usr/bin/time -v):
 *   SIM_CAPTURE_DIR=<dir> SIM_RENDER_PROFILE=structural_lowres SIM_CAPTION_STILLS=1 SIM_NETWORK_GUARD=1 \
 *   node --require ./scripts/simulator/render-capture.cjs --import tsx scripts/simulator/youtube-600.ts --out=<mp4> [--render=stub]
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { FootageProvider } from "../../src/lib/providers/types";

const SANDBOX_HEADLESS_SHELL = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
if (!process.env.REMOTION_BROWSER_EXECUTABLE && fs.existsSync(SANDBOX_HEADLESS_SHELL)) {
  process.env.REMOTION_BROWSER_EXECUTABLE = SANDBOX_HEADLESS_SHELL;
  process.env.REMOTION_CHROME_MODE = process.env.REMOTION_CHROME_MODE || "headless-shell";
}

const arg = (name: string, fallback?: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
export const TARGET_SECONDS = Number(arg("target-seconds", "600"));

/** Guion sintético de ~600 s: el documental de prueba del repo (test-fixtures.ts) repetido por ciclos y recortado por palabras. */
export async function syntheticDocumentaryBeats(targetSeconds = TARGET_SECONDS) {
  const { documentary180sFixture } = await import("../../src/lib/video/long-form/test-fixtures");
  const { WORDS_PER_SECOND, VIDEO_TAIL_SECONDS } = await import("../../src/lib/video/script-pacing");
  const base = documentary180sFixture();
  const targetWords = Math.round((targetSeconds - VIDEO_TAIL_SECONDS) * WORDS_PER_SECOND);
  const beats: ReturnType<typeof documentary180sFixture>["beats"] = [];
  let words = 0;
  for (let cycle = 1; words < targetWords; cycle++) {
    for (const b of base.beats) {
      if (words >= targetWords) break;
      const w = b.narration.split(/\s+/).filter(Boolean);
      const take = w.slice(0, Math.min(w.length, targetWords - words));
      let narration = take.join(" ");
      if (!/[.!?…]$/.test(narration)) narration = narration.replace(/[,;:]$/, "") + ".";
      beats.push({ ...b, id: `c${cycle}-${b.id}`, narration });
      words += take.length;
    }
  }
  return { topic: base.topic, beats, words };
}

/**
 * Stock SINTÉTICO (sin red, sin Pexels): varios candidatos por consulta, como el
 * catálogo simulado de produce-pipeline.test.ts, pero con imágenes JPEG reales
 * generadas por ffmpeg (patrón testsrc2 con tono y encuadre únicos por URL) para
 * que Remotion pueda renderizarlas y el control de identidad no las vea duplicadas.
 */
export function syntheticStockProvider(counter: { searches: number; downloads: number }): FootageProvider {
  const cache = new Map<string, Buffer>();
  let call = 0;
  // Cada búsqueda devuelve candidatos nuevos (como un catálogo grande): el guion repite intenciones por ciclo.
  const candidates = (query: string) => { call++; return Array.from({ length: 12 }, (_, i) => {
    const id = createHash("sha256").update(`${query}#${call}#${i}`).digest("hex").slice(0, 16);
    return { url: `https://sim-stock.local/i/${id}.jpg`, sourceId: `sim-${id}`, description: query, mediaType: "image" as const, mimeType: "image/jpeg", extension: "jpg" };
  }); };
  return {
    name: "sim-stock",
    async fetchFootage(query) { counter.searches++; const c = candidates(query)[0]; return { url: c.url, mediaType: "image", mimeType: c.mimeType, extension: c.extension }; },
    async searchVideoCandidates() { counter.searches++; return []; },
    async searchImageCandidates(query) { counter.searches++; return candidates(query); },
    async downloadFootage(url) {
      counter.downloads++;
      const hit = cache.get(url);
      if (hit) return hit;
      const h = parseInt(createHash("sha256").update(url).digest("hex").slice(0, 8), 16);
      const color = (h & 0xffffff).toString(16).padStart(6, "0");
      // Patrón "life" con semilla propia: estructura distinta por URL (el hash perceptual no los ve iguales).
      const buf = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `life=s=160x90:seed=${h}:ratio=0.${3 + (h % 5)}:mold=10:death_color=#${color}:life_color=#f0f0f0`,
        "-vf", "scale=1280:720:flags=neighbor", "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
      cache.set(url, buf);
      return buf;
    },
  };
}

async function main() {
  const out = arg("out")!;
  const renderMode = arg("render", "real");
  const { generateLongFormVideoFromScript } = await import("../../src/lib/video/long-form/produce");
  const { computeProductionPlan, REAL_LONG_FORM_PROVIDER_NAMES } = await import("../../src/lib/video/long-form/production-plan");
  const { resolveLongFormProviders } = await import("../../src/lib/video/long-form/mode");
  const { memoryShotAssetStore } = await import("../../src/lib/video/long-form/durable-shot-assets");
  const { memoryBudgetStore } = await import("../../src/lib/video/long-form/production-budget");
  const { memoryOutputDeps } = await import("../../src/lib/video/long-form/output-finalize");
  const { memoryLedgerStore } = await import("../../src/lib/production-intelligence/ledger");
  const { memoryResultStore } = await import("../../src/lib/paid-calls/result-store");
  const { renderLongFormDoc } = await import("../../src/lib/video/long-form/render");

  const script = await syntheticDocumentaryBeats();
  const plan = computeProductionPlan({ beats: script.beats, topic: script.topic, strategy: "economical", providers: REAL_LONG_FORM_PROVIDER_NAMES, aiVideoEnabled: false });
  const stockCounter = { searches: 0, downloads: 0 };
  const providers = { ...resolveLongFormProviders("simulation"), footageProvider: syntheticStockProvider(stockCounter) };

  // Almacenamiento local (mismo patrón que produce-long-form-video.ts): URLs http:// reales para Remotion.
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomivid-sim-lf-"));
  const server = http.createServer((req, res) => {
    const filePath = path.join(storageDir, decodeURIComponent((req.url ?? "").split("?")[0]));
    if (!filePath.startsWith(storageDir) || !fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const supabaseFiles = new Map<string, Buffer>();
  const supabase = { storage: { from() { return {
    async download(p: string) { const b = supabaseFiles.get(p); return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "nf" } }; },
    async upload(p: string, body: Buffer) { supabaseFiles.set(p, Buffer.from(body)); return { error: null }; },
  }; } } };
  const ledger = memoryLedgerStore();
  const outputs = memoryOutputDeps({ durationSeconds: TARGET_SECONDS });
  const stages: { stage: string; at: number; completed?: number; total?: number }[] = [];
  const t0 = Date.now();
  let renderInputSummary: Record<string, unknown> | null = null;
  try {
    const result = await generateLongFormVideoFromScript({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      requestId: "sim-youtube-600",
      topic: script.topic,
      beats: script.beats,
      language: "es",
      plan,
      providers,
      runtime: {
        paidCalls: { ledger, results: memoryResultStore() },
        // Registro durable en memoria; los objetos se sirven por el HTTP local para que Remotion los cargue.
        store: (() => { const mem = memoryShotAssetStore().store; return { ...mem,
          async putObject(objectPath: string, buffer: Buffer, contentType: string) {
            await mem.putObject(objectPath, buffer, contentType);
            const full = path.join(storageDir, objectPath);
            await fsp.mkdir(path.dirname(full), { recursive: true });
            await fsp.writeFile(full, buffer);
          },
          async signedUrl(objectPath: string) { await mem.signedUrl(objectPath); return `http://127.0.0.1:${port}/${objectPath}`; },
        }; })(),
        budgetStore: memoryBudgetStore(),
        observedUnitMax: {},
        videoProvider: null,
        aiVideoEnabled: false,
        recordCosts: false,
        resumeBackoffMs: 0,
        output: outputs.deps,
        saveVisualReport: async (report) => { await fsp.writeFile(out.replace(/\.mp4$/, ".visual-report.json"), JSON.stringify(report, null, 2)); },
        uploadArtifact: async (p, buffer) => {
          const full = path.join(storageDir, p);
          await fsp.mkdir(path.dirname(full), { recursive: true });
          await fsp.writeFile(full, buffer);
          return { path: p, url: `http://127.0.0.1:${port}/${p}` };
        },
        renderThumbnail: async () => { const f = path.join(os.tmpdir(), `sim-thumb-${Date.now()}.jpg`); fs.writeFileSync(f, "thumbnail-not-rendered-in-simulation"); return f; },
        render: async (input) => {
          renderInputSummary = { scenes: input.scenes.length, captions: input.captions.length, durationSeconds: input.durationSeconds, narrationGaps: input.narrationGaps.length };
          if (renderMode === "stub") { const f = path.join(os.tmpdir(), `sim-stub-${Date.now()}.mp4`); fs.writeFileSync(f, "stub"); return f; }
          const file = await renderLongFormDoc(input);
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await fsp.copyFile(file, out);
          return file;
        },
      },
      onProgress: (stage, units) => { stages.push({ stage, at: Date.now() - t0, completed: units?.completed, total: units?.total }); },
    });
    const report = {
      ok: true, renderMode, words: script.words, beats: script.beats.length, plan: { version: plan.version, strategy: plan.strategy, shotCount: plan.shotCount, voiceCharacters: plan.voiceCharacters, estimatedDurationSeconds: (plan as { durationSeconds?: number }).durationSeconds },
      providers: { voice: providers.voiceProvider.name, footage: providers.footageProvider.name, image: providers.imageProvider.name, music: providers.musicProvider.name },
      stock: stockCounter, spentUsd: result.spentUsd, deviations: result.deviations,
      ledgerOps: [...ledger.ops.values()].map((o) => ({ method: o.method, provider: o.provider, status: o.status })),
      renderInput: renderInputSummary, stages, elapsedMs: Date.now() - t0, output: renderMode === "stub" ? null : out,
    };
    await fsp.writeFile(out.replace(/\.mp4$/, ".pipeline.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, stages: stages.length }, null, 2));
  } finally {
    server.close();
    await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith("youtube-600.ts")) {
  main().catch((err) => { console.error("[sim:youtube-600] fallo:", err); process.exit(1); });
}
