/**
 * Modo dry-run del AI Video Pipeline (Long Form, P1) — demuestra la
 * cadena COMPLETA pedida en la Definition of Done:
 *
 *   Storyboard Shot → Eligibility Engine → Cost Guard →
 *   VideoProvider abstraction → Simulation Provider →
 *   Async Job lifecycle → Validation → Storage-ready asset
 *
 * SIN llamar nunca a un proveedor real: este script usa EXPLÍCITAMENTE
 * `fixtureVideoProvider` (nunca `getVideoProvider()`) para que sea
 * imposible que una llamada real ocurra por accidente, sin importar cómo
 * esté configurado el entorno (VIDEO_PROVIDER/RUNWAY_API_KEY/
 * PREMIUM_CLIPS_ENABLED) — coherente con "NO generar video real todavía"
 * de esta fase. Además fuerza `LONG_FORM_AI_VIDEO_ENABLED=true` SOLO
 * dentro del propio proceso de este script (nunca en el entorno real),
 * para poder ejercitar la cadena completa incluyendo el cost guard.
 *
 * Uso:
 *   npx tsx scripts/dry-run-ai-video-plan.ts \
 *     --storyboard=content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json \
 *     [--preset=economic|balanced|premium] [--aspect-ratio=16:9|9:16]
 *
 * Sin --storyboard, usa un pequeño set de shots de demostración
 * (mezcla deliberada de shots de alta/baja necesidad de movimiento y un
 * shot determinístico) para poder correr el script sin ningún archivo.
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.
process.env.LONG_FORM_AI_VIDEO_ENABLED = "true";

type DemoShotInput = {
  id: string;
  beatId: string;
  visualIntent: string;
  durationSec: number;
  type?: "text" | "diagram" | "map" | "stock_video" | "stock_image" | "generated_placeholder" | "ken_burns_image";
  generationPriority?: number;
};

const DEMO_SHOTS: DemoShotInput[] = [
  { id: "demo-1", beatId: "beat-1", visualIntent: "a wide aerial shot of an arid hill site, warm dawn light", durationSec: 6, generationPriority: 3 },
  { id: "demo-2", beatId: "beat-1", visualIntent: "people cooperating and building a monumental stone structure, carrying heavy stones, working together", durationSec: 8, generationPriority: 1 },
  { id: "demo-3", beatId: "beat-2", visualIntent: "a static archival photograph of an ancient carved inscription", durationSec: 5, generationPriority: 4 },
  { id: "demo-4", beatId: "beat-2", visualIntent: "a procession of people walking and gathering around a fire at dusk, ritual gestures", durationSec: 7, generationPriority: 2 },
  { id: "demo-5", beatId: "beat-3", visualIntent: "excavation site location", durationSec: 4, type: "map" },
  { id: "demo-6", beatId: "beat-3", visualIntent: "timeline of the excavation phases", durationSec: 4, type: "diagram" },
];

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  };
  return {
    storyboardFile: get("storyboard"),
    preset: (get("preset") ?? undefined) as "economic" | "balanced" | "premium" | undefined,
    aspectRatio: (get("aspect-ratio") ?? "16:9") as "16:9" | "9:16",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { fixtureVideoProvider } = await import("../src/lib/providers/video-gen/fixture");
  const { getAiVideoCostConfig } = await import("../src/lib/video/long-form/ai-video-cost-guard");
  const { scoreAiVideoEligibilityBatch } = await import("../src/lib/video/long-form/ai-video-eligibility");
  const { resolveAiVideoForShots } = await import("../src/lib/video/long-form/ai-video-resolver");
  const { emptyAiVideoLedgerState } = await import("../src/lib/video/long-form/ai-video-cost-guard");

  let shots: DemoShotInput[];
  let source: string;
  if (args.storyboardFile) {
    const { loadStoryboardFromFile } = await import("../src/lib/video/long-form/storyboard-loader");
    const loaded = loadStoryboardFromFile(args.storyboardFile);
    shots = [];
    for (const [beatId, sbShots] of loaded.shotsByBeatId) {
      for (const sb of sbShots) {
        shots.push({
          id: sb.shotId,
          beatId,
          // El dry-run no tiene narración real sintetizada todavía — usa
          // durationApprox del storyboard (duración de PLANEACIÓN, no la
          // real narrada) como aproximación suficiente para demostrar la
          // cadena, nunca presentada como timing final.
          visualIntent: sb.queryOrPrompt || sb.visualIntent,
          durationSec: sb.durationApprox,
          type: sb.assetType === "text" || sb.assetType === "diagram" || sb.assetType === "map" ? sb.assetType : undefined,
        });
      }
    }
    source = `storyboard real: ${args.storyboardFile} (${shots.length} shots, duraciones APROXIMADAS de planeación)`;
  } else {
    shots = DEMO_SHOTS;
    source = `set de demostración interno (${shots.length} shots) — sin --storyboard`;
  }

  const totalDocumentaryDurationSec = shots.reduce((sum, s) => sum + s.durationSec, 0);
  const costConfig = getAiVideoCostConfig(args.preset);

  console.log("=".repeat(72));
  console.log("[dry-run-ai-video-plan] AI Video Pipeline P1 — Long Form — SIMULATION ONLY");
  console.log(`  fuente: ${source}`);
  console.log(`  duración total aproximada: ${totalDocumentaryDurationSec.toFixed(1)}s`);
  console.log(`  preset de costo: ${costConfig.preset} (${JSON.stringify(costConfig)})`);
  console.log(`  proveedor: "${fixtureVideoProvider.name}" (forzado, nunca un proveedor real en este script)`);
  console.log("=".repeat(72));

  // --- 1. Eligibility engine (sin red) ---
  const eligibility = scoreAiVideoEligibilityBatch(shots, costConfig);
  console.log("\n[1/4] Elegibilidad por shot:");
  for (const e of eligibility) {
    console.log(
      `  - ${e.shotId}: score=${e.eligibilityScore.toFixed(2)} -> ${e.recommendedAssetType} ` +
        `(valor=${e.estimatedValue.toFixed(2)}, costo est.=$${e.estimatedCostUsd.toFixed(4)}) — ${e.reason}`,
    );
  }

  // --- 2-4. Cost guard + VideoProvider (simulation) + validación, encadenados por el resolver ---
  const paramsWithoutShot = {
    totalDocumentaryDurationSec,
    videoProvider: fixtureVideoProvider,
    aspectRatio: args.aspectRatio,
    costConfig,
    requireReal: false, // SIEMPRE false en este script — ver comentario de cabecera.
  };
  const batch = await resolveAiVideoForShots(shots, paramsWithoutShot, emptyAiVideoLedgerState());

  console.log("\n[2-4/4] Resolución (cost guard -> VideoProvider simulation -> validación), en orden de generationPriority:");
  let generatedCount = 0;
  let skippedCount = 0;
  for (const outcome of batch.outcomes) {
    if (outcome.status === "generated") {
      generatedCount++;
      console.log(
        `  - ${outcome.shotId}: GENERADO (simulation) — ${outcome.clip.durationSeconds}s, ` +
          `${outcome.clip.buffer.byteLength} bytes, proveedor="${outcome.clip.provider}", costo=$${outcome.clip.costUsd.toFixed(4)} ` +
          `(cero costo real: proveedor fixture)`,
      );
    } else {
      skippedCount++;
      console.log(`  - ${outcome.shotId}: OMITIDO — fallback recomendado="${outcome.recommendedFallback}" — ${outcome.reason}`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(
    `[dry-run-ai-video-plan] RESUMEN: ${shots.length} shots totales, ${generatedCount} tratados como ai_video (simulation), ` +
      `${skippedCount} con fallback a un tier más barato o determinístico.`,
  );
  console.log(
    `  ledger final (simulation): ${batch.finalLedger.usedClips} clips, ${batch.finalLedger.usedSeconds.toFixed(1)}s, ` +
      `$${batch.finalLedger.spentUsd.toFixed(4)} — TODO esto es costo SIMULADO, el proveedor fixture nunca cobra de verdad.`,
  );
  console.log("  0 llamadas reales. 0 créditos consumidos. LONG_FORM_AI_VIDEO_ENABLED permanece false fuera de este proceso.");
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error("[dry-run-ai-video-plan] fallo:", err);
  process.exit(1);
});
