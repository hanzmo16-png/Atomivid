/**
 * Orquestador de Long Form — Fase A (ATOMIVID).
 *
 * Modo por defecto: SIMULATION (fixtures, cero costo). El modo REAL exige
 * `--mode=real` Y `LONG_FORM_REAL_RUN_CONFIRM=YES_SPEND_REAL_MONEY` (ver
 * src/lib/video/long-form/mode.ts) — sin ambos, es imposible llegar a
 * llamar un proveedor pago desde este script, incluso por accidente.
 *
 * Uso (fixture):
 *   npx tsx scripts/produce-long-form-video.ts \
 *     --topic="Göbekli Tepe: el misterio de 11,000 años que cambió nuestra historia" \
 *     --duration-seconds=180 \
 *     --output=/ruta/salida.mp4
 *
 * Uso (guion real ya finalizado, p. ej. VIDEO #001 — sigue en modo
 * simulation por defecto, cero costo, solo cambia la FUENTE del guion):
 *   npx tsx scripts/produce-long-form-video.ts \
 *     --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
 *     --output=/ruta/salida.mp4
 *
 * Uso (guion + storyboard real ya aprobados, p. ej. VIDEO #001 completo —
 * usa los 45 shots ya curados y sus gráficos reales en vez del ciclo
 * genérico de shotsForSpan()/fixtures; --storyboard exige --script, los
 * beatId de ambos archivos deben coincidir):
 *   npx tsx scripts/produce-long-form-video.ts \
 *     --script=content/long-form/gobekli-tepe-001/gobekli-script-003-current.json \
 *     --storyboard=content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json \
 *     --output=/ruta/salida.mp4
 *
 * Arquitectura: guion (fixture hoy / Claude real en Fase B) → beats →
 * síntesis de voz POR BEAT + línea de tiempo real (timeline.ts) → shots
 * reales (shots.ts, ya validado en el P0) → resolución de assets por
 * shot.type (asset-resolver.ts: Pexels/OpenAI/gráficos determinísticos) →
 * captions (captions.ts, reutilizado) → música (musicProvider) → render
 * (LongFormDoc, 1920x1080) → masterización de loudness (audio-master.ts,
 * reutilizado) → salida MP4 + reporte JSON.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.REMOTION_BROWSER_EXECUTABLE =
  process.env.REMOTION_BROWSER_EXECUTABLE ||
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
process.env.REMOTION_CHROME_MODE = process.env.REMOTION_CHROME_MODE || "headless-shell";

type CliArgs = {
  mode: "simulation" | "real";
  topic: string;
  durationSeconds: number;
  output: string;
  /** Ruta a un guion real ya finalizado (p. ej. content/long-form/<video-id>/gobekli-script-003-current.json). Si se omite, se usa buildFixtureScript() como hasta ahora — comportamiento por defecto sin cambios. */
  scriptFile?: string;
  /** Ruta a un storyboard real ya aprobado (p. ej. gobekli-storyboard-003.json). Exige scriptFile — sin él no hay forma de mapear beatId a beatType. Si se omite, se usa shotsForSpan() (ciclo genérico) como hasta ahora. */
  storyboardFile?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string, fallback?: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };

  const modeRaw = get("mode", "simulation");
  if (modeRaw !== "simulation" && modeRaw !== "real") {
    throw new Error(`--mode debe ser "simulation" o "real" (recibido: "${modeRaw}")`);
  }

  return {
    mode: modeRaw,
    topic: get("topic", "Tema de prueba (fixture) — Long Form P1") as string,
    durationSeconds: Number(get("duration-seconds", "180")),
    output: get("output", path.join(process.cwd(), "scripts", "atomivid-longform-test-output.mp4")) as string,
    scriptFile: get("script"),
    storyboardFile: get("storyboard"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.storyboardFile && !args.scriptFile) {
    throw new Error(
      "--storyboard exige --script: sin un guion real no hay forma de mapear beatId a beatType para reescalar el storyboard.",
    );
  }

  const { resolveLongFormProviders, computePaidApisCalled } = await import("../src/lib/video/long-form/mode");
  const { buildFixtureScript } = await import("../src/lib/video/long-form/fixture-pipeline");
  const { loadScriptFromFile } = await import("../src/lib/video/long-form/script-loader");
  const { loadStoryboardFromFile } = await import("../src/lib/video/long-form/storyboard-loader");
  const { buildShotsFromStoryboard } = await import("../src/lib/video/long-form/storyboard-shots");
  const { realGraphicSpecProvider } = await import("../src/lib/video/long-form/real-graphics");
  const { buildLongFormTimeline } = await import("../src/lib/video/long-form/timeline");
  const { synthesizeBeatNarrationCached } = await import("../src/lib/video/long-form/tts-cache");
  const { getVoiceIdentity } = await import("../src/lib/ai/voice");
  const { assertCanSpend, recordSpend, readCostLedgerFromDisk, recordSpendToDisk, VIDEO_001_HARD_STOP_USD } = await import(
    "../src/lib/video/long-form/video-cost-guard"
  );
  const { getPricingConfig } = await import("../src/lib/billing/pricing");
  const { resolveShotAsset } = await import("../src/lib/video/long-form/asset-resolver");
  const { estimateLongFormCost, assertWithinBudget, getLongFormBudget } = await import(
    "../src/lib/video/long-form/cost"
  );
  const { buildCaptions } = await import("../src/lib/video/captions");
  const { buildEmphasisSet } = await import("../src/lib/video/caption-emphasis");
  const { masterAudioLoudness, LOUDNESS_TARGET } = await import("../src/lib/video/audio-master");
  const { renderLongFormDoc } = await import("../src/lib/video/long-form/render");
  const { VIDEO_TAIL_SECONDS } = await import("../src/lib/video/script-pacing");
  const { computeNarrationGaps } = await import("../remotion/audio-mix");

  console.log(`[atomivid:long-form] modo=${args.mode} tema="${args.topic}" duración objetivo=${args.durationSeconds}s`);

  const providers = resolveLongFormProviders(args.mode);
  const paidApisCalledAtStart = computePaidApisCalled(providers);
  console.log(
    "[atomivid:long-form] proveedores resueltos:",
    JSON.stringify({
      voice: providers.voiceProvider.name,
      footage: providers.footageProvider.name,
      music: providers.musicProvider.name,
      image: providers.imageProvider.name,
      paidApisCalled: paidApisCalledAtStart,
    }),
  );

  // 1. Guion — por defecto, SOLO fixture (buildFixtureScript() produce
  // narración claramente genérica/plantilla, ver fixture-pipeline.ts:
  // "claim marked unverified until research stage runs" — nunca debe
  // confundirse con investigación real). Si se pasa --script=<ruta>, se
  // carga un guion REAL ya finalizado y auditado (script-loader.ts valida
  // su forma) — el resto del pipeline no cambia, solo cambia la fuente.
  let scriptBeats: Awaited<ReturnType<typeof loadScriptFromFile>>["beats"];
  let scriptTopic: string;
  let scriptIsFixtureContent: boolean;

  if (args.scriptFile) {
    const loaded = loadScriptFromFile(args.scriptFile);
    scriptBeats = loaded.beats;
    scriptTopic = loaded.topic;
    scriptIsFixtureContent = loaded.isFixtureContent;
    console.log(
      `[atomivid:long-form] guion cargado desde archivo: "${args.scriptFile}" — ${scriptBeats.length} beats, ` +
        `isFixtureContent=${scriptIsFixtureContent}`,
    );
  } else {
    if (args.mode === "simulation") {
      console.log("[atomivid:long-form] guion: FIXTURE (contenido de prueba, NO investigación real)");
    }
    const fixtureScript = buildFixtureScript({
      topic: args.topic,
      mode: "curiosity_documentary",
      language: "es",
      targetDurationSec: args.durationSeconds,
    });
    scriptBeats = fixtureScript.beats;
    scriptTopic = args.topic;
    scriptIsFixtureContent = true;
    console.log(`[atomivid:long-form] guion fixture: "${fixtureScript.title}" — ${scriptBeats.length} beats`);
  }

  // 1b. Storyboard real (opcional) — si se pasa --storyboard, cada beat
  // usa sus shots CURADOS (assetType/visualIntent/licencia ya decididos en
  // preproducción) en vez del ciclo genérico de shotsForSpan(), y los
  // gráficos de texto/diagrama/mapa se generan con contenido REAL
  // (real-graphics.ts) en vez de datos de ejemplo (isFixture:true).
  let shotsBuilder: Parameters<typeof buildLongFormTimeline>[3] | undefined;
  let graphicSpecFor: Parameters<typeof resolveShotAsset>[1]["graphicSpecFor"];
  let synthesizeBeat: Parameters<typeof buildLongFormTimeline>[4] | undefined;
  /** true solo para una ejecución REAL del storyboard de VIDEO #001 — usado más abajo (paso 5a) para resolver los shots AI_RECREATION con el mecanismo durable de Supabase en vez del ciclo genérico de asset-resolver.ts. */
  let isVideo001RealRun = false;
  if (args.storyboardFile) {
    const storyboard = loadStoryboardFromFile(args.storyboardFile);
    const missingBeatIds = scriptBeats
      .map((b) => b.id)
      .filter((id) => !storyboard.shotsByBeatId.has(id));
    if (missingBeatIds.length > 0) {
      throw new Error(
        `--storyboard "${args.storyboardFile}" no tiene shots para estos beatId del guion: ${missingBeatIds.join(", ")}. ` +
          `Los beatId de guion y storyboard deben coincidir exactamente — nunca se renderiza un beat sin storyboard en silencio.`,
      );
    }
    shotsBuilder = ({ beatId, beatType, startSec, endSec }) =>
      buildShotsFromStoryboard({
        beatId,
        beatType,
        startSec,
        endSec,
        storyboardShots: storyboard.shotsByBeatId.get(beatId) ?? [],
      });
    graphicSpecFor = realGraphicSpecProvider;
    console.log(
      `[atomivid:long-form] storyboard cargado desde archivo: "${args.storyboardFile}" — ${storyboard.totalShots} shots curados, ${storyboard.shotsByBeatId.size} beats`,
    );

    // Idempotencia TTS por beat — usa el videoId del storyboard como
    // identidad. El proveedor fixture (modo simulation) hace bypass total
    // del caché en ambos casos de abajo, así que es seguro pasar esto
    // siempre que haya un storyboard, sin importar el modo.
    const voiceIdentity = getVoiceIdentity("es");
    const isVideo001 = storyboard.videoId === "gobekli-tepe-001";
    isVideo001RealRun = isVideo001 && args.mode === "real";
    const pricing = getPricingConfig();

    if (isVideo001RealRun) {
      // Producción REAL de VIDEO #001 (p. ej. GitHub Actions): el ledger y
      // la caché TTS deben ser DURABLES entre ejecuciones SEPARADAS — un
      // runner de GitHub Actions es efímero (workspace nuevo cada vez), así
      // que el ledger/caché en disco local (.atomivid-state/..., tts-cache.ts)
      // solo protegen contra un crash DENTRO de una misma ejecución, nunca
      // entre dos ejecuciones distintas del workflow. Se usa el MISMO ledger
      // de Supabase Storage donde ya está el gasto real confirmado del
      // Visual Test V2 — el hard stop de $3.00 se valida siempre sobre el
      // TOTAL acumulado real, nunca desde $0 (ver production-tts-cache.ts /
      // visual-test-v2-storage.ts).
      const { createServiceClient } = await import("../src/lib/supabase/service");
      const { synthesizeBeatNarrationProductionCached } = await import(
        "../src/lib/video/long-form/production-tts-cache"
      );
      const { readVisualTestV2Ledger, writeVisualTestV2Ledger } = await import(
        "../src/lib/video/long-form/visual-test-v2-storage"
      );
      const supabaseForTts = createServiceClient();
      synthesizeBeat = (voiceProvider, beat, language) =>
        synthesizeBeatNarrationProductionCached(supabaseForTts, voiceProvider, beat, language, {
          videoId: storyboard.videoId,
          voiceIdentity,
          costGuard: {
            estimateCostUsd: (text) => (text.length / 1000) * pricing.elevenLabsUsdPer1kChars,
            assertCanSpend: async (amountUsd) => {
              const ledger = await readVisualTestV2Ledger(supabaseForTts, "videos", storyboard.videoId);
              assertCanSpend(ledger, "production", amountUsd);
            },
            recordSpend: async (amountUsd, note) => {
              const ledger = await readVisualTestV2Ledger(supabaseForTts, "videos", storyboard.videoId);
              const updated = recordSpend(ledger, "production", amountUsd, note);
              await writeVisualTestV2Ledger(supabaseForTts, "videos", updated);
            },
          },
        });
      console.log(
        `[atomivid:long-form] PRODUCCIÓN REAL VIDEO #001: caché TTS + ledger DURABLES en Supabase Storage ` +
          `(hard stop total $${VIDEO_001_HARD_STOP_USD}, incluye gasto ya confirmado del Visual Test V2).`,
      );
    } else {
      synthesizeBeat = (voiceProvider, beat, language) =>
        synthesizeBeatNarrationCached(voiceProvider, beat, language, {
          videoId: storyboard.videoId,
          voiceIdentity,
          costGuard: isVideo001
            ? {
                estimateCostUsd: (text) => (text.length / 1000) * pricing.elevenLabsUsdPer1kChars,
                assertCanSpend: (amountUsd) => {
                  const ledger = readCostLedgerFromDisk(storyboard.videoId);
                  assertCanSpend(ledger, "production", amountUsd);
                },
                recordSpend: (amountUsd, note) => {
                  recordSpendToDisk(storyboard.videoId, "production", amountUsd, note);
                },
              }
            : undefined,
        });
      console.log(
        `[atomivid:long-form] caché TTS por beat activo (videoId="${storyboard.videoId}")` +
          (isVideo001 ? ` — cost guard de VIDEO #001 conectado (hard stop $${VIDEO_001_HARD_STOP_USD}, ledger local — solo simulation)` : ""),
      );
    }
  } else {
    console.log("[atomivid:long-form] sin --storyboard: usando shotsForSpan() (ciclo genérico) y gráficos fixture, como antes.");
  }

  // 2. Almacenamiento simulado — mismo patrón ya validado en
  // scripts/test-pipeline.ts (servidor HTTP local sobre un directorio
  // temporal): le da a Remotion URLs http:// reales sin necesitar
  // Supabase real. En modo "real" (Fase B) esto se reemplaza por un
  // cliente de Supabase auténtico — no implementado aquí a propósito
  // (fuera de alcance de Fase A, cero costo).
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-longform-storage-"));
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

  const upload = async (objectPath: string, buffer: Buffer): Promise<{ url: string }> => {
    const fullPath = path.join(storageDir, objectPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    return { url: `${baseUrl}/${objectPath}` };
  };

  try {
    // 3. Línea de tiempo real: sintetiza voz POR BEAT (respeta el límite de
    // caracteres de ElevenLabs, une audio, re-offsetea timestamps) y
    // recalcula shots[] de cada beat contra su duración REAL narrada.
    console.log("[atomivid:long-form] sintetizando narración por beat y construyendo línea de tiempo real...");
    const timeline = shotsBuilder
      ? await buildLongFormTimeline(providers.voiceProvider, scriptBeats, "es", shotsBuilder, synthesizeBeat)
      : await buildLongFormTimeline(providers.voiceProvider, scriptBeats, "es");
    console.log(
      `[atomivid:long-form] línea de tiempo real: ${timeline.durationSeconds.toFixed(1)}s narrados, ` +
        `${timeline.beats.reduce((n, b) => n + b.shots.length, 0)} shots en total`,
    );

    // 4. Guarda de presupuesto PREVENTIVA — antes de resolver ningún asset
    // generado, confirma que el plan cabe dentro de LONG_FORM_MAX_TOTAL_USD.
    const budget = getLongFormBudget();
    const estimate = estimateLongFormCost({ durationSec: timeline.durationSeconds, beats: timeline.beats });
    assertWithinBudget(estimate, budget);
    console.log("[atomivid:long-form] estimado de costo preventivo:", JSON.stringify(estimate));

    // 5. Resolver el asset real de cada shot según su shot.type.
    console.log("[atomivid:long-form] resolviendo assets por shot.type...");
    const allShots = timeline.beats.flatMap((b) => b.shots);

    // 5a. PRODUCCIÓN REAL de VIDEO #001 únicamente: resuelve TODOS los
    // shots AI_RECREATION (shot.source === "generated") ANTES del ciclo
    // genérico de abajo — los 3 ya aprobados se REUTILIZAN (nunca se
    // regeneran) y los 8 restantes se generan o reutilizan con el mismo
    // estilo/idempotencia/cost-guard del Visual Test V2 (ver
    // production-ai-recreation.ts). El ciclo genérico de asset-resolver.ts
    // (abajo) NUNCA ve estos shots — se bypassa por completo para ellos,
    // porque hoy mapea "ken_burns_image" a stock/Pexels, no a OpenAI.
    let productionAiImages:
      | Map<string, import("../src/lib/video/long-form/production-ai-recreation").ResolvedAiRecreationImage>
      | undefined;
    if (isVideo001RealRun) {
      const { createServiceClient } = await import("../src/lib/supabase/service");
      const { resolveProductionAiRecreationImages } = await import(
        "../src/lib/video/long-form/production-ai-recreation"
      );
      const supabaseForImages = createServiceClient();
      productionAiImages = await resolveProductionAiRecreationImages(supabaseForImages, allShots, providers.imageProvider);
      const newCostUsd = [...productionAiImages.values()].filter((v) => !v.reused).reduce((sum, v) => sum + v.costUsd, 0);
      console.log(
        `[atomivid:long-form] PRODUCCIÓN REAL VIDEO #001: ${productionAiImages.size} shots AI_RECREATION resueltos ` +
          `(${[...productionAiImages.values()].filter((v) => v.reused).length} reutilizados, ` +
          `${[...productionAiImages.values()].filter((v) => !v.reused).length} generados nuevos, costo nuevo=$${newCostUsd.toFixed(4)}).`,
      );
    }

    const shotScenes: {
      id: string;
      startSeconds: number;
      endSeconds: number;
      asset: Awaited<ReturnType<typeof resolveShotAsset>>["asset"];
      motion: (typeof allShots)[number]["motion"];
    }[] = [];
    let imageCostSpentUsd = 0;
    let totalBufferBytes = 0;
    const shotTypesUsed: string[] = [];
    const providersUsedForAssets = new Set<string>();

    for (const shot of allShots) {
      const preResolvedAi = productionAiImages?.get(shot.id);
      let result: Awaited<ReturnType<typeof resolveShotAsset>>;
      if (preResolvedAi) {
        // Shot AI_RECREATION de producción REAL de VIDEO #001, ya resuelto
        // en el paso 5a (reutilizado o generado con Supabase/cost-guard) —
        // NUNCA pasa por resolveShotAsset/footageProvider para este shot.
        const uploaded = await upload(`longform-pilot/${shot.id}.${preResolvedAi.extension}`, preResolvedAi.buffer);
        result = {
          shotId: shot.id,
          asset: { kind: "media", mediaType: "image", url: uploaded.url },
          costUsd: preResolvedAi.costUsd,
          bufferBytes: preResolvedAi.buffer.byteLength,
          providerUsed: preResolvedAi.reused ? "openai (reused, producción real)" : "openai (producción real)",
        };
      } else {
        const remaining = Math.max(0, budget.maxImageUsd - imageCostSpentUsd);
        result = await resolveShotAsset(shot, {
          footageProvider: providers.footageProvider,
          imageProvider: providers.imageProvider,
          upload,
          pathPrefix: "longform-pilot",
          imageBudgetRemainingUsd: remaining,
          graphicSpecFor,
        });
      }
      imageCostSpentUsd += result.costUsd;
      totalBufferBytes += result.bufferBytes;
      shotTypesUsed.push(shot.type);
      providersUsedForAssets.add(result.providerUsed);
      shotScenes.push({
        id: shot.id,
        startSeconds: shot.startSec,
        endSeconds: shot.endSec,
        asset: result.asset,
        motion: shot.motion,
      });
    }
    console.log(
      `[atomivid:long-form] assets resueltos: ${shotScenes.length} shots, ` +
        `${new Set(shotTypesUsed).size} tipos distintos, costo imágenes=$${imageCostSpentUsd.toFixed(4)}`,
    );

    // 6. Captions — reutiliza buildCaptions() (video/captions.ts) tal
    // cual, sobre los timestamps REALES de la narración unida.
    const emphasisSet = buildEmphasisSet([]);
    const captions = buildCaptions(timeline.words, emphasisSet);
    const narrationGaps = computeNarrationGaps(timeline.words);

    // 7. Música — mismo MusicProvider que Shorts, biblioteca curada o
    // fixture según el modo ya resuelto arriba.
    const finalDurationSeconds = timeline.durationSeconds + VIDEO_TAIL_SECONDS;
    const music = await providers.musicProvider.getTrack({
      durationSeconds: finalDurationSeconds,
      style: "documental",
      topic: scriptTopic,
      scriptText: scriptBeats.map((b) => b.narration).join(" "),
      language: "es",
      seed: "longform-pilot",
    });
    const musicUpload = await upload(`longform-pilot/music.${music.extension}`, music.audioBuffer);

    // 8. Subir narración unida y renderizar con la composición LongFormDoc (16:9).
    const audioUpload = await upload("longform-pilot/voice.wav", timeline.audioBuffer);
    console.log("[atomivid:long-form] renderizando con la composición LongFormDoc (1920x1080)...");
    const renderStartedAt = Date.now();
    const rawOutputPath = await renderLongFormDoc({
      audioUrl: audioUpload.url,
      musicUrl: musicUpload.url,
      scenes: shotScenes,
      captions,
      narrationGaps,
      durationSeconds: finalDurationSeconds,
    });
    const renderMs = Date.now() - renderStartedAt;

    // 9. Masterización de loudness — reutiliza audio-master.ts tal cual.
    let finalPath = rawOutputPath;
    try {
      const masteredPath = rawOutputPath.replace(/\.mp4$/, ".mastered.mp4");
      const mastering = await masterAudioLoudness(rawOutputPath, masteredPath);
      finalPath = masteredPath;
      console.log("[atomivid:long-form] masterización de loudness:", JSON.stringify({ target: LOUDNESS_TARGET, ...mastering }));
    } catch (err) {
      console.warn("[atomivid:long-form] no se pudo masterizar loudness (¿falta ffmpeg?), se usa el render sin normalizar:", err);
    }

    await fs.mkdir(path.dirname(args.output), { recursive: true });
    await fs.copyFile(finalPath, args.output);

    const paidApisCalled = computePaidApisCalled(providers) || imageCostSpentUsd > 0;
    const report = {
      mode: args.mode,
      topic: scriptTopic,
      isFixtureContent: scriptIsFixtureContent,
      scriptSource: args.scriptFile ?? "buildFixtureScript() (fixture)",
      storyboardSource: args.storyboardFile ?? "shotsForSpan() (ciclo genérico, sin storyboard)",
      targetDurationSeconds: args.durationSeconds,
      actualDurationSeconds: finalDurationSeconds,
      beatCount: timeline.beats.length,
      shotCount: shotScenes.length,
      distinctShotTypes: new Set(shotTypesUsed).size,
      shotTypesUsed: [...new Set(shotTypesUsed)],
      providersUsed: {
        voice: providers.voiceProvider.name,
        footage: providers.footageProvider.name,
        music: providers.musicProvider.name,
        image: providers.imageProvider.name,
      },
      paidApisCalled,
      imageCostSpentUsd,
      renderMs,
      output: args.output,
    };
    await fs.writeFile(args.output.replace(/\.mp4$/, ".report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (paidApisCalled && args.mode === "simulation") {
      throw new Error("INVARIANTE ROTA: paidApisCalled=true en modo simulation — esto nunca debe ocurrir.");
    }
  } finally {
    server.close();
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[atomivid:long-form] fallo:", err);
  process.exit(1);
});
