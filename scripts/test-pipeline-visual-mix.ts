/**
 * Prueba de extremo a extremo del pipeline de generación (visual mode)
 * forzando una MEZCLA real de imagen generada + stock en el mismo video
 * — contraparte de scripts/test-pipeline.ts (que siempre usa stock puro,
 * porque el storyboard simulado clasifica TODAS las escenas como
 * "stock_video", ver storyboard/simulate.ts). Verificar solo el resolver
 * (scripts/dry-run-visual-mix.ts) no demuestra que el RENDER final de
 * Remotion realmente componga ambos orígenes en un mismo video — este
 * script sí ejecuta ese render completo, con costo $0 (proveedores
 * fixture en todo el flujo).
 *
 * Cómo se fuerza la escena de imagen sin gastar en una llamada real a
 * Claude: STORYBOARD_SIMULATE_FORCE_GENERATED_IMAGE_SCENE_INDEX=0 hace
 * que storyboard/simulate.ts marque la escena 0 como "generated_image"
 * con confidence=0.9 (ver ese archivo) — es una puerta SOLO de pruebas,
 * no cambia el comportamiento por defecto. Con VISUAL_DIRECTOR_ENABLED=
 * true + OPENAI_IMAGE_GENERATION_ENABLED=true + IMAGE_PROVIDER=fixture,
 * decideResourceStrategy() en visual-resource-planner.ts elige
 * generación para esa escena (imageProvider fixture, $0 real) y stock
 * para el resto — la mezcla real que un guion con Visual Director real
 * produciría, pero sin ninguna llamada pagada.
 *
 * Uso: npx tsx scripts/test-pipeline-visual-mix.ts [--out-dir /ruta/salida]
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

process.env.SCRIPT_PROVIDER = "fixture";
process.env.VOICE_PROVIDER = "fixture";
process.env.FOOTAGE_PROVIDER = "fixture";
process.env.MUSIC_PROVIDER = "fixture";
process.env.IMAGE_PROVIDER = "fixture";
process.env.VISUAL_DIRECTOR_ENABLED = "true";
process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";
process.env.STORYBOARD_SIMULATE_FORCE_GENERATED_IMAGE_SCENE_INDEX = "0";

async function main() {
  const rawArgs = process.argv.slice(2);
  const outDirFlagIndex = rawArgs.indexOf("--out-dir");
  const outDir = outDirFlagIndex >= 0 ? rawArgs[outDirFlagIndex + 1] : undefined;

  const { generateScriptForRequest } = await import("../src/lib/video/generate-script");
  const { generateVideoFromScript } = await import("../src/lib/video/generate-video");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-storage-mix-"));

  const CONTENT_TYPES: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
  };

  const server = http.createServer((req, res) => {
    const filePath = path.join(storageDir, decodeURIComponent(req.url ?? ""));
    if (!filePath.startsWith(storageDir) || !fsSync.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    fsSync.createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const uploadedPaths = new Set<string>();
  const mockSupabase = {
    storage: {
      from(_bucket: string) {
        return {
          async upload(objectPath: string, buffer: Buffer) {
            const fullPath = path.join(storageDir, objectPath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, buffer);
            uploadedPaths.add(objectPath);
            return { error: null };
          },
          // Marcadores/registros durables (visual-resource-resolver.ts, voice-cache.ts).
          async download(objectPath: string) {
            const full = path.join(storageDir, objectPath);
            if (!fsSync.existsSync(full)) return { data: null, error: { message: "Object not found", statusCode: "404" } };
            return { data: new Blob([new Uint8Array(await fs.readFile(full))]), error: null };
          },
          async remove(paths: string[]) {
            for (const p of paths) await fs.rm(path.join(storageDir, p), { force: true });
            return { data: [], error: null };
          },
          getPublicUrl(objectPath: string) {
            return { data: { publicUrl: `${baseUrl}/${objectPath}` } };
          },
          async createSignedUrl(objectPath: string) {
            return { data: { signedUrl: `${baseUrl}/${objectPath}` }, error: null };
          },
          // Requerido por resolveGeneratedImageForScene() para la
          // búsqueda de idempotencia (ver visual-resource-resolver.ts) —
          // mismo patrón que scripts/dry-run-visual-mix.ts.
          async list(dir: string, opts: { search: string }) {
            const matches = Array.from(uploadedPaths)
              .filter((p) => p.startsWith(`${dir}/`) && p.includes(opts.search))
              .map((p) => ({ name: p.split("/").pop()! }));
            return { data: matches, error: null };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const topic = "UNA MAÑANA PARA EMPEZAR DE NUEVO";
  const style = "motivacional, cinematográfico";
  const durationSeconds = 45;

  console.log("Generando guion de prueba con proveedores fixture...");
  const start = Date.now();
  const { script, providerName } = await generateScriptForRequest({ topic, style, durationSeconds });
  console.log(
    `Guion generado (proveedor: ${providerName}): "${script.title}" con ${script.segments.length} escenas`,
  );

  const visualLog: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (line.includes("[atomivid:visual]") || line.includes("[atomivid:storyboard]") || line.includes("[atomivid:visual-plan]")) visualLog.push(line);
    originalLog(...args);
  };

  console.log("Renderizando video final (mezcla imagen generada + stock forzada)...");
  const { videoPath } = await generateVideoFromScript({
    supabase: mockSupabase,
    requestId: "test-atomivid-mix",
    script,
    style,
    targetDurationSeconds: durationSeconds,
    onProgress: (stage) => console.log(`  → etapa: ${stage}`),
  });

  console.log = originalLog;

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Video generado en ${elapsed}s: ${videoPath}`);

  const usedGeneratedImage = visualLog.some((l) => l.includes('"status":"generated"') || l.includes('"status":"reused"'));
  const usedStock = Array.from(uploadedPaths).some((p) => /\/scene-\d+-\d+\./.test(p)); // subida efectiva de footage, no mera existencia de un log
  console.log("\nEvidencia de la mezcla (líneas [atomivid:visual]/[atomivid:storyboard] capturadas):");
  for (const l of visualLog) console.log("  " + l);

  if (!usedGeneratedImage || !usedStock) {
    throw new Error(
      "La escena forzada NO usó el proveedor de imagen generada — revisa STORYBOARD_SIMULATE_FORCE_GENERATED_IMAGE_SCENE_INDEX, " +
        "VISUAL_DIRECTOR_ENABLED y OPENAI_IMAGE_GENERATION_ENABLED.",
    );
  }
  console.log(
    `\nMezcla confirmada: escena 0 resuelta por generación de imagen (fixture, $0); ${usedStock ? "el resto de escenas siguió el camino de stock (footage-select.ts), sin generación" : ""}.`,
  );

  const localPath = path.join(storageDir, videoPath);
  const destName = "atomivid-test-output-visual-mix.mp4";
  const outPath = outDir ? path.join(outDir, destName) : path.join(process.cwd(), "scripts", destName);
  if (outDir) await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(localPath, outPath);
  console.log(`Copiado a: ${outPath}`);

  if (outDir) {
    const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
    await verifyVideoEvidence(outPath);
    await fs.writeFile(path.join(outDir, "visual-decisions.log"), visualLog.join("\n"));
  }

  server.close();
}

main().catch((err) => {
  console.error("Falló la prueba de mezcla imagen+stock:", err);
  process.exit(1);
});
