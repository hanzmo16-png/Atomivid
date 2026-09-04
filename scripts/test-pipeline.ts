/**
 * Prueba de extremo a extremo del pipeline de generación usando
 * proveedores fixture (sin red, sin claves) — Fase 5/6 del plan de
 * ejecución. No se sube a producción; solo se usa aquí en desarrollo.
 *
 * Uso: npx tsx scripts/test-pipeline.ts
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.SCRIPT_PROVIDER = "fixture";
process.env.VOICE_PROVIDER = "fixture";
process.env.FOOTAGE_PROVIDER = "fixture";
process.env.MUSIC_PROVIDER = "fixture";
process.env.REMOTION_BROWSER_EXECUTABLE =
  process.env.REMOTION_BROWSER_EXECUTABLE ||
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
process.env.REMOTION_CHROME_MODE = process.env.REMOTION_CHROME_MODE || "headless-shell";

async function main() {
  const { generateVideoForRequest } = await import("../src/lib/video/generate");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-storage-"));

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

  const mockSupabase = {
    storage: {
      from(_bucket: string) {
        return {
          async upload(objectPath: string, buffer: Buffer) {
            const fullPath = path.join(storageDir, objectPath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, buffer);
            return { error: null };
          },
          getPublicUrl(objectPath: string) {
            return { data: { publicUrl: `${baseUrl}/${objectPath}` } };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  console.log("Generando video de prueba con proveedores fixture...");
  const start = Date.now();

  const { videoUrl } = await generateVideoForRequest({
    supabase: mockSupabase,
    requestId: "test-atomivid",
    topic: "LOS RESULTADOS TIENEN UN PRECIO",
    style: "motivacional, cinematográfico",
    durationSeconds: 75,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Video generado en ${elapsed}s: ${videoUrl}`);

  const localPath = videoUrl.replace(baseUrl, storageDir);
  const outPath = path.join(process.cwd(), "scripts", "atomivid-test-output.mp4");
  await fs.copyFile(localPath, outPath);
  console.log(`Copiado a: ${outPath}`);

  server.close();
}

main().catch((err) => {
  console.error("Fallo la prueba del pipeline:", err);
  process.exit(1);
});
