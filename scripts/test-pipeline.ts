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
  const { generateScriptForRequest, planOwnScriptForRequest } = await import("../src/lib/video/generate-script");
  const { buildOwnScriptDraft, draftFit, narrationPreserved } = await import("../src/lib/video/own-script");
  const { generateVideoFromScript } = await import("../src/lib/video/generate-video");
  const { getScriptProvider } = await import("../src/lib/providers/script");
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
          async createSignedUrl(objectPath: string) {
            // El bucket real es privado y usa URLs firmadas (ver
            // src/lib/video/generate-video.ts); aquí, sin Supabase real, basta
            // con simular la firma devolviendo la misma URL local.
            return { data: { signedUrl: `${baseUrl}/${objectPath}` }, error: null };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // PIPELINE_SCRIPT=own: «Usar mi propio guion» — the customer's text, split into scenes and given visuals
  // only; the run fails if one word of the narration changed on the way to the final video.
  const ownScript = process.env.PIPELINE_SCRIPT === "own";
  const topic = ownScript ? "Mi guion propio" : "LOS RESULTADOS TIENEN UN PRECIO";
  const style = "motivacional, cinematográfico";
  const durationSeconds = ownScript ? 30 : 75;
  // Includes what a naive sentence split corrupts (PR149 CORRECCIÓN-1): decimals, thousands, a domain,
  // abbreviations, a dotted acronym and a paragraph break.
  const OWN_TEXT = "Cada mañana empieza igual: la alarma suena y piensas en quedarte. Pero hoy es distinto, "
    + "como explica el Dr. Pérez desde EE. UU. con datos de 2026.\n\nEl 3.14 por ciento de los días cuesta $1.500 de energía. "
    + "Visita ejemplo.com si quieres el detalle. Preparas el café, abres la libreta y escribes tres cosas que harás sin falta. "
    + "Caminar veinte minutos. Llamar a esa persona. Terminar la tarea pendiente. "
    + "Al final del día no cambiaste el mundo, pero cumpliste tu palabra contigo.";
  // What the voice receives, recorded from the provider itself; captions are built from these words.
  const voiceInputs: { text: string; words: string[] }[] = [];
  if (ownScript) {
    const { fixtureVoiceProvider } = await import("../src/lib/providers/voice/fixture");
    const original = fixtureVoiceProvider.synthesize.bind(fixtureVoiceProvider);
    fixtureVoiceProvider.synthesize = async (text, language, speed) => {
      const result = await original(text, language, speed);
      voiceInputs.push({ text, words: result.words.map(w => w.text) });
      return result;
    };
  }
  console.log(ownScript ? "Preparando escenas del guion propio con proveedores fixture..." : "Generando guion de prueba con proveedores fixture...");
  const start = Date.now();
  const draft = ownScript ? buildOwnScriptDraft(OWN_TEXT, topic, durationSeconds) : null;
  const fit = draft ? draftFit(draft, durationSeconds, "es") : null;
  if (fit && !fit.allowed) throw new Error(`El texto de prueba no cabe en ${durationSeconds}s: ${fit.message}`);
  const { script, providerName } = draft
    ? await planOwnScriptForRequest({ scenes: draft.segments.map(s => s.text), style, durationSeconds, language: "es" })
    : await generateScriptForRequest({ topic, style, durationSeconds });
  if (draft && !narrationPreserved(draft, script)) throw new Error("La narración del guion propio cambió al preparar las escenas.");
  console.log(
    `Guion generado (proveedor: ${providerName}): "${script.title}" con ${script.segments.length} escenas`,
  );

  // Ejerce también el flujo de revisión: regenerar una escena antes de
  // renderizar, igual que haría un usuario desde /dashboard/review/[id].
  // (Un guion propio no se reescribe: se omite.)
  if (!ownScript) {
    console.log("Regenerando la escena 0 (flujo del editor de guion)...");
    const scriptProvider = getScriptProvider();
    const newScene = await scriptProvider.regenerateScene({ topic, style, script, sceneIndex: 0 });
    script.segments[0] = newScene;
    console.log(`Escena 0 regenerada: "${newScene.text.slice(0, 60)}..."`);
  }

  // PIPELINE_DIRECTOR_FILL=<usd> (anexo C1): the Director mounts the Reel and may buy new material up to that budget
  // (fixture image provider: no network, no cost). The run reports what director.json says about the fill.
  const fillBudget = Number(process.env.PIPELINE_DIRECTOR_FILL ?? "");
  const directorFill = Number.isFinite(fillBudget) && process.env.PIPELINE_DIRECTOR_FILL !== undefined;
  if (directorFill) { process.env.CINEMATIC_DIRECTOR_RENDER_ENABLED = "true"; process.env.IMAGE_PROVIDER = "fixture"; }
  console.log("Renderizando video final...");
  const { videoPath } = await generateVideoFromScript({
    ...(directorFill ? { directorRender: true, directorMaterialBudgetUsd: async () => fillBudget } : {}),
    supabase: mockSupabase,
    requestId: "test-atomivid",
    script,
    style,
    targetDurationSeconds: durationSeconds,
    onProgress: (stage) => console.log(`  → etapa: ${stage}`),
  });

  if (ownScript) {
    const { canonicalNarration } = await import("../src/lib/video/narration-fit");
    const expected = canonicalNarration(OWN_TEXT, "visual");
    if (!voiceInputs.length) throw new Error("La voz no recibió ninguna narración.");
    for (const input of voiceInputs) {
      if (input.text !== expected) throw new Error(`La voz recibió un texto distinto del guion propio:\n${input.text}\n≠\n${expected}`);
      if (input.words.join(" ") !== expected) throw new Error("Las palabras de los subtítulos no coinciden con el guion propio.");
    }
    console.log(`Guion propio intacto: ${voiceInputs.length} síntesis con el texto exacto (${expected.length} caracteres); subtítulos con las mismas palabras.`);
  }
  if (directorFill) {
    const dj = JSON.parse(await fs.readFile(path.join(storageDir, path.dirname(videoPath), "director.json"), "utf8")) as { ok: boolean; materialFill?: unknown; applied?: { shotId: string; applied: { label: string | null } }[] };
    console.log(`Director: ok=${dj.ok} materialFill=${JSON.stringify(dj.materialFill ?? null)} labels=${(dj.applied ?? []).map(a => a.applied.label).join(",")}`);
    if (!dj.ok) throw new Error("El Director no montó el video.");
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Video generado en ${elapsed}s: ${videoPath}`);

  const localPath = path.join(storageDir, videoPath);
  const outPath = path.join(process.cwd(), "scripts", "atomivid-test-output.mp4");
  await fs.copyFile(localPath, outPath);
  console.log(`Copiado a: ${outPath}`);

  server.close();
}

main().catch((err) => {
  console.error("Fallo la prueba del pipeline:", err);
  process.exit(1);
});
