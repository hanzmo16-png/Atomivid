/**
 * Evidencia de extremo a extremo de la DIRECCIÓN AUDIOVISUAL en Reels, con
 * costo $0: proveedores fixture (voz sintética, clips/imagenes de color
 * sólido, música fixture) y un Supabase simulado sobre disco. Renderiza tres
 * direcciones con el MISMO pipeline que producción (directed-reel.ts):
 *
 *   1. horror      — Horror y misterio (stock oscuro, grado y viñeta, suspenso)
 *   2. comic-mist  — Cómic + guion de misterio (imágenes por escena, suspenso)
 *   3. comic-humor — Cómic + tono Humor (mismas imágenes de estilo, ritmo dinámico)
 *   4. comic-anim  — Cómic + «Animación IA» con proveedor simulado (clip por escena)
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
process.env.REEL_ANIMATION_PROVIDER = "fixture";
process.env.REEL_AI_ANIMATION_ENABLED = "true";
process.env.MAX_AI_ANIMATION_COST_USD = "5";

const MYSTERY: GeneratedScript = {
  title: "El faro",
  segments: [
    { text: "Nadie sabe qué pasó aquella noche en el faro abandonado de la costa.", visualQuery: "old lighthouse at night", visualConcepts: ["old lighthouse at night", "stormy coast"], energy: "low" },
    { text: "El guardián desapareció y solo quedó un grito en la grabación.", visualQuery: "empty spiral stairway", visualConcepts: ["empty spiral stairway", "old tape recorder"], energy: "low" },
    { text: "Las sombras en la escalera no coincidían con ninguna persona del pueblo.", visualQuery: "shadow on wall", visualConcepts: ["shadow on wall", "flickering lamp"], energy: "medium" },
    { text: "Entonces encontraron la puerta cerrada por dentro. El misterio sigue abierto.", visualQuery: "locked wooden door", visualConcepts: ["locked wooden door", "rusty key"], energy: "high" },
  ],
};

// Mismo guion con la acción visible que cada clip debe completar (obligatoria en «Animación IA»).
const MYSTERY_ANIM: GeneratedScript = {
  ...MYSTERY,
  segments: MYSTERY.segments.map((s, i) => ({
    ...s,
    visibleAction: [
      "the lighthouse beam sweeps once across the sea",
      "a tape recorder reel slowly stops turning",
      "a shadow slides along the stairway wall",
      "the door handle rattles hard and stops",
    ][i],
  })),
};

// «Medieval oscuro»: acción declarada con pose inicial y estado final sostenido.
const MEDIEVAL: GeneratedScript = {
  title: "La torre del norte",
  segments: [
    { text: "Nadie volvió de la torre del norte desde aquel invierno.", visualQuery: "ruined stone tower", visualConcepts: ["ruined stone tower on a hill", "empty battlements"], energy: "low", visibleAction: "a crow lands on the broken battlement", actionStart: "the empty battlement, a crow gliding toward it", actionEnd: "the crow stays perched, still" },
    { text: "El caballero empujó despacio la vieja puerta de roble.", visualQuery: "knight opening oak door", visualConcepts: ["knight pushing an oak door", "iron hinges"], energy: "medium", visibleAction: "the knight pushes the oak door open", actionStart: "the knight stands before the closed oak door", actionEnd: "the door stays open, the knight on the threshold" },
    { text: "Sobre la mesa de piedra esperaba una carta sellada.", visualQuery: "sword on stone table", visualConcepts: ["sword and sealed letter on a stone table", "candlelit hall"], energy: "medium", visibleAction: "the knight picks up the sealed letter", actionStart: "the knight's hand hovers above the table", actionEnd: "the knight holds the letter, still" },
    { text: "La carta llevaba su nombre, con una letra desconocida.", visualQuery: "knight reading letter", visualConcepts: ["knight reading a letter", "wax seal"], energy: "high", visibleAction: "the knight breaks the wax seal", actionStart: "the knight holds the sealed letter in both hands", actionEnd: "the seal lies broken, the letter open" },
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

type AnimatedShotLike = { sceneIndex: number; startSeconds: number; endSeconds: number; transitionInFrames: number; source: string };

const CASES = {
  horror: { script: MYSTERY, style: "Curiosidades", topic: "El faro", selection: { version: 1 as const, profile: "horror_mystery" as const } },
  "comic-mist": { script: MYSTERY, style: "Curiosidades", topic: "El faro", selection: { version: 1 as const, profile: "comic" as const } },
  "comic-humor": { script: HUMOR, style: "Humor", topic: "Mi gato programador", selection: { version: 1 as const, profile: "comic" as const } },
  // «Animación IA» con el proveedor SIMULADO (fixture-animation: MP4 real a partir
  // de la ilustración con un elemento en movimiento). Demuestra el recorrido
  // técnico imagen → clip → render, no la calidad de una animación real.
  // «Medieval oscuro» en imágenes y en «Animación IA» (proveedor simulado).
  medieval: { script: MEDIEVAL, style: "Curiosidades", topic: "La torre del norte", selection: { version: 1 as const, profile: "medieval_dark" as const } },
  "medieval-anim": { script: MEDIEVAL, style: "Curiosidades", topic: "La torre del norte", selection: { version: 1 as const, profile: "medieval_dark" as const, motion: "ai_animation" as const } },
  "comic-anim": { script: MYSTERY_ANIM, style: "Curiosidades", topic: "El faro", selection: { version: 1 as const, profile: "comic" as const, motion: "ai_animation" as const } },
};

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes("--out-dir") ? args[args.indexOf("--out-dir") + 1] : path.join(process.cwd(), "scripts");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : Object.keys(CASES);
  await fs.mkdir(outDir, { recursive: true });

  const { generateVideoFromScript } = await import("../src/lib/video/generate-video");
  const { resolveDirection } = await import("../src/lib/video/audiovisual/direction");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-av-"));
  const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".json": "application/json" };
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
      if (line.includes("[atomivid:direction") || line.includes("[atomivid:animation-plan]")) logs.push(line);
      original(...a);
    };
    const started = Date.now();
    const { videoPath } = await generateVideoFromScript({ supabase, requestId: `av-${name}`, script: c.script, style: c.style, topic: c.topic, direction, onProgress: (s) => original(`  [${name}] etapa: ${s}`) });
    console.log = original;
    const out = path.join(outDir, `audiovisual-${name}.mp4`);
    await fs.copyFile(path.join(storageDir, videoPath), out);
    const montage = logs.find((l) => l.startsWith("[atomivid:direction-montage]"));
    const montageJson = montage ? JSON.parse(montage.slice(montage.indexOf("{"))) : null;
    const animationPlan = logs.filter((l) => l.startsWith("[atomivid:animation-plan]")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
    report[name] = {
      summary: direction.summary,
      profile: direction.profile,
      intent: direction.intent,
      music: direction.music,
      pace: direction.pace,
      seconds: (Date.now() - started) / 1000,
      montage: montageJson,
      ...(animationPlan.length > 0 ? { animationPlan } : {}),
    };
    console.log(`✔ ${name}: ${direction.summary} → ${out}`);
    if (process.env.CI || args.includes("--verify")) {
      const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
      await verifyVideoEvidence(out);
      if ("motion" in c.selection && c.selection.motion === "ai_animation") {
        const { verifyAnimatedMotion } = await import("./lib/verify-animated-motion");
        (report[name] as Record<string, unknown>).motion = await verifyAnimatedMotion(out, montageJson?.shots ?? []);
      } else if (montageJson?.shots?.some((sh: { source: string }) => sh.source === "ai_animation")) {
        throw new Error(`Evidencia inválida: «${name}» es «Imágenes» y usó clips animados.`);
      }
    }
  }
  // Control negativo: el mismo detector aplicado a «Imágenes» (comic-mist, mismo guion) debe rechazarlo;
  // así el paso de comic-anim no puede deberse a un detector que acepta cualquier cosa.
  const mist = report["comic-mist"] as { montage?: { shots?: AnimatedShotLike[] } } | undefined;
  if ((process.env.CI || args.includes("--verify")) && report["comic-anim"] && mist?.montage?.shots) {
    const { verifyAnimatedMotion } = await import("./lib/verify-animated-motion");
    const relabelled = mist.montage.shots.map((sh) => ({ ...sh, source: "ai_animation" }));
    const rejected = await verifyAnimatedMotion(path.join(outDir, "audiovisual-comic-mist.mp4"), relabelled).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    if (!rejected) throw new Error("Control inválido: el detector de movimiento aceptó el Reel de imágenes fijas.");
    report.motionControl = { case: "comic-mist", rejected };
    console.log(`✔ control: el detector rechaza «Imágenes» (${rejected})`);
  }
  await fs.writeFile(path.join(outDir, "audiovisual-report.json"), JSON.stringify(report, null, 2));
  server.close();
}

main().catch((err) => {
  console.error("Falló la evidencia de dirección audiovisual:", err);
  process.exit(1);
});
