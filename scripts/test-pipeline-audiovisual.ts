/**
 * Evidencia de extremo a extremo de la DIRECCIÓN AUDIOVISUAL en Reels, con
 * costo $0: proveedores fixture (voz sintética, clips/imagenes de color
 * sólido, música fixture) y un Supabase simulado sobre disco. Renderiza tres
 * direcciones con el MISMO pipeline que producción (directed-reel.ts):
 *
 *   1. horror      — Horror y misterio (stock oscuro, grado y viñeta, suspenso)
 *   2. comic-mist  — Cómic + guion de misterio (imágenes por escena, suspenso)
 *   3. comic-humor — Cómic + tono Humor (mismas imágenes de estilo, ritmo dinámico)
 *
 * Lo que DEMUESTRA: dirección resuelta, planos que cubren exactamente la
 * narración, fundidos/cortes y movimiento por intención, grado aplicado,
 * MP4 9:16 decodificable. Lo que NO demuestra: calidad real de imagen,
 * música o voz (todo es fixture) — eso requiere muestras reales con
 * presupuesto autorizado (docs/AUDIOVISUAL_PROFILES.md).
 *
 * Uso: npx tsx scripts/test-pipeline-audiovisual.ts [--out-dir /ruta] [--only horror,comic-humor]
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { GeneratedScript } from "../src/lib/providers/types";

export {};

process.env.SCRIPT_PROVIDER = "fixture";
process.env.VOICE_PROVIDER = "fixture";
process.env.FOOTAGE_PROVIDER = "fixture";
process.env.MUSIC_PROVIDER = "fixture";
process.env.IMAGE_PROVIDER = "fixture";
process.env.OPENAI_IMAGE_GENERATION_ENABLED = "true";

const MYSTERY: GeneratedScript = {
  title: "El faro",
  segments: [
    { text: "Nadie sabe qué pasó aquella noche en el faro abandonado de la costa.", visualQuery: "old lighthouse at night", visualConcepts: ["old lighthouse at night", "stormy coast"], energy: "low" },
    { text: "El guardián desapareció y solo quedó un grito en la grabación.", visualQuery: "empty spiral stairway", visualConcepts: ["empty spiral stairway", "old tape recorder"], energy: "low" },
    { text: "Las sombras en la escalera no coincidían con ninguna persona del pueblo.", visualQuery: "shadow on wall", visualConcepts: ["shadow on wall", "flickering lamp"], energy: "medium" },
    { text: "Entonces encontraron la puerta cerrada por dentro. El misterio sigue abierto.", visualQuery: "locked wooden door", visualConcepts: ["locked wooden door", "rusty key"], energy: "high" },
  ],
};

const HUMOR: GeneratedScript = {
  title: "Mi gato programador",
  segments: [
    { text: "Mi gato decidió que el teclado era su cama, y fue ridículo desde el primer día.", visualQuery: "cat sleeping on keyboard", energy: "medium" },
    { text: "Cada intento de trabajar terminaba en un chiste absurdo lleno de letras.", visualQuery: "screen full of random letters", energy: "high" },
    { text: "Hasta mi jefe se rió a carcajadas en plena videollamada.", visualQuery: "boss laughing on video call", energy: "high" },
    { text: "Ahora el gato tiene su propio teclado. Y sigue durmiendo en el mío.", visualQuery: "cat ignoring new keyboard", energy: "medium" },
  ],
};

const CASES = {
  horror: { script: MYSTERY, style: "Curiosidades", topic: "El faro", selection: { version: 1 as const, profile: "horror_mystery" as const } },
  "comic-mist": { script: MYSTERY, style: "Curiosidades", topic: "El faro", selection: { version: 1 as const, profile: "comic" as const } },
  "comic-humor": { script: HUMOR, style: "Humor", topic: "Mi gato programador", selection: { version: 1 as const, profile: "comic" as const } },
};

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes("--out-dir") ? args[args.indexOf("--out-dir") + 1] : path.join(process.cwd(), "scripts");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : Object.keys(CASES);
  await fs.mkdir(outDir, { recursive: true });

  const { generateVideoFromScript } = await import("../src/lib/video/generate-video");
  const { resolveDirection } = await import("../src/lib/video/audiovisual/direction");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-av-"));
  const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4" };
  const server = http.createServer((req, res) => {
    const file = path.join(storageDir, decodeURIComponent(req.url ?? ""));
    if (!file.startsWith(storageDir) || !fsSync.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
    fsSync.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const uploaded = new Set<string>();
  const supabase = {
    storage: {
      from: () => ({
        async upload(p: string, buffer: Buffer) {
          const full = path.join(storageDir, p);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, buffer);
          uploaded.add(p);
          return { error: null };
        },
        async download(p: string) {
          const full = path.join(storageDir, p);
          if (!fsSync.existsSync(full)) return { data: null, error: { message: "Object not found", statusCode: "404" } };
          return { data: new Blob([new Uint8Array(await fs.readFile(full))]), error: null };
        },
        async remove(paths: string[]) {
          for (const p of paths) await fs.rm(path.join(storageDir, p), { force: true });
          return { data: [], error: null };
        },
        async createSignedUrl(p: string) {
          return { data: { signedUrl: `http://127.0.0.1:${port}/${p}` }, error: null };
        },
        async list(dir: string, opts: { search: string }) {
          return { data: [...uploaded].filter((p) => p.startsWith(`${dir}/`) && p.includes(opts.search)).map((p) => ({ name: p.split("/").pop()! })), error: null };
        },
      }),
    },
    from: () => ({ insert: async () => ({ error: null }), upsert: async () => ({ error: null }) }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const report: Record<string, unknown> = {};
  for (const name of only) {
    const c = CASES[name as keyof typeof CASES];
    if (!c) throw new Error(`Caso desconocido: ${name}`);
    const direction = resolveDirection({ selection: c.selection, style: c.style, topic: c.topic, scenes: c.script.segments });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => {
      const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
      if (line.includes("[atomivid:direction")) logs.push(line);
      original(...a);
    };
    const started = Date.now();
    const { videoPath } = await generateVideoFromScript({ supabase, requestId: `av-${name}`, script: c.script, style: c.style, topic: c.topic, direction, onProgress: (s) => original(`  [${name}] etapa: ${s}`) });
    console.log = original;
    const out = path.join(outDir, `audiovisual-${name}.mp4`);
    await fs.copyFile(path.join(storageDir, videoPath), out);
    const montage = logs.find((l) => l.startsWith("[atomivid:direction-montage]"));
    report[name] = { summary: direction.summary, profile: direction.profile, intent: direction.intent, music: direction.music, pace: direction.pace, seconds: (Date.now() - started) / 1000, montage: montage ? JSON.parse(montage.slice(montage.indexOf("{"))) : null };
    console.log(`✔ ${name}: ${direction.summary} → ${out}`);
    if (process.env.CI || args.includes("--verify")) {
      const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
      await verifyVideoEvidence(out);
    }
  }
  await fs.writeFile(path.join(outDir, "audiovisual-report.json"), JSON.stringify(report, null, 2));
  server.close();
}

main().catch((err) => {
  console.error("Falló la evidencia de dirección audiovisual:", err);
  process.exit(1);
});
