/**
 * Modo dry-run del planificador visual: construye el storyboard (real o
 * simulado, igual criterio que dry-run-storyboard.ts) y para cada escena
 * imprime la decisión completa — stock vs. imagen generada, proveedor,
 * prompt/consulta, costo estimado, motivo — SIN llamar a ningún proveedor
 * de imagen/video/footage ni tocar Storage/Supabase. Cero llamadas de
 * pago siempre, sin importar cómo estén configurados los flags: este
 * script solo usa decideResourceStrategy()/buildScenePlanEntry() (puros,
 * sin I/O) de visual-resource-planner.ts, nunca
 * visual-resource-resolver.ts (que sí hace I/O real).
 *
 * Uso: npx tsx scripts/dry-run-visual-plan.ts
 * (mismas variables de entorno que dry-run-storyboard.ts: DRY_RUN_TOPIC,
 * DRY_RUN_STYLE, DRY_RUN_LANGUAGE, DRY_RUN_DURATION_SECONDS,
 * DRY_RUN_SCRIPT_PROVIDER — más VISUAL_DIRECTOR_ENABLED,
 * OPENAI_IMAGE_GENERATION_ENABLED, MAX_GENERATED_IMAGES_PER_VIDEO,
 * MAX_VISUAL_COST_USD para ver cómo cambia la decisión con distintos
 * límites, todo sin gastar nada).
 */
export {};

async function main() {
  const topic = process.env.DRY_RUN_TOPIC || "La disciplina te lleva más lejos que la motivación";
  const style = process.env.DRY_RUN_STYLE || "Motivacional";
  const language = (process.env.DRY_RUN_LANGUAGE === "en" ? "en" : "es") as "es" | "en";
  const durationSeconds = Number(process.env.DRY_RUN_DURATION_SECONDS || "30");
  const useRealScript = process.env.DRY_RUN_SCRIPT_PROVIDER === "anthropic";

  const { buildStoryboard } = await import("../src/lib/video/storyboard");
  const { decideResourceStrategy, buildScenePlanEntry } = await import("../src/lib/video/visual-resource-planner");
  const { getFeatureFlags } = await import("../src/lib/video/feature-flags");
  const { splitIntoBeats } = await import("../src/lib/video/scene-beats");

  let script;
  if (useRealScript) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("DRY_RUN_SCRIPT_PROVIDER=anthropic requiere ANTHROPIC_API_KEY (tiene costo real de guion).");
    }
    const { generateScript } = await import("../src/lib/ai/script");
    script = await generateScript({ topic, style, durationSeconds, language });
  } else {
    const { fixtureScriptProvider } = await import("../src/lib/providers/script/fixture");
    script = await fixtureScriptProvider.generateScript({ topic, style, durationSeconds, language });
  }

  const { storyboard, source } = await buildStoryboard(script, language);
  const flags = getFeatureFlags();

  // Reparto de tiempo aproximado (sin voz real todavía) — suficiente para
  // que el dry-run reporte duraciones plausibles por escena sin depender
  // de ElevenLabs.
  const wordsPerSecond = 2.5;
  let cursor = 0;
  const plan = [];
  let imagesRequestedCount = 0;
  let visualCostSpentUsd = 0;

  for (let i = 0; i < script.segments.length; i++) {
    const segment = script.segments[i];
    const wordCount = Math.max(segment.text.split(/\s+/).filter(Boolean).length, 1);
    const segmentDuration = wordCount / wordsPerSecond;
    const beats = splitIntoBeats(cursor, cursor + segmentDuration);
    cursor += segmentDuration;

    const storyboardScene = storyboard.scenes[i];
    const concepts = segment.visualConcepts?.length ? segment.visualConcepts : [segment.visualQuery];

    for (let b = 0; b < beats.length; b++) {
      const beat = beats[b];
      const beatDuration = Math.max(0, beat.end - beat.start);
      const decision =
        b === 0
          ? decideResourceStrategy(storyboardScene, imagesRequestedCount, visualCostSpentUsd)
          : ({ useGeneration: false, reason: "solo el primer beat de cada escena es candidato a generación" } as const);

      if (decision.useGeneration) {
        imagesRequestedCount += 1;
        visualCostSpentUsd += decision.estimatedCostUsd;
      }

      plan.push(buildScenePlanEntry(i, b, beatDuration, segment.text, concepts[0], decision));
    }
  }

  const report = {
    input: { topic, style, language, durationSeconds },
    scriptProvider: useRealScript ? "anthropic" : "fixture",
    storyboardSource: source,
    featureFlags: {
      visualDirectorEnabled: flags.visualDirectorEnabled,
      imageGenerationEnabled: flags.imageGenerationEnabled,
      imageProvider: flags.imageProvider,
      maxImagesPerVideo: flags.maxImagesPerVideo,
      maxVisualCostUsd: flags.maxVisualCostUsd,
    },
    summary: {
      totalBeats: plan.length,
      scenesPlannedGenerated: plan.filter((p) => p.status === "planned_generated").length,
      scenesPlannedStock: plan.filter((p) => p.status === "planned_stock").length,
      estimatedVisualCostUsd: visualCostSpentUsd,
    },
    plan,
    note: "Ningún proveedor de imagen/footage fue llamado — esto es solo la decisión de la política, cero costo, cero red.",
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Dry-run del planificador visual falló:", err);
  process.exit(1);
});
